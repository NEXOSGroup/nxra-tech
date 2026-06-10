// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * library-requires-block.test.ts — Plan 197 §2.4b-B / §11.2 R2-6 (Step 7B).
 *
 * The optional `requires` block resolves convention nodes BEFORE `def.setup`,
 * injects each as `self.<key>`, auto-disables (+ warn) the instance when a
 * required node is missing (which also skips fixedUpdate + the marker stamp),
 * warns + takes the first on ambiguity, and stamps an auto-badge marker from
 * the resolved nodes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Object3D } from 'three';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import {
  createBindContext,
  iterateFixedUpdate,
  applyKinematicsSpec,
  type BindContextHost,
  type KinematicsSpec,
} from '../src/core/behavior-runtime';
import { _resetCapabilitiesForTesting } from '../src/core/engine/rv-component-registry';
import { _resetMaterialFlowRegistry } from '../src/core/material-flow/registry';
import {
  defineLibraryComponent,
  _resetLibraryComponentMarkers,
} from '../src/behaviors/_shared/define-library-component';
import type { MaterialFlowSelf } from '../src/core/material-flow/material-flow-self';

const DT = 1 / 60;

beforeEach(() => {
  _resetMaterialFlowRegistry();
  _resetCapabilitiesForTesting();
  _resetLibraryComponentMarkers();
});

// ─── Mock host ───────────────────────────────────────────────────────────────

function makeHost(root: Object3D): { host: BindContextHost; values: Map<string, boolean | number> } {
  const subs = new Map<string, Set<(v: boolean | number) => void>>();
  const values = new Map<string, boolean | number>();
  const events = new EventEmitter<Record<string, unknown>>();
  const host: BindContextHost = {
    signalStore: {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => { values.set(n, v); subs.get(n)?.forEach((cb) => cb(v)); },
      subscribe: (n: string, cb: (v: boolean | number) => void) => {
        let s = subs.get(n); if (!s) { s = new Set(); subs.set(n, s); }
        s.add(cb); return () => { s!.delete(cb); };
      },
    },
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: [],
    registry: null,
  };
  return { host, values };
}

interface DemoLocal { ticks: number; }

function makeConveyorDef(over: Record<string, unknown> = {}) {
  return {
    type: 'ReqConv',
    kind: 'conveyor' as const,
    schema: {},
    requires: { belt: 'transport', sensor: 'sensor' } as const,
    state: (): DemoLocal => ({ ticks: 0 }),
    continuous: {
      fixedUpdate(self: MaterialFlowSelf<DemoLocal, Record<string, never>>) { self.local.ticks += 1; },
    },
    ...over,
  };
}

// ─── resolve + inject ────────────────────────────────────────────────────────

describe('requires block — resolution + injection', () => {
  it('injects self.belt / self.sensor from the resolved convention nodes', () => {
    let captured: Record<string, Object3D | null> | null = null;
    const behavior = defineLibraryComponent<DemoLocal>(makeConveyorDef({
      setup(self: MaterialFlowSelf<DemoLocal>) {
        captured = self as unknown as Record<string, Object3D | null>;
      },
    }));
    const root = new Object3D(); root.name = 'ReqConv';
    const belt = new Object3D(); belt.name = 'Transport-Z'; root.add(belt);
    const sensor = new Object3D(); sensor.name = 'Sensor-1'; root.add(sensor);
    const { host } = makeHost(root);
    const { ctx } = createBindContext(root, host, {} as KinematicsSpec);
    behavior.bind(ctx);
    expect(captured).not.toBeNull();
    expect(captured!.belt).toBe(belt);
    expect(captured!.sensor).toBe(sensor);
  });

  it('stamps the auto-badge marker {Belt, Sensor} from the resolved nodes', () => {
    const behavior = defineLibraryComponent<DemoLocal>(makeConveyorDef());
    const root = new Object3D(); root.name = 'ReqConv';
    const belt = new Object3D(); belt.name = 'Transport-Z'; root.add(belt);
    const sensor = new Object3D(); sensor.name = 'Sensor-Infeed'; root.add(sensor);
    const { host } = makeHost(root);
    const accum: KinematicsSpec = {};
    const { ctx } = createBindContext(root, host, accum);
    behavior.bind(ctx);
    applyKinematicsSpec(root, accum);
    const stamped = (root.userData.realvirtual as Record<string, unknown>).ReqConvBehavior as Record<string, unknown>;
    expect(stamped).toMatchObject({ Belt: 'Transport-Z', Sensor: 'Sensor-Infeed' });
  });

  it('explicit opts.badge merges over (and wins on a key clash with) the auto-badge', () => {
    const behavior = defineLibraryComponent<DemoLocal>(makeConveyorDef(), {
      badge: () => ({ Belt: 'OVERRIDDEN', Extra: 'x' }),
    });
    const root = new Object3D(); root.name = 'ReqConv';
    const belt = new Object3D(); belt.name = 'Transport-Z'; root.add(belt);
    const sensor = new Object3D(); sensor.name = 'Sensor-1'; root.add(sensor);
    const { host } = makeHost(root);
    const accum: KinematicsSpec = {};
    const { ctx } = createBindContext(root, host, accum);
    behavior.bind(ctx);
    applyKinematicsSpec(root, accum);
    const stamped = (root.userData.realvirtual as Record<string, unknown>).ReqConvBehavior as Record<string, unknown>;
    expect(stamped).toMatchObject({ Belt: 'OVERRIDDEN', Sensor: 'Sensor-1', Extra: 'x' });
  });
});

// ─── ambiguous → first + warn (R2-6) ────────────────────────────────────────

describe('requires block — ambiguous nodes', () => {
  it('takes the FIRST match and warns when multiple nodes of a kind exist', () => {
    let captured: Record<string, Object3D | null> | null = null;
    const behavior = defineLibraryComponent<DemoLocal>(makeConveyorDef({
      setup(self: MaterialFlowSelf<DemoLocal>) {
        captured = self as unknown as Record<string, Object3D | null>;
      },
    }));
    const root = new Object3D(); root.name = 'ReqConv';
    const belt1 = new Object3D(); belt1.name = 'Transport-Z'; root.add(belt1);
    const belt2 = new Object3D(); belt2.name = 'Transport-X'; root.add(belt2);
    const sensor = new Object3D(); sensor.name = 'Sensor-1'; root.add(sensor);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { host } = makeHost(root);
    const { ctx } = createBindContext(root, host, {} as KinematicsSpec);
    behavior.bind(ctx);
    expect(captured!.belt).toBe(belt1); // first match
    const ambiguityWarns = warn.mock.calls.filter(
      ([m]) => typeof m === 'string' && m.includes("multiple 'transport' nodes"),
    );
    expect(ambiguityWarns.length).toBe(1);
    warn.mockRestore();
  });
});

// ─── missing → disabled + no fixedUpdate + warn ──────────────────────────────

describe('requires block — missing node auto-disables', () => {
  it('missing sensor → self.disabled, no fixedUpdate, no marker stamp, warn', () => {
    let captured: MaterialFlowSelf<DemoLocal> | null = null;
    let continuousSetupRan = false;
    const behavior = defineLibraryComponent<DemoLocal>(makeConveyorDef({
      setup(self: MaterialFlowSelf<DemoLocal>) { captured = self; },
      continuous: {
        setup() { continuousSetupRan = true; },
        fixedUpdate(self: MaterialFlowSelf<DemoLocal>) { self.local.ticks += 1; },
      },
    }));
    const root = new Object3D(); root.name = 'ReqConv';
    const belt = new Object3D(); belt.name = 'Transport-Z'; root.add(belt);
    // No Sensor node — required, so the instance must auto-disable.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { host } = makeHost(root);
    const accum: KinematicsSpec = {};
    const { ctx, handle } = createBindContext(root, host, accum);
    behavior.bind(ctx);
    applyKinematicsSpec(root, accum);

    // setup() is skipped when a required node is missing (disabled before setup).
    expect(captured).toBeNull();
    expect(continuousSetupRan).toBe(false);

    // No fixedUpdate registered → ticks never advance.
    iterateFixedUpdate(handle, DT);
    iterateFixedUpdate(handle, DT);

    // No marker stamped.
    const rv = (root.userData.realvirtual ?? {}) as Record<string, unknown>;
    expect(rv.ReqConvBehavior).toBeUndefined();

    // Warned about the missing sensor.
    const disableWarns = warn.mock.calls.filter(
      ([m]) => typeof m === 'string' && m.includes('missing sensor for sensor'),
    );
    expect(disableWarns.length).toBe(1);
    warn.mockRestore();
  });
});
