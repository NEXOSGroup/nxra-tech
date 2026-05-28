// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SnapMarkerRenderer — thin adapter over `viewer.gizmoManager` that creates
 * one sprite gizmo per snap point, plus a single active-hover gizmo.
 *
 * All the heavy lifting (material cache, raycast hookup, scene attachment,
 * dispose semantics) lives in {@link GizmoOverlayManager}. This class only:
 *
 *   1. Maintains the one-to-one map of `snap.id → GizmoHandle`.
 *   2. Forwards visibility / occupied / show-all toggles to the right handles.
 *   3. Owns the shared "circle + plus" CanvasTexture that paints the marker.
 *
 * Markers are parented to the snap-point Object3D so they follow whatever
 * placement, gizmo drag or undo moves the owner. They are excluded from
 * raycasting so they cannot steal hover events from the underlying scene.
 */

import {
  CanvasTexture,
  type Texture,
} from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { SnapPoint, SnapPointRegistry } from '../../core/engine/rv-snap-point-registry';
import type { GizmoHandle } from '../../core/engine/rv-gizmo-manager';

const IDLE_MARKER_SIZE_M = 0.15;
const ACTIVE_MARKER_SIZE_M = 0.22;
const OCCUPIED_OPACITY = 0.5;
const IDLE_OPACITY = 0.95;
const COLOR_IDLE = 0x4fc34f;        // planner green (matches the gizmo/outline)
const COLOR_OCCUPIED = 0x808080;    // grey for occupied
const COLOR_ACTIVE = 0x6dfc9c;      // lighter green for hover highlight
/** renderOrder above everything else; the active sprite sits one slot higher. */
const RENDER_ORDER_IDLE = 2000;
const RENDER_ORDER_ACTIVE = 2001;

/** Backing canvas texture (lazy, shared across every snap-point marker). */
let _sharedCircleTex: CanvasTexture | null = null;

function _getCircleTexture(): CanvasTexture {
  if (_sharedCircleTex) return _sharedCircleTex;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 8;
  const rInner = rOuter - 8;

  // Filled disc — the marker reads as a solid target dot. The SpriteMaterial
  // multiplies this white fill with its `color`, so the same texture serves
  // every state (idle blue, occupied grey, active green).
  ctx.beginPath();
  ctx.arc(cx, cy, rInner, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  // Slim outer ring at full opacity — gives a crisp silhouette against any
  // background. Rendered on the same white pixels so material tint applies.
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, rOuter - 4, 0, Math.PI * 2);
  ctx.stroke();

  // Dark "+" cut into the filled disc so it stays visible against the tinted
  // fill. Using globalCompositeOperation = 'destination-out' would erase the
  // disc; we instead draw with a semi-opaque dark color so the icon reads
  // regardless of the chosen marker tint.
  const plus = rInner * 0.55;
  ctx.lineWidth = 14;
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(15,30,55,0.85)';
  ctx.beginPath();
  ctx.moveTo(cx - plus, cy);
  ctx.lineTo(cx + plus, cy);
  ctx.moveTo(cx, cy - plus);
  ctx.lineTo(cx, cy + plus);
  ctx.stroke();

  const tex = new CanvasTexture(canvas);
  tex.needsUpdate = true;
  tex.anisotropy = 4;
  _sharedCircleTex = tex;
  return tex;
}

export class SnapMarkerRenderer {
  private readonly viewer: RVViewer;
  private readonly registry: SnapPointRegistry;

  /** Per-snap idle gizmo handle. */
  private handleBySnapId: Map<string, GizmoHandle> = new Map();
  /** Logical "this snap should be shown by proximity" state. */
  private visibleBySnapId: Map<string, boolean> = new Map();
  /** Last applied occupied state — used to decide whether `update()` is needed. */
  private occupiedBySnapId: Map<string, boolean> = new Map();

  /** Single gizmo handle for the active-hover highlight (re-created per hover). */
  private activeHandle: GizmoHandle | null = null;
  /** Snap currently shown as active — used to avoid redundant rebuilds. */
  private activeSnapId: string | null = null;

  private enabled = false;
  private showAllIdle = false;

  constructor(viewer: RVViewer, registry: SnapPointRegistry) {
    this.viewer = viewer;
    this.registry = registry;
  }

  /**
   * Recreate the per-snap gizmo set from the current registry. Cheap enough
   * to call on every placement; each handle is one sprite. Old handles are
   * disposed so GPU material refs stay bounded.
   */
  rebuild(_snapCount: number): void {
    this._teardown();

    const all = this.registry.getAll();
    if (all.length === 0) return;

    const tex = _getCircleTexture();
    const gizmoMgr = this.viewer.gizmoManager;

    for (const sp of all) {
      const handle = gizmoMgr.create(sp.object3D, {
        shape: 'sprite',
        color: sp.occupied ? COLOR_OCCUPIED : COLOR_IDLE,
        opacity: sp.occupied ? OCCUPIED_OPACITY : IDLE_OPACITY,
        spriteTexture: tex,
        worldSize: IDLE_MARKER_SIZE_M,
        attachToNode: true,
        excludeFromRaycast: true,
        depthTest: false,
        renderOrder: RENDER_ORDER_IDLE,
        // Start invisible until proximity-show or showAllIdle flips us on.
        visible: false,
      });
      this.handleBySnapId.set(sp.id, handle);
      this.visibleBySnapId.set(sp.id, false);
      this.occupiedBySnapId.set(sp.id, sp.occupied);
    }

    if (this.showAllIdle && this.enabled) this.refreshAll();
    this.viewer.markRenderDirty?.();
  }

  /** Sync internal indices when snaps are added/removed without rebuild. */
  syncToRegistry(): void {
    this.rebuild(this.registry.size);
  }

  /** Show/hide a single snap marker by id.
   *  Occupied snaps are NEVER shown — once a placement has taken the slot,
   *  the marker is suppressed entirely (the spot is no longer available). */
  setVisibility(snapId: string, visible: boolean): void {
    const handle = this.handleBySnapId.get(snapId);
    if (!handle) return;
    this.visibleBySnapId.set(snapId, visible);
    const sp = this.registry.getById(snapId);
    if (sp?.occupied) {
      handle.setVisible(false);
      return;
    }
    const effective = this.enabled && (this.showAllIdle || visible);
    handle.setVisible(effective);
  }

  /** Hide every idle marker. */
  hideAll(): void {
    for (const id of this.handleBySnapId.keys()) {
      this.setVisibility(id, false);
    }
  }

  /** Refresh every handle from registry state (occupied changes, mode flips).
   *  Occupied snaps are forced hidden regardless of the per-snap visible flag. */
  refreshAll(): void {
    for (const [id, handle] of this.handleBySnapId) {
      const sp = this.registry.getById(id);
      if (!sp) { handle.setVisible(false); continue; }
      this.occupiedBySnapId.set(id, sp.occupied);
      if (sp.occupied) { handle.setVisible(false); continue; }
      const visible = this.visibleBySnapId.get(id) ?? false;
      handle.setVisible(this.enabled && (this.showAllIdle || visible));
    }
    this.viewer.markRenderDirty?.();
  }

  /** Show the active highlight at the given snap. */
  showActive(snap: SnapPoint): void {
    if (!this.enabled) return;
    if (this.activeSnapId === snap.id && this.activeHandle) {
      this.activeHandle.setVisible(true);
      return;
    }
    // Rebuild whenever the hovered snap changes — gizmos are parented to a
    // specific node, so re-targeting means a fresh handle.
    if (this.activeHandle) {
      this.activeHandle.dispose();
      this.activeHandle = null;
    }
    this.activeHandle = this.viewer.gizmoManager.create(snap.object3D, {
      shape: 'sprite',
      color: COLOR_ACTIVE,
      opacity: 1.0,
      spriteTexture: _getCircleTexture(),
      worldSize: ACTIVE_MARKER_SIZE_M,
      attachToNode: true,
      excludeFromRaycast: true,
      depthTest: false,
      renderOrder: RENDER_ORDER_ACTIVE,
      visible: true,
    });
    this.activeSnapId = snap.id;
    this.viewer.markRenderDirty?.();
  }

  /** Hide the active highlight. */
  hideActive(): void {
    if (this.activeHandle) {
      this.activeHandle.setVisible(false);
      this.viewer.markRenderDirty?.();
    }
  }

  /** Enable/disable the entire renderer (e.g. mode switch). */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (on) this.refreshAll();
    else {
      // Hide everything without losing the logical visibility state.
      for (const handle of this.handleBySnapId.values()) handle.setVisible(false);
      this.hideActive();
    }
    this.viewer.markRenderDirty?.();
  }

  /** Toggle "always show idle markers" mode. */
  setShowAllIdle(on: boolean): void {
    if (this.showAllIdle === on) return;
    this.showAllIdle = on;
    this.refreshAll();
  }

  /** Update occupied state. Occupied snaps are hidden entirely (no separate
   *  "greyed out" style — the slot is gone). When freed, the marker only
   *  reappears via the next setVisibility/refreshAll cycle. */
  setOccupied(snapId: string, occupied: boolean): void {
    this.occupiedBySnapId.set(snapId, occupied);
    const handle = this.handleBySnapId.get(snapId);
    if (!handle) return;
    if (occupied) {
      handle.setVisible(false);
    } else {
      const visible = this.visibleBySnapId.get(snapId) ?? false;
      handle.setVisible(this.enabled && (this.showAllIdle || visible));
    }
  }

  /** Full dispose — call on plugin teardown or model unload. */
  dispose(): void {
    this._teardown();
    if (this.activeHandle) {
      this.activeHandle.dispose();
      this.activeHandle = null;
    }
    this.activeSnapId = null;
    // The shared CanvasTexture stays alive across re-inits (module-level
    // singleton). Disposing it would leave the next plugin instance with a
    // dead reference; the few-KB texture is fine to keep until page reload.
  }

  // ── Test helpers ───────────────────────────────────────────────────

  /** Returns the GizmoHandle for the given snap id, or undefined. */
  getHandleFor(snapId: string): GizmoHandle | undefined {
    return this.handleBySnapId.get(snapId);
  }
  /** Returns the currently-hovered snap id, or null. */
  getActiveSnapId(): string | null { return this.activeSnapId; }
  /** Currently in "always show idle" mode? */
  isShowAllIdle(): boolean { return this.showAllIdle; }
  /** Renderer enabled (planner mode)? */
  isEnabled(): boolean { return this.enabled; }
  /** Test helper — current number of idle handles. */
  getIdleHandleCount(): number { return this.handleBySnapId.size; }

  // ── Internals ──────────────────────────────────────────────────────

  private _teardown(): void {
    for (const handle of this.handleBySnapId.values()) {
      handle.dispose();
    }
    this.handleBySnapId.clear();
    this.visibleBySnapId.clear();
    this.occupiedBySnapId.clear();
  }
}

/** Test-only helper: drop the shared texture (caller's responsibility to
 *  ensure no live renderer still references it). Module-level so test
 *  isolation can avoid texture re-use across suites. */
export function _disposeSharedCircleTexture(): void {
  _sharedCircleTex?.dispose();
  _sharedCircleTex = null;
}

/** Test-only export so suites can assert on cached texture state. */
export function _getSharedCircleTextureForTest(): Texture | null {
  return _sharedCircleTex;
}
