// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * GhostManager — Manages the 3D model preview shown during click-to-place
 * and drag-and-drop in the Layout Planner.
 *
 * Loads the actual GLB model and renders it at full opacity. The "preview
 * highlight" visual (green outline) is provided by the viewer's OutlinePass
 * via RVOutlineManager — the planner subscribes to `onGhostStateChange` and
 * pushes the ghost root into the outline channel whenever it changes.
 */

import { Group, BoxGeometry, EdgesGeometry, LineSegments, LineBasicMaterial } from 'three';
import type { Object3D } from 'three';

import type { ModelCache } from './model-cache';
import { alignToFloor, pivotToFloorCenter } from './model-cache';
import type { LibraryCatalogEntry } from './rv-layout-store';
import { markNoAO } from '../../core/engine/rv-group-registry';

export class GhostManager {
  private _ghost: Object3D | null = null;
  private _entryId: string | null = null;
  private _loading = false;
  private _layoutRoot: Group;
  private _modelCache: ModelCache;

  /**
   * Optional callback invoked whenever the ghost root is shown, hidden,
   * or replaced. The planner uses this to refresh the outline channel.
   */
  onGhostStateChange: (() => void) | null = null;

  constructor(layoutRoot: Group, modelCache: ModelCache) {
    this._layoutRoot = layoutRoot;
    this._modelCache = modelCache;
  }

  /** Whether a ghost is currently visible. */
  get visible(): boolean {
    return this._ghost?.visible ?? false;
  }

  /** The current ghost root (or null). Used by the planner to outline it. */
  get ghost(): Object3D | null {
    return this._ghost;
  }

  /** The entry ID the current ghost was built for. */
  get entryId(): string | null {
    return this._entryId;
  }

  /**
   * Ensure the ghost preview matches the given catalog entry.
   * Loads the model asynchronously if needed (non-blocking).
   */
  async ensureForEntry(entry: LibraryCatalogEntry): Promise<void> {
    // Already have the right ghost
    if (this._entryId === entry.id && this._ghost) return;
    // Already loading this one
    if (this._loading && this._entryId === entry.id) return;

    this._loading = true;
    this._entryId = entry.id;

    try {
      // Remove old ghost (don't deep-dispose — it's a ModelCache clone)
      this._removeFromScene();

      let ghost: Object3D;

      if (entry.virtual && entry.gizmoSize) {
        // Virtual DES component — create wireframe box as ghost
        ghost = createVirtualGhost(entry.gizmoSize, entry.desType);
      } else {
        const clone = await this._modelCache.getOrLoad(entry.glbUrl ?? '');
        // Check if entry still matches (user may have switched during load)
        if (this._entryId !== entry.id) return;

        // Always center pivot to floor — GLB models may have arbitrary internal offsets
        pivotToFloorCenter(clone);
        alignToFloor(clone);

        // No material modifications — the ghost renders the GLB as-is.
        // The green "preview" highlight is drawn by RVOutlineManager
        // (post-process OutlinePass) — see LayoutPlannerPlugin._refreshOutline.
        ghost = clone;
      }

      ghost.userData._layoutObject = true;
      ghost.userData._isGhost = true;
      ghost.visible = false; // Hidden until positioned by pointer move
      // The drag-time ghost is transient placement UI: keep it out of SSAO so
      // it casts no AO halos on the floor while moving, but leave it in the
      // RenderPass (markNoAO, not markAsOverlay) so it stays depth-occluded and
      // its green OutlinePass highlight still works.
      markNoAO(ghost);
      this._layoutRoot.add(ghost);
      this._ghost = ghost;
      this.onGhostStateChange?.();
    } catch (err) {
      console.warn('[LayoutPlanner] Failed to load ghost preview:', err);
    } finally {
      this._loading = false;
    }
  }

  /** Position the ghost at the given floor coordinates and make visible. */
  setPosition(x: number, z: number): void {
    if (!this._ghost) return;
    this._ghost.position.x = x;
    this._ghost.position.z = z;
    const wasVisible = this._ghost.visible;
    this._ghost.visible = true;
    if (!wasVisible) this.onGhostStateChange?.();
  }

  /** Hide the ghost without disposing it (keeps it ready for next move). */
  hide(): void {
    if (this._ghost && this._ghost.visible) {
      this._ghost.visible = false;
      this.onGhostStateChange?.();
    }
  }

  /** Fully dispose the ghost and reset state. */
  dispose(): void {
    if (this._ghost) {
      // The ghost's mesh geometries belong to the ModelCache and must NOT
      // be disposed here.
      this._removeFromScene();
    }
    this._ghost = null;
    this._entryId = null;
    this.onGhostStateChange?.();
  }

  // ── Internal ──

  private _removeFromScene(): void {
    if (this._ghost?.parent) this._ghost.parent.remove(this._ghost);
    this._ghost = null;
  }
}

// ── Virtual component helpers ──

const DES_COLORS: Record<string, number> = {
  DESSource: 0x4caf50,     // green
  DESSink: 0xf44336,       // red
  DESConveyor: 0x2196f3,   // blue
  DESStation: 0xff9800,    // orange
  DESStorage: 0x9c27b0,    // purple
};

/** Create a wireframe box ghost for virtual DES components. */
function createVirtualGhost(gizmoSize: [number, number, number], desType?: string): Group {
  const MM_TO_M = 0.001;
  const [w, h, d] = gizmoSize.map(v => v * MM_TO_M);
  const color = DES_COLORS[desType ?? ''] ?? 0x4fc3f7;

  const group = new Group();
  const geo = new BoxGeometry(w, h, d);
  const edges = new EdgesGeometry(geo);
  const line = new LineSegments(edges, new LineBasicMaterial({ color, opacity: 0.6, transparent: true }));
  line.position.y = h / 2; // sit on floor
  line.renderOrder = 999;
  line.frustumCulled = false;
  group.add(line);
  geo.dispose(); // edges copied the data
  return group;
}

/**
 * Create a visible wireframe placeholder for a placed virtual DES component.
 * Called by the layout planner when placing a virtual entry.
 * The component class can override createGizmo() for custom visuals.
 */
export function createVirtualPlaceholder(gizmoSize: [number, number, number], desType?: string): Group {
  const MM_TO_M = 0.001;
  const [w, h, d] = gizmoSize.map(v => v * MM_TO_M);
  const color = DES_COLORS[desType ?? ''] ?? 0x4fc3f7;

  const group = new Group();
  const geo = new BoxGeometry(w, h, d);
  const edges = new EdgesGeometry(geo);
  const line = new LineSegments(edges, new LineBasicMaterial({ color, linewidth: 1 }));
  line.position.y = h / 2;
  line.frustumCulled = false;
  group.add(line);
  geo.dispose();
  return group;
}
