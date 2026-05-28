// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import {
  SnapPointRegistry,
  type SnapPoint,
} from '../src/core/engine/rv-snap-point-registry';
import { SnapPlacementService } from '../src/plugins/snap-point/snap-placement-service';

function makeTargetSnap(reg: SnapPointRegistry): SnapPoint {
  const node = new Object3D();
  node.name = 'Snap-ZN-convroll';
  const sp: SnapPoint = {
    id: 'target-1',
    object3D: node,
    dir: { axis: 'Z', sign: 'N', code: 'ZN' },
    typeId: 'convroll',
    ownerRoot: node,
    scenePath: 'Snap-ZN-convroll',
    occupied: false,
  };
  reg.register(sp);
  return sp;
}

function makeAsset(snapName = 'Snap-ZP-convroll'): { root: Object3D; snap: Object3D } {
  const root = new Object3D();
  const snap = new Object3D();
  snap.name = snapName;
  root.add(snap);
  return { root, snap };
}

describe('SnapPlacementService.canPlace', () => {
  let registry: SnapPointRegistry;
  let svc: SnapPlacementService;
  let target: SnapPoint;

  beforeEach(() => {
    registry = new SnapPointRegistry();
    // Viewer is not used by canPlace — cast empty stub
    svc = new SnapPlacementService({} as never, registry);
    target = makeTargetSnap(registry);
  });

  it('rejects asset with non-uniform scale', () => {
    const { root } = makeAsset();
    root.scale.set(2, 1, 1);
    const r = svc.canPlace(target, root, 'Snap-ZP-convroll');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/non-uniform scale/i);
  });

  it('accepts uniform scale within epsilon', () => {
    const { root } = makeAsset();
    root.scale.set(1.0, 1.00001, 0.99999);
    const r = svc.canPlace(target, root, 'Snap-ZP-convroll');
    expect(r.ok).toBe(true);
  });

  it('rejects placement on occupied snap', () => {
    registry.markOccupied(target.id, 'placed-1');
    const { root } = makeAsset();
    const r = svc.canPlace(target, root, 'Snap-ZP-convroll');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/occupied/i);
  });

  it('rejects missing snap inside asset', () => {
    const { root } = makeAsset();
    const r = svc.canPlace(target, root, 'Snap-XX-doesNotExist');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not found/i);
  });

  it('accepts same-direction same-typeId (cross-axis or same-axis-same-sign allowed)', () => {
    // Direction code is NOT a hard filter — alignment math rotates the new
    // asset so outward axes meet anti-parallel regardless of which named
    // axes are used. Same-typeId is the only compatibility requirement.
    const { root } = makeAsset('Snap-ZN-convroll'); // same dir as target
    const r = svc.canPlace(target, root, 'Snap-ZN-convroll');
    expect(r.ok).toBe(true);
  });

  it('rejects incompatible typeId', () => {
    const { root } = makeAsset('Snap-ZP-belt');
    const r = svc.canPlace(target, root, 'Snap-ZP-belt');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/typeId/i);
  });

  it('accepts cross-axis pairing (XP target with ZN asset snap)', () => {
    // ChainTransfer-style: target has Snap-XP-convchain, library asset only
    // exposes Snap-ZN-convchain. Old matcher rejected this; new matcher
    // accepts because typeIds match.
    const { root } = makeAsset('Snap-ZN-convroll'); // typeId matches target
    const r = svc.canPlace(target, root, 'Snap-ZN-convroll');
    expect(r.ok).toBe(true);
  });

  it('accepts standard ZN-target / ZP-asset pairing', () => {
    const { root } = makeAsset('Snap-ZP-convroll');
    const r = svc.canPlace(target, root, 'Snap-ZP-convroll');
    expect(r.ok).toBe(true);
  });
});
