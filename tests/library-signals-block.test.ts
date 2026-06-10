// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * library-signals-block.test.ts — Plan 197 §2.4b-A (Step 7A).
 *
 * The optional `signals` block auto-declares each signal as `${type}.${key}`
 * with the correct type + typed default, and `self.sig.<key>` exposes a typed
 * `get()/set()` round-tripping through the SignalStore.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import {
  createBindContext,
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

beforeEach(() => {
  _resetMaterialFlowRegistry();
  _resetCapabilitiesForTesting();
  _resetLibraryComponentMarkers();
});

// ─── Mock host (captures registered signals + values) ────────────────────────

function makeHost(root: Object3D): {
  host: BindContextHost;
  values: Map<string, boolean | number>;
  registered: { name: string; path: string; initialValue: boolean | number; plcType?: string }[];
} {
  const subs = new Map<string, Set<(v: boolean | number) => void>>();
  const values = new Map<string, boolean | number>();
  const registered: { name: string; path: string; initialValue: boolean | number; plcType?: string }[] = [];
  const events = new EventEmitter<Record<string, unknown>>();
  const host: BindContextHost = {
    signalStore: {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => { values.set(n, v); subs.get(n)?.forEach((cb) => cb(v)); },
      subscribe: (n: string, cb: (v: boolean | number) => void) => {
        let s = subs.get(n); if (!s) { s = new Set(); subs.set(n, s); }
        s.add(cb); return () => { s!.delete(cb); };
      },
      register: (name, path, initialValue, plcType) => {
        registered.push({ name, path, initialValue, plcType });
        values.set(name, initialValue);
      },
    },
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: [],
    registry: null,
  };
  return { host, values, registered };
}

// The Conveyor signal contract, expressed as the declarative `signals` block.
const SIGNALS = {
  Run: 'PLCInputBool',
  Occupied: 'PLCOutputBool',
  Running: 'PLCOutputBool',
  PartCount: 'PLCOutputInt',
} as const;

type Sig = typeof SIGNALS;
interface DemoLocal { ran: boolean; }

describe('signals block — auto-declaration', () => {
  it('declares all 4 signals with scoped names + correct types into the spec', () => {
    const captured: { name: string; type: string; initialValue: unknown }[] = [];
    const behavior = defineLibraryComponent<DemoLocal, Sig>({
      type: 'SigDemo',
      kind: 'conveyor',
      schema: {},
      signals: SIGNALS,
      state: (): DemoLocal => ({ ran: false }),
      continuous: {},
    });
    const root = new Object3D(); root.name = 'SigDemo';
    const { host } = makeHost(root);
    const accum: KinematicsSpec = {};
    const { ctx } = createBindContext(root, host, accum);
    // Spy on signal accumulation via the resulting spec entries.
    behavior.bind(ctx);
    for (const s of accum.signals ?? []) captured.push({ name: s.name, type: s.type, initialValue: s.initialValue });

    const byName = new Map(captured.map(s => [s.name, s]));
    expect(byName.get('SigDemo.Run')).toMatchObject({ type: 'PLCInputBool', initialValue: false });
    expect(byName.get('SigDemo.Occupied')).toMatchObject({ type: 'PLCOutputBool', initialValue: false });
    expect(byName.get('SigDemo.Running')).toMatchObject({ type: 'PLCOutputBool', initialValue: false });
    expect(byName.get('SigDemo.PartCount')).toMatchObject({ type: 'PLCOutputInt', initialValue: 0 });
    expect(captured.length).toBe(4);
  });
});

describe('signals block — self.sig accessors round-trip', () => {
  it('self.sig.X.get()/set() reads/writes the store under the scoped name', () => {
    let captured: MaterialFlowSelf<DemoLocal, Sig> | null = null;
    const behavior = defineLibraryComponent<DemoLocal, Sig>({
      type: 'SigRT',
      kind: 'conveyor',
      schema: {},
      signals: SIGNALS,
      state: (): DemoLocal => ({ ran: false }),
      continuous: { setup(self) { captured = self; } },
    });
    const root = new Object3D(); root.name = 'SigRT';
    const { host, values } = makeHost(root);
    const accum: KinematicsSpec = {};
    const { ctx } = createBindContext(root, host, accum);
    behavior.bind(ctx);
    expect(captured).not.toBeNull();
    const self = captured!;

    // The factory auto-declares signals into the spec; the BehaviorManager
    // seeds their initial values into the store post-bind. Mirror that here so
    // the first `get()` sees the declared initial value (not an unseeded read).
    for (const s of accum.signals ?? []) {
      if (s.initialValue !== undefined) values.set(s.name, s.initialValue);
    }

    // Bool round-trip.
    expect(self.sig.Run.get()).toBe(false);
    self.sig.Run.set(true);
    expect(self.sig.Run.get()).toBe(true);
    expect(values.get('SigRT.Run')).toBe(true);

    // Int round-trip.
    self.sig.PartCount.set(7);
    expect(self.sig.PartCount.get()).toBe(7);
    expect(values.get('SigRT.PartCount')).toBe(7);
  });

  it('value types are derived from the PLC type (compile-time)', () => {
    const behavior = defineLibraryComponent<DemoLocal, Sig>({
      type: 'SigTypes',
      kind: 'conveyor',
      schema: {},
      signals: SIGNALS,
      state: (): DemoLocal => ({ ran: false }),
      continuous: {
        setup(self) {
          const b: boolean = self.sig.Run.get();      // Bool → boolean
          const n: number = self.sig.PartCount.get();  // Int  → number
          self.sig.Occupied.set(true);                 // Bool set accepts boolean
          self.sig.PartCount.set(3);                   // Int set accepts number
          // @ts-expect-error — Run is a Bool signal; set(number) must not type-check.
          self.sig.Run.set(5);
          // @ts-expect-error — PartCount is an Int signal; set(boolean) must not type-check.
          self.sig.PartCount.set(true);
          // @ts-expect-error — Unknown key must not type-check.
          self.sig.Nope?.get();
          void b; void n;
        },
      },
    });
    const root = new Object3D(); root.name = 'SigTypes';
    const { host } = makeHost(root);
    const { ctx } = createBindContext(root, host, {} as KinematicsSpec);
    expect(() => behavior.bind(ctx)).not.toThrow();
  });
});
