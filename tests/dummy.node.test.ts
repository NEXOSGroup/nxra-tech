// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';

describe('Node test environment smoke', () => {
  it('runs in node environment (process is available)', () => {
    expect(typeof process).toBe('object');
    expect(process.versions.node).toBeDefined();
  });

  it('does not have DOM globals', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
  });
});
