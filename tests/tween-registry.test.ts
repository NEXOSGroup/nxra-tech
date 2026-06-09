// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * tween-registry.test.ts — Plan 194 §3 / P5 / V3 / V4.
 *
 * Verifies the central sim-time interpolator:
 *  - progress = (simNow − t0)/duration is monotonic and clamped to [0,1].
 *  - Animated position tween is 1:1 to linear motion (lerpVectors).
 *  - Drive tween writes from + (to−from)·p.
 *  - FastForward sub-mode writes NO transform.
 *  - duration=0 is robust (no NaN), null visual / null drive are skipped.
 *  - cancelled tweens stop animating and free their pool slot.
 *  - the pool does NOT allocate a new record per event (V3).
 */

import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import {
  TweenRegistry,
  type PositionTweenTarget,
  type DriveTweenTarget,
} from '../src/core/material-flow/tween-registry';

// ─── Fakes ───────────────────────────────────────────────────────────────

function makePosTarget(): PositionTweenTarget & { pos: Vector3; writes: number } {
  return {
    pos: new Vector3(),
    writes: 0,
    setPosition(v: Vector3): void {
      this.pos.copy(v);
      this.writes++;
    },
  };
}

function makeDriveTarget(): DriveTweenTarget & { value: number; writes: number } {
  return {
    value: NaN,
    writes: 0,
    setPosition(v: number): void {
      this.value = v;
      this.writes++;
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('TweenRegistry — position tween (Animated = 1:1)', () => {
  it('interpolates linearly between from and to over the duration', () => {
    const reg = new TweenRegistry(8);
    const t = makePosTarget();
    const from = new Vector3(0, 0, 0);
    const to = new Vector3(10, 0, 0);
    reg.addPosition(t, from, to, 0, 2); // t0=0, duration=2s

    reg.onRender(0, 'animated');
    expect(t.pos.x).toBeCloseTo(0);
    reg.onRender(0.5, 'animated');
    expect(t.pos.x).toBeCloseTo(2.5); // 0.5/2 = 25%
    reg.onRender(1, 'animated');
    expect(t.pos.x).toBeCloseTo(5); // 50%
    reg.onRender(2, 'animated');
    expect(t.pos.x).toBeCloseTo(10); // 100%
  });

  it('progress is monotonic and clamped past the end', () => {
    const reg = new TweenRegistry(8);
    const t = makePosTarget();
    reg.addPosition(t, new Vector3(0, 0, 0), new Vector3(0, 0, 100), 1, 1);
    reg.onRender(0.5, 'animated'); // before t0 → clamp 0
    expect(t.pos.z).toBeCloseTo(0);
    reg.onRender(1.5, 'animated'); // mid
    expect(t.pos.z).toBeCloseTo(50);
    reg.onRender(5, 'animated'); // far past end → clamp 1, then reaped
    expect(t.pos.z).toBeCloseTo(100);
  });

  it('does not mutate the caller-supplied from/to vectors', () => {
    const reg = new TweenRegistry(8);
    const t = makePosTarget();
    const from = new Vector3(1, 2, 3);
    const to = new Vector3(4, 5, 6);
    reg.addPosition(t, from, to, 0, 1);
    reg.onRender(0.5, 'animated');
    expect(from.toArray()).toEqual([1, 2, 3]);
    expect(to.toArray()).toEqual([4, 5, 6]);
  });
});

describe('TweenRegistry — drive tween', () => {
  it('writes from + (to − from) · progress', () => {
    const reg = new TweenRegistry(8);
    const d = makeDriveTarget();
    reg.addDrive(d, 0, 90, 0, 3); // 0° → 90° over 3s
    reg.onRender(0, 'animated');
    expect(d.value).toBeCloseTo(0);
    reg.onRender(1, 'animated');
    expect(d.value).toBeCloseTo(30);
    reg.onRender(3, 'animated');
    expect(d.value).toBeCloseTo(90);
  });
});

describe('TweenRegistry — FastForward (no transform write)', () => {
  it('does not write any transform in fastforward sub-mode', () => {
    const reg = new TweenRegistry(8);
    const t = makePosTarget();
    const d = makeDriveTarget();
    reg.addPosition(t, new Vector3(0, 0, 0), new Vector3(99, 0, 0), 0, 2);
    reg.addDrive(d, 0, 99, 0, 2);

    reg.onRender(1, 'fastforward');
    expect(t.writes).toBe(0);
    expect(d.writes).toBe(0);
    expect(t.pos.x).toBe(0);

    // ...but a finished tween is still reaped (no leak), even in fastforward.
    reg.onRender(2, 'fastforward');
    expect(reg.activeCount).toBe(0);
  });
});

describe('TweenRegistry — robustness (V4)', () => {
  it('duration=0 never produces NaN', () => {
    const reg = new TweenRegistry(8);
    const t = makePosTarget();
    reg.addPosition(t, new Vector3(0, 0, 0), new Vector3(10, 0, 0), 0, 0);
    reg.onRender(0, 'animated');
    expect(Number.isNaN(t.pos.x)).toBe(false);
    // At/after the (clamped) end the tween reaches its target and is reaped.
    reg.onRender(0.01, 'animated');
    expect(t.pos.x).toBeCloseTo(10);
    expect(reg.activeCount).toBe(0);
  });

  it('null visual / null drive are skipped (no crash, handle = −1)', () => {
    const reg = new TweenRegistry(8);
    const h1 = reg.addPosition(null, new Vector3(), new Vector3(), 0, 1);
    const h2 = reg.addDrive(null, 0, 1, 0, 1);
    expect(h1).toBe(-1);
    expect(h2).toBe(-1);
    expect(reg.activeCount).toBe(0);
    expect(() => reg.onRender(0.5, 'animated')).not.toThrow();
  });

  it('cancelled tween stops animating and frees its slot', () => {
    const reg = new TweenRegistry(8);
    const t = makePosTarget();
    const h = reg.addPosition(t, new Vector3(0, 0, 0), new Vector3(100, 0, 0), 0, 10);
    reg.onRender(1, 'animated');
    expect(t.pos.x).toBeCloseTo(10);
    const writesBefore = t.writes;
    reg.cancel(h);
    expect(reg.activeCount).toBe(0);
    reg.onRender(5, 'animated'); // would be 50 if still active
    expect(t.writes).toBe(writesBefore); // no further write
    expect(t.pos.x).toBeCloseTo(10);
  });

  it('double-cancel and stale handle are ignored', () => {
    const reg = new TweenRegistry(8);
    const t = makePosTarget();
    const h = reg.addPosition(t, new Vector3(), new Vector3(1, 0, 0), 0, 1);
    reg.cancel(h);
    expect(() => reg.cancel(h)).not.toThrow();
    expect(reg.activeCount).toBe(0);
  });
});

describe('TweenRegistry — pool (V3, no per-event allocation)', () => {
  it('reuses pooled records across many finished tweens', () => {
    const reg = new TweenRegistry(4);
    const initialPool = reg.poolSize;
    // Run far more tweens than the pool size, finishing each before the next,
    // so the pool must recycle rather than grow.
    for (let i = 0; i < 100; i++) {
      const t = makePosTarget();
      reg.addPosition(t, new Vector3(), new Vector3(1, 0, 0), i, 0.001);
      reg.onRender(i + 1, 'animated'); // finishes + reaps immediately
    }
    expect(reg.activeCount).toBe(0);
    // The pool never grew because each tween finished before the next started.
    expect(reg.poolSize).toBe(initialPool);
  });

  it('clear() frees all active tweens', () => {
    const reg = new TweenRegistry(8);
    for (let i = 0; i < 5; i++) {
      reg.addPosition(makePosTarget(), new Vector3(), new Vector3(1, 0, 0), 0, 10);
    }
    expect(reg.activeCount).toBe(5);
    reg.clear();
    expect(reg.activeCount).toBe(0);
  });
});
