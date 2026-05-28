// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3 } from 'three';
import {
  computeSnapAlignedWorldMatrix,
  flipMatrixForAxis,
} from '../src/plugins/snap-point/snap-alignment';

/** Apply a Matrix4 to a newly-constructed root and update worlds. */
function applyMatrix(asset: Object3D, M: ReturnType<typeof computeSnapAlignedWorldMatrix>): void {
  asset.matrixAutoUpdate = false;
  asset.matrix.copy(M);
  M.decompose(asset.position, asset.quaternion, asset.scale);
  asset.matrixAutoUpdate = true;
  asset.updateMatrixWorld(true);
}

describe('computeSnapAlignedWorldMatrix', () => {
  it('places newAsset so newSnap world-position matches targetSnap world-position', () => {
    // Target snap at world (5, 0, 0)
    const targetRoot = new Object3D();
    targetRoot.position.set(5, 0, 0);
    targetRoot.updateMatrixWorld(true);
    const targetSnap = new Object3D();
    targetRoot.add(targetSnap);
    targetSnap.updateMatrixWorld(true);

    // New asset with snap offset (0, 0, 1) inside
    const newAsset = new Object3D();
    const newSnap = new Object3D();
    newSnap.position.set(0, 0, 1);
    newAsset.add(newSnap);
    newAsset.updateMatrixWorld(true);

    const M = computeSnapAlignedWorldMatrix(targetSnap, newAsset, newSnap, 'Z');
    applyMatrix(newAsset, M);
    newSnap.updateMatrixWorld(true);

    const got = newSnap.getWorldPosition(new Vector3());
    expect(got.x).toBeCloseTo(5, 5);
    expect(got.y).toBeCloseTo(0, 5);
    expect(got.z).toBeCloseTo(0, 5);
  });

  it('flipMatrixForAxis is identity (current convention has no flip)', () => {
    // Opposite-sign snaps already face each other when their world matrices
    // align; same-sign mates would need a flip but the matcher prohibits them.
    for (const axis of ['X', 'Y', 'Z'] as const) {
      const m = flipMatrixForAxis(axis);
      const v = new Vector3(0, 0, 1).applyMatrix4(m);
      expect(v.x).toBeCloseTo(0, 6);
      expect(v.y).toBeCloseTo(0, 6);
      expect(v.z).toBeCloseTo(1, 6);
    }
  });

  it('places assets end-to-end (no overlap) for opposite-sign Z snaps', () => {
    // Target: conveyor A at origin, length 1, ZP snap at world (0,0,+0.5).
    const A = new Object3D();
    const aZp = new Object3D();
    aZp.position.set(0, 0, 0.5);
    A.add(aZp);
    A.updateMatrixWorld(true);

    // New: conveyor B at origin, length 1, ZN snap at local (0,0,-0.5).
    const B = new Object3D();
    const bZn = new Object3D();
    bZn.position.set(0, 0, -0.5);
    B.add(bZn);
    B.updateMatrixWorld(true);

    const M = computeSnapAlignedWorldMatrix(aZp, B, bZn, 'Z');
    applyMatrix(B, M);

    // B's CENTER must end up at world (0, 0, 1) — one unit past A's centre,
    // not stacked on top of it.
    expect(B.position.x).toBeCloseTo(0, 5);
    expect(B.position.y).toBeCloseTo(0, 5);
    expect(B.position.z).toBeCloseTo(1, 5);
    // B's local +Z direction matches A's local +Z (both forward).
    const bZ = new Vector3(0, 0, 1).applyQuaternion(B.quaternion).normalize();
    expect(bZ.z).toBeCloseTo(1, 5);
  });

  it('chained snap placement: stacking 3 modules preserves alignment', () => {
    // Module A: snap-out at +Z (offset 1)
    const A = new Object3D();
    A.position.set(0, 0, 0);
    const ASnapOut = new Object3D();
    ASnapOut.position.set(0, 0, 1);
    A.add(ASnapOut);
    A.updateMatrixWorld(true);

    // Module B template: snap-in at +Z 0, snap-out at +Z 2 (length 2 in local Z)
    // After alignment, B's snap-in lands on A's snap-out.
    function makeModule(length: number): { root: Object3D; snapIn: Object3D; snapOut: Object3D } {
      const root = new Object3D();
      const snapIn = new Object3D();
      const snapOut = new Object3D();
      snapOut.position.set(0, 0, length);
      root.add(snapIn, snapOut);
      return { root, snapIn, snapOut };
    }

    const B = makeModule(2);
    const M = computeSnapAlignedWorldMatrix(ASnapOut, B.root, B.snapIn, 'Z');
    applyMatrix(B.root, M);
    B.snapIn.updateMatrixWorld(true);
    B.snapOut.updateMatrixWorld(true);

    // B's snap-in should match A's snap-out world pos
    const inPos = B.snapIn.getWorldPosition(new Vector3());
    const aOutPos = ASnapOut.getWorldPosition(new Vector3());
    expect(inPos.x).toBeCloseTo(aOutPos.x, 5);
    expect(inPos.y).toBeCloseTo(aOutPos.y, 5);
    expect(inPos.z).toBeCloseTo(aOutPos.z, 5);

    // Now place C on B's snap-out
    const C = makeModule(3);
    const M2 = computeSnapAlignedWorldMatrix(B.snapOut, C.root, C.snapIn, 'Z');
    applyMatrix(C.root, M2);
    C.snapIn.updateMatrixWorld(true);

    const cInPos = C.snapIn.getWorldPosition(new Vector3());
    const bOutPos = B.snapOut.getWorldPosition(new Vector3());
    expect(cInPos.x).toBeCloseTo(bOutPos.x, 5);
    expect(cInPos.y).toBeCloseTo(bOutPos.y, 5);
    expect(cInPos.z).toBeCloseTo(bOutPos.z, 5);
  });

  it('respects a translated newAsset starting transform when computing offset', () => {
    // newAsset starts somewhere far away; result must still end up at target.
    const targetSnap = new Object3D();
    targetSnap.position.set(10, 0, 0);
    targetSnap.updateMatrixWorld(true);

    const newAsset = new Object3D();
    newAsset.position.set(-50, 4, 7);
    const newSnap = new Object3D();
    newSnap.position.set(0, 0, 0.25);
    newAsset.add(newSnap);
    newAsset.updateMatrixWorld(true);

    const M = computeSnapAlignedWorldMatrix(targetSnap, newAsset, newSnap, 'Z');
    applyMatrix(newAsset, M);
    newSnap.updateMatrixWorld(true);

    const got = newSnap.getWorldPosition(new Vector3());
    expect(got.x).toBeCloseTo(10, 5);
    expect(got.y).toBeCloseTo(0, 5);
    expect(got.z).toBeCloseTo(0, 5);
  });
});
