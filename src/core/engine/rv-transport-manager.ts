// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Vector3 } from 'three';
import type { Scene, Object3D } from 'three';
import { RVTransportSurface } from './rv-transport-surface';
import type { RVSensor } from './rv-sensor';
import type { RVSource } from './rv-source';
import type { RVSink } from './rv-sink';
import type { RVGrip } from './rv-grip';
import type { RVGripTarget } from './rv-grip-target';
import type { RVMovingUnit, InstancedMovingUnit } from './rv-mu';
import type { AABB } from './rv-aabb';
import { createMUDissolve, createMUGrow } from './rv-mu-dissolve';
import { debug } from './rv-debug';

// Pre-allocated scratch for the driver-selection direction gate (no GC in the
// per-tick transport hot path; single-threaded reuse is safe).
const _pickDir = new Vector3();
const _pickToMu = new Vector3();
// Scratch for the end-of-line dead-end probe (single-threaded reuse, no GC).
const _deadEndDir = new Vector3();
// Scratch for the spawn grow-out effect setup/update (single-threaded reuse, no GC).
const _growDir = new Vector3();

/** True when `surface` belongs to a planner-placed layout object — its node (or
 *  any ancestor) carries the `_layoutObject` tag the layout planner propagates to
 *  every descendant of a placed asset. End-of-line vanish is scoped to these, so
 *  MUs reaching a dead end on the authored GLB scene are never deleted. */
function surfaceIsLayoutObject(surface: RVTransportSurface): boolean {
  let cur: Object3D | null = surface.node;
  while (cur) {
    if (cur.userData?._layoutObject === true) return true;
    cur = cur.parent;
  }
  return false;
}
const _growOrigin = new Vector3();
const _growPlane = new Vector3();

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

  /** Reused scratch for the per-MU overlapping-surface scan (no per-tick alloc). */
  private readonly _overlapScratch: RVTransportSurface[] = [];

  /** Reused scratch for the dead-end junction group (current surface + stacked
   *  transfer siblings). No per-tick allocation. */
  private readonly _deadEndGroup: RVTransportSurface[] = [];

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

  /** When true, an MU sitting at a DEAD END — the end of a line with no
   *  successor surface ahead of it — is deleted after `vanishDelaySec`. Covers
   *  both an MU parked on a stopped discharge belt (held by an end-stop sensor)
   *  and one that ran off the belt entirely. SCOPED to planner-placed layout
   *  objects: an MU reaching a dead end on the authored GLB scene is left alone
   *  (only MUs whose surface belongs to a layout object vanish — see
   *  `mu.onLayoutObject` / `surfaceIsLayoutObject`). Off by default; toggled from
   *  the Layout-Planner toolbar via `RVViewer.setVanishMUs`. */
  vanishMUsAtEndOfLine = false;
  /** Injected by the viewer: returns true when `surface`'s OUTGOING snap point is
   *  connected to another asset. Gates the end-of-line vanish so a connected
   *  successor (e.g. a rotated turntable whose footprint no longer geometrically
   *  overlaps the discharge edge) never causes a false vanish. Null when no snap
   *  system is wired → geometry-only behaviour (unchanged). The engine must not
   *  depend on the snap-point plugin, hence the injected predicate. */
  isOutputConnected: ((surface: RVTransportSurface) => boolean) | null = null;
  /** Seconds an MU must dwell at a dead end before it vanishes (tolerates a
   *  brief stop at a hand-off; gives freshly-spawned MUs time to reach a belt). */
  readonly vanishDelaySec = 2;
  /** How far ahead of an MU's leading edge (metres, along its surface's
   *  transport direction) to probe for a successor surface. No surface there →
   *  dead end. Large enough to clear the discharge edge / a small inter-belt
   *  gap; successor belts overlap the current one at the seam so a real
   *  successor is always found and false positives are avoided. */
  readonly vanishProbeAheadM = 0.3;
  /** Seconds the sci-fi burn dissolve plays after the dwell delay, before the
   *  MU is finally removed. */
  readonly vanishDurationSec = 0.6;
  /** True while at least one MU is mid-dissolve — the viewer uses this to keep
   *  the (otherwise on-demand) renderer awake so the burn animates. */
  private _hasVanishing = false;

  /** True while at least one MU is mid grow-out (keeps the renderer awake while
   *  it is actually moving). A freshly spawned clone MU starts fully clipped and
   *  physically slides out of a fixed world clip plane at the source as it
   *  travels — the stripe stays put, the MU emerges through it. Distance/vector
   *  based, NOT timed; a stopped belt freezes it mid-emerge. Instanced MUs have
   *  no per-instance material so they skip it. */
  private _hasGrowing = false;

  /** True while any MU effect (vanish dissolve OR spawn grow-out) is animating —
   *  the viewer keeps the on-demand renderer awake while this holds. */
  get hasVanishingMU(): boolean { return this._hasVanishing || this._hasGrowing; }

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
        this._startGrow(mu, source);
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
    this._hasVanishing = false; // recomputed below while any MU is mid-dissolve
    this._hasGrowing = false;   // recomputed below while any MU is mid grow-out
    for (const mu of this.mus) {
      if (mu.markedForRemoval) continue;

      // Spawn grow-out: a freshly-spawned clone MU plays a short clip effect that
      // grows it out of the source along its move direction. Purely visual — it
      // runs independent of transport/grip/vanish below (a gripped MU keeps
      // growing too; the effect is brief).
      if (!mu.isInstanced && (mu as RVMovingUnit).grow) this._advanceGrow(mu as RVMovingUnit);

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
          debug('transport', `MU "${mu.getName()}" entered surface "${driver.node.name}"`);
        }
        driver.transportMU(mu, dt);
        // Tag AFTER the call so a STAY sees the previous tick's value (carry),
        // while a SWITCH already reset it to undefined above (no phantom carry).
        mu.lastSurfaceTickId = tickId;
        // Remember it has been transported (gates the end-of-line vanish so
        // freshly-spawned MUs not yet on a belt are never deleted).
        mu.everOnSurface = true;
        // Remember whether the surface it's on belongs to a planner-placed
        // layout object — vanish is scoped to those. Latched while it HAS a
        // surface so it survives the moment the MU runs off (currentSurface null).
        mu.onLayoutObject = surfaceIsLayoutObject(driver);
        // Latch the driving surface so the dead-end vanish can check ITS
        // outgoing-snap connectivity even after the MU runs off (currentSurface
        // becomes null).
        mu.lastSurface = driver;
      } else {
        mu.currentSurface = null;
        mu.lastSurfaceTickId = undefined;
      }

      // End-of-line vanish: an MU that has been transported and now sits at a
      // dead end (no successor surface ahead — parked on a stopped discharge
      // belt OR run off the end entirely) is deleted after `vanishDelaySec`.
      // SCOPED to layout objects: MUs reaching a dead end on the authored GLB
      // scene are left alone (only planner-placed lines vanish their MUs).
      // Gripped MUs never reach here (skipped above). The timer resets the
      // instant the MU advances onto / toward another surface.
      if (this.vanishMUsAtEndOfLine && mu.everOnSurface && mu.onLayoutObject
          && this._isAtDeadEnd(mu) && !this._outputConnected(mu)) {
        mu.offSurfaceTime = (mu.offSurfaceTime ?? 0) + dt;
        if (mu.offSurfaceTime >= this.vanishDelaySec) this._advanceVanish(mu, dt);
      } else {
        mu.offSurfaceTime = 0;
        // Picked up again before the dissolve finished — cancel it and restore
        // the MU's normal look.
        if (!mu.isInstanced) {
          const m = mu as RVMovingUnit;
          if (m.dissolve) {
            m.dissolve.dispose();
            m.dissolve = null;
            m.vanishElapsed = undefined;
          }
        }
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
   * A good always rests on the TOPMOST surface beneath it: among all surfaces it
   * overlaps in XZ, only those whose top is within `TOP_EPS` of the highest top
   * are eligible. For a normal line (coplanar belts at a seam) every top is equal
   * so the band holds them all and the priority below is unchanged; for STACKED
   * surfaces — the ChainTransfer's fixed Z rollers and its lifting X chains — the
   * good is handed to whichever is currently on top (chains while raised, rollers
   * once the lift drops below them).
   *
   * Within the topmost band, priority:
   *  1. Keep the current surface if it is in the band AND active — sticky
   *     ownership avoids churn and keeps a moving good on its belt.
   *  2. Otherwise an ACTIVE band surface that the good is ENTERING — the
   *     downstream belt pulls the good IN off a stopped upstream belt. The
   *     "entering" gate stops a still-running UPSTREAM belt from shoving a good
   *     that just halted at its sensor further forward.
   *  3. Otherwise the current band surface even if stopped, else the first band
   *     surface.
   *  4. null when the MU overlaps no surface.
   *
   * Attachment stays purely geometric — a stopped belt is still a valid owner, so
   * a good keeps its place and starts moving the instant that belt's drive runs.
   */
  private _pickDrivingSurface(mu: RVMovingUnit | InstancedMovingUnit): RVTransportSurface | null {
    // World positions are metres; stacked ChainTransfer surfaces differ by ≥1 cm,
    // coplanar line belts by ≤ a few mm — 5 mm cleanly separates the two.
    const TOP_EPS = 0.005;

    const overlapping = this._overlapScratch;
    overlapping.length = 0;
    let topY = -Infinity;
    for (const s of this.surfaces) {
      if (!s.aabb.overlapsXZ(mu.aabb)) continue;
      overlapping.push(s);
      if (s.aabb.max.y > topY) topY = s.aabb.max.y;
    }
    if (overlapping.length === 0) return null;                          // (4)
    const minTop = topY - TOP_EPS;

    const curr = mu.currentSurface;
    const currInBand = !!curr && overlapping.includes(curr) && curr.aabb.max.y >= minTop;
    if (currInBand && curr!.isActive) return curr!;                     // (1)

    let stoppedFallback: RVTransportSurface | null = currInBand ? curr! : null;
    for (const s of overlapping) {
      if (s.aabb.max.y < minTop) continue;                             // not the topmost surface
      if (s.isActive && this._goodIsEntering(s, mu)) return s;          // (2)
      if (!stoppedFallback) stoppedFallback = s;                       // (3)
    }
    return stoppedFallback;
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
   * Drive the end-of-line dissolve for an MU whose dwell delay has expired.
   * Instanced MUs have no per-instance material, so they're removed instantly.
   * Clone MUs play a short sci-fi burn (bottom-to-top world-Y clip) and are
   * removed only once it completes.
   */
  /**
   * Begin the spawn grow-out effect on a freshly-spawned MU. Clip-based, so only
   * clone-path MUs (real per-mesh materials) get it; instanced MUs are skipped.
   * Anchors a FIXED world clip plane at the MU's leading edge along the source's
   * horizontal discharge direction — the MU then physically slides out of that
   * static plane as it travels (the stripe stays put). No-ops when the source has
   * no surface direction (free-standing source).
   */
  private _startGrow(mu: RVMovingUnit | InstancedMovingUnit, source: RVSource): void {
    if (mu.isInstanced) return;
    if (!source.getDischargeDirection(_growDir)) return; // free-standing source → no effect

    const m = mu as RVMovingUnit;
    m.updateAABB(); // freshly constructed — make sure center/halfSize are world-current
    m.node.getWorldPosition(_growOrigin);

    // MU extent along the discharge axis, relative to the node origin. Axis is
    // horizontal (y=0), so only x/z contribute to the half-extent radius.
    const c = m.aabb.center;
    const h = m.aabb.halfSize;
    const cOff = (c.x - _growOrigin.x) * _growDir.x + (c.z - _growOrigin.z) * _growDir.z;
    const r = Math.abs(_growDir.x) * h.x + Math.abs(_growDir.z) * h.z;

    // Clip plane fixed in world at the leading edge (node origin + (cOff+r) along
    // the axis) → the whole MU starts behind the plane (fully clipped). The
    // trailing edge sits at (cOff - r) relative to the node origin.
    _growPlane.copy(_growOrigin).addScaledVector(_growDir, cOff + r);
    m.grow = createMUGrow(m.node, _growDir, _growPlane, cOff - r);
    this._hasGrowing = true;
  }

  /**
   * Re-evaluate the spawn grow-out effect for `m` against its current world
   * position. The clip plane is fixed in world, so there is nothing to animate —
   * we only detect full emergence (dispose, restoring materials) and keep the
   * renderer awake while the MU is still moving through the plane. Visual only:
   * AABB / sensors / sinks always see the full MU.
   */
  private _advanceGrow(m: RVMovingUnit): void {
    if (!m.grow) return;
    m.node.getWorldPosition(_growOrigin);
    const { finished, moved } = m.grow.update(_growOrigin);
    if (finished) {
      m.grow.dispose();
      m.grow = null;
    } else if (moved) {
      this._hasGrowing = true; // keep the renderer awake while it emerges
    }
  }

  private _advanceVanish(mu: RVMovingUnit | InstancedMovingUnit, dt: number): void {
    if (mu.isInstanced) {
      mu.markedForRemoval = true;
      return;
    }
    const m = mu as RVMovingUnit;
    if (!m.dissolve) {
      // Sweep the burn edge across the MU's current world-Y bounds.
      m.dissolve = createMUDissolve(m.node, m.aabb.min.y, m.aabb.max.y);
      m.vanishElapsed = 0;
    } else {
      m.vanishElapsed = (m.vanishElapsed ?? 0) + dt;
    }
    const p = (m.vanishElapsed ?? 0) / this.vanishDurationSec;
    m.dissolve.setProgress(p);
    if (p >= 1) {
      mu.markedForRemoval = true; // dispose() restores + frees the burn materials
    } else {
      this._hasVanishing = true;  // keep the renderer awake until the burn ends
    }
  }

  /**
   * True when `mu` sits at a DEAD END — the asset it is on has NO output in any
   * direction, so it is genuinely stuck (only then should it vanish).
   *
   *   • `currentSurface === null` — it already ran off all surfaces.
   *   • Plain belt: probing one MU-half + `vanishProbeAheadM` ahead along the
   *     belt's transport direction finds no surface beyond the discharge edge.
   *
   * Router assets (which can discharge in directions OTHER than the current
   * surface's transport axis) are handled so they are NOT wrongly vanished:
   *   • Turntable — a single `Radial` surface that rotates to any conveyor it
   *     touches; if it overlaps any other surface (an arm), output exists.
   *   • Chain-transfer — two surfaces STACKED on one footprint (rollers + cross
   *     chains) with perpendicular directions. They are grouped (their XZ
   *     overlap dominates a footprint) and the probe runs along EVERY group
   *     member's direction, so the sideways output is seen.
   *
   * Plain belt-to-belt seams overlap only slightly (below the grouping
   * threshold), so they stay external successors and the original single-belt
   * end-of-line behaviour is unchanged.
   */
  /**
   * True when the MU's current (or, after it ran off, most recent) surface has a
   * CONNECTED outgoing snap point — i.e. a real downstream successor exists even
   * if geometry says otherwise (a rotated turntable's footprint may no longer
   * overlap the discharge edge). Used to suppress the end-of-line vanish: a
   * connected line never vanishes its MUs; only a free discharge end does.
   * Returns false when no connectivity predicate is wired (geometry-only).
   */
  private _outputConnected(mu: RVMovingUnit | InstancedMovingUnit): boolean {
    if (!this.isOutputConnected) return false;
    const s = mu.currentSurface ?? mu.lastSurface ?? null;
    return s ? this.isOutputConnected(s) : false;
  }

  private _isAtDeadEnd(mu: RVMovingUnit | InstancedMovingUnit): boolean {
    const s = mu.currentSurface;
    if (!s) return true;                                  // ran off every surface

    // Junction group: the current surface + any surface STACKED on it (a
    // transfer junction whose sibling shares the same footprint). Plain seams
    // overlap only slightly and are NOT grouped — they remain external outputs.
    const group = this._deadEndGroup;
    group.length = 0;
    group.push(s);
    for (const surf of this.surfaces) {
      if (surf !== s && this._overlapFractionXZ(surf.aabb, s.aabb) >= 0.5) group.push(surf);
    }

    // Turntable: a radial surface discharges to whatever conveyor it touches.
    // Any overlap with a surface OUTSIDE the junction → an output exists.
    if (s.Radial) {
      for (const surf of this.surfaces) {
        if (group.includes(surf)) continue;
        if (surf.aabb.overlapsXZ(s.aabb)) return false;
      }
      return true;                                        // lone turntable, no arms → stuck
    }

    // Probe forward along EVERY junction member's direction. A hit on a group
    // member = the MU still has room to travel within this asset (not at the
    // edge yet); a hit on a surface OUTSIDE the group = a real successor.
    const c = mu.aabb.center;
    let roomAhead = false;
    for (const js of group) {
      const d = js.getWorldDirection(_deadEndDir);
      const muHalf = Math.abs(d.x) * mu.aabb.halfSize.x + Math.abs(d.z) * mu.aabb.halfSize.z;
      const reach = muHalf + this.vanishProbeAheadM;
      const px = c.x + d.x * reach;
      const pz = c.z + d.z * reach;
      for (const surf of this.surfaces) {
        const a = surf.aabb;
        if (px < a.min.x || px > a.max.x || pz < a.min.z || pz > a.max.z) continue;
        if (group.includes(surf)) roomAhead = true;       // still within this asset
        else return false;                                // external successor → not stuck
      }
    }
    return !roomAhead;
  }

  /**
   * Fraction (0–1) of the SMALLER footprint covered by the XZ overlap of two
   * surface AABBs. ~1 for stacked transfer siblings (same footprint), small for
   * belt-to-belt seams — the signal that separates a routing junction from
   * ordinary neighbours.
   */
  private _overlapFractionXZ(a: AABB, b: AABB): number {
    const ox = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
    const oz = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
    if (ox <= 0 || oz <= 0) return 0;
    const overlap = ox * oz;
    const areaA = (a.max.x - a.min.x) * (a.max.z - a.min.z);
    const areaB = (b.max.x - b.min.x) * (b.max.z - b.min.z);
    const fa = areaA > 0 ? overlap / areaA : 0;
    const fb = areaB > 0 ? overlap / areaB : 0;
    return Math.max(fa, fb);
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
