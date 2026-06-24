// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ik-path.ts — TypeScript pendant of IKPath.cs (realvirtual Robotics Pro).
 *
 * Orchestrates a robot motion path by sequencing RVIKTarget waypoints. This is
 * the **replay engine** (plan-215 Phase 1): it drives the robot's axis drives to
 * each target's pre-computed `AxisPos` joint angles, with full functional parity
 * for the start/end/wait signal contract and LogicStep triggering.
 *
 * Parity scope (Phase 1):
 *   - PTP motion (synced + unsynced) via the axis drives' own physics
 *   - Signal contract: SignalStart (read, rising-edge → startPath), SignalIsStarted
 *     / SignalEnded (written), per-target SetSignal + WaitForSignal + WaitForSeconds
 *   - LoopPath / StartNextPath chaining
 *   - Pick/Place at targets (via RVGrip)
 *   - Start via StartPath (sim start) AND via SignalStart AND via LogicStep_IKPath
 *
 * Out of scope here (later phases): true LIN cartesian interpolation, zone
 * blending, interactive target editing (needs the WASM solver, plan-212). Linear
 * targets are executed as PTP in this MVP (same end pose, joint-space path).
 *
 * Per-frame tick: RVViewer ticks all RVIKPath instances once per fixed step,
 * BEFORE the drive loop, so target/positionOverwrite writes apply the same frame.
 */

import type { Object3D } from 'three';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent } from './rv-component-registry';
import type { ComponentRef, NodeRegistry } from './rv-node-registry';
import type { SignalStore } from './rv-signal-store';
import type { RVDrive } from './rv-drive';
import { RVIKTarget } from './rv-ik-target';
import { wireBoolSignal } from './rv-signal-wiring';
import { debug } from './rv-debug';

interface PendingSignalReset { addr: string; at: number; }

export class RVIKPath implements RVComponent {
  static readonly schema: ComponentSchema = {
    SpeedOverride:   { type: 'number',  default: 1 },
    SetNewTCP:       { type: 'boolean', default: false },
    DrawPath:        { type: 'boolean', default: true },
    DrawTargets:     { type: 'boolean', default: true },
    DebugPath:       { type: 'boolean', default: false },
    DebugBlending:   { type: 'boolean', default: false },
    StartPath:       { type: 'boolean', default: false },
    LoopPath:        { type: 'boolean', default: false },
    // Signal refs → resolved to address strings by resolveComponentRefs()
    SignalStart:     { type: 'componentRef' },
    SignalIsStarted: { type: 'componentRef' },
    SignalEnded:     { type: 'componentRef' },
    // Path is listed so it shows in the inspector (rendered by a custom
    // reorderable-list field renderer). The runtime target list is resolved from
    // raw node extras in init(), NOT from this instance field (resolveComponentRefs
    // rewrites it to a path-string array — unused).
    Path:            { type: 'componentRefArray' },
    // NOTE: StartNextPath (IKPath ref) is read raw in init().
  };

  readonly node: Object3D;
  isOwner = true;

  // ── Authoring properties (parity with IKPath.cs) ──
  SpeedOverride = 1;
  SetNewTCP = false;
  DrawPath = true;
  DrawTargets = true;
  DebugPath = false;
  DebugBlending = false;
  StartPath = false;
  LoopPath = false;
  SignalStart: string | null = null;
  SignalIsStarted: string | null = null;
  SignalEnded: string | null = null;

  // ── Runtime status (read-only; surfaced via getLiveState) ──
  PathIsActive = false;
  PathIsFinished = false;
  NumTarget = 0;
  CurrentTarget: RVIKTarget | null = null;
  LastTarget: RVIKTarget | null = null;
  WaitForSignal = false;

  // ── Resolved in init() ──
  private _path: RVIKTarget[] = [];
  private _startNextPath: RVIKPath | null = null;
  private _axisDrives: RVDrive[] = [];
  private _store: SignalStore | null = null;
  private _signalStartAddr: string | null = null;
  private _signalIsStartedAddr: string | null = null;
  private _signalEndedAddr: string | null = null;
  private _unsubStart: (() => void) | null = null;
  private _startSignalValue = false;

  // ── Internal state machine ──
  private _simTime = 0;
  private _startBefore = false;
  private _waitForStartTimer = 0;
  private _checkNextTargetTimer = 0;
  private _activeMoving = false;
  private _waitSignalAddr: string | null = null;
  private _pendingReset: PendingSignalReset | null = null;
  private _warnedNoDrives = false;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    const registry = context.registry;
    this._store = context.signalStore;

    // Read object refs DIRECTLY from node extras. We must NOT read them from
    // instance fields: resolveComponentRefs() (run by the loader before init)
    // iterates every instance property and rewrites ref-holding fields —
    // ref arrays become path-string arrays and single non-signal refs become
    // null — so any captured ref field is already corrupted by now. The raw
    // node.userData.realvirtual extras are untouched and authoritative.
    const raw = (this.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['IKPath'] ?? {};

    // Resolve the ordered target list from raw extras.
    this.rebuildTargets(registry);

    // Resolve the chained path.
    const nextRef = raw['StartNextPath'];
    if (isRef(nextRef)) {
      this._startNextPath = resolveComp<RVIKPath>(registry, 'IKPath', (nextRef as ComponentRef).path);
    }

    // Resolve the ordered axis drives from the parent RobotIK's serialized Axis[].
    this._axisDrives = this.resolveAxisDrives(registry);

    // Signal addresses (already resolved to strings by resolveComponentRefs).
    this._signalIsStartedAddr = typeof this.SignalIsStarted === 'string' ? this.SignalIsStarted : null;
    this._signalEndedAddr = typeof this.SignalEnded === 'string' ? this.SignalEnded : null;
    this._signalStartAddr = typeof this.SignalStart === 'string' ? this.SignalStart : null;

    // Subscribe to SignalStart (PLCOutputBool: PLC writes, viewer reads).
    this._unsubStart = wireBoolSignal(
      context.signalStore, this._signalStartAddr,
      (v) => { this._startSignalValue = v; },
      `IKPath "${this.node.name}": SignalStart`,
    ).unsubscribe;

    debug('loader',
      `  IKPath: ${this.node.name} targets=${this._path.length} axes=${this._axisDrives.length}` +
      ` start=${this.StartPath} loop=${this.LoopPath}`);
  }

  /** Walk up to the parent RobotIK node and resolve its ordered Axis[] drives. */
  private resolveAxisDrives(registry: NodeRegistry): RVDrive[] {
    let n: Object3D | null = this.node;
    while (n) {
      const rv = n.userData?.realvirtual as Record<string, unknown> | undefined;
      if (rv?.['RobotIK']) return resolveAxisDrivesFromNode(registry, n);
      n = n.parent;
    }
    return [];
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  startPath(): void {
    if (this.PathIsActive) return;
    this.PathIsActive = true;
    this.PathIsFinished = false;
    this.NumTarget = 0;
    this.WaitForSignal = false;
    this._activeMoving = false;
    this._checkNextTargetTimer = 0;
    this._waitForStartTimer = 0.1; // inhibit immediate stale-StartPath re-trigger
    this.setSignal(this._signalIsStartedAddr, true);
    this.setSignal(this._signalEndedAddr, false);
    debug('logic', `IKPath "${this.node.name}": startPath (${this._path.length} targets)`);
    this.checkNextTarget();
  }

  private checkNextTarget(): void {
    if (this.NumTarget < this._path.length) {
      this.driveToTarget(this._path[this.NumTarget]);
    } else {
      // Path end.
      this.PathIsActive = false;
      this.PathIsFinished = true;
      this.setSignal(this._signalEndedAddr, true);
      this.setSignal(this._signalIsStartedAddr, false);
      debug('logic', `IKPath "${this.node.name}": finished`);
      if (this._startNextPath) {
        this._startNextPath.startPath();
      } else if (this.LoopPath) {
        this.startPath();
      }
    }
  }

  private driveToTarget(target: RVIKTarget): void {
    this.CurrentTarget = target;

    const axisCount = this._axisDrives.length;
    if (axisCount === 0) {
      if (!this._warnedNoDrives) {
        console.warn(`[RVIKPath] "${this.node.name}": no axis drives resolved — cannot replay path.`);
        this._warnedNoDrives = true;
      }
      // No drives ⇒ allAxesAtTarget() is vacuously true ⇒ the fixedUpdate poll
      // advances on the next tick (never synchronously — see _activeMoving note).
      this._activeMoving = true;
      return;
    }
    if (!target.hasReplayAngles(axisCount)) {
      console.warn(`[RVIKPath] "${this.node.name}": target "${target.node.name}" has no replay angles (AxisPos) — skipping motion.`);
      this._activeMoving = true; // drives left in place ⇒ poll advances next tick
      return;
    }

    const speedFactor = clamp(this.SpeedOverride * target.SpeedToTarget, 0.0001, 10);
    const synced = target.InterpolationToTarget !== 'PointToPointUnsynced';

    // Synced PTP: longest axis dictates the move time; others scale their speed.
    let maxTime = 0;
    if (synced) {
      for (let i = 0; i < axisCount; i++) {
        const drive = this._axisDrives[i];
        const delta = Math.abs(target.AxisPos[i] - drive.currentPosition);
        const speed = Math.max(drive.TargetSpeed * speedFactor, 0.0001);
        maxTime = Math.max(maxTime, delta / speed);
      }
    }

    for (let i = 0; i < axisCount; i++) {
      const drive = this._axisDrives[i];
      const dest = target.AxisPos[i];
      drive.positionOverwrite = false;
      const delta = Math.abs(dest - drive.currentPosition);
      if (synced && maxTime > 0) {
        drive.targetSpeed = Math.max(delta / maxTime, 0.0001);
      } else {
        drive.targetSpeed = Math.max(drive.TargetSpeed * speedFactor, 0.0001);
      }
      drive.startMove(dest);
    }

    // Arrival is detected by the next fixedUpdate poll (never synchronously here):
    // guarantees ≥1 tick per target, which prevents infinite recursion on
    // zero-delta targets and LoopPath/StartNextPath restarts.
    this._activeMoving = true;
  }

  private atTarget(): void {
    const target = this.CurrentTarget;
    if (target) {
      target.onAtTarget();
      // Schedule SetSignal reset (mirrors IKTarget.OnLeaveTarget timer).
      if (target.setSignalAddr && target.SetSignalDuration > 0) {
        this._pendingReset = { addr: target.setSignalAddr, at: this._simTime + target.SetSignalDuration };
      }
    }
    this.LastTarget = target;
    this.NumTarget++;

    // Wait for a signal at this target before advancing?
    if (target?.waitForSignalAddr) {
      this.WaitForSignal = true;
      this._waitSignalAddr = target.waitForSignalAddr;
    } else {
      this.readyForCheckNextTarget();
    }
  }

  private readyForCheckNextTarget(): void {
    this.WaitForSignal = false;
    this._waitSignalAddr = null;
    const wait = this.CurrentTarget?.WaitForSeconds ?? 0;
    if (wait > 0) {
      this._checkNextTargetTimer = wait;
    } else {
      this.checkNextTarget();
    }
  }

  private allAxesAtTarget(): boolean {
    for (const drive of this._axisDrives) {
      if (!drive.isAtTarget) return false;
    }
    return true;
  }

  private setSignal(addr: string | null, value: boolean): void {
    if (addr && this._store) this._store.setByPath(addr, value);
  }

  // ── Per-frame tick (called by RVViewer before the drive loop) ──
  fixedUpdate(dt: number): void {
    this._simTime += dt;

    // Pending SetSignal reset (deferred, sim-time based).
    if (this._pendingReset && this._simTime >= this._pendingReset.at) {
      this.setSignal(this._pendingReset.addr, false);
      this._pendingReset = null;
    }

    if (this._waitForStartTimer > 0) this._waitForStartTimer -= dt;

    // Start trigger: StartPath (sim start) OR SignalStart rising edge.
    const startTrigger = this.StartPath || this._startSignalValue;
    if (!this._startBefore && startTrigger && !this.PathIsActive && this._waitForStartTimer <= 0) {
      this.startPath();
    }
    this._startBefore = startTrigger;

    if (!this.PathIsActive) return;

    // Waiting for a per-target signal.
    if (this.WaitForSignal) {
      const ok = !this._waitSignalAddr || (this._store?.getBoolByPath(this._waitSignalAddr) ?? false);
      if (ok) this.readyForCheckNextTarget();
      return;
    }

    // Dwell timer (WaitForSeconds).
    if (this._checkNextTargetTimer > 0) {
      this._checkNextTargetTimer -= dt;
      if (this._checkNextTargetTimer <= 0) this.checkNextTarget();
      return;
    }

    // PTP motion in progress — poll axis drives.
    if (this._activeMoving && this.allAxesAtTarget()) {
      this._activeMoving = false;
      this.atTarget();
    }
  }

  /** Reset to idle (used by RVIKPathStep.reset and engine reset). */
  reset(): void {
    this.PathIsActive = false;
    this.PathIsFinished = false;
    this.NumTarget = 0;
    this.CurrentTarget = null;
    this.LastTarget = null;
    this.WaitForSignal = false;
    this._activeMoving = false;
    this._checkNextTargetTimer = 0;
    this._waitForStartTimer = 0;
    this._startBefore = false;
    this._waitSignalAddr = null;
    this._pendingReset = null;
  }

  /** Resolved, ordered target list (read-only) — used by the path visualizer. */
  get targets(): readonly RVIKTarget[] { return this._path; }

  /** Re-resolve the ordered target list from the (possibly overridden) raw
   *  `IKPath.Path` extras. Called from init() and again after op-created target
   *  nodes are added on scene load (they don't exist yet when init() first runs). */
  rebuildTargets(registry: NodeRegistry): void {
    const raw = (this.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['IKPath'] ?? {};
    const pathArr = Array.isArray(raw['Path']) ? (raw['Path'] as unknown[]) : [];
    this._path = pathArr
      .filter(isRef)
      .map((ref) => resolveComp<RVIKTarget>(registry, 'IKTarget', (ref as ComponentRef).path))
      .filter((t): t is RVIKTarget => t != null);
  }

  /** Reorder the runtime target list (authoring). Indices into the target list. */
  reorderTargets(from: number, to: number): void {
    const n = this._path.length;
    if (from < 0 || from >= n || to < 0 || to >= n || from === to) return;
    const [item] = this._path.splice(from, 1);
    this._path.splice(to, 0, item);
  }

  /** Insert a target into the runtime list at `index` (authoring, optimistic). */
  insertTarget(index: number, target: RVIKTarget): void {
    const i = Math.max(0, Math.min(index, this._path.length));
    this._path.splice(i, 0, target);
  }

  /** Remove a target from the runtime list (authoring). Index into the target list. */
  removeTarget(index: number): RVIKTarget | null {
    if (index < 0 || index >= this._path.length) return null;
    const [removed] = this._path.splice(index, 1);
    return removed ?? null;
  }

  getLiveState(): Record<string, unknown> {
    return {
      PathIsActive: this.PathIsActive,
      PathIsFinished: this.PathIsFinished,
      NumTarget: this.NumTarget,
      WaitForSignal: this.WaitForSignal,
    };
  }

  dispose(): void {
    this._unsubStart?.();
    this._unsubStart = null;
  }
}

export function isRef(v: unknown): v is ComponentRef {
  return !!v && typeof v === 'object'
    && (v as Record<string, unknown>).type === 'ComponentReference'
    && typeof (v as Record<string, unknown>).path === 'string';
}

/** Resolve a component by path, robust against undefined paths and Three.js node
 *  renames (duplicate-name dedup): falls back to node lookup → current path. */
export function resolveComp<T>(registry: NodeRegistry, type: string, path: string | undefined): T | null {
  if (typeof path !== 'string' || path.length === 0) return null;
  const direct = registry.getByPath<T>(type, path);
  if (direct) return direct;
  const node = registry.getNode(path);
  if (node) {
    const cur = registry.getPathForNode(node);
    if (cur) return registry.getByPath<T>(type, cur);
  }
  return null;
}

/** Resolve a RobotIK node's ordered Axis[] drives from its serialized extras.
 *  Reads raw extras (not the RobotIK instance) so it is independent of init order.
 *  Shared by RVRobotIK and RVIKPath. */
export function resolveAxisDrivesFromNode(registry: NodeRegistry, node: Object3D): RVDrive[] {
  const robot = (node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['RobotIK'];
  const axis = robot?.['Axis'];
  if (!Array.isArray(axis)) return [];
  return axis
    .filter(isRef)
    .map((ref) => resolveComp<RVDrive>(registry, 'Drive', (ref as ComponentRef).path))
    .filter((d): d is RVDrive => d != null);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

registerComponent({
  type: 'IKPath',
  schema: RVIKPath.schema,
  capabilities: { simulationActive: true, selectable: true, badgeColor: '#ba68c8', filterLabel: 'IK Paths' },
  create: (node: Object3D) => new RVIKPath(node),
});
