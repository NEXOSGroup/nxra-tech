// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * settings-tab-store — request the Settings panel to open on a specific tab.
 *
 * A caller (e.g. the AI activity button) opens the panel and calls
 * `requestSettingsTab(value)`; SettingsPanel consumes the request once and
 * switches to that tab. The tab values are the same numeric ids SettingsPanel
 * uses (e.g. AI = 5).
 */

import { useSyncExternalStore } from 'react';

let _requested: number | null = null;
const listeners = new Set<() => void>();

/** Ask the Settings panel to switch to `value` (consumed once by SettingsPanel). */
export function requestSettingsTab(value: number): void {
  _requested = value;
  for (const l of listeners) l();
}

/** The pending requested tab, or null. */
export function getRequestedSettingsTab(): number | null {
  return _requested;
}

/** Clear the pending request (SettingsPanel calls this after applying it). */
export function clearRequestedSettingsTab(): void {
  _requested = null;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** React hook — the pending requested tab (null when none). */
export function useRequestedSettingsTab(): number | null {
  return useSyncExternalStore(subscribe, getRequestedSettingsTab, getRequestedSettingsTab);
}
