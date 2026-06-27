// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, test, expect, vi } from 'vitest';
import { createTestViewer } from './helpers/test-viewer';

describe('SimController — resetSimulation()', () => {
  test('clears all MUs', () => {
    const viewer = createTestViewer({ initialMus: 5 });
    expect(viewer.transportManager.mus.length).toBe(5);
    viewer.resetSimulation();
    expect(viewer.transportManager.mus.length).toBe(0);
  });

  test('resets transport counters to zero', () => {
    const viewer = createTestViewer({ initialMus: 5 });
    viewer.transportManager.totalConsumed = 17;
    viewer.resetSimulation();
    expect(viewer.transportManager.totalSpawned).toBe(0);
    expect(viewer.transportManager.totalConsumed).toBe(0);
  });

  test('calls logicEngine.reset()', () => {
    const viewer = createTestViewer();
    expect(viewer.logicEngine.resetCalls).toBe(0);
    viewer.resetSimulation();
    expect(viewer.logicEngine.resetCalls).toBe(1);
  });

  test('does NOT touch signal values', () => {
    const viewer = createTestViewer();
    viewer.signalStore!.set('ConveyorRunning', true);
    viewer.signalStore!.set('Speed', 42.5);
    viewer.resetSimulation();
    expect(viewer.signalStore!.get('ConveyorRunning')).toBe(true);
    expect(viewer.signalStore!.get('Speed')).toBe(42.5);
  });

  test('does NOT change pause state', () => {
    const viewer = createTestViewer({ initialMus: 2 });
    viewer.setSimulationPaused('user', true);
    expect(viewer.isSimulationPaused).toBe(true);
    viewer.resetSimulation();
    expect(viewer.isSimulationPaused).toBe(true);
    expect(viewer.simulationPauseReasons).toContain('user');
  });

  test('emits simulation-reset → simulation-resetstat → simulation-start in order', () => {
    const viewer = createTestViewer();
    const order: string[] = [];
    viewer.on('simulation-reset', () => order.push('reset'));
    viewer.on('simulation-resetstat', () => order.push('resetstat'));
    viewer.on('simulation-start', () => order.push('start'));
    viewer.resetSimulation();
    expect(order).toEqual(['reset', 'resetstat', 'start']);
  });

  test('calls reset() on every drive', () => {
    const viewer = createTestViewer();
    const resetCalls: string[] = [];
    viewer.drives = [
      { name: 'A', reset() { resetCalls.push('A'); } },
      { name: 'B', reset() { resetCalls.push('B'); } },
    ];
    viewer.resetSimulation();
    expect(resetCalls).toEqual(['A', 'B']);
  });

  test('simulation-reset fires BEFORE the engine clears MUs', () => {
    const viewer = createTestViewer({ initialMus: 3 });
    let musAtReset = -1;
    // The reset event must run while the live MUs are still present, so a
    // behavior's onReset handler can reference them before the engine drops them.
    viewer.on('simulation-reset', () => { musAtReset = viewer.transportManager.mus.length; });
    viewer.resetSimulation();
    expect(musAtReset).toBe(3);
    expect(viewer.transportManager.mus.length).toBe(0); // cleared afterwards
  });
});

describe('SimController — clearPauseReasons()', () => {
  test('clears all pause reasons when called with no argument', () => {
    const viewer = createTestViewer();
    viewer.setSimulationPaused('user', true);
    viewer.setSimulationPaused('layout-edit', true);
    expect(viewer.simulationPauseReasons.length).toBe(2);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    viewer.clearPauseReasons();
    expect(viewer.isSimulationPaused).toBe(false);
    expect(viewer.simulationPauseReasons.length).toBe(0);
    warnSpy.mockRestore();
  });

  test('clears only the specified reason when one is given', () => {
    const viewer = createTestViewer();
    viewer.setSimulationPaused('user', true);
    viewer.setSimulationPaused('layout-edit', true);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    viewer.clearPauseReasons('user');
    expect(viewer.isSimulationPaused).toBe(true);
    expect(viewer.simulationPauseReasons).toEqual(['layout-edit']);
    warnSpy.mockRestore();
  });

  test('is a no-op if no reasons are active', () => {
    const viewer = createTestViewer();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    viewer.clearPauseReasons();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('SimController — pause event re-entrancy guard', () => {
  test('nested setSimulationPaused inside a handler does not recurse', () => {
    const viewer = createTestViewer();
    const events: { reason: string; paused: boolean }[] = [];

    let entered = false;
    viewer.on('simulation-pause-changed', (e: any) => {
      events.push({ reason: e.reason, paused: e.paused });
      // Re-entrant trigger: try to pause for a DIFFERENT reason from inside
      // the handler. Without the guard this would produce a nested event,
      // potentially leading to subscriber-reorder bugs or stack growth.
      if (!entered) {
        entered = true;
        viewer.setSimulationPaused('inner', true);
      }
    });

    viewer.setSimulationPaused('user', true);
    // The outer event MUST have fired. The inner re-entrant call mutated
    // the reason-set but its own pause-changed emit was suppressed (idle→
    // paused transition only happens once for the same idle→paused edge).
    expect(events.length).toBe(1);
    expect(events[0].reason).toBe('user');
    expect(viewer.simulationPauseReasons).toContain('inner');
    expect(viewer.simulationPauseReasons).toContain('user');
  });
});
