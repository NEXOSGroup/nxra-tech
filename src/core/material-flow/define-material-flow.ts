// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * define-material-flow.ts — the public `defineMaterialFlow` API (Plan 194 §2.2).
 *
 * ONE definition per material-flow component type, THREE layers:
 *   - `logic`      — shared state-machine + routing (mode-agnostic; no time/physics)
 *   - `continuous` — public adapter (trigger = sensor/poll, effect = physics, 60 Hz)
 *   - `des`        — private adapter record (trigger = events, effect = time)
 *
 * `defineMaterialFlow(def)` registers the definition for dual discovery
 * (`registerMaterialFlow`, registry.ts): the continuous-matcher resolves
 * `models[]` against loaded models, a `registerComponent` schema adapter feeds
 * the GLB loader, and each `des` hook is namespaced `<type>.<Hook>`.
 *
 * Shim: `toBehavior(def)` adapts a definition to the existing `Behavior`
 * (`continuous.setup`→`bind`, `continuous.fixedUpdate`→`rv.onFixedUpdate`) so a
 * material-flow component is `defineBehavior`-compatible at runtime and existing
 * BehaviorManager discovery keeps every current test green.
 */

import type { ComponentSchema } from '../engine/rv-component-registry';
import type { RVBindContext } from '../behavior-runtime';
import type { Behavior } from '../behaviors';
import {
  createSelf,
  type MaterialFlowSelf,
  type MaterialFlowKind,
  type MU,
  type Port,
} from './material-flow-self';
import { registerMaterialFlow } from './registry';

export type { MaterialFlowKind } from './material-flow-self';

// ─── Layer block types ──────────────────────────────────────────────────

/**
 * Shared logic: pure decisions/transitions on `self`, NO time/physics.
 * Methods are free-form (selectInput, selectOutput, shouldFlow, enter, …);
 * both adapters call into them so routing/state is identical across modes.
 */
// `MaterialFlowSelf<any>` as the bound so a definition can pin a typed
// `local` slot (e.g. `MaterialFlowSelf<ConveyorLocal>`); the default stays the
// empty-local `MaterialFlowSelf`.
export interface LogicBlock<S extends MaterialFlowSelf<any> = MaterialFlowSelf> {
  [name: string]: (self: S, ...args: never[]) => unknown;
}

/** Continuous adapter — PUBLIC default path (60 Hz, after transport.update). */
export interface ContinuousBlock<S extends MaterialFlowSelf<any> = MaterialFlowSelf> {
  /** 1×/load: resolve nodes, declare signals, subscriptions, contextMenu, init self.* */
  setup?(self: S): void;
  /** 60 Hz, AFTER transport.update — triggers via isAtTarget/sensor. */
  fixedUpdate?(self: S, dt: number): void;
  /** Optional post-fixedUpdate pass. */
  lateFixedUpdate?(self: S, dt: number): void;
  /** Optional teardown (model-cleared). */
  teardown?(self: S): void;
  /** Adapter-private helper methods (rotateTo/runBelt/…) authored on the block. */
  [name: string]: ((self: S, ...args: never[]) => unknown) | undefined;
}

/** DES adapter — data record of hooks dispatched by the (private) DESRunner. */
export interface DesBlock<S extends MaterialFlowSelf<any> = MaterialFlowSelf> {
  canAccept?(self: S, mu: MU, port?: Port): boolean;
  onAccept?(self: S, mu: MU, port?: Port): boolean;
  onArrival?(self: S, mu: MU): void;
  onProcessComplete?(self: S, mu: MU): void;
  onRotateComplete?(self: S, mu: MU): void;
  onGenerate?(self: S): void;
  onAutoRelease?(self: S, mu: MU): void;
  onDownstreamReady?(self: S, from: unknown): void;
  onSignalChanged?(self: S, signal: string, value: boolean | number): void;
  /** Adapter-private helpers (rotateTo/tryRelease/…) authored on the block. */
  [name: string]: ((self: S, ...args: never[]) => unknown) | undefined;
}

// ─── Definition ─────────────────────────────────────────────────────────

export interface MaterialFlowDefinition<S extends MaterialFlowSelf<any> = MaterialFlowSelf> {
  /** Stable id: rv_extras key AND DES action namespace ('Conveyor' → 'Conveyor.Arrival'). */
  readonly type: string;
  readonly kind: MaterialFlowKind;
  /** Continuous-matcher globs; default `['*' + type + '*']`. */
  readonly models?: string[];
  /** Component schema (same shape as rv-component-registry; applySchema reused). */
  readonly schema: ComponentSchema;
  /**
   * Per-instance `self.local` factory — the seed for the typed local state slot.
   * Used by BOTH the continuous shim (`toBehavior`) and the DES model-load
   * binding so a directly-created `self` (no `toBehavior`) still gets its
   * resolved-nodes/handles/flags slot. When omitted, `self.local` defaults to
   * an empty object.
   */
  readonly local?: () => S extends MaterialFlowSelf<infer L> ? L : never;
  /**
   * Mode-agnostic per-instance init, called by BOTH the continuous and DES
   * runners. Resolve nodes into `self.local`, declare signals, stamp the
   * inspector/badge companion, build the context menu — everything that is
   * needed regardless of simulation mode. Runs BEFORE the mode-specific
   * `continuous.setup` / DES wiring, so those can rely on the resolved
   * `self.local` nodes.
   */
  setup?(self: S): void;
  /** Shared state-machine + routing (mode-agnostic). */
  readonly logic?: LogicBlock<S>;
  /** Continuous adapter — public default path. */
  readonly continuous: ContinuousBlock<S>;
  /** DES adapter — private feeds the runner; public stub ⇒ no-op. */
  readonly des?: DesBlock<S>;
}

/**
 * Define a material-flow component (Plan 194 §2.2). Registers for dual
 * discovery and returns the definition (so the module's default export can be
 * both the discovered behavior AND a programmatically-importable definition).
 */
export function defineMaterialFlow<S extends MaterialFlowSelf<any> = MaterialFlowSelf>(
  def: MaterialFlowDefinition<S>,
): MaterialFlowDefinition<S> {
  registerMaterialFlow(def as unknown as MaterialFlowDefinition);
  return def;
}

// ─── Shim: defineMaterialFlow → Behavior ─────────────────────────────────

/**
 * Adapt a material-flow definition to the existing `Behavior` contract so the
 * current BehaviorManager discovery/dispatch runs it unchanged on the
 * continuous path:
 *   - `models` → behavior `models` (default `['*' + type + '*']`)
 *   - `setup(self)`                    runs FIRST in `bind()` (mode-agnostic init)
 *   - `continuous.setup(self)`         runs in `bind()` AFTER the shared `setup`
 *   - `continuous.fixedUpdate(self,dt)` registered via `rv.onFixedUpdate`
 *   - `continuous.lateFixedUpdate`      chained after fixedUpdate (same tick)
 *
 * The `self` is created in continuous mode (no scheduler → `self.in/at` throw,
 * which is correct: a continuous block must not schedule DES events).
 *
 * `localFactory` (optional) seeds `self.local` — the per-instance state slot a
 * behaviour stores its resolved nodes/handles/flags in (replaces a WeakMap).
 */
export function toBehavior<S = Record<string, never>>(
  def: MaterialFlowDefinition<MaterialFlowSelf<S>>,
  localFactory?: () => S,
): Behavior {
  const models = def.models ?? [`*${def.type}*`];
  // The local-state factory: prefer the explicit arg, else the def's own `local`.
  const makeLocal = localFactory ?? (def.local as (() => S) | undefined);
  return {
    models,
    bind(rv: RVBindContext): void {
      const self = createSelf<S>(rv, def, {
        mode: 'continuous',
        local: makeLocal ? makeLocal() : undefined,
      });
      const c = def.continuous;
      // Mode-agnostic init FIRST (resolves self.local nodes, declares signals,
      // stamps the badge, builds the context menu), THEN the continuous-only
      // wiring that depends on those resolved nodes.
      if (def.setup) def.setup(self);
      if (c.setup) c.setup(self);
      const fixed = c.fixedUpdate;
      const late = c.lateFixedUpdate;
      if (fixed || late) {
        rv.onFixedUpdate((dt: number) => {
          if (fixed) fixed(self, dt);
          if (late) late(self, dt);
        });
      }
      // teardown runs via the bind context's onDispose (model-cleared).
      if (c.teardown) {
        rv.onDispose(() => c.teardown!(self));
      }
    },
  };
}
