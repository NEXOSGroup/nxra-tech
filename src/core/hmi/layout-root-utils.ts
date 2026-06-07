// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared helpers for walking from any scene node up to the placed-library-asset
 * (LayoutObject) root that owns it. A LayoutObject root carries BOTH a string
 * `userData._layoutId` (set by the layout-planner) AND a non-empty
 * `userData.realvirtual.LayoutObject` marker (the library-placement
 * distinguisher).
 */

import type { Object3D } from 'three';

export function isPlacedLibraryAsset(node: Object3D): boolean {
  const ud = node.userData;
  if (!ud || typeof ud._layoutId !== 'string') return false;
  if (ud._isGhost) return false;
  const rv = ud.realvirtual as Record<string, unknown> | undefined;
  return !!(rv && rv.LayoutObject);
}

/** Nearest ancestor (self included) that is a placed library asset, or null. */
export function findLayoutRoot(node: Object3D | null): Object3D | null {
  let cur: Object3D | null = node;
  while (cur) {
    if (isPlacedLibraryAsset(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}
