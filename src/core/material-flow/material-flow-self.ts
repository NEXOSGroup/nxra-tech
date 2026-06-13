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
  SignalType,
} from '../behavior-runtime';
import type { TransportLink } from '../../behaviors/_shared/transport-links';
import type { StateStatistics } from './rv-state-statistics';
import {
  createDownstreamInterlock,
  declareFlowSignalsWith,
  flowOccupiedRootSignal,
  FLOW_OCCUPIED,
} from '../../behaviors/_shared/transport-links';
import {
  classifyConnections,
  findOutputPairings,
  type PortConnection,
  type OutputPairing,
} from '../../behaviors/_shared/snap-graph-helpers';
import {
  findTransport,
  findSensor,
  findRotaryDrive,
} from '../library-component-loader';
import {
  attachBelt,
  attachDrive,
  selfDrives,
  type BeltHandle,
  type DriveHandle,
} from '../../behaviors/_shared/lazy-drive';
import { isSurfaceOccupied } from '../../behaviors/_shared/surface-occupancy';

// Re-export the handle types the toolkit returns so the behavior-kit `RV`
// namespace can alias them without importing `_shared/lazy-drive` directly.
export type { BeltHandle, DriveHandle } from '../../behaviors/_shared/lazy-drive';

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

// ─── Declarative `signals` block + typed `self.sig` (Plan 197 §2.4b-A) ────

/**
 * The shape of a definition's optional `signals` block: a map from a short key
 * (e.g. `Run`) to its PLC signal type. The factory auto-declares each as
 * `${def.type}.${key}` and exposes a typed accessor on `self.sig.<key>`.
 */
export type SignalShape = Record<string, SignalType>;

/**
 * Value type carried by a PLC signal type: Bool → boolean, Int/Float → number.
 * Drives the `get()`/`set()` typing of every `self.sig.<key>` accessor.
 */
export type SignalValue<T extends SignalType> = T extends `${string}Bool`
  ? boolean
  : number;

/** A single typed signal accessor — `get()`/`set()` against the scoped store. */
export interface SignalAccessor<T extends SignalType> {
  /** Read the current value (boolean for Bool signals, number for Int/Float). */
  get(): SignalValue<T>;
  /** Write a new value (boolean for Bool signals, number for Int/Float). */
  set(value: SignalValue<T>): void;
}

/**
 * The `self.sig` surface: one keyed, value-typed accessor per `signals` entry.
 * A mapped type over the `signals` shape so `self.sig.Run` is key-checked and
 * `self.sig.Run.get()` returns `boolean` (for `PLCInputBool`), etc.
 */
export type SigAccessors<SIG extends SignalShape> = {
  readonly [K in keyof SIG]: SignalAccessor<SIG[K]>;
};

// ─── self interface ─────────────────────────────────────────────────────

export interface MaterialFlowSelf<
  S = Record<string, never>,
  SIG extends SignalShape = Record<string, never>,
> {
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
  /**
   * Typed accessors for the definition's `signals` block (Plan 197 §2.4b-A).
   * `self.sig.Run.get()` / `self.sig.Run.set(v)` are key-checked and value-typed
   * (boolean for Bool, number for Int/Float). Empty when no `signals` block is
   * declared. Each accessor reads/writes through `self.signals` under the scoped
   * name `${type}.${key}`.
   */
  readonly sig: SigAccessors<SIG>;
  /** Declare a signal (setup() only — forwards to rv.signal). */
  signal(name: string, opts: SignalOpts): void;
  /** Stamp an inspector/badge companion component (forwards to rv.behavior(rv.root,...)). */
  stamp(type: string, props: Record<string, unknown>): void;

  // ── Toolkit: convention-based node resolution + handles (delegate to the
  //    _shared/loader helpers with self.root / selfDrives(self) / self.viewer).
  /** First `Transport-X/Y/Z` belt node under root, or null. */
  findTransport(): Object3D | null;
  /** First `Sensor[-id]` node under root, or null. */
  findSensor(): Object3D | null;
  /** First `Drive-Rot-X/Y/Z` rotary node under root, or null. */
  findRotaryDrive(): Object3D | null;
  /** Lazy belt handle (`run(forward)`) for a transport node. */
  attachBelt(node: Object3D | null): BeltHandle;
  /** Lazy positioned-drive handle (`run/moveTo/isAtTarget/stop`) for a drive node. */
  attachDrive(node: Object3D | null): DriveHandle;
  /** True when a live MU is physically on a transport surface under `node`. */
  surfaceOccupied(node: Object3D): boolean;
  /** Declare the public 4-signal material-flow contract (Flow.Run/Occupied/Running/PartCount). */
  declareFlowSignals(): void;
  /** Cached single-successor downstream interlock for the continuous hot path. */
  downstreamInterlock(): { occupied(): boolean };
  /** Disable this instance: warn + set local.disabled — the factory then gates setup/fixedUpdate. */
  disable(reason: string): void;
  /** True once `self.disable()` has been called (factory gate). */
  readonly disabled: boolean;

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

  // Statistics (Plan 201). When the self has a StateStatistics sink these book
  // into it; otherwise they are no-ops. `setState` already feeds state time.
  /** Count completed output (parts) for throughput statistics. */
  statOutput(n?: number): void;
  /** Start a cycle timer (statistics). */
  statCycleStart(): void;
  /** Close a cycle timer (statistics). Ignored if no cycle was started. */
  statCycleEnd(): void;

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
 * `Flow.Occupied@<id>` signal convention so the addressing is identical
 * across Plan 196 and Plan 194. The per-root interlock symbol comes from the
 * shared `flowOccupiedRootSignal()` helper (which folds in `FLOW_OCCUPIED` with
 * the `.`-separator) — no second literal lives here, so makeLink and makeLinkLike
 * can never diverge on the separator.
 */
function makeLinkLike(
  rv: RVBindContext,
  mySnapId: string,
  partnerSnapId: string,
  partnerRoot: Object3D,
): TransportLink {
  const partnerRootSig = flowOccupiedRootSignal(partnerRoot.name);
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
      rv.signals.set(`${FLOW_OCCUPIED}@${mySnapId}`, v);
    },
  };
}

/** Typed initial value for an auto-declared signal: Bool → false, Int/Float → 0. */
function signalInitialValue(type: SignalType): boolean | number {
  return type.includes('Bool') ? false : 0;
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
  /**
   * Signal-name namespace for the `signals` block / `self.sig` accessors
   * (Plan 197 §2.4b-A). Each signal is scoped `${signalNamespace ?? type}.${key}`.
   * Defaults to `type`; the material-flow interop components (Conveyor/Turntable/
   * Sink) set `signalNamespace: 'Flow'` so `self.sig.<key>` and the factory
   * auto-declare resolve to the shared `Flow.*` interop signal names instead of
   * the per-component `<type>.*` names.
   */
  readonly signalNamespace?: string;
  /**
   * The definition's optional `signals` block (Plan 197 §2.4b-A). `createSelf`
   * builds the typed `self.sig.<key>` accessor map from it (when `opts.signals`
   * is not given) AND auto-declares each signal into the store, so the DES path
   * (which calls `createSelf` directly, without the library-component factory)
   * gets identical `self.sig` accessors and declared signals as the continuous
   * path. Each accessor reads/writes the scoped name
   * `${signalNamespace ?? type}.${key}`.
   */
  readonly signals?: SignalShape;
}

export interface CreateSelfOptions<
  S = Record<string, never>,
  SIG extends SignalShape = Record<string, never>,
> {
  /** Simulation mode for this self. Default 'continuous'. */
  mode?: SimulationMode;
  /** DES entity id; -1 in pure continuous (default). */
  entityId?: number;
  /**
   * Declarative `signals` block (Plan 197 §2.4b-A). When present (or taken from
   * `def.signals`), `createSelf` BOTH builds the typed `self.sig.<key>` accessor
   * map AND auto-declares each signal into the store under the scoped name
   * `${signalNamespace ?? type}.${key}` with a typed default (Bool→false,
   * Int/Float→0). Declaration happens here — on whichever path (continuous
   * factory or DES runner) builds the self — so behaviours never re-declare in
   * `setup`; they only override non-default initial values via `self.sig.set()`.
   */
  signals?: SIG;
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
  /**
   * Plan 201 — per-component state-statistics sink. When present, `self.setState`
   * ALSO books state time into it, and `self.statOutput/statCycleStart/statCycleEnd`
   * delegate to it. Absent → every stat call is a no-op. The caller (a createSelf
   * caller wired to the StatisticsManager) constructs it with the shared sim clock
   * (`() => viewer.simTime`) and registers it for aggregation.
   */
  statistics?: StateStatistics | null;
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
export function createSelf<
  S = Record<string, never>,
  SIG extends SignalShape = Record<string, never>,
>(
  rv: RVBindContext,
  def: SelfDef,
  opts: CreateSelfOptions<S, SIG> = {},
): MaterialFlowSelf<S, SIG> {
  const mode: SimulationMode = opts.mode ?? 'continuous';
  const entityId = opts.entityId ?? -1;
  const scheduler = opts.scheduler ?? null;
  const onTransfer = opts.onTransfer ?? null;
  const spawnMU = opts.spawnMU ?? null;
  const canAcceptDownstream = opts.canAcceptDownstream ?? null;
  const local = (opts.local ?? {}) as S;
  const statistics = opts.statistics ?? null;
  let localMuId = 0;

  // Build the typed `self.sig` accessor map from the optional `signals` shape.
  // Each accessor reads/writes `self.signals` under the scoped name
  // `${signalNamespace ?? type}.${key}` (the same convention the factory uses to
  // auto-declare). The namespace defaults to `type`, but the material-flow interop
  // components (Conveyor/Turntable/Sink → `Flow.*`) override it. Empty object when
  // no `signals` block was passed.
  const signalNamespace = def.signalNamespace ?? def.type;
  // The accessor map uses the explicit `opts.signals` shape when given, else the
  // definition's own `signals` block (so the DES path, which calls createSelf
  // without opts.signals, still gets a populated `self.sig`).
  const sigShape = opts.signals ?? def.signals;
  const sig = {} as Record<string, SignalAccessor<SignalType>>;
  if (sigShape) {
    for (const key of Object.keys(sigShape)) {
      const scoped = `${signalNamespace}.${key}`;
      sig[key] = {
        get(): SignalValue<SignalType> {
          return rv.signals.get(scoped) as SignalValue<SignalType>;
        },
        set(value: SignalValue<SignalType>): void {
          rv.signals.set(scoped, value);
        },
      };
    }
  }

  const prop: Record<string, JsonValue> = {};
  const mus: MU[] = [];
  let state = 'idle';
  let disabled = false;

  // Lazy: only allocate the shared interlock when an instance actually calls
  // self.downstreamOccupied() / self.downstreamInterlock() (behaviours that
  // never gate on the downstream don't pay for it). The SAME cached object backs
  // both the one-shot `downstreamOccupied()` and the per-tick `downstreamInterlock()`.
  let interlock: { occupied(): boolean } | null = null;
  const getInterlock = (): { occupied(): boolean } =>
    (interlock ??= createDownstreamInterlock(rv));

  const throwContinuous = (fn: string): never => {
    throw new Error(
      `[material-flow] self.${fn}() is DES-only and was called in continuous mode ` +
        `(type='${def.type}'). Schedule events only from the des block.`,
    );
  };

  const self: MaterialFlowSelf<S, SIG> = {
    type: def.type,
    kind: def.kind,
    root: rv.root,
    node: rv.root,
    viewer: rv.viewer,
    entityId,
    mode,

    local,

    signals: rv.signals,
    sig: sig as SigAccessors<SIG>,
    signal(name: string, o: SignalOpts): void {
      rv.signal(name, o);
    },
    stamp(type: string, props: Record<string, unknown>): void {
      rv.behavior(rv.root, type, props);
    },

    // ── Toolkit (delegates to the _shared/loader helpers) ──────────────────
    findTransport(): Object3D | null {
      return findTransport(rv.root);
    },
    findSensor(): Object3D | null {
      return findSensor(rv.root);
    },
    findRotaryDrive(): Object3D | null {
      return findRotaryDrive(rv.root);
    },
    attachBelt(node: Object3D | null): BeltHandle {
      return attachBelt(selfDrives(self), node);
    },
    attachDrive(node: Object3D | null): DriveHandle {
      return attachDrive(selfDrives(self), node);
    },
    surfaceOccupied(node: Object3D): boolean {
      return isSurfaceOccupied(rv.viewer, node);
    },
    declareFlowSignals(): void {
      declareFlowSignalsWith((n, o) => rv.signal(n, o));
    },
    downstreamInterlock(): { occupied(): boolean } {
      return getInterlock();
    },
    disable(reason: string): void {
      disabled = true;
      (local as Record<string, unknown>).disabled = true;
      console.warn(`[material-flow] ${def.type} disabled: ${reason}`);
    },
    get disabled(): boolean {
      return disabled;
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
      // Plan 201: feed the state-statistics sink (no-op when absent). This is the
      // single source of state time — DES and continuous both go through here.
      statistics?.setState(name);
    },
    get state(): string {
      return state;
    },
    statOutput(n = 1): void {
      statistics?.output(n);
    },
    statCycleStart(): void {
      statistics?.cycleStart();
    },
    statCycleEnd(): void {
      statistics?.cycleEnd();
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

  // Auto-declare the `signals` block into the store, ONCE, on whichever path
  // built this self (continuous factory `bind()` OR the DES runner's direct
  // `createSelf`). Each signal is registered under the scoped name
  // `${signalNamespace ?? type}.${key}` with a typed default (Bool→false,
  // Int/Float→0). Behaviours therefore never re-declare in `setup` — they only
  // override the non-default initial values via `self.sig.<key>.set(...)`.
  if (sigShape) {
    for (const key of Object.keys(sigShape)) {
      const type = sigShape[key];
      self.signal(`${signalNamespace}.${key}`, {
        type,
        initialValue: signalInitialValue(type),
      });
    }
  }

  return self;
}
