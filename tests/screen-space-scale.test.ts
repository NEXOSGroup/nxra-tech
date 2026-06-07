// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Constant-screen-size scaling helper tests (rv-screen-space-scale).
 * Mirrors the FloorGizmo `_sync` maths: pick a world scale so an object spans a
 * fixed pixel size at any camera distance / zoom.
 */

import { describe, it, expect } from 'vitest';
import {
  Object3D, Group, Sprite, PerspectiveCamera, OrthographicCamera, Vector3,
} from 'three';
import {
  worldPerPixelAt, applyScreenSpaceScale,
} from '../src/core/engine/rv-screen-space-scale';

describe('worldPerPixelAt', () => {
  it('scales linearly with distance for a perspective camera', () => {
    const cam = new PerspectiveCamera(60, 1, 0.1, 100);
    cam.position.set(0, 0, 0);
    cam.updateMatrixWorld(true);
    const near = worldPerPixelAt(cam, 1000, new Vector3(0, 0, -5));
    const far = worldPerPixelAt(cam, 1000, new Vector3(0, 0, -10));
    expect(far).toBeCloseTo(near * 2, 6); // twice the distance → twice world/px
  });

  it('is distance-independent for an orthographic camera', () => {
    const cam = new OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
    cam.position.set(0, 0, 10);
    cam.zoom = 1;
    cam.updateMatrixWorld(true);
    const a = worldPerPixelAt(cam, 1000, new Vector3(0, 0, 0));
    const b = worldPerPixelAt(cam, 1000, new Vector3(0, 0, -50));
    expect(a).toBeCloseTo(b, 10);
    // (top - bottom) / zoom / height = 10 / 1 / 1000
    expect(a).toBeCloseTo(0.01, 10);
  });
});

describe('applyScreenSpaceScale', () => {
  it('sets a node\'s scale to span the requested pixels (perspective)', () => {
    const cam = new PerspectiveCamera(60, 1, 0.1, 100);
    cam.position.set(0, 0, 0);
    cam.updateMatrixWorld(true);
    const node = new Sprite();
    node.position.set(0, 0, -5);
    node.updateMatrixWorld(true);
    const world = applyScreenSpaceScale(node, 20, cam, 1000);
    const expected = 20 * worldPerPixelAt(cam, 1000, new Vector3(0, 0, -5));
    expect(world).toBeCloseTo(expected, 6);
    expect(node.scale.x).toBeCloseTo(expected, 6); // no parent scale → local == world
  });

  it('compensates for a scaled parent so the on-screen size is unchanged', () => {
    const cam = new PerspectiveCamera(60, 1, 0.1, 100);
    cam.position.set(0, 0, 0);
    cam.updateMatrixWorld(true);
    const parent = new Group();
    parent.scale.setScalar(0.001);            // mm→m style root
    const node = new Object3D();
    parent.add(node);
    node.position.set(0, 0, -5000);            // 5 m in parent-local units
    parent.updateMatrixWorld(true);
    const world = applyScreenSpaceScale(node, 20, cam, 1000);
    // local scale = worldSize / parentScale → local * parentScale == worldSize
    expect(node.scale.x * 0.001).toBeCloseTo(world, 6);
  });
});
