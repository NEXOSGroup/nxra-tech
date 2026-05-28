# Persistence Architecture — realvirtual WEB

This document describes how realvirtual WEB persists state across page reloads,
tab closes, and user sessions: which storage backend each piece of state lives
in, the wire format, and the lifecycle (when it's written, when it's read, how
it's cleared).

The two top-level concerns are:

- **Working scenes, saved scenes, and autosave snapshots** — the unified
  Scene model implemented by `SceneStore` and `rv-scene-storage.ts`. This is
  the heart of "what is the user looking at, and what unsaved changes do
  they have?". See §3.0 for the precise vocabulary.
- **Auxiliary stores** — visual settings, interface config, layout
  preferences, panel state, annotations, measurements, login gate, etc. Each
  has its own narrowly-scoped key.

There is also a small slice of state that lives in `IndexedDB` (the working
folder handle for the File System Access API) and the browser **Cache API**
(planner GLB tarballs).

---

## 1. Storage backends at a glance

| Backend | Used for | Survives reload? | Survives tab close? | Cleared by |
|---|---|---|---|---|
| **localStorage** | Almost everything: scenes, drafts, settings, overlays, presets, panel state | ✅ | ✅ | `clearAllRVStorage()` / Settings → "Reset all" |
| **sessionStorage** | Tab-scoped ephemeral state: sensor history panel layout, order cart, login gate auth | ✅ | ❌ | Tab close (browser-managed) |
| **IndexedDB** (`rv-filesystem`) | `FileSystemDirectoryHandle` for the user-selected working folder | ✅ | ✅ | `removeWorkFolder()` / Settings → Local Folder → Remove |
| **Cache API** (`rv-planner-glbs`) | Network cache for planner library GLBs | ✅ | ✅ | `ModelCache.clearPersistentCache()` |
| **URL query string** | Active scene id / built-in filename / model URL — round-trip across bookmarks and reloads | ✅ (re-read on boot) | ❌ | New URL |
| **In-memory** (`SceneStore`, op buffer, redo stack, transaction buffer) | Live workspace state; flushed to localStorage on debounce | ❌ | ❌ | Lost on reload unless autosaved |

All localStorage keys are listed centrally in
[`src/core/hmi/rv-storage-keys.ts`](src/core/hmi/rv-storage-keys.ts), which
also exposes `clearAllRVStorage()` (used by Settings → "Reset all").

---

## 1.5 What is persisted, when, where — at a glance

This table is the cheat-sheet. Every persisted piece of state is described
later in this document, but the most common question is "**when does each
thing actually get written?**".

| What | Where | **Write trigger** | Read trigger |
|---|---|---|---|
| **Working-scene op log** (autosave snapshot) | `localStorage rv-scenes/draft/<base>` or `rv-scenes/scene-draft/<id>` | Every op application, **debounced 2000 ms** (`DRAFT_AUTOSAVE_DEBOUNCE_MS`) | `openScene(id)` / `openBuiltin(url)` / `openEmpty()` at boot |
| **Saved scene** (an entry in *My Scenes*) | `localStorage rv-scenes/<id>` + `rv-scenes-index` | **Explicit user action**: Save / Save as… / Duplicate / Import / Rename | `openScene(id)` |
| **Active-scene pointer** | `localStorage rv-scenes/active` | `save()` / `openScene()`; cleared when opening an unsaved built-in | Boot fallback when `?scene=` is missing |
| **URL `?scene=…`** | History API (no storage) | Every workspace switch via `history.replaceState` | Boot, on every reload |
| **Visual / interface / search / multiuser settings** | `localStorage rv-<area>-settings` | **Every setter call** in the respective store (no debounce — synchronous) | Lazy on first access |
| **Per-group visibility** | `localStorage rv-group-visibility` | On every visibility toggle | Scene/model load + UI mount |
| **Per-model camera preset** | `localStorage rv-camera-start:<modelKey>` | `saveStartPos()` / `clearStartPos()` (also via `setCamera` op) | `scene-loaded` event |
| **Per-model annotations / measurements** | `localStorage rv-annotations-<hash>` / `rv-measurements-<hash>` | On create / edit / delete | Model load |
| **Layout Planner UI state** (grid, snaps, tabs, library URLs) | `localStorage rv-layout-…` | On every toggle / value change | Planner panel mount |
| **Hierarchy / Inspector / panel UI state** | `localStorage rv-hierarchy-… / rv-inspector-… / rv-extras-editor-…` | On every UI change (expand, resize, select) | Panel mount |
| **Working-folder handle** | `IndexedDB rv-filesystem` | On user folder selection | Settings → Local Folder open |
| **Working-folder display name** | `localStorage rv-local-folders` | Same call that writes the IDB handle | Settings UI render |
| **Planner GLB tarballs** | `Cache API rv-planner-glbs` | First fetch of a catalog GLB | Every subsequent fetch (cache-first) |
| **Sensor history panel layout** | `sessionStorage rv-sensor-history` | On panel drag / resize | Panel mount in same tab |
| **Order Manager cart** | `sessionStorage rv-order-cart` | On cart add / remove | Panel mount in same tab |
| **Login Gate auth** | `sessionStorage rv-login-auth` (default) | On successful login | Page load |
| **Settings bundle (export)** | Downloaded JSON file (not localStorage) | **Explicit user action**: Settings → Backup → Export | Settings → Backup → Import |
| **Settings sidecar (auto-load)** | Fetched from `<modelUrl>.settings.json` | (never written by viewer) | First model open, when `rv-visual-settings` is absent |

Two patterns to internalize:

1. **The working-scene op log is debounced (2 s); every other store writes
   synchronously on change.** The auxiliary stores trade write volume for
   simplicity — they're small enough that per-keystroke writes don't matter.
   The op log is large enough that debouncing matters, hence the 2-second
   window.

2. **localStorage is the resume mechanism; the URL is the bookmark.** A reload
   restores state from localStorage; sharing a link restores state from the
   URL. They're independent layers — clearing one does not clear the other.

---

## 2. The unified Scene model

The Scene model is the canonical container for "what the user is editing".
It composes a **base GLB** (built-in or empty) with an ordered **operation
log** that captures every edit.

```
┌─────────────────────────────────────────────────────────────────────┐
│                            RvScene                                  │
│  id, name, createdAt, modifiedAt                                    │
│  base:  { kind: 'builtin'; url; label } | { kind: 'empty' }         │
│  edits:                                                             │
│    ops:      [ EditOp, EditOp, … ]   ← operation log (history)      │
│    settings: { catalogUrls, gridSizeMm }                            │
│  thumbnailDataUrl?, parentId?, description?                         │
└─────────────────────────────────────────────────────────────────────┘
```

The op log is the single source of truth for edits. **Replaying it
deterministically on top of the base GLB materializes the live state**
(component property overrides + planner placements + camera preset). This is
how `SceneStore.openScene()` rebuilds an arbitrary scene on load: it does not
write a snapshot, it writes the ops, then replays them through the executors.

See [`src/core/hmi/scene/rv-scene-types.ts`](src/core/hmi/scene/rv-scene-types.ts)
and [`src/core/hmi/scene/rv-scene-edits.ts`](src/core/hmi/scene/rv-scene-edits.ts).

### 2.1 Edit operations

Every user edit produces an immutable `EditOp` record. There are six primitive
op kinds plus a `composite` for transactions:

| Kind | What it does | Inverse via |
|---|---|---|
| `setField` | Set `userData.realvirtual[componentType][fieldName] = value` on a node | `prev` (or `unsetField` if `prev === undefined`) |
| `unsetField` | Remove an override and restore the GLB default | `prev` value |
| `addPlacement` | Spawn a planner-catalog object (Layout Planner) | `removePlacement` of same id |
| `removePlacement` | Remove a planner placement | Re-`addPlacement` carrying the snapshot |
| `transformPlacement` | Move/rotate/scale a placement | `prev.{position,rotation,scale}` |
| `setCamera` | Set or clear the per-scene camera start preset | `prev` preset |
| `composite` | Group several primitives into one undo unit | Each child inverse, in reverse order |

Every primitive op carries its own inverse (`prev` field) so undo never
re-runs the forward executors against missing or stale state. Composites are
flattened recursively when materializing.

### 2.2 The op queue, transactions, and coalescing

`SceneStore` serializes all op application through a single-flight async
queue (`_opQueue`):

```
applyOp ─┐
         ├─► _enqueue ─► await applyForward(op) ─► _pushOp ─► debounced autosave
undo ────┤              await applyInverse(op)
redo ────┘
```

- **No concurrency**: ops apply one at a time. `addPlacement` (which loads a
  GLB) cannot interleave with a `setField`.
- **In-flight loads**: while `_loading === true` (during `openScene` /
  `openBuiltin` / `newEmpty`), ops are dropped — the load itself is replaying
  the canonical state and any user input would race against it.
- **Transactions**: `beginTransaction(label)` + `endTransaction()` wraps a
  sequence of primitives into one composite op. Forward applies happen
  immediately on each primitive (so the live scene reflects each step), but
  only one entry lands on the history → one undo reverts the whole gesture.
  `withTransaction(label, fn)` is the RAII helper.
- **Coalescing**: adjacent primitives on the same target within
  `COALESCE_WINDOW_MS = 500` ms merge into the head op. Typing into a number
  field doesn't bloat the history; a single undo still reverts the entire run
  because `prev` is preserved from the first op. Coalescing only happens
  **above the baseline** so it can never corrupt the inverse needed to reach
  the persisted starting state.
- **History cap**: `MAX_OP_HISTORY = 500`. When the cap is exceeded, the
  oldest ops drop off the front and the baseline shifts in lockstep so the
  undo floor stays consistent.

### 2.3 Materialization (replay)

`materialise(ops)` in [`rv-scene-edits.ts`](src/core/hmi/scene/rv-scene-edits.ts)
folds an op array into the shape the engine subsystems already consume:

```ts
{
  overlay:     RVExtrasOverlay   // → loadGLB (applied during traversal)
  placements:  PlacedComponent[] // → planner.applyPlacements()
  cameraStart: ModelCameraStart | null  // → camera-startpos plugin
}
```

It is a **pure function** — same input, same output, every time. This is the
determinism property that makes save/load round-trips safe.

`RVViewer.loadScene(scene)` in [`src/core/rv-viewer.ts`](src/core/rv-viewer.ts)
applies materialized edits in a fixed phase order:

```
0. materialise(ops)                    — fold ops
1. resolve base URL (built-in / empty) — empty = synthesised in-memory GLB
2. clear previous planner placements
3. loadModel(url, { overlay })         — overlay applied during GLB traversal
4. planner.applyPlacements(...)        — only if scene has placements
5. emit 'scene-loaded'                 — camera-startpos plugin re-tweens
```

---

## 3. localStorage layout for the Scene model

### 3.0 Vocabulary — three concepts at the workspace level

To avoid confusion, this document uses three precise terms instead of the
overloaded word "draft":

| Term | What it is | Where it lives |
|---|---|---|
| **Working scene** | The live editing session — an op log on top of a built-in or empty base. The Inspector, Hierarchy and Planner all act on this. | `SceneStore._workspace` (in-memory) + autosave snapshot (localStorage) |
| **Autosave snapshot** | A debounced backup of the working scene's op log. The reload-survival mechanism — nothing more. | `localStorage rv-scenes/draft/<baseKey>` or `rv-scenes/scene-draft/<id>` |
| **Saved scene** | A named, persistent record. Appears as a row under **My Scenes** in the Models panel. Created by Save / Save as… / Duplicate / Import. | `localStorage rv-scenes/<id>` + index entry in `rv-scenes-index` |

The **My Scenes** list in the UI is the set of saved scenes — it is **not** a
view onto the autosave snapshots. Editing a built-in stays in the autosave
snapshot only; it never appears in *My Scenes* until the user explicitly
clicks **Save as…**.

This is why the UI shows two buttons:

- **Save** — only enabled when the working scene already has a saved-scene
  id (`_saved != null`) and there are unsaved edits. Overwrites
  `rv-scenes/<id>` in place.
- **Save as…** — always enabled. Mints a new `scn_<…>` id, adds a row to
  *My Scenes*, and clears the autosave snapshot for the working scene.

The **UNSAVED** chip means *"the working scene has edits beyond its baseline"*.
It does **not** mean "you'll lose this on reload" — the autosave snapshot is
written every 2 s and restored on next boot. The chip exists to nudge the user
toward creating a named saved scene before the autosave snapshot gets
overwritten by switching workspaces.

### 3.1 localStorage layout

All Scene-related keys live in [`src/core/hmi/scene/rv-scene-storage.ts`](src/core/hmi/scene/rv-scene-storage.ts).
Five keyspaces, one job each:

| Key / Prefix | Shape | Purpose |
|---|---|---|
| `rv-scenes-index` | `RvSceneMeta[]` (sorted by `modifiedAt` desc) | Cheap list rendering for the Scene window without parsing every full scene |
| `rv-scenes/<id>` | `RvScene` (schemaVersion: 2) | Full saved scene record |
| `rv-scenes/active` | `{ id }` | Pointer to the most recently active saved scene — used as a boot-time defense-in-depth fallback when `?scene=` is missing |
| `rv-scenes/draft/<baseKey>` | `RvScene` | **Per-base autosave snapshot.** Used while the working scene has no saved id (`_saved == null`) — i.e. an untitled built-in or empty workspace |
| `rv-scenes/scene-draft/<savedId>` | `RvScene` | **Per-saved-scene autosave snapshot.** Used while the working scene has a saved id, keyed by id so multiple scenes built on the same base don't collide |

Where:
- `baseKeyOf({ kind: 'empty' })` → `'empty'`
- `baseKeyOf({ kind: 'builtin', url })` → `'builtin:' + encodeURIComponent(url)`

### 3.2 Two autosave snapshots — why?

The split exists because a working scene can be in one of two qualitatively
different states:

| Working-scene state | Saved? | Autosave snapshot | Resumed by |
|---|---|---|---|
| Fresh built-in or "Untitled" empty | `_saved == null` | `rv-scenes/draft/<baseKey>` | `openBuiltin(url)` / `openEmpty()` |
| Edits on top of a saved scene | `_saved != null` | `rv-scenes/scene-draft/<savedId>` | `openScene(savedId)` |

`SceneStore` has two empty-scene entry points that look similar but differ on
snapshot semantics:

- **`newEmpty()`** — explicit "New empty scene" gesture. Always discards the
  per-base empty snapshot and starts fresh.
- **`openEmpty()`** — resume-or-create. Mirrors `openBuiltin()`. Used by the
  boot path on `?scene=empty` so a reload preserves edits made on an
  untitled workspace.

Without the split, two saved scenes sharing the same base GLB would clobber
each other's snapshots. Two scenes that both forked from `factoryDemo.glb`
keep their unsaved edits independent because they have distinct saved ids and
write to separate `scene-draft/<id>` slots.

The per-base slot only exists for "I haven't saved this yet" working scenes;
on the first `save()`, the per-base slot is cleared and only the
per-saved-scene slot applies thereafter.

### 3.3 Autosave — when exactly does it write?

The autosave snapshot is written by `_afterOpsChanged()` on a debounced timer
(`DRAFT_AUTOSAVE_DEBOUNCE_MS = 2000` ms). The condition is a single
`if/else` — there are **two** effective branches, not three:

```
if (canUndo || canRedo || _saved == null):     // working scene has content
    if _saved != null  → writeSceneDraft(_saved.id, snapshot)
    else               → writeDraft(_workspace.base, snapshot)
else:                                          // pristine: edits match baseline
    if _saved != null  → clearSceneDraft(_saved.id)
    // NB: no clearDraft(base) here — the per-base slot is *not* cleared
    //     in the pristine path. It is only cleared on first save() / saveAs().
```

The autosave timer is cancelled at the top of every `_loadIntoWorkspace()`
call so an in-flight save can't write the previous workspace's state into
the new workspace's slot.

### 3.4 Save / Save as… / Discard / Delete semantics

| Operation | What happens | Snapshot slots |
|---|---|---|
| **Save** (`save()`) | First save: mints `scn_<…>` id, writes `rv-scenes/<id>` + index meta, sets `rv-scenes/active`. Subsequent saves: overwrite same id. | Both per-base and per-saved-scene snapshots cleared |
| **Save as…** (`saveAs(name)`) | Always mints a new id; `parentId` set to current `_saved?.id`. Adds a new row under *My Scenes*. | Same as above |
| **Discard** (`discard()`) | Re-opens last-saved scene, **first clearing the per-saved-scene snapshot** so we don't restore the very edits we're discarding | Per-saved-scene snapshot cleared, then read |
| `delete(id)` | Removes scene blob + index entry. Also `clearSceneDraft(id)` to prevent stale snapshots surviving id collisions | Per-saved-scene snapshot cleared |
| `rename(id, name)` | Index + body updated atomically (body first, then meta) | Untouched |
| `duplicate(id)` | Writes a fresh `scn_<…>` body; bumps `parentId` | Untouched |

The **Save** button in `SceneActiveCard` is enabled when
`!isDraft && !!saved && dirty`. "Disabled Save" means there is no saved-scene
id yet — the user must use **Save as…** to create one. After that, Save is
the in-place overwrite.

### 3.5 URL routing

`SceneStore` always reflects the active workspace into the URL via
`history.replaceState`:

| URL form | Effect on boot | Written by |
|---|---|---|
| `?scene=<scn_…>` | `openScene(id)` (highest priority) | `save()`, `saveAs()`, `openScene()` |
| `?scene=builtin:<filename>` | `openBuiltin(url)` for the matching entry | `openBuiltin()` |
| `?scene=empty` | `openEmpty()` (resume per-base empty draft if present) | `newEmpty()` and `openEmpty()` |
| `?model=<url>` | Legacy alias — deprecated, falls through to default-model boot |  |
| (no `scene` param) | Falls back to: saved active id (`rv-scenes/active`) → `?model=` → `LS_KEY_MODEL` → `defaultModel` from settings.json → first available | — |

The URL is the bookmarkable identity; localStorage is the resume mechanism.
`rv-scenes/active` is defense-in-depth for cases where the URL was lost
(bookmark predating the URL-write fix, code path that forgot to call
`updateUrlSceneParam`, etc.).

---

## 4. Boot path: how a reload restores state

Sequence in [`src/main.ts`](src/main.ts):

```
1. Init RVViewer, register plugins (Layout Planner, etc.)
2. initSceneStore(viewer)              ← reads catalogue indexes
3. migrateLegacyAutosave()             ← one-shot legacy migration (idempotent)

4. Resolve which scene/model to load:
   ┌──────────────────────────────────────────────────────────────┐
   │ a. ?scene=<id>           → SceneStore.openScene(id)          │
   │ b. ?scene=builtin:<file> → SceneStore.openBuiltin(url, label)│
   │ c. ?scene=empty          → SceneStore.openEmpty()            │
   │ d. (else) rv-scenes/active id → SceneStore.openScene(activeId)│
   │ e. (else) ?model=<url> + LS_KEY_MODEL + defaultModel + first │
   │       → SceneStore.openBuiltin(finalUrl, label)              │
   └──────────────────────────────────────────────────────────────┘

5. SceneStore.openScene(id):
   - readScene(id)           ← rv-scenes/<id>
   - readSceneDraft(id)      ← rv-scenes/scene-draft/<id>  (resume!)
   - sceneToLoad = draft ?? scene
   - viewer.loadScene(sceneToLoad)
   - writeActiveId(scene.id)   ← saved id, NOT draft id
   - updateUrlSceneParam(scene.id)

6. SceneStore.openBuiltin(url, label):
   - readDraft({ kind:'builtin', url })  ← rv-scenes/draft/<baseKey>  (resume!)
   - scene = restored ?? makeDraftScene(base, label)
   - viewer.loadScene(scene)
   - writeActiveId(null)       ← unsaved drafts don't claim the active slot
```

Step 5 is the key reload-survival mechanism for **saved scenes with unsaved
edits**: `openScene` always prefers the per-saved-scene draft over the saved
snapshot. Step 6 is the equivalent for **fresh drafts**.

### 4.1 Additional boot-time branches

Beyond the SceneStore routing above, `main.ts` runs a handful of other
branches that influence what gets loaded and what gets persisted. They are
not part of the Scene model but they shape the user's first paint:

| Branch | Trigger | Effect |
|---|---|---|
| **Microsoft Teams app** | `?teams=1` in URL | Initialises the Teams JS SDK, extracts user context, auto-injects `?name=<user>` for Multiuser identity |
| **Performance test mode** | `?perf` in URL | Locks settings (`appConfig.lockSettings = true`), loads the PerfTestPlugin |
| **MCP bridge** | `?mcp` in URL (or DEV mode) | Enables the MCP bridge plugin so AI tools can introspect the live scene |
| **Firebase demo deploy** | URL path matches `/demo/webviewer/<demoName>` | Loads the GLB directly from Firebase Storage; bypasses the normal `?scene=` routing |
| **Private project models** | Server provides `GET /__api/private-models` | Adds entries to the Models panel from a server-side allowlist |
| **Authoritative model manifest** | `public/models.json` present | Overrides directory-listing-based model discovery — critical for private deploys |
| **Local-filesystem model discovery** | User granted a working folder (see §7.6) | Surfaces `.glb` files in the folder's `models/` subdirectory inside the Models panel |

None of these branches write to the Scene model; they only influence which
GLB the SceneStore is asked to open. Once `openBuiltin()` / `openScene()` is
called, the regular boot path takes over.

### 4.2 The legacy fallback path

If a `?model=` URL or `LS_KEY_MODEL` resolves and no `?scene=` was set, the
legacy default-model boot is now routed through `sceneStore.openBuiltin(...)`
rather than `loadModel(...)` directly. This was an explicit fix: the bare
`loadModel` path eventually called `markGlbActive(url, label)` which builds
a workspace with **empty baseline** — discarding any per-base draft that had
been autosaved. Routing through `openBuiltin` consults the `rv-scenes/draft/`
slot, restoring property-inspector edits across reload even when the URL was
not explicitly `?scene=builtin:`.

`markGlbActive` is still called by the `loadModel` fast-path inside `main.ts`
for cases where loading is initiated outside the SceneStore (Firebase demo
mode, `loadModelWithProgress` chained from settings UI). It is a no-op while
`_loading` is true, so it cannot stomp an in-flight `openBuiltin`/`openScene`.

---

## 5. Edit executors — turning ops into live changes

[`rv-scene-executors.ts`](src/core/hmi/scene/rv-scene-executors.ts) is the
boundary between the pure op log and the live Three.js scene. Each primitive
kind has a forward + inverse function:

| Op kind | Forward | Inverse |
|---|---|---|
| `setField` | Write `userData.realvirtual.<comp>.<field>`, then `applySchema()` so the live component instance (e.g. `RVDrive.TargetSpeed`) reflects the value | Restore `prev` (or `delete` if `prev === undefined`) and re-apply schema |
| `unsetField` | Delete the field, re-apply schema (instance falls back to GLB default) | Write `prev` and re-apply schema |
| `addPlacement` | `LayoutPlannerPlugin.placeFromRecord(placement)` (loads the catalog GLB if not already cached) | `removePlacementById(id)` |
| `removePlacement` | `removePlacementById(id)` | `placeFromRecord(placement)` from the snapshot |
| `transformPlacement` | `applyTransformById(id, pos, rot, scale)` | Same with `prev.{pos,rot,scale}` |
| `setCamera` | `saveStartPos(modelKey, preset)` or `clearStartPos(modelKey)` (writes `rv-camera-start:<modelKey>`) | Same with `prev` |

All execution is wrapped in `try/catch` — a failed primitive op logs a
warning but never throws across the SceneStore boundary. **This is what lets
a saved scene whose base GLB later changed (some node went missing) still
load**: the stale ops are skipped, the rest replay cleanly. The user sees
the edits that still apply and a console warning for the ones that don't.

Composite ops are not atomic in this sense: each child is wrapped
individually, so a composite of (setField, setField, addPlacement) where the
middle child fails will still apply the first and third. This is the right
default for replay-on-load, but it means a composite that records a
multi-step gesture can produce a partial result if the scene has drifted.
For inverses (undo), the same per-child wrapping applies in reverse order.

`setCamera`'s forward path writes the per-model camera preset
(`rv-camera-start:<modelKey>`) directly — the camera startpos store is the
storage backend, not a parallel state. This is why camera presets carried
through ops (i.e. in the scene's `edits.ops`) and the per-model preset in
localStorage agree without explicit sync code.

---

## 6. JSON import / export of scenes

`SceneStore.exportSceneJSON(id)` writes a `*.scene.json` file containing the
full `RvScene` record (id, name, base, ops, settings). `importSceneJSON(file)`
validates `schemaVersion === 2`, mints a fresh id (so import never collides
with an existing entry), and adds the imported scene to the index with
`parentId` set to the original id (provenance only).

GLB export is reserved (`exportSceneGLB` currently throws "GLB export coming
soon"). When implemented it will go through the Unity-side
[`realvirtualExportPlugin`](../realvirtual/Professional/AssetManager/private/realvirtualExportPlugin.cs)
contract: serialize ops + placements into the `REALVIRTUAL` GLTF extension
under `userData.realvirtual` so the round-trip is symmetric with Unity.

---

## 7. Auxiliary persisted stores

The Scene model is the heart of "what is the user editing", but the Web
Viewer persists a long tail of unrelated state. All keys live in
[`src/core/hmi/rv-storage-keys.ts`](src/core/hmi/rv-storage-keys.ts).

### 7.1 localStorage — settings & preferences

| Key | Owner | Purpose |
|---|---|---|
| `rv-visual-settings` | `visual-settings-store.ts` | Lighting mode, tone mapping, shadows, FOV, camera bookmarks, AO mode, antialias, shadow map size |
| `rv-search-settings` | `search-settings-store.ts` | Search/filter UI preferences |
| `rv-interface-settings` | `interfaces/interface-settings-store.ts` | WebSocket Realtime / ctrlX / MQTT / TwinCAT HMI configuration |
| `rv-multiuser-settings` | `multiuser-settings-store.ts` | Multiuser relay URL, user name/colour |
| `rv-group-visibility` | `group-visibility-store.ts` | Per-group visibility toggles (persisted across reload) |
| `rv-hmi-visible` | `hmi-visibility-store.ts` | HMI overlay show/hide |
| `rv-maintenance-progress` | `maintenance-progress-store.ts` | Maintenance step completion state |
| `rv-ai-bridge` | `mcp-bridge-plugin.ts` | MCP bridge configuration |
| `rv-debug` | `engine/rv-debug.ts` | Debug subsystem flags |
| `rv-extras-overlay` | `engine/rv-extras-overlay-store.ts` | Top-level extras overlay flag (legacy boot-path fallback) |
| `rv-webviewer-last-model` | `main.ts` | Last opened model URL — used only when `?scene=` is empty AND no active saved scene |
| `rv-webviewer-renderer` | `main.ts` | `'webgl'` or `'webgpu'` — read on boot |
| `rv-welcome-dismissed` | `ButtonPanel.tsx` | One-shot welcome banner |
| `rv-gpu-warning-dismissed` | `GPUWarningBanner.tsx` | One-shot GPU warning banner |
| `rv-env-user-modified` | `environment-presets.ts` | Marks the env preset as user-edited |
| `rv-pipe-coloring-enabled` | `pipe-coloring-plugin.tsx` | Pipe coloring on/off |
| `rv-pu-mode-enabled` | `processing-unit-mode-plugin.tsx` | Processing unit mode on/off |
| `rv-connect-url` | `connect-store.ts` | CONNECT gateway base URL (default `http://localhost:5100`) |
| `rv-unity-cloud-config` | (Unity Cloud) | Unity Cloud build endpoint |
| `rv-scenes-cleared-legacy` | Settings → "Clear legacy WebViewer data" | One-shot marker that legacy keys were swept |

### 7.2 localStorage — UI panel/inspector state

| Key | Owner | Purpose |
|---|---|---|
| `rv-extras-editor-width` | `rv-extras-editor.tsx` | Property editor docked width |
| `rv-extras-editor-open` | `rv-extras-editor.tsx` | Open/closed state |
| `rv-extras-editor-selected` | `rv-extras-editor.tsx` | Last-selected node path |
| `rv-hierarchy-expanded` | `rv-hierarchy-browser.tsx` | Tree-view expanded node set |
| `rv-hierarchy-type-filter` | `rv-hierarchy-browser.tsx` | Type filter chips |
| `rv-hierarchy-signal-sort` | `rv-hierarchy-browser.tsx` | Signal sort order |
| `rv-inspector-collapsed` | `rv-component-section.tsx` | Per-section collapsed state |
| `rv-inspector-consumed-only` | `rv-property-inspector.tsx` | Show only consumed properties toggle |
| `rv-inspector-detached` | `rv-property-inspector.tsx` | Inspector docked vs floating |
| `rv-left-panel-active` | `left-panel-manager.ts` | Active left panel id (mutually exclusive panels) |
| `rv-models-window-open` | `TopBar.tsx` | Models window open/closed state |

### 7.3 localStorage — Layout Planner

| Key | Purpose |
|---|---|
| `rv-layout-library-urls` | Catalog tab URLs (user-added; bundled URLs excluded) |
| `rv-layout-autosave` | **Legacy** single-slot autosave — migrated once to `rv-layouts/<id>` on boot, then removed |
| `rv-layout-grid-enabled` | Grid snap on/off |
| `rv-layout-grid-size` | Grid size in mm |
| `rv-layout-rotation-snap` | Rotation snap in degrees |
| `rv-layout-drop-to-surface` | Drop-to-surface mode |
| `rv-layout-bbox-snap-enabled` | Magnetic bbox snap on/off |
| `rv-layout-bbox-snap-mid` | MID-point bbox snap on/off ⚠️ |
| `rv-layout-bbox-snap-side` | Side-edge bbox snap on/off ⚠️ |
| `rv-layout-bbox-snap-tolerance` | Magnetic snap tolerance in mm ⚠️ |
| `rv-layout-show-neighbor-distances` | Show neighbor-distance hints ⚠️ |
| `rv-layout-neighbor-distance-max` | Max neighbor distance in mm ⚠️ |
| `rv-layout-active-tab` | Last-active catalog tab URL |
| `rv-layouts-index` | Layout meta index (legacy multi-layout registry, superseded by `rv-scenes-index`) |
| `rv-layouts/<id>` | Layout body (legacy) |

The legacy multi-layout registry (`rv-layouts/<id>`) is no longer the active
Scene container — saved scenes write to `rv-scenes/<id>` instead. The legacy
keys exist only so that pre-unification users don't lose their layouts on
upgrade. `migrateLegacyAutosave()` runs once on boot and is idempotent.

> ⚠️ **Known gap:** The five entries marked ⚠️ above (`rv-layout-bbox-snap-mid`,
> `-side`, `-tolerance`, `rv-layout-show-neighbor-distances`,
> `rv-layout-neighbor-distance-max`) are not registered in
> `rv-storage-keys.ts` and therefore survive `clearAllRVStorage()`
> ("Reset all"). To fix, add them to `ALL_RV_STORAGE_KEYS`.

### 7.4 localStorage — dynamic prefixes (one entry per resource)

These are listed as `RV_DYNAMIC_PREFIXES` in `rv-storage-keys.ts` so
`clearAllRVStorage()` can sweep them without enumerating every concrete key:

| Prefix | Per-resource value | Owner |
|---|---|---|
| `rv-extras-overlay:<glbName>` | `RVExtrasOverlay` JSON (legacy boot-path fallback) | `engine/rv-extras-overlay-store.ts` |
| `rv-extras-originals:<glbName>` | Pre-override values for "reset" (legacy) | Same |
| `rv-annotations-<modelHash>` | Per-model annotation list | `plugins/annotation-plugin.ts` |
| `rv-measurements-<modelHash>` | Per-model measurement list | `plugins/measurement-plugin.tsx` |
| `rv-panel-…` / `rv-panel-geo:…` | Floating chart/panel geometry | `ChartPanel.tsx` |
| `rv-order-…` | Order Manager per-order state | `plugins/order-manager-plugin.tsx` |
| `rv-camera-start:<modelKey>` | `ModelCameraStart` per model (also written through `setCamera` ops) | `core/hmi/camera-startpos-store.ts` |
| `rv-login-…` | Login Gate per-deployment auth state (when configured to use localStorage) | `plugins/login-gate-plugin.tsx` |
| `rv-layouts/<id>` | Legacy layout body — see 7.3 | `layout-registry.ts` |

### 7.5 sessionStorage — tab-scoped

These intentionally clear when the tab closes:

| Key | Purpose | Owner |
|---|---|---|
| `rv-sensor-history` | Floating Sensor History panel layout (x, y, w, h, clamped to viewport on read) | `sensor-history-store.ts` |
| `rv-order-cart` | Order Manager cart (private session state) | `plugins/order-manager-plugin.tsx` |
| `rv-login-auth` (default key) | Login Gate authentication flag — defaults to sessionStorage so closing the tab forces re-auth | `plugins/login-gate-plugin.tsx` |

`ALL_RV_SESSION_STORAGE_KEYS` lists these for grep-ability but they are **not**
swept by `clearAllRVStorage()` — the browser already drops them on tab close.

### 7.6 IndexedDB — `rv-filesystem`

[`src/core/engine/rv-local-filesystem.ts`](src/core/engine/rv-local-filesystem.ts)
stores a single `FileSystemDirectoryHandle` under the `handles` object store,
keyed `'workfolder'`. The handle survives reloads but the browser may prompt
the user to re-grant read permission.

Companion key in localStorage: `rv-local-folders` carries
`{ displayName, lastAccessed }` so the Settings UI can show "Working folder:
MyProject (last opened …)" without forcing a permission prompt.

The working folder is read by both the main viewer model selector
(`models/`) and the Layout Planner (`library/`, optionally with category
subfolders). It is **not** writable from the viewer — selection mode is
hard-coded to `mode: 'read'`.

### 7.7 Cache API — `rv-planner-glbs`

`ModelCache` ([`plugins/layout-planner/model-cache.ts`](src/plugins/layout-planner/model-cache.ts))
uses the browser **Cache API** (named bucket `rv-planner-glbs`) as a
persistent network cache for catalog GLBs:

```
getOrLoad(url):
  if in-memory cache  → clone and return
  if Cache API hit    → load from blob, populate in-memory
  else                → fetch, cache.put(url, response), load from blob
```

This survives reload (unlike the in-memory `Map`) and means a heavy planner
catalog only downloads once per browser. `ModelCache.clearPersistentCache()`
deletes the bucket; otherwise it persists until the user clears site data.

---

## 8. Settings bundle — export/import + sidecar

[`rv-settings-bundle.ts`](src/core/hmi/rv-settings-bundle.ts) collects the
auxiliary stores (visual, interface, search, multiuser, group
visibility, per-model camera presets) into a single versioned JSON document:

```json
{
  "$schema": "rv-settings-bundle/1.0",
  "exportedAt": "2026-…",
  "modelUrl": "models/factory-demo.glb",
  "settings": {
    "visual": { … },
    "interface": { … },
    "cameraStart": { "<modelKey>": { px, py, pz, tx, ty, tz, duration? } }
  }
}
```

Three usage modes:

1. **Export** (Settings → Backup → Export) — writes
   `<modelBasename>.settings.json`.
2. **Import** (Settings → Backup → Import) — validates schema, prompts
   confirmation, then applies via `applySettingsBundle()` which merges with
   current values (`{ ...current, ...bundle }`).
3. **Sidecar auto-load** — on first visit (when `rv-visual-settings` is
   absent), `loadModelSettingsConfig(modelUrl)` fetches
   `<modelUrl>.settings.json` from the same path. Silent on any error —
   never blocks model loading. This is how a deploy can ship per-model
   default settings.

The bundle does **not** include the Scene model, drafts, layouts, or any
`rv-scenes/*` data. Scenes are exported/imported separately via
`exportSceneJSON` / `importSceneJSON`.

---

## 9. The "Reset all" and "Clear legacy" tools

Settings → **Backup** has three destructive buttons:

| Button | Calls | Effect |
|---|---|---|
| **Reset all** | `clearAllRVStorage()` then reload | Sweeps every `ALL_RV_STORAGE_KEYS` entry + every key matching `RV_DYNAMIC_PREFIXES`. Does NOT touch sessionStorage (the browser does that on tab close). Does NOT touch IndexedDB. |
| **Clear legacy WebViewer data** | Removes `rv-layouts-index`, `rv-layouts/*`, `rv-scene-active`, `rv-layout-autosave`, `rv-layout-library-urls`, `rv-extras-overlay:*`, `rv-extras-originals:*`. Sets `rv-scenes-cleared-legacy = true`. Reloads. | Reclaims quota from pre-unification keys without dropping the user's current Scene store |
| **Export / Import settings** | `collectSettingsBundle` / `applySettingsBundle` | See §8 |

The legacy button is only shown if `listLegacyWebViewerKeys()` finds at
least one entry — so users who never had pre-unification data don't see it.

### 9.1 What "Reset all" does **not** touch

`RV_DYNAMIC_PREFIXES` does **not** include `'rv-scenes/'`, so
`clearAllRVStorage()` leaves the following intact by design:

- `rv-scenes-index` and every `rv-scenes/<id>` saved scene
- Both autosave snapshot slots (`rv-scenes/draft/<base>`, `rv-scenes/scene-draft/<id>`)
- `rv-scenes/active`

This is intentional — "Reset all" is meant to wipe **settings**, not user
content. If you change it (e.g. add `'rv-scenes/'` to the prefix list), you
will delete the user's saved scenes on click. Most users expect Settings to
be separate from their saved work; preserve that boundary.

`ALL_RV_STORAGE_KEYS` also contains two historical entries that are no
longer written by the live code: `'rv-scene-active'` (singular, replaced by
the slashed `rv-scenes/active` form) and `'rv-splat-transform'` (legacy
transform store, superseded by `PlacedComponent` ops). They stay in the
sweep list so that older browsers still get cleaned up.

---

## 10. Quota and failure handling

localStorage is bounded (typically 5–10 MB per origin). Every write is
wrapped in `try/catch` and silently ignored on `QuotaExceededError`. The
SceneStore comment for `writeIndex` is representative:

```ts
try { localStorage.setItem(LS_KEY_INDEX, JSON.stringify(sorted)); }
catch { /* Quota — caller surfaces toast. */ }
```

There is **no global toast surface** for quota errors today. Some
in-code comments read "caller surfaces toast", but no caller actually does
— the write is silently dropped and the user is not notified. If you add a
quota-handling layer, this is the place to thread it through.

The op log cap (`MAX_OP_HISTORY = 500`) is the primary defense against
runaway growth.

**Thumbnails (`thumbnailDataUrl`)** are stored as base64 PNG data URLs
inside the `RvScene` record and are the largest single contributor to
per-scene size. They are generated lazily on `save()` / `saveAs()` (not on
every op) by rendering a small framebuffer of the current viewer. There is
no explicit thumbnail-clear API — the only ways to drop a thumbnail are to
delete the scene, overwrite it with a fresh save, or clear localStorage.
A typical thumbnail is 10–40 KB; 100 saved scenes with thumbnails fit
comfortably within the 5 MB quota, but a thousand will not.

If you're adding a new persisted store, follow the pattern:

```ts
function save(value: T): void {
  try { localStorage.setItem(KEY, JSON.stringify(value)); }
  catch { /* quota / SecurityError in private mode — skip */ }
}

function load(): T | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return validates(parsed) ? parsed : null;
  } catch { return null; }
}
```

And register the key in [`rv-storage-keys.ts`](src/core/hmi/rv-storage-keys.ts)
so `clearAllRVStorage()` sees it.

---

## 11. Quick reference — what survives what

| Action | localStorage | sessionStorage | IndexedDB | Cache API | URL | In-memory |
|---|---|---|---|---|---|---|
| Page reload (same tab) | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Close + reopen tab | ✅ | ❌ | ✅ | ✅ | only if bookmarked | ❌ |
| Browser restart | ✅ | ❌ | ✅ | ✅ | only if bookmarked | ❌ |
| Site data cleared | ❌ | ❌ | ❌ | ❌ | unaffected | ❌ |
| Settings → Reset all | ❌ | ✅ (browser will drop on close) | ✅ | ✅ | ✅ | depends on reload |
| Settings → Clear legacy | partial (legacy keys only) | ✅ | ✅ | ✅ | ✅ | depends on reload |

**On reload**, the SceneStore boot path (§4) restores:

- The active working scene (saved scene resumed from per-saved-scene
  autosave snapshot, or fresh built-in resumed from per-base autosave
  snapshot)
- All settings (visual, interface, etc.)
- Catalog tabs and grid preferences in the Layout Planner
- Per-model camera presets (and so the camera start animation)
- Annotations, measurements, group visibility toggles
- Working-folder handle (subject to a permission re-grant)
- Cached planner GLBs (no re-download)

What is **not** restored on reload:

- The simulation runtime state (signals, drive positions, MUs in transit) —
  recreated by the ops log on top of the freshly loaded GLB
- The undo/redo stacks — only the op log itself survives, so the user can
  undo back to the persisted baseline but not before it
- Floating-panel positions — the comment in `rv-settings-bundle.ts` is the
  canonical statement: "panel positions are no longer persisted; each panel
  re-anchors to the user's last click on open"

---

## 12. Where to look in the code

Heart of the persistence logic:

| File | Concern |
|---|---|
| [`src/core/hmi/scene/scene-store.ts`](src/core/hmi/scene/scene-store.ts) | `SceneStore` — workspace lifecycle, op queue, transactions, autosave timer |
| [`src/core/hmi/scene/rv-scene-storage.ts`](src/core/hmi/scene/rv-scene-storage.ts) | Pure CRUD over the five Scene keyspaces |
| [`src/core/hmi/scene/rv-scene-types.ts`](src/core/hmi/scene/rv-scene-types.ts) | `RvScene`, `SceneBase`, dirty detection, `materialise` |
| [`src/core/hmi/scene/rv-scene-edits.ts`](src/core/hmi/scene/rv-scene-edits.ts) | Op taxonomy, materialise, coalescing, inverse helpers |
| [`src/core/hmi/scene/rv-scene-executors.ts`](src/core/hmi/scene/rv-scene-executors.ts) | Forward + inverse executors against the live RVViewer scene |
| [`src/core/hmi/rv-storage-keys.ts`](src/core/hmi/rv-storage-keys.ts) | Central registry of all keys + `clearAllRVStorage()` |
| [`src/core/hmi/rv-settings-bundle.ts`](src/core/hmi/rv-settings-bundle.ts) | Settings export/import + per-model sidecar auto-load |
| [`src/core/engine/rv-local-filesystem.ts`](src/core/engine/rv-local-filesystem.ts) | IndexedDB-backed working folder API |
| [`src/plugins/layout-planner/model-cache.ts`](src/plugins/layout-planner/model-cache.ts) | Cache API-backed planner GLB cache |
| [`src/core/hmi/camera-startpos-store.ts`](src/core/hmi/camera-startpos-store.ts) | `rv-camera-start:<modelKey>` per-model camera preset (storage backend of the `setCamera` op) |
| [`src/core/hmi/scene/SceneActiveCard.tsx`](src/core/hmi/scene/SceneActiveCard.tsx) | UI for Save / Save as… / Discard / Undo / Redo |
| [`src/main.ts`](src/main.ts) | Boot path: URL routing → SceneStore → fallback chain |

For a deeper dive into the Scene model design rationale (why the op log,
why two autosave slots, why composites can't nest), the inline doc comments
in `rv-scene-edits.ts` and `scene-store.ts` are the authoritative source —
they were written as the unified Scene plan was being implemented and
explain the trade-offs that aren't visible from the code alone.

---

## 13. Known limits and non-goals

This is the short list of things the persistence layer **does not** do.
They are intentional simplifications — read them before adding a feature
that assumes the opposite.

### 13.1 Cross-tab concurrency

There is no `BroadcastChannel`, no `storage`-event listener, no inter-tab
lock. Two tabs editing the same saved scene will silently race: each tab
writes its own autosave snapshot every 2 s, and whichever tab writes last
wins. The next reload sees that tab's state.

For single-user, single-tab editing this is the right default. For
collaborative workflows, use **Multiuser mode** (relay-based, see
`doc-multiuser-system.md`) — do not assume two tabs on the same machine
can co-edit safely.

### 13.2 Secrets at rest

`rv-interface-settings` stores PLC connection credentials (WebSocket auth
tokens, MQTT username/password) in **plain text** in localStorage. The
Login Gate plugin uses base64 obfuscation, which is not encryption. Treat
realvirtual WEB's localStorage as readable by anyone with file-system access
to the browser profile.

Production deployments that need real secret handling should:
- terminate auth at a reverse proxy (HTTPS + bearer token outside the
  browser), or
- use short-lived tokens fetched at runtime, never stored in localStorage.

### 13.3 Schema migration

`RvScene.schemaVersion` is `2` today. The validator rejects anything other
than `2` outright — there is no automatic v1 → v2 path. Importing an older
JSON returns `null` from `readScene()` and the user sees an empty
workspace. If you bump the version, add a migrator inside
`rv-scene-storage.ts:readScene()` rather than at every call site.

`migrateLegacyAutosave()` is the one existing migration (legacy
`rv-layout-autosave` single-slot → `rv-layouts/<id>` registry). Use it as
the template.

### 13.4 Multiuser session state

Avatar position, camera ray, voice/chat state, and the operator-camera
follow flag are **not** persisted. They are in-memory only and reset on
reload. Only `rv-multiuser-settings` (relay URL, user name, user colour)
survives, because it's a preference, not a session.

The interaction between Shared View mode and the local SceneStore is
deliberate: live signals and operator-camera updates **override** local
ops/camera, immediately and without blending, but they do not write into
the op log. Closing the shared view restores the local working scene.

### 13.5 Offline mode and Service Workers

The Cache API bucket `rv-planner-glbs` (§7.7) is the only network cache.
There is no Service Worker, no offline-first behaviour, and model GLBs
are not cached unless they came through `ModelCache`. A reload without
network connectivity will show an empty Models panel except for whatever
is already in the Cache API.

### 13.6 Atomicity of multi-key writes

`writeScene()` writes the body (`rv-scenes/<id>`) before the index
(`rv-scenes-index`). If localStorage hits quota between the two writes,
the result is an orphan body without an index entry — harmless for the UI
(it won't list) but it consumes quota until "Clear legacy" or "Reset all"
runs. There is no transaction primitive; if you add cross-key invariants,
plan for the partial-write case.
