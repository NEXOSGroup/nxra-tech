// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * transit-timing.ts — reusable DES transit-timing geometry for transport
 * components (conveyors, curves, spirals).
 *
 * `createTransitTimer(self, belt)` resolves the belt speed (mm/s), the belt
 * length (mm), the entry/exit world positions for the in-transit tween, and
 * `transitTime` (seconds, entry → discharge over the FULL belt length).
 *
 * Why full length: in the continuous/physics view a part rides the surface to
 * the very end before the downstream picks it up — the sensor only gates ZPA
 * stop/run. The discharge sensor sits near the exit but not exactly at it, so
 * the DES transit must cover the whole belt (length / speed), NOT entry→sensor.
 * The sensor position therefore plays no part in the timing.
 *
 * Speed comes from the belt drive's `TargetSpeed` (mm/s), falling back to a
 * constant when no drive is configured. Length comes from the belt node's world
 * bounds along its longest axis: scene/world units are metres (the GLB unit), so
 * the extent is scaled ×1000 to millimetres to match the mm/s speed.
 */

import { Box3, Vector3 } from 'three';
import type { Object3D } from 'three';
import {
  type MaterialFlowSelf,
  type MU,
  type TweenSpec,
} from '../../core/material-flow/material-flow-self';

/** mm/s fallback when the belt has no configured drive (mirrors the Drive default). */
const DEFAULT_SPEED_MM_S = 200;
/** Scene/world units are metres (the GLB unit); ×1000 converts a length to mm. */
const METRES_TO_MM = 1000;

/**
 * Resolved transit-timing model for one transport component. Speed/length are in
 * the C#-DES units (mm/s, mm); world positions are in metres (the GLB/Three scene
 * unit), matching the tween targets.
 */
export interface TransitTimer {
  /** Seconds entry → discharge over the full belt (`length / speed`). ≥ 0.001. */
  readonly transitTime: number;
  /** Belt speed in mm/s (≥ 0.001), from the belt drive's `TargetSpeed`. */
  readonly speed: number;
  /** Belt length in mm (world-bounds extent ×1000, metres → mm). */
  readonly length: number;
  /** Entry world position for the in-transit tween (entry → exit). */
  readonly entryPos: [number, number, number];
  /** Exit world position for the in-transit tween. */
  readonly exitPos: [number, number, number];
  /** Build the straight entry→exit position-tween spec for an in-transit MU. */
  tween(mu: MU): TweenSpec;
  /** Recompute the timing model (e.g. after a speed / topology change). */
  refresh(): void;
}

// Pre-allocated scratch values — no per-call allocation.
const _box = new Box3();
const _v = new Vector3();

/**
 * Resolve the belt speed (mm/s) for the DES transit time from the live belt
 * drive's `TargetSpeed`, falling back to `DEFAULT_SPEED_MM_S` when there is no
 * drive (or it is non-positive). Division-protected (`Math.max(0.001, …)`).
 */
function resolveSpeed(self: MaterialFlowSelf<unknown>, belt: Object3D): number {
  const driveSpeed = self.drive(belt)?.TargetSpeed;
  return Math.max(0.001, driveSpeed && driveSpeed > 0 ? driveSpeed : DEFAULT_SPEED_MM_S);
}

/**
 * Resolve the belt length (mm) from the belt node's world bounds: the longest
 * extent ×1000 (metres → mm). Falls back to 1 mm only when the node carries no
 * renderable geometry (degenerate; keeps the transit time finite).
 */
function resolveLength(belt: Object3D): number {
  _box.makeEmpty();
  _box.expandByObject(belt);
  if (!_box.isEmpty()) {
    _box.getSize(_v);
    const longest = Math.max(_v.x, _v.y, _v.z);
    if (longest > 0) return longest * METRES_TO_MM;
  }
  return 1; // last-resort positive length (keeps transit time finite)
}

/**
 * Create a reusable transit timer over `self` and the resolved `belt` transport
 * node. Computes the timing model immediately; call `refresh()` to recompute
 * after a speed/topology change.
 */
export function createTransitTimer(
  self: MaterialFlowSelf<unknown>,
  belt: Object3D,
): TransitTimer {
  let speed = 0.001;
  let length = 1;
  let transitTime = 0.001;
  let entryPos: [number, number, number] = [0, 0, 0];
  let exitPos: [number, number, number] = [0, 0, 0];

  function compute(): void {
    speed = resolveSpeed(self, belt);
    length = resolveLength(belt);

    // Entry/exit world positions from the belt-node bounds along its longest axis.
    const entry = new Vector3();
    const exit = new Vector3();
    _box.makeEmpty();
    _box.expandByObject(belt);
    if (!_box.isEmpty()) {
      _box.getSize(_v);
      const cx = (_box.min.x + _box.max.x) * 0.5;
      const cy = (_box.min.y + _box.max.y) * 0.5;
      const cz = (_box.min.z + _box.max.z) * 0.5;
      // Span the longest axis (the transport direction in most belt layouts).
      if (_v.x >= _v.y && _v.x >= _v.z) {
        entry.set(_box.min.x, cy, cz); exit.set(_box.max.x, cy, cz);
      } else if (_v.z >= _v.x && _v.z >= _v.y) {
        entry.set(cx, cy, _box.min.z); exit.set(cx, cy, _box.max.z);
      } else {
        entry.set(cx, _box.min.y, cz); exit.set(cx, _box.max.y, cz);
      }
    } else {
      belt.getWorldPosition(entry); exit.copy(entry);
    }
    entryPos = [entry.x, entry.y, entry.z];
    exitPos = [exit.x, exit.y, exit.z];

    // Full-belt transit: length / speed. The discharge happens at the exit, so
    // the part travels the whole belt regardless of where the sensor sits.
    transitTime = Math.max(0.001, length / speed);
  }

  compute();

  return {
    get transitTime(): number { return transitTime; },
    get speed(): number { return speed; },
    get length(): number { return length; },
    get entryPos(): [number, number, number] { return entryPos; },
    get exitPos(): [number, number, number] { return exitPos; },
    tween(mu: MU): TweenSpec {
      return {
        tween: {
          kind: 'position',
          target: (mu as { visual?: unknown }).visual ?? null,
          from: entryPos,
          to: exitPos,
        },
      };
    },
    refresh(): void {
      compute();
    },
  };
}
