// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * turntable-output-selection.test.ts — Plan 199 §8.2.
 *
 * The Turntable DES router picks its discharge output via `self.freeOutputs()`,
 * which filters the resolved output ports by the downstream interlock signal
 * `/<downstreamRoot>.Flow.Occupied` (per-port `@<id>` else root). This pins that
 * the rename `Conveyor.Occupied → Flow.Occupied` keeps the routing correct: with
 * one downstream free and one busy, the router routes to the FREE port only.
 *
 * Without this test a partial rename of the routing signal would stay green yet
 * silently mis-route (the free-output read would always return "free").
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import {
  createBindContext,
  type BindContextHost,
  type KinematicsSpec,
} from '../src/core/behavior-runtime';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import { createSelf, type SelfDef } from '../src/core/material-flow/material-flow-self';

const TURNTABLE: SelfDef = { type: 'Turntable', kind: 'router', signalNamespace: 'Flow' };

/** A turntable root with two paired OUTPUT snaps, each toward a distinct downstream root. */
function buildRouterScene() {
  const ttRoot = new Object3D(); ttRoot.name = 'TT';
  const outAObj = new Object3D(); outAObj.name = 'Snap-OUT-A'; ttRoot.add(outAObj);
  const outBObj = new Object3D(); outBObj.name = 'Snap-OUT-B'; ttRoot.add(outBObj);

  const freeRoot = new Object3D(); freeRoot.name = 'ConvFree';
  const freeInObj = new Object3D(); freeInObj.name = 'Snap-IN-Free'; freeRoot.add(freeInObj);
  const busyRoot = new Object3D(); busyRoot.name = 'ConvBusy';
  const busyInObj = new Object3D(); busyInObj.name = 'Snap-IN-Busy'; busyRoot.add(busyInObj);

  const outA = { id: 'tt-out-a', object3D: outAObj, flow: 'out', pairedSnapId: 'free-in', ownerRoot: ttRoot };
  const outB = { id: 'tt-out-b', object3D: outBObj, flow: 'out', pairedSnapId: 'busy-in', ownerRoot: ttRoot };
  const freeIn = { id: 'free-in', object3D: freeInObj, flow: 'in', pairedSnapId: 'tt-out-a', ownerRoot: freeRoot };
  const busyIn = { id: 'busy-in', object3D: busyInObj, flow: 'in', pairedSnapId: 'tt-out-b', ownerRoot: busyRoot };

  const byId: Record<string, unknown> = {
    'tt-out-a': outA, 'tt-out-b': outB, 'free-in': freeIn, 'busy-in': busyIn,
  };
  const reg = {
    getByOwnerRoot: (r: Object3D) => (r === ttRoot ? [outA, outB] : []),
    getById: (id: string) => byId[id],
  };
  const snapPlugin = { getRegistry: () => reg };

  const subs = new Map<string, Set<(v: boolean | number) => void>>();
  const values = new Map<string, boolean | number>();
  const host: BindContextHost = {
    signalStore: {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => { values.set(n, v); subs.get(n)?.forEach((cb) => cb(v)); },
      subscribe: (n: string, cb: (v: boolean | number) => void) => {
        let s = subs.get(n); if (!s) { s = new Set(); subs.set(n, s); }
        s.add(cb); return () => { s!.delete(cb); };
      },
    },
    on: (e, cb) => new EventEmitter<Record<string, unknown>>().on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: [],
    registry: null,
    getPlugin: (id: string) => (id === 'snap-point' ? snapPlugin : undefined),
  };

  const accum: KinematicsSpec = {};
  const { ctx } = createBindContext(ttRoot, host, accum);
  const self = createSelf(ctx, TURNTABLE);
  return { self, values };
}

describe('Turntable output selection — routes via /<root>.Flow.Occupied', () => {
  it('both outputs resolve, both free → freeOutputs returns both', () => {
    const { self } = buildRouterScene();
    expect(self.outputs().length).toBe(2);
    expect(self.freeOutputs().length).toBe(2);
  });

  it('one downstream busy (Flow.Occupied=true) → routes to the FREE port only', () => {
    const { self, values } = buildRouterScene();
    // ConvFree open, ConvBusy blocked — via the root interlock signal.
    values.set('ConvFree.Flow.Occupied', false);
    values.set('ConvBusy.Flow.Occupied', true);

    const free = self.freeOutputs();
    expect(free.length).toBe(1);
    // The free port is the one paired toward ConvFree.
    expect(free[0].id).toBe('free-in');
    expect(free[0].ownerRoot.name).toBe('ConvFree');
  });

  it('both downstream busy → no free output (router would HOLD)', () => {
    const { self, values } = buildRouterScene();
    values.set('ConvFree.Flow.Occupied', true);
    values.set('ConvBusy.Flow.Occupied', true);
    expect(self.freeOutputs().length).toBe(0);
  });
});
