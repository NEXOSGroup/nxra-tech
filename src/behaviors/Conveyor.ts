// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Conveyor — zone-accumulation conveyor. Authoring model: doc-behavior-modelling.md */

import type { Object3D } from 'three';
import type { Behavior } from '../core/behaviors';
import { findTransport, findSensor } from '../core/library-component-loader';
import { registerCapabilities } from '../core/engine/rv-component-registry';
import { defineMaterialFlow, toBehavior } from '../core/material-flow/define-material-flow';
import type { MaterialFlowSelf, MU } from '../core/material-flow/material-flow-self';
import {
  createDownstreamInterlock,
  declareConveyorSignalsWith,
} from './_shared/transport-links';
import { attachBelt, selfDrives, type BeltHandle } from './_shared/lazy-drive';
import { isSurfaceOccupied } from './_shared/surface-occupancy';

registerCapabilities('ConveyorBehavior', {
  badgeColor: '#7e57c2',
  filterLabel: 'Behavior',
  hierarchyVisible: true,
  inspectorVisible: true,
});

const RUN_SIGNAL = 'Conveyor.Run';
const OCCUPIED_SIGNAL = 'Conveyor.Occupied';
const RUNNING_SIGNAL = 'Conveyor.Running';
const PARTCOUNT_SIGNAL = 'Conveyor.PartCount';

interface ConveyorLocal {
  disabled: boolean;
  beltNode: Object3D | null;
  sensorNode: Object3D | null;
  belt: BeltHandle | null;
  interlock: { occupied(): boolean } | null;
  partAtSensor: boolean;
  partCount: number;
  blockedMUs: MU[];
}

type ConveyorSelf = MaterialFlowSelf<ConveyorLocal>;

// partAtSensor is the LOCAL discharge trigger — NOT the published surface-based Conveyor.Occupied.
function shouldFlow(self: ConveyorSelf): boolean {
  const l = self.local;
  const run = self.signals.get<boolean>(RUN_SIGNAL) === true;
  const dsOcc = l.interlock ? l.interlock.occupied() : true;
  // ZPA: run unless a part sits at the sensor AND the downstream zone is occupied.
  return run && !(l.partAtSensor && dsOcc);
}

function onPartAtSensor(self: ConveyorSelf, present: boolean): void {
  const l = self.local;
  if (present && !l.partAtSensor) {
    l.partCount += 1;
    self.signals.set(PARTCOUNT_SIGNAL, l.partCount);
  }
  l.partAtSensor = present;
}

function onPartLeft(self: ConveyorSelf): void {
  self.local.partAtSensor = false;
}

function tryRelease(self: ConveyorSelf, mu: MU): boolean {
  if (shouldFlow(self)) {
    self.transfer(mu, self.outputs()[0]);
    onPartLeft(self);
    return true;
  }
  self.local.blockedMUs.push(mu);
  return false;
}

const def = defineMaterialFlow<ConveyorSelf>({
  type: 'Conveyor',
  kind: 'conveyor',
  models: ['*Conveyor*'],
  schema: {},

  logic: { shouldFlow, onPartAtSensor, onPartLeft },

  continuous: {
    setup(self: ConveyorSelf): void {
      const l = self.local;
      const rootTag = self.root.name || '<unnamed>';
      const beltNode = findTransport(self.root);
      const sensorNode = findSensor(self.root);
      if (!beltNode)   { console.warn(`[Conveyor:${rootTag}] no Transport-* node found — skipping bind`); l.disabled = true; return; }
      if (!sensorNode) { console.warn(`[Conveyor:${rootTag}] no Sensor / Sensor-* node found — skipping bind`); l.disabled = true; return; }

      l.beltNode = beltNode;
      l.sensorNode = sensorNode;
      l.belt = attachBelt(selfDrives(self), beltNode);
      l.interlock = createDownstreamInterlock(self);

      console.info(`[Conveyor:${rootTag}] attached — belt "${beltNode.name}", sensor "${sensorNode.name}"`);
      self.stamp('ConveyorBehavior', { Belt: beltNode.name, Sensor: sensorNode.name });

      declareConveyorSignalsWith((n, o) => self.signal(n, o));

      self.signals.on(sensorNode.name, (v) => onPartAtSensor(self, v === true));

      self.contextMenu(beltNode, [
        { id: 'run',  label: 'Run',  action: () => self.signals.set(RUN_SIGNAL, true) },
        { id: 'stop', label: 'Stop', danger: true, dividerBefore: true,
          action: () => self.signals.set(RUN_SIGNAL, false) },
      ]);
    },

    fixedUpdate(self: ConveyorSelf, _dt: number): void {
      const l = self.local;
      if (l.disabled) return;

      self.signals.set(OCCUPIED_SIGNAL, isSurfaceOccupied(self.viewer, l.beltNode!));

      const moving = shouldFlow(self);
      self.signals.set(RUNNING_SIGNAL, moving);
      l.belt!.run(moving);
    },
  },

  des: {
    onAccept(self: ConveyorSelf, mu: MU): boolean {
      onPartAtSensor(self, true);
      return tryRelease(self, mu);
    },
    onArrival(self: ConveyorSelf, mu: MU): void {
      onPartAtSensor(self, true);
      tryRelease(self, mu);
    },
    onDownstreamReady(self: ConveyorSelf): void {
      const mu = self.local.blockedMUs.shift();
      if (mu) tryRelease(self, mu);
    },
  },
});

const ConveyorBehavior: Behavior = toBehavior(def, () => ({
  disabled: false,
  beltNode: null,
  sensorNode: null,
  belt: null,
  interlock: null,
  partAtSensor: false,
  partCount: 0,
  blockedMUs: [],
}));

export default ConveyorBehavior;
