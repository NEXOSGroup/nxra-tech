// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { ConnectPlugin } from '../src/plugins/connect-plugin';

describe('ConnectPlugin', () => {
  it('should have correct id', () => {
    const plugin = new ConnectPlugin();
    expect(plugin.id).toBe('connect');
  });

  it('should register an activity-bar slot', () => {
    const plugin = new ConnectPlugin();
    expect(plugin.slots).toBeDefined();
    expect(plugin.slots.length).toBe(1);
    // CONNECT opens a left-docked window, so its button lives in the left
    // ACTIVITY BAR (activity-bar slot) — see ActivityBar.tsx. Earlier revisions
    // used 'toolbar-button' (TopBar) and 'button-group'.
    expect(plugin.slots[0].slot).toBe('activity-bar');
    expect(plugin.slots[0].order).toBe(60);
    expect(typeof plugin.slots[0].component).toBe('function');
  });

  it('should have order 55 for plugin priority', () => {
    const plugin = new ConnectPlugin();
    expect(plugin.order).toBe(55);
  });
});
