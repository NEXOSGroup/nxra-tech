// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * BaseViewerPlugin — Abstract base class implementing `RVViewerPlugin` with
 * built-in unsubscribe bookkeeping.
 *
 * Plugins frequently subscribe to viewer/DOM/event-bus emitters and have to
 * manually track the returned unsubscribe functions, call them on
 * `onModelCleared`/`dispose`, and reset the bookkeeping list. This base
 * class centralises that pattern:
 *
 *   - Call `this.sub(off)` whenever you obtain an unsubscribe.
 *   - The default `onModelCleared()` and `dispose()` automatically flush
 *     all registered unsubscribes.
 *   - If a subclass needs extra cleanup it should call `super.onModelCleared()`
 *     / `super.dispose()` first, then run its own teardown.
 *
 * The class is **opt-in**: existing plugins implementing `RVViewerPlugin`
 * directly continue to work unchanged.
 */

import type { RVViewerPlugin } from './rv-plugin';
import type { RVViewer } from './rv-viewer';
import type { LoadResult } from './engine/rv-scene-loader';
import type { UISlotEntry } from './rv-ui-plugin';
import type { PluginContext } from './rv-plugin-context';

export abstract class BaseViewerPlugin implements RVViewerPlugin {
  /** Unique plugin ID (e.g. 'drive-recorder'). Must be set by subclass. */
  abstract readonly id: string;

  /** Sort order in Pre/Post/Render lists. Default: undefined (uses interface default of 100). */
  readonly order?: number;

  /** Optional plugin flags (forwarded as-is to `RVViewerPlugin`). */
  readonly handlesTransport?: boolean;
  readonly core?: boolean;
  readonly slots?: UISlotEntry[];

  /** Internal list of unsubscribe callbacks accumulated via `sub()`. */
  private _subs: Array<() => void> = [];

  /**
   * Plugin-Capability-Bundle. Wird in Phase 4 von `viewer.use()` über `init()` befüllt.
   * Bis dahin: undefined. Plugins die `this.context` in `init()` nutzen sind safe;
   * Plugins die `this.context` im Konstruktor verwenden müssen auf null prüfen.
   *
   * Definite-assignment assertion (`!`) weil Phase 4 garantiert dass es befüllt wird;
   * neue Plugins die das frühzeitig nutzen brauchen lediglich `init()` zu implementieren.
   */
  protected context!: PluginContext;

  /**
   * Register an unsubscribe callback. The callback is invoked automatically
   * when `flushSubs()` runs (which is called by `onModelCleared()` and
   * `dispose()` by default).
   *
   * Typical usage:
   * ```ts
   * this.sub(viewer.on('model-loaded', () => { ... }));
   * ```
   */
  protected sub(off: () => void): void {
    if (typeof off !== 'function') return;
    this._subs.push(off);
  }

  /**
   * Invoke every registered unsubscribe and clear the internal list. Each
   * unsubscribe is isolated with try/catch so a faulty cleanup callback
   * cannot block the others.
   */
  protected flushSubs(): void {
    const subs = this._subs;
    this._subs = [];
    for (const off of subs) {
      try {
        off();
      } catch (e) {
        console.error(`[${this.id}] unsubscribe error:`, e);
      }
    }
  }

  // ── Lifecycle defaults ───────────────────────────────────────────────

  /**
   * Default: stores the provided context so subclasses can use `this.context`.
   * Override this method to add custom init logic — but call `super.init(viewer, context)`
   * first so `this.context` is set before your code runs.
   *
   * In Phase 3 of plan-182, viewer.use() does not yet pass `context` (that's Phase 4).
   * Until Phase 4 ships, `this.context` is undefined and subclasses should not rely on it yet.
   */
  init(_viewer: RVViewer, context?: PluginContext): void {
    if (context) this.context = context;
  }

  /**
   * Default: flushes all registered subscriptions. Subclasses overriding
   * this method should call `super.onModelCleared(viewer)` to retain the
   * default flush behaviour.
   */
  onModelCleared(_viewer: RVViewer): void {
    this.flushSubs();
  }

  /**
   * Default: flushes all registered subscriptions. Subclasses overriding
   * this method should call `super.dispose()` to retain the default flush
   * behaviour.
   */
  dispose(): void {
    this.flushSubs();
  }

  // ── Lifecycle hooks subclasses may implement ────────────────────────
  // These are declared as optional members on `RVViewerPlugin` and may be
  // overridden by subclasses. We intentionally do NOT declare them here so
  // that subclasses can keep them optional (the runtime only invokes hooks
  // that actually exist on the prototype, via callPlugin).

  onModelLoaded?(result: LoadResult, viewer: RVViewer): void;
  onConnectionStateChanged?(state: 'Connected' | 'Disconnected', viewer: RVViewer): void;
  onFixedUpdatePre?(dt: number): void;
  onFixedUpdatePost?(dt: number): void;
  onRender?(frameDt: number): void;
}
