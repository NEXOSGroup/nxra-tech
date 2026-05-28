// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import {
  listLayouts,
  readLayout,
  readMeta,
  createLayout,
  saveLayout,
  renameLayout,
  deleteLayout,
  duplicateLayout,
  migrateLegacyAutosave,
} from '../src/core/hmi/scene/layout-registry';
import type { LayoutFile } from '../src/plugins/layout-planner/rv-layout-store';

function emptyFile(name: string): LayoutFile {
  return {
    version: '1.0',
    name,
    createdAt: new Date().toISOString(),
    catalogUrls: [],
    gridSizeMm: 500,
    components: [],
  };
}

describe('layout-registry', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts empty', () => {
    expect(listLayouts()).toEqual([]);
  });

  it('creates and reads a layout', () => {
    const id = createLayout('Test A', emptyFile('Test A'));
    expect(id).toMatch(/^lyt_/);

    const list = listLayouts();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Test A');
    expect(list[0].id).toBe(id);

    const body = readLayout(id);
    expect(body?.name).toBe('Test A');
  });

  it('saveLayout bumps modifiedAt and overwrites body', async () => {
    const id = createLayout('A', emptyFile('A'));
    const original = readMeta(id)!;
    // Wait a tick so timestamps differ
    await new Promise(r => setTimeout(r, 10));
    const updated: LayoutFile = { ...emptyFile('A'), gridSizeMm: 250 };
    saveLayout(id, updated);
    expect(readLayout(id)?.gridSizeMm).toBe(250);
    expect(readMeta(id)!.modifiedAt > original.modifiedAt).toBe(true);
  });

  it('renameLayout updates index and body', () => {
    const id = createLayout('Old', emptyFile('Old'));
    renameLayout(id, 'New');
    expect(readMeta(id)!.name).toBe('New');
    expect(readLayout(id)!.name).toBe('New');
  });

  it('deleteLayout removes both body and index entry, idempotent', () => {
    const id = createLayout('A', emptyFile('A'));
    deleteLayout(id);
    expect(readMeta(id)).toBeNull();
    expect(readLayout(id)).toBeNull();
    // Second delete is a no-op (no throw).
    expect(() => deleteLayout(id)).not.toThrow();
  });

  it('duplicateLayout creates an independent copy', () => {
    const idA = createLayout('Source', emptyFile('Source'));
    const idB = duplicateLayout(idA);
    expect(idB).not.toBeNull();
    expect(idB).not.toBe(idA);
    expect(readMeta(idB!)?.name).toBe('Source (copy)');
    // Edit copy → source unchanged.
    saveLayout(idB!, { ...emptyFile('B'), gridSizeMm: 100 });
    expect(readLayout(idA)?.gridSizeMm).toBe(500);
    expect(readLayout(idB!)?.gridSizeMm).toBe(100);
  });

  it('list is sorted modifiedAt descending', async () => {
    const a = createLayout('A', emptyFile('A'));
    await new Promise(r => setTimeout(r, 10));
    const b = createLayout('B', emptyFile('B'));
    expect(listLayouts().map(m => m.id)).toEqual([b, a]);
    await new Promise(r => setTimeout(r, 10));
    saveLayout(a, emptyFile('A'));
    expect(listLayouts().map(m => m.id)).toEqual([a, b]);
  });

  it('migrateLegacyAutosave imports an existing autosave once', () => {
    const legacy: LayoutFile = { ...emptyFile('autosave'), gridSizeMm: 1000 };
    localStorage.setItem('rv-layout-autosave', JSON.stringify(legacy));

    const id = migrateLegacyAutosave();
    expect(id).not.toBeNull();
    expect(readMeta(id!)?.name).toBe('Untitled Layout');
    expect(readLayout(id!)?.gridSizeMm).toBe(1000);
    expect(localStorage.getItem('rv-layout-autosave')).toBeNull();

    // Idempotent: second call is a no-op.
    expect(migrateLegacyAutosave()).toBeNull();
  });

  it('migration preserves a non-default name', () => {
    const legacy: LayoutFile = emptyFile('My Cell');
    localStorage.setItem('rv-layout-autosave', JSON.stringify(legacy));
    const id = migrateLegacyAutosave();
    expect(readMeta(id!)?.name).toBe('My Cell');
  });

  it('migration drops corrupt legacy data', () => {
    localStorage.setItem('rv-layout-autosave', '{not json');
    expect(migrateLegacyAutosave()).toBeNull();
    expect(localStorage.getItem('rv-layout-autosave')).toBeNull();
  });
});
