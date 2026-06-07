// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Geometry-based snap-pairing reconstruction tests.
 *
 * `computeProximityPairings` rebuilds the connection graph after restore by
 * pairing compatible, coincident snaps from different owners. This is what
 * makes chained ("enchained") layout assemblies survive a page reload.
 */

import { describe, it, expect } from 'vitest';
import {
  computeProximityPairings,
  type RebuildSnapInput,
} from '../src/plugins/snap-point/snap-pairing-rebuild';

const EPS = 0.005;

/** Convenience builder. */
function snap(
  id: string,
  owner: unknown,
  pos: [number, number, number],
  opts: { typeId?: string; flow?: RebuildSnapInput['flow'] } = {},
): RebuildSnapInput {
  return {
    id, owner,
    typeId: opts.typeId ?? 'conv',
    flow: opts.flow,
    x: pos[0], y: pos[1], z: pos[2],
  };
}

describe('computeProximityPairings', () => {
  it('pairs two coincident compatible snaps from different owners', () => {
    const snaps = [
      snap('a', 'A', [1, 0, 0], { flow: 'out' }),
      snap('b', 'B', [1, 0, 0], { flow: 'in' }),
    ];
    expect(computeProximityPairings(snaps, EPS)).toEqual([{ aId: 'a', bId: 'b' }]);
  });

  it('does not pair snaps on the same owner', () => {
    const snaps = [
      snap('a', 'A', [1, 0, 0], { flow: 'out' }),
      snap('b', 'A', [1, 0, 0], { flow: 'in' }),
    ];
    expect(computeProximityPairings(snaps, EPS)).toEqual([]);
  });

  it('rejects incompatible flow (in ↔ in)', () => {
    const snaps = [
      snap('a', 'A', [1, 0, 0], { flow: 'in' }),
      snap('b', 'B', [1, 0, 0], { flow: 'in' }),
    ];
    expect(computeProximityPairings(snaps, EPS)).toEqual([]);
  });

  it('treats missing flow / bidi as compatible with anything', () => {
    const snaps = [
      snap('a', 'A', [0, 0, 0]),               // undefined → bidi
      snap('b', 'B', [0, 0, 0], { flow: 'in' }),
    ];
    expect(computeProximityPairings(snaps, EPS)).toEqual([{ aId: 'a', bId: 'b' }]);
  });

  it('does not pair across different typeIds', () => {
    const snaps = [
      snap('a', 'A', [0, 0, 0], { typeId: 'conv', flow: 'out' }),
      snap('b', 'B', [0, 0, 0], { typeId: 'pipe', flow: 'in' }),
    ];
    expect(computeProximityPairings(snaps, EPS)).toEqual([]);
  });

  it('does not pair snaps farther apart than epsilon', () => {
    const snaps = [
      snap('a', 'A', [0, 0, 0], { flow: 'out' }),
      snap('b', 'B', [0, 0, 0.01], { flow: 'in' }), // 10 mm > 5 mm eps
    ];
    expect(computeProximityPairings(snaps, EPS)).toEqual([]);
  });

  it('picks the nearest compatible partner', () => {
    const snaps = [
      snap('a', 'A', [0, 0, 0], { flow: 'out' }),
      snap('far', 'B', [0, 0, 0.004], { flow: 'in' }),
      snap('near', 'C', [0, 0, 0.001], { flow: 'in' }),
    ];
    // 'a' should claim 'near' (1 mm) over 'far' (4 mm).
    expect(computeProximityPairings(snaps, EPS)).toEqual([{ aId: 'a', bId: 'near' }]);
  });

  it('pairs each snap at most once', () => {
    // Three coincident, mutually-compatible snaps on distinct owners → one pair.
    const snaps = [
      snap('a', 'A', [0, 0, 0], { flow: 'out' }),
      snap('b', 'B', [0, 0, 0], { flow: 'in' }),
      snap('c', 'C', [0, 0, 0], { flow: 'in' }),
    ];
    const pairs = computeProximityPairings(snaps, EPS);
    expect(pairs).toHaveLength(1);
    const claimed = new Set(pairs.flatMap(p => [p.aId, p.bId]));
    expect(claimed.has('a')).toBe(true);
  });

  it('reconstructs a multi-module chain (A=B=C)', () => {
    // A.out mates B.in; B.out mates C.in — a 3-conveyor line.
    const snaps = [
      snap('a-out', 'A', [0, 0, 0], { flow: 'out' }),
      snap('b-in', 'B', [0, 0, 0], { flow: 'in' }),
      snap('b-out', 'B', [2, 0, 0], { flow: 'out' }),
      snap('c-in', 'C', [2, 0, 0], { flow: 'in' }),
    ];
    const pairs = computeProximityPairings(snaps, EPS);
    expect(pairs).toHaveLength(2);
    const asSet = new Set(pairs.map(p => [p.aId, p.bId].sort().join('|')));
    expect(asSet.has('a-out|b-in')).toBe(true);
    expect(asSet.has('b-out|c-in')).toBe(true);
  });

  it('returns [] for fewer than two snaps', () => {
    expect(computeProximityPairings([], EPS)).toEqual([]);
    expect(computeProximityPairings([snap('a', 'A', [0, 0, 0])], EPS)).toEqual([]);
  });
});
