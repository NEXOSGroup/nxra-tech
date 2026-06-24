// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { AABB } from '../src/core/engine/rv-aabb';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import type { RVMovingUnit } from '../src/core/engine/rv-mu';

const FIXED_DT = 1 / 60;
const CENTER_LERP = 0.1; // must match CENTER_MU_LERP in rv-transport-surface.ts

/** Minimal stub context — we exercise transport math, not drives/registry. */
function stubContext(): ComponentContext {
  return {
    registry: { findInParent: () => null } as unknown as ComponentContext['registry'],
    signalStore: null as unknown as ComponentContext['signalStore'],
    scene: null as unknown as ComponentContext['scene'],
    transportManager: { surfaces: [] } as unknown as ComponentContext['transportManager'],
    root: new Object3D(),
  };
}

/** Build a transport surface at world origin with a given local transport axis. */
function makeSurface(transportDir: Vector3): RVTransportSurface {
  const node = new Object3D();
  node.name = 'Transport';
  node.updateMatrixWorld(true);
  const surface = new RVTransportSurface(node, AABB.fromNode(node));
  surface.TransportDirection.copy(transportDir);
  surface.init(stubContext());
  // Belt centre line passes through the origin (set explicitly — transportMU
  // reads aabb.center but never recomputes it).
  surface.aabb.center.set(0, 0, 0);
  return surface;
}

/** A movable unit backed by a single mutable position vector. */
function makeMU(pos: Vector3): { mu: RVMovingUnit; pos: Vector3 } {
  const p = pos.clone();
  const mu = {
    getPosition: () => p,
    setPosition: (v: Vector3) => { p.copy(v); },
    rotateOnAxis: () => {},
  } as unknown as RVMovingUnit;
  return { mu, pos: p };
}

describe('RVTransportSurface — lateral belt centering', () => {
  it('eases an off-centre MU toward the centre line by ~10% per tick', () => {
    // Forward = +Z, so the lateral (cross) axis is X. MU starts 0.5 m off-centre.
    const surface = makeSurface(new Vector3(0, 0, 1));
    surface.drive = { currentSpeed: 1000 } as RVTransportSurface['drive']; // 1 m/s
    const { mu, pos } = makeMU(new Vector3(0.5, 0.2, 0));

    let tick = 1;
    let prevLateral = pos.x;
    for (let i = 0; i < 5; i++) {
      RVTransportSurface.beginTick(tick++);
      surface.transportMU(mu, FIXED_DT);
      // Lateral offset shrinks by the lerp fraction each tick.
      expect(pos.x).toBeCloseTo(prevLateral * (1 - CENTER_LERP), 6);
      prevLateral = pos.x;
    }
  });

  it('keeps height and advances along the belt while centering', () => {
    const surface = makeSurface(new Vector3(0, 0, 1));
    surface.drive = { currentSpeed: 1000 } as RVTransportSurface['drive']; // 1 m/s = FIXED_DT m/tick
    const { mu, pos } = makeMU(new Vector3(0.5, 0.2, 0));

    const N = 30;
    for (let i = 0; i < N; i++) {
      RVTransportSurface.beginTick(i + 1);
      surface.transportMU(mu, FIXED_DT);
    }

    // Forward (Z) advanced by speed*dt each tick; height (Y) untouched.
    expect(pos.z).toBeCloseTo(N * FIXED_DT, 6);
    expect(pos.y).toBeCloseTo(0.2, 6);
    // Lateral offset has converged toward the centre line.
    expect(Math.abs(pos.x)).toBeCloseTo(0.5 * Math.pow(1 - CENTER_LERP, N), 6);
    expect(Math.abs(pos.x)).toBeLessThan(0.03);
  });

  it('does not drift the MU laterally when the belt is stopped (speed 0)', () => {
    const surface = makeSurface(new Vector3(0, 0, 1));
    surface.drive = { currentSpeed: 0 } as RVTransportSurface['drive'];
    const { mu, pos } = makeMU(new Vector3(0.5, 0.2, 0));

    RVTransportSurface.beginTick(1);
    surface.transportMU(mu, FIXED_DT);

    expect(pos.x).toBeCloseTo(0.5, 6); // unchanged — no centering on a stopped belt
  });

  it('does not center MUs on a radial (turntable) surface — radius is preserved', () => {
    const surface = makeSurface(new Vector3(0, 1, 0));
    surface.Radial = true;
    (surface as unknown as { rotationAxis: Vector3 }).rotationAxis.set(0, 1, 0);
    surface.drive = { currentSpeed: 90 } as RVTransportSurface['drive']; // 90 deg/s
    const { mu, pos } = makeMU(new Vector3(0.5, 0.2, 0));
    const radius0 = Math.hypot(pos.x, pos.z);

    for (let i = 0; i < 10; i++) {
      RVTransportSurface.beginTick(i + 1);
      surface.transportMU(mu, FIXED_DT);
    }

    // Pure rotation about the centre keeps the radius constant; lateral centering
    // would have shrunk it.
    expect(Math.hypot(pos.x, pos.z)).toBeCloseTo(radius0, 6);
  });
});

describe('RVTransportSurface — snapToCenterLine (planner drop centering)', () => {
  it('removes the cross-belt offset, keeps along-belt position and Y', () => {
    // Forward = +Z → centre line runs along Z through the origin; lateral = X.
    const surface = makeSurface(new Vector3(0, 0, 1));
    const p = new Vector3(0.42, 0.2, 1.3); // 0.42 off-centre laterally, 1.3 down the belt
    surface.snapToCenterLine(p);
    expect(p.x).toBeCloseTo(0, 6);   // lateral offset removed
    expect(p.z).toBeCloseTo(1.3, 6); // along-belt position kept
    expect(p.y).toBeCloseTo(0.2, 6); // height untouched
  });

  it('snaps onto a centre line offset from the origin', () => {
    // Forward = +X → centre line runs along X; lateral = Z.
    const surface = makeSurface(new Vector3(1, 0, 0));
    surface.aabb.center.set(2, 0, 5); // belt centred at x=2, z=5
    const p = new Vector3(3.5, 0, 5.8); // along X=3.5, lateral Z off by 0.8
    surface.snapToCenterLine(p);
    expect(p.z).toBeCloseTo(5, 6);   // snapped to the centre-line Z
    expect(p.x).toBeCloseTo(3.5, 6); // along-belt (X) position kept
  });

  it('createDropPlane carries a back-reference to its surface instance', () => {
    const surface = makeSurface(new Vector3(0, 0, 1));
    // Give the AABB a finite footprint so createDropPlane returns a plane.
    surface.aabb.halfSize.set(0.5, 0.05, 1);
    surface.aabb.update();
    const plane = surface.createDropPlane();
    expect(plane).not.toBeNull();
    expect(plane!.userData._rvDropSurface).toBe(true);
    expect(plane!.userData._rvDropSurfaceInstance).toBe(surface);
  });
});
