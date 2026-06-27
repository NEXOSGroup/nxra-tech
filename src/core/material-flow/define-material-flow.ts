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
  type SignalShape,
} from './material-flow-self';
import { registerMaterialFlow } from './registry';

export type { MaterialFlowKind } from './material-flow-self';

// ─── Declarative ergonomy blocks (Plan 197 §2.4b A/B) ────────────────────

/**
 * Node kinds the optional `requires` block resolves by naming convention.
 * Each maps to a `library-component-loader` finder:
 *   - `transport` → `findTransport(self.root)` (`Transport-X/Y/Z`)
 *   - `sensor`    → `findSensor(self.root)`    (`Sensor[-id]`)
 *   - `rotary`    → `findRotaryDrive(self.root)` (`Drive-Rot-X/Y/Z`)
 */
export type RequiresKind = 'transport' | 'sensor' | 'rotary';

/**
 * The shape of a definition's optional `requires` block: a map from an
 * injection key (e.g. `belt`) to the node kind to resolve. The factory
 * resolves each before `def.setup`, injects the resolved node as `self.<key>`,
 * auto-disables the instance when any required node is missing, and stamps an
 * auto-badge marker from the resolved nodes.
 */
export type RequiresShape = Record<string, RequiresKind>;

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

export interface MaterialFlowDefinition<
  S extends MaterialFlowSelf<any, any> = MaterialFlowSelf,
  SIG extends SignalShape = Record<string, never>,
> {
  /** Stable id: rv_extras key AND DES action namespace ('Conveyor' → 'Conveyor.Arrival'). */
  readonly type: string;
  readonly kind: MaterialFlowKind;
  /**
   * Short, human-facing one-liner — what this component IS and does. Shown as the
   * library hover tooltip and returned by the `web_library_list` MCP tool. Keep it
   * general (no per-instance detail).
   */
  readonly description?: string;
  /**
   * Richer, MCP-facing notes for an AI agent building layouts: material-flow
   * direction, how to connect it (snaps), key config. Returned by the
   * `web_library_describe` MCP tool. Multi-line OK. Not shown in the UI tooltip.
   */
  readonly mcpDocs?: string;
  /**
   * Signal-name namespace for the `signals` block (Plan 197 §2.4b-A). The factory
   * auto-declares each signal as `${signalNamespace ?? type}.${key}` and the
   * `self.sig.<key>` accessors read/write the same scoped name. Defaults to
   * `type`. The material-flow interop components (Conveyor/Turntable/Sink) set
   * `signalNamespace: 'Flow'` (NOT `Conveyor.*`/`Turntable.*`/`Sink.*`) so the
   * signals block produces the shared type-neutral `Flow.*` interop names.
   */
  readonly signalNamespace?: string;
  /** Continuous-matcher globs; default `['*' + type + '*']`. */
  readonly models?: string[];
  /** Component schema (same shape as rv-component-registry; applySchema reused). */
  readonly schema: ComponentSchema;
  /**
   * Optional declarative `signals` block (Plan 197 §2.4b-A). Maps a short key to
   * its PLC signal type; the factory auto-declares each as `${type}.${key}`
   * (replaces `declareFlowSignalsWith`) and exposes a typed `self.sig.<key>`
   * accessor. OPTIONAL — a definition without `signals` declares signals
   * manually exactly as before. Initial value defaults per type (bool→false,
   * int/float→0).
   */
  readonly signals?: SIG;
  /**
   * Optional declarative `requires` block (Plan 197 §2.4b-B). Maps an injection
   * key to a node kind (`transport`/`sensor`/`rotary`). The factory resolves
   * each (reusing the `library-component-loader` finders) BEFORE `def.setup`,
   * injects the resolved node as `self.<key>`, auto-disables (warn) the instance
   * when any required node is missing, and stamps an auto-badge marker from the
   * resolved nodes. OPTIONAL — a definition without `requires` resolves nodes
   * manually in `setup` exactly as before. Ambiguous (multiple matches) → first
   * match + warn.
   */
  readonly requires?: RequiresShape;
  /**
   * Per-instance `self.local` factory — the seed for the typed local state slot.
   * Used by BOTH the continuous shim (`toBehavior`) and the DES model-load
   * binding so a directly-created `self` (no `toBehavior`) still gets its
   * resolved-nodes/handles/flags slot. When omitted, `self.local` defaults to
   * an empty object.
   */
  readonly local?: () => S extends MaterialFlowSelf<infer L> ? L : never;
  /**
   * Inline `self.local` factory — ergonomic alias for `local` (Plan 197 §12.2b,
   * Schritt-7-C pulled forward). When set it takes precedence over `local` as
   * the per-instance state seed; the resulting object is typed-inferred so the
   * author can skip a separate Local interface. Either field works.
   */
  readonly state?: () => S extends MaterialFlowSelf<infer L> ? L : never;
  /**
   * Mode-agnostic per-instance init, called by BOTH the continuous and DES
   * runners. Resolve nodes into `self.local`, declare signals, stamp the
   * inspector/badge companion, build the context menu — everything that is
   * needed regardless of simulation mode. Runs BEFORE the mode-specific
   * `continuous.setup` / DES wiring, so those can rely on the resolved
   * `self.local` nodes.
   */
  setup?(self: S): void;
  /**
   * Mode-agnostic RESET hook — fired on `resetSimulation()` phase 1
   * (`'simulation-reset'`). Restore the component's internal state to the
   * freshly-loaded start: FSM back to its initial state, part counters to 0,
   * timers/routing bookkeeping cleared. Do NOT re-resolve nodes (setup already
   * did). The factory wires this to the bind-context `onReset` hook; a
   * definition that omits it simply doesn't react to reset.
   */
  reset?(self: S): void;
  /**
   * Mode-agnostic START hook — fired on `resetSimulation()` phase 3
   * (`'simulation-start'`), after the reset + engine clear. (Re)start the
   * component from the clean state, e.g. re-assert `Run = true`. Wired to the
   * bind-context `onStart` hook.
   */
  start?(self: S): void;
  /**
   * Mode-agnostic RESETSTAT hook — fired on `'simulation-resetstat'`. Reset the
   * component's statistics accumulators only (no simulation-state change).
   * Primarily a DES concern. Wired to the bind-context `onResetStat` hook.
   */
  resetStat?(self: S): void;
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
export function defineMaterialFlow<
  S extends MaterialFlowSelf<any, any> = MaterialFlowSelf,
  SIG extends SignalShape = Record<string, never>,
>(
  def: MaterialFlowDefinition<S, SIG>,
): MaterialFlowDefinition<S, SIG> {
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
      // Reset lifecycle hooks — parity with defineLibraryComponent so a
      // definition driven through the low-level shim still reacts to
      // reset/start/resetstat.
      if (def.reset) rv.onReset(() => def.reset!(self));
      if (def.start) rv.onStart(() => def.start!(self));
      if (def.resetStat) rv.onResetStat(() => def.resetStat!(self));
      // teardown runs via the bind context's onDispose (model-cleared).
      if (c.teardown) {
        rv.onDispose(() => c.teardown!(self));
      }
    },
  };
}
