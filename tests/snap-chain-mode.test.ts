// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import {
  SnapPointRegistry,
  type SnapPoint,
} from '../src/core/engine/rv-snap-point-registry';
import {
  SnapMagneticController,
  CHAIN_BREAK_FACTOR,
  DEFAULT_MAGNET_RADIUS_M,
} from '../src/plugins/snap-point/snap-magnetic-controller';

// Re-declare the private ChainMember shape locally for test inspection.
interface ChainMember {
  root: Object3D;
}

function makeAsset(id: string, pos: [number, number, number]) {
  const root = new Object3D();
  root.name = id;
  root.position.set(...pos);
  root.updateMatrixWorld(true);
  return root;
}

function makeSnap(
  id: string,
  asset: Object3D,
  localPos: [number, number, number],
  axis: 'X' | 'Y' | 'Z' = 'Z',
  sign: 'N' | 'P' = 'P',
): SnapPoint {
  const node = new Object3D();
  node.name = `Snap-${axis}${sign}-conv`;
  node.position.set(...localPos);
  asset.add(node);
  node.updateMatrixWorld(true);
  return {
    id,
    object3D: node,
    dir: { axis, sign, code: `${axis}${sign}` as SnapPoint['dir']['code'] },
    typeId: 'conv',
    ownerRoot: asset,
    scenePath: id,
    occupied: false,
  };
}

describe('SnapPointRegistry.pair', () => {
  it('establishes bidirectional pairing', () => {
    const reg = new SnapPointRegistry();
    const a = new Object3D();
    const b = new Object3D();
    reg.register(makeSnap('a', a, [0, 0, 0]));
    reg.register(makeSnap('b', b, [0, 0, 0]));
    reg.pair('a', 'b');
    expect(reg.getById('a')!.pairedSnapId).toBe('b');
    expect(reg.getById('b')!.pairedSnapId).toBe('a');
  });

  it('unregister clears the partner pairing reference', () => {
    const reg = new SnapPointRegistry();
    const a = new Object3D();
    const b = new Object3D();
    reg.register(makeSnap('a', a, [0, 0, 0]));
    reg.register(makeSnap('b', b, [0, 0, 0]));
    reg.markOccupied('a', 'pa');
    reg.markOccupied('b', 'pb');
    reg.pair('a', 'b');
    reg.unregister('a');
    expect(reg.getById('b')!.pairedSnapId).toBeUndefined();
    // Partner becomes free again — its occupancy was tied to the deleted end.
    expect(reg.getById('b')!.occupied).toBe(false);
  });

  it('markFree on one end frees the partner too', () => {
    const reg = new SnapPointRegistry();
    const a = new Object3D();
    const b = new Object3D();
    reg.register(makeSnap('a', a, [0, 0, 0]));
    reg.register(makeSnap('b', b, [0, 0, 0]));
    reg.markOccupied('a', 'pa');
    reg.markOccupied('b', 'pb');
    reg.pair('a', 'b');
    reg.markFree('a');
    expect(reg.getById('a')!.pairedSnapId).toBeUndefined();
    expect(reg.getById('b')!.pairedSnapId).toBeUndefined();
  });
});

describe('SnapMagneticController chain mode', () => {
  let reg: SnapPointRegistry;
  let ctrl: SnapMagneticController;
  let A: Object3D;
  let B: Object3D;
  let C: Object3D;

  beforeEach(() => {
    reg = new SnapPointRegistry();
    ctrl = new SnapMagneticController(reg);

    // Three modules in a chain: A — B — C, each unit length along Z.
    A = makeAsset('A', [0, 0, 0]);
    B = makeAsset('B', [1, 0, 0]);
    C = makeAsset('C', [2, 0, 0]);

    // A's ZP snap at (0.5, 0, 0) world  -- pair with B's ZN at (-0.5, 0, 0) local = (0.5, 0, 0) world
    const aZp = makeSnap('aZp', A, [0.5, 0, 0]);
    const bZn = makeSnap('bZn', B, [-0.5, 0, 0]);
    const bZp = makeSnap('bZp', B, [0.5, 0, 0]);
    const cZn = makeSnap('cZn', C, [-0.5, 0, 0]);
    reg.register(aZp);
    reg.register(bZn);
    reg.register(bZp);
    reg.register(cZn);

    // Mark all four as paired so the chain resolver sees the edges.
    reg.markOccupied('aZp', 'A');
    reg.markOccupied('bZn', 'B');
    reg.markOccupied('bZp', 'B');
    reg.markOccupied('cZn', 'C');
    reg.pair('aZp', 'bZn');
    reg.pair('bZp', 'cZn');
  });

  it('chain mode walks the paired graph and collects all connected assets', () => {
    ctrl.armForDrag(A, undefined, { chainEnabled: true });
    // B + C must follow when A moves.
    expect(ctrl.getChainMemberCount()).toBe(2);
  });

  it('chain mode disabled = solo drag, no followers', () => {
    ctrl.armForDrag(A, undefined, { chainEnabled: false });
    expect(ctrl.getChainMemberCount()).toBe(0);
  });

  it('applyChainFollow keeps chain members rigid relative to the dragged root', () => {
    ctrl.armForDrag(A, undefined, { chainEnabled: true });
    // Move A 5 units in +X. Chain members must shift by exactly the same delta.
    const bBefore = B.position.x;
    const cBefore = C.position.x;
    A.position.x += 5;
    A.updateMatrixWorld(true);
    ctrl.applyChainFollow();
    expect(B.position.x).toBeCloseTo(bBefore + 5, 5);
    expect(C.position.x).toBeCloseTo(cBefore + 5, 5);
  });

  it('chain follow preserves position when moving root is rotated', () => {
    ctrl.armForDrag(A, undefined, { chainEnabled: true });
    // Rotate A 90° around Y. B must end up where A's local +X used to be in
    // the world; its old +X (1 unit ahead) maps to A's new +Z direction (= world -Z
    // after rot 90° CCW). Sanity: B is no longer at +X.
    A.rotation.y = Math.PI / 2;
    A.updateMatrixWorld(true);
    ctrl.applyChainFollow();
    // B started at world (1, 0, 0) rel to A at origin, i.e. relMatrix
    // encodes B at A's +X. After rotating A 90°: world = A.matrixWorld * relMatrix
    // The relative offset (1, 0, 0) rotated by 90° around Y becomes (0, 0, -1).
    expect(B.position.x).toBeCloseTo(0, 5);
    expect(B.position.z).toBeCloseTo(-1, 5);
  });

  it('large drag jumps do NOT break chain edges (rigid follow keeps edges intact)', () => {
    // Chain mode promises: a connected chain follows rigidly. Even a huge
    // drag jump (well beyond CHAIN_BREAK_FACTOR * radius) must NOT split
    // the chain — the edges only break when something OUTSIDE chain follow
    // moves a member out of place (e.g. concurrent edit).
    ctrl.armForDrag(A, undefined, { chainEnabled: true });
    A.position.x += 100;
    A.updateMatrixWorld(true);
    ctrl.applyChainFollow();
    expect(reg.getById('aZp')!.pairedSnapId).toBe('bZn');
    expect(reg.getById('bZn')!.pairedSnapId).toBe('aZp');
    // B + C must have followed.
    expect(B.position.x).toBeCloseTo(101, 5);
    expect(C.position.x).toBeCloseTo(102, 5);
  });

  it('break-check trips when an external move stretches an edge', () => {
    // Simulate a concurrent edit that moves a chain member out of place
    // (e.g. inspector edit during a drag). The next applyChainFollow tick
    // should detect the over-stretched edge and break it.
    ctrl.armForDrag(A, undefined, { chainEnabled: true });
    ctrl.applyChainFollow();
    // Drop C from the captured chain so rigid follow does NOT pull it back
    // to its expected position, then move C far away.
    (ctrl as unknown as { chainMembers: ChainMember[] }).chainMembers =
      (ctrl as unknown as { chainMembers: ChainMember[] }).chainMembers
        .filter((m) => m.root !== C);
    C.position.x += 100;
    C.updateMatrixWorld(true);
    // Now B is still in the chainMembers list (rigid follow keeps it
    // glued to A) — but B's bZp anchors to cZn which is now 100 units away.
    // applyChainFollow's break-check pass must sever the B-C edge.
    ctrl.applyChainFollow();
    expect(reg.getById('bZp')!.pairedSnapId).toBeUndefined();
    expect(reg.getById('cZn')!.pairedSnapId).toBeUndefined();
    // A-B edge stays intact (B is rigid with A).
    expect(reg.getById('aZp')!.pairedSnapId).toBe('bZn');
    expect(reg.getById('bZn')!.pairedSnapId).toBe('aZp');
  });

  it('CHAIN_BREAK_FACTOR is 2x the magnet radius', () => {
    // Pin the constant so future tweaks are intentional. If you change either
    // value, update this test to lock the new policy.
    expect(CHAIN_BREAK_FACTOR).toBe(2);
    expect(DEFAULT_MAGNET_RADIUS_M).toBeCloseTo(0.4, 5);
  });

  it('detaching the moved asset clears every paired-snap connection it owns', () => {
    // Simulates the snap-plugin _detachAssetConnections() helper invoked on
    // ALT-drag: every snap owned by `B` becomes free on both ends.
    expect(reg.getById('aZp')!.pairedSnapId).toBe('bZn');
    expect(reg.getById('bZp')!.pairedSnapId).toBe('cZn');
    for (const sp of reg.getAll()) {
      if (sp.ownerRoot === B && sp.pairedSnapId) reg.markFree(sp.id);
    }
    // B's own snaps + their partners are all free now.
    expect(reg.getById('bZn')!.pairedSnapId).toBeUndefined();
    expect(reg.getById('bZp')!.pairedSnapId).toBeUndefined();
    expect(reg.getById('aZp')!.pairedSnapId).toBeUndefined();
    expect(reg.getById('cZn')!.pairedSnapId).toBeUndefined();
    // Arming for drag on B should now find no chain members.
    ctrl.armForDrag(B, undefined, { chainEnabled: true });
    expect(ctrl.getChainMemberCount()).toBe(0);
  });
});
