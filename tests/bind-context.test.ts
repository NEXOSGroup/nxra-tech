// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi } from 'vitest';
import { Object3D } from 'three';
import {
  createBindContext,
  iterateFixedUpdate,
  type BindContextHost,
  type KinematicsSpec,
} from '../src/core/behavior-runtime';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';

function makeHost(opts?: { withSignals?: boolean }) {
  const events = new EventEmitter<Record<string, unknown>>();
  const signalSubs = new Map<string, Set<(v: boolean | number) => void>>();
  const signalValues = new Map<string, boolean | number>();
  const signalStore = opts?.withSignals === false ? null : {
    get(name: string) { return signalValues.get(name); },
    set(name: string, value: boolean | number) {
      signalValues.set(name, value);
      const subs = signalSubs.get(name);
      if (subs) for (const cb of subs) cb(value);
    },
    subscribe(name: string, cb: (v: boolean | number) => void) {
      let s = signalSubs.get(name);
      if (!s) { s = new Set(); signalSubs.set(name, s); }
      s.add(cb);
      return () => { s!.delete(cb); };
    },
  };
  const contextMenu = new ContextMenuStore();
  const host: BindContextHost = {
    signalStore,
    on: (event, cb) => events.on(event, cb as never),
    contextMenu,
    drives: [],
    registry: null,
  };
  return { host, events, contextMenu };
}

describe('createBindContext — kinematics chaining', () => {
  it('drive() accumulates entries into spec', () => {
    const root = new Object3D(); root.name = 'R';
    const accum: KinematicsSpec = {};
    const { host } = makeHost();
    const { ctx } = createBindContext(root, host, accum);
    ctx.drive('A', 'LinearY').drive('B', 'RotationZ', { speed: 100 });
    expect(accum.drives).toHaveLength(2);
    expect(accum.drives![0].direction).toBe('LinearY');
    expect(accum.drives![1].speed).toBe(100);
  });

  it('transport() accepts AxisCode + opts-only overload', () => {
    const accum: KinematicsSpec = {};
    const { host } = makeHost();
    const { ctx } = createBindContext(new Object3D(), host, accum);
    ctx.transport('Belt', '+X', { speed: 250 });
    ctx.transport('Belt2', { speed: 999 });
    expect(accum.transports![0].direction).toBe('+X');
    expect(accum.transports![1].direction).toBeUndefined();
    expect(accum.transports![1].speed).toBe(999);
  });

  it('sensor/snap/aas all chain', () => {
    const accum: KinematicsSpec = {};
    const { host } = makeHost();
    const { ctx } = createBindContext(new Object3D(), host, accum);
    ctx.sensor('S', { size: [10, 10, 10] }).snap('S', 'XN', 'belt').aas('S', 'm.aasx');
    expect(accum.sensors).toHaveLength(1);
    expect(accum.snaps).toHaveLength(1);
    expect(accum.aasLinks).toHaveLength(1);
  });
});

describe('createBindContext — signals', () => {
  it('signals.set propagates to listener via signals.on (auto-tracked)', () => {
    const accum: KinematicsSpec = {};
    const { host } = makeHost();
    const root = new Object3D();
    const { ctx } = createBindContext(root, host, accum);
    const cb = vi.fn();
    ctx.signals.on('Foo', cb);
    ctx.signals.set('Foo', true);
    expect(cb).toHaveBeenCalledWith(true);
    expect(ctx.signals.get('Foo')).toBe(true);
  });
});

describe('createBindContext — onFixedUpdate', () => {
  it('iterateFixedUpdate fires registered callbacks', () => {
    const accum: KinematicsSpec = {};
    const { host } = makeHost();
    const { ctx, handle } = createBindContext(new Object3D(), host, accum);
    const cb = vi.fn();
    ctx.onFixedUpdate(cb);
    iterateFixedUpdate(handle, 0.016);
    iterateFixedUpdate(handle, 0.016);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith(0.016);
  });
});

describe('createBindContext — auto-dispose (F12)', () => {
  it('disposes onFixedUpdate callbacks on handle.dispose()', () => {
    const accum: KinematicsSpec = {};
    const { host } = makeHost();
    const { ctx, handle } = createBindContext(new Object3D(), host, accum);
    const cb = vi.fn();
    ctx.onFixedUpdate(cb);
    iterateFixedUpdate(handle, 0.016);
    expect(cb).toHaveBeenCalledTimes(1);
    handle.dispose();
    iterateFixedUpdate(handle, 0.016);
    expect(cb).toHaveBeenCalledTimes(1); // no further calls
  });

  it('disposes signals.on subscriptions on handle.dispose()', () => {
    const accum: KinematicsSpec = {};
    const { host } = makeHost();
    const { ctx, handle } = createBindContext(new Object3D(), host, accum);
    const cb = vi.fn();
    ctx.signals.on('Foo', cb);
    ctx.signals.set('Foo', true);
    expect(cb).toHaveBeenCalledTimes(1);
    handle.dispose();
    ctx.signals.set('Foo', false);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('disposes generic on() event subscriptions on handle.dispose()', () => {
    const accum: KinematicsSpec = {};
    const { host, events } = makeHost();
    const { ctx, handle } = createBindContext(new Object3D(), host, accum);
    const cb = vi.fn();
    ctx.on('custom-event', cb);
    events.emit('custom-event', { x: 1 });
    expect(cb).toHaveBeenCalledTimes(1);
    handle.dispose();
    events.emit('custom-event', { x: 2 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('unregisters context-menu items on handle.dispose() — regression for F12', () => {
    const accum: KinematicsSpec = {};
    const { host, contextMenu } = makeHost();
    const root = new Object3D(); root.name = 'Root';
    const a = new Object3D(); a.name = 'A'; root.add(a);
    const { ctx, handle } = createBindContext(root, host, accum);
    ctx.contextMenu('A', [{ id: 'foo', label: 'Foo', action: () => {} }]);

    contextMenu.open({ x: 0, y: 0 }, { path: 'A', node: a, types: [], extras: {} });
    expect(contextMenu.getSnapshot().items.length).toBe(1);
    contextMenu.close();

    handle.dispose();
    contextMenu.open({ x: 0, y: 0 }, { path: 'A', node: a, types: [], extras: {} });
    expect(contextMenu.getSnapshot().open).toBe(false); // no items left → stays closed
  });
});

describe('createBindContext — navigation helpers', () => {
  it('find() resolves by name', () => {
    const root = new Object3D(); root.name = 'R';
    const a = new Object3D(); a.name = 'A'; root.add(a);
    const accum: KinematicsSpec = {};
    const { host } = makeHost();
    const { ctx } = createBindContext(root, host, accum);
    expect(ctx.find('A')).toBe(a);
    expect(ctx.find('Missing')).toBeNull();
  });

  it('path() joins segments and resolves', () => {
    const root = new Object3D(); root.name = 'R';
    const a = new Object3D(); a.name = 'A';
    const b = new Object3D(); b.name = 'B';
    root.add(a); a.add(b);
    const accum: KinematicsSpec = {};
    const { host } = makeHost();
    const { ctx } = createBindContext(root, host, accum);
    expect(ctx.path('A', 'B')).toBe(b);
  });
});
