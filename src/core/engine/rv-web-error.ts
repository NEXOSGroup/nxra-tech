// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVWebError — TypeScript counterpart of Unity `WebError.cs`.
 *
 * A semantic error marker: binds a PLCOutputBool error signal + a plain-text
 * message to a node. While the signal is high the part is highlighted in red
 * (mesh-glow-hull flash, or a floor-disk ring for very small parts), a backed
 * error-text badge appears above the part, and the error is registered in the
 * central ErrorStore (which drives the right-side error panel). No latching,
 * no acknowledgement — the error mirrors the signal 1:1.
 *
 * Component naming/Gizmo patterns mirror RVWebSensor; the error registry
 * (ErrorStore) is the only new building block.
 */

import { CanvasTexture, type Object3D, type Texture } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, setComponentInstance } from './rv-component-registry';
import type { GizmoHandle } from './rv-gizmo-manager';
import { computeSubtreeAABB } from './rv-traverse-utils';
import { NodeRegistry } from './rv-node-registry';

// ─── Constants (inline, glanceable) ─────────────────────────────────────

/** ISA-101 alarm red used for the 3D highlight + badge border. */
const ERROR_COLOR = 0xff2020;
/** 2 Hz flash for the active highlight (matches WebSensor 'error' state). */
const ERROR_BLINK_HZ = 2;
/** Wider outline so small parts are visible from far (matches WebSensor). */
const HIGHLIGHT_OUTLINE_SCALE = 2.0;
/** Bounding-box diagonal below this (in meters) → small part → floor-disk ring.
 *  ~150 mm threshold (Auto heuristic, plan §2.4 / open question — calibratable). */
const SMALL_PART_DIAGONAL_M = 0.15;

/** 3D highlight style — accepts the C# enum as string or int index. */
type HighlightStyle = 'Auto' | 'FlashObject' | 'Circle';

/** Normalize a string/int HighlightStyle to a named value (defensive). */
function normalizeHighlightStyle(raw: unknown): HighlightStyle {
  if (raw === 'FlashObject' || raw === 1 || raw === '1') return 'FlashObject';
  if (raw === 'Circle' || raw === 2 || raw === '2') return 'Circle';
  return 'Auto';
}

// ─── Backed error-text badge sprite (dark panel + red border + white text) ──

/** Build a CanvasTexture badge: dark rounded panel, red border, white text.
 *  Pattern mirrors MeasurementRenderer._createLabelSprite. Returns the texture
 *  plus its canvas aspect (w/h) so the caller can scale the sprite correctly. */
function buildBadgeTexture(text: string): { texture: CanvasTexture; aspect: number } {
  const label = text && text.trim() ? text : 'Error';
  const fontSize = 32;
  const border = 3;
  const radius = 8;
  const pad = 16;

  const measureCanvas = document.createElement('canvas');
  const mctx = measureCanvas.getContext('2d')!;
  mctx.font = `bold ${fontSize}px sans-serif`;
  const textWidth = Math.ceil(mctx.measureText(label).width);

  const w = textWidth + pad * 2 + border * 2;
  const h = fontSize + pad;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);

  const drawRoundedRect = (x: number, y: number, rw: number, rh: number, r: number) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + rw - r, y);
    ctx.quadraticCurveTo(x + rw, y, x + rw, y + r);
    ctx.lineTo(x + rw, y + rh - r);
    ctx.quadraticCurveTo(x + rw, y + rh, x + rw - r, y + rh);
    ctx.lineTo(x + r, y + rh);
    ctx.quadraticCurveTo(x, y + rh, x, y + rh - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  };

  // Red border (full rect) → dark panel inset
  const hex = ERROR_COLOR.toString(16).padStart(6, '0');
  ctx.fillStyle = `#${hex}`;
  drawRoundedRect(0, 0, w, h, radius);
  ctx.fill();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
  drawRoundedRect(border, border, w - border * 2, h - border * 2, Math.max(0, radius - border));
  ctx.fill();

  // White text
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, w / 2, h / 2 + 1);

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return { texture, aspect: w / h };
}

// ─── RVWebError ──────────────────────────────────────────────────────────

export class RVWebError implements RVComponent {
  static readonly schema: ComponentSchema = {
    SignalError: { type: 'componentRef' },
    ErrorText:   { type: 'string', default: '' },
    HighlightStyle: {
      type: 'enum',
      // Enum-tolerant: accepts the C# enum serialized as a string ('Auto') OR an
      // int index ('0'). UnityGLTF serializes enums via .ToString() → string, but
      // the int form is normalized defensively in init() as well.
      enumMap: {
        Auto: 'Auto', FlashObject: 'FlashObject', Circle: 'Circle',
        '0': 'Auto', '1': 'FlashObject', '2': 'Circle',
      },
      default: 'Auto',
    },
  };

  readonly node: Object3D;
  isOwner = true;

  // Schema-populated (exact C# Inspector field names)
  SignalError: string | null = null;
  ErrorText = '';
  HighlightStyle: HighlightStyle = 'Auto';

  /** Node path — the ErrorStore key. Cached once at init. */
  readonly path: string;

  private _highlightGizmo?: GizmoHandle;
  private _badgeGizmo?: GizmoHandle;
  private _badgeTexture?: Texture;
  private _unsubscribe?: () => void;
  private _ctx?: ComponentContext;
  private _active = false;

  constructor(node: Object3D) {
    this.node = node;
    this.path = NodeRegistry.computeNodePath(node);
  }

  init(ctx: ComponentContext): void {
    if (!ctx.gizmoManager) {
      console.error('[WebError] gizmoManager missing in ComponentContext — skipping');
      return;
    }
    this._ctx = ctx;

    // Defensive: if applySchema left an int (raw number bypasses the string-only
    // enumMap match), normalize it to the named style here.
    this.HighlightStyle = normalizeHighlightStyle(this.HighlightStyle);

    this.node.userData._rvType = 'WebError';
    Object.defineProperty(this.node.userData, '_rvComponentInstance', {
      value: this, writable: true, configurable: true, enumerable: false,
    });

    // Subscribe only when a signal is bound (no signal → never active).
    if (this.SignalError) {
      this._unsubscribe = ctx.signalStore.subscribeByPath(
        this.SignalError,
        (v) => this._onChange(!!v),
      );
      // Note: initial state is applied in onSceneReady once the gizmos exist —
      // we still read it here to capture a value set before init (no race).
      const current = ctx.signalStore.getByPath(this.SignalError);
      if (current !== undefined) this._active = !!current;
    }
  }

  /** Gizmo creation deferred to onSceneReady so the subtree AABB is correct
   *  AFTER kinematic re-parenting (matches RVSafetyDoor). */
  onSceneReady(ctx: ComponentContext): void {
    if (!ctx.gizmoManager) return;
    this._ctx = ctx;

    // ── 3D highlight gizmo (red flash / floor-disk ring) ──
    const useRing = this._resolveUseRing();
    if (useRing) {
      this._highlightGizmo = ctx.gizmoManager.create(this.node, {
        shape: 'floor-disk',
        color: ERROR_COLOR,
        opacity: 0.45,
        blinkHz: ERROR_BLINK_HZ,
        visible: false,
      });
    } else {
      this._highlightGizmo = ctx.gizmoManager.create(this.node, {
        shape: 'mesh-glow-hull',
        color: ERROR_COLOR,
        opacity: 0.95,
        blinkHz: ERROR_BLINK_HZ,
        outlineScale: HIGHLIGHT_OUTLINE_SCALE,
        visible: false,
      });
    }

    // ── Backed error-text badge (dark panel + red border + white text) ──
    const { texture, aspect } = buildBadgeTexture(this.ErrorText);
    this._badgeTexture = texture;
    const { size } = computeSubtreeAABB(this.node);
    // World height of the badge ≈ a fraction of the part height (min 0.08 m).
    const badgeHeight = Math.max(0.08, size.y * 0.4);
    this._badgeGizmo = ctx.gizmoManager.create(this.node, {
      shape: 'sprite',
      color: 0xffffff,
      opacity: 1.0,
      spriteTexture: texture,
      worldSize: badgeHeight,
      depthTest: false,
      renderOrder: 12,
      excludeFromRaycast: true,
      visible: false,
    });
    // Lift the badge above the part (sprite default sits at the AABB center).
    if (this._badgeGizmo) {
      // Sprite worldSize is the badge HEIGHT; width = height × aspect.
      this._badgeGizmo.root.scale.set(badgeHeight * aspect, badgeHeight, 1);
      this._badgeGizmo.root.position.y += size.y * 0.5 + badgeHeight;
    }

    // Apply the captured initial state now that gizmos exist.
    this._applyActive(this._active);
  }

  private _resolveUseRing(): boolean {
    if (this.HighlightStyle === 'Circle') return true;
    if (this.HighlightStyle === 'FlashObject') return false;
    // Auto: small parts (short diagonal) → floor-disk ring, else mesh flash.
    const { size } = computeSubtreeAABB(this.node);
    return size.length() < SMALL_PART_DIAGONAL_M;
  }

  private _onChange(active: boolean): void {
    if (active === this._active) {
      // Re-affirm store text in case ErrorText changed at runtime (rare).
      if (active) this._ctx?.errorStore?.setActive(this.path, true, this.ErrorText);
      return;
    }
    this._active = active;
    this._applyActive(active);
  }

  private _applyActive(active: boolean): void {
    this._highlightGizmo?.setVisible(active);
    this._badgeGizmo?.setVisible(active);
    this._ctx?.errorStore?.setActive(this.path, active, this.ErrorText);
  }

  /** Current active state (test/inspection helper). */
  isActive(): boolean {
    return this._active;
  }

  dispose(): void {
    this._unsubscribe?.();
    this._unsubscribe = undefined;
    this._highlightGizmo?.dispose();
    this._highlightGizmo = undefined;
    this._badgeGizmo?.dispose();
    this._badgeGizmo = undefined;
    this._badgeTexture?.dispose();
    this._badgeTexture = undefined;
    this._ctx?.errorStore?.remove(this.path);
    this._active = false;
  }
}

// ─── Self-register ──────────────────────────────────────────────────────

registerComponent({
  type: 'WebError',
  displayName: 'Error',
  schema: RVWebError.schema,
  capabilities: {
    hoverable: false,
    selectable: false,
    filterLabel: 'Web Errors',
    badgeColor: '#ef5350',
  },
  create: (node) => new RVWebError(node),
  afterCreate: (inst, node) => {
    node.userData._rvType = 'WebError';
    Object.defineProperty(node.userData, '_rvComponentInstance', {
      value: inst, writable: true, configurable: true, enumerable: false,
    });
    setComponentInstance(node, inst);
  },
});
