// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3, MathUtils } from 'three';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { AABB } from '../src/core/engine/rv-aabb';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import type { RVMovingUnit } from '../src/core/engine/rv-mu';

/** Minimal stub context — we exercise direction math, not drives/registry. */
function stubContext(): ComponentContext {
  return {
    registry: {
      findInParent: () => null,
    } as unknown as ComponentContext['registry'],
    signalStore: null as unknown as ComponentContext['signalStore'],
    scene: null as unknown as ComponentContext['scene'],
    transportManager: { surfaces: [] } as unknown as ComponentContext['transportManager'],
    root: new Object3D(),
  };
}

/** Build a TransportSurface on a node with a configurable parent transform. */
function makeSurface(opts: {
  parentRotationY?: number;        // radians — applied to the parent
  parentTranslation?: Vector3;
  transportDir?: Vector3;          // local axis
}): { surface: RVTransportSurface; parent: Object3D; node: Object3D } {
  const parent = new Object3D();
  if (opts.parentRotationY !== undefined) parent.rotation.y = opts.parentRotationY;
  if (opts.parentTranslation) parent.position.copy(opts.parentTranslation);
  parent.updateMatrixWorld(true);
  const node = new Object3D(); node.name = 'Transport-Z';
  parent.add(node);
  parent.updateMatrixWorld(true);

  // Surface needs an AABB — fromNode gives a valid default for tests.
  const aabb = AABB.fromNode(node);
  const surface = new RVTransportSurface(node, aabb);
  if (opts.transportDir) surface.TransportDirection.copy(opts.transportDir);
  surface.init(stubContext());
  return { surface, parent, node };
}

/** Read the (private) world-direction via a brief reflective access for testing. */
function worldDirection(surface: RVTransportSurface): Vector3 {
  return (surface as unknown as { direction: Vector3 }).direction.clone();
}
function localDirection(surface: RVTransportSurface): Vector3 {
  return (surface as unknown as { localDirection: Vector3 }).localDirection.clone();
}

describe('RVTransportSurface — direction model', () => {
  it('captures the local transport axis as the source of truth (not mutated)', () => {
    const { surface } = makeSurface({ transportDir: new Vector3(0, 0, 1) });
    expect(localDirection(surface).z).toBeCloseTo(1, 6);
    expect(surface.TransportDirection.z).toBeCloseTo(1, 6);   // NOT overwritten with world
  });

  it('world direction at neutral parent rotation equals local direction', () => {
    const { surface } = makeSurface({ transportDir: new Vector3(0, 0, 1), parentRotationY: 0 });
    const w = worldDirection(surface);
    expect(w.x).toBeCloseTo(0, 6);
    expect(w.z).toBeCloseTo(1, 6);
  });
});

/** Read the (private) matrix-delta state for testing the combined refresh. */
function hasTransformDelta(surface: RVTransportSurface): boolean {
  return (surface as unknown as { _hasTransformDelta: boolean })._hasTransformDelta;
}

describe('RVTransportSurface — world direction follows parent rotation', () => {
  it('rotating the parent by 90° around Y rotates the world transport direction', () => {
    const { surface, parent, node } = makeSurface({ transportDir: new Vector3(0, 0, 1) });

    // Rotate parent 90° around Y and update.
    parent.rotation.y = MathUtils.degToRad(90);
    parent.updateMatrixWorld(true);
    node.updateMatrixWorld(true);

    // Bump the tick counter and exercise the lazy refresh via transportMU.
    RVTransportSurface.beginTick(1);
    surface.transportMU({ getPosition: () => new Vector3() } as unknown as RVMovingUnit, 0);

    // After +90° Y rotation, local +Z (forward) becomes world +X.
    const w = worldDirection(surface);
    expect(w.x).toBeCloseTo(1, 5);
    expect(w.z).toBeCloseTo(0, 5);
  });

  it('per-tick refresh also tracks the world-matrix delta (combined with direction)', () => {
    const { surface, parent, node } = makeSurface({ transportDir: new Vector3(0, 0, 1) });

    // Tick 1: seed the last-matrix snapshot. Delta is identity.
    RVTransportSurface.beginTick(20);
    surface.transportMU({ getPosition: () => new Vector3() } as unknown as RVMovingUnit, 0);
    expect(hasTransformDelta(surface)).toBe(false);

    // Tick 2 with no parent move: still identity.
    RVTransportSurface.beginTick(21);
    surface.transportMU({ getPosition: () => new Vector3() } as unknown as RVMovingUnit, 0);
    expect(hasTransformDelta(surface)).toBe(false);

    // Tick 3 after rotating parent: delta is non-identity.
    parent.rotation.y = MathUtils.degToRad(45);
    parent.updateMatrixWorld(true);
    node.updateMatrixWorld(true);
    RVTransportSurface.beginTick(22);
    surface.transportMU({ getPosition: () => new Vector3() } as unknown as RVMovingUnit, 0);
    expect(hasTransformDelta(surface)).toBe(true);

    // Tick 4 with no further move: delta returns to identity.
    RVTransportSurface.beginTick(23);
    surface.transportMU({ getPosition: () => new Vector3() } as unknown as RVMovingUnit, 0);
    expect(hasTransformDelta(surface)).toBe(false);
  });

  it('refresh is per-tick: same tickId reads cached direction; new tick re-derives', () => {
    const { surface, parent, node } = makeSurface({ transportDir: new Vector3(0, 0, 1) });

    RVTransportSurface.beginTick(10);
    surface.transportMU({ getPosition: () => new Vector3() } as unknown as RVMovingUnit, 0);
    const w0 = worldDirection(surface);
    expect(w0.z).toBeCloseTo(1, 5);

    // Rotate parent but DON'T bump tickId → cached direction still used.
    parent.rotation.y = MathUtils.degToRad(90);
    parent.updateMatrixWorld(true);
    node.updateMatrixWorld(true);
    surface.transportMU({ getPosition: () => new Vector3() } as unknown as RVMovingUnit, 0);
    const w1 = worldDirection(surface);
    expect(w1.z).toBeCloseTo(1, 5);     // unchanged — cached for tick 10

    // Now bump tick → next transportMU re-derives.
    RVTransportSurface.beginTick(11);
    surface.transportMU({ getPosition: () => new Vector3() } as unknown as RVMovingUnit, 0);
    const w2 = worldDirection(surface);
    expect(w2.x).toBeCloseTo(1, 5);
    expect(w2.z).toBeCloseTo(0, 5);
  });
});
