// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * snap-hover-store — Reactive hover + picker state for the snap-point plugin.
 *
 * Uses the same useSyncExternalStore pattern as ui-context-store / layout-store
 * to stay zero-dependency (no Zustand needed).
 */

import { useSyncExternalStore } from 'react';
import type { SnapPoint } from '../../core/engine/rv-snap-point-registry';

export interface SnapHoverState {
  /** Currently nearest snap (within pixel threshold), or null. */
  hovered: SnapPoint | null;
  /** Pixel distance of `hovered` from the mouse. */
  hoverScreenDist: number;
  /** True iff the picker popup is open. */
  pickerOpen: boolean;
  /** Snap anchoring the picker. */
  pickerAnchor: SnapPoint | null;
  /** Pixel coordinates of the picker anchor (canvas-relative -> client). */
  pickerScreenPos: { x: number; y: number } | null;
}

const INITIAL: SnapHoverState = {
  hovered: null,
  hoverScreenDist: Infinity,
  pickerOpen: false,
  pickerAnchor: null,
  pickerScreenPos: null,
};

let _state: SnapHoverState = INITIAL;
const _listeners = new Set<() => void>();

function _notify(): void {
  for (const fn of _listeners) fn();
}

export const snapHoverStore = {
  getState(): SnapHoverState {
    return _state;
  },

  subscribe(listener: () => void): () => void {
    _listeners.add(listener);
    return () => { _listeners.delete(listener); };
  },

  setHovered(snap: SnapPoint | null, dist: number): void {
    if (_state.hovered === snap && _state.hoverScreenDist === dist) return;
    _state = { ..._state, hovered: snap, hoverScreenDist: dist };
    _notify();
  },

  openPicker(snap: SnapPoint, screenPos: { x: number; y: number }): void {
    _state = {
      ..._state,
      pickerOpen: true,
      pickerAnchor: snap,
      pickerScreenPos: screenPos,
    };
    _notify();
  },

  closePicker(): void {
    if (!_state.pickerOpen && !_state.pickerAnchor) return;
    _state = {
      ..._state,
      pickerOpen: false,
      pickerAnchor: null,
      pickerScreenPos: null,
    };
    _notify();
  },

  reset(): void {
    _state = INITIAL;
    _notify();
  },
};

/** React hook for picker / hover state. */
export function useSnapHoverState(): SnapHoverState {
  return useSyncExternalStore(snapHoverStore.subscribe, snapHoverStore.getState);
}
