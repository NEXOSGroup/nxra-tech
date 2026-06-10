// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Turntable — multi-port router. Authoring model: doc-behavior-modelling.md */

import { Vector3, Quaternion } from 'three';
import type { Object3D } from 'three';
import { defineLibraryComponent, type RV } from './_shared/behavior-kit';
import type { MU, Port } from '../core/material-flow/material-flow-self';
import { classifyConnections, listOwnSnaps, type PortConnection } from './_shared/snap-graph-helpers';
import { alignToInputAngle, dispatchToOutputAngle, calibrateBeltNeutralAngle } from './_shared/turntable-angle-math';
import type { DriveHandle, BeltHandle } from './_shared/lazy-drive';

const CONFIG = {
  runSignal:       'Conveyor.Run',
  occupiedSignal:  'Conveyor.Occupied',
  runningSignal:   'Conveyor.Running',
  partCountSignal: 'Conveyor.PartCount',
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
  drive: DriveHandle | null;
  belt: BeltHandle | null;
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

type TurntableSelf = RV.Self<TurntableLocal>;

function portOccupiedSignal(portId: string): string {
  return `${CONFIG.occupiedSignal}@${portId}`;
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
  self.signals.set(CONFIG.occupiedSignal, surf || self.state !== 'idle');
};
const publishRunning = (self: TurntableSelf): void => {
  self.signals.set(CONFIG.runningSignal, self.state !== 'idle');
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
    const sigName = `/${c.ownerRoot.name}/${CONFIG.occupiedSignal}`;
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
  if (self.signals.get<boolean>(CONFIG.runSignal) !== true) return;

  const ready = inputs(l).filter(c =>
    self.signals.get(`/${c.ownerRoot.name}/${CONFIG.occupiedSignal}`) === true);
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
  if (self.signals.get<boolean>(CONFIG.runSignal) !== true) { setBelt(l, false); enter(self, 'holding'); return; }
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
function desRotateTo(self: TurntableSelf, targetAngle: number, next: State, mu: MU | null): void {
  const l = self.local;
  const dt = Math.abs(targetAngle - l.lastCommandedAngle) / rotationSpeed(self);
  l.lastCommandedAngle = targetAngle;
  self.prop['driveTarget'] = targetAngle; // Tween/Animated drives the real rotation 1:1.
  enter(self, next);
  self.in(Math.max(0.001, dt), 'RotateComplete', mu);
}

/** Pick a free output port for the DES router (first not-occupied output). */
function desSelectOutput(self: TurntableSelf): Port | null {
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

  // Per-instance state slot — used by BOTH the continuous shim and the DES
  // model-load binding so a directly-created self gets its local fields.
  local: (): TurntableLocal => ({
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
  // declare signals, build the Reset context menu.
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

    self.signal(CONFIG.runSignal,       { type: 'PLCInputBool',  initialValue: true });
    self.signal(CONFIG.occupiedSignal,  { type: 'PLCOutputBool', initialValue: false });
    self.signal(CONFIG.runningSignal,   { type: 'PLCOutputBool', initialValue: false });
    self.signal(CONFIG.partCountSignal, { type: 'PLCOutputInt',  initialValue: 0 });

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
          self.signals.set(CONFIG.partCountSignal, l.partCount);
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
    canAccept(self: TurntableSelf, _mu: MU, port?: Port): boolean {
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
    onAccept(self: TurntableSelf, mu: MU, port?: Port): boolean {
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
    onRotateComplete(self: TurntableSelf, mu: MU): void {
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
const TurntableBehavior = defineLibraryComponent<TurntableLocal>(def, {
  capabilities: { badgeColor: '#7e57c2', filterLabel: 'Behavior', hierarchyVisible: true, inspectorVisible: true },
  badge: (self) => ({
    Drive: self.local.rotaryNode!.name,
    Sensor: self.local.sensorNode!.name,
    ...(self.local.beltNode ? { Belt: self.local.beltNode.name } : {}),
  }),
});

/** The material-flow definition (schema + logic + continuous + des) — for DES tests / runner. */
export const TurntableFlow = def;

export default TurntableBehavior;
