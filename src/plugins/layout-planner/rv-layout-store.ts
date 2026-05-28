// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * LayoutStore — State management for the Layout Planner plugin.
 *
 * Uses useSyncExternalStore pattern for React integration.
 * Manages catalog tabs, placed components, selection, grid settings,
 * and localStorage persistence.
 */

// ─── Types ──────────────────────────────────────────────────────────────

export interface LibraryCatalog {
  version: '1.0';
  name: string;
  entries: LibraryCatalogEntry[];
  baseUrl?: string;
}

export interface LibraryCatalogEntry {
  id: string;
  name: string;
  category: 'conveyor' | 'robot' | 'machine' | 'fixture' | 'custom' | 'des' | 'splat';
  glbUrl?: string;
  splatUrl?: string;
  thumbnailUrl?: string;
  footprintMm?: [number, number];
  tags?: string[];
  pivotToFloor?: boolean;
  plugin?: string;
  // Virtual DES components (no GLB — rendered as gizmos)
  virtual?: boolean;
  desType?: string;                        // 'DESConveyor', 'DESStation', etc.
  desConfig?: Record<string, unknown>;     // default rv_extras values
  gizmoSize?: [number, number, number];    // visual box size in mm [x, y, z]
  /** For Local-Folder entries: path of the source GLB relative to the
   *  scanned `library/` subfolder (e.g. "conveyor/belt.glb"). Used to
   *  persist generated thumbnails alongside the asset. */
  localPath?: string;
  /** Free-form group names this entry belongs to. Mirrors the Asset
   *  Manager "Collections" concept and is rendered as filter chips in
   *  the Local-Folder tab. For local libraries, derived from the
   *  immediate parent subfolder under `library/` (case preserved). */
  collections?: string[];
}

export interface PlacedComponent {
  id: string;
  catalogId: string;
  glbUrl: string;
  label: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  /** If set, this placement is a Gaussian Splat (not a GLB). */
  splatUrl?: string;
  /** Visibility toggle. Missing/undefined = visible (legacy default). */
  visible?: boolean;
}

export interface LayoutFile {
  version: '1.0';
  name: string;
  createdAt: string;
  catalogUrls: string[];
  gridSizeMm: number;
  components: PlacedComponent[];
}

export type TransformMode = 'select' | 'translate' | 'rotate';

export interface LayoutSnapshot {
  catalogs: Map<string, LibraryCatalog>;
  catalogUrls: string[];
  catalogErrors: Map<string, string>;
  activeTabUrl: string | null;
  placed: PlacedComponent[];
  selectedId: string | null;
  mode: TransformMode;
  gridEnabled: boolean;
  /** Translation snap step in millimetres. Used by the snap grid AND the
   *  TransformControls translation snap when `gridEnabled` is true. */
  gridSizeMm: number;
  /** Rotation snap step in degrees. Used by TransformControls rotation snap
   *  when `gridEnabled` is true. */
  rotationSnapDeg: number;
  dropToSurface: boolean;
  /** Magnetic snap to other layout objects' bounding-box edges/centers.
   *  Independent of `gridEnabled`. When both are on, bbox snap takes
   *  priority within its tolerance; grid is the fallback quantizer. */
  bboxSnapEnabled: boolean;
  /** Snap tolerance in millimetres (world space). */
  bboxSnapToleranceMm: number;
  /** Include bbox centres as snap references (centre-to-centre / centre-to-edge). */
  bboxSnapMid: boolean;
  /** Include bbox edges (min/max) as snap references (edge-to-edge / edge-to-centre). */
  bboxSnapSide: boolean;
  /** Show 4-direction neighbor-distance overlay while dragging (independent of snap firing). */
  showNeighborDistances: boolean;
  /** Maximum distance (mm) at which neighbor-distance lines are still drawn.
   *  Farther neighbors are ignored — keeps the overlay relevant to the
   *  immediate surroundings instead of spanning the whole layout. */
  neighborDistanceMaxMm: number;
  /** Magnetic snap between matching snap points during drag. When off, the
   *  snap-point system still highlights markers and the picker works — only
   *  the drag-time pull to a matching snap is disabled. */
  snapPointMagnetEnabled: boolean;
  /** Chain mode: when an asset connected to others via snap pairs is moved,
   *  all transitively connected assets follow rigidly. Disable to drag each
   *  element solo (connections persist until detached/over-stretched). */
  chainModeEnabled: boolean;
  placementMode: string | null; // catalogEntry id for tap-to-place
  /** Entry ids whose preview thumbnail is currently being auto-generated.
   *  Cards render a spinner while their id is present. */
  thumbnailPending: ReadonlySet<string>;
}

// ─── localStorage keys ──────────────────────────────────────────────────

const LS_KEY_URLS = 'rv-layout-library-urls';
const LS_KEY_AUTOSAVE = 'rv-layout-autosave';
const LS_KEY_GRID_ENABLED = 'rv-layout-grid-enabled';
const LS_KEY_GRID_SIZE = 'rv-layout-grid-size';
const LS_KEY_ROTATION_SNAP = 'rv-layout-rotation-snap';
const LS_KEY_DROP_TO_SURFACE = 'rv-layout-drop-to-surface';
const LS_KEY_BBOX_SNAP = 'rv-layout-bbox-snap-enabled';
const LS_KEY_BBOX_SNAP_MID = 'rv-layout-bbox-snap-mid';
const LS_KEY_BBOX_SNAP_SIDE = 'rv-layout-bbox-snap-side';
const LS_KEY_BBOX_SNAP_TOL = 'rv-layout-bbox-snap-tolerance';
const LS_KEY_SHOW_NEIGHBOR_DIST = 'rv-layout-show-neighbor-distances';
const LS_KEY_NEIGHBOR_DIST_MAX = 'rv-layout-neighbor-distance-max';
const LS_KEY_SNAPPOINT_MAGNET = 'rv-layout-snappoint-magnet-enabled';
const LS_KEY_CHAIN_MODE = 'rv-layout-chain-mode-enabled';
const LS_KEY_ACTIVE_TAB = 'rv-layout-active-tab';

/** Default magnetic-snap tolerance in millimetres (world space). */
const DEFAULT_BBOX_SNAP_TOLERANCE_MM = 30;
const MIN_BBOX_SNAP_TOLERANCE_MM = 1;
const MAX_BBOX_SNAP_TOLERANCE_MM = 1000;
const DEFAULT_NEIGHBOR_DIST_MAX_MM = 5000;
const MIN_NEIGHBOR_DIST_MAX_MM = 100;
const MAX_NEIGHBOR_DIST_MAX_MM = 100_000;

// ─── Serialization helpers ──────────────────────────────────────────────

export function serializeLayout(
  name: string,
  components: PlacedComponent[],
  catalogUrls: string[],
  gridSizeMm: number,
): LayoutFile {
  return {
    version: '1.0',
    name,
    createdAt: new Date().toISOString(),
    catalogUrls,
    gridSizeMm,
    components,
  };
}

export function deserializeLayout(json: string): LayoutFile {
  const data = JSON.parse(json);
  return data as LayoutFile;
}

// ─── Grid snap helper ───────────────────────────────────────────────────

export function snapToGrid(
  pos: { x: number; y: number; z: number },
  gridSize: number,
): { x: number; y: number; z: number } {
  if (gridSize <= 0) return { ...pos };
  return {
    x: Math.round(pos.x / gridSize) * gridSize,
    y: pos.y,
    z: Math.round(pos.z / gridSize) * gridSize,
  };
}

// alignToFloor() moved to model-cache.ts — single source of truth.

import { type Object3D } from 'three';
import {
  isSupported as isFsApiSupported,
  selectWorkFolder,
  getWorkFolder,
  getWorkFolderMeta,
  removeWorkFolder,
  getSubfolder,
  listFiles,
  readFileAsUrl,
  type LocalFileEntry,
} from '../../core/engine/rv-local-filesystem';

const THUMBNAILS_SUBFOLDER = '.thumbnails';

/**
 * Sentinel catalogError value used for a local-folder tab whose handle is
 * still saved but whose browser permission has lapsed (the default state
 * after closing the browser). The Planner UI treats this as a "click to
 * re-grant" prompt instead of a real error.
 */
export const LOCAL_NEEDS_PERMISSION = '__needs_permission__';

// ─── URL / entry normalization ───────────────────────────────────────────

/** Resolve a potentially relative URL against a base URL. */
export function resolveUrl(base: string, relative: string): string {
  // Already absolute
  if (/^https?:\/\//i.test(relative) || relative.startsWith('blob:')) return relative;
  // Starts with ./ or ../ — resolve against base
  try {
    return new URL(relative, base).href;
  } catch {
    // Fallback: simple concatenation
    const b = base.endsWith('/') ? base : base + '/';
    return b + relative.replace(/^\.\//, '');
  }
}

/** File extensions recognized as Gaussian Splat formats. */
const SPLAT_EXTENSIONS = new Set(['.splat', '.ksplat', '.ply']);

/** Auto-fill missing fields on a catalog entry. */
export function normalizeCatalogEntry(
  raw: Partial<LibraryCatalogEntry> & { glbUrl?: string; splatUrl?: string },
  baseUrl: string,
): LibraryCatalogEntry {
  // Virtual DES entries have no GLB — pass through with defaults
  if (raw.virtual) {
    return {
      id: raw.id ?? raw.desType?.toLowerCase() ?? 'virtual',
      name: raw.name ?? raw.desType ?? 'Virtual Component',
      category: raw.category ?? 'des',
      glbUrl: '',
      thumbnailUrl: '',
      footprintMm: raw.footprintMm,
      tags: raw.tags,
      pivotToFloor: raw.pivotToFloor,
      plugin: raw.plugin,
      virtual: true,
      desType: raw.desType,
      desConfig: raw.desConfig,
      gizmoSize: raw.gizmoSize,
    };
  }

  // Splat entries — splatUrl instead of glbUrl
  if (raw.splatUrl) {
    const splatUrlRaw = raw.splatUrl;
    const filename = splatUrlRaw.split('/').pop() ?? splatUrlRaw;
    const stem = filename.replace(/\.(splat|ksplat|ply)$/i, '');
    const id = raw.id ?? stem.toLowerCase().replace(/\s+/g, '-');
    const name = raw.name ?? stem.replace(/[_-]/g, ' ');
    const splatUrl = resolveUrl(baseUrl, splatUrlRaw);
    const thumbnailUrl = raw.thumbnailUrl
      ? resolveUrl(baseUrl, raw.thumbnailUrl)
      : '';
    return {
      id,
      name,
      category: raw.category ?? 'splat',
      splatUrl,
      thumbnailUrl,
      footprintMm: raw.footprintMm,
      tags: raw.tags,
      pivotToFloor: raw.pivotToFloor,
      plugin: raw.plugin,
      collections: raw.collections,
    };
  }

  const glbUrlRaw = raw.glbUrl ?? '';
  const filename = glbUrlRaw.split('/').pop() ?? glbUrlRaw;
  const stem = filename.replace(/\.glb$/i, '');
  const id = raw.id ?? stem.toLowerCase().replace(/\s+/g, '-');
  const name = raw.name ?? stem.replace(/[_-]/g, ' ');
  const category = raw.category ?? 'custom';
  const glbUrl = resolveUrl(baseUrl, glbUrlRaw);
  const thumbnailUrl = raw.thumbnailUrl
    ? resolveUrl(baseUrl, raw.thumbnailUrl)
    : '';
  return {
    id,
    name,
    category,
    glbUrl,
    thumbnailUrl,
    footprintMm: raw.footprintMm,
    tags: raw.tags,
    pivotToFloor: raw.pivotToFloor,
    plugin: raw.plugin,
    collections: raw.collections,
  };
}

// ─── GitHub repository scanning ──────────────────────────────────────────

interface GitHubRepoRef {
  owner: string;
  repo: string;
  branch?: string;
  subpath: string;
}

/**
 * Parse a GitHub repo / folder URL into its parts. Returns null for anything
 * that is not a github.com repo URL. Handles:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/branch
 *   https://github.com/owner/repo/tree/branch/sub/folder
 */
export function parseGitHubRepoUrl(url: string): GitHubRepoRef | null {
  const m = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:\/tree\/([^/?#]+)(?:\/([^?#]*))?)?\/?(?:[?#].*)?$/i,
  );
  if (!m) return null;
  return {
    owner: m[1],
    repo: m[2],
    branch: m[3],
    subpath: (m[4] ?? '').replace(/\/+$/, ''),
  };
}

/**
 * True when `url` should be treated as a GitHub repository to SCAN for `.glb`
 * files (rather than a `catalog.json` to fetch). A github.com URL that does not
 * point at a `.json` file qualifies; a `.../blob/.../catalog.json` URL does not
 * (it is handled by the regular catalog-fetch path).
 */
export function isGitHubRepoScanUrl(url: string): boolean {
  if (/\.json(\?|#|$)/i.test(url)) return false;
  if (/\/blob\//i.test(url)) return false; // a blob points at a single file, not a folder
  return parseGitHubRepoUrl(url) !== null;
}

/**
 * Scan a GitHub repository (optionally a subfolder) for `.glb` files via the
 * public GitHub API and build a `LibraryCatalog` from them — no `catalog.json`
 * required. Each `.glb` becomes an entry whose `glbUrl` is its raw URL; the
 * immediate parent folder becomes a collection chip. Throws on failure so the
 * caller can record a catalog error.
 */
export async function buildCatalogFromGitHub(url: string): Promise<LibraryCatalog> {
  const ref = parseGitHubRepoUrl(url);
  if (!ref) throw new Error('Not a GitHub repository URL');
  const { owner, repo } = ref;

  // Resolve the default branch when the URL did not specify one.
  let branch = ref.branch;
  if (!branch) {
    const repoResp = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
    if (!repoResp.ok) {
      throw new Error(repoResp.status === 403
        ? 'GitHub API rate limit reached — try again later'
        : `GitHub repo lookup failed: HTTP ${repoResp.status}`);
    }
    branch = ((await repoResp.json()) as { default_branch?: string }).default_branch ?? 'main';
  }

  // One recursive tree listing returns every path in the repo.
  const treeResp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );
  if (!treeResp.ok) {
    throw new Error(treeResp.status === 403
      ? 'GitHub API rate limit reached — try again later'
      : `GitHub tree fetch failed: HTTP ${treeResp.status}`);
  }
  const treeData = (await treeResp.json()) as {
    tree?: Array<{ path: string; type: string }>;
    truncated?: boolean;
  };

  const prefix = ref.subpath ? ref.subpath.toLowerCase() + '/' : '';
  const glbNodes = (treeData.tree ?? []).filter(
    n => n.type === 'blob'
      && /\.glb$/i.test(n.path)
      && n.path.toLowerCase().startsWith(prefix),
  );
  if (glbNodes.length === 0) {
    throw new Error(treeData.truncated
      ? 'No .glb files found (repository tree was truncated — narrow the folder)'
      : 'No .glb files found in this repository / folder');
  }

  const entries: LibraryCatalogEntry[] = glbNodes.map((n) => {
    const rel = n.path.slice(prefix.length);
    const filename = n.path.split('/').pop() ?? n.path;
    const stem = filename.replace(/\.glb$/i, '');
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')).split('/').pop() ?? '' : '';
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/`
      + n.path.split('/').map(encodeURIComponent).join('/');
    return {
      id: `${repo}/${n.path}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: stem.replace(/[_-]+/g, ' ').trim(),
      category: 'custom',
      glbUrl: rawUrl,
      thumbnailUrl: '',
      collections: parent ? [parent] : undefined,
    };
  });

  return {
    version: '1.0',
    name: `${repo}${ref.subpath ? '/' + ref.subpath : ''}`,
    entries,
  };
}

// ─── Store ──────────────────────────────────────────────────────────────

export class LayoutStore {
  private _catalogs = new Map<string, LibraryCatalog>();
  private _catalogUrls: string[] = [];
  private _catalogErrors = new Map<string, string>();
  private _activeTabUrl: string | null = null;
  private _placed: PlacedComponent[] = [];
  private _selectedId: string | null = null;
  private _mode: TransformMode = 'select';
  private _gridEnabled = true;
  private _gridSizeMm = 500;
  private _rotationSnapDeg = 15;
  private _dropToSurface = true;
  private _bboxSnapEnabled = false;
  private _bboxSnapToleranceMm = DEFAULT_BBOX_SNAP_TOLERANCE_MM;
  private _bboxSnapMid = true;
  private _bboxSnapSide = true;
  private _showNeighborDistances = true;
  private _neighborDistanceMaxMm = DEFAULT_NEIGHBOR_DIST_MAX_MM;
  private _snapPointMagnetEnabled = true;
  private _chainModeEnabled = true;
  private _placementMode: string | null = null;
  private _listeners = new Set<() => void>();
  private _snapshot: LayoutSnapshot;
  /** Map of URL -> pending Promise to serialize concurrent fetches. */
  private _pendingFetches = new Map<string, Promise<void>>();
  /** URLs added via addCatalogDirect (bundled) — excluded from localStorage. */
  private _bundledUrls = new Set<string>();

  /** Entry ids currently being auto-thumbnailed (drives per-card spinner). */
  private _thumbnailPending = new Set<string>();

  constructor() {
    // Restore grid settings from localStorage
    try {
      const ge = localStorage.getItem(LS_KEY_GRID_ENABLED);
      if (ge !== null) this._gridEnabled = ge === 'true';
      const gs = localStorage.getItem(LS_KEY_GRID_SIZE);
      if (gs !== null) {
        const n = Number(gs);
        if (!Number.isNaN(n) && n > 0) this._gridSizeMm = n;
      }
      const rs = localStorage.getItem(LS_KEY_ROTATION_SNAP);
      if (rs !== null) {
        const n = Number(rs);
        if (!Number.isNaN(n) && n > 0) this._rotationSnapDeg = n;
      }
      const dts = localStorage.getItem(LS_KEY_DROP_TO_SURFACE);
      if (dts !== null) this._dropToSurface = dts === 'true';
      const bs = localStorage.getItem(LS_KEY_BBOX_SNAP);
      if (bs !== null) this._bboxSnapEnabled = bs === 'true';
      const bsm = localStorage.getItem(LS_KEY_BBOX_SNAP_MID);
      if (bsm !== null) this._bboxSnapMid = bsm === 'true';
      const bss = localStorage.getItem(LS_KEY_BBOX_SNAP_SIDE);
      if (bss !== null) this._bboxSnapSide = bss === 'true';
      const bst = localStorage.getItem(LS_KEY_BBOX_SNAP_TOL);
      if (bst !== null) {
        const n = Number(bst);
        if (Number.isFinite(n) && n >= MIN_BBOX_SNAP_TOLERANCE_MM && n <= MAX_BBOX_SNAP_TOLERANCE_MM) {
          this._bboxSnapToleranceMm = n;
        }
      }
      const snd = localStorage.getItem(LS_KEY_SHOW_NEIGHBOR_DIST);
      if (snd !== null) this._showNeighborDistances = snd === 'true';
      const ndm = localStorage.getItem(LS_KEY_NEIGHBOR_DIST_MAX);
      if (ndm !== null) {
        const n = Number(ndm);
        if (Number.isFinite(n) && n >= MIN_NEIGHBOR_DIST_MAX_MM && n <= MAX_NEIGHBOR_DIST_MAX_MM) {
          this._neighborDistanceMaxMm = n;
        }
      }
      const spm = localStorage.getItem(LS_KEY_SNAPPOINT_MAGNET);
      if (spm !== null) this._snapPointMagnetEnabled = spm === 'true';
      const cm = localStorage.getItem(LS_KEY_CHAIN_MODE);
      if (cm !== null) this._chainModeEnabled = cm === 'true';
      const at = localStorage.getItem(LS_KEY_ACTIVE_TAB);
      if (at) this._activeTabUrl = at;
    } catch { /* ignore */ }

    this._snapshot = this._createSnapshot();
  }

  // ─── useSyncExternalStore API ─────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  getSnapshot = (): LayoutSnapshot => {
    return this._snapshot;
  };

  // ─── Catalog management (multi-tab) ───────────────────────────────

  async addCatalog(url: string): Promise<void> {
    // If already loading this URL, wait for the existing fetch
    const existing = this._pendingFetches.get(url);
    if (existing) {
      await existing;
      return;
    }

    // Avoid duplicate tabs
    if (this._catalogUrls.includes(url)) {
      this._activeTabUrl = url;
      this._notify();
      return;
    }

    // Add URL to tab list immediately (shows loading state)
    this._catalogUrls.push(url);
    if (!this._activeTabUrl) this._activeTabUrl = url;
    this._notify();

    const fetchPromise = (async () => {
      try {
        // A GitHub repo / folder URL is scanned for .glb files (no catalog.json
        // needed); any other URL is fetched as a catalog.json manifest.
        if (isGitHubRepoScanUrl(url)) {
          const data = await buildCatalogFromGitHub(url);
          this._catalogs.set(url, data);
          this._catalogErrors.delete(url);
          this._notify();
          return;
        }

        // Auto-convert GitHub blob URLs to raw URLs
        // https://github.com/user/repo/blob/main/path → https://raw.githubusercontent.com/user/repo/main/path
        let fetchUrl = url;
        const ghMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
        if (ghMatch) {
          fetchUrl = `https://raw.githubusercontent.com/${ghMatch[1]}/${ghMatch[2]}/${ghMatch[3]}`;
        }
        const resp = await fetch(fetchUrl);
        if (!resp.ok) {
          this._catalogErrors.set(url, `HTTP ${resp.status}`);
          this._notify();
          return;
        }
        const data = await resp.json() as LibraryCatalog;
        if (!data.entries || !Array.isArray(data.entries)) {
          this._catalogErrors.set(url, 'Invalid catalog format');
          this._notify();
          return;
        }
        // Derive baseUrl from catalog URL directory
        const baseUrl = data.baseUrl ?? fetchUrl.substring(0, fetchUrl.lastIndexOf('/') + 1);
        // Normalize entries: auto-fill missing fields, resolve relative URLs
        data.entries = data.entries.map(e => normalizeCatalogEntry(e, baseUrl));
        this._catalogs.set(url, data);
        this._catalogErrors.delete(url);
        this._notify();
      } catch (e) {
        this._catalogErrors.set(url, e instanceof Error ? e.message : String(e));
        this._notify();
      } finally {
        this._pendingFetches.delete(url);
      }
    })();

    this._pendingFetches.set(url, fetchPromise);
    await fetchPromise;

    this._persistUrls();
  }

  /** Inject a pre-built catalog without fetching (e.g. bundled library). */
  addCatalogDirect(key: string, catalog: LibraryCatalog): void {
    this._bundledUrls.add(key);
    if (this._catalogUrls.includes(key)) {
      // Update existing
      this._catalogs.set(key, catalog);
      this._catalogErrors.delete(key);
      this._notify();
      return;
    }
    this._catalogUrls.push(key);
    this._catalogs.set(key, catalog);
    this._catalogErrors.delete(key);
    if (!this._activeTabUrl) this._activeTabUrl = key;
    this._notify();
  }

  /** Update the thumbnail URL for a specific catalog entry.
   *
   *  Immutable update: replaces the entry, its `entries` array, and the catalog
   *  object so a new reference flows through the snapshot. The ThumbnailCard is
   *  `React.memo`'d on the `entry` prop — mutating in place would leave the
   *  reference unchanged and the card would only repaint if its spinner state
   *  happened to toggle (which is why freshly-generated previews appeared only
   *  after a reload). */
  setEntryThumbnail(entryId: string, thumbnailUrl: string): void {
    for (const [key, catalog] of this._catalogs) {
      const idx = catalog.entries.findIndex(e => e.id === entryId);
      if (idx !== -1) {
        const entries = catalog.entries.slice();
        entries[idx] = { ...entries[idx], thumbnailUrl };
        this._catalogs.set(key, { ...catalog, entries });
        this._notify();
        return;
      }
    }
  }

  /** Mark/unmark an entry as having its preview auto-generated (drives the
   *  per-card spinner). */
  setThumbnailPending(entryId: string, pending: boolean): void {
    const has = this._thumbnailPending.has(entryId);
    if (pending === has) return;
    if (pending) this._thumbnailPending.add(entryId);
    else this._thumbnailPending.delete(entryId);
    this._notify();
  }

  removeCatalog(url: string): void {
    const idx = this._catalogUrls.indexOf(url);
    if (idx === -1) return;
    this._catalogUrls.splice(idx, 1);
    this._catalogs.delete(url);
    this._catalogErrors.delete(url);

    // Switch active tab
    if (this._activeTabUrl === url) {
      this._activeTabUrl = this._catalogUrls[0] ?? null;
    }
    this._persistUrls();
    this._notify();
  }

  setActiveTab(url: string): void {
    if (!this._catalogUrls.includes(url)) return;
    this._activeTabUrl = url;
    try { localStorage.setItem(LS_KEY_ACTIVE_TAB, url); } catch { /* ignore */ }
    this._notify();
  }

  // ─── Local Working Folder support (File System Access API) ─────────

  /** True if the browser supports the File System Access API. */
  get isLocalFolderSupported(): boolean { return isFsApiSupported(); }

  /**
   * Add the working folder as a library catalog.
   *
   * If a working folder is already configured (handle in IndexedDB), reuse it —
   * Chrome may show a brief re-grant prompt because this runs in a user-gesture
   * context (button click). If no handle is stored, fall back to the native
   * directory picker.
   */
  async addLocalFolder(): Promise<void> {
    // Try to reuse an existing handle first (user-gesture context — safe to prompt).
    let root = await getWorkFolder(true);
    if (!root) {
      // No stored handle, or user denied the re-grant — show the native picker.
      root = await selectWorkFolder();
    }
    if (!root) return; // user cancelled or denied
    await this._loadLibrarySubfolder(root);
  }

  /**
   * Restore the library from a previously configured working folder.
   *
   * Called automatically at boot (no user gesture available) — must NOT call
   * `requestPermission()`. Reads the handle from IndexedDB and proceeds in
   * one of three ways:
   *   - permission still granted     → load the library subfolder normally.
   *   - handle stored, no permission → add a placeholder tab carrying the
   *     `LOCAL_NEEDS_PERMISSION` sentinel so the UI can prompt the user to
   *     re-grant access on the next click (a user-gesture context).
   *   - no handle stored             → no-op.
   */
  async restoreLocalFolder(): Promise<void> {
    const root = await getWorkFolder(false);
    if (root) {
      await this._loadLibrarySubfolder(root);
      return;
    }
    // Permission has lapsed (or was never granted in this session). If a
    // folder handle is still remembered, surface a placeholder tab so the
    // user sees the previous selection and can re-grant access by clicking
    // the tab — that click runs in a user-gesture context, which is the
    // only place `requestPermission()` is allowed.
    const meta = getWorkFolderMeta();
    if (!meta) return;
    this._addPendingLocalFolderTab(meta.displayName);
  }

  /** Insert a placeholder local-folder tab tagged with the
   *  `LOCAL_NEEDS_PERMISSION` sentinel. No-op if already present. */
  private _addPendingLocalFolderTab(folderName: string): void {
    const key = `local:${folderName}/library`;
    if (this._catalogUrls.includes(key)) return;
    this._catalogUrls.push(key);
    this._catalogs.set(key, {
      version: '1.0',
      name: `Local: ${folderName}/library`,
      entries: [],
    });
    this._catalogErrors.set(key, LOCAL_NEEDS_PERMISSION);
    this._bundledUrls.add(key); // never persist `local:` URLs into LS_KEY_URLS
    if (!this._activeTabUrl) this._activeTabUrl = key;
    this._notify();
  }

  /**
   * User-gesture entry point: prompt for read permission on the stored
   * working-folder handle and load the library subfolder. Call from a
   * click handler — the browser blocks `requestPermission()` outside of
   * user gestures. No-op if the user denies the prompt.
   */
  async activateLocalFolder(): Promise<void> {
    const root = await getWorkFolder(true);
    if (!root) return;
    // Clear the placeholder sentinel before loading so the UI flips out of
    // the "needs permission" state even if `_loadLibrarySubfolder` ends up
    // setting a different error (e.g. missing `library/` subfolder). If the
    // folder was renamed on disk since the placeholder was created, also
    // drop the now-mismatched tab — the loader will add a fresh one.
    const placeholderKey = this._catalogUrls.find(u => u.startsWith('local:'));
    const newKey = `local:${root.name}/library`;
    if (placeholderKey && placeholderKey !== newKey) {
      this.removeCatalog(placeholderKey);
    } else if (placeholderKey) {
      this._catalogErrors.delete(placeholderKey);
    }
    await this._loadLibrarySubfolder(root);
  }

  /** Refresh the local library catalog (re-scan files).
   *
   * Always called from a user gesture (the panel's Refresh button), so it uses
   * the prompting `getWorkFolder(true)` variant: if the persisted handle's read
   * permission has lapsed back to `prompt` (Chrome does this across reloads /
   * tab-backgrounding), this re-grants instead of silently no-opping — which
   * would otherwise leave the stale catalog on screen and hide newly added
   * files. When permission is already `granted`, no prompt is shown. */
  async refreshLocalFolder(): Promise<void> {
    const root = await getWorkFolder(true);
    if (!root) return;
    await this._loadLibrarySubfolder(root);
  }

  /** Remove working folder access and its catalog tab. */
  async removeLocalFolder(): Promise<void> {
    await removeWorkFolder();
    const localUrl = this._catalogUrls.find(u => u.startsWith('local:'));
    if (localUrl) this.removeCatalog(localUrl);
  }

  private async _loadLibrarySubfolder(root: FileSystemDirectoryHandle): Promise<void> {
    const key = `local:${root.name}/library`;
    try {
      // Sources merged into the single local catalog:
      //   - `library/` → all assets (GLB + Splats)
      //   - `splats/`  → splats-only (the working folder's documented home
      //                  for reality-capture point clouds). Files here are
      //                  treated identically to splats under `library/` so
      //                  the user can drop them into either location.
      const libDir = await getSubfolder(root, 'library');
      const splatsDir = await getSubfolder(root, 'splats');
      if (!libDir && !splatsDir) {
        this._catalogErrors.set(key, 'No "library/" or "splats/" subfolder found in working folder');
        this._notify();
        return;
      }

      type LibrarySource = {
        dir: FileSystemDirectoryHandle;
        files: LocalFileEntry[];
        source: 'library' | 'splats';
      };
      const sources: LibrarySource[] = [];
      if (libDir) {
        sources.push({
          dir: libDir,
          files: await listFiles(libDir, ['.glb', '.splat', '.ksplat', '.ply']),
          source: 'library',
        });
      }
      if (splatsDir) {
        sources.push({
          dir: splatsDir,
          files: await listFiles(splatsDir, ['.splat', '.ksplat', '.ply']),
          source: 'splats',
        });
      }

      // Persisted thumbnail map across both source `.thumbnails/` trees.
      // Keys are namespaced by source so `splats/.thumbnails/scan.png`
      // never collides with a hypothetical `library/.thumbnails/scan.png`.
      const thumbsByKey = new Map<string, FileSystemFileHandle>();
      for (const src of sources) {
        try {
          const thumbsDir = await src.dir.getDirectoryHandle(THUMBNAILS_SUBFOLDER);
          const thumbFiles = await listFiles(thumbsDir, ['.png']);
          for (const tf of thumbFiles) {
            thumbsByKey.set(`${src.source}/${tf.path.toLowerCase()}`, tf.handle);
          }
        } catch { /* no thumbnails folder yet — fine */ }
      }

      const entryArrays = await Promise.all(
        sources.map((src) => Promise.all(
          src.files.map(async (f: LocalFileEntry) => {
            const blobUrl = await readFileAsUrl(f.handle);
            const ext = '.' + (f.name.split('.').pop()?.toLowerCase() ?? '');
            const isSplat = SPLAT_EXTENSIONS.has(ext);
            const stem = f.name.replace(/\.(glb|splat|ksplat|ply)$/i, '');
            // Derive category from first subfolder, or 'custom' / 'splat'.
            // `category` stays in the predefined enum so existing UIs and
            // filters keep working; arbitrary subfolder names are exposed
            // separately via `collections` (Asset-Manager-style chips).
            const parts = f.path.split('/');
            const folder = parts.length > 1 ? parts[0].toLowerCase() : '';
            const category = isSplat
              ? 'splat' as LibraryCatalogEntry['category']
              : (['conveyor', 'robot', 'machine', 'fixture', 'des'].includes(folder)
                ? folder
                : 'custom') as LibraryCatalogEntry['category'];

            // Collections: every parent directory inside the source becomes
            // a chip. For `library/PalletHandling/RollConveyor2m.glb` →
            // ["PalletHandling"]. For nested `splats/Hall1/Scan.splat` →
            // ["Hall1"]. The source folder itself is not added as a chip —
            // splat-category already groups `splats/` entries together.
            const dirSegments = parts.slice(0, -1).filter(Boolean);
            const collections: string[] = [];
            for (let i = 0; i < dirSegments.length; i++) {
              collections.push(dirSegments.slice(0, i + 1).join('/'));
            }

            // Look up persisted thumbnail by mirroring the source path
            // (same subfolder structure, .png extension).
            const thumbRelPath = f.path.replace(/\.(glb|splat|ksplat|ply)$/i, '.png').toLowerCase();
            const thumbHandle = thumbsByKey.get(`${src.source}/${thumbRelPath}`);
            const thumbnailUrl = thumbHandle ? await readFileAsUrl(thumbHandle) : '';

            // Files from `splats/` use the source as a path prefix in
            // `localPath` and `id` so they round-trip cleanly on layout
            // restore and never collide with a same-name file under
            // `library/`. Files from `library/` keep their unprefixed
            // path → backwards-compatible with layouts saved before the
            // splats/ source existed.
            const prefixedPath = src.source === 'splats' ? `splats/${f.path}` : f.path;

            const base: LibraryCatalogEntry = {
              id: `local-${prefixedPath.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`,
              name: stem.replace(/[_-]/g, ' '),
              category,
              thumbnailUrl,
              pivotToFloor: !isSplat,
              localPath: prefixedPath,
              collections: collections.length > 0 ? collections : undefined,
            };
            if (isSplat) {
              base.splatUrl = blobUrl;
            } else {
              base.glbUrl = blobUrl;
            }
            return base;
          }),
        )),
      );

      const entries: LibraryCatalogEntry[] = entryArrays.flat();

      const catalog: LibraryCatalog = {
        version: '1.0',
        name: `Local: ${root.name}/library`,
        entries,
      };

      this.addCatalogDirect(key, catalog);
      this._activeTabUrl = key;
      this._notify();
    } catch (e) {
      this._catalogErrors.set(key, String(e));
      this._notify();
    }
  }

  // ─── Component management ─────────────────────────────────────────

  addComponent(comp: PlacedComponent): void {
    this._placed = [...this._placed, comp];
    this._notify();
  }

  removeComponent(id: string): void {
    this._placed = this._placed.filter(c => c.id !== id);
    if (this._selectedId === id) this._selectedId = null;
    this._notify();
  }

  selectComponent(id: string | null): void {
    this._selectedId = id;
    this._notify();
  }

  updateTransform(id: string, position: [number, number, number], rotation: [number, number, number]): void {
    this._placed = this._placed.map(c =>
      c.id === id ? { ...c, position, rotation } : c,
    );
    this._notify();
  }

  /** Replace the scale vector of a placed component. Used by splat axis
   *  inversion (sets components to ±1) — drag/translate paths do not touch
   *  scale, so this is the only writer aside from the loader. */
  updateScale(id: string, scale: [number, number, number]): void {
    this._placed = this._placed.map(c =>
      c.id === id ? { ...c, scale } : c,
    );
    this._notify();
  }

  /** Toggle visibility of a placed component. Persisted so the
   *  hide-state survives reload (Three.js `object.visible` is not part
   *  of the GLB cache and would otherwise be lost). */
  updateVisibility(id: string, visible: boolean): void {
    this._placed = this._placed.map(c =>
      c.id === id ? { ...c, visible } : c,
    );
    this._notify();
  }

  updateGlbUrl(id: string, glbUrl: string): void {
    this._placed = this._placed.map(c =>
      c.id === id ? { ...c, glbUrl } : c,
    );
    this._notify();
  }

  updateLabel(id: string, label: string): void {
    this._placed = this._placed.map(c =>
      c.id === id ? { ...c, label } : c,
    );
    this._notify();
  }

  // ─── Mode & Grid ──────────────────────────────────────────────────

  setMode(mode: TransformMode): void {
    this._mode = mode;
    this._notify();
  }

  setGridEnabled(enabled: boolean): void {
    this._gridEnabled = enabled;
    try { localStorage.setItem(LS_KEY_GRID_ENABLED, String(enabled)); } catch { /* ignore */ }
    this._notify();
  }

  setDropToSurface(enabled: boolean): void {
    this._dropToSurface = enabled;
    try { localStorage.setItem(LS_KEY_DROP_TO_SURFACE, String(enabled)); } catch { /* ignore */ }
    this._notify();
  }

  /** Toggle magnetic snap to other layout objects. Persisted to localStorage. */
  setBboxSnap(enabled: boolean): void {
    this._bboxSnapEnabled = enabled;
    try { localStorage.setItem(LS_KEY_BBOX_SNAP, String(enabled)); } catch { /* ignore */ }
    this._notify();
  }

  /** Toggle whether bbox centres count as snap references. Persisted. */
  setBboxSnapMid(enabled: boolean): void {
    this._bboxSnapMid = enabled;
    try { localStorage.setItem(LS_KEY_BBOX_SNAP_MID, String(enabled)); } catch { /* ignore */ }
    this._notify();
  }

  /** Toggle whether bbox edges (min/max) count as snap references. Persisted. */
  setBboxSnapSide(enabled: boolean): void {
    this._bboxSnapSide = enabled;
    try { localStorage.setItem(LS_KEY_BBOX_SNAP_SIDE, String(enabled)); } catch { /* ignore */ }
    this._notify();
  }

  /** Set magnetic-snap tolerance in millimetres. Persisted to localStorage. */
  setBboxSnapToleranceMm(mm: number): void {
    this._bboxSnapToleranceMm = mm;
    try { localStorage.setItem(LS_KEY_BBOX_SNAP_TOL, String(mm)); } catch { /* ignore */ }
    this._notify();
  }

  /** Toggle the 4-direction neighbor-distance overlay during drag. */
  setShowNeighborDistances(enabled: boolean): void {
    this._showNeighborDistances = enabled;
    try { localStorage.setItem(LS_KEY_SHOW_NEIGHBOR_DIST, String(enabled)); } catch { /* ignore */ }
    this._notify();
  }

  /** Set the maximum auto-measure distance in millimetres. */
  setNeighborDistanceMaxMm(mm: number): void {
    this._neighborDistanceMaxMm = mm;
    try { localStorage.setItem(LS_KEY_NEIGHBOR_DIST_MAX, String(mm)); } catch { /* ignore */ }
    this._notify();
  }

  /** Toggle drag-time magnetic snap between matching snap points. */
  setSnapPointMagnet(enabled: boolean): void {
    this._snapPointMagnetEnabled = enabled;
    try { localStorage.setItem(LS_KEY_SNAPPOINT_MAGNET, String(enabled)); } catch { /* ignore */ }
    this._notify();
  }

  /** Toggle chain mode: when on, connected assets follow during drag. */
  setChainMode(enabled: boolean): void {
    this._chainModeEnabled = enabled;
    try { localStorage.setItem(LS_KEY_CHAIN_MODE, String(enabled)); } catch { /* ignore */ }
    this._notify();
  }

  setGridSize(mm: number): void {
    this._gridSizeMm = mm;
    try { localStorage.setItem(LS_KEY_GRID_SIZE, String(mm)); } catch { /* ignore */ }
    this._notify();
  }

  /** Set the rotation snap step in degrees. Persisted to localStorage. */
  setRotationSnapDeg(deg: number): void {
    this._rotationSnapDeg = deg;
    try { localStorage.setItem(LS_KEY_ROTATION_SNAP, String(deg)); } catch { /* ignore */ }
    this._notify();
  }

  setPlacementMode(catalogEntryId: string | null): void {
    this._placementMode = catalogEntryId;
    this._notify();
  }

  // ─── Persistence ──────────────────────────────────────────────────

  autoSave(): void {
    try {
      const layout = serializeLayout(
        'autosave',
        this._placed,
        this._catalogUrls,
        this._gridSizeMm,
      );
      localStorage.setItem(LS_KEY_AUTOSAVE, JSON.stringify(layout));
    } catch {
      // QuotaExceededError — silently ignore
    }
  }

  loadAutoSave(): void {
    try {
      const json = localStorage.getItem(LS_KEY_AUTOSAVE);
      if (!json) return;
      const layout = deserializeLayout(json);
      this._placed = layout.components;
      this._gridSizeMm = layout.gridSizeMm;
      this._notify();
    } catch { /* ignore corrupt data */ }
  }

  async restoreFromStorage(): Promise<void> {
    try {
      const urlsJson = localStorage.getItem(LS_KEY_URLS);
      if (!urlsJson) return;
      const urls = (JSON.parse(urlsJson) as string[]).filter(u => u.trim() !== '');
      for (const url of urls) {
        await this.addCatalog(url);
      }
    } catch { /* ignore */ }
  }

  /** Replace all placed components (used when loading a layout file). */
  setComponents(components: PlacedComponent[]): void {
    this._placed = [...components];
    this._selectedId = null;
    this._notify();
  }

  // ─── Getters (non-React) ──────────────────────────────────────────

  get placed(): PlacedComponent[] { return this._placed; }
  get selectedId(): string | null { return this._selectedId; }
  get gridEnabled(): boolean { return this._gridEnabled; }
  get gridSizeMm(): number { return this._gridSizeMm; }
  get rotationSnapDeg(): number { return this._rotationSnapDeg; }
  get dropToSurface(): boolean { return this._dropToSurface; }
  get bboxSnapEnabled(): boolean { return this._bboxSnapEnabled; }
  get bboxSnapToleranceMm(): number { return this._bboxSnapToleranceMm; }
  get bboxSnapMid(): boolean { return this._bboxSnapMid; }
  get bboxSnapSide(): boolean { return this._bboxSnapSide; }
  get showNeighborDistances(): boolean { return this._showNeighborDistances; }
  get neighborDistanceMaxMm(): number { return this._neighborDistanceMaxMm; }
  get snapPointMagnetEnabled(): boolean { return this._snapPointMagnetEnabled; }
  get chainModeEnabled(): boolean { return this._chainModeEnabled; }

  // ─── Internal ─────────────────────────────────────────────────────

  private _persistUrls(): void {
    try {
      // Only persist user-added URLs, not bundled ones
      const userUrls = this._catalogUrls.filter(u => u.trim() !== '' && !this._bundledUrls.has(u));
      localStorage.setItem(LS_KEY_URLS, JSON.stringify(userUrls));
    } catch { /* ignore */ }
  }

  private _createSnapshot(): LayoutSnapshot {
    return {
      catalogs: new Map(this._catalogs),
      catalogUrls: [...this._catalogUrls],
      catalogErrors: new Map(this._catalogErrors),
      activeTabUrl: this._activeTabUrl,
      placed: this._placed,
      selectedId: this._selectedId,
      mode: this._mode,
      gridEnabled: this._gridEnabled,
      gridSizeMm: this._gridSizeMm,
      rotationSnapDeg: this._rotationSnapDeg,
      dropToSurface: this._dropToSurface,
      bboxSnapEnabled: this._bboxSnapEnabled,
      bboxSnapToleranceMm: this._bboxSnapToleranceMm,
      bboxSnapMid: this._bboxSnapMid,
      bboxSnapSide: this._bboxSnapSide,
      showNeighborDistances: this._showNeighborDistances,
      neighborDistanceMaxMm: this._neighborDistanceMaxMm,
      snapPointMagnetEnabled: this._snapPointMagnetEnabled,
      chainModeEnabled: this._chainModeEnabled,
      placementMode: this._placementMode,
      thumbnailPending: new Set(this._thumbnailPending),
    };
  }

  private _notify(): void {
    this._snapshot = this._createSnapshot();
    for (const l of this._listeners) l();
  }
}
