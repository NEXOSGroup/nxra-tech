// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Regression: snap-picker placements must survive a reload without drifting.
 *
 * The reload path always re-centers a placed asset's geometry with
 * `pivotToFloorCenter` (via prepPlacedVisual) before applying the saved
 * transform. The snap-picker placement path (`placeAtSnapPoint`) must therefore
 * snap-align in that SAME pivoted frame — otherwise the saved transform is in
 * the raw authored-origin frame and, on reload, the geometry lands displaced by
 * the asset's AABB-centroid offset.
 *
 * For a symmetric asset the centroid is ~0 so nothing drifts ("mostly works").
 * For an asymmetric asset (e.g. a chain transfer, whose body is offset from its
 * authored origin) the XZ centroid is non-zero → a horizontal offset that breaks
 * the snap connection after reload.
 *
 * This test drives the REAL `placeAtSnapPoint` and then reconstructs the reload
 * (fresh clone → pivotToFloorCenter → saved transform). If `placeAtSnapPoint`
 * ever stops pivot-normalizing before snap-aligning, the mated snaps drift apart
 * and the round-trip assertion fails.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Group,
  Mesh,
  BoxGeometry,
  MeshBasicMaterial,
  Object3D,
  Vector3,
  Scene,
} from 'three';
import { pivotToFloorCenter } from '../src/plugins/layout-planner/model-cache';
import { placeAtSnapPoint, type SceneMutationDeps } from '../src/plugins/layout-planner/scene-mutations';
import { scanAndRegisterSnaps } from '../src/plugins/snap-point/snap-scanner';
import { SnapPointRegistry } from '../src/core/engine/rv-snap-point-registry';

/**
 * Build an ASYMMETRIC asset: a body box whose centre is offset from the root
 * origin (so its AABB XZ-centroid is non-zero), plus a snap Empty. Modelled on a
 * chain transfer whose geometry doesn't sit on its authored origin. A fresh
 * instance is built per call so the "placement" and "reload" clones are
 * independent-but-identical, exactly like ModelCache.getOrLoad's clones.
 */
function makeAsymmetricAsset(): { root: Group; snap: Object3D } {
  const root = new Group();
  root.name = 'ChainTransfer';
  // Body box (2 x 1 x 2) centred at +X 0.5 → AABB x:[-0.5,1.5] (centroid +0.5),
  // z:[-1,1] (centroid 0), y:[0,1] (min 0). Non-zero XZ centroid in X.
  const body = new Mesh(new BoxGeometry(2, 1, 2), new MeshBasicMaterial());
  body.name = 'Body';
  body.position.set(0.5, 0.5, 0);
  root.add(body);
  const snap = new Object3D();
  snap.name = 'Snap-ZN-convroll';
  snap.position.set(0, 0.5, -0.8);
  root.add(snap);
  root.updateMatrixWorld(true);
  return { root, snap };
}

/** A stationary target with one ZP-convroll snap, modelled on a roll conveyor. */
function makeTarget(): { root: Group; snap: Object3D } {
  const root = new Group();
  root.name = 'RollConveyor';
  const snap = new Object3D();
  snap.name = 'Snap-ZP-convroll';
  snap.position.set(0, 0.5, 0.5);
  root.add(snap);
  root.updateMatrixWorld(true);
  return { root, snap };
}

/** Minimal SceneMutationDeps that lets placeAtSnapPoint run without a real
 *  viewer pipeline (signalStore null → processExtras path skipped). */
function makeDeps(scene: Scene, modelRoot: Group): SceneMutationDeps {
  const viewer = {
    scene,
    registry: { registerNode: vi.fn(), getPathForNode: vi.fn(() => null) },
    signalStore: null,
    transportManager: null,
    drives: [],
    rebuildGroupedBvh: vi.fn(),
    raycastManager: { addAuxRaycastTarget: vi.fn(), removeAuxRaycastTarget: vi.fn() },
    getPlugin: vi.fn(() => undefined),
    markShadowsDirty: vi.fn(),
    applyRenderModeToSubtree: vi.fn(),
  };
  return {
    getViewer: () => viewer as never,
    objectMap: new Map(),
    idByObject: new WeakMap(),
    getLayoutRoot: () => modelRoot,
    getTransformControls: () => null,
    getModelRoot: () => modelRoot,
  };
}

describe('snap-picker placement → reload frame round-trip', () => {
  it('keeps an asymmetric asset coincident with its target snap after reload', () => {
    const scene = new Scene();
    const modelRoot = new Group();
    modelRoot.name = 'modelRoot';
    scene.add(modelRoot);

    const reg = new SnapPointRegistry();

    // Stationary target (roll conveyor) registered in the registry.
    const target = makeTarget();
    modelRoot.add(target.root);
    target.root.updateMatrixWorld(true);
    const [targetSnap] = scanAndRegisterSnaps(target.root, reg, target.root);
    expect(targetSnap).toBeTruthy();

    // ── Placement via the REAL picker path. ──
    const deps = makeDeps(scene, modelRoot);
    const place = makeAsymmetricAsset();
    placeAtSnapPoint(deps, place.root, 'ct-1', 'ChainTransfer', 'cat:ct', targetSnap, 'Snap-ZN-convroll', reg);
    place.root.updateMatrixWorld(true);

    // In-session the mated snaps must coincide.
    const targetW = targetSnap.object3D.getWorldPosition(new Vector3());
    const placedSnapW = place.snap.getWorldPosition(new Vector3());
    expect(placedSnapW.distanceTo(targetW)).toBeLessThan(1e-4);

    // The store persists the placed root's local transform (mirrors placeAtSnap).
    const saved = { pos: place.root.position.clone(), quat: place.root.quaternion.clone() };

    // ── Reload: fresh identical clone → pivotToFloorCenter (prepPlacedVisual)
    //    → apply saved transform. The mated snaps must STILL coincide. ──
    const reload = makeAsymmetricAsset();
    modelRoot.add(reload.root);
    pivotToFloorCenter(reload.root);
    reload.root.position.copy(saved.pos);
    reload.root.quaternion.copy(saved.quat);
    reload.root.updateMatrixWorld(true);

    const reloadedSnapW = reload.snap.getWorldPosition(new Vector3());
    const drift = reloadedSnapW.distanceTo(targetW);
    // Must stay within the 30 mm pairing-rebuild epsilon — and in practice exact.
    expect(drift).toBeLessThan(1e-4);
  });
});
