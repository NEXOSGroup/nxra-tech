// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-source-marker.ts — Floor-Ring + Label-Sprite for RVSource.
 *
 * Builds an always-visible identifier under each Source node:
 *   - a flat, semi-transparent floor ring (RingGeometry) sized to the
 *     source's MU template footprint,
 *   - a kamera-orientiertes Label-Sprite (CanvasTexture) showing the
 *     Source's node name.
 *
 * Both are children of the source's node (passed in from `RVSource`),
 * so they automatically follow any Source movement (Layout-Planner drag).
 *
 * The marker is excluded from raycasting via the `_isSourceMarker` userData
 * flag — the central filter in `RaycastManager.excludeFilters` ignores it.
 *
 * Materials & textures are owned by the returned `dispose()` callback. Call
 * it from `RVSource.dispose()` to free GPU resources.
 */

import {
  CanvasTexture,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  RingGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Texture,
} from 'three';

// ─── Constants ─────────────────────────────────────────────────────

/** Inner-radius scale relative to the template half-size's X dimension. */
const RING_INNER_SCALE = 1.1;
/** Ring thickness in scene units (meters — viewer-internal unit). */
const RING_THICKNESS = 0.030;
/** Y offset above ground (avoids Z-fighting with the floor). */
const RING_Y_OFFSET = 0.0005;
/** RingGeometry radial segment count. */
const RING_SEGMENTS = 32;
/** Ring fill opacity. */
const RING_OPACITY = 0.6;
/** Minimum inner radius (so very small templates still get a usable ring). */
const RING_MIN_INNER = 0.05;
/** Label canvas dimensions. */
const LABEL_CANVAS_W = 256;
const LABEL_CANVAS_H = 64;
/** Sprite width as a fraction of the outer ring diameter.
 *  Smaller = more compact label, less visual noise next to the ring. */
const LABEL_WIDTH_FRACTION = 0.5;
/** Render order for label sprite (high so it stays on top). */
const LABEL_RENDER_ORDER = 9998;

// ─── Color hash ─────────────────────────────────────────────────────

/**
 * Deterministic per-name color via golden-ratio hue distribution. Same
 * input → same output (across sessions, machines, threads). Provides
 * good visual separation when multiple sources share the same scene.
 *
 * Note: uses `charCodeAt` which returns UTF-16 code units. ASCII names
 * (the practical norm) are handled correctly; Unicode surrogate pairs
 * are an acceptable v1 limitation.
 */
export function hashColor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  // Golden ratio conjugate ~= 0.618 → good hue distribution
  const hue = ((h >>> 0) % 65536) / 65536;
  const goldenHue = (hue + 0.618) % 1;
  return new Color().setHSL(goldenHue, 0.7, 0.55).getHex();
}

// ─── Builder ─────────────────────────────────────────────────────

export interface SourceMarkerHandles {
  /** Root group containing ring + label, parented to the source's node. */
  root: Object3D;
  /** The floor ring mesh (for test introspection + material disposal). */
  ring: Mesh;
  /** The label sprite (for test introspection + texture disposal). */
  label: Sprite;
  /** The CanvasTexture backing the label sprite. */
  labelTexture: CanvasTexture;
  /** The exact label text baked into the texture. */
  labelText: string;
  /** Frees all GPU resources and removes the root from its parent. */
  dispose(): void;
}

export interface BuildSourceMarkerOptions {
  /** Half-size of the source's MU template (meters). Drives ring radius. */
  templateHalfSize: Vector3;
  /** Source node name → used as label text and color-hash seed. */
  name: string;
  /** Initial visibility. */
  visible?: boolean;
}

/**
 * Build a floor-marker (ring + label sprite) as a single Object3D group.
 *
 * Returned root must be parented by the caller (so transform-tracking
 * via the Three.js parent chain works for moving sources).
 */
export function buildSourceMarker(opts: BuildSourceMarkerOptions): SourceMarkerHandles {
  const { templateHalfSize, name } = opts;
  const visible = opts.visible ?? true;

  const color = hashColor(name);

  // ── Floor Ring ──
  const innerRadius = Math.max(RING_MIN_INNER, templateHalfSize.x * RING_INNER_SCALE);
  const outerRadius = innerRadius + RING_THICKNESS;
  const ringGeo = new RingGeometry(innerRadius, outerRadius, RING_SEGMENTS);
  const ringMat = new MeshBasicMaterial({
    color,
    transparent: true,
    opacity: RING_OPACITY,
    depthWrite: false,
    side: DoubleSide,
  });
  const ring = new Mesh(ringGeo, ringMat);
  ring.name = `${name}_sourceMarkerRing`;
  ring.rotation.x = -Math.PI / 2; // flat on ground (XZ plane)
  ring.position.y = RING_Y_OFFSET;
  ring.castShadow = false;
  ring.receiveShadow = false;
  ring.frustumCulled = false;
  ring.userData._isSourceMarker = true;

  // ── Label Sprite ──
  const labelText = name;
  const labelTexture = createLabelTexture(labelText, color);
  const labelMat = new SpriteMaterial({
    map: labelTexture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const label = new Sprite(labelMat);
  label.name = `${name}_sourceMarkerLabel`;

  // Sprite scale: width = outer ring diameter * LABEL_WIDTH_FRACTION,
  // height preserves canvas aspect.
  const labelWorldW = outerRadius * 2 * LABEL_WIDTH_FRACTION;
  const labelWorldH = labelWorldW * (LABEL_CANVAS_H / LABEL_CANVAS_W);
  label.scale.set(labelWorldW, labelWorldH, 1);

  // Position label slightly above the ring (use 0.3 * halfSize.y or a small
  // default so labels for "flat" templates still float above the ring).
  const labelY = Math.max(templateHalfSize.y * 0.3, 0.05);
  label.position.set(0, labelY, 0);
  label.renderOrder = LABEL_RENDER_ORDER;
  label.frustumCulled = false;
  label.userData._isSourceMarker = true;

  // ── Group ──
  const root = new Object3D();
  root.name = `${name}_sourceMarker`;
  root.userData._isSourceMarker = true;
  root.visible = visible;
  root.add(ring);
  root.add(label);

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (root.parent) root.parent.remove(root);
    ringGeo.dispose();
    ringMat.dispose();
    labelTexture.dispose();
    labelMat.dispose();
  };

  return { root, ring, label, labelTexture, labelText, dispose };
}

/**
 * Render the source name into a Canvas, returning a Three.js CanvasTexture.
 * The texture is opaque inside a colored rounded-rect pill on a dark
 * background — same visual language as `rv-annotation-renderer.ts`.
 */
function createLabelTexture(text: string, hexColor: number): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = LABEL_CANVAS_W;
  canvas.height = LABEL_CANVAS_H;
  const ctx = canvas.getContext('2d');
  // Defensive: in headless contexts (extremely rare), 2D context might be
  // unavailable. Return an empty texture so callers don't crash.
  if (!ctx) return new CanvasTexture(canvas);

  const w = canvas.width;
  const h = canvas.height;
  const colorHex = '#' + hexColor.toString(16).padStart(6, '0');
  const radius = 8;
  const border = 3;

  // Colored rounded-rect border
  ctx.fillStyle = colorHex;
  roundedRect(ctx, 0, 0, w, h, radius);
  ctx.fill();

  // Dark interior
  ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
  roundedRect(ctx, border, border, w - 2 * border, h - 2 * border, Math.max(0, radius - border));
  ctx.fill();

  // Text — truncate if too long
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 24px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const truncated = text.length > 22 ? text.substring(0, 19) + '...' : text;
  ctx.fillText(truncated, w / 2, h / 2);

  return new CanvasTexture(canvas);
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

// Re-export Texture type so downstream files can refer to the marker's
// label-texture type without a direct three import.
export type { Texture };
