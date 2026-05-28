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
 * Match: `models[]` matches against the GLB **filename** (without `.glb`),
 * NOT against `root.name` (which often differs from the file name).
 * Patterns support `*` (any chars), `?` (one char), and the wildcard `'*'`
 * (applies to every loaded model).
 *
 * Lifecycle: on every `model-loaded` event the manager invokes matching
 * behaviors. The bind callback writes into a fresh KinematicsSpec which is
 * then deep-merged into `userData.realvirtual` via `applyKinematicsSpec`.
 * All hooks/subscriptions are tracked per-bind and auto-disposed on the
 * matching `model-cleared` event.
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
    this.fixedUpdateRunner = (dt: number) => {
      for (const a of this.active) iterateFixedUpdate(a.handle, dt);
    };

    this.modelLoadedOff = host.on('model-loaded', () => {
      const root = getCurrentRoot();
      if (!root) return;
      const url = getCurrentModelUrl();
      const name = extractGlbName(url);
      this.disposeAll();
      const matched: string[] = [];
      for (const { id, behavior } of this.behaviors) {
        if (!matchesAny(behavior.models, name)) continue;
        matched.push(id);
        try {
          const accum: KinematicsSpec = {};
          const { ctx, handle } = createBindContext(root, host, accum);
          behavior.bind(ctx);
          const report = applyKinematicsSpec(root, accum);
          if (report.warnings.length > 0) {
            console.warn(`[behaviors] '${id}' for '${name}': ${report.warnings.length} warning(s)`);
          }
          this.active.push({ behaviorId: id, handle });
        } catch (e) {
          console.error(`[behaviors] '${id}' bind error for '${name}':`, e);
        }
      }
      if (matched.length > 1) {
        console.warn(`[behaviors] multiple behaviors matched model '${name}': ${matched.join(', ')}`);
      }
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
