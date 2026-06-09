// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for the behavior-facing surface-occupancy helper (`isSurfaceOccupied`).
 *
 * "Occupied" for a conveyor / turntable means a good (MU) is physically on a transport surface
 * under its belt node — driven from the transport manager's live surface + MU sets.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { isSurfaceOccupied } from '../src/behaviors/_shared/surface-occupancy';

/** A surface attached to `node` with a 2×0.2×2 box. */
function surface(node: Object3D) {
  return { node, aabb: AABB.fromHalfSize(node, new Vector3(1, 0.1, 1)) };
}

/** A small good (MU) at a world position. */
function good(x: number, y: number, z: number, markedForRemoval = false) {
  const n = new Object3D();
  n.position.set(x, y, z);
  n.updateMatrixWorld(true);
  return { aabb: AABB.fromHalfSize(n, new Vector3(0.2, 0.2, 0.2)), markedForRemoval };
}

describe('isSurfaceOccupied', () => {
  it('returns false when the host has no transport manager', () => {
    const belt = new Object3D();
    expect(isSurfaceOccupied({}, belt)).toBe(false);
    expect(isSurfaceOccupied({ transportManager: null }, belt)).toBe(false);
  });

  it('returns true only while a live good overlaps a surface under the belt node', () => {
    const belt = new Object3D(); belt.name = 'Transport-X';
    belt.updateMatrixWorld(true);
    const mus: ReturnType<typeof good>[] = [];
    const host = { transportManager: { surfaces: [surface(belt)], mus } };

    expect(isSurfaceOccupied(host, belt)).toBe(false); // empty belt

    mus.push(good(0, 0.2, 0));                          // good on the belt
    expect(isSurfaceOccupied(host, belt)).toBe(true);

    mus.length = 0;
    mus.push(good(5, 0.2, 0));                          // good off the belt
    expect(isSurfaceOccupied(host, belt)).toBe(false);
  });

  it('ignores goods marked for removal', () => {
    const belt = new Object3D(); belt.updateMatrixWorld(true);
    const host = { transportManager: { surfaces: [surface(belt)], mus: [good(0, 0.2, 0, true)] } };
    expect(isSurfaceOccupied(host, belt)).toBe(false);
  });

  it('matches a surface on a descendant of the belt node', () => {
    const belt = new Object3D(); belt.name = 'Transport-X';
    const child = new Object3D(); belt.add(child);
    belt.updateMatrixWorld(true);
    const host = { transportManager: { surfaces: [surface(child)], mus: [good(0, 0.2, 0)] } };
    expect(isSurfaceOccupied(host, belt)).toBe(true);
  });
});
