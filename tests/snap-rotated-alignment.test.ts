// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Snap-alignment when the target asset is rotated.
 *
 * "All snapping is always in the local coordinate system of the object"
 * — so the math must derive outward directions from the snap's local
 * position relative to its OWNER root, then transform that back to world
 * space. The placement formula then keeps the connection in the rotated
 * frame.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { computeSnapAlignedWorldMatrix } from '../src/plugins/snap-point/snap-alignment';

function applyMatrix(asset: Object3D, M: ReturnType<typeof computeSnapAlignedWorldMatrix>): void {
  asset.matrixAutoUpdate = false;
  asset.matrix.copy(M);
  M.decompose(asset.position, asset.quaternion, asset.scale);
  asset.matrixAutoUpdate = true;
  asset.updateMatrixWorld(true);
}

/** Build asset root + snap empty inside it. Marks the root with `_layoutId`
 *  (placed-root marker the alignment code's `_resolveOwnerRoot` looks for). */
function makeAsset(snapPos: [number, number, number], rotationY = 0) {
  const root = new Object3D();
  root.userData._layoutId = 'test-' + Math.random().toString(36).slice(2, 8);
  root.rotation.y = rotationY;
  root.updateMatrixWorld(true);
  const snap = new Object3D();
  snap.position.set(...snapPos);
  root.add(snap);
  snap.updateMatrixWorld(true);
  return { root, snap };
}

describe('Snap alignment with rotated target', () => {
  it('places asset correctly at rotated target snap (90° Y)', () => {
    // Target turntable rotated 90° around Y. Its Snap-XN-convroll (Unity-X
    // negative meaning input — name letter doesn't affect outward; geometry
    // does) sits at local (1, 0.5, 0). After the 90° rotation its world
    // position is (0, 0.5, -1), and its outward in world is world -Z (the
    // local +X axis rotated 90° CCW around Y lands on world -Z).
    const T = makeAsset([1, 0.5, 0], Math.PI / 2);

    // RollConveyor at world origin, snap at local (0, 0.5, -0.5).
    const R = makeAsset([0, 0.5, -0.5], 0);

    const M = computeSnapAlignedWorldMatrix(
      T.snap,
      R.root,
      R.snap,
      { axis: 'X', sign: 'N', code: 'XN' },
      { axis: 'Z', sign: 'N', code: 'ZN' },
    );
    applyMatrix(R.root, M);

    // Snap-on-snap landing.
    const rSnapW = R.snap.getWorldPosition(new Vector3());
    const tSnapW = T.snap.getWorldPosition(new Vector3());
    expect(rSnapW.x).toBeCloseTo(tSnapW.x, 5);
    expect(rSnapW.y).toBeCloseTo(tSnapW.y, 5);
    expect(rSnapW.z).toBeCloseTo(tSnapW.z, 5);
  });

  it('placement Y position never drifts when target only differs by horizontal rotation', () => {
    // Rotating the target around Y should NOT change the placement's Y.
    const T = makeAsset([1, 0.5, 0], Math.PI / 4); // 45° rotation
    const R = makeAsset([0, 0.5, -0.5], 0);

    const M = computeSnapAlignedWorldMatrix(
      T.snap,
      R.root,
      R.snap,
      { axis: 'X', sign: 'N', code: 'XN' },
      { axis: 'Z', sign: 'N', code: 'ZN' },
    );
    applyMatrix(R.root, M);

    // The conveyor should end up with its body parallel to the rotated
    // target's local +X axis — Y stays at 0 (both Empties at y=0.5).
    expect(R.root.position.y).toBeCloseTo(0, 5);
  });

  it('rotating target by 180° puts new asset on the opposite side', () => {
    const Tnone = makeAsset([1, 0.5, 0], 0);
    const Tflip = makeAsset([1, 0.5, 0], Math.PI);
    const Rnone = makeAsset([0, 0.5, -0.5], 0);
    const Rflip = makeAsset([0, 0.5, -0.5], 0);

    applyMatrix(Rnone.root, computeSnapAlignedWorldMatrix(
      Tnone.snap, Rnone.root, Rnone.snap,
      { axis: 'X', sign: 'N', code: 'XN' }, { axis: 'Z', sign: 'N', code: 'ZN' },
    ));
    applyMatrix(Rflip.root, computeSnapAlignedWorldMatrix(
      Tflip.snap, Rflip.root, Rflip.snap,
      { axis: 'X', sign: 'N', code: 'XN' }, { axis: 'Z', sign: 'N', code: 'ZN' },
    ));

    // After rotating the target 180° around Y, its snap world X should flip
    // sign — so the connected roll's centre lands at a different world X
    // from the unrotated case. Verify that the placements differ.
    expect(Math.abs(Rnone.root.position.x - Rflip.root.position.x)).toBeGreaterThan(0.5);
  });
});
