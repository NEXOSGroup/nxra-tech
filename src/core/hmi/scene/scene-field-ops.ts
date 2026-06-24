// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * scene-field-ops.ts — Tiny helper to persist a component-field edit through the
 * SceneStore op log (same `setField` op the property inspector uses).
 *
 * Lets non-inspector editors (IK Quick-Edit popover, IK path reorder/delete)
 * write `userData.realvirtual[componentType][fieldName] = value` durably and
 * undoably without re-implementing the op plumbing. No-op when no SceneStore is
 * present (tests / pre-boot) — callers keep their own optimistic runtime update.
 */

import { getSceneStore } from './scene-store-singleton';
import { freshOpId } from './rv-scene-edits';

/** Persist a single component-field edit as a setField op (no-op without a SceneStore). */
export function persistFieldOp(
  nodePath: string,
  componentType: string,
  fieldName: string,
  value: unknown,
  prev: unknown,
): void {
  const store = getSceneStore();
  if (!store) return;
  void store.applyOp({
    id: freshOpId(), ts: Date.now(), schemaV: 1,
    kind: 'setField', nodePath, componentType, fieldName, value, prev,
  });
}
