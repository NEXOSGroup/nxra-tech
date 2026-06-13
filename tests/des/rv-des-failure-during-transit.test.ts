// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TestDESFailureDuringTransit -- a failure (downtime / stop) must HALT work that
 * is already in progress, not just block new intake, and resume it with the
 * REMAINING time on repair (so MTTR extends the effective cycle/transport time).
 *
 * Covers the three components that schedule time-consuming self-events:
 *   - DESConveyor : an in-transit MU must not arrive while the belt is down.
 *   - DESStation  : an in-process MU must not complete while the machine is down.
 *   - DESSource   : generation must pause on failure and resume on repair
 *                   (regression: a failed source used to go permanently dormant).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { DESManager, DESMode } from '@rv-private/plugins/des/rv-des-manager';
import { DES } from '@rv-private/plugins/des/rv-des-api';
import { DESSource } from '@rv-private/plugins/des/rv-des-source';
import { DESSink } from '@rv-private/plugins/des/rv-des-sink';
import { DESConveyor } from '@rv-private/plugins/des/rv-des-conveyor';
import { DESStation } from '@rv-private/plugins/des/rv-des-station';
import { createDESMU, resetDESMUCounter } from '@rv-private/plugins/des/rv-des-mu';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';

// ── Helpers ──

function createNode(name: string, x = 0, y = 0, z = 0): Object3D {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  return node;
}

function makeContext(scene: Scene) {
  return {
    registry: new NodeRegistry(),
    signalStore: new SignalStore(),
    scene,
    transportManager: {} as never,
    root: scene,
  };
}

/** Advance sim time to (at least) `target` seconds in fixed 0.1 s ticks. */
function advanceTo(manager: DESManager, target: number): void {
  let guard = 0;
  while (manager.currentTime < target && guard++ < 100000) {
    manager.processAnimated(0.1);
  }
}

describe('DES failure during transit/processing', () => {
  let manager: DESManager;
  let scene: Scene;

  beforeEach(() => {
    manager = new DESManager();
    manager.mode = DESMode.Animated;
    manager.duration = 100000;
    DES.setManager(manager);
    resetDESMUCounter();
  });

  it('Conveyor: an in-transit MU does NOT arrive while failed, resumes with remaining time on repair', () => {
    scene = new Scene();
    const ctx = makeContext(scene);

    const convNode = createNode('Conv', 1, 0, 0);
    const sinkNode = createNode('Sink', 2, 0, 0);
    scene.add(convNode, sinkNode);

    const conv = new DESConveyor(convNode);
    conv.ConveyorLength = 1000; // mm
    conv.ConveyorSpeed = 200;    // mm/s -> transportTime = 5 s
    const sink = new DESSink(sinkNode);

    conv.nextComponents = [sink];
    sink.previousComponents = [conv];

    manager.registerComponent(conv);
    manager.registerComponent(sink);
    conv.init(ctx);
    sink.init(ctx);

    // Put one MU on the belt at t=0 — arrival is due at t=5.
    const mu = createDESMU(manager.currentTime);
    manager.registerMU(mu);
    expect(conv.acceptMU(mu)).toBe(true);

    // Advance to t=2 — MU is mid-belt, not yet at the sink.
    advanceTo(manager, 2);
    expect(sink.totalConsumed).toBe(0);

    // Belt goes down mid-transit. The arrival event must be cancelled.
    conv.setFailure(true);
    expect(conv.isFailure).toBe(true);

    // Advance well past the original arrival time (t=5). With the fix the MU
    // must STILL be on the belt — it must not teleport through a stopped belt.
    advanceTo(manager, 10);
    expect(sink.totalConsumed).toBe(0);

    // Repair at ~t=10. Remaining transport was 5 - 2 = 3 s, so arrival is now ~t=13.
    conv.setFailure(false);
    expect(conv.isFailure).toBe(false);

    // Still not arrived right after repair...
    advanceTo(manager, 12);
    expect(sink.totalConsumed).toBe(0);

    // ...arrives after the remaining 3 s have elapsed.
    advanceTo(manager, 14);
    expect(sink.totalConsumed).toBe(1);

    // The part arrived at ~t=13 (5 s transport + ~8 s downtime), proving the
    // downtime extended the effective transport time rather than being ignored.
    expect(manager.currentTime).toBeGreaterThan(12.9);
  });

  it('Station: an in-process MU does NOT complete while failed, resumes with remaining time on repair', () => {
    scene = new Scene();
    const ctx = makeContext(scene);

    const stationNode = createNode('Station', 1, 0, 0);
    const sinkNode = createNode('Sink', 2, 0, 0);
    scene.add(stationNode, sinkNode);

    const station = new DESStation(stationNode);
    station.ProcessingTime = 5; // s
    station.MaxCapacity = 1;
    const sink = new DESSink(sinkNode);

    station.nextComponents = [sink];
    sink.previousComponents = [station];

    manager.registerComponent(station);
    manager.registerComponent(sink);
    station.init(ctx);
    sink.init(ctx);

    const mu = createDESMU(manager.currentTime);
    manager.registerMU(mu);
    expect(station.acceptMU(mu)).toBe(true);

    advanceTo(manager, 2);
    expect(sink.totalConsumed).toBe(0);

    station.setFailure(true);
    advanceTo(manager, 10);
    // ProcessComplete (originally t=5) must NOT have fired while down.
    expect(sink.totalConsumed).toBe(0);
    expect(station.currentLoad).toBe(1);

    station.setFailure(false);
    advanceTo(manager, 12);
    expect(sink.totalConsumed).toBe(0); // remaining 3 s not yet elapsed
    advanceTo(manager, 14);
    expect(sink.totalConsumed).toBe(1); // completes ~t=13
  });

  it('Source: generation pauses while failed and resumes on repair (no permanent dormancy)', () => {
    scene = new Scene();
    const ctx = makeContext(scene);

    const sourceNode = createNode('Source', 0, 0, 0);
    const sinkNode = createNode('Sink', 1, 0, 0);
    scene.add(sourceNode, sinkNode);

    const source = new DESSource(sourceNode);
    source.InterArrivalTime = 2; // s
    const sink = new DESSink(sinkNode);

    source.nextComponents = [sink];
    sink.previousComponents = [source];

    manager.registerComponent(source);
    manager.registerComponent(sink);
    source.init(ctx);
    sink.init(ctx);
    source.start();

    // First MU at t=2, next at t=4 — by t=5 we expect ~2 generated.
    advanceTo(manager, 5);
    const generatedBeforeFailure = source.generated;
    expect(generatedBeforeFailure).toBeGreaterThanOrEqual(1);

    // Source goes down. No new MUs while failed.
    source.setFailure(true);
    advanceTo(manager, 20);
    expect(source.generated).toBe(generatedBeforeFailure);

    // Repair — generation must resume (the regression was a forever-dormant source).
    source.setFailure(false);
    advanceTo(manager, 30);
    expect(source.generated).toBeGreaterThan(generatedBeforeFailure);
  });
});
