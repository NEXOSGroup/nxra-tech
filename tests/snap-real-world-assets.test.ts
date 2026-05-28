// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Real-world placement scenarios mirrored from the actual library GLBs
 * (Turntable, ChainTransfer, RollConveyor-1m). These verify that the
 * alignment math produces the expected result for cross-axis pairs,
 * which is the case the user reported "isn't working" on hover/drag.
 *
 * Library snap layouts (rotation identity for every snap):
 *
 *   Turntable        Snap-ZN/XN/ZP/XP-convroll  at world (0, .5, ±1), (±1, .5, 0)
 *   ChainTransfer    Snap-ZN-convroll           at local (0, .5, -.8)
 *                    Snap-ZP-convroll           at local (0, .5, +.8)
 *                    Snap-XP-convchain          at local (-.8, .5, 0)
 *   RollConveyor-1m  Snap-ZN/ZP-convroll        at local (0, .5, ±0.5)
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { computeSnapAlignedWorldMatrix } from '../src/plugins/snap-point/snap-alignment';

/** Build an asset root with an Empty snap-child at `localPos` (identity rotation). */
function makeAssetWithSnap(name: string, localPos: [number, number, number]) {
  const root = new Object3D();
  root.name = name;
  const snap = new Object3D();
  snap.name = `Snap-${name}`;
  snap.position.set(...localPos);
  root.add(snap);
  root.updateMatrixWorld(true);
  return { root, snap };
}

function applyMatrix(asset: Object3D, M: ReturnType<typeof computeSnapAlignedWorldMatrix>): void {
  asset.matrixAutoUpdate = false;
  asset.matrix.copy(M);
  M.decompose(asset.position, asset.quaternion, asset.scale);
  asset.matrixAutoUpdate = true;
  asset.updateMatrixWorld(true);
}

describe('Real-world snap placements', () => {
  it('RollConveyor attaches to Turntable XN side (cross-axis Z↔X)', () => {
    // Turntable at world origin. Snap-XN-convroll is at +X side of the
    // turntable (world (1, .5, 0)) — its outward direction is -X (per name).
    const T = makeAssetWithSnap('Turntable', [1, 0.5, 0]);

    // RollConveyor at origin. Pick its Snap-ZN side (local (0, .5, -.5),
    // outward direction -Z).
    const R = makeAssetWithSnap('Roll', [0, 0.5, -0.5]);

    const M = computeSnapAlignedWorldMatrix(
      T.snap,
      R.root,
      R.snap,
      { axis: 'X', sign: 'N', code: 'XN' },
      { axis: 'Z', sign: 'N', code: 'ZN' },
    );
    applyMatrix(R.root, M);

    // Snap positions must coincide.
    const rSnapW = R.snap.getWorldPosition(new Vector3());
    const tSnapW = T.snap.getWorldPosition(new Vector3());
    expect(rSnapW.x).toBeCloseTo(tSnapW.x, 5);
    expect(rSnapW.y).toBeCloseTo(tSnapW.y, 5);
    expect(rSnapW.z).toBeCloseTo(tSnapW.z, 5);

    // RollConveyor's body extends from its snap along its +Z axis. After the
    // swing rotation, that +Z must lie along the world +X axis so the conveyor
    // points away from the turntable.
    const rZAxis = new Vector3(0, 0, 1).applyQuaternion(R.root.quaternion).normalize();
    expect(rZAxis.x).toBeCloseTo(1, 5);
    expect(rZAxis.y).toBeCloseTo(0, 5);
    expect(rZAxis.z).toBeCloseTo(0, 5);
  });

  it('RollConveyor attaches to ChainTransfer ZP side (same-axis Z↔Z)', () => {
    const C = makeAssetWithSnap('ChainTransfer', [0, 0.5, 0.8]); // Snap-ZP
    const R = makeAssetWithSnap('Roll', [0, 0.5, -0.5]);        // Snap-ZN

    const M = computeSnapAlignedWorldMatrix(
      C.snap,
      R.root,
      R.snap,
      { axis: 'Z', sign: 'P', code: 'ZP' },
      { axis: 'Z', sign: 'N', code: 'ZN' },
    );
    applyMatrix(R.root, M);

    // Snaps coincide.
    const rSnapW = R.snap.getWorldPosition(new Vector3());
    expect(rSnapW.x).toBeCloseTo(0, 5);
    expect(rSnapW.z).toBeCloseTo(0.8, 5);
    // Roll's body extends in world +Z (away from ChainTransfer body).
    const rZAxis = new Vector3(0, 0, 1).applyQuaternion(R.root.quaternion).normalize();
    expect(rZAxis.z).toBeCloseTo(1, 5);
  });

  it('Turntable connects to ChainTransfer (both have convroll)', () => {
    // User scenario: drag a Turntable near a ChainTransfer's ZP snap. Pick
    // the Turntable's ZN snap (local (0, .5, -1)).
    const C = makeAssetWithSnap('ChainTransfer', [0, 0.5, 0.8]); // ZP
    const T = makeAssetWithSnap('Turntable', [0, 0.5, -1]);     // ZN

    const M = computeSnapAlignedWorldMatrix(
      C.snap,
      T.root,
      T.snap,
      { axis: 'Z', sign: 'P', code: 'ZP' },
      { axis: 'Z', sign: 'N', code: 'ZN' },
    );
    applyMatrix(T.root, M);

    // Turntable's snap lands on ChainTransfer's snap.
    const tSnapW = T.snap.getWorldPosition(new Vector3());
    expect(tSnapW.x).toBeCloseTo(0, 5);
    expect(tSnapW.z).toBeCloseTo(0.8, 5);
    // Turntable's centre is one unit further in +Z (ZN snap at local -Z, so
    // root sits at snap world +Z relative).
    expect(T.root.position.z).toBeCloseTo(1.8, 5);
  });

  it('Turntable XP side connects to ChainTransfer ZP (cross-axis)', () => {
    // Snap-XP-convroll on the Turntable sits at local (-1, .5, 0). With
    // position-derived outward (the new convention), its outward is local
    // -X (the side the Empty actually sits on). Connecting to ChainTransfer
    // ZP (outward +Z world) requires a swing rotation that maps Turntable's
    // -X to world -Z — i.e. a 90° rotation around Y. After alignment,
    // Turntable's snap must land on ChainTransfer's snap.
    const C = makeAssetWithSnap('ChainTransfer', [0, 0.5, 0.8]);
    const T = makeAssetWithSnap('Turntable', [-1, 0.5, 0]);

    const M = computeSnapAlignedWorldMatrix(
      C.snap,
      T.root,
      T.snap,
      { axis: 'Z', sign: 'P', code: 'ZP' },
      { axis: 'X', sign: 'P', code: 'XP' },
    );
    applyMatrix(T.root, M);

    const tSnapW = T.snap.getWorldPosition(new Vector3());
    expect(tSnapW.x).toBeCloseTo(0, 5);
    expect(tSnapW.z).toBeCloseTo(0.8, 5);
    // Asset is rotated so its body extends AWAY from ChainTransfer along
    // world +Z (snap is at the "back" side of Turntable in world, body in
    // front). Concretely: Turntable's centre lands at world Z = 0.8 + 1.
    expect(T.root.position.z).toBeCloseTo(1.8, 5);
  });
});
