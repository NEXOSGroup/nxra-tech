// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * three-utils.ts — Shared Three.js disposal helpers for the Layout Planner.
 */

import type { Object3D, Material } from 'three';
import { Mesh } from 'three';

/**
 * Dispose geometry and materials on all Mesh nodes in a subtree.
 * Uses a Set to prevent double-dispose of shared resources.
 * Does NOT remove root from scene — caller is responsible.
 */
export function disposeSubtree(root: Object3D): void {
  const disposed = new Set<unknown>();
  root.traverse((node) => {
    const m = node as Mesh;
    if (m.geometry && !disposed.has(m.geometry)) {
      disposed.add(m.geometry);
      m.geometry.dispose();
    }
    if (m.material) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        if (mat && !disposed.has(mat)) {
          disposed.add(mat);
          (mat as Material).dispose();
        }
      }
    }
  });
}
