// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi } from 'vitest';
import { ModelOptionPlugin, optionIdFromUrl, remapAasLink, setComponentField } from '../src/plugins/models/model-option-plugin';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';

function makeAasNode(aasId: string, desc: string) {
  return { userData: { _rvAasLink: { aasId, description: desc }, realvirtual: { AASLink: { AASId: aasId, Description: desc } } } };
}
function sceneOf(nodes: Array<{ userData: Record<string, unknown> }>) {
  return { traverse: (cb: (n: { userData: Record<string, unknown> }) => void) => nodes.forEach(cb) };
}

describe('optionIdFromUrl', () => {
  it('reads ?option= from a url', () => {
    expect(optionIdFromUrl('m.glb?option=sew')).toBe('sew');
    expect(optionIdFromUrl('m.glb?x=1&option=bosch')).toBe('bosch');
  });
  it('returns null without an option marker', () => {
    expect(optionIdFromUrl('m.glb')).toBeNull();
    expect(optionIdFromUrl(null)).toBeNull();
    expect(optionIdFromUrl(undefined)).toBeNull();
  });
});

describe('remapAasLink', () => {
  it('rewrites matching nodes (derived _rvAasLink + raw AASLink component), leaves others', () => {
    const motor = makeAasNode('FESTO', 'Festo');
    const cylinder = makeAasNode('OTHER', 'Other');
    const viewer = { scene: sceneOf([motor, cylinder]) } as unknown as RVViewer;

    remapAasLink(viewer, 'FESTO', 'SEW_ID', 'SEW Motor');

    expect(motor.userData._rvAasLink).toEqual({ aasId: 'SEW_ID', description: 'SEW Motor' });
    expect(motor.userData.realvirtual).toEqual({ AASLink: { AASId: 'SEW_ID', Description: 'SEW Motor' } });
    expect(cylinder.userData._rvAasLink).toEqual({ aasId: 'OTHER', description: 'Other' }); // untouched
  });
});

describe('setComponentField', () => {
  it('sets any component field, creating the buckets as needed', () => {
    const node = { userData: {} as Record<string, unknown> };
    const viewer = { registry: { getNode: () => node } } as unknown as RVViewer;

    setComponentField(viewer, 'p', 'Drive', 'TargetSpeed', 250);

    expect(node.userData).toEqual({ realvirtual: { Drive: { TargetSpeed: 250 } } });
  });
  it('is a no-op when the node is missing', () => {
    const viewer = { registry: { getNode: () => null } } as unknown as RVViewer;
    expect(() => setComponentField(viewer, 'p', 'Drive', 'x', 1)).not.toThrow();
  });
});

describe('ModelOptionPlugin', () => {
  it('runs apply with the option id from the loaded model url', () => {
    const apply = vi.fn();
    const viewer = { pendingModelUrl: 'm.glb?option=sew' } as unknown as RVViewer;
    new ModelOptionPlugin(apply).onModelLoaded({} as LoadResult, viewer);
    expect(apply).toHaveBeenCalledWith(viewer, 'sew');
  });
  it('does not run apply when no option marker is present', () => {
    const apply = vi.fn();
    const viewer = { pendingModelUrl: 'm.glb' } as unknown as RVViewer;
    new ModelOptionPlugin(apply).onModelLoaded({} as LoadResult, viewer);
    expect(apply).not.toHaveBeenCalled();
  });
});
