// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Vector2 } from 'three';

/** Pre-allocated output — callers should NOT store the returned reference. */
const _ndc = new Vector2();

/**
 * Convert pointer client coordinates to Normalized Device Coordinates [-1, +1].
 * Accounts for canvas offset via getBoundingClientRect().
 */
export function pointerToNDC(
  clientX: number,
  clientY: number,
  domElement: HTMLElement,
  out: Vector2 = _ndc,
): Vector2 {
  const rect = domElement.getBoundingClientRect();
  out.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  out.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  return out;
}
