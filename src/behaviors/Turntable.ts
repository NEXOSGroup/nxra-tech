// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Turntable — belt-aware snap-graph dispatcher with DIRECTION-classified ports.
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
import { defineBehavior } from '../core/behaviors';
import { findRotaryDrive, findSensor, findTransport } from '../core/library-component-loader';
import { registerCapabilities } from '../core/engine/rv-component-registry';
import { classifyConnections, listOwnSnaps, type PortConnection } from './_shared/snap-graph-helpers';
import { alignToInputAngle, dispatchToOutputAngle, calibrateBeltNeutralAngle } from './_shared/turntable-angle-math';
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
  | 'discharging'
  | 'discharge_clearing';

/**
 * Per-port occupied signal name (instance-scoped), keyed by the STABLE snap id
 * (Object3D uuid). The node name is NOT used — glTF turntable ports share names
 * like `Snap-ZP`/`Snap-ZN`; the id is unique and is the same object both the
 * turntable and the connected conveyor resolve, so the two always agree.
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

/**
 * Free downstream candidates: drop any whose downstream root `Conveyor.Occupied`
 * is explicitly `true`. `false`/`undefined` → clear (optimistic).
 */
export function freeCandidates<T extends { ownerRoot: Object3D }>(
  items: ReadonlyArray<T>,
  readSignal: (name: string) => boolean | number | undefined,
): T[] {
  const out: T[] = [];
  for (const p of items) {
    const sigName = `/${p.ownerRoot.name}/${CONFIG.occupiedSignal}`;
    if (readSignal(sigName) === true) continue;
    out.push(p);
  }
  return out;
}

// Minimal structural views of the host registry + transport surface (no import
// cycle, no `any`).
interface ComponentRegistryShape {
  findInChildren<T = unknown>(node: Object3D, type: string): T | null;
}
interface TransportSurfaceLike {
  getWorldDirection(out?: Vector3): Vector3;
}

export default defineBehavior({
  models: ['*Turntable*'],

  bind(rv) {
    const rootTag = rv.root.name || '<unnamed>';
    const rotaryNode = findRotaryDrive(rv.root);
    const sensorNode = findSensor(rv.root);
    const beltNode = findTransport(rv.root);
    if (!rotaryNode) { console.warn(`[Turntable:${rootTag}] no Drive-Rot-* node found`); return; }
    if (!sensorNode) { console.warn(`[Turntable:${rootTag}] no Sensor node found`); return; }
    if (!beltNode)   console.warn(`[Turntable:${rootTag}] no Transport-* node found — belt stop/start will be a no-op`);

    let drive = rv.drives.get(rotaryNode);
    let belt = beltNode ? rv.drives.get(beltNode) : null;
    if (!drive) console.warn(`[Turntable:${rootTag}] rotary drive "${rotaryNode.name}" not yet in viewer.drives — will retry`);
    if (beltNode && !belt) console.warn(`[Turntable:${rootTag}] belt drive "${beltNode.name}" not yet in viewer.drives — will retry`);

    console.info(`[Turntable:${rootTag}] attached — drive "${rotaryNode.name}", sensor "${sensorNode.name}"${beltNode ? `, belt "${beltNode.name}"` : ''}`);

    const driveAxis = axisFromDriveNodeName(rotaryNode.name);

    rv.behavior(rv.root, 'TurntableBehavior', {
      Drive: rotaryNode.name,
      Sensor: sensorNode.name,
      ...(beltNode ? { Belt: beltNode.name } : {}),
    });

    // ─── Signals ─────────────────────────────────────────────────────
    rv.signal(CONFIG.runSignal,       { type: 'PLCInputBool',  initialValue: true });
    rv.signal(CONFIG.occupiedSignal,  { type: 'PLCOutputBool', initialValue: false });
    rv.signal(CONFIG.runningSignal,   { type: 'PLCOutputBool', initialValue: false });
    rv.signal(CONFIG.partCountSignal, { type: 'PLCOutputInt',  initialValue: 0 });
    // Per-input-port interlocks (keyed by stable snap id) default to BLOCKED
    // (true) — a port only opens while the turntable is actively receiving from
    // it. Published up front (best-effort; re-asserted every refresh) so an
    // upstream conveyor reads the per-port signal rather than the root fallback.
    for (const sp of listOwnSnaps(rv.viewer, rv.root)) rv.signals.set(portOccupiedSignal(sp.id), true);

    // ─── State ───────────────────────────────────────────────────────
    let state: State = 'idle';
    let sensorOccupied = false;
    let partCount = 0;
    let lastCommandedAngle = 0;       // monotonic — never wrapped
    let clearTimer = 0;               // counts down the discharge-clear dwell (seconds)
    let connections: PortConnection[] = [];
    let selectedInputPort: string | null = null;
    let beltNeutralAngle = 0;
    let beltCalibrated = false;
    let refreshTimer: number = CONFIG.neighborRefreshSec;
    let emptyFor = 0;                 // seconds the platform has been empty in a part-carrying state

    // Scratch (no per-tick allocation).
    const _dir = new Vector3();
    const _quat = new Quaternion();

    // ─── Helpers ─────────────────────────────────────────────────────
    const setBelt = (forward: boolean): void => {
      if (!belt) return;
      belt.jogForward = forward;
      belt.jogBackward = false;
    };
    const blockAllInputs = (): void => {
      for (const c of connections) rv.signals.set(portOccupiedSignal(c.snap.id), true);
    };
    /** Open exactly one input port (false = free to feed); block the rest. */
    const openInputPort = (openId: string | null): void => {
      for (const c of connections) rv.signals.set(portOccupiedSignal(c.snap.id), c.snap.id !== openId);
    };
    const publishOccupied = (): void => {
      // Surface-based: a good physically on the platform belt OR any busy state.
      // The busy term keeps the turntable blocked across the whole receive→discharge
      // cycle; the surface term covers a good lingering on an otherwise-idle platform.
      const platformOccupied = beltNode ? isSurfaceOccupied(rv.viewer, beltNode) : sensorOccupied;
      rv.signals.set(CONFIG.occupiedSignal, platformOccupied || state !== 'idle');
    };
    const publishRunning = (): void => {
      rv.signals.set(CONFIG.runningSignal, state !== 'idle');
    };
    const enterState = (next: State): void => {
      state = next;
      publishOccupied();
      publishRunning();
    };
    const driveAtTarget = (): boolean => !!drive && drive.isAtTarget === true;

    const componentRegistry = (): ComponentRegistryShape | null => {
      const r = (rv.viewer as { registry?: unknown }).registry as Partial<ComponentRegistryShape> | undefined | null;
      return r && typeof r.findInChildren === 'function' ? (r as ComponentRegistryShape) : null;
    };

    /** Calibrate the belt's neutral discharge angle once (geometric constant). */
    const calibrateBelt = (): void => {
      if (beltCalibrated || !beltNode) return;
      const reg = componentRegistry();
      if (!reg) return;
      const surface = reg.findInChildren<TransportSurfaceLike>(beltNode, 'TransportSurface');
      if (!surface) return;
      surface.getWorldDirection(_dir);                 // world-space belt direction
      rv.root.getWorldQuaternion(_quat).invert();      // world → root-local
      _dir.applyQuaternion(_quat);
      beltNeutralAngle = calibrateBeltNeutralAngle(driveAxis, _dir, lastCommandedAngle);
      beltCalibrated = true;
    };

    const refreshTopology = (): void => {
      connections = classifyConnections(rv.viewer, rv.root);
      if (!drive) drive = rv.drives.get(rotaryNode);
      if (beltNode && !belt) belt = rv.drives.get(beltNode);
      calibrateBelt();
      // Re-assert the interlock so newly-attached ports get published + gated:
      // open the port we're receiving from, block everything else.
      if (state === 'receiving') openInputPort(selectedInputPort);
      else blockAllInputs();
    };

    const inputs = (): PortConnection[] => connections.filter(c => c.role === 'input');
    const outputs = (): PortConnection[] => connections.filter(c => c.role === 'output');

    /** Idle: pick a random input with a waiting good, rotate to align, start receiving. */
    const tryReceive = (): void => {
      if (state !== 'idle') return;
      if (rv.signals.get<boolean>(CONFIG.runSignal) !== true) return;

      // Choose randomly among ALL waiting inputs (mirrors tryDispatch) so that when
      // several inputs have a good ready, none gets starved by deterministic order.
      const ready = inputs().filter(c =>
        rv.signals.get(`/${c.ownerRoot.name}/${CONFIG.occupiedSignal}`) === true);
      if (ready.length === 0) return;
      const waiting = ready[Math.floor(Math.random() * ready.length)];

      selectedInputPort = waiting.snap.id;
      const target = alignToInputAngle(driveAxis, beltNeutralAngle, waiting.snap.object3D, lastCommandedAngle);
      setBelt(false);                 // STOP belt before rotation
      if (drive) drive.moveTo(target);
      lastCommandedAngle = target;
      enterState('aligning_in');
    };

    /** A good is on the platform: pick a free output and rotate, else HOLD. */
    const tryDispatch = (): void => {
      if (rv.signals.get<boolean>(CONFIG.runSignal) !== true) { setBelt(false); enterState('holding'); return; }
      const candidates = freeCandidates(outputs(), (n) => rv.signals.get(n));
      if (candidates.length === 0) { setBelt(false); enterState('holding'); return; }

      const chosen = candidates[Math.floor(Math.random() * candidates.length)];
      const target = dispatchToOutputAngle(driveAxis, beltNeutralAngle, chosen.snap.object3D, lastCommandedAngle);
      setBelt(false);                 // STOP belt before rotation
      if (drive) drive.moveTo(target);
      lastCommandedAngle = target;
      enterState('rotating_out');
    };

    /** Discharge dwell elapsed — belt off, re-idle and re-scan for inputs. */
    const finishCycle = (): void => {
      setBelt(false);
      enterState('idle');
    };

    /** True if a part is physically on the platform belt OR at the sensor. */
    const platformHasPart = (): boolean =>
      (beltNode ? isSurfaceOccupied(rv.viewer, beltNode) : false) || sensorOccupied;

    /** Recover to idle when the platform has unexpectedly emptied (a part it was
     *  carrying was deleted or fell off). Without this the busy state latches
     *  `Occupied=true` and keeps every input blocked forever; a conveyor frees
     *  the instant its surface clears, so the turntable must too. */
    const abortToIdle = (): void => {
      if (drive) drive.stop();
      setBelt(false);
      blockAllInputs();
      selectedInputPort = null;
      emptyFor = 0;
      enterState('idle');
    };

    // ─── Sensor edge handler ─────────────────────────────────────────
    rv.signals.on(sensorNode.name, (v) => {
      const present = v === true;
      if (present && !sensorOccupied) {
        partCount += 1;
        rv.signals.set(CONFIG.partCountSignal, partCount);
      }
      sensorOccupied = present;
      publishOccupied();

      if (present) {
        if (state === 'receiving') {
          // Good captured — block every input so nothing else feeds, then dispatch.
          blockAllInputs();
          selectedInputPort = null;
          tryDispatch();
        }
      } else if (state === 'discharging') {
        // Sensor cleared, but the good may still be partly on the platform.
        // Keep the belt running for a dwell so it fully leaves before re-idling.
        clearTimer = CONFIG.dischargeClearSec;
        enterState('discharge_clearing');
      }
    });

    // ─── Per-tick loop ───────────────────────────────────────────────
    rv.onFixedUpdate((dt) => {
      // Re-publish surface-based occupancy every tick so a good arriving on / leaving
      // the platform updates the interlock between state-machine edges.
      publishOccupied();

      refreshTimer += dt;
      if (refreshTimer >= CONFIG.neighborRefreshSec) {
        refreshTimer = 0;
        refreshTopology();
        if (state === 'idle') tryReceive();                          // poll inputs for a waiting good
        else if (state === 'holding' && sensorOccupied) tryDispatch(); // retry now an output may be free
      }

      // Platform-empty watchdog: free the turntable if a part it was carrying has
      // physically vanished (deleted by the user, fell off). Skipped in `idle`
      // (nothing to free) and `aligning_in` (platform legitimately empty while the
      // part is still on the feeder, rotating to meet it). The grace exceeds the
      // discharge-clear dwell, so a NORMAL discharge always re-idles on its own first.
      if (state !== 'idle' && state !== 'aligning_in') {
        if (!platformHasPart()) {
          emptyFor += dt;
          if (emptyFor >= CONFIG.emptyResetSec) abortToIdle();
        } else {
          emptyFor = 0;
        }
      } else {
        emptyFor = 0;
      }

      // Belt control + state transitions driven by drive.isAtTarget.
      switch (state) {
        case 'idle':
          setBelt(false);                               // nothing feeds until we align+open a port
          break;
        case 'aligning_in':
          if (driveAtTarget()) {
            enterState('receiving');
            openInputPort(selectedInputPort);           // let the selected input feed
            setBelt(true);                              // run belt to pull the good in
          }
          break;
        case 'receiving':
          setBelt(true);                                // keep pulling until sensor rising (see signals.on)
          break;
        case 'holding':
          setBelt(false);                               // good waits on the platform for a free output
          break;
        case 'rotating_out':
          if (driveAtTarget()) {
            setBelt(true);                              // belt runs to discharge
            enterState('discharging');
          }
          break;
        case 'discharging':
          // Belt keeps running; transition is sensor-driven (see signals.on).
          break;
        case 'discharge_clearing':
          setBelt(true);                                // keep conveying until the good is fully off
          clearTimer -= dt;
          if (clearTimer <= 0) finishCycle();           // good has left — belt off, re-idle
          break;
      }
    });

    rv.contextMenu(rotaryNode, [
      {
        id: 'reset', label: 'Reset',
        action: () => {
          if (drive) drive.stop();
          setBelt(false);
          blockAllInputs();
          selectedInputPort = null;
          enterState('idle');
        },
      },
    ]);
  },
});
