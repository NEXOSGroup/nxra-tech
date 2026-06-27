// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useMediaQuery } from '@mui/material';

/**
 * Compact-layout breakpoint (px). Viewports NARROWER than this use the compact
 * mobile layout (bottom tab bar, fullscreen panels, horizontal library strip);
 * viewports this wide or wider use the standard desktop dock.
 *
 * The layout decision is purely WIDTH-based (not touch-based) so large tablets
 * — which have plenty of room for the standard dock — get the desktop layout
 * even though they are touch devices. Only genuinely narrow screens (phones,
 * small tablets in portrait) fall back to the compact layout.
 */
export const MOBILE_BREAKPOINT = 900;

/** Pure predicate: should this viewport width use the compact mobile layout?
 *  Exported for testing and for non-React callers (plugins reading innerWidth). */
export function isCompactWidth(width: number): boolean {
  return width < MOBILE_BREAKPOINT;
}

/**
 * Detect mobile/touch device using multiple signals for robust detection.
 * Combines: UA Client Hints, media queries, maxTouchPoints, and UA string fallback.
 * Cached after first call — device class doesn't change at runtime.
 */
let _cachedIsMobile: boolean | null = null;

export function isMobileDevice(): boolean {
  if (_cachedIsMobile !== null) return _cachedIsMobile;

  // 1. Modern UA Client Hints (Chrome 89+, Edge, Opera — NOT Safari/Firefox)
  const uad = (navigator as unknown as { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uad?.mobile !== undefined) {
    _cachedIsMobile = uad.mobile;
    // UA Client Hints detected mobile device
    return _cachedIsMobile;
  }

  // 2. CSS media query: touch-only device (fails on iPad with keyboard/trackpad)
  const touchOnly = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  if (touchOnly) {
    _cachedIsMobile = true;
    return true;
  }

  // 3. Touch capability + small screen (catches iPads, Android tablets with accessories)
  const hasTouch = navigator.maxTouchPoints > 0;
  const smallScreen = Math.min(window.screen.width, window.screen.height) <= 1024;
  if (hasTouch && smallScreen) {
    _cachedIsMobile = true;
    return true;
  }

  // 4. UA string fallback (Safari/Firefox on iOS/Android)
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod/i.test(ua)) {
    _cachedIsMobile = true;
    return true;
  }
  // iPadOS 13+ sends Mac UA but has touch — detect via maxTouchPoints
  if (/Macintosh/i.test(ua) && hasTouch) {
    _cachedIsMobile = true;
    return true;
  }

  _cachedIsMobile = false;
  return false;
}

/**
 * Returns true when the UI should use the compact mobile layout.
 *
 * Purely width-based: triggers only on narrow viewports (< MOBILE_BREAKPOINT),
 * NOT on touch capability. Large touch tablets therefore keep the standard
 * desktop dock; only phones / small portrait tablets get the compact layout.
 * For touch-specific behavior (no hover, larger hit targets) use
 * {@link useTouchDevice} / {@link isMobileDevice} instead.
 */
export function useMobileLayout(): boolean {
  return useMediaQuery(`(max-width:${MOBILE_BREAKPOINT - 1}px)`);
}

/** Returns true when the primary input is touch (coarse pointer, no hover). */
export function useTouchDevice(): boolean {
  return useMediaQuery('(hover: none) and (pointer: coarse)') || isMobileDevice();
}
