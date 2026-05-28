// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Phase 3 of plan-182: F2 — plugins without init() (legacy) must keep working.
 * Also tests that plugins WITH init() receive the viewer (context comes in Phase 4).
 */

import { describe, it, expect } from 'vitest';
import { BaseViewerPlugin } from '../src/core/rv-base-plugin';
import type { RVViewerPlugin } from '../src/core/rv-plugin';

describe('Plugin init compatibility (plan-182 Phase 3)', () => {
  it('plugin without init() is a valid RVViewerPlugin', () => {
    // Type-level smoke test: plugin with only id is valid.
    const plugin: RVViewerPlugin = { id: 'legacy-no-init' };
    expect(plugin.id).toBe('legacy-no-init');
  });

  it('BaseViewerPlugin.init stores context when provided', () => {
    class Sub extends BaseViewerPlugin {
      readonly id = 'sub-with-context';
    }
    const plugin = new Sub();
    const fakeViewer = {} as never;
    const fakeContext = { signals: null, nodes: null } as never;
    plugin.init(fakeViewer, fakeContext);
    // Cast to any to verify the protected field was set.
    expect((plugin as unknown as { context: unknown }).context).toBe(fakeContext);
  });

  it('BaseViewerPlugin.init works without context (Phase 3 transition)', () => {
    class Sub extends BaseViewerPlugin {
      readonly id = 'sub-no-context-yet';
    }
    const plugin = new Sub();
    const fakeViewer = {} as never;
    expect(() => plugin.init(fakeViewer)).not.toThrow();
  });

  it('subclass can override init and call super.init', () => {
    let receivedContext: unknown = 'pristine';
    class Sub extends BaseViewerPlugin {
      readonly id = 'override-init';
      init(viewer: never, context?: never) {
        super.init(viewer, context);
        receivedContext = (this as unknown as { context: unknown }).context;
      }
    }
    const plugin = new Sub();
    const fakeContext = { tag: 'test-ctx' } as never;
    plugin.init({} as never, fakeContext);
    expect(receivedContext).toBe(fakeContext);
  });
});
