// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ViewerEvents — typed event surface emitted by RVViewer.
 *
 * Extracted to its own module so consumers (hooks, engine subsystems) can
 * import the type WITHOUT pulling in the full rv-viewer.ts module.
 * This was the foundational step of plan-182 (architecture refactoring).
 *
 * Keep this file free of any `rv-viewer.ts` import — it lives at the bottom
 * of the dependency graph so engine/ and hooks/ can depend on it cleanly.
 */

import type { LoadResult } from './engine/rv-scene-loader';
import type { RvScene } from './hmi/scene/rv-scene-types';
import type { RVDrive } from './engine/rv-drive';
import type { NodeSearchResult } from './engine/rv-node-registry';
import type { HoverableType, ObjectHoverData, ObjectUnhoverData, ObjectClickData } from './engine/rv-raycast-manager';
import type { SelectionSnapshot } from './engine/rv-selection-manager';
import type { MultiuserSnapshot } from '../plugins/multiuser-plugin';
import type { McpBridgeSnapshot } from '../plugins/mcp-bridge-plugin';
import type { Object3D } from 'three';

export interface ViewerEvents {
  // ── Existing events (unchanged) ──
  'model-loaded': { result: LoadResult };
  'model-cleared': void;
  /** Fired by RVViewer.loadScene() once the scene record is fully applied
   *  (base GLB + overlay + placements). Camera plugins listen for this to
   *  apply per-scene camera presets. */
  'scene-loaded': { scene: RvScene };
  'drive-chart-toggle': { open: boolean };
  'drive-filter': { filter: string; filteredDrives: RVDrive[] };
  'node-filter': { filter: string; filteredNodes: NodeSearchResult[]; tooMany: boolean };
  'sensor-chart-toggle': { open: boolean };
  'groups-overlay-toggle': { open: boolean };
  'exclusive-hover-mode': { mode: HoverableType | null };

  // ── Connection state ──
  'connection-state-changed': { state: 'Connected' | 'Disconnected'; previous: 'Connected' | 'Disconnected' };

  // ── Generic component event ──
  /** Emitted by any RVComponent (drive, sensor, MU, custom plugin component) when
   *  it reports a runtime state change. Replaces the previous per-type events
   *  (sensor-changed, mu-spawned, mu-consumed, drive-at-target). New component
   *  types add their own `componentType` without extending ViewerEvents.
   *
   *  Known kinds:
   *    - sensor   : 'changed'   payload: { occupied: boolean }
   *    - mu       : 'spawned'   payload: { totalSpawned: number }
   *    - mu       : 'consumed'  payload: { totalConsumed: number }
   *    - drive    : 'at-target' payload: { position: number }
   */
  'component-event': {
    componentType: string;
    kind: string;
    path: string;
    payload?: unknown;
  };

  // ── Interface events (emitted by interface plugins) ──
  'interface-connected': { interfaceId: string; type: string };
  'interface-disconnected': { interfaceId: string; reason?: string };
  'interface-error': { interfaceId: string; error: string };
  'interface-data': { interfaceId: string; signals: Record<string, unknown> };

  // ── Generic raycast events (emitted by RaycastManager) ──
  'object-hover': ObjectHoverData | null;
  'object-unhover': ObjectUnhoverData;
  'object-click': ObjectClickData;

  // ── UI events (emitted by UI plugins) ──
  'camera-animation-done': { targetPath?: string };
  'object-clicked': { path: string; node: Object3D; hitPoint?: [number, number, number] };
  'selection-changed': SelectionSnapshot;
  'object-focus': { path: string; node: Object3D };
  /** Fired when a previously focused object is unfocused (focusByPath cleared). */
  'object-blur': void;
  'panel-opened': { panelId: string };
  'panel-closed': { panelId: string };

  // ── Safety door events (engine listens, UI emits) ──
  /** Show or hide all safety-door gizmos at once.
   *  UI plugins emit this to toggle visibility from a warning tile etc. */
  'safety-door:show-all': { show: boolean };

  // ── XR events ──
  'xr-session-start': void;
  'xr-session-end': void;
  'xr-hit-test': { position: Float32Array; matrix: Float32Array };
  'xr-controller-select': { hand: 'left' | 'right'; position: { x: number; y: number; z: number } };

  // ── FPV events ──
  'fpv-enter': void;
  'fpv-exit': void;

  // ── Multiuser events (emitted by multiuser-plugin) ──
  'multiuser-changed': MultiuserSnapshot;

  // ── MCP Bridge events (emitted by mcp-bridge-plugin) ──
  'mcp-bridge-changed': McpBridgeSnapshot;

  // ── Context Menu events ──
  'context-menu-request': { pos: { x: number; y: number }; path: string; node: Object3D };

  // ── Layout events ──
  /** Position/rotation/scale/visibility change on a placed layout object —
   *  emitted by inspector edits, SetPositionDialog, gizmo drags, splat tools,
   *  etc. The planner listens and persists into the layout store + op log.
   *  `scale` and `visible` are optional so old call-sites don't have to be
   *  retrofitted; planner code merges them with the previous snapshot.
   *  Position/rotation arrive as `[x, y, z]` tuples (degrees for rotation)
   *  matching the layout-store wire format and the planner's listener. */
  'layout-transform-update': {
    path: string;
    position: [number, number, number];
    rotation: [number, number, number];
    scale?: [number, number, number];
    visible?: boolean;
  };
  /** Fired by the layout-planner the moment a gizmo drag begins. The snap-
   *  point plugin uses this to arm its magnetic-snap controller. `altKey`
   *  reflects the modifier state at drag-start — listeners may treat this
   *  as a per-drag override (e.g. snap-point plugin treats ALT-held as
   *  "drag solo + detach all connections of the moved asset"). */
  'layout-drag-start': { node: Object3D; altKey?: boolean };
  /** Fired once per drag frame (FloorGizmo onChange) AFTER the gizmo has
   *  applied its own transform but BEFORE the next render. Listeners may
   *  mutate `node.position`/`node.quaternion` to override (used for magnetic
   *  snap-to-snap alignment). */
  'layout-drag-tick': { node: Object3D };
  /** Fired when the gizmo drag ends, before the planner writes the final
   *  transform to its store. */
  'layout-drag-end': { node: Object3D };

  // ── Simulation pause events ──
  /** Fired when the overall simulation pause state transitions (idle ↔ paused).
   *  Plugins can subscribe to stop/resume external PLC I/O, freeze animations,
   *  disable cursor interactions, etc. Not fired when reasons are added/removed
   *  while already paused — only on the idle/paused transition. */
  'simulation-pause-changed': {
    /** New overall pause state. */
    paused: boolean;
    /** All currently active pause reasons (snapshot). */
    reasons: readonly string[];
    /** The specific reason that triggered this transition. */
    reason: string;
  };
}
