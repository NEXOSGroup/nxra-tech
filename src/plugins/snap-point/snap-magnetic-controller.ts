// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SnapMagneticController — drag-time magnetic snapping between matching
 * snap points.
 *
 * Lifecycle:
 *   armForDrag(movingRoot) — call on layout-drag-start. Caches:
 *     - moving snaps: every registered snap whose ownerRoot === movingRoot
 *       and that is NOT occupied.
 *     - candidate snaps: every other registered, non-occupied snap that
 *       shares a typeId with at least one of the moving snaps.
 *
 *   tick(movingRoot) — call on layout-drag-tick (every gizmo frame).
 *     Finds the (moving, candidate) pair with the smallest world-space
 *     distance below the threshold; if found, overrides movingRoot's
 *     position/quaternion so the pair lands snap-aligned. Returns the
 *     snapped pair so the caller can show a preview, or null.
 *
 *   disarm(committed) — call on layout-drag-end. If a snap was active at
 *     the moment of release AND `committed` is true, marks both ends
 *     occupied + writes back-references to the placed-component metadata.
 *
 *   cancel() — drop arm state without committing.
 */

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import type {
  PlacedComponentId,
  SnapPoint,
  SnapPointRegistry,
} from '../../core/engine/rv-snap-point-registry';
import { computeSnapAlignedWorldMatrix } from './snap-alignment';
import { parseSnapName, flowsCompatible } from './snap-name-parser';

/** World-meter radius within which a magnetic snap engages. */
export const DEFAULT_MAGNET_RADIUS_M = 0.4;
/** Multiplier of the magnet radius at which an already-engaged edge breaks. */
export const CHAIN_BREAK_FACTOR = 2;

/** Chain member captured at drag-start. */
interface ChainMember {
  /** The placed asset root that follows the moving root. */
  root: Object3D;
  /** Initial transform of this member relative to the moving root, captured
   *  the instant the drag starts. World-space `moving.matrixWorld.inv() * member.matrixWorld`. */
  relMatrix: Matrix4;
  /** Snap-ids that anchor this member to the rest of the chain (used to
   *  detect over-stretched edges that should break mid-drag). */
  anchorSnapIds: string[];
}

export interface MagneticSnapPair {
  /** Snap belonging to the moving asset. */
  movingSnap: SnapPoint;
  /** Snap belonging to a stationary asset (target). */
  targetSnap: SnapPoint;
  /** World-space distance between the two at engage time. */
  distance: number;
}

export class SnapMagneticController {
  private readonly registry: SnapPointRegistry;
  private readonly radius: number;

  /** Snap points owned by the dragged asset. Cached on armForDrag. */
  private movingSnaps: SnapPoint[] = [];
  /** Candidate target snaps (other assets, non-occupied, typeId-match). */
  private candidateSnaps: SnapPoint[] = [];
  /** Last engaged pair from the most recent tick — or null if none. */
  private lastPair: MagneticSnapPair | null = null;
  /** The placed-component id of the dragged asset, captured at arm. */
  private movingPlacedId: PlacedComponentId | null = null;
  /** Callback to resolve the moving root's placed-id, supplied at arm. */
  private resolvePlacedId: ((root: Object3D) => PlacedComponentId | null) | null = null;

  /** Chain members captured at drag-start (chain-mode only). */
  private chainMembers: ChainMember[] = [];
  /** Read at arm time so each drag is consistent even if user toggles mid-drag. */
  private chainEnabled = true;
  /** The asset that is being dragged (captured at arm). */
  private movingRoot: Object3D | null = null;

  // Pre-allocated temps
  private readonly _wpA = new Vector3();
  private readonly _wpB = new Vector3();
  private readonly _mInv = new Matrix4();
  private readonly _mTmp = new Matrix4();

  constructor(
    registry: SnapPointRegistry,
    opts?: { radius?: number },
  ) {
    this.registry = registry;
    this.radius = opts?.radius ?? DEFAULT_MAGNET_RADIUS_M;
  }

  /**
   * Capture the moving root's snap points, the compatible candidate set, and
   * (when chain mode is enabled) every transitively connected asset that
   * must follow rigidly. `resolvePlacedId` is used at drag-end to fetch the
   * dragged asset's id for occupied bookkeeping; it can return null if the
   * asset is not yet registered with the layout planner.
   */
  armForDrag(
    movingRoot: Object3D,
    resolvePlacedId?: (root: Object3D) => PlacedComponentId | null,
    opts?: { chainEnabled?: boolean },
  ): void {
    this.movingSnaps = [];
    this.candidateSnaps = [];
    this.chainMembers = [];
    this.lastPair = null;
    this.movingPlacedId = null;
    this.resolvePlacedId = resolvePlacedId ?? null;
    this.movingRoot = movingRoot;
    this.chainEnabled = opts?.chainEnabled !== false;

    // The "moving asset" pool starts with movingRoot. In chain mode we expand
    // it to include every asset reachable through paired-snap edges. Already-
    // occupied snaps of the moving pool stay UNAVAILABLE as candidates (their
    // own paired edge is internal to the chain).
    const movingPool: Set<Object3D> = this.chainEnabled
      ? this.registry.walkChain(movingRoot)
      : new Set<Object3D>([movingRoot]);
    if (this.chainEnabled) {
      movingRoot.updateMatrixWorld(true);
      this._mInv.copy(movingRoot.matrixWorld).invert();
      for (const root of movingPool) {
        if (root === movingRoot) continue;
        root.updateMatrixWorld(true);
        const rel = new Matrix4().multiplyMatrices(this._mInv, root.matrixWorld);
        // O(deg) anchor-snap lookup via the owner-root index.
        const anchorSnapIds: string[] = [];
        for (const sp of this.registry.getByOwnerRoot(root)) {
          if (sp.pairedSnapId) anchorSnapIds.push(sp.id);
        }
        this.chainMembers.push({ root, relMatrix: rel, anchorSnapIds });
      }
    }

    // Single pass over the registry: classify each snap as moving (owner is
    // in the pool) or candidate (owner is outside the pool AND a matching
    // typeId is already in the moving set). Both passes used to walk
    // getAll() — we now build movingSnaps + typeIdsInMoving first, then a
    // second pass for candidates that gates on the typeId set we just built.
    const typeIdsInMoving = new Set<string>();
    const all = this.registry.getAll();
    for (let i = 0; i < all.length; i++) {
      const sp = all[i];
      if (!sp.object3D.parent || sp.occupied) continue;
      if (movingPool.has(sp.ownerRoot)) {
        this.movingSnaps.push(sp);
        typeIdsInMoving.add(sp.typeId);
      }
    }
    if (this.movingSnaps.length === 0) return;

    for (let i = 0; i < all.length; i++) {
      const sp = all[i];
      if (!sp.object3D.parent || sp.occupied) continue;
      if (movingPool.has(sp.ownerRoot)) continue;
      if (!typeIdsInMoving.has(sp.typeId)) continue;
      this.candidateSnaps.push(sp);
    }
  }

  /** Move the asset to the snapped pose if within magnet radius. */
  tick(movingRoot: Object3D): MagneticSnapPair | null {
    if (this.movingSnaps.length === 0 || this.candidateSnaps.length === 0) {
      this.lastPair = null;
      return null;
    }

    // Find the (moving, candidate) pair with the smallest world distance,
    // restricted to same-typeId pairs. World distance is a cheap proxy for
    // "looks close to the user".
    let best: MagneticSnapPair | null = null;
    let bestDist = this.radius;
    for (const m of this.movingSnaps) {
      if (!m.object3D.parent) continue;
      m.object3D.updateWorldMatrix(true, false);
      m.object3D.getWorldPosition(this._wpA);
      for (const c of this.candidateSnaps) {
        if (m.typeId !== c.typeId) continue;
        if (!flowsCompatible(m.flow, c.flow)) continue;
        if (!c.object3D.parent) continue;
        c.object3D.updateWorldMatrix(true, false);
        c.object3D.getWorldPosition(this._wpB);
        const d = this._wpA.distanceTo(this._wpB);
        if (d < bestDist) {
          bestDist = d;
          best = { movingSnap: m, targetSnap: c, distance: d };
        }
      }
    }

    if (!best) {
      this.lastPair = null;
      return null;
    }

    // Apply snap-aligned transform. parseSnapName provides the outward
    // direction needed by the alignment math (cross-axis support).
    const targetDir = best.targetSnap.dir;
    const movingDir = parseSnapName(best.movingSnap.object3D.name)?.dir ?? best.movingSnap.dir;
    movingRoot.updateMatrixWorld(true);
    const M = computeSnapAlignedWorldMatrix(
      best.targetSnap.object3D,
      movingRoot,
      best.movingSnap.object3D,
      targetDir,
      movingDir,
    );
    movingRoot.matrixAutoUpdate = false;
    movingRoot.matrix.copy(M);
    M.decompose(movingRoot.position, movingRoot.quaternion, movingRoot.scale);
    movingRoot.matrixAutoUpdate = true;
    movingRoot.updateMatrixWorld(true);

    this.lastPair = best;
    return best;
  }

  /**
   * Apply the rigid chain follow-up after the gizmo (and our optional snap)
   * have moved the dragged root. Call ONCE per drag-tick AFTER `tick()`.
   *
   * Chain members get their world matrix set to
   *   movingRoot.matrixWorld * relMatrix
   * so their relative transform to the dragged root is preserved exactly.
   * While chain mode keeps the relative transforms intact, edges never
   * stretch on their own — the break-check therefore looks for members
   * whose snap is currently more than CHAIN_BREAK_FACTOR * radius away
   * from its paired snap (which can only happen if external code moved
   * the member between two ticks; the normal rigid-follow path produces
   * zero edge stretch).
   */
  applyChainFollow(): void {
    if (!this.chainEnabled || this.chainMembers.length === 0) return;
    const movingRoot = this.movingRoot;
    if (!movingRoot) return;

    movingRoot.updateMatrixWorld(true);

    // Rigid follow for every chain member first — this is the dominant
    // case during a normal drag and keeps every snap pair at exactly zero
    // distance.
    for (const m of this.chainMembers) {
      this._mTmp.multiplyMatrices(movingRoot.matrixWorld, m.relMatrix);
      m.root.matrixAutoUpdate = false;
      m.root.matrix.copy(this._mTmp);
      this._mTmp.decompose(m.root.position, m.root.quaternion, m.root.scale);
      m.root.matrixAutoUpdate = true;
      m.root.updateMatrixWorld(true);
    }

    // Edge break-check — only relevant if something other than this method
    // moved a member (e.g. concurrent inspector edit, multi-select drag).
    // Detached edges are freed in the registry and the affected member is
    // dropped from future ticks.
    const breakRadius = this.radius * CHAIN_BREAK_FACTOR;
    const survivors: ChainMember[] = [];
    for (const m of this.chainMembers) {
      let broken = false;
      for (const id of m.anchorSnapIds) {
        const own = this.registry.getById(id);
        if (!own || !own.pairedSnapId) continue;
        const partner = this.registry.getById(own.pairedSnapId);
        if (!partner) continue;
        own.object3D.updateWorldMatrix(true, false);
        partner.object3D.updateWorldMatrix(true, false);
        own.object3D.getWorldPosition(this._wpA);
        partner.object3D.getWorldPosition(this._wpB);
        if (this._wpA.distanceTo(this._wpB) > breakRadius) {
          this.registry.markFree(own.id);
          this.registry.markFree(partner.id);
          broken = true;
          break;
        }
      }
      if (!broken) survivors.push(m);
    }
    this.chainMembers = survivors;
  }

  /**
   * Drag finished. If a pair was engaged at the last tick and `committed`
   * is true, mark both ends occupied (cross-referenced) so the picker no
   * longer offers them, AND establish the bidirectional pairedSnapId link
   * so the chain resolver can walk the connection graph.
   */
  disarm(committed: boolean): MagneticSnapPair | null {
    const final = this.lastPair;
    if (committed && final) {
      const placedId = this.movingPlacedId
        ?? (this.resolvePlacedId
          ? this.resolvePlacedId(final.movingSnap.ownerRoot)
          : null);
      if (placedId) {
        this.registry.markOccupied(final.targetSnap.id, placedId);
        // The moving snap belongs to the moving asset — mark it occupied by
        // the target's owner if we can resolve it. Otherwise just flag
        // occupancy with a sentinel so the picker excludes it.
        const targetOwnerId = this.resolvePlacedId
          ? this.resolvePlacedId(final.targetSnap.ownerRoot)
          : null;
        this.registry.markOccupied(
          final.movingSnap.id,
          targetOwnerId ?? (`snap:${final.targetSnap.id}` as PlacedComponentId),
        );
        // Bidirectional pairing for chain-mode graph walks.
        this.registry.pair(final.movingSnap.id, final.targetSnap.id);
      }
    }
    this.movingSnaps = [];
    this.candidateSnaps = [];
    this.chainMembers = [];
    this.lastPair = null;
    this.movingPlacedId = null;
    this.movingRoot = null;
    this.resolvePlacedId = null;
    return final;
  }

  /** Drop arm state without committing (used on ESC / programmatic cancel). */
  cancel(): void { this.disarm(false); }

  /** Most recent engaged pair (read-only). */
  getLastPair(): MagneticSnapPair | null { return this.lastPair; }
  /** Current candidate count — test helper. */
  getCandidateCount(): number { return this.candidateSnaps.length; }
  /** Chain member count — test helper. */
  getChainMemberCount(): number { return this.chainMembers.length; }
}
