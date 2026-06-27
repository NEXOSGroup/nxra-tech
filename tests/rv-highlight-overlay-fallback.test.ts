// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVHighlightManager — OutlinePass vs overlay routing.
 *
 * OutlinePass can only outline VISIBLE meshes. Statically-merged objects (e.g.
 * RuntimeMetadata) keep their originals hidden (visible=false), so the highlight
 * must fall back to the overlay path (fill+edge meshes built from the hidden
 * geometry) when a subtree has no visible mesh. A subtree WITH a visible mesh
 * (e.g. a Drive's kinematic merged chunk) keeps using OutlinePass.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Scene, Object3D, Mesh, BoxGeometry, MeshBasicMaterial } from 'three';
import { RVHighlightManager } from '../src/core/engine/rv-highlight-manager';

/** Minimal stand-in for RVOutlineManager that reports available + records calls. */
function makeMockOutline() {
  return {
    available: true,
    hoverOutlined: [] as Object3D[],
    selectionOutlined: [] as Object3D[],
    setStyle() {},
    setHoverStyle() {},
    setHoverOutlined(objs: readonly Object3D[]) { this.hoverOutlined = [...objs]; },
    clearHover() { this.hoverOutlined = []; },
    setOutlined(objs: readonly Object3D[]) { this.selectionOutlined = [...objs]; },
    clear() { this.selectionOutlined = []; },
    get hoverPass() { return { selectedObjects: this.hoverOutlined }; },
    get pass() { return { selectedObjects: this.selectionOutlined }; },
  };
}

function makeMesh(visible: boolean): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  m.visible = visible;
  return m;
}

/** Count overlay meshes the manager added to the scene. */
function overlayCount(scene: Scene): number {
  let n = 0;
  scene.traverse(o => { if (o.userData?._highlightOverlay) n++; });
  return n;
}

describe('RVHighlightManager — OutlinePass vs overlay routing', () => {
  let scene: Scene;
  let mgr: RVHighlightManager;
  let outline: ReturnType<typeof makeMockOutline>;

  beforeEach(() => {
    scene = new Scene();
    mgr = new RVHighlightManager(scene);
    outline = makeMockOutline();
    mgr.setOutlineManager(outline as never);
  });

  it('uses OutlinePass when the subtree has a visible mesh', () => {
    const root = new Object3D();
    root.add(makeMesh(true));
    scene.add(root);

    mgr.highlight(root);

    expect(outline.hoverOutlined).toEqual([root]); // outline path
    expect(overlayCount(scene)).toBe(0);           // no overlay meshes built
  });

  it('falls back to overlay when the subtree has only hidden (merged) meshes', () => {
    const root = new Object3D();
    const hidden = makeMesh(false);
    hidden.userData._rvStaticUberSource = true; // as the static merge marks originals
    root.add(hidden);
    scene.add(root);

    mgr.highlight(root);

    expect(outline.hoverOutlined).toEqual([]);     // NOT the outline path
    expect(overlayCount(scene)).toBeGreaterThan(0); // overlay built from hidden geometry
  });

  it('uses OutlinePass when the subtree has ANY visible mesh (mixed merged product)', () => {
    // Documented rule (rv-highlight-manager): OutlinePass is used whenever the
    // subtree has AT LEAST ONE visible mesh; the overlay path is the fallback
    // only when the subtree is FULLY invisible. A mixed product (some merged/
    // hidden meshes + some visible ones) therefore stays on the OutlinePass path.
    const root = new Object3D();
    const visible = makeMesh(true);
    const hidden = makeMesh(false);
    hidden.userData._rvStaticUberSource = true;
    root.add(visible);
    root.add(hidden);
    scene.add(root);

    mgr.highlight(root);

    expect(outline.hoverOutlined).toEqual([root]); // OutlinePass on the visible mesh
    expect(overlayCount(scene)).toBe(0);           // no overlay built
  });

  it('selection: hidden-only subtree uses the overlay path too', () => {
    const root = new Object3D();
    const hidden = makeMesh(false);
    hidden.userData._rvStaticUberSource = true;
    root.add(hidden);
    scene.add(root);

    mgr.highlightSelection([root]);

    expect(outline.selectionOutlined).toEqual([]);
    expect(overlayCount(scene)).toBeGreaterThan(0);
  });

  it('clearing hover removes the overlay meshes', () => {
    const root = new Object3D();
    const hidden = makeMesh(false);
    hidden.userData._rvStaticUberSource = true;
    root.add(hidden);
    scene.add(root);

    mgr.highlight(root);
    expect(overlayCount(scene)).toBeGreaterThan(0);
    mgr.clear();
    expect(overlayCount(scene)).toBe(0);
  });
});
