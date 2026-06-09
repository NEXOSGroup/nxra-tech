// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3 } from 'three';
import {
  findOutputPairings,
  findDownstreamRoot,
  findInputSnapNode,
  classifyConnections,
  type SnapLite,
} from '../src/behaviors/_shared/snap-graph-helpers';

function makeHost(snaps: SnapLite[], registry?: unknown) {
  const byOwner = new Map<Object3D, SnapLite[]>();
  for (const s of snaps) {
    const list = byOwner.get(s.ownerRoot) ?? [];
    list.push(s);
    byOwner.set(s.ownerRoot, list);
  }
  const byId = new Map(snaps.map(s => [s.id, s]));
  return {
    registry,
    getPlugin(id: string) {
      if (id !== 'snap-point') return undefined;
      return {
        getRegistry: () => ({
          getByOwnerRoot: (r: Object3D) => byOwner.get(r) ?? [],
          getById: (id: string) => byId.get(id),
        }),
      };
    },
  };
}

function snap(opts: Partial<SnapLite> & { id: string; ownerRoot: Object3D; flow: 'in' | 'out' | 'bidi' }): SnapLite {
  return { object3D: new Object3D(), ...opts };
}

describe('findOutputPairings', () => {
  it('returns every paired out-flow snap with its partner owner', () => {
    const A = new Object3D(); A.name = 'A';
    const B = new Object3D(); B.name = 'B';
    const C = new Object3D(); C.name = 'C';
    const host = makeHost([
      snap({ id: 'a-out1', ownerRoot: A, flow: 'out', pairedSnapId: 'b-in' }),
      snap({ id: 'a-out2', ownerRoot: A, flow: 'out', pairedSnapId: 'c-in' }),
      snap({ id: 'a-out3', ownerRoot: A, flow: 'out' }),  // unpaired — filtered
      snap({ id: 'b-in',   ownerRoot: B, flow: 'in',  pairedSnapId: 'a-out1' }),
      snap({ id: 'c-in',   ownerRoot: C, flow: 'in',  pairedSnapId: 'a-out2' }),
    ]);
    const pairings = findOutputPairings(host, A);
    const owners = pairings.map(p => p.ownerRoot).sort();
    expect(owners).toEqual([B, C].sort());
  });

  it('ignores flow:"in" and flow:"bidi" — only out-flow paired snaps', () => {
    const A = new Object3D(); const B = new Object3D();
    const host = makeHost([
      snap({ id: 'a-in',   ownerRoot: A, flow: 'in',   pairedSnapId: 'b' }),
      snap({ id: 'a-bidi', ownerRoot: A, flow: 'bidi', pairedSnapId: 'b' }),
      snap({ id: 'b',      ownerRoot: B, flow: 'out',  pairedSnapId: 'a-in' }),
    ]);
    expect(findOutputPairings(host, A)).toEqual([]);
  });

  it('ignores self-loops where the paired partner is on the same root', () => {
    const A = new Object3D();
    const host = makeHost([
      snap({ id: 's1', ownerRoot: A, flow: 'out', pairedSnapId: 's2' }),
      snap({ id: 's2', ownerRoot: A, flow: 'in',  pairedSnapId: 's1' }),
    ]);
    expect(findOutputPairings(host, A)).toEqual([]);
  });

  it('returns [] when the snap-point plugin is absent', () => {
    const A = new Object3D();
    expect(findOutputPairings({ getPlugin: () => undefined }, A)).toEqual([]);
  });
});

describe('findDownstreamRoot (single-output convenience)', () => {
  it('returns the first paired output owner', () => {
    const A = new Object3D(); const B = new Object3D(); const C = new Object3D();
    const host = makeHost([
      snap({ id: 'a-out1', ownerRoot: A, flow: 'out', pairedSnapId: 'b-in' }),
      snap({ id: 'a-out2', ownerRoot: A, flow: 'out', pairedSnapId: 'c-in' }),
      snap({ id: 'b-in', ownerRoot: B, flow: 'in', pairedSnapId: 'a-out1' }),
      snap({ id: 'c-in', ownerRoot: C, flow: 'in', pairedSnapId: 'a-out2' }),
    ]);
    const ds = findDownstreamRoot(host, A);
    expect(ds === B || ds === C).toBe(true);   // either first-iterated owner; both are valid "first"
  });

  it('returns null when no paired out-flow snap exists', () => {
    const A = new Object3D();
    const host = makeHost([snap({ id: 'a-in', ownerRoot: A, flow: 'in' })]);
    expect(findDownstreamRoot(host, A)).toBeNull();
  });
});

describe('findInputSnapNode', () => {
  it('returns the Object3D of the first in-flow snap on root', () => {
    const A = new Object3D();
    const inNode = new Object3D(); inNode.name = 'Snap-XN-x';
    const host = makeHost([
      snap({ id: 'a-out', ownerRoot: A, flow: 'out' }),
      snap({ id: 'a-in',  ownerRoot: A, flow: 'in', object3D: inNode }),
    ]);
    expect(findInputSnapNode(host, A)).toBe(inNode);
  });

  it('returns null when no in-flow snap exists', () => {
    const A = new Object3D();
    const host = makeHost([snap({ id: 'a-out', ownerRoot: A, flow: 'out' })]);
    expect(findInputSnapNode(host, A)).toBeNull();
  });
});

describe('classifyConnections — role by connected transport direction', () => {
  /** Build a connected conveyor owner carrying a Transport-Z node + a fake surface. */
  function conveyorWith(worldDir: Vector3) {
    const owner = new Object3D();
    const transport = new Object3D(); transport.name = 'Transport-Z'; owner.add(transport);
    const surface = { getWorldDirection: (out: Vector3 = new Vector3()) => out.copy(worldDir) };
    const registry = {
      findInChildren: (node: Object3D, type: string) =>
        (node === transport && type === 'TransportSurface') ? surface : null,
    };
    return { owner, registry };
  }

  // The role is decided relative to the TURNTABLE CENTRE (the `root` arg), not
  // the connected conveyor's origin — so the conveyor body position is irrelevant
  // (left at the world origin here). Only the mating point + belt direction matter.
  it('a conveyor moving goods TOWARD the turntable is an input', () => {
    const TT = new Object3D(); TT.name = 'TT';                          // turntable at the world origin
    const { owner: CV, registry } = conveyorWith(new Vector3(0, 0, 1)); // belt runs +Z toward the table
    const ttNode = new Object3D(); ttNode.position.set(0, 0, -1);
    const cvNode = new Object3D(); cvNode.position.set(0, 0, -1);       // mating point SOUTH of the table
    const host = makeHost([
      { id: 'tt', object3D: ttNode, flow: 'bidi', pairedSnapId: 'cv', ownerRoot: TT },
      { id: 'cv', object3D: cvNode, flow: 'bidi', pairedSnapId: 'tt', ownerRoot: CV },
    ], registry);
    const conns = classifyConnections(host, TT);
    expect(conns).toHaveLength(1);
    expect(conns[0].role).toBe('input');
    expect(conns[0].ownerRoot).toBe(CV);
  });

  it('a conveyor moving goods AWAY from the turntable is an output', () => {
    const TT = new Object3D(); TT.name = 'TT';                          // turntable at the world origin
    const { owner: CV, registry } = conveyorWith(new Vector3(0, 0, 1)); // belt runs +Z away from the table
    const ttNode = new Object3D(); ttNode.position.set(0, 0, 1);
    const cvNode = new Object3D(); cvNode.position.set(0, 0, 1);        // mating point NORTH of the table
    const host = makeHost([
      { id: 'tt', object3D: ttNode, flow: 'bidi', pairedSnapId: 'cv', ownerRoot: TT },
      { id: 'cv', object3D: cvNode, flow: 'bidi', pairedSnapId: 'tt', ownerRoot: CV },
    ], registry);
    const conns = classifyConnections(host, TT);
    expect(conns).toHaveLength(1);
    expect(conns[0].role).toBe('output');
  });

  it('falls back to authored flow when no component registry / surface is available', () => {
    const TT = new Object3D(); TT.name = 'TT';
    const IN = new Object3D(); const OUT = new Object3D();
    const host = makeHost([   // no `registry` passed → no direction info
      { id: 'tt-in',  object3D: new Object3D(), flow: 'in',  pairedSnapId: 'p-in',  ownerRoot: TT },
      { id: 'p-in',   object3D: new Object3D(), flow: 'out', pairedSnapId: 'tt-in', ownerRoot: IN },
      { id: 'tt-out', object3D: new Object3D(), flow: 'out', pairedSnapId: 'p-out', ownerRoot: TT },
      { id: 'p-out',  object3D: new Object3D(), flow: 'in',  pairedSnapId: 'tt-out', ownerRoot: OUT },
    ]);
    const conns = classifyConnections(host, TT);
    const byOwner = new Map(conns.map(c => [c.ownerRoot, c.role]));
    expect(byOwner.get(IN)).toBe('input');
    expect(byOwner.get(OUT)).toBe('output');
  });

  it('skips unpaired snaps', () => {
    const TT = new Object3D();
    const host = makeHost([{ id: 'tt', object3D: new Object3D(), flow: 'bidi', ownerRoot: TT }]);
    expect(classifyConnections(host, TT)).toEqual([]);
  });
});
