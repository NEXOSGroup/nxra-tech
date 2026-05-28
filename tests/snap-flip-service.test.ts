// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for the snap-flip service (plan-190).
 *
 * The service operates on a minimal viewer surface: getPlugin + emit + a
 * highlighter + `isSimulationPaused`. We mock those rather than spinning up
 * a real RVViewer so the tests stay fast and deterministic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Object3D, Quaternion, Vector3 } from 'three';
import {
  canFlipPlacedComponent,
  flipPlacedComponent,
} from '../src/plugins/snap-point/snap-flip-service';
import { SnapPointRegistry } from '../src/core/engine/rv-snap-point-registry';

// ─── Test fixtures ────────────────────────────────────────────────────

/** Minimal SnapPoint shape that matches the registry's expectation. */
function registerSnap(
  registry: SnapPointRegistry,
  name: string,
  ownerRoot: Object3D,
  parent: Object3D,
  localPos: Vector3,
  typeId: string,
): { node: Object3D; id: string } {
  const node = new Object3D();
  node.name = name;
  node.position.copy(localPos);
  parent.add(node);
  parent.updateMatrixWorld(true);
  ownerRoot.updateMatrixWorld(true);
  registry.register({
    id: node.uuid,
    object3D: node,
    dir: parseDir(name),
    typeId,
    flow: 'bidi',
    ownerRoot,
    scenePath: name,
    occupied: false,
  });
  return { node, id: node.uuid };
}

function parseDir(name: string): { axis: 'X' | 'Y' | 'Z'; sign: 'N' | 'P' | 'B'; code: 'XN' | 'XP' | 'XB' | 'YN' | 'YP' | 'YB' | 'ZN' | 'ZP' | 'ZB' } {
  const m = /^Snap-([XYZ])([NPB])-/.exec(name);
  if (!m) throw new Error(`bad snap name in test: ${name}`);
  const axis = m[1] as 'X' | 'Y' | 'Z';
  const sign = m[2] as 'N' | 'P' | 'B';
  return { axis, sign, code: `${axis}${sign}` as never };
}

interface MockViewer {
  isSimulationPaused: boolean | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getPlugin: (id: string) => any;
  emit: ReturnType<typeof vi.fn>;
  highlighter: { highlight: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> };
  registry: { getPathForNode: (n: Object3D) => string | null };
}

function makeMockViewer(registry: SnapPointRegistry): MockViewer {
  return {
    isSimulationPaused: true,                       // default: paused → flips allowed
    getPlugin: (id: string) => id === 'snap-point'
      ? { getRegistry: () => registry }
      : undefined,
    emit: vi.fn(),
    highlighter: { highlight: vi.fn(), clear: vi.fn() },
    registry: {
      getPathForNode: (n: Object3D) => n.userData?._testPath ?? n.name ?? null,
    },
  };
}

/**
 * Two-snap belt + a partner asset, with the belt's inlet currently paired
 * to the partner. Conventional layout: belt sits at the origin, inlet at
 * local -Z, outlet at local +Z; partner is positioned so its inlet meets
 * the belt's outlet end (so the chain "looks right" at start).
 */
interface BeltFixture {
  root: Object3D;
  inlet: { node: Object3D; id: string };
  outlet: { node: Object3D; id: string };
  partner: Object3D;
  partnerSnap: { node: Object3D; id: string };
  registry: SnapPointRegistry;
}

function makeBeltWithInletOutlet(): BeltFixture {
  const registry = new SnapPointRegistry();

  // Partner asset (rooted at world origin) with a single Snap-ZP-belt.
  const partner = new Object3D();
  partner.userData._layoutId = 'partner';
  partner.name = 'partner';
  partner.userData._testPath = 'partner';
  partner.position.set(0, 0, 0);
  partner.updateMatrixWorld(true);
  const partnerSnap = registerSnap(
    registry,
    'Snap-ZP-belt',
    partner,
    partner,
    new Vector3(0, 0, 0.5),
    'belt',
  );

  // Belt asset placed so its inlet matches the partner's outlet.
  const root = new Object3D();
  root.userData._layoutId = 'belt-A';
  root.name = 'belt-A';
  root.userData._testPath = 'belt-A';
  root.position.set(0, 0, 1.0);
  root.updateMatrixWorld(true);

  const inlet = registerSnap(
    registry, 'Snap-ZN-belt', root, root,
    new Vector3(0, 0, -0.5),  // local -Z → world z=0.5 (= partner outlet)
    'belt',
  );
  const outlet = registerSnap(
    registry, 'Snap-ZP-belt', root, root,
    new Vector3(0, 0, 0.5),   // local +Z → world z=1.5
    'belt',
  );

  // Pair: belt.inlet ↔ partner.outlet
  registry.markOccupied(inlet.id, 'belt-A');
  registry.markOccupied(partnerSnap.id, 'partner');
  registry.pair(inlet.id, partnerSnap.id);

  return { root, inlet, outlet, partner, partnerSnap, registry };
}

// ─── canFlipPlacedComponent ────────────────────────────────────────────

describe('canFlipPlacedComponent', () => {
  it('returns true for belt with paired inlet + free outlet of same typeId', () => {
    const fx = makeBeltWithInletOutlet();
    expect(canFlipPlacedComponent(fx.root, fx.registry)).toBe(true);
  });

  it('returns false when registry is null', () => {
    const fx = makeBeltWithInletOutlet();
    expect(canFlipPlacedComponent(fx.root, null)).toBe(false);
  });

  it('returns false for component without compatible second snap', () => {
    const registry = new SnapPointRegistry();
    const root = new Object3D();
    root.userData._layoutId = 'test-root';
    root.updateMatrixWorld(true);
    const partner = new Object3D();
    partner.updateMatrixWorld(true);
    const own = registerSnap(registry, 'Snap-ZN-belt', root, root, new Vector3(), 'belt');
    const ptr = registerSnap(registry, 'Snap-ZP-belt', partner, partner, new Vector3(), 'belt');
    registry.markOccupied(own.id, 'a');
    registry.markOccupied(ptr.id, 'b');
    registry.pair(own.id, ptr.id);
    expect(canFlipPlacedComponent(root, registry)).toBe(false);
  });

  it('returns false when no snap is occupied', () => {
    const fx = makeBeltWithInletOutlet();
    // Force-free everything
    fx.registry.markFree(fx.inlet.id);
    expect(canFlipPlacedComponent(fx.root, fx.registry)).toBe(false);
  });

  it('returns false when typeId of sibling differs', () => {
    const registry = new SnapPointRegistry();
    const root = new Object3D();
    root.userData._layoutId = 'test-root';
    root.updateMatrixWorld(true);
    const partner = new Object3D(); partner.updateMatrixWorld(true);
    const inlet = registerSnap(registry, 'Snap-ZN-belt', root, root, new Vector3(0, 0, -0.5), 'belt');
    registerSnap(registry, 'Snap-ZP-roller', root, root, new Vector3(0, 0, 0.5), 'roller'); // wrong type
    const ptr = registerSnap(registry, 'Snap-ZP-belt', partner, partner, new Vector3(), 'belt');
    registry.markOccupied(inlet.id, 'a');
    registry.markOccupied(ptr.id, 'b');
    registry.pair(inlet.id, ptr.id);
    expect(canFlipPlacedComponent(root, registry)).toBe(false);
  });
});

// ─── flipPlacedComponent ───────────────────────────────────────────────

describe('flipPlacedComponent', () => {
  let fx: BeltFixture;
  let viewer: MockViewer;

  beforeEach(() => {
    fx = makeBeltWithInletOutlet();
    viewer = makeMockViewer(fx.registry);
  });

  it('flips a belt with paired inlet to use outlet instead', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = flipPlacedComponent(fx.root, viewer as any);
    expect(result.ok).toBe(true);

    // Outlet must now carry the pairing; inlet must be free.
    expect(fx.outlet.node.uuid).toBe(fx.outlet.id);
    const outletReg = fx.registry.getById(fx.outlet.id)!;
    const inletReg  = fx.registry.getById(fx.inlet.id)!;
    expect(outletReg.occupied).toBe(true);
    expect(inletReg.occupied).toBe(false);
    expect(outletReg.pairedSnapId).toBe(fx.partnerSnap.id);
    // Partner stays paired to the belt — pairedSnapId points at the NEW (outlet) snap.
    const partnerReg = fx.registry.getById(fx.partnerSnap.id)!;
    expect(partnerReg.occupied).toBe(true);
    expect(partnerReg.pairedSnapId).toBe(fx.outlet.id);

    // Belt's outlet snap now world-matches the partner's snap world position.
    const partnerWp = new Vector3();
    fx.partnerSnap.node.getWorldPosition(partnerWp);
    fx.outlet.node.updateMatrixWorld(true);
    const outletWp = new Vector3();
    fx.outlet.node.getWorldPosition(outletWp);
    expect(outletWp.distanceTo(partnerWp)).toBeLessThan(1e-4);
  });

  it('is reversible — two flips restore original pose (±1e-4)', () => {
    const posBefore = fx.root.position.clone();
    const quatBefore = fx.root.quaternion.clone();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(flipPlacedComponent(fx.root, viewer as any).ok).toBe(true);
    // After the first flip the outlet should be the occupied one; before the
    // second flip we make sure flipping again uses the OTHER snap (inlet)
    // — which the service does automatically since the loop picks the first
    // occupied snap each call.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(flipPlacedComponent(fx.root, viewer as any).ok).toBe(true);

    expect(fx.root.position.distanceTo(posBefore)).toBeLessThan(1e-4);
    expect(fx.root.quaternion.angleTo(quatBefore)).toBeLessThan(1e-4);
  });

  it('returns no-op reason when no snap is occupied', () => {
    fx.registry.markFree(fx.inlet.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = flipPlacedComponent(fx.root, viewer as any);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-occupied-snap');
  });

  it('returns no-op when the snap-point plugin is missing', () => {
    viewer.getPlugin = () => undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = flipPlacedComponent(fx.root, viewer as any);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-snap-registry');
  });

  it('emits a layout-transform-update event with position + rotation', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    flipPlacedComponent(fx.root, viewer as any);
    expect(viewer.emit).toHaveBeenCalledWith('layout-transform-update', expect.objectContaining({
      path: 'belt-A',
      position: expect.any(Array),
      rotation: expect.any(Array),
    }));
    const payload = viewer.emit.mock.calls.find(c => c[0] === 'layout-transform-update')![1] as {
      position: number[]; rotation: number[];
    };
    expect(payload.position).toHaveLength(3);
    expect(payload.rotation).toHaveLength(3);
  });

  it('invokes highlighter.highlight on success', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    flipPlacedComponent(fx.root, viewer as any);
    expect(viewer.highlighter.highlight).toHaveBeenCalledWith(fx.root);
  });

  it('refreshes the snap markers after a flip (occupancy reflects rotation)', () => {
    // Rotation changes which snaps are occupied; the service must re-sync the
    // marker visuals so the freed snap can be reused and the now-occupied one
    // is hidden. We expose a marker renderer on the plugin and assert refreshAll.
    const refreshAll = vi.fn();
    viewer.getPlugin = (id: string) => id === 'snap-point'
      ? { getRegistry: () => fx.registry, getMarkerRenderer: () => ({ refreshAll }) }
      : undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = flipPlacedComponent(fx.root, viewer as any);
    expect(result.ok).toBe(true);
    expect(refreshAll).toHaveBeenCalledTimes(1);
  });

  it('returns no-compatible-partner when the partner snap is missing', () => {
    // Service resolves partner via registry.getById(partnerId). If that
    // returns undefined (e.g. partner unregistered just before flip), the
    // flip aborts cleanly without mutating scene state.
    const realGetById = fx.registry.getById.bind(fx.registry);
    fx.registry.getById = ((id: string) => {
      if (id === fx.partnerSnap.id) return undefined;
      return realGetById(id);
    }) as typeof fx.registry.getById;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = flipPlacedComponent(fx.root, viewer as any);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-compatible-partner');
  });

  it('preserves chain — flipping middle of 3-belt chain keeps both ends paired', () => {
    // Layout: left (Snap-ZP) → middle (Snap-ZN ... Snap-ZP) → right (Snap-ZN)
    const registry = new SnapPointRegistry();

    const left = new Object3D();
    left.userData._layoutId = 'left';
    left.name = 'left'; left.userData._testPath = 'left';
    left.position.set(0, 0, 0);
    left.updateMatrixWorld(true);
    const leftOut = registerSnap(registry, 'Snap-ZP-belt', left, left, new Vector3(0, 0, 0.5), 'belt');

    const middle = new Object3D();
    middle.userData._layoutId = 'middle';
    middle.name = 'middle'; middle.userData._testPath = 'middle';
    middle.position.set(0, 0, 1);
    middle.updateMatrixWorld(true);
    const mIn  = registerSnap(registry, 'Snap-ZN-belt', middle, middle, new Vector3(0, 0, -0.5), 'belt');
    const mOut = registerSnap(registry, 'Snap-ZP-belt', middle, middle, new Vector3(0, 0, 0.5), 'belt');

    const right = new Object3D();
    right.userData._layoutId = 'right';
    right.name = 'right'; right.userData._testPath = 'right';
    right.position.set(0, 0, 2);
    right.updateMatrixWorld(true);
    const rIn = registerSnap(registry, 'Snap-ZN-belt', right, right, new Vector3(0, 0, -0.5), 'belt');

    // Wire: leftOut ↔ mIn   AND   mOut ↔ rIn
    registry.markOccupied(leftOut.id, 'left');
    registry.markOccupied(mIn.id, 'middle');
    registry.pair(leftOut.id, mIn.id);
    registry.markOccupied(mOut.id, 'middle');
    registry.markOccupied(rIn.id, 'right');
    registry.pair(mOut.id, rIn.id);

    const mv = makeMockViewer(registry);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = flipPlacedComponent(middle, mv as any);
    expect(result.ok).toBe(true);

    // Left was paired to middle's inlet; after flip middle's OUTLET inherits
    // that pairing. The right end of the chain stays where it was — its
    // pairing is between mOut↔rIn, untouched by the flip itself.
    const leftReg = registry.getById(leftOut.id)!;
    const rightReg = registry.getById(rIn.id)!;
    expect(leftReg.occupied).toBe(true);
    expect(rightReg.occupied).toBe(true);
  });
});

// Silence the global Quaternion import (used in fixtures via Three.js side-effects).
void Quaternion;
