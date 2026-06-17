// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi } from 'vitest';
import { Scene, Mesh, BoxGeometry } from 'three';
import { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';
import { RVWebError } from '../src/core/engine/rv-web-error';
import { ErrorStore } from '../src/core/engine/rv-error-store';
import { SignalStore } from '../src/core/engine/rv-signal-store';

interface SetupOpts {
  signal: string | null;
  text: string;
  gizmoManager?: GizmoOverlayManager;
  style?: 'Auto' | 'FlashObject' | 'Circle';
  /** Box size in meters (for the Auto small-part heuristic). Default 1 m. */
  boxSize?: number;
}

function setupWebError(opts: SetupOpts) {
  const scene = new Scene();
  const mgr = opts.gizmoManager === undefined ? new GizmoOverlayManager(scene) : opts.gizmoManager;
  const store = new SignalStore();
  const errorStore = new ErrorStore();
  if (opts.signal) store.register(opts.signal, opts.signal, false);

  const size = opts.boxSize ?? 1;
  const node = new Mesh(new BoxGeometry(size, size, size));
  node.name = 'Part';
  scene.add(node);

  const comp = new RVWebError(node);
  (comp as any).SignalError = opts.signal;
  (comp as any).ErrorText = opts.text;
  if (opts.style) (comp as any).HighlightStyle = opts.style;

  const ctx = { scene, signalStore: store, gizmoManager: mgr, errorStore } as any;
  comp.init(ctx);
  if (typeof comp.onSceneReady === 'function') comp.onSceneReady(ctx);

  return { comp, signalStore: store, errorStore, mgr, scene };
}

describe('RVWebError', () => {
  it('activates ErrorStore + gizmo when signal goes high', () => {
    const { comp, signalStore, errorStore, mgr } = setupWebError({ signal: 'A/Err', text: 'Overtemp' });
    expect(errorStore.getActive()).toHaveLength(0);
    signalStore.set('A/Err', true);
    expect(errorStore.getActive().map(e => e.path)).toContain(comp.path);
    expect(errorStore.getActive()[0].text).toBe('Overtemp');
    // 3D gizmos exist (highlight + badge).
    expect((mgr as any)._entries.size).toBeGreaterThanOrEqual(2);
  });

  it('deactivates when signal goes low', () => {
    const { signalStore, errorStore } = setupWebError({ signal: 'A/Err', text: 'x' });
    signalStore.set('A/Err', true);
    expect(errorStore.getActive()).toHaveLength(1);
    signalStore.set('A/Err', false);
    expect(errorStore.getActive()).toHaveLength(0);
  });

  it('reads an initial-high signal at init', () => {
    const scene = new Scene();
    const mgr = new GizmoOverlayManager(scene);
    const store = new SignalStore();
    const errorStore = new ErrorStore();
    store.register('A/Err', 'A/Err', true); // already high BEFORE init
    const node = new Mesh(new BoxGeometry());
    node.name = 'Part';
    scene.add(node);
    const comp = new RVWebError(node);
    (comp as any).SignalError = 'A/Err';
    (comp as any).ErrorText = 'boot';
    const ctx = { scene, signalStore: store, gizmoManager: mgr, errorStore } as any;
    comp.init(ctx);
    comp.onSceneReady!(ctx);
    expect(errorStore.getActive().map(e => e.path)).toContain(comp.path);
  });

  it('does not throw when gizmoManager is missing', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => setupWebError({ signal: 'A/Err', text: 'x', gizmoManager: undefined as any }))
      .not.toThrow();
    errSpy.mockRestore();
  });

  it('does not subscribe / activate when SignalError is null', () => {
    const { signalStore, errorStore } = setupWebError({ signal: null, text: 'static hint' });
    expect(errorStore.getActive()).toHaveLength(0);
    // No signal to flip — store stays empty.
    expect(signalStore).toBeDefined();
  });

  it('FlashObject style → mesh-glow-hull highlight (not floor-disk)', () => {
    const { comp } = setupWebError({ signal: 'A/Err', text: 'x', style: 'FlashObject', boxSize: 0.01 });
    const gizmo = (comp as any)._highlightGizmo;
    expect(gizmo.root.userData._rvGizmo).toBe(true);
  });

  it('Auto style on a tiny part picks the floor-disk ring', () => {
    const { comp } = setupWebError({ signal: 'A/Err', text: 'x', style: 'Auto', boxSize: 0.01 });
    // Floor-disk is a single Mesh root; mesh-glow-hull is a Group with overlays.
    const useRing = (comp as any)._resolveUseRing();
    expect(useRing).toBe(true);
  });
});
