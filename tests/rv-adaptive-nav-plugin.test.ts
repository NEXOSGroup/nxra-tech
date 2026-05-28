// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PerspectiveCamera, OrthographicCamera } from 'three';
import {
  AdaptiveNavPlugin,
  ZOOM_DIST_FACTOR, PAN_DIST_FACTOR, MIN_FACTOR, MAX_FACTOR,
} from '../src/plugins/adaptive-nav-plugin';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';

// ── Mocks ──────────────────────────────────────────────────────────────

vi.mock('../src/core/hmi/visual-settings-store', () => {
  let _store = {
    orbitZoomSpeed: 1.0,
    orbitPanSpeed: 1.0,
    distanceAdaptiveNav: true,
  };
  return {
    loadVisualSettings: () => ({ ..._store }),
    __setMockStore: (patch: Partial<typeof _store>) => { Object.assign(_store, patch); },
    __resetMockStore: () => { _store = { orbitZoomSpeed: 1.0, orbitPanSpeed: 1.0, distanceAdaptiveNav: true }; },
  };
});

// Import the mock setter after mock declaration
const { __setMockStore, __resetMockStore } = await import('../src/core/hmi/visual-settings-store') as any;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function createMockViewer(overrides?: {
  controlsEnabled?: boolean;
  getDistance?: () => number;
  camera?: 'perspective' | 'orthographic';
}): RVViewer {
  const controls = {
    enabled: overrides?.controlsEnabled ?? true,
    zoomSpeed: 99,
    panSpeed: 99,
    rotateSpeed: 1,
    dampingFactor: 0.08,
    getDistance: overrides?.getDistance ?? (() => 10),
    target: { set: vi.fn() },
    update: vi.fn(),
  };
  const camera = overrides?.camera === 'orthographic'
    ? new OrthographicCamera()
    : new PerspectiveCamera();
  return {
    controls,
    camera,
    getPlugin: vi.fn().mockReturnValue(undefined),
  } as unknown as RVViewer;
}

describe('AdaptiveNavPlugin', () => {
  let plugin: AdaptiveNavPlugin;

  beforeEach(() => {
    __resetMockStore();
    plugin = new AdaptiveNavPlugin();
  });

  // --- Core math (4 tests) ---

  it('zoom speed scales with distance (sqrt curve, baseline at 10 m)', () => {
    const viewer = createMockViewer({ getDistance: () => 10 });
    plugin.onModelLoaded({} as LoadResult, viewer);
    plugin.onRender!(0);
    const expected = 1.0 * clamp(Math.sqrt(10 * ZOOM_DIST_FACTOR), MIN_FACTOR, MAX_FACTOR);
    expect(viewer.controls!.zoomSpeed).toBeCloseTo(expected, 5);
    // Sanity: baseline preserved at 10 m
    expect(viewer.controls!.zoomSpeed).toBeCloseTo(1.0, 5);
  });

  it('pan speed scales with distance (sqrt curve)', () => {
    const viewer = createMockViewer({ getDistance: () => 10 });
    plugin.onModelLoaded({} as LoadResult, viewer);
    plugin.onRender!(0);
    const expected = 1.0 * clamp(Math.sqrt(10 * PAN_DIST_FACTOR), MIN_FACTOR, MAX_FACTOR);
    expect(viewer.controls!.panSpeed).toBeCloseTo(expected, 5);
  });

  it('near-zero distance clamps to MIN_FACTOR', () => {
    const viewer = createMockViewer({ getDistance: () => 0.001 });
    plugin.onModelLoaded({} as LoadResult, viewer);
    plugin.onRender!(0);
    // dist clamped to 0.01 → sqrt(0.01 * 0.10) = sqrt(0.001) ≈ 0.0316 → clamped up to MIN_FACTOR
    expect(viewer.controls!.zoomSpeed).toBeCloseTo(1.0 * MIN_FACTOR, 5);
  });

  it('very large distance clamps to MAX_FACTOR', () => {
    // sqrt(distance * 0.10) hits MAX_FACTOR (10.0) at distance = 1000 m.
    // Use 10000 m to be well past the clamp threshold.
    const viewer = createMockViewer({ getDistance: () => 10000 });
    plugin.onModelLoaded({} as LoadResult, viewer);
    plugin.onRender!(0);
    expect(viewer.controls!.zoomSpeed).toBeCloseTo(1.0 * MAX_FACTOR, 5);
  });

  // --- Guards (3 tests) ---

  it('disabled controls: no writes to zoomSpeed/panSpeed', () => {
    const viewer = createMockViewer({ controlsEnabled: false });
    plugin.onModelLoaded({} as LoadResult, viewer);
    plugin.onRender!(0);
    expect(viewer.controls!.zoomSpeed).toBe(99);
    expect(viewer.controls!.panSpeed).toBe(99);
  });

  it('distanceAdaptiveNav=false: no writes', () => {
    __setMockStore({ distanceAdaptiveNav: false });
    const viewer = createMockViewer();
    plugin.onModelLoaded({} as LoadResult, viewer);
    plugin.onRender!(0);
    expect(viewer.controls!.zoomSpeed).toBe(99);
    expect(viewer.controls!.panSpeed).toBe(99);
  });

  it('orthographic camera: no writes', () => {
    const viewer = createMockViewer({ camera: 'orthographic' });
    plugin.onModelLoaded({} as LoadResult, viewer);
    plugin.onRender!(0);
    expect(viewer.controls!.zoomSpeed).toBe(99);
    expect(viewer.controls!.panSpeed).toBe(99);
  });

  // --- Integration (3 tests) ---

  it('orbitZoomSpeed base multiplier is respected', () => {
    __setMockStore({ orbitZoomSpeed: 2.0 });
    const viewer = createMockViewer({ getDistance: () => 10 });
    plugin.onModelLoaded({} as LoadResult, viewer);
    plugin.onRender!(0);
    const expected = 2.0 * clamp(Math.sqrt(10 * ZOOM_DIST_FACTOR), MIN_FACTOR, MAX_FACTOR);
    expect(viewer.controls!.zoomSpeed).toBeCloseTo(expected, 5);
  });

  it('reloadSettings updates base speeds from store', () => {
    const viewer = createMockViewer({ getDistance: () => 10 });
    plugin.onModelLoaded({} as LoadResult, viewer);
    plugin.onRender!(0);
    const first = viewer.controls!.zoomSpeed;

    // Change base zoom speed
    __setMockStore({ orbitZoomSpeed: 2.0 });
    plugin.reloadSettings();
    plugin.onRender!(0);
    expect(viewer.controls!.zoomSpeed).toBeCloseTo(first * 2, 5);
  });

  it('NaN distance is handled gracefully', () => {
    const viewer = createMockViewer({ getDistance: () => NaN });
    plugin.onModelLoaded({} as LoadResult, viewer);
    plugin.onRender!(0);
    // Should not write — values stay at initial mock 99
    expect(viewer.controls!.zoomSpeed).toBe(99);
    expect(viewer.controls!.panSpeed).toBe(99);
  });

  // --- Lifecycle (2 tests) ---

  it('dispose clears viewer reference', () => {
    const viewer = createMockViewer();
    plugin.onModelLoaded({} as LoadResult, viewer);
    plugin.dispose!();
    plugin.onRender!(0);
    // After dispose, no writes happen
    expect(viewer.controls!.zoomSpeed).toBe(99);
  });

  it('onModelCleared resets state', () => {
    const viewer = createMockViewer();
    plugin.onModelLoaded({} as LoadResult, viewer);
    plugin.onModelCleared!(viewer);
    plugin.onRender!(0);
    // After clear, _enabled is false so no writes
    expect(viewer.controls!.zoomSpeed).toBe(99);
  });
});
