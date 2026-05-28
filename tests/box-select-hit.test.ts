// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import {
  Mesh,
  BoxGeometry,
  MeshBasicMaterial,
  PerspectiveCamera,
  Object3D,
} from 'three';
import {
  computeBoxSelectPaths,
  combineSelection,
  type BoxSelectRegistryLike,
  type ClientRect,
} from '../src/plugins/layout-planner/box-select-hit';

// ─── Fakes ──────────────────────────────────────────────────────────────

/**
 * Build a Mesh marked as a layout instance, optionally locked, positioned
 * at `(x, y, z)` with a 1×1×1 box geometry.
 */
function makePlacement(opts: {
  id: string;
  pos?: [number, number, number];
  locked?: boolean;
}): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  mesh.userData._layoutId = opts.id;
  if (opts.locked) {
    mesh.userData.realvirtual = { LayoutObject: { Locked: true } };
  }
  if (opts.pos) mesh.position.set(...opts.pos);
  mesh.updateMatrixWorld(true);
  return mesh;
}

/**
 * Camera that looks down the -Z axis from (0, 0, 10), aimed at origin.
 * Unit cubes at the origin project to the centre of NDC; cubes at
 * x=+5 project to the right, etc.
 */
function makeCamera(): PerspectiveCamera {
  const cam = new PerspectiveCamera(60, 1, 0.1, 100);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  // matrixWorldInverse is needed by `isInFrontOfCamera` — three.js refreshes
  // it lazily through Object3D.updateMatrixWorld plus a renderer pass.
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  return cam;
}

/**
 * Fake canvas with a 1000×1000 client rect at the viewport origin.
 * computeBoxSelectPaths only calls `getBoundingClientRect()`.
 */
function makeCanvas(): HTMLCanvasElement {
  const canvas = {
    getBoundingClientRect: () => ({
      left: 0, top: 0, right: 1000, bottom: 1000,
      width: 1000, height: 1000, x: 0, y: 0,
      toJSON() { return this; },
    }),
  } as unknown as HTMLCanvasElement;
  return canvas;
}

/** Map every placement back to its `_layoutId` as the path. */
const fakeRegistry: BoxSelectRegistryLike = {
  getPathForNode(node: Object3D): string | null {
    const id = node.userData?._layoutId;
    return typeof id === 'string' ? id : null;
  },
};

// ─── Geometry tests ─────────────────────────────────────────────────────

describe('computeBoxSelectPaths', () => {
  it('returns a placement whose centre projects inside the marquee', () => {
    const map = new Map<string, Object3D>([
      ['a', makePlacement({ id: 'a' })], // at origin → centre of viewport
    ]);
    // Marquee spans the centre of the 1000×1000 viewport.
    const rect: ClientRect = { l: 400, t: 400, w: 200, h: 200 };
    const paths = computeBoxSelectPaths(makeCamera(), makeCanvas(), rect, map, fakeRegistry);
    expect(paths).toEqual(['a']);
  });

  it('excludes a locked placement even when geometrically inside', () => {
    const map = new Map<string, Object3D>([
      ['a', makePlacement({ id: 'a', locked: true })],
    ]);
    const rect: ClientRect = { l: 0, t: 0, w: 1000, h: 1000 };
    const paths = computeBoxSelectPaths(makeCamera(), makeCanvas(), rect, map, fakeRegistry);
    expect(paths).toEqual([]);
  });

  it('does not return a placement entirely outside the marquee', () => {
    const map = new Map<string, Object3D>([
      // Far to the left; with the camera at (0,0,10) and FOV 60°, x=-5 is
      // well off-screen for a 200-px-wide marquee at the centre.
      ['a', makePlacement({ id: 'a', pos: [-5, 0, 0] })],
    ]);
    const rect: ClientRect = { l: 400, t: 400, w: 200, h: 200 };
    const paths = computeBoxSelectPaths(makeCamera(), makeCanvas(), rect, map, fakeRegistry);
    expect(paths).toEqual([]);
  });

  it('returns a placement straddling the marquee edge (any-overlap mode)', () => {
    // Place at the very edge of the marquee — its 1×1×1 AABB overhangs into
    // the rectangle even if its centre is outside.
    const cam = makeCamera();
    // We pick a position whose centre is just outside the marquee, but the
    // unit cube extends inside. A small x-offset puts the centre slightly
    // left of marquee xMin while the right face crosses in.
    const map = new Map<string, Object3D>([
      ['a', makePlacement({ id: 'a', pos: [0.4, 0, 0] })],
    ]);
    // Tight rectangle in the centre; with camera at z=10 and unit cubes,
    // marquee covers roughly the [0.05, 0.4] NDC band around origin.
    const rect: ClientRect = { l: 510, t: 480, w: 30, h: 40 };
    const paths = computeBoxSelectPaths(cam, makeCanvas(), rect, map, fakeRegistry);
    expect(paths).toEqual(['a']);
  });

  it('does not select an object entirely behind the camera', () => {
    // Camera is at z=10 looking at origin. Putting a placement at z=20
    // puts it behind the camera entirely.
    const map = new Map<string, Object3D>([
      ['a', makePlacement({ id: 'a', pos: [0, 0, 20] })],
    ]);
    // Full-viewport marquee — would catch a centred placement if it
    // were in front. We expect rejection because the cube is entirely behind.
    const rect: ClientRect = { l: 0, t: 0, w: 1000, h: 1000 };
    const paths = computeBoxSelectPaths(makeCamera(), makeCanvas(), rect, map, fakeRegistry);
    expect(paths).toEqual([]);
  });

  it('selects a placement crossing the camera near plane (straddling case)', () => {
    // Half in front, half behind: position at z=10 means the cube spans
    // z ∈ [9.5, 10.5] while the camera sits at z=10. The four corners with
    // z=9.5 are in front (z_cam = -0.5 < 0), the four with z=10.5 are
    // behind. The function must accept this as a hit.
    const map = new Map<string, Object3D>([
      ['a', makePlacement({ id: 'a', pos: [0, 0, 10] })],
    ]);
    const rect: ClientRect = { l: 0, t: 0, w: 1000, h: 1000 };
    const paths = computeBoxSelectPaths(makeCamera(), makeCanvas(), rect, map, fakeRegistry);
    expect(paths).toEqual(['a']);
  });

  it('returns [] for an empty objectMap', () => {
    const rect: ClientRect = { l: 0, t: 0, w: 1000, h: 1000 };
    const paths = computeBoxSelectPaths(
      makeCamera(), makeCanvas(), rect, new Map(), fakeRegistry,
    );
    expect(paths).toEqual([]);
  });

  it('preserves objectMap iteration order for stable results', () => {
    const map = new Map<string, Object3D>([
      ['a', makePlacement({ id: 'a', pos: [-0.5, 0, 0] })],
      ['b', makePlacement({ id: 'b', pos: [0, 0, 0] })],
      ['c', makePlacement({ id: 'c', pos: [0.5, 0, 0] })],
    ]);
    const rect: ClientRect = { l: 0, t: 0, w: 1000, h: 1000 };
    const paths = computeBoxSelectPaths(
      makeCamera(), makeCanvas(), rect, map, fakeRegistry,
    );
    expect(paths).toEqual(['a', 'b', 'c']);
  });
});

// ─── Combiner tests ─────────────────────────────────────────────────────

describe('combineSelection', () => {
  it('replaces when no modifier is held', () => {
    const result = combineSelection(['a', 'b'], ['c', 'd'], { shift: false, ctrl: false });
    expect(result).toEqual(['c', 'd']);
  });

  it('unions current + marquee when shift is held', () => {
    const result = combineSelection(['a', 'b'], ['b', 'c'], { shift: true, ctrl: false });
    expect(new Set(result)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('toggles (XOR) when ctrl is held — overlap is removed, others stay/added', () => {
    const result = combineSelection(['a', 'b', 'c'], ['b', 'd'], { shift: false, ctrl: true });
    // 'b' overlapped → removed. 'a','c' kept. 'd' added.
    expect(new Set(result)).toEqual(new Set(['a', 'c', 'd']));
  });

  it('ctrl wins over shift when both are held', () => {
    const result = combineSelection(['a', 'b'], ['b', 'c'], { shift: true, ctrl: true });
    // XOR — 'b' overlap removed; 'a' kept; 'c' added.
    expect(new Set(result)).toEqual(new Set(['a', 'c']));
  });

  it('returns a new array (does not mutate inputs)', () => {
    const cur = ['a'];
    const mar = ['b'];
    combineSelection(cur, mar, { shift: true, ctrl: false });
    expect(cur).toEqual(['a']);
    expect(mar).toEqual(['b']);
  });
});
