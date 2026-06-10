// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * conveyor-des-timing.test.ts — Plan 194 P5b (Conveyor DES transit timing).
 *
 * Verifies the unified Conveyor `des` block under the private DESRunner:
 *  - an accepted MU is NOT released immediately — it is held for `timeToSensor`
 *    of SIM time, then released to the downstream;
 *  - `transitTime = length / speed` (and the C#-DES `Math.max(0.001, …)` guard
 *    means `speed = 0` never divides by zero);
 *  - back-pressure: when the downstream cannot accept, the MU is parked in
 *    `blockedMUs` and released once the downstream frees (onDownstreamReady).
 *
 * Runs only in the private build (imports `@rv-private/plugins/des/*`).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { _resetDesHookCache } from '@rv-private/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '@rv-private/plugins/des/rv-des-mu';
import { ConveyorFlow } from '../../src/behaviors/Conveyor';
import {
  createSelf,
  type MaterialFlowSelf,
  type MU,
} from '../../src/core/material-flow/material-flow-self';
import {
  defineMaterialFlow,
  type MaterialFlowDefinition,
} from '../../src/core/material-flow/define-material-flow';
import { _resetMaterialFlowRegistry } from '../../src/core/material-flow/registry';
import {
  createBindContext,
  type BindContextHost,
  type KinematicsSpec,
  type RVBindContext,
} from '../../src/core/behavior-runtime';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';

const ConveyorDef = ConveyorFlow as unknown as MaterialFlowDefinition;

/** The conveyor's DES-relevant local fields (private to Conveyor.ts — re-stated).
 *  The transit-timing model lives on `local.timer` (createTransitTimer); the
 *  `speed`/`length`/`timeToSensor` values are identical to the prior inline fields. */
interface ConvLocalView {
  timer: { timeToSensor: number; speed: number; length: number } | null;
  blockedMUs: MU[];
}
type ConvSelf = MaterialFlowSelf<ConvLocalView>;

// ─── Minimal bind context with a Conveyor node (Transport-X + Sensor) ─────

function makeConveyorContext(name: string): { ctx: RVBindContext; root: Object3D } {
  const events = new EventEmitter<Record<string, unknown>>();
  const values = new Map<string, boolean | number>();
  const host: BindContextHost = {
    signalStore: {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => values.set(n, v),
      subscribe: () => () => {},
    } as never,
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: [] as never,
    registry: null,
    getPlugin: () => undefined,
  };
  const root = new Object3D(); root.name = name;
  const belt = new Object3D(); belt.name = 'Transport-X'; root.add(belt);
  const sensor = new Object3D(); sensor.name = 'Sensor'; root.add(sensor);
  const accum: KinematicsSpec = {};
  const { ctx } = createBindContext(root, host, accum);
  return { ctx, root };
}

function makeBareContext(name: string): RVBindContext {
  const events = new EventEmitter<Record<string, unknown>>();
  const values = new Map<string, boolean | number>();
  const host: BindContextHost = {
    signalStore: {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => values.set(n, v),
      subscribe: () => () => {},
    } as never,
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: [] as never,
    registry: null,
    getPlugin: () => undefined,
  };
  const root = new Object3D(); root.name = name;
  const accum: KinematicsSpec = {};
  const { ctx } = createBindContext(root, host, accum);
  return ctx;
}

/** Build a conveyor instance with the given length/speed config seeded in prop. */
function buildConveyor(runner: DESRunner, name: string, cfg: Record<string, number>) {
  const { ctx, root } = makeConveyorContext(name);
  let entityId = -1;
  const self = createSelf(ctx, ConveyorDef, {
    mode: 'des',
    scheduler: runner.makeScheduler(ConveyorDef, () => entityId),
    onTransfer: (mu) => runner.makeTransfer(adapter)(mu),
    // Mirror the model-load binding: the downstream probe queries the adapter's
    // wired nextComponents (set in the test after start()).
    canAcceptDownstream: (mu) =>
      adapter.nextComponents.length > 0 &&
      adapter.nextComponents.some(c => c.canAccept(mu as never)),
    local: ConveyorDef.local ? ConveyorDef.local() : undefined,
  });
  for (const k of Object.keys(cfg)) self.prop[k] = cfg[k];
  const adapter = runner.addInstance(ConveyorDef, self, root);
  entityId = adapter.entityId; // assigned lazily after start(); refreshed below
  return {
    self: self as unknown as ConvSelf,
    adapter,
    root,
    refreshId: () => { entityId = adapter.entityId; },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Conveyor DES timing — transit delay', () => {
  beforeEach(() => {
    _resetMaterialFlowRegistry();
    _resetDesHookCache();
    resetDESMUCounter();
  });

  it('holds the MU for timeToSensor (length/speed), then releases it', () => {
    const runner = new DESRunner({ subMode: 'animated' });

    // Downstream sink records transferred MUs.
    const consumed: MU[] = [];
    const sinkDef = defineMaterialFlow<MaterialFlowSelf>({
      type: 'TestSinkA', kind: 'sink', schema: {}, continuous: {},
      des: { onAccept(_s, mu) { consumed.push(mu); return true; } },
    });
    const sinkNode = new Object3D(); sinkNode.name = 'SinkA';
    let sinkId = -1;
    const sinkSelf = createSelf(makeBareContext('SinkA'), sinkDef, {
      mode: 'des', scheduler: runner.makeScheduler(sinkDef as MaterialFlowDefinition, () => sinkId),
    });
    const sink = runner.addInstance(sinkDef as MaterialFlowDefinition, sinkSelf, sinkNode);

    // 1000 mm @ 200 mm/s → transit 5 s.
    const conv = buildConveyor(runner, 'Conveyor', { ConveyorLength: 1000, ConveyorSpeed: 200 });

    runner.start([ConveyorDef, sinkDef as MaterialFlowDefinition], { root: conv.root });
    conv.refreshId();
    sinkId = sink.entityId;
    conv.adapter.nextComponents = [sink];
    conv.self.signals.set('Conveyor.Run', true); // belt running (ZPA: shouldFlow)

    // timeToSensor should equal length/speed = 5 s.
    expect(conv.self.local.timer!.timeToSensor).toBeCloseTo(5, 3);

    // Accept an MU → schedule arrival in 5 s; NOT released yet.
    const mu = runner.createMU();
    conv.adapter.acceptMU(mu as never);
    expect(conv.adapter.currentLoad).toBe(1);
    expect(consumed.length).toBe(0);

    // Advance < 5 s — still in transit.
    runner.tick(2.0);
    runner.tick(2.0);
    expect(consumed.length).toBe(0);

    // Cross 5 s — arrival fires → release to the sink.
    runner.tick(1.5);
    expect(consumed.length).toBe(1);
    expect(consumed[0].id).toBe(mu.id);
  });

  it('transit time follows length/speed and guards speed = 0', () => {
    const runner = new DESRunner({ subMode: 'animated' });
    runner.start([ConveyorDef], { root: new Object3D() });

    // 2000 mm @ 500 mm/s → 4 s. Built AFTER start(), so re-run the shared setup
    // to resolve timing with the seeded prop.
    const fast = buildConveyor(runner, 'ConvFast', { ConveyorLength: 2000, ConveyorSpeed: 500 });
    ConveyorDef.setup?.(fast.self as unknown as MaterialFlowSelf);
    expect(fast.self.local.timer!.timeToSensor).toBeCloseTo(4, 3);

    // speed = 0 → guarded by Math.max(0.001, …): timeToSensor stays finite & > 0.
    const stalled = buildConveyor(runner, 'ConvStalled', { ConveyorLength: 1000, ConveyorSpeed: 0 });
    ConveyorDef.setup?.(stalled.self as unknown as MaterialFlowSelf);
    expect(Number.isFinite(stalled.self.local.timer!.timeToSensor)).toBe(true);
    expect(stalled.self.local.timer!.timeToSensor).toBeGreaterThan(0);
    expect(stalled.self.local.timer!.speed).toBeGreaterThanOrEqual(0.001);
  });

  it('back-pressure: holds the MU when the downstream is full, releases on ready', () => {
    const runner = new DESRunner({ subMode: 'animated' });

    // Downstream that REFUSES the first MU, then accepts.
    let accepting = false;
    const consumed: MU[] = [];
    const sinkDef = defineMaterialFlow<MaterialFlowSelf>({
      type: 'TestSinkB', kind: 'station', schema: {}, continuous: {},
      des: {
        canAccept() { return accepting; },
        onAccept(_s, mu) { consumed.push(mu); return true; },
      },
    });
    const sinkNode = new Object3D(); sinkNode.name = 'SinkB';
    let sinkId = -1;
    const sinkSelf = createSelf(makeBareContext('SinkB'), sinkDef, {
      mode: 'des', scheduler: runner.makeScheduler(sinkDef as MaterialFlowDefinition, () => sinkId),
    });
    const sink = runner.addInstance(sinkDef as MaterialFlowDefinition, sinkSelf, sinkNode);

    const conv = buildConveyor(runner, 'Conveyor', { ConveyorLength: 1000, ConveyorSpeed: 1000 }); // 1 s

    runner.start([ConveyorDef, sinkDef as MaterialFlowDefinition], { root: conv.root });
    conv.refreshId();
    sinkId = sink.entityId;
    conv.adapter.nextComponents = [sink];
    conv.adapter.previousComponents = [];
    conv.self.signals.set('Conveyor.Run', true); // belt running (ZPA: shouldFlow)

    // Accept → transit 1 s. Downstream refuses → MU parks in blockedMUs.
    const mu = runner.createMU();
    conv.adapter.acceptMU(mu as never);
    runner.tick(1.5); // past the 1 s arrival → tryRelease blocked
    expect(consumed.length).toBe(0);
    expect(conv.self.local.blockedMUs.length).toBe(1);

    // Downstream frees → notify the conveyor → it retries the blocked MU.
    accepting = true;
    conv.adapter.onDownstreamReady(sink as never);
    expect(consumed.length).toBe(1);
    expect(conv.self.local.blockedMUs.length).toBe(0);
  });
});
