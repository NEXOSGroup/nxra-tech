// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ErrorStore — central error/alarm registry for the WebViewer.
 *
 * Single source of truth for which errors are currently active. RVWebError
 * components report into it (`setActive`); the right-side error panel reads
 * from it (`getActive` / `subscribe`, useSyncExternalStore-compatible).
 *
 * Lifecycle: instantiated once per RVViewer (a true singleton that survives
 * model loads). It is emptied on model switch via the web-error plugin's
 * `onModelCleared` hook (`clear()`), NOT via per-component dispose chains.
 *
 * An error is active exactly while its bound signal is high — no latching,
 * no acknowledgement. `setActive` performs a dirty-check so a flapping signal
 * with an unchanged state/text does not trigger a re-render storm.
 */

/** A single active (or recently-cleared) error entry keyed by node path. */
export interface ErrorEntry {
  /** Node path of the faulting part (the registry key). */
  path: string;
  /** Human-readable error message (from WebError.ErrorText). */
  text: string;
  /** Whether the error is currently active (= signal high). */
  active: boolean;
  /** Activation timestamp (performance-time) — used for chronological sort. */
  since: number;
}

export class ErrorStore {
  /** path → entry. Only ACTIVE entries are retained (inactive ⇒ removed). */
  private _entries = new Map<string, ErrorEntry>();
  private _listeners = new Set<() => void>();
  /** Cached sorted snapshot for useSyncExternalStore stable identity. */
  private _snapshot: ErrorEntry[] = [];
  private _snapshotDirty = true;

  /**
   * Report a part's error state. Active high → entry created/updated; active
   * low → entry removed. Notifies subscribers only on a real change (the
   * active flag toggled, or the text changed while staying active).
   */
  setActive(path: string, active: boolean, text: string): void {
    const existing = this._entries.get(path);

    if (active) {
      if (existing) {
        // Already active — only notify when the text actually changed.
        if (existing.text === text) return;
        existing.text = text;
      } else {
        this._entries.set(path, { path, text, active: true, since: performance.now() });
      }
    } else {
      // Going inactive — remove if present, otherwise nothing changed.
      if (!existing) return;
      this._entries.delete(path);
    }

    this._snapshotDirty = true;
    this._notify();
  }

  /** Remove a single entry (e.g. on component dispose). No-op if absent. */
  remove(path: string): void {
    if (!this._entries.has(path)) return;
    this._entries.delete(path);
    this._snapshotDirty = true;
    this._notify();
  }

  /** Remove all entries (e.g. on model switch). Notifies only if non-empty. */
  clear(): void {
    if (this._entries.size === 0) return;
    this._entries.clear();
    this._snapshotDirty = true;
    this._notify();
  }

  /** Active errors, sorted chronologically by activation time (oldest first). */
  getActive(): ErrorEntry[] {
    if (this._snapshotDirty) {
      this._snapshot = Array.from(this._entries.values()).sort((a, b) => a.since - b.since);
      this._snapshotDirty = false;
    }
    return this._snapshot;
  }

  /** Number of currently active errors. */
  getCount(): number {
    return this._entries.size;
  }

  /** Subscribe to list changes. Returns an unsubscribe function. */
  subscribe(cb: () => void): () => void {
    this._listeners.add(cb);
    return () => {
      this._listeners.delete(cb);
    };
  }

  private _notify(): void {
    for (const cb of this._listeners) cb();
  }
}
