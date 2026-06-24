// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import {
  RENDER_MODES,
  RENDER_MODE_IDS,
  DEFAULT_RENDER_MODE,
  getRenderMode,
  modeSupports,
  isRenderMode,
} from '../src/core/rv-render-modes';
import { setAppConfig } from '../src/core/rv-app-config';

describe('rv-render-modes registry', () => {
  it('exposes simple + default + toon modes in order', () => {
    expect(RENDER_MODE_IDS).toEqual(['simple', 'default', 'toon']);
    expect(RENDER_MODES.map((m) => m.label)).toEqual(['Simple', 'Default', 'Toon']);
  });

  it('looks up a mode by id', () => {
    expect(getRenderMode('simple').id).toBe('simple');
    expect(getRenderMode('default').id).toBe('default');
    expect(getRenderMode('toon').id).toBe('toon');
  });

  it('falls back to the default mode for unknown/undefined ids', () => {
    expect(getRenderMode('bogus').id).toBe(DEFAULT_RENDER_MODE);
    expect(getRenderMode(undefined).id).toBe(DEFAULT_RENDER_MODE);
  });

  it('isRenderMode type-guards known ids only', () => {
    expect(isRenderMode('simple')).toBe(true);
    expect(isRenderMode('default')).toBe(true);
    expect(isRenderMode('toon')).toBe(true);
    expect(isRenderMode('fancy')).toBe(false);
    expect(isRenderMode(42)).toBe(false);
    expect(isRenderMode(undefined)).toBe(false);
  });

  it('Simple mode disables every heavy rendering feature', () => {
    const caps = getRenderMode('simple').capabilities;
    // Flat ambient look only — no env/dir light/tone-mapping/shadows/post-fx.
    expect(caps.ambientLight).toBe(true);
    expect(caps.environment).toBe(false);
    expect(caps.directionalLight).toBe(false);
    expect(caps.toneMapping).toBe(false);
    expect(caps.shadows).toBe(false);
    expect(caps.ambientOcclusion).toBe(false);
    expect(caps.bloom).toBe(false);
    expect(caps.reflection).toBe(true);
    expect(caps.toon).toBe(false);
    // The viewer's renderMode setter keys off exactly these three flags.
    expect(modeSupports('simple', 'ambientOcclusion')).toBe(false);
    expect(modeSupports('simple', 'bloom')).toBe(false);
    expect(modeSupports('simple', 'shadows')).toBe(false);
  });

  it('Default mode enables the full feature set', () => {
    const caps = getRenderMode('default').capabilities;
    expect(caps.ambientLight).toBe(false);
    expect(caps.environment).toBe(true);
    expect(caps.directionalLight).toBe(true);
    expect(caps.toneMapping).toBe(true);
    expect(caps.shadows).toBe(true);
    expect(caps.ambientOcclusion).toBe(true);
    expect(caps.bloom).toBe(true);
    expect(caps.reflection).toBe(true);
    expect(caps.toon).toBe(false);
  });

  it('Toon mode is a lightweight cel setup: ambient + key light, no env/shadows/post-fx', () => {
    const caps = getRenderMode('toon').capabilities;
    expect(caps.toon).toBe(true);
    // Ambient fill (brightness) + a directional key light for the banding + specular.
    expect(caps.ambientLight).toBe(true);
    expect(caps.directionalLight).toBe(true);
    // Grey sky, no shadows, flat colours, no heavy post-fx, no floor mirror.
    expect(caps.environment).toBe(false);
    expect(caps.shadows).toBe(false);
    expect(caps.toneMapping).toBe(false);
    expect(caps.ambientOcclusion).toBe(false);
    expect(caps.bloom).toBe(false);
    expect(caps.reflection).toBe(false);
  });
});

describe('visual-settings-store render-mode migration', () => {
  beforeEach(() => {
    localStorage.clear();
    setAppConfig({});
  });

  it('reads the canonical `renderMode` field', async () => {
    const { loadVisualSettings } = await import('../src/core/hmi/visual-settings-store');
    localStorage.setItem('rv-visual-settings', JSON.stringify({ renderMode: 'simple' }));
    expect(loadVisualSettings().renderMode).toBe('simple');
  });

  it('migrates the legacy `lightingMode` field to `renderMode`', async () => {
    const { loadVisualSettings } = await import('../src/core/hmi/visual-settings-store');
    localStorage.setItem('rv-visual-settings', JSON.stringify({ lightingMode: 'simple' }));
    expect(loadVisualSettings().renderMode).toBe('simple');
  });

  it('falls back to the default mode for an invalid stored value', async () => {
    const { loadVisualSettings } = await import('../src/core/hmi/visual-settings-store');
    localStorage.setItem('rv-visual-settings', JSON.stringify({ renderMode: 'nope' }));
    expect(loadVisualSettings().renderMode).toBe(DEFAULT_RENDER_MODE);
  });

  it('accepts the legacy `lightingMode` app-config override key', async () => {
    const { loadVisualSettings } = await import('../src/core/hmi/visual-settings-store');
    setAppConfig({ visual: { lightingMode: 'simple' } });
    expect(loadVisualSettings().renderMode).toBe('simple');
  });
});
