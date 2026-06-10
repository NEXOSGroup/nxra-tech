// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * transit-timing.ts — reusable DES transit-timing geometry for transport
 * components (conveyors, curves, spirals).
 *
 * Extracted verbatim from `Conveyor.ts` (`resolveSpeed` / `resolveLength` /
 * `resolveTiming` / `transitTween`). `createTransitTimer(self, belt, sensor)`
 * resolves the belt speed (mm/s), the belt length (mm), the entry/exit world
 * positions for the in-transit tween, and `timeToSensor` (seconds entry →
 * sensor, else full transit). It is generic for any transit-based transport
 * component and produces values identical to the original Conveyor logic.
 *
 * Speed/length come from the belt drive's `TargetSpeed` and the schema fields
 * (`ConveyorSpeed`, `ConveyorLength`, `CalculatedArcLength`) read via
 * `readConfigNumber(self, …)`. Geometry comes from the belt node's world bounds
 * along its longest axis. World units are metres → ×1000 for the sensor
 * distance, exactly as the C#-DES does.
 */

import { Box3, Vector3 } from 'three';
import type { Object3D } from 'three';
import {
  readConfigNumber,
  type MaterialFlowSelf,
  type MU,
  type TweenSpec,
} from '../../core/material-flow/material-flow-self';

/**
 * Resolved transit-timing model for one transport component. All values are in
 * the same units the C#-DES uses (mm, mm/s, s); world positions are in metres
 * (the GLB/Three scene unit), matching the tween targets.
 */
export interface TransitTimer {
  /** Seconds entry → sensor (dist/speed); full `length/speed` when sensor unresolvable. ≥ 0.001. */
  readonly timeToSensor: number;
  /** Belt speed in mm/s (≥ 0.001), preferring the belt drive's `TargetSpeed`. */
  readonly speed: number;
  /** Belt length in mm (`CalculatedArcLength` || `ConveyorLength` || bounds extent || 1). */
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

// Pre-allocated scratch values — no per-call allocation (mirrors Conveyor.ts).
const _box = new Box3();
const _v = new Vector3();

/**
 * Resolve the belt speed (mm/s) for the DES transit time. Prefers the live belt
 * drive's `TargetSpeed` (so a configured drive speed wins), falling back to the
 * schema `ConveyorSpeed`. Division-protected like the C#-DES (`Math.max(0.001)`).
 */
function resolveSpeed(self: MaterialFlowSelf<unknown>, belt: Object3D): number {
  const driveSpeed = self.drive(belt)?.TargetSpeed;
  const speed = driveSpeed && driveSpeed > 0
    ? driveSpeed
    : readConfigNumber(self, 'ConveyorSpeed', 0);
  return Math.max(0.001, speed > 0 ? speed : readConfigNumber(self, 'ConveyorSpeed', 200));
}

/**
 * Resolve the belt length (mm): `CalculatedArcLength` (curves) wins, else
 * `ConveyorLength`, else a geometric fallback from the belt node's world bounds.
 */
function resolveLength(self: MaterialFlowSelf<unknown>, belt: Object3D): number {
  const arc = readConfigNumber(self, 'CalculatedArcLength', 0);
  if (arc > 0) return arc;
  const len = readConfigNumber(self, 'ConveyorLength', 0);
  if (len > 0) return len;
  // Geometric fallback: longest world-bounds extent of the belt node (mm).
  _box.makeEmpty();
  _box.expandByObject(belt);
  if (!_box.isEmpty()) {
    _box.getSize(_v);
    const longest = Math.max(_v.x, _v.y, _v.z);
    if (longest > 0) return longest;
  }
  return 1; // last-resort positive length (keeps transit time finite)
}

/**
 * Create a reusable transit timer over `self`, the resolved `belt` transport
 * node, and an optional `sensor` node. Computes the timing model immediately;
 * call `refresh()` to recompute after a speed/topology change.
 */
export function createTransitTimer(
  self: MaterialFlowSelf<unknown>,
  belt: Object3D,
  sensor: Object3D | null,
): TransitTimer {
  let speed = 0.001;
  let length = 1;
  let timeToSensor = 0.001;
  let entryPos: [number, number, number] = [0, 0, 0];
  let exitPos: [number, number, number] = [0, 0, 0];

  function compute(): void {
    speed = resolveSpeed(self, belt);
    length = resolveLength(self, belt);

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

    // timeToSensor: distance entry → sensor / speed, else the full length / speed.
    let distToSensor = length;
    if (sensor) {
      sensor.getWorldPosition(_v);
      const d = _v.distanceTo(entry) * 1000; // m → mm (world units are metres)
      if (d > 0) distToSensor = d;
    }
    timeToSensor = Math.max(0.001, distToSensor / speed);
  }

  compute();

  return {
    get timeToSensor(): number { return timeToSensor; },
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
