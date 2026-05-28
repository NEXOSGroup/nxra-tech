// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import {
  ISA_GREEN,
  ISA_AMBER,
  ISA_RED,
  ISA_CYAN,
  connectionStateColor,
} from '../src/core/hmi/isa-colors';

describe('isa-colors', () => {
  it('exports the four canonical hex values that match the dark MUI theme', () => {
    expect(ISA_GREEN).toBe('#66bb6a');
    expect(ISA_AMBER).toBe('#ffa726');
    expect(ISA_RED).toBe('#ef5350');
    expect(ISA_CYAN).toBe('#0288d1');
  });

  it('all constants are 6-digit lowercase hex strings (#rrggbb)', () => {
    for (const c of [ISA_GREEN, ISA_AMBER, ISA_RED, ISA_CYAN]) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  describe('connectionStateColor', () => {
    it('maps "connected" to ISA_GREEN', () => {
      expect(connectionStateColor('connected')).toBe(ISA_GREEN);
    });

    it('maps "connecting" to ISA_AMBER', () => {
      expect(connectionStateColor('connecting')).toBe(ISA_AMBER);
    });

    it('maps "error" to ISA_RED', () => {
      expect(connectionStateColor('error')).toBe(ISA_RED);
    });

    it('returns undefined for "disconnected" so callers pick their own neutral color', () => {
      expect(connectionStateColor('disconnected')).toBeUndefined();
    });

    it('returns undefined for unknown / future state strings', () => {
      expect(connectionStateColor('foo')).toBeUndefined();
      expect(connectionStateColor('')).toBeUndefined();
    });
  });
});
