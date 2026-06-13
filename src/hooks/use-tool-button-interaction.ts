// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useEffect, useRef, useState } from 'react';

/**
 * useToolButtonInteraction — shared "click toggles, right-click / hold opens
 * settings" interaction for planner toolbar tool buttons.
 *
 * The button's primary action (toggling the tool on/off) happens on a plain
 * left-click. The settings popover is opened by RIGHT-CLICK (desktop) or a
 * PRESS-AND-HOLD (touch, and mouse hold) — so the common toggle stays one click
 * while the rarely-needed settings move out of the way.
 *
 * Spread the returned `buttonProps` on the trigger element and wire the popover
 * to `anchorEl` / `closeMenu`:
 *
 *   const { anchorEl, closeMenu, buttonProps } = useToolButtonInteraction({ onToggle });
 *   <IconButton {...buttonProps} />
 *   <Popover anchorEl={anchorEl} open={!!anchorEl} onClose={closeMenu}>…</Popover>
 */
export interface UseToolButtonInteractionOptions {
  /** Fired on a plain (short, primary-button) click. */
  onToggle: () => void;
  /** Press-and-hold threshold in ms before the settings popover opens. */
  longPressMs?: number;
}

export interface UseToolButtonInteractionResult {
  /** Current popover anchor (null = closed). */
  anchorEl: HTMLElement | null;
  /** Open the popover anchored to an element (e.g. programmatically). */
  openMenu: (el: HTMLElement) => void;
  /** Close the popover. */
  closeMenu: () => void;
  /** Handlers to spread on the trigger button. */
  buttonProps: {
    onClick: (e: React.MouseEvent) => void;
    onContextMenu: (e: React.MouseEvent) => void;
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerUp: () => void;
    onPointerLeave: () => void;
  };
}

const DEFAULT_LONG_PRESS_MS = 450;

export function useToolButtonInteraction(
  opts: UseToolButtonInteractionOptions,
): UseToolButtonInteractionResult {
  const { onToggle, longPressMs = DEFAULT_LONG_PRESS_MS } = opts;
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once a hold has fired, so the trailing `click` (after pointer-up) is
  // suppressed and does NOT also toggle.
  const didLongPress = useRef(false);

  const clearTimer = (): void => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  };

  // Clear any pending hold timer when the component unmounts.
  useEffect(() => clearTimer, []);

  const buttonProps: UseToolButtonInteractionResult['buttonProps'] = {
    onClick: () => {
      if (didLongPress.current) { didLongPress.current = false; return; } // hold already opened the menu
      onToggle();
    },
    onContextMenu: (e) => {
      e.preventDefault();
      e.stopPropagation();
      setAnchorEl(e.currentTarget as HTMLElement);
    },
    onPointerDown: (e) => {
      if (e.button !== 0) return;                  // primary only; right-click handled by onContextMenu
      didLongPress.current = false;
      const el = e.currentTarget as HTMLElement;   // capture before the async fire (currentTarget is cleared after)
      clearTimer();
      timer.current = setTimeout(() => {
        didLongPress.current = true;
        setAnchorEl(el);
      }, longPressMs);
    },
    onPointerUp: clearTimer,
    onPointerLeave: clearTimer,
  };

  return {
    anchorEl,
    openMenu: (el) => setAnchorEl(el),
    closeMenu: () => setAnchorEl(null),
    buttonProps,
  };
}
