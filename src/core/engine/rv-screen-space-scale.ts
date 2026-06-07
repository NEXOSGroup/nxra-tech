// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Constant-screen-size scaling helpers — the same approach the FloorGizmo uses
 * in `_sync`: pick a world-space scale each frame so an object spans a fixed
 * number of screen pixels regardless of camera distance or zoom.
 *
 * Used for snap-point markers and the snap-flip rotate icon so they stay a
 * consistent on-screen size like the transform gizmo.
 */

import { MathUtils, Vector3 } from 'three';
import type { Object3D, OrthographicCamera, PerspectiveCamera } from 'three';

const _wp = new Vector3();
const _ws = new Vector3();

/** World units per screen pixel at `worldPos` for the active camera. */
export function worldPerPixelAt(
  camera: PerspectiveCamera | OrthographicCamera,
  canvasHeight: number,
  worldPos: Vector3,
): number {
  const h = canvasHeight || 1;
  const persp = camera as PerspectiveCamera;
  if (persp.isPerspectiveCamera) {
    const dist = camera.position.distanceTo(worldPos);
    return (2 * Math.tan((persp.fov * MathUtils.DEG2RAD) / 2) * dist) / h;
  }
  const ortho = camera as OrthographicCamera;
  return (ortho.top - ortho.bottom) / ortho.zoom / h;
}

/**
 * Scale `node` so it spans ~`targetPx` screen pixels regardless of camera
 * distance / zoom (constant screen size). Compensates for the parent chain's
 * world scale so it works under scaled groups (e.g. mm→m CAD roots).
 *
 * Returns the world-space size applied (useful for hit-test radii).
 */
export function applyScreenSpaceScale(
  node: Object3D,
  targetPx: number,
  camera: PerspectiveCamera | OrthographicCamera,
  canvasHeight: number,
): number {
  node.getWorldPosition(_wp);
  const worldSize = targetPx * worldPerPixelAt(camera, canvasHeight, _wp);
  let parentScale = 1;
  if (node.parent) {
    node.parent.getWorldScale(_ws);
    parentScale = Math.max(Math.abs(_ws.x), Math.abs(_ws.y), Math.abs(_ws.z)) || 1;
  }
  node.scale.setScalar(worldSize / parentScale);
  return worldSize;
}
