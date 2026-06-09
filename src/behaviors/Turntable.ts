// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Turntable — belt-aware snap-graph dispatcher with DIRECTION-classified ports.
 *
 * Authored as a `defineMaterialFlow` (Plan 194 §2.4): ONE definition, THREE
 * layers — `logic` (the mode-agnostic state-machine + routing), `continuous`
 * (the public 60 Hz physics adapter), `des` (the event-driven router adapter
 * feeding the DES runner, P5). The continuous adapter reproduces the previously
 * hand-written behaviour EXACTLY; the logic/des layers add the unified-simulation
 * surface without changing any runtime behaviour.
 *
 * Discovery (by the naming convention):
 *   - first `Drive-Rot-X/Y/Z` node       — rotary axis
 *   - first `Sensor` / `Sensor-*` node   — part-arrival sensor
 *   - first `Transport-X/Y/Z` node       — belt on the rotating platform
 *   - all paired `Snap-*` ports on the root — connections to neighbour conveyors
 *
 * Port roles are NOT fixed by the snap name. Each PAIRED port is classified at
 * runtime from the connected conveyor's transport direction: a conveyor moving
 * goods TOWARD the turntable is an `input`; one moving them AWAY is an `output`
 * (see `classifyConnections`). Ports are therefore authored bidirectional
 * (`Snap-?B-*`) so a conveyor can attach in either orientation.
 *
 * Multi-input cycle:
 *
 *   IDLE            empty; every input port blocked (`Conveyor.Occupied@port`=true)
 *     ↓ an input conveyor reports a waiting good (its root `Conveyor.Occupied`=true)
 *   ALIGNING_IN     belt STOPPED, platform rotates to face the selected input
 *     ↓ rotary drive isAtTarget
 *   RECEIVING       selected port released (false) + belt runs to pull the good in
 *     ↓ sensor rising → re-block ALL input ports, decide an output
 *   ROTATING_OUT    belt STOPPED, platform turns to the chosen free output
 *     ↓ rotary drive isAtTarget
 *   DISCHARGING     belt runs, part rolls off downstream
 *     ↓ sensor falling
 *   DISCHARGE_CLEARING belt KEEPS running for a dwell so the good fully exits
 *     ↓ dwell elapsed
 *   IDLE            (loop — no fixed home; we re-scan for the next input)
 *
 *   HOLDING         a good is on the platform but no output is free — belt stopped,
 *                   inputs blocked, retried each refresh until an output clears.
 *
 * Interlock: every connected conveyor reads a PER-PORT occupied signal
 * (`Conveyor.Occupied@<portName>`) for the specific turntable snap it mates to,
 * so only the port the turntable is actively receiving from ever feeds. The root
 * `Conveyor.Occupied` is still published (true across the whole busy cycle) for
 * non-conveyor neighbours and as a fallback.
 *
 * Signals (scoped per placed instance — same naming as Conveyor for interop):
 *   Conveyor.Run                PLCInputBool   master enable (default on)
 *   Conveyor.Occupied           PLCOutputBool  root interlock / fallback
 *   Conveyor.Occupied@<port>    PLCOutputBool  per-input-port interlock (default true)
 *   Conveyor.Running            PLCOutputBool  true in all busy states
 *   Conveyor.PartCount          PLCOutputInt   parts that traversed the sensor
 */

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

// Hierarchy/inspector badge marker (pure marker — no factory). Same colour and
// labels every transport behavior registers (BEHAVIOR_BADGE === the committed
// turntable badge object, so the badge capability is byte-for-byte identical).
registerCapabilities('TurntableBehavior', BEHAVIOR_BADGE);

const CONFIG = {
  runSignal:       'Conveyor.Run',
  occupiedSignal:  'Conveyor.Occupied',
  runningSignal:   'Conveyor.Running',
  partCountSignal: 'Conveyor.PartCount',
  neighborRefreshSec: 0.5,
  dischargeClearSec: 0.5,  // belt keeps running this long after the sensor clears,
                           // so the good fully exits before the platform re-idles
  emptyResetSec: 0.75,     // a part-carrying state whose platform stays empty this
                           // long is freed back to idle (the part was deleted / fell
                           // off). MUST exceed dischargeClearSec so a NORMAL discharge
                           // re-idles via its own dwell first.
} as const;

type State =
  | 'idle'
  | 'aligning_in'
  | 'receiving'
  | 'holding'
  | 'rotating_out'
  | 'discharge_clearing'
  | 'discharging';

/**
 * Per-port occupied signal name (instance-scoped), keyed by the STABLE snap id
 * (Object3D uuid). The node name is NOT used — glTF turntable ports share names
 * like `Snap-ZP`/`Snap-ZN`; the id is unique and is the same object both the
 * turntable and the connected conveyor resolve, so the two always agree. This is
 * exactly the `Conveyor.Occupied@<id>` convention from `_shared/transport-links`
 * (`linkOf().setOccupied()` writes the identical name) — kept as a tiny local
 * helper because the up-front block iterates `listOwnSnaps` (own snap ids) which
 * are not all paired connections.
 */
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

// Minimal structural views of the host registry + transport surface (no import
// cycle, no `any`).
interface ComponentRegistryShape {
  findInChildren<T = unknown>(node: Object3D, type: string): T | null;
}
interface TransportSurfaceLike {
  getWorldDirection(out?: Vector3): Vector3;
}

// ─── Per-instance state ─────────────────────────────────────────────────
//
// The shared `self` (createSelf) carries the mode-agnostic surface (signals,
// state, prop). The turntable's continuous-only handles — resolved nodes, the
// lazy drive/belt handles, the snap-graph connections, the angle accumulator,
// the calibration cache, the timers and the sensor/empty flags — live in a
// per-`self` WeakMap so the def's `logic`/`continuous` methods stay closure-free
// yet typed. This is the exact closure state from the committed implementation.
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
  lastCommandedAngle: number;       // monotonic — never wrapped
  clearTimer: number;               // counts down the discharge-clear dwell (seconds)
  connections: PortConnection[];
  selectedInputPort: string | null;
  beltNeutralAngle: number;
  beltCalibrated: boolean;
  refreshTimer: number;
  emptyFor: number;                 // seconds the platform has been empty in a part-carrying state

  // Scratch (no per-tick allocation).
  _dir: Vector3;
  _quat: Quaternion;
}

const _state = new WeakMap<MaterialFlowSelf, TurntableState>();

function st(self: MaterialFlowSelf): TurntableState {
  const s = _state.get(self);
  if (!s) throw new Error('[Turntable] state missing — setup() did not run');
  return s;
}

// ─── Infra helpers (mode-agnostic effects on self/state) ─────────────────

const setBelt = (s: TurntableState, forward: boolean): void => {
  if (!s.belt) return;
  s.belt.run(forward);
};
const blockAllInputs = (s: TurntableState): void => {
  for (const c of s.connections) s.rv.signals.set(portOccupiedSignal(c.snap.id), true);
};
/** Open exactly one input port (false = free to feed); block the rest. */
const openInputPort = (s: TurntableState, openId: string | null): void => {
  for (const c of s.connections) s.rv.signals.set(portOccupiedSignal(c.snap.id), c.snap.id !== openId);
};

const publishOccupied = (self: MaterialFlowSelf): void => {
  const s = st(self);
  // Surface-based: a good physically on the platform belt OR any busy state.
  // The busy term keeps the turntable blocked across the whole receive→discharge
  // cycle; the surface term covers a good lingering on an otherwise-idle platform.
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

/** Calibrate the belt's neutral discharge angle once (geometric constant). */
const calibrateBelt = (s: TurntableState): void => {
  if (s.beltCalibrated || !s.beltNode) return;
  const reg = componentRegistry(s);
  if (!reg) return;
  const surface = reg.findInChildren<TransportSurfaceLike>(s.beltNode, 'TransportSurface');
  if (!surface) return;
  surface.getWorldDirection(s._dir);                 // world-space belt direction
  s.rv.root.getWorldQuaternion(s._quat).invert();    // world → root-local
  s._dir.applyQuaternion(s._quat);
  s.beltNeutralAngle = calibrateBeltNeutralAngle(s.driveAxis, s._dir, s.lastCommandedAngle);
  s.beltCalibrated = true;
};

const refreshTopology = (self: MaterialFlowSelf): void => {
  const s = st(self);
  s.connections = classifyConnections(s.rv.viewer, s.rv.root);
  calibrateBelt(s);
  // Re-assert the interlock so newly-attached ports get published + gated:
  // open the port we're receiving from, block everything else.
  if (self.state === 'receiving') openInputPort(s, s.selectedInputPort);
  else blockAllInputs(s);
};

const inputs = (s: TurntableState): PortConnection[] => s.connections.filter(c => c.role === 'input');
const outputs = (s: TurntableState): PortConnection[] => s.connections.filter(c => c.role === 'output');

/**
 * Free downstream candidates: drop any whose downstream root `Conveyor.Occupied`
 * is explicitly `true`. `false`/`undefined` → clear (optimistic). This is the
 * committed `freeCandidates` rule kept inline (root-only read) — Plan-196's
 * `linkOf().occupied()` adds a per-port-first lookup which would change the
 * resolved signal when a downstream per-port signal exists, so it is NOT used
 * here (parity over the unified helper).
 */
const freeOutputs = (s: TurntableState): PortConnection[] => {
  const out: PortConnection[] = [];
  for (const c of outputs(s)) {
    const sigName = `/${c.ownerRoot.name}/${CONFIG.occupiedSignal}`;
    if (s.rv.signals.get(sigName) === true) continue;
    out.push(c);
  }
  return out;
};

/** True if a part is physically on the platform belt OR at the sensor. */
const platformHasPart = (s: TurntableState): boolean =>
  (s.beltNode ? isSurfaceOccupied(s.rv.viewer, s.beltNode) : false) || s.sensorOccupied;

// ─── Shared logic (state-machine + routing) — mode-agnostic ──────────────
//
// Authored as standalone functions so they are strongly typed (the `LogicBlock`
// index signature widens args to `never[]`); `def.logic` below references them
// so the three-layer structure + DES introspection stay real. These are the
// SHARED FSM the DES path reuses (P5).

/** Enter a new state and re-publish the busy/running interlocks. */
function enter(self: MaterialFlowSelf, next: State): void {
  self.setState(next);
  publishOccupied(self);
  publishRunning(self);
}

/**
 * Idle: pick a random input with a waiting good (anti-starvation), rotate to
 * align, start receiving.
 */
function tryReceive(self: MaterialFlowSelf): void {
  const s = st(self);
  if (self.state !== 'idle') return;
  if (s.rv.signals.get<boolean>(CONFIG.runSignal) !== true) return;

  // Choose randomly among ALL waiting inputs (mirrors tryDispatch) so that when
  // several inputs have a good ready, none gets starved by deterministic order.
  const ready = inputs(s).filter(c =>
    s.rv.signals.get(`/${c.ownerRoot.name}/${CONFIG.occupiedSignal}`) === true);
  if (ready.length === 0) return;
  const waiting = ready[Math.floor(Math.random() * ready.length)];

  s.selectedInputPort = waiting.snap.id;
  const target = alignToInputAngle(s.driveAxis, s.beltNeutralAngle, waiting.snap.object3D, s.lastCommandedAngle);
  setBelt(s, false);                 // STOP belt before rotation
  s.drive.moveTo(target);
  s.lastCommandedAngle = target;
  enter(self, 'aligning_in');
}

/** A good is on the platform: pick a free output and rotate, else HOLD. */
function tryDispatch(self: MaterialFlowSelf): void {
  const s = st(self);
  if (s.rv.signals.get<boolean>(CONFIG.runSignal) !== true) { setBelt(s, false); enter(self, 'holding'); return; }
  const candidates = freeOutputs(s);
  if (candidates.length === 0) { setBelt(s, false); enter(self, 'holding'); return; }

  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  const target = dispatchToOutputAngle(s.driveAxis, s.beltNeutralAngle, chosen.snap.object3D, s.lastCommandedAngle);
  setBelt(s, false);                 // STOP belt before rotation
  s.drive.moveTo(target);
  s.lastCommandedAngle = target;
  enter(self, 'rotating_out');
}

/** Sensor rising while RECEIVING — good captured, re-block all inputs, dispatch. */
function onPartAtCenter(self: MaterialFlowSelf): void {
  const s = st(self);
  blockAllInputs(s);
  s.selectedInputPort = null;
  tryDispatch(self);
}

/** Rotary drive reached its commanded angle — advance the aligning/dispatch state. */
function onRotationDone(self: MaterialFlowSelf): void {
  const s = st(self);
  if (self.state === 'aligning_in') {
    enter(self, 'receiving');
    openInputPort(s, s.selectedInputPort);           // let the selected input feed
    setBelt(s, true);                                // run belt to pull the good in
  } else if (self.state === 'rotating_out') {
    setBelt(s, true);                                // belt runs to discharge
    enter(self, 'discharging');
  }
}

/** Discharge dwell elapsed — belt off, re-idle and re-scan for inputs. */
function finishCycle(self: MaterialFlowSelf): void {
  setBelt(st(self), false);
  enter(self, 'idle');
}

/**
 * Recover to idle when the platform has unexpectedly emptied (a part it was
 * carrying was deleted or fell off). Without this the busy state latches
 * `Occupied=true` and keeps every input blocked forever; a conveyor frees the
 * instant its surface clears, so the turntable must too.
 */
function abortToIdle(self: MaterialFlowSelf): void {
  const s = st(self);
  s.drive.stop();
  setBelt(s, false);
  blockAllInputs(s);
  s.selectedInputPort = null;
  s.emptyFor = 0;
  enter(self, 'idle');
}

// ─── Definition (registers into the material-flow registry for DES) ──────

const def = defineMaterialFlow({
  type: 'Turntable',
  kind: 'router',
  models: ['*Turntable*'],
  schema: {},

  // Mode-agnostic state-machine + routing (identical decisions across modes).
  logic: { enter, tryReceive, tryDispatch, onPartAtCenter, onRotationDone, finishCycle, abortToIdle },

  // ── Continuous adapter — PUBLIC default path (60 Hz, after transport.update) ──
  continuous: {
    setup(self: MaterialFlowSelf): void {
      const s = st(self);

      // ─── Signals ─────────────────────────────────────────────────────
      self.signal(CONFIG.runSignal,       { type: 'PLCInputBool',  initialValue: true });
      self.signal(CONFIG.occupiedSignal,  { type: 'PLCOutputBool', initialValue: false });
      self.signal(CONFIG.runningSignal,   { type: 'PLCOutputBool', initialValue: false });
      self.signal(CONFIG.partCountSignal, { type: 'PLCOutputInt',  initialValue: 0 });
      // Per-input-port interlocks (keyed by stable snap id) default to BLOCKED
      // (true) — a port only opens while the turntable is actively receiving from
      // it. Published up front (best-effort; re-asserted every refresh) so an
      // upstream conveyor reads the per-port signal rather than the root fallback.
      for (const sp of listOwnSnaps(s.rv.viewer, s.rv.root)) s.rv.signals.set(portOccupiedSignal(sp.id), true);

      // ─── Calibrate / classify once up-front (B2/B3: nothing left lazy) ──
      // Init of selectedInputPort=null + beltNeutralAngle calibration happen
      // here (not on the first lazy tick) so the DES path — which never runs the
      // continuous fixedUpdate — still has a valid neutral angle and port state.
      s.connections = classifyConnections(s.rv.viewer, s.rv.root);
      calibrateBelt(s);

      // ─── Sensor edge handler ─────────────────────────────────────────
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
            // Good captured — block every input so nothing else feeds, then dispatch.
            onPartAtCenter(self);
          }
        } else if (self.state === 'discharging') {
          // Sensor cleared, but the good may still be partly on the platform.
          // Keep the belt running for a dwell so it fully leaves before re-idling.
          s.clearTimer = CONFIG.dischargeClearSec;
          enter(self, 'discharge_clearing');
        }
      });

      // ─── Operator context menu (right-click the rotary node) ──────────
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

      // Re-publish surface-based occupancy every tick so a good arriving on /
      // leaving the platform updates the interlock between state-machine edges.
      publishOccupied(self);

      s.refreshTimer += dt;
      if (s.refreshTimer >= CONFIG.neighborRefreshSec) {
        s.refreshTimer = 0;
        refreshTopology(self);
        if (self.state === 'idle') tryReceive(self);                          // poll inputs for a waiting good
        else if (self.state === 'holding' && s.sensorOccupied) tryDispatch(self); // retry now an output may be free
      }

      // Platform-empty watchdog: free the turntable if a part it was carrying has
      // physically vanished (deleted by the user, fell off). Skipped in `idle`
      // (nothing to free) and `aligning_in` (platform legitimately empty while the
      // part is still on the feeder, rotating to meet it). The grace exceeds the
      // discharge-clear dwell, so a NORMAL discharge always re-idles on its own first.
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

      // Belt control + state transitions driven by drive.isAtTarget.
      switch (self.state as State) {
        case 'idle':
          setBelt(s, false);                              // nothing feeds until we align+open a port
          break;
        case 'aligning_in':
          if (driveAtTarget(s)) onRotationDone(self);     // → RECEIVING (port opened, belt on)
          break;
        case 'receiving':
          setBelt(s, true);                               // keep pulling until sensor rising (see signals.on)
          break;
        case 'holding':
          setBelt(s, false);                              // good waits on the platform for a free output
          break;
        case 'rotating_out':
          if (driveAtTarget(s)) onRotationDone(self);     // → DISCHARGING (belt on)
          break;
        case 'discharging':
          // Belt keeps running; transition is sensor-driven (see signals.on).
          break;
        case 'discharge_clearing':
          setBelt(s, true);                               // keep conveying until the good is fully off
          s.clearTimer -= dt;
          if (s.clearTimer <= 0) finishCycle(self);       // good has left — belt off, re-idle
          break;
      }
    },
  },

  // ── DES adapter — router (event-driven path, private DESRunner, P5) ──
  // INERT until P5 (registered only). The shared `logic` FSM above is reused;
  // only the trigger (events) and effect (time, no physical drive) differ.
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

// ─── Default export: a Behavior so glob discovery (behaviors.ts) finds it ──
//
// A hand-written bind (rather than the generic `toBehavior` shim) so the
// continuous blocks get the bind context they need (rv.viewer for
// surface-occupancy + classifyConnections, rv.behavior for the marker stamp,
// the resolved drive/belt/sensor handles) via per-instance state, while still
// driving the SAME `def.continuous.setup/fixedUpdate` methods that
// `defineMaterialFlow` registered for DES.
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

    // Drive/belt lookups are DEFERRED via the lazy handles — even if a drive
    // isn't registered at bind-time (load-order race, HMR replay, late
    // convention pass) we still proceed; the handle resolves on first use and
    // no-ops until then (same retry semantics as the committed implementation).
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

    // alignedPort/selectedOutput init for the DES router (B2) — kept on the
    // snapshot-safe prop bag so a pure-DES run never reads `undefined`.
    self.prop['alignedPort'] = null;
    self.prop['selectedOutput'] = null;

    def.continuous.setup!(self);
    const fixed = def.continuous.fixedUpdate;
    if (fixed) rv.onFixedUpdate((dt: number) => fixed(self, dt));
    rv.onDispose(() => _state.delete(self));
  },
};

export default TurntableBehavior;
