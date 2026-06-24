// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ViewportFrame — confines the WebGL canvas to the central "main viewport"
 * region so the 3D renders only beside the chrome, never behind it.
 *
 * The Three.js canvas lives in a dedicated `#rv-viewport` container (created in
 * main.ts) that is full-bleed by default. This render-null component reactively
 * insets that container by the chrome widths; the renderer's ResizeObserver then
 * resizes the canvas + camera aspect automatically (no viewer API needed).
 *
 * Insets are multiplied by the UI zoom: the chrome lives inside the HMIShell box
 * (which has a CSS `zoom` applied) but the canvas container does not, so chrome
 * that measures W css-px renders at W*zoom screen-px.
 */

import { useEffect } from 'react';
import { useViewportInsets } from '../../hooks/use-viewport-insets';
import { useUIZoom } from './visual-settings-store';

export function ViewportFrame() {
  // Shared with the centered viewport overlays (KpiBar, BottomBar) so the canvas
  // and those overlays always agree on the central region. Insets are css-px and
  // already 0 when full-bleed (mobile / HMI hidden / chrome hidden in FPV/XR).
  const { left: insetLeft, right: insetRight, top: insetTop } = useViewportInsets();
  const zoom = useUIZoom();

  useEffect(() => {
    const el = document.getElementById('rv-viewport');
    if (!el) return;

    // The chrome lives inside the zoomed HMIShell but this canvas container does
    // not, so chrome that measures W css-px renders at W*zoom screen-px — scale
    // the insets to match.
    el.style.left = `${insetLeft * zoom}px`;
    el.style.right = `${insetRight * zoom}px`;
    el.style.top = `${insetTop * zoom}px`;
    el.style.bottom = '0px';
  }, [insetLeft, insetRight, insetTop, zoom]);

  return null;
}
