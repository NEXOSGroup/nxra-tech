// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Snap-Flip Service — re-orient a placed component by 180° around its snap.
 *
 * A library component that exposes two compatible snap points (e.g. a belt
 * with an Inlet and an Outlet of the same `typeId`) can be docked to a
 * partner in two orientations. This service performs the binary flip:
 * unpair the currently occupied snap, align the asset so the OTHER snap
 * lands on the same partner, and re-pair. Persistence is forwarded via the
 * standard `'layout-transform-update'` event so the layout-planner op-log
 * + store + multiuser replication all kick in automatically.
 *
 * Scope: exactly two compatible snaps per owner. Components with 3+ snaps
 * (crossings) are out of scope here — see plan-192.
 */

import * as THREE from 'three';
import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { SnapPoint, SnapPointRegistry } from '../../core/engine/rv-snap-point-registry';
import { USER_PAUSE_REASON } from '../../core/engine/rv-constants';
import { computeSnapAlignedWorldMatrix } from './snap-alignment';
import { parseSnapName } from './snap-name-parser';

/** Reason codes for a non-OK flip — keep stable, callers may surface them. */
export type FlipFailReason =
  | 'no-occupied-snap'
  | 'no-compatible-partner'
  | 'no-snap-registry'
  | 'direction-parse-failed';

export interface FlipResult {
  ok: boolean;
  reason?: FlipFailReason;
}

/** Plugin shape narrow type — accessed via `viewer.getPlugin('snap-point')`. */
interface SnapPluginShape {
  getRegistry?(): SnapPointRegistry | null;
  getMarkerRenderer?(): { refreshAll(): void } | null;
}

/**
 * Find the asset's occupied snap and a same-typeId sibling — the two anchors
 * of a 180° flip. Returns null when either is missing. Shared by
 * `canFlipPlacedComponent` (predicate) and `flipPlacedComponent` (mutator).
 */
function findOccupiedAndSibling(
  registry: SnapPointRegistry,
  root: Object3D,
): { occupied: SnapPoint; sibling: SnapPoint } | null {
  const own = registry.getByOwnerRoot(root);
  if (own.length < 2) return null;
  let occupied: SnapPoint | undefined;
  for (const sp of own) {
    if (sp.occupied) { occupied = sp; break; }
  }
  if (!occupied) return null;
  for (const sp of own) {
    if (sp.id === occupied.id) continue;
    if (sp.typeId === occupied.typeId) return { occupied, sibling: sp };
  }
  return null;
}

/**
 * True iff the asset rooted at `root` is currently paired through one snap
 * AND owns a SECOND snap of the same typeId that could carry the connection
 * after a 180° flip. Cheap O(deg) on the root's snaps — safe for use as a
 * context-menu `condition` callback.
 */
export function canFlipPlacedComponent(
  root: Object3D,
  registry: SnapPointRegistry | null,
): boolean {
  if (!registry) return false;
  return findOccupiedAndSibling(registry, root) !== null;
}

/**
 * Flip `root` around its currently engaged snap so that the OTHER compatible
 * snap inherits the connection. Steps:
 *
 *   1. Resolve the occupied snap + its partner via `registry.getById`.
 *   2. Locate the sibling snap on `root` with the same `typeId`.
 *   3. Cache the partner id BEFORE `markFree` (which also clears the partner side).
 *   4. Compute the new world matrix via `computeSnapAlignedWorldMatrix` in
 *      its 5-arg form (target dir + new dir parsed from snap names).
 *   5. Re-pair via `markOccupied` + `pair` — re-fetch the partner first to
 *      survive a concurrent registry mutation.
 *   6. Emit `'layout-transform-update'` so the layout-planner persists the
 *      new pose into the op-log / store / multiuser stream.
 *   7. Pulse the highlight as visual feedback.
 *
 * No-ops gracefully (returns `{ ok: false, reason }`) on every edge case
 * — no scene state is mutated when the operation cannot complete.
 */
export function flipPlacedComponent(
  root: Object3D,
  viewer: RVViewer,
): FlipResult {
  // Registry lives privately inside SnapPointPlugin — go through its getter.
  const snapPlugin = viewer.getPlugin<SnapPluginShape & { id: string }>('snap-point');
  const registry = snapPlugin?.getRegistry?.() ?? null;
  if (!registry) return { ok: false, reason: 'no-snap-registry' };

  const pair = findOccupiedAndSibling(registry, root);
  if (!pair) {
    // Distinguish the two failure modes for callers / tests.
    const reason: FlipFailReason = registry.getByOwnerRoot(root).some(s => s.occupied)
      ? 'no-compatible-partner'
      : 'no-occupied-snap';
    return { ok: false, reason };
  }
  const { occupied, sibling } = pair;

  // Cache partner id BEFORE markFree clears both ends of the pair.
  const partnerId = occupied.pairedSnapId;
  if (!partnerId) return { ok: false, reason: 'no-compatible-partner' };
  const partner = registry.getById(partnerId);
  if (!partner) return { ok: false, reason: 'no-compatible-partner' };

  const targetDir = parseSnapName(partner.object3D.name)?.dir;
  const newDir = parseSnapName(sibling.object3D.name)?.dir;
  if (!targetDir || !newDir) return { ok: false, reason: 'direction-parse-failed' };

  const placedId = occupied.occupiedBy;

  registry.markFree(occupied.id);

  const newWorldMatrix = computeSnapAlignedWorldMatrix(
    partner.object3D, root, sibling.object3D, targetDir, newDir,
  );
  newWorldMatrix.decompose(root.position, root.quaternion, root.scale);
  root.updateMatrixWorld(true);

  if (placedId) {
    registry.markOccupied(sibling.id, placedId);
    // markFree above cleared the partner end too, so it needs re-occupying.
    registry.markOccupied(partnerId, placedId);
  }
  registry.pair(sibling.id, partnerId);

  // Rotation changed which snaps are occupied: the previously-engaged snap is
  // now free (and sits at a new world position) while the sibling is occupied.
  // Re-sync the marker visuals from registry occupancy so the "+" markers
  // reflect the post-rotation state (the freed snap can be reused, the sibling
  // is hidden). Without this the markers/occupancy appear "stuck" pre-flip.
  snapPlugin?.getMarkerRenderer?.()?.refreshAll();

  // Auto-stop the simulation: flipping is a user edit of a placed object.
  // Uses the user-owned pause reason so the toolbar Play button resumes it.
  viewer.setSimulationPaused?.(USER_PAUSE_REASON, true);

  // 5. Persist via the standard layout-transform-update event. Path comes
  //    from the viewer's node registry so the layout-planner can resolve it
  //    back to a placement id.
  const path = viewer.registry?.getPathForNode(root) ?? root.name;
  viewer.emit('layout-transform-update', {
    path,
    position: [root.position.x, root.position.y, root.position.z],
    rotation: [
      THREE.MathUtils.radToDeg(root.rotation.x),
      THREE.MathUtils.radToDeg(root.rotation.y),
      THREE.MathUtils.radToDeg(root.rotation.z),
    ],
  });

  // 6. Visual feedback — short highlight pulse.
  pulseHighlight(viewer, root, 350);

  return { ok: true };
}

/**
 * Brief hover-style highlight on `node`, auto-cleared after `durationMs`.
 * Defensive — RVHighlightManager exposes `highlight(root)` and a no-arg
 * `clear()` (it clears whatever the current hover is), and may itself be
 * absent on minimal viewer setups (tests). All paths are wrapped so the
 * service stays robust.
 */
function pulseHighlight(viewer: RVViewer, node: Object3D, durationMs: number): void {
  const h = viewer.highlighter as
    | (RVViewer['highlighter'] & { highlight?: (n: Object3D) => void; clear?: () => void })
    | undefined;
  if (!h || typeof h.highlight !== 'function') return;
  try { h.highlight(node); } catch { return; }
  setTimeout(() => {
    try { h.clear?.(); } catch { /* swallow — pulse is purely cosmetic */ }
  }, durationMs);
}
