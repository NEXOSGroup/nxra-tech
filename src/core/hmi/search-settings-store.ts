// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Persists search/filter settings to localStorage. Supports self-registering filter subscribers. */

import { getAppConfig } from '../rv-app-config';
import { lsLoad, lsSave } from './ls-store-utils';

const STORAGE_KEY = 'rv-search-settings';

/** A filter subscriber that registers itself (Drives, Sensors, etc.). */
export interface FilterSubscriber {
  id: string;             // e.g. 'Drive', 'Sensor', 'TransportSurface'
  label: string;          // e.g. 'Drives', 'Sensors', 'Conveyors'
  componentType: string;  // NodeRegistry type key
}

export interface SearchSettings {
  highlightEnabled: boolean;   // 3D highlight on/off (default: true)
  nodesEnabled: boolean;       // Show untyped nodes (default: true). When false, only typed results appear.
  disabledTypes: string[];     // Subscriber IDs that are DISABLED (default: [])
}

const DEFAULTS: SearchSettings = {
  highlightEnabled: true,
  nodesEnabled: true,
  disabledTypes: [],
};

// ─── Self-Registration ──────────────────────────────────────────

const subscribers: FilterSubscriber[] = [];

export function registerFilterSubscriber(sub: FilterSubscriber): void {
  if (!subscribers.find(s => s.id === sub.id)) {
    subscribers.push(sub);
  }
}

export function getFilterSubscribers(): readonly FilterSubscriber[] {
  return subscribers;
}

// ─── Type Filtering ─────────────────────────────────────────────

/** Check if a node's types pass the active filter settings. */
export function isTypeEnabled(settings: SearchSettings, types: string[]): boolean {
  if (types.length === 0) return settings.nodesEnabled;
  return types.some(t => !settings.disabledTypes.includes(t));
}

// ─── Persistence ────────────────────────────────────────────────

export function loadSearchSettings(): SearchSettings {
  return lsLoad<SearchSettings>(STORAGE_KEY, DEFAULTS, {
    // Reject non-array `disabledTypes` entries to match prior defensive behavior.
    validate: (_merged, parsed) => {
      if (!Array.isArray(parsed.disabledTypes)) return { disabledTypes: [] };
      return {};
    },
    configOverride: getAppConfig().search,
  });
}

export function saveSearchSettings(settings: SearchSettings): void {
  lsSave(STORAGE_KEY, settings);
}
