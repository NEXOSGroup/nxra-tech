// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared mouse-look helper — GC-free yaw/pitch accumulation used by the FPV
 * plugin (mutates its own camera quaternion directly) and the camera Sit-On
 * mode (forwards deltas to the CameraManager).
 *
 * Euler order is YXZ (yaw applied before pitch) with the pitch clamped just
 * under ±90° to avoid gimbal flip. A single pre-allocated Euler is reused so
 * there is zero per-frame allocation in the look hot path.
 */

import { Euler, MathUtils } from 'three';
import type { Quaternion } from 'three';

/** Maximum look pitch (radians) — slightly under 90° to avoid gimbal lock. */
export const MAX_PITCH = MathUtils.degToRad(85);

/** Mutable yaw/pitch look state. */
export interface LookState {
  yaw: number;
  pitch: number;
}

// Pre-allocated Euler (reused every call — no GC in the look hot path).
const _euler = new Euler(0, 0, 0, 'YXZ');

/**
 * Accumulate a pointer movement delta into `state` (yaw from X, pitch from Y),
 * clamp the pitch, and write the resulting rotation into `outQuat`.
 *
 * @param state       Mutable yaw/pitch accumulator (mutated in place).
 * @param movementX   Pointer X movement in pixels.
 * @param movementY   Pointer Y movement in pixels.
 * @param sensitivity Radians per pixel.
 * @param outQuat     Quaternion to receive the YXZ rotation.
 */
export function applyMouseLook(
  state: LookState,
  movementX: number,
  movementY: number,
  sensitivity: number,
  outQuat: Quaternion,
): void {
  state.yaw -= movementX * sensitivity;
  state.pitch -= movementY * sensitivity;
  state.pitch = MathUtils.clamp(state.pitch, -MAX_PITCH, MAX_PITCH);
  _euler.set(state.pitch, state.yaw, 0, 'YXZ');
  outQuat.setFromEuler(_euler);
}
