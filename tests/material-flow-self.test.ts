// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import {
  createBindContext,
  type BindContextHost,
  type KinematicsSpec,
} from '../src/core/behavior-runtime';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import { createSelf, type SelfDef, type SelfScheduler, type MU } from '../src/core/material-flow/material-flow-self';

// ─── Inline mock host (mirrors tests/conveyor-behavior.test.ts) ───────────

interface FakeDrive {
  name: string;
  node: Object3D;
  jogForward: boolean;
  jogBackward: boolean;
  TargetSpeed: number;
  startMove(d?: number): void;
  stop(): void;
}

function makeHost(opts: {
  root: Object3D;
  drives?: FakeDrive[];
  snapPlugin?: unknown;
} = { root: new Object3D() }) {
  const subs = new Map<string, Set<(v: boolean | number) => void>>();
  const values = new Map<string, boolean | number>();
  const signalStore = {
    get: (n: string) => values.get(n),
    set: (n: string, v: boolean | number) => {
      values.set(n, v);
      subs.get(n)?.forEach((cb) => cb(v));
    },
    subscribe: (n: string, cb: (v: boolean | number) => void) => {
      let s = subs.get(n);
      if (!s) { s = new Set(); subs.set(n, s); }
      s.add(cb);
      return () => { s!.delete(cb); };
    },
  };
  const events = new EventEmitter<Record<string, unknown>>();
  const host: BindContextHost = {
    signalStore,
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: (opts.drives ?? []) as never,
    registry: null,
    getPlugin: (id: string) => (id === 'snap-point' ? opts.snapPlugin : undefined),
  };
  return { host, signalStore, values };
}

const DEF: SelfDef = { type: 'Conveyor', kind: 'conveyor' };

function ctxFor(host: BindContextHost, root: Object3D) {
  const accum: KinematicsSpec = {};
  const { ctx } = createBindContext(root, host, accum);
  return ctx;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('createSelf — basic projection', () => {
  it('projects type/kind/root/node/mode/entityId from the def + options', () => {
    const root = new Object3D(); root.name = 'Conv';
    const { host } = makeHost({ root });
    const self = createSelf(ctxFor(host, root), DEF);
    expect(self.type).toBe('Conveyor');
    expect(self.kind).toBe('conveyor');
    expect(self.root).toBe(root);
    expect(self.node).toBe(root);
    expect(self.mode).toBe('continuous');
    expect(self.entityId).toBe(-1);
  });

  it('honours mode + entityId options', () => {
    const root = new Object3D();
    const { host } = makeHost({ root });
    const self = createSelf(ctxFor(host, root), DEF, { mode: 'des', entityId: 7 });
    expect(self.mode).toBe('des');
    expect(self.entityId).toBe(7);
  });
});

describe('createSelf — signals project through rv.signals', () => {
  it('get/set forward to the underlying signal store (instance-scoped)', () => {
    const root = new Object3D(); root.name = 'Conv';
    const { host, values } = makeHost({ root });
    const self = createSelf(ctxFor(host, root), DEF);
    self.signals.set('Conveyor.Run', true);
    // No LayoutObject ancestor → empty scope → unscoped name.
    expect(values.get('Conveyor.Run')).toBe(true);
    expect(self.signals.get<boolean>('Conveyor.Run')).toBe(true);
  });

  it('on() subscribes and fires on subsequent set()', () => {
    const root = new Object3D(); root.name = 'Conv';
    const { host } = makeHost({ root });
    const self = createSelf(ctxFor(host, root), DEF);
    let seen: boolean | number | undefined;
    self.signals.on('Sensor', (v) => { seen = v; });
    self.signals.set('Sensor', true);
    expect(seen).toBe(true);
  });
});

describe('createSelf — drive projection', () => {
  it('resolves a drive by node ref and exposes the BindContextDrive surface', () => {
    const root = new Object3D(); root.name = 'Conv';
    const belt = new Object3D(); belt.name = 'Transport-X'; root.add(belt);
    const drive: FakeDrive = {
      name: 'Transport-X', node: belt, jogForward: false, jogBackward: false,
      TargetSpeed: 100, startMove() {}, stop() {},
    };
    const { host } = makeHost({ root, drives: [drive] });
    const self = createSelf(ctxFor(host, root), DEF);
    const d = self.drive(belt);
    expect(d).not.toBeNull();
    expect(d!.name).toBe('Transport-X');
    d!.jogForward = true;
    expect(drive.jogForward).toBe(true);
  });

  it('returns null for an unknown drive ref', () => {
    const root = new Object3D(); root.name = 'Conv';
    const { host } = makeHost({ root });
    const self = createSelf(ctxFor(host, root), DEF);
    expect(self.drive('Nope')).toBeNull();
  });
});

describe('createSelf — ports from the snap graph', () => {
  it('classifies a paired output snap as an output port (id === partner snap id)', () => {
    const aRoot = new Object3D(); aRoot.name = 'ConvA';
    const aOutObj = new Object3D(); aOutObj.name = 'Snap-XP'; aRoot.add(aOutObj);
    const bRoot = new Object3D(); bRoot.name = 'ConvB';
    const bInObj = new Object3D(); bInObj.name = 'Snap-XN'; bRoot.add(bInObj);

    const aOut = { id: 'a-out', object3D: aOutObj, flow: 'out', pairedSnapId: 'b-in', ownerRoot: aRoot };
    const bIn = { id: 'b-in', object3D: bInObj, flow: 'in', pairedSnapId: 'a-out', ownerRoot: bRoot };
    const byId: Record<string, unknown> = { 'a-out': aOut, 'b-in': bIn };
    const reg = {
      getByOwnerRoot: (r: Object3D) => (r === aRoot ? [aOut] : [bIn]),
      getById: (id: string) => byId[id],
    };
    const snapPlugin = { getRegistry: () => reg };

    const { host } = makeHost({ root: aRoot, snapPlugin });
    const self = createSelf(ctxFor(host, aRoot), DEF);

    const ports = [...self.ports];
    expect(ports.length).toBe(1);
    const port = ports[0];
    // Port.id === partner snap id === TransportLink.partnerSnapId.
    expect(port.id).toBe('b-in');
    expect(port.partnerSnapId).toBe('b-in');
    expect(port.mySnapId).toBe('a-out');
    expect(port.role).toBe('output');
    expect(port.ownerRoot).toBe(bRoot);
    expect(port.ownerComponent).toBeNull();
    expect(self.outputs().length).toBe(1);
    expect(self.inputs().length).toBe(0);
  });

  it('freeOutputs excludes a port whose downstream signal is occupied', () => {
    const aRoot = new Object3D(); aRoot.name = 'ConvA';
    const aOutObj = new Object3D(); aOutObj.name = 'Snap-XP'; aRoot.add(aOutObj);
    const bRoot = new Object3D(); bRoot.name = 'ConvB';
    const bInObj = new Object3D(); bInObj.name = 'Snap-XN'; bRoot.add(bInObj);
    const aOut = { id: 'a-out', object3D: aOutObj, flow: 'out', pairedSnapId: 'b-in', ownerRoot: aRoot };
    const bIn = { id: 'b-in', object3D: bInObj, flow: 'in', pairedSnapId: 'a-out', ownerRoot: bRoot };
    const byId: Record<string, unknown> = { 'a-out': aOut, 'b-in': bIn };
    const reg = {
      getByOwnerRoot: (r: Object3D) => (r === aRoot ? [aOut] : [bIn]),
      getById: (id: string) => byId[id],
    };
    const snapPlugin = { getRegistry: () => reg };
    const { host, values } = makeHost({ root: aRoot, snapPlugin });
    const self = createSelf(ctxFor(host, aRoot), DEF);

    // Downstream not occupied → free.
    expect(self.freeOutputs().length).toBe(1);
    // Mark downstream root occupied (no per-port key → root signal). The `/`-prefixed
    // read resolves via the global escape, which strips the leading slash, so the
    // stored key is the un-prefixed name.
    values.set('ConvB/Conveyor.Occupied', true);
    expect(self.freeOutputs().length).toBe(0);
    expect(self.downstreamOccupied(self.outputs()[0])).toBe(true);
  });
});

describe('createSelf — state machine + prop', () => {
  it('setState/state round-trip', () => {
    const root = new Object3D();
    const { host } = makeHost({ root });
    const self = createSelf(ctxFor(host, root), DEF);
    expect(self.state).toBe('idle');
    self.setState('receiving');
    expect(self.state).toBe('receiving');
  });

  it('prop is a mutable snapshot-safe bag', () => {
    const root = new Object3D();
    const { host } = makeHost({ root });
    const self = createSelf(ctxFor(host, root), DEF);
    self.prop['alignedPort'] = null;
    self.prop['driveTarget'] = 42;
    expect(self.prop['driveTarget']).toBe(42);
    expect(JSON.stringify(self.prop)).toContain('driveTarget');
  });
});

describe('createSelf — scheduling is DES-only', () => {
  it('in/at/cancel dev-throw in continuous mode', () => {
    const root = new Object3D();
    const { host } = makeHost({ root });
    const self = createSelf(ctxFor(host, root), DEF, { mode: 'continuous' });
    expect(() => self.in(1, 'Arrival')).toThrow(/DES-only/);
    expect(() => self.at(1, 'Arrival')).toThrow(/DES-only/);
    expect(() => self.cancel(0)).toThrow(/DES-only/);
    expect(self.now).toBe(0);
  });

  it('delegates to an injected scheduler in DES mode', () => {
    const root = new Object3D();
    const { host } = makeHost({ root });
    const calls: string[] = [];
    const scheduler: SelfScheduler = {
      in: (d, h) => { calls.push(`in:${d}:${h}`); return 1; },
      at: (t, h) => { calls.push(`at:${t}:${h}`); return 2; },
      cancel: (id) => { calls.push(`cancel:${id}`); },
      now: 12.5,
    };
    const self = createSelf(ctxFor(host, root), DEF, { mode: 'des', entityId: 3, scheduler });
    const mu: MU = { id: 1 };
    expect(self.in(0.5, 'Arrival', mu)).toBe(1);
    expect(self.at(2, 'RotateComplete')).toBe(2);
    self.cancel(99);
    expect(self.now).toBe(12.5);
    expect(calls).toEqual(['in:0.5:Arrival', 'at:2:RotateComplete', 'cancel:99']);
  });
});
