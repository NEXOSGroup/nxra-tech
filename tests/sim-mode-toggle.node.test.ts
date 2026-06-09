// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * sim-mode-toggle.node.test.ts — Plan 194 V7 import-boundary guard.
 *
 * The public `SimModeToggle` UI MUST NOT import the private `DESRunner` (or any
 * `@rv-private` / `realvirtual-WebViewer-Private~` path). It drives the DES
 * sub-mode/KPI surface ONLY through the public kernel facade
 * (`simulation-kernel`'s `SimDesControl`). This node-mode test reads the
 * component source and asserts no forbidden import string is present, so the
 * boundary cannot silently regress.
 *
 * Runs in the Node environment (vitest.node.config.ts).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TOGGLE = resolve(__dirname, '../src/plugins/sim-controller/SimModeToggle.tsx');

describe('SimModeToggle import boundary (plan-194 V7)', () => {
  const src = readFileSync(TOGGLE, 'utf-8');

  // Extract only the import lines (so a comment mentioning DESRunner does not
  // trip the test — the constraint is about actual imports).
  const importLines = src
    .split('\n')
    .filter(l => /^\s*import\b/.test(l) || /\bfrom\s+['"]/.test(l));
  const importBlock = importLines.join('\n');

  it('does not import DESRunner', () => {
    expect(/DESRunner/.test(importBlock)).toBe(false);
  });

  it('does not import from the private package (@rv-private / WebViewer-Private)', () => {
    expect(/@rv-private/.test(importBlock)).toBe(false);
    expect(/realvirtual-WebViewer-Private/.test(importBlock)).toBe(false);
  });

  it('does not import from the des plugin folder', () => {
    expect(/plugins\/des\b/.test(importBlock)).toBe(false);
  });

  it('imports the public kernel facade (positive control)', () => {
    expect(/from\s+['"][^'"]*material-flow\/simulation-kernel['"]/.test(importBlock)).toBe(true);
  });
});
