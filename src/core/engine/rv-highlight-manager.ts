// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVHighlightManager — Central highlight system for the WebViewer.
 *
 * Two independent highlight channels:
 *   - **Hover** (orange): Temporary overlays shown on mouse hover.
 *     Managed by RaycastManager. Call highlight()/clear().
 *   - **Selection** (cyan): Persistent overlays for selected objects.
 *     Managed by SelectionManager. Call highlightSelection()/clearSelection().
 *
 * Both channels can be active simultaneously — hovering a different object
 * while a selection is active shows both colors.
 *
 * Two tracking modes per channel:
 *   - static snapshot (fast, for brief hover)
 *   - tracked: overlays follow moving meshes each frame
 */

import {
  Mesh,
  Color,
  MeshBasicMaterial,
  LineBasicMaterial,
  EdgesGeometry,
  LineSegments,
  Object3D,

  Matrix4,
  Box3,
  Box3Helper,
  BufferGeometry,
  Float32BufferAttribute,
} from 'three';
import type { Scene } from 'three';
import type { InstancedMovingUnit } from './rv-mu';
import { HIGHLIGHT_OVERLAY_LAYER } from './rv-group-registry';
import type { RVOutlineManager } from './rv-outline-manager';

// ─── Highlight Style ──────────────────────────────────────────────────

/**
 * Per-channel highlight appearance. Used by `setSelectionStyle` and
 * `setHoverStyle` to swap colors/opacity/wireframe for the current mode
 * (e.g. planner mode uses green wireframe instead of cyan fill).
 */
export interface HighlightStyle {
  /** Overlay fill color (hex). */
  overlayColor: number;
  /** Overlay opacity in [0..1]. */
  overlayOpacity: number;
  /** When true, render the overlay as a triangle wireframe (every edge). */
  overlayWireframe: boolean;
  /** Edge outline color (hex). */
  edgeColor: number;
  /** Edge outline opacity in [0..1]. */
  edgeOpacity: number;
  /** Edge line width (mostly ignored on WebGL — kept for completeness). */
  edgeLinewidth?: number;
  /** When false, the overlay fill mesh is not created. */
  showOverlay: boolean;
  /** When false, the silhouette edge LineSegments are not created. */
  showEdges: boolean;
}

/** Default hover style — vivid orange. The edgeColor is what the OutlinePass
 *  silhouette uses; overlayColor matters only on WebGPU fallback. */
export const DEFAULT_HOVER_STYLE: HighlightStyle = Object.freeze({
  overlayColor: 0xff8800,
  overlayOpacity: 0.10,
  overlayWireframe: false,
  edgeColor: 0xff8800,
  edgeOpacity: 0.4,
  edgeLinewidth: 1,
  showOverlay: true,
  showEdges: true,
});

/** Default selection style — vivid cyan/blue. */
export const DEFAULT_SELECTION_STYLE: HighlightStyle = Object.freeze({
  overlayColor: 0x00bfff,
  overlayOpacity: 0.25,
  overlayWireframe: false,
  edgeColor: 0x00bfff,
  edgeOpacity: 0.8,
  edgeLinewidth: 1,
  showOverlay: true,
  showEdges: true,
});

// ─── Constants ────────────────────────────────────────────────────────

const EDGE_THRESHOLD_DEG = 30;

/** Default max meshes for hover highlight — above this, show bounding-box wireframe instead. */
const DEFAULT_MAX_HOVER_MESHES = 200;

/** WeakMap cache for EdgesGeometry — avoids recomputing edges for the same BufferGeometry */
const edgeGeometryCache = new WeakMap<BufferGeometry, EdgesGeometry>();

// ─── Overlay Pair (fill + edge linked to source mesh) ────────────────

interface OverlayPair {
  source: Mesh;
  /** Null when the active style has `showOverlay: false`. */
  fill: Mesh | null;
  /** Null when the active style has `showEdges: false`. */
  edge: LineSegments | null;
}

// ─── RVHighlightManager ──────────────────────────────────────────────

export class RVHighlightManager {
  /** Hover overlay pairs. */
  private hoverPairs: OverlayPair[] = [];
  /** Selection overlay pairs (persistent). */
  private selectionPairs: OverlayPair[] = [];
  /** When true, update() re-syncs hover overlay matrices from source meshes. */
  private hoverTracked = false;
  /** When true, update() re-syncs selection overlay matrices. */
  private selectionTracked = false;

  /** Max meshes before falling back to bounding-box wireframe. */
  maxHoverMeshes = DEFAULT_MAX_HOVER_MESHES;

  /** Active hover style (defaults to DEFAULT_HOVER_STYLE). */
  private _hoverStyle: HighlightStyle = { ...DEFAULT_HOVER_STYLE };
  /** Active selection style (defaults to DEFAULT_SELECTION_STYLE). */
  private _selectionStyle: HighlightStyle = { ...DEFAULT_SELECTION_STYLE };

  /** Materials built from the current styles. Recreated on style change. */
  private _hoverOverlayMat: MeshBasicMaterial;
  private _hoverEdgeMat: LineBasicMaterial;
  private _selectionOverlayMat: MeshBasicMaterial;
  private _selectionEdgeMat: LineBasicMaterial;

  /**
   * Optional outline-pass manager. When set and `available`, the standard
   * hover/selection paths render as a true OutlinePass silhouette (the same
   * look the layout planner uses for its selection) instead of building
   * overlay fill + edge meshes per highlighted node. Special cases that the
   * outline pass can't handle (instanced MU slots, the dense-mesh
   * bounding-box fallback) keep using the overlay path regardless.
   */
  private _outlineManager: RVOutlineManager | null = null;

  constructor(private readonly scene: Scene) {
    this._hoverOverlayMat = this._buildOverlayMat(this._hoverStyle, '_hoverOverlay');
    this._hoverEdgeMat = this._buildEdgeMat(this._hoverStyle);
    this._selectionOverlayMat = this._buildOverlayMat(this._selectionStyle, '_selectionOverlay');
    this._selectionEdgeMat = this._buildEdgeMat(this._selectionStyle);
  }

  /**
   * Wire up the outline-pass manager. Called once during viewer
   * construction. After this, hover/selection highlights render as
   * OutlinePass silhouettes, honoring the current style edge colors.
   */
  setOutlineManager(om: RVOutlineManager | null): void {
    this._outlineManager = om;
    if (om) {
      om.setStyle(outlineFromHighlightColor(this._selectionStyle.edgeColor));
      om.setHoverStyle(outlineFromHighlightColor(this._hoverStyle.edgeColor));
    }
  }

  /** True when the outline pass is wired up and the renderer supports it (WebGL). */
  private _useOutline(): boolean {
    return !!this._outlineManager && this._outlineManager.available;
  }

  // ─── Style API ───────────────────────────────────────────────────────

  /**
   * Replace the selection highlight style. Pass null to revert to default cyan.
   * Callers should clearSelection() first — existing selection overlays are
   * not retroactively re-styled (they reference the old materials until cleared).
   */
  setSelectionStyle(style: HighlightStyle | null): void {
    this._selectionOverlayMat.dispose();
    this._selectionEdgeMat.dispose();
    this._selectionStyle = style ? { ...style } : { ...DEFAULT_SELECTION_STYLE };
    this._selectionOverlayMat = this._buildOverlayMat(this._selectionStyle, '_selectionOverlay');
    this._selectionEdgeMat = this._buildEdgeMat(this._selectionStyle);
    // Mirror the edge color into the outline pass so the silhouette matches
    // the new style. Both the visible and the hidden edge color are pushed:
    // OutlinePass uses hiddenEdgeColor for occluded parts, and the default
    // is green — which would show as a second green outline through
    // occluding geometry when the visible color is anything else.
    // Plugins (e.g. layout planner) may follow up with a more specific
    // outlineManager.setStyle() — that call wins.
    this._outlineManager?.setStyle(outlineFromHighlightColor(this._selectionStyle.edgeColor));
  }

  /**
   * Replace the hover highlight style. Pass null to revert to default orange.
   * Existing hover overlays are not retroactively re-styled.
   */
  setHoverStyle(style: HighlightStyle | null): void {
    this._hoverOverlayMat.dispose();
    this._hoverEdgeMat.dispose();
    this._hoverStyle = style ? { ...style } : { ...DEFAULT_HOVER_STYLE };
    this._hoverOverlayMat = this._buildOverlayMat(this._hoverStyle, '_hoverOverlay');
    this._hoverEdgeMat = this._buildEdgeMat(this._hoverStyle);
    this._outlineManager?.setHoverStyle(outlineFromHighlightColor(this._hoverStyle.edgeColor));
  }

  /** Read the current active selection style (frozen copy). */
  getSelectionStyle(): Readonly<HighlightStyle> {
    return this._selectionStyle;
  }

  /** Read the current active hover style (frozen copy). */
  getHoverStyle(): Readonly<HighlightStyle> {
    return this._hoverStyle;
  }

  // ─── Private helpers ─────────────────────────────────────────────────

  private _buildOverlayMat(style: HighlightStyle, name: string): MeshBasicMaterial {
    const mat = new MeshBasicMaterial({
      color: style.overlayColor,
      transparent: style.overlayOpacity < 1.0,
      opacity: style.overlayOpacity,
      wireframe: style.overlayWireframe,
      depthTest: false,
      depthWrite: false,
    });
    mat.name = name;
    return mat;
  }

  private _buildEdgeMat(style: HighlightStyle): LineBasicMaterial {
    return new LineBasicMaterial({
      color: style.edgeColor,
      transparent: style.edgeOpacity < 1.0,
      opacity: style.edgeOpacity,
      linewidth: style.edgeLinewidth ?? 1,
      depthTest: false,
      depthWrite: false,
    });
  }

  /**
   * Create a fill overlay + edge outline pair for a single geometry,
   * positioned via `matrix`. Accepts materials and show flags so it can serve
   * both hover and selection channels with their respective styles.
   */
  private _createOverlayPair(
    geometry: BufferGeometry,
    matrix: Matrix4,
    sourceMesh: Mesh,
    namePrefix: string,
    thresholdRad: number,
    fillMat: MeshBasicMaterial,
    edgeMaterial: LineBasicMaterial,
    renderOrderBase: number,
    showOverlay: boolean,
    showEdges: boolean,
  ): OverlayPair {
    let overlay: Mesh | null = null;
    if (showOverlay) {
      overlay = new Mesh(geometry, fillMat);
      overlay.name = `${namePrefix}_hlOverlay`;
      overlay.userData._highlightOverlay = true;
      overlay.renderOrder = renderOrderBase;
      overlay.raycast = () => {};
      overlay.matrixAutoUpdate = false;
      overlay.matrixWorldAutoUpdate = false;
      overlay.matrix.copy(matrix);
      overlay.matrixWorld.copy(matrix);
      overlay.layers.set(HIGHLIGHT_OVERLAY_LAYER);
      this.scene.add(overlay);
    }

    let edgeLines: LineSegments | null = null;
    if (showEdges) {
      let edgeGeo = edgeGeometryCache.get(geometry);
      if (!edgeGeo) {
        edgeGeo = new EdgesGeometry(geometry, thresholdRad);
        edgeGeometryCache.set(geometry, edgeGeo);
      }
      edgeLines = new LineSegments(edgeGeo, edgeMaterial);
      edgeLines.name = `${namePrefix}_hlEdge`;
      edgeLines.userData._highlightOverlay = true;
      edgeLines.renderOrder = renderOrderBase + 1;
      edgeLines.raycast = () => {};
      edgeLines.matrixAutoUpdate = false;
      edgeLines.matrixWorldAutoUpdate = false;
      edgeLines.matrix.copy(matrix);
      edgeLines.matrixWorld.copy(matrix);
      edgeLines.layers.set(HIGHLIGHT_OVERLAY_LAYER);
      this.scene.add(edgeLines);
    }

    return { source: sourceMesh, fill: overlay, edge: edgeLines };
  }

  /** Remove overlay pairs from the scene. */
  private _removePairs(pairs: OverlayPair[]): void {
    for (const { fill, edge } of pairs) {
      if (fill) this.scene.remove(fill);
      if (edge) this.scene.remove(edge);
    }
    pairs.length = 0;
  }

  /** Sync tracked overlay positions. */
  private _syncPairs(pairs: OverlayPair[]): void {
    for (const { source, fill, edge } of pairs) {
      source.updateWorldMatrix(true, false);
      if (fill) {
        fill.matrix.copy(source.matrixWorld);
        fill.matrixWorld.copy(source.matrixWorld);
      }
      if (edge) {
        edge.matrix.copy(source.matrixWorld);
        edge.matrixWorld.copy(source.matrixWorld);
      }
    }
  }

  // ─── Hover API (temporary highlights) ──────────────────────────────

  /**
   * Highlight a subtree with orange hover overlay + edge glow.
   * Replaces any previous hover highlight. Does NOT affect selection.
   */
  highlight(root: Object3D, track = false, options?: { includeSensorViz?: boolean; includeChildDrives?: boolean }): void {
    this.clear();
    if (this._useOutline()) {
      // OutlinePass renders the silhouette of the live scene mesh, so
      // tracking is implicit (no per-frame matrix sync needed) and dense
      // subtrees don't need the bounding-box fallback.
      this._outlineManager!.setHoverOutlined([root]);
      return;
    }
    this.hoverTracked = track;
    const includeSensorViz = options?.includeSensorViz ?? false;
    const includeChildDrives = options?.includeChildDrives ?? false;
    const meshes = this.collectMeshes(root, includeSensorViz, includeChildDrives);

    if (meshes.length > this.maxHoverMeshes) {
      this._highlightBoundingBox(root);
      return;
    }

    const thresholdRad = EDGE_THRESHOLD_DEG * (Math.PI / 180);
    for (const mesh of meshes) {
      mesh.updateWorldMatrix(true, false);
      this.hoverPairs.push(this._createOverlayPair(
        mesh.geometry, mesh.matrixWorld, mesh, mesh.name, thresholdRad,
        this._hoverOverlayMat, this._hoverEdgeMat, 1000,
        this._hoverStyle.showOverlay, this._hoverStyle.showEdges,
      ));
    }
  }

  /**
   * Highlight an instanced MU by creating temporary hover overlay meshes.
   */
  highlightInstancedMU(mu: InstancedMovingUnit): void {
    this.clear();
    this.hoverTracked = false;

    const pool = mu.node.userData?._muPool;
    if (!pool || mu.slotIndex < 0) return;

    const geometry = mu.node.geometry;
    if (!geometry) return;

    const mat = new Matrix4();
    mu.node.getMatrixAt(mu.slotIndex, mat);

    const thresholdRad = EDGE_THRESHOLD_DEG * (Math.PI / 180);
    const pair = this._createOverlayPair(
      geometry, mat, null as unknown as Mesh, '__imu', thresholdRad,
      this._hoverOverlayMat, this._hoverEdgeMat, 1000,
      this._hoverStyle.showOverlay, this._hoverStyle.showEdges,
    );
    if (pair.fill) pair.source = pair.fill;
    this.hoverPairs.push(pair);
  }

  /**
   * Highlight multiple subtrees at once with orange hover overlay.
   * Replaces any previous hover highlight.
   */
  highlightMultiple(roots: Object3D[], options?: { includeSensorViz?: boolean }): void {
    this.clear();
    if (this._useOutline()) {
      this._outlineManager!.setHoverOutlined(roots);
      return;
    }
    this.hoverTracked = true;
    const includeSensorViz = options?.includeSensorViz ?? false;

    // Collect all meshes first to check total count
    const allMeshes: { root: Object3D; meshes: Mesh[] }[] = [];
    let totalMeshes = 0;
    for (const root of roots) {
      const meshes = this.collectMeshes(root, includeSensorViz);
      allMeshes.push({ root, meshes });
      totalMeshes += meshes.length;
    }

    if (totalMeshes > this.maxHoverMeshes) {
      for (const { root } of allMeshes) this._highlightBoundingBox(root);
      return;
    }

    const thresholdRad = EDGE_THRESHOLD_DEG * (Math.PI / 180);
    for (const { meshes } of allMeshes) {
      for (const mesh of meshes) {
        mesh.updateWorldMatrix(true, false);
        this.hoverPairs.push(this._createOverlayPair(
          mesh.geometry, mesh.matrixWorld, mesh, mesh.name, thresholdRad,
          this._hoverOverlayMat, this._hoverEdgeMat, 1000,
          this._hoverStyle.showOverlay, this._hoverStyle.showEdges,
        ));
      }
    }
  }

  /** Remove hover highlight overlays only. Selection persists. */
  clear(): void {
    this._removePairs(this.hoverPairs);
    this.hoverTracked = false;
    this._outlineManager?.clearHover();
  }

  /** Whether any hover highlight is currently active. */
  get isActive(): boolean {
    return this.hoverPairs.length > 0
      || (this._outlineManager?.hoverPass?.selectedObjects?.length ?? 0) > 0;
  }

  // ─── Selection API (persistent highlights) ─────────────────────────

  /**
   * Highlight multiple subtrees with cyan selection overlay + edge glow.
   * Replaces any previous selection highlight. Does NOT affect hover.
   * Selection overlays are always tracked (follow moving meshes).
   */
  highlightSelection(roots: Object3D[], options?: { includeSensorViz?: boolean; includeChildDrives?: boolean }): void {
    this.clearSelection();
    if (roots.length === 0) return;
    if (this._useOutline()) {
      this._outlineManager!.setOutlined(roots);
      return;
    }
    // Skip the work entirely when the active style suppresses both layers
    // (e.g. planner mode delegates the selection visual to OutlinePass).
    if (!this._selectionStyle.showOverlay && !this._selectionStyle.showEdges) return;
    this.selectionTracked = true;
    const includeSensorViz = options?.includeSensorViz ?? false;
    const includeChildDrives = options?.includeChildDrives ?? false;
    const thresholdRad = EDGE_THRESHOLD_DEG * (Math.PI / 180);

    for (const root of roots) {
      const meshes = this.collectMeshes(root, includeSensorViz, includeChildDrives);
      for (const mesh of meshes) {
        mesh.updateWorldMatrix(true, false);
        this.selectionPairs.push(this._createOverlayPair(
          mesh.geometry, mesh.matrixWorld, mesh, mesh.name + '_sel', thresholdRad,
          this._selectionOverlayMat, this._selectionEdgeMat, 900,
          this._selectionStyle.showOverlay, this._selectionStyle.showEdges,
        ));
      }
    }
  }

  /**
   * Batched selection highlight — merges all meshes from all roots into a single
   * overlay + single edge mesh. Much faster than highlightSelection() for many nodes
   * (1 EdgesGeometry computation instead of N, 2 draw calls instead of 2N).
   * Not tracked (static snapshot) — use for browse modes, not moving objects.
   */
  highlightSelectionBatched(roots: Object3D[]): void {
    this.clearSelection();
    if (roots.length === 0) return;
    if (this._useOutline()) {
      // OutlinePass handles many-root selection efficiently — no need for the
      // batched-mesh trick (which exists to avoid N EdgesGeometry computations).
      this._outlineManager!.setOutlined(roots);
      return;
    }

    // Collect all mesh geometries with their world transforms
    const positions: number[] = [];
    for (const root of roots) {
      const meshes = this.collectMeshes(root, false, false);
      for (const mesh of meshes) {
        mesh.updateWorldMatrix(true, false);
        const geo = mesh.geometry;
        const posAttr = geo.getAttribute('position');
        if (!posAttr) continue;
        const idx = geo.index;
        const mat = mesh.matrixWorld;
        if (idx) {
          for (let i = 0; i < idx.count; i++) {
            const vi = idx.getX(i);
            const x = posAttr.getX(vi), y = posAttr.getY(vi), z = posAttr.getZ(vi);
            // Transform by world matrix
            const w = 1 / (mat.elements[3] * x + mat.elements[7] * y + mat.elements[11] * z + mat.elements[15]);
            positions.push(
              (mat.elements[0] * x + mat.elements[4] * y + mat.elements[8] * z + mat.elements[12]) * w,
              (mat.elements[1] * x + mat.elements[5] * y + mat.elements[9] * z + mat.elements[13]) * w,
              (mat.elements[2] * x + mat.elements[6] * y + mat.elements[10] * z + mat.elements[14]) * w,
            );
          }
        } else {
          for (let i = 0; i < posAttr.count; i++) {
            const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
            const w = 1 / (mat.elements[3] * x + mat.elements[7] * y + mat.elements[11] * z + mat.elements[15]);
            positions.push(
              (mat.elements[0] * x + mat.elements[4] * y + mat.elements[8] * z + mat.elements[12]) * w,
              (mat.elements[1] * x + mat.elements[5] * y + mat.elements[9] * z + mat.elements[13]) * w,
              (mat.elements[2] * x + mat.elements[6] * y + mat.elements[10] * z + mat.elements[14]) * w,
            );
          }
        }
      }
    }

    if (positions.length === 0) return;

    const mergedGeo = new BufferGeometry();
    mergedGeo.setAttribute('position', new Float32BufferAttribute(positions, 3));

    // Single fill overlay — no edge computation (fast)
    const fill = new Mesh(mergedGeo, this._selectionOverlayMat);
    fill.name = '_batchedSelFill';
    fill.userData._highlightOverlay = true;
    fill.renderOrder = 900;
    fill.raycast = () => {};
    fill.frustumCulled = false;
    fill.layers.set(HIGHLIGHT_OVERLAY_LAYER);
    this.scene.add(fill);

    // Use fill as dummy edge too — batched highlights skip edge computation for speed
    this.selectionPairs.push({ source: fill, fill, edge: fill as unknown as LineSegments });
  }

  /** Remove selection highlight overlays only. Hover persists. */
  clearSelection(): void {
    this._removePairs(this.selectionPairs);
    this.selectionTracked = false;
    this._outlineManager?.clear();
  }

  /** Whether any selection highlight is currently active. */
  get isSelectionActive(): boolean {
    return this.selectionPairs.length > 0
      || (this._outlineManager?.pass?.selectedObjects?.length ?? 0) > 0;
  }

  // ─── Common API ────────────────────────────────────────────────────

  /**
   * Re-sync overlay positions from source meshes (both channels).
   * Call once per render frame. No-op when nothing is tracked.
   */
  update(): void {
    if (this.hoverTracked && this.hoverPairs.length > 0) {
      this._syncPairs(this.hoverPairs);
    }
    if (this.selectionTracked && this.selectionPairs.length > 0) {
      this._syncPairs(this.selectionPairs);
    }
  }

  /** Remove all overlays (both hover and selection). */
  clearAll(): void {
    this.clear();
    this.clearSelection();
  }

  dispose(): void {
    this.clearAll();
    this._hoverOverlayMat.dispose();
    this._hoverEdgeMat.dispose();
    this._selectionOverlayMat.dispose();
    this._selectionEdgeMat.dispose();
  }

  // outlineFromHighlightColor is a free function defined below the class.

  /** Cheap bounding-box wireframe highlight for components with too many meshes. */
  private _highlightBoundingBox(root: Object3D): void {
    const box = new Box3().setFromObject(root);
    if (box.isEmpty()) return;
    const helper = new Box3Helper(box, new Color(this._hoverStyle.edgeColor));
    helper.userData._highlightOverlay = true;
    helper.renderOrder = 1000;
    helper.raycast = () => {};
    helper.layers.set(HIGHLIGHT_OVERLAY_LAYER);
    // Box3Helper instantiates its own LineBasicMaterial which DEFAULTS to
    // depthWrite:true, depthTest:true — that contaminates the depth buffer
    // before GTAO/N8AO run in the next composer pass and produces dark
    // halos along the wire. Force the same depth contract used by the
    // other highlight materials in this manager (depthTest:false +
    // depthWrite:false → renders on top, never affects AO).
    const helperMat = helper.material as LineBasicMaterial;
    helperMat.depthTest = false;
    helperMat.depthWrite = false;
    helperMat.transparent = true;
    helperMat.opacity = this._hoverStyle.edgeOpacity;
    this.scene.add(helper);
    this.hoverPairs.push({ source: root as unknown as Mesh, fill: helper as unknown as Mesh, edge: helper as unknown as LineSegments });
  }

  /**
   * Collect all Meshes under root, optionally stopping at child drive boundaries.
   * Skips existing overlay meshes.
   */
  private collectMeshes(root: Object3D, includeSensorViz: boolean, includeChildDrives = false): Mesh[] {
    const meshes: Mesh[] = [];
    const visit = (node: Object3D, isRoot: boolean) => {
      if (!isRoot && !includeChildDrives) {
        const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
        if (rv?.['Drive']) return; // child drive boundary — don't highlight nested drives
      }
      // Skip hidden kinematic source meshes (originals hidden by merge).
      // Merged chunks (_rvKinGroupMerged) are kept — they're visible and
      // represent the Drive subtree for highlighting.
      if (node.userData?._rvKinGroupSource) return;
      if (
        (node as Mesh).isMesh &&
        !node.userData?._highlightOverlay &&
        !node.userData?._driveHoverOverlay
      ) {
        const isSensorViz = node.name.endsWith('_sensorViz');
        if (!isSensorViz || includeSensorViz) {
          meshes.push(node as Mesh);
        }
      }
      for (const child of node.children) visit(child, false);
    };
    visit(root, true);
    return meshes;
  }
}

/**
 * Map a HighlightStyle.edgeColor to a paired (visible, hidden) outline-edge
 * pair. The hidden edge is the same hue at ~25% lightness so the
 * occlusion-aware OutlinePass renders the same color through walls — a
 * mismatched hidden color (the OutlinePass default is dark green) shows up
 * as a second outline of the wrong hue when the visible color is anything
 * other than green.
 */
function outlineFromHighlightColor(rgbHex: number): { visibleEdgeColor: number; hiddenEdgeColor: number } {
  const r = (rgbHex >> 16) & 0xff;
  const g = (rgbHex >> 8) & 0xff;
  const b = rgbHex & 0xff;
  const dark = (c: number) => Math.max(0, Math.min(255, Math.round(c * 0.35)));
  return {
    visibleEdgeColor: rgbHex,
    hiddenEdgeColor: (dark(r) << 16) | (dark(g) << 8) | dark(b),
  };
}
