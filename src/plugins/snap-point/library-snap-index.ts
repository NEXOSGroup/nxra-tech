// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * library-snap-index — Lazy snap-point index for library assets.
 *
 * On first request for a (typeId, oppositeDirCode) pair, walks all known
 * library catalog entries, loads each GLB once via GLTFLoader, parses snap
 * names, and caches the result in memory + localStorage.
 *
 * Cache key: `rv-snap-index-v1:<glbUrl>`
 * Cache TTL: implicit (forever) unless invalidated by the caller; manual
 * clear via `clearCache()` for tests.
 */

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import type { LibraryCatalogEntry } from '../layout-planner/rv-layout-store';
import {
  parseSnapName,
  flowsCompatible,
  forcesBidiPort,
  type SnapDirection,
  type SnapDirectionCode,
  type SnapFlow,
} from './snap-name-parser';

export interface LibraryAssetSnapEntry {
  /** Library catalog entry id. */
  catalogId: string;
  /** GLB URL the snap belongs to. */
  glbUrl: string;
  /** Snap point inside the asset. */
  snaps: Array<{
    nodeName: string;
    dir: SnapDirection;
    typeId: string;
    flow: SnapFlow;
  }>;
}

// v2: snap flow is now normalized through `forcesBidiPort` at index time (e.g.
// the ChainTransfer's convchain port → bidi), so v1 caches that stored the raw
// authored flow must be discarded.
const LS_PREFIX = 'rv-snap-index-v2:';
const _memoryCache = new Map<string, LibraryAssetSnapEntry>();
let _loader: GLTFLoader | null = null;
let _dracoLoader: DRACOLoader | null = null;

function _getLoader(): GLTFLoader {
  if (_loader) return _loader;
  _loader = new GLTFLoader();
  _dracoLoader = new DRACOLoader();
  _dracoLoader.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
  _loader.setDRACOLoader(_dracoLoader);
  return _loader;
}

function _readLocalStorage(glbUrl: string): LibraryAssetSnapEntry | null {
  try {
    const raw = localStorage.getItem(LS_PREFIX + glbUrl);
    if (!raw) return null;
    return JSON.parse(raw) as LibraryAssetSnapEntry;
  } catch {
    // Corrupt entry — drop it
    try { localStorage.removeItem(LS_PREFIX + glbUrl); } catch { /* ignore */ }
    return null;
  }
}

function _writeLocalStorage(glbUrl: string, entry: LibraryAssetSnapEntry): void {
  try {
    localStorage.setItem(LS_PREFIX + glbUrl, JSON.stringify(entry));
  } catch {
    /* quota — silently skip; memory cache still holds it */
  }
}

/** Ensure the index for a single library entry is loaded. Idempotent. */
export async function ensureAssetIndex(
  catalogId: string,
  glbUrl: string,
): Promise<LibraryAssetSnapEntry> {
  const cached = _memoryCache.get(glbUrl);
  if (cached) return cached;
  const ls = _readLocalStorage(glbUrl);
  if (ls) {
    _memoryCache.set(glbUrl, ls);
    return ls;
  }

  const loader = _getLoader();
  const gltf = await loader.loadAsync(glbUrl);
  const snaps: LibraryAssetSnapEntry['snaps'] = [];
  gltf.scene.traverse((node) => {
    const parsed = parseSnapName(node.name);
    if (parsed) {
      snaps.push({
        nodeName: node.name,
        dir: parsed.dir,
        typeId: parsed.typeId,
        // Apply the same bidi-force the runtime scanner uses, keyed off the GLB
        // url (it contains the model keyword, e.g. "ChainTransfer"), so the
        // quick-add picker matches a forced-bidi port (convchain) the same way a
        // placed asset would.
        flow: forcesBidiPort(glbUrl, parsed.typeId) ? 'bidi' : parsed.flow,
      });
    }
  });
  const entry: LibraryAssetSnapEntry = { catalogId, glbUrl, snaps };
  _memoryCache.set(glbUrl, entry);
  _writeLocalStorage(glbUrl, entry);
  return entry;
}

/**
 * For a target snap, find all library entries that contain at least one
 * compatible snap. "Compatible" means:
 *   - same `typeId`
 *   - flow-compatible: in↔out, bidi↔anything; rejects in↔in / out↔out
 *
 * The axis direction code is NOT a hard filter — outward direction comes
 * from snap POSITION in the alignment math. The `preferOppositeDirCode`
 * argument is preserved for source-compat (favours the natural same-axis-
 * opposite snap when an asset exposes multiple matches), but is otherwise
 * informational.
 */
export async function findCompatibleLibraryAssets(
  entries: LibraryCatalogEntry[],
  typeId: string,
  preferOppositeDirCode?: SnapDirectionCode,
  targetFlow?: SnapFlow,
): Promise<Array<{ entry: LibraryCatalogEntry; ownSnapName: string }>> {
  const out: Array<{ entry: LibraryCatalogEntry; ownSnapName: string }> = [];
  for (const e of entries) {
    if (!e.glbUrl) continue;
    let idx: LibraryAssetSnapEntry;
    try {
      idx = await ensureAssetIndex(e.id, e.glbUrl);
    } catch {
      continue; // skip on load error
    }
    const matches = idx.snaps.filter(
      (s) => s.typeId === typeId && flowsCompatible(targetFlow, s.flow),
    );
    if (matches.length === 0) continue;
    const preferred = preferOppositeDirCode
      ? matches.find((s) => s.dir.code === preferOppositeDirCode)
      : undefined;
    const chosen = preferred ?? matches[0];
    out.push({ entry: e, ownSnapName: chosen.nodeName });
  }
  return out;
}

/** Clear the in-memory + localStorage cache (test helper). */
export function clearCache(): void {
  _memoryCache.clear();
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch { /* ignore */ }
}

/** Direct read of in-memory cache (test helper). */
export function _getMemoryCache(): ReadonlyMap<string, LibraryAssetSnapEntry> {
  return _memoryCache;
}
