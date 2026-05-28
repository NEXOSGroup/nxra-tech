# Lifecycle — RVViewer

This document describes the **runtime lifecycle** of realvirtual WEB:
from construction to model load, the per-frame simulation/render loop, pause and
reset semantics, connection-state transitions, and teardown.

Use this as the single reference when wiring plugins, HMI components, or
integrations that must react to lifecycle transitions. The canonical source
remains [src/core/rv-viewer.ts](src/core/rv-viewer.ts); this document organises
what is otherwise spread across `rv-viewer.ts`, `rv-plugin.ts`,
`rv-simulation-loop.ts`, and the scene loader.

---

## 1. Lifecycle Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  new RVViewer(...)            Viewer constructed (Three.js scene,    │
│                               renderer, controls, loop, plugins,     │
│                               UI registry — but NO model yet)        │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                       ┌──────────────────────┐
                       │ viewer.loadModel()   │  ──→ 'model-loaded'
                       │   or loadScene()     │      'scene-loaded'
                       └──────────────────────┘
                                  │
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │                  RUNNING (loop.start())                      │
   │   per fixed step (60 Hz):  onFixedUpdatePre → drives →       │
   │                            transport → onFixedUpdatePost     │
   │   per animation frame:     onRender                          │
   │                                                              │
   │   setSimulationPaused(reason, true/false)                    │
   │     ↑↓                                  ──→ 'simulation-     │
   │   PAUSED  (rendering continues,             pause-changed'   │
   │            fixed step skipped)                               │
   │                                                              │
   │   resetSimulation()  — clears MUs + LogicSteps               │
   │                        (drives/signals/pause untouched)      │
   └──────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                       ┌──────────────────────┐
                       │ viewer.clearModel()  │  ──→ 'model-cleared'
                       │   (or loadModel()    │
                       │    on new URL)       │
                       └──────────────────────┘
                                  │
                                  ▼
                       ┌──────────────────────┐
                       │ viewer.dispose()     │   (final teardown)
                       └──────────────────────┘
```

---

## 2. Viewer Construction

`new RVViewer(canvas, options)` builds the static infrastructure:

- Three.js `Scene`, `WebGLRenderer` (or WebGPU), camera, `OrbitControls`
- `SimulationLoop` (not yet started)
- `GizmoManager`, `SelectionManager`, `HighlightManager`
- Plugin registry (no plugins active yet — use `viewer.use(plugin)`)
- UI slot registry (HMI mounts can read this)

What is **not** present after construction:

- `currentModel`, `drives`, `signalStore`, `transportManager`, `logicEngine`,
  `registry`, `groups`, `playback`, `raycastManager` — all `null` / empty
- No sources, sinks, sensors

Plugins registered before the first `loadModel()` receive `onModelLoaded`
when the model finally loads. Plugins registered **after** a model is
already loaded receive `onModelLoaded` **retroactively** with the last
`LoadResult`.

---

## 3. Model Load Pipeline

`viewer.loadModel(url, options?)` is the single entry point for replacing the
loaded GLB. `viewer.loadScene(scene)` wraps it for the Scene/Op-Log workflow.

### 3.1 Phases of `loadModel()`

| # | Phase | What happens | Hooks fired |
|---|-------|--------------|-------------|
| 1 | **Pre-clear** | `clearModel()` is called — see §6 | `onModelCleared`, `'model-cleared'` |
| 2 | **Track URL** | `_currentModelUrl` updated | — |
| 3 | **External plugins** (opt-in via `appConfig.externalPlugins`) | Probes `./project-plugin.js` + `./models/<name>/model-plugin.js`; runs default export with `this` | — |
| 4 | **ModelPluginManager** | Loads Vite-bundled per-model plugins (`plugins/models/*`) | `onModelLoading(url, viewer)` |
| 5 | **Load gate** | `await this.loadGate` (set by e.g. login flow) | — |
| 6 | **GLB parse** | `loadGLB(url, scene, { overlay, … })` — parses GLB, applies `rv_extras`, runs two-phase component construction | — |
| 7 | **Shader pre-compile** | `renderer.compileAsync()` (when available) | — |
| 8 | **State assignment** | `currentModel`, `drives`, `transportManager`, `signalStore`, `playback`, `replayRecordings`, `logicEngine`, `registry`, `groups` are set | — |
| 9 | **Wire subsystems** | Source-markers binding, `ComponentEventDispatcher`, `AutoFilterRegistry`, `SelectionManager.init()`, `RaycastManager`, isolation gate, core context-menu items | — |
| 10 | **Plugin notification** | Every enabled plugin gets `onModelLoaded(result, viewer)` | `onModelLoaded` |
| 11 | **Re-evaluate physics** | `_physicsPluginActive` updated (plugins may have flipped `handlesTransport` in step 10) | — |
| 12 | **Emit event** | `'model-loaded'` event fires | `'model-loaded'` |
| 13 | **Drain async** | `await whenLoadingIdle()` — env-map IBL, deferred prefetch, etc. | — |
| 14 | **Resolve** | `loadModel` promise resolves with `LoadResult` | — |

> **Two-phase component construction** in step 6 mirrors Unity's
> `Awake()`/`Start()` lifecycle: all node registry entries are created first
> (Awake), then typed component instances are built and can resolve
> cross-references (Start). See [doc-signal-architecture.md](doc-signal-architecture.md) §2.

### 3.2 `loadScene()` extension

`loadScene(scene)` adds these phases around `loadModel()`:

```
Phase 0 — materialise edits (ops → overlay + placements + cameraStart)
Phase 1 — resolve base URL ('empty' or scene.base.url)
Phase 2 — clear planner placements + sweep orphans
        ── stash _currentScene BEFORE loadModel so plugin onModelLoaded
           handlers (camera-startpos) can read it ──
Phase 3 — loadModel(url, { overlay })          ← emits 'model-loaded'
Phase 4 — planner.applyPlacements(...)
Phase 4b — keep planner authoring floor hidden
Phase 5 — whenLoadingIdle() again              ← in case step 4 queued work
        emit 'scene-loaded'
```

**Two events fire per scene load**, in this order:

1. `'model-loaded'` — base GLB is parsed, components built, plugins notified
2. `'scene-loaded'` — overlay edits + placements applied, scene fully ready

Subscribers that need the **final** placed-out world (e.g. per-scene camera
presets, scene-aware HMI overlays) should listen to `'scene-loaded'`.
Subscribers that only need the GLB and its `rv_extras` (e.g. raw signal
wiring, drive lists) can use `'model-loaded'`.

### 3.3 Error handling — known gap

Today there is **no** `'model-load-error'` event and no `'model-loading'`
event. If `loadGLB` throws, the promise from `loadModel` rejects but the
scene is in a half-cleared state (step 1 ran, steps 8–12 did not). Callers
must catch the rejection and decide on UX — there is no event-driven path
for plugins to observe load failures.

> If your plugin needs to gate UI on "load is in progress", subscribe to
> `'model-cleared'` and treat the first `'model-loaded'` after it as the
> load-complete signal. A dedicated pair of events is on the roadmap.

---

## 4. The Run Loop (`SimulationLoop`)

[src/core/engine/rv-simulation-loop.ts](src/core/engine/rv-simulation-loop.ts)
runs an **accumulator-based fixed-timestep** loop at 60 Hz (`fixedTimeStep =
1/60`). The loop is started in viewer construction and stopped only on
`dispose()` — `clearModel()` does **not** stop the loop.

### 4.1 Per-frame order

```
requestAnimationFrame / renderer.setAnimationLoop tick
│
├── If isPaused → accumulator = 0, skip fixed step
│   else        → accumulator += frameDt, while ≥ fixedTimeStep:
│                   onFixedUpdate(fixedTimeStep)  ───┐
│                                                   │
└── onRender(frameDt)                               │
                                                    │
       ┌────────────────────────────────────────────┘
       ▼  RVViewer.fixedUpdate(dt):
       │
       │  ── PRE STAGE (TickStage.PRE) ──────────────────────────────────
       │  1. playback.update(dt)             (DrivesRecorder playback, Active-gated)
       │  2. logicEngine.fixedUpdate(dt)     (LogicSteps, Active-gated)
       │  3. for each replayRecording:       (ReplayRecording, Active-gated)
       │       rr.fixedUpdate(dt)
       │
       │  4. _prePlugins[].onFixedUpdatePre(dt)      ← legacy plugin callbacks
       │       (ErraticDriver, replay, CAM, interface-write — set drive targets)
       │     + onTick(PRE) callbacks
       │
       │  ── SIM STAGE (TickStage.SIM) ──────────────────────────────────
       │  5. drives[].update(dt)             ← drive physics (motion + behaviors)
       │
       │  6. transportManager.update(dt)     (kinematic transport; skipped when
       │                                      a physics plugin handles transport)
       │
       │  7. transportManager.updateTextureAnimations(dt)   (always)
       │     tankFillManager.update()
       │     gizmoManager.tick(dt * 1000)
       │     pipeFlowManager.update(dt)
       │     + onTick(SIM) callbacks
       │
       │  ── POST STAGE (TickStage.POST) ─────────────────────────────────
       │  8. _postPlugins[].onFixedUpdatePost(dt)    ← legacy plugin callbacks
       │       (DriveRecorder, SensorMonitor, interface-read,
       │        chart sampling, event emission)
       │     + onTick(POST) callbacks
       │
       └─ Back to render
```

**Rules of thumb:**

- **Set drive targets** in `onFixedUpdatePre` or `onTick(TickStage.PRE)` —
  they will be honoured in the same tick.
- **Read drive results** in `onFixedUpdatePost` or `onTick(TickStage.POST)` —
  drives have already moved.
- **Plugins sort by `order` (lower = earlier).** Default `100`. Use
  `PLUGIN_ORDER` constants from `rv-plugin-order.ts` instead of magic numbers.
- A plugin with `handlesTransport: true` takes over kinematic transport;
  the core `transportManager.update(dt)` is skipped.
- `onRender(frameDt)` runs every animation frame regardless of pause state —
  the viewer stays interactive while paused.
- **Defensive iteration:** the pre/post plugin arrays are snapshotted before
  iteration. A plugin that removes itself during a tick does not corrupt the
  loop.

### 4.1b TickStage and simLoop.onTick()

As an alternative to `onFixedUpdatePre` / `onFixedUpdatePost` plugin callbacks,
use the `SimLoopFacade` accessible via `PluginContext`:

```typescript
import { TickStage } from './rv-tick-stages';
import { PLUGIN_ORDER } from './rv-plugin-order';

// In BaseViewerPlugin.init():
this.context.simLoop.onTick(TickStage.PRE, (dt) => {
  // Before drive physics — flush incoming signals here
}, PLUGIN_ORDER.INTERFACE_ADAPTER);  // optional order

this.context.simLoop.onTick(TickStage.POST, (dt) => {
  // After drive physics — sample data, emit events
});
```

`onFixedUpdatePre` / `onFixedUpdatePost` and `onTick()` coexist and run in
their declared order within each stage. Legacy plugins require no changes.

### 4.2 Pause semantics

When paused, the loop **drains the accumulator** (`accumulator = 0`). This
is deliberate: on resume, the simulation does not catch up by replaying
seconds of skipped ticks. Drives, sensors, and LogicSteps therefore "freeze
in place" rather than "fast-forward on resume".

---

## 5. Pause API

`RVViewer.setSimulationPaused(reason: string, paused: boolean)` is the
**only** supported way to pause/resume the fixed step.

### 5.1 Multi-reason pause set

`SimulationLoop` holds a `Set<string>` of active pause reasons. The
simulation runs **only when the set is empty**. Any caller can add a reason;
the loop resumes only after **every** reason has been released.

Conventions for `reason` strings:

| Reason | Owner |
|--------|-------|
| `'user'` | UI pause button |
| `'ar-placement'` | WebXR placement mode |
| `'layout-edit'` | Layout Planner edit mode |
| `'shared-view'` | Shared-view follower (multiuser) |
| `'kiosk-tour'` | Kiosk-tour transitions |
| `'maintenance-step'` | Maintenance overlay |

> **Best practice:** one plugin = one stable reason string. Same reason
> set/cleared multiple times is idempotent — only the set state matters.
> A plugin that owns a reason **must** release it in `dispose()` to avoid
> "stuck paused" after teardown.

### 5.2 Event: `'simulation-pause-changed'`

```typescript
viewer.on('simulation-pause-changed', ({ paused, reasons, reason }) => {
  // paused : new overall pause state (boolean)
  // reasons: snapshot of all active reasons (readonly string[])
  // reason : the specific reason that triggered THIS transition
});
```

**Fires only on the `idle ↔ paused` transition.** Adding or removing a
reason while the simulation is already paused does **not** emit. Re-entrant
calls from inside a handler (calling `setSimulationPaused` synchronously
from the listener) are suppressed for the nested emission — the set update
still happens.

### 5.3 Diagnostics

```typescript
viewer.isSimulationPaused              // boolean
viewer.simulationPauseReasons          // readonly string[]
viewer.clearPauseReasons()             // force-clear ALL (leak escape; logs warning)
viewer.clearPauseReasons('layout-edit')// force-clear a single leaked reason
```

`clearPauseReasons` is a **last-resort dev/debug escape** when a plugin
crashed before releasing its reason. Logs a warning so leaks are observable
in production.

---

## 6. Clear & Reset

The two operations are **not interchangeable**.

### 6.1 `clearModel()` — full teardown of the loaded scene

Steps in order:

1. `onModelCleared(viewer)` on every enabled plugin
2. Close context menu
3. Reset dynamic UI contexts (preserving config-initial ones)
4. `selectionManager.clear()` + `dispose()`
5. `raycastManager.dispose()`
6. Drop source-markers subscription
7. `transportManager.reset()` then null it **before** scene traverse
   (MUs share geometry with templates by reference)
8. Sweep all `_rvModelRoot`-tagged children from the scene; dispose
   geometries and materials (skipping `_rvShared` material singletons)
9. Null out `currentModel`, `drives`, `playback`, `replayRecordings`,
   `logicEngine`, `tankFillManager`, `pipeFlowManager`, `signalStore`,
   `registry`, `groups`, `autoFilters`, `componentEventDispatcher`
10. Dispose `gizmoManager`
11. Emit `'model-cleared'`

The `SimulationLoop` keeps running. `onFixedUpdate` is still called but has
no drives/transport to advance.

### 6.2 `resetSimulation()` — "new demo run" without unload

Effects:

- Clears all live MUs and resets transport counters (`totalSpawned`,
  `totalConsumed`)
- Resets all LogicSteps to `Idle` (`logicEngine.reset()`)

Intentionally **untouched**:

- **Drives** — stay at current position; conveyor textures do not snap back
- **Signals** — stay at current values (essential for Live mode — resetting
  would just be overwritten on the next tick and would briefly visualise
  stale data)
- **Pause state** — reset can be invoked while paused or running

**No event fires today.** Plugins that need to observe a reset must wrap
their own button/command. A dedicated `'simulation-reset'` event is on the
roadmap.

### 6.3 Side-by-side

| | drives | signals | MUs | LogicSteps | pause | camera | listeners |
|---|---|---|---|---|---|---|---|
| `resetSimulation()` | kept | kept | cleared | reset | kept | kept | kept |
| `clearModel()` | gone | gone | gone | gone | kept | kept | kept |
| `loadModel(newUrl)` | replaced | replaced | replaced | replaced | kept | kept | kept |
| `dispose()` | gone | gone | gone | gone | gone | gone | gone |

---

## 7. Connection State

`viewer._connectionState` tracks the overall Live/Direct connection. When
it flips, `'connection-state-changed'` fires and every enabled plugin
receives `onConnectionStateChanged(state, viewer)`.

```typescript
viewer.on('connection-state-changed', ({ state, previous }) => {
  // state, previous: 'Connected' | 'Disconnected'
});
```

This is the **viewer-wide** connection. Industrial-interface plugins
additionally emit `'interface-connected'` / `'interface-disconnected'` /
`'interface-error'` per-interface — see [doc-webviewer-interface.md](doc-webviewer-interface.md).

Drives, LogicSteps, ReplayRecordings, and the playback subsystem have an
`activeOnly` flag (`'EditorAndPlay'` / `'PlayMode'` / `'EditorOnly'`). The
fixed-update gate `isActiveForState(activeOnly, isConnected)` decides
whether they tick in the current connection state.

---

## 8. Plugin Lifecycle Hooks

The full plugin interface lives in [src/core/rv-plugin.ts](src/core/rv-plugin.ts).

| Hook | When |
|------|------|
| `init?(viewer, context?)` | Called synchronously inside `viewer.use()`, **before** any model load. Receives the `PluginContext` facade. `BaseViewerPlugin.init()` stores the context in `this.context`. |
| `onModelLoaded(result, viewer)` | After step 8 of §3.1 (state assigned), **before** `'model-loaded'` emits. Also called retroactively for plugins registered after a model is already loaded. |
| `onModelCleared(viewer)` | First step of `clearModel()`, **before** state is reset. |
| `onConnectionStateChanged(state, viewer)` | When viewer-wide connection flips. |
| `onFixedUpdatePre(dt)` | 60 Hz, before drive physics (TickStage.PRE). Use to set drive targets. |
| `onFixedUpdatePost(dt)` | 60 Hz, after drive physics + transport (TickStage.POST). Use to read results / sample data / emit events. |
| `onRender(frameDt)` | Per animation frame, after `renderer.render()`. |
| `dispose()` | Viewer teardown. **Must release any held pause reasons here.** |

For stage-based tick registration without subclassing, use `this.context.simLoop.onTick(stage, callback)` from inside `init()`. See §4.1b above.

Every callback is isolated with try/catch — a faulty plugin cannot freeze
the simulation. Disabled plugins (via UI or `_disabledIds`) are skipped for
all lifecycle callbacks except (current behaviour) `dispose`.

`order` controls invocation order in pre/post/render lists. Lower is
earlier. Default `100`. `core: true` plugins always activate even in
selective mode (`rv_plugins` declared on the GLB).

---

## 9. Final Teardown — `dispose()`

```
viewer.dispose():
  1. for each plugin: callPlugin(p, 'dispose')
  2. loop.stop()
  3. clearModel()                ← emits 'model-cleared'
  4. window.removeEventListener('resize', …)
  5. resizeObserver.disconnect()
  6. controls.dispose()
  7. renderer.dispose()
  8. stats.dispose() (if active)
  9. removeAllListeners()
```

After `dispose()` the viewer instance is unusable. Plugin `dispose` runs
**first**, so plugins still have a live `viewer` reference while cleaning
up. After `removeAllListeners()`, any deferred async work that later tries
to emit will silently no-op.

---

## 10. Lifecycle Event Reference

Snapshot of the lifecycle-relevant events from `ViewerEvents` in
[src/core/rv-viewer-events.ts](src/core/rv-viewer-events.ts).
For the complete list (hover, selection, charts, XR, FPV, layout, etc.) see
[doc-extending-webviewer.md](doc-extending-webviewer.md) §4.

| Event | Payload | Fires when | Typical subscriber |
|-------|---------|-----------|--------------------|
| `'model-loaded'` | `{ result: LoadResult }` | After `loadModel()` step 12 | HMI tiles, KPI cards, MCP bridge, chart subscribers |
| `'model-cleared'` | `void` | First step of `clearModel()` | HMI reset, listener cleanup |
| `'scene-loaded'` | `{ scene: RvScene }` | After `loadScene()` Phase 5 | camera-startpos plugin, scene-aware overlays |
| `'simulation-pause-changed'` | `{ paused, reasons, reason }` | On `idle ↔ paused` transition only | External PLC I/O, animations, recorders |
| `'connection-state-changed'` | `{ state, previous }` | Viewer-wide Live/Direct flip | Status badges, reconnection UX |
| `'interface-connected'` | `{ interfaceId, type }` | Industrial interface attaches | Connection status per interface |
| `'interface-disconnected'` | `{ interfaceId, reason? }` | Industrial interface drops | Reconnect UX, alarm raising |
| `'interface-error'` | `{ interfaceId, error }` | Interface reports an error | Log panel, alarm system |
| `'component-event'` | `{ componentType, kind, path, payload? }` | Generic component lifecycle event: `mu/spawned`, `mu/consumed`, `sensor/changed`, … | OEE / parts counters, sensor monitor, plugin charts |

### Known gaps (events that do **not** exist yet)

- `'model-loading'` — would let plugins show a spinner during step 3 of §3.1
- `'model-load-error'` — see §3.3
- `'simulation-reset'` — see §6.2

If you need one of these today, the workaround is documented inline above.

---

## 11. Cross-References

- [doc-extending-webviewer.md](doc-extending-webviewer.md) — full plugin API,
  `ViewerEvents` reference, UI slot registration
- [doc-webviewer.md](doc-webviewer.md) — architecture overview, MCP control,
  reset semantics
- [doc-signal-architecture.md](doc-signal-architecture.md) — signal lifecycle,
  two-phase component construction
- [doc-persistence.md](doc-persistence.md) — when `scene-loaded` is the right
  hook for storage operations
- [doc-webviewer-interface.md](doc-webviewer-interface.md) — connection
  lifecycle for industrial interfaces (per-interface, separate from
  viewer-wide `'connection-state-changed'`)
- [src/core/rv-viewer.ts](src/core/rv-viewer.ts) — canonical source
- [src/core/rv-plugin.ts](src/core/rv-plugin.ts) — plugin interface
- [src/core/engine/rv-simulation-loop.ts](src/core/engine/rv-simulation-loop.ts)
  — fixed-step accumulator
