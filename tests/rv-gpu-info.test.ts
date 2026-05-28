// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import {
  classifyGPU, classifyAdapter, analyzeGPU,
  type ActiveGPU, type GPUInfo,
} from '../src/core/engine/rv-gpu-info';

const active = (renderer: string, vendor = 'unknown'): ActiveGPU => ({ vendor, renderer });

describe('classifyGPU', () => {
  // ── Software / CPU rendering ──
  it('detects SwiftShader as software', () => {
    expect(classifyGPU(active('Google SwiftShader'))).toBe('software');
  });
  it('detects llvmpipe as software', () => {
    expect(classifyGPU(active('Mesa /llvmpipe (LLVM 14.0.6, 256 bits)'))).toBe('software');
  });
  it('detects Microsoft Basic Render Driver as software', () => {
    expect(classifyGPU(active('Microsoft Basic Render Driver'))).toBe('software');
  });
  it('detects ANGLE software fallback', () => {
    expect(classifyGPU(active('ANGLE (Software Renderer)'))).toBe('software');
  });

  // ── Apple Silicon ──
  it('detects Apple M1', () => {
    expect(classifyGPU(active('Apple M1'))).toBe('apple-silicon');
  });
  it('detects Apple M1 Pro', () => {
    expect(classifyGPU(active('Apple M1 Pro'))).toBe('apple-silicon');
  });
  it('detects Apple M3 Max', () => {
    expect(classifyGPU(active('Apple M3 Max'))).toBe('apple-silicon');
  });

  // ── Discrete NVIDIA ──
  it('detects ANGLE-wrapped NVIDIA RTX as discrete', () => {
    expect(classifyGPU(active('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x00002860) Direct3D11 vs_5_0 ps_5_0, D3D11)')))
      .toBe('discrete');
  });
  it('detects bare NVIDIA GeForce as discrete', () => {
    expect(classifyGPU(active('NVIDIA GeForce GTX 1080'))).toBe('discrete');
  });
  it('detects Quadro as discrete', () => {
    expect(classifyGPU(active('NVIDIA Quadro P2000'))).toBe('discrete');
  });

  // ── Discrete AMD ──
  it('detects Radeon RX as discrete', () => {
    expect(classifyGPU(active('AMD Radeon RX 6700 XT'))).toBe('discrete');
  });
  it('detects ANGLE-wrapped Radeon RX as discrete', () => {
    expect(classifyGPU(active('ANGLE (AMD, AMD Radeon RX 7900 XTX, D3D11)'))).toBe('discrete');
  });
  it('detects Radeon Pro as discrete', () => {
    expect(classifyGPU(active('AMD Radeon Pro 5500M'))).toBe('discrete');
  });

  // ── Discrete Intel Arc ──
  it('detects Intel Arc as discrete', () => {
    expect(classifyGPU(active('Intel(R) Arc(TM) A770 Graphics'))).toBe('discrete');
  });

  // ── Integrated Intel ──
  it('detects Intel HD Graphics as integrated', () => {
    expect(classifyGPU(active('Intel(R) HD Graphics 4000'))).toBe('integrated');
  });
  it('detects Intel UHD Graphics as integrated', () => {
    expect(classifyGPU(active('Intel(R) UHD Graphics 630'))).toBe('integrated');
  });
  it('detects ANGLE-wrapped UHD Graphics as integrated', () => {
    expect(classifyGPU(active('ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)')))
      .toBe('integrated');
  });
  it('detects Intel Iris Xe as integrated', () => {
    expect(classifyGPU(active('Intel(R) Iris(R) Xe Graphics'))).toBe('integrated');
  });

  // ── Integrated AMD APU ──
  it('detects AMD Radeon Vega 8 (APU) as integrated', () => {
    expect(classifyGPU(active('AMD Radeon Vega 8 Graphics'))).toBe('integrated');
  });
  it('detects bare "AMD Radeon Graphics" (Ryzen APU) as integrated', () => {
    expect(classifyGPU(active('AMD Radeon Graphics'))).toBe('integrated');
  });
  it('detects Radeon 680M (RDNA APU) as integrated', () => {
    expect(classifyGPU(active('AMD Radeon 680M Graphics'))).toBe('integrated');
  });

  // ── Integrated mobile ──
  it('detects Adreno as integrated', () => {
    expect(classifyGPU(active('Qualcomm Adreno (TM) 660'))).toBe('integrated');
  });
  it('detects Mali as integrated', () => {
    expect(classifyGPU(active('ARM Mali-G78'))).toBe('integrated');
  });

  // ── Edge cases ──
  it('returns unknown for empty renderer', () => {
    expect(classifyGPU(active(''))).toBe('unknown');
  });
  it('returns unknown for "unknown" placeholder', () => {
    expect(classifyGPU(active('unknown'))).toBe('unknown');
  });
  it('returns unknown for unrecognised string', () => {
    expect(classifyGPU(active('SomeFutureGPU 9999 XL'))).toBe('unknown');
  });

  // ── Critical: discrete must beat integrated when string contains both ──
  it('prefers discrete classification when both patterns could match', () => {
    // "AMD Radeon RX 6700M" contains "M" suffix similar to APU pattern
    // but the "RX" prefix is the discrete-class marker.
    expect(classifyGPU(active('AMD Radeon RX 6700M'))).toBe('discrete');
  });
});

describe('classifyAdapter', () => {
  it('classifies bare-vendor "nvidia" as discrete even when device is empty', () => {
    // Chromium privacy redaction case — the vendor string alone is
    // still actionable diagnostic information.
    expect(classifyAdapter({ vendor: 'nvidia', device: '' })).toBe('discrete');
  });
  it('classifies bare-vendor "intel" as integrated when device is empty', () => {
    expect(classifyAdapter({ vendor: 'intel', device: '' })).toBe('integrated');
  });
  it('classifies vendor + RTX device as discrete', () => {
    expect(classifyAdapter({ vendor: 'NVIDIA', device: 'RTX 4090' })).toBe('discrete');
  });
});

describe('analyzeGPU', () => {
  // ── Discrete only ──
  it('reports OK for an active discrete GPU', () => {
    const info: GPUInfo = {
      backend: 'webgl',
      active: active('NVIDIA GeForce RTX 4070'),
    };
    const a = analyzeGPU(info);
    expect(a.tier).toBe('discrete');
    expect(a.severity).toBe('ok');
    expect(a.discreteAvailableConfirmed).toBe(false);
    expect(a.message).toBeUndefined();
  });

  it('reports OK for Apple Silicon', () => {
    const info: GPUInfo = { backend: 'webgpu', active: active('Apple M2 Pro') };
    expect(analyzeGPU(info).severity).toBe('ok');
  });

  // ── Software fallback ──
  it('reports CRITICAL for SwiftShader', () => {
    const info: GPUInfo = { backend: 'webgl', active: active('Google SwiftShader') };
    const a = analyzeGPU(info);
    expect(a.tier).toBe('software');
    expect(a.severity).toBe('critical');
    expect(a.message).toBeTruthy();
    expect(a.action).toBeTruthy();
  });

  // ── Integrated, no probe info ──
  it('warns on integrated active GPU without probe confirmation', () => {
    const info: GPUInfo = {
      backend: 'webgl',
      active: active('Intel(R) UHD Graphics 630'),
    };
    const a = analyzeGPU(info);
    expect(a.tier).toBe('integrated');
    expect(a.severity).toBe('warning');
    expect(a.discreteAvailableConfirmed).toBe(false);
    expect(a.message).toBeTruthy();
    expect(a.action).toMatch(/High performance/i);
  });

  // ── Integrated WITH discrete confirmed (the headline case) ──
  it('confirms wrong-GPU when integrated active + discrete probe found', () => {
    const info: GPUInfo = {
      backend: 'webgl',
      active: active('ANGLE (Intel, Intel(R) UHD Graphics 630, D3D11)'),
      highPerf: { vendor: 'NVIDIA', device: 'GeForce RTX 4070' },
    };
    const a = analyzeGPU(info);
    expect(a.tier).toBe('integrated');
    expect(a.severity).toBe('warning');
    expect(a.discreteAvailableConfirmed).toBe(true);
    expect(a.betterAvailable).toMatch(/RTX 4070/);
    expect(a.message).toMatch(/integrated/i);
  });

  it('confirms wrong-GPU even when probe reports a bare nvidia vendor (empty device)', () => {
    // Models the privacy-redaction case where Chromium gave us
    // vendor='nvidia' but device=''. We should still flag it because
    // the vendor alone implies a discrete adapter exists.
    const info: GPUInfo = {
      backend: 'webgl',
      active: active('Intel(R) UHD Graphics 630'),
      highPerf: { vendor: 'nvidia', device: 'NVIDIA GPU' },
    };
    const a = analyzeGPU(info);
    expect(a.severity).toBe('warning');
    expect(a.discreteAvailableConfirmed).toBe(true);
  });

  // ── Don't double-warn when discrete-on-discrete (probe == active) ──
  it('does NOT warn when probe matches the active discrete GPU', () => {
    const info: GPUInfo = {
      backend: 'webgl',
      active: active('NVIDIA GeForce RTX 4070 Laptop GPU'),
      highPerf: { vendor: 'NVIDIA', device: 'GeForce RTX 4070' },
    };
    expect(analyzeGPU(info).severity).toBe('ok');
  });

  // ── Unknown renderer should not fabricate a warning ──
  it('stays quiet on unknown renderer strings', () => {
    const info: GPUInfo = { backend: 'webgl', active: active('SomeFutureGPU XL') };
    const a = analyzeGPU(info);
    expect(a.tier).toBe('unknown');
    expect(a.severity).toBe('ok');
    expect(a.message).toBeUndefined();
  });
});
