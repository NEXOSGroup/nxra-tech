// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useToolButtonInteraction } from '../src/hooks/use-tool-button-interaction';

function fakeEl(): HTMLElement {
  return {} as HTMLElement;
}

function mouseEvent(opts: { button?: number; currentTarget?: HTMLElement } = {}): React.MouseEvent {
  return {
    button: opts.button ?? 0,
    currentTarget: opts.currentTarget ?? fakeEl(),
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as React.MouseEvent;
}

function pointerEvent(opts: { button?: number; currentTarget?: HTMLElement } = {}): React.PointerEvent {
  return {
    button: opts.button ?? 0,
    currentTarget: opts.currentTarget ?? fakeEl(),
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as React.PointerEvent;
}

describe('useToolButtonInteraction', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('toggles on a plain click', () => {
    const onToggle = vi.fn();
    const { result } = renderHook(() => useToolButtonInteraction({ onToggle }));

    act(() => { result.current.buttonProps.onClick(mouseEvent()); });

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(result.current.anchorEl).toBeNull();
  });

  it('opens the menu on right-click WITHOUT toggling', () => {
    const onToggle = vi.fn();
    const el = fakeEl();
    const { result } = renderHook(() => useToolButtonInteraction({ onToggle }));

    act(() => { result.current.buttonProps.onContextMenu(mouseEvent({ currentTarget: el })); });

    expect(result.current.anchorEl).toBe(el);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('opens the menu on press-and-hold and suppresses the trailing click', () => {
    const onToggle = vi.fn();
    const el = fakeEl();
    const { result } = renderHook(() => useToolButtonInteraction({ onToggle, longPressMs: 450 }));

    act(() => { result.current.buttonProps.onPointerDown(pointerEvent({ currentTarget: el })); });
    expect(result.current.anchorEl).toBeNull();          // not yet

    act(() => { vi.advanceTimersByTime(450); });
    expect(result.current.anchorEl).toBe(el);            // hold opened the menu

    // The trailing pointer-up + click must NOT toggle.
    act(() => {
      result.current.buttonProps.onPointerUp();
      result.current.buttonProps.onClick(mouseEvent());
    });
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('treats a short press as a normal click (toggles, no menu)', () => {
    const onToggle = vi.fn();
    const { result } = renderHook(() => useToolButtonInteraction({ onToggle, longPressMs: 450 }));

    act(() => { result.current.buttonProps.onPointerDown(pointerEvent()); });
    act(() => {
      vi.advanceTimersByTime(200);                       // released before threshold
      result.current.buttonProps.onPointerUp();
    });
    act(() => { vi.advanceTimersByTime(450); });         // timer already cleared — nothing opens
    expect(result.current.anchorEl).toBeNull();

    act(() => { result.current.buttonProps.onClick(mouseEvent()); });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('does not start a hold timer for a non-primary pointer (right button)', () => {
    const onToggle = vi.fn();
    const { result } = renderHook(() => useToolButtonInteraction({ onToggle }));

    act(() => { result.current.buttonProps.onPointerDown(pointerEvent({ button: 2 })); });
    act(() => { vi.advanceTimersByTime(1000); });

    expect(result.current.anchorEl).toBeNull();
  });

  it('cancels a pending hold on pointer leave', () => {
    const onToggle = vi.fn();
    const { result } = renderHook(() => useToolButtonInteraction({ onToggle, longPressMs: 450 }));

    act(() => {
      result.current.buttonProps.onPointerDown(pointerEvent());
      result.current.buttonProps.onPointerLeave();
    });
    act(() => { vi.advanceTimersByTime(1000); });

    expect(result.current.anchorEl).toBeNull();
  });

  it('closeMenu clears the anchor', () => {
    const onToggle = vi.fn();
    const el = fakeEl();
    const { result } = renderHook(() => useToolButtonInteraction({ onToggle }));

    act(() => { result.current.buttonProps.onContextMenu(mouseEvent({ currentTarget: el })); });
    expect(result.current.anchorEl).toBe(el);

    act(() => { result.current.closeMenu(); });
    expect(result.current.anchorEl).toBeNull();
  });
});
