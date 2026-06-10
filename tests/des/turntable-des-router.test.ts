// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * turntable-des-router.test.ts — Plan 194 P5b (Turntable DES router).
 *
 * Tests the unified Turntable `des` block at the FSM level against a controllable
 * fake `self` (ports/outputs injected, scheduled events + transfers captured):
 *  - `canAccept` only at the currently aligned input port (when a port is given)
 *    and below capacity;
 *  - `onAccept` rotates to a free output and schedules `RotateComplete` after
 *    `|Δang| / RotationSpeed` seconds;
 *  - `onRotateComplete` dispatches the MU to the selected free output;
 *  - HOLD when no output is free, then dispatch on `onDownstreamReady`.
 *
 * The Turntable angle math reads the output snap node's world position via
 * `dispatchToOutputAngle`; the test seeds deterministic output roots so |Δang|
 * is predictable.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { TurntableFlow } from '../../src/behaviors/Turntable';
import type {
  MaterialFlowSelf,
  MU,
  Port,
} from '../../src/core/material-flow/material-flow-self';
import { dispatchToOutputAngle } from '../../src/behaviors/_shared/turntable-angle-math';

const des = TurntableFlow.des!;

/** The concrete self type the Turntable des hooks expect (local is private to Turntable.ts). */
type TTSelf = Parameters<NonNullable<typeof des.onAccept>>[0];

// ─── Controllable fake self ──────────────────────────────────────────────

interface ScheduledEvent { delay: number; hook: string; mu: MU | null }

interface TurntableLocalLike {
  driveAxis: Vector3;
  beltNeutralAngle: number;
  lastCommandedAngle: number;
}

/** A port backed by a positioned owner root (so the angle math is deterministic). */
function makeOutputPort(id: string, x: number, z: number, occupied = false): Port {
  const ownerRoot = new Object3D();
  ownerRoot.name = `Out-${id}`;
  ownerRoot.position.set(x, 0, z);
  ownerRoot.updateMatrixWorld(true);
  return {
    id,
    role: 'output',
    ownerRoot,
    ownerComponent: null,
    mySnapId: `tt-${id}`,
    partnerSnapId: id,
    partnerRoot: ownerRoot,
    partnerComponent: null,
    occupied: () => occupied,
    upstreamWaiting: () => false,
    setOccupied: () => {},
  };
}

function makeFakeSelf(outputs: Port[]): {
  self: TTSelf;
  events: ScheduledEvent[];
  transfers: { mu: MU; port?: Port }[];
  setLoad: (n: number) => void;
  setOutputs: (ports: Port[]) => void;
} {
  const events: ScheduledEvent[] = [];
  const transfers: { mu: MU; port?: Port }[] = [];
  const muList: MU[] = [];
  let outs = outputs;
  let state = 'idle';
  let load = 0;
  const prop: Record<string, unknown> = { RotationSpeed: 45, MaxCapacity: 1, alignedPort: null };

  const self = {
    type: 'Turntable',
    kind: 'router',
    local: { driveAxis: new Vector3(0, 1, 0), beltNeutralAngle: 0, lastCommandedAngle: 0 },
    prop,
    get state() { return state; },
    setState(n: string) { state = n; },
    get currentLoad() { return load; },
    get mus() { return muList; },
    signals: { get: () => undefined, set: () => {}, on: () => {} },
    // The router publishes Conveyor.Occupied/Running via the typed `self.sig.*`
    // accessors (signals block, namespace 'Conveyor'); stub them as no-ops here.
    sig: {
      Run: { get: () => false, set: () => {} },
      Occupied: { get: () => false, set: () => {} },
      Running: { get: () => false, set: () => {} },
      PartCount: { get: () => 0, set: () => {} },
    },
    outputs: () => outs,
    inputs: () => [],
    freeOutputs: () => outs.filter(p => !p.occupied()),
    in: (delay: number, hook: string, mu?: MU | null) => { events.push({ delay, hook, mu: mu ?? null }); return events.length; },
    transfer: (mu: MU, port?: Port) => { transfers.push({ mu, port }); },
  } as unknown as TTSelf;

  return {
    self,
    events,
    transfers,
    setLoad: (n: number) => { load = n; muList.length = 0; for (let i = 0; i < n; i++) muList.push({ id: 100 + i }); },
    setOutputs: (ports: Port[]) => { outs = ports; },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Turntable DES router — acceptance', () => {
  it('accepts below capacity; rejects when full', () => {
    const { self, setLoad } = makeFakeSelf([makeOutputPort('a', 1, 0)]);
    expect(des.canAccept!(self, { id: 1 } as MU, undefined)).toBe(true);
    setLoad(1); // at MaxCapacity = 1
    expect(des.canAccept!(self, { id: 2 } as MU, undefined)).toBe(false);
  });

  it('accepts only at the aligned input port when a port is supplied', () => {
    const { self } = makeFakeSelf([makeOutputPort('a', 1, 0)]);
    self.prop['alignedPort'] = 'IN-A';
    const aligned = { id: 'IN-A' } as unknown as Port;
    const other = { id: 'IN-B' } as unknown as Port;
    expect(des.canAccept!(self, { id: 1 } as MU, aligned)).toBe(true);
    expect(des.canAccept!(self, { id: 1 } as MU, other)).toBe(false);
  });
});

describe('Turntable DES router — rotate timing + dispatch', () => {
  it('rotates to a free output and schedules RotateComplete after |Δang|/RotationSpeed', () => {
    const out = makeOutputPort('a', 1, 0); // +X
    const ctx = makeFakeSelf([out]);
    const { self, events } = ctx;

    const expectedAngle = dispatchToOutputAngle(
      self.local.driveAxis, self.local.beltNeutralAngle, out.ownerRoot, self.local.lastCommandedAngle,
    );
    const expectedTime = Math.abs(expectedAngle - 0) / 45;

    des.onAccept!(self, { id: 1 } as MU, undefined);

    // One RotateComplete scheduled with the |Δang|/RotationSpeed delay.
    expect(events.length).toBe(1);
    expect(events[0].hook).toBe('RotateComplete');
    expect(events[0].delay).toBeCloseTo(Math.max(0.001, expectedTime), 3);
    // The selected output is recorded; the tween coupling target is set.
    expect(self.prop['selectedOutput']).toBe('a');
    expect(self.prop['driveTarget']).toBeCloseTo(expectedAngle, 3);
    expect(self.state).toBe('rotating_out');
  });

  it('onRotateComplete dispatches the MU to the selected output', () => {
    const out = makeOutputPort('a', 1, 0);
    const ctx = makeFakeSelf([out]);
    const { self, transfers } = ctx;
    const mu = { id: 7 } as MU;

    des.onAccept!(self, mu, undefined);
    des.onRotateComplete!(self, mu);

    expect(transfers.length).toBe(1);
    expect(transfers[0].mu.id).toBe(7);
    expect(transfers[0].port?.id).toBe('a');
    expect(self.state).toBe('idle');
    expect(self.prop['selectedOutput']).toBe(null);
  });
});

describe('Turntable DES router — back-pressure HOLD', () => {
  it('HOLDs when no output is free, then dispatches on onDownstreamReady', () => {
    const blocked = makeOutputPort('a', 1, 0, /*occupied*/ true);
    const ctx = makeFakeSelf([blocked]);
    const { self, events, transfers, setLoad } = ctx;
    const mu = { id: 9 } as MU;

    // No free output → HOLD (no rotate scheduled, MU parked).
    des.onAccept!(self, mu, undefined);
    expect(events.length).toBe(0);
    expect(self.state).toBe('holding');
    expect(self.prop['heldMU']).toBe(9);

    // The held MU must be discoverable for the retry — put it on the platform.
    setLoad(0);
    (self.mus as MU[]).push(mu);

    // Output frees → retry: now a free output exists → rotate scheduled.
    ctx.setOutputs([makeOutputPort('a', 1, 0, /*occupied*/ false)]);
    des.onDownstreamReady!(self, undefined);
    expect(events.length).toBe(1);
    expect(events[0].hook).toBe('RotateComplete');
    expect(self.state).toBe('rotating_out');

    // Completing the rotation dispatches the held MU.
    des.onRotateComplete!(self, mu);
    expect(transfers.length).toBe(1);
    expect(transfers[0].mu.id).toBe(9);
  });
});
