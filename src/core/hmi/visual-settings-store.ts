// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Persists visual settings and camera bookmarks to localStorage. */

import { useSyncExternalStore } from 'react';
import { getAppConfig } from '../rv-app-config';
import { lsSave } from './ls-store-utils';

const STORAGE_KEY = 'rv-visual-settings';
/** Standalone scalar key for the "show source markers" toggle (plan-181).
 *  Kept separate from the main `rv-visual-settings` blob so it can be flipped
 *  in isolation (and so existing visual-settings consumers don't see schema
 *  churn). Listed in `ALL_RV_STORAGE_KEYS` for cleanup-sweep coverage. */
const SOURCE_MARKERS_KEY = 'rv-source-markers-visible';

export type LightingMode = 'simple' | 'default';
export const LIGHTING_MODES: readonly LightingMode[] = ['simple', 'default'] as const;

export type ToneMappingType = 'none' | 'linear' | 'reinhard' | 'cineon' | 'aces' | 'agx' | 'neutral';
export const TONE_MAPPING_OPTIONS: readonly ToneMappingType[] = ['none', 'linear', 'reinhard', 'cineon', 'aces', 'agx', 'neutral'] as const;

export type ShadowQuality = 'low' | 'medium' | 'high';
export const SHADOW_QUALITY_OPTIONS: readonly ShadowQuality[] = ['low', 'medium', 'high'] as const;

export type ProjectionType = 'perspective' | 'orthographic';

/** Ambient-occlusion backend selection.
 *  - `'off'`  : AO disabled entirely.
 *  - `'gtao'` : three.js built-in GTAOPass (current default, smaller bundle).
 *  - `'n8ao'` : N8AO pass (higher visual quality, lazy-loaded on first use). */
export type AOMode = 'off' | 'gtao' | 'n8ao';
export const AO_MODES: readonly AOMode[] = ['off', 'gtao', 'n8ao'] as const;

export interface LightingModeSettings {
  lightIntensity: number;
  toneMapping: ToneMappingType;
  toneMappingExposure: number;
  ambientColor: string;
  ambientIntensity: number;
  dirLightEnabled: boolean;
  dirLightColor: string;
  dirLightIntensity: number;
  shadowEnabled: boolean;
  shadowIntensity: number;
  shadowQuality: ShadowQuality;
}

export interface CameraBookmark {
  px: number; py: number; pz: number;
  tx: number; ty: number; tz: number;
}

export interface VisualSettings {
  lightingMode: LightingMode;
  modeSettings: Record<LightingMode, LightingModeSettings>;
  projection: ProjectionType;
  fov: number;
  cameras: (CameraBookmark | null)[];
  /** Whether native MSAA antialiasing is enabled (requires page reload to change). */
  antialias: boolean;
  /** Shadow map resolution in pixels (512, 1024, or 2048). */
  shadowMapSize: number;
  /** Shadow softness radius (1-5). */
  shadowRadius: number;
  /** Maximum device pixel ratio (1.0 = performance, 1.5 = balanced, native = quality). */
  maxDpr: number;
  /** FPV walk speed in m/s. */
  fpvSpeed: number;
  /** FPV sprint speed in m/s. */
  fpvSprintSpeed: number;
  /** FPV mouse look sensitivity (radians per pixel). */
  fpvSensitivity: number;
  /** FPV eye height above ground in meters. */
  fpvEyeHeight: number;
  /** Ambient-occlusion backend: 'off' | 'gtao' | 'n8ao'. WebGL only; on WebGPU
   *  this is effectively ignored (AO is a no-op). Supersedes the legacy
   *  `ssaoEnabled` boolean — the boolean is derived from this for back-compat. */
  aoMode: AOMode;
  /** AO blend intensity (0 = invisible, 1 = full). Shared between backends. */
  ssaoIntensity: number;
  /** AO sampling radius in world units. Shared between backends. */
  ssaoRadius: number;
  /** Whether bloom (glow on bright areas) is enabled. WebGL only. */
  bloomEnabled: boolean;
  /** Bloom glow intensity (0–2). */
  bloomIntensity: number;
  /** Brightness threshold for bloom (0–1). Only pixels above this luminance bloom. */
  bloomThreshold: number;
  /** Bloom spread radius (0–1). */
  bloomRadius: number;
  /** Whether the ground (floor) plane is visible. */
  groundEnabled: boolean;
  /** Floor brightness multiplier (0 = black, 1 = default, 2 = double). */
  groundBrightness: number;
  /** Floor base color as #rrggbb hex. Combined with `groundBrightness` to drive
   *  the actual ground material tint (color × brightness, component-wise). */
  groundColor: string;
  /** Scene background brightness multiplier (0 = black, 1 = default gray, 2 = white). */
  backgroundBrightness: number;
  /** Floor checker pattern contrast multiplier (0 = flat midgray, 1 = default, 2 = doubled). */
  checkerContrast: number;
  /** Zoom factor for the React HMI overlay (0.5–2.0, default 1.0). */
  uiZoom: number;
  /** OrbitControls rotate speed multiplier (0.1–3.0, default 1.0). */
  orbitRotateSpeed: number;
  /** OrbitControls pan speed multiplier (0.1–3.0, default 1.0). */
  orbitPanSpeed: number;
  /** OrbitControls zoom speed for mouse wheel, trackpad, and touch pinch (0.1–3.0, default 1.0). */
  orbitZoomSpeed: number;
  /** OrbitControls damping factor — inertia feel (0.01–0.5, default 0.08). */
  orbitDampingFactor: number;
  /** Distance-adaptive navigation: scales zoom/pan speed proportionally to camera–target distance (opt-in). */
  distanceAdaptiveNav?: boolean;
}

/** Single source of truth for OrbitControls navigation-sensitivity ranges (UI sliders + clamping). */
export const NAVIGATION_RANGES = {
  rotateSpeed:   { min: 0.1,  max: 3.0, step: 0.05 },
  panSpeed:      { min: 0.1,  max: 3.0, step: 0.05 },
  zoomSpeed:     { min: 0.1,  max: 3.0, step: 0.1  },
  dampingFactor: { min: 0.01, max: 0.5, step: 0.01 },
} as const;

function clampNavNumber(raw: unknown, range: { min: number; max: number }, fallback: number): number {
  if (typeof raw !== 'number' || Number.isNaN(raw)) return fallback;
  if (raw < range.min || raw > range.max) return fallback;
  return raw;
}

const MODE_DEFAULTS: Record<LightingMode, LightingModeSettings> = {
  simple: {
    lightIntensity: 1.0, toneMapping: 'none', toneMappingExposure: 1.0,
    ambientColor: '#ffffff', ambientIntensity: 1.0,
    dirLightEnabled: false, dirLightColor: '#ffffff', dirLightIntensity: 1.5,
    shadowEnabled: false, shadowIntensity: 0.5, shadowQuality: 'medium',
  },
  default: {
    lightIntensity: 0.5, toneMapping: 'neutral', toneMappingExposure: 1.0,
    ambientColor: '#404040', ambientIntensity: 0.75,
    dirLightEnabled: true, dirLightColor: '#ffffff', dirLightIntensity: 1.5,
    shadowEnabled: true, shadowIntensity: 0.95, shadowQuality: 'medium',
  },
};

const DEFAULTS: VisualSettings = {
  lightingMode: 'default',
  modeSettings: {
    simple:  { ...MODE_DEFAULTS.simple },
    default: { ...MODE_DEFAULTS.default },
  },
  projection: 'perspective' as ProjectionType,
  fov: 45,
  cameras: [null, null, null],
  antialias: true,
  shadowMapSize: 1024,
  shadowRadius: 2,
  maxDpr: 1.5,
  fpvSpeed: 2.5,
  fpvSprintSpeed: 5.0,
  fpvSensitivity: 0.002,
  fpvEyeHeight: 1.7,
  aoMode: 'gtao',
  ssaoIntensity: 0.35,
  ssaoRadius: 0.03,
  bloomEnabled: true,
  bloomIntensity: 0.2,
  bloomThreshold: 0.85,
  bloomRadius: 0.4,
  groundEnabled: true,
  groundBrightness: 1.0,
  groundColor: '#ffffff',
  backgroundBrightness: 1.0,
  checkerContrast: 1.0,
  uiZoom: 1.0,
  orbitRotateSpeed: 1.0,
  orbitPanSpeed: 1.0,
  orbitZoomSpeed: 1.0,
  orbitDampingFactor: 0.08,
  distanceAdaptiveNav: false,
};

function migrateToneMapping(raw: unknown, mode: LightingMode): ToneMappingType {
  if (typeof raw === 'string' && (TONE_MAPPING_OPTIONS as readonly string[]).includes(raw)) return raw as ToneMappingType;
  if (raw === true) return 'neutral';
  if (raw === false) return 'none';
  return MODE_DEFAULTS[mode].toneMapping;
}

function parseModeSettings(raw: unknown): Record<LightingMode, LightingModeSettings> {
  const result: Record<LightingMode, LightingModeSettings> = {
    simple:  { ...MODE_DEFAULTS.simple },
    default: { ...MODE_DEFAULTS.default },
  };
  if (typeof raw !== 'object' || raw === null) return result;
  const obj = raw as Record<string, Partial<LightingModeSettings> & { toneMapping?: unknown }>;
  for (const mode of LIGHTING_MODES) {
    if (obj[mode]) {
      const d = MODE_DEFAULTS[mode];
      const s = obj[mode];
      result[mode].lightIntensity = s.lightIntensity ?? d.lightIntensity;
      result[mode].toneMapping = migrateToneMapping(s.toneMapping, mode);
      result[mode].toneMappingExposure = s.toneMappingExposure ?? d.toneMappingExposure;
      result[mode].ambientColor = s.ambientColor ?? d.ambientColor;
      result[mode].ambientIntensity = s.ambientIntensity ?? d.ambientIntensity;
      result[mode].dirLightEnabled = s.dirLightEnabled ?? d.dirLightEnabled;
      result[mode].dirLightColor = s.dirLightColor ?? d.dirLightColor;
      result[mode].dirLightIntensity = s.dirLightIntensity ?? d.dirLightIntensity;
      result[mode].shadowEnabled = s.shadowEnabled ?? d.shadowEnabled;
      result[mode].shadowIntensity = s.shadowIntensity ?? d.shadowIntensity;
      result[mode].shadowQuality = (s.shadowQuality && (SHADOW_QUALITY_OPTIONS as readonly string[]).includes(s.shadowQuality)) ? s.shadowQuality : d.shadowQuality;
    }
  }
  return result;
}

export function loadVisualSettings(): VisualSettings {
  const fromStorage = loadFromLocalStorage();
  const override = getAppConfig().visual;
  if (!override) return fromStorage;
  return {
    lightingMode: override.lightingMode ?? fromStorage.lightingMode,
    modeSettings: fromStorage.modeSettings,
    projection: override.projection ?? fromStorage.projection,
    fov: override.fov ?? fromStorage.fov,
    cameras: fromStorage.cameras,
    antialias: fromStorage.antialias,
    shadowMapSize: fromStorage.shadowMapSize,
    shadowRadius: fromStorage.shadowRadius,
    maxDpr: fromStorage.maxDpr,
    fpvSpeed: fromStorage.fpvSpeed,
    fpvSprintSpeed: fromStorage.fpvSprintSpeed,
    fpvSensitivity: fromStorage.fpvSensitivity,
    fpvEyeHeight: fromStorage.fpvEyeHeight,
    aoMode: fromStorage.aoMode,
    ssaoIntensity: fromStorage.ssaoIntensity,
    ssaoRadius: fromStorage.ssaoRadius,
    bloomEnabled: fromStorage.bloomEnabled,
    bloomIntensity: fromStorage.bloomIntensity,
    bloomThreshold: fromStorage.bloomThreshold,
    bloomRadius: fromStorage.bloomRadius,
    groundEnabled: fromStorage.groundEnabled,
    groundBrightness: fromStorage.groundBrightness,
    groundColor: fromStorage.groundColor,
    backgroundBrightness: fromStorage.backgroundBrightness,
    checkerContrast: fromStorage.checkerContrast,
    uiZoom: fromStorage.uiZoom,
    orbitRotateSpeed: clampNavNumber(
      override.orbitRotateSpeed,
      NAVIGATION_RANGES.rotateSpeed,
      fromStorage.orbitRotateSpeed,
    ),
    orbitPanSpeed: clampNavNumber(
      override.orbitPanSpeed,
      NAVIGATION_RANGES.panSpeed,
      fromStorage.orbitPanSpeed,
    ),
    orbitZoomSpeed: clampNavNumber(
      override.orbitZoomSpeed,
      NAVIGATION_RANGES.zoomSpeed,
      fromStorage.orbitZoomSpeed,
    ),
    orbitDampingFactor: clampNavNumber(
      override.orbitDampingFactor,
      NAVIGATION_RANGES.dampingFactor,
      fromStorage.orbitDampingFactor,
    ),
    distanceAdaptiveNav: fromStorage.distanceAdaptiveNav,
  };
}

function loadFromLocalStorage(): VisualSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS, modeSettings: { simple: { ...MODE_DEFAULTS.simple }, default: { ...MODE_DEFAULTS.default } }, cameras: [...DEFAULTS.cameras] };
    const parsed = JSON.parse(raw) as Partial<VisualSettings> & { lightIntensity?: number; qualityPreset?: string };
    const mode = (parsed.lightingMode && LIGHTING_MODES.includes(parsed.lightingMode)) ? parsed.lightingMode : DEFAULTS.lightingMode;
    const modeSettings = parseModeSettings(parsed.modeSettings);
    if (typeof parsed.lightIntensity === 'number' && !parsed.modeSettings) {
      modeSettings[mode].lightIntensity = parsed.lightIntensity;
    }
    const projection = (parsed.projection === 'perspective' || parsed.projection === 'orthographic') ? parsed.projection : DEFAULTS.projection;
    const antialiasRaw = (parsed as Record<string, unknown>).antialias;
    const antialias = typeof antialiasRaw === 'boolean' ? antialiasRaw : DEFAULTS.antialias;
    const shadowMapSizeRaw = (parsed as Record<string, unknown>).shadowMapSize;
    const shadowMapSize = (typeof shadowMapSizeRaw === 'number' && [512, 1024, 2048].includes(shadowMapSizeRaw))
      ? shadowMapSizeRaw : DEFAULTS.shadowMapSize;
    const shadowRadiusRaw = (parsed as Record<string, unknown>).shadowRadius;
    const shadowRadius = (typeof shadowRadiusRaw === 'number' && shadowRadiusRaw >= 1 && shadowRadiusRaw <= 5)
      ? shadowRadiusRaw : DEFAULTS.shadowRadius;
    const maxDprRaw = (parsed as Record<string, unknown>).maxDpr;
    const maxDpr = (typeof maxDprRaw === 'number' && maxDprRaw >= 0.5 && maxDprRaw <= 4)
      ? maxDprRaw : DEFAULTS.maxDpr;
    const fpvSpeedRaw = (parsed as Record<string, unknown>).fpvSpeed;
    const fpvSpeed = (typeof fpvSpeedRaw === 'number' && fpvSpeedRaw >= 0.5 && fpvSpeedRaw <= 20)
      ? fpvSpeedRaw : DEFAULTS.fpvSpeed;
    const fpvSprintSpeedRaw = (parsed as Record<string, unknown>).fpvSprintSpeed;
    const fpvSprintSpeed = (typeof fpvSprintSpeedRaw === 'number' && fpvSprintSpeedRaw >= 1 && fpvSprintSpeedRaw <= 40)
      ? fpvSprintSpeedRaw : DEFAULTS.fpvSprintSpeed;
    const fpvSensitivityRaw = (parsed as Record<string, unknown>).fpvSensitivity;
    const fpvSensitivity = (typeof fpvSensitivityRaw === 'number' && fpvSensitivityRaw >= 0.0005 && fpvSensitivityRaw <= 0.01)
      ? fpvSensitivityRaw : DEFAULTS.fpvSensitivity;
    const fpvEyeHeightRaw = (parsed as Record<string, unknown>).fpvEyeHeight;
    const fpvEyeHeight = (typeof fpvEyeHeightRaw === 'number' && fpvEyeHeightRaw >= 0.5 && fpvEyeHeightRaw <= 5)
      ? fpvEyeHeightRaw : DEFAULTS.fpvEyeHeight;
    // aoMode migration: prefer explicit `aoMode`; fall back to legacy
    // boolean `ssaoEnabled` (true → 'gtao', false → 'off'); finally DEFAULTS.
    const aoModeRaw = (parsed as Record<string, unknown>).aoMode;
    const ssaoEnabledRaw = (parsed as Record<string, unknown>).ssaoEnabled;
    let aoMode: AOMode;
    if (typeof aoModeRaw === 'string' && (AO_MODES as readonly string[]).includes(aoModeRaw)) {
      aoMode = aoModeRaw as AOMode;
    } else if (typeof ssaoEnabledRaw === 'boolean') {
      aoMode = ssaoEnabledRaw ? 'gtao' : 'off';
    } else {
      aoMode = DEFAULTS.aoMode;
    }
    const ssaoIntensityRaw = (parsed as Record<string, unknown>).ssaoIntensity;
    const ssaoIntensity = (typeof ssaoIntensityRaw === 'number' && ssaoIntensityRaw >= 0 && ssaoIntensityRaw <= 2)
      ? ssaoIntensityRaw : DEFAULTS.ssaoIntensity;
    const ssaoRadiusRaw = (parsed as Record<string, unknown>).ssaoRadius;
    const ssaoRadius = (typeof ssaoRadiusRaw === 'number' && ssaoRadiusRaw >= 0.01 && ssaoRadiusRaw <= 1)
      ? ssaoRadiusRaw : DEFAULTS.ssaoRadius;
    const bloomEnabledRaw = (parsed as Record<string, unknown>).bloomEnabled;
    const bloomEnabled = typeof bloomEnabledRaw === 'boolean' ? bloomEnabledRaw : DEFAULTS.bloomEnabled;
    const bloomIntensityRaw = (parsed as Record<string, unknown>).bloomIntensity;
    const bloomIntensity = (typeof bloomIntensityRaw === 'number' && bloomIntensityRaw >= 0 && bloomIntensityRaw <= 2)
      ? bloomIntensityRaw : DEFAULTS.bloomIntensity;
    const bloomThresholdRaw = (parsed as Record<string, unknown>).bloomThreshold;
    const bloomThreshold = (typeof bloomThresholdRaw === 'number' && bloomThresholdRaw >= 0 && bloomThresholdRaw <= 1)
      ? bloomThresholdRaw : DEFAULTS.bloomThreshold;
    const bloomRadiusRaw = (parsed as Record<string, unknown>).bloomRadius;
    const bloomRadius = (typeof bloomRadiusRaw === 'number' && bloomRadiusRaw >= 0 && bloomRadiusRaw <= 1)
      ? bloomRadiusRaw : DEFAULTS.bloomRadius;
    const groundEnabledRaw = (parsed as Record<string, unknown>).groundEnabled;
    const groundEnabled = typeof groundEnabledRaw === 'boolean' ? groundEnabledRaw : DEFAULTS.groundEnabled;
    const groundBrightnessRaw = (parsed as Record<string, unknown>).groundBrightness;
    const groundBrightness = (typeof groundBrightnessRaw === 'number' && groundBrightnessRaw >= 0 && groundBrightnessRaw <= 2)
      ? groundBrightnessRaw : DEFAULTS.groundBrightness;
    const groundColorRaw = (parsed as Record<string, unknown>).groundColor;
    const groundColor = (typeof groundColorRaw === 'string' && /^#[0-9a-fA-F]{6}$/.test(groundColorRaw))
      ? groundColorRaw : DEFAULTS.groundColor;
    const backgroundBrightnessRaw = (parsed as Record<string, unknown>).backgroundBrightness;
    const backgroundBrightness = (typeof backgroundBrightnessRaw === 'number' && backgroundBrightnessRaw >= 0 && backgroundBrightnessRaw <= 2)
      ? backgroundBrightnessRaw : DEFAULTS.backgroundBrightness;
    const checkerContrastRaw = (parsed as Record<string, unknown>).checkerContrast;
    const checkerContrast = (typeof checkerContrastRaw === 'number' && checkerContrastRaw >= 0 && checkerContrastRaw <= 2)
      ? checkerContrastRaw : DEFAULTS.checkerContrast;
    const uiZoomRaw = (parsed as Record<string, unknown>).uiZoom;
    const uiZoom = (typeof uiZoomRaw === 'number' && uiZoomRaw >= 0.5 && uiZoomRaw <= 2)
      ? uiZoomRaw : DEFAULTS.uiZoom;
    const orbitRotateSpeed = clampNavNumber(
      (parsed as Record<string, unknown>).orbitRotateSpeed,
      NAVIGATION_RANGES.rotateSpeed,
      DEFAULTS.orbitRotateSpeed,
    );
    const orbitPanSpeed = clampNavNumber(
      (parsed as Record<string, unknown>).orbitPanSpeed,
      NAVIGATION_RANGES.panSpeed,
      DEFAULTS.orbitPanSpeed,
    );
    const orbitZoomSpeed = clampNavNumber(
      (parsed as Record<string, unknown>).orbitZoomSpeed,
      NAVIGATION_RANGES.zoomSpeed,
      DEFAULTS.orbitZoomSpeed,
    );
    const orbitDampingFactor = clampNavNumber(
      (parsed as Record<string, unknown>).orbitDampingFactor,
      NAVIGATION_RANGES.dampingFactor,
      DEFAULTS.orbitDampingFactor,
    );
    return {
      lightingMode: mode,
      modeSettings,
      projection,
      fov: typeof parsed.fov === 'number' ? parsed.fov : DEFAULTS.fov,
      cameras: Array.isArray(parsed.cameras) ? parsed.cameras.slice(0, 3) : [...DEFAULTS.cameras],
      antialias,
      shadowMapSize,
      shadowRadius,
      maxDpr,
      fpvSpeed,
      fpvSprintSpeed,
      fpvSensitivity,
      fpvEyeHeight,
      aoMode,
      ssaoIntensity,
      ssaoRadius,
      bloomEnabled,
      bloomIntensity,
      bloomThreshold,
      bloomRadius,
      groundEnabled,
      groundBrightness,
      groundColor,
      backgroundBrightness,
      checkerContrast,
      uiZoom,
      orbitRotateSpeed,
      orbitPanSpeed,
      orbitZoomSpeed,
      orbitDampingFactor,
      distanceAdaptiveNav: typeof (parsed as Record<string, unknown>).distanceAdaptiveNav === 'boolean'
        ? (parsed as Record<string, unknown>).distanceAdaptiveNav as boolean
        : DEFAULTS.distanceAdaptiveNav,
    };
  } catch {
    return { ...DEFAULTS, modeSettings: { simple: { ...MODE_DEFAULTS.simple }, default: { ...MODE_DEFAULTS.default } }, cameras: [...DEFAULTS.cameras] };
  }
}

export function saveVisualSettings(settings: VisualSettings): void {
  lsSave(STORAGE_KEY, settings);
}

// ─── Reactive UI Zoom Store ────────────────────────────────────────────
// Tiny reactive store so HMIShell can subscribe to zoom changes in real time.

let _uiZoom: number = loadVisualSettings().uiZoom;
const _zoomListeners = new Set<() => void>();

function notifyZoom(): void { for (const l of _zoomListeners) l(); }

/** Update the live UI zoom factor (also persists to visual settings). */
export function setUIZoom(zoom: number): void {
  _uiZoom = zoom;
  notifyZoom();
}

/** Read the current UI zoom value (non-reactive). */
export function getUIZoom(): number { return _uiZoom; }

/** Subscribe to zoom changes. Returns unsubscribe function. */
export function subscribeUIZoom(cb: () => void): () => void {
  _zoomListeners.add(cb);
  return () => { _zoomListeners.delete(cb); };
}

/** React hook: returns the current UI zoom factor (reactive). */
export function useUIZoom(): number {
  return useSyncExternalStore(
    (cb) => { _zoomListeners.add(cb); return () => { _zoomListeners.delete(cb); }; },
    () => _uiZoom,
  );
}

// ─── Reactive Source-Markers-Visible Store (plan-181) ─────────────────
// Pure scalar boolean persisted to its own localStorage slot so other
// `VisualSettings` consumers don't have to know about it. Default: true.

const DEFAULT_SOURCE_MARKERS_VISIBLE = true;

function loadSourceMarkersVisible(): boolean {
  try {
    const raw = localStorage.getItem(SOURCE_MARKERS_KEY);
    if (raw === null) return DEFAULT_SOURCE_MARKERS_VISIBLE;
    return raw === 'true';
  } catch {
    return DEFAULT_SOURCE_MARKERS_VISIBLE;
  }
}

let _sourceMarkersVisible: boolean = loadSourceMarkersVisible();
const _sourceMarkersListeners = new Set<() => void>();

function notifySourceMarkers(): void { for (const l of _sourceMarkersListeners) l(); }

/** Read the current source-markers-visible toggle (non-reactive). */
export function getSourceMarkersVisible(): boolean { return _sourceMarkersVisible; }

/**
 * Update the source-markers-visible flag, persist to localStorage, and
 * notify subscribers. Plugins (e.g. `RVViewer.setSourceMarkersVisible`)
 * subscribe via {@link subscribeSourceMarkersVisible} to apply the change
 * to every source's `_markerNode.visible`.
 */
export function setSourceMarkersVisible(visible: boolean): void {
  if (_sourceMarkersVisible === visible) return;
  _sourceMarkersVisible = visible;
  try {
    localStorage.setItem(SOURCE_MARKERS_KEY, visible ? 'true' : 'false');
  } catch {
    /* quota exceeded or storage disabled — ignore */
  }
  notifySourceMarkers();
}

/** Subscribe to source-markers-visible changes. Returns unsubscribe handle. */
export function subscribeSourceMarkersVisible(cb: () => void): () => void {
  _sourceMarkersListeners.add(cb);
  return () => { _sourceMarkersListeners.delete(cb); };
}

/** React hook: returns the current source-markers-visible flag (reactive). */
export function useSourceMarkersVisible(): boolean {
  return useSyncExternalStore(
    (cb) => { _sourceMarkersListeners.add(cb); return () => { _sourceMarkersListeners.delete(cb); }; },
    () => _sourceMarkersVisible,
  );
}

// ─── Reactive Toolbar-Show-Labels Store ───────────────────────────────
// Controls whether the top-left toolbar's window-opening buttons (Hierarchy,
// Models, Annotations, Multiuser, VR/AR, Settings) render a text label next
// to their icon. Always collapsed on mobile regardless of this setting.

const TOOLBAR_LABELS_KEY = 'rv-toolbar-show-labels';
const DEFAULT_TOOLBAR_SHOW_LABELS = false;

function loadToolbarShowLabels(): boolean {
  try {
    const raw = localStorage.getItem(TOOLBAR_LABELS_KEY);
    if (raw === null) return DEFAULT_TOOLBAR_SHOW_LABELS;
    return raw === 'true';
  } catch {
    return DEFAULT_TOOLBAR_SHOW_LABELS;
  }
}

let _toolbarShowLabels: boolean = loadToolbarShowLabels();
const _toolbarLabelsListeners = new Set<() => void>();

function notifyToolbarLabels(): void { for (const l of _toolbarLabelsListeners) l(); }

export function getToolbarShowLabels(): boolean { return _toolbarShowLabels; }

export function setToolbarShowLabels(show: boolean): void {
  if (_toolbarShowLabels === show) return;
  _toolbarShowLabels = show;
  try {
    localStorage.setItem(TOOLBAR_LABELS_KEY, show ? 'true' : 'false');
  } catch {
    /* quota exceeded or storage disabled — ignore */
  }
  notifyToolbarLabels();
}

export function useToolbarShowLabels(): boolean {
  return useSyncExternalStore(
    (cb) => { _toolbarLabelsListeners.add(cb); return () => { _toolbarLabelsListeners.delete(cb); }; },
    () => _toolbarShowLabels,
  );
}

// ─── Reactive Snap-Flip-Icons Store (plan-190) ────────────────────────
// Controls whether the layout planner shows a clickable "flip orientation"
// icon over a hovered/selected placed component that has a second compatible
// snap. Default: true. Kept as its own scalar key so existing visual-settings
// consumers stay schema-stable.

const SNAP_FLIP_ICONS_KEY = 'rv-snap-flip-icons-visible';
const DEFAULT_SNAP_FLIP_ICONS_VISIBLE = true;

function loadSnapFlipIconsVisible(): boolean {
  try {
    const raw = localStorage.getItem(SNAP_FLIP_ICONS_KEY);
    if (raw === null) return DEFAULT_SNAP_FLIP_ICONS_VISIBLE;
    return raw === 'true';
  } catch {
    return DEFAULT_SNAP_FLIP_ICONS_VISIBLE;
  }
}

let _snapFlipIconsVisible: boolean = loadSnapFlipIconsVisible();
const _snapFlipIconsListeners = new Set<() => void>();

function notifySnapFlipIcons(): void { for (const l of _snapFlipIconsListeners) l(); }

/** Read the current snap-flip-icons-visible toggle (non-reactive). */
export function getSnapFlipIconsVisible(): boolean { return _snapFlipIconsVisible; }

/** Set the snap-flip-icons-visible flag and persist to localStorage. */
export function setSnapFlipIconsVisible(visible: boolean): void {
  if (_snapFlipIconsVisible === visible) return;
  _snapFlipIconsVisible = visible;
  try {
    localStorage.setItem(SNAP_FLIP_ICONS_KEY, visible ? 'true' : 'false');
  } catch {
    /* quota exceeded or storage disabled — ignore */
  }
  notifySnapFlipIcons();
}

/** Subscribe to snap-flip-icons-visible changes. Returns unsubscribe handle. */
export function subscribeSnapFlipIconsVisible(cb: () => void): () => void {
  _snapFlipIconsListeners.add(cb);
  return () => { _snapFlipIconsListeners.delete(cb); };
}

/** React hook: returns the current snap-flip-icons-visible flag (reactive). */
export function useSnapFlipIconsVisible(): boolean {
  return useSyncExternalStore(
    (cb) => { _snapFlipIconsListeners.add(cb); return () => { _snapFlipIconsListeners.delete(cb); }; },
    () => _snapFlipIconsVisible,
  );
}
