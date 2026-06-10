// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * flow-occupied-ssot.node.test.ts — Plan 199 §8.3 (SSOT guard).
 *
 * The material-flow interlock signal lives in ONE place: the exported
 * `FLOW_OCCUPIED = 'Flow.Occupied'` constant in transport-links.ts. No `src/`
 * module may hand-build the old `Conveyor.<interopSignal>` literal (Occupied /
 * Run / Running / PartCount) ever again — they would resolve against a namespace
 * no component publishes and silently deadlock the interlock.
 *
 * This guard scans every `src/**.ts(x)` source file (CODE only — comments are
 * stripped first, since prose may legitimately mention the historical name) and
 * fails on any quoted `'Conveyor.<signal>'` literal. Importing the
 * `FLOW_OCCUPIED` constant is the sanctioned path. `tests/` are excluded by
 * construction (we only walk `src/`).
 *
 * Runs in the Node environment (see vitest.node.config.ts).
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
  // Block comments (/* ... */) including JSDoc, then line comments (// ... EOL).
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Quoted literal `'Conveyor.Occupied'` / `'Conveyor.Run'` / `Running` / `PartCount`
// (single OR double quotes). The leading quote rules out `signalNamespace`/`type`
// matches like `'Conveyor'` (the component name, which legitimately stays).
const FORBIDDEN = /['"]Conveyor\.(Occupied|Run|Running|PartCount)['"]/;

describe('Flow.Occupied SSOT guard (plan-199 §8.3)', () => {
  const files = walk(SRC_DIR);

  it(`scans src/ directory (${SRC_DIR})`, () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no src/ code literal builds the old Conveyor.<interopSignal> name', () => {
    const violations: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf-8'));
      if (FORBIDDEN.test(code)) {
        violations.push(relative(SRC_DIR, file));
      }
    }
    expect(violations).toEqual([]);
  });
});
