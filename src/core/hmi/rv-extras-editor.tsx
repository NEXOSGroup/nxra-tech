// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RvExtrasEditorPlugin — Hierarchy browser and extras editor plugin.
 *
 * Manages the hierarchy browser state, node selection, and overlay mutations.
 * The UI button lives in TopBar (system menu) alongside VR and Settings.
 * Clicking a node updates the selectedNodePath state; the PropertyInspector
 * reads and mutates overlay data via the methods here.
 */

import type { RVViewerPlugin } from '../rv-plugin';
import type { LoadResult } from '../engine/rv-scene-loader';
import type { RVViewer } from '../rv-viewer';
import type { ContextMenuTarget } from './context-menu-store';
import { loadOverlay, saveOverlay, saveOriginals, loadOriginals, removeOriginals, type RVExtrasOverlay } from '../engine/rv-extras-overlay-store';
import { materialise as materialiseEdits, freshOpId } from './scene/rv-scene-edits';
import { getSceneStore } from './scene/scene-store-singleton';
import { isHiddenComponentType, baseComponentType } from './rv-inspector-helpers';
import { isEphemeralField } from './rv-value-resolver';
import { getFieldDescriptor } from '../engine/rv-component-registry';
import { openSetPositionDialog } from './SetPositionDialog';

// ─── Layout Object Helpers (for context menu) ──────────────────────────

/** Check if a context menu target has a LayoutObject component. */
function hasLayoutObject(target: ContextMenuTarget): boolean {
  return !!(target.extras as Record<string, unknown>)?.LayoutObject;
}

/** Check if a node at the given path is locked. */
function isNodeLocked(viewer: RVViewer, path: string): boolean {
  const node = viewer.registry?.getNode(path);
  const rv = node?.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
  return !!(rv?.LayoutObject?.Locked);
}

/**
 * Get the effective list of layout object paths for a context menu action.
 * If multiple objects are selected, returns all selected paths that have LayoutObject.
 * Otherwise returns just the target path.
 */
function getLayoutPaths(viewer: RVViewer, target: ContextMenuTarget): string[] {
  const sel = viewer.selectionManager;
  if (sel.count > 1) {
    const paths = [...sel.selectedPaths].filter(p => {
      const node = viewer.registry?.getNode(p);
      const rv = node?.userData?.realvirtual as Record<string, unknown> | undefined;
      return !!rv?.LayoutObject;
    });
    if (paths.length > 0) return paths;
  }
  return [target.path];
}

/** Get count of layout objects that will be affected. */
function getLayoutCount(viewer: RVViewer, target: ContextMenuTarget): number {
  return getLayoutPaths(viewer, target).length;
}

// ─── Editable Node Info ──────────────────────────────────────────────────

export interface EditableNodeInfo {
  /** Full hierarchy path (e.g. 'DemoCell/Conveyor1'). */
  path: string;
  /** Component types present on this node (e.g. ['Drive', 'TransportSurface']). */
  types: string[];
}

/**
 * Source of a selectNode() call.
 * - 'tree'     — explicit selection from the hierarchy panel; sub-node paths
 *                under a LayoutObject must remain unchanged
 * - 'viewport' — 3D-viewport pick; resolves up to the LayoutObject root so
 *                clicking any sub-mesh selects the whole placed object
 * - 'api'      — programmatic call from plugins/tests; no resolution applied
 */
export type SelectionSource = 'tree' | 'viewport' | 'api';

// ─── Plugin State (external store for React) ─────────────────────────────

/** Default and min/max width for the hierarchy panel. */
export const HIERARCHY_MIN_WIDTH = 200;
export const HIERARCHY_MAX_WIDTH = 600;
export const HIERARCHY_DEFAULT_WIDTH = 280;

const LS_KEY_PANEL_WIDTH = 'rv-extras-editor-width';
const LS_KEY_PANEL_OPEN = 'rv-extras-editor-open';
const LS_KEY_SELECTED_NODE = 'rv-extras-editor-selected';

/** Snapshot of plugin state for React consumption. */
export interface ExtrasEditorState {
  panelOpen: boolean;
  panelWidth: number;
  overlay: RVExtrasOverlay | null;
  editableNodes: EditableNodeInfo[];
  selectedNodePath: string | null;
  /** Set by selectAndReveal(), consumed by HierarchyBrowser to expand ancestors and scroll-to. */
  revealPath: string | null;
  /** Whether the property inspector should be shown (true when selected from hierarchy, false from 3D click). */
  showInspector: boolean;
  /** Whether the settings panel is open (shared so ButtonPanel can shift). */
  settingsOpen: boolean;
}

// ─── Plugin ──────────────────────────────────────────────────────────────

export class RvExtrasEditorPlugin implements RVViewerPlugin {
  readonly id = 'rv-extras-editor';
  readonly core = true;

  // ── State ──
  private _panelOpen = false;
  private _panelWidth: number;
  private _overlay: RVExtrasOverlay | null = null;
  private _editableNodes: EditableNodeInfo[] = [];
  private _selectedNodePath: string | null = null;
  private _revealPath: string | null = null;
  private _showInspector = false;
  private _settingsOpen = false;
  private _viewer: RVViewer | null = null;
  private _glbName: string | null = null;

  /** Snapshot of original GLB values before any override was applied.
   *  Key: `${nodePath}/${componentType}/${fieldName}` → original value */
  private _originals = new Map<string, unknown>();

  constructor() {
    const storedWidth = localStorage.getItem(LS_KEY_PANEL_WIDTH);
    this._panelWidth = storedWidth ? Math.max(HIERARCHY_MIN_WIDTH, Math.min(HIERARCHY_MAX_WIDTH, Number(storedWidth))) : HIERARCHY_DEFAULT_WIDTH;
    this._panelOpen = localStorage.getItem(LS_KEY_PANEL_OPEN) === 'true';
    this._selectedNodePath = localStorage.getItem(LS_KEY_SELECTED_NODE) || null;
    this._snapshot = {
      panelOpen: this._panelOpen,
      panelWidth: this._panelWidth,
      overlay: null,
      editableNodes: [],
      selectedNodePath: this._selectedNodePath,
      revealPath: null,
      showInspector: false,
      settingsOpen: false,
    };
  }

  // ── External store subscription (React) ──
  private _listeners = new Set<() => void>();

  /** Cached snapshot — MUST be a stable reference between notifications.
   *  Creating a new object in getSnapshot causes infinite React re-renders. */
  private _snapshot: ExtrasEditorState = {
    panelOpen: false,
    panelWidth: HIERARCHY_DEFAULT_WIDTH,
    overlay: null,
    editableNodes: [],
    selectedNodePath: null,
    revealPath: null,
    showInspector: false,
    settingsOpen: false,
  };

  /** Subscribe for React useSyncExternalStore. */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  /** Snapshot getter for React useSyncExternalStore. Returns stable reference. */
  getSnapshot = (): ExtrasEditorState => this._snapshot;

  private notify(): void {
    this._snapshot = {
      panelOpen: this._panelOpen,
      panelWidth: this._panelWidth,
      overlay: this._overlay,
      editableNodes: this._editableNodes,
      selectedNodePath: this._selectedNodePath,
      revealPath: this._revealPath,
      showInspector: this._showInspector,
      settingsOpen: this._settingsOpen,
    };
    for (const listener of this._listeners) listener();
  }

  // ── Public API ──

  get panelOpen(): boolean { return this._panelOpen; }

  togglePanel(): void {
    this._panelOpen = !this._panelOpen;
    localStorage.setItem(LS_KEY_PANEL_OPEN, String(this._panelOpen));
    // Coordinate with LeftPanelManager for mutual exclusion
    if (this._viewer) {
      if (this._panelOpen) {
        this._viewer.leftPanelManager.open('hierarchy', this._panelWidth);
      } else {
        this._viewer.leftPanelManager.close('hierarchy');
      }
    }
    this.notify();
  }

  setSettingsOpen(open: boolean): void {
    this._settingsOpen = open;
    this.notify();
  }

  setPanelWidth(width: number): void {
    this._panelWidth = Math.max(HIERARCHY_MIN_WIDTH, Math.min(HIERARCHY_MAX_WIDTH, width));
    localStorage.setItem(LS_KEY_PANEL_WIDTH, String(this._panelWidth));
    this.notify();
  }

  /**
   * Update the selected node path and snapshot it to localStorage.
   *
   * `source` differentiates click origins: viewport picks resolve up to the
   * enclosing LayoutObject (matches the whole-object hover/click highlight),
   * tree/api selections stay on the explicit path.
   */
  selectNode(path: string, showInspector?: boolean): void;
  selectNode(path: string, source: SelectionSource): void;
  selectNode(path: string, showInspector: boolean, source: SelectionSource): void;
  selectNode(
    path: string,
    showInspectorOrSource: boolean | SelectionSource = false,
    sourceArg: SelectionSource = 'api',
  ): void {
    const show = typeof showInspectorOrSource === 'boolean' ? showInspectorOrSource : false;
    const source: SelectionSource = typeof showInspectorOrSource === 'string'
      ? showInspectorOrSource
      : sourceArg;
    if (source === 'viewport') {
      const resolved = this.findLayoutObjectAncestor(path);
      if (resolved) path = resolved;
    }
    this._selectedNodePath = path;
    this._showInspector = show;
    localStorage.setItem(LS_KEY_SELECTED_NODE, path);
    this.notify();
  }

  /** Cache for ancestor lookups; invalidated whenever editableNodes refresh. */
  private _ancestorCache = new Map<string, string | null>();

  /**
   * Walk up the registered hierarchy from `path` and return the path of the
   * nearest ancestor (inclusive) whose Three.js node carries a
   * `userData.realvirtual.LayoutObject` marker. Returns null if no such
   * ancestor exists. Cached per-path; cleared on `refreshEditableNodes`.
   */
  findLayoutObjectAncestor(path: string): string | null {
    if (this._ancestorCache.has(path)) return this._ancestorCache.get(path)!;
    if (!this._viewer?.registry) return null;
    const node = this._viewer.registry.getNode(path);
    if (!node) return null;
    let current: import('three').Object3D | null = node;
    while (current) {
      const rv = current.userData?.realvirtual as Record<string, unknown> | undefined;
      if (rv?.LayoutObject) {
        const ancestor = this._viewer.registry.getPathForNode(current);
        this._ancestorCache.set(path, ancestor);
        return ancestor;
      }
      current = current.parent;
    }
    this._ancestorCache.set(path, null);
    return null;
  }

  /** Convenience: read the currently selected node path. */
  getSelectedPath(): string | null {
    return this._selectedNodePath;
  }

  /** Convenience: snapshot of editable nodes (matches `state.editableNodes`). */
  getEditableNodes(): EditableNodeInfo[] {
    return this._editableNodes;
  }

  clearSelection(): void {
    this._selectedNodePath = null;
    this._showInspector = false;
    localStorage.removeItem(LS_KEY_SELECTED_NODE);
    this.notify();
  }

  /**
   * Select a node and request the hierarchy browser to reveal it
   * by expanding all ancestor tree nodes and scrolling to it.
   * Opens the panel if currently closed.
   */
  selectAndReveal(path: string, showInspector = true): void {
    if (!this._panelOpen) {
      this._panelOpen = true;
      localStorage.setItem(LS_KEY_PANEL_OPEN, 'true');
      // Coordinate with LeftPanelManager for mutual exclusion
      if (this._viewer) {
        this._viewer.leftPanelManager.open('hierarchy', this._panelWidth);
      }
    }
    this._selectedNodePath = path;
    this._revealPath = path;
    this._showInspector = showInspector;
    localStorage.setItem(LS_KEY_SELECTED_NODE, path);
    this.notify();
  }

  /** Clear the revealPath after the hierarchy browser has consumed it. */
  clearReveal(): void {
    if (this._revealPath) {
      this._revealPath = null;
      this.notify();
    }
  }

  /** Unsubscribe functions for viewer events. */
  private _eventUnsubs: (() => void)[] = [];
  /** Ancestor override for LayoutObject hover resolution. */
  private _layoutAncestorOverride: ((mesh: import('three').Object3D) => import('three').Object3D | null) | null = null;
  /** Cleanup handle for the SceneStore subscription (keeps `_overlay` cache fresh). */
  private _sceneStoreUnsub: (() => void) | null = null;

  /** The RVViewer instance (available after onModelLoaded). */
  get viewer(): RVViewer | null { return this._viewer; }

  /** The GLB file name derived from the model URL (available after onModelLoaded). */
  get glbName(): string | null { return this._glbName; }

  // ── Overlay Mutation ──

  /** Ensure an overlay object exists, creating one if needed. */
  private ensureOverlay(): RVExtrasOverlay {
    if (!this._overlay) {
      this._overlay = {
        $schema: 'rv-extras-overlay/1.0',
        $source: 'property-inspector',
        nodes: {},
      };
    }
    return this._overlay;
  }

  /** Key for the originals map. */
  private origKey(nodePath: string, componentType: string, fieldName: string): string {
    return `${nodePath}/${componentType}/${fieldName}`;
  }

  /** Snapshot the current (original) value before first override.
   *  Persists to localStorage sidecar for reset-after-reload support. */
  private snapshotOriginal(nodePath: string, componentType: string, fieldName: string): void {
    const key = this.origKey(nodePath, componentType, fieldName);
    if (this._originals.has(key)) return; // already captured
    const rv = this.readSceneField(nodePath, componentType, fieldName);
    this._originals.set(key, rv);
    // Persist originals sidecar to LS
    if (this._glbName) saveOriginals(this._glbName, this._originals);
  }

  /** Read a field value from the live scene node. */
  private readSceneField(nodePath: string, componentType: string, fieldName: string): unknown {
    if (!this._viewer?.registry) return undefined;
    const node = this._viewer.registry.getNode(nodePath);
    if (!node) return undefined;
    const rv = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    return rv?.[componentType]?.[fieldName];
  }

  /**
   * Update a single field. Routes through SceneStore.applyOp so the change
   * enters the unified op log and participates in undo/redo. The legacy
   * localStorage write is kept ONLY for the boot path (no SceneStore yet);
   * SceneStore-driven sessions persist via the per-base draft autosave.
   */
  updateOverlayField(nodePath: string, componentType: string, fieldName: string, value: unknown): boolean {
    // Never write a field its schema marks readonly — defense in depth in case
    // the inspector UI (which already hides the editor) is bypassed.
    if (getFieldDescriptor(baseComponentType(componentType), fieldName)?.readonly) {
      console.warn(`[rvExtrasEditor] Refusing to edit readonly field ${componentType}.${fieldName}`);
      return false;
    }

    // Block edits on sub-paths of locked LayoutObjects. The LayoutObject root
    // itself remains editable so the user can unlock it without first
    // un-editing every nested field.
    const ancestor = this.findLayoutObjectAncestor(nodePath);
    if (ancestor && ancestor !== nodePath) {
      const obj = this._viewer?.registry?.getNode(ancestor);
      const rv = obj?.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
      if (rv?.LayoutObject?.Locked === true) {
        console.warn(`[rvExtrasEditor] Cannot edit ${nodePath}: LayoutObject ${ancestor} is locked`);
        return false;
      }
    }

    // Never persist ephemeral runtime state (e.g. a drive's CurrentPosition, a
    // sensor's Occupied) as an override. Only config fields can become overrides
    // and be saved — otherwise drafts/layouts accumulate meaningless runtime
    // snapshots that mis-seed the simulation on reload.
    if (this._viewer && isEphemeralField(this._viewer, nodePath, componentType, fieldName)) {
      console.warn(`[rvExtrasEditor] Refusing to persist runtime field ${componentType}.${fieldName}`);
      return false;
    }

    // No-op guard: drag handlers fire continuously with the same value;
    // bail out before allocating ops or touching localStorage.
    const prev = this.readSceneField(nodePath, componentType, fieldName);
    if (Object.is(prev, value)) return true;

    // Snapshot original before first override (for the legacy reset path).
    this.snapshotOriginal(nodePath, componentType, fieldName);

    const sceneStore = getSceneStore();
    if (sceneStore) {
      // Optimistically reflect the override in the cached overlay and notify
      // NOW, so the inspector marks the field as overridden the moment it
      // changes. `applyOp` runs asynchronously through the SceneStore op queue;
      // without this the override dot only appears after the queue flushes (or,
      // in some scene states, not until a reload re-materialises the ops). The
      // SceneStore subscription later re-materialises the overlay to the same
      // value (idempotent — it no-ops when structurally equal).
      const ov = this.ensureOverlay();
      if (!ov.nodes[nodePath]) ov.nodes[nodePath] = {};
      if (!ov.nodes[nodePath][componentType]) ov.nodes[nodePath][componentType] = {};
      ov.nodes[nodePath][componentType][fieldName] = value;
      this.notify();

      // Op-based path — applyOp pushes a `setField` op, the executor writes
      // userData + reapplies schema. The store's notify cascades back to
      // this plugin via _sceneStoreUnsub → _refreshOverlayFromScene.
      void sceneStore.applyOp({
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'setField', nodePath, componentType, fieldName, value, prev,
      });
      return true;
    }

    // Legacy fallback — pre-SceneStore boot or test environments.
    const overlay = this.ensureOverlay();
    if (!overlay.nodes[nodePath]) overlay.nodes[nodePath] = {};
    if (!overlay.nodes[nodePath][componentType]) overlay.nodes[nodePath][componentType] = {};
    overlay.nodes[nodePath][componentType][fieldName] = value;
    this.applyFieldToScene(nodePath, componentType, fieldName, value);
    if (this._glbName) saveOverlay(this._glbName, overlay);
    this.notify();
    return true;
  }

  /**
   * Reset a single field override. Op-based path emits an `unsetField` op;
   * the executor restores the prev value from the inverse path.
   */
  resetField(nodePath: string, componentType: string, fieldName: string): void {
    const prev = this.readSceneField(nodePath, componentType, fieldName);
    const sceneStore = getSceneStore();
    if (sceneStore) {
      void sceneStore.applyOp({
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'unsetField', nodePath, componentType, fieldName, prev,
      });
      return;
    }

    // Legacy fallback
    if (!this._overlay) return;
    const nodeOverrides = this._overlay.nodes[nodePath];
    if (!nodeOverrides?.[componentType]) return;
    delete nodeOverrides[componentType][fieldName];
    const key = this.origKey(nodePath, componentType, fieldName);
    if (this._originals.has(key)) {
      this.applyFieldToScene(nodePath, componentType, fieldName, this._originals.get(key));
      this._originals.delete(key);
    }
    if (Object.keys(nodeOverrides[componentType]).length === 0) delete nodeOverrides[componentType];
    if (Object.keys(nodeOverrides).length === 0) delete this._overlay.nodes[nodePath];
    if (this._glbName) {
      saveOverlay(this._glbName, this._overlay);
      removeOriginals(this._glbName, [key]);
    }
    this.notify();
  }

  /**
   * Reset all overrides for a component. Wrapped in a transaction so the
   * batch is one undo step.
   */
  resetComponent(nodePath: string, componentType: string): void {
    const sceneStore = getSceneStore();
    if (sceneStore && this._overlay?.nodes[nodePath]?.[componentType]) {
      const fields = Object.keys(this._overlay.nodes[nodePath][componentType]);
      void sceneStore.withTransaction(`Reset ${componentType}`, async () => {
        for (const fieldName of fields) {
          const prev = this.readSceneField(nodePath, componentType, fieldName);
          await sceneStore.applyOp({
            id: freshOpId(), ts: Date.now(), schemaV: 1,
            kind: 'unsetField', nodePath, componentType, fieldName, prev,
          });
        }
      });
      return;
    }

    // Legacy fallback
    if (!this._overlay) return;
    const nodeOverrides = this._overlay.nodes[nodePath];
    if (!nodeOverrides?.[componentType]) return;
    const removedKeys: string[] = [];
    for (const fieldName of Object.keys(nodeOverrides[componentType])) {
      const key = this.origKey(nodePath, componentType, fieldName);
      if (this._originals.has(key)) {
        this.applyFieldToScene(nodePath, componentType, fieldName, this._originals.get(key));
        this._originals.delete(key);
        removedKeys.push(key);
      }
    }
    delete nodeOverrides[componentType];
    if (Object.keys(nodeOverrides).length === 0) delete this._overlay.nodes[nodePath];
    if (this._glbName) {
      saveOverlay(this._glbName, this._overlay);
      if (removedKeys.length > 0) removeOriginals(this._glbName, removedKeys);
    }
    this.notify();
  }

  /**
   * Reset all overrides for a node — emits one transaction wrapping all
   * unsetField primitives so undo restores the entire node in one step.
   */
  resetNode(nodePath: string): void {
    const sceneStore = getSceneStore();
    if (sceneStore && this._overlay?.nodes[nodePath]) {
      const nodeOv = this._overlay.nodes[nodePath];
      const work: Array<{ componentType: string; fieldName: string; prev: unknown }> = [];
      for (const [componentType, fields] of Object.entries(nodeOv)) {
        for (const fieldName of Object.keys(fields)) {
          work.push({ componentType, fieldName, prev: this.readSceneField(nodePath, componentType, fieldName) });
        }
      }
      if (work.length === 0) return;
      void sceneStore.withTransaction(`Reset node`, async () => {
        for (const w of work) {
          await sceneStore.applyOp({
            id: freshOpId(), ts: Date.now(), schemaV: 1,
            kind: 'unsetField', nodePath, componentType: w.componentType,
            fieldName: w.fieldName, prev: w.prev,
          });
        }
      });
      return;
    }

    // Legacy fallback
    if (!this._overlay) return;
    const nodeOverrides = this._overlay.nodes[nodePath];
    const removedKeys: string[] = [];
    if (nodeOverrides) {
      for (const [componentType, fields] of Object.entries(nodeOverrides)) {
        for (const fieldName of Object.keys(fields)) {
          const key = this.origKey(nodePath, componentType, fieldName);
          if (this._originals.has(key)) {
            this.applyFieldToScene(nodePath, componentType, fieldName, this._originals.get(key));
            this._originals.delete(key);
            removedKeys.push(key);
          }
        }
      }
    }
    delete this._overlay.nodes[nodePath];
    if (this._glbName) {
      saveOverlay(this._glbName, this._overlay);
      if (removedKeys.length > 0) removeOriginals(this._glbName, removedKeys);
    }
    this.notify();
  }

  /**
   * Apply a single field value to the live scene node's userData.realvirtual.
   */
  private applyFieldToScene(nodePath: string, componentType: string, fieldName: string, value: unknown): void {
    if (!this._viewer?.registry) return;
    const node = this._viewer.registry.getNode(nodePath);
    if (!node) return;

    const rv = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    if (!rv?.[componentType]) return;
    rv[componentType][fieldName] = value;
  }

  // ── Layout Context Menu ──

  /** Register context menu items for LayoutObject nodes (lock, delete, edit, set position). */
  private _registerLayoutContextMenu(viewer: RVViewer): void {
    const plugin = this;

    viewer.contextMenu.register({
      pluginId: 'layout-objects',
      items: [
        // ── Edit (open hierarchy + inspector) ──
        {
          id: 'layout.edit',
          label: 'Edit',
          order: 10,
          condition: hasLayoutObject,
          action: (target) => {
            plugin.selectAndReveal(target.path, true);
          },
        },
        // ── Lock / Unlock ──
        {
          id: 'layout.lock',
          label: (target) => {
            const paths = getLayoutPaths(viewer, target);
            const allLocked = paths.every(p => isNodeLocked(viewer, p));
            const count = paths.length;
            const verb = allLocked ? 'Unlock' : 'Lock';
            return count > 1 ? `${verb} (${count})` : verb;
          },
          order: 20,
          condition: hasLayoutObject,
          action: (target) => {
            const paths = getLayoutPaths(viewer, target);
            const allLocked = paths.every(p => isNodeLocked(viewer, p));
            const newLocked = !allLocked;
            for (const p of paths) {
              plugin.updateOverlayField(p, 'LayoutObject', 'Locked', newLocked);
            }
          },
        },
        // ── Set Transform ──
        {
          id: 'layout.settransform',
          label: (target) => {
            const count = getLayoutCount(viewer, target);
            return count > 1 ? `Set Transform (${count})` : 'Set Transform';
          },
          order: 30,
          condition: (target) => {
            if (!hasLayoutObject(target)) return false;
            // Hide if all are locked
            return getLayoutPaths(viewer, target).some(p => !isNodeLocked(viewer, p));
          },
          action: (target) => {
            const paths = getLayoutPaths(viewer, target).filter(p => !isNodeLocked(viewer, p));
            if (paths.length > 0) openSetPositionDialog(viewer, paths);
          },
        },
        // ── Delete ──
        {
          id: 'layout.delete',
          label: (target) => {
            const count = getLayoutCount(viewer, target);
            return count > 1 ? `Delete (${count})` : 'Delete';
          },
          order: 200,
          danger: true,
          dividerBefore: true,
          condition: (target) => {
            if (!hasLayoutObject(target)) return false;
            return getLayoutPaths(viewer, target).some(p => !isNodeLocked(viewer, p));
          },
          action: (target) => {
            const paths = getLayoutPaths(viewer, target).filter(p => !isNodeLocked(viewer, p));
            if (paths.length === 0) return;
            // The layout-planner plugin owns the actual scene/store/SceneStore
            // mutation — it listens for `layout-objects-deleted` and routes
            // through its own removal pipeline (undo-safe). Don't mutate
            // visibility here; the planner clears the selection itself.
            viewer.emit('layout-objects-deleted', { paths });
          },
        },
      ],
    });
  }

  // ── Lifecycle ──

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this._viewer = viewer;
    this._editableNodes = [];

    // Collect all nodes that have userData.realvirtual with component data
    const registry = result.registry;
    const scene = viewer.scene;

    scene.traverse((node) => {
      const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
      if (!rv) return;

      // Get types: keys that map to objects (component data), excluding metadata and hidden types
      const types: string[] = [];
      for (const [key, value] of Object.entries(rv)) {
        if (isHiddenComponentType(key)) continue;
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          types.push(key);
        }
      }

      if (types.length === 0) return;

      // Compute path using registry or fallback
      const path = registry.getPathForNode(node);
      if (!path) return;

      this._editableNodes.push({ path, types });
    });

    // Sort by path for consistent display
    this._editableNodes.sort((a, b) => a.path.localeCompare(b.path));

    // Load overlay state. Priority:
    //   1) Materialise the active unified Scene's edit log into an overlay —
    //      wins when the load came through the new SceneStore (op-based).
    //   2) Legacy localStorage (rv-extras-overlay:<glbName>) — kept for the
    //      boot path that loads a GLB directly without going through the
    //      Scene panel (e.g. ?model=). The originals sidecar is loaded the
    //      same way for reset-after-reload support.
    const modelUrl = viewer.currentModelUrl;
    if (modelUrl) {
      this._glbName = modelUrl.split('/').pop() ?? modelUrl;
      const scene = viewer.currentScene;
      if (scene) {
        // Materialise the scene's op log into an overlay snapshot — read-only
        // CACHE for the inspector's "is this field overridden?" rendering.
        // Inspector mutations now flow through SceneStore.applyOp (see
        // updateOverlayField above); the SceneStore subscription below keeps
        // this cache fresh after undo/redo or external edits.
        this._overlay = materialiseEdits(scene.edits.ops).overlay;
      } else {
        this._overlay = loadOverlay(this._glbName);
      }

      // Originals sidecar: legacy-only. Future PR may capture originals
      // during loadGLB traversal so this side store can be retired.
      this._originals = loadOriginals(this._glbName);

      // Subscribe to SceneStore so _overlay stays in sync with the op log
      // (e.g. after undo / redo or external applyOp calls). The
      // subscription is torn down in dispose().
      const sceneStore = getSceneStore();
      if (sceneStore && !this._sceneStoreUnsub) {
        this._sceneStoreUnsub = sceneStore.subscribe(() => {
          // Materialise from the store's LIVE op log (its draft snapshot), not
          // viewer.currentScene.edits.ops — the latter is a stale copy that is
          // only refreshed on load/save, so it never reflects in-progress edits.
          // Reading it here was why a freshly-edited field's override mark was
          // wiped right after it appeared (and only showed up again on reload).
          const ops = sceneStore.getSnapshot().draft?.edits.ops
            ?? viewer.currentScene?.edits.ops;
          if (!ops) return;
          const next = materialiseEdits(ops).overlay;
          // Only notify if the overlay actually changed structurally.
          if (JSON.stringify(this._overlay) !== JSON.stringify(next)) {
            this._overlay = next;
            this.notify();
          }
        });
      }
    }

    // Register layout object context menu items
    this._registerLayoutContextMenu(viewer);

    // Register ancestor override so hovering any child of a LayoutObject
    // resolves to the LayoutObject root (full subtree hover highlight)
    if (viewer.raycastManager) {
      this._layoutAncestorOverride = (mesh: import('three').Object3D) => {
        let current: import('three').Object3D | null = mesh;
        while (current) {
          const rv = current.userData?.realvirtual as Record<string, unknown> | undefined;
          if (rv?.LayoutObject) return current;
          current = current.parent;
        }
        return null;
      };
      viewer.raycastManager.addAncestorOverride(this._layoutAncestorOverride);
    }

    // Subscribe to selection-changed for loose-coupled scene interaction.
    // Preserve the current inspector visibility — switching the selected
    // object in the 3D scene should follow the inspector to the new node
    // when it's open, NOT close it (the prior `false` literal closed the
    // inspector on every scene selection change).
    this._eventUnsubs.push(
      viewer.on('selection-changed', (snapshot) => {
        const path = snapshot.primaryPath;
        if (!path) {
          this.clearSelection();
        } else if (this._panelOpen) {
          this.selectAndReveal(path, this._showInspector);
        } else {
          this.selectNode(path, this._showInspector);
        }
      }),
    );

    // Subscribe to object-focus (canvas double-click + F key) — opens the
    // Property Inspector alongside the camera-zoom that the viewer's built-in
    // handler already performs. We accept any path the registry knows; the
    // inspector itself decides what to render (empty state for nodes without
    // rv_extras components).
    this._eventUnsubs.push(
      viewer.on('object-focus', ({ path }) => {
        if (!path) return;
        this.selectAndReveal(path, true);
      }),
    );

    // Subscribe to LeftPanelManager: close hierarchy when another panel opens
    this._eventUnsubs.push(
      viewer.leftPanelManager.subscribe(() => {
        const snap = viewer.leftPanelManager.getSnapshot();
        if (snap.activePanel !== null && snap.activePanel !== 'hierarchy' && this._panelOpen) {
          this._panelOpen = false;
          localStorage.setItem(LS_KEY_PANEL_OPEN, 'false');
          this.notify();
        }
      }),
    );

    // If panel was persisted as open, register with LPM so it knows about us
    if (this._panelOpen) {
      viewer.leftPanelManager.open('hierarchy', this._panelWidth);
    }

    this.notify();
  }

  /**
   * Remove all overlay entries whose path falls under the given prefix
   * (i.e. the prefix itself OR `${prefix}/...`).
   *
   * Called when a LayoutObject is deleted so re-placing a catalog item
   * with the same root name doesn't inherit the previous instance's
   * sub-overlay state. Returns the number of paths purged (legacy path
   * only — SceneStore op-log entries are not retroactively rewritten;
   * they unwind via the standard undo/redo replay).
   */
  purgeOverlaysForSubtree(prefix: string): number {
    if (!this._overlay) return 0;
    const toDelete: string[] = [];
    for (const path of Object.keys(this._overlay.nodes)) {
      if (path === prefix || path.startsWith(prefix + '/')) toDelete.push(path);
    }
    for (const path of toDelete) delete this._overlay.nodes[path];
    // Also clear originals snapshot entries for the subtree
    const removedKeys: string[] = [];
    for (const key of this._originals.keys()) {
      if (key === prefix || key.startsWith(prefix + '/')) {
        removedKeys.push(key);
      }
    }
    for (const key of removedKeys) this._originals.delete(key);
    if (this._glbName && toDelete.length > 0) {
      saveOverlay(this._glbName, this._overlay);
      if (removedKeys.length > 0) removeOriginals(this._glbName, removedKeys);
    }
    if (toDelete.length > 0) this.notify();
    return toDelete.length;
  }

  /** Re-scan the scene for editable nodes. Call after adding/removing nodes with userData.realvirtual. */
  refreshEditableNodes(): void {
    if (!this._viewer) return;
    this._ancestorCache.clear();
    this._editableNodes = [];
    const registry = this._viewer.registry;
    if (!registry) return;
    this._viewer.scene.traverse((node) => {
      const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
      if (!rv) return;
      const types: string[] = [];
      for (const [key, value] of Object.entries(rv)) {
        if (isHiddenComponentType(key)) continue;
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          types.push(key);
        }
      }
      if (types.length === 0) return;
      const path = registry.getPathForNode(node);
      if (!path) return;
      this._editableNodes.push({ path, types });
    });
    this._editableNodes.sort((a, b) => a.path.localeCompare(b.path));
    this.notify();
  }

  onModelCleared(): void {
    // Unsubscribe viewer events
    for (const unsub of this._eventUnsubs) unsub();
    this._eventUnsubs.length = 0;

    // Unsubscribe from SceneStore
    if (this._sceneStoreUnsub) {
      this._sceneStoreUnsub();
      this._sceneStoreUnsub = null;
    }

    // Remove ancestor override
    if (this._layoutAncestorOverride && this._viewer?.raycastManager) {
      this._viewer.raycastManager.removeAncestorOverride(this._layoutAncestorOverride);
      this._layoutAncestorOverride = null;
    }

    this._editableNodes = [];
    this._overlay = null;
    this._selectedNodePath = null;
    this._viewer = null;
    this._glbName = null;
    this.notify();
  }

  dispose(): void {
    this.onModelCleared();
    this._listeners.clear();
  }
}
