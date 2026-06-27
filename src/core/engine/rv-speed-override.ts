// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Central drive-speed override — a single master factor that scales the
 * effective speed of every Drive at runtime (continuous simulation).
 *
 * 1 = normal, 0.5 = half speed, 2 = double, 0 = stopped. Relative speeds
 * between drives are preserved (it multiplies each drive's targetSpeed).
 * RVDrive reads it in its fixed update; the UI and the MCP tool
 * `web_drive_speed_override` set it. Not persisted — it is a live override.
 */

let _factor = 1;
const listeners = new Set<() => void>();

/** Current master speed factor (1 = normal). */
export function getDriveSpeedOverride(): number {
  return _factor;
}

/** Set the master speed factor. Clamped to [0, 100]. */
export function setDriveSpeedOverride(factor: number): number {
  const f = Number.isFinite(factor) ? Math.max(0, Math.min(factor, 100)) : 1;
  if (f !== _factor) {
    _factor = f;
    for (const l of listeners) l();
  }
  return _factor;
}

/** Subscribe to override changes (for reactive UI). Returns an unsubscribe fn. */
export function subscribeDriveSpeedOverride(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
