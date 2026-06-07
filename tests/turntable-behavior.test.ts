// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Object3D } from 'three';
import {
  createBindContext,
  iterateFixedUpdate,
  applyKinematicsSpec,
  type BindContextHost,
  type KinematicsSpec,
} from '../src/core/behavior-runtime';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import { getCapabilities } from '../src/core/engine/rv-component-registry';
import Turntable, { freeCandidates } from '../src/behaviors/Turntable';
import { matchesAny } from '../src/core/behaviors';
import type { SnapLite } from '../src/behaviors/_shared/snap-graph-helpers';

const DT = 1 / 60;
/** Advance the fixed loop by `secs` (≥ one neighbour-refresh window when secs ≥ 0.5). */
function pump(handle: ReturnType<typeof createBindContext>['handle'], secs: number): void {
  for (let t = 0; t < secs; t += DT) iterateFixedUpdate(handle, DT);
}

interface FakeRotaryDrive {
  name: string;
  node: Object3D;
  TargetSpeed: number;
  targetPosition: number;
  running: boolean;
  isAtTarget: boolean;
  startMove(d?: number): void;
  stop(): void;
}
interface FakeBeltDrive {
  name: string;
  node: Object3D;
  TargetSpeed: number;
  jogForward: boolean;
  jogBackward: boolean;
  startMove(d?: number): void;
  stop(): void;
}

/**
 * Build a turntable with `inputs` paired infeed conveyors and `downstreams`
 * paired output conveyors. Ports are bidirectional; with NO component registry,
 * `classifyConnections` falls back to the authored snap flow (in → input,
 * out → output) — which is what these state-machine tests exercise.
 */
function setup(opts?: { inputs?: number; downstreams?: number; missingBelt?: boolean }) {
  const nInputs = opts?.inputs ?? 1;
  const nOutputs = opts?.downstreams ?? 3;

  const signalSubs = new Map<string, Set<(v: boolean | number) => void>>();
  const values = new Map<string, boolean | number>();
  const signalStore = {
    get: (n: string) => values.get(n),
    set: (n: string, v: boolean | number) => {
      values.set(n, v);
      signalSubs.get(n)?.forEach((cb) => cb(v));
    },
    subscribe: (n: string, cb: (v: boolean | number) => void) => {
      let s = signalSubs.get(n); if (!s) { s = new Set(); signalSubs.set(n, s); }
      s.add(cb); return () => { s!.delete(cb); };
    },
  };
  const events = new EventEmitter<Record<string, unknown>>();

  // ── Turntable: root → Drive-Rot-Y → Transport-Z; root → Sensor; root → ports ──
  // No LayoutObject marker → behavior signals stay UNSCOPED in tests.
  const root = new Object3D(); root.name = 'Turntable';
  const driveNode = new Object3D(); driveNode.name = 'Drive-Rot-Y'; root.add(driveNode);
  const beltNode = new Object3D(); beltNode.name = 'Transport-Z'; driveNode.add(beltNode);
  const sensorNode = new Object3D(); sensorNode.name = 'Sensor'; root.add(sensorNode);

  const snapList: SnapLite[] = [];
  const infeedRoots: Object3D[] = [];
  const downstreamRoots: Object3D[] = [];

  // Inputs (infeed conveyors feeding the turntable). NOTE: node names are
  // intentionally NON-unique (`Snap-ZN`) — the interlock keys off the snap id.
  for (let i = 0; i < nInputs; i++) {
    const portNode = new Object3D(); portNode.name = 'Snap-ZN'; portNode.position.set(-1, 0, i); root.add(portNode);
    const infeed = new Object3D(); infeed.name = `Infeed${i}`;
    infeed.userData.realvirtual = { LayoutObject: { Label: `Infeed${i}`, CatalogId: 'c', Locked: false } };
    infeedRoots.push(infeed);
    snapList.push({ id: `tt-in${i}`, object3D: portNode, flow: 'in', pairedSnapId: `in${i}-out`, ownerRoot: root });
    snapList.push({ id: `in${i}-out`, object3D: new Object3D(), flow: 'out', pairedSnapId: `tt-in${i}`, ownerRoot: infeed });
  }

  // Outputs (downstream conveyors fed by the turntable).
  const angles = [90, 180, 270];
  for (let i = 0; i < nOutputs; i++) {
    const angRad = (angles[i % angles.length] * Math.PI) / 180;
    const portNode = new Object3D();
    portNode.name = 'Snap-ZP';                       // non-unique node name (shared across outputs)
    portNode.position.set(Math.cos(angRad), 0, Math.sin(angRad));
    root.add(portNode);

    const downRoot = new Object3D(); downRoot.name = `Conv${i}`;
    downRoot.userData.realvirtual = { LayoutObject: { Label: `Conv${i}`, CatalogId: 'c', Locked: false } };
    downstreamRoots.push(downRoot);

    snapList.push({ id: `tt-out${i}`, object3D: portNode, flow: 'out', pairedSnapId: `c${i}-in`, ownerRoot: root });
    snapList.push({ id: `c${i}-in`, object3D: new Object3D(), flow: 'in', pairedSnapId: `tt-out${i}`, ownerRoot: downRoot });
  }

  const byOwner = new Map<Object3D, SnapLite[]>();
  for (const s of snapList) {
    const list = byOwner.get(s.ownerRoot) ?? []; list.push(s); byOwner.set(s.ownerRoot, list);
  }
  const byId = new Map(snapList.map(s => [s.id, s]));
  const snapPlugin = {
    getRegistry: () => ({
      getByOwnerRoot: (r: Object3D) => byOwner.get(r) ?? [],
      getById: (id: string) => byId.get(id),
    }),
  };

  const rotary: FakeRotaryDrive = {
    name: 'Drive-Rot-Y',
    node: driveNode,
    TargetSpeed: 90,
    targetPosition: 0,
    running: false,
    isAtTarget: true,                              // start AT target (idle)
    startMove(d?: number) { if (d !== undefined) this.targetPosition = d; this.running = true; this.isAtTarget = false; },
    stop() { this.running = false; },
  };
  const belt: FakeBeltDrive = {
    name: 'Transport-Z',
    node: beltNode,
    TargetSpeed: 100,
    jogForward: false,
    jogBackward: false,
    startMove() {},
    stop() { this.jogForward = false; this.jogBackward = false; },
  };

  const host: BindContextHost = {
    signalStore,
    on: (event, cb) => events.on(event, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: opts?.missingBelt ? [rotary] : [rotary, belt],
    registry: null,                                // no component registry → flow fallback
    getPlugin: (id: string) => (id === 'snap-point' ? snapPlugin : undefined),
  };

  const accum: KinematicsSpec = {};
  const { ctx, handle } = createBindContext(root, host, accum);
  Turntable.bind(ctx);

  // Convenience helpers for the common signal names.
  const setInputWaiting = (i: number, v: boolean) => signalStore.set(`Infeed${i}/Conveyor.Occupied`, v);
  // Per-port interlock is keyed by the snap id (e.g. 'tt-in0', 'tt-out1').
  const portOcc = (portId: string) => signalStore.get(`Conveyor.Occupied@${portId}`);

  return { signalStore, rotary, belt, handle, root, accum, infeedRoots, downstreamRoots, setInputWaiting, portOcc };
}

/** Drive the turntable from idle through ALIGNING_IN → RECEIVING for input `i`. */
function receiveFromInput(s: ReturnType<typeof setup>, i = 0): void {
  s.signalStore.set('Conveyor.Run', true);
  s.setInputWaiting(i, true);                       // a good waits at the infeed
  iterateFixedUpdate(s.handle, DT);                 // refresh → tryReceive → ALIGNING_IN
  s.rotary.isAtTarget = true;                       // rotation to the input completes
  iterateFixedUpdate(s.handle, DT);                 // → RECEIVING (port opened, belt on)
}

describe('Turntable behavior — hierarchy badge', () => {
  it('registers a TurntableBehavior badge capability', () => {
    const caps = getCapabilities('TurntableBehavior');
    expect(caps.hierarchyVisible).toBe(true);
    expect(caps.inspectorVisible).toBe(true);
    expect(caps.badgeColor).toBe('#7e57c2');
  });

  it('stamps a TurntableBehavior marker with Drive + Sensor + Belt props', () => {
    const { root, accum } = setup();
    applyKinematicsSpec(root, accum);
    const rv = root.userData.realvirtual as Record<string, unknown>;
    expect(rv.TurntableBehavior).toMatchObject({ Drive: 'Drive-Rot-Y', Sensor: 'Sensor', Belt: 'Transport-Z' });
  });
});

describe('Turntable behavior — model matching', () => {
  it('matches GLB filenames containing "Turntable"', () => {
    for (const name of ['Turntable', 'Turntable-4Way', 'CustomTurntable']) {
      expect(matchesAny(Turntable.models, name)).toBe(true);
    }
  });
  it('does not match unrelated filenames', () => {
    expect(matchesAny(Turntable.models, 'Conveyor')).toBe(false);
  });
});

describe('freeCandidates — downstream-block trichotomy', () => {
  it('drops items whose downstream Conveyor.Occupied === true', () => {
    const A = new Object3D(); A.name = 'A';
    const B = new Object3D(); B.name = 'B';
    const C = new Object3D(); C.name = 'C';
    const items = [A, B, C].map(r => ({ ownerRoot: r }));
    const sigs = new Map<string, boolean | number>([
      ['/A/Conveyor.Occupied', false],
      ['/B/Conveyor.Occupied', true],
    ]);
    const free = freeCandidates(items, n => sigs.get(n));
    expect(free.map(p => p.ownerRoot)).toEqual([A, C]);
  });
});

describe('Turntable behavior — multi-input cycle', () => {
  beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('IDLE: belt stopped while empty, even with Run=true (nothing feeds until a port opens)', () => {
    const { signalStore, belt, handle } = setup({ downstreams: 1 });
    signalStore.set('Conveyor.Run', true);
    iterateFixedUpdate(handle, DT);
    expect(belt.jogForward).toBe(false);
    expect(signalStore.get('Conveyor.Occupied')).not.toBe(true);
    expect(signalStore.get('Conveyor.Running')).not.toBe(true);
  });

  it('a waiting input → ALIGNING_IN: rotation commanded, belt stopped, busy', () => {
    const { signalStore, rotary, belt, handle, setInputWaiting } = setup({ downstreams: 1 });
    signalStore.set('Conveyor.Run', true);
    setInputWaiting(0, true);
    iterateFixedUpdate(handle, DT);                 // refresh → tryReceive
    expect(rotary.running).toBe(true);              // rotation to the input commanded
    expect(rotary.isAtTarget).toBe(false);
    expect(belt.jogForward).toBe(false);            // belt stopped while rotating
    expect(signalStore.get('Conveyor.Occupied')).toBe(true);
    expect(signalStore.get('Conveyor.Running')).toBe(true);
  });

  it('aligned → RECEIVING: ONLY the selected input port opens, belt runs', () => {
    const s = setup({ inputs: 1, downstreams: 2 });
    receiveFromInput(s, 0);
    expect(s.belt.jogForward).toBe(true);                       // belt pulls the good in
    expect(s.portOcc('tt-in0')).toBe(false);                   // selected input port OPEN
    expect(s.portOcc('tt-out0')).toBe(true);                   // every other port BLOCKED
    expect(s.portOcc('tt-out1')).toBe(true);
  });

  it('sensor rising during RECEIVING → re-block all inputs, dispatch to a free output', () => {
    const s = setup({ inputs: 1, downstreams: 1 });
    receiveFromInput(s, 0);
    s.signalStore.set('Conv0/Conveyor.Occupied', false);        // output free
    s.signalStore.set('Sensor', true);                          // good captured (handler runs synchronously)
    expect(s.portOcc('tt-in0')).toBe(true);                    // input re-blocked
    expect(s.rotary.running).toBe(true);                        // dispatch rotation commanded
    expect(s.belt.jogForward).toBe(false);                      // belt stopped for the dispatch rotation
    expect(s.signalStore.get('Conveyor.PartCount')).toBe(1);
  });

  it('dispatch rotation reaches target → DISCHARGING (belt on), then dwell → IDLE', () => {
    const s = setup({ inputs: 1, downstreams: 1 });
    receiveFromInput(s, 0);
    s.signalStore.set('Conv0/Conveyor.Occupied', false);
    s.signalStore.set('Sensor', true);                          // → ROTATING_OUT
    s.rotary.isAtTarget = true;
    iterateFixedUpdate(s.handle, DT);                           // → DISCHARGING
    expect(s.belt.jogForward).toBe(true);
    expect(s.signalStore.get('Conveyor.Running')).toBe(true);

    s.signalStore.set('Sensor', false);                         // → DISCHARGE_CLEARING
    iterateFixedUpdate(s.handle, DT);
    expect(s.belt.jogForward).toBe(true);                       // belt keeps running through the dwell
    pump(s.handle, 0.66);                                       // dwell elapses → finishCycle → IDLE
    expect(s.belt.jogForward).toBe(false);
    expect(s.signalStore.get('Conveyor.Occupied')).toBe(false);
    expect(s.signalStore.get('Conveyor.Running')).toBe(false);
  });

  it('HOLDING: good captured but every output blocked → belt off; releases when one frees', () => {
    const s = setup({ inputs: 1, downstreams: 2 });
    receiveFromInput(s, 0);
    s.signalStore.set('Conv0/Conveyor.Occupied', true);
    s.signalStore.set('Conv1/Conveyor.Occupied', true);
    const alignTarget = s.rotary.targetPosition;                // angle from aligning to the input
    s.signalStore.set('Sensor', true);                          // captured, but no free output
    expect(s.rotary.targetPosition).toBe(alignTarget);          // no dispatch rotation commanded
    expect(s.belt.jogForward).toBe(false);                      // belt stopped — good waits on the platform
    expect(s.signalStore.get('Conveyor.Occupied')).toBe(true);  // still busy

    s.signalStore.set('Conv1/Conveyor.Occupied', false);        // an output frees
    pump(s.handle, 0.6);                                        // refresh tick retries dispatch
    expect(s.rotary.targetPosition).not.toBe(alignTarget);      // dispatch rotation now commanded
  });

  it('multiple inputs: a second waiting input is served on the next cycle', () => {
    const s = setup({ inputs: 2, downstreams: 1 });
    s.signalStore.set('Conv0/Conveyor.Occupied', false);
    s.signalStore.set('Conveyor.Run', true);
    s.setInputWaiting(0, true);
    s.setInputWaiting(1, true);
    iterateFixedUpdate(s.handle, DT);                           // selects input0 → ALIGNING_IN
    s.rotary.isAtTarget = true; iterateFixedUpdate(s.handle, DT); // → RECEIVING input0
    expect(s.portOcc('tt-in0')).toBe(false);                   // input0 chosen first
    expect(s.portOcc('tt-in1')).toBe(true);

    // Run input0's good all the way out.
    s.setInputWaiting(0, false);                                // input0 good has left the infeed
    s.signalStore.set('Sensor', true);                          // captured → dispatch
    s.rotary.isAtTarget = true; iterateFixedUpdate(s.handle, DT); // → DISCHARGING
    s.signalStore.set('Sensor', false);                         // → DISCHARGE_CLEARING
    pump(s.handle, 0.66);                                       // → IDLE
    expect(s.signalStore.get('Conveyor.Occupied')).toBe(false);

    // Next idle scan picks input1.
    pump(s.handle, 0.6);                                        // refresh → tryReceive selects input1
    s.rotary.isAtTarget = true; iterateFixedUpdate(s.handle, DT); // → RECEIVING input1
    expect(s.portOcc('tt-in1')).toBe(false);
    expect(s.portOcc('tt-in0')).toBe(true);
  });
});

describe('Turntable behavior — back-pressure across the cycle', () => {
  beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('Occupied is true from ALIGNING_IN through DISCHARGE_CLEARING — only clears at IDLE', () => {
    const s = setup({ inputs: 1, downstreams: 1 });
    s.signalStore.set('Conveyor.Run', true);
    s.setInputWaiting(0, true);

    iterateFixedUpdate(s.handle, DT);                           // ALIGNING_IN
    expect(s.signalStore.get('Conveyor.Occupied')).toBe(true);
    s.rotary.isAtTarget = true; iterateFixedUpdate(s.handle, DT); // RECEIVING
    expect(s.signalStore.get('Conveyor.Occupied')).toBe(true);

    s.signalStore.set('Conv0/Conveyor.Occupied', false);
    s.signalStore.set('Sensor', true);                          // ROTATING_OUT
    expect(s.signalStore.get('Conveyor.Occupied')).toBe(true);
    s.rotary.isAtTarget = true; iterateFixedUpdate(s.handle, DT); // DISCHARGING
    expect(s.signalStore.get('Conveyor.Occupied')).toBe(true);

    s.signalStore.set('Sensor', false); iterateFixedUpdate(s.handle, DT); // DISCHARGE_CLEARING
    expect(s.signalStore.get('Conveyor.Occupied')).toBe(true);
    pump(s.handle, 0.66);                                       // IDLE
    expect(s.signalStore.get('Conveyor.Occupied')).toBe(false);
  });
});

describe('Turntable behavior — works without a belt drive', () => {
  beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('binds without a belt and still rotates to align with a waiting input', () => {
    const { signalStore, rotary, handle, setInputWaiting } = setup({ downstreams: 1, missingBelt: true });
    signalStore.set('Conveyor.Run', true);
    setInputWaiting(0, true);
    iterateFixedUpdate(handle, DT);
    expect(rotary.running).toBe(true);                          // rotation still commanded
    expect(signalStore.get('Conveyor.Occupied')).toBe(true);
  });
});
