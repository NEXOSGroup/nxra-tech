// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Turntable — a multi-port router (a rotating platform that re-routes parts).
 *
 * A part arrives on one side; the table ROTATES to line up with a free output, then
 * DISCHARGES. Because that's a sequence of steps, this component is a state machine
 * (FSM) with seven states:
 *   idle → aligning_in → receiving → holding → rotating_out → discharging
 *        → discharge_clearing → idle
 *
 * One definition, two simulations (see doc-behavior-modelling.md):
 *   • Continuous — `continuous.fixedUpdate` is the FSM driver: it polls the real
 *     drive (`isAtTarget`) to detect a finished rotation and switches on the state.
 *   • DES — `des.onAccept`/`onRotateComplete` are the same router as events: a
 *     rotation just consumes TIME (|Δangle| / RotationSpeed), no physical drive.
 *
 * How to read this file: CONFIG + SIGNALS → the small FSM helpers (setBelt,
 * openInputPort, publishOccupied, …) → the `logic` transitions (tryReceive /
 * tryDispatch / onRotationDone) → the `def` (setup, continuous, des).
 *
 * Note `signalNamespace: 'Flow'`: a turntable joins a material-flow line, so it
 * speaks the same type-neutral `Flow.*` interop signal names as its belt
 * neighbours.
 *
 * Full authoring guide: doc-behavior-modelling.md
 */

import { Vector3, Quaternion } from 'three';
import type { Object3D } from 'three';
import { defineLibraryComponent, type RV } from './_shared/behavior-kit';
import { classifyConnections, listOwnSnaps, type PortConnection } from './_shared/snap-graph-helpers';
import { alignToInputAngle, dispatchToOutputAngle, calibrateBeltNeutralAngle } from './_shared/turntable-angle-math';

// Turntable publishes the type-neutral material-flow interop signals `Flow.*`
// (NOT `Turntable.*`). `signalNamespace: 'Flow'` scopes the signals block to the
// shared interop namespace, so `self.sig.Run/Occupied/Running/PartCount`
// read/write `Flow.<key>`.
const SIGNALS = {
  Run:       'PLCInputBool',
  Occupied:  'PLCOutputBool',
  Running:   'PLCOutputBool',
  PartCount: 'PLCOutputInt',
} as const;

const OCCUPIED_SIGNAL = 'Flow.Occupied';
const CONFIG = {
  neighborRefreshSec: 0.5,
  dischargeClearSec: 0.5,
  emptyResetSec: 0.75,
} as const;

type State =
  | 'idle'
  | 'aligning_in'
  | 'receiving'
  | 'holding'
  | 'rotating_out'
  | 'discharge_clearing'
  | 'discharging';

interface TurntableLocal {
  rotaryNode: Object3D | null;
  sensorNode: Object3D | null;
  beltNode: Object3D | null;
  drive: RV.DriveHandle | null;
  belt: RV.BeltHandle | null;
  driveAxis: Vector3;

  sensorOccupied: boolean;
  partCount: number;
  lastCommandedAngle: number;
  clearTimer: number;
  connections: PortConnection[];
  selectedInputPort: string | null;
  beltNeutralAngle: number;
  beltCalibrated: boolean;
  refreshTimer: number;
  emptyFor: number;

  _dir: Vector3;
  _quat: Quaternion;
}

type TurntableSelf = RV.Self<TurntableLocal, typeof SIGNALS>;

function portOccupiedSignal(portId: string): string {
  return `${OCCUPIED_SIGNAL}@${portId}`;
}

function axisFromDriveNodeName(name: string): Vector3 {
  const m = /Drive-Rot-([XYZ])$/.exec(name);
  if (!m) return new Vector3(0, 1, 0);
  return m[1] === 'X' ? new Vector3(1, 0, 0)
       : m[1] === 'Y' ? new Vector3(0, 1, 0)
       :                new Vector3(0, 0, 1);
}

interface ComponentRegistryShape {
  findInChildren<T = unknown>(node: Object3D, type: string): T | null;
}
interface TransportSurfaceLike {
  getWorldDirection(out?: Vector3): Vector3;
}

const setBelt = (l: TurntableLocal, forward: boolean): void => {
  if (l.belt) l.belt.run(forward);
};
const blockAllInputs = (self: TurntableSelf): void => {
  for (const c of self.local.connections) self.signals.set(portOccupiedSignal(c.snap.id), true);
};
const openInputPort = (self: TurntableSelf, openId: string | null): void => {
  for (const c of self.local.connections) self.signals.set(portOccupiedSignal(c.snap.id), c.snap.id !== openId);
};

const surfaceOccupied = (self: TurntableSelf): boolean =>
  self.local.beltNode ? self.surfaceOccupied(self.local.beltNode) : self.local.sensorOccupied;

const publishOccupied = (self: TurntableSelf, surf = surfaceOccupied(self)): void => {
  self.sig.Occupied.set(surf || self.state !== 'idle');
};
const publishRunning = (self: TurntableSelf): void => {
  self.sig.Running.set(self.state !== 'idle');
};

const componentRegistry = (self: TurntableSelf): ComponentRegistryShape | null => {
  const r = (self.viewer as { registry?: unknown }).registry as Partial<ComponentRegistryShape> | undefined | null;
  return r && typeof r.findInChildren === 'function' ? (r as ComponentRegistryShape) : null;
};

const calibrateBelt = (self: TurntableSelf): void => {
  const l = self.local;
  if (l.beltCalibrated || !l.beltNode) return;
  const reg = componentRegistry(self);
  if (!reg) return;
  const surface = reg.findInChildren<TransportSurfaceLike>(l.beltNode, 'TransportSurface');
  if (!surface) return;
  surface.getWorldDirection(l._dir);
  self.root.getWorldQuaternion(l._quat).invert();
  l._dir.applyQuaternion(l._quat);
  l.beltNeutralAngle = calibrateBeltNeutralAngle(l.driveAxis, l._dir, l.lastCommandedAngle);
  l.beltCalibrated = true;
};

const refreshTopology = (self: TurntableSelf): void => {
  const l = self.local;
  l.connections = classifyConnections(self.viewer as { getPlugin?(id: string): unknown }, self.root);
  calibrateBelt(self);
  if (self.state === 'receiving') openInputPort(self, l.selectedInputPort);
  else blockAllInputs(self);
};

const inputs = (l: TurntableLocal): PortConnection[] => l.connections.filter(c => c.role === 'input');
const outputs = (l: TurntableLocal): PortConnection[] => l.connections.filter(c => c.role === 'output');

// Deliberate root-only free-output read, kept for parity (NOT the per-port linkOf().occupied() lookup).
const freeOutputs = (self: TurntableSelf): PortConnection[] => {
  const out: PortConnection[] = [];
  for (const c of outputs(self.local)) {
    const sigName = `/${c.ownerRoot.name}/${OCCUPIED_SIGNAL}`;
    if (self.signals.get(sigName) === true) continue;
    out.push(c);
  }
  return out;
};

const platformHasPart = (self: TurntableSelf, surf = surfaceOccupied(self)): boolean =>
  surf || self.local.sensorOccupied;

function enter(self: TurntableSelf, next: State): void {
  self.setState(next);
  publishOccupied(self);
  publishRunning(self);
}

function tryReceive(self: TurntableSelf): void {
  const l = self.local;
  if (self.state !== 'idle') return;
  if (!self.sig.Run.get()) return;

  const ready = inputs(l).filter(c =>
    self.signals.get(`/${c.ownerRoot.name}/${OCCUPIED_SIGNAL}`) === true);
  if (ready.length === 0) return;
  const waiting = ready[Math.floor(Math.random() * ready.length)];

  l.selectedInputPort = waiting.snap.id;
  const target = alignToInputAngle(l.driveAxis, l.beltNeutralAngle, waiting.snap.object3D, l.lastCommandedAngle);
  setBelt(l, false);
  l.drive!.moveTo(target);
  l.lastCommandedAngle = target;
  enter(self, 'aligning_in');
}

function tryDispatch(self: TurntableSelf): void {
  const l = self.local;
  if (!self.sig.Run.get()) { setBelt(l, false); enter(self, 'holding'); return; }
  const candidates = freeOutputs(self);
  if (candidates.length === 0) { setBelt(l, false); enter(self, 'holding'); return; }

  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  const target = dispatchToOutputAngle(l.driveAxis, l.beltNeutralAngle, chosen.snap.object3D, l.lastCommandedAngle);
  setBelt(l, false);
  l.drive!.moveTo(target);
  l.lastCommandedAngle = target;
  enter(self, 'rotating_out');
}

function onPartAtCenter(self: TurntableSelf): void {
  blockAllInputs(self);
  self.local.selectedInputPort = null;
  tryDispatch(self);
}

function onRotationDone(self: TurntableSelf): void {
  const l = self.local;
  if (self.state === 'aligning_in') {
    enter(self, 'receiving');
    openInputPort(self, l.selectedInputPort);
    setBelt(l, true);
  } else if (self.state === 'rotating_out') {
    setBelt(l, true);
    enter(self, 'discharging');
  }
}

function finishCycle(self: TurntableSelf): void {
  setBelt(self.local, false);
  enter(self, 'idle');
}

function abortToIdle(self: TurntableSelf): void {
  const l = self.local;
  l.drive!.stop();
  setBelt(l, false);
  blockAllInputs(self);
  l.selectedInputPort = null;
  l.emptyFor = 0;
  enter(self, 'idle');
}

// ── DES router timing (Plan 194 §2.4) ─────────────────────────────────────
//
// The DES adapter has NO physical drive — it only consumes TIME. A rotation to
// an angle takes |Δang|/RotationSpeed seconds, scheduled as a `RotateComplete`
// event; `prop['driveTarget']` is the coupling point the Tween-Registry uses to
// animate the real drive 1:1 in Animated/HybridSynced (so the optics match).

const DES_DEFAULT_ROTATION_SPEED = 45; // deg/s

function rotationSpeed(self: TurntableSelf): number {
  const v = self.prop['RotationSpeed'];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : DES_DEFAULT_ROTATION_SPEED;
}

function maxCapacity(self: TurntableSelf): number {
  const v = self.prop['MaxCapacity'];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/**
 * DES rotate: command a logical rotation to `targetAngle` and schedule the
 * `RotateComplete` after `|Δang|/RotationSpeed` seconds (NO physical drive).
 * Records the new commanded angle and the tween coupling target.
 */
function desRotateTo(self: TurntableSelf, targetAngle: number, next: State, mu: RV.MU | null): void {
  const l = self.local;
  const dt = Math.abs(targetAngle - l.lastCommandedAngle) / rotationSpeed(self);
  l.lastCommandedAngle = targetAngle;
  self.prop['driveTarget'] = targetAngle; // Tween/Animated drives the real rotation 1:1.
  enter(self, next);
  self.in(Math.max(0.001, dt), 'RotateComplete', mu);
}

/** Pick a free output port for the DES router (first not-occupied output). */
function desSelectOutput(self: TurntableSelf): RV.Port | null {
  const free = self.freeOutputs();
  return free.length > 0 ? free[0] : null;
}

const def = {
  type: 'Turntable' as const,
  kind: 'router' as const,
  models: ['*Turntable*'],
  // DES router params (Plan 194 §2.4). RotationSpeed drives the rotate-time
  // schedule (|Δang|/RotationSpeed); MaxCapacity gates acceptance.
  schema: {
    RotationSpeed: { type: 'number' as const, default: 45 }, // deg/s
    MaxCapacity:   { type: 'number' as const, default: 1 },
  },

  // The material-flow interop signals — published under the type-neutral `Flow`
  // namespace (NOT `Turntable.*`), auto-declared as `Flow.<key>` + typed self.sig.
  signalNamespace: 'Flow' as const,
  signals: SIGNALS,

  // Per-instance state slot (type-inferred). Used by BOTH the continuous shim and
  // the DES model-load binding so a directly-created self gets its local fields.
  state: (): TurntableLocal => ({
    rotaryNode: null,
    sensorNode: null,
    beltNode: null,
    drive: null,
    belt: null,
    driveAxis: new Vector3(0, 1, 0),

    sensorOccupied: false,
    partCount: 0,
    lastCommandedAngle: 0,
    clearTimer: 0,
    connections: [],
    selectedInputPort: null,
    beltNeutralAngle: 0,
    beltCalibrated: false,
    refreshTimer: CONFIG.neighborRefreshSec,
    emptyFor: 0,

    _dir: new Vector3(),
    _quat: new Quaternion(),
  }),

  logic: { enter, tryReceive, tryDispatch, onPartAtCenter, onRotationDone, finishCycle, abortToIdle },

  // Mode-agnostic init (continuous AND DES): resolve nodes into self.local,
  // declare signals (the rotary drive + sensor are HARD-required; the belt is
  // OPTIONAL), build the Reset context menu.
  setup(self: TurntableSelf): void {
    const l = self.local;
    const rootTag = self.root.name || '<unnamed>';
    const rotaryNode = self.findRotaryDrive();
    const sensorNode = self.findSensor();
    const beltNode = self.findTransport();
    if (!rotaryNode) return self.disable('no Drive-Rot-* node');
    if (!sensorNode) return self.disable('no Sensor node');
    if (!beltNode)   console.warn(`[Turntable:${rootTag}] no Transport-* node found — belt stop/start will be a no-op`);

    l.rotaryNode = rotaryNode;
    l.sensorNode = sensorNode;
    l.beltNode = beltNode;
    l.driveAxis = axisFromDriveNodeName(rotaryNode.name);

    // Run defaults TRUE — the only signal whose initial value differs from the
    // type-default. createSelf already declared the Conveyor.* contract (both
    // paths, Bool→false); override Run here.
    self.sig.Run.set(true);
    // Stamp the inspector/hierarchy marker with the resolved nodes (the factory
    // also stamps TurntableBehavior with the schema defaults — these deep-merge).
    self.stamp('TurntableBehavior', {
      Drive: rotaryNode.name,
      Sensor: sensorNode.name,
      ...(beltNode ? { Belt: beltNode.name } : {}),
    });

    // Mode-agnostic shared-state init (B2): ALL self.prop fields both adapters
    // read MUST be initialised here so the DES path (which never runs
    // continuous.setup) has a defined alignedPort/selectedOutput/driveTarget and
    // a clean state after Reset-on-Switch / DESRunner.start().
    self.prop['alignedPort'] = null;
    self.prop['selectedOutput'] = null;
    self.prop['heldMU'] = null;
    self.prop['driveTarget'] = l.lastCommandedAngle;
    self.setState('idle');

    self.contextMenu(rotaryNode, [
      {
        id: 'reset', label: 'Reset',
        action: () => {
          l.drive!.stop();
          setBelt(l, false);
          blockAllInputs(self);
          l.selectedInputPort = null;
          enter(self, 'idle');
        },
      },
    ]);
  },

  continuous: {
    // Continuous-only wiring — reads the self.local nodes resolved by the shared
    // setup() above: drive/belt handles, belt-neutral calibration, topology +
    // per-port interlock state, and the AABB-sensor subscription.
    setup(self: TurntableSelf): void {
      const l = self.local;
      l.drive = self.attachDrive(l.rotaryNode!);
      l.belt = l.beltNode ? self.attachBelt(l.beltNode) : null;

      self.prop['alignedPort'] = null;
      self.prop['selectedOutput'] = null;

      for (const sp of listOwnSnaps(self.viewer as { getPlugin?(id: string): unknown }, self.root)) {
        self.signals.set(portOccupiedSignal(sp.id), true);
      }

      l.connections = classifyConnections(self.viewer as { getPlugin?(id: string): unknown }, self.root);
      calibrateBelt(self);

      self.signals.on(l.sensorNode!.name, (v) => {
        const present = v === true;
        if (present && !l.sensorOccupied) {
          l.partCount += 1;
          self.sig.PartCount.set(l.partCount);
        }
        l.sensorOccupied = present;
        publishOccupied(self);

        if (present) {
          if (self.state === 'receiving') onPartAtCenter(self);
        } else if (self.state === 'discharging') {
          l.clearTimer = CONFIG.dischargeClearSec;
          enter(self, 'discharge_clearing');
        }
      });
    },

    fixedUpdate(self: TurntableSelf, dt: number): void {
      const l = self.local;
      if (!l.rotaryNode) return;

      const surf = surfaceOccupied(self);
      publishOccupied(self, surf);

      l.refreshTimer += dt;
      if (l.refreshTimer >= CONFIG.neighborRefreshSec) {
        l.refreshTimer = 0;
        refreshTopology(self);
        if (self.state === 'idle') tryReceive(self);
        else if (self.state === 'holding' && l.sensorOccupied) tryDispatch(self);
      }

      if (self.state !== 'idle' && self.state !== 'aligning_in') {
        if (!platformHasPart(self, surf)) {
          l.emptyFor += dt;
          if (l.emptyFor >= CONFIG.emptyResetSec) abortToIdle(self);
        } else {
          l.emptyFor = 0;
        }
      } else {
        l.emptyFor = 0;
      }

      switch (self.state as State) {
        case 'idle':
          setBelt(l, false);
          break;
        case 'aligning_in':
          if (l.drive!.isAtTarget()) onRotationDone(self);
          break;
        case 'receiving':
          setBelt(l, true);
          break;
        case 'holding':
          setBelt(l, false);
          break;
        case 'rotating_out':
          if (l.drive!.isAtTarget()) onRotationDone(self);
          break;
        case 'discharging':
          break;
        case 'discharge_clearing':
          setBelt(l, true);
          l.clearTimer -= dt;
          if (l.clearTimer <= 0) finishCycle(self);
          break;
      }
    },
  },

  des: {
    // Accept only at the currently aligned input port (when a port is supplied)
    // AND below capacity. The base handshake passes `port === undefined`, in
    // which case capacity alone gates acceptance — an idle table receives the
    // part, then aligns to the chosen OUTPUT during onAccept (B2: alignedPort is
    // initialised to null in setup(), the table is idle so it accepts).
    canAccept(self: TurntableSelf, _mu: RV.MU, port?: RV.Port): boolean {
      if (self.currentLoad >= maxCapacity(self)) return false;
      if (self.state !== 'idle' && self.state !== 'receiving') return false;
      if (port && self.prop['alignedPort'] != null && port.id !== self.prop['alignedPort']) {
        return false;
      }
      return true;
    },
    // The part is on the platform. Pick a free output, rotate to it (time-based),
    // and schedule RotateComplete. With no free output, HOLD the MU (parked on
    // self.prop['heldMU']) until onDownstreamReady retries.
    onAccept(self: TurntableSelf, mu: RV.MU, port?: RV.Port): boolean {
      self.prop['alignedPort'] = port?.id ?? null;
      const out = desSelectOutput(self);
      if (!out) {
        // No free output — hold the part on the platform (Plan 194 §2.4 HOLD).
        self.prop['heldMU'] = mu.id;
        enter(self, 'holding');
        return true;
      }
      self.prop['selectedOutput'] = out.id;
      const target = dispatchToOutputAngle(self.local.driveAxis, self.local.beltNeutralAngle, out.ownerRoot, self.local.lastCommandedAngle);
      desRotateTo(self, target, 'rotating_out', mu);
      return true;
    },
    // Rotation to the chosen output is done — discharge: transfer the MU to the
    // selected output port (the native handshake blocks if the output is full).
    onRotateComplete(self: TurntableSelf, mu: RV.MU): void {
      const outId = self.prop['selectedOutput'] as string | null;
      const out = outId != null ? self.outputs().find(p => p.id === outId) : undefined;
      enter(self, 'discharging');
      self.transfer(mu, out);
      self.prop['selectedOutput'] = null;
      self.prop['heldMU'] = null;
      enter(self, 'idle');
    },
    // A chosen output freed — if a part is held (no output was free at accept
    // time), retry the dispatch now.
    onDownstreamReady(self: TurntableSelf, _from: unknown): void {
      if (self.state !== 'holding') return;
      const heldId = self.prop['heldMU'] as number | null;
      if (heldId == null) return;
      const out = desSelectOutput(self);
      if (!out) return; // still blocked — wait for the next ready signal
      const held = self.mus.find(m => m.id === heldId) ?? null;
      self.prop['selectedOutput'] = out.id;
      const target = dispatchToOutputAngle(self.local.driveAxis, self.local.beltNeutralAngle, out.ownerRoot, self.local.lastCommandedAngle);
      desRotateTo(self, target, 'rotating_out', held);
    },
  },
};

/** Turntable — multi-port router (factory-built; behaviour identical to the def). */
const TurntableBehavior = defineLibraryComponent(def);

/** The material-flow definition (schema + logic + continuous + des) — for DES tests / runner. */
export const TurntableFlow = def;

export default TurntableBehavior;
