// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Integration test: snap-scanner discovers Snap-* empty nodes in a
 * programmatically-built Three.js hierarchy.
 *
 * Uses a Group instead of a binary GLB to keep the test deterministic
 * and renderer-agnostic. E2E with real GLBs lives in the picker test.
 */

import { describe, it, expect } from 'vitest';
import { Group, Object3D } from 'three';
import { SnapPointRegistry } from '../src/core/engine/rv-snap-point-registry';
import { scanAndRegisterSnaps } from '../src/plugins/snap-point/snap-scanner';

function buildRollConveyorMock(): Group {
  const root = new Group();
  root.name = 'RollConveyor-1m';
  const snapZN = new Object3D();
  snapZN.name = 'Snap-ZN-convroll';
  snapZN.position.set(0, 0, -0.5);
  const snapZP = new Object3D();
  snapZP.name = 'Snap-ZP-convroll';
  snapZP.position.set(0, 0, 0.5);
  root.add(snapZN, snapZP);
  return root;
}

describe('scanAndRegisterSnaps', () => {
  it('discovers all Snap-* empty nodes in subtree', () => {
    const reg = new SnapPointRegistry();
    scanAndRegisterSnaps(buildRollConveyorMock(), reg);
    const all = reg.getAll();
    expect(all.length).toBe(2);
    expect(all.find((s) => s.dir.code === 'ZN' && s.typeId === 'convroll')).toBeTruthy();
    expect(all.find((s) => s.dir.code === 'ZP' && s.typeId === 'convroll')).toBeTruthy();
  });

  it('skips non-Snap-named nodes', () => {
    const reg = new SnapPointRegistry();
    const root = new Group();
    const m1 = new Object3D(); m1.name = 'Base';
    const m2 = new Object3D(); m2.name = 'DriveMesh';
    root.add(m1, m2);
    scanAndRegisterSnaps(root, reg);
    expect(reg.getAll().length).toBe(0);
  });

  it('uses node.uuid as id (collision-free for same-named siblings)', () => {
    const reg = new SnapPointRegistry();
    const root = new Group();
    const a = new Object3D(); a.name = 'Snap-ZN-convroll';
    const b = new Object3D(); b.name = 'Snap-ZN-convroll'; // duplicate name
    root.add(a, b);
    scanAndRegisterSnaps(root, reg);
    expect(reg.getAll().length).toBe(2);
    expect(reg.getById(a.uuid)).toBeTruthy();
    expect(reg.getById(b.uuid)).toBeTruthy();
  });

  it('uses the explicit ownerRoot when provided', () => {
    const reg = new SnapPointRegistry();
    const owner = new Group();
    owner.name = 'PlacedAsset-42';
    const child = new Group();
    const snap = new Object3D();
    snap.name = 'Snap-XP-flange';
    child.add(snap);
    owner.add(child);
    scanAndRegisterSnaps(owner, reg, owner);
    const all = reg.getAll();
    expect(all.length).toBe(1);
    expect(all[0].ownerRoot).toBe(owner);
  });

  it('keeps the authored flow (in/out) for non-turntable assets', () => {
    const reg = new SnapPointRegistry();
    scanAndRegisterSnaps(buildRollConveyorMock(), reg);
    const all = reg.getAll();
    expect(all.find((s) => s.dir.code === 'ZN')?.flow).toBe('in');
    expect(all.find((s) => s.dir.code === 'ZP')?.flow).toBe('out');
  });

  it('forces ports to bidirectional for a turntable asset (axis kept, flow overridden)', () => {
    const reg = new SnapPointRegistry();
    const tt = new Group(); tt.name = 'Turntable-4Way';
    const zn = new Object3D(); zn.name = 'Snap-ZN-tt'; zn.position.set(0, 0, -0.5);
    const zp = new Object3D(); zp.name = 'Snap-ZP-tt'; zp.position.set(0, 0, 0.5);
    tt.add(zn, zp);
    scanAndRegisterSnaps(tt, reg, tt);
    const all = reg.getAll();
    // Axis preserved from the name…
    expect(all.find((s) => s.dir.code === 'ZN')).toBeTruthy();
    expect(all.find((s) => s.dir.code === 'ZP')).toBeTruthy();
    // …but every port is bidirectional so any conveyor can attach either way.
    expect(all.every((s) => s.flow === 'bidi')).toBe(true);
  });

  it('records a sensible scenePath for debug', () => {
    const reg = new SnapPointRegistry();
    const root = new Group();
    root.name = 'Root';
    const mid = new Group();
    mid.name = 'Middle';
    const snap = new Object3D();
    snap.name = 'Snap-ZN-convroll';
    mid.add(snap);
    root.add(mid);
    scanAndRegisterSnaps(root, reg);
    const sp = reg.getAll()[0];
    expect(sp.scenePath).toContain('Snap-ZN-convroll');
  });
});
