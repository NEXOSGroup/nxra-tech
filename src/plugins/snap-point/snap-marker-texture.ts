// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared snap-marker sprite texture.
 *
 * One white "disc + ring" base (tinted at render time by the SpriteMaterial
 * colour) with an optional dark glyph in the centre. Used by BOTH the snap-point
 * markers (plain / "+") and the snap-flip rotate icon ("rotate") so they form a
 * single visually-consistent family — same disc, same proportions, same size;
 * only the glyph differs.
 */

import { CanvasTexture } from 'three';

/** Centre glyph painted onto the disc. */
export type SnapGlyph = 'none' | 'plus' | 'rotate';

/** Disc background for the glyph variants — same green as the normal idle snap
 *  markers (COLOR_IDLE 0x4fc34f). Baked into the texture so the glyph can be a
 *  contrasting WHITE on top (a single tinted texture can't show two colours).
 *  The 'none' variant stays white so the material can tint it (idle/occupied/
 *  drag states). */
const DISC_GREEN = '#4fc34f';
const GLYPH_WHITE = '#ffffff';

const _cache: Record<SnapGlyph, CanvasTexture | null> = {
  none: null, plus: null, rotate: null,
};

/** Lazily build (and cache) the shared marker texture for a given glyph. */
export function makeSnapMarkerTexture(glyph: SnapGlyph = 'none'): CanvasTexture {
  const cached = _cache[glyph];
  if (cached) return cached;

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
  const hasGlyph = glyph !== 'none';

  // Disc fill: white for the tintable plain marker; green (baked) for the glyph
  // variants so a white glyph reads on top.
  ctx.beginPath();
  ctx.arc(cx, cy, rInner, 0, Math.PI * 2);
  ctx.fillStyle = hasGlyph ? DISC_GREEN : '#ffffff';
  ctx.fill();

  // Slim white outer ring — crisp silhouette on any background.
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, rOuter - 4, 0, Math.PI * 2);
  ctx.stroke();

  if (glyph === 'plus') {
    const plus = rInner * 0.5;
    ctx.lineWidth = 22;
    ctx.lineCap = 'round';
    ctx.strokeStyle = GLYPH_WHITE;
    ctx.beginPath();
    ctx.moveTo(cx - plus, cy);
    ctx.lineTo(cx + plus, cy);
    ctx.moveTo(cx, cy - plus);
    ctx.lineTo(cx, cy + plus);
    ctx.stroke();
  } else if (glyph === 'rotate') {
    // White circular arrow on the same green disc — matches the "+" marker
    // exactly bar the icon.
    const ringR = rInner * 0.5;
    ctx.lineWidth = 22;
    ctx.lineCap = 'round';
    ctx.strokeStyle = GLYPH_WHITE;
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, -Math.PI * 0.3, Math.PI * 1.3);
    ctx.stroke();
    // Arrowhead at the open end of the arc.
    const tipAng = -Math.PI * 0.3;
    const tipX = cx + ringR * Math.cos(tipAng);
    const tipY = cy + ringR * Math.sin(tipAng);
    const head = size * 0.13;
    ctx.fillStyle = GLYPH_WHITE;
    ctx.beginPath();
    ctx.moveTo(tipX + head * 0.9, tipY - head * 0.2);
    ctx.lineTo(tipX - head * 0.4, tipY - head * 0.9);
    ctx.lineTo(tipX - head * 0.1, tipY + head * 0.5);
    ctx.closePath();
    ctx.fill();
  }

  const tex = new CanvasTexture(canvas);
  tex.needsUpdate = true;
  tex.anisotropy = 4;
  _cache[glyph] = tex;
  return tex;
}

/** Test-only: drop all cached textures. */
export function _disposeSnapMarkerTextures(): void {
  for (const k of Object.keys(_cache) as SnapGlyph[]) {
    _cache[k]?.dispose();
    _cache[k] = null;
  }
}
