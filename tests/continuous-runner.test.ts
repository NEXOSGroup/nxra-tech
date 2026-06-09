// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * continuous-runner.test.ts — Plan 194 P1.
 *
 * Verifies the public `ContinuousRunner`:
 *  - `tick(dt)` delegates to transport.update THEN behaviour fixedUpdate, in
 *    that exact order (R1 regression guard, mirrored from rv-viewer.ts:3254/3288).
 *  - clearMUs / reset / dispose delegate to the shared transport manager and do
 *    NOT dispose the behaviour manager (ownership stays in the viewer).
 *  - muCount reads through to the shared transport manager.
 *  - handlesTransport is a static const true.
 *
 * Uses inline spy mocks (no GLB / WebGL) in the style of tests/rv-transport.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  ContinuousRunner,
  type TransportManagerLike,
  type BehaviorManagerLike,
} from '../src/core/material-flow/continuous-runner';

// ─── Mocks ────────────────────────────────────────────────────────────────

interface MockTransport extends TransportManagerLike {
  calls: string[];
  updateCount: number;
  resetCount: number;
  mus: unknown[];
}

function makeTransport(calls: string[]): MockTransport {
  return {
    calls,
    updateCount: 0,
    resetCount: 0,
    mus: [],
    update(_dt: number): void {
      this.updateCount++;
      this.calls.push('transport.update');
    },
    reset(): void {
      this.resetCount++;
      this.calls.push('transport.reset');
      this.mus.length = 0;
    },
  };
}

interface MockBehaviors extends BehaviorManagerLike {
  calls: string[];
  tickCount: number;
}

function makeBehaviors(calls: string[]): MockBehaviors {
  return {
    calls,
    tickCount: 0,
    tick(_dt: number): void {
      this.tickCount++;
      this.calls.push('behaviors.tick');
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('ContinuousRunner', () => {
  it('tick() runs transport.update BEFORE behaviours.tick (exact R1 order)', () => {
    const calls: string[] = [];
    const transport = makeTransport(calls);
    const behaviors = makeBehaviors(calls);
    const runner = new ContinuousRunner(transport, behaviors);

    runner.tick(0.016);

    expect(calls).toEqual(['transport.update', 'behaviors.tick']);
    expect(transport.updateCount).toBe(1);
    expect(behaviors.tickCount).toBe(1);
  });

  it('tick() preserves order across multiple ticks', () => {
    const calls: string[] = [];
    const transport = makeTransport(calls);
    const behaviors = makeBehaviors(calls);
    const runner = new ContinuousRunner(transport, behaviors);

    runner.tick(0.016);
    runner.tick(0.016);

    expect(calls).toEqual([
      'transport.update', 'behaviors.tick',
      'transport.update', 'behaviors.tick',
    ]);
  });

  it('forwards dt to transport.update', () => {
    const calls: string[] = [];
    let seenDt = -1;
    const transport: TransportManagerLike = {
      update(dt: number): void { seenDt = dt; calls.push('u'); },
      reset(): void {},
    };
    const behaviors = makeBehaviors(calls);
    const runner = new ContinuousRunner(transport, behaviors);

    runner.tick(0.025);
    expect(seenDt).toBe(0.025);
  });

  it('muCount reads through the shared transport manager', () => {
    const calls: string[] = [];
    const transport = makeTransport(calls);
    const behaviors = makeBehaviors(calls);
    const runner = new ContinuousRunner(transport, behaviors);

    expect(runner.muCount).toBe(0);
    transport.mus.push({}, {}, {});
    expect(runner.muCount).toBe(3);
  });

  it('muCount is 0 for a minimal transport mock without a mus list', () => {
    const calls: string[] = [];
    const transport: TransportManagerLike = { update() {}, reset() {} };
    const runner = new ContinuousRunner(transport, makeBehaviors(calls));
    expect(runner.muCount).toBe(0);
  });

  it('clearMUs() delegates to transport.reset (Reset-on-Switch outgoing step)', () => {
    const calls: string[] = [];
    const transport = makeTransport(calls);
    transport.mus.push({}, {});
    const runner = new ContinuousRunner(transport, makeBehaviors(calls));

    runner.clearMUs();
    expect(transport.resetCount).toBe(1);
    expect(transport.mus.length).toBe(0);
    // The behaviour manager must NOT be touched — it is owned by the viewer.
    expect(calls).toEqual(['transport.reset']);
  });

  it('reset() delegates to transport.reset and leaves behaviours intact', () => {
    const calls: string[] = [];
    const transport = makeTransport(calls);
    const runner = new ContinuousRunner(transport, makeBehaviors(calls));

    runner.reset();
    expect(transport.resetCount).toBe(1);
    expect(calls).toEqual(['transport.reset']);
  });

  it('dispose() clears MUs via transport.reset but never disposes the shared managers', () => {
    const calls: string[] = [];
    const transport = makeTransport(calls);
    const behaviors = makeBehaviors(calls);
    const runner = new ContinuousRunner(transport, behaviors);

    runner.dispose();
    // Only transport.reset — no behaviour disposal, no extra transport teardown.
    expect(transport.resetCount).toBe(1);
    expect(calls).toEqual(['transport.reset']);
  });

  it('start() is a no-op coordination point (does not touch the managers)', () => {
    const calls: string[] = [];
    const transport = makeTransport(calls);
    const runner = new ContinuousRunner(transport, makeBehaviors(calls));

    runner.start([], { root: {} as never });
    expect(calls).toEqual([]);
    expect(transport.updateCount).toBe(0);
    expect(transport.resetCount).toBe(0);
  });

  it('lateTick() is a no-op for the continuous runner', () => {
    const calls: string[] = [];
    const transport = makeTransport(calls);
    const runner = new ContinuousRunner(transport, makeBehaviors(calls));

    runner.lateTick(0.016);
    expect(calls).toEqual([]);
  });

  it('exposes mode "continuous" and a static handlesTransport === true', () => {
    const calls: string[] = [];
    const runner = new ContinuousRunner(makeTransport(calls), makeBehaviors(calls));
    expect(runner.mode).toBe('continuous');
    expect(ContinuousRunner.handlesTransport).toBe(true);
  });

  it('instances() is empty (continuous path does not track MaterialFlowInstance)', () => {
    const calls: string[] = [];
    const runner = new ContinuousRunner(makeTransport(calls), makeBehaviors(calls));
    expect(runner.instances()).toEqual([]);
  });
});
