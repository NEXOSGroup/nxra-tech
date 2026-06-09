// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Conveyor — zone-accumulation conveyor for a snapped line of belts.
 *
 * Authored as a `defineMaterialFlow` (Plan 194 §2.5): ONE definition, THREE
 * layers — `logic` (mode-agnostic ZPA decisions), `continuous` (the public
 * 60 Hz physics adapter), `des` (the event-driven adapter feeding the DES
 * runner). The continuous adapter reproduces the previously hand-written
 * behavior EXACTLY; the logic/des layers add the unified-simulation surface
 * without changing any runtime behaviour.
 *
 * Discovers its belt (`Transport-*`) and sensor (`Sensor` / `Sensor-*`) by the
 * naming convention. MUs already flow belt → belt automatically (the transport
 * manager hands an MU to whichever adjacent surface overlaps it), so this
 * component's job is ACCUMULATION control — standard single-sensor ZPA
 * (zero-pressure accumulation):
 *
 *   The belt runs while `Conveyor.Run` is true, EXCEPT it stops when a part sits at
 *   its sensor AND the downstream zone is occupied — so parts queue at the junction
 *   instead of colliding. When downstream clears, the belt releases the part and
 *   back-pressure ripples upstream.
 *
 * Topology: the downstream neighbour is the conveyor paired to this conveyor's
 * OUTPUT snap (`Snap-*P-*`, flow = 'out') in the snap-point graph. Each conveyor
 * publishes `Conveyor.Occupied` (its surface state) as the interlock its upstream
 * neighbour reads. Per-instance signal scoping keeps every placement's signals
 * independent; the upstream reads the downstream's scoped `Conveyor.Occupied` via
 * the global (`/`-prefixed) signal escape (see rv-instance-scope).
 *
 * Signals (scoped per placed instance):
 *   Conveyor.Run        PLCInputBool   master enable (default on)
 *   Conveyor.Occupied   PLCOutputBool  a part is anywhere on this conveyor's belt (interlock)
 *   Conveyor.Running    PLCOutputBool  belt currently moving
 *   Conveyor.PartCount  PLCOutputInt   parts that passed the sensor
 *
 * GLB: a `Transport-*` belt + a `Sensor*` node; placed and snapped into a line.
 * No downstream neighbour (end of line / standalone, or mid-assembly) → treated
 * as **blocked**. An empty conveyor with no successor still runs (so parts can
 * transit through an unfinished line), but a part reaching its sensor holds
 * there instead of discharging into nothing. Add a Sink at the end to declare
 * `Conveyor.Occupied = false` and let the line discharge.
 * All rv.* subscriptions auto-dispose.
 */

import type { Object3D } from 'three';
import type { Behavior } from '../core/behaviors';
import type { RVBindContext } from '../core/behavior-runtime';
import { findTransport, findSensor } from '../core/library-component-loader';
import { registerCapabilities } from '../core/engine/rv-component-registry';
import { defineMaterialFlow } from '../core/material-flow/define-material-flow';
import { createSelf, type MaterialFlowSelf, type MU } from '../core/material-flow/material-flow-self';
import {
  conveyorShouldRun,
  createDownstreamInterlock,
} from './_shared/transport-links';
import { attachBelt, type BeltHandle } from './_shared/lazy-drive';
import { BEHAVIOR_BADGE } from './_shared/behavior-badge';
import { isSurfaceOccupied } from './_shared/surface-occupancy';

// Hierarchy/inspector badge marker (pure marker — no factory).
registerCapabilities('ConveyorBehavior', BEHAVIOR_BADGE);

const RUN_SIGNAL = 'Conveyor.Run';
const OCCUPIED_SIGNAL = 'Conveyor.Occupied';
const RUNNING_SIGNAL = 'Conveyor.Running';
const PARTCOUNT_SIGNAL = 'Conveyor.PartCount';
const NEIGHBOR_REFRESH_SEC = 0.5; // re-resolve the downstream neighbour / retry drive at this rate

// ─── Per-instance continuous state ──────────────────────────────────────
//
// The shared `self` (createSelf) carries the mode-agnostic surface (signals,
// drive, downstreamOccupied, prop). Conveyor needs a few continuous-only,
// non-JSON handles in addition (the bind context for surface-occupancy, the
// resolved nodes, the lazy belt handle, the inline interlock, and the local
// edge/count state). These live in a per-`self` WeakMap so the def's
// `continuous`/`logic` methods stay closure-free yet typed. partAtSensor here
// is the LOCAL discharge trigger and is distinct from the PUBLISHED
// surface-based `Conveyor.Occupied`.
interface ConveyorState {
  rv: RVBindContext;
  beltNode: Object3D;
  sensorNode: Object3D;
  belt: BeltHandle;
  interlock: { occupied(): boolean };
  partAtSensor: boolean;
  partCount: number;
  refreshTimer: number;
  /** DES-only: MUs held back because shouldFlow() / canAccept() said no. */
  blockedMUs: MU[];
}

const _state = new WeakMap<MaterialFlowSelf, ConveyorState>();

function st(self: MaterialFlowSelf): ConveyorState {
  const s = _state.get(self);
  if (!s) throw new Error('[Conveyor] state missing — setup() did not run');
  return s;
}

// ─── Mode-agnostic ZPA logic (shared by continuous + des, typed) ─────────
//
// Authored as standalone functions so they are strongly typed (the
// `LogicBlock` index signature widens args to `never[]`); `def.logic` below
// references them so the three-layer structure + DES introspection stay real.

/**
 * Standard single-sensor ZPA release rule: run unless a part is held at this
 * conveyor's sensor AND the downstream zone is occupied. Identical to
 * `conveyorShouldRun`. `partAtSensor` is the LOCAL discharge trigger — NOT the
 * published surface-based Occupied.
 */
function shouldFlow(self: MaterialFlowSelf): boolean {
  const s = st(self);
  const run = self.signals.get<boolean>(RUN_SIGNAL) === true;
  const dsOcc = s.interlock.occupied();
  return conveyorShouldRun(run, s.partAtSensor, dsOcc);
}

/** Sensor flank: count on the rising edge and set the local discharge trigger. */
function onPartAtSensor(self: MaterialFlowSelf, present: boolean): void {
  const s = st(self);
  if (present && !s.partAtSensor) {        // rising edge → a part arrived
    s.partCount += 1;
    self.signals.set(PARTCOUNT_SIGNAL, s.partCount);
  }
  s.partAtSensor = present;
  // NOTE: `Conveyor.Occupied` is NOT published here — it is published every
  // tick from surface occupancy (see continuous.fixedUpdate) so it reflects a
  // good ANYWHERE on the belt, not only at the sensor point.
}

function onPartLeft(self: MaterialFlowSelf): void {
  st(self).partAtSensor = false;
}

/** DES release attempt: flow if allowed, else hold the MU as back-pressure. */
function tryRelease(self: MaterialFlowSelf, mu: MU): boolean {
  if (shouldFlow(self)) {
    self.transfer(mu, self.outputs()[0]);
    onPartLeft(self);
    return true;
  }
  st(self).blockedMUs.push(mu);    // stau = blocked, not a belt stop
  return false;
}

// ─── Definition (registers into the material-flow registry for DES) ──────

const def = defineMaterialFlow({
  // Any GLB whose filename contains "Conveyor" (case-sensitive): Conveyor,
  // RollConveyor2m, ChainConveyor3m, … One belt + one sensor per asset.
  type: 'Conveyor',
  kind: 'conveyor',
  models: ['*Conveyor*'],
  schema: {},

  // Mode-agnostic ZPA logic (identical decision across continuous + des).
  logic: { shouldFlow, onPartAtSensor, onPartLeft },

  // ── Continuous adapter — PUBLIC default path (60 Hz, after transport.update) ──
  continuous: {
    setup(self: MaterialFlowSelf): void {
      const s = st(self);

      // ─── Signals (scoped per instance) ───────────────────────────────
      self.signal(RUN_SIGNAL,       { type: 'PLCInputBool',  initialValue: true });
      self.signal(OCCUPIED_SIGNAL,  { type: 'PLCOutputBool', initialValue: false });
      self.signal(RUNNING_SIGNAL,   { type: 'PLCOutputBool', initialValue: false });
      self.signal(PARTCOUNT_SIGNAL, { type: 'PLCOutputInt',  initialValue: 0 });

      // ─── Sensor edge → local discharge trigger + part count ──────────
      self.signals.on(s.sensorNode.name, (v) => onPartAtSensor(self, v === true));

      // ─── Operator context menu (right-click the belt node) ───────────
      self.contextMenu(s.beltNode, [
        { id: 'run',  label: 'Run',  action: () => self.signals.set(RUN_SIGNAL, true) },
        { id: 'stop', label: 'Stop', danger: true, dividerBefore: true,
          action: () => self.signals.set(RUN_SIGNAL, false) },
      ]);
    },

    fixedUpdate(self: MaterialFlowSelf, dt: number): void {
      const s = st(self);

      // Publish surface-based occupancy every tick: a good ANYWHERE on this belt
      // marks the zone occupied so the upstream neighbour won't push a second good
      // onto it (one good per zone). Read by the predecessor as its successor interlock.
      self.signals.set(OCCUPIED_SIGNAL, isSurfaceOccupied(s.rv.viewer, s.beltNode));

      // Periodically retry the drive lookup if it wasn't ready at bind time.
      // (Downstream interlock resolution is allocation-free + inline in
      // createDownstreamInterlock, evaluated fresh on each shouldFlow.)
      s.refreshTimer += dt;
      if (s.refreshTimer >= NEIGHBOR_REFRESH_SEC) s.refreshTimer = 0;

      const moving = shouldFlow(self);
      self.signals.set(RUNNING_SIGNAL, moving);
      s.belt.run(moving);               // belt speed = drive.currentSpeed; no-op until drive resolves
    },
  },

  // ── DES adapter — event-driven path (private DESRunner, P5) ──
  // The ZPA `logic.shouldFlow` is shared; only the EFFECT differs: stop the belt
  // (continuous) vs. blockedMUs + onDownstreamReady (des).
  des: {
    onAccept(self: MaterialFlowSelf, mu: MU): boolean {
      onPartAtSensor(self, true);
      return tryRelease(self, mu);
    },
    onArrival(self: MaterialFlowSelf, mu: MU): void {
      onPartAtSensor(self, true);
      tryRelease(self, mu);
    },
    onDownstreamReady(self: MaterialFlowSelf): void {
      const mu = st(self).blockedMUs.shift();
      if (mu) tryRelease(self, mu);
    },
  },
});

// ─── Default export: a Behavior so glob discovery (behaviors.ts) finds it ──
//
// A hand-written bind (rather than the generic `toBehavior` shim) so the
// continuous blocks get the bind context they need (rv.viewer for
// surface-occupancy, rv.behavior for the badge stamp) via per-instance state,
// while still driving the SAME `def.continuous.setup/fixedUpdate` methods that
// `defineMaterialFlow` registered for DES.
const ConveyorBehavior: Behavior = {
  models: def.models ?? ['*Conveyor*'],
  bind(rv: RVBindContext): void {
    const rootTag = rv.root.name || '<unnamed>';
    const beltNode = findTransport(rv.root);
    const sensorNode = findSensor(rv.root);
    if (!beltNode)   { console.warn(`[Conveyor:${rootTag}] no Transport-* node found — skipping bind`); return; }
    if (!sensorNode) { console.warn(`[Conveyor:${rootTag}] no Sensor / Sensor-* node found — skipping bind`); return; }

    // Drive lookup is DEFERRED to the fixed-update loop via `attachBelt`. Even
    // if the drive isn't registered at bind-time (load-order race, HMR replay,
    // or a late convention pass) we still proceed: the SIGNAL side of the
    // conveyor (Occupied publication for upstream back-pressure, PartCount,
    // sensor edge tracking, downstream interlock) is fully functional without a
    // drive reference. Belt control simply no-ops until the drive shows up.
    const belt = attachBelt(rv, beltNode);

    console.info(`[Conveyor:${rootTag}] attached — belt "${beltNode.name}", sensor "${sensorNode.name}"`);
    rv.behavior(rv.root, 'ConveyorBehavior', { Belt: beltNode.name, Sensor: sensorNode.name });

    const self = createSelf(rv, def, { mode: 'continuous' });
    _state.set(self, {
      rv,
      beltNode,
      sensorNode,
      belt,
      interlock: createDownstreamInterlock(rv),
      partAtSensor: false,
      partCount: 0,
      refreshTimer: NEIGHBOR_REFRESH_SEC,   // resolve on the first tick
      blockedMUs: [],
    });

    def.continuous.setup!(self);
    const fixed = def.continuous.fixedUpdate;
    if (fixed) rv.onFixedUpdate((dt: number) => fixed(self, dt));
    rv.onDispose(() => _state.delete(self));
  },
};

export default ConveyorBehavior;
