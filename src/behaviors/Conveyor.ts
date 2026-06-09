// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Conveyor — zone-accumulation conveyor. Authoring model: doc-behavior-modelling.md */

import { Box3, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { Behavior } from '../core/behaviors';
import { findTransport, findSensor } from '../core/library-component-loader';
import { registerCapabilities } from '../core/engine/rv-component-registry';
import { defineMaterialFlow, toBehavior } from '../core/material-flow/define-material-flow';
import {
  readConfigNumber,
  type MaterialFlowSelf,
  type MU,
  type TweenSpec,
} from '../core/material-flow/material-flow-self';
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

  // ── DES timing (Plan 194 §2.5 / F11 / F12) — resolved once in setup() ──
  /** Belt speed in mm/s (≥ 0.001), preferring the belt drive's TargetSpeed. */
  desSpeed: number;
  /** Conveyor length in mm (CalculatedArcLength || ConveyorLength || geometry). */
  desLength: number;
  /** Seconds entry → sensor (dist/speed); full transit when sensor unresolvable. */
  timeToSensor: number;
  /** Entry world position (mm) for the in-transit tween (entry → exit). */
  entryPos: [number, number, number];
  /** Exit world position (mm) for the in-transit tween. */
  exitPos: [number, number, number];
  /** MUs currently in transit → their DES arrival event id (cancel-on-reset). */
  transitMUs: Map<number, number>;
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

/**
 * Belt-running gate for the DES discharge (ZPA): the belt must be running for a
 * part at the sensor to be released. Downstream OCCUPANCY is NOT pre-gated here —
 * the object handshake (`self.transfer` → adapter `tryTransferMU`) is the
 * authority and parks the MU when the downstream is full. (The continuous path
 * uses the full `shouldFlow`, which additionally reads the surface interlock.)
 */
function beltRunning(self: ConveyorSelf): boolean {
  return self.signals.get<boolean>(RUN_SIGNAL) === true;
}

function tryRelease(self: ConveyorSelf, mu: MU): boolean {
  // ZPA release (Plan 194 §2.5): release only when the belt is running AND the
  // downstream can accept. Otherwise the part stays on the belt (parked in the
  // conveyor's own blockedMUs) and is retried on onDownstreamReady / run-signal.
  const out = self.outputs()[0];
  if (beltRunning(self) && self.downstreamCanAccept(mu, out)) {
    self.transfer(mu, out);
    onPartLeft(self);
    return true;
  }
  self.local.blockedMUs.push(mu);
  return false;
}

// ── DES timing resolution (Plan 194 §2.5 / F11 / F12) ─────────────────────

const _box = new Box3();
const _v = new Vector3();

/**
 * Resolve the belt speed (mm/s) for the DES transit time. Prefers the live belt
 * drive's `TargetSpeed` (so a configured drive speed wins), falling back to the
 * schema `ConveyorSpeed`. Division-protected like the C#-DES (`Math.max(0.001)`).
 */
function resolveSpeed(self: ConveyorSelf): number {
  const beltNode = self.local.beltNode;
  const driveSpeed = beltNode ? self.drive(beltNode)?.TargetSpeed : undefined;
  const speed = driveSpeed && driveSpeed > 0
    ? driveSpeed
    : readConfigNumber(self, 'ConveyorSpeed', 0);
  return Math.max(0.001, speed > 0 ? speed : readConfigNumber(self, 'ConveyorSpeed', 200));
}

/**
 * Resolve the belt length (mm): `CalculatedArcLength` (curves) wins, else
 * `ConveyorLength`, else a geometric fallback from the belt node's world bounds.
 */
function resolveLength(self: ConveyorSelf): number {
  const arc = readConfigNumber(self, 'CalculatedArcLength', 0);
  if (arc > 0) return arc;
  const len = readConfigNumber(self, 'ConveyorLength', 0);
  if (len > 0) return len;
  // Geometric fallback: longest world-bounds extent of the belt node (mm).
  const beltNode = self.local.beltNode;
  if (beltNode) {
    _box.makeEmpty();
    _box.expandByObject(beltNode);
    if (!_box.isEmpty()) {
      _box.getSize(_v);
      const longest = Math.max(_v.x, _v.y, _v.z);
      if (longest > 0) return longest;
    }
  }
  return 1; // last-resort positive length (keeps transit time finite)
}

/**
 * Compute and cache the DES timing model (Plan 194 §2.5):
 *   - speed  = belt drive speed (preferred) else `ConveyorSpeed`, ≥ 0.001
 *   - length = CalculatedArcLength || ConveyorLength || belt-bounds extent
 *   - timeToSensor = distance(entry → sensor)/speed when the sensor world
 *     position is resolvable, else the full `length/speed`.
 * Also records the entry/exit world positions used for the in-transit tween.
 */
function resolveTiming(self: ConveyorSelf): void {
  const l = self.local;
  const speed = resolveSpeed(self);
  const length = resolveLength(self);
  l.desSpeed = speed;
  l.desLength = length;

  // Entry/exit world positions from the belt-node bounds along its longest axis.
  const beltNode = l.beltNode;
  let entry = new Vector3();
  let exit = new Vector3();
  if (beltNode) {
    _box.makeEmpty();
    _box.expandByObject(beltNode);
    if (!_box.isEmpty()) {
      _box.getSize(_v);
      const cx = (_box.min.x + _box.max.x) * 0.5;
      const cy = (_box.min.y + _box.max.y) * 0.5;
      const cz = (_box.min.z + _box.max.z) * 0.5;
      // Span the longest axis (the transport direction in most belt layouts).
      if (_v.x >= _v.y && _v.x >= _v.z) {
        entry.set(_box.min.x, cy, cz); exit.set(_box.max.x, cy, cz);
      } else if (_v.z >= _v.x && _v.z >= _v.y) {
        entry.set(cx, cy, _box.min.z); exit.set(cx, cy, _box.max.z);
      } else {
        entry.set(cx, _box.min.y, cz); exit.set(cx, _box.max.y, cz);
      }
    } else {
      beltNode.getWorldPosition(entry); exit.copy(entry);
    }
  }
  l.entryPos = [entry.x, entry.y, entry.z];
  l.exitPos = [exit.x, exit.y, exit.z];

  // timeToSensor: distance entry → sensor / speed, else the full length / speed.
  let distToSensor = length;
  const sensorNode = l.sensorNode;
  if (sensorNode) {
    sensorNode.getWorldPosition(_v);
    const d = _v.distanceTo(entry) * 1000; // m → mm (world units are metres)
    if (d > 0) distToSensor = d;
  }
  l.timeToSensor = Math.max(0.001, distToSensor / speed);
}

/** Build the position-tween spec for an in-transit MU (entry → exit). */
function transitTween(self: ConveyorSelf, mu: MU): TweenSpec {
  return {
    tween: {
      kind: 'position',
      target: (mu as { visual?: unknown }).visual ?? null,
      from: self.local.entryPos,
      to: self.local.exitPos,
    },
  };
}

const def = defineMaterialFlow<ConveyorSelf>({
  type: 'Conveyor',
  kind: 'conveyor',
  models: ['*Conveyor*'],
  // DES timing params (Plan 194 §2.5 / F12). Mirror the C#-DES `DESConveyor`
  // schema; read from rv_extras via the binding wiring into self.prop.
  schema: {
    ConveyorLength:      { type: 'number', default: 1000 }, // mm
    ConveyorSpeed:       { type: 'number', default: 200 },  // mm/s
    CalculatedArcLength: { type: 'number', default: 0 },    // mm (curves; overrides length)
  },

  logic: { shouldFlow, onPartAtSensor, onPartLeft },

  // Per-instance state slot — used by BOTH the continuous shim and the DES
  // model-load binding so a directly-created self gets its local fields.
  local: (): ConveyorLocal => ({
    disabled: false,
    beltNode: null,
    sensorNode: null,
    belt: null,
    interlock: null,
    partAtSensor: false,
    partCount: 0,
    blockedMUs: [],
    desSpeed: 0.001,
    desLength: 1,
    timeToSensor: 0.001,
    entryPos: [0, 0, 0],
    exitPos: [0, 0, 0],
    transitMUs: new Map<number, number>(),
  }),

  // Mode-agnostic init (continuous AND DES): resolve nodes into self.local,
  // declare signals, stamp the badge, build the context menu.
  setup(self: ConveyorSelf): void {
    const l = self.local;
    const rootTag = self.root.name || '<unnamed>';
    const beltNode = findTransport(self.root);
    const sensorNode = findSensor(self.root);
    if (!beltNode)   { console.warn(`[Conveyor:${rootTag}] no Transport-* node found — skipping bind`); l.disabled = true; return; }
    if (!sensorNode) { console.warn(`[Conveyor:${rootTag}] no Sensor / Sensor-* node found — skipping bind`); l.disabled = true; return; }

    l.beltNode = beltNode;
    l.sensorNode = sensorNode;

    // Reset transient DES flow state — setup() re-runs on Reset-on-Switch /
    // DESRunner.start(), so clear any leftover transit/blocked bookkeeping.
    l.partAtSensor = false;
    l.blockedMUs.length = 0;
    l.transitMUs.clear();

    console.info(`[Conveyor:${rootTag}] attached — belt "${beltNode.name}", sensor "${sensorNode.name}"`);
    self.stamp('ConveyorBehavior', { Belt: beltNode.name, Sensor: sensorNode.name });

    declareConveyorSignalsWith((n, o) => self.signal(n, o));

    // Resolve the DES timing model once (speed/length/timeToSensor + tween
    // endpoints). Mode-agnostic: harmless in continuous (the belt physics owns
    // motion there), authoritative for the DES transit schedule.
    resolveTiming(self);

    self.contextMenu(beltNode, [
      { id: 'run',  label: 'Run',  action: () => self.signals.set(RUN_SIGNAL, true) },
      { id: 'stop', label: 'Stop', danger: true, dividerBefore: true,
        action: () => self.signals.set(RUN_SIGNAL, false) },
    ]);
  },

  continuous: {
    // Continuous-only wiring — reads the self.local nodes resolved by the shared
    // setup() above. attachBelt → belt handle, the downstream interlock, and the
    // AABB-sensor subscription are the continuous trigger/effect plumbing.
    setup(self: ConveyorSelf): void {
      const l = self.local;
      if (l.disabled) return;

      l.belt = attachBelt(selfDrives(self), l.beltNode!);
      l.interlock = createDownstreamInterlock(self);

      self.signals.on(l.sensorNode!.name, (v) => onPartAtSensor(self, v === true));
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
    // Accept = enter transit. Schedule the arrival at the sensor/discharge point
    // after `timeToSensor` of SIM time (NOT an immediate release), and attach a
    // straight entry→exit position tween (Plan 194 §2.5 / §3.1). Capacity is
    // single-zone like the C#-DES `DESConveyor`; the runner's canAccept already
    // enforces MaxCapacity, so returning true here accepts the MU into transit.
    onAccept(self: ConveyorSelf, mu: MU): boolean {
      const eventId = self.in(self.local.timeToSensor, 'Arrival', mu, transitTween(self, mu));
      self.local.transitMUs.set(mu.id, eventId);
      return true;
    },
    // Arrival at the sensor/discharge point: mark the part present (the local
    // discharge trigger), then run the existing release handshake. A downstream
    // block parks the MU in blockedMUs (Plan 194 §2.5 back-pressure).
    onArrival(self: ConveyorSelf, mu: MU): void {
      self.local.transitMUs.delete(mu.id);
      onPartAtSensor(self, true);
      tryRelease(self, mu);
    },
    onDownstreamReady(self: ConveyorSelf): void {
      const mu = self.local.blockedMUs.shift();
      if (mu) tryRelease(self, mu);
    },
  },
});

// The local-state factory lives on the def (`def.local`) so both the continuous
// shim and the DES binding seed `self.local` identically.
const ConveyorBehavior: Behavior = toBehavior(def);

/** The material-flow definition (schema + logic + continuous + des) — for DES tests / runner. */
export const ConveyorFlow = def;

export default ConveyorBehavior;
