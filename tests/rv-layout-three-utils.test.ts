// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshBasicMaterial } from 'three';
import { disposeSubtree } from '../src/plugins/layout-planner/three-utils';

describe('disposeSubtree', () => {
  it('should dispose geometry and material on mesh', () => {
    const geo = new BoxGeometry();
    const mat = new MeshBasicMaterial();
    const mesh = new Mesh(geo, mat);
    const geoSpy = vi.spyOn(geo, 'dispose');
    const matSpy = vi.spyOn(mat, 'dispose');

    disposeSubtree(mesh);

    expect(geoSpy).toHaveBeenCalledOnce();
    expect(matSpy).toHaveBeenCalledOnce();
  });

  it('should not double-dispose shared geometry', () => {
    const sharedGeo = new BoxGeometry();
    const mat1 = new MeshBasicMaterial();
    const mat2 = new MeshBasicMaterial();
    const mesh1 = new Mesh(sharedGeo, mat1);
    const mesh2 = new Mesh(sharedGeo, mat2);
    const group = new Group();
    group.add(mesh1, mesh2);

    const geoSpy = vi.spyOn(sharedGeo, 'dispose');
    disposeSubtree(group);

    expect(geoSpy).toHaveBeenCalledOnce(); // NOT twice
  });

  it('should handle array materials', () => {
    const geo = new BoxGeometry();
    const mats = [new MeshBasicMaterial(), new MeshBasicMaterial()];
    const mesh = new Mesh(geo, mats);
    const spies = mats.map(m => vi.spyOn(m, 'dispose'));

    disposeSubtree(mesh);

    spies.forEach(s => expect(s).toHaveBeenCalledOnce());
  });

  it('should handle empty group', () => {
    const group = new Group();
    expect(() => disposeSubtree(group)).not.toThrow();
  });
});
