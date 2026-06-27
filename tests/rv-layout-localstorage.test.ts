// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for Layout localStorage Persistence — verify library URLs and layout auto-save.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { LayoutStore } from '../src/plugins/layout-planner/rv-layout-store';

describe('Layout localStorage Persistence', () => {
  beforeEach(() => localStorage.clear());

  test('addCatalog persists URL to localStorage', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ version: '1.0', name: 'Test', entries: [] })),
    );
    const store = new LayoutStore();
    await store.addCatalog('https://example.com/catalog.json');
    const stored = JSON.parse(localStorage.getItem('rv-layout-library-urls') ?? '[]');
    expect(stored).toContain('https://example.com/catalog.json');
  });

  test('new LayoutStore restores URLs from localStorage', async () => {
    localStorage.setItem('rv-layout-library-urls', JSON.stringify(['https://example.com/catalog.json']));
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ version: '1.0', name: 'Test', entries: [] })),
    );
    const store = new LayoutStore();
    await store.restoreFromStorage();
    expect(store.getSnapshot().catalogUrls).toHaveLength(1);
  });

  test('restoreFromStorage SKIPS a persisted GitHub catalog (opt-in only — no auto-load)', async () => {
    // A former-default GitHub library that leaked into storage must not re-scan
    // GitHub on boot. Only the non-GitHub catalog is restored.
    localStorage.setItem('rv-layout-library-urls', JSON.stringify([
      'https://github.com/game4automation/realvirtual-Library',
      'https://example.com/catalog.json',
    ]));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes('example.com')) {
        return new Response(JSON.stringify({ version: '1.0', name: 'Test', entries: [] }));
      }
      return new Response('not found', { status: 404 });
    });
    const store = new LayoutStore();
    await store.restoreFromStorage();

    const urls = store.getSnapshot().catalogUrls;
    expect(urls).toEqual(['https://example.com/catalog.json']);
    // GitHub API was never contacted.
    expect(fetchSpy.mock.calls.every(c => !String(c[0]).includes('github'))).toBe(true);
  });

  test('manually added GitHub catalog is session-only — never persisted to localStorage', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = String(input);
      if (/\/repos\/[^/]+\/[^/]+$/.test(u)) {
        return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
      }
      if (/\/git\/trees\//.test(u)) {
        return new Response(JSON.stringify({ tree: [{ path: 'A.glb', type: 'blob' }], truncated: false }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    const store = new LayoutStore();
    await store.addCatalog('https://github.com/acme/assets'); // explicit manual add → loads this session
    expect(store.getSnapshot().catalogUrls).toContain('https://github.com/acme/assets');
    // ...but it is NOT written to storage, so it won't auto-load next boot.
    const stored = JSON.parse(localStorage.getItem('rv-layout-library-urls') ?? '[]');
    expect(stored).not.toContain('https://github.com/acme/assets');
  });

  test('removeCatalog removes URL from localStorage', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ version: '1.0', name: 'Test', entries: [] })),
    );
    const store = new LayoutStore();
    await store.addCatalog('https://example.com/catalog.json');
    store.removeCatalog('https://example.com/catalog.json');
    const stored = JSON.parse(localStorage.getItem('rv-layout-library-urls') ?? '[]');
    expect(stored).toHaveLength(0);
  });

  test('auto-save handles QuotaExceededError gracefully', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('QuotaExceededError');
    });
    const store = new LayoutStore();
    // Should not throw
    expect(() => store.autoSave()).not.toThrow();
  });

  test('autoSave writes layout data to localStorage', () => {
    const store = new LayoutStore();
    store.addComponent({ id: '1', catalogId: 'belt', glbUrl: 'x.glb', label: 'Belt', position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] });
    store.autoSave();
    const saved = localStorage.getItem('rv-layout-autosave');
    expect(saved).toBeTruthy();
    const parsed = JSON.parse(saved!);
    expect(parsed.components).toHaveLength(1);
  });

  test('loadAutoSave restores placed components', () => {
    const store1 = new LayoutStore();
    store1.addComponent({ id: '1', catalogId: 'belt', glbUrl: 'x.glb', label: 'Belt', position: [100,0,200], rotation: [0,45,0], scale: [1,1,1] });
    store1.autoSave();

    const store2 = new LayoutStore();
    store2.loadAutoSave();
    expect(store2.getSnapshot().placed).toHaveLength(1);
    expect(store2.getSnapshot().placed[0].position).toEqual([100, 0, 200]);
  });

  test('constructor restores grid settings from localStorage', () => {
    localStorage.setItem('rv-layout-grid-enabled', 'false');
    localStorage.setItem('rv-layout-grid-size', '250');
    const store = new LayoutStore();
    expect(store.getSnapshot().gridEnabled).toBe(false);
    expect(store.getSnapshot().gridSizeMm).toBe(250);
  });

  test('constructor ignores invalid grid size in localStorage', () => {
    localStorage.setItem('rv-layout-grid-size', 'not-a-number');
    const store = new LayoutStore();
    expect(store.getSnapshot().gridSizeMm).toBe(500); // Default
  });
});
