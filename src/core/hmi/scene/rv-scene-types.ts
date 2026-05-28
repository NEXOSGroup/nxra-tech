// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-types — Unified Scene model for the WebViewer Model Window.
 *
 * A Scene composes a base GLB with optional edit layers:
 *   - rv-extras overlay (component property patches)
 *   - planner placements (PlacedComponent[])
 *   - camera start preset
 *
 * Replaces the prior split between "GLB Scenes", "Layouts", and the hidden
 * `rv-extras-overlay:*` keyspace. See plan: unified scene model.
 */

import type { SceneEdits } from './rv-scene-edits';
import { opsEqual } from './rv-scene-edits';

// ─── Base ───────────────────────────────────────────────────────────────

/** Foundation a scene is built on. */
export type SceneBase =
  | { kind: 'empty' }
  | { kind: 'builtin'; url: string; label: string };
// 'imported' (user-uploaded GLB) reserved for future.

/** Stable storage key derived from a SceneBase, safe for use in localStorage paths. */
export function baseKeyOf(base: SceneBase): string {
  if (base.kind === 'empty') return 'empty';
  return 'builtin:' + encodeURIComponent(base.url);
}

/** Human-readable label for a base (used in "from <label>" subtext). */
export function baseLabelOf(base: SceneBase): string {
  return base.kind === 'empty' ? '(empty)' : base.label;
}

// ─── Scene record ───────────────────────────────────────────────────────

/**
 * Full scene record — base + edits + metadata. Stored at `rv-scenes/<id>`.
 *
 * `schemaVersion: 2` introduced the unified `edits` field (operation log +
 * workspace settings). Pre-existing v1 records (with `overlay`/`placements`
 * fields directly on the RvScene) are filtered out by storage on read; the
 * legacy keys are mopped up by Settings → "Clear legacy WebViewer data".
 */
export interface RvScene {
  id: string;                       // 'scn_<base36-time>_<rand>'
  name: string;
  createdAt: string;                // ISO 8601
  modifiedAt: string;               // ISO 8601
  schemaVersion: 2;

  base: SceneBase;
  edits: SceneEdits;                // ops log + workspace settings

  thumbnailDataUrl?: string;        // base64 PNG, generated lazily on save
  parentId?: string;                // scene this was duplicated from
  description?: string;
}

/** Lightweight scene index entry — kept in `rv-scenes-index` for fast list rendering. */
export interface RvSceneMeta {
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  baseKind: SceneBase['kind'];
  baseLabel: string;
  parentId?: string;
}

/** In-memory active workspace: the saved snapshot + the live draft. */
export interface RvSceneSession {
  saved: RvScene | null;            // last-saved snapshot; null for never-saved drafts
  draft: RvScene;                   // mutated by editors via SceneStore subscriptions
  isDraft: boolean;                 // true => no saved.id yet
  dirty: boolean;                   // structural diff between saved and draft
}

/** Built-in scene catalogue entry, mirrored from `viewer.availableModels`. */
export interface BuiltinSceneEntry {
  url: string;
  label: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Generate a new scene id. Short, sortable, unique enough for client-side identifiers. */
export function newSceneId(): string {
  return 'scn_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/** Produce a meta record from a full scene. */
export function metaOf(scene: RvScene): RvSceneMeta {
  return {
    id: scene.id,
    name: scene.name,
    createdAt: scene.createdAt,
    modifiedAt: scene.modifiedAt,
    baseKind: scene.base.kind,
    baseLabel: baseLabelOf(scene.base),
    parentId: scene.parentId,
  };
}

/** Construct an empty draft on top of a base. Caller assigns a final id on save. */
export function makeDraftScene(base: SceneBase, name: string = 'Untitled'): RvScene {
  const now = new Date().toISOString();
  return {
    id: 'draft',
    name,
    createdAt: now,
    modifiedAt: now,
    schemaVersion: 2,
    base,
    edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
  };
}

/**
 * Structural equality between two scenes for dirty detection.
 * Compares identity + base + ops sequence + workspace settings. Ignores
 * `modifiedAt` (advances on every save) and `thumbnailDataUrl` (regenerated
 * lazily). Op sequence equality uses op-id comparison via {@link opsEqual} —
 * EditOp records are immutable.
 */
export function scenesEqual(a: RvScene | null, b: RvScene | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.id !== b.id) return false;
  if (a.name !== b.name) return false;
  if (a.parentId !== b.parentId) return false;
  if (a.description !== b.description) return false;
  if (!sceneBaseEqual(a.base, b.base)) return false;
  if (!opsEqual(a.edits.ops, b.edits.ops)) return false;
  if (canonicalize(a.edits.settings) !== canonicalize(b.edits.settings)) return false;
  return true;
}

function sceneBaseEqual(a: SceneBase, b: SceneBase): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'empty' && b.kind === 'empty') return true;
  if (a.kind === 'builtin' && b.kind === 'builtin') return a.url === b.url && a.label === b.label;
  return false;
}

/** Stable JSON stringify with sorted keys, used only for equality comparison. */
function canonicalize(value: unknown): string {
  if (value === undefined) return '';
  return JSON.stringify(value, sortReplacer);
}

function sortReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}
