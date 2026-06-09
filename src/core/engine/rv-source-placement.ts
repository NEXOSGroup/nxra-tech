// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Pure placement-classification helpers for RVSource.
 *
 * A Source switches its spawn strategy based on what it stands on:
 *  - `'surface'`  — a plain TransportSurface → keep the configured Interval/Distance rhythm.
 *  - `'conveyor'` — an ancestor of the surface carries a ConveyorBehavior → spawn only while the
 *                   conveyor's belt surface(s) are unoccupied (one part per conveyor at a time).
 *  - `'none'`     — no transport surface under the source → never spawn.
 *
 * These functions are intentionally free of Three.js side-effects and engine singletons so they can
 * be unit-tested in isolation. They operate on structural `SurfaceLike` / `MULike` shapes, which the
 * real `RVTransportSurface` and MU classes satisfy. The classifier is generic so callers get their
 * concrete surface type back.
 */

import type { Object3D, Vector3 } from 'three';
import type { AABB } from './rv-aabb';

/** Tolerance (metres) by which a surface top may sit above the source origin and still count as
 *  "under" it — absorbs the case where the source pivot sits slightly inside the belt geometry. */
export const SURFACE_TOP_EPS_M = 0.05;

/** Auto-behaviors that switch the source into occupancy-gated mode. Extensible by design. */
export const OCCUPANCY_GATED_BEHAVIORS = ['ConveyorBehavior'] as const;

export type SourcePlacementMode = 'surface' | 'conveyor' | 'none';

/** Minimal structural view of a transport surface needed for placement decisions. */
export interface SurfaceLike {
  readonly node: Object3D;
  readonly aabb: AABB;
}

/** Minimal structural view of a moving unit needed for occupancy tests. */
export interface MULike {
  readonly aabb: AABB;
  readonly markedForRemoval: boolean;
}

export interface SourcePlacement<T extends SurfaceLike = SurfaceLike> {
  mode: SourcePlacementMode;
  /** The single surface the source sits on (topmost match), or null. */
  surface: T | null;
  /** Ancestor node carrying a gated behavior (conveyor mode only), else null. */
  conveyorRoot: Object3D | null;
  /** Occupancy set: every surface under `conveyorRoot` (conveyor mode only). */
  conveyorSurfaces: T[];
}

/**
 * Find the surface the source stands on: its XZ position must lie within the surface's AABB, the
 * surface top must be at or below the source (within `topEps`), and among all such matches the one
 * with the highest top wins (so a source on an upper level ignores a belt directly beneath it).
 */
export function findSurfaceUnder<T extends SurfaceLike>(
  pos: Vector3,
  surfaces: readonly T[],
  topEps: number,
): T | null {
  let best: T | null = null;
  let bestTop = -Infinity;
  for (const s of surfaces) {
    const a = s.aabb;
    if (pos.x < a.min.x || pos.x > a.max.x) continue;
    if (pos.z < a.min.z || pos.z > a.max.z) continue;
    if (a.max.y > pos.y + topEps) continue; // surface top above the source → not under it
    if (a.max.y > bestTop) {
      bestTop = a.max.y;
      best = s;
    }
  }
  return best;
}

/** Walk ancestors from `node`; return the first node whose `userData.realvirtual` carries one of
 *  the given behavior types, or null. */
export function findGatedBehaviorRoot(node: Object3D, types: readonly string[]): Object3D | null {
  let p: Object3D | null = node;
  while (p) {
    const rv = p.userData?.realvirtual as Record<string, unknown> | undefined;
    if (rv) {
      for (const t of types) {
        if (rv[t] !== undefined) return p;
      }
    }
    p = p.parent;
  }
  return null;
}

/** Collect every surface whose node is `root` or a descendant of it. */
export function collectSurfacesUnder<T extends SurfaceLike>(root: Object3D, surfaces: readonly T[]): T[] {
  const out: T[] = [];
  for (const s of surfaces) {
    let p: Object3D | null = s.node;
    while (p) {
      if (p === root) {
        out.push(s);
        break;
      }
      p = p.parent;
    }
  }
  return out;
}

/** Classify the source's placement from its world position and the live surface set. */
export function classifySourcePlacement<T extends SurfaceLike>(
  pos: Vector3,
  surfaces: readonly T[],
  gatedTypes: readonly string[],
  topEps: number,
): SourcePlacement<T> {
  const surface = findSurfaceUnder(pos, surfaces, topEps);
  if (!surface) {
    return { mode: 'none', surface: null, conveyorRoot: null, conveyorSurfaces: [] };
  }
  const conveyorRoot = findGatedBehaviorRoot(surface.node, gatedTypes);
  if (!conveyorRoot) {
    return { mode: 'surface', surface, conveyorRoot: null, conveyorSurfaces: [] };
  }
  const conveyorSurfaces = collectSurfacesUnder(conveyorRoot, surfaces);
  // Guarantee the surface the source sits on is part of the occupancy set.
  if (!conveyorSurfaces.includes(surface)) conveyorSurfaces.push(surface);
  return { mode: 'conveyor', surface, conveyorRoot, conveyorSurfaces };
}

/** True if any live (not removal-marked) MU's AABB overlaps any of the given surfaces in XZ. */
export function anyMUOnSurfaces(surfaces: readonly SurfaceLike[], mus: readonly MULike[]): boolean {
  for (const mu of mus) {
    if (mu.markedForRemoval) continue;
    for (const s of surfaces) {
      if (s.aabb.overlapsXZ(mu.aabb)) return true;
    }
  }
  return false;
}
