// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Snap-graph helpers shared between behaviors that need to know about their
 * paired outputs (Conveyor → first/only out; Turntable → all outs, picks
 * one to dispatch).
 *
 * The host shape is loose so these are testable without a real RVViewer:
 * just `getPlugin('snap-point') → { getRegistry() → { getByOwnerRoot, getById } }`.
 */

import { Vector3 } from 'three';
import type { Object3D } from 'three';
import type { SnapPointPlugin } from '../../plugins/snap-point';
import { findAll, NODE_KIND_TESTS } from '../../core/library-component-loader';

export interface SnapLite {
  readonly id: string;
  readonly object3D: Object3D;
  readonly flow?: 'in' | 'out' | 'bidi';
  readonly pairedSnapId?: string;
  readonly ownerRoot: Object3D;
}

export interface OutputPairing {
  /** The downstream LayoutObject root paired through `snap`. */
  ownerRoot: Object3D;
  /** This conveyor/turntable's out-flow snap. */
  snap: SnapLite;
  /** The matched downstream snap. */
  pairedSnap: SnapLite;
}

/**
 * A turntable port connection classified by the DIRECTION of the connected
 * conveyor's transport: a conveyor that moves goods toward the turntable is an
 * `input`; one that moves them away is an `output`. Independent of the snap's
 * authored `flow` (works with bidirectional `Snap-?B-*` ports).
 */
export interface PortConnection {
  role: 'input' | 'output';
  /** The connected (conveyor) LayoutObject root. */
  ownerRoot: Object3D;
  /** This turntable's port snap (its `object3D` feeds the angle math). */
  snap: SnapLite;
  /** The matched conveyor-side snap. */
  pairedSnap: SnapLite;
}

interface SnapHost {
  getPlugin?(id: string): unknown;
}

/** Minimal slice of the node registry needed to resolve a connected belt's surface. */
interface ComponentRegistryShape {
  findInChildren<T = unknown>(node: Object3D, type: string): T | null;
}

/** Structural type for the bit of RVTransportSurface we read (avoids an import cycle). */
interface TransportSurfaceLike {
  getWorldDirection(out?: Vector3): Vector3;
}

interface ClassifyHost extends SnapHost {
  registry?: unknown;
}

interface SnapRegistryShape {
  getByOwnerRoot(r: Object3D): readonly SnapLite[];
  getById(id: string): SnapLite | undefined;
}

function getRegistry(host: SnapHost): SnapRegistryShape | null {
  const plugin = host.getPlugin?.('snap-point') as SnapPointPlugin | undefined;
  const reg = plugin?.getRegistry?.();
  return (reg as unknown as SnapRegistryShape | undefined) ?? null;
}

/**
 * All snaps registered on `root` (paired or not). Empty when the snap-point
 * plugin isn't available yet (e.g. before the scene scan, or in minimal tests).
 */
export function listOwnSnaps(host: SnapHost, root: Object3D): SnapLite[] {
  const reg = getRegistry(host);
  return reg ? [...reg.getByOwnerRoot(root)] : [];
}

/**
 * Every paired output snap on `root`: for each `flow === 'out'` snap with a
 * `pairedSnapId`, resolve its partner and the partner's owner. Self-loops and
 * unpaired/missing partners are filtered out.
 */
export function findOutputPairings(host: SnapHost, root: Object3D): OutputPairing[] {
  const reg = getRegistry(host);
  if (!reg) return [];
  const out: OutputPairing[] = [];
  for (const sp of reg.getByOwnerRoot(root)) {
    if (sp.flow !== 'out' || !sp.pairedSnapId) continue;
    const partner = reg.getById(sp.pairedSnapId);
    if (!partner || partner.ownerRoot === root) continue;
    out.push({ ownerRoot: partner.ownerRoot, snap: sp, pairedSnap: partner });
  }
  return out;
}

/**
 * First paired-output owner — the single-successor convenience used by
 * Conveyor. Returns null when no paired out-flow snap exists.
 */
export function findDownstreamRoot(host: SnapHost, root: Object3D): Object3D | null {
  const all = findOutputPairings(host, root);
  return all.length > 0 ? all[0].ownerRoot : null;
}

/**
 * First (or only) input snap node on `root`: any `flow === 'in'` snap.
 * Returns the underlying Object3D for angle-math computations (its local
 * position relative to `root` defines the input direction). null if absent.
 */
export function findInputSnapNode(host: SnapHost, root: Object3D): Object3D | null {
  const reg = getRegistry(host);
  if (!reg) return null;
  for (const sp of reg.getByOwnerRoot(root)) {
    if (sp.flow === 'in') return sp.object3D;
  }
  return null;
}

/** Read the component registry off the host (RVViewer), or null in tests/minimal hosts. */
function getComponentRegistry(host: ClassifyHost): ComponentRegistryShape | null {
  const reg = host.registry as Partial<ComponentRegistryShape> | undefined | null;
  return reg && typeof reg.findInChildren === 'function'
    ? (reg as ComponentRegistryShape)
    : null;
}

// Scratch vectors — module-local, never escape this file.
const _dir = new Vector3();
const _matingPos = new Vector3();
const _tableCentre = new Vector3();
const _toCentre = new Vector3();

/** Map an authored flow to a role for the ambiguous/near-perpendicular fallback. */
function roleFromFlow(flow: SnapLite['flow']): 'input' | 'output' {
  return flow === 'in' ? 'input' : 'output';
}

/**
 * Classify every PAIRED snap on `root` as an input or output port, based on the
 * direction the connected conveyor transports goods relative to this turntable.
 *
 * For each paired snap we resolve the partner conveyor, read its belt's world
 * transport direction (`RVTransportSurface.getWorldDirection`), and compare it to
 * the vector pointing from the conveyor toward the mating point:
 *   - moving TOWARD the turntable  → goods exit the conveyor here → `input`
 *   - moving AWAY from the turntable → `output`
 * When the registry/surface is unavailable or the projection is ~0 we fall back
 * to the snap's authored `flow` (so it degrades to the legacy behaviour).
 */
export function classifyConnections(host: ClassifyHost, root: Object3D): PortConnection[] {
  const reg = getRegistry(host);
  if (!reg) return [];
  const compReg = getComponentRegistry(host);
  const out: PortConnection[] = [];

  for (const sp of reg.getByOwnerRoot(root)) {
    if (!sp.pairedSnapId) continue;
    const partner = reg.getById(sp.pairedSnapId);
    if (!partner || partner.ownerRoot === root) continue;
    const ownerRoot = partner.ownerRoot;

    let role: 'input' | 'output' = roleFromFlow(sp.flow);

    // Try to refine from the connected conveyor's transport direction.
    // Reference vector: from the mating connection point toward the TURNTABLE
    // CENTRE (`root`). A belt moving toward the centre feeds the table (input);
    // one moving away discharges from it (output). Using the turntable centre —
    // NOT the connected conveyor's root origin — keeps the sign correct for
    // conveyors with an off-centre pivot (origin at the discharge end), a common
    // library-asset case that otherwise flipped the classification.
    if (compReg) {
      partner.object3D.getWorldPosition(_matingPos);
      root.getWorldPosition(_tableCentre);
      _toCentre.copy(_tableCentre).sub(_matingPos);

      // A partner may carry SEVERAL transport surfaces (e.g. a ChainTransfer has
      // both a straight roller line and a perpendicular cross chain). Picking the
      // first one found would read a surface that is ~perpendicular to this
      // connection (projection ≈ 0) and silently fall back to the authored flow —
      // which for a forced-bidi turntable port resolves to 'output', so the table
      // never recognises the upstream and the handover stalls. Evaluate ALL of the
      // partner's transport surfaces and keep the one most aligned with the
      // connection axis (largest |projection|). Single-surface partners are
      // unaffected — the result is identical to the first-match behaviour.
      let bestProj = 0;
      let bestAbs = 1e-4;
      for (const tNode of findAll(ownerRoot, NODE_KIND_TESTS.transport)) {
        const surface = compReg.findInChildren<TransportSurfaceLike>(tNode, 'TransportSurface');
        if (!surface) continue;
        surface.getWorldDirection(_dir);
        const proj = _dir.dot(_toCentre);
        const abs = Math.abs(proj);
        if (abs > bestAbs) { bestAbs = abs; bestProj = proj; }
      }
      if (bestProj !== 0) role = bestProj > 0 ? 'input' : 'output';
    }

    out.push({ role, ownerRoot, snap: sp, pairedSnap: partner });
  }
  return out;
}
