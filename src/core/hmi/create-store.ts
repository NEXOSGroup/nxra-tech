// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * createStore<T> — Minimal Pub/Sub store factory for the realvirtual WebViewer.
 *
 * Designed to be compatible with React 18's `useSyncExternalStore`:
 *   - `subscribe(cb)` returns an unsubscribe function
 *   - `getSnapshot()` returns a referentially stable snapshot (no allocation when
 *     state has not changed) — required to avoid infinite re-render loops
 *
 * Used by the canonical "Pattern A" stores in the WebViewer that share the
 * shape `{ subscribe, getSnapshot, set, notify }`. Stores with side-effects in
 * `notify()` (e.g. `annotation-plugin`'s `markRenderDirty()`), frozen sorted
 * arrays (`instruction-store`) or scalar primitives (`fpv-plugin`) are
 * intentionally left unchanged — they would require too many escape hatches.
 *
 * Usage:
 *   const store = createStore<MySnapshot>({ count: 0, items: [] });
 *   store.subscribe(() => console.log(store.getSnapshot()));
 *   store.set({ count: 1 });            // Partial merge
 *   store.set(prev => ({ ...prev }));    // Updater function
 *   store.notify();                      // Manual fire (after external mutation)
 */

/** Subscriber callback. Fired on every notify(). */
type Listener = () => void;

/** Store API returned by createStore<T>. */
export interface Store<T> {
  /** Subscribe to changes. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void;
  /** Get current state snapshot. Reference is stable until next set/notify. */
  getSnapshot(): T;
  /**
   * Update state. Accepts either a partial object (shallow-merged into current
   * state) or an updater function (`(prev) => next`). For scalar T (boolean,
   * number, string), pass the new value via an updater: `set(() => true)`.
   * Automatically calls `notify()` after the new snapshot is installed.
   */
  set(updater: ((prev: T) => T) | Partial<T>): void;
  /** Manually notify all subscribers without changing state. */
  notify(): void;
}

/**
 * Create a new Pub/Sub store with an initial value.
 *
 * The store guarantees `getSnapshot()` returns the same reference until either
 * `set()` or `notify()` is called. Subscribers are invoked synchronously in
 * insertion order. Errors thrown by a listener are caught and logged so that
 * a single bad subscriber does not prevent others from being notified.
 *
 * @param initial - Initial state value.
 * @returns A typed store with subscribe/getSnapshot/set/notify.
 */
export function createStore<T>(initial: T): Store<T> {
  let snapshot: T = initial;
  const listeners = new Set<Listener>();

  function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getSnapshot(): T {
    return snapshot;
  }

  function notify(): void {
    for (const l of listeners) {
      try {
        l();
      } catch (e) {
        console.error('[createStore] subscriber threw:', e);
      }
    }
  }

  function set(updater: ((prev: T) => T) | Partial<T>): void {
    if (typeof updater === 'function') {
      snapshot = (updater as (prev: T) => T)(snapshot);
    } else {
      // Shallow-merge partial into current state. Only meaningful for object T.
      snapshot = { ...(snapshot as object), ...(updater as object) } as T;
    }
    notify();
  }

  return { subscribe, getSnapshot, set, notify };
}
