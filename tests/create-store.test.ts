// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi } from 'vitest';
import { createStore } from '../src/core/hmi/create-store';

interface CounterSnapshot {
  count: number;
  label: string;
}

describe('createStore', () => {
  it('returns the initial value via getSnapshot()', () => {
    const store = createStore<CounterSnapshot>({ count: 0, label: 'a' });
    const snap = store.getSnapshot();
    expect(snap).toEqual({ count: 0, label: 'a' });
  });

  it('getSnapshot returns the same reference when state is unchanged (React 18 useSyncExternalStore contract)', () => {
    const store = createStore<CounterSnapshot>({ count: 0, label: 'a' });
    const a = store.getSnapshot();
    const b = store.getSnapshot();
    const c = store.getSnapshot();
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('set(partial) merges into state and produces a new reference', () => {
    const store = createStore<CounterSnapshot>({ count: 0, label: 'a' });
    const before = store.getSnapshot();
    store.set({ count: 5 });
    const after = store.getSnapshot();
    expect(after).toEqual({ count: 5, label: 'a' });
    expect(after).not.toBe(before);
  });

  it('set(updater) replaces state with the function result', () => {
    const store = createStore<CounterSnapshot>({ count: 0, label: 'a' });
    store.set(prev => ({ count: prev.count + 10, label: prev.label.toUpperCase() }));
    expect(store.getSnapshot()).toEqual({ count: 10, label: 'A' });
  });

  it('set() automatically notifies all subscribers', () => {
    const store = createStore<CounterSnapshot>({ count: 0, label: 'a' });
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    store.subscribe(cb1);
    store.subscribe(cb2);

    store.set({ count: 1 });
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);

    store.set(prev => ({ ...prev, count: prev.count + 1 }));
    expect(cb1).toHaveBeenCalledTimes(2);
    expect(cb2).toHaveBeenCalledTimes(2);
  });

  it('notify() fires subscribers without changing state', () => {
    const store = createStore<CounterSnapshot>({ count: 0, label: 'a' });
    const before = store.getSnapshot();
    const cb = vi.fn();
    store.subscribe(cb);

    store.notify();
    expect(cb).toHaveBeenCalledTimes(1);
    // State reference is preserved across pure notify().
    expect(store.getSnapshot()).toBe(before);
  });

  it('subscribe returns an unsubscribe function that detaches the listener', () => {
    const store = createStore<CounterSnapshot>({ count: 0, label: 'a' });
    const cb = vi.fn();
    const unsubscribe = store.subscribe(cb);

    store.set({ count: 1 });
    expect(cb).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.set({ count: 2 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('multiple subscribers are all notified in insertion order', () => {
    const store = createStore<CounterSnapshot>({ count: 0, label: 'a' });
    const order: number[] = [];
    store.subscribe(() => order.push(1));
    store.subscribe(() => order.push(2));
    store.subscribe(() => order.push(3));

    store.notify();
    expect(order).toEqual([1, 2, 3]);
  });

  it('a throwing subscriber does not prevent later subscribers from running', () => {
    const store = createStore<CounterSnapshot>({ count: 0, label: 'a' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cbBad = vi.fn(() => {
      throw new Error('boom');
    });
    const cbGood = vi.fn();
    store.subscribe(cbBad);
    store.subscribe(cbGood);

    store.notify();
    expect(cbBad).toHaveBeenCalledTimes(1);
    expect(cbGood).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('supports scalar T via the updater form (no allocations on getSnapshot)', () => {
    const store = createStore<boolean>(false);
    expect(store.getSnapshot()).toBe(false);
    const refA = store.getSnapshot();
    const refB = store.getSnapshot();
    expect(refA).toBe(refB);

    const cb = vi.fn();
    store.subscribe(cb);
    store.set(() => true);
    expect(store.getSnapshot()).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
