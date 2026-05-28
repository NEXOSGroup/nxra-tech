// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-storage — localStorage CRUD for the unified Scene model.
 *
 * Keyspace:
 *   rv-scenes-index                  JSON: RvSceneMeta[] (sorted modifiedAt desc)
 *   rv-scenes/<id>                   JSON: RvScene
 *   rv-scenes/active                 JSON: { id: string }
 *   rv-scenes/draft/<baseKey>        JSON: RvScene  (per-base autosaved draft —
 *                                                    fresh built-in / empty
 *                                                    workspaces with no saved id)
 *   rv-scenes/scene-draft/<savedId>  JSON: RvScene  (per-saved-scene autosaved
 *                                                    draft — survives reload via
 *                                                    openScene; keyed by id so
 *                                                    multiple scenes built on
 *                                                    the same base don't collide)
 *
 * Pure CRUD — no React, no Three.js, no DOM. Imported by SceneStore and tests.
 */

import {
  type RvScene,
  type RvSceneMeta,
  type SceneBase,
  baseKeyOf,
  metaOf,
} from './rv-scene-types';

// ─── Storage keys ───────────────────────────────────────────────────────

const LS_KEY_INDEX = 'rv-scenes-index';
const LS_KEY_ACTIVE = 'rv-scenes/active';
const LS_KEY_SCENE_PREFIX = 'rv-scenes/';
const LS_KEY_DRAFT_PREFIX = 'rv-scenes/draft/';
const LS_KEY_SCENE_DRAFT_PREFIX = 'rv-scenes/scene-draft/';

function sceneKey(id: string): string {
  return LS_KEY_SCENE_PREFIX + id;
}

function draftKey(base: SceneBase): string {
  return LS_KEY_DRAFT_PREFIX + baseKeyOf(base);
}

function sceneDraftKey(id: string): string {
  return LS_KEY_SCENE_DRAFT_PREFIX + id;
}

// ─── Index ──────────────────────────────────────────────────────────────

export function listMetas(): RvSceneMeta[] {
  try {
    const raw = localStorage.getItem(LS_KEY_INDEX);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Sort defensively in case index was written out of order.
    return [...parsed].sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''));
  } catch {
    return [];
  }
}

function writeIndex(metas: RvSceneMeta[]): void {
  const sorted = [...metas].sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''));
  try {
    localStorage.setItem(LS_KEY_INDEX, JSON.stringify(sorted));
  } catch {
    // Quota — caller surfaces toast.
  }
}

function upsertMeta(meta: RvSceneMeta): void {
  const metas = listMetas();
  const i = metas.findIndex(m => m.id === meta.id);
  if (i >= 0) metas[i] = meta;
  else metas.push(meta);
  writeIndex(metas);
}

function removeMeta(id: string): void {
  const metas = listMetas().filter(m => m.id !== id);
  writeIndex(metas);
}

// ─── Scene CRUD ─────────────────────────────────────────────────────────

export function readScene(id: string): RvScene | null {
  try {
    const raw = localStorage.getItem(sceneKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RvScene;
    if (parsed?.schemaVersion !== 2) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist a scene. Updates `modifiedAt`, writes the blob, and refreshes the index.
 * @returns the persisted scene (with updated modifiedAt)
 */
export function writeScene(scene: RvScene): RvScene {
  const updated: RvScene = { ...scene, modifiedAt: new Date().toISOString() };
  try {
    localStorage.setItem(sceneKey(updated.id), JSON.stringify(updated));
    upsertMeta(metaOf(updated));
  } catch {
    // Quota — caller surfaces toast. Index left alone.
  }
  return updated;
}

export function deleteScene(id: string): void {
  try {
    localStorage.removeItem(sceneKey(id));
  } catch {
    /* ignore */
  }
  removeMeta(id);
  // If active was this scene, clear it.
  if (readActiveId() === id) writeActiveId(null);
}

// ─── Active scene ───────────────────────────────────────────────────────

export function readActiveId(): string | null {
  try {
    const raw = localStorage.getItem(LS_KEY_ACTIVE);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.id === 'string') return parsed.id;
    return null;
  } catch {
    return null;
  }
}

export function writeActiveId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEY_ACTIVE);
    else localStorage.setItem(LS_KEY_ACTIVE, JSON.stringify({ id }));
  } catch {
    /* ignore */
  }
}

// ─── Per-base draft slots ───────────────────────────────────────────────

export function readDraft(base: SceneBase): RvScene | null {
  try {
    const raw = localStorage.getItem(draftKey(base));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RvScene;
    if (parsed?.schemaVersion !== 2) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeDraft(base: SceneBase, scene: RvScene): void {
  try {
    localStorage.setItem(draftKey(base), JSON.stringify(scene));
  } catch {
    /* quota */
  }
}

export function clearDraft(base: SceneBase): void {
  try {
    localStorage.removeItem(draftKey(base));
  } catch {
    /* ignore */
  }
}

/** Enumerate all per-base draft keys currently in storage. Used by tests and the cleanup tool. */
export function listDraftBaseKeys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    // Per-base prefix is a strict prefix of the per-saved-scene prefix
    // (`rv-scenes/draft/` vs `rv-scenes/scene-draft/`). Filter the latter
    // out so the legacy enumerator keeps its semantics.
    if (k && k.startsWith(LS_KEY_DRAFT_PREFIX) && !k.startsWith(LS_KEY_SCENE_DRAFT_PREFIX)) {
      out.push(k.slice(LS_KEY_DRAFT_PREFIX.length));
    }
  }
  return out;
}

// ─── Per-saved-scene draft slots ────────────────────────────────────────
//
// Drafts for workspaces that have a saved scene (`SceneStore._saved != null`)
// are keyed by saved-scene id so they survive reload via `openScene(id)`
// and don't collide with the source built-in's own draft slot. Same shape
// as the per-base helpers above; just a different keyspace.

export function readSceneDraft(id: string): RvScene | null {
  try {
    const raw = localStorage.getItem(sceneDraftKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RvScene;
    if (parsed?.schemaVersion !== 2) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeSceneDraft(id: string, scene: RvScene): void {
  try {
    localStorage.setItem(sceneDraftKey(id), JSON.stringify(scene));
  } catch {
    /* quota */
  }
}

export function clearSceneDraft(id: string): void {
  try {
    localStorage.removeItem(sceneDraftKey(id));
  } catch {
    /* ignore */
  }
}

/** Enumerate all per-saved-scene draft ids currently in storage. */
export function listSceneDraftIds(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(LS_KEY_SCENE_DRAFT_PREFIX)) {
      out.push(k.slice(LS_KEY_SCENE_DRAFT_PREFIX.length));
    }
  }
  return out;
}

// ─── Bulk helpers ───────────────────────────────────────────────────────

/** Delete every key in the new scene namespace. Test/cleanup utility. */
export function clearAllScenes(): void {
  const metas = listMetas();
  for (const m of metas) {
    try { localStorage.removeItem(sceneKey(m.id)); } catch { /* ignore */ }
  }
  for (const baseKey of listDraftBaseKeys()) {
    try { localStorage.removeItem(LS_KEY_DRAFT_PREFIX + baseKey); } catch { /* ignore */ }
  }
  for (const id of listSceneDraftIds()) {
    try { localStorage.removeItem(LS_KEY_SCENE_DRAFT_PREFIX + id); } catch { /* ignore */ }
  }
  try { localStorage.removeItem(LS_KEY_INDEX); } catch { /* ignore */ }
  try { localStorage.removeItem(LS_KEY_ACTIVE); } catch { /* ignore */ }
}
