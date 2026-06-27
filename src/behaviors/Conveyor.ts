// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Conveyor — a zone-accumulation belt (one part per zone).
 *
 * The rule, in one sentence: the belt RUNS, unless a part is sitting at its exit
 * sensor AND the next zone downstream is still full — then it STOPS so parts queue
 * up instead of crashing together. (This is "ZPA" — Zoned Part Accumulation.)
 *
 * Like every material-flow component this ONE definition runs two ways:
 *   • Continuous — 60 Hz physics: the belt surface slides the part, the sensor
 *     fires on overlap, `continuous.fixedUpdate` jogs the belt.
 *   • DES — events: `des.onAccept` schedules the part's arrival after its transit
 *     time (length / speed) and the handshake hands it downstream.
 * The shared decision (`logic.shouldFlow`) is written once and used by both.
 *
 * How to read this file: SIGNALS (the PLC contract) → the `logic` functions (the
 * shared brain) → the `def` object (schema, signals, state, setup, continuous, des).
 *
 * Full authoring guide: doc-behavior-modelling.md
 */

import { defineLibraryComponent, createTransitTimer, type RV, type TransitTimer } from './_shared/behavior-kit';

// Public 4-signal material-flow contract — auto-declared (by createSelf) as
// `Flow.<key>` (signalNamespace: 'Flow') and exposed as typed `self.sig.<key>`
// accessors. The namespace is type-neutral (`Flow`, not `Conveyor`) because
// turntables and sinks publish/read the SAME interop signals to join the line.
const SIGNALS = {
  Run:       'PLCInputBool',
  Occupied:  'PLCOutputBool',
  Running:   'PLCOutputBool',
  PartCount: 'PLCOutputInt',
} as const;

// Local state slot (type-inferred from `state`). `belt`/`sensor` are resolved
// path-agnostically in setup() (the finders work on BOTH the continuous and DES
// paths) and stored here.
interface ConveyorLocal {
  belt: RV.Node | null;
  sensor: RV.Node | null;
  beltHandle: RV.BeltHandle | null;
  interlock: { occupied(): boolean } | null;
  partAtSensor: boolean;
  partCount: number;
  blockedMUs: RV.MU[];
  /** Resolved DES transit-timing model (speed/length/transitTime + entry/exit tween). */
  timer: TransitTimer | null;
  /** MUs currently in transit → their DES arrival event id (cancel-on-reset). */
  transitMUs: Map<number, number>;
}
type ConveyorSelf = RV.Self<ConveyorLocal, typeof SIGNALS>;

// ── ZPA rule (shared: continuous + DES) ──
// partAtSensor is the LOCAL discharge trigger — NOT the published surface-based Flow.Occupied.
function shouldFlow(self: ConveyorSelf): boolean {
  const l = self.local;
  // ZPA: run unless a part sits at the sensor AND the downstream zone is occupied.
  return self.sig.Run.get() && !(l.partAtSensor && (l.interlock?.occupied() ?? true));
}
function onPartAtSensor(self: ConveyorSelf, present: boolean): void {
  const l = self.local;
  if (present && !l.partAtSensor) self.sig.PartCount.set(++l.partCount);
  l.partAtSensor = present;
}
function tryRelease(self: ConveyorSelf, mu: RV.MU): boolean {
  // ZPA release: release only when the belt is running AND the downstream can
  // accept. Otherwise the part stays on the belt (parked in blockedMUs) and is
  // retried on onDownstreamReady / run-signal. The object handshake is the
  // authority and parks the MU when the downstream is full.
  const out = self.outputs()[0];
  if (self.sig.Run.get() && self.downstreamCanAccept(mu, out)) {
    self.transfer(mu, out); self.local.partAtSensor = false; return true;
  }
  self.local.blockedMUs.push(mu); return false;
}

const def = {
  type: 'Conveyor' as const,
  kind: 'conveyor' as const,
  description: 'Straight conveyor that transports parts along its length.',
  mcpDocs:
    'Straight transport conveyor. Material flows along its local +Z: input snap ' +
    'Snap-ZN-convroll (-Z end), output snap Snap-ZP-convroll (+Z end). Chain a run by ' +
    'snap-attaching the next conveyor to the previous output (Snap-ZP-convroll). For a 90° ' +
    'turn, insert a Turntable. Speed comes from the embedded Transport Drive (TargetSpeed); ' +
    'the central drive-speed override scales it.',
  models: ['*Conveyor*'],
  // No DES timing fields: the transit timing is derived from the real belt
  // geometry (length) and the Transport Drive's TargetSpeed (speed), so there is
  // nothing for the user to configure here. See _shared/transit-timing.ts.
  schema: {},

  // The material-flow interop signals — published under the type-neutral `Flow`
  // namespace (NOT `Conveyor.*`), auto-declared as `Flow.<key>` + typed self.sig.
  signalNamespace: 'Flow' as const,
  // Public 4-signal material-flow contract — auto-declared (by createSelf) as
  // `Flow.<key>` and exposed as typed `self.sig.<key>` accessors.
  signals: SIGNALS,

  // Per-instance state slot (type-inferred). Used by BOTH the continuous shim and
  // the DES model-load binding so a directly-created self gets its local fields.
  state: (): ConveyorLocal => ({
    belt: null, sensor: null, beltHandle: null, interlock: null,
    partAtSensor: false, partCount: 0, blockedMUs: [], timer: null, transitMUs: new Map(),
  }),

  logic: { shouldFlow, onPartAtSensor },

  // Mode-agnostic init (continuous AND DES): resolve nodes, set the Run=true
  // default, resolve the DES timing model, stamp the marker, build the context
  // menu. The signals are already declared (by createSelf, both paths); the
  // finders are path-agnostic, so this is the single resolve point for belt/sensor.
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

    // Run defaults TRUE (the belt runs unless told to stop) — the only signal
    // whose initial value differs from the type-default (createSelf declares
    // Run=false with the rest); override it here on both paths.
    self.sig.Run.set(true);
    // Stamp the inspector/hierarchy marker with the resolved nodes.
    self.stamp('ConveyorBehavior', { Belt: l.belt.name, Sensor: l.sensor.name });
    // Resolve the DES timing model once (speed from the Transport Drive, length
    // from the belt geometry, full-belt transit time + tween endpoints).
    // Mode-agnostic: harmless in continuous (the belt physics owns motion
    // there), authoritative for the DES transit schedule.
    l.timer = createTransitTimer(self, l.belt);
    self.contextMenu(l.belt, [
      { id: 'run',  label: 'Run',  action: () => self.sig.Run.set(true) },
      { id: 'stop', label: 'Stop', danger: true, dividerBefore: true,
        action: () => self.sig.Run.set(false) },
    ]);
  },

  // Lifecycle: clear the per-run flow state on reset (part-at-sensor flag, part
  // counter, blocked/transit bookkeeping) and zero the published outputs; the
  // belt drive itself is reset by RVDrive.reset(). `start` re-asserts Run so the
  // belt resumes after a reset.
  reset(self: ConveyorSelf): void {
    const l = self.local;
    l.partAtSensor = false;
    l.partCount = 0;
    l.blockedMUs.length = 0;
    l.transitMUs.clear();
    self.sig.PartCount.set(0);
    self.sig.Occupied.set(false);
    self.sig.Running.set(false);
  },
  start(self: ConveyorSelf): void {
    self.sig.Run.set(true);
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
      self.sig.Occupied.set(self.surfaceOccupied(l.belt!));
      const moving = shouldFlow(self);
      self.sig.Running.set(moving);
      l.beltHandle!.run(moving);
    },
  },

  des: {
    // Accept = enter transit. Schedule the arrival at the discharge point (the
    // belt exit) after the full-belt transit time of SIM time (NOT an immediate
    // release), and attach a straight entry→exit position tween. Capacity is
    // single-zone; the runner's canAccept already enforces MaxCapacity, so
    // returning true here accepts the MU into transit.
    onAccept(self: ConveyorSelf, mu: RV.MU): boolean {
      const l = self.local;
      l.transitMUs.set(mu.id, self.in(l.timer!.transitTime, 'Arrival', mu, l.timer!.tween(mu)));
      return true;
    },
    // Arrival at the discharge point (belt exit): mark the part present (the
    // local discharge trigger), then run the existing release handshake. A
    // downstream block parks the MU in blockedMUs (back-pressure).
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
const ConveyorBehavior = defineLibraryComponent(def);

/** The material-flow definition (schema + logic + continuous + des) — for DES tests / runner. */
export const ConveyorFlow = def;

export default ConveyorBehavior;
