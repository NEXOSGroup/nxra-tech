// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ThumbnailCache — persistent (Cache-API) store for auto-generated library
 * previews. Verifies put/get round-trip, miss → null, key isolation, and
 * graceful no-op when the Cache API is unavailable.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThumbnailCache } from '../src/plugins/layout-planner/thumbnail-cache';

/** Minimal in-memory Cache API stub (keyed by request URL string). */
function installFakeCaches(): Map<string, Map<string, Response>> {
  const buckets = new Map<string, Map<string, Response>>();
  const fake = {
    open: async (name: string) => {
      let store = buckets.get(name);
      if (!store) { store = new Map(); buckets.set(name, store); }
      return {
        match: async (key: string) => store!.get(String(key)),
        put: async (key: string, resp: Response) => { store!.set(String(key), resp); },
      };
    },
    delete: async (name: string) => buckets.delete(name),
  };
  vi.stubGlobal('caches', fake);
  return buckets;
}

beforeEach(() => { installFakeCaches(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('ThumbnailCache', () => {
  it('round-trips a stored preview blob and returns an object URL', async () => {
    const cache = new ThumbnailCache('test-bucket');
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

    expect(await cache.get('https://x/y.glb')).toBeNull(); // miss before put
    await cache.put('https://x/y.glb', blob);

    const url = await cache.get('https://x/y.glb');
    expect(url).toBeTruthy();
    expect(url!.startsWith('blob:')).toBe(true);
  });

  it('isolates entries by glbUrl key', async () => {
    const cache = new ThumbnailCache('test-bucket');
    await cache.put('https://x/a.glb', new Blob(['a'], { type: 'image/png' }));
    expect(await cache.get('https://x/a.glb')).toBeTruthy();
    expect(await cache.get('https://x/b.glb')).toBeNull();
  });

  it('returns null and never throws when the Cache API is unavailable', async () => {
    vi.stubGlobal('caches', undefined);
    const cache = new ThumbnailCache('test-bucket');
    await expect(cache.put('https://x/y.glb', new Blob(['z']))).resolves.toBeUndefined();
    expect(await cache.get('https://x/y.glb')).toBeNull();
  });
});
