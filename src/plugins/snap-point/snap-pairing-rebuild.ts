// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Geometry-based snap-pairing reconstruction.
 *
 * Layout restore replays each placement's saved transform but does NOT recreate
 * the runtime snap-registry connection state (`pairedSnapId` / `occupied`). As a
 * result, chained ("enchained") assemblies lose their snap connections on reload
 * — chain-mode dragging, occupancy, and reverse-direction all stop working even
 * though the objects still look connected.
 *
 * Because two mated snap points are placed *exactly coincident* in world space
 * (both `placeAtSnapPoint` and the magnetic drag controller land one snap onto
 * the other), we can reconstruct every connection purely from geometry: pair any
 * two compatible snaps from different owners whose world positions coincide.
 *
 * This pure function does the matching; the planner applies the result to the
 * live `SnapPointRegistry`. Unit-tested in `tests/snap-pairing-rebuild.test.ts`.
 */

import { flowsCompatible, type SnapFlow } from './snap-name-parser';

/** Minimal snap shape the matcher needs (no Three.js dependency). */
export interface RebuildSnapInput {
  /** Registry id (Object3D.uuid). */
  id: string;
  /** Connection type — only equal typeIds may mate. */
  typeId: string;
  /** Flow semantics (in/out/bidi). Undefined is treated as bidi. */
  flow?: SnapFlow;
  /** Identity of the owning placed asset — snaps with the same owner never pair. */
  owner: unknown;
  /** Snap world position. */
  x: number;
  y: number;
  z: number;
}

export interface RebuiltPair {
  aId: string;
  bId: string;
}

/**
 * Pair compatible, coincident snaps from different owners. Greedy nearest-match:
 * each snap is paired at most once, to its closest compatible partner within
 * `epsilon` (world units). Stable: scans in input order; the first snap claims
 * its nearest free partner.
 *
 * @param snaps   Candidate snaps (typically every *unoccupied* registry snap).
 * @param epsilon Max world-space distance to consider two snaps mated.
 */
export function computeProximityPairings(
  snaps: readonly RebuildSnapInput[],
  epsilon: number,
): RebuiltPair[] {
  const eps2 = epsilon * epsilon;
  const claimed = new Set<string>();
  const pairs: RebuiltPair[] = [];

  for (let i = 0; i < snaps.length; i++) {
    const a = snaps[i];
    if (claimed.has(a.id)) continue;

    let best: RebuildSnapInput | null = null;
    let bestD2 = Infinity;
    for (let j = i + 1; j < snaps.length; j++) {
      const b = snaps[j];
      if (claimed.has(b.id)) continue;
      if (b.owner === a.owner) continue;
      if (b.typeId !== a.typeId) continue;
      if (!flowsCompatible(a.flow, b.flow)) continue;
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= eps2 && d2 < bestD2) { bestD2 = d2; best = b; }
    }

    if (best) {
      claimed.add(a.id);
      claimed.add(best.id);
      pairs.push({ aId: a.id, bId: best.id });
    }
  }

  return pairs;
}
