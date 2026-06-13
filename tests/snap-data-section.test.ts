// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * snap-data-section.test.ts — Plan 200 §9.5 (A3, mock-level per §10.5).
 *
 * The inspector's Snap-Point section resolves a snap by Object3D.uuid through the
 * snap-point registry and projects type / axis / flow / state / paired-with. This
 * tests the pure projection (`snapInspectorData`) against a real SnapPointRegistry
 * — no React render (the WebViewer has no render-test precedent).
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { SnapPointRegistry, type SnapPoint } from '../src/core/engine/rv-snap-point-registry';
import { snapInspectorData } from '../src/core/hmi/rv-property-inspector';

function snap(id: string, name: string, flow: 'in' | 'out' | 'bidi', owner: Object3D): SnapPoint {
  const o = new Object3D(); o.name = name; o.uuid = id; owner.add(o);
  return {
    id,
    object3D: o,
    dir: { axis: 'Z', sign: flow === 'in' ? 'N' : flow === 'out' ? 'P' : 'B', code: flow === 'in' ? 'ZN' : flow === 'out' ? 'ZP' : 'ZB' },
    typeId: 'convroll',
    flow,
    ownerRoot: owner,
    scenePath: `${owner.name}/${name}`,
    occupied: false,
  };
}

describe('snapInspectorData (plan-200 §9.5)', () => {
  it('returns null for an unknown uuid', () => {
    const reg = new SnapPointRegistry();
    expect(snapInspectorData(reg, 'nope')).toBeNull();
    expect(snapInspectorData(null, 'nope')).toBeNull();
  });

  it('projects type/axis/flow/state for a free snap', () => {
    const reg = new SnapPointRegistry();
    const owner = new Object3D(); owner.name = 'Conv';
    reg.register(snap('s-out', 'Snap-ZP-convroll', 'out', owner));

    const d = snapInspectorData(reg, 's-out');
    expect(d).toEqual({
      type: 'convroll',
      axis: 'Z',
      flow: 'Output',
      state: 'Free',
      occupied: false,
      pairedWith: '—',
      partnerOwnerRoot: null,
    });
  });

  it('reports the paired partner owner-root name when connected', () => {
    const reg = new SnapPointRegistry();
    const convA = new Object3D(); convA.name = 'ConvA';
    const convB = new Object3D(); convB.name = 'ConvB';
    reg.register(snap('a-out', 'Snap-ZP-convroll', 'out', convA));
    reg.register(snap('b-in', 'Snap-ZN-convroll', 'in', convB));
    reg.pair('a-out', 'b-in');
    reg.markOccupied('a-out', 'placed-1');

    const d = snapInspectorData(reg, 'a-out');
    expect(d?.flow).toBe('Output');
    expect(d?.state).toBe('Occupied');
    expect(d?.occupied).toBe(true);
    expect(d?.pairedWith).toBe('ConvB');
    // The partner owner-root is exposed for clickable "Paired with" navigation.
    expect(d?.partnerOwnerRoot).toBe(convB);
  });

  it('maps a bidirectional input/output flow correctly', () => {
    const reg = new SnapPointRegistry();
    const owner = new Object3D(); owner.name = 'TT';
    reg.register(snap('bidi', 'Snap-ZB-convroll', 'bidi', owner));
    expect(snapInspectorData(reg, 'bidi')?.flow).toBe('Bidirectional');
  });
});
