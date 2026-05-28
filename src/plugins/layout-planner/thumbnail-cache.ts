// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ThumbnailCache — persistent store for auto-generated library preview PNGs,
 * keyed by the asset's `glbUrl`. Backed by the Cache API (same approach as
 * `rv-asset-blob-cache.ts`) so previews survive reloads and large libraries
 * don't re-decode + re-render every session.
 *
 * Unlike the GLB blob cache this stores *generated* blobs (it never fetches the
 * key), so it exposes an explicit `put`. All methods degrade to a silent no-op
 * when the Cache API is unavailable (private mode / file://) — callers simply
 * fall back to regenerating in-memory.
 */
export class ThumbnailCache {
  private readonly _bucket: string;

  constructor(bucket = 'rv-planner-thumbnails') {
    this._bucket = bucket;
  }

  /** Cache API keys must be http(s) Requests; wrap the glbUrl in a synthetic key. */
  private _key(glbUrl: string): string {
    return `https://rv-thumb.local/${encodeURIComponent(glbUrl)}`;
  }

  /** Return a fresh object URL for a cached preview, or null on miss/unsupported.
   *  Caller owns the returned URL (revoke when the entry is replaced). */
  async get(glbUrl: string): Promise<string | null> {
    try {
      const cache = await caches.open(this._bucket);
      const hit = await cache.match(this._key(glbUrl));
      if (!hit) return null;
      return URL.createObjectURL(await hit.blob());
    } catch {
      return null;
    }
  }

  /** Store a generated preview PNG blob under the asset's glbUrl. */
  async put(glbUrl: string, blob: Blob): Promise<void> {
    try {
      const cache = await caches.open(this._bucket);
      await cache.put(
        this._key(glbUrl),
        new Response(blob, { headers: { 'Content-Type': 'image/png' } }),
      );
    } catch {
      /* quota / unsupported — fine, preview stays in-memory only */
    }
  }

  /** Wipe the persistent bucket (tooling / "regenerate all"). */
  async clear(): Promise<void> {
    try { await caches.delete(this._bucket); } catch { /* ignore */ }
  }
}
