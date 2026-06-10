// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * library-state-inference.test.ts — Plan 197 §2.4b-C (Step 7C).
 *
 * The inline `state: () => ({...})` factory seeds `self.local` AND drives the
 * `S` generic by inference — an author can drop the separate `XxxLocal`
 * interface and the explicit `<XxxLocal>` type argument. `self.local` is then
 * typed as the inferred return shape.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import {
  createBindContext,
  iterateFixedUpdate,
  type BindContextHost,
  type KinematicsSpec,
} from '../src/core/behavior-runtime';
import { _resetCapabilitiesForTesting } from '../src/core/engine/rv-component-registry';
import { _resetMaterialFlowRegistry } from '../src/core/material-flow/registry';
import {
  defineLibraryComponent,
  _resetLibraryComponentMarkers,
} from '../src/behaviors/_shared/define-library-component';

const DT = 1 / 60;

beforeEach(() => {
  _resetMaterialFlowRegistry();
  _resetCapabilitiesForTesting();
  _resetLibraryComponentMarkers();
});

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

describe('state factory — generic inference + seeding', () => {
  it('infers S from `state` (no explicit type arg) and seeds self.local', () => {
    let seenAtSensor: boolean | undefined;
    let seenCount: number | undefined;
    let seenBlocked: number | undefined;

    // NOTE: NO explicit <Local> type argument — S is inferred from `state`.
    const behavior = defineLibraryComponent({
      type: 'StateInfer',
      kind: 'conveyor',
      schema: {},
      state: () => ({ partAtSensor: false, partCount: 0, blockedMUs: [] as number[] }),
      continuous: {
        setup(self) {
          // These compile ONLY because self.local is typed to the inferred shape.
          const a: boolean = self.local.partAtSensor;
          const c: number = self.local.partCount;
          const d: number[] = self.local.blockedMUs;
          self.local.partCount = 42;
          self.local.blockedMUs.push(1, 2, 3);
          seenAtSensor = a;
          seenCount = self.local.partCount;
          seenBlocked = d.length;
        },
        fixedUpdate(self) { self.local.partCount += 1; },
      },
    });

    const root = new Object3D(); root.name = 'StateInfer';
    const { host } = makeHost(root);
    const { ctx, handle } = createBindContext(root, host, {} as KinematicsSpec);
    behavior.bind(ctx);

    // Seeded + mutated in setup.
    expect(seenAtSensor).toBe(false);
    expect(seenCount).toBe(42);
    expect(seenBlocked).toBe(3);

    // fixedUpdate keeps mutating the same local slot.
    iterateFixedUpdate(handle, DT);
    iterateFixedUpdate(handle, DT);
    // (cannot read self.local from outside, but no throw = wired)
    expect(() => iterateFixedUpdate(handle, DT)).not.toThrow();
  });

  it('`local` (the alias) still works for the existing author style', () => {
    let ran = false;
    const behavior = defineLibraryComponent({
      type: 'StateAlias',
      kind: 'conveyor',
      schema: {},
      local: () => ({ flag: true }),
      continuous: {
        setup(self) { ran = self.local.flag; },
      },
    });
    const root = new Object3D(); root.name = 'StateAlias';
    const { host } = makeHost(root);
    const { ctx } = createBindContext(root, host, {} as KinematicsSpec);
    behavior.bind(ctx);
    expect(ran).toBe(true);
  });
});
