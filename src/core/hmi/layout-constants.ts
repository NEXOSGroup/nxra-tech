// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Shared layout constants — kept dependency-free to avoid circular imports. */

/** Height of the bottom bar area (search + padding) for layout calculations. */
export const BOTTOM_BAR_HEIGHT = 52;

/** Width of the left activity bar (VSCode-style vertical icon strip).
 *  Sized to match the floating overlay ButtonPanel (medium IconButtons, 38px,
 *  inside a 4px-padded Paper → 46px) so the outer and overlay toolbars align. */
export const ACTIVITY_BAR_WIDTH = 46;

/** Height of the optional top title bar (shown only when branding.titleBar is set).
 *  Top-anchored chrome and the 3D canvas are pushed down by this amount when active. */
export const TITLE_BAR_HEIGHT = 40;

/** Small top gap for floating viewport clusters (mode/sim switcher, camera/view
 *  controls, KPI bar). There is no top app bar anymore — they float at the top. */
export const FLOATING_TOP_MARGIN = 8;

/** Top of left-docked windows — flush to the very top (the activity bar and
 *  docked windows run full height now that the top app bar is gone). */
export const LEFT_PANEL_TOP = 0;

/** Left of left-docked windows — flush against the activity bar (edge-to-edge). */
export const LEFT_PANEL_LEFT = ACTIVITY_BAR_WIDTH;

/** Bottom of left-docked windows — flush to the viewport bottom (edge-to-edge). */
export const LEFT_PANEL_BOTTOM = 0;

/** Z-index for left-side panels (desktop). */
export const LEFT_PANEL_ZINDEX = 1200;

/**
 * Z-index for left-side panels on mobile.
 * Higher than TopBar buttons (9001), BottomBar (1201), ButtonPanel/LogoBadge (1210),
 * so mobile panels fully overlay the entire viewport. The panel header's own close
 * button keeps it dismissable.
 */
export const LEFT_PANEL_MOBILE_ZINDEX = 10000;

/** Width of the Settings panel. */
export const SETTINGS_PANEL_WIDTH = 540;

/** Default width of the PropertyInspector panel (also the initial resizable width). */
export const INSPECTOR_PANEL_WIDTH = 320;

/** Min width the PropertyInspector can be resized to. */
export const INSPECTOR_MIN_WIDTH = 240;

/** Max width the PropertyInspector can be resized to. */
export const INSPECTOR_MAX_WIDTH = 640;

/** Width of the Machine Control panel. */
export const MACHINE_PANEL_WIDTH = 370;

/** Width of the Layout Planner library panel. */
export const LAYOUT_PANEL_WIDTH = 340;

/** Width of the Scene panel (scene browser + layout management). */
export const SCENE_PANEL_WIDTH = 340;

/** Width of the Order Manager panel. */
export const ORDER_PANEL_WIDTH = 320;

/** Width of the CONNECT panel. */
export const CONNECT_PANEL_WIDTH = 360;

