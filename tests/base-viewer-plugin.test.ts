// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi } from 'vitest';
import { BaseViewerPlugin } from '../src/core/rv-base-plugin';
import type { RVViewer } from '../src/core/rv-viewer';

// Minimal concrete subclass for testing
class TestPlugin extends BaseViewerPlugin {
  readonly id = 'test-plugin';

  // Allow test code to register subs from the outside
  publicSub(off: () => void): void {
    this.sub(off);
  }

  publicFlushSubs(): void {
    this.flushSubs();
  }
}

const fakeViewer = {} as unknown as RVViewer;

describe('BaseViewerPlugin', () => {
  it('sub() registers an unsubscribe callback', () => {
    const plugin = new TestPlugin();
    const off = vi.fn();
    plugin.publicSub(off);
    // Not yet flushed
    expect(off).not.toHaveBeenCalled();
    // Flush — callback fires
    plugin.publicFlushSubs();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('flushSubs() calls every registered unsubscribe and clears the list', () => {
    const plugin = new TestPlugin();
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    plugin.publicSub(a);
    plugin.publicSub(b);
    plugin.publicSub(c);

    plugin.publicFlushSubs();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);

    // Second flush — list is empty, no double-fire
    plugin.publicFlushSubs();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it('dispose() automatically flushes registered subs', () => {
    const plugin = new TestPlugin();
    const off = vi.fn();
    plugin.publicSub(off);
    plugin.dispose();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('onModelCleared() automatically flushes registered subs', () => {
    const plugin = new TestPlugin();
    const off = vi.fn();
    plugin.publicSub(off);
    plugin.onModelCleared(fakeViewer);
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('subclass with custom dispose can call super.dispose() to inherit flushSubs', () => {
    const customCleanup = vi.fn();

    class WithCustomDispose extends BaseViewerPlugin {
      readonly id = 'custom';
      publicSub(off: () => void): void {
        this.sub(off);
      }
      override dispose(): void {
        super.dispose();
        customCleanup();
      }
    }

    const plugin = new WithCustomDispose();
    const off = vi.fn();
    plugin.publicSub(off);
    plugin.dispose();

    expect(off).toHaveBeenCalledTimes(1);
    expect(customCleanup).toHaveBeenCalledTimes(1);
  });

  it('subclass with custom onModelCleared can call super.onModelCleared() to inherit flushSubs', () => {
    const customCleanup = vi.fn();

    class WithCustomClear extends BaseViewerPlugin {
      readonly id = 'custom-clear';
      publicSub(off: () => void): void {
        this.sub(off);
      }
      override onModelCleared(viewer: RVViewer): void {
        super.onModelCleared(viewer);
        customCleanup();
      }
    }

    const plugin = new WithCustomClear();
    const off = vi.fn();
    plugin.publicSub(off);
    plugin.onModelCleared(fakeViewer);

    expect(off).toHaveBeenCalledTimes(1);
    expect(customCleanup).toHaveBeenCalledTimes(1);
  });

  it('a throwing unsubscribe does not prevent others from running', () => {
    const plugin = new TestPlugin();
    // Silence the expected console.error from the throwing unsub
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const a = vi.fn();
    const bad = vi.fn(() => { throw new Error('boom'); });
    const c = vi.fn();

    plugin.publicSub(a);
    plugin.publicSub(bad);
    plugin.publicSub(c);

    plugin.publicFlushSubs();

    expect(a).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);

    errSpy.mockRestore();
  });

  it('sub() ignores non-function inputs gracefully', () => {
    const plugin = new TestPlugin();
    // @ts-expect-error — runtime guard test
    plugin.publicSub(null);
    // @ts-expect-error — runtime guard test
    plugin.publicSub(undefined);
    // Should be a no-op flush (no errors)
    expect(() => plugin.publicFlushSubs()).not.toThrow();
  });

  it('subs registered after a flush are tracked independently', () => {
    const plugin = new TestPlugin();
    const a = vi.fn();
    plugin.publicSub(a);
    plugin.publicFlushSubs();
    expect(a).toHaveBeenCalledTimes(1);

    const b = vi.fn();
    plugin.publicSub(b);
    plugin.publicFlushSubs();
    expect(a).toHaveBeenCalledTimes(1); // not called again
    expect(b).toHaveBeenCalledTimes(1);
  });
});
