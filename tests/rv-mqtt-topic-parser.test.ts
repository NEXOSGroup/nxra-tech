// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MQTT Topic Parser Tests
 *
 * Validates topic-to-signal-name parsing, direction detection,
 * signal type detection, and prefix normalization.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizePrefix,
  topicToSignalName,
  detectDirection,
  stripDirectionPrefix,
  detectSignalType,
  parsePayloadValue,
} from '../src/interfaces/mqtt-interface';

describe('normalizePrefix', () => {
  it('appends trailing slash if missing', () => {
    expect(normalizePrefix('rv')).toBe('rv/');
  });

  it('preserves existing trailing slash', () => {
    expect(normalizePrefix('rv/')).toBe('rv/');
  });

  it('returns empty string for empty prefix', () => {
    expect(normalizePrefix('')).toBe('');
  });

  it('handles multi-level prefix', () => {
    expect(normalizePrefix('factory/line1')).toBe('factory/line1/');
  });

  it('preserves multi-level prefix with trailing slash', () => {
    expect(normalizePrefix('factory/line1/')).toBe('factory/line1/');
  });
});

describe('topicToSignalName', () => {
  it('removes prefix from topic', () => {
    expect(topicToSignalName('rv/ConveyorStart', 'rv/')).toBe('ConveyorStart');
  });

  it('removes prefix without trailing slash', () => {
    expect(topicToSignalName('rv/ConveyorStart', 'rv')).toBe('ConveyorStart');
  });

  it('handles empty prefix', () => {
    expect(topicToSignalName('ConveyorStart', '')).toBe('ConveyorStart');
  });

  it('preserves nested path after prefix', () => {
    expect(topicToSignalName('rv/drives/DriveSpeed', 'rv/')).toBe('drives/DriveSpeed');
  });

  it('returns full topic if prefix does not match', () => {
    expect(topicToSignalName('other/ConveyorStart', 'rv/')).toBe('other/ConveyorStart');
  });

  it('handles multi-level prefix', () => {
    expect(topicToSignalName('factory/line1/Sensor1', 'factory/line1/')).toBe('Sensor1');
  });
});

describe('detectDirection', () => {
  it('detects input direction from in/ subfolder', () => {
    expect(detectDirection('in/SensorA')).toBe('input');
  });

  it('detects output direction from out/ subfolder', () => {
    expect(detectDirection('out/StartButton')).toBe('output');
  });

  it('defaults to output (read-only) for flat topics', () => {
    expect(detectDirection('DriveSpeed')).toBe('output');
  });

  it('defaults to output (read-only) for nested topics without in/out', () => {
    expect(detectDirection('drives/DriveSpeed')).toBe('output');
  });
});

describe('stripDirectionPrefix', () => {
  it('strips in/ prefix', () => {
    expect(stripDirectionPrefix('in/SensorA')).toBe('SensorA');
  });

  it('strips out/ prefix', () => {
    expect(stripDirectionPrefix('out/StartButton')).toBe('StartButton');
  });

  it('preserves name without direction prefix', () => {
    expect(stripDirectionPrefix('DriveSpeed')).toBe('DriveSpeed');
  });

  it('preserves nested path without direction prefix', () => {
    expect(stripDirectionPrefix('drives/DriveSpeed')).toBe('drives/DriveSpeed');
  });
});

describe('detectSignalType', () => {
  it('detects bool from "true"', () => {
    expect(detectSignalType('true')).toBe('bool');
  });

  it('detects bool from "false"', () => {
    expect(detectSignalType('false')).toBe('bool');
  });

  it('detects bool from "True" (case insensitive)', () => {
    expect(detectSignalType('True')).toBe('bool');
  });

  it('detects bool from "FALSE" (case insensitive)', () => {
    expect(detectSignalType('FALSE')).toBe('bool');
  });

  it('detects bool from "0"', () => {
    expect(detectSignalType('0')).toBe('bool');
  });

  it('detects bool from "1"', () => {
    expect(detectSignalType('1')).toBe('bool');
  });

  it('detects int from integer strings', () => {
    expect(detectSignalType('42')).toBe('int');
  });

  it('detects int from negative integers', () => {
    expect(detectSignalType('-7')).toBe('int');
  });

  it('detects float from decimal strings', () => {
    expect(detectSignalType('3.14')).toBe('float');
  });

  it('detects float from negative decimals', () => {
    expect(detectSignalType('-2.5')).toBe('float');
  });

  it('detects float from scientific notation', () => {
    expect(detectSignalType('1e3')).toBe('float');
  });

  it('returns float for non-numeric strings', () => {
    expect(detectSignalType('hello')).toBe('float');
  });

  it('handles whitespace-padded values', () => {
    expect(detectSignalType('  true  ')).toBe('bool');
    expect(detectSignalType(' 42 ')).toBe('int');
  });
});

describe('parsePayloadValue', () => {
  it('parses "true" to true', () => {
    expect(parsePayloadValue('true')).toBe(true);
  });

  it('parses "false" to false', () => {
    expect(parsePayloadValue('false')).toBe(false);
  });

  it('parses "True" to true (case insensitive)', () => {
    expect(parsePayloadValue('True')).toBe(true);
  });

  it('parses integer strings to numbers', () => {
    expect(parsePayloadValue('42')).toBe(42);
  });

  it('parses float strings to numbers', () => {
    expect(parsePayloadValue('3.14')).toBe(3.14);
  });

  it('parses "0" to 0', () => {
    expect(parsePayloadValue('0')).toBe(0);
  });

  it('parses "1" to 1', () => {
    expect(parsePayloadValue('1')).toBe(1);
  });

  it('returns 0 for non-parseable strings', () => {
    expect(parsePayloadValue('hello')).toBe(0);
  });
});
