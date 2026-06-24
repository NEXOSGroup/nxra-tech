// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ModeDropdown tests (plan-198) — renders the dropdown, opens the menu, and
 * verifies it lists every registered mode and switches on selection.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { ModeDropdown } from '../src/core/hmi/ModeDropdown';
import { ModeManager, type ModeHost, type ModePluginSets } from '../src/core/rv-mode-manager';
import type { RVViewer } from '../src/core/rv-viewer';

const EMPTY: ModePluginSets = { enable: [], disable: [], activateHooks: [], deactivateHooks: [] };

function makeViewer(register = true): RVViewer {
  const host: ModeHost = {
    viewer: {} as RVViewer,
    pluginsForMode: () => EMPTY,
    enablePlugin: () => {}, disablePlugin: () => {}, callPlugin: () => {},
    setContext: () => {}, emit: () => {},
  };
  const modes = new ModeManager(host);
  if (register) {
    modes.register({ id: 'hmi', label: 'HMI', order: 10 });
    modes.register({ id: 'des', label: 'DES', order: 20 });
    modes.register({ id: 'planner', label: 'Planner', order: 30 });
    modes.setMode('hmi');
  }
  return { modes } as unknown as RVViewer;
}

function renderWith(viewer: RVViewer) {
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(RVViewerProvider, { value: viewer }, children);
  return render(createElement(ModeDropdown), { wrapper: Wrapper });
}

describe('ModeDropdown', () => {
  beforeEach(() => { try { localStorage.removeItem('rv-active-mode'); } catch { /* ignore */ } });
  afterEach(() => cleanup());

  it('renders nothing when no modes are registered', () => {
    const { container } = renderWith(makeViewer(false));
    expect(container.querySelector('button')).toBeNull();
  });

  it('lists one menu item per registered mode', () => {
    renderWith(makeViewer());
    fireEvent.click(screen.getByLabelText('Switch workspace mode'));
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(
      expect.arrayContaining(['HMI', 'DES', 'Planner']),
    );
    expect(items.length).toBe(3);
  });

  it('marks the active mode as selected', () => {
    renderWith(makeViewer());
    fireEvent.click(screen.getByLabelText('Switch workspace mode'));
    const menu = screen.getByRole('menu');
    const selected = within(menu).getAllByRole('menuitem').filter(
      (i) => i.classList.contains('Mui-selected'),
    );
    expect(selected.length).toBe(1);
    expect(selected[0].textContent).toContain('HMI');
  });

  it('switches mode on selection', () => {
    const viewer = makeViewer();
    renderWith(viewer);
    fireEvent.click(screen.getByLabelText('Switch workspace mode'));
    const menu = screen.getByRole('menu');
    fireEvent.click(within(menu).getByText('Planner'));
    expect(viewer.modes.activeMode).toBe('planner');
  });
});
