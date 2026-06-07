// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { ArrowHelper, Box3, Object3D, Vector3, Quaternion, MathUtils, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, DoubleSide, RepeatWrapping } from 'three';
import { debug } from './rv-debug';
import { MM_TO_METERS } from './rv-constants';
import type { MeshStandardMaterial, Texture } from 'three';
import { AABB } from './rv-aabb';
import type { RVDrive } from './rv-drive';
import type { RVMovingUnit, InstancedMovingUnit } from './rv-mu';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent } from './rv-component-registry';
import { traverseMeshes } from './rv-traverse-utils';
import type { GizmoOverlayManager } from './rv-gizmo-manager';

// Pre-allocated temp vectors (no GC in hot path)
const _movement = new Vector3();
const _offset = new Vector3();
// Pre-allocated scratch for the per-tick matrix-delta refresh.
const _scratchInv = new Matrix4();
const _quatCarry = new Quaternion();
// Scratch for the parent-local↔world carry conversion in transportMU.
const _scratchVecA = new Vector3();
const _scratchQuatA = new Quaternion();
const _scratchQuatB = new Quaternion();

/** Identity-matrix element pattern (column-major), used by `matrixIsIdentity`. */
const _identityElements = new Matrix4().elements;
const MATRIX_EPS = 1e-6;
/** True when every element of `m` is within ε of the identity matrix. */
function matrixIsIdentity(m: Matrix4): boolean {
  const e = m.elements;
  for (let i = 0; i < 16; i++) {
    if (Math.abs(e[i] - _identityElements[i]) > MATRIX_EPS) return false;
  }
  return true;
}

// Shared geometry/material for transport-surface drop planes. These transient
// planes are NEVER added to the scene (never rendered, never selectable) — they
// are handed to the planner's drop-to-surface raycast as candidate targets so
// objects can be placed on a conveyor top even when it has no solid top mesh.
const _dropPlaneGeometry = new PlaneGeometry(1, 1);
_dropPlaneGeometry.rotateX(-Math.PI / 2); // unit quad, lying flat (normal = +Y)
const _dropPlaneMaterial = new MeshBasicMaterial({ side: DoubleSide });

/**
 * RVTransportSurface - Moves MUs along a direction at the associated Drive's speed.
 *
 * TransportDirection comes from GLB extras (computed by Unity at export time).
 * Speed comes from the associated RVDrive's currentSpeed.
 */
export class RVTransportSurface implements RVComponent {
  static readonly schema: ComponentSchema = {
    TransportDirection: { type: 'vector3', unityCoords: true },
    Radial: { type: 'boolean', default: false },
    TextureScale: { type: 'number', default: 1 },
    HeightOffsetOverride: { type: 'number', default: 0 },
    AnimateSurface: { type: 'boolean', default: true },
    DriveReference: { type: 'componentRef' },
  };

  readonly node: Object3D;
  readonly aabb: AABB;
  isOwner = true;

  // Properties — exact C# Inspector field names
  TransportDirection = new Vector3(1, 0, 0);
  Radial = false;
  TextureScale = 1;
  HeightOffsetOverride = 0;
  AnimateSurface = true;
  DriveReference: RVDrive | null = null;

  /** Raw Unity local transport direction for UV animation (before coordinate conversion) */
  rawLocalDir: { x: number; y: number; z: number } = { x: 1, y: 0, z: 0 };

  /** Associated drive (provides speed). Found during scene loading. */
  drive: RVDrive | null = null;

  /**
   * Local transport axis — source of truth. Captured at `init()` from the
   * authored `TransportDirection` (Unity-coords) and NEVER mutated afterwards.
   * The current world direction is derived from this every tick.
   */
  private localDirection = new Vector3(1, 0, 0);
  /**
   * Normalized transport direction in WORLD space — derived from
   * `localDirection × node.getWorldQuaternion()`, refreshed once per tick (or
   * on demand). Stale between `init()` and the first `_refreshWorldDirection()`
   * call within a tick — callers must go through `transportMU()` which
   * refreshes lazily, or call `_refreshWorldDirection()` explicitly.
   */
  private direction = new Vector3();
  /** Last tickId for which `direction` was refreshed (manager bumps this). */
  private _directionTickId = -1;
  /** Rotation axis for radial transport */
  private rotationAxis = new Vector3();

  // ── Per-tick world-matrix delta — carries MUs along with a rotating platform.
  /** Snapshot of `node.matrixWorld` at the end of the previous tick. */
  private _lastWorldMatrix = new Matrix4();
  /** `currentWorldMatrix * _lastWorldMatrix^-1` — the world transform applied
   *  to the surface between the previous and current tick. Identity when the
   *  surface didn't move (the common case for static conveyors). */
  private _matrixDelta = new Matrix4();
  /** Quaternion extracted from `_matrixDelta` — applied to MU orientation. */
  private _deltaQuat = new Quaternion();
  /** Whether `_matrixDelta` is non-identity within ε (i.e. carry the MU). */
  private _hasTransformDelta = false;
  /** True once we have a previous-tick matrix to diff against. */
  private _lastMatrixCaptured = false;

  /** Cloned textures for independent conveyor belt animation */
  private _texMaps: Texture[] = [];
  /** Raw Unity local direction X component for UV animation */
  private _uvDirX = 0;
  /** Raw Unity local direction Z component for UV animation */
  private _uvDirZ = 0;
  /** Raw Unity local direction Y component for radial UV direction sign */
  private _uvDirY = 0;
  /** Accumulated radial texture offset (wraps to avoid precision loss) */
  private _radialOffsetX = 0;

  // ── Selection-gizmo state (managed by our own selection subscription) ──
  /** Blue transparent fill over the top face of the surface while selected.
   *  Lives under `this.node` so it follows the asset's transform. */
  private _selTopSurface: Mesh | null = null;
  /** Direction arrow shown alongside the top surface. Lives under `this.node`. */
  private _selArrow: ArrowHelper | null = null;
  /** Captured at init() so we can build the gizmo without the full context. */
  private _selGizmoMgr: GizmoOverlayManager | null = null;
  /** Unsubscribe handle for the direct 'selection-changed' subscription. */
  private _selUnsub: (() => void) | null = null;
  /** Captured registry — used to map selection paths back to nodes. */
  private _selRegistry: { getNode(path: string): Object3D | null | undefined } | null = null;

  constructor(node: Object3D, aabb: AABB) {
    this.node = node;
    this.aabb = aabb;
  }

  /** Reusable quaternion for world-space direction transform */
  private static _worldQuat = new Quaternion();

  /**
   * Transform transport direction to world space, resolve drive, initialize transport.
   * Called after applySchema + resolveComponentRefs.
   */
  init(context: ComponentContext): void {
    // Capture the LOCAL transport axis as the source of truth — never mutated
    // again. The world direction is derived per tick from this × the node's
    // CURRENT world quaternion, so MUs keep moving along the belt even when
    // a parent drive (e.g. a turntable's Drive-Rot-Y) rotates the platform.
    this.localDirection.copy(this.TransportDirection).normalize();
    if (this.localDirection.lengthSq() === 0) this.localDirection.set(1, 0, 0);

    // Seed `this.direction` (world) immediately so consumers that don't go
    // through `transportMU` (gizmo, debug logs) see a sensible value at init.
    this._refreshWorldDirection();

    // Initialize transport internals (radial, texture animation)
    this.initTransport();

    // Find associated drive: DriveReference first (explicit ref resolved by resolveComponentRefs),
    // then parent hierarchy walk-up
    if (this.DriveReference) {
      this.drive = this.DriveReference;
    }
    if (!this.drive) {
      this.drive = context.registry.findInParent<RVDrive>(this.node, 'Drive');
    }
    if (!this.drive) {
      console.warn(`  TransportSurface "${this.node.name}": no Drive found - will not transport`);
    }

    // Mark drive as transport surface drive (matches Unity's _istransportsurface flag).
    // This is used by multiuser sync to distinguish conveyor drives from positioning drives.
    if (this.drive) {
      this.drive.isTransportSurface = true;
    }

    // Belt drives (conveyor + turntable platform) default to 200 mm/s — twice
    // the generic Drive default (100 mm/s in `RVDrive` schema). We only bump
    // when the drive's `TargetSpeed` is still at the generic default, so a GLB
    // that authored a different value (e.g. 150 or 50) is respected. `applySchema`
    // runs before `init`, so this check fires after any explicit value has
    // already been written by the loader.
    const BELT_DEFAULT_SPEED = 200;
    const DRIVE_SCHEMA_DEFAULT = 100;
    if (this.drive && this.drive.TargetSpeed === DRIVE_SCHEMA_DEFAULT) {
      this.drive.TargetSpeed = BELT_DEFAULT_SPEED;
      this.drive.targetSpeed = BELT_DEFAULT_SPEED;
    }

    // Auto-start: if the drive has a target speed but isn't jogging (Forward signal was false/missing),
    // default to running. In Unity the PLC/LogicStep sets Forward=true during play, but in the
    // WebViewer we want conveyor belts to run out of the box.
    if (this.drive && this.drive.targetSpeed > 0 && !this.drive.jogForward && !this.drive.jogBackward) {
      this.drive.jogForward = true;
    }

    // Stash a reference to the GizmoOverlayManager + node registry so the
    // selection-gizmo logic can build the visualisation without holding
    // the full context.
    this._selGizmoMgr = context.gizmoManager ?? null;
    this._selRegistry = context.registry;

    // Subscribe to selection events DIRECTLY. We can't use the standard
    // `onSelect(selected)` lifecycle hook here because the
    // ComponentEventDispatcher honours only ONE component per node
    // (first-writer wins — see `_rvComponentInstance` in
    // rv-component-registry.ts). Since auto-bound library assets place
    // both `Drive` AND `TransportSurface` on the same node (Transport-Z),
    // the Drive grabs the slot and our `onSelect` would never fire. The
    // direct subscription side-steps that limitation.
    if (context.events) {
      const lastState = { selected: false };
      this._selUnsub = context.events.on('selection-changed', (snap) => {
        const nowSelected = this._isSurfaceImpliedBySelection(snap.selectedPaths ?? []);
        if (nowSelected === lastState.selected) return;
        lastState.selected = nowSelected;
        if (nowSelected) this._showSelectionGizmo();
        else this._hideSelectionGizmo();
      });
    }

    // Register in transport manager
    context.transportManager.surfaces.push(this);

    debug('transport',
      `TransportSurface: ${this.node.name}` +
      ` dir=(${this.TransportDirection.x.toFixed(2)}, ${this.TransportDirection.y.toFixed(2)}, ${this.TransportDirection.z.toFixed(2)})` +
      ` radial=${this.Radial}` +
      (this.drive ? ` drive=${this.drive.name} jogFwd=${this.drive.jogForward}` : ' NO DRIVE')
    );
  }

  /**
   * Whether the current selection should reveal this surface's gizmo. The
   * surface is shown when it sits on the SAME branch as a selected node:
   * either a selected ancestor contains this surface (the common case — the
   * conveyor click resolves to the parent Drive node, which is an ancestor of
   * the child surface node), or a selected child mesh lives under this surface.
   */
  private _isSurfaceImpliedBySelection(paths: readonly string[]): boolean {
    for (const p of paths) {
      const selNode = this._selRegistry?.getNode(p);
      if (!selNode) continue;
      // Selected a parent: the surface is at-or-below the selected node.
      if (this._isAncestorOrSelf(selNode, this.node)) return true;
      // Selected a child mesh: the selection is at-or-below the surface.
      if (this._isAncestorOrSelf(this.node, selNode)) return true;
    }
    return false;
  }

  /** True if `ancestor` is `node` itself or any of its parents. */
  private _isAncestorOrSelf(ancestor: Object3D, node: Object3D): boolean {
    let cur: Object3D | null = node;
    while (cur) {
      if (cur === ancestor) return true;
      cur = cur.parent;
    }
    return false;
  }

  /**
   * Selection-driven visualisation: a wireframe AABB box plus a cyan
   * direction arrow at the AABB centre, both rendered always-on-top and
   * opt-out of raycasting so they never steal hover/click.
   *
   * Subscription is installed in `init()` directly on the viewer event bus
   * (see comment there for why we bypass the standard `onSelect` lifecycle
   * hook). Cleaned up in `dispose()`.
   */
  dispose(): void {
    this._hideSelectionGizmo();
    if (this._selUnsub) { this._selUnsub(); this._selUnsub = null; }
  }

  private _showSelectionGizmo(): void {
    this._hideSelectionGizmo();
    if (!this._selGizmoMgr) return;

    // Blue transparent fill over the TOP face of the surface's bounding box.
    // Built in the node's LOCAL frame and parented to `this.node`, so it
    // follows (and rotates with) the asset.
    this.node.updateMatrixWorld(true);
    const localBox = this._computeLocalAABB();
    if (localBox && !localBox.isEmpty()) {
      const lmin = localBox.min;
      const lmax = localBox.max;
      const sx = Math.max(lmax.x - lmin.x, 1e-4);
      const sz = Math.max(lmax.z - lmin.z, 1e-4);
      const geo = new PlaneGeometry(sx, sz);
      geo.rotateX(-Math.PI / 2); // lie flat in the local XZ plane (normal = +Y)
      const mat = new MeshBasicMaterial({
        color: 0x8ec5ff,         // light blue
        transparent: true,
        opacity: 0.2,
        side: DoubleSide,
        depthTest: false,
        depthWrite: false,
      });
      const surf = new Mesh(geo, mat);
      surf.position.set((lmin.x + lmax.x) / 2, lmax.y, (lmin.z + lmax.z) / 2);
      surf.renderOrder = 2001;
      surf.userData._highlightOverlay = true;
      surf.raycast = () => { /* never a click target */ };
      this.node.add(surf);
      this._selTopSurface = surf;
    }

    // Subtree AABB → local centre for the arrow origin.
    const box = new Box3().setFromObject(this.node);
    const center = new Vector3();
    const size = new Vector3();
    box.getCenter(center);
    box.getSize(size);
    if (!Number.isFinite(size.x) || size.lengthSq() === 0) return;
    const localOrigin = this.node.worldToLocal(center.clone());

    // Use the surface's LOCAL transport axis directly — the arrow sits under
    // `this.node` and inherits its world transform, so the local axis is
    // exactly the right input. This is what keeps the gizmo glued to the
    // belt's true direction even after a parent drive rotates the platform.
    const localDir = this.localDirection.clone();
    if (localDir.lengthSq() === 0) localDir.copy(this.TransportDirection);
    if (localDir.lengthSq() === 0) return;
    localDir.normalize();

    // Fixed 0.5 m arrow in WORLD space. The arrow is parented to `this.node`,
    // so its length is interpreted in node-local units — divide by the node's
    // world scale along the arrow direction so it renders at a true 0.5 m
    // regardless of any scale baked into the surface (e.g. library placements).
    const ARROW_WORLD_LENGTH = 0.5; // metres
    const ws = new Vector3();
    this.node.getWorldScale(ws);
    const scaleAlongDir = Math.hypot(ws.x * localDir.x, ws.y * localDir.y, ws.z * localDir.z) || 1;
    const length = ARROW_WORLD_LENGTH / scaleAlongDir;
    const arrow = new ArrowHelper(
      localDir,
      localOrigin,
      length,
      0x00ddff,         // cyan — high contrast on most scene backgrounds
      length * 0.18,    // head length
      length * 0.10,    // head width
    );
    arrow.line.renderOrder = 2002;
    arrow.cone.renderOrder = 2002;
    type LineMat = { depthTest: boolean };
    type MeshMat = { depthTest: boolean; depthWrite: boolean; transparent: boolean };
    (arrow.line.material as unknown as LineMat).depthTest = false;
    const coneMat = arrow.cone.material as unknown as MeshMat;
    coneMat.depthTest = false;
    coneMat.depthWrite = false;
    coneMat.transparent = true;
    arrow.userData._highlightOverlay = true;
    arrow.raycast = () => { /* never a click target */ };
    this.node.add(arrow);
    this._selArrow = arrow;
  }

  private _hideSelectionGizmo(): void {
    if (this._selTopSurface) {
      this._selTopSurface.parent?.remove(this._selTopSurface);
      this._selTopSurface.geometry.dispose();
      (this._selTopSurface.material as MeshBasicMaterial).dispose();
      this._selTopSurface = null;
    }
    if (this._selArrow) {
      this._selArrow.parent?.remove(this._selArrow);
      this._selArrow.dispose();
      this._selArrow = null;
    }
  }

  /** AABB of all mesh descendants expressed in `this.node`'s LOCAL frame.
   *  Returns null if the subtree has no mesh geometry. */
  private _computeLocalAABB(): Box3 | null {
    const box = new Box3();
    const invNode = new Matrix4().copy(this.node.matrixWorld).invert();
    const m = new Matrix4();
    const tmp = new Box3();
    let found = false;
    this.node.traverse((child) => {
      const mesh = child as Mesh;
      if (mesh.isMesh && mesh.geometry) {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const gb = mesh.geometry.boundingBox;
        if (gb) {
          m.multiplyMatrices(invNode, mesh.matrixWorld);
          tmp.copy(gb).applyMatrix4(m);
          box.union(tmp);
          found = true;
        }
      }
    });
    return found ? box : null;
  }

  /**
   * Build a transient horizontal drop-target plane at the TOP of this surface's
   * AABB, in WORLD space. Used by the planner's drop-to-surface so objects can
   * be placed on the conveyor top even when the surface has no solid top mesh
   * (e.g. an AABB-only / virtual conveyor). The returned mesh is NOT added to
   * the scene — it is only a raycast candidate for the duration of a drag.
   * Returns null for a degenerate (zero-area) footprint.
   */
  createDropPlane(): Mesh | null {
    this.aabb.update();
    const min = this.aabb.min;
    const max = this.aabb.max;
    const sx = max.x - min.x;
    const sz = max.z - min.z;
    if (!Number.isFinite(sx) || !Number.isFinite(sz) || sx <= 1e-4 || sz <= 1e-4) return null;
    const plane = new Mesh(_dropPlaneGeometry, _dropPlaneMaterial);
    plane.position.set((min.x + max.x) / 2, max.y, (min.z + max.z) / 2);
    plane.scale.set(sx, 1, sz);
    plane.userData._rvDropSurface = true;
    plane.updateMatrixWorld(true);
    return plane;
  }

  /**
   * Initialize transport after properties are set (direction, radial, texture animation).
   * Called by the loader after applySchema + quaternion transform.
   */
  initTransport(): void {
    // Note: `this.direction` (world) is already seeded by `init()` via
    // `_refreshWorldDirection()`. We DO NOT mutate it from
    // `TransportDirection` here — `TransportDirection` is the LOCAL axis
    // (Unity-coords) and overwriting `direction` from it would clobber the
    // world-space derivation. The radial axis stays in WORLD space for
    // consistency with `transportMURadial`'s coordinate frame.
    if (this.Radial) {
      this.rotationAxis.copy(this.direction);
    }

    // Texture animation setup
    if (this.AnimateSurface !== false) {
      this._uvDirX = this.rawLocalDir?.x ?? 0;
      this._uvDirY = this.rawLocalDir?.y ?? 0;
      this._uvDirZ = this.rawLocalDir?.z ?? 0;
      this._initTextureAnimation();
    }
  }

  /** Current transport speed in mm/s from the associated Drive */
  get speed(): number {
    if (!this.drive) return 0;
    // Use drive's actual current speed (respects acceleration ramps)
    return this.drive.currentSpeed;
  }

  /** Is the surface actively transporting? (either direction — a reversed belt
   *  has negative speed but is still moving). */
  get isActive(): boolean {
    return this.drive != null && this.speed !== 0;
  }

  /** Authoritative current runtime value for UI display (live source of truth). */
  getLiveState(): Record<string, unknown> {
    return { Speed: this.speed };
  }

  /**
   * Move a MU along the transport direction.
   * Linear transport: direct position offset (+ optional carry by the surface's
   * own world-transform delta when the platform itself moved between ticks —
   * e.g. a turntable rotating under the MU).
   */
  transportMU(mu: RVMovingUnit | InstancedMovingUnit, dt: number): void {
    // Refresh per-tick state (world direction + world-matrix delta) once per
    // tick. Multiple MUs on the same surface share one compute.
    this._refreshWorldDirectionLazy();

    if (this.Radial) {
      // Radial surfaces explicitly rotate MUs around the surface centre —
      // don't ALSO carry by `_matrixDelta` here or we'd double-rotate.
      this.transportMURadial(mu, dt);
      return;
    }

    // Carry the MU along with the surface's own world transform when:
    //   1. The surface actually moved this tick (`_hasTransformDelta`), AND
    //   2. The MU was already on THIS surface in the immediately previous tick
    //      (`lastSurfaceTickId === currentTickId - 1` AND `mu.currentSurface === this`)
    //      — so a freshly-entered MU isn't snapped by a phantom delta.
    if (
      this._hasTransformDelta &&
      mu.currentSurface === this &&
      mu.lastSurfaceTickId === RVTransportSurface._currentTickId - 1
    ) {
      // `mu.getPosition()` / `mu.getQuaternion()` return values in the MU's
      // PARENT-local frame for clone MUs (Source spawns under `spawnParent`,
      // which can itself be a transformed LayoutObject). For instanced MUs
      // the position is world-space, and `getPosition()` returns a temp —
      // we must round-trip via `setPosition` for the write to land in the
      // pool's Float32Array. Either way we drive both via the IMUAccessor's
      // explicit setters: read into scratch, transform, write back.
      const muNode: Object3D | null = (mu as RVMovingUnit).node ?? null;
      const muParent: Object3D | null = (muNode && !(mu as { isInstanced?: boolean }).isInstanced)
        ? muNode.parent
        : null;
      if (muParent) {
        // Clone MU under a (possibly transformed) parent. Convert local→world,
        // apply world-space delta, convert world→local, write via setPosition.
        _scratchVecA.copy(mu.getPosition());
        muParent.localToWorld(_scratchVecA);
        _scratchVecA.applyMatrix4(this._matrixDelta);
        muParent.worldToLocal(_scratchVecA);
        mu.setPosition(_scratchVecA);

        // ORIENTATION: world = parentWorld * local. After carry:
        //   newWorld = delta * world  →  newLocal = parentWorld^-1 * delta * parentWorld * local
        muParent.getWorldQuaternion(_scratchQuatA);             // parentWorld
        _scratchQuatB.copy(_scratchQuatA).invert();             // parentWorld^-1
        _scratchQuatB.multiply(this._deltaQuat).multiply(_scratchQuatA).multiply(mu.getQuaternion());
        mu.setQuaternion(_scratchQuatB);
      } else {
        // Scene-root parented (clone with no parent set yet, or instanced MU
        // whose pool positions are already in world space). Carry in world.
        _scratchVecA.copy(mu.getPosition()).applyMatrix4(this._matrixDelta);
        mu.setPosition(_scratchVecA);
        mu.setQuaternion(_quatCarry.copy(this._deltaQuat).multiply(mu.getQuaternion()));
      }
    }

    // Linear transport: position += direction * speed * dt
    // Speed is in mm/s, Three.js positions are in meters -> divide by MM_TO_METERS
    const speedM = this.speed / MM_TO_METERS;
    if (speedM !== 0 && dt !== 0) {
      _movement.copy(this.direction).multiplyScalar(speedM * dt);
      // Use the explicit get-mutate-set round-trip (matching the carry path above):
      // `getPosition()` returns the live `node.position` reference for clone MUs but
      // a shared TEMP Vector3 for instanced MUs — mutating that temp in place would
      // be lost on return, freezing instanced MUs on the belt. `setPosition()` writes
      // back into the pool's Float32Array, so both backends advance correctly.
      _scratchVecA.copy(mu.getPosition()).add(_movement);
      mu.setPosition(_scratchVecA);
    }
  }

  /** Recompute `this.direction` (world) from `this.localDirection` × current world quaternion. */
  private _refreshWorldDirection(): void {
    this.node.getWorldQuaternion(RVTransportSurface._worldQuat);
    this.direction.copy(this.localDirection).applyQuaternion(RVTransportSurface._worldQuat).normalize();
  }

  /**
   * World-space transport direction (unit vector), recomputed on demand from the
   * authored local axis × the node's current world orientation. Used by topology
   * consumers (e.g. the Turntable classifying connected conveyors as in/out).
   */
  getWorldDirection(out: Vector3 = new Vector3()): Vector3 {
    this._refreshWorldDirection();
    return out.copy(this.direction);
  }

  /**
   * Refresh once per tick (manager bumps `RVTransportSurface._currentTickId`):
   *   • the world transport direction (used by every MU advance), and
   *   • the world-matrix delta vs. the previous tick (used to carry MUs along
   *     with a rotating/translating platform — e.g. a turntable).
   */
  private _refreshWorldDirectionLazy(): void {
    if (this._directionTickId === RVTransportSurface._currentTickId) return;
    this._directionTickId = RVTransportSurface._currentTickId;

    // Make sure the ancestor chain's matrices are current before snapshotting.
    this.node.updateWorldMatrix(true, false);

    // Refresh world direction from local axis × current world quaternion.
    this._refreshWorldDirection();

    // Compute matrix delta = currentWorldMatrix * lastWorldMatrix^-1.
    if (this._lastMatrixCaptured) {
      _scratchInv.copy(this._lastWorldMatrix).invert();
      this._matrixDelta.multiplyMatrices(this.node.matrixWorld, _scratchInv);
      this._hasTransformDelta = !matrixIsIdentity(this._matrixDelta);
      if (this._hasTransformDelta) {
        // Extract rotation part for orientation carry.
        this._deltaQuat.setFromRotationMatrix(this._matrixDelta);
      } else {
        this._deltaQuat.identity();
      }
    } else {
      this._matrixDelta.identity();
      this._deltaQuat.identity();
      this._hasTransformDelta = false;
      this._lastMatrixCaptured = true;
    }
    this._lastWorldMatrix.copy(this.node.matrixWorld);
  }

  /** Called by `RVTransportManager.update()` at the top of each tick. */
  static beginTick(tickId: number): void {
    RVTransportSurface._currentTickId = tickId;
  }
  static get currentTickId(): number { return RVTransportSurface._currentTickId; }
  private static _currentTickId = 0;

  /**
   * Rotate a MU around the surface center (turntable).
   */
  private transportMURadial(mu: RVMovingUnit | InstancedMovingUnit, dt: number): void {
    // Speed is in degrees/s for rotational drives
    const angleDeg = this.speed * dt;
    const angleRad = MathUtils.degToRad(angleDeg);

    // Get surface center in world space
    const surfacePos = this.node.getWorldPosition(_offset);

    // Offset from surface center to MU
    _movement.copy(mu.getPosition()).sub(surfacePos);
    // Rotate offset around axis
    _movement.applyAxisAngle(this.rotationAxis, angleRad);
    // Apply new position
    _offset.copy(surfacePos).add(_movement);
    mu.setPosition(_offset);

    // Also rotate the MU itself
    mu.rotateOnAxis(this.rotationAxis, angleRad);
  }

  /**
   * Animate conveyor belt texture based on drive speed.
   * Mirrors Unity's TransportSurface.UpdateTextureAnimation().
   */
  updateTextureAnimation(dt: number): void {
    if (this._texMaps.length === 0 || !this.drive || this.speed === 0) return;

    if (this.Radial) {
      this._updateRadialTexture(dt);
    } else {
      this._updateLinearTexture(dt);
    }
  }

  /** Update AABB (call once per frame, before overlap checks) */
  updateAABB(): void {
    this.aabb.update();
  }

  // ── Texture Animation (private) ──────────────────────────────────

  /**
   * Find mesh children with textures and clone their maps for independent offset control.
   * Mirrors Unity creating material instances for texture animation.
   */
  private _initTextureAnimation(): void {
    let meshCount = 0;
    let texCount = 0;
    traverseMeshes(this.node, (mesh) => {
      meshCount++;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (let i = 0; i < mats.length; i++) {
        const mat = mats[i] as MeshStandardMaterial;
        if (mat.map) {
          // Clone texture to get independent offset (image data stays shared on GPU)
          const tex = mat.map.clone();
          tex.wrapS = RepeatWrapping;
          tex.wrapT = RepeatWrapping;
          tex.needsUpdate = true;
          mat.map = tex;
          this._texMaps.push(tex);
          texCount++;
        }
      }
    });
    if (texCount > 0) {
      debug('transport', `TransportSurface "${this.node.name}": texture animation enabled (${texCount} textures on ${meshCount} meshes, uvDir=(${this._uvDirX.toFixed(2)}, ${this._uvDirZ.toFixed(2)}))`);
    } else {
      debug('transport', `TransportSurface "${this.node.name}": no textures found for animation (${meshCount} meshes, all without map)`);
    }
  }

  /**
   * Linear texture animation: scroll UV based on drive speed and transport direction.
   * Matches Unity: uvOffset = (localDir.x, localDir.z) * TextureScale * dt * speed / Scale
   */
  private _updateLinearTexture(dt: number): void {
    // speed is mm/s, /MM_TO_METERS converts to m/s (matches Unity's /Scale)
    const speedFactor = this.TextureScale * dt * this.speed / MM_TO_METERS;
    // Use raw Unity local direction for UV (UV coords are in Unity space)
    const du = this._uvDirX * speedFactor;
    const dv = this._uvDirZ * speedFactor;

    for (const tex of this._texMaps) {
      tex.offset.x += du;
      tex.offset.y += dv;
    }
  }

  /**
   * Radial texture animation: scroll U based on angular speed.
   * Matches Unity: rotationSpeed = speed/360, offset.x += movement * sign(localDir.y)
   */
  private _updateRadialTexture(dt: number): void {
    // speed is degrees/s for rotational drives
    const rotationSpeed = this.speed / 360; // revolutions per second
    const movement = rotationSpeed * dt;
    const direction = Math.sign(this._uvDirY);

    this._radialOffsetX += movement * direction;
    // Wrap to [0, 1] to avoid float precision loss over long runs
    this._radialOffsetX -= Math.floor(this._radialOffsetX);

    for (const tex of this._texMaps) {
      tex.offset.x = this._radialOffsetX;
    }
  }
}

// Self-register for auto-discovery by scene loader
registerComponent({
  type: 'TransportSurface',
  schema: RVTransportSurface.schema,
  needsAABB: true,
  capabilities: {
    badgeColor: '#ffa726',
    filterLabel: 'Conveyors',
    simulationActive: true,
  },
  create: (node, aabb) => new RVTransportSurface(node, aabb!),
  beforeSchema: (inst, extras) => {
    const rawDir = extras['TransportDirection'] as { x: number; y: number; z: number } | undefined;
    (inst as RVTransportSurface).rawLocalDir = rawDir
      ? { x: rawDir.x, y: rawDir.y, z: rawDir.z } : { x: 1, y: 0, z: 0 };
  },
});
