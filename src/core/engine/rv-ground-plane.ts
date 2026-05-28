// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ground-plane — Pure factory for the viewer's checker-fade ground plane.
 *
 * The floor is a 200×200 PlaneGeometry textured with a procedural 8×8 checker
 * pattern and an alpha map that fades the disc to fully transparent at the
 * inscribed-circle edge. Both the plane size and the alpha-map opaque/fade
 * split are derived from {@link FLOOR_FADE_START_RATIO} and
 * {@link FLOOR_FADE_END_RATIO}, expressed as multiples of the model's
 * half-extent in X/Z, so the disc always re-scales to match whatever model
 * is loaded.
 *
 * This module has zero coupling to the rest of the viewer — it only depends
 * on Three.js — which makes it trivial to test in isolation. It is extracted
 * from rv-viewer.ts (Phase 7a of plan-177).
 */

import {
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';

// ─── Module constants (mirrors of the originals in rv-viewer.ts) ──────────

/**
 * Base scene-background grayscale (0x9a9a9a / 255 ≈ 0.604). Re-exported here
 * because the checker pattern derives its lower (dark) tile colour from the
 * same value — keeping them in one place guarantees the floor and the
 * background read as the same shade when contrast=0 and brightness=1.
 */
export const BG_BASE_SCALAR = 0x9a / 255;

/** World radius where the floor alpha fade STARTS (× model max half-extent). */
export const FLOOR_FADE_START_RATIO = 1.5;

/** World radius where the floor alpha fade reaches zero (× model max half-extent). */
export const FLOOR_FADE_END_RATIO = 6.0;

/**
 * Delta between the lighter and darker checker tile at contrast=1 — chosen so
 * the original color pair (#b0b0b0 / #9a9a9a) is reproduced exactly when the
 * user has not touched the slider.
 */
const CHECKER_HIGHLIGHT_DELTA = 0x16 / 255;

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Draw the 8×8 checker pattern into `canvas`. The darker tile always equals
 * the scene-background base colour, so at contrast=0 (and when floor/bg
 * brightness are equal) the floor and background render to the same colour.
 * The lighter tile brightens above the base by CHECKER_HIGHLIGHT_DELTA ×
 * contrast, so contrast=1 reproduces the original `#b0b0b0` / `#9a9a9a` pair.
 *
 * Exposed so the viewer can re-draw the canvas in place when the user moves
 * the `checkerContrast` slider — the existing CanvasTexture is reused, only
 * its source pixels change.
 */
export function drawCheckerPattern(canvas: HTMLCanvasElement, contrast: number): void {
  const tileCount = 8;
  const ctx = canvas.getContext('2d')!;
  const tilePixels = canvas.width / tileCount;
  const a = Math.max(0, Math.min(1, BG_BASE_SCALAR + CHECKER_HIGHLIGHT_DELTA * contrast));
  const b = BG_BASE_SCALAR;
  const toCss = (x: number) => {
    const v = Math.round(x * 255);
    return `rgb(${v},${v},${v})`;
  };
  const colorA = toCss(a);
  const colorB = toCss(b);
  for (let y = 0; y < tileCount; y++) {
    for (let x = 0; x < tileCount; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? colorA : colorB;
      ctx.fillRect(x * tilePixels, y * tilePixels, tilePixels, tilePixels);
    }
  }
}

/** Result of {@link createGroundFade}. Returned as a struct so the caller
 *  can keep a reference to the canvas (needed for in-place re-draws when
 *  the contrast slider changes) without having to dig through the mesh. */
export interface GroundFadeResult {
  /** The mesh to add to the scene. Already rotated horizontal and tagged with
   *  `renderOrder = -1`, `receiveShadow = true`, `visible = false`. */
  mesh: Mesh;
  /** Canvas backing the checker CanvasTexture. Kept so the caller can call
   *  {@link drawCheckerPattern} on it later and flag the texture dirty. */
  canvas: HTMLCanvasElement;
}

/**
 * Create ground plane with checker pattern that fades to transparent via a
 * CIRCULAR alpha map. The opaque-to-fade split is controlled by
 * {@link FLOOR_FADE_START_RATIO} / {@link FLOOR_FADE_END_RATIO} — see their
 * declaration above for the geometric meaning.
 *
 * The function is pure: it allocates fresh Three.js resources every call and
 * mutates nothing outside its return value. The caller owns disposal.
 *
 * @param checkerContrast Initial checker contrast (0..2 typical range).
 * @param isWebGPU When true, the indexed PlaneGeometry is converted to a
 *  non-indexed BufferGeometry — the three/webgpu backend doesn't render the
 *  indexed variant correctly for this particular ground configuration.
 */
export function createGroundFade(
  checkerContrast: number,
  isWebGPU: boolean,
): GroundFadeResult {
  const checkerSize = 512;
  const canvas = document.createElement('canvas');
  canvas.width = checkerSize;
  canvas.height = checkerSize;
  drawCheckerPattern(canvas, checkerContrast);

  const checkerTex = new CanvasTexture(canvas);
  checkerTex.wrapS = RepeatWrapping;
  checkerTex.wrapT = RepeatWrapping;
  checkerTex.colorSpace = SRGBColorSpace;
  checkerTex.magFilter = NearestFilter;

  // Create alpha map: CIRCULAR fade — radial distance from center. Opaque
  // disc of fractional radius `opaqueRatio`, then linear fade to zero at
  // the inscribed circle's edge. Pixels outside that circle (the four
  // corner regions of the square texture) are fully transparent so the
  // floor reads as a disc, not a rectangle.
  //
  // `opaqueRatio` is derived from the same constants that drive the plane
  // size (see FLOOR_FADE_START_RATIO / FLOOR_FADE_END_RATIO) so the opaque
  // area in WORLD space is exactly FLOOR_FADE_START_RATIO × model-half-extent
  // regardless of how wide the fade band is.
  const opaqueRatio = FLOOR_FADE_START_RATIO / FLOOR_FADE_END_RATIO;
  const alphaSize = 256;
  const alphaCanvas = document.createElement('canvas');
  alphaCanvas.width = alphaSize;
  alphaCanvas.height = alphaSize;
  const alphaCtx = alphaCanvas.getContext('2d')!;
  const imageData = alphaCtx.createImageData(alphaSize, alphaSize);
  for (let py = 0; py < alphaSize; py++) {
    for (let px = 0; px < alphaSize; px++) {
      const dx = px / alphaSize - 0.5; // -0.5..+0.5
      const dy = py / alphaSize - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2; // 0 at center, 1 at inscribed-circle edge
      // Opaque inside `opaqueRatio`, linear fade to 0 at r=1, hard cut beyond.
      const alpha =
        r <= opaqueRatio ? 1 :
        r >= 1 ? 0 :
        1 - (r - opaqueRatio) / (1 - opaqueRatio);
      const idx = (py * alphaSize + px) * 4;
      const v = Math.max(0, Math.round(alpha * 255));
      imageData.data[idx] = v;
      imageData.data[idx + 1] = v;
      imageData.data[idx + 2] = v;
      imageData.data[idx + 3] = 255;
    }
  }
  alphaCtx.putImageData(imageData, 0, 0);
  const alphaTex = new CanvasTexture(alphaCanvas);

  let geo: PlaneGeometry | BufferGeometry = new PlaneGeometry(200, 200);
  if (isWebGPU && geo.index) {
    const nonIndexed = geo.toNonIndexed();
    geo.dispose();
    geo = nonIndexed;
  }

  const mat = new MeshStandardMaterial({
    map: checkerTex,
    alphaMap: alphaTex,
    transparent: true,
    side: DoubleSide,
    depthWrite: false,
    roughness: 1.0,
    metalness: 0.0,
  });

  const mesh = new Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = -1;
  mesh.receiveShadow = true;
  mesh.visible = false;

  return { mesh, canvas };
}
