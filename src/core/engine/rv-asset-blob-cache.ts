// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-asset-blob-cache.ts — URL → Blob cache.
 *
 * Two-tier cache for binary assets (GLB, splat, pcd, ply, …):
 *
 *   1. In-memory `Map<url, Promise<Blob>>` — survives the current session and
 *      deduplicates concurrent fetches for the same URL.
 *   2. Browser Cache API (per-bucket) — survives page reload.
 *
 * Decoded forms (Three.js Group, GS3D.SplatMesh, …) are NOT this cache's
 * concern. Callers that benefit from a decoded cache (e.g. ModelCache.clone())
 * wrap this layer.
 *
 * Blob URLs (`blob:`) are returned unchanged — no fetch, no caching — since
 * the bytes already live in the browser.
 */

interface AssetBlobCacheOptions {
  /** Cache API bucket name (e.g. `rv-planner-glbs`). One bucket per asset type. */
  bucket: string;
}

export class RVAssetBlobCache {
  private _pending = new Map<string, Promise<Blob>>();
  private readonly _bucket: string;

  constructor(options: AssetBlobCacheOptions) {
    this._bucket = options.bucket;
  }

  /**
   * Fetch (or hit cache for) the blob behind `url`. Concurrent calls for the
   * same URL share a single Promise. Returns the original blob — callers
   * decide whether to `URL.createObjectURL` it.
   *
   * For `blob:` and `data:` URLs the cache is bypassed (their bytes are
   * already local; no benefit to copying them through the Cache API).
   */
  async getBlob(url: string): Promise<Blob> {
    if (url.startsWith('blob:') || url.startsWith('data:')) {
      const resp = await fetch(url);
      return resp.blob();
    }

    const pending = this._pending.get(url);
    if (pending) return pending;

    const promise = this._fetchWithBucket(url);
    this._pending.set(url, promise);
    promise.catch(() => { this._pending.delete(url); });
    return promise;
  }

  /**
   * Same as `getBlob()` but returns a freshly created blob URL ready to hand
   * to a loader. Caller is responsible for `URL.revokeObjectURL()` once the
   * loader has consumed it.
   */
  async getObjectUrl(url: string): Promise<string> {
    const blob = await this.getBlob(url);
    return URL.createObjectURL(blob);
  }

  private async _fetchWithBucket(url: string): Promise<Blob> {
    const name = url.split('/').pop() ?? url;
    try {
      const cache = await caches.open(this._bucket);
      const hit = await cache.match(url);
      if (hit) {
        const blob = await hit.blob();
        console.log(`[blob-cache:${this._bucket}] HIT  ${name} (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
        return blob;
      }

      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
      // Clone BEFORE consuming so we can store and return the body once each.
      cache.put(url, resp.clone()).catch(() => { /* quota / unsupported — fine */ });
      const blob = await resp.blob();
      console.log(`[blob-cache:${this._bucket}] MISS ${name} → fetched ${(blob.size / 1024 / 1024).toFixed(1)} MB, cached`);
      return blob;
    } catch {
      // Cache API unavailable (private browsing, file://, …) — fall back to
      // a direct fetch so the caller still gets the bytes.
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
      const blob = await resp.blob();
      console.log(`[blob-cache:${this._bucket}] NO-CACHE ${name} → direct fetch ${(blob.size / 1024 / 1024).toFixed(1)} MB`);
      return blob;
    }
  }

  /** Drop the in-memory tier. Cache API entries are kept (persistent layer). */
  clearMemory(): void {
    this._pending.clear();
  }

  /** Wipe the persistent Cache API bucket. */
  async clearPersistent(): Promise<void> {
    try { await caches.delete(this._bucket); } catch { /* ignore */ }
  }
}
