// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MuReconciler + planner-selectable predicate tests.
 *
 * The reconciler registers spawned clone-MU nodes as selectable scene nodes
 * (registry path + aux raycast targets + `_muSelectable`/`_muRef`) and NEVER
 * sets `_layoutId` (so MUs stay out of persistence + the gizmo). It diffs the
 * live MU list each frame and drops a consumed MU's selection.
 */

import { describe, it, expect } from 'vitest';
import { Mesh, BoxGeometry, MeshBasicMaterial, Object3D } from 'three';
import { MuReconciler } from '../src/plugins/layout-planner/mu-reconciler';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import {
  isMuSelectable, isPlannerSelectable, isLayoutInstance, findPlannerSelectableAncestor,
} from '../src/plugins/layout-planner/layout-predicates';
import type { RVViewer } from '../src/core/rv-viewer';

function makeMu(): RVMovingUnit {
  const node = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  node.name = 'Box';
  return new RVMovingUnit(node, 'src');
}

/** Stub viewer surface the reconciler touches. */
function makeHarness() {
  const registered = new Map<string, Object3D>();
  const auxTargets = new Set<Object3D>();
  let selectedPaths: string[] = [];
  const mus: RVMovingUnit[] = [];
  let dropped = 0;

  const viewer = {
    registry: {
      registerNode: (path: string, node: Object3D) => { registered.set(path, node); },
      unregisterSubtree: (root: Object3D) => {
        for (const [p, n] of registered) if (n === root) registered.delete(p);
        return new Set<string>();
      },
    },
    raycastManager: {
      addAuxRaycastTarget: (mesh: Object3D) => { auxTargets.add(mesh); },
      removeAuxRaycastTarget: (mesh: Object3D) => { auxTargets.delete(mesh); },
    },
    selectionManager: {
      getSnapshot: () => ({ selectedPaths, primaryPath: selectedPaths[0] ?? null }),
      selectPaths: (p: string[]) => { selectedPaths = p; },
    },
  } as unknown as RVViewer;

  const recon = new MuReconciler({
    viewer,
    getMUs: () => mus,
    onSelectionDropped: () => { dropped++; },
  });

  return {
    recon, mus, registered, auxTargets,
    setSelected: (p: string[]) => { selectedPaths = p; },
    getSelected: () => selectedPaths,
    getDropped: () => dropped,
  };
}

describe('MuReconciler', () => {
  it('registers a new MU as selectable WITHOUT _layoutId', () => {
    const h = makeHarness();
    const mu = makeMu();
    h.mus.push(mu);

    h.recon.reconcile();

    expect(mu.node.userData._muSelectable).toBe(true);
    expect(mu.node.userData._muRef).toBe(mu);
    expect(mu.node.userData._layoutId).toBeUndefined(); // never a layout placement
    expect(isMuSelectable(mu.node)).toBe(true);
    expect(isLayoutInstance(mu.node)).toBe(false);
    expect(h.registered.size).toBe(1);
    expect(h.auxTargets.has(mu.node)).toBe(true);
    expect(h.recon.objectMap.size).toBe(1);
  });

  it('unregisters a consumed MU and drops its selection', () => {
    const h = makeHarness();
    const mu = makeMu();
    h.mus.push(mu);
    h.recon.reconcile();
    const path = [...h.recon.objectMap.values()][0].path;
    h.setSelected([path]);

    // MU consumed → removed from the live list.
    h.mus.length = 0;
    h.recon.reconcile();

    expect(h.recon.objectMap.size).toBe(0);
    expect(h.registered.size).toBe(0);
    expect(h.auxTargets.size).toBe(0);
    expect(h.getSelected()).toEqual([]);   // selection dropped
    expect(h.getDropped()).toBe(1);
    expect(mu.node.userData._muSelectable).toBeUndefined();
  });

  it('ignores instanced MUs (no per-instance node)', () => {
    const h = makeHarness();
    const mu = makeMu();
    (mu as unknown as { isInstanced: boolean }).isInstanced = true;
    h.mus.push(mu);
    h.recon.reconcile();
    expect(h.recon.objectMap.size).toBe(0);
  });

  it('disposeAll unregisters everything', () => {
    const h = makeHarness();
    h.mus.push(makeMu(), makeMu());
    h.recon.reconcile();
    expect(h.recon.objectMap.size).toBe(2);

    h.recon.disposeAll();
    expect(h.recon.objectMap.size).toBe(0);
    expect(h.registered.size).toBe(0);
    expect(h.auxTargets.size).toBe(0);
  });
});

describe('planner-selectable predicates', () => {
  it('isMuSelectable / isPlannerSelectable / findPlannerSelectableAncestor', () => {
    const layout = new Object3D(); layout.userData._layoutId = 'lay_1';
    const mu = new Object3D(); mu.userData._muSelectable = true;
    const plain = new Object3D();

    expect(isMuSelectable(mu)).toBe(true);
    expect(isMuSelectable(layout)).toBe(false);
    expect(isPlannerSelectable(layout)).toBe(true);
    expect(isPlannerSelectable(mu)).toBe(true);
    expect(isPlannerSelectable(plain)).toBe(false);

    const child = new Object3D();
    mu.add(child);
    expect(findPlannerSelectableAncestor(child)).toBe(mu);
    expect(findPlannerSelectableAncestor(plain)).toBeNull();
  });
});
