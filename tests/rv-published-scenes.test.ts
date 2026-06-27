// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-published-scenes — catalogue parser tests.
 *
 * Covers the curated index.json parser and the glob-fallback entry builder
 * that feed the Models panel's "Examples" section.
 */
import { describe, it, expect } from 'vitest';
import {
  parsePublishedIndex,
  publishedEntryFromFile,
  urlNameFromFile,
} from '../src/core/hmi/scene/rv-published-scenes';

describe('urlNameFromFile', () => {
  it('strips the .scene.json suffix', () => {
    expect(urlNameFromFile('DemoPlanner.scene.json')).toBe('DemoPlanner');
  });
  it('is case-insensitive on the suffix', () => {
    expect(urlNameFromFile('Foo.Scene.JSON')).toBe('Foo');
  });
});

describe('publishedEntryFromFile', () => {
  it('derives urlName and label from the filename, no mode', () => {
    expect(publishedEntryFromFile('DemoPlanner.scene.json')).toEqual({
      file: 'DemoPlanner.scene.json',
      urlName: 'DemoPlanner',
      label: 'DemoPlanner',
    });
  });
});

describe('parsePublishedIndex', () => {
  it('maps curated entries with name → label and carries mode', () => {
    const out = parsePublishedIndex([
      { file: 'DemoPlanner.scene.json', name: 'Planner Demo', mode: 'planner' },
    ]);
    expect(out).toEqual([
      { file: 'DemoPlanner.scene.json', urlName: 'DemoPlanner', label: 'Planner Demo', mode: 'planner' },
    ]);
  });

  it('falls back to the url name when name is missing/blank', () => {
    const out = parsePublishedIndex([
      { file: 'A.scene.json' },
      { file: 'B.scene.json', name: '   ' },
    ]);
    expect(out.map(e => e.label)).toEqual(['A', 'B']);
    expect(out.every(e => e.mode === undefined)).toBe(true);
  });

  it('ignores non-array input', () => {
    expect(parsePublishedIndex(null)).toEqual([]);
    expect(parsePublishedIndex({})).toEqual([]);
    expect(parsePublishedIndex('nope')).toEqual([]);
  });

  it('skips entries without a valid .scene.json file field', () => {
    const out = parsePublishedIndex([
      { file: 'ok.scene.json' },
      { file: 'bad.json' },
      { file: 42 },
      { name: 'no file' },
      null,
      'string',
    ]);
    expect(out.map(e => e.file)).toEqual(['ok.scene.json']);
  });

  it('drops a non-string mode', () => {
    const out = parsePublishedIndex([{ file: 'A.scene.json', mode: 123 }]);
    expect(out[0].mode).toBeUndefined();
  });
});
