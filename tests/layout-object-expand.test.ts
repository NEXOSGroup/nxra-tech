// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Plan-191: LayoutObject expand & Behavior Properties — integration tests.
 *
 * Validates that placed LayoutObjects become expandable in the hierarchy
 * panel, their internal drives/sensors/meshes are discoverable in
 * NodeRegistry, mesh-only children render as selectable rows, the
 * ancestor-resolution differentiates viewport vs tree clicks, the
 * Locked flag blocks sub-edits, and overlay sub-paths are purged on
 * deletion.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildTree } from '../src/core/hmi/hierarchy-utils';
import type { TreeNode } from '../src/core/hmi/hierarchy-utils';
import { RvExtrasEditorPlugin } from '../src/core/hmi/rv-extras-editor';
import {
  makeLayoutTestViewer,
  makeMockLayoutGLB,
  placeLayoutObject,
  registerSubtreePaths,
  unplaceLayoutObject,
  type LayoutTestViewer,
} from './helpers/test-layout-object';
import { collectAllTypes, findNode } from './helpers/tree-utils';

/**
 * Build the `editableNodes` array the way the rv-extras-editor plugin would
 * produce it, by walking the scene's userData.realvirtual entries.
 */
function collectEditableNodes(viewer: LayoutTestViewer) {
  const nodes: { path: string; types: string[] }[] = [];
  viewer.scene.traverse((node) => {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return;
    const types: string[] = [];
    for (const [k, v] of Object.entries(rv)) {
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) types.push(k);
    }
    if (types.length === 0) return;
    const path = viewer.registry.getPathForNode(node);
    if (!path) return;
    nodes.push({ path, types });
  });
  nodes.sort((a, b) => a.path.localeCompare(b.path));
  return nodes;
}

describe('plan-191: LayoutObject expand', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // §9.1 — buildTree Lazy injection ─────────────────────────────────────

  describe('buildTree Lazy injection', () => {
    it('does NOT inject mesh-only children when LayoutObject is not expanded', () => {
      // Place a layout object that has BOTH rv_extras children (Drive, Sensor)
      // and mesh-only children (Mesh1/Mesh2). The rv_extras children appear in
      // editableNodes and so build into the tree unconditionally; the mesh-only
      // children may only appear via lazy injection when the parent is expanded.
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RollConveyor2m', 'cat:rc');

      const nodes = collectEditableNodes(viewer);
      // viewer cast: buildTree only reads .registry, makeLayoutTestViewer provides it
      const treeCollapsed = buildTree(nodes, null, viewer as never, new Set());
      const layoutNodeCollapsed = findNode(treeCollapsed, (n) => n.types.includes('LayoutObject'));
      expect(layoutNodeCollapsed).not.toBeNull();
      // Collapsed: mesh-only children must NOT have been injected
      const collapsedMeshChildren = layoutNodeCollapsed!.children.filter((c) => c.types.length === 0);
      expect(collapsedMeshChildren.length).toBe(0);
      // But the row must still advertise expandability so the caret renders.
      expect(layoutNodeCollapsed!.canExpandLazy).toBe(true);

      // Expanded: mesh-only children must now appear
      const treeExpanded = buildTree(nodes, null, viewer as never, new Set(['modelRoot/RollConveyor2m']));
      const layoutNodeExpanded = findNode(treeExpanded, (n) => n.types.includes('LayoutObject'))!;
      const expandedMeshChildren = layoutNodeExpanded.children.filter((c) => c.types.length === 0);
      expect(expandedMeshChildren.length).toBeGreaterThan(0);
    });

    it('injects children when LayoutObject is in expandedPaths', () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RollConveyor2m', 'cat:rc');

      const nodes = collectEditableNodes(viewer);
      const expanded = new Set(['modelRoot/RollConveyor2m']);
      const tree = buildTree(nodes, null, viewer as never, expanded);
      const layoutNode = findNode(tree, (n) => n.types.includes('LayoutObject'));
      expect(layoutNode).not.toBeNull();
      expect(layoutNode!.children.length).toBeGreaterThan(0);

      // Drive child must be among injected children
      const drive = findNode(layoutNode!.children, (c) => c.types.includes('Drive'));
      expect(drive).not.toBeNull();
      // Sensor as well
      const sensor = findNode(layoutNode!.children, (c) => c.types.includes('Sensor'));
      expect(sensor).not.toBeNull();
    });

    it('renders mesh-only children with types=[] under an expanded LayoutObject (§9.4)', () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');

      const nodes = collectEditableNodes(viewer);
      const tree = buildTree(nodes, null, viewer as never, new Set(['modelRoot/RC']));
      const layoutNode = findNode(tree, (n) => n.types.includes('LayoutObject'))!;
      const meshOnly = layoutNode.children.find((c) => c.types.length === 0);
      expect(meshOnly).toBeDefined();
      // Expect at least one Mesh1 / Mesh2 entry
      const meshNames = layoutNode.children.filter((c) => c.types.length === 0).map((c) => c.name);
      expect(meshNames.length).toBeGreaterThanOrEqual(1);
    });
  });

  // §9.3 — Layout-Planner NodeRegistry registration ─────────────────────

  describe('Layout-Planner NodeRegistry registration', () => {
    it('exposes inner rv_extras nodes after place (§9.3)', () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      const root = viewer.registry.getNode('modelRoot/RC');
      expect(root).toBeDefined();
      const drive = viewer.registry.getNode('modelRoot/RC/Drive-Lin-X');
      expect(drive).not.toBeNull();
    });

    it('registers mesh-only descendants too (so tree-injection finds them via dedup)', () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      // Mesh1 / Mesh2 are mesh-only — also indexed by registerSubtreePaths
      expect(viewer.registry.getNode('modelRoot/RC/Mesh1')).not.toBeNull();
    });
  });

  // §9.2 — Sub-Drive overlay editing ────────────────────────────────────

  describe('Sub-component overlay editing', () => {
    it('updates sub-drive speed via updateOverlayField (§9.2)', () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      const subPath = 'modelRoot/RC/Drive-Lin-X';
      const ok = viewer.rvExtrasEditor.updateOverlayField(subPath, 'Drive', 'TargetSpeed', 250);
      expect(ok).toBe(true);
      const node = viewer.registry.getNode(subPath);
      const rv = node?.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
      expect(rv?.Drive?.TargetSpeed).toBe(250);
    });
  });

  // §9.7 — Locked-Flag blocks sub-edits ─────────────────────────────────

  describe('Locked LayoutObject blocks sub-edits (§9.7)', () => {
    it('updateOverlayField returns false when ancestor is Locked', () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      const root = viewer.registry.getNode('modelRoot/RC');
      const rv = root!.userData.realvirtual as Record<string, Record<string, unknown>>;
      rv.LayoutObject.Locked = true;

      const subPath = 'modelRoot/RC/Drive-Lin-X';
      const before = (viewer.registry.getNode(subPath)!.userData.realvirtual as Record<string, Record<string, unknown>>).Drive.TargetSpeed;
      const ok = viewer.rvExtrasEditor.updateOverlayField(subPath, 'Drive', 'TargetSpeed', 999);
      expect(ok).toBe(false);
      const after = (viewer.registry.getNode(subPath)!.userData.realvirtual as Record<string, Record<string, unknown>>).Drive.TargetSpeed;
      expect(after).toBe(before);
    });

    it('still allows editing the LayoutObject root itself when Locked=true', () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      const root = viewer.registry.getNode('modelRoot/RC');
      const rv = root!.userData.realvirtual as Record<string, Record<string, unknown>>;
      rv.LayoutObject.Locked = true;
      const ok = viewer.rvExtrasEditor.updateOverlayField('modelRoot/RC', 'LayoutObject', 'Locked', false);
      expect(ok).toBe(true);
    });
  });

  // §9.8 — selectNode source differentiation ────────────────────────────

  describe('selectNode source differentiation (§9.8)', () => {
    it("source='viewport' resolves a sub-path up to the LayoutObject ancestor", () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      viewer.rvExtrasEditor.selectNode('modelRoot/RC/Drive-Lin-X', false, 'viewport');
      expect(viewer.rvExtrasEditor.getSelectedPath()).toBe('modelRoot/RC');
    });

    it("source='tree' keeps the explicit sub-path", () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      viewer.rvExtrasEditor.selectNode('modelRoot/RC/Drive-Lin-X', false, 'tree');
      expect(viewer.rvExtrasEditor.getSelectedPath()).toBe('modelRoot/RC/Drive-Lin-X');
    });

    it("source='api' (default) keeps the explicit sub-path", () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      viewer.rvExtrasEditor.selectNode('modelRoot/RC/Drive-Lin-X');
      expect(viewer.rvExtrasEditor.getSelectedPath()).toBe('modelRoot/RC/Drive-Lin-X');
    });

    it("legacy two-arg form selectNode(path, true) still works", () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      viewer.rvExtrasEditor.selectNode('modelRoot/RC/Drive-Lin-X', true);
      const snap = viewer.rvExtrasEditor.getSnapshot();
      expect(snap.selectedNodePath).toBe('modelRoot/RC/Drive-Lin-X');
      expect(snap.showInspector).toBe(true);
    });
  });

  // §9.9 — Op-log cleanup on delete ─────────────────────────────────────

  describe('Sub-overlay cleanup on LayoutObject delete (§9.9)', () => {
    it('purgeOverlaysForSubtree removes prefix and sub-path entries', () => {
      const editor = new RvExtrasEditorPlugin();
      // Seed the legacy in-memory overlay directly via the public mutator
      // (no scene store wired → legacy path).
      // We can't easily hit the boot path without a glbName so we
      // simulate by calling updateOverlayField on a stub viewer.
      const stub = {
        registry: {
          getNode: () => ({ userData: { realvirtual: { Drive: { Speed: 0 } } } }),
          getPathForNode: () => null,
        },
      } as unknown as { registry: unknown };
      (editor as unknown as { _viewer: unknown })._viewer = stub;

      // No SceneStore: legacy path writes into _overlay directly
      editor.updateOverlayField('RC', 'LayoutObject', 'Label', 'X');
      editor.updateOverlayField('RC/Drive-Lin-X', 'Drive', 'TargetSpeed', 250);
      editor.updateOverlayField('Other', 'Drive', 'TargetSpeed', 999);

      const removed = editor.purgeOverlaysForSubtree('RC');
      expect(removed).toBeGreaterThanOrEqual(2);
      const snap = editor.getSnapshot();
      // 'Other' must remain
      expect(snap.overlay?.nodes['Other']).toBeDefined();
      expect(snap.overlay?.nodes['RC']).toBeUndefined();
      expect(snap.overlay?.nodes['RC/Drive-Lin-X']).toBeUndefined();
    });

    it('removePlacedFromScene triggers overlay purge via editor plugin hook', () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      viewer.rvExtrasEditor.updateOverlayField('modelRoot/RC/Drive-Lin-X', 'Drive', 'TargetSpeed', 250);
      // Snapshot the editor's view of the overlay
      const before = viewer.rvExtrasEditor.getSnapshot();
      expect(before.overlay?.nodes['modelRoot/RC/Drive-Lin-X']).toBeDefined();

      unplaceLayoutObject(viewer, 'id1');

      const after = viewer.rvExtrasEditor.getSnapshot();
      expect(after.overlay?.nodes?.['modelRoot/RC/Drive-Lin-X']).toBeUndefined();
    });
  });

  // §9.10 — Path sanitization ───────────────────────────────────────────

  describe('Path sanitization (§9.10)', () => {
    it('replaces "/" in node names with "_" during Three.js child injection', () => {
      const viewer = makeLayoutTestViewer();
      const glb = makeMockLayoutGLB({
        rootName: 'Item',
        children: [{ name: 'Door/Frame' }],
      });
      placeLayoutObject(viewer, 'id1', 'Item', 'cat:item', glb);

      const nodes = collectEditableNodes(viewer);
      const tree = buildTree(nodes, null, viewer as never, new Set(['modelRoot/Item']));
      const layoutNode = findNode(tree, (n) => n.types.includes('LayoutObject'))!;
      // Find a child whose generated path ends with the sanitized name
      const child = layoutNode.children.find((c) => c.path?.endsWith('/Door_Frame'));
      expect(child).toBeDefined();
    });
  });

  // §9.11 — Performance: collapsed buildTree stays near baseline ────────

  describe('Performance', () => {
    it('builds tree for a large LayoutObject (50+ mesh children) under 50ms when expanded', () => {
      const viewer = makeLayoutTestViewer();
      const glb = makeMockLayoutGLB({ rootName: 'Big', meshes: 50 });
      placeLayoutObject(viewer, 'id1', 'Big', 'cat:big', glb);
      const nodes = collectEditableNodes(viewer);
      const t0 = performance.now();
      buildTree(nodes, null, viewer as never, new Set(['modelRoot/Big']));
      const elapsed = performance.now() - t0;
      expect(elapsed).toBeLessThan(50);
    });

    it('collapsed buildTree has negligible overhead vs the no-viewer baseline', () => {
      const viewer = makeLayoutTestViewer();
      const glb = makeMockLayoutGLB({ rootName: 'Big', meshes: 100 });
      placeLayoutObject(viewer, 'id1', 'Big', 'cat:big', glb);
      const nodes = collectEditableNodes(viewer);
      // Warmup runs to stabilise JIT
      for (let i = 0; i < 3; i++) buildTree(nodes, null);
      for (let i = 0; i < 3; i++) buildTree(nodes, null, viewer as never, new Set());

      const t1 = performance.now();
      for (let i = 0; i < 5; i++) buildTree(nodes, null);
      const baseline = performance.now() - t1;
      const t2 = performance.now();
      for (let i = 0; i < 5; i++) buildTree(nodes, null, viewer as never, new Set());
      const withLazy = performance.now() - t2;
      // Lazy path adds an empty tree-walk; cap at 3x baseline + 5ms slack
      // (warmup + measurement noise on slow CI runners)
      expect(withLazy).toBeLessThan(baseline * 3 + 5);
    });
  });

  // §9.6 — Expand state persistence (direct LS) ─────────────────────────

  describe('Expand state persistence (§9.6)', () => {
    it('serialises a LayoutObject path through rv-hierarchy-expanded LS key', () => {
      const key = 'rv-hierarchy-expanded';
      const expanded = new Set(['modelRoot/RC']);
      localStorage.setItem(key, JSON.stringify([...expanded]));
      const loaded = new Set<string>(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]);
      expect(loaded.has('modelRoot/RC')).toBe(true);
    });
  });

  // §9.5 — Filter behaviour with sub-drives ─────────────────────────────

  describe('Filter behaviour (§9.5)', () => {
    it('flat editableNodes view includes sub-drives once processExtras-registered', () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      const nodes = collectEditableNodes(viewer);
      const hasSubDrive = nodes.some(
        (n) => n.types.includes('Drive') && n.path.startsWith('modelRoot/RC/'),
      );
      expect(hasSubDrive).toBe(true);
    });

    it('tree-expanded view of an "all"-filter tree surfaces sub-drives', () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      const nodes = collectEditableNodes(viewer);
      const tree = buildTree(nodes, null, viewer as never, new Set(['modelRoot/RC']));
      const types = collectAllTypes(tree);
      expect(types).toContain('Drive');
      expect(types).toContain('Sensor');
    });
  });
});

// ─── findLayoutObjectAncestor ─────────────────────────────────────────────

describe('findLayoutObjectAncestor', () => {
  it('returns the LayoutObject root for a mesh-only sub-path', () => {
    const viewer = makeLayoutTestViewer();
    placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
    const ancestor = viewer.rvExtrasEditor.findLayoutObjectAncestor('modelRoot/RC/Mesh1');
    expect(ancestor).toBe('modelRoot/RC');
  });

  it('returns the path itself when called on a LayoutObject root', () => {
    const viewer = makeLayoutTestViewer();
    placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
    const ancestor = viewer.rvExtrasEditor.findLayoutObjectAncestor('modelRoot/RC');
    expect(ancestor).toBe('modelRoot/RC');
  });

  it('returns null when no LayoutObject is in the ancestry', () => {
    const viewer = makeLayoutTestViewer();
    // modelRoot is not a LayoutObject
    const ancestor = viewer.rvExtrasEditor.findLayoutObjectAncestor('modelRoot');
    expect(ancestor).toBeNull();
  });
});
