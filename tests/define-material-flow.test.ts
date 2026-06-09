// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import { BehaviorManager } from '../src/core/behaviors';
import {
  createBindContext,
  iterateFixedUpdate,
  type BindContextHost,
  type KinematicsSpec,
} from '../src/core/behavior-runtime';
import {
  defineMaterialFlow,
  toBehavior,
  type MaterialFlowDefinition,
} from '../src/core/material-flow/define-material-flow';
import {
  matchMaterialFlows,
  getMaterialFlow,
  getDesActionNames,
  _resetMaterialFlowRegistry,
} from '../src/core/material-flow/registry';
import type { MaterialFlowSelf } from '../src/core/material-flow/material-flow-self';

beforeEach(() => {
  _resetMaterialFlowRegistry();
});

// A minimal, self-contained material-flow definition for testing.
function makeDef(over: Partial<MaterialFlowDefinition> = {}): MaterialFlowDefinition {
  const calls: string[] = [];
  const def: MaterialFlowDefinition = {
    type: 'TestFlow',
    kind: 'conveyor',
    models: ['*TestFlow*'],
    schema: { Speed: { type: 'number', default: 100 } },
    logic: {
      shouldFlow(_self: MaterialFlowSelf) { return true; },
    },
    continuous: {
      setup(self) { (self.prop as Record<string, unknown>)['_calls'] = calls; calls.push('setup'); },
      fixedUpdate(_self, _dt) { calls.push('fixedUpdate'); },
    },
    des: {
      onArrival() { /* no-op */ },
      canAccept() { return true; },
    },
    ...over,
  };
  return def;
}

function makeHost(root: Object3D): BindContextHost {
  const subs = new Map<string, Set<(v: boolean | number) => void>>();
  const values = new Map<string, boolean | number>();
  return {
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
  } as BindContextHost;
}

describe('defineMaterialFlow — registration', () => {
  it('registers the definition and returns it unchanged', () => {
    const def = makeDef();
    const ret = defineMaterialFlow(def);
    expect(ret).toBe(def);
    expect(getMaterialFlow('TestFlow')).toBe(def);
  });

  it('exposes the shared logic block for direct testing', () => {
    const def = defineMaterialFlow(makeDef());
    expect(typeof def.logic!.shouldFlow).toBe('function');
    expect(def.logic!.shouldFlow({} as MaterialFlowSelf)).toBe(true);
  });

  it('reserves DES action names <type>.<Hook> for present des hooks', () => {
    defineMaterialFlow(makeDef());
    const actions = getDesActionNames('TestFlow');
    expect(actions).toContain('TestFlow.Arrival');
    expect(actions).toContain('TestFlow.CanAccept');
    // A hook NOT present in the des block is not reserved.
    expect(actions).not.toContain('TestFlow.Generate');
  });
});

describe('defineMaterialFlow — continuous-matcher via glob', () => {
  it('resolves models[] through compileGlob/matchesAny', () => {
    defineMaterialFlow(makeDef({ type: 'Conv', models: ['*Conveyor*'] }));
    expect(matchMaterialFlows('RollConveyor2m').map(d => d.type)).toContain('Conv');
    expect(matchMaterialFlows('Conveyor_Infeed').map(d => d.type)).toContain('Conv');
    expect(matchMaterialFlows('Turntable')).toHaveLength(0);
  });

  it('defaults models to ["*<type>*"] when omitted', () => {
    defineMaterialFlow(makeDef({ type: 'Widget', models: undefined }));
    expect(matchMaterialFlows('SuperWidget3000').map(d => d.type)).toContain('Widget');
  });
});

describe('toBehavior — shim is defineBehavior-compatible', () => {
  it('produces a Behavior with the definition models', () => {
    const def = makeDef({ models: ['*Conveyor*'] });
    const b = toBehavior(def);
    expect(b.models).toEqual(['*Conveyor*']);
    expect(typeof b.bind).toBe('function');
  });

  it('dispatches setup on bind and fixedUpdate on each tick (via the bind context)', () => {
    const calls: string[] = [];
    const def = makeDef({
      type: 'ShimFlow', models: ['*ShimFlow*'],
      continuous: {
        setup() { calls.push('setup'); },
        fixedUpdate() { calls.push('fixedUpdate'); },
      },
      des: undefined,
    });
    const behavior = toBehavior(def);

    const root = new Object3D(); root.name = 'ShimFlow';
    const host = makeHost(root);
    const accum: KinematicsSpec = {};
    const { ctx, handle } = createBindContext(root, host, accum);

    // bind() runs continuous.setup (1×), and registers continuous.fixedUpdate.
    behavior.bind(ctx);
    expect(calls).toEqual(['setup']);

    iterateFixedUpdate(handle, 1 / 60);
    expect(calls).toEqual(['setup', 'fixedUpdate']);
    iterateFixedUpdate(handle, 1 / 60);
    expect(calls).toEqual(['setup', 'fixedUpdate', 'fixedUpdate']);

    // After dispose, no more fixedUpdate dispatches.
    handle.dispose();
    iterateFixedUpdate(handle, 1 / 60);
    expect(calls).toEqual(['setup', 'fixedUpdate', 'fixedUpdate']);
  });

  it('is discoverable + dispatchable through a real BehaviorManager (setup runs)', () => {
    const calls: string[] = [];
    const def = makeDef({
      type: 'MgrFlow', models: ['*MgrFlow*'],
      continuous: { setup() { calls.push('setup'); } },
      des: undefined,
    });
    const mgr = new BehaviorManager();
    mgr.register('MgrFlow', toBehavior(def));
    const root = new Object3D(); root.name = 'MgrFlow';
    mgr.triggerLoad(makeHost(root), root, 'MgrFlow');
    expect(calls).toEqual(['setup']);
  });

  it('runs teardown on dispose when authored', () => {
    const calls: string[] = [];
    const def = makeDef({
      type: 'TearFlow', models: ['*TearFlow*'],
      continuous: {
        setup() { calls.push('setup'); },
        teardown() { calls.push('teardown'); },
      },
      des: undefined,
    });
    const mgr = new BehaviorManager();
    mgr.register('TearFlow', toBehavior(def));
    const root = new Object3D(); root.name = 'TearFlow';
    mgr.triggerLoad(makeHost(root), root, 'TearFlow');
    expect(calls).toEqual(['setup']);
    mgr.disposeAll();
    expect(calls).toEqual(['setup', 'teardown']);
  });
});
