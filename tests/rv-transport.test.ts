// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Transport Simulation Tests
 *
 * Tests the transport surface, sensor, source, sink, and MU lifecycle.
 * Runs in browser via Vitest + Playwright (like glb-extras.test.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Vector3, Scene, MathUtils } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { RVSink } from '../src/core/engine/rv-sink';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';

// ─── Helpers ──────────────────────────────────────────────────────

function createMU(name: string, x: number, y: number, z: number): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  return new RVMovingUnit(node, 'test-source', new Vector3(0.05, 0.05, 0.05));
}

function createSurface(
  x: number, y: number, z: number,
  halfSize: Vector3,
  direction: Vector3,
  speed: number,
): RVTransportSurface {
  const node = new Object3D();
  node.position.set(x, y, z);

  const aabb = AABB.fromHalfSize(node, halfSize);
  const surface = new RVTransportSurface(node, aabb);
  surface.TransportDirection.copy(direction);
  surface.Radial = false;
  surface.TextureScale = 1;
  surface.HeightOffsetOverride = 0;
  surface.initTransport();

  // Mock drive with configurable speed (currentSpeed is what TransportSurface reads)
  surface.drive = {
    currentSpeed: speed,
    name: 'mock-drive',
  } as any;

  return surface;
}

function createSensor(x: number, y: number, z: number, halfSize: Vector3): RVSensor {
  const node = new Object3D();
  node.position.set(x, y, z);
  const aabb = AABB.fromHalfSize(node, halfSize);
  const sensor = new RVSensor(node, aabb);
  sensor.invertSignal = false;
  sensor.UseRaycast = false;
  return sensor;
}

function createSink(x: number, y: number, z: number, halfSize: Vector3): RVSink {
  const node = new Object3D();
  node.position.set(x, y, z);
  const aabb = AABB.fromHalfSize(node, halfSize);
  return new RVSink(node, aabb);
}

// ─── Transport Surface Tests ─────────────────────────────────────

describe('RVTransportSurface', () => {
  it('should move MU along transport direction', () => {
    const surface = createSurface(0, 0, 0, new Vector3(2, 0.1, 0.5), new Vector3(1, 0, 0), 1000);
    const mu = createMU('part1', 0, 0, 0);

    const startX = mu.getPosition().x;

    // Simulate 1 second at 1000 mm/s = 1 m/s
    const dt = 1 / 60;
    for (let i = 0; i < 60; i++) {
      surface.transportMU(mu, dt);
    }

    // Should have moved ~1 meter in X
    const movedX = mu.getPosition().x - startX;
    expect(movedX).toBeCloseTo(1.0, 1);
  });

  it('should not transport when no drive assigned', () => {
    const surface = createSurface(0, 0, 0, new Vector3(2, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    surface.drive = null;

    expect(surface.isActive).toBe(false);
    expect(surface.speed).toBe(0);
  });

  it('should report correct speed from drive', () => {
    const surface = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 500);
    expect(surface.speed).toBe(500);
  });
});

// ─── Sensor Tests ────────────────────────────────────────────────

describe('RVSensor', () => {
  it('should detect MU inside sensor area', () => {
    const sensor = createSensor(0, 0, 0, new Vector3(0.5, 0.5, 0.5));
    const mu = createMU('part1', 0, 0, 0);

    sensor.checkOverlap([mu]);
    expect(sensor.occupied).toBe(true);
    expect(sensor.occupiedMU).toBe(mu);
  });

  it('should not detect MU outside sensor area', () => {
    const sensor = createSensor(0, 0, 0, new Vector3(0.5, 0.5, 0.5));
    const mu = createMU('part1', 5, 0, 0);

    sensor.checkOverlap([mu]);
    expect(sensor.occupied).toBe(false);
    expect(sensor.occupiedMU).toBeNull();
  });

  it('should invert signal when configured', () => {
    const node = new Object3D();
    node.position.set(0, 0, 0);
    const aabb = AABB.fromHalfSize(node, new Vector3(0.5, 0.5, 0.5));
    const sensor = new RVSensor(node, aabb);
    sensor.invertSignal = true;
    sensor.UseRaycast = false;

    // MU is inside, but signal is inverted
    const mu = createMU('part1', 0, 0, 0);
    sensor.checkOverlap([mu]);
    expect(sensor.occupied).toBe(false); // Inverted!

    // MU is outside, inverted = occupied
    const mu2 = createMU('part2', 5, 0, 0);
    sensor.checkOverlap([mu2]);
    expect(sensor.occupied).toBe(true); // Inverted!
  });

  it('should fire onChanged callback on state change', () => {
    const sensor = createSensor(0, 0, 0, new Vector3(0.5, 0.5, 0.5));
    let callCount = 0;
    sensor.onChanged = () => { callCount++; };

    const mu = createMU('part1', 0, 0, 0);

    // First check: MU inside -> occupied (change from false to true)
    sensor.checkOverlap([mu]);
    expect(callCount).toBe(1);

    // Second check: MU still inside -> no change
    sensor.checkOverlap([mu]);
    expect(callCount).toBe(1);

    // Third check: MU gone -> unoccupied (change)
    sensor.checkOverlap([]);
    expect(callCount).toBe(2);
  });
});

// ─── Sink Tests ──────────────────────────────────────────────────

describe('RVSink', () => {
  it('should mark overlapping MUs for removal', () => {
    const sink = createSink(0, 0, 0, new Vector3(0.5, 0.5, 0.5));
    const mu = createMU('part1', 0, 0, 0);

    sink.markOverlapping([mu]);
    expect(mu.markedForRemoval).toBe(true);
  });

  it('should not mark MUs outside sink area', () => {
    const sink = createSink(0, 0, 0, new Vector3(0.5, 0.5, 0.5));
    const mu = createMU('part1', 5, 0, 0);

    sink.markOverlapping([mu]);
    expect(mu.markedForRemoval).toBe(false);
  });

  it('should not double-mark already marked MUs', () => {
    const sink = createSink(0, 0, 0, new Vector3(0.5, 0.5, 0.5));
    const mu = createMU('part1', 0, 0, 0);
    mu.markedForRemoval = true;

    sink.markOverlapping([mu]);
    // Should remain marked but callback should not fire again
    expect(mu.markedForRemoval).toBe(true);
  });
});

// ─── Transport Manager Tests ─────────────────────────────────────

describe('RVTransportManager', () => {
  let manager: RVTransportManager;

  beforeEach(() => {
    manager = new RVTransportManager();
    manager.scene = new Scene();
  });

  it('should transport MUs on active surfaces', () => {
    const surface = createSurface(0, 0, 0, new Vector3(5, 0.5, 0.5), new Vector3(1, 0, 0), 1000);
    manager.surfaces.push(surface);

    const mu = createMU('part1', 0, 0, 0);
    manager.mus.push(mu);

    const startX = mu.getPosition().x;
    manager.update(1 / 60);

    expect(mu.getPosition().x).toBeGreaterThan(startX);
  });

  it('should detect sensor overlap after transport', () => {
    const sensor = createSensor(1, 0, 0, new Vector3(0.2, 0.5, 0.5));
    manager.sensors.push(sensor);

    // MU starts at sensor position
    const mu = createMU('part1', 1, 0, 0);
    manager.mus.push(mu);

    manager.update(1 / 60);

    expect(sensor.occupied).toBe(true);
  });

  it('should remove MUs at sink via swap-and-pop', () => {
    const sink = createSink(0, 0, 0, new Vector3(0.5, 0.5, 0.5));
    manager.sinks.push(sink);

    const mu1 = createMU('part1', 0, 0, 0); // At sink
    const mu2 = createMU('part2', 5, 0, 0); // Far away
    manager.mus.push(mu1, mu2);

    manager.update(1 / 60);

    // mu1 should be removed, mu2 should remain
    expect(manager.mus.length).toBe(1);
    expect(manager.mus[0].getName()).toBe('part2');
    expect(manager.totalConsumed).toBe(1);
  });

  it('should handle multiple MUs at sink correctly', () => {
    const sink = createSink(0, 0, 0, new Vector3(1, 1, 1));
    manager.sinks.push(sink);

    // Three MUs at sink, one far away
    manager.mus.push(
      createMU('a', 0, 0, 0),
      createMU('b', 0.1, 0, 0),
      createMU('c', 5, 0, 0), // Not at sink
      createMU('d', -0.1, 0, 0),
    );

    manager.update(1 / 60);

    expect(manager.mus.length).toBe(1);
    expect(manager.mus[0].getName()).toBe('c');
    expect(manager.totalConsumed).toBe(3);
  });

  it('should report correct stats', () => {
    manager.surfaces.push(createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 500));
    manager.sensors.push(createSensor(0, 0, 0, new Vector3(0.5, 0.5, 0.5)));
    manager.sinks.push(createSink(5, 0, 0, new Vector3(0.5, 0.5, 0.5)));

    const s = manager.stats;
    expect(s.surfaces).toBe(1);
    expect(s.sensors).toBe(1);
    expect(s.sinks).toBe(1);
    expect(s.mus).toBe(0);
  });

  it('should reset all state', () => {
    manager.mus.push(createMU('a', 0, 0, 0));
    manager.totalSpawned = 10;
    manager.totalConsumed = 5;

    const sensor = createSensor(0, 0, 0, new Vector3(0.5, 0.5, 0.5));
    sensor.occupied = true;
    manager.sensors.push(sensor);

    manager.reset();

    expect(manager.mus.length).toBe(0);
    expect(manager.totalSpawned).toBe(0);
    expect(manager.totalConsumed).toBe(0);
    expect(sensor.occupied).toBe(false);
  });
});

// ─── Multi-surface hand-off (straddle) ───────────────────────────

describe('RVTransportManager — multi-surface hand-off', () => {
  it('pulls a good straddling a STOPPED belt and a RUNNING belt with the running one', () => {
    const manager = new RVTransportManager();
    manager.scene = new Scene();
    // A spans X[-1,1] and is STOPPED; B spans X[0.5,2.5] and RUNS in +X.
    const A = createSurface(0, 0, 0, new Vector3(1, 0.1, 1), new Vector3(1, 0, 0), 0);
    const B = createSurface(1.5, 0, 0, new Vector3(1, 0.1, 1), new Vector3(1, 0, 0), 1000);
    manager.surfaces.push(A, B);

    const mu = createMU('part1', 0.75, 0, 0); // in the A∩B overlap
    mu.currentSurface = A;                     // arrived on A (the stopped upstream belt)
    manager.mus.push(mu);

    const startX = mu.getPosition().x;
    manager.update(1 / 60);

    expect(mu.getPosition().x).toBeGreaterThan(startX); // pulled forward by B, not frozen on A
    expect(mu.currentSurface).toBe(B);                  // ownership handed to the running belt
  });

  it('keeps a good on its current belt while that belt is the active one (no churn)', () => {
    const manager = new RVTransportManager();
    manager.scene = new Scene();
    const A = createSurface(0, 0, 0, new Vector3(1, 0.1, 1), new Vector3(1, 0, 0), 1000); // running
    const B = createSurface(1.5, 0, 0, new Vector3(1, 0.1, 1), new Vector3(1, 0, 0), 1000);
    manager.surfaces.push(A, B);

    const mu = createMU('part1', 0.75, 0, 0);
    mu.currentSurface = A;
    manager.mus.push(mu);

    manager.update(1 / 60);
    expect(mu.currentSurface).toBe(A); // current is active → stays put, no needless switch
  });

  it('leaves a good in place on a single stopped belt (accumulation)', () => {
    const manager = new RVTransportManager();
    manager.scene = new Scene();
    const A = createSurface(0, 0, 0, new Vector3(1, 0.1, 1), new Vector3(1, 0, 0), 0);
    manager.surfaces.push(A);

    const mu = createMU('part1', 0, 0, 0);
    manager.mus.push(mu);

    const startX = mu.getPosition().x;
    manager.update(1 / 60);
    expect(mu.getPosition().x).toBeCloseTo(startX, 5); // stopped belt → no movement
    expect(mu.currentSurface).toBe(A);                 // still owned; moves once the belt runs
  });

  it('does NOT let a running UPSTREAM belt drag a good that has stopped at its sensor (no overshoot)', () => {
    const manager = new RVTransportManager();
    manager.scene = new Scene();
    // B is the good's belt: STOPPED at its sensor, spans X[0.5,1.5], centre 1.0.
    const B = createSurface(1.0, 0, 0, new Vector3(0.5, 0.1, 1), new Vector3(1, 0, 0), 0);
    // A is UPSTREAM and still RUNNING (+X), spans X[-0.65,1.05] — it overlaps only
    // the good's trailing edge, so the good sits on A's OUTGOING half.
    const A = createSurface(0.2, 0, 0, new Vector3(0.85, 0.1, 1), new Vector3(1, 0, 0), 1000);
    manager.surfaces.push(A, B);

    const mu = createMU('part1', 1.0, 0, 0); // spans X[0.95,1.05]: centre on B, tail still on A
    mu.currentSurface = B;                   // arrived and stopped on B (at the sensor)
    manager.mus.push(mu);

    const startX = mu.getPosition().x;
    manager.update(1 / 60);

    expect(mu.getPosition().x).toBeCloseTo(startX, 5); // upstream belt must NOT drag it forward
    expect(mu.currentSurface).toBe(B);                 // stays owned by the stopped belt it halted on
  });
});

// ─── MU rotation-aware detection footprint ───────────────────────

describe('RVMovingUnit — rotation-aware AABB footprint', () => {
  it('keeps its footprint for an un-rotated part (no change on straight conveyors)', () => {
    const node = new Object3D();
    // Elongated like a Euro-pallet: long axis along local Z.
    const mu = new RVMovingUnit(node, 'src', new Vector3(0.4, 0.2, 0.6));
    mu.updateAABB();
    expect(mu.aabb.halfSize.x).toBeCloseTo(0.4, 3);
    expect(mu.aabb.halfSize.z).toBeCloseTo(0.6, 3);
  });

  it('swaps the footprint axes when the part is rotated 90° (matches the visible mesh)', () => {
    const node = new Object3D();
    const mu = new RVMovingUnit(node, 'src', new Vector3(0.4, 0.2, 0.6));

    // Turn the part 90° about Y — as a turntable corner would.
    node.rotation.y = MathUtils.degToRad(90);
    node.updateMatrixWorld(true);
    mu.updateAABB();

    // Long axis is now world-X, short axis world-Z — so a cross-belt light
    // barrier breaks at the part's true edge instead of ~0.2 m off.
    expect(mu.aabb.halfSize.x).toBeCloseTo(0.6, 3);
    expect(mu.aabb.halfSize.z).toBeCloseTo(0.4, 3);
  });
});

// ─── Vanish MUs at end of line ───────────────────────────────────

describe('RVTransportManager — vanish MUs at end of line', () => {
  let manager: RVTransportManager;

  beforeEach(() => {
    manager = new RVTransportManager();
    manager.scene = new Scene();
    manager.vanishMUsAtEndOfLine = true;
    // End-of-line vanish is SCOPED to planner-placed layout objects. These tests
    // exercise the vanish mechanism, so auto-tag every surface registered here as
    // a layout object. (The NON-layout case is covered by its own test, which
    // un-tags its surface explicitly.)
    const arr = manager.surfaces;
    const origPush = arr.push;
    arr.push = function (...items: RVTransportSurface[]): number {
      for (const s of items) s.node.userData._layoutObject = true;
      return origPush.apply(this, items);
    };
  });

  const dt = 1 / 60;

  /** Run the sim until the MU list drains or `cap` ticks elapse. Returns the
   *  tick count actually run. */
  function run(cap = 400): number {
    let i = 0;
    for (; i < cap; i++) {
      manager.update(dt);
      if (manager.mus.length === 0) break;
    }
    return i;
  }

  it('deletes an MU that runs off the end of the line after the delay', () => {
    // A short belt in +X; the MU starts on it then runs off the +X end.
    const surface = createSurface(0, 0, 0, new Vector3(0.5, 0.1, 0.5), new Vector3(1, 0, 0), 2000);
    manager.surfaces.push(surface);

    const mu = createMU('part1', -0.4, 0, 0); // on the belt
    manager.mus.push(mu);

    // First tick: still on belt → everOnSurface set, timer at 0.
    manager.update(dt);
    expect(mu.everOnSurface).toBe(true);

    run();
    expect(manager.mus.length).toBe(0);
    expect(manager.totalConsumed).toBe(1);
  });

  it('does NOT vanish an MU at a dead end on a NON-layout (authored GLB) surface', () => {
    // Same dead-end geometry as the discharge-belt vanish test, but the surface
    // is NOT a planner-placed layout object — so the MU must be left alone.
    const surface = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    manager.surfaces.push(surface);
    surface.node.userData._layoutObject = false; // authored scene geometry, not placed

    const mu = createMU('part1', 0.9, 0, 0); // parked at the +X discharge end (dead end)
    manager.mus.push(mu);

    manager.update(dt);
    expect(mu.currentSurface).toBe(surface);
    expect(mu.everOnSurface).toBe(true);

    run();
    expect(manager.mus.length).toBe(1);     // dead end, but not on a layout object → survives
    expect(mu.onLayoutObject).toBeFalsy();
  });

  it('does NOT delete when the toggle is off', () => {
    manager.vanishMUsAtEndOfLine = false;
    const surface = createSurface(0, 0, 0, new Vector3(0.5, 0.1, 0.5), new Vector3(1, 0, 0), 2000);
    manager.surfaces.push(surface);

    const mu = createMU('part1', -0.4, 0, 0);
    manager.mus.push(mu);

    run();
    expect(manager.mus.length).toBe(1); // ran off the end but survives
  });

  it('does NOT delete an MU resting MID-belt on a stopped belt (not at the end)', () => {
    const surface = createSurface(0, 0, 0, new Vector3(1, 0.1, 1), new Vector3(1, 0, 0), 0); // stopped
    manager.surfaces.push(surface);

    const mu = createMU('part1', 0, 0, 0); // centre of the belt — room ahead
    manager.mus.push(mu);

    run();
    expect(manager.mus.length).toBe(1);
    expect(mu.currentSurface).toBe(surface); // belt ahead → not a dead end
  });

  it('deletes an MU parked at the end of a STOPPED discharge belt (no successor)', () => {
    // Belt spans X[-1,1] and is STOPPED (end-stop sensor); the MU sits at the
    // +X discharge end and never moves — the case the original off-surface
    // check missed.
    const surface = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    manager.surfaces.push(surface);

    const mu = createMU('part1', 0.9, 0, 0); // leading edge ~0.95, near the belt end 1.0
    manager.mus.push(mu);

    manager.update(dt);
    expect(mu.currentSurface).toBe(surface);
    expect(mu.everOnSurface).toBe(true);

    run();
    expect(manager.mus.length).toBe(0); // nothing ahead → vanished
    expect(manager.totalConsumed).toBe(1);
  });

  it('does NOT vanish a parked dead-end MU when its outgoing snap IS connected', () => {
    // Same dead-end geometry as the stopped-discharge test (a rotated turntable's
    // footprint no longer overlaps the edge), but the conveyor's outgoing snap is
    // connected → the MU must wait, never vanish.
    const surface = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    manager.surfaces.push(surface);
    manager.isOutputConnected = () => true; // connected successor (e.g. rotated turntable)

    const mu = createMU('part1', 0.9, 0, 0); // parked at the +X discharge end
    manager.mus.push(mu);

    run();
    expect(manager.mus.length).toBe(1);       // connected → survives
    expect(mu.offSurfaceTime ?? 0).toBe(0);   // dwell timer held at 0
  });

  it('does NOT vanish a run-off MU when its last surface had a connected output', () => {
    // The MU runs off the +X end (currentSurface → null); connectivity is checked
    // against the LATCHED lastSurface, so a connected line still never vanishes.
    const surface = createSurface(0, 0, 0, new Vector3(0.5, 0.1, 0.5), new Vector3(1, 0, 0), 2000);
    manager.surfaces.push(surface);
    manager.isOutputConnected = () => true;

    const mu = createMU('part1', -0.4, 0, 0);
    manager.mus.push(mu);

    manager.update(dt);
    expect(mu.lastSurface).toBe(surface); // latched while on the belt

    run();
    expect(manager.mus.length).toBe(1);   // ran off but connected → survives
  });

  it('still vanishes a parked dead-end MU when the outgoing snap is UNCONNECTED', () => {
    // The gate must not suppress legitimate end-of-line vanishing.
    const surface = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    manager.surfaces.push(surface);
    manager.isOutputConnected = () => false; // free discharge end

    const mu = createMU('part1', 0.9, 0, 0);
    manager.mus.push(mu);

    run();
    expect(manager.mus.length).toBe(0);     // unconnected dead end → vanishes
    expect(manager.totalConsumed).toBe(1);
  });

  it('does NOT delete an MU stopped at a seam that HAS a successor belt', () => {
    // A (stopped) discharges into B (stopped); their AABBs overlap at the seam.
    // The MU sits at A's discharge end — but B succeeds it, so not a dead end.
    const A = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    const B = createSurface(1.7, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0); // spans X[0.7,2.7]
    manager.surfaces.push(A, B);

    const mu = createMU('part1', 0.9, 0, 0); // in the A∩B overlap
    manager.mus.push(mu);

    run();
    expect(manager.mus.length).toBe(1); // successor ahead → survives
  });

  it('does NOT delete a free MU that was never on any surface', () => {
    // No surfaces at all — the MU floats free but was never transported.
    const mu = createMU('part1', 5, 0, 0);
    manager.mus.push(mu);

    run();
    expect(manager.mus.length).toBe(1);
    expect(mu.everOnSurface).toBeFalsy();
  });

  it('does NOT vanish an MU on a turntable that has an arm conveyor', () => {
    // Turntable = a single Radial surface. It can rotate to discharge to any
    // conveyor it touches, so an MU on it must never be flagged as stuck.
    const turntable = createSurface(0, 0, 0, new Vector3(0.6, 0.1, 0.6), new Vector3(1, 0, 0), 0);
    turntable.Radial = true;
    const arm = createSurface(1.0, 0, 0, new Vector3(0.5, 0.1, 0.3), new Vector3(1, 0, 0), 0); // overlaps turntable
    manager.surfaces.push(turntable, arm);

    const mu = createMU('part1', 0, 0, 0); // centred on the turntable
    manager.mus.push(mu);

    run();
    expect(manager.mus.length).toBe(1);            // turntable can still route it out
    expect(mu.currentSurface).toBe(turntable);
  });

  it('vanishes an MU on a lone turntable with no conveyor attached', () => {
    const turntable = createSurface(0, 0, 0, new Vector3(0.6, 0.1, 0.6), new Vector3(1, 0, 0), 0);
    turntable.Radial = true;
    manager.surfaces.push(turntable);

    const mu = createMU('part1', 0, 0, 0);
    manager.mus.push(mu);

    manager.update(dt);
    expect(mu.everOnSurface).toBe(true);
    run();
    expect(manager.mus.length).toBe(0);            // no output at all → vanish
  });

  it('does NOT vanish an MU on a chain-transfer junction (stacked perpendicular surfaces)', () => {
    // A chain-transfer is two surfaces stacked on one footprint: rollers along
    // one axis and cross-chains perpendicular. An MU on it can exit sideways, so
    // the single-axis probe must not flag it as stuck. The perpendicular surface
    // is modelled by rotating its node 90° about Y (its world transport
    // direction comes from localDirection × node world-quaternion).
    const rollers = createSurface(0, 0, 0, new Vector3(0.6, 0.1, 0.6), new Vector3(1, 0, 0), 0); // world +X
    const chains = createSurface(0, 0.02, 0, new Vector3(0.6, 0.1, 0.6), new Vector3(1, 0, 0), 0); // on top
    chains.node.rotation.y = Math.PI / 2;        // → world transport direction becomes ±Z
    chains.node.updateMatrixWorld(true);
    manager.surfaces.push(rollers, chains);

    const mu = createMU('part1', 0.55, 0, 0); // parked near the rollers' +X discharge edge
    manager.mus.push(mu);

    run();
    expect(manager.mus.length).toBe(1);            // perpendicular output exists → not a dead end
  });

  it('plays a dissolve before removal (not an instant delete at the dwell threshold)', () => {
    const surface = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0); // stopped
    manager.surfaces.push(surface);
    const mu = createMU('part1', 0.9, 0, 0); // parked at the discharge end
    manager.mus.push(mu);

    // Advance just past the dwell delay → the burn dissolve begins; MU still here.
    const delayTicks = Math.ceil(manager.vanishDelaySec / dt) + 1;
    for (let i = 0; i < delayTicks; i++) manager.update(dt);
    expect(manager.mus.length).toBe(1);
    expect(mu.dissolve).toBeTruthy();           // dissolve effect active
    expect(manager.hasVanishingMU).toBe(true);  // renderer kept awake

    // Let the dissolve play out → MU finally removed, signal clears.
    const durTicks = Math.ceil(manager.vanishDurationSec / dt) + 3;
    for (let i = 0; i < durTicks; i++) manager.update(dt);
    expect(manager.mus.length).toBe(0);
    expect(manager.hasVanishingMU).toBe(false);
  });

  it('keeps the dwell timer at zero across an overlapping belt hand-off', () => {
    // Two OVERLAPPING belts form one continuous line (A∩B at X≈[0.5,1.0]); the
    // MU is always on a surface during hand-off, so it never starts vanishing
    // until it finally runs off B's far end.
    const A = createSurface(0, 0, 0, new Vector3(0.75, 0.1, 0.5), new Vector3(1, 0, 0), 2000);
    const B = createSurface(1.25, 0, 0, new Vector3(0.75, 0.1, 0.5), new Vector3(1, 0, 0), 2000);
    manager.surfaces.push(A, B);

    const mu = createMU('part1', -0.6, 0, 0); // starts on A
    manager.mus.push(mu);

    // Step until ownership hands to B; the timer must never have started.
    let pickedUpByB = false;
    for (let i = 0; i < 120; i++) {
      manager.update(dt);
      expect(mu.offSurfaceTime ?? 0).toBe(0); // on a surface the whole way
      if (mu.currentSurface === B) { pickedUpByB = true; break; }
    }
    expect(pickedUpByB).toBe(true);
    expect(manager.mus.length).toBe(1);

    // Finally it runs off B's end and vanishes.
    run();
    expect(manager.mus.length).toBe(0);
  });
});

// ─── End-to-End: Surface -> Sensor -> Sink ───────────────────────

describe('End-to-end transport', () => {
  it('should transport MU from surface through sensor to sink', () => {
    const manager = new RVTransportManager();
    manager.scene = new Scene();

    // Conveyor surface at origin, 5m long, moving in +X at 2000 mm/s
    const surface = createSurface(2.5, 0, 0, new Vector3(2.5, 0.1, 0.5), new Vector3(1, 0, 0), 2000);
    manager.surfaces.push(surface);

    // Sensor at x=2
    const sensor = createSensor(2, 0, 0, new Vector3(0.2, 0.5, 0.5));
    manager.sensors.push(sensor);

    // Sink at x=5
    const sink = createSink(5, 0, 0, new Vector3(0.3, 0.5, 0.5));
    manager.sinks.push(sink);

    // MU starts at x=0 (on the conveyor)
    const mu = createMU('part1', 0, 0, 0);
    manager.mus.push(mu);

    const dt = 1 / 60;
    let sensorTriggered = false;
    let sinkConsumed = false;

    sensor.onChanged = (occupied) => {
      if (occupied) sensorTriggered = true;
    };
    sink.onConsumed = () => {
      sinkConsumed = true;
    };

    // Run for up to 5 seconds of sim time
    for (let i = 0; i < 300; i++) {
      manager.update(dt);
      if (manager.mus.length === 0) break;
    }

    expect(sensorTriggered).toBe(true);
    expect(sinkConsumed).toBe(true);
    expect(manager.mus.length).toBe(0);
    expect(manager.totalConsumed).toBe(1);
  });
});
