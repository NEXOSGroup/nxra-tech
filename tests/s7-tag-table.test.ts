// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for the browser-side Siemens tag-table importer (s7-tag-table.ts).
 * Covers CSV header autodetect, delimiter autodetect, address/type validation,
 * overlap warnings (non-blocking) and wire-type derivation.
 */

import { describe, it, expect } from 'vitest';
import { parseTagTable, deriveWireType } from '../src/core/import/s7-tag-table';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a File from text content (csv). */
function csvFile(content: string, name = 'tags.csv'): File {
  return new File([content], name, { type: 'text/csv' });
}

describe('parseTagTable — CSV', () => {
  it('csvWithHeader: skips the header row and parses tags', async () => {
    const csv = [
      'Name,Type,Adress,Comment',
      'Motor_Start,Bool,%I0.0,start button',
      'ActualTemp,Word,%IW13,temperature',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    expect(result.tags).toHaveLength(2);
    expect(result.tags[0].name).toBe('Motor_Start');
    expect(result.tags[0].area).toBe('I');
    expect(result.tags[0].address).toBe('%I0.0');
    expect(result.tags[1].name).toBe('ActualTemp');
    expect(result.tags[1].dataType).toBe('Word');
    expect(result.warnings).toHaveLength(0);
  });

  it('csvNoHeader: treats the first row as data when col 3 is an address', async () => {
    const csv = [
      'Motor_Start,Bool,%I0.0,start',
      'ActualTemp,Word,%IW13,temp',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    expect(result.tags).toHaveLength(2);
    expect(result.tags[0].name).toBe('Motor_Start');
  });

  it('semicolonDelimited: autodetects the ";" delimiter (German TIA export)', async () => {
    const csv = [
      'Name;Type;Adress;Comment',
      'Valve_Open;Bool;%Q0.1;open valve',
      'Pressure;Real;%MD20;line pressure',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    expect(result.tags).toHaveLength(2);
    expect(result.tags[0].name).toBe('Valve_Open');
    expect(result.tags[0].area).toBe('Q');
    expect(result.tags[1].name).toBe('Pressure');
    expect(result.tags[1].dataType).toBe('Real');
  });

  it('tabDelimited: autodetects the Tab delimiter', async () => {
    const csv = [
      'Name\tType\tAdress\tComment',
      'Sensor_1\tBool\t%I2.3\tbarrier',
      'Counter\tDInt\t%MD40\tparts',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    expect(result.tags).toHaveLength(2);
    expect(result.tags[0].name).toBe('Sensor_1');
    expect(result.tags[1].name).toBe('Counter');
    expect(result.tags[1].dataType).toBe('DInt');
  });

  it('bareAddress: accepts byte.bit addresses without an area letter (raw process image)', async () => {
    const csv = [
      'Name,Type,Adress,Comment',
      '3146,Bool,96.0,bare bit',
      '3145,Bool,96.1,bare bit',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    expect(result.tags).toHaveLength(2);
    expect(result.tags[0].address).toBe('96.0');
    expect(result.tags[0].area).toBe('');
    expect(result.tags[1].address).toBe('96.1');
    expect(result.warnings).toHaveLength(0);
  });

  it('bareAddressByte: accepts a bare byte address without area letter or bit', async () => {
    const csv = [
      'Name,Type,Adress,Comment',
      'Counter,Word,96,bare byte word',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    expect(result.tags).toHaveLength(1);
    expect(result.tags[0].address).toBe('96');
  });

  it('bareAddressNoHeader: first row with a bare address is imported as data (no header)', async () => {
    const csv = [
      '3146,Bool,96.0,bare bit',
      '3145,Bool,96.1,bare bit',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    expect(result.tags).toHaveLength(2);
    expect(result.tags[0].name).toBe('3146');
    expect(result.tags[1].name).toBe('3145');
  });

  it('invalidAddress: produces a warning and drops the tag', async () => {
    const csv = [
      'Name,Type,Adress,Comment',
      'Good,Bool,%I0.0,ok',
      'Bad,Bool,%IZ9,invalid area',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    expect(result.tags).toHaveLength(1);
    expect(result.tags[0].name).toBe('Good');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.includes('Bad'))).toBe(true);
  });

  it('dataTypeConflict: size letter conflicts with data type → tag rejected', async () => {
    const csv = [
      'Name,Type,Adress,Comment',
      'Conflict,Bool,%IW13,word addr for bool',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    expect(result.tags).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('overlap: overlapping ranges produce a warning that does NOT block (tags kept)', async () => {
    const csv = [
      'Name,Type,Adress,Comment',
      'A,Word,%IW13,bytes 13-14',
      'B,Bool,%I14.2,byte 14 bit 2 (overlaps A)',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    // Both tags are kept — overlap is non-blocking.
    expect(result.tags).toHaveLength(2);
    expect(result.warnings).toHaveLength(0);
    expect(result.overlaps.length).toBeGreaterThan(0);
  });

  it('overlap: cross-area overlap (%I vs %M) is still reported', async () => {
    const csv = [
      'Name,Type,Adress,Comment',
      'A,Bool,%I3.1,input bit',
      'B,Bool,%M3.1,memory bit (same offset, cross-area)',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    expect(result.tags).toHaveLength(2);
    expect(result.overlaps.length).toBeGreaterThan(0);
  });

  it('flat table without overlaps produces no overlap warnings', async () => {
    const csv = [
      'Name,Type,Adress,Comment',
      'A,Bool,%I0.0,',
      'B,Bool,%I0.1,',
      'C,Word,%IW2,',
      'D,Word,%IW4,',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    expect(result.tags).toHaveLength(4);
    expect(result.overlaps).toHaveLength(0);
  });
});

describe('deriveWireType', () => {
  // Imported process-image signals are PLC outputs (PLC writes, viewer reads — read-only).
  it('Bool → PLCOutputBool', () => {
    expect(deriveWireType('Bool')).toBe('PLCOutputBool');
  });

  it('Word/Byte/Int/DWord/DInt → PLCOutputInt', () => {
    expect(deriveWireType('Word')).toBe('PLCOutputInt');
    expect(deriveWireType('Byte')).toBe('PLCOutputInt');
    expect(deriveWireType('Int')).toBe('PLCOutputInt');
    expect(deriveWireType('DWord')).toBe('PLCOutputInt');
    expect(deriveWireType('DInt')).toBe('PLCOutputInt');
  });

  it('Real/LReal → PLCOutputFloat', () => {
    expect(deriveWireType('Real')).toBe('PLCOutputFloat');
    expect(deriveWireType('LReal')).toBe('PLCOutputFloat');
  });
});
