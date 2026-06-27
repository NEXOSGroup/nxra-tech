// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { ToolSchema } from './protocol.js';

/**
 * Self-managed registry of browser-announced tools.
 *
 * The low-level MCP `Server` does not own a tool list (unlike the high-level
 * `McpServer`), so we keep the list here and serve it from the ListTools handler.
 * `replace()` is called on every `discover`; `clear()` on browser disconnect.
 */
export class ToolRegistry {
  private readonly _tools = new Map<string, ToolSchema>();

  /** Replace the whole set with the announced tools (ignores entries without a name). */
  replace(tools: ToolSchema[]): void {
    this._tools.clear();
    for (const t of tools) {
      if (t && typeof t.name === 'string' && t.name.length > 0) {
        this._tools.set(t.name, t);
      }
    }
  }

  clear(): void {
    this._tools.clear();
  }

  has(name: string): boolean {
    return this._tools.has(name);
  }

  list(): ToolSchema[] {
    return [...this._tools.values()];
  }

  get size(): number {
    return this._tools.size;
  }
}
