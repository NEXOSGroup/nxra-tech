// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Source — material-flow GENERATOR definition (Plan 194 §2.2, P3).
 *
 * Authored as a `defineLibraryComponent` (`kind:'source'`, `inert:true`) so the
 * unified-simulation surface (registry + DES hooks) covers MU generation. ONE
 * definition, but only TWO layers carry effect here:
 *
 *   - `des.onGenerate(self)` — the EVENT-DRIVEN path (private DESRunner, P5):
 *     mint a fresh MU and transfer it to the first free output, then schedule the
 *     next generation from the spawn schedule (Interval / Distance / OnSignal).
 *   - `continuous` — a thin, INERT pass-through marker.
 *
 * ── Why the component is inert (the double-spawn guard) ─────────────────────
 *
 * The CONTINUOUS spawn driver is the engine component `RVSource`
 * (`src/core/engine/rv-source.ts`), constructed from `rv_extras['Source']` by the
 * scene loader and ticked by the transport manager. It owns template resolution,
 * ghost/preview rendering, placement gating, and the actual clone/instanced
 * spawn. This behavior MUST NOT re-implement any of that: if its `continuous`
 * block spawned, every Source asset would spawn TWICE (engine + behavior) on the
 * default path — a regression. So `inert:true` runs setup but registers NO
 * fixedUpdate. The definition exists for the material-flow registry (dual
 * discovery, §2.6) and for the `des` adapter; it does NOT drive the continuous
 * simulation.
 *
 * The behavior binds only when a placed asset's name matches `*Source*` (the
 * BehaviorManager matches `models[]` against the GLB filename / LayoutObject
 * asset name, never against inner node names), so it never collides with an
 * arbitrary `Source` rv_extras entry on some inner node.
 *
 * Schema is mode-agnostic and read straight from `rv_extras['Source']` — the
 * same fields the engine `RVSource` consumes (Interval / GenerateIfDistance /
 * AutomaticGeneration / ThisObjectAsMU). No values are duplicated; the schema is
 * registered for inspector visibility and consumed by the DES generator.
 */

import { defineLibraryComponent, type RV } from './_shared/behavior-kit';

/** Seconds between generations, derived from the mode-agnostic schema. */
function generationInterval(self: RV.Self): number {
  const interval = Number(self.prop['Interval'] ?? 0);
  // Default cadence mirrors the engine RVSource (3 s) when no interval is set.
  return interval > 0 ? interval : 3;
}

const def = {
  // Any placed asset whose name contains "Source": Source, PartSource, …
  type: 'Source' as const,
  kind: 'source' as const,
  description: 'Source that spawns parts (MUs) and feeds them into the line.',
  mcpDocs:
    'Start of a material-flow line: spawns MUs (pallets/boxes) at an interval and pushes them ' +
    'onto the connected conveyor. Place it at the head of a run (snap it to a conveyor input). ' +
    'Spawn rate / part template / automatic generation are config fields.',
  models: ['*Source*'],
  // Spawn config — the SAME field names the engine RVSource consumes. This
  // behavior is inert:true (no continuous fixedUpdate) and only the `des` block
  // reads them (generationInterval → self.prop['Interval']); the LIVE spawn driver
  // is the engine RVSource component (its own editable "Source" inspector section).
  // Editing these on the SourceBehavior marker has NO live effect and would
  // duplicate/contradict the real Source section, so all are scope:'des'
  // (read-only, "(DES)" tag) — edit the live values in the Source section instead.
  schema: {
    AutomaticGeneration: { type: 'boolean' as const, default: true, scope: 'des' as const },
    Interval:            { type: 'number' as const,  default: 0, aliases: ['SpawnInterval'], scope: 'des' as const },
    GenerateIfDistance:  { type: 'number' as const,  default: 300, aliases: ['SpawnDistance'], scope: 'des' as const },
    ThisObjectAsMU:      { type: 'string' as const,  default: '', scope: 'des' as const },
  },

  // ── Continuous adapter — INERT. The engine RVSource owns continuous spawning. ──
  // No fixedUpdate (no double-spawn on the default path) — guaranteed by
  // `inert:true`. See the file header "double-spawn guard".
  continuous: {},

  // ── DES adapter — event-driven generation (private DESRunner, P5) ──
  des: {
    /**
     * Generate one MU and transfer it to the first free output, then schedule
     * the next generation. This is the DES analogue of the engine RVSource's
     * interval/distance spawn — it runs only under the DESRunner, never on the
     * continuous path.
     */
    onGenerate(self: RV.Self): void {
      // Mint a real runner-backed MU (manager-tracked) — `self.spawn()` returns a
      // plain structural MU in continuous/mock mode, a registered DESMU under the
      // DESRunner.
      const mu: RV.MU = self.spawn();
      // Hand the new MU to the first output port (the start of the line). The
      // DESRunner replaces self.transfer with the real canAccept→accept handshake
      // (P5); in continuous/mock mode it is a no-op (no double-effect).
      self.transfer(mu, self.outputs()[0]);
      // Re-arm: schedule the next generation from the spawn schedule.
      self.in(generationInterval(self), 'Generate', null);
    },
  },
};

/**
 * Source — inert material-flow generator (factory-built). The continuous bind
 * stamps the inspector badge and runs setup, but `inert:true` registers NO
 * fixedUpdate — the engine RVSource (constructed from rv_extras) remains the sole
 * continuous spawn driver.
 */
const SourceBehavior = defineLibraryComponent(def, { inert: true });

export default SourceBehavior;
