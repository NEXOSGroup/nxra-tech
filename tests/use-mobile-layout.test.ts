// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { isCompactWidth, MOBILE_BREAKPOINT } from '../src/hooks/use-mobile-layout';

describe('isCompactWidth', () => {
  it('uses the compact layout below the breakpoint (phones)', () => {
    expect(isCompactWidth(390)).toBe(true);  // iPhone portrait
    expect(isCompactWidth(768)).toBe(true);  // iPad mini portrait
    expect(isCompactWidth(834)).toBe(true);  // iPad 11" portrait
    expect(isCompactWidth(MOBILE_BREAKPOINT - 1)).toBe(true);
  });

  it('uses the standard dock at or above the breakpoint (large tablets / desktop)', () => {
    expect(isCompactWidth(MOBILE_BREAKPOINT)).toBe(false);
    expect(isCompactWidth(1024)).toBe(false); // iPad 12.9" portrait
    expect(isCompactWidth(1366)).toBe(false); // tablet landscape / laptop
    expect(isCompactWidth(1920)).toBe(false);
  });

  it('pins the breakpoint at 900px (phone vs. large tablet boundary)', () => {
    expect(MOBILE_BREAKPOINT).toBe(900);
  });
});
