// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Turntable — multi-port router. Authoring model: doc-behavior-modelling.md */

import { Vector3, Quaternion } from 'three';
import type { Object3D } from 'three';
import type { Behavior } from '../core/behaviors';
import { findRotaryDrive, findSensor, findTransport } from '../core/library-component-loader';
import { registerCapabilities } from '../core/engine/rv-component-registry';
import { defineMaterialFlow, toBehavior } from '../core/material-flow/define-material-flow';
import type { MaterialFlowSelf, MU, Port } from '../core/material-flow/material-flow-self';
import { classifyConnections, listOwnSnaps, type PortConnection } from './_shared/snap-graph-helpers';
import { alignToInputAngle, dispatchToOutputAngle, calibrateBeltNeutralAngle } from './_shared/turntable-angle-math';
import { attachDrive, attachBelt, selfDrives, type DriveHandle, type BeltHandle } from './_shared/lazy-drive';
import { isSurfaceOccupied } from './_shared/surface-occupancy';

registerCapabilities('TurntableBehavior', {
  badgeColor: '#7e57c2',
  filterLabel: 'Behavior',
  hierarchyVisible: true,
  inspectorVisible: true,
});

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

type TurntableSelf = MaterialFlowSelf<TurntableLocal>;

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
  self.local.beltNode ? isSurfaceOccupied(self.viewer, self.local.beltNode) : self.local.sensorOccupied;

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

const def = defineMaterialFlow<TurntableSelf>({
  type: 'Turntable',
  kind: 'router',
  models: ['*Turntable*'],
  schema: {},

  logic: { enter, tryReceive, tryDispatch, onPartAtCenter, onRotationDone, finishCycle, abortToIdle },

  continuous: {
    setup(self: TurntableSelf): void {
      const l = self.local;
      const rootTag = self.root.name || '<unnamed>';
      const rotaryNode = findRotaryDrive(self.root);
      const sensorNode = findSensor(self.root);
      const beltNode = findTransport(self.root);
      if (!rotaryNode) { console.warn(`[Turntable:${rootTag}] no Drive-Rot-* node found`); return; }
      if (!sensorNode) { console.warn(`[Turntable:${rootTag}] no Sensor node found`); return; }
      if (!beltNode)   console.warn(`[Turntable:${rootTag}] no Transport-* node found — belt stop/start will be a no-op`);

      l.rotaryNode = rotaryNode;
      l.sensorNode = sensorNode;
      l.beltNode = beltNode;
      l.drive = attachDrive(selfDrives(self), rotaryNode);
      l.belt = beltNode ? attachBelt(selfDrives(self), beltNode) : null;
      l.driveAxis = axisFromDriveNodeName(rotaryNode.name);

      console.info(`[Turntable:${rootTag}] attached — drive "${rotaryNode.name}", sensor "${sensorNode.name}"${beltNode ? `, belt "${beltNode.name}"` : ''}`);
      self.stamp('TurntableBehavior', {
        Drive: rotaryNode.name,
        Sensor: sensorNode.name,
        ...(beltNode ? { Belt: beltNode.name } : {}),
      });

      self.prop['alignedPort'] = null;
      self.prop['selectedOutput'] = null;

      self.signal(CONFIG.runSignal,       { type: 'PLCInputBool',  initialValue: true });
      self.signal(CONFIG.occupiedSignal,  { type: 'PLCOutputBool', initialValue: false });
      self.signal(CONFIG.runningSignal,   { type: 'PLCOutputBool', initialValue: false });
      self.signal(CONFIG.partCountSignal, { type: 'PLCOutputInt',  initialValue: 0 });
      for (const sp of listOwnSnaps(self.viewer as { getPlugin?(id: string): unknown }, self.root)) {
        self.signals.set(portOccupiedSignal(sp.id), true);
      }

      l.connections = classifyConnections(self.viewer as { getPlugin?(id: string): unknown }, self.root);
      calibrateBelt(self);

      self.signals.on(sensorNode.name, (v) => {
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
    canAccept(self: TurntableSelf, _mu: MU, port?: Port): boolean {
      // TODO(P5): port-aligned acceptance — accept only at the currently aligned
      // input port. `alignedPort` is initialised in setup()/the FSM (B2).
      return self.currentLoad < 1 && port?.id === (self.prop['alignedPort'] as string | null);
    },
    onAccept(_self: TurntableSelf, _mu: MU, _port?: Port): boolean {
      return false; // TODO(P5): rotate-to-input then receive (time-based, via self.in).
    },
    onRotateComplete(_self: TurntableSelf, _mu: MU): void {
      // TODO(P5): advance the shared FSM (onRotationDone / onPartAtCenter) and transfer to the selected output port.
    },
    onDownstreamReady(_self: TurntableSelf, _from: unknown): void {
      // TODO(P5): push a HELD MU once the chosen output frees.
    },
  },
});

const TurntableBehavior: Behavior = toBehavior(def, () => ({
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
}));

export default TurntableBehavior;
