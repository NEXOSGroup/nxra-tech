// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * scope-symbol-separator.node.test.ts — Plan 200 §10.2 (SYM grep-guard).
 *
 * The PLC-facing signal SYMBOL is now dot-scoped (`${scope}.${name}` =
 * `RollConveyor-1m.Flow.Occupied`). `scopeSignalName()` in rv-instance-scope.ts
 * is the single producer of a scoped symbol — no `src/` module may hand-build a
 * scoped signal NAME with the old `${scope}/${name}` slash form, or producer and
 * consumer would diverge on the separator (a silent interlock self-deadlock).
 *
 * The scene-graph NODE path legitimately stays `/`-separated (it is the technical
 * hierarchy address, not the symbol). The one sanctioned `${scope}/...` literal
 * builds that node path and is recognised by its `SIGNALS_CONTAINER_NAME` segment
 * (allow-listed below). Anything else that interpolates `${scope}/` is a
 * forbidden scoped-symbol construction.
 *
 * This guard scans every `src/**.ts(x)` source file (CODE only — comments are
 * stripped first, since prose may legitimately show the old form). Runs in the
 * Node environment (see vitest.node.config.ts).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC_DIR = resolve(__dirname, '../src');

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) acc.push(full);
  }
  return acc;
}

/** Strip `//` line comments and block comments so prose mentions don't trip the guard. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// A `${scope}/` (or `${signalScope}/`) interpolation inside a template literal.
// The scope variable is the instance-scope prefix; immediately followed by a
// literal `/` it would build the OLD slash-separated scoped symbol.
const SCOPE_SLASH = /\$\{\s*(?:scope|signalScope)\s*\}\//g;

// The single sanctioned form: the node path, recognised by the
// `SIGNALS_CONTAINER_NAME` segment right after the scope (`${scope}/${SIGNALS_CONTAINER_NAME}/...`).
const NODE_PATH_ALLOW = /\$\{\s*(?:scope|signalScope)\s*\}\/\$\{\s*SIGNALS_CONTAINER_NAME\s*\}/;

describe('SYM scope-symbol separator guard (plan-200 §10.2)', () => {
  const files = walk(SRC_DIR);

  it(`scans src/ directory (${SRC_DIR})`, () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no src/ code builds a scoped signal SYMBOL with the slash separator', () => {
    const violations: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf-8'));
      // Tokenise each `${scope}/...` occurrence; allow only the node-path form.
      const matches = code.match(SCOPE_SLASH);
      if (!matches) continue;
      // Re-scan with surrounding context to distinguish node path from symbol.
      let idx = 0;
      while ((idx = code.indexOf('}/', idx)) !== -1) {
        // Look back to confirm the interpolation is a scope variable.
        const window = code.slice(Math.max(0, idx - 20), idx + 40);
        if (/\$\{\s*(?:scope|signalScope)\s*\}\//.test(window)) {
          if (!NODE_PATH_ALLOW.test(window)) {
            violations.push(`${relative(SRC_DIR, file)} :: ${window.trim()}`);
          }
        }
        idx += 2;
      }
    }
    expect(violations).toEqual([]);
  });
});
