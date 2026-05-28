// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { PLUGIN_ORDER } from '../src/core/rv-plugin-order';

describe('PLUGIN_ORDER constants (plan-182 Phase 5)', () => {
  it('contains the documented range slots', () => {
    expect(PLUGIN_ORDER.CORE_PRE).toBe(0);
    expect(PLUGIN_ORDER.INTERFACE_ADAPTER).toBe(10);
    expect(PLUGIN_ORDER.SIM_DEFAULT).toBe(100);
    expect(PLUGIN_ORDER.UI_OVERLAY).toBe(250);
    expect(PLUGIN_ORDER.DEBUG).toBe(990);
  });

  it('values are sorted in ascending order', () => {
    const values = Object.values(PLUGIN_ORDER);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });

  it('CORE_PRE < INTERFACE_ADAPTER < SIM_DEFAULT < UI_OVERLAY < DEBUG (key relationships)', () => {
    expect(PLUGIN_ORDER.CORE_PRE).toBeLessThan(PLUGIN_ORDER.INTERFACE_ADAPTER);
    expect(PLUGIN_ORDER.INTERFACE_ADAPTER).toBeLessThan(PLUGIN_ORDER.SIM_DEFAULT);
    expect(PLUGIN_ORDER.SIM_DEFAULT).toBeLessThan(PLUGIN_ORDER.UI_OVERLAY);
    expect(PLUGIN_ORDER.UI_OVERLAY).toBeLessThan(PLUGIN_ORDER.DEBUG);
  });
});
