// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for the shared InspectorRow layout primitive — the single source of
 * truth for the "label → field" grid every Property Inspector row uses.
 * Runs in real Chromium (browser-mode), so getComputedStyle resolves the grid
 * tracks; we assert on track COUNT (4 = scalar, 3 = full-width) rather than
 * exact pixels.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { InspectorRow } from '../src/core/hmi/rv-inspector-row';

afterEach(() => cleanup());

/** The grid container is the parent of the label Typography. */
function gridOf(labelText: string): HTMLElement {
  return screen.getByText(labelText).parentElement as HTMLElement;
}

function trackCount(grid: HTMLElement): number {
  return getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length;
}

describe('InspectorRow', () => {
  it('scalar row uses a 4-track grid (gutter · label · spacer · field)', () => {
    render(
      <div style={{ width: 320 }}>
        <InspectorRow label="Speed"><span>10</span></InspectorRow>
      </div>,
    );
    expect(trackCount(gridOf('Speed'))).toBe(4);
  });

  it('fullWidthField row uses a 3-track grid (gutter · label · field)', () => {
    render(
      <div style={{ width: 320 }}>
        <InspectorRow fullWidthField label="Position"><span>xyz</span></InspectorRow>
      </div>,
    );
    expect(trackCount(gridOf('Position'))).toBe(3);
  });

  it('renders the field children and the dot in the gutter', () => {
    render(
      <InspectorRow label="Speed" dot={<i data-testid="dot" />}>
        <span>10</span>
      </InspectorRow>,
    );
    expect(screen.getByText('10')).toBeTruthy();
    expect(screen.getByTestId('dot')).toBeTruthy();
  });

  it('truncates the label with an ellipsis', () => {
    render(<InspectorRow label="VeryLongFieldLabelName"><span>v</span></InspectorRow>);
    const label = screen.getByText('VeryLongFieldLabelName');
    expect(getComputedStyle(label).textOverflow).toBe('ellipsis');
  });

  it('right-aligns the field cell when alignField="end" (no ml:auto needed)', () => {
    render(<InspectorRow label="On" alignField="end"><span>toggle</span></InspectorRow>);
    const cell = screen.getByText('toggle').parentElement as HTMLElement;
    expect(getComputedStyle(cell).justifyContent).toBe('flex-end');
  });
});
