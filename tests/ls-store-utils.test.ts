// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { lsLoad, lsSave } from '../src/core/hmi/ls-store-utils';
import { setAppConfig } from '../src/core/rv-app-config';

const KEY = 'rv-ls-store-utils-test';

interface SampleSettings {
  name: string;
  age: number;
  enabled: boolean;
  tags: string[];
}

const DEFAULTS: SampleSettings = {
  name: 'default',
  age: 10,
  enabled: false,
  tags: [],
};

describe('ls-store-utils', () => {
  beforeEach(() => {
    localStorage.removeItem(KEY);
    setAppConfig({});
  });

  afterEach(() => {
    localStorage.removeItem(KEY);
    setAppConfig({});
  });

  describe('lsLoad', () => {
    it('returns defaults when no entry exists', () => {
      const result = lsLoad<SampleSettings>(KEY, DEFAULTS);
      expect(result).toEqual(DEFAULTS);
    });

    it('returns defaults when stored JSON is corrupted', () => {
      localStorage.setItem(KEY, '{not valid json');
      const result = lsLoad<SampleSettings>(KEY, DEFAULTS);
      expect(result).toEqual(DEFAULTS);
    });

    it('returns defaults when stored value is not a JSON object', () => {
      localStorage.setItem(KEY, '"a string"');
      const result = lsLoad<SampleSettings>(KEY, DEFAULTS);
      expect(result).toEqual(DEFAULTS);
    });

    it('returns defaults when stored value is an array (not an object)', () => {
      localStorage.setItem(KEY, JSON.stringify([1, 2, 3]));
      const result = lsLoad<SampleSettings>(KEY, DEFAULTS);
      expect(result).toEqual(DEFAULTS);
    });

    it('merges stored fields on top of defaults', () => {
      localStorage.setItem(KEY, JSON.stringify({ name: 'stored', age: 42 }));
      const result = lsLoad<SampleSettings>(KEY, DEFAULTS);
      expect(result).toEqual({
        name: 'stored',
        age: 42,
        enabled: false,
        tags: [],
      });
    });

    it('returns a fresh object on each call (no shared mutation)', () => {
      const a = lsLoad<SampleSettings>(KEY, DEFAULTS);
      const b = lsLoad<SampleSettings>(KEY, DEFAULTS);
      expect(a).not.toBe(b);
      a.name = 'mutated';
      expect(b.name).toBe('default');
    });

    it('returns a clone independent of the defaults object', () => {
      const result = lsLoad<SampleSettings>(KEY, DEFAULTS);
      expect(result).not.toBe(DEFAULTS);
      result.name = 'changed';
      expect(DEFAULTS.name).toBe('default');
    });

    it('applies the validate callback to clean per-field types', () => {
      localStorage.setItem(KEY, JSON.stringify({ tags: 'not an array' }));
      const result = lsLoad<SampleSettings>(KEY, DEFAULTS, {
        validate: (_merged, parsed) => {
          if (!Array.isArray(parsed.tags)) return { tags: [] };
          return {};
        },
      });
      expect(result.tags).toEqual([]);
    });

    it('applies the migrate callback before merging', () => {
      // Stored as legacy boolean — migrate must coerce it.
      localStorage.setItem(KEY, JSON.stringify({ enabled: 1, age: 5 }));
      const result = lsLoad<SampleSettings>(KEY, DEFAULTS, {
        migrate: (raw) => {
          const r = raw as { enabled?: unknown; age?: unknown };
          return {
            enabled: r.enabled === 1 || r.enabled === true,
            age: typeof r.age === 'number' ? r.age : undefined,
          };
        },
      });
      expect(result.enabled).toBe(true);
      expect(result.age).toBe(5);
    });

    it('applies configOverride on top of localStorage (3-layer merge)', () => {
      localStorage.setItem(KEY, JSON.stringify({ name: 'from-ls', age: 42 }));
      const result = lsLoad<SampleSettings>(KEY, DEFAULTS, {
        configOverride: { name: 'from-config' },
      });
      expect(result.name).toBe('from-config'); // override wins
      expect(result.age).toBe(42); // localStorage still wins where override is undefined
    });

    it('ignores `undefined` keys in configOverride (preserves localStorage value)', () => {
      localStorage.setItem(KEY, JSON.stringify({ name: 'from-ls' }));
      const result = lsLoad<SampleSettings>(KEY, DEFAULTS, {
        configOverride: { name: undefined, age: 99 },
      });
      expect(result.name).toBe('from-ls'); // undefined override ignored
      expect(result.age).toBe(99);
    });
  });

  describe('lsSave', () => {
    it('writes JSON to localStorage', () => {
      const v: SampleSettings = { name: 'foo', age: 1, enabled: true, tags: ['x'] };
      lsSave(KEY, v);
      expect(JSON.parse(localStorage.getItem(KEY) as string)).toEqual(v);
    });

    it('does NOT write when settings are locked', () => {
      setAppConfig({ lockSettings: true });
      const v: SampleSettings = { name: 'foo', age: 1, enabled: true, tags: [] };
      lsSave(KEY, v);
      expect(localStorage.getItem(KEY)).toBeNull();
    });

    it('silently swallows storage errors', () => {
      // Force a non-serializable value to trigger JSON.stringify error.
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      // Must not throw.
      expect(() => lsSave(KEY, circular)).not.toThrow();
    });
  });
});
