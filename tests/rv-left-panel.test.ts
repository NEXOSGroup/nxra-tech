// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for LeftPanel component exports, clampWidth helper, buildPanelSx helper,
 * and shared layout constants.
 *
 * Runs in vitest browser mode (Playwright/Chromium) — no Node fs/path.
 * Uses Vite ?raw imports to read source files as strings for the
 * "no hardcoded widths" regression tests.
 */

import { describe, it, expect } from 'vitest';

// Vite ?raw imports — source text for regression checks (browser-compatible)
import leftWindowWidthSrc from '../src/hooks/use-left-window-width.ts?raw';
import viewerSrc from '../src/core/rv-viewer.ts?raw';
import cameraManagerSrc from '../src/core/rv-camera-manager.ts?raw';

// ── 9.1 TestLayoutConstants ──────────────────────────────────────────────

import {
  BOTTOM_BAR_HEIGHT,
  ACTIVITY_BAR_WIDTH,
  FLOATING_TOP_MARGIN,
  LEFT_PANEL_TOP,
  LEFT_PANEL_LEFT,
  LEFT_PANEL_BOTTOM,
  LEFT_PANEL_ZINDEX,
  SETTINGS_PANEL_WIDTH,
  INSPECTOR_PANEL_WIDTH,
} from '../src/core/hmi/layout-constants';

describe('layout-constants', () => {
  it('exports all panel dimension constants with correct values', () => {
    expect(BOTTOM_BAR_HEIGHT).toBe(52);
    // The top app bar was removed: left windows + the activity bar run full
    // height from the very top, flush against the activity bar.
    expect(LEFT_PANEL_TOP).toBe(0);
    expect(ACTIVITY_BAR_WIDTH).toBe(30);
    expect(LEFT_PANEL_LEFT).toBe(ACTIVITY_BAR_WIDTH);
    expect(LEFT_PANEL_BOTTOM).toBe(0);
    expect(LEFT_PANEL_ZINDEX).toBe(1200);
    expect(SETTINGS_PANEL_WIDTH).toBe(540);
    expect(INSPECTOR_PANEL_WIDTH).toBe(320);
  });

  it('LEFT_PANEL_TOP sits flush at the very top (no top app bar)', () => {
    expect(LEFT_PANEL_TOP).toBe(0);
  });

  it('all dimension constants are non-negative numbers', () => {
    for (const v of [
      BOTTOM_BAR_HEIGHT, ACTIVITY_BAR_WIDTH, FLOATING_TOP_MARGIN,
      LEFT_PANEL_TOP, LEFT_PANEL_LEFT,
      LEFT_PANEL_BOTTOM, LEFT_PANEL_ZINDEX,
      SETTINGS_PANEL_WIDTH, INSPECTOR_PANEL_WIDTH,
    ]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(typeof v).toBe('number');
    }
  });
});

// ── 9.2 TestLeftPanelExports ─────────────────────────────────────────────

describe('LeftPanel module', () => {
  it('exports LeftPanel component as a function', async () => {
    const mod = await import('../src/core/hmi/LeftPanel');
    expect(mod.LeftPanel).toBeDefined();
    expect(typeof mod.LeftPanel).toBe('function');
  });

  it('exports clampWidth helper for resize logic', async () => {
    const mod = await import('../src/core/hmi/LeftPanel');
    expect(mod.clampWidth).toBeDefined();
    expect(typeof mod.clampWidth).toBe('function');
  });

  it('exports buildPanelSx helper for style computation', async () => {
    const mod = await import('../src/core/hmi/LeftPanel');
    expect(mod.buildPanelSx).toBeDefined();
    expect(typeof mod.buildPanelSx).toBe('function');
  });
});

// ── 9.3 TestClampWidth ───────────────────────────────────────────────────

import { clampWidth } from '../src/core/hmi/LeftPanel';

describe('clampWidth', () => {
  it('returns value when within range', () => {
    expect(clampWidth(300, 200, 600)).toBe(300);
  });

  it('clamps to minWidth when too small', () => {
    expect(clampWidth(100, 200, 600)).toBe(200);
  });

  it('clamps to maxWidth when too large', () => {
    expect(clampWidth(800, 200, 600)).toBe(600);
  });

  it('handles edge case: value equals min', () => {
    expect(clampWidth(200, 200, 600)).toBe(200);
  });

  it('handles edge case: value equals max', () => {
    expect(clampWidth(600, 200, 600)).toBe(600);
  });

  it('handles negative values by clamping to min', () => {
    expect(clampWidth(-50, 200, 600)).toBe(200);
  });

  it('handles NaN by returning min', () => {
    expect(clampWidth(NaN, 200, 600)).toBe(200);
  });
});

// ── 9.4 TestBuildPanelSx ─────────────────────────────────────────────────

import { buildPanelSx } from '../src/core/hmi/LeftPanel';

describe('buildPanelSx', () => {
  it('returns correct desktop positioning', () => {
    const sx = buildPanelSx({ width: 320, isMobile: false });
    expect(sx.position).toBe('fixed');
    expect(sx.left).toBe(LEFT_PANEL_LEFT);
    expect(sx.top).toBe(LEFT_PANEL_TOP);
    expect(sx.bottom).toBe(LEFT_PANEL_BOTTOM);
    expect(sx.width).toBe(320);
    expect(sx.zIndex).toBe(LEFT_PANEL_ZINDEX);
    expect(sx.right).toBe('auto');
  });

  it('returns full-screen mobile positioning covering entire viewport', () => {
    const sx = buildPanelSx({ width: 320, isMobile: true, mobile: 'full-screen' });
    expect(sx.inset).toBe(0);
    expect(sx.width).toBe('100%');
    expect(sx.height).toBe('100%');
    expect(sx.borderRadius).toBe(0);
  });

  it('mobile panel zIndex overlays TopBar/ButtonPanel/BottomBar/LogoBadge', () => {
    // TopBar buttons=9001, ButtonPanel=1210, BottomBar=1201, LogoBadge=1210.
    // Mobile panel must overlay every UI element including the TopBar.
    const sx = buildPanelSx({ width: 320, isMobile: true, mobile: 'full-screen' });
    expect(sx.zIndex).toBeGreaterThan(9001);
  });

  it('mobile hidden panel uses the same elevated zIndex', () => {
    const shown = buildPanelSx({ width: 320, isMobile: true, mobile: 'full-screen' });
    const hidden = buildPanelSx({ width: 320, isMobile: true, mobile: 'hidden' });
    expect(hidden.zIndex).toBe(shown.zIndex);
  });

  it('returns display:none for mobile=hidden', () => {
    const sx = buildPanelSx({ width: 320, isMobile: true, mobile: 'hidden' });
    expect(sx.display).toBe('none');
  });

  it('respects custom leftOffset', () => {
    const sx = buildPanelSx({ width: 320, isMobile: false, leftOffset: 296 });
    expect(sx.left).toBe(296);
  });

  it('defaults mobile to full-screen', () => {
    const sx = buildPanelSx({ width: 320, isMobile: true });
    expect(sx.inset).toBe(0);
    expect(sx.width).toBe('100%');
    expect(sx.height).toBe('100%');
  });
});

// ── 9.5 TestNoHardcodedWidths ────────────────────────────────────────────

describe('No hardcoded panel widths', () => {
  it('useLeftWindowWidth hook derives the offset from the live inspector width + live lpm width', () => {
    // The floating mode switcher + tool toolbar share this hook for an
    // immediate, identical offset (no hardcoded widths, no CSS transition lag).
    // The inspector is resizable, so the offset tracks the live inspectorWidth
    // from editor state rather than a fixed constant.
    expect(leftWindowWidthSrc).toContain('inspectorWidth');
    expect(leftWindowWidthSrc).toContain('activePanelWidth');
  });

  it('camera no longer compensates for panels — the WebGL canvas is confined to the viewport', () => {
    // The canvas is now sized to the central viewport region (ViewportFrame),
    // so docked windows don't overlap it and focus/fit frame within the real
    // visible canvas. getCurrentViewportOffset() therefore returns undefined
    // (no panel-offset math, no INSPECTOR_PANEL_WIDTH compensation).
    expect(viewerSrc).toContain('getCurrentViewportOffset');
    expect(cameraManagerSrc).toContain('getCurrentViewportOffset');
    expect(cameraManagerSrc).not.toContain('INSPECTOR_PANEL_WIDTH');
  });
});
