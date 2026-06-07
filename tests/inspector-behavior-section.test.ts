// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { collectBehaviorData, type BehaviorViewerSnapshot } from '../src/core/hmi/inspector-behavior-section';
import { findLayoutRoot, isPlacedLibraryAsset } from '../src/core/hmi/layout-root-utils';

function placedRoot(name: string, layoutId: string): Object3D {
  const root = new Object3D();
  root.name = name;
  root.userData._layoutId = layoutId;
  root.userData.realvirtual = { LayoutObject: { Label: name, CatalogId: 'c', Locked: false } };
  return root;
}

function makeViewer(opts: {
  drives?: Array<{ name: string; node: Object3D }>;
  sensors?: Array<{ node: Object3D }>;
  signals?: Record<string, boolean | number>;
  snapsByOwner?: Map<Object3D, readonly { id: string; flow: 'in' | 'out' | 'bidi'; pairedSnapId?: string }[]>;
}): BehaviorViewerSnapshot {
  const sigMap = new Map(Object.entries(opts.signals ?? {}));
  return {
    drives: opts.drives ?? [],
    transportManager: opts.sensors ? { sensors: opts.sensors } : null,
    signalStore: { getAll: () => sigMap },
    getPlugin: opts.snapsByOwner
      ? <T,>(id: string) => (id === 'snap-point'
          ? ({ getRegistry: () => ({ getByOwnerRoot: (r: Object3D) => opts.snapsByOwner!.get(r) ?? [] }) } as unknown as T)
          : undefined)
      : undefined,
  };
}

describe('layout-root-utils', () => {
  it('isPlacedLibraryAsset requires _layoutId AND realvirtual.LayoutObject', () => {
    const a = placedRoot('A', 'lid-A');
    expect(isPlacedLibraryAsset(a)).toBe(true);

    const justId = new Object3D(); justId.userData._layoutId = 'x';
    expect(isPlacedLibraryAsset(justId)).toBe(false);   // missing LayoutObject

    const justMarker = new Object3D();
    justMarker.userData.realvirtual = { LayoutObject: {} };
    expect(isPlacedLibraryAsset(justMarker)).toBe(false);   // missing _layoutId

    const ghost = placedRoot('G', 'lid-G');
    ghost.userData._isGhost = true;
    expect(isPlacedLibraryAsset(ghost)).toBe(false);   // ghost
  });

  it('findLayoutRoot walks up from any descendant', () => {
    const root = placedRoot('A', 'lid-A');
    const belt = new Object3D(); belt.name = 'Transport-Z'; root.add(belt);
    const inner = new Object3D(); belt.add(inner);
    expect(findLayoutRoot(inner)).toBe(root);
    expect(findLayoutRoot(belt)).toBe(root);
    expect(findLayoutRoot(root)).toBe(root);
  });

  it('findLayoutRoot returns null when no LayoutObject ancestor exists', () => {
    const isolated = new Object3D();
    expect(findLayoutRoot(isolated)).toBeNull();
  });
});

describe('collectBehaviorData — signals scoping', () => {
  it('attaches only signals whose name starts with `${root.name}/`', () => {
    const root = placedRoot('RollConveyor-3m', 'lid-A');
    const data = collectBehaviorData(makeViewer({
      signals: {
        'RollConveyor-3m/Conveyor.Run': true,
        'RollConveyor-3m/Conveyor.Occupied': false,
        'RollConveyor-3m/Sensor': true,
        'RollConveyor-3m_2/Sensor': false,    // different scope — excluded
        'GlobalSignal': true,                 // unscoped — excluded
      },
    }), root);
    expect(data.signalNames.sort()).toEqual([
      'RollConveyor-3m/Conveyor.Occupied',
      'RollConveyor-3m/Conveyor.Run',
      'RollConveyor-3m/Sensor',
    ]);
  });
});

describe('collectBehaviorData — subtree drives + sensors', () => {
  it('only includes drives whose node is at or under root', () => {
    const root = placedRoot('Conv', 'lid-A');
    const belt = new Object3D(); belt.name = 'Transport-Z'; root.add(belt);
    const orphan = new Object3D(); orphan.name = 'Floating';
    const data = collectBehaviorData(makeViewer({
      drives: [{ name: 'Transport-Z', node: belt }, { name: 'Floating', node: orphan }],
    }), root);
    expect(data.driveNames).toEqual(['Transport-Z']);
  });

  it('only includes sensors whose node is at or under root', () => {
    const root = placedRoot('Conv', 'lid-A');
    const sensor = new Object3D(); sensor.name = 'Sensor'; root.add(sensor);
    const elsewhere = new Object3D(); elsewhere.name = 'OtherSensor';
    const data = collectBehaviorData(makeViewer({
      sensors: [{ node: sensor }, { node: elsewhere }],
    }), root);
    expect(data.sensorNames).toEqual(['Sensor']);
  });
});

describe('collectBehaviorData — snap points', () => {
  it('reports per-snap flow + paired status from the snap registry', () => {
    const root = placedRoot('Conv', 'lid-A');
    const snapsByOwner = new Map<Object3D, readonly { id: string; flow: 'in' | 'out' | 'bidi'; pairedSnapId?: string }[]>();
    snapsByOwner.set(root, [
      { id: 's1', flow: 'out', pairedSnapId: 'p1' },
      { id: 's2', flow: 'in' },                       // free
    ]);
    const data = collectBehaviorData(makeViewer({ snapsByOwner }), root);
    expect(data.snaps).toEqual([
      { id: 's1', flow: 'out', paired: true },
      { id: 's2', flow: 'in',  paired: false },
    ]);
  });

  it('returns no snaps when the snap-point plugin is absent', () => {
    const root = placedRoot('Conv', 'lid-A');
    const data = collectBehaviorData(makeViewer({}), root);
    expect(data.snaps).toEqual([]);
  });
});

describe('collectBehaviorData — empty/edge cases', () => {
  it('returns all-empty arrays when nothing is in scope', () => {
    const root = placedRoot('Conv', 'lid-A');
    const data = collectBehaviorData(makeViewer({}), root);
    expect(data).toEqual({ signalNames: [], driveNames: [], sensorNames: [], snaps: [] });
  });
});
