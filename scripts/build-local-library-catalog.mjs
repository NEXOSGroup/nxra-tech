// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * build-local-library-catalog.mjs — Generate the bundled-library manifest.
 *
 * Scans `public/models/library/` for `.glb` files and writes a
 * `public/models/library/catalog.json` the planner loads via
 * `loadBundledLibrary` (planner-persistence.ts). This is the STANDARD library
 * shipped with every publish; GitHub is NOT a default source.
 *
 * Without this catalog the planner falls back to a flat glob scan where every
 * asset lands in the "custom" category with a filename-derived label. The
 * catalog instead derives:
 *   - category  = the first sub-folder, humanized (e.g. `PalletHandling`
 *                 -> "Pallet Handling"). Keep sub-folders CamelCase for nice
 *                 display; an all-lowercase folder can't be word-split.
 *   - name      = the file stem, humanized (e.g. `RollConveyor-2m`
 *                 -> "Roll Conveyor 2m").
 *   - glbUrl    = path relative to `models/library/` (resolved at load time).
 * Thumbnails are rendered at runtime by the planner, so none are emitted here.
 *
 * Run: `node scripts/build-local-library-catalog.mjs`
 */

import { readdir, writeFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LIBRARY_DIR = join(ROOT, 'public', 'models', 'library');
const OUTPUT = join(LIBRARY_DIR, 'catalog.json');

/** Insert spaces at camelCase / acronym boundaries and on `-`/`_`, then title-trim. */
function humanize(s) {
  return s
    .replace(/[_-]+/g, ' ')                     // separators -> space
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')     // camelCase -> "camel Case"
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')  // acronym boundary: ABCFoo -> ABC Foo
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable, URL-safe id from a path-ish string. */
function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Recursively collect all `.glb` files under `dir`, returned as paths relative to LIBRARY_DIR. */
async function collectGlbs(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await collectGlbs(full));
    } else if (entry.isFile() && /\.glb$/i.test(entry.name)) {
      out.push(relative(LIBRARY_DIR, full));
    }
  }
  return out;
}

async function main() {
  try {
    await stat(LIBRARY_DIR);
  } catch {
    // No bundled library in this checkout (e.g. a public fork) — skip gracefully
    // so `npm run build` (which runs this as prebuild) still succeeds. The planner
    // then has no standard catalog; that's fine.
    console.warn(`[build-local-library-catalog] no library dir (${relative(ROOT, LIBRARY_DIR)}) — skipping catalog.`);
    process.exit(0);
  }

  const relPaths = (await collectGlbs(LIBRARY_DIR)).sort();
  const entries = relPaths.map((rel) => {
    const parts = rel.split(sep);
    const file = parts[parts.length - 1];
    const folder = parts.length > 1 ? parts[0] : 'General';
    const stem = file.replace(/\.glb$/i, '');
    const glbUrl = parts.join('/'); // POSIX-style URL relative to models/library/
    return {
      id: slug(rel.replace(/\.glb$/i, '')),
      name: humanize(stem),
      category: humanize(folder),
      glbUrl,
    };
  });

  // Stable order: by category, then name.
  entries.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  const catalog = { version: '1.0', name: 'realvirtual Library', entries };
  await writeFile(OUTPUT, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

  const byCat = entries.reduce((m, e) => ((m[e.category] = (m[e.category] || 0) + 1), m), {});
  console.log(`[build-local-library-catalog] wrote ${entries.length} entries -> ${relative(ROOT, OUTPUT)}`);
  for (const [cat, n] of Object.entries(byCat).sort()) console.log(`  ${cat}: ${n}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
