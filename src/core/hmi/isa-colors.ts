// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * isa-colors.ts — Canonical ISA-101 status colors used across HMI elements.
 *
 * Centralizes the dark-theme MUI palette tones for status (success / warning /
 * error / info). These four hex values were previously duplicated across 40+
 * files. Use these constants instead of hardcoding the hex strings.
 *
 * The values intentionally match the dark MUI theme palette in `theme.ts`:
 *   success.main  → ISA_GREEN
 *   warning.main  → ISA_AMBER
 *   error.main    → ISA_RED
 *   info / cyan   → ISA_CYAN
 *
 * `connectionStateColor()` is a tiny convenience used by interface/status panels
 * that map a connection-state string to one of the four colors.
 */

/** ISA-101 GO / success / connected — MUI dark `success.main`. */
export const ISA_GREEN = '#66bb6a';

/** ISA-101 WARNING / connecting / pending — MUI dark `warning.main`. */
export const ISA_AMBER = '#ffa726';

/** ISA-101 ALARM / error / disconnected-error — MUI dark `error.main`. */
export const ISA_RED = '#ef5350';

/** Cyan / info accent (used for selection highlights and info badges). */
export const ISA_CYAN = '#0288d1';

/** Connection-state string accepted by `connectionStateColor()`. */
export type ConnectionStateLike =
  | 'connected'
  | 'connecting'
  | 'error'
  | 'disconnected'
  | string;

/**
 * Map a connection-state string to its canonical ISA color.
 *
 *   'connected'   → ISA_GREEN
 *   'connecting'  → ISA_AMBER
 *   'error'       → ISA_RED
 *   anything else → undefined (caller decides fallback)
 */
export function connectionStateColor(state: ConnectionStateLike): string | undefined {
  if (state === 'connected') return ISA_GREEN;
  if (state === 'connecting') return ISA_AMBER;
  if (state === 'error') return ISA_RED;
  return undefined;
}
