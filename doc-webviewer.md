# realvirtual WEB

**The open standard for browser-based 3D-HMI and Digital Twins in manufacturing.**

realvirtual WEB brings industrial 3D visualization to the browser — load realvirtual GLB exports and run transport simulation, sensor collision, LogicStep sequencing, and drive animation with no installation required. WebGL, WebGPU, and WebXR (VR/AR) supported out of the box.

**One link. Any device. Live Digital Twin.** Share an interactive 3D model of your machine or production line with anyone — customers, operators, service technicians — across desktop, tablet, and VR/AR headsets.

**Built for manufacturing:**
- **3D HMI / operator dashboards** — Web-based HMI connected to real PLCs via WebSocket or MQTT. Live signal visualization, KPI overlays, drive monitoring — replacing desktop HMI applications.
- **Sales & presales** — Interactive 3D models that let prospects explore machines live in the browser. More convincing than slides, more accessible than installed software.
- **Maintenance & service** — Technicians open a link on their tablet, interact with 3D components, check sensor states and drive positions — on-site or remote.
- **Training & onboarding** — Operators learn machine behavior interactively before touching the real system.
- **Remote acceptance** — Share virtual commissioning models with customers for review and sign-off — worldwide, instantly.

> For building custom plugins and extending the viewer, see **[doc-extending-webviewer.md](doc-extending-webviewer.md)**.
> For how scenes, drafts, and edits are stored and resumed across reloads, see **[doc-persistence.md](doc-persistence.md)**.

## Quick Start

```bash
cd Assets/realvirtual-WebViewer~
npm install
npm run dev          # Vite dev server with HMR
```

Drop `.glb` files into `public/models/` — they appear automatically in the model selector.

```bash
npm run build        # Production build → dist/
npm run preview      # Preview production build
npm test             # Run browser tests (headless Chromium via Playwright)
npm run test:node    # Run Node.js tests (fs, glob, ESLint — see below)
npm run test:all     # Run both: Node tests + browser tests
npm run test:watch   # Watch mode
npm run lint         # ESLint (flat-config, boundaries/dependencies rule)
```

**Test naming convention:** Files matching `tests/*.node.test.ts` run in Node
environment (use `vitest.node.config.ts`). Files matching `tests/*.test.ts` run in the
browser environment. Use the Node config for tests that require `fs`, glob imports,
or the ESLint instance itself.

## Workspace Modes

realvirtual WEB is organized into **workspace modes** — switch them from the mode
dropdown in the top-left toolbar. Exactly one mode is active at a time; switching a
mode swaps both the active plugin set and the UI (each plugin declares its mode
membership via `plugin.modes`). The same model stays loaded across a switch.

| Mode | Purpose | What it adds |
|---|---|---|
| **HMI** (default) | Operate and monitor a running model — the delivery / 3D-HMI view. | Live PLC signals (WebSocket / MQTT / REST), KPI overlays, message panel, drive & sensor tooltips, camera presets, measurement. |
| **Planner** | Assemble and edit layouts by dragging reusable library objects (conveyors, robots, fixtures) onto a grid, snapping and positioning them with gizmos. Authoring, not operation. | Library panel, grid + snap toolbar, translate / rotate gizmos, snap-point connections. See [doc-layout-planner.md](doc-layout-planner.md). |
| **DES** | Discrete-event material-flow simulation for throughput and utilization analysis — fast, event-driven rather than per-frame. | DES workspace surface and material-flow statistics. |

**HMI vs Planner vs DES in one line:** HMI *runs and shows* a model, Planner *builds and arranges* it, DES *analyses material flow through* it.

Switch modes via the dropdown or the `?mode=hmi|planner|des` URL parameter, so a shared
link can boot directly into a workspace (e.g. `?scene=published:MyLayout&mode=planner`).
A locked-down deployment can pin a single mode (the dropdown then hides).

## Architecture

```
src/
├── main.ts                              # Entry: viewer creation, plugin registration, HMI init
├── rv-test-runner.ts                    # Dev-only in-browser test runner
├── core/
│   ├── rv-viewer.ts                     # RVViewer facade (scene, sim loop, plugins, events)
│   ├── rv-camera-manager.ts             # Camera (projection, animation, viewport offset)
│   ├── rv-visual-settings-manager.ts    # Lighting, shadows, tone mapping
│   ├── rv-app-config.ts                 # App config singleton (settings.json, lock mode)
│   ├── rv-plugin.ts                     # RVViewerPlugin interface (lifecycle + optional UI slots)
│   ├── rv-behavior.ts                   # RVBehavior abstract base class (MonoBehaviour-like)
│   ├── rv-events.ts                     # Typed EventEmitter<TEvents>
│   ├── rv-model-plugin-manager.ts       # Per-model dynamic plugin loading/unloading
│   ├── rv-ui-plugin.ts                  # UISlot types, UISlotEntry
│   ├── rv-ui-registry.ts                # UIPluginRegistry (slot component lookup)
│   ├── maintenance-parser.ts            # MaintenancePanel content parser
│   ├── types/plugin-types.ts            # Shared plugin API types (decouples core↔plugins)
│   ├── engine/                          # Simulation engine subsystems
│   │   ├── rv-scene-loader.ts           # GLB loading, two-phase component construction
│   │   ├── rv-node-registry.ts          # Object discovery (path, type, hierarchy)
│   │   ├── rv-component-registry.ts     # Schema-based auto-mapping (C# → TS) + capability registry
│   │   ├── rv-model-config.ts           # Per-model plugin config (modelname.json + GLB extras)
│   │   ├── rv-plugin-loader.ts          # Dynamic ESM plugin loading
│   │   ├── rv-simulation-loop.ts        # Fixed 60 Hz accumulator (XR-compatible)
│   │   ├── rv-debug.ts                  # Structured category-based debug logging + ring buffer
│   │   ├── rv-constants.ts              # Shared numeric constants (MM_TO_METERS, etc.)
│   │   ├── rv-coordinate-utils.ts       # Unity ↔ glTF coord conversions
│   │   ├── rv-active-only.ts            # Active-only sub-tree marker
│   │   │
│   │   │── # Components (ports of Unity C#) ───────────────────────────────
│   │   ├── rv-drive.ts                  # RVDrive (Drive.cs)
│   │   ├── rv-drive-simple.ts           # Drive_Simple
│   │   ├── rv-drive-cylinder.ts         # Drive_Cylinder
│   │   ├── rv-drives-playback.ts        # DrivesRecorder playback
│   │   ├── rv-drive-recorder.ts         # Drive data recording
│   │   ├── rv-replay-recording.ts       # ReplayRecording component
│   │   ├── rv-erratic.ts                # Drive_ErraticPosition
│   │   ├── rv-mu.ts                     # MovingUnit (incl. instanced MU pool)
│   │   ├── rv-source.ts                 # MU spawner
│   │   ├── rv-sink.ts                   # MU consumer
│   │   ├── rv-sensor.ts                 # AABB sensor
│   │   ├── rv-sensor-recorder.ts        # Sensor history sampler
│   │   ├── rv-transport-surface.ts      # Conveyor surface
│   │   ├── rv-transport-manager.ts      # Sources → surfaces → sensors → sinks
│   │   ├── rv-grip.ts / rv-grip-target.ts  # Gripping
│   │   ├── rv-signal-store.ts           # PLC signal pub/sub
│   │   ├── rv-signal-wiring.ts          # Signal routing (ConnectSignal)
│   │   ├── rv-connect-signal.ts         # Signal connection component
│   │   ├── rv-logic-step.ts             # LogicStep base + step types
│   │   ├── rv-logic-engine.ts           # LogicStep tree builder
│   │   ├── rv-pipe-flow.ts              # Process pipe flow propagation
│   │   ├── rv-tank-fill.ts              # Tank fill visualization
│   │   ├── rv-safety-door.ts            # Safety door / hazard zone halo
│   │   │
│   │   │── # Rendering, raycast, optimization ────────────────────────────
│   │   ├── rv-raycast-manager.ts        # Unified hover/click/XR raycaster
│   │   ├── rv-raycast-geometry.ts       # BVH groups + face-range hit resolution
│   │   ├── rv-highlight-manager.ts      # Highlight overlays + edge glow
│   │   ├── rv-selection-manager.ts      # Selection state + events
│   │   ├── rv-gizmo-manager.ts          # Generic 3D gizmo overlays (sensors, etc.)
│   │   ├── rv-static-merge-uber.ts      # Uber-material static merge
│   │   ├── rv-kinematic-merge-uber.ts   # Uber-material kinematic merge
│   │   ├── rv-uber-material.ts          # Uber-material (PBR atlas-shared)
│   │   ├── rv-material-dedup.ts         # Material deduplication
│   │   │
│   │   │── # Plumbing ────────────────────────────────────────────────────
│   │   ├── rv-aabb.ts                   # AABB primitive
│   │   ├── rv-ring-buffer.ts            # Generic RingBuffer
│   │   ├── rv-group-registry.ts         # Group definitions and visibility
│   │   ├── rv-xr-manager.ts             # WebXR session management
│   │   ├── rv-xr-hit-test.ts            # AR hit-test reticle
│   │   ├── rv-avatar-manager.ts         # Multiuser 3D avatar rendering
│   │   ├── rv-mcp-tools.ts              # @McpTool / @McpParam decorators
│   │   ├── rv-component-event-dispatcher.ts # Per-component onHover/onClick/onSelect routing
│   │   ├── rv-auto-filter-registry.ts   # Type-based auto filter registration
│   │   └── rv-extras-validator.ts       # Dev-mode GLB extras parity checker
│   └── hmi/                             # React HMI layout components (MUI-based)
│       ├── rv-app-config.ts             # App config singleton (settings.json, lock mode, plugins)
│       ├── ui-context-store.ts          # Context-aware UI visibility (activateContext, useUIVisible)
│       ├── context-menu-store.ts        # Plugin-extensible right-click context menus
│       ├── visual-settings-store.ts     # Visual settings (shadows, light, cameras)
│       ├── search-settings-store.ts     # Search/filter settings
│       ├── rv-storage-keys.ts           # Central localStorage key registry
│       ├── hmi-entry.ts                 # HMI initialization (React root)
│       ├── App.tsx                      # Root layout (minimal public shell)
│       ├── HMIShell.tsx                 # SlotRenderer for plugin UI
│       ├── KpiBar.tsx                   # Top KPI card container (slot: kpi-bar)
│       ├── ButtonPanel.tsx              # Left sidebar with nav buttons (slot: button-group)
│       ├── MessagePanel.tsx             # Right message panel (slot: messages)
│       ├── settings/                    # Settings panel tabs (extracted from TopBar)
│       │   ├── ModelTab.tsx             # Model/renderer selection
│       │   ├── VisualTab.tsx            # Lighting, shadows, tone mapping
│       │   ├── InterfacesTab.tsx        # WebSocket/MQTT/ctrlX config
│       │   ├── DevToolsTab.tsx          # FPS, benchmarks, debug
│       │   └── TestsTab.tsx             # Feature test runner
│       ├── TopBar.tsx, BottomBar.tsx     # Top/bottom bars
│       ├── KpiCard.tsx, TileCard.tsx     # Reusable card components
│       ├── ChartPanel.tsx               # Draggable/resizable chart overlay
│       ├── LeftPanel.tsx                # Standardized docked left panel
│       ├── LayoutLibraryPanel.tsx       # Layout planner library panel (multi-tab)
│       ├── MachineControlPanel.tsx      # Machine start/stop/mode control
│       ├── MaintenancePanel.tsx         # Maintenance step guides
│       ├── GroupsOverlay.tsx            # Group visibility toggles
│       ├── left-panel-manager.ts        # LeftPanel mutual exclusion coordinator
│       ├── layout-constants.ts          # Shared positioning constants
│       ├── shared-sx.ts                 # Reusable MUI sx style fragments
│       ├── chart-theme.ts              # Shared ECharts theme constants
│       ├── chart-constants.ts           # Chart color/size constants
│       ├── group-visibility-store.ts    # Group visibility state
│       └── tooltip/                       # Generic tooltip system
│           ├── tooltip-store.ts           # TooltipStore (useSyncExternalStore, priority resolution)
│           ├── tooltip-registry.ts        # TooltipContentRegistry (content-type → React, data resolvers, search resolvers)
│           ├── tooltip-utils.ts           # 3D→screen projection, viewport clamping
│           ├── TooltipLayer.tsx           # Tooltip renderer (glassmorphism, cursor/world/fixed)
│           ├── GenericTooltipController.tsx # Single headless controller — reads rv_extras + _rvPdfLinks, calls resolvers
│           ├── DriveTooltipContent.tsx    # Drive content provider + data resolver
│           ├── MetadataTooltipContent.tsx # RuntimeMetadata content provider
│           ├── PipeTooltipContent.tsx     # Pipe/flow content provider
│           ├── PumpTooltipContent.tsx     # Pump content provider
│           ├── TankTooltipContent.tsx     # Tank content provider
│           ├── ProcessingUnitTooltipContent.tsx
│           ├── PdfTooltipSection.tsx      # Generic PDF links section (auto-stacked)
│           └── index.ts                   # Barrel export
├── private-stubs/                       # No-op fallbacks when private folder absent
│   ├── private-plugins.ts              # export function registerPrivatePlugins() {} // no-op
│   └── custom/
│       └── hmi-entry.tsx               # Mounts core/hmi/App.tsx
├── interfaces/                          # Industrial interface plugins
│   ├── interface-manager.ts             # Interface coordinator (mutex, auto-connect)
│   ├── interface-settings-store.ts      # Interface settings (WS, MQTT, ctrlX)
│   ├── base-industrial-interface.ts     # Abstract interface base class
│   ├── websocket-realtime-interface.ts  # WebSocket Realtime protocol
│   └── ctrlx-interface.ts              # Bosch Rexroth ctrlX protocol
├── plugins/                             # Plugin implementations
│   │  # Core (always loaded) ──────────────────────────────────────────
│   ├── sensor-monitor-plugin.ts         # Event-based sensor monitoring
│   ├── transport-stats-plugin.ts        # 10 Hz RingBuffer transport stats
│   ├── camera-events-plugin.ts          # Camera animation done events
│   ├── drive-order-plugin.ts            # Topological CAM/Gear drive sort
│   ├── debug-endpoint-plugin.ts         # /__api/debug HTTP endpoint (dev)
│   ├── mcp-bridge-plugin.ts             # Claude MCP WebSocket bridge (dev)
│   │  # Optional / model-specific ─────────────────────────────────────
│   ├── multiuser-plugin.ts              # Multi-user presence + avatars + relay
│   ├── webxr-plugin.ts                  # WebXR VR/AR support
│   ├── fpv-plugin.tsx                   # First-person WASD navigation
│   ├── annotation-plugin.ts             # 3D markers, labels, drawing
│   ├── rv-annotation-renderer.ts        # Annotation render helpers
│   ├── aas-link-plugin.tsx              # AAS / AASX linking + tooltip
│   ├── aas-link-parser.ts               # AASX ZIP/index parser
│   ├── docs-browser-plugin.tsx          # PDF / docs browser panel
│   ├── camera-startpos-plugin.tsx       # Per-model camera start position
│   ├── blueprint-plugin.ts              # Blueprint / 2D plan view
│   ├── drive-recorder-plugin.ts         # Drive recording (runtime)
│   ├── sensor-recorder-plugin.ts        # Sensor history recording
│   ├── order-manager-plugin.tsx         # Production order manager
│   │  # Demo model plugins (loaded per-model) ─────────────────────────
│   ├── demo/
│   │   ├── index.ts                     # Barrel exports
│   │   ├── kpi-demo-plugin.ts           # OEE/Parts/CycleTime demo data
│   │   ├── demo-hmi-plugin.tsx          # Demo KPI cards, buttons, messages
│   │   ├── robot-alarm/                 # FANUC CRX "Ask AI" alarm assistant
│   │   ├── machine-control-plugin.ts    # Machine start/stop panel
│   │   ├── maintenance-plugin.ts        # Maintenance checklists
│   │   ├── test-axes-plugin.tsx         # Manual axis control slider
│   │   ├── perf-test-plugin.ts          # Performance benchmark (?perf)
│   │   ├── DriveChartOverlay.tsx, SensorChartOverlay.tsx
│   │   └── OeeChart.tsx, PartsChart.tsx, CycleTimeChart.tsx, EnergyChart.tsx
│   └── models/                          # Per-model plugin entry points
│       └── DemoRealvirtualWeb/index.ts  # Registers demo model plugins
├── hooks/                               # React hooks (see hook table in extending guide)
└── ...
```

**Tests** live in [tests/](tests/) (Vitest browser-mode) and [e2e/](e2e/) (Playwright). For the current inventory run `ls tests/*.test.*`; for a particular suite, run `npx vitest run -t '<name>'`.

> **Note:** The `~` suffix in `realvirtual-WebViewer~` prevents Unity from importing `node_modules/`.

## Data Flow

```
Unity GLB Export (UnityGLTF + GLBComponentSerializer)
  → GLB with node.extras.realvirtual.{Drive, TransportSurface, Sensor, Source, Sink, ...}
  → Three.js GLTFLoader → node.userData.realvirtual.*
  → rv-scene-loader.ts: Two-phase construction (register nodes, then build typed instances)
  → LoadResult { drives[], transportManager, signalStore, registry, logicEngine, playback }
  → viewer.use(plugin) — Register plugins
  → SimulationLoop (60Hz fixedUpdate):
      1. LogicEngine         — LogicStep sequencing
      2. Playback            — Recording playback
      3. Plugins Pre         — Set drive targets (ErraticDriver, ReplayRecording, etc.)
      4. Drive physics       — Sorted: master before slave (DriveOrderPlugin)
      5. Transport           — Sources → Surfaces → Sensors → Sinks
      6. Plugins Post        — Sample data (SensorMonitor, TransportStats, DriveRecorder)
      7. Plugins Render      — Camera events, visual overlays
```

## Plugin System

All extensions use the `RVViewerPlugin` interface. `viewer.use(plugin)` calls `plugin.init?(viewer, context)`, giving each plugin a `PluginContext` — a narrower facade over scene, camera, controls, simLoop, and the signal/node/transport live-getters.

For convenience, extend `BaseViewerPlugin` (context-aware) or `RVBehavior` (MonoBehaviour-like, also context-aware) instead of implementing `RVViewerPlugin` directly:

```typescript
// Raw interface (for minimal plugins)
interface RVViewerPlugin {
  readonly id: string;
  readonly order?: number;              // Execution order (lower = earlier)
  readonly handlesTransport?: boolean;  // true = replaces kinematic transport
  readonly core?: boolean;              // true = always active, even in selective mode
  readonly slots?: UISlotEntry[];       // Optional React components for HMI layout

  onModelLoaded?(result, viewer): void;
  onFixedUpdatePre?(dt): void;          // Before drive physics (60Hz)
  onFixedUpdatePost?(dt): void;         // After drive physics + transport (60Hz)
  onRender?(frameDt): void;
  dispose?(): void;
}

// Base class (recommended for most plugins)
abstract class RVBehavior implements RVViewerPlugin {
  abstract readonly id: string;
  protected viewer: RVViewer | null;    // Auto-managed
  protected get drives(): RVDrive[];
  protected get sensors(): RVSensor[];
  protected get signals(): SignalStore | null;
  // Signal access by name (primary)
  protected getSignalBool(name: string): boolean;
  protected setSignal(name: string, value: boolean | number): void;
  protected onSignalChanged(name: string, cb): void;  // Auto-cleanup
  // Generic component discovery (like GetComponent<T>)
  protected find<T>(type, path): T | null;
  protected findAll<T>(type): { path, instance: T }[];
  // Lifecycle hooks
  protected onStart?(result): void;     // Like MonoBehaviour.Start()
  protected onDestroy?(): void;         // Like MonoBehaviour.OnDestroy()
  protected onPreFixedUpdate?(dt): void;  // Before drive physics
  protected onLateFixedUpdate?(dt): void; // After drive physics
  protected onFrame?(frameDt): void;    // Per render frame
}
```

### Registration

Plugins are registered via `viewer.use()` (eager) or `viewer.registerLazy()` (code-split):

```typescript
// Eager registration — plugin is always bundled
viewer
  .use(new DriveOrderPlugin())
  .use(new SensorMonitorPlugin());

// Lazy registration — Vite code-splits into a separate chunk
viewer.registerLazy('maintenance', () => import('./plugins/maintenance-plugin'));
viewer.registerLazy('multiuser', () => import('./plugins/multiuser-plugin'));
```

Lazy plugins are only loaded when a model requests them (via `rv_plugins` or `modelname.json`). This keeps the initial bundle small.

### Plugin Resolution

When a model requests a plugin by ID, the viewer resolves it through a three-level chain:

```
1. Already registered (via use())        → return existing
2. Lazy built-in (via registerLazy())    → import chunk, instantiate, use()
3. External plugin (models/plugins/{id}.js) → dynamic import(), use()
4. Not found                             → null (no crash)
```

External plugins are pre-built `.js` files placed in `models/plugins/`. They must export a default class or instance implementing `RVViewerPlugin`.

### Activation Modes

Plugin activation depends on whether the model declares an `rv_plugins` list:

| Mode | Condition | Behavior |
|------|-----------|----------|
| **ALL-MODE** | No `rv_plugins` declared anywhere | All registered plugins receive `onModelLoaded` |
| **SELECTIVE-MODE** | `rv_plugins` declared in modelname.json, GLB extras, or settings.json | Only declared plugins + `core: true` plugins activate |

In selective mode, core plugins (drive sorting, sensor monitoring) always activate regardless of the `rv_plugins` list. This ensures essential infrastructure is never accidentally disabled.

See **[Model-Specific Plugin Configuration](#model-specific-plugin-configuration)** for how to declare `rv_plugins`.

Plugins with `slots` automatically register React components into HMI layout positions: `kpi-bar`, `button-group`, `messages`, `views`, `search-bar`, `settings-tab`, `toolbar-button`, `overlay`. See **[doc-extending-webviewer.md § 5](doc-extending-webviewer.md)** for the full slot reference.

### Plugin Tiers

| Tier | Loaded when | Can be removed | Examples |
|------|------------|----------------|----------|
| **Core** (`core: true`) | Always — survive model switches | No (`removePlugin()` blocked); use `disablePlugin()` | `drive-order`, `sensor-monitor`, `transport-stats`, `camera-events`, `rv-extras-editor`, `debug-endpoint`, `mcp-bridge` |
| **Global Private** | Always when private folder present | Yes | `layout-planner`, `des-plugin`, `des-hmi` |
| **Model-Specific** | Only when matching GLB is loaded | Yes (auto-removed on model switch) | `kpi-demo`, `demo-hmi`, `webxr`, `multiuser`, `fpv`, `annotations`, `aas-link`, `docs-browser`, `camera-startpos`, `blueprint`, `drive-recorder`, `sensor-recorder`, `order-manager`, `machine-control`, `maintenance` |

Model-specific plugins are defined in `plugins/index.ts` files per model folder. The `ModelPluginManager` auto-discovers them via `import.meta.glob` and loads/unloads them when models are switched. See **[doc-extending-webviewer.md](doc-extending-webviewer.md) § Per-Model Plugin System** for how to create model-specific plugins.

See **[doc-extending-webviewer.md](doc-extending-webviewer.md)** for detailed plugin development guide, UI slot system, event bus, hooks reference, and examples.

## Simulation Features

### Transport
Non-physics AABB-based transport (or Rapier.js physics when enabled). Sources spawn MUs, transport surfaces move them, sensors detect overlap, sinks consume.

#### Source markers (floor ring + label)
Every Source carries an always-visible **floor marker** — a thin semi-transparent ring on the ground plus a camera-oriented label sprite showing the source's node name. The marker is visible in **Play, Pause, AR and Layout-Planner modes** so spawn locations stay identifiable even before the first MU appears. Each source's ring/label color is derived deterministically from its name (golden-ratio hue hash), giving consistent visual separation across sessions.

Markers are children of the source node, so they follow Layout-Planner drags automatically. They are excluded from raycast hits via the central `RaycastManager.excludeFilters` (the same filter also catches the pause-ghost overlay), so clicking through the marker selects the underlying layout object instead.

Toggle globally via **Settings → Visual → Show source markers** (default ON) or programmatically via `viewer.setSourceMarkersVisible(false)` / the MCP tool `web_set_source_markers`. The choice persists to `localStorage['rv-source-markers-visible']`.

### LogicStep Engine
Port of Unity's LogicStep sequencing: SerialContainer, ParallelContainer, SetSignalBool, WaitForSignalBool, WaitForSensor, Delay, DriveToPosition, SetDriveSpeed, Enable.

### Signal Store
Central pub/sub for PLC signals (bool/int/float) with two lookup tables:
- **By name** (primary) — Signal.Name if set, otherwise node name (GameObject name). Used by plugins and HMI.
- **By path** (secondary) — Full hierarchy path. Used by GLB object references (ComponentRef) and internal bindings.

Change-only notification. Batch semantics for `setMany()`.

### Drive Physics
Ported from Drive.cs — acceleration/deceleration, position limits, rotation and linear movement. CAM/Gear master-slave dependencies resolved via topological sort.

### WebSensor (3D-HMI status indicator)
Pure UI marker authored in Unity (`Packages/io.realvirtual.professional/Runtime/WebViewerHMI/WebSensor.cs`) and rendered exclusively by realvirtual WEB (`rv-web-sensor.ts`). Four visual states — **Low / High / Warning / Error** plus an **Unbound** fallback — driven by either:

- a **PLCOutputBool** (`SignalBool`) → `false=Low`, `true=High`, OR
- a **PLCOutputInt** (`SignalInt`) → mapped via flexible `IntStateMap` string (default `0=Low, 1=High, 2=Warning, 3=Error`)

ISA-101-aligned colors (grey / blue / amber / red), with amber blinking at 1 Hz and red at 2 Hz. The visualization is delegated to the generic `GizmoOverlayManager` and supports six shapes (box / transparent-shell / mesh-overlay / sphere / sprite / text). When `Label` is set, an additional camera-facing text gizmo renders the label above the node. See `Sensor isolation` below for the end-user control. For developer-side customization (corporate-design overrides, custom int-mapping defaults), see [doc-extending-webviewer.md § 19](./doc-extending-webviewer.md#19-websensor--initwebsensor-configuration-api).

### Sensor isolation (toolbar button)
A single **Isolate Sensors** toolbar button (in the `button-group` slot, registered via `web-sensor-plugin.tsx`) toggles sensor isolation mode. When active, non-sensor meshes are dimmed (opacity `0.55`) and desaturated so only the sensors stand out, and sensor labels are shown for identification. Click the button again to restore the normal view.

The isolation state persists in `localStorage` under key `rv-group-visibility` (field `isolatedAutoFilter`).

### Generic Gizmo Overlay System
The `GizmoOverlayManager` (`viewer.gizmoManager`) is a reusable infrastructure for any component that needs to render a visual overlay over its node. WebSensor is the first consumer; future Drive direction arrows, Grip volumes, Station zones, etc. can all use the same API. Material sharing keyed by `(color, opacity, depthTest, blinkHz)` keeps memory low; one central `tick()` loop modulates all blinking gizmos in sync. Gizmos are tagged onto the on-top overlay layer by default so they never contaminate SSAO (bloom/glow gizmos stay in the composer via `keepInComposer`); see [doc-extending-webviewer.md § 17 — "Keeping 3D UI out of SSAO"](./doc-extending-webviewer.md#17-gizmo-overlay-system-viewergizmomanager).

### Component Event Dispatcher
Per-component event callbacks for `onHover` / `onClick` / `onSelect` are routed centrally via `viewer.componentEventDispatcher` — components implement optional methods on the `RVComponent` interface and the dispatcher resolves which component matches each viewer-level event (via `node.userData._rvComponentInstance` + parent-chain walk). Exception-isolated and listener-leak-safe. See [doc-extending-webviewer.md § 18](./doc-extending-webviewer.md#18-component-event-dispatcher-viewercomponenteventdispatcher).

### AI Alarm Assistant (demo)
The standard demo ships a FANUC CRX alarm tile (`src/plugins/demo/robot-alarm/`) for **SYST-320 — Contact Force Exceeds Limit**. The card offers a prominent **Ask AI** button and a **History** icon button (badge = note count). Ask AI shows a short "analyzing" spinner, then types out a structured answer: diagnosis, recommended steps, a **live excerpt pulled from the bundled FANUC PDF** with a page deep-link, a summary of what previous operators did, and a **Sources** block whose entries open the manual at the cited page. The History dialog lists the operator notes and lets a visitor add their own (stored in `localStorage`); a new note is considered in the next answer. The assistant answer is generated client-side via an `AlarmAssistantProvider` seam — no backend — while the PDF excerpt and page links are real.

### Raycast System

Unified raycast pipeline (`rv-raycast-manager.ts`) consolidates hover, scene click, and XR controller raycasting into a single Three.js `Raycaster`. Hover is throttled at 50 ms.

**BVH-grouped geometry** (`rv-raycast-geometry.ts`):
Instead of iterating all scene meshes per ray, the loader builds **merged BVH groups**:

- **One merged BVH for all static meshes** — never animates, baked once.
- **One merged BVH per kinematic Drive group** — re-used as the drive moves; only the group transform updates.
- **`InstancedMesh` targets for MU pools** — single instanced draw, single BVH.

Each ray is tested against this small set of grouped geometries. Hit-to-node resolution uses **face-range binary search** (O(log n)) — the loader records, for every face range in a group, which `realvirtual` ancestor owns it. No ancestor walk-up at runtime.

**Hoverability is capability-driven**: `getCapabilities(type).hoverable` (from [rv-component-registry.ts](src/core/engine/rv-component-registry.ts)) decides whether a component type takes part in hover/click. There is no separate Three.js layer per type; the raycaster runs `layers.enableAll()`.

**Key features:**
- **Pointer hover**: Throttled at 50 ms, resolves the hit face to its registered `realvirtual` ancestor via face-range lookup.
- **XR controller ray**: `updateFromXRController(origin, direction)` for VR/AR controller raycasting.
- **AR tap selection**: 9-point sampling (`arTapRaycast()`) for touch tolerance on mobile AR.
- **Click detection**: `raycastForRVNode(e)` for scene click without altering hover state.
- **Exclude filters**: Skip highlight overlays, sensor viz meshes, and custom exclusions.
- **Highlight integration**: Automatic orange overlay + edge glow via `RVHighlightManager`.

**Highlight Manager** (`rv-highlight-manager.ts`):
- Semi-transparent orange fill overlay + glowing edge outlines
- Cached `EdgesGeometry` (WeakMap) for GC-free repeated highlights
- Two modes: static snapshot (brief hover) and tracked (overlays follow moving meshes)
- Single highlight slot — calling `highlight()` replaces the previous one

**Events emitted:**
- `object-hover` — `{ node, nodeType, nodePath, pointer, hitPoint, mesh }`
- `object-unhover` — `{ node, nodeType }`
- `object-click` — `{ node, nodeType, nodePath, pointer }`

### Tooltip System

Generic, extensible tooltip system (`core/hmi/tooltip/`) with **a single headless controller**, a content-type registry, and per-component **data resolvers**. New tooltip types are added by registering a content provider + a data resolver — no per-type controllers.

**Architecture:**

```
GenericTooltipController (single, headless)
    ├─ reads node.userData.realvirtual (rv_extras keys)
    ├─ for each key → getCapabilities(key).tooltipType
    ├─ tooltipRegistry.getDataResolver(tooltipType) → data
    └─ tooltipStore.show({ id, data, mode, cursorPos, priority })
                ↓
         TooltipLayer (renderer)
                ↓
         tooltipRegistry.getProvider(contentType)  →  Content Provider (React)
```

The same controller also auto-attaches a **PDF links section** (`PdfTooltipSection`) at the bottom whenever `node.userData._rvPdfLinks` is non-empty.

**Three positioning modes:**
- **cursor** — Follows mouse pointer (ref-based updates, no React re-render on move)
- **world** — Projects a 3D `Object3D` to screen coordinates (for focused/selected objects)
- **fixed** — Uses a fixed screen position

**Key design decisions:**
- **One controller for all types**: `GenericTooltipController` replaced the previous per-type controllers (Drive/Pipeline/Metadata/AAS).
- **Capability-driven dispatch**: which `rv_extras` keys produce a tooltip is decided by `getCapabilities(type).tooltipType` in [rv-component-registry.ts](src/core/engine/rv-component-registry.ts). No controller code per type.
- **Data-only store**: Holds typed data objects, not ReactNodes (avoids re-render storms)
- **Shallow-compare guard**: `show()` only notifies React when data fields actually change
- **Cursor position is ref-based**: Updated via `getCursorPos()`, polled at 100 ms — not in React state
- **Priority resolution**: When multiple tooltips are active, highest priority wins (lower `priority` number = higher)
- **useSyncExternalStore**: React 18+ pattern for efficient subscription without cascading renders

**Built-ins**: Drive, RuntimeMetadata, Pipe, Pump, Tank, ProcessingUnit, AASLink. Each ships a content provider + a data resolver.

**Adding a new tooltip type** (e.g., Sensor):

```typescript
// 1. Declare the capability — in rv-component-registry registration:
registerComponent({
  type: 'Sensor',
  // ... other fields ...
  capabilities: { hoverable: true, tooltipType: 'sensor' /* matches step 2 */ },
});

// 2. Register a content provider AND a data resolver — self-registers at module import
import { tooltipRegistry, type TooltipContentProps } from './core/hmi/tooltip/tooltip-registry';

function SensorTooltipContent({ data }: TooltipContentProps) {
  return <Typography>{data.sensorName}: {data.occupied ? 'Occupied' : 'Free'}</Typography>;
}

tooltipRegistry.register({ contentType: 'sensor', component: SensorTooltipContent });

tooltipRegistry.registerDataResolver('sensor', (node, viewer) => {
  // node has rv_extras.Sensor — derive what to display
  const path = viewer.registry.pathFor(node) ?? node.name;
  const sensor = viewer.sensors.find(s => s.path === path);
  if (!sensor) return null;
  return { type: 'sensor', sensorName: node.name, occupied: sensor.occupied };
});

// 3. Side-effect-import the content module so registration runs (in App.tsx)
import './core/hmi/tooltip/SensorTooltipContent';
```

That's it — the single `GenericTooltipController` will now show the sensor tooltip on hover and on selection (pinned). No controller code to write.

**React hook:**
```typescript
import { useTooltipState } from './hooks/use-tooltip';
const { active } = useTooltipState();  // current tooltip or null
```

### Hierarchy Panel

The Hierarchy Panel (left dockable panel, owned by `RvExtrasEditorPlugin`) renders a tree of every node carrying `userData.realvirtual` plus the live overlay-override state. Two view modes:

- **All** — full tree with expand/collapse. Maps directly to the Three.js scene graph for components, and lazily injects extra rows for the inner structure of placed LayoutObjects (see below).
- **Drives / Sensors / Signals / Logic** — flat, virtualised view filtered by component family. Logic mode preserves container indentation.

#### LayoutObject expand behavior

Placed catalog items (LayoutObjects from the Layout Planner) are expandable like normal GLB nodes. When the user opens the chevron on a LayoutObject:

- Inner nodes that carry their own `userData.realvirtual` (drives, sensors, signals, etc.) appear as normal child rows and route through the Property Inspector as standalone selections.
- Mesh-only descendants (no `userData.realvirtual`) appear as dimmed/italic rows. They are selectable for highlight + Transform-only inspection.
- Sub-paths are registered on demand into the `NodeRegistry`, so plugins that query by path (`viewer.registry.getNode('RC/Drive-Lin-X')`) see them as first-class nodes.

Selection sources differentiate intent:

- 3D-viewport picks resolve up to the LayoutObject root (so the whole placed object highlights and lifts together).
- Tree clicks keep the explicit sub-path, exposing nested drive properties to the inspector.

When the LayoutObject's `Locked` flag is set, edits on any sub-path are rejected (`updateOverlayField` returns `false` and logs a warning). The root row itself stays editable so the user can unlock it without first reverting nested changes. Deleting a LayoutObject purges every overlay entry whose path falls under that subtree, so re-placing a catalog item with the same root name starts from defaults.

### WebXR (VR/AR)
VR on Quest, Vision Pro, PCVR. AR with hit-test surface detection and model placement. Uses `setAnimationLoop` for XR frame callback.

### Simulation Control (Play / Pause / Reset)

The TopBar SimController plugin exposes two buttons next to the existing tools:

- **Play / Pause toggle** — toggles the `'user'` pause reason via `viewer.setSimulationPaused('user', …)`. Pausing freezes every `onFixedUpdate` consumer (drives, transport, sources, sinks, LogicSteps). `onRender` keeps running so the scene stays interactive (camera, selection, gizmos).
- **Reset** — calls `viewer.resetSimulation()`, which clears all MUs and resets LogicSteps to `Idle`. Drives and signals are intentionally **not** reset. This matches "start a new demo run from a clean transport state" semantics.

Keyboard shortcuts (enabled by default, suppressed inside text inputs):

| Key       | Action                |
|-----------|-----------------------|
| `Space`   | Toggle Play / Pause   |
| `Shift+R` | Reset MUs + LogicSteps |

#### Pause is a multi-reason set

Pause is reference-counted by `string` reason. Multiple subsystems can hold it simultaneously, and the simulation only resumes after every holder releases its reason:

| Reason          | Holder                                       |
|-----------------|----------------------------------------------|
| `'user'`        | SimController Play/Pause button (+ shortcut) |
| `'layout-edit'` | Layout-Planner while the planner is active   |
| `'ar-placement'`| WebXR plugin while placing the model in AR   |

The Pause-Badge in the TopBar shows the active reasons live (`paused: user, layout-edit`) so it's easy to debug why the simulation is frozen.

#### Live mode

In Live mode, the WebSocket / MQTT / REST interface listeners **continue to write** into the `SignalStore` while the simulation is paused. Drives and components do not consume those values until the simulation resumes — the next `onFixedUpdate` tick picks up the **current** signal values, which means drives may visibly snap to a new target ("live snap") rather than gradually interpolating. This is intentional: it prevents the viewer from running on stale data after a long pause.

#### Dev-tools escape

If a plugin crashes mid-execution and leaks a pause reason, `viewer.clearPauseReasons(reason?)` is a manual override. Logs a `[SimControl]` warning. Use sparingly — the plugin's own `dispose()` should normally clean up its own reason.

#### MCP tools

When the MCP bridge is connected, the following tools are exposed:

| Tool                | Purpose                                         |
|---------------------|-------------------------------------------------|
| `sim_play_pause`    | Toggle or explicitly set the `'user'` reason   |
| `sim_reset`         | Clear MUs + LogicSteps (`resetSimulation()`)   |

## Renderer Support

- **WebGL** (default): Stable, all browsers
- **WebGPU**: Three.js r171+ `WebGPURenderer` with WebGL2 fallback

Selection persists via URL parameter (`?renderer=webgpu`) or localStorage.

## Deployment Configuration (settings.json)

Place a `settings.json` in `public/` (or next to `index.html` in production) to configure the viewer at deployment level. The file is fetched with cache-busting before React mounts, so settings apply immediately without flicker.

A documented example is provided in `public/settings.example.json` — copy it to `public/settings.json` and edit as needed.

### Settings Priority

```
URL Params  >  settings.json  >  localStorage  >  Code DEFAULTS
```

Each settings store (`visual`, `search`, `interface`) follows this 3-layer merge:
1. **DEFAULTS** — Hardcoded in each store module
2. **localStorage** — User's persisted preferences (overrides DEFAULTS)
3. **settings.json** — Deployment config (overrides localStorage per-field via `??`)

### Example settings.json

```json
{
  "lockSettings": true,
  "hideWelcomeModal": true,
  "defaultModel": "models/customer-line.glb",
  "visual": {
    "shadows": true,
    "shadowStrength": 0.5,
    "lightIntensity": 1.0
  },
  "interface": {
    "activeType": "websocket-realtime",
    "autoConnect": true,
    "wsAddress": "192.168.1.100",
    "wsPort": 7000
  }
}
```

### Lock Mode

- **`lockSettings: true`** — Hides the Settings gear button entirely. All `save*()` functions become no-ops (lock guard). End users see only the 3D scene and HMI overlay.
- **`lockedTabs: ["interfaces", "devtools"]`** — Hides only specific tabs in the Settings dialog. The gear button remains visible for unlocked tabs.
- **`hideWelcomeModal: true`** — Suppresses the welcome/about dialog on first visit.
- **`defaultModel: "models/demo.glb"`** — Pre-selects a model on load (can be a filename or full URL).

`lockSettings` is an admin override — it only comes from `settings.json` or the `?lockSettings` URL param, never from localStorage.

### Context Visibility Overrides

Control which HMI elements are visible or hidden based on active "contexts" (e.g. `fpv`, `planner`, `maintenance`, `xr`, `kiosk`). Rules are declared per UI element with `hiddenIn` and `shownOnlyIn`:

```json
{
  "uiVisibility": {
    "kpi-bar":      { "hiddenIn": ["fpv", "xr"] },
    "bottom-bar":   { "hiddenIn": ["fpv", "xr", "planner"] },
    "button-panel": { "hiddenIn": ["xr"] },
    "top-bar":      { "hiddenIn": ["xr"] },
    "messages":     { "hiddenIn": ["fpv", "planner"] },
    "views":        { "hiddenIn": ["fpv", "planner"] },
    "kiosk-overlay": { "shownOnlyIn": ["kiosk"] }
  }
}
```

**Rule semantics:**
- `hiddenIn: ["fpv", "xr"]` — element is hidden when ANY of these contexts is active
- `shownOnlyIn: ["kiosk"]` — element is visible ONLY when ALL listed contexts are active
- No rule → always visible (default)
- Rules compose with the existing `H` key HMI toggle via AND logic

**Built-in contexts:** `fpv` (first-person view), `planner` (layout planner), `maintenance`, `xr` (VR/AR), `kiosk`

Plugins activate/deactivate contexts programmatically:

```typescript
import { activateContext, deactivateContext, setContext } from './core/hmi/ui-context-store';

activateContext('fpv');     // Hides elements with hiddenIn: ['fpv']
deactivateContext('fpv');   // Restores visibility
setContext('kiosk', true);  // Convenience toggle
```

React components subscribe via the `useUIVisible()` hook:

```typescript
import { useUIVisible } from './core/hmi/ui-context-store';

function KpiBar() {
  const visible = useUIVisible('kpi-bar', { hiddenIn: ['fpv', 'xr'] });
  if (!visible) return null;
  // ...
}
```

### URL Parameter Overrides

| Parameter | Effect |
|-----------|--------|
| `?lockSettings` | Locks settings (highest priority) |
| `?lockSettings=false` | Explicitly unlocks |
| `?model=models/demo.glb` | Load specific model |
| `?renderer=webgpu` | Use WebGPU renderer |

### API (for plugins/custom code)

```typescript
import { getAppConfig, isSettingsLocked, isTabLocked } from './core/hmi/rv-app-config';

// Read config values
const config = getAppConfig();
if (config.interface?.autoConnect) { /* ... */ }

// Check lock state
if (isSettingsLocked()) { /* hide settings UI */ }
if (isTabLocked('interfaces')) { /* hide interfaces tab */ }
```

### How Stores Use Config

Each settings store internally calls `getAppConfig()` — no signature changes needed at call sites:

```typescript
// In loadVisualSettings():
const fromStorage = loadFromLocalStorage();           // Layer 1+2
const override = getAppConfig().visual;                // Layer 3
if (!override) return fromStorage;
return {
  shadows: override.shadows ?? fromStorage.shadows,    // config wins if set
  lightIntensity: override.lightIntensity ?? fromStorage.lightIntensity,
  // ...
};

// In saveVisualSettings():
if (isSettingsLocked()) return;  // Lock guard — no-op when locked
localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
```

## Publishing

### Public Demo

The standard publish workflow deploys to `https://web.realvirtual.io/{demoName}/`:

1. **Unity:** Tools → realvirtual → Export → WebViewer Tools → Publish tab
2. Select provider (Bunny CDN), enter demo name, export scene, click Publish
3. The viewer app + GLB are uploaded to the CDN

Or via Claude: `/deploy-web`

### Private Projects

Private projects publish to **unguessable URLs** at `https://web.realvirtual.io/{code}/` where `{code}` is a 32-character hex string (128-bit entropy). Each project is fully self-contained — its own GLB models, plugins, and settings.

**Local project structure:**

```
Assets/realvirtual-WebViewer-Private~/projects/
  mauser3dhmi/                        # Project folder
    project.json                      # Metadata: name, code, settings
    index.ts                          # Project-level plugins (optional)
    models/
      CL Digital Twin V100.glb        # Customer-specific GLBs
    models/CL Digital Twin V100/
      index.ts                        # Model-specific plugins (optional)
    plugins/
      customer-hmi.ts                 # Plugin source files
```

**project.json format:**

```json
{
  "name": "Mauser 3D HMI",
  "code": "a9d6c728c2a7006e52e55c03a174efbf",
  "created": "2026-04-03",
  "lastPublished": "",
  "settings": {
    "defaultModel": "CL Digital Twin V100.glb"
  }
}
```

**Unity workflow:**

1. Open the **Private** tab in WebViewer Tools
2. Click **New Project** (or create the folder structure manually)
3. Open your customer scene, click **Export Scene** on the project card
4. Optionally write an `index.ts` for project-specific plugins
5. Click **Publish** — stages, compiles plugins, uploads to CDN
6. Share the URL: `https://web.realvirtual.io/{code}/`

Or via Claude: `/deploy-web-private`

**How it works:**

- The shared app bundle (`index.html`, `assets/`) is copied from `dist/` — no separate Vite build per project
- Project `index.ts` is compiled to `project-plugin.js` via esbuild (<1s)
- Model-specific `index.ts` compiled to `model-plugin.js` in the model's subfolder
- At runtime, the viewer loads `project-plugin.js` and `model-plugin.js` via dynamic `import()` and calls `setup(viewer)`
- Customer GLBs never touch `public/models/` — they stay in the private project folder

### Project-Specific Plugins (index.ts)

Project plugins control which plugins are active and can disable standard plugins. The viewer instance is injected — no direct imports from the app source needed.

**Project-level** (applies to all models in the project):

```ts
import type { RVViewer } from 'realvirtual-webviewer';
import { CustomerHmiPlugin } from './plugins/customer-hmi';

export default function setup(viewer: RVViewer): void {
  viewer.use(new CustomerHmiPlugin());
  viewer.disablePlugin('kpi-demo');      // Disable standard plugins
  viewer.disablePlugin('test-axes');
}
```

**Model-level** (applies only to a specific model):

```ts
import type { RVViewer } from 'realvirtual-webviewer';

export default function setup(viewer: RVViewer): void {
  viewer.disablePlugin('sensor-monitor');  // Not needed for this model
}
```

**`disablePlugin(id)` API:**

- Removes the plugin from all tick callbacks (`onFixedUpdatePre/Post`, `onRender`)
- Skips the plugin in lifecycle callbacks (`onModelLoaded`, `onModelCleared`, `onConnectionStateChanged`)
- Core plugins (`core: true`) cannot be disabled
- `dispose()` is still called for disabled plugins (prevents memory leaks)

### CDN Structure

```
https://web.realvirtual.io/
  demo/                              # Public demo
    index.html, assets/*, models/demo.glb
  a9d6c728c2a7006e52e55c03a174efbf/  # Private project (root-level)
    index.html                       # Same app bundle
    assets/                          # Same JS/CSS
    project-plugin.js                # Compiled from project index.ts
    models/
      CL Digital Twin V100.glb       # Customer-specific
    settings.json                    # Project-specific config
```

Security is based on URL unguessability (128-bit entropy, same principle as Google Docs share links). HTTPS is enforced by Bunny CDN.

## GLB Extras Format

The GLB export stores component data in `node.extras.realvirtual`:

```json
{
  "extras": {
    "realvirtual": {
      "Drive": { "Direction": "LinearX", "TargetSpeed": 500.0, "Acceleration": 100.0 },
      "TransportSurface": { "SurfaceSpeed": 500.0, "BoxCollider": { "center": [0,0.5,0], "size": [2,0.1,0.5] } },
      "Sensor": { "BoxCollider": { "center": [0,0,0], "size": [0.1,0.2,0.5] } }
    }
  }
}
```

Enums as strings, component references as `{ type: "ComponentReference", path: "...", componentType: "..." }`.

## Testing

Tests run in real Chromium via Vitest + Playwright:

```bash
npm test              # All tests, headless
npm run test:watch    # Watch mode
npx tsc --noEmit     # Type check only
```

Test GLB: Export from Unity demo scene → `public/models/tests.glb`.

Test files live in [tests/](tests/) (Vitest, browser-mode) and [e2e/](e2e/) (Playwright). Run `ls tests/*.test.*` for the current inventory — counts move every release, so no totals are kept here.

## Debug Logging

Category-based structured logging via `rv-debug.ts`. Zero overhead in production.

```
?debug=all              # URL parameter
?debug=playback,loader  # Specific categories
```

Categories: `loader`, `playback`, `drive`, `transport`, `sensor`, `logic`, `signal`, `erratic`, `parity`

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| three | ^0.171.0 | 3D rendering (WebGL + WebGPU + WebXR) |
| react + react-dom | ^19 | HMI overlay |
| @mui/material | ^7 | UI components |
| echarts | ^5 | Charts |
| vite | ^6.1.0 | Build tool + dev server |
| vitest | ^4 | Test runner |
| typescript | ^5.7 | Compiler |

## Camera Controls

- **Right mouse**: Orbit
- **Middle mouse**: Pan
- **Scroll**: Zoom
- Damping enabled (factor 0.08)
- Auto-fit to model bounding box after load

## Known Limitations

- `controllerScale` hardcoded to 1000 (mm→m)
- Only `Drive_ErraticPosition` behavior animated (other DriveBehaviours not ported)
- Materials may differ from Unity URP (PBR mapping differences)
- OnSignal spawn mode not implemented for Sources

## Multiuser

realvirtual WEB supports real-time multiuser sessions where multiple users see each other as avatars in the same 3D scene. Each user's camera position is shared and rendered as a colored sphere with a name label.

### Quick Start

1. Add the `MultiplayerWEB` component to any GameObject in your Unity scene
2. Press Play — the WebSocket server starts on Port 7000
3. Open realvirtual WEB, click the Multiuser button in the top bar
4. Enter the server URL (e.g., `ws://192.168.1.5:7000`) and your name
5. Click Connect — you will see other connected users as avatars

### Features

- **VR/AR Avatars**: VR users show head + controller positions
- **Roles**: Operator (can control signals and drives) vs Observer (watch only)
- **Late Join**: New users receive the complete simulation state (all signal values, drive positions, and current avatars)
- **Cursor Rays**: See where other users are pointing in the 3D scene
- **URL Join**: Share `?server=ws://host:7000&name=User` links for instant session entry
- **Rate limiting**: Max 100 messages/second per client on the Unity side; outgoing avatar updates capped at 20 Hz on the browser side
- **Auto-reconnect**: The browser client reconnects automatically after a 2 s delay

### Web-only Mode (No Unity)

For sessions without a running Unity instance, point realvirtual WEB at a standalone relay server. The relay source lives in a separate repository; realvirtual WEB ships with a default hosted relay (`wss://download.realvirtual.io/relay`) configured in [multiuser-settings-store.ts](src/core/hmi/multiuser-settings-store.ts). Switch a session into relay mode via the Multiuser settings tab or by passing `?server=wss://...&joinCode=...` on the URL.

### Microsoft Teams Integration

realvirtual WEB runs natively inside Microsoft Teams as an interactive app — no screen sharing needed. Share 3D digital twins directly in meetings, channels, and chats.

**What it does:**
- **Meeting stage sharing** — Share the 3D viewer to the meeting stage. All participants can orbit, pan, and zoom the model independently — including external guests who are not in your organization.
- **Personal tab** — Pin the viewer in your Teams sidebar for quick access.
- **Channel tab** — Add the viewer to any channel. Configure which model to display per channel via the config page.

**Setup:**

1. Build the Teams app package:
   ```bash
   cd teams-app
   powershell.exe Compress-Archive -Path manifest.json,color.png,outline.png -DestinationPath realvirtual-web-teams.zip
   ```

2. Install in Teams:
   - **Personal**: Teams → Apps → Manage your apps → Upload a custom app → select the zip
   - **Organization-wide**: Teams Admin Center → Manage apps → Upload new app

3. Share in a meeting:
   - Click **Share** in the meeting toolbar
   - Select **realvirtual WEB** from the app list
   - The 3D viewer opens on the meeting stage for all participants

**Key points:**
- Only the person sharing needs the app installed — guests see it automatically on the meeting stage
- External participants (outside your org) can interact with the shared 3D viewer
- The app loads from `https://web.realvirtual.io/demo/` — public URL, no VPN required
- Teams SDK initialization is automatic when `?teams=1` is in the URL
- The `teams-app/` directory contains `manifest.json`, `color.png` (192x192), and `outline.png` (32x32)

**Configurable tabs** allow per-channel model selection. The config page (`teams-config.html`) lets users set a custom model URL when adding the tab to a channel.

## Shared Constants

Centralized numeric constants in `rv-constants.ts` replace magic numbers across the codebase:

| Constant | Value | Purpose |
|----------|-------|---------|
| `MM_TO_METERS` | `1000` | Unity mm → Three.js meters conversion factor |
| `DRAG_THRESHOLD_PX` | `8` | Min pixel distance before pointerdown→move is treated as drag |
| `DEFAULT_DPR_CAP` | `1.5` | Device pixel ratio cap to limit GPU load on HiDPI screens |
| `lastPathSegment(path)` | — | Extracts last segment from hierarchy path (`"Root/Child/Leaf"` → `"Leaf"`) |

## Context Menus

Plugin-extensible right-click context menus on 3D objects. Plugins register menu items via `ContextMenuStore`; items are filtered by condition callbacks at open time, labels can be dynamic functions, and errors in conditions are caught and treated as `false`.

```typescript
import { contextMenuStore } from './core/hmi/context-menu-store';

// Register items from a plugin
contextMenuStore.register({
  pluginId: 'my-plugin',
  items: [
    {
      id: 'focus',
      label: 'Focus Camera',
      action: (target) => viewer.focusByPath(target.path),
      order: 10,
    },
    {
      id: 'inspect',
      label: (target) => `Inspect ${target.path.split('/').pop()}`,
      condition: (target) => target.types.includes('Drive'),
      action: (target) => openInspector(target.path),
      order: 20,
    },
  ],
});

// Unregister on plugin dispose
contextMenuStore.unregister('my-plugin');
```

The context menu opens on right-click (with drag-distance guard) and touch long-press (500ms). It renders via MUI `<Menu>` in `ContextMenuLayer.tsx`.

## Extending

For wiring drives, sensors, transports, signals and AAS links onto a GLB
without touching the engine, use **Component Behaviors** —
see **[doc-behaviors.md](doc-behaviors.md)** (one TypeScript file per GLB
in `src/behaviors/`, auto-discovered, with a naming convention
(`Drive-Lin-Y`, `Transport-X`, …) and sidecar JSON as alternative wiring
paths — no Unity marker required).

See **[doc-extending-webviewer.md](doc-extending-webviewer.md)** for:
- Plugin development (lifecycle callbacks, UI slots, events)
- React hooks reference
- UI slot system and layout
- Chart panel integration
- Testing patterns
- Existing plugins reference

Plugins can read deployment config via `getAppConfig()` from `rv-app-config.ts` to adjust behavior based on `settings.json` values. Custom tooltips can be added via `tooltipRegistry.register()` — see [Tooltip System](#tooltip-system) above.
