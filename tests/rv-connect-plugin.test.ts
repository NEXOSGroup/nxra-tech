// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { ConnectPlugin } from '../src/plugins/connect-plugin';

describe('ConnectPlugin', () => {
  it('should have correct id', () => {
    const plugin = new ConnectPlugin();
    expect(plugin.id).toBe('connect');
  });

  it('should register a toolbar-button slot', () => {
    const plugin = new ConnectPlugin();
    expect(plugin.slots).toBeDefined();
    expect(plugin.slots.length).toBe(1);
    // ConnectPlugin renders in the TopBar (toolbar-button slot), not in
    // the left vertical Nav strip — see TopBar.tsx <SlotRenderer
    // slot="toolbar-button" />. Earlier revisions used 'button-group'.
    expect(plugin.slots[0].slot).toBe('toolbar-button');
    expect(plugin.slots[0].order).toBe(10);
    expect(typeof plugin.slots[0].component).toBe('function');
  });

  it('should have order 55 for plugin priority', () => {
    const plugin = new ConnectPlugin();
    expect(plugin.order).toBe(55);
  });
});
