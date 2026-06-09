// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Vector3 } from 'three';
import type { Scene } from 'three';
import { RVTransportSurface } from './rv-transport-surface';
import type { RVSensor } from './rv-sensor';
import type { RVSource } from './rv-source';
import type { RVSink } from './rv-sink';
import type { RVGrip } from './rv-grip';
import type { RVGripTarget } from './rv-grip-target';
import type { RVMovingUnit, InstancedMovingUnit } from './rv-mu';
import { debug } from './rv-debug';

// Pre-allocated scratch for the driver-selection direction gate (no GC in the
// per-tick transport hot path; single-threaded reuse is safe).
const _pickDir = new Vector3();
const _pickToMu = new Vector3();

/**
 * RVTransportManager - Central coordinator for transport simulation.
 *
 * Manages the update order: Sources -> Transport -> Sensors -> Sinks.
 * Called from SimulationLoop.onFixedUpdate.
 */
export class RVTransportManager {
  surfaces: RVTransportSurface[] = [];
  sensors: RVSensor[] = [];
  sources: RVSource[] = [];
  sinks: RVSink[] = [];
  grips: RVGrip[] = [];
  gripTargets: RVGripTarget[] = [];
  mus: (RVMovingUnit | InstancedMovingUnit)[] = [];
  scene: Scene | null = null;

  /** Monotonic tick counter shared with RVTransportSurface for per-tick world-direction refresh. */
  private _tickId = 0;

  /** When false, sources do NOT spawn new MUs (the rest of the simulation —
   *  transport, sensors, sinks — keeps running). The Layout-Planner sets this
   *  false while active so editing/dragging sources doesn't scatter spawned
   *  instances; the always-visible source ghost represents the source instead. */
  spawnEnabled = true;

  /** When true, sources spawn CLONE MUs (real Object3Ds) even if their template
   *  could be instanced. The Layout-Planner sets this while active so spawned
   *  MUs have a real node to register as a selectable scene object (instanced
   *  MUs have no per-instance Object3D). Reset to false on planner exit. */
  preferCloneMU = false;

  /**
   * Enable/disable source spawning. When disabling, each source immediately
   * shows its held "showcase" preview instance (the paused sim loop won't build
   * it). When re-enabling, the held previews are released by the next source
   * update (the first real spawn).
   */
  setSpawnEnabled(enabled: boolean): void {
    this.spawnEnabled = enabled;
    if (!enabled) {
      for (const source of this.sources) source.showPreview();
    }
  }

  /** Total MUs spawned since start */
  totalSpawned = 0;
  /** Total MUs consumed by sinks since start */
  totalConsumed = 0;

  /** Hard safety ceiling on simultaneously-live MUs. A source feeding a belt
   *  with no downstream sink (or a jammed line) would otherwise spawn without
   *  bound until the tab runs out of memory. At the cap, sources hold their
   *  preview instead of spawning and resume automatically once MUs drain. */
  maxLiveMUs = 5000;
  private _muCapWarned = false;

  /**
   * Main update loop - called every fixed timestep (16.67ms @ 60Hz).
   *
   * Order matters:
   * 1. Sources spawn new MUs
   * 2. Update surface AABBs
   * 3. Transport: each MU is moved by exactly one surface (currentSurface tracking)
   * 4. Update MU AABBs (after transport moved them)
   * 5. Sensors check overlap with MUs
   * 6. Sinks mark overlapping MUs for removal
   * 7. Remove marked MUs (reverse iteration, swap-and-pop)
   */
  update(dt: number): void {
    // Bump the global transport tick id — RVTransportSurface uses this to
    // lazily refresh its world-space direction once per tick (so MUs follow
    // the belt even when a parent drive rotates the platform).
    RVTransportSurface.beginTick(++this._tickId);

    // 1. Sources: spawn new MUs. When spawning is disabled (e.g. the
    //    Layout-Planner is active) the source instead shows a held "showcase"
    //    instance at its origin and does not spawn; the frame spawning
    //    re-enables, the held instance is released as the first real MU.
    const atCap = this.mus.length >= this.maxLiveMUs;
    if (atCap && !this._muCapWarned) {
      this._muCapWarned = true;
      console.warn(`[TransportManager] live-MU cap of ${this.maxLiveMUs} reached — sources are holding. Check for a missing/blocked Sink downstream.`);
    } else if (!atCap && this._muCapWarned && this.mus.length < this.maxLiveMUs * 0.9) {
      // Re-arm the warning once the line has clearly drained (hysteresis).
      this._muCapWarned = false;
    }
    for (const source of this.sources) {
      // Pass spawning-disabled while at the cap so sources show their preview
      // instead of spawning; they resume automatically as MUs drain.
      const mu = source.update(dt, this.spawnEnabled && !atCap, this.preferCloneMU);
      if (mu) {
        this.mus.push(mu);
        this.totalSpawned++;
        debug('transport', `Source "${source.node.name}" spawned MU #${this.totalSpawned}: "${mu.getName()}"`);
      }
    }

    // 2. Update surface AABBs every tick. Surfaces under a rotating parent
    //    (e.g. a turntable platform's belt orbiting Drive-Rot-Y) move with
    //    each fixed step — their AABB centre tracks the parent rotation only
    //    if `updateAABB` is called per tick. The cost is one getWorldPosition
    //    + one quaternion multiply per surface per tick — negligible.
    for (const surface of this.surfaces) {
      surface.updateAABB();
    }

    // 3. Transport: each MU is moved by exactly one surface (currentSurface)
    //    Skip gripped MUs — they move with the grip node via Three.js parent chain
    const tickId = RVTransportSurface.currentTickId;
    for (const mu of this.mus) {
      if (mu.markedForRemoval) continue;
      if (!mu.isInstanced && (mu as RVMovingUnit).isGripped) continue;

      // Pick the single surface that drives this MU this tick. When a good
      // straddles two belts (a hand-off), an ACTIVE (running) overlapping surface
      // wins so a stopped upstream belt never freezes a good the downstream belt
      // is ready to pull. See `_pickDrivingSurface` for the full priority.
      const prev = mu.currentSurface;
      const driver = this._pickDrivingSurface(mu);
      if (driver) {
        if (driver !== prev) {
          // Ownership changed — clear the carry marker so `transportMU` doesn't
          // apply a phantom parent-rotation delta on the entry tick (its carry
          // guard fires only when `lastSurfaceTickId === tickId - 1`).
          mu.lastSurfaceTickId = undefined;
          mu.currentSurface = driver;
          if (driver !== prev) debug('transport', `MU "${mu.getName()}" entered surface "${driver.node.name}"`);
        }
        driver.transportMU(mu, dt);
        // Tag AFTER the call so a STAY sees the previous tick's value (carry),
        // while a SWITCH already reset it to undefined above (no phantom carry).
        mu.lastSurfaceTickId = tickId;
      } else {
        mu.currentSurface = null;
        mu.lastSurfaceTickId = undefined;
      }
    }

    // 3b. Grips: flank detection → pick/place
    for (const grip of this.grips) {
      grip.fixedUpdate();
    }

    // 4. Update MU AABBs after transport
    for (const mu of this.mus) {
      if (!mu.markedForRemoval) {
        mu.updateAABB();
      }
    }

    // 5. Sensors: check overlap
    for (const sensor of this.sensors) {
      sensor.updateAABB();
      sensor.checkOverlap(this.mus);
    }

    // 6. Sinks: mark overlapping MUs (skip gripped MUs)
    for (const sink of this.sinks) {
      sink.updateAABB();
      sink.markOverlapping(this.mus);
    }

    // 7. Remove marked MUs (reverse iteration, swap-and-pop — no splice!)
    for (let i = this.mus.length - 1; i >= 0; i--) {
      if (this.mus[i].markedForRemoval) {
        const removedMU = this.mus[i];
        // Notify grips of MU disposal
        if (!removedMU.isInstanced) {
          for (const grip of this.grips) {
            grip.onMUDisposed(removedMU as RVMovingUnit);
          }
        }
        // Clear gripTarget occupancy if this MU was placed on one
        for (const target of this.gripTargets) {
          if (target.occupiedBy === removedMU) {
            target.clearOccupied();
          }
        }
        removedMU.dispose();
        this.totalConsumed++;
        // Swap with last element and pop
        this.mus[i] = this.mus[this.mus.length - 1];
        this.mus.pop();
      }
    }

    // 8. Batch-update instance matrices after all position changes
    this.updatePoolMatrices();
  }

  /**
   * Choose the one surface that drives `mu` this tick among all it overlaps (XZ).
   * A good is always carried by exactly one surface (no double-driving); the
   * question is which, when it touches several at once during a hand-off.
   *
   * Priority:
   *  1. Keep the current surface if it still overlaps AND is active — sticky
   *     ownership avoids churn and keeps a moving good on its belt.
   *  2. Otherwise an ACTIVE overlapping surface that the good is ENTERING — the
   *     downstream belt pulls the good IN off a stopped upstream belt (the
   *     reported hand-off bug). The "entering" gate is what stops a still-running
   *     UPSTREAM belt from shoving a good that has just halted at its sensor
   *     further forward (the intermittent ~15 cm overshoot at a seam).
   *  3. Otherwise the current overlapping surface even if stopped (a good waiting
   *     in accumulation, or a centered good carried by a rotating turntable
   *     platform), else the first overlapping stopped surface.
   *  4. null when the MU overlaps no surface.
   *
   * Attachment stays purely geometric — a stopped belt is still a valid owner, so
   * a good keeps its place and starts moving the instant that belt's drive runs.
   */
  private _pickDrivingSurface(mu: RVMovingUnit | InstancedMovingUnit): RVTransportSurface | null {
    const curr = mu.currentSurface;
    const currOverlaps = !!curr && curr.aabb.overlapsXZ(mu.aabb);
    if (curr && currOverlaps && curr.isActive) return curr;            // (1)

    let stoppedFallback: RVTransportSurface | null = currOverlaps ? curr : null;
    for (const s of this.surfaces) {
      if (!s.aabb.overlapsXZ(mu.aabb)) continue;
      if (s.isActive && this._goodIsEntering(s, mu)) return s;          // (2) downstream belt pulls it IN
      if (!stoppedFallback) stoppedFallback = s;                       // first stopped (or upstream-only) overlap
    }
    return stoppedFallback;                                            // (3) / (4)
  }

  /**
   * True when surface `s`'s motion would carry `mu` DEEPER into `s` (a downstream
   * pull), false when `s` would only shove an already-exiting good further out (an
   * upstream drag). Used to gate hand-off to a non-current active surface during a
   * seam straddle, so a running upstream belt can't drag a good past the sensor it
   * just stopped at. Rule (1) handles a good travelling along its OWN active belt,
   * so this never gates normal mid-belt motion.
   */
  private _goodIsEntering(s: RVTransportSurface, mu: RVMovingUnit | InstancedMovingUnit): boolean {
    // Actual motion direction (sign(speed) handles a reversed belt).
    s.getWorldDirection(_pickDir).multiplyScalar(Math.sign(s.speed));
    _pickToMu.copy(mu.aabb.center).sub(s.aabb.center);
    return _pickDir.dot(_pickToMu) <= 0;                               // mu behind centre along motion → entering
  }

  /**
   * Immediately remove a single MU from the simulation (full cleanup: grip
   * notification, gripTarget release, dispose, list removal). Unlike setting
   * `markedForRemoval`, this works even when the sim is PAUSED (the removal
   * loop in `update()` never runs while paused) — used by the Layout-Planner
   * to delete a selected MU on demand. Idempotent: a no-op if the MU isn't
   * currently tracked.
   */
  removeMU(mu: RVMovingUnit | InstancedMovingUnit): void {
    const idx = this.mus.indexOf(mu);
    if (idx < 0) return;

    if (!mu.isInstanced) {
      for (const grip of this.grips) {
        grip.onMUDisposed(mu as RVMovingUnit);
      }
    }
    for (const target of this.gripTargets) {
      if (target.occupiedBy === mu) target.clearOccupied();
    }
    mu.dispose();
    this.totalConsumed++;

    // Swap-and-pop (matches the update() removal loop).
    this.mus[idx] = this.mus[this.mus.length - 1];
    this.mus.pop();

    // Refresh instanced pool matrices so a released slot stops rendering at
    // its stale position right away (clone removal already detached the node).
    if (mu.isInstanced) this.updatePoolMatrices();
  }

  /** Get counts for stats display */
  get stats() {
    let occupiedSensors = 0;
    for (const s of this.sensors) {
      if (s.occupied) occupiedSensors++;
    }
    return {
      mus: this.mus.length,
      sensors: this.sensors.length,
      sensorsOccupied: occupiedSensors,
      surfaces: this.surfaces.length,
      sources: this.sources.length,
      sinks: this.sinks.length,
      totalSpawned: this.totalSpawned,
      totalConsumed: this.totalConsumed,
    };
  }

  /**
   * Animate conveyor belt textures (scroll UV based on drive speed).
   * Called separately from update() so it also runs when the physics plugin handles transport.
   */
  updateTextureAnimations(dt: number): void {
    for (const surface of this.surfaces) {
      surface.updateTextureAnimation(dt);
    }
  }

  /**
   * Update all instance pool matrices after transport tick.
   * Call once per frame after all MU positions have been updated.
   */
  updatePoolMatrices(): void {
    for (const source of this.sources) {
      if (source.pool) {
        source.pool.updateInstanceMatrix();
      }
    }
  }

  /** Reset all state */
  reset(): void {
    // Reset grips before disposing MUs (so they release references cleanly)
    for (const grip of this.grips) {
      grip.reset();
    }
    for (const target of this.gripTargets) {
      target.clearOccupied();
    }
    for (const mu of this.mus) {
      mu.dispose();
    }
    this.mus.length = 0;
    this.totalSpawned = 0;
    this.totalConsumed = 0;
    for (const sensor of this.sensors) {
      sensor.occupied = false;
      sensor.occupiedMU = null;
    }
    // Dispose each source — frees its pause-ghost (plan-180), floor marker
    // (plan-181: ring/label geometry, material, CanvasTexture) and any other
    // per-source GPU resources. Without this, every `clearModel()` leaks
    // those resources for every source in the previous scene.
    for (const source of this.sources) {
      source.dispose?.();
    }
    // Dispose instance pools
    for (const source of this.sources) {
      if (source.pool) {
        source.pool.dispose();
      }
    }
  }
}
