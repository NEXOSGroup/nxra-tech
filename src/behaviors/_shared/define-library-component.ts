// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * define-library-component.ts — the all-in-one authoring factory (Plan 197 §12).
 *
 * `defineLibraryComponent(def, opts)` is ONE call + ONE kit import for a
 * component author. It wraps the existing material-flow primitives so a
 * self-defined component is indistinguishable from an rv_extras-configured one:
 *
 *   1. `defineMaterialFlow(def)`        — dual discovery + schema (idempotent).
 *   2. `registerComponentSchema(<Type>Behavior, schema, caps)` — registers the
 *      schema AND the badge capability under the marker type so the schema
 *      fields render as "consumed" inspector rows in the SAME section as the
 *      badge marker (F2). Guarded against double-register (no DEV double-warn).
 *   3. Returns a `Behavior` whose `bind(rv)`:
 *        createSelf → def.setup → (skip rest if self.disabled) →
 *        continuous.setup → marker + schema-default stamp → onFixedUpdate
 *        (only when !inert && continuous.fixedUpdate && !disabled) → onDispose.
 *
 * The badge literal is defined INLINE in this file (no shared `_shared`
 * constant; per [[feedback-behaviors-inline-trivial]]). Authors pass their own
 * `opts.capabilities` to override it.
 */

import type { Behavior } from '../../core/behaviors';
import type { RVBindContext, SignalType } from '../../core/behavior-runtime';
import {
  registerComponentSchema,
  getSchemaDefaults,
  type ComponentCapabilities,
} from '../../core/engine/rv-component-registry';
import {
  defineMaterialFlow,
  type MaterialFlowDefinition,
  type RequiresKind,
} from '../../core/material-flow/define-material-flow';
import {
  createSelf,
  type MaterialFlowSelf,
  type SignalShape,
} from '../../core/material-flow/material-flow-self';
import {
  findAll,
  NODE_KIND_TESTS,
} from '../../core/library-component-loader';
import type { Object3D } from 'three';

/**
 * The standard library-component badge — inline literal, NOT a shared constant.
 * Used as the default for `opts.capabilities` so every factory-built component
 * shows the same purple "Behavior" badge unless the author overrides it.
 */
const STANDARD_BADGE: ComponentCapabilities = {
  badgeColor: '#7e57c2',
  filterLabel: 'Behavior',
  hierarchyVisible: true,
  inspectorVisible: true,
};

/** Marker types whose schema/capabilities are already registered (guard). */
const _registeredMarkers = new Set<string>();

/** Typed initial value for an auto-declared signal: Bool → false, Int/Float → 0. */
function signalInitialValue(type: SignalType): boolean | number {
  return type.includes('Bool') ? false : 0;
}

/** Resolve all convention-named nodes of a `requires` kind under `root`. */
function resolveRequiredNodes(root: Object3D, kind: RequiresKind): Object3D[] {
  return findAll(root, NODE_KIND_TESTS[kind]);
}

/**
 * Capitalise a `requires` key for the auto-badge marker payload (so
 * `requires: { belt:'transport', sensor:'sensor' }` stamps `{ Belt, Sensor }`,
 * matching the explicit `badge` hook the conveyor used before).
 */
function badgeKey(key: string): string {
  return key.length === 0 ? key : key[0].toUpperCase() + key.slice(1);
}

export interface LibraryComponentOptions<S, SIG extends SignalShape = Record<string, never>> {
  /** Inline badge/inspector caps for the `<Type>Behavior` marker. Default = STANDARD_BADGE. */
  capabilities?: ComponentCapabilities;
  /** Marker payload (e.g. resolved Belt/Sensor names) stamped after setup. Default `{}`. */
  badge?: (self: MaterialFlowSelf<S, SIG>) => Record<string, unknown>;
  /** Engine-owned components (Source/Sink): setup runs, NEVER fixedUpdate (double-spawn guard). */
  inert?: boolean;
}

/**
 * Define a library component from a material-flow definition + factory options.
 *
 * Both generics are INFERRED from the definition (Plan 197 §2.4b-C / §2.4b-A),
 * so an author rarely needs an explicit type argument:
 *   - `S`   (local state) — from `def.state` / `def.local` return type.
 *   - `SIG` (signals shape) — from the optional `def.signals` block.
 *
 * The definition's `state` field (when present) is the preferred `self.local`
 * factory (typed-inferred); `local` keeps working as the fallback. The returned
 * `Behavior` is `defineBehavior`-compatible — discovered + dispatched by the
 * existing BehaviorManager exactly like a hand-written behavior.
 *
 * Three OPTIONAL declarative blocks layer on top of the core (all additive — a
 * definition that uses none behaves exactly as before):
 *   - `signals` (§2.4b-A): auto-declares each as `${type}.${key}` and exposes a
 *     typed `self.sig.<key>` accessor.
 *   - `requires` (§2.4b-B): resolves convention nodes, injects `self.<key>`,
 *     auto-disables on a missing node, and stamps an auto-badge marker.
 *   - `state` (§2.4b-C): inline local-state factory (the `S` generic is inferred
 *     from its return type).
 */
export function defineLibraryComponent<
  S = Record<string, never>,
  SIG extends SignalShape = Record<string, never>,
>(
  def: MaterialFlowDefinition<MaterialFlowSelf<S, SIG>, SIG>,
  opts: LibraryComponentOptions<S, SIG> = {},
): Behavior {
  // 1. Dual discovery + schema under `def.type` (idempotent).
  defineMaterialFlow(def);

  // 2. Schema + badge capability under the `<Type>Behavior` marker — one section,
  //    one source of truth for the inspector (F2). Guarded so a re-register
  //    (HMR / a second module evaluation) does not emit the DEV double-warn.
  const markerType = `${def.type}Behavior`;
  const caps = opts.capabilities ?? STANDARD_BADGE;
  if (!_registeredMarkers.has(markerType)) {
    registerComponentSchema(markerType, def.schema, caps);
    _registeredMarkers.add(markerType);
  }

  // `state` is the preferred local factory (typed-inferred); `local` is the
  // fallback. Reconcile here so both author styles seed `self.local`.
  const makeLocal = (def.state ?? def.local) as (() => S) | undefined;
  const signalsBlock = def.signals;
  const requiresBlock = def.requires;

  return {
    models: def.models ?? [`*${def.type}*`],
    bind(rv: RVBindContext): void {
      const self = createSelf<S, SIG>(rv, def, {
        mode: 'continuous',
        local: makeLocal ? makeLocal() : undefined,
        // Pass the signals shape so `self.sig.<key>` accessors are built.
        signals: signalsBlock,
      });

      // 3a. `signals` block — auto-declare each signal as `${type}.${key}` with a
      //     typed initial value (replaces `declareConveyorSignalsWith`). Done in
      //     the mode-agnostic phase (BEFORE def.setup) so setup/sig can use them.
      if (signalsBlock) {
        for (const key of Object.keys(signalsBlock)) {
          const type = signalsBlock[key];
          self.signal(`${def.type}.${key}`, { type, initialValue: signalInitialValue(type) });
        }
      }

      // 3b. `requires` block — resolve convention nodes, inject `self.<key>`,
      //     auto-disable on a missing node, collect the auto-badge payload. Done
      //     BEFORE def.setup so setup can rely on the injected nodes.
      const injected = self as unknown as Record<string, Object3D | null>;
      const autoBadge: Record<string, unknown> = {};
      if (requiresBlock) {
        for (const key of Object.keys(requiresBlock)) {
          const kind = requiresBlock[key];
          const matches = resolveRequiredNodes(rv.root, kind);
          if (matches.length > 1) {
            console.warn(
              `[library-component] ${def.type}: multiple '${kind}' nodes for ` +
                `requires.${key} — using the first ('${matches[0].name}').`,
            );
          }
          const node = matches[0] ?? null;
          injected[key] = node;
          if (!node) {
            self.disable(`missing ${kind} for ${key}`);
          } else {
            autoBadge[badgeKey(key)] = node.name;
          }
        }
      }

      // If a required node was missing, the instance is disabled — skip ALL
      // continuous wiring (no marker stamp, no continuous.setup, no fixedUpdate).
      if (self.disabled) return;

      // Mode-agnostic init. If it disables the instance (missing nodes), skip
      // the rest as well (no marker stamp, no continuous wiring).
      def.setup?.(self);
      if (self.disabled) return;

      const c = def.continuous;
      c.setup?.(self);

      // Marker + schema-default stamp: schema defaults render as (editable /
      // readonly) inspector rows; the auto-badge (resolved required nodes) and
      // the explicit `opts.badge` payload add the resolved markers (explicit
      // wins on a key clash). All land in userData.realvirtual[<Type>Behavior].
      rv.behavior(rv.root, markerType, {
        ...getSchemaDefaults(markerType),
        ...autoBadge,
        ...(opts.badge ? opts.badge(self) : {}),
      });

      // FixedUpdate only for non-inert components that declare one (F5).
      const fixed = c.fixedUpdate;
      const late = c.lateFixedUpdate;
      if (!opts.inert && (fixed || late)) {
        rv.onFixedUpdate((dt: number) => {
          if (fixed) fixed(self, dt);
          if (late) late(self, dt);
        });
      }

      if (c.teardown) {
        rv.onDispose(() => c.teardown!(self));
      }
    },
  };
}

/** Test-only: clear the marker-registration guard set. */
export function _resetLibraryComponentMarkers(): void {
  _registeredMarkers.clear();
}
