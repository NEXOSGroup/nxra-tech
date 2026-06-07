// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Compute the rotation angle the turntable's rotary drive must reach to
 * dispatch a part through a chosen output snap.
 *
 * Model:
 *   - The drive rotates around an axis encoded by its `Drive-Rot-X|Y|Z` name.
 *     The two axes ORTHOGONAL to it form the dispatch plane.
 *   - Each snap node lives at a local position relative to the LayoutObject
 *     root. Projected onto the dispatch plane, that position has an angle
 *     around the rotation axis.
 *   - With one input snap present: the belt direction at neutral (drive
 *     position 0) is the "through" direction — input through the centre to
 *     the opposite side. Dispatching means rotating so the chosen output's
 *     mating direction coincides with what was originally the "opposite of
 *     input" direction.
 *   - With no input snap: assume the belt at neutral discharges in the snap's
 *     own direction (i.e. dispatch angle = output's local angle).
 *
 * Monotonic accumulation: we never use `% 360`. Instead we add full-turn
 * multiples to the previously commanded angle so the platform rotates by the
 * shortest direction without backtracking from 359° → 0°.
 */

import type { Object3D } from 'three';
import { Vector3 } from 'three';

const RAD2DEG = 180 / Math.PI;

export interface DispatchAngleInput {
  /** Rotary drive's axis (already a unit vector — `Drive-Rot-Y` → (0,1,0)). */
  driveAxis: Vector3;
  /** Local-position-bearing input snap node (or null when none exists). */
  inputSnapNode: Object3D | null;
  /** Local-position-bearing chosen output snap node. */
  outputSnapNode: Object3D;
  /** Drive's previously commanded angle (monotonic accumulator). */
  lastCommandedAngle: number;
}

/** Pick the two basis axes perpendicular to `axis` for the projection plane. */
function planeBasisFor(axis: Vector3): { u: Vector3; v: Vector3 } {
  // For canonical X/Y/Z drives we want consistent, deterministic basis vectors
  // so the SAME GLB always produces the SAME angle (no atan2 ambiguity from
  // numerically-picked perpendiculars).
  const ax = Math.abs(axis.x), ay = Math.abs(axis.y), az = Math.abs(axis.z);
  if (ay >= ax && ay >= az) return { u: new Vector3(1, 0, 0), v: new Vector3(0, 0, 1) };  // Y-axis (most common turntable)
  if (ax >= ay && ax >= az) return { u: new Vector3(0, 1, 0), v: new Vector3(0, 0, 1) };  // X-axis
  return { u: new Vector3(1, 0, 0), v: new Vector3(0, 1, 0) };                            // Z-axis
}

/** Angle (deg) of `node.position` in the (u,v) plane, measured atan2(v, u). */
function angleOf(node: Object3D, u: Vector3, v: Vector3): number {
  return angleOfVector(node.position, u, v);
}

/** Angle (deg) of an arbitrary vector in the (u,v) plane, measured atan2(v, u). */
function angleOfVector(p: Vector3, u: Vector3, v: Vector3): number {
  const cu = p.x * u.x + p.y * u.y + p.z * u.z;
  const cv = p.x * v.x + p.y * v.y + p.z * v.z;
  return Math.atan2(cv, cu) * RAD2DEG;
}

/**
 * Add full-turn multiples to `target` so it lands within (last − 180°, last + 180°].
 * The platform then rotates by the shortest direction without crossing a
 * `% 360` discontinuity.
 */
export function monotonicNext(lastCommandedAngle: number, target: number): number {
  let next = target;
  while (next - lastCommandedAngle > 180) next -= 360;
  while (next - lastCommandedAngle <= -180) next += 360;
  return next;
}

export function chooseDispatchAngle(input: DispatchAngleInput): number {
  const { driveAxis, inputSnapNode, outputSnapNode, lastCommandedAngle } = input;
  const { u, v } = planeBasisFor(driveAxis);
  const θ_out = angleOf(outputSnapNode, u, v);

  // With one input: belt's neutral discharge direction = θ_in + 180°. To
  // discharge through the output, rotate the platform so the (current) belt
  // direction lands on the output's angle:  θ_in + 180° + φ = θ_out
  //                                          ⇒ φ = θ_out − θ_in − 180°.
  // Without an input snap: assume the belt at neutral already points at the
  // output's direction → φ = θ_out.
  const target = inputSnapNode === null
    ? θ_out
    : (θ_out - angleOf(inputSnapNode, u, v) - 180);

  return monotonicNext(lastCommandedAngle, target);
}

// ─────────────────────────────────────────────────────────────────────────
// Belt-relative model (multi-input turntable).
//
// The single number `beltNeutralAngle` is the belt's discharge plane-angle when
// the rotary drive is at commanded angle 0. The drive convention is additive:
//   beltDischargeAngle(φ) = beltNeutralAngle + φ
// (consistent with `chooseDispatchAngle`, where beltNeutral = θ_in + 180 made
//  the dispatch target collapse to θ_out − θ_in − 180).
//
// From that single reference, BOTH receiving and dispatching are expressible for
// ANY port — which the input-relative `chooseDispatchAngle` could not do.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Calibrate the belt's neutral discharge angle from a runtime sample: the belt's
 * CURRENT discharge direction (expressed in the turntable ROOT-LOCAL frame) and
 * the CURRENT commanded drive angle. Geometric constant — calibrate once.
 */
export function calibrateBeltNeutralAngle(
  driveAxis: Vector3,
  beltLocalDirNow: Vector3,
  currentAngle: number,
): number {
  const { u, v } = planeBasisFor(driveAxis);
  return angleOfVector(beltLocalDirNow, u, v) - currentAngle;
}

/**
 * Drive angle that makes the belt RECEIVE from `inputSnapNode`: the belt must
 * discharge toward the opposite side (θ_in + 180) so its intake faces the input.
 */
export function alignToInputAngle(
  driveAxis: Vector3,
  beltNeutralAngle: number,
  inputSnapNode: Object3D,
  lastCommandedAngle: number,
): number {
  const { u, v } = planeBasisFor(driveAxis);
  const θ_in = angleOf(inputSnapNode, u, v);
  return monotonicNext(lastCommandedAngle, (θ_in + 180) - beltNeutralAngle);
}

/**
 * Drive angle that makes the belt DISCHARGE toward `outputSnapNode`.
 */
export function dispatchToOutputAngle(
  driveAxis: Vector3,
  beltNeutralAngle: number,
  outputSnapNode: Object3D,
  lastCommandedAngle: number,
): number {
  const { u, v } = planeBasisFor(driveAxis);
  const θ_out = angleOf(outputSnapNode, u, v);
  return monotonicNext(lastCommandedAngle, θ_out - beltNeutralAngle);
}
