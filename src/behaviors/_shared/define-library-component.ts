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
import type { RVBindContext } from '../../core/behavior-runtime';
import {
  registerComponentSchema,
  getSchemaDefaults,
  type ComponentCapabilities,
} from '../../core/engine/rv-component-registry';
import {
  defineMaterialFlow,
  type MaterialFlowDefinition,
} from '../../core/material-flow/define-material-flow';
import {
  createSelf,
  type MaterialFlowSelf,
} from '../../core/material-flow/material-flow-self';

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

export interface LibraryComponentOptions<S> {
  /** Inline badge/inspector caps for the `<Type>Behavior` marker. Default = STANDARD_BADGE. */
  capabilities?: ComponentCapabilities;
  /** Marker payload (e.g. resolved Belt/Sensor names) stamped after setup. Default `{}`. */
  badge?: (self: MaterialFlowSelf<S>) => Record<string, unknown>;
  /** Engine-owned components (Source/Sink): setup runs, NEVER fixedUpdate (double-spawn guard). */
  inert?: boolean;
}

/**
 * Define a library component from a material-flow definition + factory options.
 *
 * The definition's `state` field (when present) is the preferred `self.local`
 * factory (typed-inferred); `local` keeps working as the fallback. The returned
 * `Behavior` is `defineBehavior`-compatible — discovered + dispatched by the
 * existing BehaviorManager exactly like a hand-written behavior.
 */
export function defineLibraryComponent<S = Record<string, never>>(
  def: MaterialFlowDefinition<MaterialFlowSelf<S>>,
  opts: LibraryComponentOptions<S> = {},
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

  return {
    models: def.models ?? [`*${def.type}*`],
    bind(rv: RVBindContext): void {
      const self = createSelf<S>(rv, def, {
        mode: 'continuous',
        local: makeLocal ? makeLocal() : undefined,
      });

      // Mode-agnostic init FIRST. If it disables the instance (missing nodes),
      // skip ALL continuous wiring (no continuous.setup, no fixedUpdate).
      def.setup?.(self);
      if (self.disabled) return;

      const c = def.continuous;
      c.setup?.(self);

      // Marker + schema-default stamp: schema defaults render as (editable /
      // readonly) inspector rows; the badge payload adds the resolved markers.
      // Both land in userData.realvirtual[<Type>Behavior] (F2/F6).
      rv.behavior(rv.root, markerType, {
        ...getSchemaDefaults(markerType),
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
