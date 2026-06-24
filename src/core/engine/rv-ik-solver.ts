// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ik-solver.ts — Public interface + registry for the interactive IK solver.
 *
 * The actual analytical solver is a PROTECTED, closed-source artifact (Rust →
 * WASM, plan-212) that ships only in licensed builds. The private side registers
 * a provider here; when absent (open-source / unlicensed build), `available` is
 * false and the viewer falls back to AxisPos replay (no interactive re-solving).
 *
 * Frame contract: pos/quat describe the desired TCP pose in the robot's LOCAL
 * frame, in meters, with any scene scale removed — the same frame the serialized
 * OPW parameters live in. (Validated: identity conversion, exact parity with the
 * Unity Burst solver on clean targets.)
 */

import { Matrix4, Vector3, Quaternion } from 'three';

/** Ortho-parallel-wrist kinematic parameters (serialized in rv_extras as RobotIK). */
export interface OpwParams {
  a1: number; a2: number; b: number;
  c1: number; c2: number; c3: number; c4: number;
  elbowInUnityX: boolean;
  /** Tool offset in robot-local meters. */
  toolOffset: [number, number, number];
}

/** One IK configuration: 6 joint angles (degrees) + reachability flag. */
export interface IKSolution {
  angles: number[];
  reachable: boolean;
}

/** Implemented by the protected WASM provider (private). */
export interface IKSolverProvider {
  /** True once the solver artifact has loaded. */
  readonly available: boolean;
  /** Returns up to 8 analytical solutions for the given robot-local TCP pose. */
  solvePieper(
    params: OpwParams,
    pos: [number, number, number],
    quat: [number, number, number, number],
  ): IKSolution[];
}

class IKSolverRegistry {
  private provider: IKSolverProvider | null = null;

  /** Register the protected solver provider (called from the private side). */
  register(provider: IKSolverProvider): void {
    this.provider = provider;
  }

  /** True when a loaded solver is available (licensed build). */
  get available(): boolean {
    return this.provider?.available ?? false;
  }

  /** Solve, or null when no solver is available (→ replay-only fallback). */
  solvePieper(
    params: OpwParams,
    pos: [number, number, number],
    quat: [number, number, number, number],
  ): IKSolution[] | null {
    return this.provider?.available ? this.provider.solvePieper(params, pos, quat) : null;
  }

  /**
   * Pick the solution closest to the reference joint angles (L2, with 360°
   * unwrap per axis) — mirrors RobotIK's default selection. Returns null if
   * none reachable.
   */
  selectClosest(solutions: IKSolution[], reference: number[]): number[] | null {
    let best: number[] | null = null;
    let bestErr = Infinity;
    for (const s of solutions) {
      if (!s.reachable) continue;
      let err = 0;
      for (let a = 0; a < 6; a++) {
        let d = Math.abs((s.angles[a] ?? 0) - (reference[a] ?? 0)) % 360;
        if (d > 180) d = 360 - d;
        err += d * d;
      }
      if (err < bestErr) { bestErr = err; best = s.angles; }
    }
    return best;
  }
}

/** Singleton IK solver registry. */
export const ikSolverRegistry = new IKSolverRegistry();

// Reusable temps for targetPoseInBase (single-threaded; not reentrant).
const _poseMat = new Matrix4();
const _posePos = new Vector3();
const _poseQuat = new Quaternion();
const _poseScl = new Vector3();

/**
 * Express a target's world pose in a base (robot) local frame and write the
 * scene-scale-removed position + quaternion into the caller's reusable tuples —
 * ready for solvePieper(). No per-call allocation. Shared by the interactive
 * edit plugin (re-solve) and the path visualizer (reachability check).
 */
export function targetPoseInBase(
  baseMatrixWorld: Matrix4,
  targetMatrixWorld: Matrix4,
  outPos: [number, number, number],
  outQuat: [number, number, number, number],
): void {
  _poseMat.copy(baseMatrixWorld).invert().multiply(targetMatrixWorld);
  _poseMat.decompose(_posePos, _poseQuat, _poseScl);
  outPos[0] = _posePos.x / (_poseScl.x || 1);
  outPos[1] = _posePos.y / (_poseScl.y || 1);
  outPos[2] = _posePos.z / (_poseScl.z || 1);
  outQuat[0] = _poseQuat.x; outQuat[1] = _poseQuat.y; outQuat[2] = _poseQuat.z; outQuat[3] = _poseQuat.w;
}
