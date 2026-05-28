// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi } from 'vitest';
import { createTestViewer } from './helpers/test-viewer';
import { TickStage } from '../src/core/rv-tick-stages';

describe('createTestViewer — Phase 0 helpers', () => {
  describe('withNodes', () => {
    it('populates registry with given paths', () => {
      const viewer = createTestViewer({
        withNodes: [{ path: 'root/a' }, { path: 'root/b', type: 'Drive' }],
      });
      expect(viewer.registry).not.toBeNull();
      const a = viewer.registry!.getNode('root/a');
      expect(a).not.toBeNull();
      expect(a!.path).toBe('root/a');
      const b = viewer.registry!.getNode('root/b');
      expect(b!.type).toBe('Drive');
    });

    it('forEachNode iterates all nodes', () => {
      const viewer = createTestViewer({
        withNodes: [{ path: 'a' }, { path: 'b' }, { path: 'c' }],
      });
      const paths: string[] = [];
      viewer.registry!.forEachNode((_, path) => paths.push(path));
      expect(paths.sort()).toEqual(['a', 'b', 'c']);
    });
  });

  describe('withSignals', () => {
    it('pre-populates signalStore', () => {
      const viewer = createTestViewer({
        withSignals: [{ name: 'X', value: 42 }, { name: 'Y', value: true }],
      });
      expect(viewer.signalStore!.get('X')).toBe(42);
      expect(viewer.signalStore!.get('Y')).toBe(true);
    });
  });

  describe('withPlugin', () => {
    it('registers plugin via use()', () => {
      const plugin = { id: 'test-plugin' };
      const viewer = createTestViewer({ withPlugin: plugin });
      expect(viewer.getPlugin('test-plugin')).toBe(plugin);
    });
  });

  describe('simLoop.onTick + _tickOnce', () => {
    it('callbacks fire in TickStage order: PRE -> SIM -> POST', () => {
      const viewer = createTestViewer();
      const order: string[] = [];
      viewer.simLoop.onTick(TickStage.POST, () => order.push('post'));
      viewer.simLoop.onTick(TickStage.PRE, () => order.push('pre'));
      viewer.simLoop.onTick(TickStage.SIM, () => order.push('sim'));
      viewer._tickOnce(0.016);
      expect(order).toEqual(['pre', 'sim', 'post']);
    });

    it('within a stage, lower order runs first', () => {
      const viewer = createTestViewer();
      const order: number[] = [];
      viewer.simLoop.onTick(TickStage.PRE, () => order.push(30), 30);
      viewer.simLoop.onTick(TickStage.PRE, () => order.push(10), 10);
      viewer.simLoop.onTick(TickStage.PRE, () => order.push(20), 20);
      viewer._tickOnce(0.016);
      expect(order).toEqual([10, 20, 30]);
    });

    it('same order = insertion-order-stable', () => {
      const viewer = createTestViewer();
      const order: string[] = [];
      viewer.simLoop.onTick(TickStage.PRE, () => order.push('first'),  50);
      viewer.simLoop.onTick(TickStage.PRE, () => order.push('second'), 50);
      viewer.simLoop.onTick(TickStage.PRE, () => order.push('third'),  50);
      viewer._tickOnce(0.016);
      expect(order).toEqual(['first', 'second', 'third']);
    });

    it('onTick returns a disposer', () => {
      const viewer = createTestViewer();
      const fn = vi.fn();
      const off = viewer.simLoop.onTick(TickStage.PRE, fn);
      viewer._tickOnce(0.016);
      expect(fn).toHaveBeenCalledTimes(1);
      off();
      viewer._tickOnce(0.016);
      expect(fn).toHaveBeenCalledTimes(1); // not called again
    });

    it('callback added during tick is NOT called in same tick (defensive snapshot)', () => {
      const viewer = createTestViewer();
      const order: string[] = [];
      viewer.simLoop.onTick(TickStage.PRE, () => {
        order.push('outer');
        viewer.simLoop.onTick(TickStage.PRE, () => order.push('inner'));
      });
      viewer._tickOnce(0.016);
      expect(order).toEqual(['outer']);
      viewer._tickOnce(0.016);
      // Next tick both fire (outer adds a new inner each time, but original outer + first-tick's inner)
      expect(order).toContain('inner');
    });

    it('dt is passed to callback', () => {
      const viewer = createTestViewer();
      let receivedDt = 0;
      viewer.simLoop.onTick(TickStage.SIM, (dt) => { receivedDt = dt; });
      viewer._tickOnce(0.025);
      expect(receivedDt).toBe(0.025);
    });
  });

  describe('_setSignalStore', () => {
    it('replaces the signalStore reference', () => {
      const viewer = createTestViewer({ withSignals: [{ name: 'A', value: 1 }] });
      expect(viewer.signalStore!.get('A')).toBe(1);

      viewer._setSignalStore(null);
      expect(viewer.signalStore).toBeNull();

      const newStore = {
        cleared: false,
        values: new Map<string, boolean | number>([['B', 99]]),
        get(name: string) { return this.values.get(name); },
        set(name: string, v: boolean | number) { this.values.set(name, v); },
      };
      viewer._setSignalStore(newStore);
      expect(viewer.signalStore!.get('B')).toBe(99);
    });
  });

  describe('removePlugin', () => {
    it('returns true and removes when plugin exists', () => {
      const viewer = createTestViewer({ withPlugin: { id: 'plug' } });
      expect(viewer.removePlugin('plug')).toBe(true);
      expect(viewer.getPlugin('plug')).toBeUndefined();
    });

    it('returns false when plugin does not exist', () => {
      const viewer = createTestViewer();
      expect(viewer.removePlugin('does-not-exist')).toBe(false);
    });
  });

  describe('drives array', () => {
    it('is empty by default', () => {
      const viewer = createTestViewer();
      expect(viewer.drives).toEqual([]);
    });
  });
});
