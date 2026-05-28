// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * canvas-interaction.ts — Canvas event handling for the Layout Planner.
 *
 * Extracted from the monolithic _wireCanvasEvents() closure in index.ts.
 * Owns all pointer, keyboard, drag-over/drop, blur/visibility listeners
 * that operate on the 3D canvas while the planner is active.
 */

import { Raycaster, Vector2, Vector3 } from 'three';
import type { Object3D, Mesh } from 'three';

import type { RVViewer } from '../../core/rv-viewer';
import { DRAG_THRESHOLD_PX } from '../../core/engine/rv-constants';
import { pointerToNDC } from '../../core/engine/rv-pointer-utils';
import { getLayoutDragData } from './drag-types';
import { type LibraryCatalogEntry, type LayoutStore } from './rv-layout-store';
import type { GhostManager } from './ghost-manager';
import type { FloorGizmo } from './floor-gizmo';
import { findLayoutAncestor, isLockedLayoutInstance } from './layout-predicates';
import type { BoxSelectController } from './box-select-controller';
import type { BboxSnapController } from './bbox-snap';
import type { SnapPointPlugin } from '../snap-point';
import {
  findBestGhostSnap,
  applyGhostSnapAlignment,
  type GhostSnapMatch,
} from '../snap-point/ghost-snap-match';
import { DEFAULT_MAGNET_RADIUS_M } from '../snap-point/snap-magnetic-controller';
import type { SnapPoint } from '../../core/engine/rv-snap-point-registry';

// ─── Dependency interface ────────────────────────────────────────────

export interface CanvasInteractionDeps {
  viewer: RVViewer;
  store: LayoutStore;
  canvas: HTMLCanvasElement;
  objectMap: ReadonlyMap<string, Object3D>;
  idByObject: WeakMap<Object3D, string>;
  ghost: GhostManager;
  floorPlane: Mesh;
  transformControls: FloorGizmo | null;
  modelRoot: Object3D | null;
  getPlacementEntry(): LibraryCatalogEntry | null;
  setDragEntry(entry: LibraryCatalogEntry | null): void;
  getDragEntry(): LibraryCatalogEntry | null;
  placeComponent(entry: LibraryCatalogEntry, pos: [number, number, number]): Promise<string>;
  placeAtSnap(entry: LibraryCatalogEntry, target: SnapPoint, ownSnapName: string): Promise<string | null>;
  removeSelected(): void;
  duplicateSelected(): Promise<string | null>;
  copySelected(): number;
  pasteClipboard(): Promise<string[]>;
  selectObjectById(id: string | null): void;
  isActive(): boolean;
  /** Marquee (rubber-band) controller. Owned by the planner, used here to
   *  start a marquee drag when pointer-down lands on empty canvas. */
  boxSelect: BoxSelectController;
  /** Magnetic bbox snap controller, shared with FloorGizmo via the gizmo's
   *  custom-snap callback. Used here to snap the ghost during drag-in /
   *  click-to-place so the preview matches the post-place re-drag behaviour. */
  bboxSnap: BboxSnapController;
}

// ─── Manager ─────────────────────────────────────────────────────────

interface DragCandidate {
  target: Object3D;
  path: string;
  startX: number;
  startY: number;
  started: boolean;
}

export class CanvasInteractionManager {
  private _unsubs: (() => void)[] = [];

  // Own pre-allocated vectors — NOT shared with MultiSelectPivot
  private _raycaster = new Raycaster();
  private _mouse = new Vector2();
  // dragCandidate migrated from _wireCanvasEvents closure scope to instance field
  private _dragCandidate: DragCandidate | null = null;

  constructor(private deps: CanvasInteractionDeps) {}

  /**
   * Arm bbox magnetic snap for the current ghost the first time a valid
   * drag-over / placement-mode move produces a floor hit. Idempotent — the
   * controller's own `isArmed` guard skips repeat calls. The controller
   * self-checks `store.bboxSnapEnabled`, so toggling the toolbar button
   * mid-drag takes effect on the next pointer-move.
   */
  private _armBboxForGhost(): void {
    const ghostNode = this.deps.ghost.ghost;
    if (!ghostNode) return;
    if (this.deps.bboxSnap.isArmed) return;
    this.deps.bboxSnap.armForDrag(ghostNode);
  }

  /** Disarm bbox snap if armed. Idempotent. */
  private _disarmBbox(): void {
    if (this.deps.bboxSnap.isArmed) this.deps.bboxSnap.disarm();
  }

  /**
   * Snap-point magnetic alignment for the placement ghost.
   *
   * Resets the ghost to its baseline pose (Y=0, identity rotation) so the
   * previous frame's snap doesn't carry over when the cursor moves out of
   * range, then probes for the nearest compatible scene-snap. If a match
   * is found, the ghost's transform is overwritten with the snap-aligned
   * matrix and the match is returned for the drop handler to forward to
   * `placeAtSnap`. Returns null when no snap is in range OR the
   * snap-point plugin isn't installed.
   */
  private _tryGhostSnapAlignment(): GhostSnapMatch | null {
    const ghostRoot = this.deps.ghost.ghost;
    if (!ghostRoot) return null;
    const snapPlugin = this.deps.viewer.getPlugin<SnapPointPlugin>('snap-point');
    const registry = snapPlugin?.getRegistry();
    if (!registry || registry.size === 0) return null;

    // Reset to baseline: floor-Y, no rotation. setPosition has already set X/Z.
    ghostRoot.position.y = 0;
    ghostRoot.rotation.set(0, 0, 0);
    ghostRoot.updateMatrixWorld(true);

    const match = findBestGhostSnap(ghostRoot, registry, DEFAULT_MAGNET_RADIUS_M);
    if (!match) return null;
    applyGhostSnapAlignment(ghostRoot, match);
    return match;
  }

  /**
   * Apply bbox + grid snap to a raw floor-hit XZ point. Mirrors the
   * FloorGizmo's per-axis priority: bbox magnetic snap claims an axis when
   * it finds a target within tolerance; grid quantises any axis the bbox
   * snap leaves alone. Returns the snapped (x, z) as a 2-tuple.
   *
   * Returns the input unchanged when both snaps are off / inactive.
   */
  private _snapXZ(rawX: number, rawZ: number): [number, number] {
    let nx = rawX;
    let nz = rawZ;
    // applySnap returns null when not armed, bboxSnapEnabled is off, Alt is
    // held, or no targets are in range.
    const custom = this.deps.bboxSnap.applySnap(nx, nz, 'free');
    if (custom?.snappedX) nx = custom.x;
    if (custom?.snappedZ) nz = custom.z;
    if (this.deps.store.gridEnabled) {
      const step = this.deps.store.gridSizeMm / 1000;
      if (step > 0) {
        if (!custom?.snappedX) nx = Math.round(nx / step) * step;
        if (!custom?.snappedZ) nz = Math.round(nz / step) * step;
      }
    }
    return [nx, nz];
  }

  /** Wire all canvas/document/window events. Call once after model loaded. */
  wire(): void {
    const { viewer, canvas, store, ghost, floorPlane } = this.deps;

    const DIRECT_DRAG_THRESHOLD_SQ = DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX;

    // ── Direct-drag translation on layout objects, OR marquee on empty canvas ──
    //
    // Single pointer-down handler so we don't race with a separate listener.
    // Decision tree:
    //   1. Placement-mode active   → fall through to onPointerUp's place flow.
    //   2. Modifier key held       → fall through (Shift/Ctrl reserved for the
    //                                marquee modifiers AT RELEASE time, but NOT
    //                                for arming a direct-drag).
    //   3. Pointer-down on a layout instance → arm direct-drag (existing behavior).
    //   4. Else (empty canvas)     → start the marquee.
    const onDirectPointerDown = (e: PointerEvent) => {
      if (!this.deps.isActive() || e.button !== 0) return;
      if (this.deps.getPlacementEntry()) return;

      // The FloorGizmo registers its own `pointerdown` listener on the same
      // canvas BEFORE this manager wires up (planner constructs the gizmo
      // first). When the user clicks on a gizmo handle, the gizmo's handler
      // synchronously sets `_dragging` — so by the time we run, isDragging
      // already reflects the gesture. Bail out to keep the marquee from
      // starting underneath the in-flight transform drag.
      if (this.deps.transformControls?.isDragging) return;

      const layoutObjs = [...this.deps.objectMap.values()];

      // Resolve a layout-instance hit (if any) up front. The result determines
      // whether we arm direct-drag OR start a marquee.
      let hitRoot: Object3D | null = null;
      let hitPath: string | null = null;
      if (layoutObjs.length > 0) {
        pointerToNDC(e.clientX, e.clientY, canvas, this._mouse);
        this._raycaster.setFromCamera(this._mouse, viewer.camera);
        const hits = this._raycaster.intersectObjects(layoutObjs, true);
        if (hits.length > 0) {
          const root = findLayoutAncestor(hits[0].object);
          if (root && !isLockedLayoutInstance(root)) {
            const p = viewer.registry?.getPathForNode(root) ?? null;
            if (p) { hitRoot = root; hitPath = p; }
          }
        }
      }

      // Modifier-held (Shift/Ctrl/Meta) on a layout instance: do nothing — let
      // the global selection pipeline handle add/toggle on click. We can't arm
      // direct-drag because Shift+drag means "add to marquee selection" and
      // would be ambiguous if it ALSO moved the object.
      if (hitRoot && (e.shiftKey || e.ctrlKey || e.metaKey)) return;

      if (hitRoot && hitPath) {
        this._dragCandidate = {
          target: hitRoot, path: hitPath,
          startX: e.clientX, startY: e.clientY,
          started: false,
        };
        viewer.controls.enabled = false;
        return;
      }

      // No layout hit → empty canvas → marquee.
      this.deps.boxSelect.start(e);
    };

    const onDirectPointerMove = (e: PointerEvent) => {
      if (!this._dragCandidate || this._dragCandidate.started) return;
      const dx = e.clientX - this._dragCandidate.startX;
      const dy = e.clientY - this._dragCandidate.startY;
      if (dx * dx + dy * dy < DIRECT_DRAG_THRESHOLD_SQ) return;

      this._dragCandidate.started = true;

      const snap = viewer.selectionManager.getSnapshot();
      if (!snap.selectedPaths.includes(this._dragCandidate.path)) {
        viewer.selectionManager.select(this._dragCandidate.path);
      }

      this.deps.transformControls?.beginExternalDrag(e, 'disc');
    };

    const onDirectPointerUp = (_e: PointerEvent) => {
      if (!this._dragCandidate) return;
      viewer.controls.enabled = true;
      this._dragCandidate = null;
    };

    canvas.addEventListener('pointerdown', onDirectPointerDown);
    canvas.addEventListener('pointermove', onDirectPointerMove);
    window.addEventListener('pointerup', onDirectPointerUp);
    this._unsubs.push(
      () => canvas.removeEventListener('pointerdown', onDirectPointerDown),
      () => canvas.removeEventListener('pointermove', onDirectPointerMove),
      () => window.removeEventListener('pointerup', onDirectPointerUp),
    );

    // ── Pointer click for click-to-place mode only ──
    const onPointerUp = (e: PointerEvent) => {
      if (!this.deps.isActive()) return;
      if (e.button !== 0) return;

      const placementEntry = this.deps.getPlacementEntry();
      if (!placementEntry) return;

      pointerToNDC(e.clientX, e.clientY, canvas, this._mouse);
      this._raycaster.setFromCamera(this._mouse, viewer.camera);

      const floorHits = this._raycaster.intersectObject(floorPlane);
      if (floorHits.length > 0) {
        const [nx, nz] = this._snapXZ(floorHits[0].point.x, floorHits[0].point.z);
        // Position the ghost first so snap-point can probe from the final
        // cursor location.
        ghost.setPosition(nx, nz);
        const snapMatch = this._tryGhostSnapAlignment();
        const pos: [number, number, number] = [nx, 0, nz];
        // Disarm BEFORE placing — placeComponent / placeAtSnap register the
        // new object in _objectMap, which would otherwise contaminate the
        // next snap arm.
        this._disarmBbox();
        if (snapMatch) {
          this.deps.placeAtSnap(placementEntry, snapMatch.targetSnap, snapMatch.ghostSnap.name)
            .catch(err => console.error('[LayoutPlanner] Failed to snap-place:', err));
        } else {
          this.deps.placeComponent(placementEntry, pos).catch(err =>
            console.error('[LayoutPlanner] Failed to place:', err),
          );
        }
      }
    };

    canvas.addEventListener('pointerup', onPointerUp);
    this._unsubs.push(() => canvas.removeEventListener('pointerup', onPointerUp));

    // ── Mouse move for ghost preview in placement mode ──
    const onPointerMove = (e: PointerEvent) => {
      if (!this.deps.isActive()) return;
      const placementEntry = this.deps.getPlacementEntry();
      if (!placementEntry) {
        if (ghost.visible) {
          ghost.hide();
          this._disarmBbox();
          viewer.markRenderDirty();
        }
        return;
      }

      ghost.ensureForEntry(placementEntry);

      pointerToNDC(e.clientX, e.clientY, canvas, this._mouse);
      this._raycaster.setFromCamera(this._mouse, viewer.camera);

      const floorHits = this._raycaster.intersectObject(floorPlane);
      if (floorHits.length > 0) {
        // Arm magnetic bbox snap on the first valid floor-hit — captures the
        // ghost's AABB and freezes every other placed object's AABB so the
        // ghost can magnetise to nearby placements just like a re-drag does.
        this._armBboxForGhost();
        const [nx, nz] = this._snapXZ(floorHits[0].point.x, floorHits[0].point.z);
        ghost.setPosition(nx, nz);
        // Snap-point overrides bbox/grid when a compatible scene snap is in
        // range — same precedence as the FloorGizmo's re-drag path.
        this._tryGhostSnapAlignment();
        viewer.markRenderDirty();
      }
    };

    canvas.addEventListener('pointermove', onPointerMove);
    this._unsubs.push(() => canvas.removeEventListener('pointermove', onPointerMove));

    // ── Keyboard shortcuts ──
    const onKeyDown = (e: KeyboardEvent) => {
      if (!this.deps.isActive()) return;
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      switch (e.key) {
        case 'g':
        case 'G':
          store.setMode('translate');
          break;
        case 'r':
        case 'R':
          store.setMode('rotate');
          break;
        case 'Delete':
        case 'Backspace':
          this.deps.removeSelected();
          break;
        case 'Escape':
          this.deps.selectObjectById(null);
          store.setPlacementMode(null);
          ghost.hide();
          this._disarmBbox();
          viewer.markRenderDirty();
          break;
        case 'd':
        case 'D':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            this.deps.duplicateSelected();
          }
          break;
        case 'c':
        case 'C':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            this.deps.copySelected();
          }
          break;
        case 'v':
        case 'V':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            this.deps.pasteClipboard();
          }
          break;
      }
    };

    document.addEventListener('keydown', onKeyDown);
    this._unsubs.push(() => document.removeEventListener('keydown', onKeyDown));

    // ── HTML5 Drag & Drop ──
    //
    // Snap behaviour during drag-in matches the post-place re-drag exactly:
    // bbox magnetic snap claims any axis where it finds a target within
    // tolerance (tracked via the shared BboxSnapController, the same one the
    // FloorGizmo's custom-snap callback invokes), and grid quantises the
    // remaining axes. Without this, the ghost only grid-snapped during the
    // initial drag-in and the user had to drop + re-drag to get magnetic
    // alignment to existing placements.
    const onDragOver = (e: DragEvent) => {
      if (!this.deps.isActive() || !this.deps.getDragEntry()) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';

      ghost.ensureForEntry(this.deps.getDragEntry()!);

      pointerToNDC(e.clientX, e.clientY, canvas, this._mouse);
      this._raycaster.setFromCamera(this._mouse, viewer.camera);
      const hits = this._raycaster.intersectObject(floorPlane);

      if (hits.length > 0) {
        // Arm magnetic bbox snap on the first valid floor-hit (idempotent —
        // the controller's `isArmed` guard skips repeat calls).
        this._armBboxForGhost();
        const [nx, nz] = this._snapXZ(hits[0].point.x, hits[0].point.z);
        ghost.setPosition(nx, nz);
        // Snap-point overrides bbox/grid when a compatible scene snap is in
        // range — same precedence as the post-place re-drag path.
        this._tryGhostSnapAlignment();
        viewer.markRenderDirty();
      }
    };

    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) {
        ghost.hide();
        this._disarmBbox();
        viewer.markRenderDirty();
      }
    };

    const onDrop = async (e: DragEvent) => {
      if (!this.deps.isActive()) return;
      e.preventDefault();

      const dragData = e.dataTransfer ? getLayoutDragData(e.dataTransfer) : null;
      if (!dragData || !dragData.glbUrl) {
        ghost.hide();
        this._disarmBbox();
        return;
      }
      const { catalogId, glbUrl, entryName, category: categoryStr } = dragData;

      pointerToNDC(e.clientX, e.clientY, canvas, this._mouse);
      this._raycaster.setFromCamera(this._mouse, viewer.camera);
      const hits = this._raycaster.intersectObject(floorPlane);

      let pos: [number, number, number] = [0, 0, 0];
      let snapMatch: GhostSnapMatch | null = null;
      if (hits.length > 0) {
        const [nx, nz] = this._snapXZ(hits[0].point.x, hits[0].point.z);
        pos = [nx, 0, nz];
        // Re-evaluate snap-point at the drop frame so the placement uses the
        // exact same alignment the user saw in the ghost. Position the ghost
        // first so the matcher reads the final cursor location.
        ghost.setPosition(nx, nz);
        snapMatch = this._tryGhostSnapAlignment();
      }

      // Hide ghost AFTER reading its final pose. Disarm BEFORE placing —
      // placeComponent / placeAtSnap register the new object in _objectMap,
      // which would otherwise be picked up as a snap target by the next arm
      // cycle.
      ghost.hide();
      this._disarmBbox();

      const entry: LibraryCatalogEntry = {
        id: catalogId,
        name: entryName || catalogId,
        category: (categoryStr as LibraryCatalogEntry['category']) || 'custom',
        glbUrl,
        thumbnailUrl: '',
      };

      try {
        if (snapMatch) {
          await this.deps.placeAtSnap(entry, snapMatch.targetSnap, snapMatch.ghostSnap.name);
        } else {
          await this.deps.placeComponent(entry, pos);
        }
      } catch (err) {
        console.error('[LayoutPlanner] Failed to place component:', err);
      }

      this.deps.setDragEntry(null);
    };

    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);
    this._unsubs.push(() => document.removeEventListener('dragover', onDragOver));
    this._unsubs.push(() => document.removeEventListener('dragleave', onDragLeave));
    this._unsubs.push(() => document.removeEventListener('drop', onDrop));

    // ── Blur/visibility handlers to restore controls ──
    const onBlur = () => {
      viewer.controls.enabled = true;
    };
    const onVisChange = () => {
      if (document.hidden) {
        viewer.controls.enabled = true;
      }
    };

    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisChange);
    this._unsubs.push(() => window.removeEventListener('blur', onBlur));
    this._unsubs.push(() => document.removeEventListener('visibilitychange', onVisChange));
  }

  /** Remove all event listeners registered by wire(). */
  dispose(): void {
    for (const unsub of this._unsubs) unsub();
    this._unsubs.length = 0;
    this._dragCandidate = null;
    // Drop bbox snap arm + its window keydown/keyup listeners — leaving
    // them attached would leak across plugin re-init.
    this._disarmBbox();
  }
}
