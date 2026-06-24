// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { ACTIVITY_BAR_WIDTH, TITLE_BAR_HEIGHT } from '../core/hmi/layout-constants';
import { useLeftWindowWidth, useRightWindowWidth } from './use-left-window-width';
import { useMobileLayout } from './use-mobile-layout';
import { useHmiVisible } from '../core/hmi/hmi-visibility-store';
import { useUIVisible } from '../core/hmi/ui-context-store';
import { useCustomBranding } from '../core/hmi/branding-store';

/**
 * Reactive left/right insets (css-px) of the central 3D viewport region — the
 * area the WebGL canvas is confined to by {@link ViewportFrame}, i.e. between
 * the activity bar + any open left-docked window on the left and any open
 * right-docked window on the right.
 *
 * Single source of truth for horizontally centering floating viewport overlays
 * (the top KPI / OEE bar, the bottom search bar) on the *actual* 3D view rather
 * than on the whole browser window. Returns `{ left: 0, right: 0 }` whenever the
 * canvas is full-bleed (mobile, HMI hidden, or chrome hidden in FPV / XR) so
 * those overlays fall back to full-window centering — matching ViewportFrame's
 * own gating exactly.
 *
 * NOTE: values are css-px (unzoomed). Consumers that live inside the zoomed
 * HMIShell (KpiBar, BottomBar) use them directly; ViewportFrame multiplies by
 * the UI zoom because the canvas container lives outside the zoom.
 */
export function useViewportInsets(): { left: number; right: number; top: number } {
  const isMobile = useMobileLayout();
  const hmiVisible = useHmiVisible();
  // Same gate the activity bar uses — when it's hidden (FPV/XR) the canvas is full-bleed.
  const showActivityBar = useUIVisible('activity-bar', { hiddenIn: ['fpv', 'xr'] });
  const leftWidth = useLeftWindowWidth();
  const rightWidth = useRightWindowWidth();
  const branding = useCustomBranding();

  // Top inset for the optional title bar. Shown everywhere (desktop + mobile)
  // while the HMI is visible, so it is computed independently of the horizontal
  // full-bleed gating below.
  const top = hmiVisible && branding?.titleBar ? TITLE_BAR_HEIGHT : 0;

  const fullBleed = isMobile || !hmiVisible || !showActivityBar;
  if (fullBleed) return { left: 0, right: 0, top };
  return { left: ACTIVITY_BAR_WIDTH + leftWidth, right: rightWidth, top };
}
