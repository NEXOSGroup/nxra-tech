// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Regression test for the picker-"+"-click placement direction bug.
 *
 * `addPlacedToScene` (and its inline twin in `placeAtSnapPoint`) propagates
 * `_layoutObject = true` to EVERY descendant of a placed asset — including
 * the snap empties themselves. If `_resolveOwnerRoot` keys off
 * `_layoutObject`, the walk starts at the snap and returns the snap as
 * "owner", so `outwardLocalByPosition` sees diff=0 and falls back to the
 * snap name's sign letter. That fallback yields the WRONG outward for
 * X-axis snaps (Unity → glTF X-flip) and, more importantly, prevents the
 * position-derived outward from ever overriding stale sign information.
 *
 * This test reproduces the production marking pattern and asserts the
 * newly placed asset's snap actually lands at the target's world position
 * and that its body extends OUTWARD (away from the target) rather than
 * into the target.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { computeSnapAlignedWorldMatrix } from '../src/plugins/snap-point/snap-alignment';

/** Mark every node under `root` (root included) with `_layoutObject = true`,
 *  matching the production `clone.traverse(child => child.userData._layoutObject = true)`
 *  pattern in scene-mutations. The root additionally gets `_layoutId`. */
function markPlaced(root: Object3D, id: string): void {
  root.userData._layoutId = id;
  root.traverse((n) => { n.userData._layoutObject = true; });
}

function applyMatrix(asset: Object3D, M: ReturnType<typeof computeSnapAlignedWorldMatrix>): void {
  asset.matrixAutoUpdate = false;
  asset.matrix.copy(M);
  M.decompose(asset.position, asset.quaternion, asset.scale);
  asset.matrixAutoUpdate = true;
  asset.updateMatrixWorld(true);
}

describe('Picker placement direction (production _layoutObject marking)', () => {
  it('Z-axis turntable snap attaches a Z-axis conveyor along world -Z (outward)', () => {
    // Turntable already placed in the scene with snaps at ±1 on Z (and ±1 on X).
    // Reproduces production marking — every descendant carries _layoutObject.
    const turntable = new Object3D();
    const tZN = new Object3D(); tZN.name = 'Snap-ZN-convroll'; tZN.position.set(0, 0.5, -1);
    turntable.add(tZN);
    markPlaced(turntable, 'turntable-1');
    turntable.updateMatrixWorld(true);

    // Fresh conveyor clone — NOT yet marked. snap at +Z end (flow 'out').
    const conv = new Object3D();
    const cZP = new Object3D(); cZP.name = 'Snap-ZP-convroll'; cZP.position.set(0, 0.5, +1);
    conv.add(cZP);
    conv.updateMatrixWorld(true);

    const M = computeSnapAlignedWorldMatrix(
      tZN, conv, cZP,
      { axis: 'Z', sign: 'N', code: 'ZN' },
      { axis: 'Z', sign: 'P', code: 'ZP' },
    );
    applyMatrix(conv, M);

    // Snap-on-snap landing.
    const cSnapW = cZP.getWorldPosition(new Vector3());
    const tSnapW = tZN.getWorldPosition(new Vector3());
    expect(cSnapW.x).toBeCloseTo(tSnapW.x, 5);
    expect(cSnapW.y).toBeCloseTo(tSnapW.y, 5);
    expect(cSnapW.z).toBeCloseTo(tSnapW.z, 5);

    // Conveyor body must extend AWAY from the turntable. Target outward is
    // world -Z (snap at z=-1, owner centered at z=0). Conveyor centre must
    // therefore land at z < target.z — i.e. further south.
    expect(conv.position.z).toBeLessThan(tSnapW.z);
  });

  it('X-axis turntable snap attaches a Z-axis conveyor along world +X (outward, Unity X-flip aware)', () => {
    // GLB authored in Unity: Snap-XN at GLB-local +X (Unity→glTF X-flip).
    // The CORRECT outward is +X (position-derived); the name's sign letter
    // alone would yield -X (Wrong).
    const turntable = new Object3D();
    const tXN = new Object3D(); tXN.name = 'Snap-XN-convroll'; tXN.position.set(+1, 0.5, 0);
    turntable.add(tXN);
    markPlaced(turntable, 'turntable-1');
    turntable.updateMatrixWorld(true);

    const conv = new Object3D();
    const cZP = new Object3D(); cZP.name = 'Snap-ZP-convroll'; cZP.position.set(0, 0.5, +1);
    conv.add(cZP);
    conv.updateMatrixWorld(true);

    const M = computeSnapAlignedWorldMatrix(
      tXN, conv, cZP,
      { axis: 'X', sign: 'N', code: 'XN' },
      { axis: 'Z', sign: 'P', code: 'ZP' },
    );
    applyMatrix(conv, M);

    // Snap-on-snap landing.
    const cSnapW = cZP.getWorldPosition(new Vector3());
    const tSnapW = tXN.getWorldPosition(new Vector3());
    expect(cSnapW.x).toBeCloseTo(tSnapW.x, 5);
    expect(cSnapW.z).toBeCloseTo(tSnapW.z, 5);

    // Outward is world +X (snap at x=+1, owner centered at x=0). Conveyor
    // centre must land at x > target.x.
    expect(conv.position.x).toBeGreaterThan(tSnapW.x);
  });
});
