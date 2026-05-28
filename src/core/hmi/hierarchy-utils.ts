// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Pure utilities for the Hierarchy Browser.
 *
 * Extracted from `rv-hierarchy-browser.tsx` (plan-177 Phase 5) — these functions
 * have no React dependencies and are unit-testable in isolation.
 *
 * Categories:
 * - Tree building / filtering / counting (buildTree, filterTree, countNodes)
 * - Type filter predicate (matchesTypeFilter)
 * - Signal-sort comparator (sortSignalNodes)
 * - Ancestor path computation (computeAncestors)
 * - Badge utilities (splitTypes, isSignalType, isBoolSignal, isLogicStepType,
 *   shortStepType, badgeColor, badgeLabel, formatSignalValue, signalBadgeColor,
 *   formatContainerProgress, getStepInfoForPath)
 */

import type { RVViewer } from '../rv-viewer';
import type { EditableNodeInfo } from './rv-extras-editor';
import type { RVExtrasOverlay } from '../engine/rv-extras-overlay-store';
import type { SignalStore } from '../engine/rv-signal-store';
import type { RVLogicEngine, StepStateInfo } from '../engine/rv-logic-engine';
import { StepState } from '../engine/rv-logic-step';
import { extractComponentTypes } from './rv-inspector-helpers';
import { STEP_STATE_COLORS, STEP_STATE_LABELS } from './rv-logic-step-colors';
import { componentColor } from './rv-inspector-helpers';
import { readSignalValue, formatValue } from './rv-value-resolver';
import { getDisplayName } from '../engine/rv-component-registry';
import { tooltipRegistry } from './tooltip/tooltip-registry';

// ─── Tree data structure ─────────────────────────────────────────────────

export interface TreeNode {
  name: string;
  path: string | null;
  types: string[];
  hasOverrides: boolean;
  children: TreeNode[];
  /** LayoutObjects can hold uninjected Three.js descendants. Set so the row
   *  renders an expand caret even before children are lazily injected. */
  canExpandLazy?: boolean;
}

/** Internal tree node augmented with a child lookup map for O(1) insertion. */
interface BuildTreeNode extends TreeNode {
  _childMap?: Map<string, BuildTreeNode>;
}

// ─── Type filter ─────────────────────────────────────────────────────────

export type TypeFilter = 'all' | 'drives' | 'sensors' | 'signals' | 'logic';

export function matchesTypeFilter(types: string[], filter: TypeFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'drives') return types.some(t => t === 'Drive' || t.startsWith('Drive_'));
  if (filter === 'sensors') return types.some(t => t === 'Sensor' || t === 'WebSensor');
  if (filter === 'signals') return types.some(t => t.startsWith('PLCInput') || t.startsWith('PLCOutput'));
  if (filter === 'logic') return types.some(t => t.startsWith('LogicStep_'));
  return true;
}

// ─── Signal sort ─────────────────────────────────────────────────────────

export type SignalSort = 'name' | 'type';

/** Sort signal nodes: 'name' = alphabetical by leaf name, 'type' = group by Out/In then alphabetical. */
export function sortSignalNodes(nodes: EditableNodeInfo[], sort: SignalSort): EditableNodeInfo[] {
  const sorted = [...nodes];
  if (sort === 'name') {
    sorted.sort((a, b) => {
      const nameA = (a.path.split('/').pop() ?? a.path).toLowerCase();
      const nameB = (b.path.split('/').pop() ?? b.path).toLowerCase();
      return nameA.localeCompare(nameB);
    });
  } else {
    // Group by type: Outputs first, then Inputs
    sorted.sort((a, b) => {
      const aIsOut = a.types.some(t => t.startsWith('PLCOutput'));
      const bIsOut = b.types.some(t => t.startsWith('PLCOutput'));
      if (aIsOut !== bIsOut) return aIsOut ? -1 : 1;
      const nameA = (a.path.split('/').pop() ?? a.path).toLowerCase();
      const nameB = (b.path.split('/').pop() ?? b.path).toLowerCase();
      return nameA.localeCompare(nameB);
    });
  }
  return sorted;
}

// ─── Tree building ───────────────────────────────────────────────────────

/**
 * Build a hierarchy tree from a flat list of editable nodes.
 *
 * When `viewer` and `expandedPaths` are provided, Three.js children of
 * LayoutObject nodes that appear in `expandedPaths` are lazily injected
 * into the tree — including mesh-only children that don't carry
 * `userData.realvirtual`. This makes placed catalog items expandable in
 * the hierarchy panel exactly like normal GLB imports.
 *
 * The injection is **lazy**: collapsed LayoutObjects are not traversed,
 * so the cost of placing many catalog items stays flat.
 *
 * Idempotent NodeRegistry registration ensures injection never duplicates
 * existing entries in the suffix map.
 */
export function buildTree(
  nodes: EditableNodeInfo[],
  overlay: RVExtrasOverlay | null,
  viewer?: RVViewer,
  expandedPaths?: ReadonlySet<string>,
): TreeNode[] {
  const root: BuildTreeNode = { name: '', path: null, types: [], hasOverrides: false, children: [], _childMap: new Map() };

  for (const info of nodes) {
    const segments = info.path.split('/');
    let current = root;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;

      const fullPath = segments.slice(0, i + 1).join('/');
      const childMap = current._childMap ?? (current._childMap = new Map());
      let child = childMap.get(seg);
      if (!child) {
        child = {
          name: seg,
          path: fullPath,
          types: isLast ? info.types : [],
          hasOverrides: false,
          children: [],
          _childMap: new Map(),
        };
        childMap.set(seg, child);
        current.children.push(child);
      }

      if (isLast) {
        child.path = info.path;
        child.types = info.types;
        child.hasOverrides = overlay ? !!overlay.nodes[info.path] : false;
      }

      current = child;
    }
  }

  // Clean up temporary lookup maps to reduce memory
  function stripMaps(node: BuildTreeNode): void {
    delete node._childMap;
    for (const child of node.children) stripMaps(child as BuildTreeNode);
  }
  stripMaps(root);

  // Flatten GLB root wrapper: if top level has a single child with no component types
  // (the synthetic gltf.scene node like "demoglb"), skip it and show its children instead.
  let topNodes = root.children;
  while (topNodes.length === 1 && topNodes[0].types.length === 0 && topNodes[0].children.length > 0) {
    topNodes = topNodes[0].children;
  }

  // LayoutObject discovery: walk the tree and visit every LayoutObject node.
  // - If it's expanded, eagerly inject its Three.js subtree (mesh-only kids included).
  // - Otherwise mark `canExpandLazy` so the row renders an expand caret even
  //   when no children have been injected yet (the caret triggers the lazy
  //   inject on first toggle).
  if (viewer) {
    const visit = (nodes: TreeNode[]): void => {
      for (const node of nodes) {
        if (node.path && node.types.includes('LayoutObject')) {
          const obj = viewer.registry?.getNode(node.path);
          if (obj) {
            if (expandedPaths?.has(node.path)) {
              injectThreeJsChildren(node, obj, viewer, expandedPaths, overlay);
            } else if (obj.children.length > 0) {
              node.canExpandLazy = true;
            }
          }
        }
        if (node.children.length > 0) visit(node.children);
      }
    };
    visit(topNodes);
  }

  return topNodes;
}

/**
 * Inject Three.js children of a LayoutObject node as TreeNode children.
 *
 * Recursive injection cascades only into children that are themselves in
 * `expandedPaths` — keeping the cost bounded by the user's actual expansion
 * state, never by total scene size.
 *
 * The function is idempotent across multiple invocations on the same
 * parent: existing children (registered via the normal `editableNodes`
 * scan) are not duplicated, and NodeRegistry registration only fires when
 * a path is not yet known.
 */
function injectThreeJsChildren(
  parent: TreeNode,
  parentObj: import('three').Object3D,
  viewer: RVViewer,
  expandedPaths: ReadonlySet<string>,
  overlay: RVExtrasOverlay | null,
): void {
  // O(1) dedup via Map (avoids quadratic some() scans for large LayoutObjects)
  const existingChildPaths = new Map<string, TreeNode>();
  for (const c of parent.children) {
    if (c.path) existingChildPaths.set(c.path, c);
  }

  for (const child of parentObj.children) {
    // Skip highlight/ghost overlays — they're not real scene content
    const childUd = (child.userData ?? {}) as Record<string, unknown>;
    if (childUd._highlightOverlay || childUd._isGhostOverlay) continue;

    // Pfad-Sanitization: '/' im Namen ersetzen (Door/Frame -> Door_Frame)
    const safeName = ((child.name || child.uuid) as string).replace(/\//g, '_');
    if (!safeName) continue;
    const childPath = `${parent.path}/${safeName}`;
    if (existingChildPaths.has(childPath)) {
      // Recurse into existing child if expanded
      const existing = existingChildPaths.get(childPath)!;
      if (expandedPaths.has(childPath)) {
        injectThreeJsChildren(existing, child, viewer, expandedPaths, overlay);
      }
      continue;
    }

    const types = extractComponentTypes(childUd.realvirtual);

    const childNode: TreeNode = {
      path: childPath,
      name: safeName,
      types,
      children: [],
      hasOverrides: overlay ? !!overlay.nodes[childPath] : false,
    };
    parent.children.push(childNode);
    existingChildPaths.set(childPath, childNode);

    // Idempotent NodeRegistry registration so subsequent lookups by path
    // succeed without polluting the suffix map.
    if (viewer.registry && !viewer.registry.getNode(childPath)) {
      viewer.registry.registerNode(childPath, child);
    }

    // Cascade lazily — only descend when the user has expanded this child
    if (expandedPaths.has(childPath)) {
      injectThreeJsChildren(childNode, child, viewer, expandedPaths, overlay);
    }
  }
}

/**
 * Flatten a TreeNode forest into a flat list of nodes (depth-first, parent-first).
 * Useful for virtualization (variable-height rows) or test assertions about order.
 *
 * Returns each node with its `depth` (0 = root) so the consumer can render indentation
 * without reconstructing the hierarchy.
 */
export function flattenTree(nodes: TreeNode[]): Array<{ node: TreeNode; depth: number }> {
  const flat: Array<{ node: TreeNode; depth: number }> = [];
  function walk(node: TreeNode, depth: number): void {
    flat.push({ node, depth });
    for (const child of node.children) walk(child, depth + 1);
  }
  for (const node of nodes) walk(node, 0);
  return flat;
}

export function filterTree(nodes: TreeNode[], term: string, viewer?: RVViewer): TreeNode[] {
  if (!term) return nodes;
  const lower = term.toLowerCase();

  function filterRecursive(node: TreeNode): TreeNode | null {
    const nameMatches = node.name.toLowerCase().includes(lower);
    const pathMatches = node.path ? node.path.toLowerCase().includes(lower) : false;

    // Check component search resolvers (AAS description, Metadata content, etc.)
    let componentMatches = false;
    if (!nameMatches && !pathMatches && node.path && viewer?.registry) {
      const obj3d = viewer.registry.getNode(node.path);
      if (obj3d) {
        const searchTexts = tooltipRegistry.getSearchableText(obj3d);
        componentMatches = searchTexts.some(t => t.toLowerCase().includes(lower));
      }
    }

    const filteredChildren: TreeNode[] = [];
    for (const child of node.children) {
      const result = filterRecursive(child);
      if (result) filteredChildren.push(result);
    }

    if (nameMatches || pathMatches || componentMatches || filteredChildren.length > 0) {
      return { ...node, children: filteredChildren };
    }
    return null;
  }

  const result: TreeNode[] = [];
  for (const node of nodes) {
    const filtered = filterRecursive(node);
    if (filtered) result.push(filtered);
  }
  return result;
}

export function countNodes(
  nodes: EditableNodeInfo[],
  overlay: RVExtrasOverlay | null,
): { total: number; withOverrides: number } {
  let withOverrides = 0;
  if (overlay) {
    for (const info of nodes) {
      if (overlay.nodes[info.path]) withOverrides++;
    }
  }
  return { total: nodes.length, withOverrides };
}

// ─── Ancestor path computation ───────────────────────────────────────────

/**
 * Compute all ancestor path segments for a given path.
 * E.g. "A/B/C/D" -> ["A", "A/B", "A/B/C"]
 */
export function computeAncestors(path: string): string[] {
  const segments = path.split('/');
  const ancestors: string[] = [];
  for (let i = 0; i < segments.length - 1; i++) {
    ancestors.push(segments.slice(0, i + 1).join('/'));
  }
  return ancestors;
}

// ─── Signal helpers ──────────────────────────────────────────────────────

export function isSignalType(type: string): boolean {
  return type.startsWith('PLCInput') || type.startsWith('PLCOutput');
}

export function isBoolSignal(type: string): boolean {
  return type.includes('Bool');
}

/** Split types into [nonSignals, signals] so signals render last (right-most). */
export function splitTypes(types: string[]): [string[], string[]] {
  const nonSignals: string[] = [];
  const signals: string[] = [];
  for (const t of types) {
    if (isSignalType(t)) signals.push(t);
    else nonSignals.push(t);
  }
  return [nonSignals, signals];
}

/** Format a signal value for badge display. Single-sourced through the value
 *  resolver so hierarchy badges, inspector and tooltips never diverge. */
export function formatSignalValue(type: string, signalStore: SignalStore | null, path: string | null): string {
  if (!path) return '—';
  return formatValue(readSignalValue(signalStore, path), {
    boolStyle: 'glyph',
    intLike: type.includes('Int'),
  });
}

/** Get signal badge color based on live value. Bool: green when true, grey when false. */
export function signalBadgeColor(type: string, signalStore: SignalStore | null, path: string | null): string {
  if (!signalStore || !path) return componentColor(type);
  const value = signalStore.getByPath(path);
  if (value === undefined) return componentColor(type);

  if (isBoolSignal(type)) {
    if (value === true) {
      return type.startsWith('PLCInput') ? '#ef5350' : '#66bb6a';
    }
    return '#808080';
  }
  return componentColor(type);
}

// ─── LogicStep helpers ───────────────────────────────────────────────────

export function isLogicStepType(type: string): boolean {
  return type.startsWith('LogicStep_');
}

/** Get badge color for a component type — dynamic for LogicStep types (Active/Waiting only). */
export function badgeColor(type: string, stepState?: StepState): string {
  if (isLogicStepType(type) && (stepState === StepState.Active || stepState === StepState.Waiting)) {
    return STEP_STATE_COLORS[stepState];
  }
  return componentColor(type);
}

/** Get step info from the logic engine for a given hierarchy path. */
export function getStepInfoForPath(engine: RVLogicEngine | null, path: string | null): StepStateInfo | null {
  if (!engine || !path) return null;
  return engine.getStepInfo(path);
}

/** Format container progress text. */
export function formatContainerProgress(info: StepStateInfo): string | null {
  if (info.type === 'Delay' && info.state === StepState.Active && info.elapsed !== undefined && info.duration !== undefined) {
    return `${info.elapsed.toFixed(1)}s/${info.duration.toFixed(1)}s`;
  }
  return null;
}

// ─── Badge label ─────────────────────────────────────────────────────────

/** Shorten verbose LogicStep type names to fit in compact badges. */
export function shortStepType(type: string): string {
  const raw = type.replace('LogicStep_', '');
  switch (raw) {
    case 'SerialContainer':   return 'Serial';
    case 'ParallelContainer': return 'Parallel';
    case 'SetSignalBool':     return 'SetBool';
    case 'WaitForSignalBool': return 'WaitBool';
    case 'WaitForSensor':     return 'WaitSens';
    case 'DriveToPosition':
    case 'DriveTo':           return 'DriveTo';
    case 'SetDriveSpeed':     return 'SetSpd';
    case 'Enable':            return 'Enable';
    case 'Delay':             return 'Delay';
    case 'Pause':             return 'Pause';
    default:                  return raw;
  }
}

export function badgeLabel(type: string, stepState?: StepState): string {
  if (isLogicStepType(type)) {
    const shortType = shortStepType(type);
    // Only show state label for Active/Waiting — Idle and Finished are not shown
    if (stepState === StepState.Active || stepState === StepState.Waiting) {
      return `${shortType} ${STEP_STATE_LABELS[stepState]}`;
    }
    return shortType;
  }
  if (type === 'RuntimeMetadata') return 'Metadata';
  if (type === 'ConnectSignal') return 'Conn';
  if (type === 'TransportSurface') return 'TS';
  if (type === 'DrivesRecorder') return 'Rec';
  if (type === 'ReplayRecording') return 'Replay';
  if (type === 'PLCOutputBool') return 'OutBool';
  if (type === 'PLCOutputFloat') return 'OutFloat';
  if (type === 'PLCOutputInt') return 'OutInt';
  if (type === 'PLCInputBool') return 'InBool';
  if (type === 'PLCInputFloat') return 'InFloat';
  if (type === 'PLCInputInt') return 'InInt';
  if (type.startsWith('PLCOutput')) return 'Out:' + type.replace('PLCOutput', '');
  if (type.startsWith('PLCInput')) return 'In:' + type.replace('PLCInput', '');
  if (type.startsWith('Drive_')) return type.replace('Drive_', 'D:');
  // Components can declare a custom display name via registerComponent({ displayName })
  return getDisplayName(type);
}
