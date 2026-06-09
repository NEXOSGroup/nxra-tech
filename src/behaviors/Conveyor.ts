// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Conveyor — zone-accumulation conveyor. Authoring model: doc-behavior-modelling.md */

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

registerCapabilities('ConveyorBehavior', BEHAVIOR_BADGE);

const RUN_SIGNAL = 'Conveyor.Run';
const OCCUPIED_SIGNAL = 'Conveyor.Occupied';
const RUNNING_SIGNAL = 'Conveyor.Running';
const PARTCOUNT_SIGNAL = 'Conveyor.PartCount';
const NEIGHBOR_REFRESH_SEC = 0.5;

interface ConveyorState {
  rv: RVBindContext;
  beltNode: Object3D;
  sensorNode: Object3D;
  belt: BeltHandle;
  interlock: { occupied(): boolean };
  partAtSensor: boolean;
  partCount: number;
  refreshTimer: number;
  blockedMUs: MU[];
}

const _state = new WeakMap<MaterialFlowSelf, ConveyorState>();

function st(self: MaterialFlowSelf): ConveyorState {
  const s = _state.get(self);
  if (!s) throw new Error('[Conveyor] state missing — setup() did not run');
  return s;
}

// partAtSensor is the LOCAL discharge trigger — NOT the published surface-based Conveyor.Occupied.
function shouldFlow(self: MaterialFlowSelf): boolean {
  const s = st(self);
  const run = self.signals.get<boolean>(RUN_SIGNAL) === true;
  const dsOcc = s.interlock.occupied();
  return conveyorShouldRun(run, s.partAtSensor, dsOcc);
}

function onPartAtSensor(self: MaterialFlowSelf, present: boolean): void {
  const s = st(self);
  if (present && !s.partAtSensor) {
    s.partCount += 1;
    self.signals.set(PARTCOUNT_SIGNAL, s.partCount);
  }
  s.partAtSensor = present;
}

function onPartLeft(self: MaterialFlowSelf): void {
  st(self).partAtSensor = false;
}

function tryRelease(self: MaterialFlowSelf, mu: MU): boolean {
  if (shouldFlow(self)) {
    self.transfer(mu, self.outputs()[0]);
    onPartLeft(self);
    return true;
  }
  st(self).blockedMUs.push(mu);
  return false;
}

const def = defineMaterialFlow({
  type: 'Conveyor',
  kind: 'conveyor',
  models: ['*Conveyor*'],
  schema: {},

  logic: { shouldFlow, onPartAtSensor, onPartLeft },

  continuous: {
    setup(self: MaterialFlowSelf): void {
      const s = st(self);

      self.signal(RUN_SIGNAL,       { type: 'PLCInputBool',  initialValue: true });
      self.signal(OCCUPIED_SIGNAL,  { type: 'PLCOutputBool', initialValue: false });
      self.signal(RUNNING_SIGNAL,   { type: 'PLCOutputBool', initialValue: false });
      self.signal(PARTCOUNT_SIGNAL, { type: 'PLCOutputInt',  initialValue: 0 });

      self.signals.on(s.sensorNode.name, (v) => onPartAtSensor(self, v === true));

      self.contextMenu(s.beltNode, [
        { id: 'run',  label: 'Run',  action: () => self.signals.set(RUN_SIGNAL, true) },
        { id: 'stop', label: 'Stop', danger: true, dividerBefore: true,
          action: () => self.signals.set(RUN_SIGNAL, false) },
      ]);
    },

    fixedUpdate(self: MaterialFlowSelf, dt: number): void {
      const s = st(self);

      self.signals.set(OCCUPIED_SIGNAL, isSurfaceOccupied(s.rv.viewer, s.beltNode));

      s.refreshTimer += dt;
      if (s.refreshTimer >= NEIGHBOR_REFRESH_SEC) s.refreshTimer = 0;

      const moving = shouldFlow(self);
      self.signals.set(RUNNING_SIGNAL, moving);
      s.belt.run(moving);
    },
  },

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

const ConveyorBehavior: Behavior = {
  models: def.models ?? ['*Conveyor*'],
  bind(rv: RVBindContext): void {
    const rootTag = rv.root.name || '<unnamed>';
    const beltNode = findTransport(rv.root);
    const sensorNode = findSensor(rv.root);
    if (!beltNode)   { console.warn(`[Conveyor:${rootTag}] no Transport-* node found — skipping bind`); return; }
    if (!sensorNode) { console.warn(`[Conveyor:${rootTag}] no Sensor / Sensor-* node found — skipping bind`); return; }

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
      refreshTimer: NEIGHBOR_REFRESH_SEC,
      blockedMUs: [],
    });

    def.continuous.setup!(self);
    const fixed = def.continuous.fixedUpdate;
    if (fixed) rv.onFixedUpdate((dt: number) => fixed(self, dt));
    rv.onDispose(() => _state.delete(self));
  },
};

export default ConveyorBehavior;
