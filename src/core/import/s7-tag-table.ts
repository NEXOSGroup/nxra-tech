// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * s7-tag-table.ts — Browser-side import of Siemens TIA tag tables for the
 * realvirtual CONNECT MQTT ProcessImage interface.
 *
 * A tag table (xlsx or csv) lists named signals with their Siemens symbolic
 * address (e.g. `%I0.0`, `%IW13`, `%MD20`), data type and an optional comment.
 * This module parses such a table into a flat list of {@link S7Tag}, validates
 * each address against its data type, derives the rv wire type, and runs an
 * overlap check (range overlap, including cross-area) so the user is warned
 * about non-flat tables before pushing the configuration to CONNECT.
 *
 * xlsx parsing uses `read-excel-file` (lazy-loaded to keep the initial bundle
 * small and to avoid pulling a spreadsheet parser into the critical path).
 * csv parsing is delimiter-autodetecting (`,` / `;` / Tab — German TIA exports
 * frequently use `;`).
 *
 * The result mirrors the CONNECT-side decoder: parse/conflict errors are hard
 * (the offending tag is dropped into `warnings`), whereas range overlaps are
 * soft warnings (`overlaps`) that do NOT block the push.
 */

// ── Public Types ───────────────────────────────────────────────────────────

export interface S7Tag {
  name: string;
  /** Siemens data type as written in the table: Bool/Byte/Word/Int/DWord/DInt/Real/LReal. */
  dataType: string;
  /** Original symbolic address, e.g. "%IW13". */
  address: string;
  /** Memory area letter: I/Q/M/E/A. */
  area: string;
  comment?: string;
}

export interface ParsedTagTable {
  tags: S7Tag[];
  /** Hard problems (invalid address, data-type/size conflict). Offending tags are dropped. */
  warnings: string[];
  /** Soft range-overlap warnings — these do NOT block the push. */
  overlaps: string[];
}

// ── Address Parsing ─────────────────────────────────────────────────────────

/** Siemens symbolic address: optional `%`, area letter, optional size letter, byte offset, optional bit. */
const ADDRESS_RE = /^%?([IQMEA])([BWDX]?)(\d+)(?:\.([0-7]))?$/;

/** Recognized Siemens data types and their byte length (Bool handled separately as 1 bit). */
const TYPE_SIZE: Record<string, number> = {
  bool: 0, // bit
  byte: 1,
  word: 2,
  int: 2,
  dword: 4,
  dint: 4,
  real: 4,
  lreal: 8,
};

export interface ParsedAddress {
  area: string;
  byteOffset: number;
  /** Bit index 0–7, or undefined for byte-aligned access. */
  bit?: number;
  /** Length in bytes the data type occupies (Bool = 1 byte range for overlap purposes). */
  byteLength: number;
}

/**
 * Parse a Siemens symbolic address against a data type.
 * Returns the parsed address, or sets `error` (and returns null) when the
 * address is invalid or its size letter conflicts with the data type.
 */
export function parseAddress(
  address: string,
  dataType: string,
): { parsed: ParsedAddress | null; error: string | null } {
  const raw = address.trim();
  const m = ADDRESS_RE.exec(raw);
  if (!m) {
    return { parsed: null, error: `Invalid address "${address}"` };
  }

  const area = m[1].toUpperCase();
  const sizeLetter = m[2].toUpperCase(); // '' | 'B' | 'W' | 'D' | 'X'
  const byteOffset = parseInt(m[3], 10);
  const bit = m[4] !== undefined ? parseInt(m[4], 10) : undefined;

  const dt = dataType.trim().toLowerCase();
  const typeBytes = TYPE_SIZE[dt];
  if (typeBytes === undefined) {
    return { parsed: null, error: `Unknown data type "${dataType}" for ${address}` };
  }

  const isBool = dt === 'bool';

  // Bit access (`X` or `.n`) is only valid for Bool, and Bool requires bit access.
  const hasBit = sizeLetter === 'X' || bit !== undefined;
  if (isBool && !hasBit) {
    return { parsed: null, error: `Bool tag "${address}" requires a bit address (e.g. %I0.0)` };
  }
  if (!isBool && hasBit) {
    return { parsed: null, error: `Non-bool type "${dataType}" cannot use a bit address (${address})` };
  }

  // Size letter must match the data type's byte width.
  if (!isBool && sizeLetter !== '') {
    const letterBytes = sizeLetter === 'B' ? 1 : sizeLetter === 'W' ? 2 : sizeLetter === 'D' ? 4 : -1;
    if (letterBytes !== typeBytes) {
      return {
        parsed: null,
        error: `Address size "${sizeLetter}" conflicts with data type "${dataType}" (${address})`,
      };
    }
  }

  return {
    parsed: {
      area,
      byteOffset,
      bit,
      byteLength: isBool ? 1 : typeBytes,
    },
    error: null,
  };
}

// ── Wire-type derivation ────────────────────────────────────────────────────

/**
 * Derive the rv PLC wire type (always an input) from a Siemens data type.
 *   Bool                         → PLCInputBool
 *   Byte/Word/Int/DWord/DInt     → PLCInputInt
 *   Real/LReal                   → PLCInputFloat
 */
export function deriveWireType(dataType: string): string {
  const dt = dataType.trim().toLowerCase();
  if (dt === 'bool') return 'PLCInputBool';
  if (dt === 'real' || dt === 'lreal') return 'PLCInputFloat';
  // Byte, Word, Int, DWord, DInt and any other integral type.
  return 'PLCInputInt';
}

// ── Overlap check ───────────────────────────────────────────────────────────

/**
 * Detect byte-range overlaps between tags. The table is expected to be flat
 * (Area ignored, offset = index), so any overlapping byte range — including
 * cross-area (`%I3.x` vs `%M3.x`) — is reported as a non-blocking warning.
 */
function findOverlaps(tags: S7Tag[]): string[] {
  const overlaps: string[] = [];
  interface Range { tag: S7Tag; start: number; end: number; isBit: boolean; bit: number; }
  const ranges: Range[] = [];

  for (const tag of tags) {
    const { parsed } = parseAddress(tag.address, tag.dataType);
    if (!parsed) continue; // already reported as a hard warning
    ranges.push({
      tag,
      start: parsed.byteOffset,
      end: parsed.byteOffset + parsed.byteLength - 1,
      isBit: parsed.bit !== undefined,
      bit: parsed.bit ?? -1,
    });
  }

  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i];
      const b = ranges[j];
      // Byte ranges must intersect to possibly overlap.
      if (a.start > b.end || b.start > a.end) continue;
      // Two distinct bits in the same single byte do NOT overlap.
      if (a.isBit && b.isBit && a.start === b.start && a.end === b.end && a.bit !== b.bit) continue;
      overlaps.push(
        `Overlap: "${a.tag.name}" (${a.tag.address}) overlaps "${b.tag.name}" (${b.tag.address})`,
      );
    }
  }
  return overlaps;
}

// ── Row → tags ──────────────────────────────────────────────────────────────

type Cell = string | number | boolean | Date | null | undefined;

function cellToString(cell: Cell): string {
  if (cell === null || cell === undefined) return '';
  return String(cell).trim();
}

/** A cell looks like a Siemens address (used for header auto-detect). */
const ADDRESS_LIKE_RE = /^%?[IQMEA][BWDX]?\d+(\.[0-7])?$/;

/**
 * Build tags from a matrix of rows (header auto-detected). Each row is expected
 * to follow the fixed column order Name, Type, Adress, Comment.
 */
function rowsToTable(rows: Cell[][]): ParsedTagTable {
  const tags: S7Tag[] = [];
  const warnings: string[] = [];

  // Header auto-detect (F7): skip the first row when its 3rd column (the address)
  // is NOT a Siemens address; otherwise the first row is already data.
  let startRow = 0;
  if (rows.length > 0) {
    const firstAddr = cellToString(rows[0][2]);
    if (!ADDRESS_LIKE_RE.test(firstAddr)) {
      startRow = 1;
    }
  }

  for (let r = startRow; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;

    const name = cellToString(row[0]);
    const dataType = cellToString(row[1]);
    const address = cellToString(row[2]);
    const comment = cellToString(row[3]);

    // Skip fully empty rows.
    if (!name && !dataType && !address) continue;

    if (!name || !address) {
      warnings.push(`Row ${r + 1}: missing name or address — skipped`);
      continue;
    }

    const { parsed, error } = parseAddress(address, dataType);
    if (!parsed) {
      warnings.push(`Row ${r + 1} "${name}": ${error}`);
      continue;
    }

    tags.push({
      name,
      dataType: dataType,
      address,
      area: parsed.area,
      comment: comment || undefined,
    });
  }

  const overlaps = findOverlaps(tags);
  return { tags, warnings, overlaps };
}

// ── CSV parsing ─────────────────────────────────────────────────────────────

/** Autodetect the CSV delimiter by counting `,`, `;` and Tab on the first line. */
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const counts: Record<string, number> = {
    ';': (firstLine.match(/;/g) ?? []).length,
    '\t': (firstLine.match(/\t/g) ?? []).length,
    ',': (firstLine.match(/,/g) ?? []).length,
  };
  let best = ',';
  let bestCount = -1;
  for (const d of [';', '\t', ',']) {
    if (counts[d] > bestCount) {
      best = d;
      bestCount = counts[d];
    }
  }
  return best;
}

/** Split a single CSV line on a delimiter, honoring double-quoted fields. */
function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text: string): ParsedTagTable {
  const delimiter = detectDelimiter(text);
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  const rows: Cell[][] = lines.map(l => splitCsvLine(l, delimiter));
  return rowsToTable(rows);
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Parse a Siemens tag table file (xlsx or csv) into a flat list of tags with
 * validation and overlap warnings.
 */
export async function parseTagTable(file: File): Promise<ParsedTagTable> {
  const name = (file.name ?? '').toLowerCase();
  const isXlsx = name.endsWith('.xlsx') || name.endsWith('.xls');

  if (isXlsx) {
    // Lazy-load the spreadsheet parser only when an xlsx is actually imported.
    const mod = await import('read-excel-file');
    const readXlsxFile = (mod.default ?? mod) as (input: File | Blob | ArrayBuffer) => Promise<Cell[][]>;
    const rows = await readXlsxFile(file);
    return rowsToTable(rows);
  }

  const text = await file.text();
  return parseCsv(text);
}
