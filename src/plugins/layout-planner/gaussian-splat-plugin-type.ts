// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Lightweight type-only contract for the GaussianSplatPlugin API consumed by
 * the layout planner. Avoids a direct import of the plugin module (which would
 * pull in all of @mkkellogg/gaussian-splats-3d into the planner chunk).
 */

import type { Group, Vector3, Ray } from 'three';

/**
 * One ray/splat intersection result, in world space.
 * Returned by `raycastSplats` — sorted nearest-first by `distance`.
 */
export interface SplatRaycastHit {
  /** World-space point of the splat's centre (sphere approximation). */
  readonly point: Vector3;
  /** Surface normal at the hit point — points from splat centre outward. */
  readonly normal: Vector3;
  /** World-space distance from the ray origin to `point`. */
  readonly distance: number;
  /** Index of the hit splat in its mesh (useful for highlighting / debug). */
  readonly splatIndex: number;
  /** Container Group of the splat instance the hit belongs to. */
  readonly container: Group;
}

export interface GaussianSplatPluginApi {
  loadSplat(url: string, fileExt?: string): Promise<Group>;
  disposeSplat(container: Group): void;
  /**
   * Set the per-axis scale of the gaussian-splat scene attached to this
   * container. Negative values mirror the splat along that axis — needed
   * because the gaussian-splats-3d library renders through its own
   * pipeline and does NOT honour the parent Three.js container's scale.
   * Pass `1` to restore an axis. No-op if the container isn't a managed
   * splat instance.
   */
  setSplatScale(container: Group, scale: readonly [number, number, number]): void;
  /**
   * Crop the splat to an axis-aligned box in its local coordinate frame.
   * Splats whose centre falls outside [min, max] are culled in the vertex
   * shader. Use a wide range (e.g. ±1e6) on an axis to effectively disable
   * cropping there. No-op for point-cloud instances.
   */
  setSplatCrop(
    container: Group,
    box: { min: readonly [number, number, number]; max: readonly [number, number, number] },
  ): void;
  /**
   * Copy the container's current position + quaternion onto the
   * library's splatMesh. Triggered by `layout-transform-update` events
   * (Gizmo drag, Inspector edit, restore) — the splat library's internal
   * scene is otherwise disconnected from the host Three.js scene graph
   * and the splat would stay at world origin no matter where the
   * container moves. Scale is intentionally NOT touched (owned by
   * `setSplatScale`).
   */
  syncSplatTransform(container: Group): void;
  /**
   * Raycast a world-space ray against every visible splat instance and
   * return all hits, sorted nearest-first. Necessary because Three.js'
   * `Raycaster.intersectObjects()` cannot hit splats (they have no
   * triangle geometry) — this routine walks the splat-mesh octree and
   * tests each splat as a sphere (centre + averaged radius).
   *
   * Returns `[]` (empty) when no splat is visible or none is intersected.
   * Used by the measurement plugin as a fallback after the standard
   * Three.js raycast misses, so dimensions on a scanned-room splat
   * become possible.
   */
  raycastSplats(ray: Ray): readonly SplatRaycastHit[];
  readonly instanceCount: number;
}
