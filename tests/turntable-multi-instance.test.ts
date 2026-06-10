// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Multi-turntable independence — two placed turntables sharing ONE signal store
 * must not cross-talk. Each instance is a LayoutObject (distinct root name), so
 * its signals are scoped (`Turntable/…` vs `Turntable_2/…`) and its drive is
 * resolved by node identity. Driving one table must leave the other idle.
 *
 * Regression guard for the "only the first one works / they interfere" symptom.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Object3D } from 'three';
import {
  createBindContext,
  iterateFixedUpdate,
  type BindContextHost,
  type KinematicsSpec,
} from '../src/core/behavior-runtime';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import Turntable from '../src/behaviors/Turntable';
import type { SnapLite } from '../src/behaviors/_shared/snap-graph-helpers';

const DT = 1 / 60;

/** One shared signal store + event bus for the whole (multi-instance) scene. */
function makeScene() {
  const subs = new Map<string, Set<(v: boolean | number) => void>>();
  const values = new Map<string, boolean | number>();
  const signalStore = {
    get: (n: string) => values.get(n),
    set: (n: string, v: boolean | number) => { values.set(n, v); subs.get(n)?.forEach(cb => cb(v)); },
    subscribe: (n: string, cb: (v: boolean | number) => void) => {
      let s = subs.get(n); if (!s) { s = new Set(); subs.set(n, s); }
      s.add(cb); return () => { s!.delete(cb); };
    },
  };
  const events = new EventEmitter<Record<string, unknown>>();
  const drives: BindContextHost['drives'] = [];
  const snapList: SnapLite[] = [];

  const host: BindContextHost = {
    signalStore,
    on: (event, cb) => events.on(event, cb as never),
    contextMenu: new ContextMenuStore(),
    drives,
    registry: null,                                  // no component registry → flow fallback
    getPlugin: (id: string) => id === 'snap-point' ? {
      getRegistry: () => {
        const byOwner = new Map<Object3D, SnapLite[]>();
        for (const s of snapList) { const l = byOwner.get(s.ownerRoot) ?? []; l.push(s); byOwner.set(s.ownerRoot, l); }
        const byId = new Map(snapList.map(s => [s.id, s]));
        return { getByOwnerRoot: (r: Object3D) => byOwner.get(r) ?? [], getById: (id: string) => byId.get(id) };
      },
    } : undefined,
  };
  return { signalStore, host, drives, snapList };
}

/** Build + bind one turntable (a LayoutObject named `name`) into the shared scene. */
function addTurntable(scene: ReturnType<typeof makeScene>, name: string, tag: string) {
  const root = new Object3D(); root.name = name;
  root.userData.realvirtual = { LayoutObject: { Label: name, CatalogId: 'c', Locked: false } };
  const driveNode = new Object3D(); driveNode.name = 'Drive-Rot-Y'; root.add(driveNode);
  const beltNode = new Object3D(); beltNode.name = 'Transport-Z'; driveNode.add(beltNode);
  const sensorNode = new Object3D(); sensorNode.name = 'Sensor'; root.add(sensorNode);

  // One input port + one output port (authored flow → classification fallback).
  const inPort = new Object3D(); inPort.name = 'Snap-ZN'; inPort.position.set(-1, 0, 0); root.add(inPort);
  const outPort = new Object3D(); outPort.name = 'Snap-ZP'; outPort.position.set(1, 0, 0); root.add(outPort);
  const infeed = new Object3D(); infeed.name = `Infeed_${tag}`;
  infeed.userData.realvirtual = { LayoutObject: { Label: infeed.name, CatalogId: 'c', Locked: false } };
  const downstream = new Object3D(); downstream.name = `Conv_${tag}`;
  downstream.userData.realvirtual = { LayoutObject: { Label: downstream.name, CatalogId: 'c', Locked: false } };

  scene.snapList.push(
    { id: `${tag}-in`,  object3D: inPort,  flow: 'in',  pairedSnapId: `${tag}-infeed`, ownerRoot: root },
    { id: `${tag}-infeed`, object3D: new Object3D(), flow: 'out', pairedSnapId: `${tag}-in`, ownerRoot: infeed },
    { id: `${tag}-out`, object3D: outPort, flow: 'out', pairedSnapId: `${tag}-down`,   ownerRoot: root },
    { id: `${tag}-down`, object3D: new Object3D(), flow: 'in', pairedSnapId: `${tag}-out`, ownerRoot: downstream },
  );

  const rotary = {
    name: 'Drive-Rot-Y', node: driveNode, TargetSpeed: 90, targetPosition: 0,
    running: false, isAtTarget: true,
    startMove(d?: number) { if (d !== undefined) this.targetPosition = d; this.running = true; this.isAtTarget = false; },
    stop() { this.running = false; },
  };
  const belt = {
    name: 'Transport-Z', node: beltNode, TargetSpeed: 100, jogForward: false, jogBackward: false,
    startMove() {}, stop() { this.jogForward = false; this.jogBackward = false; },
  };
  scene.drives.push(rotary, belt);

  const accum: KinematicsSpec = {};
  const { ctx, handle } = createBindContext(root, scene.host, accum);
  Turntable.bind(ctx);
  return { root, name, tag, infeed, downstream, rotary, belt, handle };
}

describe('Turntable — multiple instances are independent', () => {
  beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('driving turntable #1 leaves turntable #2 idle (no signal cross-talk, distinct drives)', () => {
    const scene = makeScene();
    const t1 = addTurntable(scene, 'Turntable', 't1');
    const t2 = addTurntable(scene, 'Turntable_2', 't2');

    const s = scene.signalStore;
    // Both tables enabled; downstream of t1 is free.
    s.set('Turntable/Flow.Run', true);
    s.set('Turntable_2/Flow.Run', true);
    s.set('Conv_t1/Flow.Occupied', false);

    // A good waits ONLY at turntable #1's infeed.
    s.set('Infeed_t1/Flow.Occupied', true);

    iterateFixedUpdate(t1.handle, DT);                 // t1: refresh → tryReceive → ALIGNING_IN
    iterateFixedUpdate(t2.handle, DT);                 // t2: should stay idle

    // t1 reacts.
    expect(t1.rotary.running).toBe(true);
    expect(s.get('Turntable/Flow.Occupied')).toBe(true);

    // t2 is untouched — its own drive never moved, its signals stayed idle.
    expect(t2.rotary.running).toBe(false);
    expect(s.get('Turntable_2/Flow.Occupied')).not.toBe(true);
    expect(s.get('Turntable_2/Flow.Running')).not.toBe(true);

    // Complete t1's receive and verify ONLY t1's input port opens (scoped by id).
    t1.rotary.isAtTarget = true;
    iterateFixedUpdate(t1.handle, DT);                 // → RECEIVING, opens t1-in
    expect(s.get('Turntable/Flow.Occupied@t1-in')).toBe(false);   // t1's port open
    expect(s.get('Turntable_2/Flow.Occupied@t2-in')).toBe(true);  // t2's port still blocked
    expect(t2.rotary.running).toBe(false);                            // t2 still idle
  });
});
