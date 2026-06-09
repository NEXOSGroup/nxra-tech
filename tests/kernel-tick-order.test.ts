// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * kernel-tick-order.test.ts — Plan 194 P1, R1 regression guard.
 *
 * Proves that routing the fixed tick through the SimulationKernel /
 * ContinuousRunner reproduces the EXACT legacy tick ordering — transport BEFORE
 * the behaviour/component fixedUpdate — verified two ways:
 *
 *  1. Call-order parity: an interleave recorder shows the legacy split
 *     (`transport.update` then `behaviors.tick`) and the kernel-routed path
 *     (`kernel.tick`) emit the same transport→behaviour sequence.
 *
 *  2. MU-position parity: a real `RVTransportManager` + real surface + real MU
 *     ticked via `ContinuousRunner.tick` moves the MU to the SAME position as a
 *     reference manager ticked directly with `transportManager.update`.
 *
 * Reference for the legacy order (rv-viewer.ts fixedUpdate):
 *   rv-viewer.ts:3254   transportManager.update(dt)   ← transport FIRST
 *   rv-viewer.ts:3288   behaviors.tick(dt)            ← behaviour AFTER
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { ContinuousRunner } from '../src/core/material-flow/continuous-runner';
import { SimulationKernel } from '../src/core/material-flow/simulation-kernel';

// ─── Helpers (mirrors tests/rv-transport.test.ts) ──────────────────────────

function createMU(name: string, x: number, y: number, z: number): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  return new RVMovingUnit(node, 'test-source', new Vector3(0.05, 0.05, 0.05));
}

function createSurface(speed: number): RVTransportSurface {
  const node = new Object3D();
  node.position.set(0, 0, 0);
  const aabb = AABB.fromHalfSize(node, new Vector3(2, 0.1, 0.5));
  const surface = new RVTransportSurface(node, aabb);
  surface.TransportDirection.copy(new Vector3(1, 0, 0));
  surface.Radial = false;
  surface.TextureScale = 1;
  surface.HeightOffsetOverride = 0;
  surface.initTransport();
  surface.drive = { currentSpeed: speed, name: 'mock-drive' } as never;
  return surface;
}

function makeRealTransportManager(speed: number): { mgr: RVTransportManager; mu: RVMovingUnit } {
  const mgr = new RVTransportManager();
  const surface = createSurface(speed);
  const mu = createMU('part', 0, 0, 0);
  mgr.surfaces.push(surface);
  mgr.mus.push(mu);
  return { mgr, mu };
}

// ─── 1. Call-order parity ──────────────────────────────────────────────────

describe('kernel tick order — call-order parity (R1)', () => {
  it('kernel-routed tick emits transport→behaviour in the same order as the legacy split', () => {
    // Legacy reference: what rv-viewer.ts does today (transport then behaviours).
    const legacy: string[] = [];
    const legacyTransport = { mus: [] as unknown[], update(_dt: number) { legacy.push('transport.update'); }, reset() {} };
    const legacyBehaviors = { tick(_dt: number) { legacy.push('behaviors.tick'); } };
    // The legacy fixedUpdate calls these in this exact textual order.
    legacyTransport.update(0.016);
    legacyBehaviors.tick(0.016);

    // Kernel-routed path: a single kernel.tick(dt) over a ContinuousRunner.
    const routed: string[] = [];
    const transport = { mus: [] as unknown[], update(_dt: number) { routed.push('transport.update'); }, reset() {} };
    const behaviors = { tick(_dt: number) { routed.push('behaviors.tick'); } };
    const kernel = new SimulationKernel({
      continuousRunner: new ContinuousRunner(transport, behaviors),
      topology: { root: {} as never },
    });
    kernel.tick(0.016);

    expect(routed).toEqual(legacy);
    expect(routed).toEqual(['transport.update', 'behaviors.tick']);
  });

  it('interleaved over several ticks: transport always precedes behaviours', () => {
    const seq: string[] = [];
    const transport = { mus: [] as unknown[], update() { seq.push('transport.update'); }, reset() {} };
    const behaviors = { tick() { seq.push('behaviors.tick'); } };
    const kernel = new SimulationKernel({
      continuousRunner: new ContinuousRunner(transport, behaviors),
      topology: { root: {} as never },
    });

    for (let i = 0; i < 3; i++) kernel.tick(0.016);

    // Every behaviour call must be immediately preceded by a transport call.
    for (let i = 0; i < seq.length; i += 2) {
      expect(seq[i]).toBe('transport.update');
      expect(seq[i + 1]).toBe('behaviors.tick');
    }
    expect(seq.length).toBe(6);
  });
});

// ─── 2. MU-position parity ─────────────────────────────────────────────────

describe('kernel tick order — MU-position parity (R1)', () => {
  it('ContinuousRunner.tick moves an MU identically to a direct transportManager.update', () => {
    const speed = 1000; // mm/s = 1 m/s
    const dt = 1 / 60;

    // Reference: ticked directly via transportManager.update (legacy path).
    const ref = makeRealTransportManager(speed);
    // Kernel: ticked via ContinuousRunner (behaviours = a real no-op that only
    // records it ran AFTER transport).
    const order: string[] = [];
    const k = makeRealTransportManager(speed);
    const runner = new ContinuousRunner(k.mgr, {
      tick() {
        // Behaviour runs AFTER transport: the MU has already advanced this tick.
        order.push(`behaviour@x=${k.mu.getPosition().x.toFixed(4)}`);
      },
    });
    const kernel = new SimulationKernel({ continuousRunner: runner, topology: { root: {} as never } });

    for (let i = 0; i < 30; i++) {
      ref.mgr.update(dt);
      kernel.tick(dt);
    }

    // Same MU position after 30 identical ticks → transport ran the same way.
    expect(k.mu.getPosition().x).toBeCloseTo(ref.mu.getPosition().x, 6);
    expect(k.mu.getPosition().x).toBeGreaterThan(0); // actually moved

    // The behaviour observed a NON-zero (already-advanced) x on the first tick,
    // confirming transport ran BEFORE the behaviour within the kernel tick.
    expect(order.length).toBe(30);
    const firstX = parseFloat(order[0].split('=')[1]);
    expect(firstX).toBeGreaterThan(0);
  });
});
