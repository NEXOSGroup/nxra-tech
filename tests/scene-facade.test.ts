// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { SceneFacadeImpl } from '../src/core/facades/scene-facade';

describe('SceneFacadeImpl (plan-182 Phase 4a)', () => {
  it('eachNode delegates to viewer.registry.forEachNode (adapts path/node order)', () => {
    const spy = vi.fn();
    const nodeA = new Object3D();
    const nodeB = new Object3D();
    // NodeRegistry.forEachNode uses (path, node) order — SceneFacade exposes (node, path)
    const fakeViewer = {
      registry: {
        forEachNode: (cb: (path: string, node: Object3D) => void) => {
          cb('root/a', nodeA);
          cb('root/b', nodeB);
        },
      },
    } as never;
    const facade = new SceneFacadeImpl(fakeViewer);
    facade.eachNode((n, p) => spy(n, p));
    expect(spy).toHaveBeenCalledWith(nodeA, 'root/a');
    expect(spy).toHaveBeenCalledWith(nodeB, 'root/b');
  });

  it('eachNode is a no-op when registry is null', () => {
    const fakeViewer = { registry: null } as never;
    const facade = new SceneFacadeImpl(fakeViewer);
    expect(() => facade.eachNode(() => {})).not.toThrow();
  });

  it('projectPoint returns null when camera is missing', () => {
    const fakeViewer = { camera: null, renderer: null } as never;
    const facade = new SceneFacadeImpl(fakeViewer);
    expect(facade.projectPoint(new Vector3(0, 0, 0))).toBeNull();
  });

  it('highlightByPath/clearHighlight delegate', () => {
    const highlightSpy = vi.fn();
    const clearSpy = vi.fn();
    const fakeViewer = { highlightByPath: highlightSpy, clearHighlight: clearSpy } as never;
    const facade = new SceneFacadeImpl(fakeViewer);
    facade.highlightByPath('foo', true);
    expect(highlightSpy).toHaveBeenCalledWith('foo', true);
    facade.clearHighlight();
    expect(clearSpy).toHaveBeenCalled();
  });
});
