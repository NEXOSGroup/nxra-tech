// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Phase 4b of plan-182: RVViewer exposes typed helper methods that delegate
 * to sub-facades. Pure type/signature smoke test — no real Three.js scene needed.
 */

import { describe, it, expect } from 'vitest';
import viewerSrc from '../src/core/rv-viewer.ts?raw';

describe('RVViewer helper methods (plan-182 Phase 4b)', () => {
  it('declares eachNode method', () => {
    expect(viewerSrc).toMatch(/eachNode\s*\(/);
  });
  it('declares projectToScreen method', () => {
    expect(viewerSrc).toMatch(/projectToScreen\s*\(/);
  });
  it('declares projectPoint method', () => {
    expect(viewerSrc).toMatch(/projectPoint\s*\(/);
  });
  it('declares getCameraState method', () => {
    expect(viewerSrc).toMatch(/getCameraState\s*\(/);
  });
  it('declares setControlsConfig method', () => {
    expect(viewerSrc).toMatch(/setControlsConfig\s*\(/);
  });
  it('declares setDebugLogging method', () => {
    expect(viewerSrc).toMatch(/setDebugLogging\s*\(/);
  });
  it('has @deprecated JSDoc on scene/camera/controls/renderer', () => {
    // Check all four properties have @deprecated.
    const deprecationCount = (viewerSrc.match(/@deprecated Phase 4b of plan-182/g) ?? []).length;
    expect(deprecationCount).toBeGreaterThanOrEqual(4);
  });
});
