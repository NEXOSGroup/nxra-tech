// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * useMode hook tests (plan-198) — verifies the React binding reflects the
 * ModeManager state and re-renders on setMode.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, act, cleanup } from '@testing-library/react';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { useMode } from '../src/hooks/use-mode';
import { ModeManager, type ModeHost, type ModePluginSets } from '../src/core/rv-mode-manager';
import type { RVViewer } from '../src/core/rv-viewer';

const EMPTY: ModePluginSets = { enable: [], disable: [], activateHooks: [], deactivateHooks: [] };

function makeViewerWithModes(): RVViewer {
  const host: ModeHost = {
    viewer: {} as RVViewer,
    pluginsForMode: () => EMPTY,
    enablePlugin: () => {},
    disablePlugin: () => {},
    callPlugin: () => {},
    setContext: () => {},
    emit: () => {},
  };
  const modes = new ModeManager(host);
  modes.register({ id: 'hmi', label: 'HMI', order: 10 });
  modes.register({ id: 'des', label: 'DES', order: 20 });
  modes.register({ id: 'planner', label: 'Planner', order: 30 });
  return { modes } as unknown as RVViewer;
}

function wrapper(viewer: RVViewer) {
  return ({ children }: { children: ReactNode }) =>
    createElement(RVViewerProvider, { value: viewer }, children);
}

describe('useMode', () => {
  beforeEach(() => { try { localStorage.removeItem('rv-active-mode'); } catch { /* ignore */ } });
  afterEach(() => cleanup());

  it('returns the sorted mode list and null active before any switch', () => {
    const viewer = makeViewerWithModes();
    const { result } = renderHook(() => useMode(), { wrapper: wrapper(viewer) });
    expect(result.current.modes.map((m) => m.id)).toEqual(['hmi', 'des', 'planner']);
    expect(result.current.active).toBeNull();
  });

  it('re-renders when setMode is called', () => {
    const viewer = makeViewerWithModes();
    const { result } = renderHook(() => useMode(), { wrapper: wrapper(viewer) });
    act(() => result.current.setMode('des'));
    expect(result.current.active).toBe('des');
    act(() => result.current.setMode('planner'));
    expect(result.current.active).toBe('planner');
  });
});
