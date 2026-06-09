// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * material-flow-self.ts — the shared `self` context (Plan 194 §2.3).
 *
 * `MaterialFlowSelf` is the single mutable surface that all three layers of a
 * `defineMaterialFlow` definition (`logic` / `continuous` / `des`) talk to. It
 * is a thin PROJECTION over the existing `RVBindContext` (behavior-runtime.ts):
 * signals/drive/find/contextMenu/onFixedUpdate forward straight through, so the
 * continuous path keeps zero behavior change, while ports/state/transfer/prop
 * add the mode-agnostic material-flow surface on top.
 *
 * `Port` extends Plan-196's `TransportLink` (transport-links.ts): `port.id`
 * equals `TransportLink.partnerSnapId` equals the partner snap's id, and
 * `port.ownerComponent` fills Plan-196's reserved `partnerComponent` slot for
 * the DES object-handshake. Topology comes from `resolvePorts()` (topology
 * resolver below): snap-graph primary via `classifyConnections`/
 * `findOutputPairings`; autoConnect fallback is a documented stub for now.
 *
 * `self.in` / `self.at` are DES-only scheduling. In continuous mode they
 * dev-throw (caught early in tests) so a continuous block that accidentally
 * schedules an event fails loudly instead of silently no-op'ing.
 */

import type { Object3D } from 'three';
import type { ContextMenuItem } from '../hmi/context-menu-store';
import type {
  RVBindContext,
  BindContextDrive,
  NodeRef,
  SignalOpts,
} from '../behavior-runtime';
import type { TransportLink } from '../../behaviors/_shared/transport-links';
import { createDownstreamInterlock } from '../../behaviors/_shared/transport-links';
import {
  classifyConnections,
  findOutputPairings,
  type PortConnection,
  type OutputPairing,
} from '../../behaviors/_shared/snap-graph-helpers';

// ─── Public value types ─────────────────────────────────────────────────

/** JSON-serializable value (matches the DES `prop` bag — snapshot-safe). */
export type JsonValue =
  | string | number | boolean | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type MaterialFlowKind =
  | 'conveyor' | 'router' | 'station' | 'source' | 'sink' | 'storage' | 'downtime';

export type SimulationMode = 'continuous' | 'des';

/**
 * Drive facade exposed to a material-flow definition — identical surface to
 * `BindContextDrive` plus a continuous-friendly `currentSpeed` alias and a
 * `setTo(target, progress)` used by the (later) Tween-Registry.
 */
export interface SelfDrive extends BindContextDrive {
  /** Live speed in mm/s or deg/s (alias of the running drive speed). */
  readonly currentSpeed?: number;
  /** Interpolated set — `progress` in [0,1] from `from` to `to`. Tween-Registry use (P5). */
  setTo?(target: number, progress: number): void;
}

/**
 * A movable unit as seen by the material-flow layers. Kept structural and
 * minimal so the public core never has to import the private DES `DESMU`.
 * The DES runner passes its richer `DESMU` (which is assignable to this).
 */
export interface MU {
  readonly id: number;
  /** The visual moving-unit (RVMovingUnit) — null until/unless rendered. */
  visual?: unknown;
  /** Per-MU snapshot-safe custom state. */
  prop?: Record<string, JsonValue>;
}

/** Hook name as authored in a `des` block (e.g. 'Arrival', 'RotateComplete'). */
export type DesHookName = string;

/**
 * A tween descriptor a `des` block may attach to a DURATION event so the
 * (private) DESRunner animates the effect over the scheduled interval (Plan 194
 * §3.1). It is pure DATA — the public side never touches the tween registry; it
 * only describes the interpolation, and the private scheduler registers it on
 * its `TweenRegistry` (keyed by the event's t0 / duration). Both flavours map
 * onto `TweenRegistry.addPosition` / `addDrive`.
 *
 * Pass it as the `data` argument of `self.in(delay, hook, mu, { tween })` (the
 * scheduler reads `data.tween`); in continuous/mock mode (no scheduler) it is
 * inert because `self.in` itself is a dev-throw there.
 */
export interface TweenSpec {
  /** Position tween: lerp `target.position` from `from` to `to` over the interval. */
  readonly tween:
    | {
        readonly kind: 'position';
        /** The visual to move (a `PositionTweenTarget` — typically `mu.visual`). */
        readonly target: unknown | null;
        readonly from: readonly [number, number, number];
        readonly to: readonly [number, number, number];
      }
    | {
        readonly kind: 'drive';
        /** The drive to interpolate (a `DriveTweenTarget` wrapper). */
        readonly drive: unknown | null;
        readonly from: number;
        readonly to: number;
      };
}

/**
 * A unified material-flow port. EXTENDS Plan-196's `TransportLink`:
 *   port.id === TransportLink.partnerSnapId === partner snap id
 *   port.ownerComponent fills TransportLink.partnerComponent (DES handshake)
 */
export interface Port extends TransportLink {
  /** Stable port id — equals `partnerSnapId` (the partner snap's id). */
  readonly id: string;
  /** Flow role from the topology resolver (direction-classified). */
  readonly role: 'input' | 'output';
  /** The partner LayoutObject root (alias of `TransportLink.partnerRoot`). */
  readonly ownerRoot: Object3D;
  /**
   * The partner's MaterialFlowInstance for the DES object-handshake. Fills the
   * `partnerComponent` slot Plan-196 reserved (null on the continuous path).
   */
  readonly ownerComponent: unknown | null;
  /** Optional world dispatch angle (deg) for routers — filled by P4. */
  worldAngle?: number;
}

// ─── self interface ─────────────────────────────────────────────────────

export interface MaterialFlowSelf<S = Record<string, never>> {
  readonly type: string;
  readonly kind: MaterialFlowKind;
  readonly root: Object3D;
  readonly node: Object3D;
  /** Opaque viewer handle (== rv.viewer) — the type isSurfaceOccupied accepts. */
  readonly viewer: unknown;
  /** DES integer entity id; -1 in pure continuous. */
  readonly entityId: number;
  readonly mode: SimulationMode;

  /** Per-instance mutable state slot — behaviours store resolved nodes/handles/flags here. */
  readonly local: S;

  // Signals — instance-scoped, identical surface to rv.signals.
  readonly signals: {
    get<T = unknown>(name: string): T;
    set(name: string, value: boolean | number): void;
    on(name: string, cb: (value: boolean | number) => void): void;
  };
  /** Declare a signal (setup() only — forwards to rv.signal). */
  signal(name: string, opts: SignalOpts): void;
  /** Stamp an inspector/badge companion component (forwards to rv.behavior(rv.root,...)). */
  stamp(type: string, props: Record<string, unknown>): void;

  // Scheduling — DES-only. Continuous mode dev-throws.
  in(delay: number, hook: DesHookName, mu?: MU | null, data?: unknown): number;
  at(time: number, hook: DesHookName, mu?: MU | null, data?: unknown): number;
  cancel(eventId: number): void;
  readonly now: number;

  // Drives.
  drive(ref: NodeRef): SelfDrive | null;

  // Ports — unified snap-graph ∪ IN*/OUT* model.
  readonly ports: ReadonlyArray<Port>;
  inputs(): Port[];
  outputs(): Port[];
  freeOutputs(mu?: MU): Port[];
  /** Per-port downstream interlock used by `logic.shouldFlow` (continuous: signal-backed). */
  downstreamOccupied(port?: Port): boolean;

  // State machine.
  setState(name: string): void;
  readonly state: string;

  // MU transfer / load.
  transfer(mu: MU, fromPort?: Port): void;
  /**
   * Would the downstream accept `mu` right now? DES routing pre-check (Plan 194
   * §2.5 `self.downstream?.canAccept(mu)`): in DES mode it queries the resolved
   * downstream component's handshake; in continuous/mock mode (no backend) it
   * returns `true` (the transport surface, not a handshake, gates the flow).
   * `port` selects a specific output for multi-output routers.
   */
  downstreamCanAccept(mu: MU, port?: Port): boolean;
  /**
   * Mint a fresh MU (sources). In DES mode this creates + registers a real
   * runner-backed MU (so the manager tracks it, ids are global, and the tween
   * registry can animate its `visual`). In continuous/mock mode it returns a
   * plain structural MU. Use this in `des.onGenerate` instead of fabricating a
   * `{ id }` literal so the model-load flow tracks every part.
   */
  spawn(): MU;
  readonly mus: ReadonlyArray<MU>;
  readonly currentLoad: number;

  contextMenu(target: NodeRef, items: ContextMenuItem[]): void;

  /** Snapshot-safe custom runtime state (== DESComponent.prop). */
  readonly prop: Record<string, JsonValue>;
}

// ─── Topology resolver (snap-graph primary, autoConnect fallback) ─────────

/**
 * Build the unified `Port[]` for a node.
 *
 * Primary source: the snap-graph. `classifyConnections` gives every PAIRED
 * snap a direction-classified `role` (input/output) — used for routers
 * (turntables) and any multi-port component. `findOutputPairings` is the
 * single-successor convenience the conveyor uses; we fold any output pairings
 * not already covered into the result so a plain conveyor (which may only have
 * output snaps modelled) still exposes its downstream port.
 *
 * Fallback (autoConnect by world-distance, V2 §2.6): NOT yet implemented —
 * returns no extra ports. When the snap-graph yields nothing (no snap-point
 * plugin, or unsnapped placement) `resolvePorts` returns `[]`. The autoConnect
 * distance heuristic (OUT-to-IN nearest, role from IN-/OUT- node name) lands
 * with P4/topology-resolver.ts. See the TODO(P5) note below.
 */
export function resolvePorts(rv: RVBindContext): Port[] {
  const out: Port[] = [];
  const seen = new Set<string>();

  // 1. Direction-classified connections (works for routers + bidirectional ports).
  const conns: PortConnection[] = classifyConnections(rv.viewer, rv.root);
  for (const c of conns) {
    const p = portFromConnection(rv, c);
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }

  // 2. Output pairings the conveyor relies on (single-successor); fold in any
  //    not already represented (e.g. when classifyConnections returns nothing
  //    because no component registry / transport surface is present).
  const pairings: OutputPairing[] = findOutputPairings(rv.viewer, rv.root);
  for (const pr of pairings) {
    if (seen.has(pr.pairedSnap.id)) continue;
    seen.add(pr.pairedSnap.id);
    out.push(portFromPairing(rv, pr));
  }

  // 3. TODO(P5): autoConnect distance fallback (no snaps → nearest OUT→IN by
  //    world distance, role from IN*/OUT* node name). Intentionally a no-op
  //    for now — documented in resolvePorts() jsdoc above. Returns [] here.

  return out;
}

/** A Port built from a direction-classified PortConnection. */
function portFromConnection(rv: RVBindContext, c: PortConnection): Port {
  const link = makeLinkLike(rv, c.snap.id, c.pairedSnap.id, c.ownerRoot);
  return {
    ...link,
    id: c.pairedSnap.id,
    role: c.role,
    ownerRoot: c.ownerRoot,
    ownerComponent: null, // continuous path; DES runner fills it (P5)
  };
}

/** A Port built from a single-successor OutputPairing (always role 'output'). */
function portFromPairing(rv: RVBindContext, pr: OutputPairing): Port {
  const link = makeLinkLike(rv, pr.snap.id, pr.pairedSnap.id, pr.ownerRoot);
  return {
    ...link,
    id: pr.pairedSnap.id,
    role: 'output',
    ownerRoot: pr.ownerRoot,
    ownerComponent: null,
  };
}

/**
 * Build the TransportLink fields for a port. This mirrors `makeLink` in
 * transport-links.ts (kept private there) using the same per-port/root
 * `Conveyor.Occupied@<id>` signal convention so the addressing is identical
 * across Plan 196 and Plan 194.
 */
function makeLinkLike(
  rv: RVBindContext,
  mySnapId: string,
  partnerSnapId: string,
  partnerRoot: Object3D,
): TransportLink {
  const OCCUPIED = 'Conveyor.Occupied';
  const partnerRootSig = `/${partnerRoot.name}/${OCCUPIED}`;
  return {
    mySnapId,
    partnerSnapId,
    partnerRoot,
    partnerComponent: null,
    occupied(): boolean {
      const perPort = `${partnerRootSig}@${partnerSnapId}`;
      const name = rv.signals.get(perPort) !== undefined ? perPort : partnerRootSig;
      return rv.signals.get<boolean>(name) === true;
    },
    upstreamWaiting(): boolean {
      return rv.signals.get<boolean>(partnerRootSig) === true;
    },
    setOccupied(v: boolean): void {
      rv.signals.set(`${OCCUPIED}@${mySnapId}`, v);
    },
  };
}

/**
 * Read a numeric config value from `self.prop` (the rv_extras bag the binding
 * wiring fills) with a default fallback. Non-finite / missing → `def`.
 */
export function readConfigNumber(
  self: Pick<MaterialFlowSelf, 'prop'>,
  key: string,
  def: number,
): number {
  const v = self.prop[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : def;
}

// ─── createSelf ─────────────────────────────────────────────────────────

/** Minimal definition shape `createSelf` needs (avoids a cycle with define-material-flow). */
export interface SelfDef {
  readonly type: string;
  readonly kind: MaterialFlowKind;
}

export interface CreateSelfOptions<S = Record<string, never>> {
  /** Simulation mode for this self. Default 'continuous'. */
  mode?: SimulationMode;
  /** DES entity id; -1 in pure continuous (default). */
  entityId?: number;
  /**
   * DES scheduling backend (P5). When present, `self.in/at/cancel/now` delegate
   * to it. Absent (continuous) → `in/at` dev-throw, `now` reads the host loop.
   */
  scheduler?: SelfScheduler | null;
  /**
   * DES MU-transfer backend (P5). When present, `self.transfer(mu, fromPort)`
   * delegates the blocking handshake (canAccept → accept → release / block)
   * to it. Absent (continuous) → `transfer` is the implicit no-op hand-off
   * (the transport manager moves MUs surface→surface).
   */
  onTransfer?: ((mu: MU, fromPort?: Port) => void) | null;
  /**
   * DES MU factory (P5). When present, `self.spawn()` mints a real runner-backed
   * MU. Absent (continuous) → `self.spawn()` returns a plain structural MU with a
   * locally-incremented id.
   */
  spawnMU?: (() => MU) | null;
  /**
   * DES downstream-acceptance probe (P5). When present, `self.downstreamCanAccept`
   * delegates to it (the runner queries the resolved downstream adapter). Absent
   * (continuous) → `downstreamCanAccept` returns `true`.
   */
  canAcceptDownstream?: ((mu: MU, port?: Port) => boolean) | null;
  /** Per-instance state object exposed as `self.local` (defaults to `{}`). */
  local?: S;
}

/** DES scheduling backend the DESRunner injects (P5). */
export interface SelfScheduler {
  in(delay: number, hook: DesHookName, mu?: MU | null, data?: unknown): number;
  at(time: number, hook: DesHookName, mu?: MU | null, data?: unknown): number;
  cancel(eventId: number): void;
  readonly now: number;
}

/**
 * Project a `MaterialFlowSelf` over an existing `RVBindContext`.
 *
 * The signal/drive/find/contextMenu/onFixedUpdate surface forwards straight
 * through `rv`, so a continuous definition behaves exactly like a hand-written
 * behavior. Ports are resolved lazily (the snap-graph mutates as assets are
 * placed); `state`/`prop`/`mus` are local mutable state on the self.
 */
export function createSelf<S = Record<string, never>>(
  rv: RVBindContext,
  def: SelfDef,
  opts: CreateSelfOptions<S> = {},
): MaterialFlowSelf<S> {
  const mode: SimulationMode = opts.mode ?? 'continuous';
  const entityId = opts.entityId ?? -1;
  const scheduler = opts.scheduler ?? null;
  const onTransfer = opts.onTransfer ?? null;
  const spawnMU = opts.spawnMU ?? null;
  const canAcceptDownstream = opts.canAcceptDownstream ?? null;
  const local = (opts.local ?? {}) as S;
  let localMuId = 0;

  const prop: Record<string, JsonValue> = {};
  const mus: MU[] = [];
  let state = 'idle';

  // Lazy: only allocate the shared interlock when an instance actually calls
  // self.downstreamOccupied() without a port (behaviours that build their own
  // never pay for it).
  let interlock: { occupied(): boolean } | null = null;
  const getInterlock = (): { occupied(): boolean } =>
    (interlock ??= createDownstreamInterlock(rv));

  const throwContinuous = (fn: string): never => {
    throw new Error(
      `[material-flow] self.${fn}() is DES-only and was called in continuous mode ` +
        `(type='${def.type}'). Schedule events only from the des block.`,
    );
  };

  const self: MaterialFlowSelf<S> = {
    type: def.type,
    kind: def.kind,
    root: rv.root,
    node: rv.root,
    viewer: rv.viewer,
    entityId,
    mode,

    local,

    signals: rv.signals,
    signal(name: string, o: SignalOpts): void {
      rv.signal(name, o);
    },
    stamp(type: string, props: Record<string, unknown>): void {
      rv.behavior(rv.root, type, props);
    },

    in(delay, hook, mu, data): number {
      if (!scheduler) return throwContinuous('in');
      return scheduler.in(delay, hook, mu, data);
    },
    at(time, hook, mu, data): number {
      if (!scheduler) return throwContinuous('at');
      return scheduler.at(time, hook, mu, data);
    },
    cancel(eventId: number): void {
      if (!scheduler) return throwContinuous('cancel');
      scheduler.cancel(eventId);
    },
    get now(): number {
      return scheduler ? scheduler.now : 0;
    },

    drive(ref: NodeRef): SelfDrive | null {
      const d = rv.drives.get(ref);
      return (d as SelfDrive | null) ?? null;
    },

    get ports(): ReadonlyArray<Port> {
      return resolvePorts(rv);
    },
    inputs(): Port[] {
      return resolvePorts(rv).filter(p => p.role === 'input');
    },
    outputs(): Port[] {
      return resolvePorts(rv).filter(p => p.role === 'output');
    },
    freeOutputs(_mu?: MU): Port[] {
      // A free output = one whose downstream is NOT occupied (Plan 196:
      // `outputs().filter(p => !linkOf(rv,p).occupied())`).
      return resolvePorts(rv).filter(p => p.role === 'output' && !p.occupied());
    },
    downstreamOccupied(port?: Port): boolean {
      // Per-port when given (multi-output routers); else the conveyor's
      // allocation-free single-successor interlock (Plan 196), resolved lazily.
      return port ? port.occupied() : getInterlock().occupied();
    },

    setState(name: string): void {
      state = name;
    },
    get state(): string {
      return state;
    },

    transfer(mu: MU, fromPort?: Port): void {
      // DES: delegate the blocking handshake (canAccept → accept → release /
      // block) to the runner-injected backend. Continuous: implicit no-op
      // hand-off (the transport manager moves MUs surface→surface).
      if (onTransfer) onTransfer(mu, fromPort);
    },
    spawn(): MU {
      // DES: a real runner-backed MU (manager-tracked, global id, visual). Else
      // a plain structural MU with a local id (continuous/mock).
      return spawnMU ? spawnMU() : { id: ++localMuId, prop: {} };
    },
    downstreamCanAccept(mu: MU, port?: Port): boolean {
      // DES: probe the resolved downstream adapter; continuous/mock: always true
      // (the transport surface gates the flow, not a handshake).
      return canAcceptDownstream ? canAcceptDownstream(mu, port) : true;
    },
    get mus(): ReadonlyArray<MU> {
      return mus;
    },
    get currentLoad(): number {
      return mus.length;
    },

    contextMenu(target: NodeRef, items: ContextMenuItem[]): void {
      rv.contextMenu(target, items);
    },

    prop,
  };

  return self;
}
