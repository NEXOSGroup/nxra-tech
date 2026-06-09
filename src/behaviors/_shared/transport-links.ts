// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Transport-link helpers — encapsulate a transport asset's snap connections and
 * the Occupied-interlock signal convention (per-port `@<id>`, else root).
 *
 * Behaviors never build signal names by hand again: they ask a `TransportLink`
 * for `occupied()` / `upstreamWaiting()` / `setOccupied()`. Under the hood
 * everything stays signal-backed (Standalone/Live/Direct).
 *
 * Separation of concerns: this module is topology + signal-name ADDRESSING of
 * the interlock. Occupancy DETECTION (is a good physically on the belt) lives in
 * `_shared/surface-occupancy.ts`; the surface-based PUBLICATION of
 * `Conveyor.Occupied` stays in the behavior, not here.
 */
import type { Object3D } from 'three';
import type { RVBindContext, SignalOpts } from '../../core/behavior-runtime';
import { findOutputPairings, listOwnSnaps, type OutputPairing, type PortConnection } from './snap-graph-helpers';

const OCCUPIED = 'Conveyor.Occupied';

export interface TransportLink {
  /** Stable snap id on my side (Object3D.uuid). */
  readonly mySnapId: string;
  /** Stable snap id on the partner side (== Plan-194 Port.id). */
  readonly partnerSnapId: string;
  /** Partner LayoutObject root. */
  readonly partnerRoot: Object3D;
  /** Forward-compat to Plan-194 Port: the partner's MaterialFlowInstance.
   *  Always null today (signal path); Plan 194 fills it for the DES handshake. */
  readonly partnerComponent: unknown | null;

  /** true = downstream cannot accept: partner per-port Occupied (key = partnerSnapId),
   *  else its root Occupied, is explicitly true. */
  occupied(): boolean;
  /** true = a part waits on the connected upstream side (its root Occupied === true). */
  upstreamWaiting(): boolean;
  /** Publishes my per-port Occupied for exactly this connection (key = mySnapId). */
  setOccupied(v: boolean): void;
}

function makeLink(rv: RVBindContext, mySnapId: string, partnerSnapId: string, partnerRoot: Object3D): TransportLink {
  const partnerRootSig = `/${partnerRoot.name}/${OCCUPIED}`;
  return {
    mySnapId, partnerSnapId, partnerRoot,
    partnerComponent: null,    // Plan 194 fills this for the DES handshake
    occupied() {
      const perPort = `${partnerRootSig}@${partnerSnapId}`;
      const name = rv.signals.get(perPort) !== undefined ? perPort : partnerRootSig;
      return rv.signals.get<boolean>(name) === true;
    },
    upstreamWaiting() {
      return rv.signals.get<boolean>(partnerRootSig) === true;
    },
    setOccupied(v: boolean) {
      rv.signals.set(`${OCCUPIED}@${mySnapId}`, v);
    },
  };
}

/** All downstream connections (flow 'out'), fresh from the snap graph. */
export function outputLinks(rv: RVBindContext): TransportLink[] {
  return findOutputPairings(rv.viewer, rv.root).map((p: OutputPairing) =>
    makeLink(rv, p.snap.id, p.pairedSnap.id, p.ownerRoot));
}

/** The single downstream connection (Conveyor convenience). null at end of line. */
export function outputLink(rv: RVBindContext): TransportLink | null {
  return outputLinks(rv)[0] ?? null;
}

/** Link from a direction-classified turntable port connection. */
export function linkOf(rv: RVBindContext, conn: PortConnection): TransportLink {
  return makeLink(rv, conn.snap.id, conn.pairedSnap.id, conn.ownerRoot);
}

/** Stable snap ids of ALL own ports (paired and unpaired) — mirror of
 *  listOwnSnaps, for the turntable's initial up-front per-port block. */
export function portIds(rv: RVBindContext): string[] {
  return listOwnSnaps(rv.viewer, rv.root).map(s => s.id);
}

/** A `signal`-declarer (subset of rv / self): registers one signal by name. */
type SignalDeclarer = (name: string, opts: SignalOpts) => void;

/** Registers the public 4-signal contract via any declarer (rv.signal or self.signal). */
export function declareConveyorSignalsWith(signal: SignalDeclarer): void {
  signal('Conveyor.Run',       { type: 'PLCInputBool',  initialValue: true });
  signal('Conveyor.Occupied',  { type: 'PLCOutputBool', initialValue: false });
  signal('Conveyor.Running',   { type: 'PLCOutputBool', initialValue: false });
  signal('Conveyor.PartCount', { type: 'PLCOutputInt',  initialValue: 0 });
}

/** Registers the public 4-signal contract (instance-scoped). */
export function declareConveyorSignals(rv: RVBindContext): void {
  declareConveyorSignalsWith((n, o) => rv.signal(n, o));
}

/** Minimal interlock host — satisfied by both `rv` and the material-flow `self`. */
export interface InterlockHost {
  readonly viewer: unknown;
  readonly root: Object3D;
  readonly signals: { get<T = unknown>(name: string): T };
}

/**
 * Allocation-free downstream interlock for the hot path (Conveyor).
 * Build once in setup(); occupied() scans the snap registry INLINE (no .map,
 * no link objects) and only reads signals → no per-tick allocation.
 */
export function createDownstreamInterlock(rv: InterlockHost): { occupied(): boolean } {
  return {
    occupied(): boolean {
      // Inline scan instead of findOutputPairings().map(): take the first out
      // pairing, read per-port-then-root; no successor → blocked.
      const pairing = findOutputPairings(rv.viewer as { getPlugin?(id: string): unknown }, rv.root)[0];   // small/no alloc; 1-4 snaps
      if (!pairing) return true;
      const rootSig = `/${pairing.ownerRoot.name}/${OCCUPIED}`;
      const perPort = `${rootSig}@${pairing.pairedSnap.id}`;
      const name = rv.signals.get(perPort) !== undefined ? perPort : rootSig;
      return rv.signals.get<boolean>(name) === true;
    },
  };
}
