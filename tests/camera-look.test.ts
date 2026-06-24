// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared mouse-look helper tests (plan-221 §9.6 — regression guard for the FPV
 * refactor). FpvPlugin and the Sit-On camera mode both route mouse look through
 * `applyMouseLook`; this verifies the shared accumulation + pitch clamp directly,
 * which is more robust than simulating DOM pointer events.
 */

import { describe, it, expect } from 'vitest';
import { Quaternion, Euler } from 'three';
import { applyMouseLook, MAX_PITCH, type LookState } from '../src/plugins/_shared/camera-look';

describe('applyMouseLook (shared FPV / Sit-On look)', () => {
  it('accumulates yaw from X and pitch from Y and writes the YXZ quaternion', () => {
    const state: LookState = { yaw: 0, pitch: 0 };
    const q = new Quaternion();
    applyMouseLook(state, 100, 50, 0.01, q);
    expect(state.yaw).toBeCloseTo(-1.0, 5);
    expect(state.pitch).toBeCloseTo(-0.5, 5);
    const e = new Euler().setFromQuaternion(q, 'YXZ');
    expect(e.y).toBeCloseTo(-1.0, 4);
    expect(e.x).toBeCloseTo(-0.5, 4);
  });

  it('clamps pitch to ±MAX_PITCH', () => {
    const state: LookState = { yaw: 0, pitch: 0 };
    const q = new Quaternion();
    applyMouseLook(state, 0, 100000, 0.01, q);     // far past down
    expect(state.pitch).toBeCloseTo(-MAX_PITCH, 5);
    applyMouseLook(state, 0, -1000000, 0.01, q);   // far past up
    expect(state.pitch).toBeCloseTo(MAX_PITCH, 5);
  });

  it('keeps yaw unbounded (full turns) while pitch stays clamped', () => {
    const state: LookState = { yaw: 0, pitch: 0 };
    const q = new Quaternion();
    applyMouseLook(state, 100000, 0, 0.01, q);
    expect(Math.abs(state.yaw)).toBeGreaterThan(Math.PI * 2);
    expect(Math.abs(state.pitch)).toBeLessThanOrEqual(MAX_PITCH);
  });
});
