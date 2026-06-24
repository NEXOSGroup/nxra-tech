// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * scene-store — Op-based source of truth for the unified Scene model.
 *
 * Holds:
 *   - the workspace shell (id, name, base, createdAt) of the currently open scene
 *   - workspace settings (catalogUrls, gridSizeMm)
 *   - the operation log `_ops` — the canonical edit state
 *   - the baseline `_baselineOps` (ops at the moment of last load/save) for
 *     dirty detection and undo floor
 *   - the redo stack
 *   - flags for in-flight loads / op apply
 *
 * Editors push ops via `applyOp` (or `beginTransaction` / `endTransaction`
 * for grouped edits). The store applies them through the executors, queues
 * concurrent calls, autosaves the draft, and notifies React via
 * useSyncExternalStore.
 *
 * A few thin backward-compat shims (loadScene, createNewLayout,
 * exportLayoutJSON) remain for callers still on the old API.
 */

import type { RVViewer } from '../../rv-viewer';
import type {
  RvScene, RvSceneMeta, SceneBase, BuiltinSceneEntry,
} from './rv-scene-types';
import {
  baseLabelOf, metaOf, newSceneId, makeDraftScene, scenesEqual,
} from './rv-scene-types';
import {
  type EditOp, type PrimitiveEditOp, type SceneEditsSettings,
  MAX_OP_HISTORY, COALESCE_WINDOW_MS,
  freshOpId, canCoalesce, mergeOps, describeOp, opsEqual,
} from './rv-scene-edits';
import {
  listMetas, readScene, writeScene, deleteScene,
  readActiveId, writeActiveId, readDraft, writeDraft, clearDraft,
  readSceneDraft, writeSceneDraft, clearSceneDraft,
} from './rv-scene-storage';
import { applyForward, applyInverse } from './rv-scene-executors';
import { showInfoOverlay, hideInfoOverlay } from '../info-overlay-store';

// ─── Legacy compat type (used by the `loadScene` shim) ──────────────────

/** @deprecated Source descriptor for the legacy `loadScene` shim. */
export type SceneSource =
  | { kind: 'glb'; url: string; label: string }
  | { kind: 'layout'; id: string; name: string; modifiedAt: string };

// ─── Snapshot ───────────────────────────────────────────────────────────

export interface SceneSnapshot {
  saved: RvScene | null;
  /** Always-present derived view of the current workspace. Includes the
   *  current op log; structurally compared against `saved` for dirty. */
  draft: RvScene | null;
  isDraft: boolean;
  dirty: boolean;
  scenes: RvSceneMeta[];
  builtins: BuiltinSceneEntry[];
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Tooltip text "Undo: <action>" / "Redo: <action>"; null when disabled. */
  undoLabel: string | null;
  redoLabel: string | null;
}

// ─── Internal state ─────────────────────────────────────────────────────

interface WorkspaceShell {
  id: string;            // 'draft' for unsaved drafts; final id after save
  name: string;
  base: SceneBase;
  createdAt: string;
  parentId?: string;
  description?: string;
}

const DRAFT_AUTOSAVE_DEBOUNCE_MS = 2000;
const DEFAULT_SETTINGS: SceneEditsSettings = { catalogUrls: [], gridSizeMm: 500 };

export interface TransactionToken { readonly _depth: number }

// ─── Store ──────────────────────────────────────────────────────────────

export class SceneStore {
  private readonly _viewer: RVViewer;

  // Workspace
  private _workspace: WorkspaceShell | null = null;
  private _settings: SceneEditsSettings = { ...DEFAULT_SETTINGS };
  private _baselineOps: EditOp[] = [];
  private _ops: EditOp[] = [];
  private _redoStack: EditOp[] = [];
  private _saved: RvScene | null = null;

  // Catalogue
  private _builtins: BuiltinSceneEntry[] = [];
  private _scenes: RvSceneMeta[] = [];

  // UI state flags
  private _busy = false;
  private _loading = false;

  // Async serialisation
  private _opQueue: Promise<void> = Promise.resolve();

  // Transaction buffer (op accumulator)
  private _txnDepth = 0;
  private _txnLabel = '';
  private _txnBuffer: PrimitiveEditOp[] = [];

  // Debounced draft autosave timer
  private _draftAutosaveTimer: number | null = null;

  // React subscribers
  private _listeners = new Set<() => void>();
  private _snapshot: SceneSnapshot;

  constructor(viewer: RVViewer) {
    this._viewer = viewer;
    this._refreshBuiltins();
    this._refreshScenes();
    this._snapshot = this._buildSnapshot();
  }

  // ─── React useSyncExternalStore API ─────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  getSnapshot = (): SceneSnapshot => this._snapshot;

  // ─── External notifications ─────────────────────────────────────────

  refreshGlbList(): void {
    this._refreshBuiltins();
    this._notify();
  }

  /**
   * Boot path: a GLB was loaded directly via loadModelWithProgress (e.g.
   * `?model=` URL) without going through SceneStore. Synthesise a fresh
   * draft on top of that base so the Scene panel highlights the right row.
   *
   * No-op while an `openScene` / `openBuiltin` / `newEmpty` is in flight —
   * those paths already set up the workspace correctly *before* awaiting
   * `viewer.loadScene`, and the inner `loadModelWithProgress` call would
   * otherwise stomp it. In particular for `newEmpty`, the synthesized empty
   * GLB is a `blob:` URL with a random UUID — markGlbActive would clobber
   * the workspace name with that UUID. (`?model=`/`?scene=builtin:` URL
   * routing also reaches loadModel, but at that point `_loading` is true
   * for the whole openBuiltin call.)
   */
  markGlbActive(url: string, label: string): void {
    if (this._loading) return;
    const base: SceneBase = { kind: 'builtin', url, label };
    if (this._workspace?.base.kind === 'builtin' && this._workspace.base.url === url) return;
    this._cancelAutosave();
    this._workspace = freshShell(base, label);
    this._settings = { ...DEFAULT_SETTINGS };
    this._baselineOps = [];
    this._ops = [];
    this._redoStack = [];
    this._saved = null;
    this._viewer.currentScene = this._buildDraft();
    writeActiveId(null);
    this._notify();
  }

  // ─── Catalogue ──────────────────────────────────────────────────────

  listScenes(): RvSceneMeta[] { return this._scenes; }
  listBuiltins(): BuiltinSceneEntry[] { return this._builtins; }

  // ─── Workspace lifecycle ────────────────────────────────────────────

  /** Open a saved scene by id. */
  async openScene(id: string): Promise<void> {
    const scene = readScene(id);
    if (!scene) throw new Error(`Scene ${id} not found`);
    // Restore any in-progress draft for this saved scene on top of the
    // persisted baseline. The draft lives in `rv-scenes/scene-draft/<id>`,
    // separate from the per-base keyspace, so it can't be wiped by a
    // sibling built-in `openBuiltin(base)` clearing the base draft slot.
    // If no draft exists, fall back to the saved scene as-is.
    const draft = readSceneDraft(id);
    const sceneToLoad = draft ?? scene;
    await this._loadIntoWorkspace(sceneToLoad, scene);
    // Reflect the choice in the URL so a browser reload re-opens the same
    // saved scene. Without this, `?scene=` stays empty and reload falls
    // through to the legacy default-model boot path (which then clears the
    // active-id pointer via markGlbActive — see scene-store.ts).
    updateUrlSceneParam(scene.id);
  }

  /** Open a built-in. Auto-resumes the per-base draft if one was autosaved. */
  async openBuiltin(url: string, label: string): Promise<void> {
    const base: SceneBase = { kind: 'builtin', url, label };
    const restored = readDraft(base);
    const scene = restored ?? makeDraftScene(base, label);
    await this._loadIntoWorkspace(scene, null);
    updateUrlSceneParam(urlValueForBase(base));
  }

  /**
   * Open a "published" scene transiently — a read-only RvScene fetched from a
   * static asset (e.g. `public/scenes/<name>.scene.json`) and routed via
   * `?scene=published:<name>`. Unlike a saved scene it is NOT written to
   * localStorage, so a shared public link has no side effects on the visitor's
   * stored scenes. `name` is only used to keep the URL stable across reloads.
   */
  async openPublished(scene: RvScene, name: string): Promise<void> {
    if (!scene || scene.schemaVersion !== 2 || !scene.base || !scene.edits) {
      throw new Error('Invalid published scene JSON (missing schemaVersion 2 / base / edits)');
    }
    await this._loadIntoWorkspace(scene, null);
    updateUrlSceneParam(`published:${name}`);
  }

  /**
   * Create a fresh empty scene. Always discards any prior autosaved empty
   * draft and always names the new scene "Untitled" — this is the explicit
   * "New empty scene" gesture from the user (e.g. the SceneWindow button)
   * and from `discard()` for an unsaved empty workspace.
   *
   * For the boot path (reload after editing an Untitled scene) use
   * `openEmpty()` instead — that one resumes the autosaved per-base draft.
   */
  async newEmpty(): Promise<void> {
    const base: SceneBase = { kind: 'empty' };
    clearDraft(base);
    const scene = makeDraftScene(base, 'Untitled');
    await this._loadIntoWorkspace(scene, null);
    updateUrlSceneParam('empty');
  }

  /**
   * Open an empty scene, **resuming** the autosaved per-base empty draft if
   * one exists. Used by the boot path (`?scene=empty`) so a reload preserves
   * edits the user has made on an "Untitled" empty workspace — the same
   * resume semantics `openBuiltin()` provides for built-in bases.
   *
   * Compare to `newEmpty()`, which always discards the prior draft and
   * starts fresh.
   */
  async openEmpty(): Promise<void> {
    const base: SceneBase = { kind: 'empty' };
    const restored = readDraft(base);
    const scene = restored ?? makeDraftScene(base, 'Untitled');
    await this._loadIntoWorkspace(scene, null);
    updateUrlSceneParam('empty');
  }

  /** Duplicate a saved scene as a fresh draft. */
  async forkFromBase(baseId: string): Promise<void> {
    const src = readScene(baseId);
    if (!src) throw new Error(`Scene ${baseId} not found`);
    const fork: RvScene = {
      ...src,
      id: 'draft',
      name: `${src.name} (copy)`,
      parentId: src.id,
    };
    return this._loadIntoWorkspace(fork, null);
  }

  /**
   * Internal: cancel any pending autosave, set state, await viewer.loadScene,
   * then snapshot the baseline. Used by all four open* entry points.
   */
  private async _loadIntoWorkspace(scene: RvScene, saved: RvScene | null): Promise<void> {
    this._cancelAutosave();
    this._loading = true;
    this._busy = true;
    this._workspace = workspaceShellOf(scene);
    this._settings = { ...scene.edits.settings };
    // Baseline = the scene's clean (last-persisted) state. Dirty is computed
    // as `!opsEqual(_baselineOps, _ops)`.
    //   • Saved scene  → baseline = the saved scene's ops; identical to
    //                    current on open, so dirty=false until the user
    //                    edits.
    //   • Built-in / fork / restored draft (saved=null) → baseline = empty
    //                    (the unmodified base GLB). On a fresh open, ops=[]
    //                    so dirty=false. On a draft RESTORE the draft's
    //                    ops are non-empty, so dirty=true correctly — the
    //                    UI surfaces "Unsaved" immediately on reload until
    //                    the user explicitly saves or discards.
    this._baselineOps = saved ? saved.edits.ops : [];
    this._ops = [...scene.edits.ops];
    this._redoStack = [];
    this._saved = saved;
    this._notify();
    // Surface a centered loading overlay during scene/GLB swaps. The base
    // GLB parse + scene rebuild blocks the main thread for a few seconds
    // on larger models; without this hint the UI looks frozen. The
    // overlay is `pointerEvents:none` so it doesn't block any background
    // interactions that happen to remain responsive.
    const sceneLabel = scene.name || baseLabelOf(scene.base) || 'scene';
    showInfoOverlay(`Loading ${sceneLabel}…`);
    try {
      await this._viewer.loadScene(scene);
      writeActiveId(saved?.id ?? null);
    } finally {
      this._loading = false;
      this._busy = false;
      hideInfoOverlay();
      this._notify();
    }
  }

  // ─── Persistence ────────────────────────────────────────────────────

  /** Save the current draft (creates a new id on first save, else overwrites). */
  async save(): Promise<void> {
    if (!this._workspace) return;
    const isFirstSave = this._workspace.id === 'draft';
    const id = isFirstSave ? newSceneId() : this._workspace.id;
    const now = new Date().toISOString();
    const scene: RvScene = {
      id,
      name: this._workspace.name,
      base: this._workspace.base,
      createdAt: this._workspace.createdAt,
      modifiedAt: now,
      schemaVersion: 2,
      parentId: this._workspace.parentId,
      description: this._workspace.description,
      edits: { ops: [...this._ops], settings: { ...this._settings } },
    };
    const persisted = writeScene(scene);
    this._workspace = workspaceShellOf(persisted);
    this._saved = persisted;
    this._baselineOps = persisted.edits.ops;
    // _ops stays as-is (now matches baseline)
    writeActiveId(persisted.id);
    // Clear both draft slots: the per-base slot (legacy / pre-fix path that
    // accumulated edits before the workspace had a saved id) AND the new
    // per-saved-scene slot (defensive — clean baseline post-save).
    clearDraft(persisted.base);
    clearSceneDraft(persisted.id);
    this._refreshScenes();
    this._viewer.currentScene = persisted;
    updateUrlSceneParam(persisted.id);
    this._notify();
  }

  /** Save under a new name — always creates a new id. */
  async saveAs(name: string): Promise<string> {
    if (!this._workspace) throw new Error('Nothing to save');
    const id = newSceneId();
    const now = new Date().toISOString();
    const scene: RvScene = {
      id,
      name,
      base: this._workspace.base,
      createdAt: now,
      modifiedAt: now,
      schemaVersion: 2,
      parentId: this._saved?.id,
      description: this._workspace.description,
      edits: { ops: [...this._ops], settings: { ...this._settings } },
    };
    const persisted = writeScene(scene);
    this._workspace = workspaceShellOf(persisted);
    this._saved = persisted;
    this._baselineOps = persisted.edits.ops;
    writeActiveId(persisted.id);
    // See save() above for the dual-slot rationale.
    clearDraft(persisted.base);
    clearSceneDraft(persisted.id);
    this._refreshScenes();
    this._viewer.currentScene = persisted;
    updateUrlSceneParam(persisted.id);
    this._notify();
    return persisted.id;
  }

  /** Revert to the last-saved state (or to bare base for fresh drafts). */
  async discard(): Promise<void> {
    if (this._saved) {
      // Clear the per-saved-scene draft slot BEFORE re-opening — without
      // this, openScene would just restore the same draft we're trying to
      // throw away.
      clearSceneDraft(this._saved.id);
      await this.openScene(this._saved.id);
    } else if (this._workspace) {
      const base = this._workspace.base;
      clearDraft(base);
      if (base.kind === 'builtin') await this.openBuiltin(base.url, base.label);
      else await this.newEmpty();
    }
  }

  rename(id: string, name: string): void {
    const s = readScene(id);
    if (!s) return;
    const updated = writeScene({ ...s, name });
    if (this._saved?.id === id) {
      this._saved = updated;
      if (this._workspace?.id === id) this._workspace = { ...this._workspace, name };
      this._viewer.currentScene = updated;
    }
    this._refreshScenes();
    this._notify();
  }

  duplicate(id: string): string {
    const src = readScene(id);
    if (!src) throw new Error(`Scene ${id} not found`);
    const now = new Date().toISOString();
    const dup: RvScene = {
      ...src,
      id: newSceneId(),
      name: `${src.name} (copy)`,
      createdAt: now,
      modifiedAt: now,
      parentId: src.id,
    };
    writeScene(dup);
    this._refreshScenes();
    this._notify();
    return dup.id;
  }

  async delete(id: string): Promise<void> {
    const wasActive = this._saved?.id === id;
    deleteScene(id);
    // Clean up any orphaned draft for this saved scene — otherwise
    // re-creating a scene with the same id (extremely unlikely but
    // possible via JSON import) would inherit a stale draft.
    clearSceneDraft(id);
    this._refreshScenes();
    if (wasActive) {
      this._workspace = null;
      this._saved = null;
      this._ops = [];
      this._baselineOps = [];
      this._redoStack = [];
      this._viewer.currentScene = null;
      const fb = this._builtins[0];
      if (fb) await this.openBuiltin(fb.url, fb.label);
      else await this._viewer.loadEmptyScene();
    }
    this._notify();
  }

  // ─── JSON import / export ───────────────────────────────────────────

  exportSceneJSON(id: string): void {
    const scene = readScene(id);
    if (!scene) return;
    const json = JSON.stringify(scene, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${scene.name.replace(/\s+/g, '_')}.scene.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async importSceneJSON(file: File): Promise<string> {
    const text = await file.text();
    const parsed = JSON.parse(text) as RvScene;
    if (!parsed || parsed.schemaVersion !== 2 || !parsed.base || !parsed.edits) {
      throw new Error('Invalid scene JSON (missing schemaVersion 2 / base / edits)');
    }
    const now = new Date().toISOString();
    const fresh: RvScene = {
      ...parsed,
      id: newSceneId(),
      createdAt: now,
      modifiedAt: now,
      parentId: parsed.id,
    };
    writeScene(fresh);
    this._refreshScenes();
    this._notify();
    return fresh.id;
  }

  async exportSceneGLB(_id: string): Promise<Blob> {
    throw new Error('GLB export coming soon');
  }

  // ════════════════════════════════════════════════════════════════════
  // Op API — applyOp / undo / redo / transactions
  // ════════════════════════════════════════════════════════════════════

  /**
   * Apply an op to the live workspace. Serialised through `_opQueue`:
   * concurrent calls run sequentially. During in-flight loads (`_loading`),
   * ops are dropped on the floor — the load is replaying canonical state.
   *
   * If a transaction is open, the op is buffered instead of pushed onto
   * `_ops`; the composite is committed by `endTransaction`.
   */
  applyOp(op: PrimitiveEditOp): Promise<void> {
    return this._enqueue(async () => {
      if (this._loading) return;
      // Inside a transaction, accumulate primitives. The composite executes
      // via the executor at commit time (so the live scene reflects the
      // final state immediately on each primitive — but only one undo).
      if (this._txnDepth > 0) {
        await applyForward(op, { viewer: this._viewer });
        this._txnBuffer.push(op);
        return;
      }
      await applyForward(op, { viewer: this._viewer });
      this._pushOp(op);
      this._redoStack.length = 0;   // any new op invalidates redo
      this._enforceCap();
      this._afterOpsChanged();
    });
  }

  /** Undo the last op (down to the baseline floor). */
  undo(): Promise<void> {
    return this._enqueue(async () => {
      if (this._loading) return;
      if (this._ops.length <= this._baselineOps.length) return;
      const op = this._ops.pop()!;
      await applyInverse(op, { viewer: this._viewer });
      this._redoStack.push(op);
      this._afterOpsChanged();
    });
  }

  /** Redo the most-recently undone op. */
  redo(): Promise<void> {
    return this._enqueue(async () => {
      if (this._loading) return;
      const op = this._redoStack.pop();
      if (!op) return;
      await applyForward(op, { viewer: this._viewer });
      this._ops.push(op);
      this._afterOpsChanged();
    });
  }

  canUndo(): boolean { return this._ops.length > this._baselineOps.length; }
  canRedo(): boolean { return this._redoStack.length > 0; }

  describeUndo(): string | null {
    if (!this.canUndo()) return null;
    return `Undo: ${describeOp(this._ops[this._ops.length - 1])}`;
  }

  describeRedo(): string | null {
    if (!this.canRedo()) return null;
    return `Redo: ${describeOp(this._redoStack[this._redoStack.length - 1])}`;
  }

  /**
   * Begin a transaction. Subsequent `applyOp` calls accumulate into a
   * composite; commit on `endTransaction`. Reference-counted depth — nested
   * transactions commit when the OUTER one ends.
   */
  beginTransaction(label: string): TransactionToken {
    if (this._txnDepth === 0) {
      this._txnLabel = label;
      this._txnBuffer = [];
    }
    this._txnDepth++;
    return Object.freeze({ _depth: this._txnDepth });
  }

  /** Commit (push the composite op). Empty transactions become no-ops. */
  endTransaction(_token: TransactionToken): Promise<void> {
    return this._enqueue(async () => {
      if (this._txnDepth === 0) return;
      this._txnDepth--;
      if (this._txnDepth > 0) return; // outer commits later
      const ops = this._txnBuffer;
      this._txnBuffer = [];
      const label = this._txnLabel;
      this._txnLabel = '';
      if (ops.length === 0) return;
      const composite: EditOp = {
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'composite', label, ops,
      };
      this._pushOp(composite);
      this._redoStack.length = 0;
      this._enforceCap();
      this._afterOpsChanged();
    });
  }

  /** Discard the buffered primitives. The forward applies HAVE happened on
   *  the live scene — caller is responsible for any rollback. Use sparingly. */
  abortTransaction(_token: TransactionToken): void {
    if (this._txnDepth === 0) return;
    this._txnDepth--;
    if (this._txnDepth === 0) {
      this._txnBuffer = [];
      this._txnLabel = '';
    }
  }

  /** RAII helper. */
  async withTransaction<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
    const token = this.beginTransaction(label);
    try {
      const result = await fn();
      await this.endTransaction(token);
      return result;
    } catch (e) {
      this.abortTransaction(token);
      throw e;
    }
  }

  /**
   * Push an op onto _ops with coalescing. The merged op is forward-applied
   * only ONCE (the caller already applied it before calling _pushOp), but the
   * incoming op's value replaces the head's. Coalescing only happens when:
   *   - the head exists and `canCoalesce` agrees, AND
   *   - the head is ABOVE the baseline (so coalescing wouldn't corrupt the
   *     baseline's prev field, which would make undo-to-baseline lose
   *     information).
   */
  private _pushOp(op: EditOp): void {
    const last = this._ops[this._ops.length - 1];
    const headIsAboveBaseline = this._ops.length > this._baselineOps.length;
    if (last && headIsAboveBaseline && canCoalesce(last, op)) {
      this._ops[this._ops.length - 1] = mergeOps(last, op);
    } else {
      this._ops.push(op);
    }
  }

  private _enforceCap(): void {
    if (this._ops.length <= MAX_OP_HISTORY) return;
    const drop = this._ops.length - MAX_OP_HISTORY;
    this._ops.splice(0, drop);
    // Keep baseline aligned to the start of the kept window.
    if (this._baselineOps.length > 0) {
      const keepBaseline = Math.max(0, this._baselineOps.length - drop);
      this._baselineOps = this._baselineOps.slice(this._baselineOps.length - keepBaseline);
    }
  }

  private _afterOpsChanged(): void {
    // Schedule draft autosave (debounced). The slot we write to depends on
    // whether the workspace is anchored to a saved scene:
    //   • _saved != null → per-saved-scene slot (rv-scenes/scene-draft/<id>)
    //                       so reload via openScene resumes correctly.
    //   • _saved == null → per-base slot (rv-scenes/draft/<baseKey>) so
    //                       reload via openBuiltin resumes correctly.
    if (this._draftAutosaveTimer !== null) clearTimeout(this._draftAutosaveTimer);
    this._draftAutosaveTimer = window.setTimeout(() => {
      this._draftAutosaveTimer = null;
      if (!this._workspace) return;
      const draft = this._buildDraft();
      if (!draft) return;
      const saved = this._saved;
      if (this.canUndo() || this.canRedo() || !saved) {
        // There's edit content beyond baseline OR we're a fresh draft —
        // persist for tab-close survival.
        if (saved) writeSceneDraft(saved.id, draft);
        else writeDraft(this._workspace.base, draft);
      } else {
        // Workspace is in pristine saved state — clear the saved-scene's
        // draft slot. (No matching clear for the base slot here: a saved
        // workspace's base slot belongs to fresh built-in drafts of that
        // base, not to us.)
        clearSceneDraft(saved.id);
      }
    }, DRAFT_AUTOSAVE_DEBOUNCE_MS);
    this._notify();
  }

  private _cancelAutosave(): void {
    if (this._draftAutosaveTimer !== null) {
      clearTimeout(this._draftAutosaveTimer);
      this._draftAutosaveTimer = null;
    }
  }

  // ─── Async queue ────────────────────────────────────────────────────

  private _enqueue(work: () => Promise<void>): Promise<void> {
    const next = this._opQueue.then(() => work(), () => work());
    this._opQueue = next.catch(() => undefined);
    return next;
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private _refreshBuiltins(): void {
    this._builtins = (this._viewer.availableModels ?? []).map(m => ({ url: m.url, label: m.label }));
  }

  private _refreshScenes(): void {
    this._scenes = listMetas();
  }

  private _buildDraft(): RvScene | null {
    if (!this._workspace) return null;
    return {
      id: this._workspace.id,
      name: this._workspace.name,
      base: this._workspace.base,
      createdAt: this._workspace.createdAt,
      modifiedAt: new Date().toISOString(),
      schemaVersion: 2,
      parentId: this._workspace.parentId,
      description: this._workspace.description,
      edits: { ops: this._ops, settings: this._settings },
    };
  }

  private _buildSnapshot(): SceneSnapshot {
    const draft = this._buildDraft();
    const dirty = !opsEqual(this._baselineOps, this._ops);
    const isDraft = this._saved == null && this._workspace != null;
    return {
      saved: this._saved,
      draft,
      isDraft,
      dirty,
      scenes: this._scenes,
      builtins: this._builtins,
      busy: this._busy,
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      undoLabel: this.describeUndo(),
      redoLabel: this.describeRedo(),
    };
  }

  private _notify(): void {
    this._snapshot = this._buildSnapshot();
    for (const l of this._listeners) l();
  }

  // ════════════════════════════════════════════════════════════════════
  // Legacy compat shims — keep SceneWindow.tsx working.
  // ════════════════════════════════════════════════════════════════════

  /** @deprecated Use `openScene` / `openBuiltin`. */
  async loadScene(source: SceneSource): Promise<void> {
    if (source.kind === 'glb') return this.openBuiltin(source.url, source.label);
    return this.openScene(source.id);
  }

  /** @deprecated Use `newEmpty()` then `saveAs(name)`. */
  async createNewLayout(name: string): Promise<string> {
    await this.newEmpty();
    return this.saveAs(name);
  }

  /** @deprecated Use `exportSceneJSON(id)`. */
  exportLayoutJSON(id: string): void { this.exportSceneJSON(id); }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function workspaceShellOf(scene: RvScene): WorkspaceShell {
  return {
    id: scene.id,
    name: scene.name,
    base: scene.base,
    createdAt: scene.createdAt,
    parentId: scene.parentId,
    description: scene.description,
  };
}

function freshShell(base: SceneBase, name: string): WorkspaceShell {
  return {
    id: 'draft',
    name,
    base,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Sync `?scene=<value>` in the address bar. Pass null to drop the param.
 * Always called via history.replaceState — no navigation, just URL refresh
 * so a browser reload picks up exactly where the user left off.
 */
function updateUrlSceneParam(value: string | null): void {
  if (typeof window === 'undefined' || typeof window.history?.replaceState !== 'function') return;
  try {
    const url = new URL(window.location.href);
    if (value === null) url.searchParams.delete('scene');
    else url.searchParams.set('scene', value);
    url.searchParams.delete('model');
    window.history.replaceState(window.history.state, '', url.toString());
  } catch { /* ignore */ }
}

/** Compute the `?scene=<value>` form for a given workspace base. */
function urlValueForBase(base: SceneBase): string {
  if (base.kind === 'empty') return 'empty';
  // For built-ins, prefer the filename — short, stable, matches main.ts boot
  // matcher which checks `entries.find(e => e.filename === wanted || ...)`.
  const filename = base.url.split('?')[0].split('/').pop() ?? base.url;
  return 'builtin:' + filename;
}

// Keep imports from being marked unused by linters.
void scenesEqual;
void baseLabelOf;
void metaOf;
void COALESCE_WINDOW_MS;
