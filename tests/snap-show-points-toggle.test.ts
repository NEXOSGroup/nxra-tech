// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Scene } from 'three';
import {
  SnapPointRegistry,
  type SnapPoint,
} from '../src/core/engine/rv-snap-point-registry';
import { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';
import { SnapMarkerRenderer } from '../src/plugins/snap-point/snap-marker-renderer';
import { snapToolbarStore } from '../src/plugins/snap-point/snap-toolbar-store';

function makeViewerStub(scene: Scene) {
  return {
    scene,
    gizmoManager: new GizmoOverlayManager(scene, () => null),
    raycastManager: { addExcludeFilter: () => { /* noop */ } },
    markRenderDirty: () => { /* noop */ },
  };
}

function makeSnap(reg: SnapPointRegistry, scene: Scene, id: string, pos: [number, number, number]): SnapPoint {
  const node = new Object3D();
  node.name = 'Snap-ZN-foo';
  node.position.set(...pos);
  scene.add(node);
  node.updateMatrixWorld(true);
  const sp: SnapPoint = {
    id,
    object3D: node,
    dir: { axis: 'Z', sign: 'N', code: 'ZN' },
    typeId: 'foo',
    ownerRoot: node,
    scenePath: id,
    occupied: false,
  };
  reg.register(sp);
  return sp;
}

function spriteVisible(reg: SnapPointRegistry, id: string): boolean {
  const node = reg.getById(id)!.object3D;
  const sprite = node.children.find(c => c.userData._rvGizmo);
  return !!sprite?.visible;
}

describe('Show Snap-Points toggle', () => {
  let scene: Scene;
  let reg: SnapPointRegistry;
  let renderer: SnapMarkerRenderer;

  beforeEach(() => {
    snapToolbarStore._reset();
    scene = new Scene();
    reg = new SnapPointRegistry();
    const viewer = makeViewerStub(scene);
    renderer = new SnapMarkerRenderer(viewer as never, reg);
    renderer.setEnabled(true);
    makeSnap(reg, scene, 'a', [0, 0, 0]);
    makeSnap(reg, scene, 'b', [1, 0, 0]);
    makeSnap(reg, scene, 'c', [2, 0, 0]);
    renderer.rebuild(reg.size);
  });

  it('show-all ON makes every idle marker visible', () => {
    renderer.setShowAllIdle(true);
    for (const id of ['a', 'b', 'c']) {
      expect(spriteVisible(reg, id)).toBe(true);
    }
  });

  it('show-all OFF resumes proximity-driven (default hidden)', () => {
    renderer.setShowAllIdle(true);
    renderer.setShowAllIdle(false);
    for (const id of ['a', 'b', 'c']) {
      expect(spriteVisible(reg, id)).toBe(false);
    }
  });

  it('toggle state persists to localStorage', () => {
    snapToolbarStore.setShowAllSnaps(true);
    expect(localStorage.getItem('rv-snap-show-all-v1')).toBe('true');
    snapToolbarStore.setShowAllSnaps(false);
    expect(localStorage.getItem('rv-snap-show-all-v1')).toBe('false');
  });

  it('store hydrates from localStorage', () => {
    snapToolbarStore.setShowAllSnaps(true);
    expect(localStorage.getItem('rv-snap-show-all-v1')).toBe('true');
    expect(snapToolbarStore.getState().showAllSnaps).toBe(true);
  });
});
