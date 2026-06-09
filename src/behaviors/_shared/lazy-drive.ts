// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Lazy-drive handles — resolve the underlying Drive on-demand and no-op while
 * it is not yet registered in the viewer (load-order race, HMR replay, late
 * convention pass). Replaces the hand-written drive-retry loops in behaviors.
 *
 * `attachBelt` is the minimal belt handle (`run(forward)` → jog). `attachDrive`
 * is the richer handle for positioned axes (rotary table, lift): it adds
 * `moveTo`, `isAtTarget` and `stop`. Both cache the drive once resolved.
 */
import type { Object3D } from 'three';
import type { BindContextDrive, NodeRef } from '../../core/behavior-runtime';

/**
 * Minimal drive-resolver surface: anything exposing `drives.get(node)`.
 * `rv` (RVBindContext) satisfies it directly; the material-flow `self` adapts
 * via `selfDrives(self)` (its `drive()` projection wrapped as `drives.get`).
 */
export interface DriveResolver {
  drives: { get(ref: NodeRef): BindContextDrive | null };
}

/** Wrap a `self`-style `drive()` projection as a `DriveResolver`. */
export function selfDrives(self: { drive(ref: NodeRef): BindContextDrive | null }): DriveResolver {
  return { drives: { get: (ref) => self.drive(ref) } };
}

function resolveOnce(src: DriveResolver, node: Object3D): BindContextDrive | null {
  return src.drives.get(node);
}

export interface BeltHandle {
  readonly node: Object3D | null;
  /** Sets jogForward/jogBackward once the drive is resolved; no-op before then. */
  run(forward: boolean): void;
}

export interface DriveHandle {
  readonly node: Object3D | null;
  /** Sets jogForward/jogBackward once the drive is resolved; no-op before then. */
  run(forward: boolean): void;
  /** Commands a move to `pos` once the drive is resolved; no-op before then. */
  moveTo(pos: number): void;
  /** True only when the drive is resolved and has reached its target. */
  isAtTarget(): boolean;
  /** Stops the drive once resolved; no-op before then. */
  stop(): void;
}

/**
 * Belt handle that resolves `rv.drives.get(node)` on first use and no-ops until
 * the drive exists. `run(forward)` jogs the belt in one direction.
 */
export function attachBelt(src: DriveResolver, node: Object3D | null): BeltHandle {
  let drive: BindContextDrive | null = node ? resolveOnce(src, node) : null;
  const resolve = (): BindContextDrive | null => {
    if (!drive && node) drive = resolveOnce(src, node);
    return drive;
  };
  return {
    get node() { return node; },
    run(forward: boolean) {
      const d = resolve();
      if (!d) return;
      d.jogForward = forward;
      d.jogBackward = false;
    },
  };
}

/**
 * Positioned-drive handle (rotary/lift). Same resolve-on-demand pattern as
 * `attachBelt`, plus `moveTo`/`isAtTarget`/`stop`. Defensive: a handle whose
 * resolved drive is missing a method silently no-ops (and `isAtTarget` → false).
 */
export function attachDrive(src: DriveResolver, node: Object3D | null): DriveHandle {
  let drive: BindContextDrive | null = node ? resolveOnce(src, node) : null;
  const resolve = (): BindContextDrive | null => {
    if (!drive && node) drive = resolveOnce(src, node);
    return drive;
  };
  return {
    get node() { return node; },
    run(forward: boolean) {
      const d = resolve();
      if (!d) return;
      d.jogForward = forward;
      d.jogBackward = false;
    },
    moveTo(pos: number) {
      const d = resolve();
      if (!d || typeof d.moveTo !== 'function') return;
      d.moveTo(pos);
    },
    isAtTarget(): boolean {
      const d = resolve();
      return d ? d.isAtTarget === true : false;
    },
    stop() {
      const d = resolve();
      if (!d || typeof d.stop !== 'function') return;
      d.stop();
    },
  };
}
