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
import { findTransport } from '../../core/library-component-loader';

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
const _ownerPos = new Vector3();
const _toMating = new Vector3();

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
    const transportNode = compReg ? findTransport(ownerRoot) : null;
    const surface = transportNode
      ? compReg!.findInChildren<TransportSurfaceLike>(transportNode, 'TransportSurface')
      : null;
    if (surface) {
      surface.getWorldDirection(_dir);
      // Mating point ≈ the conveyor-side snap's world position; reference vector
      // points from the conveyor body toward that connection (i.e. toward us).
      partner.object3D.getWorldPosition(_matingPos);
      ownerRoot.getWorldPosition(_ownerPos);
      _toMating.copy(_matingPos).sub(_ownerPos);
      const proj = _dir.dot(_toMating);
      if (Math.abs(proj) > 1e-4) role = proj > 0 ? 'input' : 'output';
    }

    out.push({ role, ownerRoot, snap: sp, pairedSnap: partner });
  }
  return out;
}
