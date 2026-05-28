// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Localizable strings for the snap-point feature.
 *
 * Light-weight string table — no i18n framework. Add new locales by extending
 * the union of keys. UI components read via `t(key)`.
 */

type StringKey =
  | 'picker.title'
  | 'picker.empty'
  | 'picker.loading'
  | 'picker.cancel'
  | 'picker.occupied'
  | 'toolbar.showSnaps'
  | 'error.nonUniformScale'
  | 'error.occupied'
  | 'error.missingSnap';

const EN: Record<StringKey, string> = {
  'picker.title': 'Pick component for',
  'picker.empty': 'No compatible components',
  'picker.loading': 'Loading library…',
  'picker.cancel': 'ESC to cancel',
  'picker.occupied': 'Position occupied',
  'toolbar.showSnaps': 'Show Snap-Points',
  'error.nonUniformScale': 'Asset has non-uniform scale — snap placement not possible',
  'error.occupied': 'Snap point is already occupied',
  'error.missingSnap': 'Snap point not found in library asset',
};

export function t(key: StringKey): string {
  return EN[key] ?? key;
}
