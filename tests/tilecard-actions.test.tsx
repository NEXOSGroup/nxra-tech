// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TileCard `actions` tests — the new optional footer prop is purely additive:
 * cards without `actions` render exactly as before, and action buttons that call
 * stopPropagation do not trigger the card-body onAction.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { Button } from '@mui/material';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { TileCard } from '../src/core/hmi/TileCard';
import type { RVViewer } from '../src/core/rv-viewer';

function mockViewer(): RVViewer {
  return {
    highlightByPath: () => {},
    clearHighlight: () => {},
    focusByPath: () => {},
    filterDrives: () => {},
  } as unknown as RVViewer;
}

function wrap(ui: ReactNode) {
  return (
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={mockViewer()}>{ui}</RVViewerProvider>
    </ThemeProvider>
  );
}

describe('TileCard — actions backcompat', () => {
  afterEach(() => cleanup());

  it('renders unchanged (no footer) when actions is omitted', () => {
    const { container } = render(wrap(
      <TileCard title="Plain" subtitle="sub" severity="info" icon="speed" timestamp="Live" />,
    ));
    expect(screen.getByText('Plain')).toBeTruthy();
    // No extra footer buttons besides the built-in OpenInNew icon button.
    expect(container.querySelectorAll('button').length).toBe(1);
  });

  it('renders the action button row when actions provided', () => {
    render(wrap(
      <TileCard
        title="WithActions" subtitle="sub" severity="error" icon="warning" timestamp="08:42"
        actions={<Button>Do It</Button>}
      />,
    ));
    expect(screen.getByRole('button', { name: /do it/i })).toBeTruthy();
  });

  it('action button with stopPropagation does not trigger the card onAction', () => {
    const onAction = vi.fn();
    render(wrap(
      <TileCard
        title="Guard" subtitle="sub" severity="error" icon="warning" timestamp="08:42"
        onAction={onAction}
        actions={<Button onClick={(e) => e.stopPropagation()}>Inner</Button>}
      />,
    ));
    fireEvent.click(screen.getByRole('button', { name: /inner/i }));
    expect(onAction).not.toHaveBeenCalled();
  });
});
