// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * des-runner.test.ts — Plan 194 P5 (DESRunner + hook adapter + sub-modes).
 *
 * Verifies the private DESRunner end-to-end against the public material-flow
 * surface:
 *  - hook name → integer dispatch (R3): `self.in('Arrival', …)` resolves the
 *    `<type>.Arrival` named action and the hook runs.
 *  - Animated sub-mode advances simNow by dt and fires due events.
 *  - HybridSynced spreads a large batch across frames (B4) — NEVER drops events.
 *  - FastForward drains the queue (jump-to-event-time, no render write).
 *  - Step processes exactly one event.
 *  - the tween registry is driven on lateTick (Animated) / off in FastForward.
 *  - createDesRunner factory is non-null in the private build (kernel wiring).
 *
 * Runs only in the private build (imports `@rv-private/plugins/des/*`).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { createDesRunner } from '@rv-private/plugins/des/register-des-runner';
import { _resetDesHookCache } from '@rv-private/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '@rv-private/plugins/des/rv-des-mu';
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

// ─── Minimal bind context (mirrors material-flow-self.test.ts) ────────────

function makeBindContext(root: Object3D): RVBindContext {
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
  const accum: KinematicsSpec = {};
  const { ctx } = createBindContext(root, host, accum);
  return ctx;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('DESRunner — factory wiring', () => {
  it('createDesRunner is non-null in the private build', () => {
    expect(createDesRunner).not.toBe(null);
    const exec = createDesRunner!([], { root: new Object3D() });
    expect(exec.mode).toBe('des');
  });
});

describe('DESRunner — hook int-dispatch + Animated', () => {
  beforeEach(() => {
    _resetMaterialFlowRegistry();
    _resetDesHookCache();
    resetDESMUCounter();
  });

  it('schedules and dispatches a des hook by short suffix (R3)', () => {
    const fired: string[] = [];
    const def = defineMaterialFlow<MaterialFlowSelf>({
      type: 'TestConveyor',
      kind: 'conveyor',
      schema: {},
      continuous: {},
      setup() { fired.push('setup'); },
      des: {
        onGenerate(self) {
          // schedule an Arrival 2s out
          self.in(2, 'Arrival', { id: 1 } as MU);
        },
        onArrival() { fired.push('arrival'); },
      },
    });

    const runner = new DESRunner({ subMode: 'animated' });
    const node = new Object3D();
    node.name = 'TestConveyor1';
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def as MaterialFlowDefinition, () => adapter.entityId),
    });
    const adapter = runner.addInstance(def as MaterialFlowDefinition, self, node);

    runner.start([def as MaterialFlowDefinition], { root: node });
    expect(fired).toContain('setup');

    // Manually fire onGenerate (def is 'conveyor' so start() does not auto-fire).
    def.des!.onGenerate!(self);

    // Advance < 2s — no arrival yet.
    runner.tick(1.0);
    expect(fired).not.toContain('arrival');
    // Advance past 2s — arrival fires exactly once.
    runner.tick(1.5);
    expect(fired).toContain('arrival');
    expect(fired.filter(f => f === 'arrival').length).toBe(1);
  });
});

describe('DESRunner — sub-modes (B4 no-drop / FastForward / Step)', () => {
  beforeEach(() => {
    _resetMaterialFlowRegistry();
    _resetDesHookCache();
    resetDESMUCounter();
  });

  /** Build a def that, on each Generate, schedules N back-to-back events. */
  function makeBurstDef(count: number, processed: { n: number }) {
    return defineMaterialFlow<MaterialFlowSelf>({
      type: 'Burst',
      kind: 'source',
      schema: {},
      continuous: {},
      des: {
        onGenerate(self) {
          for (let i = 0; i < count; i++) {
            // all due at t = 0.001*(i+1) — a dense burst
            self.at(0.001 * (i + 1), 'Arrival', null);
          }
        },
        onArrival() { processed.n++; },
      },
    });
  }

  it('HybridSynced spreads a large burst across frames and drops NOTHING (B4)', () => {
    const processed = { n: 0 };
    const def = makeBurstDef(5000, processed);
    const runner = new DESRunner({ subMode: 'hybrid', frameEventBudget: 1000, multiplier: 50 });
    const node = new Object3D(); node.name = 'Burst1';
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def as MaterialFlowDefinition, () => adapter.entityId),
    });
    const adapter = runner.addInstance(def as MaterialFlowDefinition, self, node);

    runner.start([def as MaterialFlowDefinition], { root: node });
    // start() fired onGenerate (kind 'source') → 5000 events queued at t≈0..5s.

    // One big-dt frame at 50× would advance simNow by a lot, but the per-frame
    // budget is 1000 → it must take ≥ 5 frames to drain, NEVER truncating.
    let frames = 0;
    while (runner.getManager().pendingEventCount > 0 && frames < 100) {
      runner.tick(0.1); // 0.1s · 50× = 5s render advance — covers all event times
      frames++;
    }
    expect(frames).toBeGreaterThanOrEqual(5); // batch spread across frames
    expect(processed.n).toBe(5000);           // EVERY event processed (no drop)
    expect(runner.getManager().pendingEventCount).toBe(0);
  });

  it('FastForward drains the whole queue', () => {
    const processed = { n: 0 };
    const def = makeBurstDef(3000, processed);
    const runner = new DESRunner({ subMode: 'fastforward', frameEventBudget: 5000 });
    const node = new Object3D(); node.name = 'Burst2';
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def as MaterialFlowDefinition, () => adapter.entityId),
    });
    const adapter = runner.addInstance(def as MaterialFlowDefinition, self, node);
    runner.start([def as MaterialFlowDefinition], { root: node });

    let frames = 0;
    while (runner.getManager().pendingEventCount > 0 && frames < 50) {
      runner.tick(0.016);
      frames++;
    }
    expect(processed.n).toBe(3000);
  });

  it('Step processes exactly one event per step()', () => {
    const processed = { n: 0 };
    const def = makeBurstDef(10, processed);
    const runner = new DESRunner({ subMode: 'step' });
    const node = new Object3D(); node.name = 'Burst3';
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def as MaterialFlowDefinition, () => adapter.entityId),
    });
    const adapter = runner.addInstance(def as MaterialFlowDefinition, self, node);
    runner.start([def as MaterialFlowDefinition], { root: node });

    runner.tick(1.0);            // step mode: tick does NOT auto-advance
    expect(processed.n).toBe(0);
    runner.step();
    expect(processed.n).toBe(1);
    runner.step();
    expect(processed.n).toBe(2);
  });
});

describe('DESRunner — tween integration', () => {
  beforeEach(() => {
    _resetMaterialFlowRegistry();
    _resetDesHookCache();
    resetDESMUCounter();
  });

  it('Animated drives the tween registry on lateTick; FastForward does not write', () => {
    const target = { pos: new Vector3(), writes: 0, setPosition(v: Vector3) { this.pos.copy(v); this.writes++; } };

    const def = defineMaterialFlow<MaterialFlowSelf>({
      type: 'Mover',
      kind: 'source',
      schema: {},
      continuous: {},
      des: { onGenerate() { /* no events; tween added directly below */ } },
    });
    const runner = new DESRunner({ subMode: 'animated' });
    const node = new Object3D(); node.name = 'Mover1';
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def as MaterialFlowDefinition, () => adapter.entityId),
    });
    const adapter = runner.addInstance(def as MaterialFlowDefinition, self, node);
    runner.start([def as MaterialFlowDefinition], { root: node });

    // Register a position tween 0→10 over 2s starting at the current render clock.
    runner.getTweenRegistry().addPosition(target, new Vector3(0, 0, 0), new Vector3(10, 0, 0), 0, 2);

    runner.tick(1.0);      // simNow → 1.0
    runner.lateTick(1.0);  // render at 1.0 → 50%
    expect(target.pos.x).toBeCloseTo(5);

    // Switch to FastForward — lateTick must not write.
    runner.setSubMode('fastforward');
    const writesBefore = target.writes;
    runner.tick(0.5);
    runner.lateTick(0.5);
    expect(target.writes).toBe(writesBefore);
  });
});

describe('DESRunner — Station definition (DES-only wrapper)', () => {
  beforeEach(() => {
    _resetMaterialFlowRegistry();
    _resetDesHookCache();
    resetDESMUCounter();
  });

  it('holds an MU for ProcessingTime, then transfers it downstream', async () => {
    // Import here so the def self-registers AFTER the registry reset.
    const { Station } = await import('@rv-private/plugins/des/material-flow/Station');
    const def = Station as unknown as MaterialFlowDefinition<MaterialFlowSelf<{ processingTime: number }>>;
    const defAny = def as unknown as MaterialFlowDefinition;

    const runner = new DESRunner({ subMode: 'animated' });
    const node = new Object3D(); node.name = 'Station1';
    const self = createSelf<{ processingTime: number }>(makeBindContext(node), def, {
      mode: 'des',
      local: { processingTime: 0 },
      scheduler: runner.makeScheduler(defAny, () => adapter.entityId),
      onTransfer: (mu) => runner.makeTransfer(adapter)(mu),
    });
    // Sink-like downstream that records transferred MUs.
    const transferred: MU[] = [];
    const sinkDef = defineMaterialFlow<MaterialFlowSelf>({
      type: 'TestSink', kind: 'sink', schema: {}, continuous: {},
      des: { onAccept(_s, mu) { transferred.push(mu); return true; } },
    });
    const sinkNode = new Object3D(); sinkNode.name = 'Sink1';
    const sinkSelf = createSelf(makeBindContext(sinkNode), sinkDef, {
      mode: 'des',
      scheduler: runner.makeScheduler(sinkDef as MaterialFlowDefinition, () => sink.entityId),
    });
    const sink = runner.addInstance(sinkDef as MaterialFlowDefinition, sinkSelf, sinkNode);
    const adapter = runner.addInstance(defAny, self as unknown as MaterialFlowSelf, node);

    // Wire the Station's downstream to the sink (native handshake routing).
    runner.start([defAny, sinkDef as MaterialFlowDefinition], { root: node });
    adapter.nextComponents = [sink];

    // ProcessingTime defaults to 5s; accept an MU and verify the hold + release.
    self.local.processingTime = 3; // 3s hold
    const mu = runner.createMU();
    adapter.acceptMU(mu as never); // → des.onAccept schedules ProcessComplete in 3s

    runner.tick(2.0); // 2s — still processing
    expect(transferred.length).toBe(0);
    runner.tick(1.5); // past 3s — ProcessComplete fires → transfer
    expect(transferred.length).toBe(1);
    expect(transferred[0].id).toBe(mu.id);
  });
});
