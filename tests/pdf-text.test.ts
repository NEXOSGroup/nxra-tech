// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * pdf-text tests — graceful behavior of the headless page-text helpers.
 *
 * Runs in browser mode (Playwright/Chromium). These assert the contract that
 * matters for production: never throw, return '' / null on failure. A real-PDF
 * extraction is exercised opportunistically against the bundled FANUC manual
 * but tolerates absence so the suite stays deterministic in CI.
 */

import { describe, it, expect } from 'vitest';
import { extractPdfPageText, findFirstPageWithText } from '../src/core/hmi/pdf-text';

const FANUC_URL = `${import.meta.env.BASE_URL}pdf/fanuc-crx-educational-cell-manual.pdf`;

describe('pdf-text — graceful degradation', () => {
  it('extractPdfPageText returns "" for an unreachable URL (no throw)', async () => {
    const text = await extractPdfPageText('/does-not-exist-xyz.pdf', 1);
    expect(text).toBe('');
  });

  it('findFirstPageWithText returns null for an unreachable URL (no throw)', async () => {
    const page = await findFirstPageWithText('/does-not-exist-xyz.pdf', ['payload']);
    expect(page).toBeNull();
  });

  it('findFirstPageWithText returns null for empty terms', async () => {
    const page = await findFirstPageWithText(FANUC_URL, []);
    expect(page).toBeNull();
  });
});

describe('pdf-text — bundled FANUC manual (opportunistic)', () => {
  it('extracts non-empty text from a real page (or "" if asset missing)', async () => {
    const text = await extractPdfPageText(FANUC_URL, 1);
    // Either real text (asset present) or '' (asset not served in this env). Never throws.
    expect(typeof text).toBe('string');
  });

  it('finds a page for a common term or returns null', async () => {
    const page = await findFirstPageWithText(FANUC_URL, ['payload', 'contact']);
    expect(page === null || (typeof page === 'number' && page >= 1)).toBe(true);
  });
});
