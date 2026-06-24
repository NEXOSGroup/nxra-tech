// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * pdf-text.ts — Headless PDF page-text extraction helpers.
 *
 * Reuses the single react-pdf / pdf.js loader from DocViewerOverlay (one worker
 * setup, promise-cached) so there is no second loader. These helpers let UI code
 * pull a real text excerpt from a bundled PDF and resolve which page contains a
 * given set of terms — without rendering anything.
 *
 * All functions degrade gracefully: on any error (load failure, missing page,
 * CORS) they return an empty string / null instead of throwing.
 */

import { loadReactPdf } from './DocViewerOverlay';

/** Minimal structural view of a pdf.js page text content item. */
interface TextItem {
  str?: unknown;
}

/** Minimal structural view of the pdf.js document proxy we use here. */
interface PdfDocProxy {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: ReadonlyArray<unknown> }> }>;
}

/** Per-URL cache of the loaded document proxy so repeated calls share one parse. */
const _docCache = new Map<string, Promise<PdfDocProxy | null>>();

/** Load (and cache) the pdf.js document proxy for a URL. Never throws. */
function getDoc(url: string): Promise<PdfDocProxy | null> {
  let p = _docCache.get(url);
  if (!p) {
    p = loadReactPdf()
      .then((mod) => mod.pdfjs.getDocument(url).promise as unknown as PdfDocProxy)
      .catch(() => null);
    _docCache.set(url, p);
  }
  return p;
}

/** Join a page's text content items into a single whitespace-collapsed string. */
function joinItems(items: ReadonlyArray<unknown>): string {
  return items
    .map((i) => {
      const s = (i as TextItem).str;
      return typeof s === 'string' ? s : '';
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract the plain text of a single 1-based page. Returns an empty string when
 * the page is out of range or extraction fails.
 */
export async function extractPdfPageText(url: string, page: number): Promise<string> {
  try {
    const doc = await getDoc(url);
    if (!doc) return '';
    if (page < 1 || page > doc.numPages) return '';
    const content = await (await doc.getPage(page)).getTextContent();
    return joinItems(content.items);
  } catch {
    return '';
  }
}

/**
 * Find the first 1-based page whose text contains ANY of the given terms
 * (case-insensitive). Returns `null` when no page matches or extraction fails —
 * callers fall back to a static page in that case.
 */
export async function findFirstPageWithText(url: string, terms: string[]): Promise<number | null> {
  const needles = terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
  if (needles.length === 0) return null;
  try {
    const doc = await getDoc(url);
    if (!doc) return null;
    for (let p = 1; p <= doc.numPages; p++) {
      let hay = '';
      try {
        const content = await (await doc.getPage(p)).getTextContent();
        hay = joinItems(content.items).toLowerCase();
      } catch {
        continue;
      }
      if (needles.some((n) => hay.includes(n))) return p;
    }
    return null;
  } catch {
    return null;
  }
}
