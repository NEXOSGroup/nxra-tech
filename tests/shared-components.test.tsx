// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SectionHeader } from '../src/core/hmi/shared-components';

describe('SectionHeader', () => {
  afterEach(() => cleanup());

  it('renders its text content', () => {
    render(<SectionHeader>Profiler</SectionHeader>);
    expect(screen.getByText('Profiler')).toBeTruthy();
  });

  it('renders ReactNode children (not only strings)', () => {
    render(
      <SectionHeader>
        <span data-testid="inner">Drives (3)</span>
      </SectionHeader>,
    );
    expect(screen.getByTestId('inner').textContent).toBe('Drives (3)');
  });

  it('applies the canonical caption styling (uppercase, small caps look)', () => {
    render(<SectionHeader>Optimization</SectionHeader>);
    const el = screen.getByText('Optimization');
    const styles = window.getComputedStyle(el);
    // MUI applies sx via emotion; the computed text-transform is the most
    // stable assertion across MUI versions.
    expect(styles.textTransform).toBe('uppercase');
  });
});
