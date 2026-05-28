// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Planner-Pause integration — verifies that the layout-planner plugin
 * holds the `'layout-edit'` pause reason whenever the planner is active,
 * and releases it on every close path (toggle, X-button, auto-release,
 * dispose).
 *
 * The actual LayoutPlannerPlugin pulls in Three.js + DOM + LayoutStore, which
 * is heavy for a unit test. Instead, we test the **integration contract**:
 * a fake planner that mirrors the production behavior — `setActive(active)`
 * calls `viewer.setSimulationPaused('layout-edit', active)` and `dispose()`
 * releases the reason as a safety net.
 */

import { describe, test, expect, vi } from 'vitest';
import { createTestViewer } from './helpers/test-viewer';

/** Minimal stand-in mirroring the production pause-wiring contract. */
class FakeLayoutPlanner {
  readonly id = 'layout-planner';
  private _active = false;
  constructor(private _viewer: ReturnType<typeof createTestViewer>) {}

  get active(): boolean { return this._active; }

  setActive(active: boolean): void {
    if (this._active === active) return;
    this._active = active;
    this._viewer.setSimulationPaused('layout-edit', active);
  }

  dispose(): void {
    this._viewer.setSimulationPaused('layout-edit', false);
  }
}

describe('Layout-Planner → simulation pause', () => {
  test('setActive(true) holds layout-edit pause', () => {
    const viewer = createTestViewer();
    const planner = new FakeLayoutPlanner(viewer);
    expect(viewer.isSimulationPaused).toBe(false);

    planner.setActive(true);
    expect(viewer.simulationPauseReasons).toContain('layout-edit');
    expect(viewer.isSimulationPaused).toBe(true);
  });

  test('setActive(false) releases layout-edit pause', () => {
    const viewer = createTestViewer();
    const planner = new FakeLayoutPlanner(viewer);
    planner.setActive(true);
    planner.setActive(false);
    expect(viewer.simulationPauseReasons).not.toContain('layout-edit');
    expect(viewer.isSimulationPaused).toBe(false);
  });

  test('toggling setActive does not emit redundant transitions', () => {
    const viewer = createTestViewer();
    const planner = new FakeLayoutPlanner(viewer);
    const events: { paused: boolean }[] = [];
    viewer.on('simulation-pause-changed', (e: any) => events.push({ paused: e.paused }));

    planner.setActive(true);   // idle → paused
    planner.setActive(true);   // no-op (already active)
    planner.setActive(false);  // paused → idle
    planner.setActive(false);  // no-op
    expect(events.length).toBe(2);
  });

  test('dispose releases layout-edit pause even when still active', () => {
    const viewer = createTestViewer();
    const planner = new FakeLayoutPlanner(viewer);
    planner.setActive(true);
    planner.dispose();
    expect(viewer.simulationPauseReasons).not.toContain('layout-edit');
  });
});

describe('Multi-plugin pause stack', () => {
  test('planner + user pause compose correctly via ref-count', () => {
    const viewer = createTestViewer();
    const planner = new FakeLayoutPlanner(viewer);

    viewer.setSimulationPaused('user', true);
    planner.setActive(true);
    expect(viewer.simulationPauseReasons.length).toBe(2);
    expect(viewer.isSimulationPaused).toBe(true);

    // Releasing 'user' alone keeps the sim paused via 'layout-edit'.
    viewer.setSimulationPaused('user', false);
    expect(viewer.isSimulationPaused).toBe(true);
    expect(viewer.simulationPauseReasons).toEqual(['layout-edit']);

    // Closing the planner finally resumes the sim.
    planner.setActive(false);
    expect(viewer.isSimulationPaused).toBe(false);
  });

  test('planner + WebXR ar-placement compose', () => {
    const viewer = createTestViewer();
    const planner = new FakeLayoutPlanner(viewer);

    planner.setActive(true);
    viewer.setSimulationPaused('ar-placement', true);
    expect(viewer.simulationPauseReasons.length).toBe(2);

    // Either order of release leaves the other in place.
    viewer.setSimulationPaused('ar-placement', false);
    expect(viewer.simulationPauseReasons).toEqual(['layout-edit']);
    planner.setActive(false);
    expect(viewer.isSimulationPaused).toBe(false);
  });

  test('clearPauseReasons() forces release of all reasons', () => {
    const viewer = createTestViewer();
    const planner = new FakeLayoutPlanner(viewer);
    planner.setActive(true);
    viewer.setSimulationPaused('user', true);
    viewer.setSimulationPaused('ar-placement', true);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    viewer.clearPauseReasons();
    expect(viewer.isSimulationPaused).toBe(false);
    warnSpy.mockRestore();
  });

  test('clearPauseReasons("layout-edit") releases only that reason', () => {
    const viewer = createTestViewer();
    const planner = new FakeLayoutPlanner(viewer);
    planner.setActive(true);
    viewer.setSimulationPaused('user', true);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    viewer.clearPauseReasons('layout-edit');
    warnSpy.mockRestore();

    expect(viewer.simulationPauseReasons).toEqual(['user']);
    expect(viewer.isSimulationPaused).toBe(true);
  });
});
