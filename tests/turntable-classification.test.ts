// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * classifyConnections — port input/output classification from the connected
 * conveyor's belt direction.
 *
 * Regression guard for the "complex layouts break" bug: the role must be decided
 * relative to the TURNTABLE CENTRE, not the connected conveyor's root origin.
 * Library conveyors often have an off-centre pivot (origin at the discharge end),
 * which made the old origin-based reference vector flip sign and misclassify the
 * port — a misclassified port cascades into the turntable trying to receive from a
 * downstream belt or dispatch toward an infeed.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { classifyConnections, type SnapLite } from '../src/behaviors/_shared/snap-graph-helpers';

interface SurfaceMock { getWorldDirection(out?: Vector3): Vector3; }

/**
 * Build a turntable at the world origin with two paired ports:
 *   - one connected conveyor whose belt moves TOWARD the table  → expect 'input'
 *   - one connected conveyor whose belt moves AWAY from the table → expect 'output'
 * BOTH conveyors are given an off-centre origin (pivot at the discharge end,
 * between the mating snap and the table) that fools an origin-based reference.
 */
function setupClassificationScene() {
  const ttRoot = new Object3D(); ttRoot.name = 'Turntable'; ttRoot.position.set(0, 0, 0);

  // The two turntable-side port snaps (positions irrelevant to classification).
  const inPort = new Object3D(); inPort.name = 'Snap-ZB-In'; ttRoot.add(inPort);
  const outPort = new Object3D(); outPort.name = 'Snap-ZB-Out'; ttRoot.add(outPort);

  // ── INPUT conveyor: belt moves +Z toward the table (table is north at origin). ──
  const inConv = new Object3D(); inConv.name = 'Infeed'; inConv.position.set(0, 0, -0.5); // off-centre origin
  const inTransport = new Object3D(); inTransport.name = 'Transport-Z'; inConv.add(inTransport);
  const inMating = new Object3D(); inMating.name = 'Snap-ZP'; inMating.position.set(0, 0, -1); // south edge of table
  const inBeltDir = new Vector3(0, 0, 1);

  // ── OUTPUT conveyor: belt moves +Z away from the table (conveyor is north of it). ──
  const outConv = new Object3D(); outConv.name = 'Outfeed'; outConv.position.set(0, 0, 0.5); // off-centre origin
  const outTransport = new Object3D(); outTransport.name = 'Transport-Z'; outConv.add(outTransport);
  const outMating = new Object3D(); outMating.name = 'Snap-ZN'; outMating.position.set(0, 0, 1); // north edge of table
  const outBeltDir = new Vector3(0, 0, 1);

  const snaps: SnapLite[] = [
    { id: 'tt-a', object3D: inPort,  flow: 'bidi', pairedSnapId: 'in-out',  ownerRoot: ttRoot },
    { id: 'tt-b', object3D: outPort, flow: 'bidi', pairedSnapId: 'out-in',  ownerRoot: ttRoot },
    { id: 'in-out',  object3D: inMating,  flow: 'out', pairedSnapId: 'tt-a', ownerRoot: inConv },
    { id: 'out-in',  object3D: outMating, flow: 'in',  pairedSnapId: 'tt-b', ownerRoot: outConv },
  ];
  const byId = new Map(snaps.map(s => [s.id, s]));
  const byOwner = new Map<Object3D, SnapLite[]>();
  for (const s of snaps) { const l = byOwner.get(s.ownerRoot) ?? []; l.push(s); byOwner.set(s.ownerRoot, l); }

  const surfaceByTransport = new Map<Object3D, SurfaceMock>([
    [inTransport,  { getWorldDirection: (out = new Vector3()) => out.copy(inBeltDir) }],
    [outTransport, { getWorldDirection: (out = new Vector3()) => out.copy(outBeltDir) }],
  ]);

  const host = {
    getPlugin: (id: string) => id === 'snap-point' ? {
      getRegistry: () => ({
        getByOwnerRoot: (r: Object3D) => byOwner.get(r) ?? [],
        getById: (id: string) => byId.get(id),
      }),
    } : undefined,
    registry: {
      // Mirrors NodeRegistry.findInChildren: resolve the TransportSurface under a node.
      findInChildren: <T,>(node: Object3D, type: string): T | null => {
        if (type !== 'TransportSurface') return null;
        let found: SurfaceMock | null = null;
        node.traverse((n) => { if (!found && surfaceByTransport.has(n)) found = surfaceByTransport.get(n)!; });
        return found as unknown as T | null;
      },
    },
  };

  return { host, ttRoot };
}

describe('classifyConnections — direction relative to the turntable centre', () => {
  it('classifies an off-centre-origin infeed as input and outfeed as output', () => {
    const { host, ttRoot } = setupClassificationScene();
    const conns = classifyConnections(host, ttRoot);

    const roleOf = (snapId: string) => conns.find(c => c.snap.id === snapId)?.role;
    expect(roleOf('tt-a')).toBe('input');   // belt moves toward the table
    expect(roleOf('tt-b')).toBe('output');  // belt moves away from the table
  });
});

/**
 * Build a turntable at the origin fed (in +Z) by a ChainTransfer upstream. A
 * ChainTransfer carries TWO transport surfaces: a perpendicular cross chain
 * (Transport-X) AND the straight roller line (Transport-Z) aligned with the
 * handover. The X node is added FIRST so a first-match lookup (mirroring
 * findTransport's traversal) returns the perpendicular surface — whose ~0
 * projection used to fall back to the turntable port's forced-bidi flow and
 * misclassify the upstream as an 'output', stalling the handover.
 */
function setupChainTransferUpstreamScene() {
  const ttRoot = new Object3D(); ttRoot.name = 'Turntable'; ttRoot.position.set(0, 0, 0);

  // Turntable-side bidi port (all turntable ports are forced bidi).
  const inPort = new Object3D(); inPort.name = 'Snap-ZB-In'; ttRoot.add(inPort);

  // Upstream ChainTransfer: roller line feeds +Z toward the table; cross chain is X.
  const ct = new Object3D(); ct.name = 'ChainTransfer'; ct.position.set(0, 0, -0.5);
  const ctX = new Object3D(); ctX.name = 'Transport-X'; ct.add(ctX); // perpendicular — added FIRST
  const ctZ = new Object3D(); ctZ.name = 'Transport-Z'; ct.add(ctZ); // aligned with the handover
  const ctMating = new Object3D(); ctMating.name = 'Snap-ZP-convroll'; ctMating.position.set(0, 0, -1);
  const xDir = new Vector3(1, 0, 0); // cross chain — perpendicular to the centre vector
  const zDir = new Vector3(0, 0, 1); // roller line — +Z, toward the table

  const snaps: SnapLite[] = [
    { id: 'tt-in', object3D: inPort,   flow: 'bidi', pairedSnapId: 'ct-out', ownerRoot: ttRoot },
    { id: 'ct-out', object3D: ctMating, flow: 'out',  pairedSnapId: 'tt-in', ownerRoot: ct },
  ];
  const byId = new Map(snaps.map(s => [s.id, s]));
  const byOwner = new Map<Object3D, SnapLite[]>();
  for (const s of snaps) { const l = byOwner.get(s.ownerRoot) ?? []; l.push(s); byOwner.set(s.ownerRoot, l); }

  const surfaceByTransport = new Map<Object3D, SurfaceMock>([
    [ctX, { getWorldDirection: (out = new Vector3()) => out.copy(xDir) }],
    [ctZ, { getWorldDirection: (out = new Vector3()) => out.copy(zDir) }],
  ]);

  const host = {
    getPlugin: (id: string) => id === 'snap-point' ? {
      getRegistry: () => ({
        getByOwnerRoot: (r: Object3D) => byOwner.get(r) ?? [],
        getById: (id: string) => byId.get(id),
      }),
    } : undefined,
    registry: {
      findInChildren: <T,>(node: Object3D, type: string): T | null => {
        if (type !== 'TransportSurface') return null;
        let found: SurfaceMock | null = null;
        node.traverse((n) => { if (!found && surfaceByTransport.has(n)) found = surfaceByTransport.get(n)!; });
        return found as unknown as T | null;
      },
    },
  };

  return { host, ttRoot };
}

describe('classifyConnections — multi-transport upstream (ChainTransfer → Turntable)', () => {
  it('classifies a ChainTransfer feeding in +Z as input despite its perpendicular cross chain', () => {
    const { host, ttRoot } = setupChainTransferUpstreamScene();
    const conns = classifyConnections(host, ttRoot);

    const roleOf = (snapId: string) => conns.find(c => c.snap.id === snapId)?.role;
    // Must pick the aligned roller surface (Transport-Z), not the first-found X.
    expect(roleOf('tt-in')).toBe('input');
  });
});
