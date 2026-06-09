// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Sink — material-flow CONSUMER definition (Plan 194 §2.2, P3).
 *
 * Authored as a `defineMaterialFlow` (`kind:'sink'`) so the unified-simulation
 * surface (registry + DES hooks) covers MU destruction. ONE definition, but only
 * the `des` layer carries effect here:
 *
 *   - `des.onAccept(self, mu)` — the EVENT-DRIVEN path (private DESRunner, P5):
 *     accept and DESTROY the MU (mark it consumed), and publish
 *     `Conveyor.Occupied = false` so an upstream conveyor reads its successor as
 *     clear and discharges its part into the sink. Returns true (always accepts).
 *   - `continuous` — a thin, INERT pass-through marker.
 *
 * ── Why `continuous` is inert (the double-destroy guard) ────────────────────
 *
 * The CONTINUOUS destroy driver is the engine component `RVSink`
 * (`src/core/engine/rv-sink.ts`), constructed from `rv_extras['Sink']` by the
 * scene loader and ticked by the transport manager: it marks every MU whose AABB
 * overlaps the sink's collider for removal. This behavior MUST NOT re-implement
 * that AABB consumption: if its `continuous` block also destroyed MUs, every Sink
 * asset would consume on TWO paths (engine + behavior) — a regression. So
 * `continuous.setup` only declares the interlock signal + stamps the badge, and
 * `continuous.fixedUpdate` is absent.
 *
 * One continuous EFFECT it DOES carry (an interop convenience, NOT MU
 * destruction): it publishes `Conveyor.Occupied = false` for its own root once at
 * setup so an upstream conveyor that snaps into a Sink reads a clear successor and
 * discharges its line — the documented "add a Sink at the end to let the line
 * discharge" path from Conveyor.ts. This is a single signal write, not a per-tick
 * loop, and it never touches MUs.
 *
 * The behavior binds only when a placed asset's name matches `*Sink*` (the
 * BehaviorManager matches `models[]` against the GLB filename / LayoutObject
 * asset name, never against inner node names).
 */

import type { Behavior } from '../core/behaviors';
import type { RVBindContext } from '../core/behavior-runtime';
import { registerCapabilities } from '../core/engine/rv-component-registry';
import { defineMaterialFlow } from '../core/material-flow/define-material-flow';
import { createSelf, type MaterialFlowSelf, type MU } from '../core/material-flow/material-flow-self';

// Hierarchy/inspector badge marker (pure marker — no factory).
registerCapabilities('SinkBehavior', {
  badgeColor: '#7e57c2',
  filterLabel: 'Behavior',
  hierarchyVisible: true,
  inspectorVisible: true,
});

const OCCUPIED_SIGNAL = 'Conveyor.Occupied';

/** Mark an MU consumed (destroyed). Mirrors RVSink's `markedForRemoval` flag
 *  when the visual carries it; always tags the structural MU's prop bag. */
function destroyMu(mu: MU): void {
  if (mu.prop) mu.prop['consumed'] = true;
  const visual = mu.visual as { markedForRemoval?: boolean } | undefined;
  if (visual && typeof visual === 'object') visual.markedForRemoval = true;
}

// ─── Definition (registers into the material-flow registry; DES uses des.*) ──

const def = defineMaterialFlow({
  // Any placed asset whose name contains "Sink": Sink, PalletSink, …
  type: 'Sink',
  kind: 'sink',
  models: ['*Sink*'],
  schema: {},

  // ── Mode-agnostic init (continuous AND DES) — declares + publishes the
  //    successor-clear interlock signal so an upstream conveyor that snaps into
  //    the sink discharges its line. A Sink is ALWAYS a clear successor; this is
  //    a single signal write at init, never per-tick, and never touches MUs.
  setup(self: MaterialFlowSelf): void {
    self.signal(OCCUPIED_SIGNAL, { type: 'PLCOutputBool', initialValue: false });
    self.signals.set(OCCUPIED_SIGNAL, false);
  },

  // ── Continuous adapter — INERT for MU destruction. The engine RVSink owns
  //    the per-tick AABB consumption. No fixedUpdate, no MU handling: RVSink
  //    remains the continuous destroy driver.
  continuous: {
    setup(_self: MaterialFlowSelf): void {
      // Intentionally empty — the successor-clear interlock is published by the
      // shared setup() above; continuous MU destruction stays with RVSink.
    },
  },

  // ── DES adapter — event-driven consumption (private DESRunner, P5) ──
  des: {
    /**
     * Accept the MU, destroy it, and keep the successor-clear interlock low so
     * the upstream line discharges. Always accepts (a sink has infinite
     * capacity). Runs only under the DESRunner, never on the continuous path.
     */
    onAccept(self: MaterialFlowSelf, mu: MU): boolean {
      destroyMu(mu);
      // A sink is never a back-pressure point — publish clear so the upstream
      // conveyor reads its successor as free and pushes the next part.
      self.signals.set(OCCUPIED_SIGNAL, false);
      return true;
    },
  },
});

// ─── Default export: a Behavior so glob discovery (behaviors.ts) finds it ──
//
// The continuous bind stamps the inspector badge and runs the shared (mode-
// agnostic) setup (which publishes the successor-clear interlock) followed by the
// inert continuous setup, but registers NO fixedUpdate. The engine RVSink
// (constructed from rv_extras) remains the sole continuous MU-destroy driver.
const SinkBehavior: Behavior = {
  models: def.models ?? ['*Sink*'],
  bind(rv: RVBindContext): void {
    const rootTag = rv.root.name || '<unnamed>';
    rv.behavior(rv.root, 'SinkBehavior', {});
    console.info(`[Sink:${rootTag}] material-flow definition bound (continuous consumption stays with the engine RVSink)`);

    const self = createSelf(rv, def, { mode: 'continuous' });
    // Mode-agnostic init FIRST, then the (inert) continuous setup — same order
    // as toBehavior(), so the successor-clear interlock is published.
    def.setup!(self);
    def.continuous.setup!(self);
    // No rv.onFixedUpdate — continuous consumption is owned by the engine RVSink.
  },
};

export default SinkBehavior;
