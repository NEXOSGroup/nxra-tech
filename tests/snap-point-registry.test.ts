// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import { Group, Object3D } from 'three';
import {
  SnapPointRegistry,
  type SnapPoint,
} from '../src/core/engine/rv-snap-point-registry';
import type { SnapDirectionCode } from '../src/plugins/snap-point/snap-name-parser';

function makeSnap(
  id: string,
  code: SnapDirectionCode,
  typeId: string,
  owner?: Object3D,
): SnapPoint {
  const node = new Object3D();
  node.name = `Snap-${code}-${typeId}`;
  const ownerRoot = owner ?? node;
  return {
    id,
    object3D: node,
    dir: {
      axis: code[0] as 'X' | 'Y' | 'Z',
      sign: code[1] as 'N' | 'P',
      code,
    },
    typeId,
    ownerRoot,
    scenePath: node.name,
    occupied: false,
  };
}

describe('SnapPointRegistry', () => {
  let reg: SnapPointRegistry;
  beforeEach(() => {
    reg = new SnapPointRegistry();
  });

  it('returns all same-typeId snaps regardless of direction code', () => {
    // Direction is just outward-axis metadata for the alignment math — it
    // does NOT restrict compatibility. typeId match is the only criterion.
    reg.register(makeSnap('a', 'ZN', 'convroll'));
    reg.register(makeSnap('b', 'ZP', 'convroll'));
    reg.register(makeSnap('c', 'ZN', 'belt'));
    reg.register(makeSnap('d', 'XP', 'convroll'));

    const result = reg.getCompatible('convroll', 'ZP');
    expect(result.map((s) => s.id).sort()).toEqual(['a', 'b', 'd']);
  });

  it('returns empty array for unknown typeId', () => {
    reg.register(makeSnap('a', 'ZN', 'convroll'));
    expect(reg.getCompatible('belt', 'ZP')).toEqual([]);
  });

  it('register is idempotent on id', () => {
    const sp = makeSnap('a', 'ZN', 'convroll');
    reg.register(sp);
    reg.register(sp);
    expect(reg.size).toBe(1);
    expect(reg.getAll().length).toBe(1);
  });

  it('unregister removes from byId, byTypeId and getAll', () => {
    const sp = makeSnap('a', 'ZN', 'convroll');
    reg.register(sp);
    reg.unregister('a');
    expect(reg.getById('a')).toBeUndefined();
    expect(reg.getAll().length).toBe(0);
    expect(reg.getCompatible('convroll', 'ZP')).toEqual([]);
  });

  it('unregisterUnder removes all snaps under a subtree (by ownerRoot)', () => {
    const owner1 = new Group();
    const owner2 = new Group();
    const a = makeSnap('a', 'ZN', 'convroll', owner1);
    const b = makeSnap('b', 'ZP', 'convroll', owner1);
    const c = makeSnap('c', 'ZN', 'belt', owner2);
    reg.register(a);
    reg.register(b);
    reg.register(c);

    reg.unregisterUnder(owner1);
    expect(reg.size).toBe(1);
    expect(reg.getById('c')).toBeTruthy();
  });

  it('unregisterUnder removes snaps that are descendants of the root', () => {
    const root = new Group();
    const child = new Group();
    root.add(child);

    // owner field is root itself, but snap.object3D is a descendant
    const node = new Object3D();
    node.name = 'Snap-ZN-foo';
    child.add(node);

    const sp: SnapPoint = {
      id: 'd',
      object3D: node,
      dir: { axis: 'Z', sign: 'N', code: 'ZN' },
      typeId: 'foo',
      ownerRoot: root, // explicit owner root
      scenePath: 'root/child/Snap-ZN-foo',
      occupied: false,
    };
    reg.register(sp);

    reg.unregisterUnder(root);
    expect(reg.size).toBe(0);
  });

  it('markOccupied + markFree toggles state without removing snap', () => {
    reg.register(makeSnap('a', 'ZN', 'convroll'));
    reg.markOccupied('a', 'placed-1');
    expect(reg.getById('a')!.occupied).toBe(true);
    expect(reg.getById('a')!.occupiedBy).toBe('placed-1');

    reg.markFree('a');
    expect(reg.getById('a')!.occupied).toBe(false);
    expect(reg.getById('a')!.occupiedBy).toBeUndefined();
    expect(reg.size).toBe(1); // not removed
  });

  it('markOccupied for unknown id is a no-op', () => {
    expect(() => reg.markOccupied('xxx', 'p')).not.toThrow();
  });

  it('clear drops all state', () => {
    reg.register(makeSnap('a', 'ZN', 'convroll'));
    reg.register(makeSnap('b', 'ZP', 'convroll'));
    reg.clear();
    expect(reg.size).toBe(0);
    expect(reg.getCompatible('convroll', 'ZP')).toEqual([]);
  });
});
