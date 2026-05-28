// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Bbox-snap unit tests — pure-math layer (findBestAxisSnap).
 *
 * The full BboxSnapController is exercised in manual E2E (it touches the
 * scene graph + DOM keyboard listeners). Here we test the snap math in
 * isolation: it's where the correctness lives, and it's pure scalars.
 */
import { describe, it, expect } from 'vitest';
import { findBestAxisSnap } from '../src/plugins/layout-planner/bbox-snap';

const TOL = 0.030; // 30 mm world tolerance

describe('findBestAxisSnap', () => {
  it('snaps moving max to target min (touching edge-to-edge)', () => {
    // Moving box at X ∈ [0, 1]; target at X ∈ [1.005, 2]
    // Best alignment: moving.max (1.0) → target.min (1.005), delta = +0.005 m
    const r = findBestAxisSnap(
      0, 0.5, 1.0,                  // moving min/center/max
      [1.005], [1.5025], [2.0],     // target min/center/max
      1, TOL,
    );
    expect(r.snapped).toBe(true);
    expect(r.delta).toBeCloseTo(0.005, 6);
    expect(r.targetIdx).toBe(0);
    expect(r.snapValue).toBeCloseTo(1.005, 6);
  });

  it('snaps centers when they are closer than edges', () => {
    // Moving center 0.5; target center 0.502 — within tolerance
    // Edges (max 1.0 vs min 0.002 → 0.998 delta) are far; center wins
    const r = findBestAxisSnap(
      0, 0.5, 1.0,
      [0.002], [0.502], [1.002],
      1, TOL,
    );
    expect(r.snapped).toBe(true);
    // Smallest abs delta is center→center = +0.002 (or max→max = +0.002)
    // either is acceptable; both yield the same |delta|
    expect(Math.abs(r.delta)).toBeCloseTo(0.002, 6);
  });

  it('returns snapped=false when nearest candidate is beyond tolerance', () => {
    // Moving at 0..1; target far away at 5..6 — closest delta = 4.0
    const r = findBestAxisSnap(
      0, 0.5, 1.0,
      [5], [5.5], [6],
      1, TOL,
    );
    expect(r.snapped).toBe(false);
    // delta + targetIdx still populated (the controller ignores them)
    expect(r.targetIdx).toBe(0);
  });

  it('picks the closest of multiple targets', () => {
    // Three targets at increasing distance; snap to the nearest
    const r = findBestAxisSnap(
      0, 0.5, 1.0,
      [1.020, 1.500, 3.000],
      [1.520, 2.000, 3.500],
      [2.020, 2.500, 4.000],
      3, TOL,
    );
    expect(r.snapped).toBe(true);
    expect(r.targetIdx).toBe(0);
    // moving.max (1.0) → target[0].min (1.020) = +0.020
    expect(r.delta).toBeCloseTo(0.020, 6);
  });

  it('returns snapped=false on empty target list', () => {
    const r = findBestAxisSnap(
      0, 0.5, 1.0,
      [], [], [],
      0, TOL,
    );
    expect(r.snapped).toBe(false);
  });

  it('handles negative-coordinate targets', () => {
    // Moving box at X ∈ [10, 11]; target at X ∈ [-1, 11.005]
    // moving.max (11) → target.max (11.005), delta = +0.005
    const r = findBestAxisSnap(
      10, 10.5, 11.0,
      [-1], [5.0025], [11.005],
      1, TOL,
    );
    expect(r.snapped).toBe(true);
    expect(r.delta).toBeCloseTo(0.005, 6);
  });

  it('honors the tolerance boundary exactly', () => {
    // Use exactly-representable FP values (powers of two) to avoid IEEE-754
    // rounding noise at the boundary. 0.125 is exactly representable.
    const tol = 0.125;
    // Delta exactly equal to tolerance → snap (≤ comparison)
    const r1 = findBestAxisSnap(
      0, 0.5, 1.0,
      [1.125], [1.625], [2.125],
      1, tol,
    );
    expect(r1.snapped).toBe(true);
    expect(r1.delta).toBeCloseTo(0.125, 6);

    // Clearly past tolerance → no snap
    const r2 = findBestAxisSnap(
      0, 0.5, 1.0,
      [1.5], [2.0], [2.5],
      1, tol,
    );
    expect(r2.snapped).toBe(false);
  });
});
