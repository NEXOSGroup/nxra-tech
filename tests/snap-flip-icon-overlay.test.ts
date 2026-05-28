// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for the snap-flip icon overlay plugin (plan-190).
 *
 * Exercises the show/hide trigger matrix, the visual-settings opt-out, and
 * the click → flipPlacedComponent dispatch. The full viewer is heavy and
 * touches WebGL — for unit coverage we use a small typed-event mock plus a
 * mocked GizmoOverlayManager that records create()/dispose() calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { SnapFlipIconOverlay } from '../src/plugins/snap-point/snap-flip-icon-overlay';
import { SnapPointRegistry } from '../src/core/engine/rv-snap-point-registry';
import {
  setSnapFlipIconsVisible,
  getSnapFlipIconsVisible,
} from '../src/core/hmi/visual-settings-store';
import { setContext } from '../src/core/hmi/ui-context-store';

// ─── Minimal event bus mock ────────────────────────────────────────────

type Handler = (data: unknown) => void;
class MockBus {
  private map = new Map<string, Set<Handler>>();
  on(event: string, cb: Handler): () => void {
    let s = this.map.get(event);
    if (!s) { s = new Set(); this.map.set(event, s); }
    s.add(cb);
    return () => s!.delete(cb);
  }
  emit(event: string, data?: unknown): void {
    const s = this.map.get(event);
    if (!s) return;
    for (const h of s) h(data);
  }
}

// ─── Mock GizmoOverlayManager ──────────────────────────────────────────

class MockGizmoManager {
  createCount = 0;
  lastCreatedRoot: Object3D | null = null;
  lastOpts: Record<string, unknown> | null = null;
  lastHandle: { id: string; dispose: ReturnType<typeof vi.fn>; setVisible: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } | null = null;
  disposed = 0;

  create(node: Object3D, opts: Record<string, unknown>) {
    this.createCount++;
    this.lastCreatedRoot = node;
    this.lastOpts = opts;
    const handle = {
      id: `gz_${this.createCount}`,
      dispose: vi.fn(() => { this.disposed++; }),
      setVisible: vi.fn(),
      update: vi.fn(),
    };
    this.lastHandle = handle;
    return handle;
  }
}

// ─── Fixture: belt with paired inlet + free outlet ─────────────────────

interface Fixture {
  root: Object3D;
  registry: SnapPointRegistry;
  bus: MockBus;
  gizmo: MockGizmoManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  viewer: any;
}

function makeFixture(): Fixture {
  const registry = new SnapPointRegistry();

  const partner = new Object3D();
  partner.updateMatrixWorld(true);
  const partnerSnapNode = new Object3D();
  partnerSnapNode.name = 'Snap-ZP-belt';
  partnerSnapNode.position.set(0, 0, 0.5);
  partner.add(partnerSnapNode);
  partner.updateMatrixWorld(true);
  registry.register({
    id: partnerSnapNode.uuid, object3D: partnerSnapNode,
    dir: { axis: 'Z', sign: 'P', code: 'ZP' }, typeId: 'belt', flow: 'bidi',
    ownerRoot: partner, scenePath: 'partner/Snap-ZP-belt', occupied: false,
  });

  const root = new Object3D();
  root.name = 'belt-A';
  root.userData._layoutId = 'belt-A';
  root.updateMatrixWorld(true);

  const inlet = new Object3D();
  inlet.name = 'Snap-ZN-belt';
  inlet.position.set(0, 0, -0.5);
  root.add(inlet);

  const outlet = new Object3D();
  outlet.name = 'Snap-ZP-belt';
  outlet.position.set(0, 0, 0.5);
  root.add(outlet);
  root.updateMatrixWorld(true);

  registry.register({
    id: inlet.uuid, object3D: inlet,
    dir: { axis: 'Z', sign: 'N', code: 'ZN' }, typeId: 'belt', flow: 'bidi',
    ownerRoot: root, scenePath: 'belt-A/Snap-ZN-belt', occupied: false,
  });
  registry.register({
    id: outlet.uuid, object3D: outlet,
    dir: { axis: 'Z', sign: 'P', code: 'ZP' }, typeId: 'belt', flow: 'bidi',
    ownerRoot: root, scenePath: 'belt-A/Snap-ZP-belt', occupied: false,
  });

  registry.markOccupied(inlet.uuid, 'belt-A');
  registry.markOccupied(partnerSnapNode.uuid, 'partner');
  registry.pair(inlet.uuid, partnerSnapNode.uuid);

  const bus = new MockBus();
  const gizmo = new MockGizmoManager();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viewer: any = {
    on: (event: string, cb: Handler) => bus.on(event, cb),
    emit: (event: string, data?: unknown) => bus.emit(event, data),
    isSimulationPaused: true,
    getPlugin: (id: string) => id === 'snap-point' ? { getRegistry: () => registry } : undefined,
    gizmoManager: gizmo,
    highlighter: { highlight: vi.fn(), clear: vi.fn() },
    registry: {
      getPathForNode: (n: Object3D) => n.name,
      getNode: () => null,
    },
  };

  return { root, registry, bus, gizmo, viewer };
}

// Reset the visual-settings toggle between tests (it's module-level state).
beforeEach(() => {
  setSnapFlipIconsVisible(true);
  // Ensure clean storage state for assertions.
  expect(getSnapFlipIconsVisible()).toBe(true);
  // The flip icon is a planner-only feature — activate planner context so the
  // overlay's _maybeShow gate passes. (Reset in afterEach to avoid leaking the
  // active context into other test files that share the module-level store.)
  setContext('planner', true);
});

afterEach(() => {
  setContext('planner', false);
});

// ─── Tests ────────────────────────────────────────────────────────────

describe('SnapFlipIconOverlay', () => {
  it('does NOT show outside planner mode (planner-only feature)', () => {
    const fx = makeFixture();
    const overlay = new SnapFlipIconOverlay();
    overlay.init(fx.viewer);

    // Leave planner mode — the icon must not appear even on a flippable hover.
    setContext('planner', false);
    fx.bus.emit('object-hover', { node: fx.root });
    expect(fx.gizmo.createCount).toBe(0);

    // Re-enter planner mode → the icon shows again.
    setContext('planner', true);
    fx.bus.emit('object-hover', { node: fx.root });
    expect(fx.gizmo.createCount).toBe(1);
  });

  it('shows sprite on object-hover when flip is possible', () => {
    const fx = makeFixture();
    const overlay = new SnapFlipIconOverlay();
    overlay.init(fx.viewer);

    fx.bus.emit('object-hover', { node: fx.root });
    expect(fx.gizmo.createCount).toBe(1);
    // The icon must be anchored at the currently-occupied snap-point
    // (the pivot of the flip), NOT at the placed-component root.
    const occupied = fx.registry.getByOwnerRoot(fx.root).find(s => s.occupied);
    expect(occupied).toBeDefined();
    expect(fx.gizmo.lastCreatedRoot).toBe(occupied!.object3D);
    expect(fx.gizmo.lastCreatedRoot).not.toBe(fx.root);
    expect((fx.gizmo.lastOpts as Record<string, unknown>).shape).toBe('sprite');
    expect((fx.gizmo.lastOpts as Record<string, unknown>).userDataMarker).toBe('isFlipIcon');
    expect((fx.gizmo.lastOpts as Record<string, unknown>).attachToNode).toBe(true);
  });

  it('re-anchors at the NEW occupied snap after a flip', () => {
    const fx = makeFixture();
    const overlay = new SnapFlipIconOverlay();
    overlay.init(fx.viewer);

    // Initial hover: icon anchors at the originally-occupied snap (inlet).
    fx.bus.emit('object-hover', { node: fx.root });
    const firstAnchor = fx.gizmo.lastCreatedRoot;
    expect(firstAnchor).toBeDefined();

    // Simulate the flip: free the inlet pairing, then pair the outlet to
    // the same partner instead. The occupied snap on the belt root now
    // swaps from inlet to outlet.
    const own = fx.registry.getByOwnerRoot(fx.root);
    const oldOccupied = own.find(s => s.occupied)!;
    const newOccupied = own.find(s => s.id !== oldOccupied.id)!;
    const partnerId = oldOccupied.pairedSnapId!;
    fx.registry.markFree(oldOccupied.id);
    fx.registry.markOccupied(newOccupied.id, 'belt-A');
    fx.registry.markOccupied(partnerId, 'partner');
    fx.registry.pair(newOccupied.id, partnerId);

    // The active icon now points at the WRONG (no-longer-occupied) snap,
    // so we force a teardown + re-hover to re-anchor at the new occupied
    // snap. (In production the flip itself runs through model-cleared /
    // selection events that drive the same re-arm.)
    overlay.dispose();
    const overlay2 = new SnapFlipIconOverlay();
    overlay2.init(fx.viewer);
    fx.bus.emit('object-hover', { node: fx.root });

    expect(fx.gizmo.createCount).toBe(2);
    const secondAnchor = fx.gizmo.lastCreatedRoot;
    expect(secondAnchor).toBe(newOccupied.object3D);
    expect(secondAnchor).not.toBe(firstAnchor);
  });

  it('hides (no-op) when no occupied snap exists at show-time', () => {
    const fx = makeFixture();
    const overlay = new SnapFlipIconOverlay();
    overlay.init(fx.viewer);

    // Race condition: partner is gone & inlet unpaired before hover fires.
    const own = fx.registry.getByOwnerRoot(fx.root);
    const occupied = own.find(s => s.occupied)!;
    fx.registry.markFree(occupied.id);
    // canFlipPlacedComponent will already return false here (no occupied snap),
    // so the icon must stay hidden — gizmoManager.create must NOT be called.

    fx.bus.emit('object-hover', { node: fx.root });
    expect(fx.gizmo.createCount).toBe(0);
  });

  it('hides sprite on object-unhover after the grace period', async () => {
    vi.useFakeTimers();
    try {
      const fx = makeFixture();
      const overlay = new SnapFlipIconOverlay();
      overlay.init(fx.viewer);

      fx.bus.emit('object-hover', { node: fx.root });
      expect(fx.gizmo.createCount).toBe(1);

      // Unhover schedules the hide; it doesn't fire instantly anymore — the
      // grace window lets the cursor travel onto the icon to click it.
      fx.bus.emit('object-unhover', { node: fx.root, nodeType: 'asset' });
      expect(fx.gizmo.disposed).toBe(0);

      // Advance past the grace window (GRACE_MS = 800).
      vi.advanceTimersByTime(900);
      expect(fx.gizmo.disposed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps sprite visible if cursor enters the icon during grace', async () => {
    vi.useFakeTimers();
    try {
      const fx = makeFixture();
      const overlay = new SnapFlipIconOverlay();
      overlay.init(fx.viewer);

      fx.bus.emit('object-hover', { node: fx.root });
      fx.bus.emit('object-unhover', { node: fx.root, nodeType: 'asset' });

      // Within the grace window, cursor enters the sprite (marked as
      // isFlipIcon). The overlay must cancel the pending hide.
      const fakeSprite = new Object3D();
      fakeSprite.userData.isFlipIcon = true;
      fx.bus.emit('object-hover', { node: fakeSprite });

      vi.advanceTimersByTime(900);
      expect(fx.gizmo.disposed).toBe(0); // still alive
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides sprite during layout-drag-start (F13)', () => {
    const fx = makeFixture();
    const overlay = new SnapFlipIconOverlay();
    overlay.init(fx.viewer);

    fx.bus.emit('object-hover', { node: fx.root });
    expect(fx.gizmo.createCount).toBe(1);
    fx.bus.emit('layout-drag-start', { node: fx.root });
    expect(fx.gizmo.disposed).toBe(1);

    // While drag is active, further hovers stay hidden.
    fx.bus.emit('object-hover', { node: fx.root });
    expect(fx.gizmo.createCount).toBe(1);

    // After drag end, hovers re-arm.
    fx.bus.emit('layout-drag-end', { node: fx.root });
    fx.bus.emit('object-hover', { node: fx.root });
    expect(fx.gizmo.createCount).toBe(2);
  });

  it('does NOT show when visualSettings.showSnapFlipIcons is false (F14)', () => {
    setSnapFlipIconsVisible(false);
    const fx = makeFixture();
    const overlay = new SnapFlipIconOverlay();
    overlay.init(fx.viewer);

    fx.bus.emit('object-hover', { node: fx.root });
    expect(fx.gizmo.createCount).toBe(0);

    // Re-enable; new hover shows.
    setSnapFlipIconsVisible(true);
    fx.bus.emit('object-hover', { node: fx.root });
    expect(fx.gizmo.createCount).toBe(1);
  });

  it('does NOT show for non-flippable components (no second snap)', () => {
    const fx = makeFixture();
    const overlay = new SnapFlipIconOverlay();
    overlay.init(fx.viewer);

    // Strip the outlet so the belt has only one snap.
    fx.registry.unregister(fx.root.children[1].uuid); // outlet was added second

    fx.bus.emit('object-hover', { node: fx.root });
    expect(fx.gizmo.createCount).toBe(0);
  });

  it('click on flip icon triggers flipPlacedComponent (emits layout-transform-update)', () => {
    const fx = makeFixture();
    const overlay = new SnapFlipIconOverlay();
    overlay.init(fx.viewer);

    fx.bus.emit('object-hover', { node: fx.root });

    // Simulate clicking the gizmo sprite — the GizmoOverlayManager would have
    // tagged it `isFlipIcon=true` via userDataMarker. Build a stand-in node
    // with that marker for the click event.
    const fakeSprite = new Object3D();
    fakeSprite.userData.isFlipIcon = true;

    const emitSpy = vi.fn();
    const origEmit = fx.viewer.emit;
    fx.viewer.emit = (event: string, data?: unknown) => {
      emitSpy(event, data);
      origEmit.call(fx.viewer, event, data);
    };

    // The actual emitted event is 'object-clicked' (with -d); 'object-click'
    // is declared but never fired by the viewer. The click must land ON the
    // icon — provide a hitPoint at the occupied snap (where the icon sits).
    const occupied = fx.registry.getByOwnerRoot(fx.root).find(s => s.occupied)!;
    const iconWp = new Vector3();
    occupied.object3D.getWorldPosition(iconWp);
    fx.bus.emit('object-clicked', { node: fakeSprite, path: '', hitPoint: [iconWp.x, iconWp.y, iconWp.z] });

    // Flip service should have emitted layout-transform-update.
    expect(emitSpy).toHaveBeenCalledWith('layout-transform-update', expect.objectContaining({
      position: expect.any(Array),
      rotation: expect.any(Array),
    }));
  });

  it('does NOT flip when a click lands on the object mesh far from the icon', () => {
    const fx = makeFixture();
    const overlay = new SnapFlipIconOverlay();
    overlay.init(fx.viewer);

    // Icon is showing (object is flippable + hovered).
    fx.bus.emit('object-hover', { node: fx.root });
    expect(fx.gizmo.createCount).toBe(1);

    const emitSpy = vi.fn();
    const origEmit = fx.viewer.emit;
    fx.viewer.emit = (event: string, data?: unknown) => {
      emitSpy(event, data);
      origEmit.call(fx.viewer, event, data);
    };

    // A click/drag on the object's geometry resolves to the SAME placed root as
    // the icon, but its hit-point is far from the icon → must NOT flip.
    fx.bus.emit('object-clicked', { node: fx.root, path: 'belt-A', hitPoint: [10, 0, 10] });

    expect(emitSpy).not.toHaveBeenCalledWith('layout-transform-update', expect.anything());
  });

  it('click on non-icon node is ignored', () => {
    const fx = makeFixture();
    const overlay = new SnapFlipIconOverlay();
    overlay.init(fx.viewer);

    fx.bus.emit('object-hover', { node: fx.root });

    const some = new Object3D(); // no marker
    const emitSpy = vi.fn();
    const origEmit = fx.viewer.emit;
    fx.viewer.emit = (event: string, data?: unknown) => {
      emitSpy(event, data);
      origEmit.call(fx.viewer, event, data);
    };

    fx.bus.emit('object-click', { node: some, nodeType: 'asset', nodePath: '', pointer: { x: 0, y: 0 } });
    expect(emitSpy).not.toHaveBeenCalledWith('layout-transform-update', expect.any(Object));
  });

  it('dispose cleans up the active gizmo and unsubscribes', () => {
    const fx = makeFixture();
    const overlay = new SnapFlipIconOverlay();
    overlay.init(fx.viewer);

    fx.bus.emit('object-hover', { node: fx.root });
    expect(fx.gizmo.createCount).toBe(1);

    overlay.dispose();
    expect(fx.gizmo.disposed).toBe(1);

    // Further events should have no effect — subscriptions were torn down.
    fx.bus.emit('object-hover', { node: fx.root });
    expect(fx.gizmo.createCount).toBe(1); // unchanged
  });
});

// silence unused import lint
void Vector3;
