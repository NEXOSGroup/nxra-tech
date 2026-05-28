// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi } from 'vitest';
import { SimLoopFacadeImpl } from '../src/core/facades/sim-loop-facade';
import { TickStage } from '../src/core/rv-tick-stages';

describe('SimLoopFacadeImpl (plan-182 Phase 4a)', () => {
  it('setPaused / clearPauseReasons forward to viewer', () => {
    const setPaused = vi.fn();
    const clearPauseReasons = vi.fn();
    const facade = new SimLoopFacadeImpl({
      setSimulationPaused: setPaused,
      clearPauseReasons,
    } as never);
    facade.setPaused('test', true);
    expect(setPaused).toHaveBeenCalledWith('test', true);
    facade.clearPauseReasons('test');
    expect(clearPauseReasons).toHaveBeenCalledWith('test');
  });

  it('isPaused reads viewer.isSimulationPaused', () => {
    const facade = new SimLoopFacadeImpl({ isSimulationPaused: true } as never);
    expect(facade.isPaused()).toBe(true);
  });

  it('onTick registers callback and returns disposer', () => {
    const facade = new SimLoopFacadeImpl({} as never);
    const cb = vi.fn();
    const off = facade.onTick(TickStage.PRE, cb, 50);
    expect(facade._ticks.get(TickStage.PRE)).toHaveLength(1);
    off();
    expect(facade._ticks.get(TickStage.PRE)).toHaveLength(0);
  });

  it('onTick within a stage sorted by order, stable on tie', () => {
    const facade = new SimLoopFacadeImpl({} as never);
    facade.onTick(TickStage.PRE, () => {}, 30);
    facade.onTick(TickStage.PRE, () => {}, 10);
    facade.onTick(TickStage.PRE, () => {}, 30);
    const entries = facade._ticks.get(TickStage.PRE)!;
    expect(entries.map(e => e.order)).toEqual([10, 30, 30]);
    // Stable: the two order=30 entries keep their registration order (1st before 3rd).
    expect(entries[1].insertIdx).toBeLessThan(entries[2].insertIdx);
  });

  it('eachDrive iterates viewer.drives', () => {
    const drives = [{ id: 'A' }, { id: 'B' }];
    const facade = new SimLoopFacadeImpl({ drives } as never);
    const seen: string[] = [];
    facade.eachDrive((d, _i) => seen.push((d as unknown as { id: string }).id));
    expect(seen).toEqual(['A', 'B']);
  });

  it('driveCount returns viewer.drives.length', () => {
    const facade = new SimLoopFacadeImpl({ drives: [1, 2, 3] } as never);
    expect(facade.driveCount).toBe(3);
  });
});
