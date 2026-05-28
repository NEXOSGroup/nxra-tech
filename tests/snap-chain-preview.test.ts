// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Scene } from 'three';
import {
  SnapPointRegistry,
  type SnapPoint,
} from '../src/core/engine/rv-snap-point-registry';
import { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';
import { SnapChainPreview } from '../src/plugins/snap-point/snap-chain-preview';

function makeAsset(pos: [number, number, number]): Object3D {
  // Mesh-glow-hull needs at least one Mesh descendant to compute the hull.
  const root = new Object3D();
  root.position.set(...pos);
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  root.add(mesh);
  root.updateMatrixWorld(true);
  return root;
}

function makeSnap(
  id: string,
  asset: Object3D,
  localPos: [number, number, number],
): SnapPoint {
  const node = new Object3D();
  node.name = `Snap-ZP-conv`;
  node.position.set(...localPos);
  asset.add(node);
  node.updateMatrixWorld(true);
  return {
    id,
    object3D: node,
    dir: { axis: 'Z', sign: 'P', code: 'ZP' },
    typeId: 'conv',
    ownerRoot: asset,
    scenePath: id,
    occupied: false,
  };
}

function makeViewerStub(scene: Scene) {
  const gizmoManager = new GizmoOverlayManager(scene, () => null);
  return {
    scene,
    gizmoManager,
    markRenderDirty: () => { /* noop */ },
  };
}

describe('SnapChainPreview', () => {
  let scene: Scene;
  let reg: SnapPointRegistry;
  let preview: SnapChainPreview;
  let A: Object3D;
  let B: Object3D;
  let C: Object3D;

  beforeEach(() => {
    scene = new Scene();
    reg = new SnapPointRegistry();
    const viewer = makeViewerStub(scene);
    preview = new SnapChainPreview(viewer as never, reg);

    A = makeAsset([0, 0, 0]);
    B = makeAsset([1, 0, 0]);
    C = makeAsset([2, 0, 0]);
    scene.add(A, B, C);

    reg.register(makeSnap('aZp', A, [0.5, 0, 0]));
    reg.register(makeSnap('bZn', B, [-0.5, 0, 0]));
    reg.register(makeSnap('bZp', B, [0.5, 0, 0]));
    reg.register(makeSnap('cZn', C, [-0.5, 0, 0]));
    reg.markOccupied('aZp', 'A');
    reg.markOccupied('bZn', 'B');
    reg.markOccupied('bZp', 'B');
    reg.markOccupied('cZn', 'C');
    reg.pair('aZp', 'bZn');
    reg.pair('bZp', 'cZn');
  });

  it('showFor walks the chain and glows every member except root', () => {
    preview.showFor(A);
    // Root (A) does NOT get a glow — only B and C do.
    expect(preview.getHandleCount()).toBe(2);
    expect(preview.getCurrentRoot()).toBe(A);
  });

  it('hide drops every glow handle', () => {
    preview.showFor(A);
    preview.hide();
    expect(preview.getHandleCount()).toBe(0);
    expect(preview.getCurrentRoot()).toBeNull();
  });

  it('showFor is idempotent for the same root', () => {
    preview.showFor(A);
    const countAfterFirst = preview.getHandleCount();
    preview.showFor(A); // no churn
    expect(preview.getHandleCount()).toBe(countAfterFirst);
  });

  it('showFor swaps to a new root cleanly', () => {
    preview.showFor(A);
    preview.showFor(B);
    expect(preview.getCurrentRoot()).toBe(B);
    // B's chain = { A, C } → 2 glow handles (B itself excluded).
    expect(preview.getHandleCount()).toBe(2);
  });

  it('a standalone asset has no chain → no glow handles', () => {
    const solo = makeAsset([5, 0, 0]);
    scene.add(solo);
    reg.register(makeSnap('soloZp', solo, [0, 0, 0]));
    preview.showFor(solo);
    expect(preview.getHandleCount()).toBe(0);
  });

  it('breaking a chain edge between showFor and refresh updates the glow set', () => {
    preview.showFor(A);
    expect(preview.getHandleCount()).toBe(2); // B + C
    // Break the B-C edge — chain from A is now just B.
    reg.markFree('bZp');
    preview.refresh();
    expect(preview.getHandleCount()).toBe(1);
  });
});
