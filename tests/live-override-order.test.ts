// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Phase 5 of plan-182: Live-Override-Reihenfolge regression test.
 *
 * Adapter setzen PLC-Signale in TickStage.PRE; Sim-Code liest sie in
 * TickStage.SIM. Wenn die Reihenfolge verdreht wird, sieht SIM den
 * vorherigen Tick-Wert — der Test failt sofort.
 *
 * Test mit dem TestViewer (Phase 0 mock) — die echte fixedUpdate-Integration
 * im RVViewer-Constructor erfordert eine Browser-WebGL-Umgebung.
 */

import { describe, it, expect } from 'vitest';
import { createTestViewer } from './helpers/test-viewer';
import { TickStage } from '../src/core/rv-tick-stages';

describe('Live-override tick order (plan-182 Phase 5)', () => {
  it('Signal set in PRE is visible in SIM same tick', () => {
    const viewer = createTestViewer({ withSignals: [{ name: 'LiveSignal', value: false }] });
    let seenInSim: boolean | undefined;

    viewer.simLoop.onTick(TickStage.PRE, () => {
      // Adapter writes the live signal
      viewer.signalStore!.set('LiveSignal', true);
    });
    viewer.simLoop.onTick(TickStage.SIM, () => {
      seenInSim = viewer.signalStore!.get('LiveSignal') as boolean;
    });

    viewer._tickOnce(0.016);
    expect(seenInSim).toBe(true);
  });

  it('Signal set in SIM is visible in POST same tick', () => {
    const viewer = createTestViewer({ withSignals: [{ name: 'SimComputed', value: 0 }] });
    let seenInPost: number | undefined;

    viewer.simLoop.onTick(TickStage.SIM, () => {
      viewer.signalStore!.set('SimComputed', 42);
    });
    viewer.simLoop.onTick(TickStage.POST, () => {
      seenInPost = viewer.signalStore!.get('SimComputed') as number;
    });

    viewer._tickOnce(0.016);
    expect(seenInPost).toBe(42);
  });

  it('TickStage.PRE callbacks run before TickStage.SIM before TickStage.POST', () => {
    const viewer = createTestViewer();
    const order: string[] = [];
    viewer.simLoop.onTick(TickStage.POST, () => order.push('post'));
    viewer.simLoop.onTick(TickStage.PRE,  () => order.push('pre'));
    viewer.simLoop.onTick(TickStage.SIM,  () => order.push('sim'));

    viewer._tickOnce(0.016);
    expect(order).toEqual(['pre', 'sim', 'post']);
  });
});
