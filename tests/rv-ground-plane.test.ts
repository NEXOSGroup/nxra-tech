// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Mesh, MeshStandardMaterial, CanvasTexture, PlaneGeometry, BufferGeometry } from 'three';
import {
  createGroundFade,
  drawCheckerPattern,
  BG_BASE_SCALAR,
  FLOOR_FADE_START_RATIO,
  FLOOR_FADE_END_RATIO,
} from '../src/core/engine/rv-ground-plane';

describe('rv-ground-plane — createGroundFade', () => {
  it('returns a Mesh together with the backing checker canvas', () => {
    const { mesh, canvas } = createGroundFade(1.0, /* isWebGPU */ false);
    expect(mesh).toBeInstanceOf(Mesh);
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(canvas.width).toBe(512);
    expect(canvas.height).toBe(512);
  });

  it('configures the mesh with the same defaults as the original viewer', () => {
    const { mesh } = createGroundFade(1.0, false);
    // Rotated horizontal so the plane lies on the XZ ground.
    expect(mesh.rotation.x).toBeCloseTo(-Math.PI / 2);
    // Rendered first so the rest of the scene composites on top of it.
    expect(mesh.renderOrder).toBe(-1);
    // Receives shadows from drives / MUs above it.
    expect(mesh.receiveShadow).toBe(true);
    // Hidden until the viewer scales it to the loaded model.
    expect(mesh.visible).toBe(false);
  });

  it('uses MeshStandardMaterial with the alphaMap + map combo', () => {
    const { mesh } = createGroundFade(1.0, false);
    const mat = mesh.material as MeshStandardMaterial;
    expect(mat).toBeInstanceOf(MeshStandardMaterial);
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(mat.roughness).toBe(1.0);
    expect(mat.metalness).toBe(0.0);
    expect(mat.map).toBeInstanceOf(CanvasTexture);
    expect(mat.alphaMap).toBeInstanceOf(CanvasTexture);
  });

  it('keeps PlaneGeometry indexed in WebGL mode', () => {
    const { mesh } = createGroundFade(1.0, /* isWebGPU */ false);
    expect(mesh.geometry).toBeInstanceOf(PlaneGeometry);
    expect(mesh.geometry.index).not.toBeNull();
  });

  it('converts PlaneGeometry to non-indexed in WebGPU mode', () => {
    const { mesh } = createGroundFade(1.0, /* isWebGPU */ true);
    // After toNonIndexed() the result is a generic BufferGeometry, not a
    // PlaneGeometry, and the index attribute is dropped.
    expect(mesh.geometry).toBeInstanceOf(BufferGeometry);
    expect(mesh.geometry.index).toBeNull();
  });

  it('is a pure function — repeated calls produce independent meshes', () => {
    const a = createGroundFade(1.0, false);
    const b = createGroundFade(1.0, false);
    expect(a.mesh).not.toBe(b.mesh);
    expect(a.canvas).not.toBe(b.canvas);
    expect(a.mesh.material).not.toBe(b.mesh.material);
    expect(a.mesh.geometry).not.toBe(b.mesh.geometry);
  });

  it('exports the constants used by the viewer', () => {
    // These are the public source-of-truth values for the floor disc layout.
    expect(BG_BASE_SCALAR).toBeCloseTo(0x9a / 255);
    expect(FLOOR_FADE_START_RATIO).toBe(1.5);
    expect(FLOOR_FADE_END_RATIO).toBe(6.0);
  });
});

describe('rv-ground-plane — drawCheckerPattern', () => {
  it('paints both colours across the canvas at contrast=1', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    drawCheckerPattern(canvas, 1.0);
    const ctx = canvas.getContext('2d')!;
    // Tile 0 (top-left, even sum) should be the lighter colour;
    // tile 1 (one over) should be the darker base.
    const tile0 = ctx.getImageData(2, 2, 1, 1).data;
    const tile1 = ctx.getImageData(2 + 8, 2, 1, 1).data;
    expect(tile0[0]).toBeGreaterThan(tile1[0]);
    // The darker tile should equal the background base scalar (0x9a).
    expect(tile1[0]).toBe(0x9a);
  });

  it('produces a flat midgray at contrast=0', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    drawCheckerPattern(canvas, 0.0);
    const ctx = canvas.getContext('2d')!;
    const tile0 = ctx.getImageData(2, 2, 1, 1).data;
    const tile1 = ctx.getImageData(2 + 4, 2, 1, 1).data;
    // Both tiles collapse to the base colour — checker pattern disappears.
    expect(tile0[0]).toBe(tile1[0]);
    expect(tile0[0]).toBe(0x9a);
  });
});
