// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Sink — material-flow CONSUMER definition (Plan 194 §2.2, P3).
 *
 * Authored as a `defineLibraryComponent` (`kind:'sink'`, `inert:true`) so the
 * unified-simulation surface (registry + DES hooks) covers MU destruction. ONE
 * definition, but only the `des` layer carries effect here:
 *
 *   - `des.onAccept(self, mu)` — the EVENT-DRIVEN path (private DESRunner, P5):
 *     accept and DESTROY the MU (mark it consumed), and publish
 *     `Conveyor.Occupied = false` so an upstream conveyor reads its successor as
 *     clear and discharges its part into the sink. Returns true (always accepts).
 *   - `continuous` — a thin, INERT pass-through marker.
 *
 * ── Why the component is inert (the double-destroy guard) ───────────────────
 *
 * The CONTINUOUS destroy driver is the engine component `RVSink`
 * (`src/core/engine/rv-sink.ts`), constructed from `rv_extras['Sink']` by the
 * scene loader and ticked by the transport manager: it marks every MU whose AABB
 * overlaps the sink's collider for removal. This behavior MUST NOT re-implement
 * that AABB consumption: if its `continuous` block also destroyed MUs, every Sink
 * asset would consume on TWO paths (engine + behavior) — a regression. So
 * `inert:true` runs setup but registers NO fixedUpdate.
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

import { defineLibraryComponent, type RV } from './_shared/behavior-kit';

// Sink publishes the conveyor interop signal `Conveyor.Occupied` (NOT `Sink.*`).
// `signalNamespace: 'Conveyor'` scopes the signals block to that partner type,
// so `self.sig.Occupied` reads/writes `Conveyor.Occupied`.
const SIGNALS = { Occupied: 'PLCOutputBool' } as const;
type SinkSelf = RV.Self<Record<string, never>, typeof SIGNALS>;

/** Mark an MU consumed (destroyed). Mirrors RVSink's `markedForRemoval` flag
 *  when the visual carries it; always tags the structural MU's prop bag. */
function destroyMu(mu: RV.MU): void {
  if (mu.prop) mu.prop['consumed'] = true;
  const visual = mu.visual as { markedForRemoval?: boolean } | undefined;
  if (visual && typeof visual === 'object') visual.markedForRemoval = true;
}

const def = {
  // Any placed asset whose name contains "Sink": Sink, PalletSink, …
  type: 'Sink' as const,
  kind: 'sink' as const,
  models: ['*Sink*'],
  schema: {},

  // The successor-clear interop signal — published under the `Conveyor` namespace
  // (cross-type convention), auto-declared as `Conveyor.Occupied`.
  signalNamespace: 'Conveyor' as const,
  signals: SIGNALS,

  // ── Mode-agnostic init (continuous AND DES) — publishes the successor-clear
  //    interlock signal so an upstream conveyor that snaps into the sink
  //    discharges its line. A Sink is ALWAYS a clear successor; this is a single
  //    signal write at init, never per-tick, and never touches MUs.
  setup(self: SinkSelf): void {
    self.sig.Occupied.set(false);
  },

  // ── Continuous adapter — INERT for MU destruction. The engine RVSink owns
  //    the per-tick AABB consumption. No fixedUpdate, no MU handling (guaranteed
  //    by `inert:true`): RVSink remains the continuous destroy driver.
  continuous: {},

  // ── DES adapter — event-driven consumption (private DESRunner, P5) ──
  des: {
    /**
     * Accept the MU, destroy it, and keep the successor-clear interlock low so
     * the upstream line discharges. Always accepts (a sink has infinite
     * capacity). Runs only under the DESRunner, never on the continuous path.
     */
    onAccept(self: SinkSelf, mu: RV.MU): boolean {
      destroyMu(mu);
      // A sink is never a back-pressure point — publish clear so the upstream
      // conveyor reads its successor as free and pushes the next part.
      self.sig.Occupied.set(false);
      return true;
    },
  },
};

/**
 * Sink — inert material-flow consumer (factory-built). The continuous bind stamps
 * the inspector badge and runs the shared setup (which publishes the
 * successor-clear interlock), but `inert:true` registers NO fixedUpdate — the
 * engine RVSink (constructed from rv_extras) remains the sole continuous
 * MU-destroy driver.
 */
const SinkBehavior = defineLibraryComponent(def, { inert: true });

export default SinkBehavior;
