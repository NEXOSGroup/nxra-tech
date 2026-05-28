// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * panel-anchor-store — Captures the most recent user pointer-down
 * position so floating panels can place themselves close to whatever
 * the user just clicked (button, KPI card, context-menu item, etc.).
 *
 * Self-installing on first module import. Capture-phase listener so the
 * coordinate is recorded BEFORE any click handler runs — by the time a
 * panel transitions to `open=true` the anchor is already up-to-date.
 *
 * Falls back to `null` for programmatic opens (no recent pointer-down)
 * so callers can use their default positioning.
 *
 * ── CSS zoom note ─────────────────────────────────────────────────
 * HMIShell applies CSS `zoom` to its container. Inside a zoomed
 * ancestor `event.clientX/Y` and `window.innerWidth/Height` stay in
 * UNZOOMED viewport space, while any position written to `style.left`
 * (and React state mirrors) is in the CHILD's CSS-px coordinate
 * system (= viewport-px / zoom). All public APIs in this module
 * return values in CSS-px so callers can use them directly with
 * panel state.
 */

import { getUIZoom } from './visual-settings-store';

interface AnchorPoint {
  x: number;
  y: number;
  t: number; // performance.now() at capture
}

let _last: AnchorPoint | null = null;

/** Default freshness window: clicks older than this are treated as "no anchor". */
const DEFAULT_MAX_AGE_MS = 1000;

function _onPointerDown(e: PointerEvent): void {
  _last = { x: e.clientX, y: e.clientY, t: performance.now() };
}

function _install(): void {
  if (typeof window === 'undefined') return;
  // Capture-phase + passive: runs before component handlers, never blocks
  // scrolling, and survives stopPropagation in click handlers.
  window.addEventListener('pointerdown', _onPointerDown, { capture: true, passive: true });
}

// Side-effect install on first import — happens at module-graph load time,
// well before any panel can open in response to user input.
_install();

/**
 * Most recent pointer-down position in CSS-px (zoomed-container coords),
 * if it occurred within `maxAgeMs`. Returns null for programmatic opens
 * or when nothing has been clicked recently — caller should fall back
 * to its default placement.
 */
export function getRecentAnchorPoint(maxAgeMs: number = DEFAULT_MAX_AGE_MS): { x: number; y: number } | null {
  if (!_last) return null;
  if (performance.now() - _last.t > maxAgeMs) return null;
  const z = getUIZoom() || 1;
  return { x: _last.x / z, y: _last.y / z };
}

/**
 * Viewport size in CSS-px (zoomed-container coords). Use this anywhere
 * panel state (`pos.x`, `style.left`) is being clamped or compared
 * against viewport extents.
 */
export function getCSSViewportSize(): { w: number; h: number } {
  const z = getUIZoom() || 1;
  return { w: window.innerWidth / z, h: window.innerHeight / z };
}

/**
 * Convert a raw event coordinate (event.clientX or event.clientY) from
 * unzoomed viewport space into CSS-px of the zoomed container — the
 * coordinate system used by `style.left/top` on panel elements.
 */
export function clientToCSS(client: number): number {
  const z = getUIZoom() || 1;
  return client / z;
}

/**
 * Compute a panel's top-left position so the panel sits adjacent to the
 * given anchor point without covering the trigger element. Pure function —
 * no DOM access, no side effects. Caller is responsible for clamping the
 * returned values to the viewport (use `clampToViewport`).
 *
 * Heuristic:
 *  - Anchor in left half of viewport → place panel to the RIGHT of anchor
 *  - Otherwise → place panel to the LEFT of anchor
 *  - Vertically: center on anchor.y
 */
export function placeAdjacentToAnchor(
  anchor: { x: number; y: number },
  panelW: number,
  panelH: number,
  viewportW: number,
  gap: number = 16,
): { x: number; y: number } {
  const onLeftHalf = anchor.x < viewportW / 2;
  const x = onLeftHalf
    ? anchor.x + gap
    : anchor.x - gap - panelW;
  const y = anchor.y - panelH / 2;
  return { x, y };
}
