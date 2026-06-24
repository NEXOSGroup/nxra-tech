// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RobotContactForceAlarm render smoke test — the card shows the SYST-320 title,
 * a prominent "Ask AI" button, and a History icon with a badge equal to the
 * seeded note count.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { RobotContactForceAlarm } from '../src/plugins/demo/robot-alarm/RobotContactForceAlarm';
import { SYST_320_SCENARIO } from '../src/plugins/demo/robot-alarm/alarm-seed-data';
import type { RVViewer } from '../src/core/rv-viewer';

function mockViewer(): RVViewer {
  return {
    on: () => () => {},
    highlightByPath: () => {},
    clearHighlight: () => {},
    focusByPath: () => {},
    filterDrives: () => {},
    registry: { getNode: () => null },
    outlineManager: { getStyle: () => ({}), setStyle: () => {}, setOutlined: () => {}, clear: () => {} },
    fitToNodes: () => {},
  } as unknown as RVViewer;
}

function wrap(ui: ReactNode, viewer: RVViewer) {
  return (
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewer}>{ui}</RVViewerProvider>
    </ThemeProvider>
  );
}

describe('RobotContactForceAlarm', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders the SYST-320 title', () => {
    render(wrap(<RobotContactForceAlarm viewer={mockViewer()} />, mockViewer()));
    expect(screen.getByText(/SYST-320/)).toBeTruthy();
  });

  it('renders a prominent "Ask AI" button', () => {
    render(wrap(<RobotContactForceAlarm viewer={mockViewer()} />, mockViewer()));
    expect(screen.getByRole('button', { name: /ask ai/i })).toBeTruthy();
  });

  it('renders the History icon button with a badge of the seeded note count', async () => {
    render(wrap(<RobotContactForceAlarm viewer={mockViewer()} />, mockViewer()));
    const historyBtn = screen.getByRole('button', { name: /view alarm history/i });
    expect(historyBtn).toBeTruthy();
    await waitFor(() => {
      expect(historyBtn.textContent).toContain(String(SYST_320_SCENARIO.seedNotes.length));
    });
  });
});
