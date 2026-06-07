// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Mesh, Group, Object3D, BoxGeometry, MeshStandardMaterial } from 'three';
import { classifyShadows, applyShadowFlags } from '../src/core/engine/rv-mesh-classifier';

/**
 * Build a Mesh whose material we can mutate before classification.
 * Uses MeshStandardMaterial so the material has the real prototype + defaults.
 */
function makeMesh(matOverrides: Partial<MeshStandardMaterial> = {}): Mesh {
  const mat = new MeshStandardMaterial();
  Object.assign(mat, matOverrides);
  return new Mesh(new BoxGeometry(1, 1, 1), mat);
}

describe('classifyShadows', () => {
  it('returns true for a plain opaque material (default MeshStandardMaterial)', () => {
    const mesh = makeMesh();
    expect(classifyShadows(mesh)).toBe(true);
  });

  it('returns false when material.transparent === true', () => {
    const mesh = makeMesh({ transparent: true });
    expect(classifyShadows(mesh)).toBe(false);
  });

  it('returns false when material.alphaTest > 0 (alpha-cutout / foliage)', () => {
    const mesh = makeMesh({ alphaTest: 0.5 });
    expect(classifyShadows(mesh)).toBe(false);
  });

  it('returns true when material.alphaTest === 0 (explicit no-cutout)', () => {
    const mesh = makeMesh({ alphaTest: 0 });
    expect(classifyShadows(mesh)).toBe(true);
  });

  it('returns false when material has an alphaMap', () => {
    // alphaMap is typed Texture | null — a truthy non-null value is enough
    const mesh = makeMesh();
    (mesh.material as MeshStandardMaterial).alphaMap = {} as unknown as MeshStandardMaterial['alphaMap'];
    expect(classifyShadows(mesh)).toBe(false);
  });

  it('returns false when material.opacity < 1 (semi-transparent)', () => {
    const mesh = makeMesh({ opacity: 0.5 });
    expect(classifyShadows(mesh)).toBe(false);
  });

  it('returns true when material.opacity === 1 (fully opaque)', () => {
    const mesh = makeMesh({ opacity: 1 });
    expect(classifyShadows(mesh)).toBe(true);
  });

  it('returns true when material is undefined (defensive — no material assigned)', () => {
    const mesh = new Mesh(new BoxGeometry(1, 1, 1));
    // Force material to undefined to simulate a meshless edge case
    (mesh as unknown as { material: undefined }).material = undefined;
    expect(classifyShadows(mesh)).toBe(true);
  });

  it('combines flags correctly — transparent + opacity < 1 still returns false', () => {
    const mesh = makeMesh({ transparent: true, opacity: 0.3 });
    expect(classifyShadows(mesh)).toBe(false);
  });

  it('does NOT mutate the mesh or its material', () => {
    const mesh = makeMesh({ transparent: true });
    const matBefore = mesh.material as MeshStandardMaterial;
    const castBefore = mesh.castShadow;
    const receiveBefore = mesh.receiveShadow;
    const transparentBefore = matBefore.transparent;
    classifyShadows(mesh);
    expect(mesh.castShadow).toBe(castBefore);
    expect(mesh.receiveShadow).toBe(receiveBefore);
    expect((mesh.material as MeshStandardMaterial).transparent).toBe(transparentBefore);
  });

  it('handles emissive opaque material as cast-shadow (emissive does not imply alpha)', () => {
    const mesh = makeMesh({ emissiveIntensity: 1 });
    expect(classifyShadows(mesh)).toBe(true);
  });
});

describe('applyShadowFlags', () => {
  it('sets castShadow per classifyShadows and receiveShadow=true on opaque meshes', () => {
    const root = new Group();
    const opaque = makeMesh();
    opaque.castShadow = false;   // start wrong (e.g. cloned library object)
    opaque.receiveShadow = false;
    root.add(opaque);

    applyShadowFlags(root);

    expect(opaque.castShadow).toBe(true);
    expect(opaque.receiveShadow).toBe(true);
  });

  it('keeps castShadow=false for transparent meshes but still sets receiveShadow=true', () => {
    const root = new Group();
    const glass = makeMesh({ transparent: true });
    glass.castShadow = true; // would be wrong for a transparent mesh
    root.add(glass);

    applyShadowFlags(root);

    expect(glass.castShadow).toBe(false);
    expect(glass.receiveShadow).toBe(true);
  });

  it('applies recursively to nested meshes and ignores non-mesh nodes', () => {
    const root = new Group();
    const empty = new Object3D(); // non-mesh — must be skipped without error
    const childMesh = makeMesh();
    childMesh.castShadow = false;
    childMesh.receiveShadow = false;
    empty.add(childMesh);
    root.add(empty);

    applyShadowFlags(root);

    expect(childMesh.castShadow).toBe(true);
    expect(childMesh.receiveShadow).toBe(true);
  });
});
