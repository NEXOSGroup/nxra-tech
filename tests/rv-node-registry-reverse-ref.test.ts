// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * NodeRegistry reverse-reference index — lazy-build tests.
 *
 * Verifies that getReferencesTo() builds the reverse-ref index on first
 * access (no explicit buildReverseRefIndex() call needed) and returns
 * correct results on subsequent lookups.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';

/**
 * Create a node carrying a rv_extras ComponentReference field.
 * Structure mirrors what buildReverseRefIndex expects:
 *   userData.realvirtual[compType][field] = { type: 'ComponentReference', path }
 */
function makeRefNode(
  name: string,
  compType: string,
  field: string,
  targetPath: string,
): Object3D {
  const node = new Object3D();
  node.name = name;
  node.userData.realvirtual = {
    [compType]: {
      [field]: { type: 'ComponentReference', path: targetPath, componentType: 'realvirtual.Drive' },
    },
  };
  return node;
}

describe('NodeRegistry reverse-ref lazy build', () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    registry = new NodeRegistry();
  });

  it('builds the index lazily on first getReferencesTo() (no explicit build call)', () => {
    // Target node (no refs of its own) + a source referencing it
    const target = new Object3D();
    target.name = 'Motor';
    registry.registerNode('Cell/Motor', target);

    const source = makeRefNode('Sensor', 'Sensor', 'ConnectedDrive', 'Cell/Motor');
    registry.registerNode('Cell/Sensor', source);

    // No explicit buildReverseRefIndex() call — should still resolve
    const refs = registry.getReferencesTo('Cell/Motor');
    expect(refs.length).toBe(1);
    expect(refs[0]).toEqual({
      sourcePath: 'Cell/Sensor',
      fieldName: 'ConnectedDrive',
      componentType: 'Sensor',
    });
  });

  it('returns empty array for an unreferenced target after lazy build', () => {
    const a = makeRefNode('A', 'Sensor', 'Ref', 'Cell/Target');
    registry.registerNode('Cell/A', a);
    const target = new Object3D();
    registry.registerNode('Cell/Target', target);
    const orphan = new Object3D();
    registry.registerNode('Cell/Orphan', orphan);

    // First access triggers build
    expect(registry.getReferencesTo('Cell/Target').length).toBe(1);
    // Subsequent lookups remain correct (index already built)
    expect(registry.getReferencesTo('Cell/Orphan')).toEqual([]);
  });

  it('aggregates multiple references to the same target', () => {
    const s1 = makeRefNode('S1', 'Sensor', 'Drive', 'Cell/Motor');
    const s2 = makeRefNode('S2', 'Grip', 'TargetDrive', 'Cell/Motor');
    registry.registerNode('Cell/S1', s1);
    registry.registerNode('Cell/S2', s2);
    registry.registerNode('Cell/Motor', new Object3D());

    const refs = registry.getReferencesTo('Cell/Motor');
    expect(refs.length).toBe(2);
    const sources = refs.map((r) => r.sourcePath).sort();
    expect(sources).toEqual(['Cell/S1', 'Cell/S2']);
  });

  it('explicit buildReverseRefIndex() still works and is consistent with lazy build', () => {
    const source = makeRefNode('Sensor', 'Sensor', 'Drive', 'Cell/Motor');
    registry.registerNode('Cell/Sensor', source);
    registry.registerNode('Cell/Motor', new Object3D());

    registry.buildReverseRefIndex();
    const refs = registry.getReferencesTo('Cell/Motor');
    expect(refs.length).toBe(1);
    expect(refs[0].sourcePath).toBe('Cell/Sensor');
  });
});

describe('createLoadProfiler', () => {
  it('mark/report do not throw when perf category is inactive', async () => {
    const { createLoadProfiler } = await import('../src/core/engine/rv-load-profiler');
    const prof = createLoadProfiler('test');
    prof.mark('phase-a');
    prof.mark('phase-b');
    expect(() => prof.report()).not.toThrow();
  });
});
