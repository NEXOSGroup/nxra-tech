// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3, Quaternion, MathUtils } from 'three';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { AABB } from '../src/core/engine/rv-aabb';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import type { RVMovingUnit, IMUAccessor } from '../src/core/engine/rv-mu';

/** Minimal stub context — same shape as the existing direction tests. */
function stubContext(): ComponentContext {
  return {
    registry: { findInParent: () => null } as unknown as ComponentContext['registry'],
    signalStore: null as unknown as ComponentContext['signalStore'],
    scene: null as unknown as ComponentContext['scene'],
    transportManager: { surfaces: [] } as unknown as ComponentContext['transportManager'],
    root: new Object3D(),
  };
}

/**
 * Build a TransportSurface under a configurable parent. The parent rotates —
 * the surface itself stays at identity locally — so the surface's matrixWorld
 * tracks the parent's rotation, which is exactly the turntable layout.
 */
function makeSurface(opts: {
  transportDir?: Vector3;
  initialParentRotY?: number; // radians
}): { surface: RVTransportSurface; parent: Object3D; node: Object3D } {
  const parent = new Object3D();
  if (opts.initialParentRotY !== undefined) parent.rotation.y = opts.initialParentRotY;
  parent.updateMatrixWorld(true);
  const node = new Object3D();
  node.name = 'Transport-Z';
  parent.add(node);
  parent.updateMatrixWorld(true);

  const aabb = AABB.fromNode(node);
  const surface = new RVTransportSurface(node, aabb);
  if (opts.transportDir) surface.TransportDirection.copy(opts.transportDir);
  surface.init(stubContext());
  return { surface, parent, node };
}

/** Stub MU that mirrors the IMUAccessor shape the surface actually touches. */
class FakeMU implements Partial<RVMovingUnit> {
  readonly node = new Object3D();
  readonly isInstanced = false;
  readonly markedForRemoval = false;
  isGripped = false;
  currentSurface: RVTransportSurface | null = null;
  lastSurfaceTickId?: number;

  getPosition(): Vector3 { return this.node.position; }
  setPosition(v: Vector3): void { this.node.position.copy(v); }
  getQuaternion(): Quaternion { return this.node.quaternion; }
  setQuaternion(q: Quaternion): void { this.node.quaternion.copy(q); }
  rotateOnAxis(axis: Vector3, angle: number): void { this.node.rotateOnAxis(axis, angle); }
  getName(): string { return 'fake-mu'; }
  getWorldPosition(out: Vector3): Vector3 { return this.node.getWorldPosition(out); }
}

/**
 * Drive the surface's per-tick state up to a given tickId without ever calling
 * transportMU (so the surface captures matrices but applies no carry). Useful
 * for seeding the surface BEFORE the test's interesting tick.
 */
function bumpSurfaceTicks(surface: RVTransportSurface, count: number, startId = 1): number {
  for (let i = 0; i < count; i++) {
    RVTransportSurface.beginTick(startId + i);
    // Call transportMU with a throwaway MU that hasn't been on the surface —
    // this triggers the lazy refresh but skips the carry (guard fails).
    const throwaway = new FakeMU();
    surface.transportMU(throwaway as unknown as RVMovingUnit, 0);
  }
  return startId + count - 1;
}

describe('RVTransportSurface — MU carry by surface rotation', () => {
  it('carries an MU around the parent pivot when matrix delta is non-identity AND mu was on the surface last tick', () => {
    const { surface, parent, node } = makeSurface({ transportDir: new Vector3(1, 0, 0) });
    // Place an MU at world position (0, 0, 0.5) — i.e. 0.5 m forward of the
    // surface origin along local +Z (before the parent rotates).
    const mu = new FakeMU();
    mu.getPosition().set(0, 0, 0.5);
    mu.currentSurface = surface;

    // Tick 1: seed last-matrix and mark MU as on-surface.
    const lastTick = bumpSurfaceTicks(surface, 1, 1);
    mu.lastSurfaceTickId = lastTick;

    // Between ticks: rotate the parent 90° around Y. world +X now points where
    // local +Z used to. The MU at (0,0,0.5) should be carried to (0.5, 0, 0).
    parent.rotation.y = MathUtils.degToRad(90);
    parent.updateMatrixWorld(true);
    node.updateMatrixWorld(true);

    // Tick 2: surface sees a non-identity delta and the MU is eligible.
    RVTransportSurface.beginTick(lastTick + 1);
    surface.transportMU(mu as unknown as RVMovingUnit, 0); // dt=0 so the speed*dt part contributes nothing
    expect(mu.getPosition().x).toBeCloseTo(0.5, 5);
    expect(mu.getPosition().z).toBeCloseTo(0, 5);

    // Orientation: starts as identity. After +90° Y rotation, the carry should
    // have applied (0,sin(45°),0,cos(45°)) — a +90° Y rotation quaternion.
    const expectedQuat = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    expect(mu.getQuaternion().x).toBeCloseTo(expectedQuat.x, 5);
    expect(mu.getQuaternion().y).toBeCloseTo(expectedQuat.y, 5);
    expect(mu.getQuaternion().z).toBeCloseTo(expectedQuat.z, 5);
    expect(mu.getQuaternion().w).toBeCloseTo(expectedQuat.w, 5);
  });

  it('does NOT carry an MU that just entered the surface this tick (lastSurfaceTickId undefined)', () => {
    const { surface, parent } = makeSurface({ transportDir: new Vector3(1, 0, 0) });
    const mu = new FakeMU();
    mu.getPosition().set(0, 0, 0.5);
    mu.currentSurface = surface;
    // NOTE: lastSurfaceTickId left undefined — MU just entered.

    // Seed the surface so it has a prior matrix to diff against.
    bumpSurfaceTicks(surface, 1, 1);

    // Rotate parent 90° between ticks.
    parent.rotation.y = MathUtils.degToRad(90);
    parent.updateMatrixWorld(true);

    RVTransportSurface.beginTick(2);
    surface.transportMU(mu as unknown as RVMovingUnit, 0);

    // No carry: position unchanged from where we placed it.
    expect(mu.getPosition().x).toBeCloseTo(0, 5);
    expect(mu.getPosition().z).toBeCloseTo(0.5, 5);
  });

  it('does NOT carry an MU when the surface did not move between ticks (identity delta)', () => {
    const { surface } = makeSurface({ transportDir: new Vector3(1, 0, 0) });
    const mu = new FakeMU();
    mu.getPosition().set(0, 0, 0.5);
    mu.currentSurface = surface;

    const lastTick = bumpSurfaceTicks(surface, 1, 1);
    mu.lastSurfaceTickId = lastTick;

    // No parent move — but the carry path checks both flag and prior-tick eligibility.
    RVTransportSurface.beginTick(lastTick + 1);
    surface.transportMU(mu as unknown as RVMovingUnit, 0);

    expect(mu.getPosition().x).toBeCloseTo(0, 6);
    expect(mu.getPosition().z).toBeCloseTo(0.5, 6);
    expect(mu.getQuaternion().x).toBeCloseTo(0, 6);
    expect(mu.getQuaternion().w).toBeCloseTo(1, 6);
  });

  it('multiple MUs on the same surface in the same tick share one matrix-delta refresh (cached)', () => {
    const { surface, parent } = makeSurface({ transportDir: new Vector3(1, 0, 0) });
    const mu1 = new FakeMU();
    mu1.getPosition().set(0, 0, 0.5);
    mu1.currentSurface = surface;
    const mu2 = new FakeMU();
    mu2.getPosition().set(0, 0, -0.5);
    mu2.currentSurface = surface;

    const lastTick = bumpSurfaceTicks(surface, 1, 1);
    mu1.lastSurfaceTickId = lastTick;
    mu2.lastSurfaceTickId = lastTick;

    parent.rotation.y = MathUtils.degToRad(90);
    parent.updateMatrixWorld(true);

    RVTransportSurface.beginTick(lastTick + 1);
    surface.transportMU(mu1 as unknown as RVMovingUnit, 0);
    // The lazy refresh ran once for mu1. mu2 must see the SAME delta and be
    // carried by the same +90° rotation around Y — (0,0,-0.5) → (-0.5,0,0).
    surface.transportMU(mu2 as unknown as RVMovingUnit, 0);
    expect(mu1.getPosition().x).toBeCloseTo(0.5, 5);
    expect(mu1.getPosition().z).toBeCloseTo(0, 5);
    expect(mu2.getPosition().x).toBeCloseTo(-0.5, 5);
    expect(mu2.getPosition().z).toBeCloseTo(0, 5);
  });

  it('Radial surfaces skip the per-tick carry (rotation is owned by transportMURadial)', () => {
    const { surface, parent } = makeSurface({ transportDir: new Vector3(1, 0, 0) });
    // Flip to radial mode and seed the rotation axis (Radial transport reads
    // `rotationAxis` which is initialised from the world direction in
    // `initTransport()` when `Radial` is true). We toggle the flag AFTER init
    // so the surface still configures itself reasonably for the test.
    (surface as unknown as { Radial: boolean }).Radial = true;
    // The radial branch calls `transportMURadial` which reads `this.speed`.
    // With no drive attached `speed` is 0 → no rotation applied. We just want
    // to confirm the position carry doesn't fire.

    const mu = new FakeMU();
    mu.getPosition().set(0, 0, 0.5);
    mu.currentSurface = surface;
    const lastTick = bumpSurfaceTicks(surface, 1, 1);
    mu.lastSurfaceTickId = lastTick;

    parent.rotation.y = MathUtils.degToRad(90);
    parent.updateMatrixWorld(true);

    RVTransportSurface.beginTick(lastTick + 1);
    surface.transportMU(mu as unknown as RVMovingUnit, 0);

    // Position unchanged: the linear carry path was skipped because Radial=true.
    expect(mu.getPosition().x).toBeCloseTo(0, 5);
    expect(mu.getPosition().z).toBeCloseTo(0.5, 5);
  });
});

// Compile-time assertion: FakeMU satisfies the public surface of IMUAccessor.
const _typeCheck: IMUAccessor = new FakeMU() as unknown as IMUAccessor;
void _typeCheck;
