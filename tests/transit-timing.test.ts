// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * transit-timing.test.ts — value-parity gate for `_shared/transit-timing.ts`
 * (Plan 197 Step 2b).
 *
 * `createTransitTimer` extracts the DES transit geometry from `Conveyor.ts`
 * (`resolveSpeed` / `resolveLength` / `resolveTiming` / `transitTween`). This
 * test re-states that ORIGINAL Conveyor logic inline as a reference oracle and
 * asserts the extracted helper produces byte-identical `speed` / `length` /
 * `timeToSensor` / `entryPos` / `exitPos` for representative inputs:
 *   - a straight X belt with the sensor at the exit;
 *   - speed from the belt drive's TargetSpeed vs the schema ConveyorSpeed;
 *   - length from CalculatedArcLength vs ConveyorLength vs the bounds fallback;
 *   - the speed = 0 guard (→ 0.001);
 *   - the tween(mu) shape (kind 'position', from = entry, to = exit, target = mu.visual).
 *
 * Pure TypeScript — no private DES build, no GLB. Only the small `self` surface
 * the helper reads (`prop`, `drive(node)`) is mocked.
 */

import { describe, it, expect } from 'vitest';
import { Box3, Vector3, Mesh, BoxGeometry, Object3D } from 'three';
import { createTransitTimer } from '../src/behaviors/_shared/transit-timing';
import {
  readConfigNumber,
  type MaterialFlowSelf,
  type MU,
  type SelfDrive,
} from '../src/core/material-flow/material-flow-self';

// ─── Minimal `self` surface the helper reads (prop + drive(node)) ──────────

type DriveMap = Map<Object3D, Partial<SelfDrive>>;

function makeSelf(prop: Record<string, number>, drives: DriveMap = new Map()): MaterialFlowSelf<unknown> {
  // Only `prop` (read via readConfigNumber) and `drive(node)` are exercised by
  // createTransitTimer; everything else is an unused stub.
  const self = {
    prop: { ...prop } as Record<string, number>,
    drive(ref: unknown): SelfDrive | null {
      return (drives.get(ref as Object3D) as SelfDrive | undefined) ?? null;
    },
  };
  return self as unknown as MaterialFlowSelf<unknown>;
}

/**
 * A belt node carrying real geometry so `Box3.expandByObject` yields finite
 * world bounds. `BoxGeometry(w,h,d)` is centred on the origin → world bounds
 * span [-w/2,+w/2] etc. once world matrices are updated.
 */
function makeBeltMesh(w: number, h: number, d: number, pos?: [number, number, number]): Object3D {
  const mesh = new Mesh(new BoxGeometry(w, h, d));
  mesh.name = 'Transport-X';
  if (pos) mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.updateMatrixWorld(true);
  return mesh;
}

// ─── Reference oracle: the ORIGINAL Conveyor.ts logic, re-stated verbatim ───
// (Conveyor.ts lines ~111-216 — resolveSpeed / resolveLength / resolveTiming.)

const _refBox = new Box3();
const _refV = new Vector3();

function refResolveSpeed(self: MaterialFlowSelf<unknown>, belt: Object3D): number {
  const driveSpeed = self.drive(belt)?.TargetSpeed;
  const speed = driveSpeed && driveSpeed > 0
    ? driveSpeed
    : readConfigNumber(self, 'ConveyorSpeed', 0);
  return Math.max(0.001, speed > 0 ? speed : readConfigNumber(self, 'ConveyorSpeed', 200));
}

function refResolveLength(self: MaterialFlowSelf<unknown>, belt: Object3D): number {
  const arc = readConfigNumber(self, 'CalculatedArcLength', 0);
  if (arc > 0) return arc;
  const len = readConfigNumber(self, 'ConveyorLength', 0);
  if (len > 0) return len;
  _refBox.makeEmpty();
  _refBox.expandByObject(belt);
  if (!_refBox.isEmpty()) {
    _refBox.getSize(_refV);
    const longest = Math.max(_refV.x, _refV.y, _refV.z);
    if (longest > 0) return longest;
  }
  return 1;
}

interface RefTiming {
  speed: number;
  length: number;
  timeToSensor: number;
  entryPos: [number, number, number];
  exitPos: [number, number, number];
}

function refResolveTiming(
  self: MaterialFlowSelf<unknown>,
  belt: Object3D,
  sensor: Object3D | null,
): RefTiming {
  const speed = refResolveSpeed(self, belt);
  const length = refResolveLength(self, belt);

  const entry = new Vector3();
  const exit = new Vector3();
  _refBox.makeEmpty();
  _refBox.expandByObject(belt);
  if (!_refBox.isEmpty()) {
    _refBox.getSize(_refV);
    const cx = (_refBox.min.x + _refBox.max.x) * 0.5;
    const cy = (_refBox.min.y + _refBox.max.y) * 0.5;
    const cz = (_refBox.min.z + _refBox.max.z) * 0.5;
    if (_refV.x >= _refV.y && _refV.x >= _refV.z) {
      entry.set(_refBox.min.x, cy, cz); exit.set(_refBox.max.x, cy, cz);
    } else if (_refV.z >= _refV.x && _refV.z >= _refV.y) {
      entry.set(cx, cy, _refBox.min.z); exit.set(cx, cy, _refBox.max.z);
    } else {
      entry.set(cx, _refBox.min.y, cz); exit.set(cx, _refBox.max.y, cz);
    }
  } else {
    belt.getWorldPosition(entry); exit.copy(entry);
  }
  const entryPos: [number, number, number] = [entry.x, entry.y, entry.z];
  const exitPos: [number, number, number] = [exit.x, exit.y, exit.z];

  let distToSensor = length;
  if (sensor) {
    sensor.getWorldPosition(_refV);
    const d = _refV.distanceTo(entry) * 1000;
    if (d > 0) distToSensor = d;
  }
  const timeToSensor = Math.max(0.001, distToSensor / speed);

  return { speed, length, timeToSensor, entryPos, exitPos };
}

// ─── Parity assertion helper ────────────────────────────────────────────────

function expectParity(
  prop: Record<string, number>,
  belt: Object3D,
  sensor: Object3D | null,
  drives: DriveMap = new Map(),
): void {
  const ref = refResolveTiming(makeSelf(prop, drives), belt, sensor);
  const timer = createTransitTimer(makeSelf(prop, drives), belt, sensor);

  expect(timer.speed).toBe(ref.speed);
  expect(timer.length).toBe(ref.length);
  expect(timer.timeToSensor).toBe(ref.timeToSensor);
  expect(timer.entryPos).toEqual(ref.entryPos);
  expect(timer.exitPos).toEqual(ref.exitPos);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('createTransitTimer — value parity with Conveyor logic', () => {
  it('straight X belt, sensor at exit, speed/length from schema', () => {
    // 1000 mm long belt along X, centred — world bounds X span = [-500, +500].
    const belt = makeBeltMesh(1000, 100, 200);
    // Sensor at the exit (+X end) in world metres so the m→mm ×1000 path runs.
    const sensor = new Object3D();
    sensor.position.set(500, 0, 0); // 500 m from origin along +X (extreme, exercises the branch)
    sensor.updateMatrixWorld(true);

    expectParity({ ConveyorLength: 1000, ConveyorSpeed: 200 }, belt, sensor);

    // Spot-check the absolute values too (not just parity).
    const timer = createTransitTimer(makeSelf({ ConveyorLength: 1000, ConveyorSpeed: 200 }), belt, sensor);
    expect(timer.speed).toBe(200);
    expect(timer.length).toBe(1000);
    expect(timer.entryPos[0]).toBeCloseTo(-500, 6);
    expect(timer.exitPos[0]).toBeCloseTo(500, 6);
  });

  it('timeToSensor = length/speed when no sensor (full transit)', () => {
    const belt = makeBeltMesh(2000, 100, 200);
    expectParity({ ConveyorLength: 2000, ConveyorSpeed: 500 }, belt, null);

    const timer = createTransitTimer(makeSelf({ ConveyorLength: 2000, ConveyorSpeed: 500 }), belt, null);
    // 2000 mm / 500 mm/s = 4 s.
    expect(timer.timeToSensor).toBeCloseTo(4, 6);
  });

  it('speed prefers the belt drive TargetSpeed over the schema ConveyorSpeed', () => {
    const belt = makeBeltMesh(1000, 100, 200);
    const drives: DriveMap = new Map([[belt, { TargetSpeed: 750 } as Partial<SelfDrive>]]);

    expectParity({ ConveyorLength: 1000, ConveyorSpeed: 200 }, belt, null, drives);

    const timer = createTransitTimer(
      makeSelf({ ConveyorLength: 1000, ConveyorSpeed: 200 }, drives),
      belt,
      null,
    );
    expect(timer.speed).toBe(750); // drive wins
  });

  it('falls back to schema ConveyorSpeed when the drive TargetSpeed is 0', () => {
    const belt = makeBeltMesh(1000, 100, 200);
    const drives: DriveMap = new Map([[belt, { TargetSpeed: 0 } as Partial<SelfDrive>]]);

    expectParity({ ConveyorLength: 1000, ConveyorSpeed: 200 }, belt, null, drives);

    const timer = createTransitTimer(
      makeSelf({ ConveyorLength: 1000, ConveyorSpeed: 200 }, drives),
      belt,
      null,
    );
    expect(timer.speed).toBe(200); // schema wins (drive speed not > 0)
  });

  it('length: CalculatedArcLength overrides ConveyorLength', () => {
    const belt = makeBeltMesh(1000, 100, 200);
    expectParity({ ConveyorLength: 1000, ConveyorSpeed: 200, CalculatedArcLength: 1234 }, belt, null);

    const timer = createTransitTimer(
      makeSelf({ ConveyorLength: 1000, ConveyorSpeed: 200, CalculatedArcLength: 1234 }),
      belt,
      null,
    );
    expect(timer.length).toBe(1234);
  });

  it('length: bounds fallback when no CalculatedArcLength and no ConveyorLength', () => {
    // Longest world-bounds extent (X) = 1500 → used as the length.
    const belt = makeBeltMesh(1500, 100, 200);
    expectParity({ ConveyorSpeed: 200 }, belt, null);

    const timer = createTransitTimer(makeSelf({ ConveyorSpeed: 200 }), belt, null);
    expect(timer.length).toBeCloseTo(1500, 6);
  });

  it('speed = 0 guard → 0.001 (no divide-by-zero; timeToSensor finite & > 0)', () => {
    const belt = makeBeltMesh(1000, 100, 200);
    expectParity({ ConveyorLength: 1000, ConveyorSpeed: 0 }, belt, null);

    const timer = createTransitTimer(makeSelf({ ConveyorLength: 1000, ConveyorSpeed: 0 }), belt, null);
    expect(timer.speed).toBeGreaterThanOrEqual(0.001);
    expect(Number.isFinite(timer.timeToSensor)).toBe(true);
    expect(timer.timeToSensor).toBeGreaterThan(0);
  });

  it('empty-bounds belt (no geometry) → entry = exit = belt world position', () => {
    // Plain Object3D has no renderable geometry → expandByObject leaves the box
    // empty → the fallback copies the belt world position into both endpoints.
    const belt = new Object3D();
    belt.name = 'Transport-X';
    belt.position.set(3, 4, 5);
    belt.updateMatrixWorld(true);

    expectParity({ ConveyorLength: 1000, ConveyorSpeed: 200 }, belt, null);

    const timer = createTransitTimer(makeSelf({ ConveyorLength: 1000, ConveyorSpeed: 200 }), belt, null);
    expect(timer.entryPos).toEqual([3, 4, 5]);
    expect(timer.exitPos).toEqual([3, 4, 5]);
  });

  it('longest-axis selection: Z-dominant belt spans Z', () => {
    // Z is the longest extent → entry/exit span Z, not X.
    const belt = makeBeltMesh(200, 100, 1800);
    expectParity({ ConveyorSpeed: 200 }, belt, null);

    const timer = createTransitTimer(makeSelf({ ConveyorSpeed: 200 }), belt, null);
    expect(timer.entryPos[2]).toBeCloseTo(-900, 6);
    expect(timer.exitPos[2]).toBeCloseTo(900, 6);
    expect(timer.entryPos[0]).toBeCloseTo(0, 6); // X centred
  });

  it('refresh() recomputes after a prop change', () => {
    const belt = makeBeltMesh(1000, 100, 200);
    const self = makeSelf({ ConveyorLength: 1000, ConveyorSpeed: 200 });
    const timer = createTransitTimer(self, belt, null);
    expect(timer.timeToSensor).toBeCloseTo(5, 6); // 1000/200

    // Mutate the config and refresh → new timing.
    self.prop['ConveyorSpeed'] = 1000;
    timer.refresh();
    expect(timer.speed).toBe(1000);
    expect(timer.timeToSensor).toBeCloseTo(1, 6); // 1000/1000
  });
});

describe('createTransitTimer.tween — spec shape', () => {
  it('returns a position tween from entry to exit, target = mu.visual', () => {
    const belt = makeBeltMesh(1000, 100, 200);
    const timer = createTransitTimer(makeSelf({ ConveyorLength: 1000, ConveyorSpeed: 200 }), belt, null);

    const visual = { marker: 'mu-visual' };
    const mu = { id: 1, visual } as unknown as MU;
    const spec = timer.tween(mu);

    expect(spec.tween.kind).toBe('position');
    if (spec.tween.kind === 'position') {
      expect(spec.tween.target).toBe(visual);
      expect(spec.tween.from).toEqual(timer.entryPos);
      expect(spec.tween.to).toEqual(timer.exitPos);
    }
  });

  it('tween target is null when the MU has no visual', () => {
    const belt = makeBeltMesh(1000, 100, 200);
    const timer = createTransitTimer(makeSelf({ ConveyorLength: 1000, ConveyorSpeed: 200 }), belt, null);

    const mu = { id: 2 } as unknown as MU;
    const spec = timer.tween(mu);
    expect(spec.tween.kind).toBe('position');
    if (spec.tween.kind === 'position') {
      expect(spec.tween.target).toBeNull();
    }
  });
});
