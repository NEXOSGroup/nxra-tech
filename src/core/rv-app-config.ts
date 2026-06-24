// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * App-level configuration singleton.
 *
 * Loaded from `public/settings.json` before React mounts.
 * Provides lock-mode helpers consumed by settings stores and UI.
 */

import type { VisualSettings } from './hmi/visual-settings-store';
import type { RenderMode } from './rv-render-modes';
import type { InterfaceSettings } from '../interfaces/interface-settings-store';
import type { SearchSettings } from './hmi/search-settings-store';
import type { UIVisibilityRule } from './hmi/ui-context-store';
import { debug } from './engine/rv-debug';

/** Configuration for context-aware UI visibility (loaded from settings.json `ui` key). */
export interface UIContextConfig {
  /** Contexts to activate on startup (e.g. ["kiosk"]). */
  initialContexts?: string[];
  /** Per-element visibility rule overrides — keys are element IDs like 'kpi-bar'. */
  visibilityOverrides?: Record<string, UIVisibilityRule>;
}

/** Settings tab identifiers used for selective locking. */
export type SettingsTabId = 'model' | 'mouse' | 'visual' | 'environment' | 'interfaces' | 'devtools' | 'tests' | 'mcp' | 'multiuser' | 'groups';

/** Top-level app configuration loaded from `public/settings.json`. */
export interface RVAppConfig {
  /** Lock all settings — hides the settings gear button entirely. */
  lockSettings?: boolean;
  /** Selectively lock individual tabs (settings gear still visible). */
  lockedTabs?: SettingsTabId[];
  /** Default model URL or filename (priority: URL param > settings.json defaultModel > last opened > first model). */
  defaultModel?: string;
  /** Base path for project-specific assets (docs, AASX, logos). Relative to BASE_URL. Ends with '/'. */
  projectAssetsPath?: string;

  /** Global plugin IDs — lowest priority, overridden by modelname.json and GLB extras. */
  plugins?: string[];
  /** Global per-plugin config — lowest priority, deep-merged with model-specific config. */
  pluginConfig?: Record<string, Record<string, unknown>>;

  /**
   * Opt-in: load external plugin bundles at runtime via HEAD-then-import.
   * - `./project-plugin.js` (always checked if enabled)
   * - `./models/{modelName}/model-plugin.js` (per-model)
   * Default `false` — leaving it off keeps the network tab clean and skips two
   * HEAD requests per model load. Enable only when deploying external plugin
   * bundles (not bundled by Vite) alongside the viewer.
   */
  externalPlugins?: boolean;

  /** Partial overrides merged on top of localStorage values.
   *  Accepts the legacy `lightingMode` key (renamed to `renderMode`) for back-compat. */
  visual?: Partial<VisualSettings> & { lightingMode?: RenderMode };
  interface?: Partial<InterfaceSettings>;
  search?: Partial<SearchSettings>;

  /** Groups configuration: overlay exclusions and default-hidden groups. */
  groups?: {
    excludedFromOverlay?: string[];
    defaultHiddenGroups?: string[];
  };

  /** Context-aware UI visibility configuration. */
  ui?: UIContextConfig;

  /** Analytics configuration. GA script is only injected when a measurement ID is provided. */
  analytics?: {
    /** Google Analytics 4 Measurement ID (e.g. "G-XXXXXXXXXX"). Omit to disable tracking. */
    googleAnalyticsId?: string;
    /** Privacy-policy URL linked from the consent gate. Omit to hide the link. */
    privacyPolicyUrl?: string;
  };
}

// ─── Build-time feature flags ──────────────────────────────────

/**
 * Is the unified SimulationKernel / ContinuousRunner path enabled? Default ON:
 * the kernel owns the fixed-update orchestration (continuous via ContinuousRunner,
 * DES via the DESRunner). Opt out back to the legacy fixedUpdate path with
 * `VITE_UNIFIED_SIM=0` (or `false`) — a rollback kept available during the soak
 * period before the legacy path + `_physicsPluginActive` are removed.
 *
 * Read via `import.meta.env` so Vite statically replaces it (the value is the
 * raw string '0'/'false'/'1'/'true' or undefined).
 */
export function isUnifiedSimEnabled(): boolean {
  const v = import.meta.env.VITE_UNIFIED_SIM;
  return v !== '0' && v !== 'false';
}

// ─── Singleton State ───────────────────────────────────────────

let _config: RVAppConfig = {};

/** Replace the current app config (call once in main.ts before React mount). */
export function setAppConfig(config: RVAppConfig): void {
  _config = config;
}

/** Read the current app config. */
export function getAppConfig(): RVAppConfig {
  return _config;
}

/** True when the entire settings dialog should be hidden. */
export function isSettingsLocked(): boolean {
  return _config.lockSettings === true;
}

/** True when a specific settings tab should be hidden/disabled. */
export function isTabLocked(tab: SettingsTabId): boolean {
  if (_config.lockSettings) return true;
  return _config.lockedTabs?.includes(tab) ?? false;
}

// ─── Fetch ─────────────────────────────────────────────────────

/**
 * Fetch `public/settings.json`. Returns `{}` silently on 404, network error,
 * or invalid JSON so the app always boots with defaults.
 */
export async function fetchAppConfig(): Promise<RVAppConfig> {
  try {
    // Use BASE_URL (not a bare relative path) so it resolves correctly under
    // sub-folder deploys (e.g. Bunny CDN /demo/) regardless of a trailing slash.
    const resp = await fetch(`${import.meta.env.BASE_URL}settings.json?v=${Date.now()}`, { cache: 'no-store' });
    if (!resp.ok) {
      debug('config', 'No settings.json found, using defaults');
      return {};
    }
    const json: unknown = await resp.json();
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      console.warn('[config] settings.json is not a JSON object, ignoring');
      return {};
    }
    const keys = Object.keys(json);
    debug('config', `Loaded settings.json (${keys.length} key${keys.length !== 1 ? 's' : ''})`);
    return json as RVAppConfig;
  } catch {
    debug('config', 'No settings.json found, using defaults');
    return {};
  }
}

// ─── Analytics ────────────────────────────────────────────────

let _analyticsInjected = false;

/**
 * Inject Google Analytics 4 if configured in settings.json.
 * No-op when `analytics.googleAnalyticsId` is absent — AGPL source ships clean.
 *
 * Idempotent: only injects once. GA is a non-essential tracker, so callers
 * MUST gate this behind consent (see consent-gate / consent-store) — main.ts
 * only calls it after the consent gate resolves.
 */
export function initAnalytics(): void {
  if (_analyticsInjected) return;
  const gaId = _config.analytics?.googleAnalyticsId;
  if (!gaId) return;
  _analyticsInjected = true;

  // Inject gtag.js script
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(gaId)}`;
  document.head.appendChild(script);

  // Initialize dataLayer and config
  const w = window as unknown as Record<string, unknown>;
  w.dataLayer = w.dataLayer || [];
  function gtag(...args: unknown[]) { (w.dataLayer as unknown[]).push(args); }
  // Expose gtag globally so trackAnalyticsEvent() can fire GA4 custom events.
  w.gtag = gtag;
  gtag('js', new Date());
  gtag('config', gaId);

  debug('config', `Google Analytics initialized: ${gaId}`);
}

/**
 * Fire a GA4 custom event. No-op when analytics was never injected (no id
 * configured, or consent not granted) — gtag is only present after initAnalytics.
 * Used to distinguish what the visitor is looking at (e.g. standard demo model
 * vs. planner workspace) without any extra tracking infrastructure.
 */
export function trackAnalyticsEvent(name: string, params?: Record<string, unknown>): void {
  const gtag = (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
  if (!gtag) return;
  gtag('event', name, params ?? {});
}
