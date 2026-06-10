// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Conveyor — zone-accumulation conveyor. Authoring model: doc-behavior-modelling.md */

import { defineLibraryComponent, createTransitTimer, type RV, type TransitTimer } from './_shared/behavior-kit';

const RUN = 'Conveyor.Run', OCCUPIED = 'Conveyor.Occupied', RUNNING = 'Conveyor.Running', PARTCOUNT = 'Conveyor.PartCount';

interface ConveyorLocal {
  belt: RV.Node | null;
  sensor: RV.Node | null;
  beltHandle: RV.BeltHandle | null;
  interlock: { occupied(): boolean } | null;
  partAtSensor: boolean;
  partCount: number;
  blockedMUs: RV.MU[];
  /** Resolved DES transit-timing model (speed/length/timeToSensor + entry/exit tween). */
  timer: TransitTimer | null;
  /** MUs currently in transit → their DES arrival event id (cancel-on-reset). */
  transitMUs: Map<number, number>;
}
type ConveyorSelf = RV.Self<ConveyorLocal>;

// ── ZPA rule (shared: continuous + DES) ──
// partAtSensor is the LOCAL discharge trigger — NOT the published surface-based Conveyor.Occupied.
function shouldFlow(self: ConveyorSelf): boolean {
  const l = self.local;
  // ZPA: run unless a part sits at the sensor AND the downstream zone is occupied.
  return self.signals.get<boolean>(RUN) === true && !(l.partAtSensor && (l.interlock?.occupied() ?? true));
}
function onPartAtSensor(self: ConveyorSelf, present: boolean): void {
  const l = self.local;
  if (present && !l.partAtSensor) self.signals.set(PARTCOUNT, ++l.partCount);
  l.partAtSensor = present;
}
function tryRelease(self: ConveyorSelf, mu: RV.MU): boolean {
  // ZPA release: release only when the belt is running AND the downstream can
  // accept. Otherwise the part stays on the belt (parked in blockedMUs) and is
  // retried on onDownstreamReady / run-signal. The object handshake is the
  // authority and parks the MU when the downstream is full.
  const out = self.outputs()[0];
  if (self.signals.get<boolean>(RUN) === true && self.downstreamCanAccept(mu, out)) {
    self.transfer(mu, out); self.local.partAtSensor = false; return true;
  }
  self.local.blockedMUs.push(mu); return false;
}

const def = {
  type: 'Conveyor' as const,
  kind: 'conveyor' as const,
  models: ['*Conveyor*'],
  // DES timing params (Plan 194 §2.5 / F12). Mirror the C#-DES `DESConveyor`
  // schema; read from rv_extras via the binding wiring into self.prop.
  schema: {
    ConveyorLength:      { type: 'number' as const, default: 1000 }, // mm
    ConveyorSpeed:       { type: 'number' as const, default: 200 },  // mm/s
    CalculatedArcLength: { type: 'number' as const, default: 0 },    // mm (curves; overrides length)
  },

  // Per-instance state slot — used by BOTH the continuous shim and the DES
  // model-load binding so a directly-created self gets its local fields.
  local: (): ConveyorLocal => ({
    belt: null, sensor: null, beltHandle: null, interlock: null,
    partAtSensor: false, partCount: 0, blockedMUs: [], timer: null, transitMUs: new Map(),
  }),

  logic: { shouldFlow, onPartAtSensor },

  // Mode-agnostic init (continuous AND DES): resolve nodes, declare signals,
  // resolve the DES timing model, build the context menu.
  setup(self: ConveyorSelf): void {
    const l = self.local;
    l.belt = self.findTransport();
    l.sensor = self.findSensor();
    if (!l.belt || !l.sensor) return self.disable('missing Transport-*/Sensor-* node');

    // Reset transient DES flow state — setup() re-runs on Reset-on-Switch /
    // DESRunner.start(), so clear any leftover transit/blocked bookkeeping.
    l.partAtSensor = false;
    l.blockedMUs.length = 0;
    l.transitMUs.clear();

    self.declareConveyorSignals();
    // Resolve the DES timing model once (speed/length/timeToSensor + tween
    // endpoints). Mode-agnostic: harmless in continuous (the belt physics owns
    // motion there), authoritative for the DES transit schedule.
    l.timer = createTransitTimer(self, l.belt, l.sensor);
    self.contextMenu(l.belt, [
      { id: 'run',  label: 'Run',  action: () => self.signals.set(RUN, true) },
      { id: 'stop', label: 'Stop', danger: true, dividerBefore: true,
        action: () => self.signals.set(RUN, false) },
    ]);
  },

  continuous: {
    // Continuous-only wiring — reads the self.local nodes resolved by the shared
    // setup() above: belt handle, the downstream interlock, and the AABB-sensor
    // subscription are the continuous trigger/effect plumbing.
    setup(self: ConveyorSelf): void {
      const l = self.local;
      l.beltHandle = self.attachBelt(l.belt!);
      l.interlock = self.downstreamInterlock();
      self.signals.on(l.sensor!.name, (v) => onPartAtSensor(self, v === true));
    },
    fixedUpdate(self: ConveyorSelf): void {
      const l = self.local;
      self.signals.set(OCCUPIED, self.surfaceOccupied(l.belt!));
      const moving = shouldFlow(self);
      self.signals.set(RUNNING, moving);
      l.beltHandle!.run(moving);
    },
  },

  des: {
    // Accept = enter transit. Schedule the arrival at the sensor/discharge point
    // after `timeToSensor` of SIM time (NOT an immediate release), and attach a
    // straight entry→exit position tween (Plan 194 §2.5 / §3.1). Capacity is
    // single-zone like the C#-DES `DESConveyor`; the runner's canAccept already
    // enforces MaxCapacity, so returning true here accepts the MU into transit.
    onAccept(self: ConveyorSelf, mu: RV.MU): boolean {
      const l = self.local;
      l.transitMUs.set(mu.id, self.in(l.timer!.timeToSensor, 'Arrival', mu, l.timer!.tween(mu)));
      return true;
    },
    // Arrival at the sensor/discharge point: mark the part present (the local
    // discharge trigger), then run the existing release handshake. A downstream
    // block parks the MU in blockedMUs (Plan 194 §2.5 back-pressure).
    onArrival(self: ConveyorSelf, mu: RV.MU): void {
      self.local.transitMUs.delete(mu.id);
      onPartAtSensor(self, true);
      tryRelease(self, mu);
    },
    onDownstreamReady(self: ConveyorSelf): void {
      const mu = self.local.blockedMUs.shift();
      if (mu) tryRelease(self, mu);
    },
  },
};

/** Conveyor — zone-accumulation conveyor (factory-built; behaviour identical to the def). */
const ConveyorBehavior = defineLibraryComponent<ConveyorLocal>(def, {
  capabilities: { badgeColor: '#7e57c2', filterLabel: 'Behavior', hierarchyVisible: true, inspectorVisible: true },
  badge: (self) => ({ Belt: self.local.belt!.name, Sensor: self.local.sensor!.name }),
});

/** The material-flow definition (schema + logic + continuous + des) — for DES tests / runner. */
export const ConveyorFlow = def;

export default ConveyorBehavior;
