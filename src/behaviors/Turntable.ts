// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Turntable — multi-port router. Authoring model: doc-behavior-modelling.md */

import { Vector3, Quaternion } from 'three';
import type { Object3D } from 'three';
import type { Behavior } from '../core/behaviors';
import type { RVBindContext } from '../core/behavior-runtime';
import { findRotaryDrive, findSensor, findTransport } from '../core/library-component-loader';
import { registerCapabilities } from '../core/engine/rv-component-registry';
import { defineMaterialFlow } from '../core/material-flow/define-material-flow';
import { createSelf, type MaterialFlowSelf, type MU, type Port } from '../core/material-flow/material-flow-self';
import { classifyConnections, listOwnSnaps, type PortConnection } from './_shared/snap-graph-helpers';
import { alignToInputAngle, dispatchToOutputAngle, calibrateBeltNeutralAngle } from './_shared/turntable-angle-math';
import { attachDrive, attachBelt, type DriveHandle, type BeltHandle } from './_shared/lazy-drive';
import { BEHAVIOR_BADGE } from './_shared/behavior-badge';
import { isSurfaceOccupied } from './_shared/surface-occupancy';

registerCapabilities('TurntableBehavior', BEHAVIOR_BADGE);

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

interface TurntableState {
  rv: RVBindContext;
  rootTag: string;
  rotaryNode: Object3D;
  sensorNode: Object3D;
  beltNode: Object3D | null;
  drive: DriveHandle;
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

const _state = new WeakMap<MaterialFlowSelf, TurntableState>();

function st(self: MaterialFlowSelf): TurntableState {
  const s = _state.get(self);
  if (!s) throw new Error('[Turntable] state missing — setup() did not run');
  return s;
}

const setBelt = (s: TurntableState, forward: boolean): void => {
  if (!s.belt) return;
  s.belt.run(forward);
};
const blockAllInputs = (s: TurntableState): void => {
  for (const c of s.connections) s.rv.signals.set(portOccupiedSignal(c.snap.id), true);
};
const openInputPort = (s: TurntableState, openId: string | null): void => {
  for (const c of s.connections) s.rv.signals.set(portOccupiedSignal(c.snap.id), c.snap.id !== openId);
};

const publishOccupied = (self: MaterialFlowSelf): void => {
  const s = st(self);
  const platformOccupied = s.beltNode ? isSurfaceOccupied(s.rv.viewer, s.beltNode) : s.sensorOccupied;
  s.rv.signals.set(CONFIG.occupiedSignal, platformOccupied || self.state !== 'idle');
};
const publishRunning = (self: MaterialFlowSelf): void => {
  st(self).rv.signals.set(CONFIG.runningSignal, self.state !== 'idle');
};
const driveAtTarget = (s: TurntableState): boolean => s.drive.isAtTarget();

const componentRegistry = (s: TurntableState): ComponentRegistryShape | null => {
  const r = (s.rv.viewer as { registry?: unknown }).registry as Partial<ComponentRegistryShape> | undefined | null;
  return r && typeof r.findInChildren === 'function' ? (r as ComponentRegistryShape) : null;
};

const calibrateBelt = (s: TurntableState): void => {
  if (s.beltCalibrated || !s.beltNode) return;
  const reg = componentRegistry(s);
  if (!reg) return;
  const surface = reg.findInChildren<TransportSurfaceLike>(s.beltNode, 'TransportSurface');
  if (!surface) return;
  surface.getWorldDirection(s._dir);
  s.rv.root.getWorldQuaternion(s._quat).invert();
  s._dir.applyQuaternion(s._quat);
  s.beltNeutralAngle = calibrateBeltNeutralAngle(s.driveAxis, s._dir, s.lastCommandedAngle);
  s.beltCalibrated = true;
};

const refreshTopology = (self: MaterialFlowSelf): void => {
  const s = st(self);
  s.connections = classifyConnections(s.rv.viewer, s.rv.root);
  calibrateBelt(s);
  if (self.state === 'receiving') openInputPort(s, s.selectedInputPort);
  else blockAllInputs(s);
};

const inputs = (s: TurntableState): PortConnection[] => s.connections.filter(c => c.role === 'input');
const outputs = (s: TurntableState): PortConnection[] => s.connections.filter(c => c.role === 'output');

// Deliberate root-only free-output read, kept for parity (NOT the per-port linkOf().occupied() lookup).
const freeOutputs = (s: TurntableState): PortConnection[] => {
  const out: PortConnection[] = [];
  for (const c of outputs(s)) {
    const sigName = `/${c.ownerRoot.name}/${CONFIG.occupiedSignal}`;
    if (s.rv.signals.get(sigName) === true) continue;
    out.push(c);
  }
  return out;
};

const platformHasPart = (s: TurntableState): boolean =>
  (s.beltNode ? isSurfaceOccupied(s.rv.viewer, s.beltNode) : false) || s.sensorOccupied;

function enter(self: MaterialFlowSelf, next: State): void {
  self.setState(next);
  publishOccupied(self);
  publishRunning(self);
}

function tryReceive(self: MaterialFlowSelf): void {
  const s = st(self);
  if (self.state !== 'idle') return;
  if (s.rv.signals.get<boolean>(CONFIG.runSignal) !== true) return;

  const ready = inputs(s).filter(c =>
    s.rv.signals.get(`/${c.ownerRoot.name}/${CONFIG.occupiedSignal}`) === true);
  if (ready.length === 0) return;
  const waiting = ready[Math.floor(Math.random() * ready.length)];

  s.selectedInputPort = waiting.snap.id;
  const target = alignToInputAngle(s.driveAxis, s.beltNeutralAngle, waiting.snap.object3D, s.lastCommandedAngle);
  setBelt(s, false);
  s.drive.moveTo(target);
  s.lastCommandedAngle = target;
  enter(self, 'aligning_in');
}

function tryDispatch(self: MaterialFlowSelf): void {
  const s = st(self);
  if (s.rv.signals.get<boolean>(CONFIG.runSignal) !== true) { setBelt(s, false); enter(self, 'holding'); return; }
  const candidates = freeOutputs(s);
  if (candidates.length === 0) { setBelt(s, false); enter(self, 'holding'); return; }

  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  const target = dispatchToOutputAngle(s.driveAxis, s.beltNeutralAngle, chosen.snap.object3D, s.lastCommandedAngle);
  setBelt(s, false);
  s.drive.moveTo(target);
  s.lastCommandedAngle = target;
  enter(self, 'rotating_out');
}

function onPartAtCenter(self: MaterialFlowSelf): void {
  const s = st(self);
  blockAllInputs(s);
  s.selectedInputPort = null;
  tryDispatch(self);
}

function onRotationDone(self: MaterialFlowSelf): void {
  const s = st(self);
  if (self.state === 'aligning_in') {
    enter(self, 'receiving');
    openInputPort(s, s.selectedInputPort);
    setBelt(s, true);
  } else if (self.state === 'rotating_out') {
    setBelt(s, true);
    enter(self, 'discharging');
  }
}

function finishCycle(self: MaterialFlowSelf): void {
  setBelt(st(self), false);
  enter(self, 'idle');
}

function abortToIdle(self: MaterialFlowSelf): void {
  const s = st(self);
  s.drive.stop();
  setBelt(s, false);
  blockAllInputs(s);
  s.selectedInputPort = null;
  s.emptyFor = 0;
  enter(self, 'idle');
}

const def = defineMaterialFlow({
  type: 'Turntable',
  kind: 'router',
  models: ['*Turntable*'],
  schema: {},

  logic: { enter, tryReceive, tryDispatch, onPartAtCenter, onRotationDone, finishCycle, abortToIdle },

  continuous: {
    setup(self: MaterialFlowSelf): void {
      const s = st(self);

      self.signal(CONFIG.runSignal,       { type: 'PLCInputBool',  initialValue: true });
      self.signal(CONFIG.occupiedSignal,  { type: 'PLCOutputBool', initialValue: false });
      self.signal(CONFIG.runningSignal,   { type: 'PLCOutputBool', initialValue: false });
      self.signal(CONFIG.partCountSignal, { type: 'PLCOutputInt',  initialValue: 0 });
      for (const sp of listOwnSnaps(s.rv.viewer, s.rv.root)) s.rv.signals.set(portOccupiedSignal(sp.id), true);

      s.connections = classifyConnections(s.rv.viewer, s.rv.root);
      calibrateBelt(s);

      self.signals.on(s.sensorNode.name, (v) => {
        const present = v === true;
        if (present && !s.sensorOccupied) {
          s.partCount += 1;
          self.signals.set(CONFIG.partCountSignal, s.partCount);
        }
        s.sensorOccupied = present;
        publishOccupied(self);

        if (present) {
          if (self.state === 'receiving') {
            onPartAtCenter(self);
          }
        } else if (self.state === 'discharging') {
          s.clearTimer = CONFIG.dischargeClearSec;
          enter(self, 'discharge_clearing');
        }
      });

      self.contextMenu(s.rotaryNode, [
        {
          id: 'reset', label: 'Reset',
          action: () => {
            s.drive.stop();
            setBelt(s, false);
            blockAllInputs(s);
            s.selectedInputPort = null;
            enter(self, 'idle');
          },
        },
      ]);
    },

    fixedUpdate(self: MaterialFlowSelf, dt: number): void {
      const s = st(self);

      publishOccupied(self);

      s.refreshTimer += dt;
      if (s.refreshTimer >= CONFIG.neighborRefreshSec) {
        s.refreshTimer = 0;
        refreshTopology(self);
        if (self.state === 'idle') tryReceive(self);
        else if (self.state === 'holding' && s.sensorOccupied) tryDispatch(self);
      }

      if (self.state !== 'idle' && self.state !== 'aligning_in') {
        if (!platformHasPart(s)) {
          s.emptyFor += dt;
          if (s.emptyFor >= CONFIG.emptyResetSec) abortToIdle(self);
        } else {
          s.emptyFor = 0;
        }
      } else {
        s.emptyFor = 0;
      }

      switch (self.state as State) {
        case 'idle':
          setBelt(s, false);
          break;
        case 'aligning_in':
          if (driveAtTarget(s)) onRotationDone(self);
          break;
        case 'receiving':
          setBelt(s, true);
          break;
        case 'holding':
          setBelt(s, false);
          break;
        case 'rotating_out':
          if (driveAtTarget(s)) onRotationDone(self);
          break;
        case 'discharging':
          break;
        case 'discharge_clearing':
          setBelt(s, true);
          s.clearTimer -= dt;
          if (s.clearTimer <= 0) finishCycle(self);
          break;
      }
    },
  },

  des: {
    canAccept(self: MaterialFlowSelf, _mu: MU, port?: Port): boolean {
      // TODO(P5): port-aligned acceptance — accept only at the currently aligned
      // input port. `alignedPort` is initialised in setup()/the FSM (B2).
      return self.currentLoad < 1 && port?.id === (self.prop['alignedPort'] as string | null);
    },
    onAccept(_self: MaterialFlowSelf, _mu: MU, _port?: Port): boolean {
      // TODO(P5): rotate-to-input then receive (time-based, via self.in).
      return false;
    },
    onRotateComplete(_self: MaterialFlowSelf, _mu: MU): void {
      // TODO(P5): advance the shared FSM (onRotationDone / onPartAtCenter) and
      // transfer to the selected output port.
    },
    onDownstreamReady(_self: MaterialFlowSelf, _from: unknown): void {
      // TODO(P5): push a HELD MU once the chosen output frees.
    },
  },
});

const TurntableBehavior: Behavior = {
  models: def.models ?? ['*Turntable*'],
  bind(rv: RVBindContext): void {
    const rootTag = rv.root.name || '<unnamed>';
    const rotaryNode = findRotaryDrive(rv.root);
    const sensorNode = findSensor(rv.root);
    const beltNode = findTransport(rv.root);
    if (!rotaryNode) { console.warn(`[Turntable:${rootTag}] no Drive-Rot-* node found`); return; }
    if (!sensorNode) { console.warn(`[Turntable:${rootTag}] no Sensor node found`); return; }
    if (!beltNode)   console.warn(`[Turntable:${rootTag}] no Transport-* node found — belt stop/start will be a no-op`);

    const drive = attachDrive(rv, rotaryNode);
    const belt = beltNode ? attachBelt(rv, beltNode) : null;

    console.info(`[Turntable:${rootTag}] attached — drive "${rotaryNode.name}", sensor "${sensorNode.name}"${beltNode ? `, belt "${beltNode.name}"` : ''}`);

    rv.behavior(rv.root, 'TurntableBehavior', {
      Drive: rotaryNode.name,
      Sensor: sensorNode.name,
      ...(beltNode ? { Belt: beltNode.name } : {}),
    });

    const self = createSelf(rv, def, { mode: 'continuous' });
    _state.set(self, {
      rv,
      rootTag,
      rotaryNode,
      sensorNode,
      beltNode,
      drive,
      belt,
      driveAxis: axisFromDriveNodeName(rotaryNode.name),

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
    });

    self.prop['alignedPort'] = null;
    self.prop['selectedOutput'] = null;

    def.continuous.setup!(self);
    const fixed = def.continuous.fixedUpdate;
    if (fixed) rv.onFixedUpdate((dt: number) => fixed(self, dt));
    rv.onDispose(() => _state.delete(self));
  },
};

export default TurntableBehavior;
