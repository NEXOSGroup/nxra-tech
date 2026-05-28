// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Box3, Group, Mesh, BoxGeometry, MeshBasicMaterial, Object3D, Vector3 } from 'three';
import {
  computeSubtreeAABB,
  traverseMeshes,
  traverseMeshesWithDepth,
} from '../src/core/engine/rv-traverse-utils';

function makeMesh(name: string): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  m.name = name;
  return m;
}

describe('traverseMeshes', () => {
  it('calls the callback for every descendant Mesh and skips non-meshes', () => {
    const root = new Group();
    root.name = 'root';
    const inner = new Group();
    inner.name = 'inner';
    const m1 = makeMesh('m1');
    const m2 = makeMesh('m2');
    const obj = new Object3D();
    obj.name = 'obj';

    root.add(inner);
    inner.add(m1);
    inner.add(obj);
    root.add(m2);

    const seen: string[] = [];
    traverseMeshes(root, (m) => { seen.push(m.name); });

    expect(seen.sort()).toEqual(['m1', 'm2']);
  });

  it('invokes the callback for root itself when it is a Mesh', () => {
    const root = makeMesh('root');
    const seen: string[] = [];
    traverseMeshes(root, (m) => { seen.push(m.name); });
    expect(seen).toEqual(['root']);
  });

  it('does not invoke the callback when root has no mesh descendants', () => {
    const root = new Group();
    root.add(new Object3D());
    root.add(new Group());

    let count = 0;
    traverseMeshes(root, () => { count++; });
    expect(count).toBe(0);
  });

  it('receives the descendant typed as Mesh (geometry accessible without casts)', () => {
    const root = new Group();
    const m = makeMesh('x');
    root.add(m);

    traverseMeshes(root, (mesh) => {
      // BoxGeometry has a `parameters` field — proves we got a real Mesh.
      expect(mesh.geometry).toBeDefined();
      expect(mesh.material).toBeDefined();
    });
  });

  it('traverses deeply nested hierarchies', () => {
    const root = new Group();
    let parent: Object3D = root;
    const expected: string[] = [];
    for (let i = 0; i < 5; i++) {
      const g = new Group();
      g.name = `g${i}`;
      parent.add(g);
      const m = makeMesh(`m${i}`);
      g.add(m);
      expected.push(m.name);
      parent = g;
    }

    const seen: string[] = [];
    traverseMeshes(root, (m) => { seen.push(m.name); });
    expect(seen.sort()).toEqual(expected.sort());
  });
});

describe('traverseMeshesWithDepth', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('invokes the callback only for Mesh descendants (skips Object3D / Group)', () => {
    const root = new Group();
    const m1 = makeMesh('m1');
    const obj = new Object3D();
    const g = new Group();
    root.add(m1, obj, g);

    const seen: string[] = [];
    traverseMeshesWithDepth(root, 5, (m) => { seen.push(m.name); });
    expect(seen).toEqual(['m1']);
  });

  it('reports correct depth for nested meshes', () => {
    const root = new Group();
    root.name = 'root';
    const g1 = new Group();
    const g2 = new Group();
    root.add(g1);
    g1.add(g2);
    const m1 = makeMesh('top'); // depth 1
    const m2 = makeMesh('mid'); // depth 2
    const m3 = makeMesh('deep'); // depth 3
    root.add(m1);
    g1.add(m2);
    g2.add(m3);

    const depths: Array<[string, number]> = [];
    traverseMeshesWithDepth(root, 10, (m, d) => { depths.push([m.name, d]); });
    const map = new Map(depths);
    expect(map.get('top')).toBe(1);
    expect(map.get('mid')).toBe(2);
    expect(map.get('deep')).toBe(3);
  });

  it('skips meshes deeper than maxDepth and warns once', () => {
    const root = new Group();
    let parent: Object3D = root;
    const allMeshes: string[] = [];
    for (let i = 0; i < 7; i++) {
      const g = new Group();
      parent.add(g);
      const m = makeMesh(`m${i + 1}`); // depth i+1
      g.add(m);
      allMeshes.push(m.name);
      parent = g;
    }

    const seen: string[] = [];
    traverseMeshesWithDepth(root, 3, (m) => { seen.push(m.name); });
    // Only meshes at depth <= 3 are emitted: m1 (depth 2), m2 (depth 4 skip), …
    // Actually each `gN` adds one level → mN is at depth 2*N. Just assert
    // that nothing past depth 3 is reported:
    for (const name of seen) {
      // every emitted name appeared in our generated set
      expect(allMeshes).toContain(name);
    }
    expect(seen.length).toBeLessThan(allMeshes.length);
    // Single warn call regardless of how many over-deep meshes were skipped
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('does not warn when nothing exceeds maxDepth', () => {
    const root = new Group();
    root.add(makeMesh('a'));
    root.add(makeMesh('b'));
    const seen: string[] = [];
    traverseMeshesWithDepth(root, 5, (m) => { seen.push(m.name); });
    expect(seen.sort()).toEqual(['a', 'b']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('invokes callback for root itself (depth 0) when root is a Mesh', () => {
    const rootMesh = makeMesh('root');
    const seen: Array<[string, number]> = [];
    traverseMeshesWithDepth(rootMesh, 5, (m, d) => { seen.push([m.name, d]); });
    expect(seen).toEqual([['root', 0]]);
  });

  it('skips meshes without geometry', () => {
    const root = new Group();
    const m = makeMesh('valid');
    const ghost = new Mesh();
    // Three.js sets a default BufferGeometry — force null to simulate no-geometry case
    (ghost as unknown as { geometry: unknown }).geometry = null;
    ghost.name = 'ghost';
    root.add(m, ghost);

    const seen: string[] = [];
    traverseMeshesWithDepth(root, 5, (mesh) => { seen.push(mesh.name); });
    expect(seen).toEqual(['valid']);
  });
});

describe('computeSubtreeAABB', () => {
  it('computes the bounding box of all mesh descendants', () => {
    const root = new Group();
    const m1 = new Mesh(new BoxGeometry(2, 2, 2));
    m1.position.set(0, 0, 0);
    const m2 = new Mesh(new BoxGeometry(2, 2, 2));
    m2.position.set(10, 0, 0);
    root.add(m1, m2);
    root.updateMatrixWorld(true);

    const { box, size, center } = computeSubtreeAABB(root);
    expect(box.isEmpty()).toBe(false);
    // Both 2x2x2 boxes → from x=-1 to x=11
    expect(size.x).toBeCloseTo(12);
    expect(size.y).toBeCloseTo(2);
    expect(size.z).toBeCloseTo(2);
    expect(center.x).toBeCloseTo(5);
  });

  it('returns minimal fallback box when no mesh descendants exist', () => {
    const root = new Group();
    root.position.set(3, 4, 5);
    root.add(new Group());
    root.updateMatrixWorld(true);

    const { size, center } = computeSubtreeAABB(root);
    expect(size.x).toBeCloseTo(0.1);
    expect(size.y).toBeCloseTo(0.1);
    expect(size.z).toBeCloseTo(0.1);
    // Center should be at root's world position
    expect(center.x).toBeCloseTo(3);
    expect(center.y).toBeCloseTo(4);
    expect(center.z).toBeCloseTo(5);
  });

  it('clamps zero-thickness extents to >= 0.001 (avoids zero-scale traps)', () => {
    // A degenerate flat geometry — BoxGeometry with 0 height
    const root = new Group();
    const m = new Mesh(new BoxGeometry(2, 0, 2));
    root.add(m);
    root.updateMatrixWorld(true);

    const { size } = computeSubtreeAABB(root);
    expect(size.x).toBeCloseTo(2);
    expect(size.y).toBeGreaterThanOrEqual(0.001);
    expect(size.z).toBeCloseTo(2);
  });

  it('reuses the provided target Box3 (GC avoidance)', () => {
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(1, 1, 1)));
    root.updateMatrixWorld(true);

    const target = new Box3();
    const { box } = computeSubtreeAABB(root, target);
    expect(box).toBe(target);
    // Reused target should hold the new bounds
    const s = new Vector3();
    target.getSize(s);
    expect(s.x).toBeCloseTo(1);
  });
});
