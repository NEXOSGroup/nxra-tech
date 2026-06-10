// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Port-vs-TransportLink bridge (Plan 194 §2.8): a material-flow `Port` EXTENDS
 * Plan-196's `TransportLink`. This test pins the contract:
 *   - port.id === TransportLink.partnerSnapId === partner snap id
 *   - port.ownerComponent fills the slot TransportLink reserves as partnerComponent
 *   - a Port is structurally a TransportLink (assignable, same occupied() signal contract)
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
import { resolvePorts, type Port } from '../src/core/material-flow/material-flow-self';
import type { TransportLink } from '../src/behaviors/_shared/transport-links';
import { linkOf } from '../src/behaviors/_shared/transport-links';
import { classifyConnections } from '../src/behaviors/_shared/snap-graph-helpers';

function buildScene() {
  const aRoot = new Object3D(); aRoot.name = 'ConvA';
  const aOutObj = new Object3D(); aOutObj.name = 'Snap-XP'; aRoot.add(aOutObj);
  const bRoot = new Object3D(); bRoot.name = 'ConvB';
  const bInObj = new Object3D(); bInObj.name = 'Snap-XN'; bRoot.add(bInObj);

  const aOut = { id: 'a-out-snap', object3D: aOutObj, flow: 'out', pairedSnapId: 'b-in-snap', ownerRoot: aRoot };
  const bIn = { id: 'b-in-snap', object3D: bInObj, flow: 'in', pairedSnapId: 'a-out-snap', ownerRoot: bRoot };
  const byId: Record<string, unknown> = { 'a-out-snap': aOut, 'b-in-snap': bIn };
  const reg = {
    getByOwnerRoot: (r: Object3D) => (r === aRoot ? [aOut] : [bIn]),
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
  const { ctx } = createBindContext(aRoot, host, accum);
  return { ctx, host, values, aRoot, bRoot };
}

describe('Port extends TransportLink (Plan 194 §2.8)', () => {
  it('port.id === partnerSnapId === partner snap id', () => {
    const { ctx } = buildScene();
    const ports = resolvePorts(ctx);
    expect(ports).toHaveLength(1);
    const port = ports[0];
    expect(port.id).toBe('b-in-snap');
    expect(port.partnerSnapId).toBe('b-in-snap');
    expect(port.id).toBe(port.partnerSnapId);
  });

  it('mySnapId is this side; partnerRoot is the downstream owner', () => {
    const { ctx, bRoot } = buildScene();
    const port = resolvePorts(ctx)[0];
    expect(port.mySnapId).toBe('a-out-snap');
    expect(port.partnerRoot).toBe(bRoot);
    expect(port.ownerRoot).toBe(bRoot);
  });

  it('ownerComponent fills the partnerComponent slot (null on the continuous path)', () => {
    const { ctx } = buildScene();
    const port = resolvePorts(ctx)[0];
    expect(port.ownerComponent).toBeNull();
    expect(port.partnerComponent).toBeNull();
    expect(port.ownerComponent).toBe(port.partnerComponent);
  });

  it('a Port is structurally a TransportLink and shares the @<id> occupied contract', () => {
    const { ctx, values } = buildScene();
    const port = resolvePorts(ctx)[0];
    // Assignable to TransportLink (compile-time + runtime shape).
    const link: TransportLink = port;
    expect(typeof link.occupied).toBe('function');
    expect(link.occupied()).toBe(false);
    // Same signal name convention as Plan 196: per-port then root. The `/`-prefixed
    // read uses the global escape (leading slash stripped), so the stored key is
    // the un-prefixed per-port name.
    values.set('ConvB/Flow.Occupied@b-in-snap', true);
    expect(link.occupied()).toBe(true);
  });

  it('matches the TransportLink produced by Plan-196 linkOf() for the same connection', () => {
    const { ctx } = buildScene();
    const port: Port = resolvePorts(ctx)[0];
    const conn = classifyConnections(ctx.viewer, ctx.root)[0];
    const link196 = linkOf(ctx, conn);
    expect(port.partnerSnapId).toBe(link196.partnerSnapId);
    expect(port.mySnapId).toBe(link196.mySnapId);
    expect(port.partnerRoot).toBe(link196.partnerRoot);
  });
});
