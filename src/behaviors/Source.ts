// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Source — material-flow GENERATOR definition (Plan 194 §2.2, P3).
 *
 * Authored as a `defineMaterialFlow` (`kind:'source'`) so the unified-simulation
 * surface (registry + DES hooks) covers MU generation. ONE definition, but only
 * TWO layers carry effect here:
 *
 *   - `des.onGenerate(self)` — the EVENT-DRIVEN path (private DESRunner, P5):
 *     mint a fresh MU and transfer it to the first free output, then schedule the
 *     next generation from the spawn schedule (Interval / Distance / OnSignal).
 *   - `continuous` — a thin, INERT pass-through marker.
 *
 * ── Why `continuous` is inert (the double-spawn guard) ──────────────────────
 *
 * The CONTINUOUS spawn driver is the engine component `RVSource`
 * (`src/core/engine/rv-source.ts`), constructed from `rv_extras['Source']` by the
 * scene loader and ticked by the transport manager. It owns template resolution,
 * ghost/preview rendering, placement gating, and the actual clone/instanced
 * spawn. This behavior MUST NOT re-implement any of that: if its `continuous`
 * block spawned, every Source asset would spawn TWICE (engine + behavior) on the
 * default path — a regression. So `continuous.setup` only stamps an inspector
 * badge and `continuous.fixedUpdate` is absent. The definition exists for the
 * material-flow registry (dual discovery, §2.6) and for the `des` adapter; it
 * does NOT drive the continuous simulation.
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

import type { Behavior } from '../core/behaviors';
import type { RVBindContext } from '../core/behavior-runtime';
import { registerCapabilities } from '../core/engine/rv-component-registry';
import { defineMaterialFlow } from '../core/material-flow/define-material-flow';
import { createSelf, type MaterialFlowSelf, type MU } from '../core/material-flow/material-flow-self';
import { BEHAVIOR_BADGE } from './_shared/behavior-badge';

// Hierarchy/inspector badge marker (pure marker — no factory).
registerCapabilities('SourceBehavior', BEHAVIOR_BADGE);

// ── Per-self DES generation state (id counter only; continuous holds nothing) ──
const _muIdCounter = new WeakMap<MaterialFlowSelf, number>();

function nextMuId(self: MaterialFlowSelf): number {
  const n = (_muIdCounter.get(self) ?? 0) + 1;
  _muIdCounter.set(self, n);
  return n;
}

/** Seconds between generations, derived from the mode-agnostic schema. */
function generationInterval(self: MaterialFlowSelf): number {
  const interval = Number(self.prop['Interval'] ?? 0);
  // Default cadence mirrors the engine RVSource (3 s) when no interval is set.
  return interval > 0 ? interval : 3;
}

// ─── Definition (registers into the material-flow registry; DES uses des.*) ──

const def = defineMaterialFlow({
  // Any placed asset whose name contains "Source": Source, PartSource, …
  type: 'Source',
  kind: 'source',
  models: ['*Source*'],
  // Mode-agnostic spawn config — the SAME fields the engine RVSource reads.
  schema: {
    AutomaticGeneration: { type: 'boolean', default: true },
    Interval:            { type: 'number',  default: 0, aliases: ['SpawnInterval'] },
    GenerateIfDistance:  { type: 'number',  default: 300, aliases: ['SpawnDistance'] },
    ThisObjectAsMU:      { type: 'string',  default: '' },
  },

  // ── Continuous adapter — INERT. The engine RVSource owns continuous spawning. ──
  // setup() stamps the badge only; NO fixedUpdate (no double-spawn on the default
  // path). See the file header "double-spawn guard".
  continuous: {
    setup(_self: MaterialFlowSelf): void {
      // Intentionally empty beyond the bind-time badge stamp (done in bind()).
      // No signals, no spawning — RVSource is the continuous spawn driver.
    },
  },

  // ── DES adapter — event-driven generation (private DESRunner, P5) ──
  des: {
    /**
     * Generate one MU and transfer it to the first free output, then schedule
     * the next generation. This is the DES analogue of the engine RVSource's
     * interval/distance spawn — it runs only under the DESRunner, never on the
     * continuous path.
     */
    onGenerate(self: MaterialFlowSelf): void {
      const mu: MU = { id: nextMuId(self), prop: {} };
      // Hand the new MU to the first output port (the start of the line). The
      // DESRunner replaces self.transfer with the real canAccept→accept handshake
      // (P5); in continuous/mock mode it is a no-op (no double-effect).
      self.transfer(mu, self.outputs()[0]);
      // Re-arm: schedule the next generation from the spawn schedule.
      self.in(generationInterval(self), 'Generate', null);
    },
  },
});

// ─── Default export: a Behavior so glob discovery (behaviors.ts) finds it ──
//
// The continuous bind is deliberately minimal — it stamps the inspector badge
// and creates the (continuous-mode) self so the definition is discoverable and
// the registry is populated, but registers NO fixedUpdate. The engine RVSource
// (constructed from rv_extras) remains the sole continuous spawn driver.
const SourceBehavior: Behavior = {
  models: def.models ?? ['*Source*'],
  bind(rv: RVBindContext): void {
    const rootTag = rv.root.name || '<unnamed>';
    rv.behavior(rv.root, 'SourceBehavior', {});
    console.info(`[Source:${rootTag}] material-flow definition bound (continuous spawning stays with the engine RVSource)`);

    const self = createSelf(rv, def, { mode: 'continuous' });
    def.continuous.setup!(self);
    // No rv.onFixedUpdate — continuous spawning is owned by the engine RVSource.
  },
};

export default SourceBehavior;
