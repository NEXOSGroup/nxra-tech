// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Per-instance signal scoping for placed library assets.
 *
 * Signals are keyed globally by name in the SignalStore, so two placed copies of
 * the same library asset would collide on names like `Conveyor.Run` or `Sensor`.
 * To isolate them, signal names are prefixed with the nearest enclosing
 * LayoutObject root name (which the layout planner de-duplicates per placement,
 * e.g. `RollConveyor2m`, `RollConveyor2m_2`).
 *
 * Both producers of a scoped name (the behavior bind context for declared signals,
 * and RVSensor for its occupied signal) derive the scope from the SAME LayoutObject
 * root, so the names always meet.
 */

import type { Object3D } from 'three';

/**
 * Nearest enclosing LayoutObject root name (self included), or '' if the node is
 * not inside a placed LayoutObject (i.e. a standalone-loaded asset).
 *
 * A LayoutObject root is marked by `userData.realvirtual.LayoutObject` (set in the
 * layout planner's `addPlacedToScene`).
 */
export function instanceScope(node: Object3D): string {
  let cur: Object3D | null = node;
  while (cur) {
    const rv = cur.userData?.realvirtual as Record<string, unknown> | undefined;
    if (rv && rv.LayoutObject) return cur.name;
    cur = cur.parent;
  }
  return '';
}

/**
 * Apply an instance scope to a signal name.
 *   - `''` scope (standalone) → name unchanged (backward compatible).
 *   - leading `/` → global signal: strip the `/`, never prefix (shared E-stop etc.).
 *   - otherwise → `${scope}/${name}`.
 */
export function scopeSignalName(scope: string, name: string): string {
  if (name.startsWith('/')) return name.slice(1);
  return scope ? `${scope}/${name}` : name;
}
