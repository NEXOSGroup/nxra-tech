// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * tween-registry.ts — the central sim-time interpolator (Plan 194 §3).
 *
 * Every DES duration event (a conveyor transit, a router rotation, a station
 * pick-place) registers ONE tween here. On each render the registry walks the
 * active tweens and interpolates them by SIMULATION time:
 *
 *   progress = clamp01((simNow − t0) / (t1 − t0))
 *
 * Because the progress is driven by `simNow` (not wall-clock), the HybridSynced
 * time-lapse falls out for free — when `simNow` advances N× faster, the MU moves
 * N× faster with no special case. This is exactly the C#-DES `DESMUMover`
 * principle (DESMUMover.cs:88, Plan 194 §9.2).
 *
 * Two tween flavours (Plan 194 §3.1):
 *   - position tween — `target.position.lerpVectors(from, to, p)` (straight
 *     translation; linear lerp is 1:1 to the continuous transport physics when
 *     `transitTime = length/speed`).
 *   - drive tween — `drive.setPosition(from + (to−from)·p)` (rotation/linear via
 *     the REAL drive, so the acceleration curve and visuals match the continuous
 *     path 1:1).
 *
 * FastForward sub-mode: `onRender` writes NO transform at all (Plan 194 §3.2 /
 * DESManager.cs:327) — events still fire and time still advances, but the scene
 * is not animated.
 *
 * GC discipline (Plan 194 V3): tween records come from a PRE-ALLOCATED POOL, not
 * `{ tween: {...} }` object literals per event — at HybridSynced 50× that would
 * be thousands of allocations/second. `add()` rents a record; the render loop
 * returns finished records to the pool. The interpolation scratch `Vector3` is a
 * module-level singleton, reused every frame.
 *
 * Robustness (Plan 194 V4):
 *   - `duration = Math.max(0.001, …)` → never `(simNow−t0)/0 = NaN`.
 *   - null visual / null target → the tween is skipped (no crash).
 *   - cancelled events → `cancel(handle)` frees the record so a stale tween can
 *     never keep moving an MU that the DES no longer owns.
 *
 * PUBLIC module — imports nothing private. The DESRunner (private, P5) owns an
 * instance and calls `add`/`cancel`/`onRender`/`clear`.
 */

import { Vector3 } from 'three';

// ─── Public target shapes (structural — no private/RV imports) ───────────

/** Sub-mode tag the registry honours on render (Plan 194 §3.2). */
export type TweenSubMode = 'animated' | 'hybrid' | 'fastforward' | 'step';

/**
 * A visual that a position tween moves. Structurally satisfied by both
 * `RVMovingUnit` and `InstancedMovingUnit` (`IMUAccessor.setPosition`), so the
 * public registry never imports the MU classes.
 */
export interface PositionTweenTarget {
  setPosition(v: Vector3): void;
}

/**
 * A drive a rotation/linear tween writes. Structurally satisfied by `RVDrive`
 * via a thin wrapper the DESRunner supplies (`v => { drive.currentPosition = v;
 * drive.applyToNode(); }`), so the public registry never imports `RVDrive`.
 */
export interface DriveTweenTarget {
  setPosition(value: number): void;
}

/** Opaque tween handle (an index into the pool). −1 means "no tween". */
export type TweenHandle = number;

// ─── Pool record (mutable; never exposed) ────────────────────────────────

interface TweenRecord {
  /** In-use flag — a free record is `active = false`. */
  active: boolean;
  /** 'pos' | 'drive' | '' (free). */
  kind: 'pos' | 'drive' | '';
  /** Sim-time the tween starts. */
  t0: number;
  /** Sim-time the tween ends (always `> t0`, clamped via Math.max). */
  t1: number;
  /** Position tween target (null for drive tweens / free records). */
  posTarget: PositionTweenTarget | null;
  /** Drive tween target (null for position tweens / free records). */
  driveTarget: DriveTweenTarget | null;
  /** Start value — Vector3 for pos, scalar for drive (stored in `fromScalar`). */
  fromVec: Vector3;
  toVec: Vector3;
  fromScalar: number;
  toScalar: number;
  /** Monotonic generation, bumped on free — guards stale-handle cancels. */
  gen: number;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Module-level interpolation scratch — reused every record, every frame (V3). */
const _scratch = new Vector3();

/**
 * The central sim-time tween registry. One instance per DESRunner.
 *
 * @param initialCapacity initial pool size (grows geometrically on demand).
 */
export class TweenRegistry {
  /** Pre-allocated record pool (Plan 194 V3 — no per-event allocation). */
  private _pool: TweenRecord[] = [];
  /** Indices of currently-active records (compacted in place on render). */
  private _active: number[] = [];
  /** Free-list of pool indices ready to be rented. */
  private _free: number[] = [];

  constructor(initialCapacity = 256) {
    this._grow(Math.max(1, initialCapacity));
  }

  /** Number of live tweens (diagnostics / tests). */
  get activeCount(): number {
    return this._active.length;
  }

  /** Pool size (diagnostics / tests — verifies no per-event growth). */
  get poolSize(): number {
    return this._pool.length;
  }

  // ─── Registration ──────────────────────────────────────────────────────

  /**
   * Register a POSITION tween (straight translation). The `from`/`to` vectors
   * are COPIED into the pooled record (the caller may mutate or reuse theirs).
   *
   * @returns a handle for `cancel()`, or −1 when the target is null (skipped).
   */
  addPosition(
    target: PositionTweenTarget | null,
    from: Vector3,
    to: Vector3,
    t0: number,
    duration: number,
  ): TweenHandle {
    if (!target) return -1; // null visual → skip (V4)
    const idx = this._rent();
    const r = this._pool[idx];
    r.active = true;
    r.kind = 'pos';
    r.t0 = t0;
    r.t1 = t0 + Math.max(0.001, duration); // duration=0 guard (V4)
    r.posTarget = target;
    r.driveTarget = null;
    r.fromVec.copy(from);
    r.toVec.copy(to);
    this._active.push(idx);
    return this._encode(idx, r.gen);
  }

  /**
   * Register a DRIVE tween (rotation / linear via the real drive).
   *
   * @returns a handle for `cancel()`, or −1 when the drive is null (skipped).
   */
  addDrive(
    drive: DriveTweenTarget | null,
    from: number,
    to: number,
    t0: number,
    duration: number,
  ): TweenHandle {
    if (!drive) return -1; // null drive → skip (V4)
    const idx = this._rent();
    const r = this._pool[idx];
    r.active = true;
    r.kind = 'drive';
    r.t0 = t0;
    r.t1 = t0 + Math.max(0.001, duration); // duration=0 guard (V4)
    r.posTarget = null;
    r.driveTarget = drive;
    r.fromScalar = from;
    r.toScalar = to;
    this._active.push(idx);
    return this._encode(idx, r.gen);
  }

  /**
   * Cancel a tween (e.g. its DES event was cancelled). Frees the pooled record
   * so a stale tween can never keep animating an MU (V4). Stale or already-freed
   * handles are ignored via the generation check.
   */
  cancel(handle: TweenHandle): void {
    if (handle < 0) return;
    const idx = this._decodeIdx(handle);
    const gen = this._decodeGen(handle);
    const r = this._pool[idx];
    if (!r || !r.active || r.gen !== gen) return; // stale / double-cancel
    this._freeRecord(idx);
    // Remove from the active list (linear scan — cancels are rare vs. renders).
    const ai = this._active.indexOf(idx);
    if (ai >= 0) this._active.splice(ai, 1);
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  /**
   * Interpolate every active tween at `simNow`. Finished tweens write their
   * final value once, then are returned to the pool. In `fastforward` mode NO
   * transform is written (Plan 194 §3.2) — but finished tweens are still reaped
   * so the pool does not leak.
   */
  onRender(simNow: number, subMode: TweenSubMode): void {
    const noWrite = subMode === 'fastforward';
    const active = this._active;
    let write = 0; // compaction write cursor

    for (let read = 0; read < active.length; read++) {
      const idx = active[read];
      const r = this._pool[idx];
      if (!r.active) continue; // defensive (cancel compacts already)

      const p = clamp01((simNow - r.t0) / (r.t1 - r.t0));

      if (!noWrite) {
        if (r.kind === 'pos' && r.posTarget) {
          _scratch.lerpVectors(r.fromVec, r.toVec, p);
          r.posTarget.setPosition(_scratch);
        } else if (r.kind === 'drive' && r.driveTarget) {
          r.driveTarget.setPosition(r.fromScalar + (r.toScalar - r.fromScalar) * p);
        }
      }

      if (simNow >= r.t1) {
        // Finished — reap into the pool (do NOT keep in the active list).
        this._freeRecord(idx);
      } else {
        // Still running — keep (compact in place).
        active[write++] = idx;
      }
    }

    active.length = write;
  }

  /** Free every active tween (Reset-on-Switch / dispose). */
  clear(): void {
    for (const idx of this._active) this._freeRecord(idx);
    this._active.length = 0;
  }

  // ─── Pool internals ────────────────────────────────────────────────────

  private _grow(by: number): void {
    const start = this._pool.length;
    for (let i = 0; i < by; i++) {
      this._pool.push({
        active: false, kind: '', t0: 0, t1: 0,
        posTarget: null, driveTarget: null,
        fromVec: new Vector3(), toVec: new Vector3(),
        fromScalar: 0, toScalar: 0, gen: 0,
      });
      this._free.push(start + i);
    }
  }

  /** Rent a free pool index, growing the pool if exhausted. */
  private _rent(): number {
    if (this._free.length === 0) this._grow(this._pool.length); // geometric
    return this._free.pop()!;
  }

  /** Return a record to the pool (bumps its generation to invalidate handles). */
  private _freeRecord(idx: number): void {
    const r = this._pool[idx];
    r.active = false;
    r.kind = '';
    r.posTarget = null;
    r.driveTarget = null;
    r.gen++;
    this._free.push(idx);
  }

  // Handle = (idx << 20) | gen — packs the generation so a freed-and-reused
  // record's old handle is detected as stale on cancel. (idx is small; 20 bits
  // of generation is ample for a per-record monotonic counter.)
  private _encode(idx: number, gen: number): TweenHandle {
    return (idx << 20) | (gen & 0xfffff);
  }
  private _decodeIdx(handle: TweenHandle): number {
    return handle >>> 20;
  }
  private _decodeGen(handle: TweenHandle): number {
    return handle & 0xfffff;
  }
}
