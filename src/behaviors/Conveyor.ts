// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Conveyor — zone-accumulation conveyor for a snapped line of belts.
 *
 * Discovers its belt (`Transport-*`) and sensor (`Sensor` / `Sensor-*`) by the
 * naming convention. MUs already flow belt → belt automatically (the transport
 * manager hands an MU to whichever adjacent surface overlaps it), so this
 * behavior's job is ACCUMULATION control — standard single-sensor ZPA
 * (zero-pressure accumulation):
 *
 *   The belt runs while `Conveyor.Run` is true, EXCEPT it stops when a part sits at
 *   its sensor AND the downstream zone is occupied — so parts queue at the junction
 *   instead of colliding. When downstream clears, the belt releases the part and
 *   back-pressure ripples upstream.
 *
 * Topology: the downstream neighbour is the conveyor paired to this conveyor's
 * OUTPUT snap (`Snap-*P-*`, flow = 'out') in the snap-point graph. Each conveyor
 * publishes `Conveyor.Occupied` (its sensor state) as the interlock its upstream
 * neighbour reads. Per-instance signal scoping keeps every placement's signals
 * independent; the upstream reads the downstream's scoped `Conveyor.Occupied` via
 * the global (`/`-prefixed) signal escape (see rv-instance-scope).
 *
 * Signals (scoped per placed instance):
 *   Conveyor.Run        PLCInputBool   master enable (default on)
 *   Conveyor.Occupied   PLCOutputBool  a part is at this conveyor's sensor (interlock)
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

import { defineBehavior } from '../core/behaviors';
import { findTransport, findSensor } from '../core/library-component-loader';
import { registerCapabilities } from '../core/engine/rv-component-registry';
import { findDownstreamRoot as findFirstDownstreamRoot, findOutputPairings } from './_shared/snap-graph-helpers';
import type { Object3D } from 'three';

// Hierarchy/inspector badge marker (pure marker — no factory).
registerCapabilities('ConveyorBehavior', {
  badgeColor: '#7e57c2',
  filterLabel: 'Behavior',
  hierarchyVisible: true,
  inspectorVisible: true,
});

// ─── Public properties (per-instance configurable) ──────────────────────
const CONFIG = {
  runSignal:       'Conveyor.Run',        // PLCInputBool  — master enable
  occupiedSignal:  'Conveyor.Occupied',   // PLCOutputBool — part at sensor (upstream interlock)
  runningSignal:   'Conveyor.Running',    // PLCOutputBool — belt actually moving
  partCountSignal: 'Conveyor.PartCount',  // PLCOutputInt  — parts that passed the sensor
  neighborRefreshSec: 0.5,                // re-resolve the downstream neighbour at this rate
} as const;

/**
 * Standard single-sensor ZPA release rule: run unless a part is held at this
 * conveyor's sensor AND the downstream zone is occupied (so it can't accept).
 */
export function conveyorShouldRun(run: boolean, occupied: boolean, downstreamOccupied: boolean): boolean {
  return run && !(occupied && downstreamOccupied);
}

/**
 * Downstream conveyor root via the snap-point graph: this conveyor's first
 * OUTPUT snap (`flow === 'out'`) → its paired partner → owner. Null if no
 * paired out-flow snap exists. Thin re-export from `snap-graph-helpers` so the
 * single-downstream contract used by Conveyor stays at the call site.
 */
export function findDownstreamRoot(host: { getPlugin?(id: string): unknown }, root: Object3D): Object3D | null {
  return findFirstDownstreamRoot(host, root);
}

export default defineBehavior({
  // Any GLB whose filename contains "Conveyor" (case-sensitive): Conveyor,
  // RollConveyor2m, ChainConveyor3m, … One belt + one sensor per asset.
  models: ['*Conveyor*'],

  bind(rv) {
    const rootTag = rv.root.name || '<unnamed>';
    const beltNode = findTransport(rv.root);
    const sensorNode = findSensor(rv.root);
    if (!beltNode)   { console.warn(`[Conveyor:${rootTag}] no Transport-* node found — skipping bind`); return; }
    if (!sensorNode) { console.warn(`[Conveyor:${rootTag}] no Sensor / Sensor-* node found — skipping bind`); return; }

    // Drive lookup is DEFERRED to the fixed-update loop. Even if the drive
    // isn't in `host.drives` at bind-time (load-order race, HMR replay, or a
    // late convention pass), we still proceed: the SIGNAL side of the
    // conveyor (Occupied publication for upstream back-pressure, PartCount,
    // sensor edge tracking, downstream interlock) is fully functional
    // without a drive reference. Belt control simply turns into a no-op
    // until the drive shows up. The previous early-return left the LAST
    // conveyor in a state where nothing published its Occupied signal, so
    // its upstream couldn't see the back-pressure and the line didn't stop.
    let belt = rv.drives.get(beltNode);
    if (!belt) console.warn(`[Conveyor:${rootTag}] belt "${beltNode.name}" has no Drive YET — will retry on each fixed-update`);

    console.info(`[Conveyor:${rootTag}] attached — belt "${beltNode.name}"${belt ? '' : ' (drive deferred)'}, sensor "${sensorNode.name}"`);
    rv.behavior(rv.root, 'ConveyorBehavior', { Belt: beltNode.name, Sensor: sensorNode.name });

    // ─── Signals (scoped per instance) ───────────────────────────────
    rv.signal(CONFIG.runSignal,       { type: 'PLCInputBool',  initialValue: true });
    rv.signal(CONFIG.occupiedSignal,  { type: 'PLCOutputBool', initialValue: false });
    rv.signal(CONFIG.runningSignal,   { type: 'PLCOutputBool', initialValue: false });
    rv.signal(CONFIG.partCountSignal, { type: 'PLCOutputInt',  initialValue: 0 });

    // ─── State ───────────────────────────────────────────────────────
    let occupied = false;
    let partCount = 0;
    // Downstream interlock — resolved lazily because the line topology changes as
    // conveyors are snapped on after this one was placed. Stored as an absolute,
    // `/`-prefixed signal name read via the global escape.
    let downstreamOccupiedSignal: string | null = null;
    let refreshTimer: number = CONFIG.neighborRefreshSec;   // resolve on the first tick

    rv.signals.on(sensorNode.name, (v) => {
      const present = v === true;
      if (present && !occupied) {                   // rising edge → a part arrived
        partCount += 1;
        rv.signals.set(CONFIG.partCountSignal, partCount);
      }
      occupied = present;
      rv.signals.set(CONFIG.occupiedSignal, present);
    });

    rv.onFixedUpdate((dt) => {
      // Periodically (re)resolve the downstream neighbour's Occupied interlock
      // AND retry the drive lookup if it wasn't ready at bind time.
      refreshTimer += dt;
      if (refreshTimer >= CONFIG.neighborRefreshSec) {
        refreshTimer = 0;
        // Resolve the downstream interlock. Prefer the downstream's PER-PORT
        // occupied signal for the exact snap we mate to (a turntable publishes
        // one per input port); fall back to its root `Conveyor.Occupied` for
        // plain conveyor→conveyor lines that only publish the root signal.
        const pairing = findOutputPairings(rv.viewer, rv.root)[0] ?? null;
        if (!pairing) {
          downstreamOccupiedSignal = null;
        } else {
          const root = `/${pairing.ownerRoot.name}/${CONFIG.occupiedSignal}`;
          // Per-port signal is keyed by the downstream snap's STABLE id (the
          // exact port we mate to); a turntable publishes one per input port.
          const perPort = `${root}@${pairing.pairedSnap.id}`;
          downstreamOccupiedSignal = rv.signals.get(perPort) !== undefined ? perPort : root;
        }
        if (!belt) {
          belt = rv.drives.get(beltNode);
          if (belt) console.info(`[Conveyor:${rootTag}] drive "${beltNode.name}" resolved on retry — belt control online`);
        }
      }

      const run = rv.signals.get<boolean>(CONFIG.runSignal) === true;
      // Two distinct cases for the downstream interlock:
      //   1. NO successor at all → blocked. End-of-line accumulation: hold
      //      the part at the sensor instead of pushing it into nothing.
      //   2. Successor exists → only an EXPLICIT `true` blocks. `false` /
      //      `undefined` → release. Parts physically flow into a successor
      //      either way; pessimistic locking on an unknown state would stall
      //      the whole line whenever one neighbour fails to bind.
      const downstreamOccupied = downstreamOccupiedSignal === null
        ? true
        : rv.signals.get<boolean>(downstreamOccupiedSignal) === true;
      const moving = conveyorShouldRun(run, occupied, downstreamOccupied);
      rv.signals.set(CONFIG.runningSignal, moving);
      if (belt) {
        belt.jogForward = moving;                    // belt speed = drive.currentSpeed
        belt.jogBackward = false;
      }
    });

    // ─── Operator context menu (right-click the belt node) ────────────
    rv.contextMenu(beltNode, [
      { id: 'run',  label: 'Run',  action: () => rv.signals.set(CONFIG.runSignal, true) },
      { id: 'stop', label: 'Stop', danger: true, dividerBefore: true,
        action: () => rv.signals.set(CONFIG.runSignal, false) },
    ]);
  },
});
