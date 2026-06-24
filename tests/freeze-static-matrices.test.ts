// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Unit tests for freezeStaticMatrices (rv-freeze-static).
 *
 * Verifies the static/dynamic classification that gates the per-frame
 * updateMatrixWorld pruning: a node stays dynamic iff it, an ancestor, or a
 * descendant carries a mover component (Drive, Kinematic, Grip,
 * TransportSurface, Source, Sink, MU, Cam); everything else is frozen. The
 * scenarios mirror the live cases — including a deep static mesh under a Drive
 * (the "Cylinder001" shape, where the moving mesh has matrixAutoUpdate=false
 * but sits below a Drive).
 */
import { describe, it, expect } from 'vitest';
import { Object3D, Mesh } from 'three';
import { freezeStaticMatrices } from '../src/core/engine/rv-freeze-static';

/** Tag a node with an rv_extras component (truthy value = present). */
function withComponent<T extends Object3D>(node: T, key: string): T {
  node.userData.realvirtual = { ...(node.userData.realvirtual ?? {}), [key]: { enabled: true } };
  return node;
}

function named(name: string, mesh = false): Object3D {
  const n: Object3D = mesh ? new Mesh() : new Object3D();
  n.name = name;
  return n;
}

describe('freezeStaticMatrices', () => {
  it('freezes a fully static subtree', () => {
    const root = named('root');
    const a = named('a'); const b = named('b'); const c = named('c');
    root.add(a); a.add(b); b.add(c);

    const res = freezeStaticMatrices(root);

    // No movers anywhere → every node frozen.
    expect(res.frozen).toBe(4);
    expect([root, a, b, c].every((n) => n.matrixWorldAutoUpdate === false)).toBe(true);
  });

  it('keeps a Drive node, its ancestors and its whole subtree dynamic', () => {
    const root = named('root');
    const mid = named('mid');                       // ancestor of the drive
    const drive = withComponent(named('drive'), 'Drive');
    const child = named('child');                   // descendant of the drive
    const grandchild = named('grandchild', true);
    root.add(mid); mid.add(drive); drive.add(child); child.add(grandchild);

    freezeStaticMatrices(root);

    // Ancestors (root, mid) + drive + descendants (child, grandchild) all dynamic.
    for (const n of [root, mid, drive, child, grandchild]) {
      expect(n.matrixWorldAutoUpdate).toBe(true);
    }
  });

  it('keeps a deep static mesh under a Drive dynamic (matrixAutoUpdate=false case)', () => {
    // Mirrors the live "Cylinder001": a mesh the engine marked static
    // (matrixAutoUpdate=false) but which moves because a Drive sits above it.
    const root = named('root');
    const drive = withComponent(named('CAxis'), 'Drive');
    const inner = named('inner');
    const movingMesh = named('Cylinder001', true);
    movingMesh.matrixAutoUpdate = false; // engine-classified "static" leaf
    root.add(drive); drive.add(inner); inner.add(movingMesh);

    freezeStaticMatrices(root);

    expect(movingMesh.matrixWorldAutoUpdate).toBe(true); // NOT frozen — under a Drive
  });

  it('matches Drive_* variants (Drive_Cylinder, Drive_ErraticPosition, …)', () => {
    const root = named('root');
    const cyl = withComponent(named('cyl'), 'Drive_Cylinder');
    const part = named('part', true);
    root.add(cyl); cyl.add(part);

    freezeStaticMatrices(root);

    expect(cyl.matrixWorldAutoUpdate).toBe(true);
    expect(part.matrixWorldAutoUpdate).toBe(true);
  });

  it('keeps Source/Sink/Transport/Grip/MU subtrees dynamic (runtime MU carriers)', () => {
    for (const key of ['Source', 'Sink', 'TransportSurface', 'Grip', 'Kinematic', 'MU']) {
      const root = named('root');
      const carrier = withComponent(named(key), key);
      const child = named('child', true);
      root.add(carrier); carrier.add(child);

      freezeStaticMatrices(root);

      expect(carrier.matrixWorldAutoUpdate, `${key} carrier`).toBe(true);
      expect(child.matrixWorldAutoUpdate, `${key} child`).toBe(true);
    }
  });

  it('freezes a static sibling subtree while a Drive sibling stays dynamic', () => {
    const root = named('root');
    const driveBranch = withComponent(named('drive'), 'Drive');
    const driveMesh = named('driveMesh', true);
    const staticBranch = named('staticBranch');
    const staticMesh = named('staticMesh', true);
    root.add(driveBranch); driveBranch.add(driveMesh);
    root.add(staticBranch); staticBranch.add(staticMesh);

    freezeStaticMatrices(root);

    expect(root.matrixWorldAutoUpdate).toBe(true);          // ancestor of the drive
    expect(driveBranch.matrixWorldAutoUpdate).toBe(true);
    expect(driveMesh.matrixWorldAutoUpdate).toBe(true);
    expect(staticBranch.matrixWorldAutoUpdate).toBe(false); // disconnected static
    expect(staticMesh.matrixWorldAutoUpdate).toBe(false);
  });

  it('leaves world transforms correct after freezing', () => {
    const root = named('root');
    const child = named('child', true);
    child.position.set(1, 2, 3);
    root.add(child);

    freezeStaticMatrices(root);

    // updateMatrixWorld(true) was run up front → world matrix reflects position.
    expect(child.matrixWorld.elements[12]).toBeCloseTo(1);
    expect(child.matrixWorld.elements[13]).toBeCloseTo(2);
    expect(child.matrixWorld.elements[14]).toBeCloseTo(3);
  });
});
