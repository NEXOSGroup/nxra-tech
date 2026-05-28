// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, PerspectiveCamera, Scene } from 'three';
import {
  activateContext,
  deactivateContext,
  _resetStore as resetCtxStore,
} from '../src/core/hmi/ui-context-store';
import {
  SnapPointRegistry,
  type SnapPoint,
} from '../src/core/engine/rv-snap-point-registry';
import { SnapMarkerRenderer } from '../src/plugins/snap-point/snap-marker-renderer';
import { SnapPointController } from '../src/plugins/snap-point/snap-point-controller';
import { snapHoverStore } from '../src/plugins/snap-point/snap-hover-store';
import { SnapPointPlugin } from '../src/plugins/snap-point';
import { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';

function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 400;
  c.height = 300;
  document.body.appendChild(c);
  return c;
}

function makeViewerStub(canvas: HTMLCanvasElement) {
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 4 / 3, 0.01, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return {
    scene,
    camera,
    renderer: { domElement: canvas },
    raycastManager: { addExcludeFilter: () => { /* noop */ } },
    gizmoManager: new GizmoOverlayManager(scene, () => null),
    markRenderDirty: () => { /* noop */ },
    on: (_ev: string, _cb: unknown): (() => void) => () => { /* noop */ },
    emit: (_ev: string, _payload?: unknown): void => { /* noop */ },
  };
}

function makeSnap(reg: SnapPointRegistry, scene: Scene): SnapPoint {
  const node = new Object3D();
  node.name = 'Snap-ZN-foo';
  scene.add(node);
  node.updateMatrixWorld(true);
  const sp: SnapPoint = {
    id: 'a',
    object3D: node,
    dir: { axis: 'Z', sign: 'N', code: 'ZN' },
    typeId: 'foo',
    ownerRoot: node,
    scenePath: 'a',
    occupied: false,
  };
  reg.register(sp);
  return sp;
}

describe('Snap-Point mode switching', () => {
  beforeEach(() => {
    resetCtxStore();
    snapHoverStore.reset();
  });

  it('controller is inactive when planner context is not active', () => {
    const canvas = makeCanvas();
    const viewer = makeViewerStub(canvas);
    const reg = new SnapPointRegistry();
    const renderer = new SnapMarkerRenderer(viewer as never, reg);
    const ctrl = new SnapPointController(viewer as never, reg, renderer);
    expect(ctrl.isActive()).toBe(false);
  });

  it('SnapPointPlugin activates the controller when planner becomes active', () => {
    const canvas = makeCanvas();
    const viewer = makeViewerStub(canvas);
    const plugin = new SnapPointPlugin();
    plugin.init(viewer as never);
    expect(plugin.isActive()).toBe(false);
    activateContext('planner');
    expect(plugin.isActive()).toBe(true);
    deactivateContext('planner');
    expect(plugin.isActive()).toBe(false);
    plugin.dispose();
  });

  it('closes picker when leaving planner mode', () => {
    const canvas = makeCanvas();
    const viewer = makeViewerStub(canvas);
    const plugin = new SnapPointPlugin();
    plugin.init(viewer as never);
    activateContext('planner');

    // Open picker
    const reg = plugin.getRegistry()!;
    const sp = makeSnap(reg, viewer.scene);
    snapHoverStore.openPicker(sp, { x: 100, y: 100 });
    expect(snapHoverStore.getState().pickerOpen).toBe(true);

    // Leave planner
    deactivateContext('planner');
    expect(snapHoverStore.getState().pickerOpen).toBe(false);
    plugin.dispose();
  });
});
