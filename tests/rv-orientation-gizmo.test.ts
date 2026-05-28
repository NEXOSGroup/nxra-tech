// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import {
  AXIS_VECTORS,
  viewToCameraPose,
  type OrientationView,
} from '../src/plugins/rv-orientation-gizmo-plugin';

describe('viewToCameraPose', () => {
  const target = new Vector3(2, 0.5, -1);
  const distance = 6;

  it.each<OrientationView>(['pos-x', 'neg-x', 'pos-z', 'neg-z'])(
    '%s places camera `distance` units from target along the axis',
    (view) => {
      const pos = viewToCameraPose(view, target, distance);
      const offset = pos.clone().sub(target);
      const dir = AXIS_VECTORS[view];
      // dot product equals distance for parallel vectors
      expect(offset.dot(dir)).toBeCloseTo(distance, 5);
      expect(offset.length()).toBeCloseTo(distance, 5);
    },
  );

  it('pos-y nudges position laterally to dodge gimbal lock', () => {
    const pos = viewToCameraPose('pos-y', target, distance);
    expect(pos.y).toBeCloseTo(target.y + distance, 5);
    expect(pos.x).toBeCloseTo(target.x, 5);
    // z is offset by 1e-3
    expect(pos.z).toBeCloseTo(target.z + 1e-3, 6);
    expect(pos.z).not.toBe(target.z);
  });

  it('neg-y nudges position the opposite direction', () => {
    const pos = viewToCameraPose('neg-y', target, distance);
    expect(pos.y).toBeCloseTo(target.y - distance, 5);
    expect(pos.z).toBeCloseTo(target.z - 1e-3, 6);
  });

  it('does NOT mutate the input target', () => {
    const t = new Vector3(1, 2, 3);
    const snapshot = t.clone();
    viewToCameraPose('pos-x', t, 5);
    expect(t.equals(snapshot)).toBe(true);
  });

  it('pos-y with upWorld=+X offsets position in -X (so +X appears up on screen)', () => {
    const t = new Vector3(0, 0, 0);
    const pos = viewToCameraPose('pos-y', t, 10, new Vector3(1, 0, 0));
    expect(pos.x).toBeCloseTo(-1e-3, 6);
    expect(pos.z).toBeCloseTo(0, 6);
    expect(pos.y).toBeCloseTo(10, 5);
  });

  it('pos-y with upWorld=+Z offsets position in -Z', () => {
    const t = new Vector3(0, 0, 0);
    const pos = viewToCameraPose('pos-y', t, 10, new Vector3(0, 0, 1));
    expect(pos.x).toBeCloseTo(0, 6);
    expect(pos.z).toBeCloseTo(-1e-3, 6);
  });

  it('neg-y with upWorld=+X offsets position in +X (sign flipped)', () => {
    const t = new Vector3(0, 0, 0);
    const pos = viewToCameraPose('neg-y', t, 10, new Vector3(1, 0, 0));
    expect(pos.x).toBeCloseTo(1e-3, 6);
    expect(pos.z).toBeCloseTo(0, 6);
    expect(pos.y).toBeCloseTo(-10, 5);
  });
});

describe('AXIS_VECTORS', () => {
  it('all six axes are unit vectors', () => {
    for (const view of Object.keys(AXIS_VECTORS) as OrientationView[]) {
      expect(AXIS_VECTORS[view].length()).toBeCloseTo(1, 6);
    }
  });

  it('positive and negative pairs sum to zero', () => {
    expect(AXIS_VECTORS['pos-x'].clone().add(AXIS_VECTORS['neg-x']).length()).toBeCloseTo(0, 6);
    expect(AXIS_VECTORS['pos-y'].clone().add(AXIS_VECTORS['neg-y']).length()).toBeCloseTo(0, 6);
    expect(AXIS_VECTORS['pos-z'].clone().add(AXIS_VECTORS['neg-z']).length()).toBeCloseTo(0, 6);
  });
});
