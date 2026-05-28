// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Phase 4a of plan-182: viewer.use(plugin) now passes _pluginContext to plugin.init().
 * BaseViewerPlugin subclasses get this.context filled.
 */

import { describe, it, expect } from 'vitest';
import { createTestViewer } from './helpers/test-viewer';
import type { RVViewerPlugin } from '../src/core/rv-plugin';

describe('viewer.use() passes context to plugin.init() (plan-182 Phase 4a)', () => {
  it.skip('echter RVViewer-Test wäre hier — siehe phase-4a-rv-viewer-integration.test.ts (Phase 4b)', () => {});

  it('test-viewer mock does NOT call init (intentional — Mock has no PluginContextImpl)', () => {
    // The TestViewer mock from Phase 0 is intentionally narrow. Real RVViewer test
    // comes once HMI migrations of Phase 4b allow us to build a full viewer in tests.
    const viewer = createTestViewer();
    let initCalled = false;
    const plugin: RVViewerPlugin = { id: 'p', init: () => { initCalled = true; } };
    viewer.use(plugin);
    // TestViewer.use() does not call init() — that is correct for the mock.
    expect(initCalled).toBe(false);
  });
});
