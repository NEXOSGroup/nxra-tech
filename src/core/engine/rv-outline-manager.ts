// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVOutlineManager — Wraps Three.js OutlinePass for plugin-driven outline
 * highlights.
 *
 * Two independent channels:
 *   - **selection** (cyan by default): persistent outlines for selected nodes,
 *     used by the SelectionManager via the highlight manager. The layout
 *     planner overrides the style to a green silhouette while active.
 *   - **hover** (orange by default): transient outlines for the node under
 *     the cursor, used by RaycastManager via the highlight manager.
 *
 * Each channel owns its own OutlinePass instance + style, so hover and
 * selection can render different colors simultaneously. Passes are lazily
 * inserted into the viewer's EffectComposer (just before the OutputPass) on
 * first use. WebGPU builds skip the composer entirely and `available`
 * reports false; methods become no-ops.
 *
 * Usage:
 *   viewer.outlineManager.setStyle({ visibleEdgeColor: 0x4fc34f });   // selection
 *   viewer.outlineManager.setOutlined([selectedRoot]);
 *   viewer.outlineManager.setHoverStyle({ visibleEdgeColor: 0xffb870 });
 *   viewer.outlineManager.setHoverOutlined([hoveredRoot]);
 *   ...
 *   viewer.outlineManager.clearAll();
 */

import { Vector2, Color } from 'three';
import type { Object3D, PerspectiveCamera, OrthographicCamera, Scene } from 'three';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';

// ─── Style ────────────────────────────────────────────────────────────

export interface OutlineStyle {
  /** Hex color of the outline edge over visible faces. */
  visibleEdgeColor: number;
  /** Hex color of the outline edge through occluding geometry. */
  hiddenEdgeColor: number;
  /** Edge intensity multiplier (1 thin, 10 strong). */
  edgeStrength: number;
  /** Edge thickness in pixels (1..4). */
  edgeThickness: number;
  /** Glow halo around the edge (0 = crisp, 1 = wide bloom). */
  edgeGlow: number;
  /** Pulse period in seconds (0 = no pulse). */
  pulsePeriod: number;
}

/** Default selection outline — green silhouette (matches planner / general select). */
export const DEFAULT_OUTLINE_STYLE: OutlineStyle = Object.freeze({
  visibleEdgeColor: 0x4fc34f,
  hiddenEdgeColor: 0x2a6b2a,
  edgeStrength: 6,
  edgeThickness: 2,
  edgeGlow: 0.35,
  pulsePeriod: 0,
});

/** Default hover outline — softer orange to match the legacy hover overlay tint. */
export const DEFAULT_HOVER_OUTLINE_STYLE: OutlineStyle = Object.freeze({
  visibleEdgeColor: 0xffb870,
  hiddenEdgeColor: 0x7a4a20,
  edgeStrength: 5,
  edgeThickness: 2,
  edgeGlow: 0.3,
  pulsePeriod: 0,
});

/** Default chain outline — pale green, distinct from the vivid green used for the
 *  focused (hovered/selected) object. Used by the snap-point chain preview to
 *  outline every asset that will follow the focused one in chain mode. */
export const DEFAULT_CHAIN_OUTLINE_STYLE: OutlineStyle = Object.freeze({
  visibleEdgeColor: 0xa6e8ad,
  hiddenEdgeColor: 0x4a6b4f,
  edgeStrength: 3,
  edgeThickness: 2,
  edgeGlow: 0.25,
  pulsePeriod: 0,
});

// ─── Manager ──────────────────────────────────────────────────────────

/**
 * Minimal viewer surface this manager needs. Defined as an interface so
 * we don't take a hard dependency on RVViewer (avoids a circular import).
 */
export interface OutlineHostViewer {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera | OrthographicCamera;
  readonly renderer: { domElement: HTMLCanvasElement };
  readonly isWebGPU: boolean;
  /** Lazily creates the EffectComposer (no-op if it already exists). */
  _ensureComposer(): void;
  /** The composer once `_ensureComposer` has run; null on WebGPU. */
  readonly _composer: EffectComposer | null;
  /** Mark the next frame as needing a render. */
  markRenderDirty(): void;
}

interface ChannelState {
  pass: OutlinePass | null;
  outlined: Object3D[];
  style: OutlineStyle;
}

export class RVOutlineManager {
  private readonly _viewer: OutlineHostViewer;
  private readonly _selection: ChannelState = {
    pass: null, outlined: [], style: { ...DEFAULT_OUTLINE_STYLE },
  };
  private readonly _hover: ChannelState = {
    pass: null, outlined: [], style: { ...DEFAULT_HOVER_OUTLINE_STYLE },
  };
  private readonly _chain: ChannelState = {
    pass: null, outlined: [], style: { ...DEFAULT_CHAIN_OUTLINE_STYLE },
  };

  constructor(viewer: OutlineHostViewer) {
    this._viewer = viewer;
  }

  // ─── Public API ────────────────────────────────────────────────────

  /**
   * True when the manager can render outlines. Always false on WebGPU
   * (no EffectComposer support). On WebGL this is always true — passes
   * are lazily created on first use.
   */
  get available(): boolean {
    return !this._viewer.isWebGPU;
  }

  /** Whether any outlines are currently active in any channel. */
  get hasOutlines(): boolean {
    return this._selection.outlined.length > 0
      || this._hover.outlined.length > 0
      || this._chain.outlined.length > 0;
  }

  /** The selection-channel OutlinePass instance, or null if not yet created. */
  get pass(): OutlinePass | null {
    return this._selection.pass;
  }

  /** The hover-channel OutlinePass instance, or null if not yet created. */
  get hoverPass(): OutlinePass | null {
    return this._hover.pass;
  }

  // ─── Selection channel (default channel — backward-compatible API) ──

  /**
   * Replace the selection-channel outlined objects. Empty array clears.
   */
  setOutlined(objects: readonly Object3D[]): void {
    this._setChannelOutlined(this._selection, objects);
  }

  /** Clear selection-channel outlines. */
  clear(): void {
    this.setOutlined([]);
  }

  /** Update selection-channel style (partial — only provided fields change). */
  setStyle(style: Partial<OutlineStyle>): void {
    this._selection.style = { ...this._selection.style, ...style };
    this._applyStyle(this._selection);
    if (this._selection.outlined.length > 0) this._viewer.markRenderDirty();
  }

  /** Read the current selection-channel style. */
  getStyle(): Readonly<OutlineStyle> {
    return this._selection.style;
  }

  // ─── Hover channel ─────────────────────────────────────────────────

  /** Replace the hover-channel outlined objects. Empty array clears. */
  setHoverOutlined(objects: readonly Object3D[]): void {
    this._setChannelOutlined(this._hover, objects);
  }

  /** Clear hover-channel outlines. */
  clearHover(): void {
    this.setHoverOutlined([]);
  }

  /** Update hover-channel style. */
  setHoverStyle(style: Partial<OutlineStyle>): void {
    this._hover.style = { ...this._hover.style, ...style };
    this._applyStyle(this._hover);
    if (this._hover.outlined.length > 0) this._viewer.markRenderDirty();
  }

  /** Read the current hover-channel style. */
  getHoverStyle(): Readonly<OutlineStyle> {
    return this._hover.style;
  }

  // ─── Chain channel (pale green — snap-point chain preview) ─────────

  /** The chain-channel OutlinePass instance, or null if not yet created. */
  get chainPass(): OutlinePass | null {
    return this._chain.pass;
  }

  /** Replace the chain-channel outlined objects. Empty array clears. */
  setChainOutlined(objects: readonly Object3D[]): void {
    this._setChannelOutlined(this._chain, objects);
  }

  /** Clear chain-channel outlines. */
  clearChain(): void {
    this.setChainOutlined([]);
  }

  /** Update chain-channel style. */
  setChainStyle(style: Partial<OutlineStyle>): void {
    this._chain.style = { ...this._chain.style, ...style };
    this._applyStyle(this._chain);
    if (this._chain.outlined.length > 0) this._viewer.markRenderDirty();
  }

  /** Read the current chain-channel style. */
  getChainStyle(): Readonly<OutlineStyle> {
    return this._chain.style;
  }

  // ─── Aggregated ────────────────────────────────────────────────────

  /** Clear all channels. */
  clearAll(): void {
    this.clear();
    this.clearHover();
    this.clearChain();
  }

  /** Resize handler — call from the renderer's resize observer. */
  setSize(width: number, height: number): void {
    if (this._selection.pass) this._selection.pass.setSize(width, height);
    if (this._hover.pass) this._hover.pass.setSize(width, height);
    if (this._chain.pass) this._chain.pass.setSize(width, height);
  }

  /**
   * Re-bind every active OutlinePass to the host viewer's currently active
   * camera. Cheap (single property write per pass) — call from the per-frame
   * render loop so outlines stay correctly projected after a perspective ↔
   * orthographic swap. No-op when no passes have been created yet.
   */
  syncCamera(): void {
    if (this._selection.pass) this._selection.pass.renderCamera = this._viewer.camera;
    if (this._hover.pass) this._hover.pass.renderCamera = this._viewer.camera;
    if (this._chain.pass) this._chain.pass.renderCamera = this._viewer.camera;
  }

  /** Tear down all passes (does not remove them from the composer chain). */
  dispose(): void {
    for (const ch of [this._selection, this._hover, this._chain]) {
      if (ch.pass) {
        ch.pass.dispose();
        ch.pass.selectedObjects = [];
        ch.pass = null;
      }
      ch.outlined = [];
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private _setChannelOutlined(channel: ChannelState, objects: readonly Object3D[]): void {
    if (!this.available) return;
    if (objects.length === 0) {
      if (channel.outlined.length === 0) return;
      channel.outlined = [];
      if (channel.pass) channel.pass.selectedObjects = channel.outlined;
      this._viewer.markRenderDirty();
      return;
    }
    this._ensurePass(channel);
    channel.outlined = [...objects];
    if (channel.pass) channel.pass.selectedObjects = channel.outlined;
    this._viewer.markRenderDirty();
  }

  /**
   * Create an OutlinePass on first need and insert it just before the
   * OutputPass. Forces composer creation if it doesn't exist yet (planner
   * mode may activate before AO or bloom turn on).
   */
  private _ensurePass(channel: ChannelState): void {
    if (channel.pass || !this.available) return;

    // Force the composer into existence — needed because the viewer only
    // builds it lazily when AO or bloom flips on. Outlines also need it.
    this._viewer._ensureComposer();
    const composer = this._viewer._composer;
    if (!composer) return;

    const canvas = this._viewer.renderer.domElement;
    const w = canvas.width || canvas.clientWidth || 1;
    const h = canvas.height || canvas.clientHeight || 1;

    const pass = new OutlinePass(
      new Vector2(w, h),
      this._viewer.scene,
      this._viewer.camera,
    );
    channel.pass = pass;
    this._applyStyle(channel);

    // Insert just before the OutputPass so the outline is composited
    // onto the post-AO + post-bloom buffer and then tone-mapped together
    // with everything else. If no OutputPass is found (defensive), append.
    const passes = composer.passes;
    const outputIdx = passes.findIndex((p) => p instanceof OutputPass);
    if (outputIdx >= 0) {
      composer.insertPass(pass, outputIdx);
    } else {
      composer.addPass(pass);
    }
  }

  private _applyStyle(channel: ChannelState): void {
    if (!channel.pass) return;
    const s = channel.style;
    channel.pass.visibleEdgeColor = new Color(s.visibleEdgeColor);
    channel.pass.hiddenEdgeColor = new Color(s.hiddenEdgeColor);
    channel.pass.edgeStrength = s.edgeStrength;
    channel.pass.edgeThickness = s.edgeThickness;
    channel.pass.edgeGlow = s.edgeGlow;
    channel.pass.pulsePeriod = s.pulsePeriod;
  }
}
