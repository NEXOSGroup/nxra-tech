// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-published-scenes — catalogue of read-only "Example" scenes shipped with
 * the build under `public/scenes/*.scene.json`.
 *
 * Examples are curated demos (e.g. a planner layout). Unlike "My Scenes" they
 * are NOT stored in localStorage — opening one loads it transiently via
 * `SceneStore.openPublishedExample`, and "Add to My Scenes"
 * (`SceneStore.addPublishedToMyScenes`) materialises an editable copy the user
 * owns. Discovery prefers a curated `public/scenes/index.json`
 * (`[{ file, name, mode }]`) and falls back to a build-time glob of the folder.
 */

/** A single example scene available in the "Examples" section. */
export interface PublishedSceneEntry {
  /** Filename under `public/scenes/`, e.g. "DemoPlanner.scene.json". */
  file: string;
  /** Token used in `?scene=published:<urlName>` — `file` without ".scene.json". */
  urlName: string;
  /** Display label shown in the Examples list. */
  label: string;
  /** Preferred workspace mode to switch to on open (e.g. "planner"). Optional. */
  mode?: string;
}

/** Strip the `.scene.json` suffix to get the `?scene=published:<name>` token. */
export function urlNameFromFile(file: string): string {
  return file.replace(/\.scene\.json$/i, '');
}

/**
 * Build a catalogue entry from a bare filename (glob fallback path) — label
 * defaults to the url name, no preferred mode.
 */
export function publishedEntryFromFile(file: string): PublishedSceneEntry {
  const urlName = urlNameFromFile(file);
  return { file, urlName, label: urlName };
}

/**
 * Parse a curated `public/scenes/index.json` payload into catalogue entries.
 * Defensive: ignores non-array input and any item without a valid `file`
 * ending in `.scene.json`. `name` becomes the label (falls back to the url
 * name); `mode` is carried through only when it is a non-empty string.
 */
export function parsePublishedIndex(raw: unknown): PublishedSceneEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PublishedSceneEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const file = rec.file;
    if (typeof file !== 'string' || !/\.scene\.json$/i.test(file)) continue;
    const urlName = urlNameFromFile(file);
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    const mode = typeof rec.mode === 'string' && rec.mode.trim() ? rec.mode.trim() : undefined;
    out.push({ file, urlName, label: name || urlName, mode });
  }
  return out;
}
