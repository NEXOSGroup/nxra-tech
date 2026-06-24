// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * CameraFollowPlugin lifecycle tests (plan-221 §9.5): mode toggle, exclusivity
 * guards (FPV / deselection), and camera-mode-changed emission. Uses a minimal
 * viewer stub (same approach as rv-fpv-plugin.test.ts) — no DOM/WebGL needed.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Object3D } from 'three';
import { CameraFollowPlugin } from '../src/plugins/camera-follow-plugin';

function createMockViewer() {
  const listeners = new Map<string, Set<(d?: unknown) => void>>();
  let primaryPath: string | null = null;
  const node = new Object3D();

  const viewer = {
    renderer: { domElement: document.createElement('canvas') },
    registry: { getNode: (p: string) => (p ? node : null), getPathForNode: () => null },
    selectionManager: { get primaryPath() { return primaryPath; } },
    getPlugin: vi.fn((_id: string): unknown => undefined),
    startCameraFollow: vi.fn(),
    startCameraSitOn: vi.fn(),
    stopCameraFollow: vi.fn(),
    applyCameraLookDelta: vi.fn(),
    emit: vi.fn((event: string, data?: unknown) => {
      listeners.get(event)?.forEach((cb) => cb(data));
    }),
    on: vi.fn((event: string, cb: (d?: unknown) => void) => {
      let set = listeners.get(event);
      if (!set) { set = new Set(); listeners.set(event, set); }
      set.add(cb);
      return () => set!.delete(cb);
    }),
    /** Test helper: change selection and emit selection-changed. */
    setPrimary(p: string | null) {
      primaryPath = p;
      this.emit('selection-changed', { primaryPath: p, selectedPaths: p ? [p] : [] });
    },
  };
  return viewer;
}

function setup() {
  const plugin = new CameraFollowPlugin();
  const viewer = createMockViewer();
  plugin.onModelLoaded({ drives: [] } as never, viewer as never);
  return { plugin, viewer };
}

afterEach(() => { vi.clearAllMocks(); });

describe('CameraFollowPlugin', () => {
  it('starts inactive and is a no-op without a followable selection', () => {
    const { plugin } = setup();
    expect(plugin.mode).toBe(null);
    expect(plugin.canFollow()).toBe(false);
    plugin.toggle('follow');
    expect(plugin.mode).toBe(null);          // nothing selected → no-op
  });

  it('enters follow for a selected part and emits camera-mode-changed', () => {
    const { plugin, viewer } = setup();
    const events: (string | null)[] = [];
    viewer.on('camera-mode-changed', (e) => events.push((e as { mode: string | null }).mode));

    viewer.setPrimary('Part/A');
    expect(plugin.canFollow()).toBe(true);
    plugin.toggle('follow');

    expect(plugin.mode).toBe('follow');
    expect(viewer.startCameraFollow).toHaveBeenCalledTimes(1);
    expect(events).toContain('follow');
  });

  it('toggling the active mode twice exits', () => {
    const { plugin, viewer } = setup();
    viewer.setPrimary('Part/A');
    plugin.toggle('siton');
    expect(plugin.mode).toBe('siton');
    expect(viewer.startCameraSitOn).toHaveBeenCalledTimes(1);
    plugin.toggle('siton');
    expect(plugin.mode).toBe(null);
    expect(viewer.stopCameraFollow).toHaveBeenCalled();
  });

  it('exits when FPV starts (mutual exclusivity)', () => {
    const { plugin, viewer } = setup();
    viewer.setPrimary('Part/A');
    plugin.toggle('follow');
    expect(plugin.mode).toBe('follow');
    viewer.emit('fpv-enter');                 // FPV took over
    expect(plugin.mode).toBe(null);
    expect(viewer.stopCameraFollow).toHaveBeenCalled();
  });

  it('exits when the selection is lost', () => {
    const { plugin, viewer } = setup();
    viewer.setPrimary('Part/A');
    plugin.toggle('follow');
    expect(plugin.mode).toBe('follow');
    viewer.setPrimary(null);                  // deselected → not followable
    expect(plugin.mode).toBe(null);
  });

  it('does not enter while an XR session is presenting', () => {
    const { plugin, viewer } = setup();
    viewer.getPlugin.mockImplementation((id: string) =>
      id === 'webxr' ? { id: 'webxr', isPresenting: true } : undefined);
    viewer.setPrimary('Part/A');
    plugin.toggle('siton');
    expect(plugin.mode).toBe(null);
    expect(viewer.startCameraSitOn).not.toHaveBeenCalled();
  });
});
