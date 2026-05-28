// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Ghost-snap matcher — magnetic snap for the transient placement ghost.
 *
 * A library asset being dragged out of the catalog lives as a ghost
 * Object3D managed by GhostManager. It is NOT registered in the snap
 * registry (it isn't a placement yet), so the regular SnapMagneticController
 * — which reads moving snaps from the registry — does not see it.
 *
 * `findBestGhostSnap` traverses the ghost subtree on-the-fly, parses every
 * Snap-* node it finds, and tries each one against every compatible
 * registered scene snap. Returns the closest pair within `radius` or null.
 */

import { Vector3 } from 'three';
import type { Object3D } from 'three';
import type {
  SnapPoint,
  SnapPointRegistry,
} from '../../core/engine/rv-snap-point-registry';
import { parseSnapName, type SnapDirection, type SnapFlow, flowsCompatible } from './snap-name-parser';
import { computeSnapAlignedWorldMatrix } from './snap-alignment';

export interface GhostSnapMatch {
  /** Snap-* node found inside the ghost subtree. */
  ghostSnap: Object3D;
  /** Direction parsed from the ghost-snap name. */
  ghostDir: SnapDirection;
  /** Registered scene snap the ghost is closest to. */
  targetSnap: SnapPoint;
  /** World-space distance between ghost-snap and target-snap. */
  distance: number;
}

interface ParsedGhostSnap {
  node: Object3D;
  dir: SnapDirection;
  typeId: string;
  flow?: SnapFlow;
}

const _ghostPos = new Vector3();
const _targetPos = new Vector3();

/** userData key under which we cache the ghost's parsed snap list. The ghost
 *  subtree is structurally stable while a single library entry is shown, so
 *  we can amortise the `traverse + parseSnapName` cost across many dragover
 *  frames. GhostManager swaps the entire root when switching entries, which
 *  drops the cache with it. */
const GHOST_SNAP_CACHE_KEY = '_ghostSnapCache';

function getGhostSnaps(ghostRoot: Object3D): readonly ParsedGhostSnap[] {
  const cached = ghostRoot.userData[GHOST_SNAP_CACHE_KEY] as ParsedGhostSnap[] | undefined;
  if (cached) return cached;
  const parsed: ParsedGhostSnap[] = [];
  ghostRoot.traverse((n) => {
    const p = parseSnapName(n.name);
    if (p) parsed.push({ node: n, dir: p.dir, typeId: p.typeId, flow: p.flow });
  });
  ghostRoot.userData[GHOST_SNAP_CACHE_KEY] = parsed;
  return parsed;
}

/**
 * Find the closest compatible (ghost-snap, scene-snap) pair within `radius`.
 *
 * Same compatibility rules as the regular magnetic controller: typeIds must
 * match AND flows must be compatible (in↔out, bidi↔anything).
 *
 * Returns null when the ghost has no Snap-* children, no compatible
 * candidate is in range, or `radius <= 0`.
 *
 * Caller MUST have called `ghostRoot.updateMatrixWorld(true)` before invoking
 * — this hot path skips the sweep to avoid duplicating work the caller did.
 * Same for scene snaps: registered placements have current world matrices.
 */
export function findBestGhostSnap(
  ghostRoot: Object3D,
  registry: SnapPointRegistry,
  radius: number,
): GhostSnapMatch | null {
  if (radius <= 0) return null;

  const ghostSnaps = getGhostSnaps(ghostRoot);
  if (ghostSnaps.length === 0) return null;

  let best: GhostSnapMatch | null = null;
  let bestDist = radius;
  for (const g of ghostSnaps) {
    g.node.getWorldPosition(_ghostPos);
    for (const c of registry.getCompatible(g.typeId, undefined)) {
      if (c.occupied) continue;
      if (!flowsCompatible(g.flow, c.flow)) continue;
      if (!c.object3D.parent) continue;
      c.object3D.getWorldPosition(_targetPos);
      const d = _ghostPos.distanceTo(_targetPos);
      if (d < bestDist) {
        bestDist = d;
        best = { ghostSnap: g.node, ghostDir: g.dir, targetSnap: c, distance: d };
      }
    }
  }
  return best;
}

/**
 * Apply the snap-aligned transform of `match` to `ghostRoot`. Mirrors the
 * mutation pattern used by SnapMagneticController.tick.
 */
export function applyGhostSnapAlignment(
  ghostRoot: Object3D,
  match: GhostSnapMatch,
): void {
  const M = computeSnapAlignedWorldMatrix(
    match.targetSnap.object3D,
    ghostRoot,
    match.ghostSnap,
    match.targetSnap.dir,
    match.ghostDir,
  );
  ghostRoot.matrixAutoUpdate = false;
  ghostRoot.matrix.copy(M);
  M.decompose(ghostRoot.position, ghostRoot.quaternion, ghostRoot.scale);
  ghostRoot.matrixAutoUpdate = true;
  ghostRoot.updateMatrixWorld(true);
}
