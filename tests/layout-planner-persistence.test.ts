// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for layout-planner/planner-persistence.ts — the catalog-loading
 * and placement-URL helpers extracted from LayoutPlannerPlugin in
 * Plan-177 Phase 8.
 *
 * Covers findCatalogEntryById, resolvePlacementUrl (incl. cloud download
 * mock), waitForCloudReady, refreshCloudGlbUrl idempotency.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

import {
  findCatalogEntryById,
  resolvePlacementUrl,
  waitForCloudReady,
  refreshCloudGlbUrl,
} from '../src/plugins/layout-planner/planner-persistence';
import { LayoutStore } from '../src/plugins/layout-planner/rv-layout-store';
import type { PlacedComponent, LibraryCatalog } from '../src/plugins/layout-planner/rv-layout-store';
import type {
  LayoutPlannerCloudStore,
  LayoutPlannerCloudConnState,
} from '../src/plugins/layout-planner/cloud-types';

// ─── Fixtures ───────────────────────────────────────────────────────────

function makePlacement(over: Partial<PlacedComponent> = {}): PlacedComponent {
  return {
    id: over.id ?? 'pid',
    catalogId: over.catalogId ?? 'cat:belt',
    glbUrl: over.glbUrl ?? 'https://example.com/belt.glb',
    label: over.label ?? 'Belt',
    position: over.position ?? [0, 0, 0],
    rotation: over.rotation ?? [0, 0, 0],
    scale: over.scale ?? [1, 1, 1],
    ...(over.splatUrl !== undefined ? { splatUrl: over.splatUrl } : {}),
  };
}

function makeCatalog(entries: { id: string; glbUrl?: string; splatUrl?: string }[]): LibraryCatalog {
  return {
    version: '1.0',
    name: 'Test',
    entries: entries.map(e => ({
      id: e.id,
      name: e.id,
      category: 'custom' as const,
      glbUrl: e.glbUrl ?? '',
      ...(e.splatUrl ? { splatUrl: e.splatUrl } : {}),
    })),
  };
}

interface MockCloudStore extends LayoutPlannerCloudStore {
  _setConnections: (cs: LayoutPlannerCloudConnState[]) => void;
  _bump: () => void;
}

function makeCloudStore(initial: LayoutPlannerCloudConnState[] = []): MockCloudStore {
  let connections = initial;
  const subs = new Set<() => void>();
  const bump = () => subs.forEach(cb => cb());
  return {
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
    getSnapshot() { return { connections, activeConnectionId: null }; },
    addConnection: vi.fn(() => 'c1'),
    updateConnection: vi.fn(),
    removeConnection: vi.fn(),
    downloadGlb: vi.fn(async (_connId, assetId, version) => `blob:fresh-${assetId}-${version}`),
    _setConnections(cs) { connections = cs; bump(); },
    _bump: bump,
  } as MockCloudStore;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('layout-planner/planner-persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('findCatalogEntryById', () => {
    test('returns the matching entry across multiple catalogs', () => {
      const store = new LayoutStore();
      store.addCatalogDirect('a', makeCatalog([{ id: 'e1', glbUrl: 'a.glb' }]));
      store.addCatalogDirect('b', makeCatalog([{ id: 'e2', glbUrl: 'b.glb' }]));
      expect(findCatalogEntryById(store, 'e2')?.glbUrl).toBe('b.glb');
    });

    test('returns null when no catalog has the id', () => {
      const store = new LayoutStore();
      store.addCatalogDirect('a', makeCatalog([{ id: 'e1', glbUrl: 'a.glb' }]));
      expect(findCatalogEntryById(store, 'missing')).toBeNull();
    });
  });

  describe('resolvePlacementUrl', () => {
    test('returns the saved glbUrl when it is a stable URL', async () => {
      const store = new LayoutStore();
      const p = makePlacement({ glbUrl: 'https://x.com/a.glb' });
      expect(await resolvePlacementUrl(store, null, p)).toBe('https://x.com/a.glb');
    });

    test('falls back to the current catalog entry when saved url is blob:', async () => {
      const store = new LayoutStore();
      store.addCatalogDirect('a', makeCatalog([{ id: 'cat:belt', glbUrl: 'https://x.com/fresh.glb' }]));
      const p = makePlacement({ glbUrl: 'blob:dead', catalogId: 'cat:belt' });
      expect(await resolvePlacementUrl(store, null, p)).toBe('https://x.com/fresh.glb');
    });

    test('downloads via cloud extension for unity-cloud: assets', async () => {
      const store = new LayoutStore();
      const cloud = makeCloudStore([{
        conn: { id: 'c1', label: 'AM', config: { projectId: 'p', keyId: 'k', secretKey: 's' } },
        connected: true, connecting: false, loading: false,
        adapter: {}, // truthy
        assets: [{ id: 'asset-A', assetVersion: 'v3' }],
      }]);
      const p = makePlacement({ glbUrl: 'blob:dead', catalogId: 'unity-cloud:asset-A' });
      const url = await resolvePlacementUrl(store, cloud, p);
      expect(url).toBe('blob:fresh-asset-A-v3');
      expect(cloud.downloadGlb).toHaveBeenCalledWith('c1', 'asset-A', 'v3');
    });

    test('returns null when cloud download throws', async () => {
      const store = new LayoutStore();
      const cloud = makeCloudStore([{
        conn: { id: 'c1', label: 'AM', config: { projectId: 'p', keyId: 'k', secretKey: 's' } },
        connected: true, connecting: false, loading: false,
        adapter: {},
        assets: [{ id: 'asset-A', assetVersion: 'v3' }],
      }]);
      (cloud.downloadGlb as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('net'));
      const p = makePlacement({ glbUrl: 'blob:dead', catalogId: 'unity-cloud:asset-A' });
      const url = await resolvePlacementUrl(store, cloud, p);
      expect(url).toBeNull();
    });

    test('returns null when no source URL can be resolved', async () => {
      const store = new LayoutStore();
      const p = makePlacement({ glbUrl: 'blob:dead', catalogId: 'cat:unknown' });
      expect(await resolvePlacementUrl(store, null, p)).toBeNull();
    });

    test('prefers catalog splatUrl for splat placements with dead blob', async () => {
      const store = new LayoutStore();
      store.addCatalogDirect('a', makeCatalog([{ id: 'cat:splat', splatUrl: 'https://x.com/s.splat' }]));
      const p = makePlacement({ glbUrl: '', catalogId: 'cat:splat', splatUrl: 'blob:dead' });
      expect(await resolvePlacementUrl(store, null, p)).toBe('https://x.com/s.splat');
    });
  });

  describe('waitForCloudReady', () => {
    test('resolves immediately when no connection is pending', async () => {
      const cloud = makeCloudStore([]);
      await expect(waitForCloudReady(cloud)).resolves.toBeUndefined();
    });

    test('waits until all connecting/loading flags clear', async () => {
      const cloud = makeCloudStore([{
        conn: { id: 'c1', label: 'AM', config: { projectId: 'p', keyId: 'k', secretKey: 's' } },
        connected: false, connecting: true, loading: false,
      }]);
      const p = waitForCloudReady(cloud);
      let resolved = false;
      p.then(() => { resolved = true; });
      // Microtask flush — should still be pending
      await Promise.resolve();
      expect(resolved).toBe(false);
      // Clear the flag and notify subscribers
      cloud._setConnections([{
        conn: { id: 'c1', label: 'AM', config: { projectId: 'p', keyId: 'k', secretKey: 's' } },
        connected: true, connecting: false, loading: false,
      }]);
      await p;
      expect(resolved).toBe(true);
    });
  });

  describe('refreshCloudGlbUrl', () => {
    test('returns the input glbUrl unchanged for non-cloud placements', async () => {
      const store = new LayoutStore();
      const p = makePlacement({ glbUrl: 'https://x.com/a.glb', catalogId: 'cat:belt' });
      const url = await refreshCloudGlbUrl(store, null, p);
      expect(url).toBe('https://x.com/a.glb');
    });

    test('returns the input glbUrl when cloud url is already non-blob', async () => {
      const store = new LayoutStore();
      const p = makePlacement({ glbUrl: 'https://x.com/cached.glb', catalogId: 'unity-cloud:A' });
      const url = await refreshCloudGlbUrl(store, null, p);
      expect(url).toBe('https://x.com/cached.glb');
    });

    test('downloads fresh blob URL and mirrors it into the store', async () => {
      const store = new LayoutStore();
      store.addComponent(makePlacement({ id: 'pid', glbUrl: 'blob:dead', catalogId: 'unity-cloud:A' }));
      const cloud = makeCloudStore([{
        conn: { id: 'c1', label: 'AM', config: { projectId: 'p', keyId: 'k', secretKey: 's' } },
        connected: true, connecting: false, loading: false,
        adapter: {},
        assets: [{ id: 'A', assetVersion: 'v7' }],
      }]);
      const p = makePlacement({ id: 'pid', glbUrl: 'blob:dead', catalogId: 'unity-cloud:A' });
      const progress = vi.fn();
      const url = await refreshCloudGlbUrl(store, cloud, p, progress);
      expect(url).toBe('blob:fresh-A-v7');
      expect(progress).toHaveBeenCalledWith(expect.stringContaining('Downloading'));
      // Store mirror — the placed component now carries the fresh URL.
      const placed = store.getSnapshot().placed.find(c => c.id === 'pid');
      expect(placed?.glbUrl).toBe('blob:fresh-A-v7');
    });

    test('returns null when no cloud extension is wired', async () => {
      const store = new LayoutStore();
      const p = makePlacement({ glbUrl: 'blob:dead', catalogId: 'unity-cloud:A' });
      const url = await refreshCloudGlbUrl(store, null, p);
      expect(url).toBeNull();
    });

    test('returns null when the asset is not in the connection asset list', async () => {
      const store = new LayoutStore();
      const cloud = makeCloudStore([{
        conn: { id: 'c1', label: 'AM', config: { projectId: 'p', keyId: 'k', secretKey: 's' } },
        connected: true, connecting: false, loading: false,
        adapter: {},
        assets: [{ id: 'OTHER', assetVersion: 'v1' }],
      }]);
      const p = makePlacement({ glbUrl: 'blob:dead', catalogId: 'unity-cloud:MISSING' });
      const url = await refreshCloudGlbUrl(store, cloud, p);
      expect(url).toBeNull();
    });

    test('is idempotent: a second call with the freshened URL is a no-op', async () => {
      const store = new LayoutStore();
      const p1 = makePlacement({ id: 'pid', glbUrl: 'https://x.com/stable.glb', catalogId: 'unity-cloud:A' });
      const url1 = await refreshCloudGlbUrl(store, null, p1);
      expect(url1).toBe('https://x.com/stable.glb');
      const url2 = await refreshCloudGlbUrl(store, null, { ...p1, glbUrl: url1! });
      expect(url2).toBe('https://x.com/stable.glb');
    });
  });
});
