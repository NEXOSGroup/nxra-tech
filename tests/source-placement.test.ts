// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Unit tests for the pure Source placement classifier (rv-source-placement.ts).
 *
 * Covers the three placement modes a Source switches between:
 *  - 'surface'  : plain transport surface under the source.
 *  - 'conveyor' : an ancestor of the surface carries a ConveyorBehavior.
 *  - 'none'     : no surface under the source.
 * Plus the topmost-surface tiebreak, ancestor behavior walk, and MU occupancy test.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import {
  classifySourcePlacement,
  findGatedBehaviorRoot,
  anyMUOnSurfaces,
  OCCUPANCY_GATED_BEHAVIORS,
  SURFACE_TOP_EPS_M,
  type SurfaceLike,
  type MULike,
} from '../src/core/engine/rv-source-placement';

/** Build a SurfaceLike at a world position with the given half-extents. */
function makeSurface(parent: Object3D | null, x: number, y: number, z: number, half: Vector3): SurfaceLike {
  const node = new Object3D();
  node.position.set(x, y, z);
  if (parent) parent.add(node);
  node.updateMatrixWorld(true);
  return { node, aabb: AABB.fromHalfSize(node, half) };
}

function makeMU(x: number, y: number, z: number, half: Vector3, markedForRemoval = false): MULike {
  const node = new Object3D();
  node.position.set(x, y, z);
  node.updateMatrixWorld(true);
  return { aabb: AABB.fromHalfSize(node, half), markedForRemoval };
}

const HALF = new Vector3(1, 0.1, 1); // 2×0.2×2 belt → top at y = pos.y + 0.1

describe('classifySourcePlacement', () => {
  it("returns 'surface' for a plain transport surface under the source", () => {
    const belt = makeSurface(null, 0, 0, 0, HALF);
    const p = classifySourcePlacement(new Vector3(0, 0.1, 0), [belt], OCCUPANCY_GATED_BEHAVIORS, SURFACE_TOP_EPS_M);
    expect(p.mode).toBe('surface');
    expect(p.surface).toBe(belt);
    expect(p.conveyorRoot).toBeNull();
  });

  it("returns 'conveyor' when an ancestor carries a ConveyorBehavior", () => {
    const root = new Object3D();
    root.userData.realvirtual = { ConveyorBehavior: { Belt: 'Transport', Sensor: 'Sensor' } };
    const belt = makeSurface(root, 0, 0, 0, HALF);
    root.updateMatrixWorld(true);
    const p = classifySourcePlacement(new Vector3(0, 0.1, 0), [belt], OCCUPANCY_GATED_BEHAVIORS, SURFACE_TOP_EPS_M);
    expect(p.mode).toBe('conveyor');
    expect(p.conveyorRoot).toBe(root);
    expect(p.conveyorSurfaces).toContain(belt);
  });

  it("returns 'none' when no surface is under the source", () => {
    const belt = makeSurface(null, 0, 0, 0, HALF);
    const p = classifySourcePlacement(new Vector3(5, 0.1, 0), [belt], OCCUPANCY_GATED_BEHAVIORS, SURFACE_TOP_EPS_M);
    expect(p.mode).toBe('none');
    expect(p.surface).toBeNull();
  });

  it('picks the topmost surface when several overlap below the source', () => {
    const low = makeSurface(null, 0, 0, 0, HALF); // top 0.1
    const high = makeSurface(null, 0, 0.4, 0, HALF); // top 0.5
    const p = classifySourcePlacement(new Vector3(0, 0.6, 0), [low, high], OCCUPANCY_GATED_BEHAVIORS, SURFACE_TOP_EPS_M);
    expect(p.surface).toBe(high);
  });

  it('ignores a surface whose top is above the source (different level below)', () => {
    const above = makeSurface(null, 0, 2, 0, HALF); // top 2.1, well above the source
    const p = classifySourcePlacement(new Vector3(0, 0.1, 0), [above], OCCUPANCY_GATED_BEHAVIORS, SURFACE_TOP_EPS_M);
    expect(p.mode).toBe('none');
  });
});

describe('findGatedBehaviorRoot', () => {
  it('walks ancestors and ignores non-gated behaviors', () => {
    const root = new Object3D();
    root.userData.realvirtual = { SomeOtherBehavior: {} };
    const child = new Object3D();
    root.add(child);
    expect(findGatedBehaviorRoot(child, OCCUPANCY_GATED_BEHAVIORS)).toBeNull();

    root.userData.realvirtual.ConveyorBehavior = {};
    expect(findGatedBehaviorRoot(child, OCCUPANCY_GATED_BEHAVIORS)).toBe(root);
  });
});

describe('anyMUOnSurfaces', () => {
  it('is true only when a live MU overlaps a surface in XZ', () => {
    const belt = makeSurface(null, 0, 0, 0, HALF);
    const muHalf = new Vector3(0.2, 0.2, 0.2);
    expect(anyMUOnSurfaces([belt], [makeMU(0, 0.2, 0, muHalf)])).toBe(true); // on belt
    expect(anyMUOnSurfaces([belt], [makeMU(5, 0.2, 0, muHalf)])).toBe(false); // off belt
  });

  it('skips MUs marked for removal', () => {
    const belt = makeSurface(null, 0, 0, 0, HALF);
    const muHalf = new Vector3(0.2, 0.2, 0.2);
    expect(anyMUOnSurfaces([belt], [makeMU(0, 0.2, 0, muHalf, true)])).toBe(false);
  });
});
