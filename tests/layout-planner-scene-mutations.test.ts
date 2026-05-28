// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for layout-planner/scene-mutations.ts — the pure module functions
 * extracted from LayoutPlannerPlugin in Plan-177 Phase 8.
 *
 * Exercises addPlacedToScene + removePlacedFromScene + resolveUniqueName
 * via a minimal `SceneMutationDeps` mock that captures hierarchy + the
 * registry / drives / transport-manager side-effects observable from
 * outside the module.
 */
import { describe, test, expect, vi } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshBasicMaterial, Scene } from 'three';
import type { Object3D } from 'three';

import {
  addPlacedToScene,
  addSplatPlacedToScene,
  removePlacedFromScene,
  resolveUniqueName,
  type SceneMutationDeps,
} from '../src/plugins/layout-planner/scene-mutations';

// ─── Helpers ────────────────────────────────────────────────────────────

function makeMesh(name = 'mesh'): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  m.name = name;
  return m;
}

function makeClone(name: string): Group {
  const g = new Group();
  g.name = name;
  g.add(makeMesh(name + '_geo'));
  return g;
}

interface MockViewer {
  scene: Scene;
  registry: {
    registerNode: ReturnType<typeof vi.fn>;
    unregisterSubtree: ReturnType<typeof vi.fn>;
    getPathForNode: ReturnType<typeof vi.fn>;
  } | null;
  signalStore: object | null;
  transportManager: {
    sensors: { node: Object3D }[];
    surfaces: { node: Object3D }[];
    sources: { node: Object3D }[];
    sinks: { node: Object3D }[];
    grips: { node: Object3D }[];
    gripTargets: { node: Object3D }[];
  } | null;
  drives: { node: Object3D }[];
  rebuildGroupedBvh: ReturnType<typeof vi.fn>;
  raycastManager: {
    addAuxRaycastTarget: ReturnType<typeof vi.fn>;
    removeAuxRaycastTarget: ReturnType<typeof vi.fn>;
  } | null;
  getPlugin: ReturnType<typeof vi.fn>;
}

function makeMockViewer(): MockViewer {
  return {
    scene: new Scene(),
    registry: {
      registerNode: vi.fn(),
      unregisterSubtree: vi.fn(() => new Set<string>()),
      getPathForNode: vi.fn(() => null),
    },
    signalStore: null, // null disables processExtras path
    transportManager: null,
    drives: [],
    rebuildGroupedBvh: vi.fn(),
    raycastManager: {
      addAuxRaycastTarget: vi.fn(),
      removeAuxRaycastTarget: vi.fn(),
    },
    getPlugin: vi.fn(),
  };
}

interface TestHarness {
  viewer: MockViewer;
  modelRoot: Group;
  layoutRoot: Group;
  objectMap: Map<string, Object3D>;
  idByObject: WeakMap<Object3D, string>;
  transformControls: { detach: ReturnType<typeof vi.fn> };
  deps: SceneMutationDeps;
}

function makeHarness(opts: { withModelRoot?: boolean } = {}): TestHarness {
  const viewer = makeMockViewer();
  const layoutRoot = new Group();
  layoutRoot.name = '_layoutRoot';
  viewer.scene.add(layoutRoot);

  let modelRoot: Group;
  if (opts.withModelRoot !== false) {
    modelRoot = new Group();
    modelRoot.name = 'modelRoot';
    viewer.scene.add(modelRoot);
  } else {
    modelRoot = null as unknown as Group;
  }

  const objectMap = new Map<string, Object3D>();
  const idByObject = new WeakMap<Object3D, string>();
  const transformControls = { detach: vi.fn() };

  const deps: SceneMutationDeps = {
    getViewer: () => viewer as never,
    objectMap,
    idByObject,
    getLayoutRoot: () => layoutRoot,
    getTransformControls: () => transformControls as never,
    getModelRoot: () => modelRoot,
  };

  return { viewer, modelRoot, layoutRoot, objectMap, idByObject, transformControls, deps };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('layout-planner/scene-mutations', () => {
  describe('addPlacedToScene', () => {
    test('parents clone under the model root when present', () => {
      const h = makeHarness();
      const clone = makeClone('belt');
      addPlacedToScene(h.deps, clone, 'id-1', 'Belt', 'cat:belt');
      expect(clone.parent).toBe(h.modelRoot);
      expect(h.modelRoot.children).toContain(clone);
    });

    test('falls back to layoutRoot when no model root is available', () => {
      const h = makeHarness({ withModelRoot: false });
      const clone = makeClone('belt');
      addPlacedToScene(h.deps, clone, 'id-1', 'Belt', 'cat:belt');
      expect(clone.parent).toBe(h.layoutRoot);
    });

    test('writes layout metadata onto clone + every descendant', () => {
      const h = makeHarness();
      const clone = makeClone('belt');
      addPlacedToScene(h.deps, clone, 'id-1', 'Belt', 'cat:belt');
      expect(clone.userData._layoutObject).toBe(true);
      expect(clone.userData._layoutId).toBe('id-1');
      const lo = (clone.userData.realvirtual as { LayoutObject: { Label: string; CatalogId: string; Locked: boolean } }).LayoutObject;
      expect(lo).toEqual({ Label: 'Belt', CatalogId: 'cat:belt', Locked: false });
      // Descendant mesh also marked
      const mesh = clone.children[0];
      expect(mesh.userData._layoutObject).toBe(true);
    });

    test('records the placement in objectMap and idByObject', () => {
      const h = makeHarness();
      const clone = makeClone('belt');
      addPlacedToScene(h.deps, clone, 'id-1', 'Belt', 'cat:belt');
      expect(h.objectMap.get('id-1')).toBe(clone);
      expect(h.idByObject.get(clone)).toBe('id-1');
    });

    test('registers every Mesh as an auxiliary raycast target', () => {
      const h = makeHarness();
      const clone = makeClone('belt');
      addPlacedToScene(h.deps, clone, 'id-1', 'Belt', 'cat:belt');
      expect(h.viewer.raycastManager!.addAuxRaycastTarget).toHaveBeenCalled();
      const calls = h.viewer.raycastManager!.addAuxRaycastTarget.mock.calls;
      // Every Mesh under clone → one call per mesh, all targeting clone
      expect(calls.length).toBeGreaterThan(0);
      for (const [, target] of calls) {
        expect(target).toBe(clone);
      }
    });
  });

  describe('resolveUniqueName', () => {
    test('keeps the name unchanged when no collision exists', () => {
      const h = makeHarness();
      const clone = makeClone('belt');
      h.modelRoot.add(clone);
      resolveUniqueName(h.deps, clone);
      expect(clone.name).toBe('belt');
    });

    test('suffixes _2, _3, ... when siblings share the base name', () => {
      const h = makeHarness();
      // Pre-populate model root with siblings that already use "belt".
      const sibling1 = makeClone('belt');
      const sibling2 = makeClone('belt_2');
      h.modelRoot.add(sibling1);
      h.modelRoot.add(sibling2);

      const clone = makeClone('belt');
      h.modelRoot.add(clone);
      resolveUniqueName(h.deps, clone);
      expect(clone.name).toBe('belt_3');
    });

    test('returns silently when registry is unavailable', () => {
      const h = makeHarness();
      h.viewer.registry = null;
      const clone = makeClone('belt');
      h.modelRoot.add(clone);
      resolveUniqueName(h.deps, clone);
      // No throw, name unchanged
      expect(clone.name).toBe('belt');
    });
  });

  describe('removePlacedFromScene', () => {
    test('removes the clone from its parent and clears objectMap', () => {
      const h = makeHarness();
      const clone = makeClone('belt');
      addPlacedToScene(h.deps, clone, 'id-1', 'Belt', 'cat:belt');
      expect(clone.parent).not.toBeNull();

      removePlacedFromScene(h.deps, 'id-1');
      expect(clone.parent).toBeNull();
      expect(h.objectMap.has('id-1')).toBe(false);
      expect(h.idByObject.get(clone)).toBeUndefined();
    });

    test('detaches the active transform gizmo', () => {
      const h = makeHarness();
      const clone = makeClone('belt');
      addPlacedToScene(h.deps, clone, 'id-1', 'Belt', 'cat:belt');
      removePlacedFromScene(h.deps, 'id-1');
      expect(h.transformControls.detach).toHaveBeenCalledTimes(1);
    });

    test('unregisters auxiliary raycast targets for every Mesh', () => {
      const h = makeHarness();
      const clone = makeClone('belt');
      addPlacedToScene(h.deps, clone, 'id-1', 'Belt', 'cat:belt');
      const addedCount = h.viewer.raycastManager!.addAuxRaycastTarget.mock.calls.length;

      removePlacedFromScene(h.deps, 'id-1');
      expect(h.viewer.raycastManager!.removeAuxRaycastTarget).toHaveBeenCalledTimes(addedCount);
    });

    test('is a silent no-op when id is unknown', () => {
      const h = makeHarness();
      // Should not throw, should not call gizmo.detach
      removePlacedFromScene(h.deps, 'does-not-exist');
      expect(h.transformControls.detach).not.toHaveBeenCalled();
    });

    test('filters transport-manager component arrays when registry path matches', () => {
      const h = makeHarness();
      const clone = makeClone('belt');
      addPlacedToScene(h.deps, clone, 'id-1', 'Belt', 'cat:belt');

      // Now wire a transport-manager AND make registry report a removed path.
      const removedPath = 'modelRoot/belt';
      h.viewer.transportManager = {
        sensors: [{ node: clone }, { node: makeClone('keep') }],
        surfaces: [],
        sources: [],
        sinks: [],
        grips: [],
        gripTargets: [],
      };
      // Spy the same removedPaths set the production code will read
      h.viewer.registry!.unregisterSubtree = vi.fn(() => new Set([removedPath]));
      // Stub computeNodePath via the NodeRegistry static call
      // (the production code calls NodeRegistry.computeNodePath). We don't
      // need to mock the static here — it works on real Three.js nodes.
      // But we DO need our `clone` to resolve to `removedPath`, so name it:
      clone.name = 'belt';
      // Re-register so name change is reflected
      removePlacedFromScene(h.deps, 'id-1');

      // The keep entry is retained (its computeNodePath is "keep", not the
      // removedPath). The clone entry should be filtered out — but only when
      // its computed path matches the removed path. With a fresh Scene >
      // modelRoot > belt the path is 'modelRoot/belt'. The keep sensor's
      // node has no parent, so its path won't match. Therefore the keep
      // sensor survives and the array shrinks to length 1.
      expect(h.viewer.transportManager.sensors.length).toBe(1);
    });
  });

  describe('addSplatPlacedToScene', () => {
    test('marks splat metadata and registers via NodeRegistry', () => {
      const h = makeHarness();
      const container = new Group();
      container.name = 'orig';
      addSplatPlacedToScene(h.deps, container, 'sid-1', 'Splatty', 'cat:splat', 'blob:abc');
      expect(container.userData._isSplat).toBe(true);
      expect(container.userData._splatUrl).toBe('blob:abc');
      expect(container.userData._layoutObject).toBe(true);
      expect(container.userData._layoutId).toBe('sid-1');
      expect(container.name).toBe('Splatty');
      expect(h.objectMap.get('sid-1')).toBe(container);
      expect(h.viewer.registry!.registerNode).toHaveBeenCalled();
    });
  });
});
