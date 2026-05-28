// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-traverse-utils.ts — Small reusable Object3D traversal helpers.
 *
 * The `node.traverse(c => { if (!(c as Mesh).isMesh) return; ... })` pattern
 * appears in 30+ files. `traverseMeshes()` makes the intent explicit and
 * eliminates the `as Mesh` cast boilerplate at every call site.
 */

import { Box3, Vector3, type Object3D } from 'three';
import { Mesh } from 'three';

/**
 * Traverse `root` and invoke `cb` for every descendant (and `root` itself,
 * if it is a `Mesh`). Skips non-Mesh nodes.
 *
 * Equivalent to:
 * ```ts
 * root.traverse((c) => { if (!(c as Mesh).isMesh) return; cb(c as Mesh); });
 * ```
 *
 * The `isMesh` runtime check is preserved (not just `instanceof Mesh`) because
 * Three.js uses duck-typed flags on Object3D subclasses and the existing code
 * relied on that behavior.
 */
export function traverseMeshes(root: Object3D, cb: (mesh: Mesh) => void): void {
  root.traverse((child) => {
    if ((child as Mesh).isMesh) {
      cb(child as Mesh);
    }
  });
}

/**
 * Traverse `root` and invoke `cb(mesh, depth)` for every descendant `Mesh`
 * whose depth (parent-hops back to `root`) is `<= maxDepth`. Meshes deeper
 * than `maxDepth` are skipped silently; a single console.warn (prefixed with
 * `prefix`) is emitted the first time the depth limit is exceeded.
 *
 * This consolidates a repeated pattern in `rv-gizmo-manager.ts` where three
 * shape builders (`_buildMeshOverlay`, `_buildMeshEdges`, `_buildMeshGlowHull`)
 * each duplicated:
 *
 * ```ts
 * let depth = 0;
 * let overDepthWarned = false;
 * node.traverse((child) => {
 *   depth = 0;
 *   let cur = child;
 *   while (cur && cur !== node) { depth++; cur = cur.parent; }
 *   if (depth > MAX_OVERLAY_DEPTH) {
 *     if (!overDepthWarned) { console.warn(...); overDepthWarned = true; }
 *     return;
 *   }
 *   if (!(child as Mesh).isMesh) return;
 *   ...
 * });
 * ```
 *
 * The depth count and iteration order match the original Three.js
 * `traverse()` semantics exactly: depth is computed by walking
 * `parent` pointers back to `root`; the `root` itself has depth `0` and
 * is iterated if it is a Mesh.
 *
 * The `cb` only fires for Mesh descendants with a defined `geometry`
 * (matches the original guard at every call site).
 */
export function traverseMeshesWithDepth(
  root: Object3D,
  maxDepth: number,
  cb: (mesh: Mesh, depth: number) => void,
  prefix = '[traverseMeshesWithDepth]',
): void {
  let overDepthWarned = false;
  root.traverse((child) => {
    // Cheap depth gate (approximate — same logic as the inlined original)
    let depth = 0;
    let cur: Object3D | null = child;
    while (cur && cur !== root) {
      depth++;
      cur = cur.parent;
    }
    if (depth > maxDepth) {
      if (!overDepthWarned) {
        console.warn(`${prefix} exceeded depth ${maxDepth}; skipping deeper meshes`);
        overDepthWarned = true;
      }
      return;
    }
    const m = child as Mesh;
    if (!m.isMesh || !m.geometry) return;
    cb(m, depth);
  });
}

/**
 * Compute the axis-aligned bounding box of all `Mesh` descendants of `node`,
 * including geometry transforms. Lights, Cameras, Groups, and other non-Mesh
 * children are skipped.
 *
 * The returned object exposes `box` plus pre-computed `size` and `center`
 * Vector3s for convenience. When no mesh descendants exist, the box falls
 * back to a `0.1 × 0.1 × 0.1` cube centered on the node's world position.
 * Each component of `size` is clamped to at least `0.001` to avoid
 * zero-scale traps when the result is used as a Three.js scale.
 *
 * The `target` parameter may be passed to reuse a pre-allocated `Box3`
 * (GC avoidance for callers in hot paths); `size` and `center` are always
 * fresh `Vector3` instances on return.
 */
export function computeSubtreeAABB(
  node: Object3D,
  target?: Box3,
): { box: Box3; size: Vector3; center: Vector3 } {
  const box = target ?? new Box3();
  box.makeEmpty();
  let hasAny = false;
  node.traverse((child) => {
    const asMesh = child as Mesh;
    if (asMesh.isMesh && asMesh.geometry) {
      box.expandByObject(asMesh);
      hasAny = true;
    }
  });
  if (!hasAny) {
    // Fallback: use node world position as center with minimal size
    const pos = new Vector3();
    node.getWorldPosition(pos);
    box.setFromCenterAndSize(pos, new Vector3(0.1, 0.1, 0.1));
  }
  const size = new Vector3();
  box.getSize(size);
  if (size.x < 0.001) size.x = 0.001;
  if (size.y < 0.001) size.y = 0.001;
  if (size.z < 0.001) size.z = 0.001;
  const center = new Vector3();
  box.getCenter(center);
  return { box, size, center };
}
