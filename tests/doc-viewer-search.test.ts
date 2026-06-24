// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { findMatchPages, highlightHtml, escapeRegExp } from '../src/core/hmi/DocViewerOverlay';

describe('findMatchPages', () => {
  const pages = ['the motor is hot', 'no match here', 'motor motor MOTOR'];

  it('returns one entry per occurrence, with 1-based page numbers', () => {
    // page 1: 1×, page 3: 3× (case-insensitive)
    expect(findMatchPages(pages, 'motor')).toEqual([1, 3, 3, 3]);
  });

  it('is case-insensitive for both haystack and query', () => {
    expect(findMatchPages(pages, 'MOTOR')).toEqual([1, 3, 3, 3]);
  });

  it('returns empty for blank/whitespace query', () => {
    expect(findMatchPages(pages, '')).toEqual([]);
    expect(findMatchPages(pages, '   ')).toEqual([]);
  });

  it('returns empty when nothing matches', () => {
    expect(findMatchPages(pages, 'gearbox')).toEqual([]);
  });

  it('counts overlapping-safe sequential occurrences', () => {
    expect(findMatchPages(['aaaa'], 'aa')).toEqual([1, 1]); // non-overlapping: positions 0 and 2
  });
});

describe('highlightHtml', () => {
  it('wraps each occurrence in a highlight mark', () => {
    expect(highlightHtml('hot motor', 'motor')).toBe('hot <mark class="rv-pdf-hl">motor</mark>');
  });

  it('preserves the original casing inside the mark', () => {
    expect(highlightHtml('Motor MOTOR', 'motor')).toBe('<mark class="rv-pdf-hl">Motor</mark> <mark class="rv-pdf-hl">MOTOR</mark>');
  });

  it('returns the string unchanged for a blank query', () => {
    expect(highlightHtml('hot motor', '')).toBe('hot motor');
  });

  it('treats regex metacharacters in the query literally', () => {
    expect(highlightHtml('value (a.b)', '(a.b)')).toBe('value <mark class="rv-pdf-hl">(a.b)</mark>');
    expect(highlightHtml('a.b axb', 'a.b')).toBe('<mark class="rv-pdf-hl">a.b</mark> axb');
  });
});

describe('escapeRegExp', () => {
  it('escapes regex special characters', () => {
    expect(escapeRegExp('a.b*c')).toBe('a\\.b\\*c');
  });
});
