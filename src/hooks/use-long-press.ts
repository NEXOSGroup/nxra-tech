// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * useLongPress — touch long-press detection with movement cancellation.
 *
 * Returns pointer event handlers that fire `onLongPress(clientX, clientY)`
 * after `delayMs` if a touch pointer stays within `moveTolerancePx` of its
 * original location. Cancels on pointer-up, pointer-leave, or movement
 * beyond the tolerance.
 *
 * Mouse and pen pointer types are ignored — long-press is touch-only by
 * design (mouse users have right-click for context menus).
 *
 * Extracted from `rv-hierarchy-browser.tsx` (plan-177 Phase 5) where
 * TreeNodeRow and FlatNodeRow had identical 30-line long-press blocks.
 */

import { useCallback, useEffect, useRef } from 'react';

export interface UseLongPressOptions {
  /** Whether long-press is enabled. When false, all handlers no-op. */
  enabled?: boolean;
  /** Delay in ms before the long-press fires. Default: 500ms. */
  delayMs?: number;
  /**
   * Squared distance tolerance in px². Movement beyond this cancels the timer.
   * Default: 64 (i.e. 8px in each direction).
   */
  moveTolerancePx2?: number;
  /** Optional callback fired on long-press, receiving the original pointer position. */
  onLongPress?: (x: number, y: number) => void;
}

export interface UseLongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  /** Cancel imperatively (e.g. when a parent handler decides the gesture was something else). */
  cancel: () => void;
}

export function useLongPress({
  enabled = true,
  delayMs = 500,
  moveTolerancePx2 = 64,
  onLongPress,
}: UseLongPressOptions = {}): UseLongPressHandlers {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const posRef = useRef<{ x: number; y: number } | null>(null);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    posRef.current = null;
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!enabled || !onLongPress || e.pointerType !== 'touch') return;
    // Clear any leftover timer from a previous gesture before starting a new one.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    posRef.current = { x: e.clientX, y: e.clientY };
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const start = posRef.current;
      if (start && onLongPress) {
        onLongPress(start.x, start.y);
        navigator.vibrate?.(50);
      }
    }, delayMs);
  }, [enabled, onLongPress, delayMs]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!timerRef.current || !posRef.current) return;
    const dx = e.clientX - posRef.current.x;
    const dy = e.clientY - posRef.current.y;
    if (dx * dx + dy * dy > moveTolerancePx2) cancel();
  }, [cancel, moveTolerancePx2]);

  // Cleanup on unmount: ensure any pending timer is cleared so callbacks
  // can't fire against a disposed component tree.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      posRef.current = null;
    };
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: cancel,
    onPointerLeave: cancel,
    cancel,
  };
}
