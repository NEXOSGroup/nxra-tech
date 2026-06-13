// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Scene, Vector3 } from 'three';
import {
  SnapPointRegistry,
  type SnapPoint,
} from '../src/core/engine/rv-snap-point-registry';
import { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';
import { SnapMarkerRenderer } from '../src/plugins/snap-point/snap-marker-renderer';

function makeViewerStub(scene: Scene) {
  const gizmoManager = new GizmoOverlayManager(scene, () => null);
  return {
    scene,
    gizmoManager,
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

describe('SnapMarkerRenderer', () => {
  let scene: Scene;
  let reg: SnapPointRegistry;
  let renderer: SnapMarkerRenderer;
  let viewer: ReturnType<typeof makeViewerStub>;

  beforeEach(() => {
    scene = new Scene();
    reg = new SnapPointRegistry();
    viewer = makeViewerStub(scene);
    renderer = new SnapMarkerRenderer(viewer as never, reg);
    renderer.setEnabled(true);
  });

  it('creates one gizmo handle per snap on rebuild', () => {
    makeSnap(reg, scene, 'a', [0, 0, 0]);
    makeSnap(reg, scene, 'b', [1, 0, 0]);
    makeSnap(reg, scene, 'c', [2, 0, 0]);
    renderer.rebuild(reg.size);
    expect(renderer.getIdleHandleCount()).toBe(3);
    for (const id of ['a', 'b', 'c']) {
      expect(renderer.getHandleFor(id)).toBeDefined();
    }
  });

  it('hides idle markers by default', () => {
    makeSnap(reg, scene, 'a', [0, 0, 0]);
    renderer.rebuild(reg.size);
    // Idle markers are parented under the snap node — the gizmo root is the
    // sprite. Visible flag should be off until proximity- or show-all triggers.
    const node = reg.getById('a')!.object3D;
    const sprite = node.children.find(c => c.userData._rvGizmo);
    expect(sprite).toBeDefined();
    expect(sprite!.visible).toBe(false);
  });

  it('setVisibility toggles a single marker', () => {
    makeSnap(reg, scene, 'a', [0, 0, 0]);
    makeSnap(reg, scene, 'b', [1, 0, 0]);
    renderer.rebuild(reg.size);
    renderer.setVisibility('a', true);
    const spriteA = reg.getById('a')!.object3D.children.find(c => c.userData._rvGizmo)!;
    const spriteB = reg.getById('b')!.object3D.children.find(c => c.userData._rvGizmo)!;
    expect(spriteA.visible).toBe(true);
    expect(spriteB.visible).toBe(false);
  });

  it('marker follows the snap node when the asset moves', () => {
    const sp = makeSnap(reg, scene, 'a', [0, 0, 0]);
    renderer.rebuild(reg.size);
    renderer.setVisibility('a', true);
    // Move the snap node — the sprite is parented under it so it must follow.
    sp.object3D.position.set(7, 0, 0);
    sp.object3D.updateMatrixWorld(true);
    const sprite = sp.object3D.children.find(c => c.userData._rvGizmo)!;
    // Sprite's local position is (0,0,0); world position = node world position.
    const w = sprite.getWorldPosition(new Vector3());
    expect(w.x).toBeCloseTo(7, 5);
  });

  it('rebuild releases old handles before creating new ones', () => {
    makeSnap(reg, scene, 'a', [0, 0, 0]);
    renderer.rebuild(1);
    expect(renderer.getIdleHandleCount()).toBe(1);
    makeSnap(reg, scene, 'b', [1, 0, 0]);
    renderer.rebuild(reg.size);
    expect(renderer.getIdleHandleCount()).toBe(2);
  });

  it('showActive creates a single active handle and tracks the hovered snap', () => {
    const a = makeSnap(reg, scene, 'a', [3, 0, 0]);
    const b = makeSnap(reg, scene, 'b', [5, 0, 0]);
    renderer.rebuild(reg.size);
    renderer.showActive(a);
    expect(renderer.getActiveSnapId()).toBe('a');
    renderer.showActive(b);
    expect(renderer.getActiveSnapId()).toBe('b');
  });

  it('hideActive hides without disposing the handle', () => {
    const a = makeSnap(reg, scene, 'a', [0, 0, 0]);
    renderer.rebuild(reg.size);
    renderer.showActive(a);
    renderer.hideActive();
    // Active snap id remains so the next showActive on the same snap can be
    // a no-op rather than a rebuild.
    expect(renderer.getActiveSnapId()).toBe('a');
  });

  it('dispose drops all handles without throwing', () => {
    makeSnap(reg, scene, 'a', [0, 0, 0]);
    renderer.rebuild(reg.size);
    renderer.showActive(reg.getAll()[0]);
    expect(() => renderer.dispose()).not.toThrow();
    expect(renderer.getIdleHandleCount()).toBe(0);
    expect(renderer.getActiveSnapId()).toBeNull();
  });

  // ── Drag hints ───────────────────────────────────────────────────────

  /** Read the SpriteMaterial color hex + opacity of a snap's idle marker. */
  function spriteStyle(id: string): { hex: number; opacity: number; visible: boolean } {
    const node = reg.getById(id)!.object3D;
    const sprite = node.children.find(c => c.userData._rvGizmo)! as
      import('three').Sprite;
    const mat = sprite.material as import('three').SpriteMaterial;
    return { hex: mat.color.getHex(), opacity: mat.opacity, visible: sprite.visible };
  }

  const GOLD = 0xffd24a;
  const GREEN = 0x4fc34f;

  it('setDragHints shows moving snaps faint and target snaps gold', () => {
    makeSnap(reg, scene, 'm', [0, 0, 0]);
    makeSnap(reg, scene, 't', [1, 0, 0]);
    makeSnap(reg, scene, 'x', [2, 0, 0]); // untouched
    renderer.rebuild(reg.size);

    renderer.setDragHints(['m'], ['t']);

    const m = spriteStyle('m');
    expect(m.visible).toBe(true);
    expect(m.hex).toBe(GREEN);
    expect(m.opacity).toBeCloseTo(0.4, 5);

    const t = spriteStyle('t');
    expect(t.visible).toBe(true);
    expect(t.hex).toBe(GOLD);
    expect(t.opacity).toBeCloseTo(0.95, 5);

    // Unrelated snap stays hidden.
    expect(spriteStyle('x').visible).toBe(false);
  });

  it('clearDragHints restores idle style + hides markers (show-all off)', () => {
    makeSnap(reg, scene, 'm', [0, 0, 0]);
    makeSnap(reg, scene, 't', [1, 0, 0]);
    renderer.rebuild(reg.size);

    renderer.setDragHints(['m'], ['t']);
    renderer.clearDragHints();

    for (const id of ['m', 't']) {
      const s = spriteStyle(id);
      expect(s.visible).toBe(false);   // default hidden when show-all is off
      expect(s.hex).toBe(GREEN);       // colour restored
      expect(s.opacity).toBeCloseTo(0.95, 5);
    }
  });

  it('clearDragHints keeps markers visible when show-all is on', () => {
    makeSnap(reg, scene, 'm', [0, 0, 0]);
    renderer.rebuild(reg.size);
    renderer.setShowAllIdle(true);

    renderer.setDragHints(['m'], []);
    renderer.clearDragHints();

    const s = spriteStyle('m');
    expect(s.visible).toBe(true);      // show-all keeps it on
    expect(s.hex).toBe(GREEN);
    expect(s.opacity).toBeCloseTo(0.95, 5);
  });

  it('setDragHints never emphasises an occupied snap', () => {
    const t = makeSnap(reg, scene, 't', [0, 0, 0]);
    renderer.rebuild(reg.size);
    t.occupied = true;
    renderer.setDragHints([], ['t']);
    expect(spriteStyle('t').visible).toBe(false);
  });

  // ── Hierarchy 3D-highlight (plan-200 §9.8 / A5) ────────────────────────

  it('highlight(snapId) shows a single distinct highlight marker', () => {
    makeSnap(reg, scene, 'a', [0, 0, 0]);
    makeSnap(reg, scene, 'b', [1, 0, 0]);
    renderer.rebuild(reg.size);

    renderer.highlight('a');
    expect(renderer.getHighlightSnapId()).toBe('a');
    const handle = renderer.getHighlightHandle();
    expect(handle).toBeDefined();
    expect(handle!.root.visible).toBe(true);
    // The highlight marker is parented to the highlighted snap's node.
    expect(reg.getById('a')!.object3D.children).toContain(handle!.root);
  });

  it('highlight re-targets to a new snap (only one active at a time)', () => {
    makeSnap(reg, scene, 'a', [0, 0, 0]);
    makeSnap(reg, scene, 'b', [1, 0, 0]);
    renderer.rebuild(reg.size);

    renderer.highlight('a');
    const firstHandle = renderer.getHighlightHandle()!;
    renderer.highlight('b');
    expect(renderer.getHighlightSnapId()).toBe('b');
    // The old handle was disposed/removed from snap 'a'.
    expect(reg.getById('a')!.object3D.children).not.toContain(firstHandle.root);
    expect(reg.getById('b')!.object3D.children).toContain(renderer.getHighlightHandle()!.root);
  });

  it('highlight(null) clears the highlight', () => {
    makeSnap(reg, scene, 'a', [0, 0, 0]);
    renderer.rebuild(reg.size);
    renderer.highlight('a');
    renderer.highlight(null);
    expect(renderer.getHighlightSnapId()).toBeNull();
    expect(renderer.getHighlightHandle()).toBeUndefined();
  });

  it('highlight works regardless of planner-mode enabled state', () => {
    makeSnap(reg, scene, 'a', [0, 0, 0]);
    renderer.rebuild(reg.size);
    renderer.setEnabled(false);          // outside planner mode
    renderer.highlight('a');
    expect(renderer.getHighlightSnapId()).toBe('a');
    expect(renderer.getHighlightHandle()?.root.visible).toBe(true);
  });

  it('dispose clears the highlight too', () => {
    makeSnap(reg, scene, 'a', [0, 0, 0]);
    renderer.rebuild(reg.size);
    renderer.highlight('a');
    renderer.dispose();
    expect(renderer.getHighlightSnapId()).toBeNull();
    expect(renderer.getHighlightHandle()).toBeUndefined();
  });
});
