// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Central list of all localStorage keys used by the WebViewer. */

export const ALL_RV_STORAGE_KEYS = [
  'rv-visual-settings',
  'rv-search-settings',
  'rv-interface-settings',
  'rv-webviewer-last-model',
  'rv-webviewer-renderer',
  'rv-debug',
  'rv-extras-overlay',
  // Hierarchy & Inspector keys
  'rv-extras-editor-width',
  'rv-extras-editor-open',
  'rv-extras-editor-selected',
  'rv-hierarchy-expanded',
  'rv-hierarchy-type-filter',
  'rv-hierarchy-signal-sort',
  'rv-inspector-collapsed',
  'rv-inspector-consumed-only',
  'rv-group-visibility',
  'rv-maintenance-progress',
  'rv-ai-bridge',
  'rv-multiuser-settings',
  'rv-source-markers-visible',
  'rv-toolbar-show-labels',
  'rv-left-panel-active',
  'rv-layout-library-urls',
  'rv-layout-autosave',
  'rv-layout-grid-enabled',
  'rv-layout-grid-size',
  'rv-layout-drop-to-surface',
  'rv-layout-active-tab',
  'rv-layout-bbox-snap-mid',
  'rv-layout-bbox-snap-side',
  'rv-layout-bbox-snap-tolerance',
  'rv-layout-show-neighbor-distances',
  'rv-layout-neighbor-distance-max',
  'rv-unity-cloud-config',
  'rv-layouts-index',
  'rv-scene-active',
  'rv-models-window-open',
  'rv-local-folders',
  'rv-splat-transform',  // legacy — transforms now managed via PlacedComponent
] as const;

/**
 * sessionStorage keys used by the WebViewer.
 * These are automatically cleared by the browser when the tab closes, so they
 * are NOT included in ALL_RV_STORAGE_KEYS / clearAllRVStorage(). Listed here
 * for documentation + grep-ability.
 */
export const ALL_RV_SESSION_STORAGE_KEYS = [
  'rv-sensor-history',   // Floating SensorHistoryPanel layout (plan-156)
  'rv-order-cart',       // Order Manager cart state
] as const;

/**
 * Prefixes for dynamic localStorage keys (keyed by GLB name).
 * Used by `clearAllRVStorage()` to scan and remove these entries.
 */
export const RV_DYNAMIC_PREFIXES = [
  'rv-extras-overlay:',
  'rv-extras-originals:',
  'rv-annotations-',
  'rv-measurements-',
  'rv-panel-',
  'rv-panel-geo:',
  'rv-order-',
  'rv-camera-start:',
  'rv-login-',    // login gate keys
  'rv-layouts/',  // multi-layout registry entries (rv-layouts/<id>)
] as const;

/**
 * Clear all known realvirtual localStorage keys, including dynamic ones.
 * This handles both the static keys in ALL_RV_STORAGE_KEYS and
 * dynamic keys that match RV_DYNAMIC_PREFIXES.
 */
export function clearAllRVStorage(): void {
  // Clear static keys
  for (const key of ALL_RV_STORAGE_KEYS) {
    localStorage.removeItem(key);
  }
  // Clear dynamic prefix-based keys
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && RV_DYNAMIC_PREFIXES.some(prefix => key.startsWith(prefix))) {
      keysToRemove.push(key);
    }
  }
  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }
}
