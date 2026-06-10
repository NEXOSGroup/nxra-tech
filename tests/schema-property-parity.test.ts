// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import {
  createBindContext,
  applyKinematicsSpec,
  type BindContextHost,
  type KinematicsSpec,
} from '../src/core/behavior-runtime';
import { getSchemaDefaults, _resetCapabilitiesForTesting } from '../src/core/engine/rv-component-registry';
import { getConsumedFields } from '../src/core/engine/rv-extras-validator';
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

function makeHost(root: Object3D): BindContextHost {
  const subs = new Map<string, Set<(v: boolean | number) => void>>();
  const values = new Map<string, boolean | number>();
  const events = new EventEmitter<Record<string, unknown>>();
  return {
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
}

interface FooLocal { ok: boolean; }

function makeFooFactory() {
  return defineLibraryComponent<FooLocal>({
    type: 'Foo',
    kind: 'station',
    models: ['*Foo*'],
    schema: {
      Period:   { type: 'number', default: 1.5 },
      MaxSpeed: { type: 'number', default: 1000, readonly: true },
    },
    state: (): FooLocal => ({ ok: true }),
    continuous: {
      setup() { /* no-op */ },
    },
  });
}

describe('schema-property-parity — factory bind stamps schema defaults', () => {
  it('userData.realvirtual.FooBehavior carries the getSchemaDefaults values', () => {
    const behavior = makeFooFactory();
    const root = new Object3D(); root.name = 'Foo';
    const host = makeHost(root);
    const accum: KinematicsSpec = {};
    const { ctx } = createBindContext(root, host, accum);
    behavior.bind(ctx);
    applyKinematicsSpec(root, accum);

    const defaults = getSchemaDefaults('FooBehavior');
    expect(defaults).toMatchObject({ Period: 1.5, MaxSpeed: 1000 });

    const stamped = (root.userData.realvirtual as Record<string, unknown>).FooBehavior as Record<string, unknown>;
    expect(stamped).toMatchObject({ Period: 1.5, MaxSpeed: 1000 });
  });

  it('getConsumedFields(FooBehavior) contains the schema keys → inspector "consumed"', () => {
    makeFooFactory();
    const consumed = getConsumedFields('FooBehavior');
    expect(consumed).toContain('Period');
    expect(consumed).toContain('MaxSpeed');
  });
});
