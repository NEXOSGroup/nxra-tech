// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * bunny-deploy.mjs — Unity-independent, CI-capable Bunny CDN deploy CLI for the
 * realvirtual WebViewer. Builds the Vite app, then diff-uploads dist/ (+ project
 * GLBs) to Bunny CDN Edge Storage — public demo or a private customer project.
 *
 * Behavior is a 1:1 parity port of the Unity C# tooling (BunnyCdnUploader.cs +
 * WebViewerToolbar.cs); the reusable logic lives in `_bunny-lib.mjs`. The GLB
 * export itself stays Unity-bound — this tool deploys existing builds + models.
 *
 * Credentials come exclusively from env (no EditorPrefs, no hardcoded secret).
 * See `.env.example`. Exit code: 0 = OK, 1 = error.
 *
 * Usage:
 *   node scripts/bunny-deploy.mjs                          # public deploy (build + upload)
 *   node scripts/bunny-deploy.mjs --path demo              # public, custom remote prefix
 *   node scripts/bunny-deploy.mjs --private --project "Kunde XY"
 *   node scripts/bunny-deploy.mjs --private --list         # list private projects
 *   node scripts/bunny-deploy.mjs --no-build               # deploy existing dist/
 *   node scripts/bunny-deploy.mjs --force                  # skip diff, upload all
 *   node scripts/bunny-deploy.mjs --dry-run                # log only, no build/upload
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadConfig,
  buildEnvForMode,
  BunnyClient,
  collectLocalFiles,
  buildRemoteIndex,
  selectFilesToUpload,
  stagePrivateProject,
  discoverPrivateProjects,
  loadProject,
  sanitizeDemoName,
  applyPublicModelAllowlist,
  PUBLIC_MODEL_PREFIX,
} from './_bunny-lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

//! Load credentials from a gitignored .env file into process.env (dependency-free).
//! CI / real shell env wins — we only fill keys that aren't already set. Vite
//! auto-loads .env.production for the BUILD, but this plain Node script does not,
//! so without this `npm run deploy` can't see BUNNY_* locally. Mirrors .env.example.
function loadDotEnv() {
  for (const name of ['.env.production', '.env']) {
    const p = join(ROOT, name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      const val = m[2].replace(/^["']|["']$/g, '');
      if (process.env[key] === undefined || process.env[key] === '') process.env[key] = val;
    }
  }
}

// ─── CLI args (parity with webtest.mjs getArg/hasFlag) ───────────────────

const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return defaultVal;
  if (idx + 1 < args.length && !args[idx + 1].startsWith('--')) return args[idx + 1];
  return defaultVal;
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}

// ─── ANSI colors ─────────────────────────────────────────────────────────
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';

function log(msg) { console.log(msg); }
function info(label, value) { console.log(`  ${CYAN}${label.padEnd(10)}${RESET}: ${value}`); }

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Build ───────────────────────────────────────────────────────────────

//! Runs `npm run build` with mode-specific env. Throws on non-zero exit so the
//! caller aborts before any upload (R8).
function runBuild(mode, base, dryRun) {
  const env = buildEnvForMode(mode, { base });
  log(`${DIM}Building (${mode}${base ? `, base=${base}` : ''})...${RESET}`);
  if (dryRun) {
    log(`${DIM}[dry-run] skipping npm run build${RESET}`);
    return;
  }
  execSync('npm run build', { cwd: ROOT, env, shell: true, stdio: 'inherit' });
}

// ─── Shared upload routine ───────────────────────────────────────────────

//! Diff-uploads all files from `localDir` to `{remotePrefix}/...`. Returns
//! { uploaded, skipped }. Atomic ordering: every non-index.html file first,
//! index.html files last (R10), so the CDN never points new HTML at missing
//! assets.
async function uploadDirectory(client, localDir, remotePrefix, { force, dryRun }) {
  const local = collectLocalFiles(localDir);
  if (local.length === 0) {
    throw new Error(`No files to upload in ${localDir}`);
  }

  let remoteIndex = null;
  if (!force) {
    log(`${DIM}Fetching remote file list for diff...${RESET}`);
    const entries = await client.listRecursive(remotePrefix);
    remoteIndex = buildRemoteIndex(entries);
    info('diff', `${remoteIndex.size} remote files indexed`);
  }

  const selected = selectFilesToUpload(local, remoteIndex, { force });
  const skipped = local.length - selected.length;

  // Atomic ordering: assets first, index.html last.
  const isIndexHtml = (rel) => /(^|\/)index\.html$/i.test(rel);
  selected.sort((a, b) => Number(isIndexHtml(a.rel)) - Number(isIndexHtml(b.rel)));

  const prefix = (remotePrefix || '').replace(/^\/+|\/+$/g, '');
  let uploaded = 0;
  for (const f of selected) {
    const remotePath = prefix ? `${prefix}/${f.rel}` : f.rel;
    const always = /\.html$/i.test(f.rel) || /(^|\/)(settings|models|manifest)\.json$/i.test(f.rel);
    const tag = always ? `${MAGENTA}(always)${RESET}` : '';
    log(`  ${GREEN}↑${RESET} ${f.rel} ${tag} ${DIM}${humanSize(f.size)}${RESET}`);
    try {
      await client.putFile(readFileSync(f.abs), remotePath);
      uploaded++;
    } catch (ex) {
      throw new Error(
        `Failed to upload ${f.rel}: ${ex?.message ?? ex}\n` +
        `  (rerun without --force to resume via diff)`,
      );
    }
  }

  if (skipped > 0) log(`  ${DIM}= ${skipped} unchanged (skipped)${RESET}`);
  return { uploaded, skipped };
}

// ─── Public deploy ───────────────────────────────────────────────────────

async function deployPublic(cfg, opts) {
  const distDir = opts.dist;
  const remotePrefix = opts.path ?? cfg.remotePath;

  if (!opts.noBuild) {
    runBuild('public', opts.base, opts.dryRun);
  }
  if (!existsSync(distDir)) {
    throw new Error(`dist/ not found: ${distDir} (build first or drop --no-build)`);
  }

  // Model allowlist: the public CDN must ship ONLY the official demo models
  // (prefix DemoRealvirtual*) plus the planner library — prune test/helper/stray
  // GLBs (and their hashed assets/ duplicates) before upload, and rewrite
  // models.json so the selector lists exactly what is shipped.
  const modelPrefix = (process.env.RV_PUBLIC_MODEL_PREFIX || PUBLIC_MODEL_PREFIX).trim() || PUBLIC_MODEL_PREFIX;
  const allow = applyPublicModelAllowlist(distDir, { prefix: modelPrefix, dryRun: opts.dryRun });
  log(`${DIM}Public model allowlist (prefix "${modelPrefix}*"): `
    + `${allow.kept.length} kept, ${allow.dropped.length} pruned`
    + `${allow.droppedAssets.length ? ` (+${allow.droppedAssets.length} hashed)` : ''}${RESET}`);
  for (const f of allow.kept) log(`  ${GREEN}keep${RESET} models/${f}`);
  for (const f of allow.dropped) log(`  ${RED}prune${RESET} models/${f}`);
  if (allow.kept.length === 0) {
    log(`  ${RED}⚠ no model matches prefix "${modelPrefix}*" — the public selector will be empty${RESET}`);
  }

  // GA injection (R2): inject only into the deployed settings.json, never commit it.
  injectGaIntoSettings(join(distDir, 'settings.json'), cfg.googleAnalyticsId, opts.dryRun);

  log('');
  log(`${MAGENTA}realvirtual WebViewer · Bunny Deploy${RESET}`);
  info('mode', 'public');
  info('zone', `${cfg.storageZone}  region ${cfg.region}`);
  info('remote', `${remotePrefix || '(root)'}/`);

  const client = new BunnyClient({
    region: cfg.region, zone: cfg.storageZone, storageKey: cfg.storageKey,
    accountKey: cfg.accountKey, pullZoneId: cfg.pullZoneId, dryRun: opts.dryRun, log,
  });

  const { uploaded, skipped } = await uploadDirectory(client, distDir, remotePrefix, opts);

  await maybePurge(client, uploaded, opts);
  info('done', `${uploaded} uploaded, ${skipped} unchanged`);
}

// ─── Private deploy ──────────────────────────────────────────────────────

async function deployPrivate(cfg, opts) {
  const projectsDir = opts.projectsDir;
  if (!projectsDir) {
    throw new Error('Private deploy requires --projects-dir <dir> (or BUNNY_PRIVATE_PROJECTS_DIR env)');
  }

  if (opts.list) {
    listPrivateProjects(projectsDir);
    return;
  }
  if (!opts.project) {
    throw new Error('Private deploy requires --project <name> (or --list to enumerate)');
  }

  const projectDir = resolvePrivateProjectDir(projectsDir, opts.project);
  const project = loadProject(projectDir); // validates code + name (R6)

  if (!opts.noBuild) {
    runBuild('private', opts.base, opts.dryRun); // NOTE: no VITE_PUBLIC_BUILD
  }
  if (!existsSync(opts.dist)) {
    throw new Error(`dist/ not found: ${opts.dist} (build first or drop --no-build)`);
  }

  log('');
  log(`${MAGENTA}realvirtual WebViewer · Bunny Deploy${RESET}`);
  info('mode', `private  project "${project.name}" (code ${project.code.slice(0, 8)}…)`);
  info('zone', `${cfg.storageZone}  region ${cfg.region}`);
  info('remote', `${project.code}/`);

  const client = new BunnyClient({
    region: cfg.region, zone: cfg.storageZone, storageKey: cfg.storageKey,
    accountKey: cfg.accountKey, pullZoneId: cfg.pullZoneId, dryRun: opts.dryRun, log,
  });

  let totalUploaded = 0;
  let totalSkipped = 0;
  let stagingDir = null;
  try {
    if (opts.dryRun) {
      log(`${DIM}[dry-run] would stage project + upload to ${project.code}/${RESET}`);
    } else {
      stagingDir = stagePrivateProject({
        distDir: opts.dist,
        projectDir,
        googleAnalyticsId: cfg.googleAnalyticsId,
      });
      info('staging', stagingDir);

      // Pass 1: app + models → {code}/
      log(`${DIM}Pass 1/2: app + models${RESET}`);
      const p1 = await uploadDirectory(client, stagingDir, project.code, opts);
      totalUploaded += p1.uploaded;
      totalSkipped += p1.skipped;

      // Pass 2: project asset subfolders + root *.json → {code}/private-assets/{folder}/
      log(`${DIM}Pass 2/2: private assets${RESET}`);
      const p2 = await uploadPrivateAssets(client, projectDir, project, opts);
      totalUploaded += p2.uploaded;
      totalSkipped += p2.skipped;

      // lastPublished only AFTER pass 2 (R9).
      writeLastPublished(projectDir, project);
    }
  } finally {
    if (stagingDir && existsSync(stagingDir)) {
      try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  await maybePurge(client, totalUploaded, opts);
  info('done', `${totalUploaded} uploaded, ${totalSkipped} unchanged`);
  info('url', `https://web.realvirtual.io/${project.code}/`);
}

//! Pass 2: uploads project asset subfolders (excluding build/system dirs) and
//! root-level *.json (except project.json) into {code}/private-assets/{folder}/.
// SOURCE: WebViewerToolbar.cs:1346 (skipDirs + private-assets) — keep in sync
async function uploadPrivateAssets(client, projectDir, project, opts) {
  const skipDirs = new Set(['models', 'plugins', 'scripts', 'node_modules', '.git']);
  const folderName = project.folderName ?? requireFolderName(projectDir);
  let uploaded = 0;
  let skipped = 0;

  for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name.toLowerCase())) continue;
      const remotePath = `${project.code}/private-assets/${folderName}/${entry.name}`;
      const r = await uploadDirectory(client, join(projectDir, entry.name), remotePath, opts);
      uploaded += r.uploaded;
      skipped += r.skipped;
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json') &&
               entry.name.toLowerCase() !== 'project.json') {
      const remotePath = `${project.code}/private-assets/${folderName}/${entry.name}`;
      log(`  ${GREEN}↑${RESET} ${entry.name} ${DIM}(asset)${RESET}`);
      if (!opts.dryRun) {
        await client.putFile(readFileSync(join(projectDir, entry.name)), remotePath);
      }
      uploaded++;
    }
  }
  return { uploaded, skipped };
}

function requireFolderName(projectDir) {
  return join(projectDir).split(/[\\/]/).filter(Boolean).pop();
}

function writeLastPublished(projectDir, project) {
  const jsonPath = join(projectDir, 'project.json');
  const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
  data.lastPublished = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  writeFileSync(jsonPath, JSON.stringify(data, null, 2));
}

function resolvePrivateProjectDir(projectsDir, projectName) {
  const all = discoverPrivateProjects(projectsDir);
  // Match by exact project name, then by sanitized folder name.
  const byName = all.find((p) => p.project.name === projectName);
  if (byName) return byName.projectDir;
  const sanitized = sanitizeDemoName(projectName);
  const byFolder = all.find((p) => p.folderName === sanitized || p.folderName === projectName);
  if (byFolder) return byFolder.projectDir;
  const direct = join(projectsDir, projectName);
  if (existsSync(join(direct, 'project.json'))) return direct;
  throw new Error(`Private project "${projectName}" not found under ${projectsDir}`);
}

function listPrivateProjects(projectsDir) {
  const all = discoverPrivateProjects(projectsDir);
  log('');
  log(`${MAGENTA}Private projects in ${projectsDir}${RESET}`);
  if (all.length === 0) {
    log(`  ${DIM}(none)${RESET}`);
    return;
  }
  for (const { project, folderName } of all) {
    const last = project.lastPublished ? project.lastPublished : 'never';
    log(`  ${folderName.padEnd(28)} ${DIM}code ${project.code.slice(0, 8)}…  published ${last}${RESET}`);
  }
}

// ─── GA injection + purge helpers ────────────────────────────────────────

//! Injects the GA4 id into a settings.json on disk (deployed artifact only).
//! Empty id → no-op (committed settings.json stays clean). R2 / O5.
function injectGaIntoSettings(settingsPath, gaId, dryRun) {
  if (!gaId) return;
  if (!existsSync(settingsPath)) return;
  if (dryRun) {
    log(`${DIM}[dry-run] would inject GA id into ${settingsPath}${RESET}`);
    return;
  }
  const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
  s.analytics = s.analytics || {};
  s.analytics.googleAnalyticsId = gaId;
  writeFileSync(settingsPath, JSON.stringify(s, null, 2));
  log(`${DIM}GA4 id injected into ${settingsPath}${RESET}`);
}

//! Purges the pull-zone cache once, but only if files were uploaded and purge
//! isn't suppressed (--no-purge). Mirrors C# (uploadedCount>0 + creds set).
async function maybePurge(client, uploadedCount, opts) {
  if (opts.noPurge) {
    info('purge', 'skipped (--no-purge)');
    return;
  }
  if (uploadedCount <= 0) {
    info('purge', 'skipped (nothing uploaded)');
    return;
  }
  const ok = await client.purge();
  info('purge', ok ? `${GREEN}✓${RESET}` : `${DIM}skipped${RESET}`);
}

// ─── main ────────────────────────────────────────────────────────────────

async function main() {
  loadDotEnv(); // populate process.env from .env.production / .env (CI env still wins)
  const opts = {
    private: hasFlag('private'),
    project: getArg('project', null),
    list: hasFlag('list'),
    path: getArg('path', null),
    dist: getArg('dist', join(ROOT, 'dist')),
    projectsDir: getArg('projects-dir', process.env.BUNNY_PRIVATE_PROJECTS_DIR || null),
    noBuild: hasFlag('no-build'),
    base: getArg('base', null),
    force: hasFlag('force'),
    dryRun: hasFlag('dry-run'),
    noPurge: hasFlag('no-purge'),
  };

  // --list does not need full credentials.
  if (opts.private && opts.list) {
    if (!opts.projectsDir) throw new Error('--list requires --projects-dir <dir>');
    listPrivateProjects(opts.projectsDir);
    return;
  }

  const cfg = loadConfig(process.env);

  if (opts.private) {
    await deployPrivate(cfg, opts);
  } else {
    await deployPublic(cfg, opts);
  }
}

main().catch((e) => {
  console.error(`${RED}Error:${RESET} ${e?.message ?? e}`);
  process.exit(1);
});
