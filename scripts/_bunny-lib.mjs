// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * _bunny-lib.mjs — Reusable, individually testable building blocks for the
 * Unity-independent Bunny CDN deploy CLI (`bunny-deploy.mjs`).
 *
 * This is a direct 1:1 behavior port of the Unity C# tooling so that a deploy
 * performed by the CLI is bit-functionally identical to a deploy performed from
 * the Unity Editor:
 *   - HTTP / diff / MIME / purge / retry  → BunnyCdnUploader.cs
 *   - private staging / settings / models → WebViewerToolbar.cs
 *
 * Each parity function carries a `// SOURCE: <file>:<line> — keep in sync`
 * comment. If the C# side changes, update the matching JS here.
 *
 * Zero new runtime deps: Node built-ins + global fetch only (Node 18+).
 */

import {
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  existsSync,
} from 'node:fs';
import { join, extname, basename, sep } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Constants ───────────────────────────────────────────────────────────

//! Files that bypass the size-based diff check and are ALWAYS re-uploaded.
//! Vite rewrites these on every build with new hashed asset references of
//! identical byte length, so size-only diff would incorrectly skip them and
//! the CDN would keep serving HTML that points at stale JS/CSS.
// SOURCE: BunnyCdnUploader.cs:637 (IsAlwaysUploadFile) — keep in sync
export const ALWAYS_UPLOAD_FILES = new Set([
  'settings.json',
  'models.json',
  'manifest.json',
]);

const DEFAULT_REGION = 'storage.bunnycdn.com';
const FETCH_TIMEOUT_MS = 300_000; // parity with C# HttpClient.Timeout = 5 min (R4)
const MAX_ATTEMPTS = 3;

// ─── Path / URL helpers ──────────────────────────────────────────────────

//! Normalizes a relative path by replacing backslashes with forward slashes.
//! Critical on Windows dev machines (R5).
// SOURCE: BunnyCdnUploader.cs:72 (NormalizePath) — keep in sync
export function normalizePath(path) {
  if (!path) return path;
  return path.split(sep).join('/').replace(/\\/g, '/');
}

//! Builds the full Bunny storage upload URL. Encodes each path segment
//! individually (handles spaces / special chars in filenames), keeps slashes.
// SOURCE: BunnyCdnUploader.cs:60 (BuildUploadUrl) — keep in sync
export function buildUploadUrl(region, storageZone, relativePath) {
  const host = region.startsWith('https://') ? region : `https://${region}`;
  const encodedPath = relativePath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  const zone = storageZone.replace(/^\/+|\/+$/g, '');
  return `${host}/${zone}/${encodedPath}`;
}

//! Normalizes a region string. EditorPrefs may store a label suffix such as
//! "storage.bunnycdn.com (Falkenstein DE)" — only the first token is the host.
// SOURCE: WebViewerToolbar.cs:1336 (regionEntry.Split(' ')[0]) — keep in sync
export function normalizeRegion(region) {
  if (!region || !region.trim()) return DEFAULT_REGION;
  return region.trim().split(' ')[0].trim();
}

//! Returns a MIME type for common web asset extensions. `.glb` MUST map to
//! `model/gltf-binary` or Three.js refuses to load the model.
// SOURCE: BunnyCdnUploader.cs:650 (GetMimeType) — keep in sync
export function mimeType(filePath) {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html';
    case '.css': return 'text/css';
    case '.js': return 'application/javascript';
    case '.json': return 'application/json';
    case '.png': return 'image/png';
    case '.jpg': return 'image/jpeg';
    case '.jpeg': return 'image/jpeg';
    case '.svg': return 'image/svg+xml';
    case '.ico': return 'image/x-icon';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.ttf': return 'font/ttf';
    case '.glb': return 'model/gltf-binary';
    case '.gltf': return 'model/gltf+json';
    default: return 'application/octet-stream';
  }
}

//! True for files that must bypass the size-diff check (see ALWAYS_UPLOAD_FILES).
// SOURCE: BunnyCdnUploader.cs:637 (IsAlwaysUploadFile) — keep in sync
export function isAlwaysUploadFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.html') return true;
  return ALWAYS_UPLOAD_FILES.has(basename(filePath).toLowerCase());
}

// ─── Config ──────────────────────────────────────────────────────────────

//! Reads + validates the Bunny credentials from an env object (default
//! process.env). Throws on missing required keys (CI fail-fast).
export function loadConfig(env = process.env) {
  const storageKey = (env.BUNNY_STORAGE_KEY || '').trim();
  const storageZone = (env.BUNNY_STORAGE_ZONE || '').trim();

  if (!storageKey) throw new Error('Missing required env BUNNY_STORAGE_KEY');
  if (!storageZone) throw new Error('Missing required env BUNNY_STORAGE_ZONE');

  return {
    storageKey,
    storageZone: storageZone.replace(/^\/+|\/+$/g, ''),
    accountKey: (env.BUNNY_ACCOUNT_KEY || '').trim(),
    pullZoneId: (env.BUNNY_PULL_ZONE_ID || '').trim(),
    region: normalizeRegion(env.BUNNY_REGION),
    remotePath: (env.BUNNY_REMOTE_PATH || '').trim().replace(/^\/+|\/+$/g, ''),
    googleAnalyticsId: (env.GA_MEASUREMENT_ID || '').trim(),
  };
}

// ─── Build env ───────────────────────────────────────────────────────────

//! Builds the environment for `npm run build` for a given mode.
//! Public  → VITE_PUBLIC_BUILD=1 (HAS_PRIVATE=false, no private content).
//! Private → MUST NOT set VITE_PUBLIC_BUILD (private content compiled in).
//! Optional `base` → VITE_BASE (Vite base path, e.g. /demo/).
// SOURCE: WebViewerToolbar.cs (BuildWebViewerPrivate vs public deploy) — keep in sync
export function buildEnvForMode(mode, opts = {}) {
  const env = { ...process.env };
  if (mode === 'public') {
    env.VITE_PUBLIC_BUILD = '1';
  } else {
    // Private build: ensure VITE_PUBLIC_BUILD is NOT inherited from a prior public run.
    delete env.VITE_PUBLIC_BUILD;
  }
  if (opts.base) env.VITE_BASE = opts.base;
  return env;
}

// ─── Sanitize ────────────────────────────────────────────────────────────

//! Sanitizes a demo / project name for use in URLs: lowercase, alphanumeric +
//! hyphens, collapsed + trimmed, capped at 60 chars. Empty → "demo".
// SOURCE: WebViewerToolbar.cs:1050 (SanitizeDemoName) — keep in sync
export function sanitizeDemoName(name) {
  if (!name) return 'demo';
  let out = String(name).toLowerCase().trim();
  out = out.replace(/[^a-z0-9-]/g, '-');
  out = out.replace(/-+/g, '-');
  out = out.replace(/^-+|-+$/g, '');
  if (out.length > 60) out = out.substring(0, 60);
  return out || 'demo';
}

// ─── Local file collection + diff ────────────────────────────────────────

//! Recursively collects files under a directory. Returns
//! [{ abs, rel, size }] with forward-slash relative paths. Skips `.map`.
// SOURCE: BunnyCdnUploader.cs:239 (GetFiles + .map skip) — keep in sync
export function collectLocalFiles(rootDir) {
  const out = [];
  const root = rootDir.replace(/[\\/]+$/, '');
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (extname(entry.name).toLowerCase() === '.map') continue;
      const rel = normalizePath(abs.substring(root.length + 1));
      out.push({ abs, rel, size: statSync(abs).size });
    }
  }
  walk(root);
  return out;
}

//! Selects which local files need uploading. `local` = [{ rel, size }],
//! `remote` = Map<lowercaseRelPath, size>. A file is skipped when its remote
//! size equals the local size AND it is not an always-upload file. With
//! `force: true` everything is selected.
// SOURCE: BunnyCdnUploader.cs:287 (diff check) — keep in sync
export function selectFilesToUpload(local, remote, opts = {}) {
  if (opts.force || !remote) return [...local];
  const result = [];
  for (const f of local) {
    if (isAlwaysUploadFile(f.rel)) {
      result.push(f);
      continue;
    }
    const remoteSize = remote.get(f.rel.toLowerCase());
    if (remoteSize !== undefined && remoteSize === f.size) {
      continue; // unchanged
    }
    result.push(f);
  }
  return result;
}

//! Builds a Map<lowercaseRelPath, size> from a flat list of remote storage
//! entries (already flattened, directories filtered out by listRecursive).
export function buildRemoteIndex(entries) {
  const map = new Map();
  for (const e of entries) {
    if (e.isDirectory) continue;
    map.set(e.rel.toLowerCase(), e.size);
  }
  return map;
}

// ─── Bunny HTTP client ───────────────────────────────────────────────────

//! Thin HTTP client over the Bunny Storage + CDN APIs. Uses global fetch with
//! a 5-minute AbortSignal.timeout (R4) and exponential backoff + jitter (R7).
export class BunnyClient {
  constructor({ region, zone, storageKey, accountKey = '', pullZoneId = '', dryRun = false, log = () => {} }) {
    this.region = region;
    this.zone = zone.replace(/^\/+|\/+$/g, '');
    this.storageKey = storageKey;
    this.accountKey = accountKey;
    this.pullZoneId = pullZoneId;
    this.dryRun = dryRun;
    this.log = log;
  }

  _host() {
    return this.region.startsWith('https://') ? this.region : `https://${this.region}`;
  }

  //! Uploads a single file (Buffer/Uint8Array) to the given remote path.
  //! Accepts HTTP 200/201. Retries up to 3 times on 5xx / network error with
  //! exponential backoff (2^n * 1000 ms) + jitter.
  // SOURCE: BunnyCdnUploader.cs:308 (per-file PUT + retry loop) — keep in sync
  async putFile(bytes, remotePath, mimeOverride) {
    if (this.dryRun) {
      this.log(`[dry-run] PUT ${remotePath}`);
      return;
    }
    const url = buildUploadUrl(this.region, this.zone, normalizePath(remotePath));
    const contentType = mimeOverride || mimeType(remotePath);
    let lastErr = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const resp = await fetch(url, {
          method: 'PUT',
          headers: {
            AccessKey: this.storageKey,
            'Content-Type': contentType,
          },
          body: bytes,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (resp.status === 201 || resp.status === 200) return;
        const body = await resp.text().catch(() => '');
        lastErr = `HTTP ${resp.status}: ${body.slice(0, 200)}`;
      } catch (ex) {
        lastErr = ex?.message ?? String(ex);
      }
      if (attempt < MAX_ATTEMPTS) {
        const backoff = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw new Error(`Upload failed after ${MAX_ATTEMPTS} attempts: ${lastErr}`);
  }

  //! Recursively lists a remote storage path. Returns a flat array of
  //! { rel, size, isDirectory:false } where `rel` is relative to `remoteRoot`.
  //! Directories are descended into, not emitted. A failed/empty listing
  //! returns [] (first deploy: nothing remote yet).
  // SOURCE: BunnyCdnUploader.cs:378 (ListStorageRecursiveAsync) — keep in sync
  async listRecursive(remoteRoot) {
    const root = normalizePath(remoteRoot || '').replace(/^\/+|\/+$/g, '');
    const result = [];
    await this._listInto(root, root, result);
    return result;
  }

  async _listInto(currentPath, rootPath, result) {
    const segment = currentPath ? `/${currentPath}/` : '/';
    const url = `${this._host()}/${this.zone}${segment}`;
    let entries;
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { AccessKey: this.storageKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) return;
      entries = await resp.json();
    } catch (ex) {
      this.log(`[bunny] failed to list ${currentPath || '/'}: ${ex?.message ?? ex}`);
      return;
    }
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const name = String(entry.ObjectName ?? '').replace(/^\/+|\/+$/g, '');
      const entryPath = currentPath ? `${currentPath}/${name}` : name;
      if (entry.IsDirectory) {
        await this._listInto(entryPath, rootPath, result);
      } else {
        const rel = rootPath ? entryPath.substring(rootPath.length).replace(/^\/+/, '') : entryPath;
        result.push({ rel, size: Number(entry.Length ?? 0), isDirectory: false });
      }
    }
  }

  //! Purges the configured pull-zone cache (single POST). No-op if account key
  //! or pull-zone id is missing. Failure is non-fatal (logged, not thrown).
  // SOURCE: BunnyCdnUploader.cs:594 (PurgeCacheAsync) — keep in sync
  async purge() {
    if (!this.pullZoneId || !this.accountKey) {
      this.log('[bunny] purge skipped (no account key / pull zone id)');
      return false;
    }
    if (this.dryRun) {
      this.log(`[dry-run] purge pull zone ${this.pullZoneId}`);
      return true;
    }
    try {
      const resp = await fetch(`https://api.bunny.net/pullzone/${this.pullZoneId}/purgeCache`, {
        method: 'POST',
        headers: { AccessKey: this.accountKey, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        this.log(`[bunny] purge returned HTTP ${resp.status}: ${body.slice(0, 200)}`);
        return false;
      }
      return true;
    } catch (ex) {
      this.log(`[bunny] purge failed (non-fatal): ${ex?.message ?? ex}`);
      return false;
    }
  }
}

// ─── Private project: load / validate ────────────────────────────────────

//! Loads + validates a project.json. Throws (with filename) when missing or
//! when `code` / `name` are absent — so a deploy never lands under `undefined/`.
// SOURCE: WebViewerToolbar.cs:1135 (LoadProject) + R6 validation — keep in sync
export function loadProject(projectDir) {
  const jsonPath = join(projectDir, 'project.json');
  if (!existsSync(jsonPath)) {
    throw new Error(`project.json not found in ${projectDir}`);
  }
  let project;
  try {
    project = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch (ex) {
    throw new Error(`Failed to parse ${jsonPath}: ${ex?.message ?? ex}`);
  }
  if (!project || typeof project.code !== 'string' || !project.code.trim()) {
    throw new Error(`Invalid project.json (missing "code"): ${jsonPath}`);
  }
  if (typeof project.name !== 'string' || !project.name.trim()) {
    throw new Error(`Invalid project.json (missing "name"): ${jsonPath}`);
  }
  return project;
}

//! Discovers private projects: subfolders of `baseDir` that contain a
//! project.json. Returns [{ project, projectDir, folderName }].
// SOURCE: WebViewerToolbar.cs:1112 (DiscoverPrivateProjects) — keep in sync
export function discoverPrivateProjects(baseDir) {
  const result = [];
  if (!baseDir || !existsSync(baseDir)) return result;
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectDir = join(baseDir, entry.name);
    if (!existsSync(join(projectDir, 'project.json'))) continue;
    try {
      const project = loadProject(projectDir);
      result.push({ project, projectDir, folderName: entry.name });
    } catch {
      // corrupt project.json — skip in discovery
    }
  }
  return result;
}

// ─── Private project: settings.json ──────────────────────────────────────

//! Generates the settings.json content for a private project.
//! GA id comes from the caller (env GA_MEASUREMENT_ID); empty = no analytics.
//! The hardcoded C# id `G-4XNW76DQQG` is intentionally NOT ported (R2 / O5).
// SOURCE: WebViewerToolbar.cs:1185 (GeneratePrivateSettings) — keep in sync
export function generatePrivateSettings(project, projectFolderName, opts = {}) {
  let defaultModel = project?.settings?.defaultModel ?? '';
  if (defaultModel && !defaultModel.startsWith('models/')) {
    defaultModel = 'models/' + defaultModel;
  }
  const settings = {};
  if (defaultModel) settings.defaultModel = defaultModel;
  if (projectFolderName) settings.projectAssetsPath = `private-assets/${projectFolderName}/`;
  settings.analytics = { googleAnalyticsId: opts.googleAnalyticsId || '' };
  settings.generated = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return JSON.stringify(settings, null, 2);
}

// ─── Private project: staging ────────────────────────────────────────────

function copyDirRecursive(sourceDir, destDir, excludeExtensions) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const srcPath = join(sourceDir, entry.name);
    const dstPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath, excludeExtensions);
    } else {
      if (excludeExtensions && excludeExtensions.has(extname(entry.name).toLowerCase())) continue;
      copyFileSync(srcPath, dstPath);
    }
  }
}

//! Stages a private project into a fresh temp directory ready for upload.
//! Copies dist/ (root files flat; subdirs except models/; assets/ without .glb),
//! the project's own models/*.glb, then writes models.json + settings.json.
//! Returns the staging directory path. Does NOT build (caller builds first).
//! Caller is responsible for cleaning up the returned dir (try/finally).
// SOURCE: WebViewerToolbar.cs:1215 (StagePrivateProject) — keep in sync
export function stagePrivateProject({ distDir, projectDir, googleAnalyticsId = '' }) {
  if (!existsSync(distDir)) {
    throw new Error(`dist/ not found: ${distDir}`);
  }
  const project = loadProject(projectDir);
  const folderName = basename(projectDir);

  // Fresh atomic staging dir (R9).
  const stagingDir = mkdtempSync(join(tmpdir(), `realvirtual-private-${project.code}-`));

  // Copy dist/ root files flat.
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (entry.isFile()) {
      copyFileSync(join(distDir, entry.name), join(stagingDir, entry.name));
    }
  }
  // Copy dist/ subdirectories EXCEPT models/; strip .glb out of assets/.
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.toLowerCase() === 'models') continue;
    const exclude = entry.name.toLowerCase() === 'assets' ? new Set(['.glb']) : null;
    copyDirRecursive(join(distDir, entry.name), join(stagingDir, entry.name), exclude);
  }

  // Copy project models/*.glb.
  const projectModelsDir = join(projectDir, 'models');
  const stagingModelsDir = join(stagingDir, 'models');
  mkdirSync(stagingModelsDir, { recursive: true });
  let glbNames = [];
  if (existsSync(projectModelsDir)) {
    for (const entry of readdirSync(projectModelsDir, { withFileTypes: true })) {
      if (entry.isFile() && extname(entry.name).toLowerCase() === '.glb') {
        copyFileSync(join(projectModelsDir, entry.name), join(stagingModelsDir, entry.name));
        glbNames.push(entry.name);
      }
    }
  }

  // models.json (array of GLB filenames) — AlwaysUpload file.
  writeFileSync(join(stagingDir, 'models.json'), JSON.stringify(glbNames));

  // settings.json with project assets path + analytics.
  writeFileSync(
    join(stagingDir, 'settings.json'),
    generatePrivateSettings(project, folderName, { googleAnalyticsId }),
  );

  return stagingDir;
}
