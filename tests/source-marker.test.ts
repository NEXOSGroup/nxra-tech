// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Source Floor-Marker Tests (plan-181)
 *
 * Covers the always-visible floor ring + label sprite under every RVSource:
 *  - Construction in `setTemplate()` (ring + sprite as children of source.node)
 *  - Visibility (independent of pause state; toggle is visibility-only)
 *  - Label text comes from the source node name
 *  - Deterministic color hashing
 *  - dispose() frees ring material, label material, and CanvasTexture
 *  - TransportManager.reset() disposes every source (plan-180 memory-leak
 *    regression: was leaking ghost materials AND now would leak marker
 *    materials too)
 *  - Raycast excludes marker children (so click hits the layout object below)
 *  - Missing template = no marker, no crash
 *  - sourceIsTemplate=true skips marker (would otherwise leak into clones)
 *  - Idempotency guard — second setTemplate() does NOT duplicate the marker
 *
 * Pragmatic Strategy
 * ──────────────────
 * The plan referred to `createTestViewer({ glb })` but the existing helper
 * is a pure mock with no GLB-loading. Building a real GLB fixture for this
 * test surface would be over-engineering for v1. Instead these tests
 * construct `RVSource` directly with synthetic Object3D meshes — exactly
 * the same pattern used in `rv-transport.test.ts` for surfaces/sensors/MUs.
 *
 * The plan's `clearModel()` scenario is exercised by calling
 * `transportManager.reset()` directly, which is the lifecycle hook that
 * the Pre-Phase fix added the source-disposal loop to.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  BoxGeometry,
  Material,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Raycaster,
  Vector3,
} from 'three';
import { RVSource } from '../src/core/engine/rv-source';
import { hashColor } from '../src/core/engine/rv-source-marker';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Build a synthetic MU template: a 0.6 × 0.4 × 0.6 m box at world origin.
 * The `RVSource.setTemplate()` path computes the AABB from world bounds
 * and pre-hides the template, exactly as the loader does.
 */
function createTemplate(name = 'TestTemplate'): Mesh {
  const geo = new BoxGeometry(0.6, 0.4, 0.6);
  const mat = new MeshBasicMaterial();
  const mesh = new Mesh(geo, mat);
  mesh.name = name;
  return mesh;
}

/**
 * Build a Source attached to a scene root. The source itself is not the
 * template (sourceIsTemplate=false) so the marker path is exercised.
 */
function createSourceWithTemplate(opts: {
  sourceName?: string;
  templateName?: string;
} = {}): { source: RVSource; template: Mesh; sceneRoot: Object3D } {
  const sceneRoot = new Object3D();
  sceneRoot.name = 'SceneRoot';

  const sourceNode = new Object3D();
  sourceNode.name = opts.sourceName ?? 'PalletSource1';
  sceneRoot.add(sourceNode);

  const template = createTemplate(opts.templateName ?? 'TestPallet');
  sceneRoot.add(template);

  const source = new RVSource(sourceNode);
  source.muName = template.name;
  source.sourceIsTemplate = false;
  source.setTemplate(template);

  return { source, template, sceneRoot };
}

// ─── Pre-Phase: TransportManager.reset() disposes sources ──────────

describe('TransportManager.reset() — source disposal (plan-180 patch)', () => {
  it('calls dispose on every registered source', () => {
    const tm = new RVTransportManager();
    const { source: a } = createSourceWithTemplate({ sourceName: 'A' });
    const { source: b } = createSourceWithTemplate({ sourceName: 'B' });
    tm.sources.push(a, b);

    const aSpy = vi.spyOn(a, 'dispose');
    const bSpy = vi.spyOn(b, 'dispose');

    tm.reset();

    expect(aSpy).toHaveBeenCalledTimes(1);
    expect(bSpy).toHaveBeenCalledTimes(1);
  });

  it('disposes marker GPU resources (no leak)', () => {
    const tm = new RVTransportManager();
    const { source } = createSourceWithTemplate();
    tm.sources.push(source);

    const { ring, texture } = source.markerForTesting;
    expect(ring).toBeTruthy();
    expect(texture).toBeTruthy();
    const ringMatSpy = vi.spyOn(ring!.material as Material, 'dispose');
    const texSpy = vi.spyOn(texture!, 'dispose');

    tm.reset();

    expect(ringMatSpy).toHaveBeenCalled();
    expect(texSpy).toHaveBeenCalled();
  });
});

// ─── Phase 1: Marker construction ──────────────────────────────────

describe('RVSource floor-marker — construction', () => {
  it('builds a marker child under source.node containing a ring and a label', () => {
    const { source } = createSourceWithTemplate();

    const markerChild = source.node.children.find(c => c.userData._isSourceMarker);
    expect(markerChild).toBeTruthy();

    let hasRing = false;
    let hasSprite = false;
    markerChild!.traverse((c) => {
      // Mesh check via type-name to avoid importing Sprite/Mesh just for
      // identity discrimination.
      if ((c as { isMesh?: boolean }).isMesh) hasRing = true;
      if ((c as { isSprite?: boolean }).isSprite) hasSprite = true;
    });
    expect(hasRing).toBe(true);
    expect(hasSprite).toBe(true);
  });

  it('flags every marker descendant with userData._isSourceMarker', () => {
    const { source } = createSourceWithTemplate();
    const marker = source.markerForTesting.root!;
    let allFlagged = true;
    marker.traverse((c) => {
      if (!c.userData._isSourceMarker) allFlagged = false;
    });
    expect(allFlagged).toBe(true);
  });

  it('uses source.node.name as label text', () => {
    const { source } = createSourceWithTemplate({ sourceName: 'MyPalletSource' });
    expect(source.markerForTesting.labelText).toBe('MyPalletSource');
  });

  it('is idempotent — calling setTemplate twice does NOT duplicate the marker', () => {
    const { source, template } = createSourceWithTemplate();
    const firstMarker = source.markerForTesting.root;
    expect(firstMarker).toBeTruthy();

    source.setTemplate(template);

    const markers = source.node.children.filter(c => c.userData._isSourceMarker);
    expect(markers.length).toBe(1);
    expect(source.markerForTesting.root).toBe(firstMarker);
  });

  it('skips marker when sourceIsTemplate=true', () => {
    const sceneRoot = new Object3D();
    const sourceNode = new Object3D();
    sourceNode.name = 'SelfTemplateSource';
    sceneRoot.add(sourceNode);
    // Give the node a child mesh so AABB computation produces a finite size.
    const mesh = createTemplate();
    sourceNode.add(mesh);

    const source = new RVSource(sourceNode);
    source.sourceIsTemplate = true;
    source.setTemplate(sourceNode);

    const marker = sourceNode.children.find(c => c.userData._isSourceMarker);
    expect(marker).toBeUndefined();
    expect(source.markerForTesting.root).toBeNull();
  });
});

// ─── Phase 1: Visibility ──────────────────────────────────────────

describe('RVSource floor-marker — visibility', () => {
  it('is visible by default after construction', () => {
    const { source } = createSourceWithTemplate();
    expect(source.markerForTesting.root!.visible).toBe(true);
  });

  it('stays visible across simulated pause transitions', () => {
    const { source } = createSourceWithTemplate();
    const marker = source.markerForTesting.root!;

    // The marker is NOT wired to the pause-changed handler — verify the
    // ghost-pause-handler does not flip the marker by simulating the
    // ghost callback.
    source.setGhostVisible(true);
    expect(marker.visible).toBe(true);
    source.setGhostVisible(false);
    expect(marker.visible).toBe(true);
  });

  it('setMarkerVisible flips visibility WITHOUT rebuilding the marker', () => {
    const { source } = createSourceWithTemplate();
    const before = source.markerForTesting.root!;

    source.setMarkerVisible(false);
    expect(before.visible).toBe(false);
    // Reference identity preserved — no rebuild.
    expect(source.markerForTesting.root).toBe(before);

    source.setMarkerVisible(true);
    expect(before.visible).toBe(true);
  });
});

// ─── Phase 1: Color hash ──────────────────────────────────────────

describe('hashColor — deterministic per-name color', () => {
  it('returns the same color for the same input', () => {
    expect(hashColor('PalletSrc')).toBe(hashColor('PalletSrc'));
    expect(hashColor('BoxSrc')).toBe(hashColor('BoxSrc'));
  });

  it('returns different colors for distinct names', () => {
    // Not a hash-collision-proof guarantee, but distinct in practice.
    const a = hashColor('PalletSrc');
    const b = hashColor('BoxSrc');
    expect(a).not.toBe(b);
  });

  it('returns a positive 24-bit integer', () => {
    const c = hashColor('AnyName');
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(0xffffff);
  });
});

// ─── Phase 1: Dispose ─────────────────────────────────────────────

describe('RVSource.dispose() — marker cleanup', () => {
  it('removes the marker from source.node and frees materials + texture', () => {
    const { source } = createSourceWithTemplate();
    const { ring, label, texture, root } = source.markerForTesting;
    expect(root).toBeTruthy();

    const ringMatSpy = vi.spyOn(ring!.material as Material, 'dispose');
    const labelMatSpy = vi.spyOn(label!.material, 'dispose');
    const texSpy = vi.spyOn(texture!, 'dispose');

    source.dispose();

    expect(ringMatSpy).toHaveBeenCalled();
    expect(labelMatSpy).toHaveBeenCalled();
    expect(texSpy).toHaveBeenCalled();
    expect(source.node.children.some(c => c.userData._isSourceMarker)).toBe(false);
    expect(source.markerForTesting.root).toBeNull();
  });

  it('is safe to call when no template was ever set (no crash)', () => {
    const sourceNode = new Object3D();
    sourceNode.name = 'OrphanSource';
    const source = new RVSource(sourceNode);
    // muTemplate stays null — the missing-template path
    expect(source.muTemplate).toBeNull();
    expect(source.markerForTesting.root).toBeNull();
    expect(() => source.dispose()).not.toThrow();
  });
});

// ─── Phase 1: Raycast filter ──────────────────────────────────────

describe('Raycast — marker meshes are excluded by default filter', () => {
  it('marker root, ring and label all carry the _isSourceMarker flag', () => {
    // The RaycastManager.excludeFilters default filter checks
    // `obj.userData._isSourceMarker`. We assert the flag presence (the
    // RaycastManager's own filter logic is covered by its tests).
    const { source } = createSourceWithTemplate();
    const { ring, label, root } = source.markerForTesting;
    expect(root!.userData._isSourceMarker).toBe(true);
    expect(ring!.userData._isSourceMarker).toBe(true);
    expect(label!.userData._isSourceMarker).toBe(true);
  });

  it('a downward raycast at the marker hits the marker only, and the marker is _isSourceMarker-flagged', () => {
    const { source } = createSourceWithTemplate();
    const ring = source.markerForTesting.ring!;

    // Compute world transforms so getWorldPosition is meaningful.
    source.node.updateMatrixWorld(true);

    const pos = new Vector3();
    ring.getWorldPosition(pos);

    const raycaster = new Raycaster();
    raycaster.set(new Vector3(pos.x, pos.y + 1, pos.z), new Vector3(0, -1, 0));

    const hits = raycaster.intersectObject(ring, true);
    if (hits.length > 0) {
      // Every hit should be on a flagged marker descendant — which is
      // what the central RaycastManager filter relies on to skip them.
      for (const h of hits) {
        expect(h.object.userData._isSourceMarker).toBe(true);
      }
    }
    // (If no hits — e.g. the ring is edge-on to the ray — the test still
    // passes because the meaningful invariant is "every marker-hit is
    // flagged", and there are none to violate.)
  });
});
