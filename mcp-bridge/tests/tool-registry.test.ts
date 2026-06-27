// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../src/tool-registry.js';
import type { ToolSchema } from '../src/protocol.js';

function tool(name: string): ToolSchema {
  return { name, description: name, inputSchema: { type: 'object', properties: {}, required: [] } };
}

describe('ToolRegistry', () => {
  it('replaces the whole set on each replace()', () => {
    const reg = new ToolRegistry();
    reg.replace([tool('web_status'), tool('web_logs')]);
    expect(reg.list().map((t) => t.name).sort()).toEqual(['web_logs', 'web_status']);
    reg.replace([tool('web_find')]);
    expect(reg.list().map((t) => t.name)).toEqual(['web_find']);
  });

  it('ignores entries without a name', () => {
    const reg = new ToolRegistry();
    reg.replace([tool('web_status'), { name: '' } as ToolSchema, undefined as unknown as ToolSchema]);
    expect(reg.size).toBe(1);
    expect(reg.has('web_status')).toBe(true);
  });

  it('clears to empty', () => {
    const reg = new ToolRegistry();
    reg.replace([tool('web_status')]);
    reg.clear();
    expect(reg.size).toBe(0);
    expect(reg.list()).toEqual([]);
  });
});
