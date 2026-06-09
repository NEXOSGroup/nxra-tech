// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * glob-match — the dependency-free filename glob matcher used by behavior
 * discovery (`behaviors.ts`) and the material-flow registry (`registry.ts`).
 *
 * Extracted to its own module so neither consumer creates an import cycle.
 * `behaviors.ts` carries an eager `import.meta.glob('../behaviors/*.ts')` which
 * pulls in every behavior module — and those modules call `defineMaterialFlow`,
 * which imports `registry.ts`. If `registry.ts` imported the matcher FROM
 * `behaviors.ts`, that closed a circular dependency whose re-entry observed
 * `registry.ts`'s module-level state in the temporal dead zone (`Cannot access
 * '…' before initialization`). Both consumers now import the matcher from here;
 * `behaviors.ts` still re-exports it for backward compatibility.
 */

const _globCache = new Map<string, RegExp>();

export function compileGlob(pattern: string): RegExp {
  const cached = _globCache.get(pattern);
  if (cached) return cached;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const re = new RegExp(`^${escaped}$`);
  _globCache.set(pattern, re);
  return re;
}

export function matchesAny(patterns: string[], name: string): boolean {
  for (const p of patterns) {
    if (p === '*') return true;
    if (p === name) return true;
    if (p.includes('*') || p.includes('?')) {
      if (compileGlob(p).test(name)) return true;
    }
  }
  return false;
}

/** Extract the GLB filename (no extension, no directory, no query string) from a URL. */
export function extractGlbName(url: string | null | undefined): string {
  if (!url) return '';
  const noQuery = url.split('?')[0];
  const file = noQuery.substring(noQuery.lastIndexOf('/') + 1);
  return file.replace(/\.glb$/i, '');
}
