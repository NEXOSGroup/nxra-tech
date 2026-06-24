// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for the two helpers that make the live-draft drag-in model work with a
 * REGISTERED dragged object:
 *  - `findBestGhostSnap(..., excludeOwner)` — skips the draft's OWN ports so it
 *    doesn't self-match once registered.
 *  - `markSnapOccupied(...)` — commit-time occupancy + pairing without re-register.
 */
import { describe, test, expect } from 'vitest';
import { Group, Object3D } from 'three';
import { SnapPointRegistry, type SnapPoint } from '../src/core/engine/rv-snap-point-registry';
import { findBestGhostSnap } from '../src/plugins/snap-point/ghost-snap-match';
import { markSnapOccupied, type SceneMutationDeps } from '../src/plugins/layout-planner/scene-mutations';
import type { SnapDirectionCode } from '../src/plugins/snap-point/snap-name-parser';

function makeSnap(id: string, code: SnapDirectionCode, typeId: string, owner: Object3D, node: Object3D): SnapPoint {
  node.name = `Snap-${code}-${typeId}`;
  return {
    id,
    object3D: node,
    dir: { axis: code[0] as 'X' | 'Y' | 'Z', sign: code[1] as 'N' | 'P', code },
    typeId,
    ownerRoot: owner,
    scenePath: node.name,
    occupied: false,
  };
}

function minimalDeps(): SceneMutationDeps {
  return {
    getViewer: () => ({ getPlugin: () => undefined }) as never,
    objectMap: new Map(),
    idByObject: new WeakMap(),
    getLayoutRoot: () => new Group(),
    getTransformControls: () => null,
    getModelRoot: () => null,
  };
}

describe('findBestGhostSnap — excludeOwner', () => {
  test('without excludeOwner, the draft self-matches its own (distance-0) port', () => {
    const ghostRoot = new Group();
    const ghostPort = new Object3D();
    ghostRoot.add(ghostPort);
    const reg = new SnapPointRegistry();
    // The draft's own port, registered (ownerRoot = ghostRoot) — distance 0.
    reg.register(makeSnap('self', 'ZP', 'belt', ghostRoot, ghostPort));
    // A foreign port slightly away.
    const otherRoot = new Group();
    const foreignPort = new Object3D();
    foreignPort.position.set(0.1, 0, 0);
    otherRoot.add(foreignPort);
    reg.register(makeSnap('foreign', 'ZN', 'belt', otherRoot, foreignPort));
    ghostRoot.updateMatrixWorld(true);
    otherRoot.updateMatrixWorld(true);

    const match = findBestGhostSnap(ghostRoot, reg, 1.0);
    expect(match?.targetSnap.id).toBe('self'); // the self-match bug, unguarded
  });

  test('with excludeOwner = draft root, self ports are skipped → foreign match', () => {
    const ghostRoot = new Group();
    const ghostPort = new Object3D();
    ghostRoot.add(ghostPort);
    const reg = new SnapPointRegistry();
    reg.register(makeSnap('self', 'ZP', 'belt', ghostRoot, ghostPort));
    const otherRoot = new Group();
    const foreignPort = new Object3D();
    foreignPort.position.set(0.1, 0, 0);
    otherRoot.add(foreignPort);
    reg.register(makeSnap('foreign', 'ZN', 'belt', otherRoot, foreignPort));
    ghostRoot.updateMatrixWorld(true);
    otherRoot.updateMatrixWorld(true);

    const match = findBestGhostSnap(ghostRoot, reg, 1.0, ghostRoot);
    expect(match?.targetSnap.id).toBe('foreign');
  });
});

describe('markSnapOccupied', () => {
  test('marks target + own occupied and pairs them (no re-register)', () => {
    const draft = new Group();
    const ownPort = new Object3D();
    draft.add(ownPort);
    const reg = new SnapPointRegistry();
    reg.register(makeSnap('own', 'ZP', 'belt', draft, ownPort)); // draft's registered port
    const targetOwner = new Group();
    const target = makeSnap('target', 'ZN', 'belt', targetOwner, new Object3D());
    reg.register(target);

    markSnapOccupied(minimalDeps(), draft, 'draft-1', target, 'Snap-ZP-belt', reg);

    expect(target.occupied).toBe(true);
    expect(target.occupiedBy).toBe('draft-1');
    const own = reg.getById('own')!;
    expect(own.occupied).toBe(true);
    // Bidirectional pairing for chain-walk.
    expect(own.pairedSnapId).toBe('target');
    expect(target.pairedSnapId).toBe('own');
  });
});
