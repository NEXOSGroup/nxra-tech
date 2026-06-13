// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import {
  buildTree,
  computeAncestors,
  countNodes,
  filterTree,
  flattenTree,
  matchesTypeFilter,
  sortSignalNodes,
  splitTypes,
  isSignalType,
  isBoolSignal,
  isLogicStepType,
  shortStepType,
  badgeLabel,
  badgeColor,
  signalBadgeColor,
  formatSignalValue,
  formatContainerProgress,
  snapLabel,
  signalOwnerLabel,
  type TreeNode,
} from '../src/core/hmi/hierarchy-utils';
import { StepState } from '../src/core/engine/rv-logic-step';
import { STEP_STATE_COLORS } from '../src/core/hmi/rv-logic-step-colors';
import type { EditableNodeInfo } from '../src/core/hmi/rv-extras-editor';
import type { RVExtrasOverlay } from '../src/core/engine/rv-extras-overlay-store';
import type { SignalStore } from '../src/core/engine/rv-signal-store';
import type { StepStateInfo } from '../src/core/engine/rv-logic-engine';

function info(path: string, types: string[] = []): EditableNodeInfo {
  return { path, types } as EditableNodeInfo;
}

// ── buildTree ──────────────────────────────────────────────────────────────

describe('buildTree', () => {
  it('returns empty array on empty input', () => {
    expect(buildTree([], null)).toEqual([]);
  });

  it('builds nested tree from path strings', () => {
    const tree = buildTree([
      info('Robot/Base'),
      info('Robot/Arm/Joint1'),
      info('Robot/Arm/Joint2'),
    ], null);
    // The wrapper-flatten rule strips a single typeless root child
    // ('Robot' has children but no types — flattening unwraps it).
    // So the top-level becomes [Base, Arm] not [Robot].
    expect(tree.map(n => n.name)).toEqual(['Base', 'Arm']);
    const arm = tree.find(n => n.name === 'Arm')!;
    expect(arm.children.map(c => c.name)).toEqual(['Joint1', 'Joint2']);
  });

  it('keeps a single typed root node (does not flatten if it has types)', () => {
    const tree = buildTree([
      info('Top', ['Drive']),
      info('Top/Child'),
    ], null);
    expect(tree.length).toBe(1);
    expect(tree[0].name).toBe('Top');
    expect(tree[0].types).toEqual(['Drive']);
  });

  it('flattens GLB wrapper: single typeless root with children', () => {
    const tree = buildTree([
      info('Wrapper/A', ['Drive']),
      info('Wrapper/B', ['Sensor']),
    ], null);
    // 'Wrapper' has no types and a single child — flattened away
    expect(tree.map(n => n.name)).toEqual(['A', 'B']);
  });

  it('marks hasOverrides when overlay covers a path', () => {
    const overlay = { nodes: { 'Foo/Bar': {} } } as unknown as RVExtrasOverlay;
    const tree = buildTree([
      info('Foo/Bar', ['Drive']),
      info('Foo/Baz', ['Sensor']),
    ], overlay);
    const bar = tree.find(n => n.name === 'Bar')!;
    const baz = tree.find(n => n.name === 'Baz')!;
    expect(bar.hasOverrides).toBe(true);
    expect(baz.hasOverrides).toBe(false);
  });

  it('preserves insertion order of siblings', () => {
    const tree = buildTree([
      info('Root/Z'),
      info('Root/A'),
      info('Root/M'),
    ], null);
    expect(tree.map(n => n.name)).toEqual(['Z', 'A', 'M']);
  });

  it('handles deeply nested paths (single-child typeless wrappers are flattened)', () => {
    // Inserting a single leaf "A/B/C/D/E/F" produces a chain of single-child typeless
    // wrappers — the wrapper-flatten rule unwraps them all and the result is just [F].
    const tree = buildTree([
      info('A/B/C/D/E/F', ['Drive']),
    ], null);
    expect(tree.length).toBe(1);
    expect(tree[0].name).toBe('F');
    expect(tree[0].types).toEqual(['Drive']);
  });

  it('preserves intermediate typeless nodes when they have multiple children', () => {
    const tree = buildTree([
      info('A/B/C/leaf1', ['Drive']),
      info('A/B/C/leaf2', ['Sensor']),
    ], null);
    // A, B, C are typeless single-child wrappers but C has 2 children, so flattening
    // stops at the multi-child level. Result top-level is [leaf1, leaf2].
    expect(tree.map(n => n.name)).toEqual(['leaf1', 'leaf2']);
  });

  it('LayoutObject lazy-inject: a nested Drive node with Three.js descendants shows an expand caret', () => {
    // Reproduces the turntable bug: Drive-Rot-Y (under a LayoutObject) had
    // Three.js children (Transport-Z, Snap-*, ...) but no canExpandLazy flag,
    // so the user couldn't open it to see them.
    const turntableRoot = new Object3D(); turntableRoot.name = 'Turntable';
    turntableRoot.userData.realvirtual = { LayoutObject: {}, } as Record<string, unknown>;
    const driveNode = new Object3D(); driveNode.name = 'Drive-Rot-Y';
    driveNode.userData.realvirtual = { Drive: {} } as Record<string, unknown>;
    turntableRoot.add(driveNode);
    const transport = new Object3D(); transport.name = 'Transport-Z'; driveNode.add(transport);
    const snap = new Object3D(); snap.name = 'Snap-ZP-x'; driveNode.add(snap);

    const mockViewer = {
      registry: {
        getNode: (path: string) => path === 'Turntable' ? turntableRoot : null,
        registerNode: () => { /* no-op for the test */ },
      },
    } as unknown as Parameters<typeof buildTree>[2];

    const tree = buildTree(
      [info('Turntable', ['LayoutObject'])],
      null,
      mockViewer,
      new Set(['Turntable']),   // LayoutObject expanded, Drive-Rot-Y NOT expanded
    );

    expect(tree).toHaveLength(1);
    const tt = tree[0];
    expect(tt.name).toBe('Turntable');
    const drive = tt.children.find(c => c.name === 'Drive-Rot-Y');
    expect(drive).toBeDefined();
    expect(drive!.children).toEqual([]);                 // not yet injected
    expect(drive!.canExpandLazy).toBe(true);             // but a caret should show
  });

  it('LayoutObject lazy-inject: a leaf Three.js child without descendants stays non-expandable', () => {
    const root = new Object3D(); root.name = 'Asset';
    root.userData.realvirtual = { LayoutObject: {} } as Record<string, unknown>;
    const leaf = new Object3D(); leaf.name = 'Plain'; root.add(leaf);    // no own children
    const mockViewer = {
      registry: { getNode: (path: string) => path === 'Asset' ? root : null, registerNode: () => {} },
    } as unknown as Parameters<typeof buildTree>[2];
    const tree = buildTree([info('Asset', ['LayoutObject'])], null, mockViewer, new Set(['Asset']));
    const plain = tree[0].children.find(c => c.name === 'Plain')!;
    expect(plain.canExpandLazy).toBeUndefined();
  });

  // ── plan-200 §9.4: snap marker skip + readable snap label ──────────────
  it('does NOT inject the _rvGizmo snap-marker sprite as a hierarchy child (A1)', () => {
    const root = new Object3D(); root.name = 'Conv';
    root.userData.realvirtual = { LayoutObject: {} } as Record<string, unknown>;
    const snap = new Object3D(); snap.name = 'Snap-ZN-convroll'; root.add(snap);
    // The marker sprite is parented to the snap Empty (attachToNode) and tagged.
    const marker = new Object3D(); marker.userData._rvGizmo = true; snap.add(marker);

    const mockViewer = {
      registry: { getNode: (p: string) => (p === 'Conv' ? root : null), registerNode: () => {} },
    } as unknown as Parameters<typeof buildTree>[2];

    // Expand both the LayoutObject and the snap Empty so injection would reach
    // the marker if it weren't skipped.
    const tree = buildTree([info('Conv', ['LayoutObject'])], null, mockViewer, new Set(['Conv', 'Conv/Snap-ZN-convroll']));
    const snapNode = tree[0].children.find(c => c.path === 'Conv/Snap-ZN-convroll');
    expect(snapNode).toBeDefined();
    // The UUID-marker node must NOT appear under the snap.
    expect(snapNode!.children).toEqual([]);
    expect(snapNode!.canExpandLazy).toBeUndefined();
  });

  it('gives a snap Empty a readable label, keeping the real path (A2)', () => {
    const root = new Object3D(); root.name = 'Conv';
    root.userData.realvirtual = { LayoutObject: {} } as Record<string, unknown>;
    const snap = new Object3D(); snap.name = 'Snap-ZN-convroll'; root.add(snap);
    const mockViewer = {
      registry: { getNode: (p: string) => (p === 'Conv' ? root : null), registerNode: () => {} },
    } as unknown as Parameters<typeof buildTree>[2];
    const tree = buildTree([info('Conv', ['LayoutObject'])], null, mockViewer, new Set(['Conv']));
    const snapNode = tree[0].children.find(c => c.path === 'Conv/Snap-ZN-convroll')!;
    expect(snapNode.name).toBe('Snap in (Z) · convroll');     // readable label
    expect(snapNode.path).toBe('Conv/Snap-ZN-convroll');      // real path unchanged
  });
});

// ── snapLabel ────────────────────────────────────────────────────────────

describe('snapLabel (plan-200 A2)', () => {
  it('maps the sign letter to flow and keeps axis + typeId', () => {
    expect(snapLabel('Snap-ZN-convroll')).toBe('Snap in (Z) · convroll');
    expect(snapLabel('Snap-ZP-convroll')).toBe('Snap out (Z) · convroll');
    expect(snapLabel('Snap-XB-flange-1')).toBe('Snap bidi (X) · flange-1');
  });

  it('returns null for a non-snap node name', () => {
    expect(snapLabel('Transport-Z')).toBeNull();
    expect(snapLabel('')).toBeNull();
  });
});

// ── signalOwnerLabel ───────────────────────────────────────────────────────

describe('signalOwnerLabel (plan-200 §9.2 / B1)', () => {
  it('builds the dot-symbol Owner.Leaf from a scoped signal node path', () => {
    expect(signalOwnerLabel('RollConveyor-1m/Signals/Flow.Occupied')).toBe('RollConveyor-1m.Flow.Occupied');
    expect(signalOwnerLabel('Turntable_2/Signals/Flow.Run')).toBe('Turntable_2.Flow.Run');
  });

  it('falls back to the bare leaf for a non-Signals path', () => {
    expect(signalOwnerLabel('Robot/Arm/Joint1')).toBe('Joint1');
    expect(signalOwnerLabel('Standalone')).toBe('Standalone');
  });
});

// ── flattenTree ────────────────────────────────────────────────────────────

describe('flattenTree', () => {
  it('returns empty array for empty tree', () => {
    expect(flattenTree([])).toEqual([]);
  });

  it('preserves DFS order with correct depths', () => {
    const t: TreeNode[] = [
      {
        name: 'A', path: 'A', types: [], hasOverrides: false,
        children: [
          { name: 'A1', path: 'A/A1', types: [], hasOverrides: false, children: [
            { name: 'A1a', path: 'A/A1/A1a', types: [], hasOverrides: false, children: [] },
          ] },
          { name: 'A2', path: 'A/A2', types: [], hasOverrides: false, children: [] },
        ],
      },
      { name: 'B', path: 'B', types: [], hasOverrides: false, children: [] },
    ];
    const flat = flattenTree(t);
    expect(flat.map(x => x.node.name)).toEqual(['A', 'A1', 'A1a', 'A2', 'B']);
    expect(flat.map(x => x.depth)).toEqual([0, 1, 2, 1, 0]);
  });
});

// ── matchesTypeFilter ──────────────────────────────────────────────────────

describe('matchesTypeFilter', () => {
  it('"all" matches everything', () => {
    expect(matchesTypeFilter([], 'all')).toBe(true);
    expect(matchesTypeFilter(['Drive'], 'all')).toBe(true);
    expect(matchesTypeFilter(['Anything'], 'all')).toBe(true);
  });

  it('"drives" matches Drive and Drive_* but not Sensor', () => {
    expect(matchesTypeFilter(['Drive'], 'drives')).toBe(true);
    expect(matchesTypeFilter(['Drive_Linear'], 'drives')).toBe(true);
    expect(matchesTypeFilter(['Sensor'], 'drives')).toBe(false);
  });

  it('"sensors" matches Sensor and WebSensor only', () => {
    expect(matchesTypeFilter(['Sensor'], 'sensors')).toBe(true);
    expect(matchesTypeFilter(['WebSensor'], 'sensors')).toBe(true);
    expect(matchesTypeFilter(['Sensor_Special'], 'sensors')).toBe(false);
    expect(matchesTypeFilter(['Drive'], 'sensors')).toBe(false);
  });

  it('"signals" matches PLCInput* and PLCOutput*', () => {
    expect(matchesTypeFilter(['PLCInputBool'], 'signals')).toBe(true);
    expect(matchesTypeFilter(['PLCOutputFloat'], 'signals')).toBe(true);
    expect(matchesTypeFilter(['Drive'], 'signals')).toBe(false);
  });

  it('"logic" matches LogicStep_*', () => {
    expect(matchesTypeFilter(['LogicStep_Delay'], 'logic')).toBe(true);
    expect(matchesTypeFilter(['LogicStep_SerialContainer'], 'logic')).toBe(true);
    expect(matchesTypeFilter(['LogicSteppy'], 'logic')).toBe(false);
    expect(matchesTypeFilter(['Drive'], 'logic')).toBe(false);
  });

  it('empty types array does not match specific filters', () => {
    expect(matchesTypeFilter([], 'drives')).toBe(false);
    expect(matchesTypeFilter([], 'sensors')).toBe(false);
    expect(matchesTypeFilter([], 'signals')).toBe(false);
    expect(matchesTypeFilter([], 'logic')).toBe(false);
  });
});

// ── sortSignalNodes ────────────────────────────────────────────────────────

describe('sortSignalNodes', () => {
  it('"name" sorts alphabetically (case-insensitive) by leaf name', () => {
    const nodes = [
      info('R/zebra', ['PLCInputBool']),
      info('R/Alpha', ['PLCOutputBool']),
      info('R/middle', ['PLCInputBool']),
    ];
    const sorted = sortSignalNodes(nodes, 'name');
    expect(sorted.map(n => n.path.split('/').pop())).toEqual(['Alpha', 'middle', 'zebra']);
  });

  it('"type" groups outputs before inputs, then alphabetical', () => {
    const nodes = [
      info('R/inA', ['PLCInputBool']),
      info('R/outZ', ['PLCOutputFloat']),
      info('R/inZ', ['PLCInputBool']),
      info('R/outA', ['PLCOutputFloat']),
    ];
    const sorted = sortSignalNodes(nodes, 'type');
    const names = sorted.map(n => n.path.split('/').pop());
    // Outputs first (sorted), then inputs (sorted)
    expect(names).toEqual(['outA', 'outZ', 'inA', 'inZ']);
  });

  it('does not mutate the input array', () => {
    const nodes = [info('Z'), info('A'), info('M')];
    const before = nodes.map(n => n.path);
    sortSignalNodes(nodes, 'name');
    expect(nodes.map(n => n.path)).toEqual(before);
  });

  it('handles empty array', () => {
    expect(sortSignalNodes([], 'name')).toEqual([]);
    expect(sortSignalNodes([], 'type')).toEqual([]);
  });
});

// ── filterTree ─────────────────────────────────────────────────────────────

describe('filterTree', () => {
  function mkTree(): TreeNode[] {
    return [
      {
        name: 'Robot', path: 'Robot', types: [], hasOverrides: false,
        children: [
          { name: 'Arm', path: 'Robot/Arm', types: [], hasOverrides: false, children: [
            { name: 'Joint1', path: 'Robot/Arm/Joint1', types: ['Drive'], hasOverrides: false, children: [] },
            { name: 'Joint2', path: 'Robot/Arm/Joint2', types: ['Drive'], hasOverrides: false, children: [] },
          ] },
          { name: 'Gripper', path: 'Robot/Gripper', types: ['Sensor'], hasOverrides: false, children: [] },
        ],
      },
    ];
  }

  it('returns full tree on empty term', () => {
    const t = mkTree();
    expect(filterTree(t, '')).toEqual(t);
  });

  it('keeps only matching leaf and its ancestors', () => {
    const filtered = filterTree(mkTree(), 'Joint1');
    expect(filtered[0].name).toBe('Robot');
    expect(filtered[0].children[0].name).toBe('Arm');
    expect(filtered[0].children[0].children.length).toBe(1);
    expect(filtered[0].children[0].children[0].name).toBe('Joint1');
  });

  it('returns empty when no matches', () => {
    expect(filterTree(mkTree(), 'totallyMissing')).toEqual([]);
  });

  it('matches case-insensitively', () => {
    expect(filterTree(mkTree(), 'gripper').length).toBe(1);
    expect(filterTree(mkTree(), 'GRIPPER').length).toBe(1);
  });
});

// ── countNodes ─────────────────────────────────────────────────────────────

describe('countNodes', () => {
  it('counts total and overrides', () => {
    const overlay = { nodes: { 'A': {}, 'B': {} } } as unknown as RVExtrasOverlay;
    const nodes = [info('A'), info('B'), info('C')];
    expect(countNodes(nodes, overlay)).toEqual({ total: 3, withOverrides: 2 });
  });

  it('reports zero overrides on null overlay', () => {
    expect(countNodes([info('A')], null)).toEqual({ total: 1, withOverrides: 0 });
  });
});

// ── computeAncestors ───────────────────────────────────────────────────────

describe('computeAncestors', () => {
  it('returns prefixes for A/B/C/D', () => {
    expect(computeAncestors('A/B/C/D')).toEqual(['A', 'A/B', 'A/B/C']);
  });

  it('returns empty for top-level path', () => {
    expect(computeAncestors('Root')).toEqual([]);
  });

  it('returns single ancestor for two-segment path', () => {
    expect(computeAncestors('A/B')).toEqual(['A']);
  });
});

// ── splitTypes ─────────────────────────────────────────────────────────────

describe('splitTypes', () => {
  it('separates signals from non-signals', () => {
    const [nonSignals, signals] = splitTypes(['Drive', 'PLCInputBool', 'Sensor', 'PLCOutputFloat']);
    expect(nonSignals).toEqual(['Drive', 'Sensor']);
    expect(signals).toEqual(['PLCInputBool', 'PLCOutputFloat']);
  });

  it('handles empty array', () => {
    const [n, s] = splitTypes([]);
    expect(n).toEqual([]);
    expect(s).toEqual([]);
  });

  it('handles only-signals input', () => {
    const [n, s] = splitTypes(['PLCInputBool', 'PLCOutputBool']);
    expect(n).toEqual([]);
    expect(s).toEqual(['PLCInputBool', 'PLCOutputBool']);
  });
});

// ── signal type predicates ────────────────────────────────────────────────

describe('signal predicates', () => {
  it('isSignalType', () => {
    expect(isSignalType('PLCInputBool')).toBe(true);
    expect(isSignalType('PLCOutputFloat')).toBe(true);
    expect(isSignalType('Drive')).toBe(false);
    expect(isSignalType('Sensor')).toBe(false);
  });

  it('isBoolSignal', () => {
    expect(isBoolSignal('PLCInputBool')).toBe(true);
    expect(isBoolSignal('PLCOutputBool')).toBe(true);
    expect(isBoolSignal('PLCInputFloat')).toBe(false);
  });

  it('isLogicStepType', () => {
    expect(isLogicStepType('LogicStep_Delay')).toBe(true);
    expect(isLogicStepType('LogicStep_SerialContainer')).toBe(true);
    expect(isLogicStepType('Drive')).toBe(false);
    expect(isLogicStepType('LogicSteppy')).toBe(false);
  });
});

// ── shortStepType ──────────────────────────────────────────────────────────

describe('shortStepType', () => {
  it('shortens known container types', () => {
    expect(shortStepType('LogicStep_SerialContainer')).toBe('Serial');
    expect(shortStepType('LogicStep_ParallelContainer')).toBe('Parallel');
  });

  it('shortens known leaf types', () => {
    expect(shortStepType('LogicStep_SetSignalBool')).toBe('SetBool');
    expect(shortStepType('LogicStep_WaitForSignalBool')).toBe('WaitBool');
    expect(shortStepType('LogicStep_WaitForSensor')).toBe('WaitSens');
    expect(shortStepType('LogicStep_DriveTo')).toBe('DriveTo');
    expect(shortStepType('LogicStep_DriveToPosition')).toBe('DriveTo');
    expect(shortStepType('LogicStep_SetDriveSpeed')).toBe('SetSpd');
    expect(shortStepType('LogicStep_Enable')).toBe('Enable');
    expect(shortStepType('LogicStep_Delay')).toBe('Delay');
    expect(shortStepType('LogicStep_Pause')).toBe('Pause');
  });

  it('falls back to stripped raw type for unknown LogicStep', () => {
    expect(shortStepType('LogicStep_CustomNew')).toBe('CustomNew');
  });
});

// ── badgeLabel ─────────────────────────────────────────────────────────────

describe('badgeLabel', () => {
  it('formats PLC signal types compactly', () => {
    expect(badgeLabel('PLCInputBool')).toBe('InBool');
    expect(badgeLabel('PLCOutputBool')).toBe('OutBool');
    expect(badgeLabel('PLCInputFloat')).toBe('InFloat');
    expect(badgeLabel('PLCOutputInt')).toBe('OutInt');
  });

  it('handles unknown PLC suffixes via prefix', () => {
    expect(badgeLabel('PLCInputCustom')).toBe('In:Custom');
    expect(badgeLabel('PLCOutputWeird')).toBe('Out:Weird');
  });

  it('handles Drive_* subtypes', () => {
    expect(badgeLabel('Drive_Linear')).toBe('D:Linear');
  });

  it('shows step state suffix for Active/Waiting', () => {
    // STEP_STATE_LABELS uses short labels: RUN / WAIT (max 4 chars)
    expect(badgeLabel('LogicStep_Delay', StepState.Active)).toContain('Delay');
    expect(badgeLabel('LogicStep_Delay', StepState.Active)).toContain('RUN');
    expect(badgeLabel('LogicStep_Delay', StepState.Waiting)).toContain('WAIT');
  });

  it('does not append state suffix for Idle/Finished', () => {
    expect(badgeLabel('LogicStep_Delay', StepState.Idle)).toBe('Delay');
    expect(badgeLabel('LogicStep_Delay', StepState.Finished)).toBe('Delay');
  });

  it('handles named special components', () => {
    expect(badgeLabel('RuntimeMetadata')).toBe('Metadata');
    expect(badgeLabel('ConnectSignal')).toBe('Conn');
    expect(badgeLabel('TransportSurface')).toBe('TS');
    expect(badgeLabel('DrivesRecorder')).toBe('Rec');
    expect(badgeLabel('ReplayRecording')).toBe('Replay');
  });
});

// ── badgeColor ─────────────────────────────────────────────────────────────

describe('badgeColor', () => {
  it('uses step state color for Active LogicStep', () => {
    expect(badgeColor('LogicStep_Delay', StepState.Active)).toBe(STEP_STATE_COLORS[StepState.Active]);
    expect(badgeColor('LogicStep_Delay', StepState.Waiting)).toBe(STEP_STATE_COLORS[StepState.Waiting]);
  });

  it('uses componentColor for non-Active/Waiting LogicStep', () => {
    // Color comes from componentColor() — we only verify it does NOT equal the active-state color
    const idleColor = badgeColor('LogicStep_Delay', StepState.Idle);
    expect(idleColor).not.toBe(STEP_STATE_COLORS[StepState.Active]);
    expect(idleColor).not.toBe(STEP_STATE_COLORS[StepState.Waiting]);
  });

  it('uses componentColor for non-LogicStep types regardless of stepState', () => {
    const a = badgeColor('Drive', StepState.Active);
    const b = badgeColor('Drive');
    expect(a).toBe(b);
  });
});

// ── formatSignalValue ──────────────────────────────────────────────────────

describe('formatSignalValue', () => {
  function mockStore(values: Record<string, boolean | number | undefined>): SignalStore {
    // Includes get() for the value resolver's path→name fallback.
    return {
      getByPath: (p: string) => values[p],
      get: (n: string) => values[n],
    } as unknown as SignalStore;
  }

  it('returns em-dash when no store or no path', () => {
    expect(formatSignalValue('PLCInputBool', null, 'X')).toBe('—');
    expect(formatSignalValue('PLCInputBool', mockStore({}), null)).toBe('—');
  });

  it('returns em-dash when value undefined', () => {
    expect(formatSignalValue('PLCInputBool', mockStore({ 'X': undefined }), 'X')).toBe('—');
  });

  it('renders bool as filled/hollow circle glyph', () => {
    expect(formatSignalValue('PLCInputBool', mockStore({ 'X': true }), 'X')).toBe('●');
    expect(formatSignalValue('PLCInputBool', mockStore({ 'X': false }), 'X')).toBe('○');
  });

  it('truncates Int numeric values', () => {
    expect(formatSignalValue('PLCInputInt', mockStore({ 'X': 3.7 }), 'X')).toBe('3');
    expect(formatSignalValue('PLCInputInt', mockStore({ 'X': -2.9 }), 'X')).toBe('-2');
  });

  it('formats Float numeric values to one decimal', () => {
    expect(formatSignalValue('PLCInputFloat', mockStore({ 'X': 1.234 }), 'X')).toBe('1.2');
    expect(formatSignalValue('PLCInputFloat', mockStore({ 'X': 0 }), 'X')).toBe('0.0');
  });
});

// ── signalBadgeColor ───────────────────────────────────────────────────────

describe('signalBadgeColor', () => {
  function mockStore(values: Record<string, boolean | number | undefined>): SignalStore {
    return { getByPath: (p: string) => values[p] } as unknown as SignalStore;
  }

  it('green for true PLCOutput bool, red for true PLCInput bool', () => {
    expect(signalBadgeColor('PLCOutputBool', mockStore({ 'X': true }), 'X')).toBe('#66bb6a');
    expect(signalBadgeColor('PLCInputBool', mockStore({ 'X': true }), 'X')).toBe('#ef5350');
  });

  it('grey for false bool', () => {
    expect(signalBadgeColor('PLCOutputBool', mockStore({ 'X': false }), 'X')).toBe('#808080');
    expect(signalBadgeColor('PLCInputBool', mockStore({ 'X': false }), 'X')).toBe('#808080');
  });

  it('falls back to componentColor when value undefined', () => {
    const c1 = signalBadgeColor('PLCInputBool', mockStore({}), 'X');
    const c2 = signalBadgeColor('PLCInputBool', null, 'X');
    // Both fall back to componentColor() of the same type — should be equal
    expect(c1).toBe(c2);
  });
});

// ── formatContainerProgress ────────────────────────────────────────────────

describe('formatContainerProgress', () => {
  it('formats Delay progress when Active with elapsed+duration', () => {
    const info: StepStateInfo = {
      state: StepState.Active,
      name: 'd',
      type: 'Delay',
      progress: 50,
      elapsed: 1.234,
      duration: 3,
    } as StepStateInfo;
    expect(formatContainerProgress(info)).toBe('1.2s/3.0s');
  });

  it('returns null for non-Delay types', () => {
    const info: StepStateInfo = {
      state: StepState.Active,
      name: 'c',
      type: 'SerialContainer',
      progress: 50,
    } as StepStateInfo;
    expect(formatContainerProgress(info)).toBeNull();
  });

  it('returns null when Delay but not Active', () => {
    const info: StepStateInfo = {
      state: StepState.Idle,
      name: 'd',
      type: 'Delay',
      progress: 0,
      elapsed: 1,
      duration: 3,
    } as StepStateInfo;
    expect(formatContainerProgress(info)).toBeNull();
  });

  it('returns null when elapsed or duration missing', () => {
    const info: StepStateInfo = {
      state: StepState.Active,
      name: 'd',
      type: 'Delay',
      progress: 50,
    } as StepStateInfo;
    expect(formatContainerProgress(info)).toBeNull();
  });
});
