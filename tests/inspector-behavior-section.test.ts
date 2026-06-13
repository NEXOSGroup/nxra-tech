// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import {
  collectBehaviorData,
  buildBehaviorVirtualComponent,
  behaviorDisplayName,
  type BehaviorViewerSnapshot,
} from '../src/core/hmi/inspector-behavior-section';
import { isRuntimeRow, type RuntimeRowSpec } from '../src/core/hmi/rv-component-section';
import { findLayoutRoot, isPlacedLibraryAsset } from '../src/core/hmi/layout-root-utils';

/** Test helper — assert a field is a RuntimeRowSpec and return its display text. */
function rowDisplay(value: unknown): string {
  expect(isRuntimeRow(value)).toBe(true);
  return (value as RuntimeRowSpec).display;
}

function placedRoot(name: string, layoutId: string): Object3D {
  const root = new Object3D();
  root.name = name;
  root.userData._layoutId = layoutId;
  root.userData.realvirtual = { LayoutObject: { Label: name, CatalogId: 'c', Locked: false } };
  return root;
}

function makeViewer(opts: {
  drives?: Array<{ name: string; node: Object3D; jogForward?: boolean; jogBackward?: boolean; currentSpeed?: number }>;
  sensors?: Array<{ node: Object3D; occupied?: boolean }>;
  signals?: Record<string, boolean | number>;
}): BehaviorViewerSnapshot {
  const sigMap = new Map(Object.entries(opts.signals ?? {}));
  return {
    drives: opts.drives ?? [],
    transportManager: opts.sensors ? { sensors: opts.sensors } : null,
    signalStore: { getAll: () => sigMap },
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

// ── plan-200 §9.6: STATES from scoped dot-symbol Flow.* signals ────────────

describe('collectBehaviorData — STATES (Flow.* dot-symbols)', () => {
  it('reads Running / Occupied / Part Count from `${root}.Flow.*`', () => {
    const root = placedRoot('RollConveyor-3m', 'lid-A');
    const data = collectBehaviorData(makeViewer({
      signals: {
        'RollConveyor-3m.Flow.Running': true,
        'RollConveyor-3m.Flow.Occupied': false,
        'RollConveyor-3m.Flow.PartCount': 7,
        'RollConveyor-3m_2.Flow.Running': true,   // different scope — ignored
        'GlobalSignal': true,                      // unscoped — ignored
      },
    }), root);
    expect(data.running).toBe(true);
    expect(data.occupied).toBe(false);
    expect(data.partCount).toBe(7);
  });

  it('leaves states undefined when the scoped signals are absent', () => {
    const root = placedRoot('Conv', 'lid-A');
    const data = collectBehaviorData(makeViewer({ signals: { 'Other.Flow.Running': true } }), root);
    expect(data.running).toBeUndefined();
    expect(data.occupied).toBeUndefined();
    expect(data.partCount).toBeUndefined();
  });
});

// ── HARDWARE: drives + sensors ─────────────────────────────────────────────

describe('collectBehaviorData — HARDWARE drives', () => {
  it('reports live speed + direction for drives at or under root', () => {
    const root = placedRoot('Conv', 'lid-A');
    const belt = new Object3D(); belt.name = 'Transport-Z'; root.add(belt);
    const orphan = new Object3D(); orphan.name = 'Floating';
    const data = collectBehaviorData(makeViewer({
      drives: [
        { name: 'Transport-Z', node: belt, jogForward: true, currentSpeed: 1000 },
        { name: 'Floating', node: orphan, currentSpeed: 500 },
      ],
    }), root);
    expect(data.drives).toEqual([{ name: 'Transport-Z', speed: 1000, direction: 'forward' }]);
  });

  it('reports idle direction + zero speed when a drive is stopped/unknown', () => {
    const root = placedRoot('Conv', 'lid-A');
    const belt = new Object3D(); belt.name = 'Transport-Z'; root.add(belt);
    const data = collectBehaviorData(makeViewer({ drives: [{ name: 'Transport-Z', node: belt }] }), root);
    expect(data.drives).toEqual([{ name: 'Transport-Z', speed: 0, direction: 'idle' }]);
  });
});

describe('collectBehaviorData — HARDWARE sensors', () => {
  it('reports clear/occupied for sensors at or under root', () => {
    const root = placedRoot('Conv', 'lid-A');
    const sensor = new Object3D(); sensor.name = 'Sensor'; root.add(sensor);
    const elsewhere = new Object3D(); elsewhere.name = 'OtherSensor';
    const data = collectBehaviorData(makeViewer({
      sensors: [{ node: sensor, occupied: true }, { node: elsewhere, occupied: true }],
    }), root);
    expect(data.sensors).toEqual([{ name: 'Sensor', occupied: true }]);
  });
});

describe('collectBehaviorData — empty/edge cases', () => {
  it('returns all-empty/undefined when nothing is in scope', () => {
    const root = placedRoot('Conv', 'lid-A');
    const data = collectBehaviorData(makeViewer({}), root);
    expect(data).toEqual({
      running: undefined, occupied: undefined, partCount: undefined,
      drives: [], sensors: [],
    });
  });
});

// ── behaviorDisplayName ────────────────────────────────────────────────────

describe('behaviorDisplayName', () => {
  it('strips the Behavior suffix and space-splits camelCase, uppercased', () => {
    expect(behaviorDisplayName('ConveyorBehavior')).toBe('CONVEYOR');
    expect(behaviorDisplayName('ChainTransferBehavior')).toBe('CHAIN TRANSFER');
    expect(behaviorDisplayName('TurntableBehavior')).toBe('TURNTABLE');
  });

  it('falls back gracefully when there is no Behavior suffix', () => {
    expect(behaviorDisplayName('Conveyor')).toBe('CONVEYOR');
  });
});

// ── buildBehaviorVirtualComponent ──────────────────────────────────────────

describe('buildBehaviorVirtualComponent', () => {
  it('builds a read-only-live virtual component with States + Hardware rows', () => {
    const root = placedRoot('RollConveyor-3m', 'lid-A');
    const belt = new Object3D(); belt.name = 'Transport-Z'; root.add(belt);
    const sensor = new Object3D(); sensor.name = 'EndSensor'; root.add(sensor);

    const vc = buildBehaviorVirtualComponent(makeViewer({
      signals: {
        'RollConveyor-3m.Flow.Running': true,
        'RollConveyor-3m.Flow.Occupied': false,
        'RollConveyor-3m.Flow.PartCount': 3,
      },
      drives: [{ name: 'Transport-Z', node: belt, jogForward: true, currentSpeed: 1200 }],
      sensors: [{ node: sensor, occupied: true }],
    }), root, 'ConveyorBehavior');

    expect(vc).not.toBeNull();
    expect(vc!.type).toBe('CONVEYOR');
    expect(rowDisplay(vc!.data['Running'])).toBe('true');
    expect(rowDisplay(vc!.data['Occupied'])).toBe('false');
    expect(rowDisplay(vc!.data['Part Count'])).toBe('3');
    // Drive: forward arrow + speed; sensor: occupied.
    expect(rowDisplay(vc!.data['Transport-Z'])).toContain('1200 mm/s');
    expect(rowDisplay(vc!.data['Transport-Z'])).toContain('►');
    expect(rowDisplay(vc!.data['EndSensor'])).toBe('Occupied');
  });

  it('returns null when the root is not a placed library asset', () => {
    const bare = new Object3D(); bare.name = 'Plain';
    const vc = buildBehaviorVirtualComponent(makeViewer({
      signals: { 'Plain.Flow.Running': true },
    }), bare, 'ConveyorBehavior');
    expect(vc).toBeNull();
  });

  it('returns null when there is no live data at all', () => {
    const root = placedRoot('Empty', 'lid-A');
    const vc = buildBehaviorVirtualComponent(makeViewer({}), root, 'ConveyorBehavior');
    expect(vc).toBeNull();
  });
});
