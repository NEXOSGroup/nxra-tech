// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Behaviors — auto-discovered, per-component scripts that wire GLB models
 * to drives, sensors, transport surfaces, snaps, signals, AAS links and
 * context-menu items in a single declarative file.
 *
 * Discovery: all `src/behaviors/*.ts` modules are eager-loaded via
 * `import.meta.glob` and their default export (a `Behavior`) is collected
 * into the registry. Adding a new component is a single new file — no
 * imports, no manual registration.
 *
 * Match: `models[]` matches against the GLB **filename** (without `.glb`)
 * for a standalone asset, OR — for a library asset placed inside a scene —
 * against the placed LayoutObject's asset name (`node.name` minus the `_N`
 * duplicate suffix). Patterns support `*` (any chars), `?` (one char), and
 * the wildcard `'*'` (applies to every loaded model).
 *
 * Lifecycle: on every `model-loaded` event the manager (1) invokes behaviors
 * matching the loaded GLB filename, scoped to the scene root, and (2) scans the
 * scene for placed LayoutObjects and dispatches behaviors matching each one,
 * scoped to that object's subtree. The layout planner also calls
 * `dispatchPlaced(root)` when an asset is added after load. The bind callback
 * writes into a fresh KinematicsSpec, deep-merged into `userData.realvirtual`
 * via `applyKinematicsSpec`. All hooks/subscriptions are tracked per-bind and
 * auto-disposed on `model-cleared` (or `disposeObject` on removal).
 */

import type { Object3D } from 'three';
import {
  createBindContext,
  applyKinematicsSpec,
  iterateFixedUpdate,
  type RVBindContext,
  type BindContextHost,
  type BindContextHandle,
  type KinematicsSpec,
  type KinematizeReport,
} from './behavior-runtime';

// ─── Public types ───────────────────────────────────────────────────────

export interface Behavior {
  /**
   * GLB filenames (without `.glb` extension) this behavior applies to.
   *
   * Each entry is either:
   *   - exact filename: `'ChainTransfer'`
   *   - glob pattern:   `'ChainTransfer_*'`, `'Belt_v?'`
   *   - wildcard:       `'*'` (applies to every loaded model)
   */
  models: string[];

  /** Called once per matching model load. All subscriptions are auto-disposed. */
  bind(rv: RVBindContext): void;
}

/** Identity helper for type-safe behavior authoring. */
export function defineBehavior(b: Behavior): Behavior { return b; }

// ─── Glob matcher ───────────────────────────────────────────────────────

const _globCache = new Map<string, RegExp>();

export function compileGlob(pattern: string): RegExp {
  const cached = _globCache.get(pattern);
  if (cached) return cached;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const re = new RegExp(`^${escaped}$`);
  _globCache.set(pattern, re);
  return re;
}

export function matchesAny(patterns: string[], name: string): boolean {
  for (const p of patterns) {
    if (p === '*') return true;
    if (p === name) return true;
    if (p.includes('*') || p.includes('?')) {
      if (compileGlob(p).test(name)) return true;
    }
  }
  return false;
}

/** Extract the GLB filename (no extension, no directory, no query string) from a URL. */
export function extractGlbName(url: string | null | undefined): string {
  if (!url) return '';
  const noQuery = url.split('?')[0];
  const file = noQuery.substring(noQuery.lastIndexOf('/') + 1);
  return file.replace(/\.glb$/i, '');
}

// ─── Registry ───────────────────────────────────────────────────────────

interface ActiveBind {
  behaviorId: string;
  handle: BindContextHandle;
  /** Set when bound to a placed LayoutObject subtree (its placement id) — null for whole-scene binds. */
  objectKey?: string;
}

/**
 * BehaviorManager — owns the registered behaviors, dispatches them on
 * model-load and disposes them on model-clear.
 */
export class BehaviorManager {
  private behaviors: Array<{ id: string; behavior: Behavior }> = [];
  private active: ActiveBind[] = [];
  private modelLoadedOff: (() => void) | null = null;
  private modelClearedOff: (() => void) | null = null;
  private fixedUpdateRunner: ((dt: number) => void) | null = null;
  /** Host stored at attach() so dispatchPlaced() can bind objects placed after load. */
  private host: BindContextHost | null = null;
  /** Placement ids already dispatched, to keep per-object dispatch idempotent. */
  private dispatchedObjects = new Set<string>();

  /**
   * Register a behavior with an explicit id (filename without extension,
   * provided by `registerAllBehaviors`).
   */
  register(id: string, behavior: Behavior): void {
    if (!behavior || typeof behavior.bind !== 'function' || !Array.isArray(behavior.models)) {
      console.warn(`[behaviors] '${id}' is not a valid Behavior (must have models[] + bind())`);
      return;
    }
    this.behaviors.push({ id, behavior });
  }

  /** Total number of registered behaviors (for diagnostics / tests). */
  get count(): number { return this.behaviors.length; }

  /** Get all registered ids (for diagnostics / tests). */
  ids(): string[] { return this.behaviors.map(b => b.id); }

  /** Number of currently active (post-load, pre-clear) bind contexts. */
  get activeCount(): number { return this.active.length; }

  /** Read-only snapshot of `{behaviorId, objectKey}` for active binds — for the layout-graph debug page. */
  getActiveBinds(): ReadonlyArray<{ behaviorId: string; objectKey: string | undefined }> {
    return this.active.map(a => ({ behaviorId: a.behaviorId, objectKey: a.objectKey }));
  }

  /**
   * Attach to a viewer-like host: subscribe to model-loaded/model-cleared
   * and forward fixed-update ticks to active bind contexts.
   *
   * Returns a dispose function that detaches all listeners.
   */
  attach(
    host: BindContextHost,
    getCurrentRoot: () => Object3D | null,
    getCurrentModelUrl: () => string | null,
  ): () => void {
    // Build a per-tick fan-out for active onFixedUpdate callbacks.
    this.host = host;
    this.fixedUpdateRunner = (dt: number) => {
      for (const a of this.active) iterateFixedUpdate(a.handle, dt);
    };

    this.modelLoadedOff = host.on('model-loaded', () => {
      const root = getCurrentRoot();
      if (!root) return;
      this.disposeAll();
      // 1. Whole scene vs. the loaded GLB filename (a standalone asset GLB).
      this.bindForRoot(root, extractGlbName(getCurrentModelUrl()));
      // 2. Each placed LayoutObject subtree vs. its asset name, so library
      //    items embedded in a scene get their behavior even though the
      //    scene's filename doesn't match (see dispatchPlaced).
      this.dispatchPlacedObjectsIn(root);
    });

    this.modelClearedOff = host.on('model-cleared', () => {
      this.disposeAll();
    });

    return () => {
      this.modelLoadedOff?.();
      this.modelClearedOff?.();
      this.modelLoadedOff = null;
      this.modelClearedOff = null;
      this.fixedUpdateRunner = null;
      this.disposeAll();
    };
  }

  /** Forward a fixed-update tick — call once per sim tick from the viewer. */
  tick(dt: number): void {
    this.fixedUpdateRunner?.(dt);
  }

  /**
   * Bind every behavior whose `models[]` match `matchName`, scoped to `root`.
   * Bound contexts join `active[]` (so they tick and dispose with the scene).
   * Returns the number of behaviors bound.
   */
  private bindForRoot(root: Object3D, matchName: string, objectKey?: string): number {
    if (!this.host) return 0;
    const matched: string[] = [];
    for (const { id, behavior } of this.behaviors) {
      if (!matchesAny(behavior.models, matchName)) continue;
      matched.push(id);
      try {
        const accum: KinematicsSpec = {};
        const { ctx, handle } = createBindContext(root, this.host, accum);
        behavior.bind(ctx);
        const report = applyKinematicsSpec(root, accum);
        if (report.warnings.length > 0) {
          console.warn(`[behaviors] '${id}' for '${matchName}': ${report.warnings.length} warning(s)`);
        }
        this.registerBehaviorSignals(accum);
        this.active.push({ behaviorId: id, handle, objectKey });
      } catch (e) {
        console.error(`[behaviors] '${id}' bind error for '${matchName}':`, e);
      }
    }
    if (matched.length > 1) {
      console.warn(`[behaviors] multiple behaviors matched '${matchName}': ${matched.join(', ')}`);
    }
    return matched.length;
  }

  /**
   * Register each behavior-declared signal's initialValue in the SignalStore.
   *
   * Why this lives here: the load-time signal-construction pass reads behavior
   * signals from `userData.realvirtual.__BehaviorSignals`, but behaviors write
   * that key DURING bind (after construction has already happened). So without
   * this post-bind pass, a behavior's `initialValue: true` never reaches the
   * store, `signals.get(...)` returns `undefined`, and the first onFixedUpdate
   * sees a stale state. This is non-destructive: an already-present value
   * (PLC, saved scene, prior bind) is preserved.
   */
  private registerBehaviorSignals(accum: KinematicsSpec): void {
    const store = this.host?.signalStore;
    if (!store) { console.warn(`[behaviors] registerBehaviorSignals: no signalStore on host — ${accum.signals?.length ?? 0} behavior signal(s) DROPPED`); return; }
    if (!accum.signals || accum.signals.length === 0) return;
    let registered = 0; let skippedExisting = 0; let skippedNoInit = 0;
    for (const sig of accum.signals) {
      if (sig.initialValue === undefined) { skippedNoInit++; continue; }
      if (store.get(sig.name) !== undefined) { skippedExisting++; continue; }
      if (store.register) {
        store.register(sig.name, sig.name, sig.initialValue, sig.type);
      } else {
        store.set(sig.name, sig.initialValue);
      }
      registered++;
    }
    console.info(`[behaviors] registerBehaviorSignals: ${registered} registered, ${skippedExisting} pre-existing, ${skippedNoInit} no-init (of ${accum.signals.length} total)`);
  }

  /** True if `node` is the ROOT of a placed LayoutObject (carries the marker). */
  private isLayoutObjectRoot(node: Object3D): boolean {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    return !!(rv && rv.LayoutObject);
  }

  /** Stable per-object key: the layout placement id, else the node uuid. */
  private layoutKey(node: Object3D): string {
    return (node.userData?._layoutId as string | undefined) ?? node.uuid;
  }

  /** Asset name to match against: the node name minus the `_N` duplicate suffix. */
  private layoutMatchName(node: Object3D): string {
    return node.name.replace(/_\d+$/, '');
  }

  /**
   * Dispatch behaviors for a single placed LayoutObject subtree — called by the
   * layout planner right after a library asset is added to a scene. Idempotent
   * per object (keyed by placement id). Bound contexts join `active[]`, so they
   * receive fixed-update ticks and are disposed on model-cleared (or via
   * {@link disposeObject} when the object is removed).
   */
  dispatchPlaced(root: Object3D): void {
    if (!this.host) {
      console.warn(`[behaviors] dispatchPlaced("${root.name}") skipped: no host attached`);
      return;
    }
    const key = this.layoutKey(root);
    if (this.dispatchedObjects.has(key)) {
      console.info(`[behaviors] dispatchPlaced("${root.name}") deduped (key=${key.slice(0, 8)})`);
      return;
    }
    this.dispatchedObjects.add(key);
    const matchName = this.layoutMatchName(root);
    const matched = this.bindForRoot(root, matchName, key);
    console.info(`[behaviors] dispatchPlaced("${root.name}" → match "${matchName}"): ${matched} behavior(s) bound`);
  }

  /** Scan a scene root for placed LayoutObjects and dispatch each (on model-loaded). */
  private dispatchPlacedObjectsIn(sceneRoot: Object3D): void {
    sceneRoot.traverse((node) => {
      if (this.isLayoutObjectRoot(node)) this.dispatchPlaced(node);
    });
  }

  /** Dispose the behavior contexts bound to a placed object (call on removal). */
  disposeObject(root: Object3D): void {
    const key = this.layoutKey(root);
    const remaining: ActiveBind[] = [];
    for (const a of this.active) {
      if (a.objectKey === key) { try { a.handle.dispose(); } catch { /* ignore */ } }
      else remaining.push(a);
    }
    this.active = remaining;
    this.dispatchedObjects.delete(key);
  }

  /** For tests: directly trigger the load logic without an event. */
  triggerLoad(host: BindContextHost, root: Object3D, modelName: string): KinematizeReport[] {
    this.disposeAll();
    const reports: KinematizeReport[] = [];
    for (const { id, behavior } of this.behaviors) {
      if (!matchesAny(behavior.models, modelName)) continue;
      try {
        const accum: KinematicsSpec = {};
        const { ctx, handle } = createBindContext(root, host, accum);
        behavior.bind(ctx);
        reports.push(applyKinematicsSpec(root, accum));
        this.active.push({ behaviorId: id, handle });
      } catch (e) {
        console.error(`[behaviors] '${id}' bind error for '${modelName}':`, e);
      }
    }
    return reports;
  }

  /** For tests: dispose all active binds. */
  disposeAll(): void {
    for (const a of this.active) {
      try { a.handle.dispose(); } catch { /* ignore */ }
    }
    this.active.length = 0;
    this.dispatchedObjects.clear();
  }

  /** For tests: clear registered behaviors. */
  clearRegistry(): void {
    this.disposeAll();
    this.behaviors.length = 0;
  }
}

// ─── Discovery ──────────────────────────────────────────────────────────

/**
 * Auto-discover all behavior modules in `src/behaviors/` and register them.
 *
 * Vite's `import.meta.glob` is evaluated at build time — adding a new file
 * to `src/behaviors/` is sufficient to enrol it (no manual import).
 */
export function registerAllBehaviors(manager: BehaviorManager): void {
  // Eager glob with default export — see Vite docs.
  // The path is relative to this module (src/core/behaviors.ts → ../behaviors/*.ts).
  const modules = (import.meta as unknown as {
    glob: (pattern: string, opts: { eager: true; import: string }) => Record<string, unknown>;
  }).glob('../behaviors/*.ts', { eager: true, import: 'default' });

  for (const [path, mod] of Object.entries(modules)) {
    const id = path.split('/').pop()!.replace(/\.tsx?$/i, '');
    if (mod && typeof (mod as Behavior).bind === 'function') {
      manager.register(id, mod as Behavior);
    } else {
      console.warn(`[behaviors] '${id}' does not export a default Behavior`);
    }
  }
}
