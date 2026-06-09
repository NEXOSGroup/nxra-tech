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

  // ── Multi-connection placement (loop closure + multi-port) ───────────────
  // These model the production behaviour where a single live placement triggers
  // `_rebuildSnapPairings`, which excludes already-occupied snaps (the one pair
  // the magnetic snap engaged) and pairs every REMAINING coincident end.

  it('loop closure: pairs the second coincident end after the engaged pair is excluded', () => {
    // Closing piece D lands with BOTH ends coincident: D.in on C.out (the engaged
    // pair — already marked occupied, so the rebuild omits it) and D.out on A.in
    // (still free). The rebuild must pair the remaining free end so the loop closes.
    const freeEnds = [
      snap('a-in', 'A', [0, 0, 0], { flow: 'in' }),
      snap('d-out', 'D', [0, 0, 0], { flow: 'out' }),
    ];
    expect(computeProximityPairings(freeEnds, EPS)).toEqual([{ aId: 'a-in', bId: 'd-out' }]);
  });

  it('multi-port hub: pairs all coincident ports of a 4-way turntable in one pass', () => {
    // A turntable T with N/E/S/W ports, each coincident with a distinct neighbour.
    const snaps = [
      snap('t-n', 'T', [0, 0, 1], { flow: 'bidi' }),
      snap('t-e', 'T', [1, 0, 0], { flow: 'bidi' }),
      snap('t-s', 'T', [0, 0, -1], { flow: 'bidi' }),
      snap('t-w', 'T', [-1, 0, 0], { flow: 'bidi' }),
      snap('n-in', 'N', [0, 0, 1], { flow: 'in' }),
      snap('e-in', 'E', [1, 0, 0], { flow: 'in' }),
      snap('s-out', 'S', [0, 0, -1], { flow: 'out' }),
      snap('w-out', 'W', [-1, 0, 0], { flow: 'out' }),
    ];
    const pairs = computeProximityPairings(snaps, EPS);
    expect(pairs).toHaveLength(4);
    const asSet = new Set(pairs.map(p => [p.aId, p.bId].sort().join('|')));
    expect(asSet.has('n-in|t-n')).toBe(true);
    expect(asSet.has('e-in|t-e')).toBe(true);
    expect(asSet.has('s-out|t-s')).toBe(true);
    expect(asSet.has('t-w|w-out')).toBe(true);
  });

  it('never resurfaces an excluded (occupied) engaged snap', () => {
    // Production filters `sp.occupied` BEFORE calling this; the engaged ids must
    // never appear in the output (only the free coincident ends pair).
    const freeEnds = [
      snap('a-in', 'A', [0, 0, 0], { flow: 'in' }),
      snap('d-out', 'D', [0, 0, 0], { flow: 'out' }),
    ];
    const ids = new Set(computeProximityPairings(freeEnds, EPS).flatMap(p => [p.aId, p.bId]));
    expect(ids.has('c-out')).toBe(false); // engaged (occupied) — excluded upstream
    expect(ids.has('d-in')).toBe(false);  // engaged (occupied) — excluded upstream
    expect(ids.has('a-in')).toBe(true);
    expect(ids.has('d-out')).toBe(true);
  });
});
