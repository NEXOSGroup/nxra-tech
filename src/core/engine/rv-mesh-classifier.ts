// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Pure-function mesh shadow classifier — extracted from `processMeshes()` in
 * rv-scene-loader.ts.
 *
 * Why this exists:
 * The shadow-casting decision for each mesh is a heuristic based on the
 * material's alpha properties. Transparent / alpha-blended / alpha-tested
 * materials produce visually wrong shadows on most rendering pipelines (the
 * shadow caster cannot represent partial occlusion correctly), so we skip
 * shadow casting for them. Opaque meshes always cast shadows.
 *
 * Heuristics (in order of precedence; ANY of these flags an alpha material):
 *  1. `material.transparent === true`            (explicit transparency flag)
 *  2. `material.alphaTest > 0`                   (alpha-cutout — e.g. leaves, foliage)
 *  3. `material.alphaMap != null`                (alpha texture present)
 *  4. `material.opacity < 1`                     (semi-transparent override)
 *
 * `receiveShadow` is set unconditionally to true elsewhere — only the
 * cast-shadow decision needs classification, so this module returns a single
 * boolean.
 *
 * Background — see plan-094: originally `castShadow` was also disabled on
 * static meshes for performance reasons, but that meant users saw no shadows
 * from walls, frames, fixtures and factory structure. After the uber-material
 * merge collapses untextured statics into one draw call, opaque meshes are
 * cheap enough to all cast shadows; the per-mesh cost is only paid by textured
 * static meshes and only when the shadow map actually rebuilds.
 */

import type { Mesh } from 'three';

/** Subset of material properties the classifier reads. Kept loose to avoid
 *  coupling to a specific Three.js material subclass. */
export interface ShadowClassifiableMaterial {
  transparent?: boolean;
  alphaTest?: number;
  opacity?: number;
  alphaMap?: unknown;
}

/**
 * Decide whether a mesh should cast shadows based on its material's alpha
 * properties. Returns `true` for opaque meshes (cast shadows), `false` for
 * any material flagged as alpha-blended / alpha-tested / partially
 * transparent.
 *
 * Pure function: no side effects, does not mutate `mesh` or its material.
 *
 * @param mesh The Three.js mesh to classify.
 * @returns `true` if the mesh should cast shadows, `false` if not.
 */
export function classifyShadows(mesh: Mesh): boolean {
  const mat = mesh.material as ShadowClassifiableMaterial | undefined;
  const hasAlpha =
    mat !== undefined &&
    mat !== null &&
    (
      mat.transparent === true ||
      (mat.alphaTest ?? 0) > 0 ||
      mat.alphaMap != null ||
      (mat.opacity ?? 1) < 1
    );
  return !hasAlpha;
}
