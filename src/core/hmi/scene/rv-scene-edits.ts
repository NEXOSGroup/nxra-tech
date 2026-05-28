// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-edits — Operation log for the unified Scene model.
 *
 * Edits to a Scene are stored as an ordered array of `EditOp` records.
 * Each op is immutable, carries its own inverse (`prev`), and can be replayed
 * deterministically on top of the base GLB to materialise the live state
 * (component overrides + planner placements + camera preset).
 *
 * This module is **pure** — no Three.js, no DOM, no localStorage, no plugin
 * references. It defines the op taxonomy and provides folding / coalescing /
 * description helpers that the SceneStore and tests share.
 *
 * The actual application of ops to the live scene lives in
 * `rv-scene-executors.ts`; the queue / transaction machinery lives in
 * `rv-scene-op-queue.ts`. Together they implement the command-pattern
 * undo/redo system documented in the plan.
 */

import type { RVExtrasOverlay } from '../../engine/rv-extras-overlay-store';
import type { PlacedComponent } from '../../../plugins/layout-planner/rv-layout-store';
import type { ModelCameraStart } from '../camera-startpos-types';

// ─── Edit operations ────────────────────────────────────────────────────

/** Common header fields on every edit op. */
interface EditOpBase {
  /** Stable id (`op_<base36-time>_<rand6>`) used for stack identity and coalescing. */
  id: string;
  /** Wall-clock timestamp at the moment the op was created. Display-only. */
  ts: number;
  /** Op-shape version. Bump + add a migrator when a kind's payload changes. */
  schemaV: 1;
  /** Optional: node path that should be selected after forward / before inverse. */
  selectionAfter?: string | null;
  selectionBefore?: string | null;
}

/** Set a single field on `userData.realvirtual[componentType][fieldName]`. */
export interface SetFieldOp extends EditOpBase {
  kind: 'setField';
  nodePath: string;
  componentType: string;
  fieldName: string;
  value: unknown;
  /** Original value (deep-cloned for objects/arrays). Used by inverse. */
  prev: unknown;
}

/** Remove a field — restores the GLB-default value via inverse `prev`. */
export interface UnsetFieldOp extends EditOpBase {
  kind: 'unsetField';
  nodePath: string;
  componentType: string;
  fieldName: string;
  /** Pre-removal value, restored on undo. */
  prev: unknown;
}

/** Add a planner placement (catalog-spawned object). */
export interface AddPlacementOp extends EditOpBase {
  kind: 'addPlacement';
  /** Full placement record. `placement.id` is the stable handle for the
   *  placement throughout subsequent transform / remove ops. */
  placement: PlacedComponent;
}

/** Remove a planner placement by id. Carries the full snapshot for undo. */
export interface RemovePlacementOp extends EditOpBase {
  kind: 'removePlacement';
  placementId: string;
  placement: PlacedComponent;
}

/** Move / rotate / scale a placement. */
export interface TransformPlacementOp extends EditOpBase {
  kind: 'transformPlacement';
  placementId: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  prev: {
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
  };
}

/** Set or clear the per-scene camera start preset. */
export interface SetCameraOp extends EditOpBase {
  kind: 'setCamera';
  preset: ModelCameraStart | null;
  prev: ModelCameraStart | null;
}

/** Composite (transaction) — multiple primitive ops as one undo unit. */
export interface CompositeOp extends EditOpBase {
  kind: 'composite';
  /** Human-readable label for the entire transaction. */
  label: string;
  /** Child ops, applied forward in order, undone in reverse. */
  ops: PrimitiveEditOp[];
}

/** Ops that may NOT appear inside a composite (composites can't nest). */
export type PrimitiveEditOp =
  | SetFieldOp
  | UnsetFieldOp
  | AddPlacementOp
  | RemovePlacementOp
  | TransformPlacementOp
  | SetCameraOp;

/** Top-level op type (anything that may appear in `_ops`). */
export type EditOp = PrimitiveEditOp | CompositeOp;

// ─── Container types ────────────────────────────────────────────────────

/** Workspace-level settings that aren't part of the undoable history. */
export interface SceneEditsSettings {
  catalogUrls: string[];
  gridSizeMm: number;
}

/** What `RvScene.edits` becomes (added in PR C; PR A only ships the type). */
export interface SceneEdits {
  ops: EditOp[];
  settings: SceneEditsSettings;
}

/** The shape `materialise()` produces — fed into `loadGLB` and `applyPlacements`. */
export interface MaterialisedEdits {
  overlay: RVExtrasOverlay;
  placements: PlacedComponent[];
  cameraStart: ModelCameraStart | null;
}

// ─── Constants ──────────────────────────────────────────────────────────

/** Max number of ops kept in the history. Older ops drop off the front. */
export const MAX_OP_HISTORY = 500;

/** Coalesce window — adjacent same-target ops within this window merge. */
export const COALESCE_WINDOW_MS = 500;

// ─── Identity ───────────────────────────────────────────────────────────

/** Generate a fresh op id. Stable across save/load — never regenerate. */
export function freshOpId(): string {
  return 'op_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ─── Materialise (replay ops onto an empty workspace) ───────────────────

/**
 * Fold an op array into the materialised edit state — the shape the existing
 * loader pipeline already consumes (overlay → loadGLB, placements → planner,
 * camera → camera-startpos plugin).
 *
 * Pure function: no mutations, no async, no side effects. The result is
 * fully derived from `ops` (and only `ops`); replaying the same array
 * produces a structurally-equal output every time — the determinism property
 * the plan relies on for save/load round-trips.
 *
 * Composite ops are flattened recursively in apply order. Removal ops cancel
 * their corresponding adds. Transform ops update the live position/rotation/scale.
 */
export function materialise(ops: ReadonlyArray<EditOp>): MaterialisedEdits {
  const overlay: RVExtrasOverlay = emptyOverlay();
  const placements = new Map<string, PlacedComponent>();
  let cameraStart: ModelCameraStart | null = null;

  for (const op of flattenOps(ops)) {
    applyForwardPure(op, overlay, placements, (next) => { cameraStart = next; });
  }

  return {
    overlay,
    placements: [...placements.values()],
    cameraStart,
  };
}

function flattenOps(ops: ReadonlyArray<EditOp>): PrimitiveEditOp[] {
  const out: PrimitiveEditOp[] = [];
  for (const op of ops) {
    if (op.kind === 'composite') out.push(...op.ops);
    else out.push(op);
  }
  return out;
}

/** Pure-data forward apply for a single primitive op against working buffers. */
function applyForwardPure(
  op: PrimitiveEditOp,
  overlay: RVExtrasOverlay,
  placements: Map<string, PlacedComponent>,
  setCamera: (next: ModelCameraStart | null) => void,
): void {
  switch (op.kind) {
    case 'setField': {
      ensureNode(overlay, op.nodePath);
      ensureComponent(overlay, op.nodePath, op.componentType);
      overlay.nodes[op.nodePath][op.componentType][op.fieldName] = op.value;
      return;
    }
    case 'unsetField': {
      const nodeOv = overlay.nodes[op.nodePath];
      const compOv = nodeOv?.[op.componentType];
      if (!compOv) return;
      delete compOv[op.fieldName];
      if (Object.keys(compOv).length === 0) delete nodeOv[op.componentType];
      if (Object.keys(nodeOv).length === 0) delete overlay.nodes[op.nodePath];
      return;
    }
    case 'addPlacement': {
      placements.set(op.placement.id, deepCloneJSON(op.placement));
      return;
    }
    case 'removePlacement': {
      placements.delete(op.placementId);
      return;
    }
    case 'transformPlacement': {
      const p = placements.get(op.placementId);
      if (!p) return; // tolerate — base GLB may have changed
      placements.set(op.placementId, {
        ...p,
        position: [...op.position] as [number, number, number],
        rotation: [...op.rotation] as [number, number, number],
        scale: [...op.scale] as [number, number, number],
      });
      return;
    }
    case 'setCamera': {
      setCamera(op.preset ? { ...op.preset } : null);
      return;
    }
  }
}

function emptyOverlay(): RVExtrasOverlay {
  return { $schema: 'rv-extras-overlay/1.0', $source: 'edits', nodes: {} };
}

function ensureNode(overlay: RVExtrasOverlay, nodePath: string): void {
  if (!overlay.nodes[nodePath]) overlay.nodes[nodePath] = {};
}

function ensureComponent(overlay: RVExtrasOverlay, nodePath: string, componentType: string): void {
  if (!overlay.nodes[nodePath][componentType]) overlay.nodes[nodePath][componentType] = {};
}

// ─── Coalescing ─────────────────────────────────────────────────────────

/**
 * Decide whether two adjacent ops should merge into a single history entry.
 * Coalescing keeps the history tight when the user types into a field or
 * drags an object — without losing the original `prev` (so a single undo
 * still reverts the full sequence).
 *
 * Rules: same kind, same target, within COALESCE_WINDOW_MS, primitive only.
 */
export function canCoalesce(last: EditOp, next: EditOp): boolean {
  if (last.kind !== next.kind) return false;
  if (last.kind === 'composite' || next.kind === 'composite') return false;
  if (next.ts - last.ts > COALESCE_WINDOW_MS) return false;
  if (next.ts < last.ts) return false; // clock went backwards — don't coalesce
  switch (next.kind) {
    case 'setField': {
      const a = last as SetFieldOp;
      return a.nodePath === next.nodePath
        && a.componentType === next.componentType
        && a.fieldName === next.fieldName;
    }
    case 'unsetField': {
      // Unset is idempotent — coalesce identical targets.
      const a = last as UnsetFieldOp;
      return a.nodePath === next.nodePath
        && a.componentType === next.componentType
        && a.fieldName === next.fieldName;
    }
    case 'transformPlacement': {
      const a = last as TransformPlacementOp;
      return a.placementId === next.placementId;
    }
    case 'setCamera': {
      // Camera coalesces unconditionally on consecutive saves.
      return true;
    }
    case 'addPlacement':
    case 'removePlacement':
      return false; // never coalesce add/remove — discrete user actions
  }
}

/**
 * Merge `next` into `last`. Caller has verified `canCoalesce(last, next)`.
 * The merged op keeps `last.id`, `last.prev`, and `last.ts`; takes `next`'s
 * forward payload (value / position / preset). Net effect: a single undo
 * after the merge reverts to the state BEFORE the first op in the run.
 */
export function mergeOps(last: EditOp, next: EditOp): EditOp {
  if (last.kind !== next.kind || last.kind === 'composite' || next.kind === 'composite') {
    throw new Error('mergeOps: precondition violated — call canCoalesce first');
  }
  switch (next.kind) {
    case 'setField': {
      const a = last as SetFieldOp;
      return { ...a, value: (next as SetFieldOp).value };
    }
    case 'unsetField': {
      // Identical target → result is the same op.
      return last;
    }
    case 'transformPlacement': {
      const a = last as TransformPlacementOp;
      const n = next as TransformPlacementOp;
      return { ...a, position: n.position, rotation: n.rotation, scale: n.scale };
    }
    case 'setCamera': {
      const a = last as SetCameraOp;
      return { ...a, preset: (next as SetCameraOp).preset };
    }
    case 'addPlacement':
    case 'removePlacement':
      throw new Error('mergeOps: should not be called for add/removePlacement');
  }
}

// ─── Description (for tooltips / history UI) ────────────────────────────

/**
 * Produce a short human-readable label for a tooltip or history entry.
 * Pure function — fully testable. Localisation-friendly: English only for now;
 * future i18n can replace this single function.
 */
export function describeOp(op: EditOp): string {
  switch (op.kind) {
    case 'setField':
      return `Set ${op.componentType}.${op.fieldName} = ${formatValue(op.value)} on ${nodeLeaf(op.nodePath)}`;
    case 'unsetField':
      return `Reset ${op.componentType}.${op.fieldName} on ${nodeLeaf(op.nodePath)}`;
    case 'addPlacement':
      return `Add ${op.placement.label}`;
    case 'removePlacement':
      return `Remove ${op.placement.label}`;
    case 'transformPlacement':
      return `Move ${shortPlacementLabel(op)}`;
    case 'setCamera':
      return op.preset ? 'Set camera view' : 'Clear camera view';
    case 'composite':
      return op.label;
  }
}

function nodeLeaf(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function shortPlacementLabel(op: TransformPlacementOp): string {
  // We only have the placement id here. The id is opaque (e.g. plc_abc123)
  // so we surface it shortened. Real label comes from a placements lookup
  // — caller can provide a richer description by composing on top.
  return op.placementId.length > 12 ? op.placementId.slice(0, 12) + '…' : op.placementId;
}

function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'number') {
    return Number.isInteger(v) ? v.toString() : v.toFixed(3).replace(/\.?0+$/, '');
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v.length > 20 ? `"${v.slice(0, 20)}…"` : `"${v}"`;
  if (Array.isArray(v)) return `[${v.length}]`;
  return '{…}';
}

// ─── Inverse helpers (used by executors and tests) ──────────────────────

/**
 * Compute the inverse op for a primitive forward op. The inverse is the
 * single op that, when applied forward, restores the state that existed
 * BEFORE the original op. Composite inverse = reverse the children and
 * invert each.
 *
 * Note: the executor doesn't necessarily call this — it applies the inverse
 * directly via the `prev` field of the original op. This helper is exposed
 * for tests and for any future code that wants an "inverse op" record.
 */
export function inverseOp(op: EditOp): EditOp {
  switch (op.kind) {
    case 'setField': {
      // Inverse: setField with prev value (or unsetField if prev was undefined)
      if (op.prev === undefined) {
        return {
          id: freshOpId(), ts: Date.now(), schemaV: 1,
          kind: 'unsetField',
          nodePath: op.nodePath, componentType: op.componentType, fieldName: op.fieldName,
          prev: op.value,
        };
      }
      return {
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'setField',
        nodePath: op.nodePath, componentType: op.componentType, fieldName: op.fieldName,
        value: op.prev, prev: op.value,
      };
    }
    case 'unsetField': {
      return {
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'setField',
        nodePath: op.nodePath, componentType: op.componentType, fieldName: op.fieldName,
        value: op.prev, prev: undefined,
      };
    }
    case 'addPlacement': {
      return {
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'removePlacement',
        placementId: op.placement.id, placement: op.placement,
      };
    }
    case 'removePlacement': {
      return {
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'addPlacement', placement: op.placement,
      };
    }
    case 'transformPlacement': {
      return {
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'transformPlacement',
        placementId: op.placementId,
        position: op.prev.position, rotation: op.prev.rotation, scale: op.prev.scale,
        prev: { position: op.position, rotation: op.rotation, scale: op.scale },
      };
    }
    case 'setCamera': {
      return {
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'setCamera',
        preset: op.prev, prev: op.preset,
      };
    }
    case 'composite': {
      const reversed: PrimitiveEditOp[] = [];
      for (let i = op.ops.length - 1; i >= 0; i--) {
        const inv = inverseOp(op.ops[i]);
        if (inv.kind === 'composite') {
          // Defensive — composites don't nest. Flatten.
          reversed.push(...inv.ops);
        } else {
          reversed.push(inv);
        }
      }
      return {
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'composite', label: `Undo: ${op.label}`, ops: reversed,
      };
    }
  }
}

// ─── Equality (for dirty + tests) ───────────────────────────────────────

/** Compare two op arrays by id sequence. Op records are immutable — id
 *  equality implies content equality. */
export function opsEqual(a: ReadonlyArray<EditOp>, b: ReadonlyArray<EditOp>): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false;
  return true;
}

// ─── Misc helpers ───────────────────────────────────────────────────────

/** Cheap deep-clone for JSON-safe values. Used to snapshot `prev` for
 *  object/array overlay values so later mutations of the live data don't
 *  retroactively change the stored inverse. */
export function deepCloneJSON<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
