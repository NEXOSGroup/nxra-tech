// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * layout-predicates.ts — Pure predicate functions for layout instance detection.
 *
 * Extracted to a leaf module to break circular dependencies between
 * index.ts, canvas-interaction.ts, and multi-select-pivot.ts.
 */

import type { Object3D } from 'three';

/** True if the Object3D is a layout instance placed by the planner. */
export function isLayoutInstance(obj: Object3D): boolean {
  return typeof obj.userData?._layoutId === 'string' && !obj.userData?._isGhost;
}

/** True if the layout instance has been locked against editing. */
export function isLockedLayoutInstance(obj: Object3D): boolean {
  const rv = obj.userData?.realvirtual as Record<string, unknown> | undefined;
  const lo = rv?.LayoutObject as Record<string, unknown> | undefined;
  return !!lo?.Locked;
}

/** Walk parent chain to find the nearest layout-instance ancestor (or self). */
export function findLayoutAncestor(obj: Object3D): Object3D | null {
  let cur: Object3D | null = obj;
  while (cur) {
    if (isLayoutInstance(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}
