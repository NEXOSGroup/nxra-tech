// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVViewer — Public facade for the realvirtual Web Viewer core.
 *
 * Single entry point that owns the Three.js scene, simulation loop, and all
 * core subsystems. Framework-agnostic: no React, no MUI. Custom UIs bind
 * to this class via events and direct property access.
 *
 * Usage:
 *   const viewer = new RVViewer(document.getElementById('app'));
 *   await viewer.loadModel('./models/demo.glb');
 *   viewer.signalStore?.subscribe('ConveyorStart', console.log);
 *   viewer.on('object-hover', (data) => console.log(data?.path));
 */

import {
  Scene,
  PerspectiveCamera,
  OrthographicCamera,
  WebGLRenderer,
  AmbientLight,
  DirectionalLight,
  Color,
  Vector2,
  Vector3,
  Box3,
  Object3D,
  MOUSE,
  TOUCH,
  Mesh,
  MeshStandardMaterial,
  NoToneMapping,
  CanvasTexture,
  Spherical,
  Texture,
  Matrix4,
  Frustum,
} from 'three';
import type { Renderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import type { AOMode } from './hmi/visual-settings-store';
import { PostProcessingManager, type PostProcessingHost } from './rv-post-processing';
import { createGroundFade, drawCheckerPattern } from './engine/rv-ground-plane';
import type { ToneMappingType, ShadowQuality, ProjectionType, VisualSettings } from './hmi/visual-settings-store';
import {
  loadVisualSettings,
  getSourceMarkersVisible,
  setSourceMarkersVisible as setSourceMarkersVisibleStore,
  subscribeSourceMarkersVisible,
} from './hmi/visual-settings-store';
import { CameraManager, type ViewportOffset } from './rv-camera-manager';
import { VisualSettingsManager } from './rv-visual-settings-manager';
import Stats from 'stats-gl';

import { EventEmitter } from './rv-events';
import { debug, logInfo } from './engine/rv-debug';
import { loadModelSettingsConfig } from './hmi/rv-settings-bundle';
import { DRAG_THRESHOLD_PX, DEFAULT_DPR_CAP, NO_AO_LAYER } from './engine/rv-constants';
import { loadGLB, type LoadResult } from './engine/rv-scene-loader';
import type { RVExtrasOverlay } from './engine/rv-extras-overlay-store';
import type { RvScene } from './hmi/scene/rv-scene-types';
import type { PlacementsSnapshot } from './rv-shared-types';
import type { MultiuserSnapshot } from '../plugins/multiuser-plugin';
import type { McpBridgeSnapshot } from '../plugins/mcp-bridge-plugin';
import { buildRaycastGeometries } from './engine/rv-raycast-geometry';
import {
  loadModelJsonConfig,
  extractGlbPluginConfig,
  mergeModelConfig,
  type ModelConfig,
} from './engine/rv-model-config';
import { loadExternalPlugin } from './engine/rv-plugin-loader';
import type { ModelPluginManager } from './rv-model-plugin-manager';
import { SimulationLoop } from './engine/rv-simulation-loop';
import { RVHighlightManager } from './engine/rv-highlight-manager';
import { RVOutlineManager } from './engine/rv-outline-manager';
import { RaycastManager, type ObjectHoverData, type ObjectUnhoverData, type ObjectClickData, type HoverableType } from './engine/rv-raycast-manager';
import type { RVDrive } from './engine/rv-drive';
import type { RVTransportManager } from './engine/rv-transport-manager';
import type { SignalStore } from './engine/rv-signal-store';
import type { RVDrivesPlayback } from './engine/rv-drives-playback';
import type { RVReplayRecording } from './engine/rv-replay-recording';
import type { RVLogicEngine } from './engine/rv-logic-engine';
import type { NodeRegistry, NodeSearchResult } from './engine/rv-node-registry';
import { TankFillManager } from './engine/rv-tank-fill';
import { PipeFlowManager } from './engine/rv-pipe-flow';
import { GizmoOverlayManager } from './engine/rv-gizmo-manager';
import { ComponentEventDispatcher } from './engine/rv-component-event-dispatcher';
import type { GroupRegistry } from './engine/rv-group-registry';
import { AutoFilterRegistry } from './engine/rv-auto-filter-registry';
import {
  ISOLATE_FOCUS_LAYER,
  HIGHLIGHT_OVERLAY_LAYER,
  disableOverlayLayers,
  setOverlayLayersOnly,
} from './engine/rv-group-registry';
import {
  detectActiveGPU, enumerateOtherAdapters, isSameAsActive,
  analyzeGPU,
  type GPUInfo, type GPUAnalysis,
} from './engine/rv-gpu-info';
import { registerFilterSubscriber, loadSearchSettings, isTypeEnabled } from './hmi/search-settings-store';
import { getTypesWithCapability, getRegisteredCapabilities } from './engine/rv-component-registry';
import type { RVViewerPlugin } from './rv-plugin';
import type { ViewerEvents } from './rv-viewer-events';
import type { ViewerHost } from './engine/rv-viewer-host';
import { UIPluginRegistry } from './rv-ui-registry';
import { isActiveForState } from './engine/rv-active-only';
import { LeftPanelManager } from './hmi/left-panel-manager';
import { SelectionManager } from './engine/rv-selection-manager';
import { ContextMenuStore } from './hmi/context-menu-store';
import type { ContextMenuTarget } from './hmi/context-menu-store';
import type { SelectionSnapshot } from './engine/rv-selection-manager';
import { isMobileDevice } from '../hooks/use-mobile-layout';
import { resetDynamicContexts } from './hmi/ui-context-store';
import { getAppConfig } from './rv-app-config';
import { PluginContextImpl } from './rv-plugin-context';
import { SceneFacadeImpl } from './facades/scene-facade';
import { CameraFacadeImpl } from './facades/camera-facade';
import { ControlsFacadeImpl } from './facades/controls-facade';
import { SimLoopFacadeImpl } from './facades/sim-loop-facade';
import { TickStage } from './rv-tick-stages';
import { BehaviorManager } from './behaviors';
import {
  applyKinematicsSpec,
  createBindContext,
  type KinematicsSpec,
  type KinematizeReport,
  type RVBindContext,
  type BindContextHost,
} from './behavior-runtime';

// Base scene-background grayscale (0x9a9a9a / 255 ≈ 0.604). Multiplied by
// backgroundBrightness so brightness=1 reproduces the original default color.
const BG_BASE_SCALAR = 0x9a / 255;

// ─── Ground fade geometry ────────────────────────────────────────────────
// The floor is a square plane carrying a CIRCULAR alpha map: opaque disc in
// the middle, linear radial fade to transparent at the inscribed-circle edge.
//
// Both the plane SIZE and the alpha-map opaque/fade split are keyed off these
// constants (expressed as multiples of the model's half-extent in X/Z) so the
// two always stay in sync — change one number and the disc layout updates.
//   - FLOOR_FADE_START: world radius where the fade starts (opaque inside).
//   - FLOOR_FADE_END:   world radius where the fade reaches zero alpha.
// A long, gentle fade reads better than a hard cut — hence END >> START.
const FLOOR_FADE_START_RATIO = 1.5;  // × model max half-extent
const FLOOR_FADE_END_RATIO   = 6.0;  // × model max half-extent (fade length = 4.5×)

// ─── Plugin Error Isolation ──────────────────────────────────────────────

/**
 * Call a plugin method with error isolation. If the method doesn't exist
 * or throws, the error is logged with the plugin's ID and swallowed.
 * Exported for unit testing — only used internally by RVViewer.
 */
export function callPlugin(
  plugin: RVViewerPlugin,
  method: string,
  ...args: unknown[]
): void {
  const fn = (plugin as unknown as Record<string, unknown>)[method];
  if (typeof fn !== 'function') return;
  try {
    fn.apply(plugin, args);
  } catch (e) {
    console.error(`[RVViewer] Plugin '${plugin.id}' ${method} error:`, e);
  }
}

// ─── Public Types ───────────────────────────────────────────────────────

// Re-export ViewportOffset from CameraManager (public API backward compat)
export type { ViewportOffset } from './rv-camera-manager';

// Re-export extracted subsystems for backwards compatibility (plan-177 phase 7)
export { PostProcessingManager } from './rv-post-processing';
export type { PostProcessingHost } from './rv-post-processing';
export { createGroundFade, drawCheckerPattern } from './engine/rv-ground-plane';

/** @deprecated Import from './rv-viewer-events' directly. Re-exported here for
 *  backward compatibility with existing hooks; will be removed in a future major. */
export type { ViewerEvents } from './rv-viewer-events';

// SceneSource (discriminated union of GLB vs. Layout) was retired in favour of
// the unified `RvScene` model. The viewer now only deals with `RvScene`
// records — see `src/core/hmi/scene/rv-scene-types.ts`. Translation between
// any external API shapes and `RvScene` happens in `SceneStore`.

export interface RVViewerOptions {
  /** Use WebGPU renderer (falls back to WebGL if unavailable). Default: false */
  useWebGPU?: boolean;
  /** Show checkerboard ground plane. Default: true */
  ground?: boolean;
  /** Auto-resize on window resize. Default: true */
  autoResize?: boolean;
  /** Enable native MSAA antialiasing (constructor-only, requires page reload to change). Default: false */
  antialias?: boolean;
}

// ─── Navigation Helper ──────────────────────────────────────────────────

/**
 * Apply navigation-sensitivity settings (rotate/pan/zoom speed + damping) to an
 * OrbitControls-compatible object. Extracted as a free function so it can be
 * unit-tested against a plain mock object without WebGL/Three.js setup.
 */
export function applyNavigationSettingsToControls(
  controls: {
    rotateSpeed: number;
    panSpeed: number;
    zoomSpeed: number;
    dampingFactor: number;
  },
  s: Pick<VisualSettings, 'orbitRotateSpeed' | 'orbitPanSpeed' | 'orbitZoomSpeed' | 'orbitDampingFactor' | 'distanceAdaptiveNav'>,
): void {
  controls.rotateSpeed = s.orbitRotateSpeed;
  // When adaptive navigation is active, the AdaptiveNavPlugin owns zoomSpeed/panSpeed writes.
  if (!s.distanceAdaptiveNav) {
    controls.panSpeed = s.orbitPanSpeed;
    controls.zoomSpeed = s.orbitZoomSpeed;
  }
  controls.dampingFactor = s.orbitDampingFactor;
}

// ─── RVViewer ───────────────────────────────────────────────────────────

// Compile-time assertion: RVViewer must satisfy ViewerHost contract.
// Phase 2 of plan-182. If this fails, RVViewer broke the contract used by
// engine/rv-component-event-dispatcher and engine/rv-selection-manager.
type _RVViewer_satisfies_ViewerHost = RVViewer extends ViewerHost ? true : false;
const _rvViewerHostCheck: _RVViewer_satisfies_ViewerHost = true;
void _rvViewerHostCheck;  // suppress unused-warning

export class RVViewer extends EventEmitter<ViewerEvents> {
  // --- Three.js context (read-only for custom UIs) ---
  /**
   * @deprecated Phase 4b of plan-182: prefer typed helpers like `viewer.eachNode(fn)`
   * or `viewer.projectToScreen(node)` over direct `viewer.scene` access. Only ~15
   * core plugins (WebXR, layout-planner, annotation, fpv, etc.) have a legitimate
   * reason to use the raw Scene — those are whitelisted in plan-182 section 2.7.2.
   */
  readonly scene: Scene;
  private perspCamera!: PerspectiveCamera;
  private orthoCamera!: OrthographicCamera;
  private _activeCamera!: PerspectiveCamera | OrthographicCamera;
  /**
   * @deprecated Phase 4b of plan-182: prefer `viewer.getCameraState()` for reads,
   * `viewer.animateCameraTo()` for navigation. Direct camera access is only for
   * plugins handling custom view modes (FPV, WebXR, multiuser sync).
   */
  get camera(): PerspectiveCamera | OrthographicCamera { return this._activeCamera; }
  /**
   * @deprecated Phase 4b of plan-182: renderer access is only for plugins needing
   * `renderer.domElement` for raycasting/event-listeners (annotation, measurement,
   * fpv). Most HMI code should not access this directly.
   */
  readonly renderer: Renderer;
  /**
   * @deprecated Phase 4b of plan-182: prefer `viewer.setControlsConfig({...})` for
   * Settings-panel writes. Direct control access is only for plugins managing
   * drag-mode conflicts (layout-planner, annotation, measurement).
   */
  readonly controls: OrbitControls;
  readonly loop: SimulationLoop;
  private stats!: Stats;
  private statsReady = false;
  readonly isWebGPU: boolean;

  /** Whether native MSAA antialiasing is active (set at renderer creation, cannot change at runtime). */
  private _antialiasActive = false;
  /** Whether native MSAA antialiasing is active on the current renderer. */
  get antialiasActive(): boolean { return this._antialiasActive; }

  // --- Delegated Managers (internal implementation detail) ---
  /** @internal Camera projection, animation, and viewport offset logic. */
  private _cameraManager!: CameraManager;
  /** @internal Lighting, tone mapping, shadows, DPR settings. */
  private _visualSettings!: VisualSettingsManager;

  // --- Highlight system (always available) ---
  readonly highlighter: RVHighlightManager;

  // --- Outline system (post-process OutlinePass; WebGL only) ---
  /** Plugin-driven OutlinePass wrapper. `available` is false on WebGPU. */
  readonly outlineManager: RVOutlineManager;

  // --- Generic gizmo overlay system (always available) ---
  /** Central 3D-overlay/gizmo system. Used by WebSensor and other components. */
  readonly gizmoManager: GizmoOverlayManager;

  // --- Component event dispatcher (routes viewer events → per-component callbacks) ---
  /** Dispatches object-hover/clicked/selection-changed to RVComponent.onHover/onClick/onSelect. */
  componentEventDispatcher: ComponentEventDispatcher | null = null;

  // --- Connection State ---
  /** Global connection state — controls which subsystems run based on their ActiveOnly mode. */
  private _connectionState: 'Connected' | 'Disconnected' = 'Connected';

  /** Current connection state ('Connected' or 'Disconnected'). */
  get connectionState(): 'Connected' | 'Disconnected' { return this._connectionState; }

  /**
   * Set the global connection state. Notifies all plugins and emits
   * 'connection-state-changed' event. Subsystems are guarded in fixedUpdate().
   */
  setConnectionState(state: 'Connected' | 'Disconnected'): void {
    if (state === this._connectionState) return;
    const previous = this._connectionState;
    this._connectionState = state;

    // Notify plugins (skip disabled)
    for (const p of this._plugins) {
      if (this._disabledIds.has(p.id)) continue;
      callPlugin(p, 'onConnectionStateChanged', state, this);
    }

    this.emit('connection-state-changed', { state, previous });
  }

  // --- Simulation state (populated after loadModel) ---
  signalStore: SignalStore | null = null;
  registry: NodeRegistry | null = null;
  drives: RVDrive[] = [];
  /** Unified raycast manager (replaces the old driveHover). */
  raycastManager: RaycastManager | null = null;
  transportManager: RVTransportManager | null = null;
  logicEngine: RVLogicEngine | null = null;
  tankFillManager: TankFillManager | null = null;
  pipeFlowManager: PipeFlowManager | null = null;
  playback: RVDrivesPlayback | null = null;
  groups: GroupRegistry | null = null;
  autoFilters: AutoFilterRegistry | null = null;

  /**
   * @deprecated Use `viewer.raycastManager` instead. This getter returns
   * an adapter that delegates to RaycastManager for backward compatibility.
   */
  get driveHover(): {
    enabled: boolean;
    hoveredDrive: RVDrive | null;
    pointerClientX: number;
    pointerClientY: number;
    lastRayOrigin: Vector3 | null;
    lastRayDirection: Vector3 | null;
    setDriveTargets(drives: RVDrive[]): void;
    updateFromXRController(origin: Vector3, direction: Vector3): void;
    dispose(): void;
  } | null {
    if (!this.raycastManager) return null;
    const rm = this.raycastManager;
    const self = this;
    return {
      get enabled() { return rm.enabled; },
      set enabled(v: boolean) { rm.setEnabled(v); },
      get hoveredDrive() {
        if (!rm.hoveredNode || rm.hoveredNodeType !== 'Drive') return null;
        return self.registry?.findInParent<RVDrive>(rm.hoveredNode, 'Drive') ?? null;
      },
      get pointerClientX() { return rm.pointerClientX; },
      get pointerClientY() { return rm.pointerClientY; },
      get lastRayOrigin() { return rm.lastRayOrigin; },
      get lastRayDirection() { return rm.lastRayDirection; },
      setDriveTargets(_drives: RVDrive[]) {
        // No-op: grouped BVH raycast geometry replaces per-target registration
      },
      updateFromXRController(origin: Vector3, direction: Vector3) {
        rm.updateFromXRController(origin, direction);
      },
      dispose() {
        rm.dispose();
      },
    };
  }

  // --- Plugin System ---

  /** All registered core plugins. */
  private _plugins: RVViewerPlugin[] = [];
  /** Cached: only plugins with onFixedUpdatePre, sorted by order. */
  private _prePlugins: RVViewerPlugin[] = [];
  /** Cached: only plugins with onFixedUpdatePost, sorted by order. */
  private _postPlugins: RVViewerPlugin[] = [];
  /** Cached: only plugins with onRender, sorted by order. */
  private _renderPlugins: RVViewerPlugin[] = [];
  /** Flag: a plugin handles transport (kinematic transportManager.update is skipped). */
  private _physicsPluginActive = false;
  /** IDs of plugins that have been disabled via disablePlugin(). */
  private _disabledIds = new Set<string>();
  /** Last successful load result (for retroactive onModelLoaded). */
  private _lastLoadResult: LoadResult | null = null;
  /** Lazy plugin factories: ID → async import factory (code-split by Vite). */
  private _lazyFactories = new Map<string, () => Promise<{ default: unknown }>>();
  /** URL of the currently loaded model (for reloadModel). */
  private _currentModelUrl: string | null = null;
  /** Original model URL set by main.ts before loadModel (survives blob URL override). */
  pendingModelUrl: string | null = null;
  /** True while OrbitControls is actively rotating/panning/pinching. */
  private _isOrbiting = false;
  /** Pointer position at pointerdown — used for drag-distance threshold. */
  private _pointerDownPos: { x: number; y: number } | null = null;
  /** Right-button pointer position at pointerdown — used for context menu drag guard. */
  private _rightDownPos: { x: number; y: number } | null = null;
  /** Long-press timer ID for touch context menu. */
  private _longPressTimer: ReturnType<typeof setTimeout> | null = null;
  /** Stored position at touch start for long-press context menu. */
  private _longPressPos: { x: number; y: number } | null = null;

  /** Available model entries for the model selector UI. */
  availableModels: Array<{ url: string; label: string }> = [];

  /** UI plugin registry for React slot rendering. */
  readonly uiRegistry = new UIPluginRegistry();

  /** Centralized left-panel coordination (mutual exclusion, ButtonPanel offset). */
  readonly leftPanelManager = new LeftPanelManager();

  /** Central selection state (multi-select, Escape-to-deselect, selection highlights). */
  readonly selectionManager = new SelectionManager();

  /** Pending async work that must complete before `loadModel` / `loadScene`
   *  resolves to the caller. Drained via {@link whenLoadingIdle}; populated
   *  via {@link trackLoadingWork} by subsystems and plugins that kick off
   *  deferred async tasks during a load (env-map IBL generation, placement
   *  spawn, asset prefetch). Centralising the wait means the loading
   *  overlay stays up until the scene is fully ready to be revealed — no
   *  unlit-first-frame, no late lighting / placement pop-in. */
  private _loadingTasks: Promise<unknown>[] = [];

  /**
   * Register an async task that must complete before the next `loadModel`
   * or `loadScene` resolves to its caller. The task's resolution value is
   * ignored and rejections are swallowed (`Promise.allSettled`), so a slow
   * HDRI failing won't deadlock the loading overlay.
   *
   * Safe to call at any time:
   *   - viewer construction (env-map starts loading there);
   *   - inside `onModelLoaded` (plugins doing post-load async work);
   *   - inside another already-tracked task (cascades are awaited too —
   *     `whenLoadingIdle` drains in batches until the queue is empty).
   *
   * When no `loadModel`/`loadScene` is in flight, resolved tasks just sit
   * in the queue harmlessly until the next drain.
   */
  trackLoadingWork(p: Promise<unknown>): void {
    this._loadingTasks.push(p);
  }

  /**
   * Resolve when every currently-registered loading task has settled. Drains
   * in batches so tasks queued by other tasks (cascades) are awaited too.
   * Idempotent when the queue is empty.
   */
  async whenLoadingIdle(): Promise<void> {
    while (this._loadingTasks.length > 0) {
      const batch = this._loadingTasks.splice(0);
      await Promise.allSettled(batch);
    }
  }

  /** Plugin-extensible context menu (right-click / long-press). */
  readonly contextMenu = new ContextMenuStore();

  /**
   * BehaviorManager — owns all auto-discovered `src/behaviors/*.ts` modules.
   * On every `model-loaded` event, matching behaviors are invoked with a
   * fresh RVBindContext; on `model-cleared` all hooks/subscriptions made
   * during the bind are disposed.
   */
  readonly behaviors = new BehaviorManager();
  /** @internal — dispose function returned by `behaviors.attach()`. */
  private _behaviorsDetach: (() => void) | null = null;

  /**
   * Register a plugin. Sorted into cached lifecycle lists.
   * If the plugin has `slots`, its UI entries are auto-registered into the HMI.
   * Duplicate IDs are rejected with a warning. Chainable.
   */
  use(plugin: RVViewerPlugin): this {
    if (this._plugins.some((p) => p.id === plugin.id)) {
      console.warn(`[RVViewer] Plugin '${plugin.id}' already registered`);
      return this;
    }
    this._plugins.push(plugin);

    // Phase 4a of plan-182: Plugins können init?(viewer, context) implementieren um
    // den schmalen PluginContext statt vollem RVViewer zu erhalten. Optional & try/catch.
    if (typeof plugin.init === 'function') {
      try {
        plugin.init(this, this._pluginContext);
      } catch (e) {
        console.error(`[RVViewer] Plugin '${plugin.id}' init error:`, e);
      }
    }

    // Insert into cached lists sorted by order
    const insertSorted = (list: RVViewerPlugin[], p: RVViewerPlugin) => {
      list.push(p);
      list.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    };
    if (plugin.onFixedUpdatePre) insertSorted(this._prePlugins, plugin);
    if (plugin.onFixedUpdatePost) insertSorted(this._postPlugins, plugin);
    if (plugin.onRender) insertSorted(this._renderPlugins, plugin);

    if (plugin.handlesTransport) this._physicsPluginActive = true;

    // Auto-register UI slot entries if the plugin provides them
    if (plugin.slots && plugin.slots.length > 0) {
      this.uiRegistry.register(plugin);
    }

    // Retroactive: if model already loaded, call onModelLoaded immediately (skip disabled)
    if (this.drives.length > 0 && this._lastLoadResult && plugin.onModelLoaded && !this._disabledIds.has(plugin.id)) {
      try {
        plugin.onModelLoaded(this._lastLoadResult, this);
      } catch (e) {
        console.error(`[RVViewer] Plugin '${plugin.id}' onModelLoaded error:`, e);
      }
    }
    return this;
  }

  /** Type-safe plugin lookup by ID. */
  getPlugin<T extends RVViewerPlugin>(id: string): T | undefined {
    return this._plugins.find((p) => p.id === id) as T | undefined;
  }

  /**
   * Disable a plugin by ID. The plugin is removed from the cached pre/post/render
   * arrays and skipped in onModelLoaded, onModelCleared, and onConnectionStateChanged.
   * The plugin remains in _plugins so dispose() still runs (prevents memory leaks).
   */
  disablePlugin(id: string): void {
    this._prePlugins = this._prePlugins.filter(p => p.id !== id);
    this._postPlugins = this._postPlugins.filter(p => p.id !== id);
    this._renderPlugins = this._renderPlugins.filter(p => p.id !== id);
    this._disabledIds.add(id);
  }

  /**
   * Fully remove a non-core plugin: dispose, remove from all arrays,
   * unregister UI slots and context menu entries.
   * Core plugins (core: true) cannot be removed — use disablePlugin() instead.
   */
  removePlugin(id: string): boolean {
    const idx = this._plugins.findIndex(p => p.id === id);
    if (idx < 0) return false;
    const plugin = this._plugins[idx];
    if (plugin.core) {
      console.warn(`[RVViewer] Cannot remove core plugin '${id}' — use disablePlugin() instead`);
      return false;
    }
    if (plugin.dispose) {
      try { plugin.dispose(); } catch (e) {
        console.error(`[RVViewer] Plugin '${id}' dispose error:`, e);
      }
    }
    this._plugins.splice(idx, 1);
    this._prePlugins = this._prePlugins.filter(p => p.id !== id);
    this._postPlugins = this._postPlugins.filter(p => p.id !== id);
    this._renderPlugins = this._renderPlugins.filter(p => p.id !== id);
    this._disabledIds.delete(id);
    this.uiRegistry.unregister(id);
    this.contextMenu.unregister(id);
    // Re-evaluate physics plugin state
    this._physicsPluginActive = this._plugins.some(p => p.handlesTransport);
    return true;
  }

  /** Model plugin manager — handles per-model plugin loading/unloading. */
  modelPluginManager: ModelPluginManager | null = null;

  // ─── Sub-Facaden (Phase 4a of plan-182) ────────────────────────────────
  // Instanziiert am Ende des Constructors, niemals null während Viewer-Lifetime.
  // Plugins greifen über this._pluginContext.scene/.camera/etc. zu (NICHT direkt!).
  /** @internal */ _scene!: SceneFacadeImpl;
  /** @internal */ _camera!: CameraFacadeImpl;
  /** @internal */ _controls!: ControlsFacadeImpl;
  /** @internal */ _simLoop!: SimLoopFacadeImpl;
  // _transport ist lazy in PluginContextImpl gecacht — kein Feld auf RVViewer.

  // PluginContext-Instanz — wird in use() an Plugins via init?() durchgereicht.
  /** @internal */ _pluginContext!: PluginContextImpl;

  /**
   * Register a lazy plugin factory. The factory is only called when a model
   * actually requests the plugin (via rv_plugins / modelname.json).
   * Vite automatically code-splits lazy factories into separate chunks.
   */
  registerLazy(id: string, factory: () => Promise<{ default: unknown }>): this {
    this._lazyFactories.set(id, factory);
    return this;
  }

  /**
   * Resolve a plugin by ID through the three-level resolution chain:
   *   1. Already registered (via `use()`)  → return existing
   *   2. Lazy built-in (via `registerLazy()`) → import chunk, instantiate, register
   *   3. External plugin (`models/plugins/{id}.js`) → dynamic import, register
   *   4. Not found → return null (no crash)
   */
  async resolvePlugin(id: string): Promise<RVViewerPlugin | null> {
    // 1. Already registered?
    const existing = this._plugins.find(p => p.id === id);
    if (existing) return existing;

    // 2. Lazy built-in?
    const factory = this._lazyFactories.get(id);
    if (factory) {
      try {
        const mod = await factory();
        const PluginOrInstance = mod.default;
        const plugin = typeof PluginOrInstance === 'function'
          ? new (PluginOrInstance as new () => RVViewerPlugin)()
          : PluginOrInstance as RVViewerPlugin;
        if (plugin && plugin.id) {
          this.use(plugin);
          return plugin;
        }
      } catch (e) {
        console.warn(`[RVViewer] Failed to load lazy plugin '${id}':`, e);
      }
      return null;
    }

    // 3. External plugin?
    const baseUrl = this._currentModelUrl
      ? this._currentModelUrl.substring(0, this._currentModelUrl.lastIndexOf('/'))
      : '.';
    // loadExternalPlugin returns PluginLoadable (plan-182 Phase 2 — avoids rv-viewer.ts
    // cycle). External plugins are RVViewerPlugin by convention; cast is safe here.
    const loadedPlugin = await loadExternalPlugin(id, baseUrl);
    if (loadedPlugin) {
      const plugin = loadedPlugin as RVViewerPlugin;
      this.use(plugin);
      return plugin;
    }

    // 4. Not found
    console.warn(`[RVViewer] Plugin '${id}' not found (not registered, no lazy factory, no external)`);
    return null;
  }

  // ─── Exclusive Hover Mode ──────────────────────────────────────────

  /** The currently active exclusive hover mode (only this type is hoverable). null = all types. */
  private _exclusiveHoverMode: HoverableType | null = null;
  get exclusiveHoverMode(): HoverableType | null { return this._exclusiveHoverMode; }

  /**
   * Set an exclusive hover mode — only the specified type will be hoverable.
   * Pass null to restore default behavior (all registered types hoverable).
   * Any existing exclusive mode is automatically deactivated.
   */
  setExclusiveHoverMode(mode: HoverableType | null): void {
    if (mode === this._exclusiveHoverMode) return;
    this._exclusiveHoverMode = mode;

    if (!this.raycastManager) return;
    if (mode) {
      // Enable only the requested type, disable all others in the exclusive group
      for (const type of getTypesWithCapability('exclusiveHoverGroup')) {
        this.raycastManager.enableHoverType(type, type === mode);
      }
    } else {
      // Default: all exclusive-group types hoverable
      for (const type of getTypesWithCapability('exclusiveHoverGroup')) {
        this.raycastManager.enableHoverType(type, true);
      }
    }
    this.emit('exclusive-hover-mode', { mode });
  }

  // ─── Drive Chart ──────────────────────────────────────────────────

  /** Whether the drive chart overlay is open. */
  private _driveChartOpen = false;
  get driveChartOpen(): boolean { return this._driveChartOpen; }

  /** Toggle the drive chart overlay. Exclusive with other chart modes. */
  toggleDriveChart(forceOpen?: boolean): void {
    this._driveChartOpen = forceOpen ?? !this._driveChartOpen;
    if (this._driveChartOpen) {
      // Close other exclusive modes
      if (this._sensorChartOpen) {
        this._sensorChartOpen = false;
        this.emit('sensor-chart-toggle', { open: false });
      }
      this.setExclusiveHoverMode('Drive');
      // Isolate drives — dims non-drive geometry
      this.autoFilters?.isolate('Drive', { dimOpacity: 0.55, dimDesaturate: true });
      this.markShadowsDirty();
    } else {
      this.setExclusiveHoverMode(null);
      this.autoFilters?.showAll();
      this.markShadowsDirty();
    }
    this.emit('drive-chart-toggle', { open: this._driveChartOpen });
  }

  // ─── Sensor Chart ─────────────────────────────────────────────────

  /** Whether the sensor chart overlay is open. */
  private _sensorChartOpen = false;
  get sensorChartOpen(): boolean { return this._sensorChartOpen; }

  /** Toggle the sensor chart overlay. Exclusive with other chart modes. */
  toggleSensorChart(forceOpen?: boolean): void {
    this._sensorChartOpen = forceOpen ?? !this._sensorChartOpen;
    if (this._sensorChartOpen) {
      // Close other exclusive modes
      if (this._driveChartOpen) {
        this._driveChartOpen = false;
        this.emit('drive-chart-toggle', { open: false });
      }
      this.setExclusiveHoverMode('Sensor');
      const sensors = this.transportManager?.sensors ?? [];
      const nodes = sensors.map((s) => s.node);
      if (nodes.length > 0) {
        this.highlighter.highlightMultiple(nodes, { includeSensorViz: true });
        this.fitToNodes(nodes);
      }
    } else {
      this.setExclusiveHoverMode(null);
      this.highlighter.clear();
    }
    this.emit('sensor-chart-toggle', { open: this._sensorChartOpen });
  }

  /** Whether the groups overlay is open. */
  private _groupsOverlayOpen = false;
  get groupsOverlayOpen(): boolean { return this._groupsOverlayOpen; }

  /** Toggle the groups overlay panel. */
  toggleGroupsOverlay(forceOpen?: boolean): void {
    this._groupsOverlayOpen = forceOpen ?? !this._groupsOverlayOpen;
    this.emit('groups-overlay-toggle', { open: this._groupsOverlayOpen });
  }

  /**
   * Mark shadows as dirty — call after visibility changes (e.g. group toggle)
   * so the shadow map is re-rendered on the next frame.
   */
  markShadowsDirty(): void {
    this._shadowsDirty = true;
    this._renderDirty = true;
  }

  /**
   * Mark the render pass as dirty so the next frame renders.
   * Call from plugins that need continuous rendering (e.g. FPV movement).
   */
  markRenderDirty(): void {
    this._renderDirty = true;
  }

  /** The ground plane mesh, or null if ground was disabled. */
  get groundMesh(): Mesh | null {
    return this._groundMesh;
  }

  /** Whether the ground/floor plane is visible. No-op if ground was disabled at construction. */
  get groundEnabled(): boolean {
    return this._groundMesh?.visible ?? false;
  }
  set groundEnabled(v: boolean) {
    if (!this._groundMesh) return;
    if (this._groundMesh.visible === v) return;
    this._groundMesh.visible = v;
    this._renderDirty = true;
  }

  /**
   * Floor brightness multiplier (0 = black, 1 = default, 2 = double).
   * Combined with `groundColor` in the material tint:
   *     mat.color = groundColor × groundBrightness   (component-wise)
   * so a white ground at brightness 1 reproduces the original look, and a
   * green ground at brightness 1 reads as the green hue at full intensity.
   */
  get groundBrightness(): number {
    return this._groundBrightness;
  }
  set groundBrightness(v: number) {
    const clamped = Math.max(0, Math.min(2, v));
    if (this._groundBrightness === clamped) return;
    this._groundBrightness = clamped;
    this.applyGroundTint();
  }

  /**
   * Floor base color as `#rrggbb` hex. Combined with `groundBrightness` in the
   * material tint (color × brightness). Default '#ffffff' (white) so brightness
   * acts as a uniform gray scaler exactly as before.
   */
  get groundColor(): string {
    return '#' + this._groundColor.getHexString();
  }
  set groundColor(hex: string) {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
    const next = new Color(hex);
    if (this._groundColor.equals(next)) return;
    this._groundColor.copy(next);
    this.applyGroundTint();
  }

  /** Recompute the ground material color from the stored base color and
   *  brightness. Called whenever either input changes. */
  private applyGroundTint(): void {
    if (!this._groundMesh) return;
    const mat = this._groundMesh.material as MeshStandardMaterial;
    if (!mat.color) return;
    mat.color
      .copy(this._groundColor)
      .multiplyScalar(this._groundBrightness);
    this._renderDirty = true;
  }

  /**
   * Scene background brightness multiplier (0 = black, 1 = default gray, 2 = white).
   * Scales the base 0x9a9a9a gray uniformly so brightness=1 reproduces the original look.
   */
  get backgroundBrightness(): number {
    return this._backgroundBrightness;
  }
  set backgroundBrightness(v: number) {
    const clamped = Math.max(0, Math.min(2, v));
    if (this._backgroundBrightness === clamped) return;
    this._backgroundBrightness = clamped;
    const bg = this.scene.background;
    if (bg && (bg as Color).isColor) {
      (bg as Color).setScalar(Math.min(1, BG_BASE_SCALAR * clamped));
      this._renderDirty = true;
    }
  }

  /**
   * Floor checker pattern contrast multiplier (0 = flat midgray, 1 = default, 2 = doubled spread).
   * Regenerates the checker CanvasTexture in place.
   */
  get checkerContrast(): number {
    return this._checkerContrast;
  }
  set checkerContrast(v: number) {
    const clamped = Math.max(0, Math.min(2, v));
    if (this._checkerContrast === clamped) return;
    this._checkerContrast = clamped;
    if (!this._groundMesh || !this._checkerCanvas) return;
    drawCheckerPattern(this._checkerCanvas, clamped);
    const mat = this._groundMesh.material as MeshStandardMaterial;
    if (mat.map) {
      (mat.map as CanvasTexture).needsUpdate = true;
      this._renderDirty = true;
    }
  }


  /**
   * Cancel any in-progress camera animation immediately.
   * Used by FPV to prevent the animation overwriting the camera position.
   */
  cancelCameraAnimation(): void {
    this._cameraManager.cancelCameraAnimation();
  }

  // ─── Shared View Mode ────────────────────────────────────────────

  /** Whether shared view mode is active (camera controlled by remote operator). */
  private _sharedViewActive = false;
  get sharedViewActive(): boolean { return this._sharedViewActive; }

  /**
   * Enable or disable shared view mode — used by multiuser shared view.
   * When active: controls disabled, raycast disabled, _isOrbiting cleared.
   * When inactive: controls and raycast re-enabled.
   *
   * Rejects toggle if FPV or XR is active (returns false).
   * ALWAYS use this method instead of writing controls.enabled directly.
   *
   * @returns true if the toggle was applied, false if rejected.
   */
  setSharedViewMode(active: boolean): boolean {
    // Check FPV conflict
    const fpv = this.getPlugin<{ id: string; toggle(): void }>('fpv');
    if (active && fpv && (this as unknown as { _fpvActive?: boolean })._fpvActive) return false;

    // Check XR conflict
    const xr = this.getPlugin('webxr') as { isPresenting?: boolean } | undefined;
    if (active && xr?.isPresenting) return false;

    this._sharedViewActive = active;
    this.controls.enabled = !active;
    this._isOrbiting = false;
    this.raycastManager?.setEnabled(!active);
    this.controls.update();
    this._renderDirty = true;
    return true;
  }

  // ─── Simulation Pause ────────────────────────────────────────────

  /**
   * Pause or resume the fixed-timestep simulation with a named reason.
   *
   * Multiple reasons can hold a pause simultaneously (AR placement, layout edit,
   * shared-view session, user-initiated pause button, layout-planner drag, etc.).
   * The simulation resumes only after every reason has released its hold.
   *
   * Rendering is unaffected — onRender still fires each frame, so the 3D view,
   * highlights, gizmos, and camera passthrough stay live. Only `onFixedUpdate`
   * is skipped, which freezes drives, transport surfaces, sensors, logic steps,
   * physics, sources, and sinks.
   *
   * Plugins can subscribe to `'simulation-pause-changed'` to react to transitions
   * (e.g. disconnect WebSocket commands, stop signal polling, dim the scene).
   *
   * @param reason  Short, stable identifier per caller — e.g. `'ar-placement'`,
   *                `'layout-edit'`, `'user'`, `'shared-view'`. Same reason can be
   *                set/cleared multiple times; only the set state matters.
   * @param paused  `true` to request pause, `false` to release this reason.
   */
  setSimulationPaused(reason: string, paused: boolean): void {
    const changed = this.loop.setPaused(reason, paused);
    if (changed) {
      this._emitPauseChanged(reason);
    }
  }

  // ─── Source Floor-Marker Visibility (plan-181) ─────────────────────
  //
  // Toggles the always-visible floor ring + label sprite under each
  // `RVSource`. Visibility-only (no rebuild) so the toggle is cheap and
  // safe to flip from the settings UI on every interaction.

  /** Unsubscribe handle for the source-markers reactive store. */
  private _sourceMarkersUnsub: (() => void) | null = null;

  /**
   * Show or hide the floor markers under every Source in the current
   * scene. Persists the choice to localStorage via the
   * `'rv-source-markers-visible'` key.
   *
   * Idempotent — calling with the same value as already stored is a no-op
   * from the user's perspective (the reactive subscriber would not fire).
   * For consistency this method always re-applies the visibility to every
   * source's marker, even when the persisted value didn't change, so a
   * just-loaded scene picks up the current state immediately.
   */
  setSourceMarkersVisible(visible: boolean): void {
    setSourceMarkersVisibleStore(visible);
    this._applySourceMarkersVisible(visible);
  }

  /** Walk every source in the current transport manager and apply the flag. */
  private _applySourceMarkersVisible(visible: boolean): void {
    const tm = this.transportManager;
    if (!tm) return;
    for (const source of tm.sources) {
      source.setMarkerVisible?.(visible);
    }
  }

  /**
   * Wire the reactive `'rv-source-markers-visible'` store to the loaded
   * scene's Sources. Called once after the scene loads so the initial
   * value is applied AND subsequent settings-panel changes propagate
   * without callers having to wire it themselves.
   *
   * Safe to call multiple times — re-subscribing replaces the prior
   * handle.
   */
  private _installSourceMarkersBinding(): void {
    this._sourceMarkersUnsub?.();
    // Apply current value once so freshly-loaded sources reflect the
    // persisted setting.
    this._applySourceMarkersVisible(getSourceMarkersVisible());
    this._sourceMarkersUnsub = subscribeSourceMarkersVisible(() => {
      this._applySourceMarkersVisible(getSourceMarkersVisible());
    });
  }

  /**
   * Force-clear pause reasons. Intended as a last-resort dev/debug escape
   * when a plugin leaked its pause-reason (e.g. crashed before `dispose()`
   * could release it). Logs a warning so leaks are observable in production.
   *
   * @param reason  If provided, only that reason is removed. If omitted,
   *                ALL active pause reasons are cleared.
   */
  clearPauseReasons(reason?: string): void {
    if (!this.loop.pauseReasons.length) return;
    if (reason !== undefined) {
      if (!this.loop.pauseReasons.includes(reason)) return;
      console.warn(`[SimControl] Force-clearing pause reason: '${reason}'`);
      const changed = this.loop.setPaused(reason, false);
      if (changed) this._emitPauseChanged(reason);
      return;
    }
    const snapshot = [...this.loop.pauseReasons];
    console.warn(`[SimControl] Force-clearing pause reasons: ${snapshot.join(', ')}`);
    let lastChanged = false;
    let lastReason = '';
    for (const r of snapshot) {
      lastChanged = this.loop.setPaused(r, false) || lastChanged;
      lastReason = r;
    }
    if (lastChanged) this._emitPauseChanged(lastReason);
  }

  /**
   * Re-entrancy-guarded emit for `'simulation-pause-changed'`. If a subscriber
   * synchronously calls `setSimulationPaused` from inside the handler, the
   * nested emission is suppressed to avoid event-driven feedback loops.
   * (The pause-set itself is still updated — only the recursive event is skipped.)
   */
  private _emittingPauseChanged = false;
  private _emitPauseChanged(reason: string): void {
    if (this._emittingPauseChanged) return;
    this._emittingPauseChanged = true;
    try {
      this.emit('simulation-pause-changed', {
        paused: this.loop.isPaused,
        reasons: this.loop.pauseReasons,
        reason,
      });
    } finally {
      this._emittingPauseChanged = false;
    }
  }

  /** True if any reason is currently holding the simulation paused. */
  get isSimulationPaused(): boolean { return this.loop.isPaused; }

  /** Snapshot of active pause reasons (for diagnostics / UI badges). */
  get simulationPauseReasons(): readonly string[] { return this.loop.pauseReasons; }

  /**
   * Reset the simulation to a clean "start of new demo run" state without
   * unloading the model.
   *
   * Effects:
   * - Clears all live MUs and resets transport counters (`totalSpawned`,
   *   `totalConsumed`).
   * - Resets all LogicSteps to `Idle` (existing `logicEngine.reset()`).
   *
   * Intentionally leaves untouched:
   * - **Drives**: stay at their current position. Conveyor textures do not
   *   abruptly snap back — the user-visible model continues to look like it
   *   did before the reset.
   * - **Signals**: stay at their current values. This is essential for Live
   *   mode (Unity / PLC stream) — resetting them would just be overwritten on
   *   the next tick and would briefly visualise stale data.
   * - **Pause state**: untouched. Reset can be invoked while paused or running.
   *
   * Use case: starting a fresh demo loop on a model that has been running for
   * a while and has accumulated MUs on conveyors.
   */
  resetSimulation(): void {
    if (this.transportManager) this.transportManager.reset();
    if (this.logicEngine) this.logicEngine.reset();
  }

  // #region NodeFilter
  // ─── Unified Node Filter ──────────────────────────────────────────
  //
  // Marked as a region rather than extracted to a separate service because
  // `filterNodes()` calls `this.emit()` which requires a circular reference
  // back to the viewer. See plan-177 section 2.4 (DESCOPED NodeFilterService)
  // for the rationale.

  private static readonly MAX_HIGHLIGHT_RESULTS = 20;

  /** Current drive search filter string (derived from node filter). */
  private _driveFilter = '';
  get driveFilter(): string { return this._driveFilter; }

  /** Drives matching the current filter (all drives if filter is empty). */
  private _filteredDrives: RVDrive[] = [];
  get filteredDrives(): RVDrive[] { return this._filteredDrives.length > 0 || this._driveFilter ? this._filteredDrives : this.drives; }

  /** Current node search filter string. */
  private _nodeFilter = '';
  get nodeFilter(): string { return this._nodeFilter; }

  /** Nodes matching the current filter. */
  private _filteredNodes: NodeSearchResult[] = [];
  get filteredNodes(): NodeSearchResult[] { return this._filteredNodes; }

  /** Unified search: filters ALL registered nodes. Subscribers extract their subset via events. */
  filterNodes(term: string): void {
    this._nodeFilter = term;
    this._driveFilter = term;

    if (!term.trim()) {
      this._filteredNodes = [];
      this._filteredDrives = [];
      // Restore chart-specific highlights if chart is open
      if (this._driveChartOpen) {
        const nodes = this.drives.map((d) => d.node);
        if (nodes.length > 0) this.highlighter.highlightMultiple(nodes);
      } else if (this._sensorChartOpen) {
        const sensors = this.transportManager?.sensors ?? [];
        const nodes = sensors.map((s) => s.node);
        if (nodes.length > 0) this.highlighter.highlightMultiple(nodes, { includeSensorViz: true });
      } else {
        this.highlighter.clear();
      }
      this.emit('node-filter', { filter: '', filteredNodes: [], tooMany: false });
      this.emit('drive-filter', { filter: '', filteredDrives: [] });
      return;
    }

    const allResults = this.registry?.search(term) ?? [];
    // Apply subscriber type filter from settings
    const settings = loadSearchSettings();
    const results = allResults.filter(r => isTypeEnabled(settings, r.types));
    this._filteredNodes = results;
    const tooMany = results.length >= RVViewer.MAX_HIGHLIGHT_RESULTS;

    // Highlight matching nodes (only if below threshold and highlight enabled)
    if (settings.highlightEnabled && !tooMany && results.length > 0) {
      const nodes = results.map(r => r.node);
      this.highlighter.highlightMultiple(nodes);
    } else {
      this.highlighter.clear();
    }

    // Derive drive-filter from node-filter (backwards compat)
    this._filteredDrives = this.drives.filter((d) =>
      results.some((r) => r.node === d.node)
    );

    this.emit('node-filter', { filter: term, filteredNodes: results, tooMany });
    this.emit('drive-filter', { filter: term, filteredDrives: this._filteredDrives });
  }

  /** Backwards-compatible wrapper. Delegates to filterNodes(). */
  filterDrives(term: string): void {
    this.filterNodes(term);
  }
  // #endregion NodeFilter

  /** Drive pinned by a card click (shown in tooltip until cleared). */
  focusedDrive: RVDrive | null = null;
  focusedNode: Object3D | null = null;

  // --- Dev Tools stats (polled by React DevToolsTab) ---
  /** Current FPS (updated every 500ms). */
  currentFps = 0;
  /** Current frame time in ms (updated every 500ms). */
  currentFrameTime = 0;
  /** Info from the last GLB load. */
  lastLoadInfo: { glbSize: string; loadTime: string } | null = null;

  /** Load model with progress overlay (set by main.ts bootstrap).
   *  The optional `options.overlay` is forwarded to `loadModel` so the
   *  rv-extras overlay is applied during traversal (no race window).
   */
  loadModelWithProgress: ((url: string, options?: { overlay?: RVExtrasOverlay }) => Promise<void>) | null = null;

  /**
   * Optional gate promise that must resolve before model loading begins.
   * Set by plugins like LoginGatePlugin to defer heavy loading until the
   * user has authenticated — avoids main-thread contention that causes
   * laggy login UI.
   */
  loadGate: Promise<void> | null = null;

  // --- XR state ---
  private _savedBackground: Color | null = null;
  private _savedShadowState = true;

  // --- Internal ---
  private replayRecordings: RVReplayRecording[] = [];
  private currentModel: Object3D | null = null;
  private sceneFixtures = new Set<Object3D>();
  private resizeHandler: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private simTickCount = 0;
  private fpsFrameCount = 0;
  private fpsAccumTime = 0;
  private rendererInfoFrameCount = 0;
  private _lastGeoCount = 0;
  private _lastTexCount = 0;
  private ambientLight!: AmbientLight;
  private dirLight!: DirectionalLight;

  // --- Post-processing (WebGL only) ---
  // All composer / GTAO / N8AO / Bloom / desat / isolate-overlay state now
  // lives in `_postProcessing` (see PostProcessingManager). The viewer keeps
  // proxy getters/setters below so the 71 external consumers of RVViewer
  // continue to work unchanged. `_composer` and `_ensureComposer` stay as
  // accessors here too because RVOutlineManager talks to them directly
  // (matches the OutlineHostViewer interface contract).
  private _postProcessing!: PostProcessingManager;
  /** @internal — exposed to RVOutlineManager so it can insert OutlinePass. */
  get _composer(): EffectComposer | null { return this._postProcessing.composer; }

  /** Diagnostic GPU info — populated synchronously at construction with the
   *  active adapter, then asynchronously merged with high-perf / low-power
   *  probes a tick later (best-effort, see rv-gpu-info.ts). Read via
   *  `getGPUInfo()`; consumers poll. */
  private _gpuInfo: GPUInfo | null = null;

  private constructor(
    container: HTMLElement,
    renderer: Renderer,
    options: RVViewerOptions = {},
  ) {
    super();

    const showGround = options.ground ?? true;
    const autoResize = options.autoResize ?? true;

    // --- Renderer (already configured by create/_configureAndCreate) ---
    this.renderer = renderer;
    this.isWebGPU = this._detectWebGPU(renderer);
    this._antialiasActive = options.antialias ?? false;

    // --- GPU diagnostics ---
    // Sync detection first so `getGPUInfo()` returns a usable object
    // immediately (UI doesn't have to wait for the async probe). Then
    // kick off the optional adapter enumeration in the background;
    // when it resolves, merge non-duplicate entries onto _gpuInfo so
    // the next DevToolsTab poll picks them up.
    this._gpuInfo = {
      backend: this.isWebGPU ? 'webgpu' : 'webgl',
      active: detectActiveGPU(renderer, this.isWebGPU ? 'webgpu' : 'webgl'),
    };
    void enumerateOtherAdapters().then((adapters) => {
      if (!this._gpuInfo) return;
      const active = this._gpuInfo.active;
      const highPerf = !isSameAsActive(adapters.highPerf, active) ? adapters.highPerf : undefined;
      const lowPower = !isSameAsActive(adapters.lowPower, active) ? adapters.lowPower : undefined;
      // Skip lowPower if it's identical to highPerf — single useful entry.
      const lowDiffersFromHigh = lowPower && highPerf
        && (lowPower.device.toLowerCase() !== highPerf.device.toLowerCase());
      this._gpuInfo = {
        ...this._gpuInfo,
        highPerf,
        lowPower: lowDiffersFromHigh ? lowPower : undefined,
      };
    });

    // --- Scene ---
    this.scene = new Scene();
    // Default background = 0x9a9a9a gray (scalar 0.604) scaled by backgroundBrightness.
    this.scene.background = new Color().setScalar(BG_BASE_SCALAR * this._backgroundBrightness);
    this.highlighter = new RVHighlightManager(this.scene);
    this.outlineManager = new RVOutlineManager(this);
    // --- Post-processing manager (constructed early so the OutlineManager,
    // which talks to `_composer` / `_ensureComposer()` via the host, sees a
    // backing manager whenever it eventually calls in). The host shape is
    // satisfied by `this` via the proxy getters below.
    const ppSelf = this;
    const ppHost: PostProcessingHost = {
      get renderer() { return ppSelf.renderer; },
      get scene() { return ppSelf.scene; },
      get camera() { return ppSelf.camera; },
      get isWebGPU() { return ppSelf.isWebGPU; },
      get antialiasActive() { return ppSelf._antialiasActive; },
      get outlineHasOutlines() { return ppSelf.outlineManager.hasOutlines; },
      markRenderDirty() { ppSelf._renderDirty = true; },
    };
    this._postProcessing = new PostProcessingManager(ppHost);
    // Route standard hover/selection through the OutlinePass so they render
    // as a true silhouette (matching the layout planner look). Each channel
    // (hover / selection) keeps its own color, derived from the active
    // HighlightStyle's edgeColor — preserving the existing orange/cyan
    // palette while replacing the per-mesh overlay+edge meshes.
    this.highlighter.setOutlineManager(this.outlineManager);
    // Lazy getter for raycastManager: it's created later (loadGLB time), so a closure
    // is needed instead of passing the value directly. Once available, every gizmo
    // automatically participates in raycasting (hover/click resolves to owner node).
    this.gizmoManager = new GizmoOverlayManager(this.scene, () => this.raycastManager);

    // --- Camera ---
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    const aspect = w / h;
    this.perspCamera = new PerspectiveCamera(45, aspect, 0.01, 1000);
    this.perspCamera.position.set(3, 2.5, 4);
    this.perspCamera.lookAt(0, 0.5, 0);
    // Enable highlight-overlay layer so hover/select wireframes render in
    // normal mode. The 3-pass isolate renderer manages this layer per-pass.
    this.perspCamera.layers.enable(HIGHLIGHT_OVERLAY_LAYER);
    // Enable NO_AO so the RenderPass draws NO_AO-tagged UI (ghost, grid, glow
    // gizmos) normally. The AO clone camera turns this layer back OFF so those
    // objects never enter the GTAO/N8AO gbuffer.
    this.perspCamera.layers.enable(NO_AO_LAYER);

    const frustumHalf = 5;
    this.orthoCamera = new OrthographicCamera(
      -frustumHalf * aspect, frustumHalf * aspect, frustumHalf, -frustumHalf, 0.01, 1000,
    );
    this.orthoCamera.position.set(3, 2.5, 4);
    this.orthoCamera.lookAt(0, 0.5, 0);
    this.orthoCamera.layers.enable(HIGHLIGHT_OVERLAY_LAYER);
    this.orthoCamera.layers.enable(NO_AO_LAYER);

    this._activeCamera = this.perspCamera;

    // --- Lighting ---
    this.ambientLight = new AmbientLight(0xffffff, 1.8);
    this.scene.add(this.ambientLight);
    this.sceneFixtures.add(this.ambientLight);

    this.dirLight = new DirectionalLight(0xffffff, 1.5);
    // Match Unity realvirtual Sun prefab: euler (72.82, -150.577, -106.188)
    // Light FROM direction in Three.js: (0.145, 0.955, -0.257)
    this.dirLight.position.set(1.45, 9.55, -2.57);
    this.dirLight.castShadow = false;
    this.dirLight.shadow.mapSize.set(1024, 1024);
    this.dirLight.shadow.camera.near = 0.1;
    this.dirLight.shadow.camera.far = 50;
    this.dirLight.shadow.camera.left = -15;
    this.dirLight.shadow.camera.right = 15;
    this.dirLight.shadow.camera.top = 15;
    this.dirLight.shadow.camera.bottom = -15;
    this.dirLight.shadow.bias = -0.0005;
    this.dirLight.shadow.normalBias = 0.02;
    this.dirLight.shadow.intensity = 0.5;
    this.dirLight.shadow.radius = 2;

    // --- Delegated Managers ---
    // VisualSettingsManager reads/writes shared state on `this` (the facade).
    // We pass a thin object whose property accessors proxy back to the viewer.
    const self = this;
    this._visualSettings = new VisualSettingsManager({
      scene: this.scene,
      renderer: this.renderer,
      ambientLight: this.ambientLight,
      dirLight: this.dirLight,
      sceneFixtures: this.sceneFixtures,
      get _shadowsDirty() { return self._shadowsDirty; },
      set _shadowsDirty(v: boolean) { self._shadowsDirty = v; },
      get _renderDirty() { return self._renderDirty; },
      set _renderDirty(v: boolean) { self._renderDirty = v; },
      // Lets the env-map (IBL) load participate in loadModel's idle-drain
      // so the scene isn't revealed unlit.
      trackLoadingWork: (p) => self.trackLoadingWork(p),
    });

    // --- Ground ---
    if (showGround) {
      const { mesh: ground, canvas } = createGroundFade(this._checkerContrast, this.isWebGPU);
      ground.visible = true;
      ground.userData._rvGroundPlane = true;
      this.scene.add(ground);
      this.sceneFixtures.add(ground);
      this._groundMesh = ground;
      this._checkerCanvas = canvas;
    }

    // --- Renderer-dependent init ---
    renderer.domElement.style.touchAction = 'none';
    container.appendChild(renderer.domElement);

    // --- Controls ---
    this.controls = new OrbitControls(this._activeCamera, renderer.domElement);
    this.controls.enableDamping = true;
    // Dolly toward the cursor instead of the static orbit target. Without this,
    // OrbitControls' wheel-dolly scales distance to `target` by a fixed factor
    // per notch — asymptotic to the target, so close-up zoom in large scenes
    // (e.g. Gaussian Splat showrooms) feels frozen.
    this.controls.zoomToCursor = true;
    this.controls.target.set(0, 0.5, 0);
    this.controls.mouseButtons = {
      LEFT: -1 as MOUSE,
      MIDDLE: MOUSE.PAN,
      RIGHT: MOUSE.ROTATE,
    };
    this.controls.touches = {
      ONE: TOUCH.ROTATE,
      TWO: TOUCH.DOLLY_PAN,
    };
    // Apply navigation-sensitivity settings (rotate/pan/zoom/damping) from store.
    const navSettings = loadVisualSettings();
    applyNavigationSettingsToControls(this.controls, navSettings);
    this.controls.update();

    // Track orbit/pan/pinch gesture state to suppress selection & hover highlighting
    this.controls.addEventListener('start', () => {
      this._isOrbiting = true;
      if (this.raycastManager) this.raycastManager.setEnabled(false);
      this._cancelLongPress();
    });
    this.controls.addEventListener('end', () => {
      this._isOrbiting = false;
      if (this.raycastManager) this.raycastManager.setEnabled(true);
      // Keep rendering long enough for damping decay to fall below 1% velocity.
      // Budget adapts to current dampingFactor; capped at 300 frames (~5 s @ 60 fps).
      this._dampingFramesRemaining = Math.min(
        Math.ceil(Math.log(0.01) / Math.log(1 - this.controls.dampingFactor)),
        300,
      );
    });
    // Mark render dirty on any controls change (orbit, pan, zoom). Shadow
    // dirty is more nuanced: in the legacy tight-fit mode the shadow camera
    // adapts to the view frustum so every camera change needs a re-fit, but
    // once the uber-merge creates a static shadow caster we switch to a
    // full-scene shadow camera (see `_fitShadowToView`). That camera is
    // fixed at scene center with `_shadowPadMax` bounds and is completely
    // independent of where the user is currently looking, so rotation /
    // pan / zoom produce an identical shadow map — re-rendering it every
    // frame during interaction would literally double triangle throughput.
    this.controls.addEventListener('change', () => {
      this._renderDirty = true;
      const hasStaticUberCaster = (this._lastLoadResult?.uberMergeResult?.mergedCount ?? 0) > 0;
      if (!hasStaticUberCaster) {
        this._shadowsDirty = true;
      }
    });

    // CameraManager — uses proxy state to read/write shared fields on the facade.
    this._cameraManager = new CameraManager({
      perspCamera: this.perspCamera,
      orthoCamera: this.orthoCamera,
      get _activeCamera() { return self._activeCamera; },
      set _activeCamera(v) { self._activeCamera = v; },
      controls: this.controls,
      renderer: this.renderer,
      get _renderDirty() { return self._renderDirty; },
      set _renderDirty(v: boolean) { self._renderDirty = v; },
      leftPanelManager: this.leftPanelManager,
      getPlugin: <T>(id: string) => this.getPlugin(id) as T | undefined,
    });

    // --- Canvas events ---
    this._bindCanvasEvents(renderer.domElement);

    // --- XR (only for WebGL backend) ---
    this._setupXR(renderer, container);

    // --- Stats-gl ---
    this._setupStats(renderer);

    // --- Simulation Loop ---
    this.loop = new SimulationLoop(renderer);
    this.loop.onFixedUpdate = (dt: number) => this.fixedUpdate(dt);
    this.loop.onRender = () => this.render();
    this.loop.start();

    // --- Resize (ResizeObserver on container — handles soft keyboard, orientation) ---
    if (autoResize) {
      let resizeRafId = 0;
      this.resizeHandler = () => {
        const w = container.clientWidth || window.innerWidth;
        const h = container.clientHeight || window.innerHeight;
        const aspect = w / h;
        this.perspCamera.aspect = aspect;
        this.perspCamera.updateProjectionMatrix();
        // Keep ortho frustum in sync
        const dist = this.orthoCamera.position.distanceTo(this.controls.target);
        const halfH = dist * Math.tan((this.perspCamera.fov * Math.PI / 180) / 2);
        this.orthoCamera.left = -halfH * aspect;
        this.orthoCamera.right = halfH * aspect;
        this.orthoCamera.top = halfH;
        this.orthoCamera.bottom = -halfH;
        this.orthoCamera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
        this._postProcessing.setSize(w, h);
        // OutlinePass renders at full resolution — keep it in sync with the canvas.
        this.outlineManager.setSize(w, h);
        this._renderDirty = true;
      };
      this.resizeObserver = new ResizeObserver(() => {
        cancelAnimationFrame(resizeRafId);
        resizeRafId = requestAnimationFrame(() => this.resizeHandler!());
      });
      this.resizeObserver.observe(container);
      // Fallback for browsers without ResizeObserver on window events
      window.addEventListener('resize', this.resizeHandler);
    }

    logInfo(`realvirtual WEB — Ready (${this.isWebGPU ? 'WebGPU' : 'WebGL'})`);

    // ─── Sub-Facaden (Phase 4a of plan-182) ────────────────────────────
    // Initialized last: all managers (controls, camera, scene) are ready.
    // Plugins reach these via this._pluginContext — not via direct field access.
    this._scene    = new SceneFacadeImpl(this);
    this._camera   = new CameraFacadeImpl(this);
    this._controls = new ControlsFacadeImpl(this);
    this._simLoop  = new SimLoopFacadeImpl(this);
    this._pluginContext = new PluginContextImpl(this);

    // ─── Behavior auto-discovery hook ───────────────────────────────────
    // Attach the BehaviorManager so it listens for model-loaded /
    // model-cleared and dispatches all matching behaviors registered via
    // `registerAllBehaviors(viewer.behaviors)`. Per-context cleanup is
    // centrally guaranteed on model-cleared.
    this._behaviorsDetach = this.behaviors.attach(
      this as unknown as BindContextHost,
      () => this.currentModel,
      () => this._currentModelUrl,
    );
  }

  // ─── Post-Processing Pipeline (WebGL only) ─────────────────────────
  // The composer + GTAO/N8AO/Bloom/desat/isolate-overlay resources are
  // owned by `_postProcessing` (see PostProcessingManager). The methods
  // and getters below are thin delegations preserved for backwards
  // compatibility with RVOutlineManager and the viewer's own render path.

  /** Whether any post-processing effect is active (determines composer vs
   *  direct render). Always false while a WebXR session is presenting and
   *  always false on WebGPU — see {@link PostProcessingManager.useComposer}. */
  private get _useComposer(): boolean {
    return this._postProcessing.useComposer;
  }

  /**
   * Lazily create the EffectComposer with all post-processing passes.
   * @internal — also called by RVOutlineManager when outlines turn on.
   */
  _ensureComposer(): void {
    this._postProcessing.ensureComposer();
  }

  /**
   * Three-pass render used when GroupRegistry.isIsolateActive is true:
   *   1. Dim backdrop — everything except the focus layer, through composer if enabled.
   *   2. Semi-transparent white overlay drawn over the dim frame.
   *   3. Focus group drawn crisply on top of the overlay.
   *
   * Caller (render()) saves and restores camera.layers.mask / renderer.autoClear
   * in a try/finally so exceptions can't corrupt global state. The composer,
   * desat, and isolate-overlay resources are all owned by _postProcessing.
   */
  private _renderIsolateMode(): void {
    this._postProcessing.ensureIsolateOverlay();
    // Re-tag isolated subtrees so dynamically added descendants (spawned MUs,
    // gripper pickups, async-loaded geometry, etc.) inherit ISOLATE_FOCUS_LAYER
    // and render in pass 3 instead of being washed by the dim overlay.
    this.groups?.refreshIsolateLayer();
    this.autoFilters?.refreshIsolateLayer();
    const camera = this.camera;
    // Cast to WebGLRenderer for autoClear / clearDepth typings. The running
    // instance is actually three/webgpu Renderer in forceWebGL mode — see
    // Background.js in the three/webgpu source for the clear gate.
    const gl = this.renderer as unknown as WebGLRenderer;

    // Check if desaturation is requested by any active isolate caller.
    const desaturate =
      this.autoFilters?.dimDesaturate ||
      !!(this.groups as { dimDesaturate?: boolean } | null)?.dimDesaturate;

    // Restrict shadow map to focus-layer objects only so dimmed objects
    // don't cast shadows onto the ground plane.
    const savedShadowLayers = this.dirLight.shadow.camera.layers.mask;
    this.dirLight.shadow.camera.layers.set(ISOLATE_FOCUS_LAYER);

    // ── Pass 1: Dim backdrop ──
    // enableAll + disable focus = "everything but focus", mutation-safe for
    // dynamically spawned nodes (MUs, tank fills, pipe-flow rings) which
    // default to layer 0 only. Also exclude overlay layers (highlight wires
    // and measurement markers/labels) so they don't render dim here — both
    // are re-rendered crisply in pass 4 above the AO/composer output.
    // Excluding MEASUREMENT_LAYER also prevents the label sprite from
    // contaminating the GTAO/N8AO depth sample → halo artifacts.
    camera.layers.enableAll();
    camera.layers.disable(ISOLATE_FOCUS_LAYER);
    disableOverlayLayers(camera);

    if (desaturate) {
      // Render backdrop to offscreen RT, then blit desaturated to screen.
      this._postProcessing.ensureDesatPass();
      const rt = this._postProcessing.desatRT!;
      const w = gl.domElement.width;
      const h = gl.domElement.height;
      if (rt.width !== w || rt.height !== h) rt.setSize(w, h);

      // Remove environment map during backdrop render so metallic surfaces
      // don't show specular reflections (they'd appear as bright white spots
      // even after desaturation). Restored before Pass 3 (focus group).
      const savedEnv = this.scene.environment;
      this.scene.environment = null;

      // Render the full-color backdrop (everything except focus layer) into the RT.
      gl.setRenderTarget(rt);
      gl.clear(true, true, false);
      gl.render(this.scene, camera);
      gl.setRenderTarget(null);

      // Restore environment map for the focus group render (Pass 3).
      this.scene.environment = savedEnv;

      // Blit the RT to the default framebuffer through a desaturation shader.
      // saturation=0 → full grayscale; the focus group (Pass 3) renders in
      // full color on top afterwards.
      const desatMat = this._postProcessing.desatMat!;
      desatMat.uniforms.tDiffuse.value = rt.texture;
      desatMat.uniforms.saturation.value = 0.0;
      gl.clear(true, true, false);
      gl.render(this._postProcessing.desatScene!, this._postProcessing.desatCam!);
    } else if (this._useComposer) {
      // AO clone excludes NO_AO_LAYER (mirrors pass-1's reduced mask); RenderPass
      // keeps the real camera so NO_AO UI still draws in the dim backdrop.
      const aoCam = this._postProcessing.syncAoCamera(camera);
      const gtaoPass = this._postProcessing.gtaoPass;
      if (gtaoPass) gtaoPass.camera = aoCam;
      const n8 = this._postProcessing.n8aoPass as (Pass & { camera?: PerspectiveCamera | OrthographicCamera }) | null;
      if (n8) n8.camera = aoCam;
      const composer = this._postProcessing.composer!;
      const renderPass = composer.passes[0] as RenderPass;
      if (renderPass) renderPass.camera = camera;
      composer.render();
    } else {
      gl.render(this.scene, camera);
    }

    // CRITICAL: three/webgpu Background.js:44 sets `forceClear = true` when
    // `scene.background` is a Color, which BYPASSES `autoClear` and wipes
    // the framebuffer on every render call. For the remaining passes we
    // must disable both autoClear AND temporarily null the scene background,
    // then restore both afterwards.
    gl.autoClear = false;
    const savedBackground = this.scene.background;
    this.scene.background = null;
    // Sync overlay tint to the scene background color (Color → use as-is,
    // Texture/CubeTexture/null → fall back to the renderer clear color so
    // the fade still matches the visible sky).
    const overlayMat = this._postProcessing.isolateOverlayMat;
    if (overlayMat) {
      if (savedBackground && (savedBackground as Color).isColor) {
        overlayMat.color.copy(savedBackground as Color);
      } else {
        gl.getClearColor(overlayMat.color);
      }
      // Allow the active isolate caller to override the dim-opacity.
      // autoFilters takes precedence over groups; both fall back to the default 0.9.
      const override =
        this.autoFilters?.dimOpacity ??
        (this.groups as { dimOpacity?: number | null } | null)?.dimOpacity ??
        null;
      overlayMat.opacity = override ?? 0.9;
    }
    try {
      // ── Pass 2: Semi-transparent fullscreen overlay ──
      // Direct render — do NOT route through composer, the composer already
      // wrote its final color to the default framebuffer.
      gl.clearDepth();
      gl.render(this._postProcessing.isolateOverlayScene!, this._postProcessing.isolateOverlayCam!);

      // ── Pass 3: Focus group on top ──
      gl.clearDepth();
      camera.layers.set(ISOLATE_FOCUS_LAYER);
      gl.render(this.scene, camera);

      // ── Pass 4: Overlays on top of everything ──
      // Hover/select wireframes (HIGHLIGHT_OVERLAY_LAYER) and measurement
      // markers/lines/labels (MEASUREMENT_LAYER) — both have depthTest:false
      // and renderOrder>=11. Combined into a single overlay pass: the depth
      // clear keeps them visible regardless of pass-3 z-state, and rendering
      // here (after composer/desat) ensures AO never sees their depth and
      // never darkens their color.
      gl.clearDepth();
      setOverlayLayersOnly(camera);
      gl.render(this.scene, camera);
    } finally {
      this.scene.background = savedBackground;
      this.dirLight.shadow.camera.layers.mask = savedShadowLayers;
    }
  }

  // ─── Static Factory ──────────────────────────────────────────────────

  /**
   * Create a viewer instance. Always use this instead of `new RVViewer()`.
   * Uses WebGPURenderer with forceWebGL as the universal renderer.
   * When `options.useWebGPU` is true and the browser supports it,
   * the real WebGPU backend is used instead.
   */
  static async create(
    container: HTMLElement,
    options?: RVViewerOptions,
  ): Promise<RVViewer> {
    const isTouchDevice = isMobileDevice();

    let useWebGPU = !!options?.useWebGPU;
    if (useWebGPU && !navigator.gpu) {
      console.warn('[RVViewer] WebGPU not available, falling back to WebGL');
      useWebGPU = false;
    }

    let renderer: Renderer;

    if (useWebGPU) {
      // Real WebGPU: use WebGPURenderer with async init
      const { WebGPURenderer } = await import('three/webgpu');
      const gpuRenderer = new WebGPURenderer({ antialias: options?.antialias ?? false, alpha: true, stencil: true } as any);
      try {
        await gpuRenderer.init();
      } catch (err) {
        console.warn('[RVViewer] WebGPU init() failed, falling back to WebGL:', err);
        gpuRenderer.dispose();
        useWebGPU = false;
        // fall through to WebGL path below
      }
      if (useWebGPU) renderer = gpuRenderer;
    }

    if (!useWebGPU) {
      // Standard WebGL: use the proven WebGLRenderer (no init needed)
      renderer = new WebGLRenderer({ antialias: options?.antialias ?? false, alpha: true, stencil: true, powerPreference: 'high-performance' }) as unknown as Renderer;
    }

    return RVViewer._configureAndCreate(renderer!, container, isTouchDevice, useWebGPU, options);
  }

  /** Shared renderer config — called by create() and fallback path. */
  private static _configureAndCreate(
    renderer: Renderer,
    container: HTMLElement,
    isTouchDevice: boolean,
    isWebGPU: boolean,
    options?: RVViewerOptions,
  ): RVViewer {
    renderer.setSize(
      container.clientWidth || window.innerWidth,
      container.clientHeight || window.innerHeight,
    );
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, DEFAULT_DPR_CAP));
    renderer.shadowMap.enabled = false;
    (renderer.shadowMap as unknown as { autoUpdate: boolean }).autoUpdate = false;
    renderer.toneMapping = NoToneMapping;
    // Disable the auto-reset of renderer.info.render so we can accumulate
    // stats across multiple passes in a single frame (composer passes,
    // shadow map, etc.). Without this, the stats we read in getRendererInfo()
    // reflect only the LAST pass — typically a 1-triangle fullscreen
    // post-processing blit — and look completely wrong.
    (renderer.info as unknown as { autoReset: boolean }).autoReset = false;

    return new RVViewer(container, renderer, options ?? {});
  }

  // ─── Behaviors / Kinematics low-level binding ─────────────────────────

  /**
   * Apply a KinematicsSpec or a bind-callback to the given root subtree.
   *
   * Two forms:
   *   1. `viewer.bind(root, spec)` — applies the spec directly via
   *      {@link applyKinematicsSpec}.
   *   2. `viewer.bind(root, (rv) => { ... })` — runs the callback against a
   *      fresh RVBindContext, accumulates a spec from the calls, and
   *      applies it. Subscriptions (`onFixedUpdate`, `signals.on`,
   *      contextMenu) are NOT auto-disposed in this low-level entry; the
   *      caller may dispose them by listening to `model-cleared`. For
   *      Behavior-files use the BehaviorManager — it disposes for you.
   */
  bind(
    root: Object3D,
    specOrCb: KinematicsSpec | ((rv: RVBindContext) => void),
    opts?: { strict?: boolean; overwrite?: boolean },
  ): KinematizeReport {
    if (typeof specOrCb === 'function') {
      const accum: KinematicsSpec = {};
      const { ctx } = createBindContext(root, this as unknown as BindContextHost, accum);
      specOrCb(ctx);
      const merged: KinematicsSpec = {
        ...accum,
        strict: opts?.strict ?? accum.strict,
        overwrite: opts?.overwrite ?? accum.overwrite,
      };
      return applyKinematicsSpec(root, merged);
    }
    const merged: KinematicsSpec = {
      ...specOrCb,
      strict: opts?.strict ?? specOrCb.strict,
      overwrite: opts?.overwrite ?? specOrCb.overwrite,
    };
    return applyKinematicsSpec(root, merged);
  }

  // ─── Model Management ─────────────────────────────────────────────────

  /**
   * Load a GLB model and start all simulation systems.
   *
   * @param url      GLB URL (file, blob:, or empty-glb URL)
   * @param options  Optional load options (e.g. an rv-extras overlay applied during traversal).
   */
  async loadModel(url: string, options?: { overlay?: RVExtrasOverlay }): Promise<LoadResult> {
    this.clearModel();
    this._currentModelUrl = url;

    // --- Pre-load phase: load model plugins BEFORE GLB so they can register capabilities ---
    // Capabilities must be registered before buildRaycastGeometries() in loadGLB().
    // External plugin bundles (./project-plugin.js, ./models/<name>/model-plugin.js) are
    // an opt-in feature for deploys that ship standalone plugin bundles alongside the viewer.
    // Gated on appConfig.externalPlugins to avoid two 404s per model load on every other deploy
    // where no such bundle exists. The Vite-bundled ModelPluginManager below is the default path.
    if (getAppConfig().externalPlugins) {
      const modelBaseName = url.replace(/^.*\//, '').replace(/\.glb$/i, '');
      const tryPreloadPlugin = async (pluginUrl: string): Promise<void> => {
        try {
          const resp = await fetch(pluginUrl, { method: 'HEAD' });
          if (!resp.ok) return;
          const mod = await import(/* @vite-ignore */ pluginUrl);
          if (typeof mod.default === 'function') mod.default(this);
        } catch { /* skip silently */ }
      };
      await tryPreloadPlugin('./project-plugin.js');
      await tryPreloadPlugin(`./models/${modelBaseName}/model-plugin.js`);
    }
    if (this.modelPluginManager) {
      await this.modelPluginManager.onModelLoading(url, this);
    }

    // Wait for any load gate (e.g. login) before heavy GLB parsing
    if (this.loadGate) await this.loadGate;

    const result = await loadGLB(url, this.scene, {
      isWebGPU: this.isWebGPU,
      gizmoManager: this.gizmoManager,
      events: this,
      overlay: options?.overlay,
    });

    // Pre-compile shaders to avoid first-frame stutter (available on WebGPURenderer)
    if ('compileAsync' in this.renderer) {
      try {
        await this.renderer.compileAsync(this.scene, this.camera, this.scene);
      } catch { /* non-critical */ }
    }

    // GLB root is reported deterministically by loadGLB (LoadResult.root) —
    // no diffing scene.children. The `_rvModelRoot` userData tag stays as
    // defence-in-depth so clearModel's tag-sweep can recover from any
    // historic stray that might still be tagged from prior buggy sessions.
    this.currentModel = result.root;
    this.currentModel.userData._rvModelRoot = true;
    this.drives = result.drives;
    this.transportManager = result.transportManager;
    this.signalStore = result.signalStore;
    this.playback = result.playback;
    this.replayRecordings = result.replayRecordings;
    this.logicEngine = result.logicEngine;
    this.registry = result.registry;
    this.groups = result.groups;

    // Wire the source-floor-marker visibility flag (plan-181) — applies the
    // persisted value to all freshly-loaded Sources AND subscribes to future
    // settings-panel toggles. Idempotent across re-loads.
    this._installSourceMarkersBinding();

    // Component event dispatcher — routes viewer events (object-hover, object-clicked,
    // selection-changed) to per-component onHover/onClick/onSelect callbacks.
    // Must be created after registry is available.
    if (this.componentEventDispatcher) {
      this.componentEventDispatcher.dispose();
    }
    this.componentEventDispatcher = new ComponentEventDispatcher(this, result.registry);

    // Build auto-filter groups from component capabilities
    this.autoFilters = new AutoFilterRegistry();
    this.autoFilters.build(result.registry);

    // Selection manager — init after registry is available
    this.selectionManager.init(this);

    // Register core "Focus" context menu item (available for all nodes)
    this.contextMenu.register({
      pluginId: '_core',
      items: [{
        id: '_core.focus',
        label: 'Focus',
        order: 1,
        action: (target) => {
          this.fitToNodes([target.node]);
          this.selectionManager.select(target.path);
        },
      }],
    });

    // Register filter subscribers from capabilities registry
    for (const [type, caps] of getRegisteredCapabilities()) {
      if (caps.filterLabel) {
        registerFilterSubscriber({ id: type, label: caps.filterLabel, componentType: type });
      }
    }

    // Unified raycast manager with grouped BVH. Pass a getter (not the
    // current camera reference) so the raycaster always uses the active
    // camera even after a perspective ↔ orthographic swap. A captured
    // reference would go stale at the moment of the swap and produce
    // wrong rays in the new projection mode.
    this.raycastManager = new RaycastManager(
      this.renderer, () => this.camera, this.scene,
      result.registry, this.highlighter, this,
    );

    // Install central isolation gate — single invariant across all isolate
    // providers (GroupRegistry, AutoFilterRegistry, external/plugin isolates).
    // Stacks atop any plugin-specific allow filter.
    this.raycastManager.setIsolationGate((node) => {
      if (this.groups?.isIsolateActive && !this.groups.isInIsolatedSubtree(node)) return false;
      if (this.autoFilters?.isIsolateActive && !this.autoFilters.isInIsolatedSubtree(node)) return false;
      return true;
    });

    // Provide grouped raycast geometry (built during scene loading)
    if (result.raycastGeometrySet) {
      const muMeshes = this._collectInstancedMeshes();
      this.raycastManager.setRaycastGeometry(result.raycastGeometrySet, muMeshes);
    }

    // Gizmos created during loadGLB (e.g. WebSensor outlines) were instantiated
    // before raycastManager existed. Register them AFTER setRaycastGeometry so
    // they survive the rebuild that setRaycastGeometry triggers.
    this.gizmoManager.refreshAuxRaycastTargets();

    // Enable hover types based on capabilities registry (hoverEnabledByDefault)
    const hoverDefaults = getTypesWithCapability('hoverEnabledByDefault');
    for (const type of hoverDefaults) {
      this.raycastManager.enableHoverType(type, true);
    }
    const pl = result.pipelineNodes;

    // Tank fill visualization (3D liquid level)
    if (pl.tanks.length > 0) {
      this.tankFillManager = new TankFillManager(pl.tanks, this.renderer as unknown as { localClippingEnabled?: boolean });
      if (this.tankFillManager.update()) {
        this._renderDirty = true;
      }
    }

    // Pipe flow visualization (animated rings)
    if (pl.pipes.length > 0) {
      this.pipeFlowManager = new PipeFlowManager(pl.pipes);
    }

    // LogicEngine
    if (this.logicEngine) {
      this.logicEngine.start();
    }

    // Recording playback
    if (this.playback) {
      const shouldAutoPlay = result.recorderSettings?.playOnStart ?? false;
      if (shouldAutoPlay) {
        this.playback.play();
      }
    }

    // Resize ground plane to fit model bounds + margin
    const center = new Vector3();
    const size = new Vector3();
    if (result.boundingBox.isEmpty()) {
      // Empty / mesh-less GLB (e.g. the synthesized empty scene from
      // empty-glb.ts). Box3.getCenter/getSize on an empty box returns
      // ±Infinity, which would put the camera + orbit target at infinity
      // and lock OrbitControls. Synthesize a 15 m playground bbox so the
      // ground fade and camera framing land at a workable scale for an
      // empty workspace (drives the ground size below via FLOOR_FADE_*
      // and the initial camera distance further down).
      center.set(0, 0, 0);
      size.set(15, 1, 15);
    } else {
      result.boundingBox.getCenter(center);
      result.boundingBox.getSize(size);
    }

    if (this._groundMesh) {
      // Ground is a 200×200 fade plane with a circular alpha map. The fade
      // geometry is driven by FLOOR_FADE_START_RATIO and FLOOR_FADE_END_RATIO
      // — both expressed in units of the model's half-extent. The plane is
      // sized so its inscribed-circle radius equals FLOOR_FADE_END_RATIO ×
      // model-half-extent, and the alpha map puts opaque out to
      // FLOOR_FADE_START_RATIO / FLOOR_FADE_END_RATIO of that radius.
      const modelMaxFullExtent = Math.max(size.x, size.z);
      const groundSize = modelMaxFullExtent * FLOOR_FADE_END_RATIO;
      this._groundMesh.scale.set(groundSize / 200, groundSize / 200, 1);
      this._groundMesh.position.set(center.x, 0, center.z);

      // Update checker texture repeat so each square is always 0.5m
      const SQUARE_SIZE = 0.5; // meters per checker square
      const TILES_PER_REPEAT = 8; // tiles baked into the checker texture
      const metersPerRepeat = TILES_PER_REPEAT * SQUARE_SIZE; // 4m
      const checkerMap = ((this._groundMesh as Mesh).material as MeshStandardMaterial).map;
      if (checkerMap) {
        checkerMap.repeat.set(groundSize / metersPerRepeat, groundSize / metersPerRepeat);
      }
    }

    // Fit camera to model

    const maxDim = Math.max(size.x, size.y, size.z);
    // For an empty base (synthesized 15 m playground bbox above) the user
    // is authoring at workspace scale — frame the camera close to a 5 m
    // working area so the initial view matches what the user is about to
    // build, not the full 15 m ground extent. Shadow / sun fit below still
    // uses `maxDim` so coverage extends across the whole ground.
    const cameraFitDim = result.boundingBox.isEmpty() ? 5 : maxDim;
    const fov = this.perspCamera.fov * (Math.PI / 180);
    const dist = (cameraFitDim / (2 * Math.tan(fov / 2))) * 1.5;

    this.camera.position.set(center.x + dist * 0.7, center.y + dist * 0.5, center.z + dist * 0.7);
    this.controls.target.copy(center);
    this.controls.update();

    // Fit directional light shadow camera to model
    // Light direction matches Unity realvirtual Sun prefab: euler (72.82, -150.577, -106.188)
    // Light FROM direction in Three.js: (0.145, 0.955, -0.257)
    {
      this._shadowPadMax = Math.max(maxDim * 1.2, 5);
      const sunDist = maxDim * 2;
      this.dirLight.position.set(
        center.x + 0.145 * sunDist,
        center.y + 0.955 * sunDist,
        center.z + -0.257 * sunDist,
      );
      this.dirLight.target.position.copy(center);
      this.dirLight.shadow.camera.left = -this._shadowPadMax;
      this.dirLight.shadow.camera.right = this._shadowPadMax;
      this.dirLight.shadow.camera.top = this._shadowPadMax;
      this.dirLight.shadow.camera.bottom = -this._shadowPadMax;
      this.dirLight.shadow.camera.near = 0.1;
      this.dirLight.shadow.camera.far = Math.max(maxDim * 4, 50);
      this.dirLight.shadow.camera.updateProjectionMatrix();
    }

    // --- Auto-load model sidecar settings (first visit only) ---
    // --- Load and merge model-specific plugin configuration ---
    const [modelJsonConfig, glbConfig] = await Promise.all([
      loadModelJsonConfig(url).catch(() => ({} as ModelConfig)),
      Promise.resolve(extractGlbPluginConfig(this.scene)),
      loadModelSettingsConfig(url),
    ]);
    const settingsConfig: ModelConfig = {};
    const appConfig = getAppConfig();
    if (appConfig.plugins) settingsConfig.plugins = appConfig.plugins;
    if (appConfig.pluginConfig) settingsConfig.pluginConfig = appConfig.pluginConfig;

    result.modelConfig = mergeModelConfig(modelJsonConfig, glbConfig, settingsConfig);

    // Note: Project/model plugin loading (tryPreloadPlugin, modelPluginManager.onModelLoading)
    // was moved to the pre-load phase BEFORE loadGLB() so plugins can register capabilities
    // before BVH construction. See top of loadModel().

    // Plugin lifecycle: onModelLoaded (before event, with error isolation)
    // Activation mode depends on whether rv_plugins is declared anywhere.
    this._lastLoadResult = result;
    const declared = result.modelConfig.plugins; // string[] | undefined

    if (declared === undefined) {
      // ALL-MODE: no rv_plugins declared — activate ALL registered plugins (backward compatible)
      for (const p of this._plugins) {
        if (this._disabledIds.has(p.id)) continue;
        callPlugin(p, 'onModelLoaded', result, this);
      }
    } else {
      // SELECTIVE-MODE: only declared plugins + core plugins activate
      for (const p of this._plugins) {
        if (this._disabledIds.has(p.id)) continue;
        if (p.core || declared.includes(p.id)) {
          callPlugin(p, 'onModelLoaded', result, this);
        }
      }
      // Resolve any declared plugins not yet registered (lazy built-in or external)
      for (const id of declared) {
        if (!this._plugins.find(p => p.id === id)) {
          const plugin = await this.resolvePlugin(id);
          if (plugin) callPlugin(plugin, 'onModelLoaded', result, this);
        }
      }
    }

    // Re-evaluate _physicsPluginActive — plugins may have changed handlesTransport in onModelLoaded
    // Re-evaluate _physicsPluginActive — plugins may have changed handlesTransport in onModelLoaded
    this._physicsPluginActive = this._plugins.some(p => p.handlesTransport);

    // Ensure first frame renders fully (shadows + scene)
    this._shadowsDirty = true;
    this._renderDirty = true;

    // Build reverse-reference index for O(1) lookup in PropertyInspector
    result.registry.buildReverseRefIndex();

    logInfo(`Model loaded: ${this.drives.length} drives, ${this.signalStore?.size ?? 0} signals`);
    this.emit('model-loaded', { result });
    // Wait for any deferred async loading work registered by subsystems
    // and plugins (env-map IBL, deferred asset prefetch, …) so the caller's
    // `await viewer.loadModel(...)` only resolves once the scene is fully
    // ready to be revealed.
    await this.whenLoadingIdle();
    return result;
  }

  /** Remove the current model and reset all simulation state. */
  clearModel(): void {
    // Plugin lifecycle: onModelCleared (before state reset, skip disabled)
    for (const p of this._plugins) {
      if (this._disabledIds.has(p.id)) continue;
      callPlugin(p, 'onModelCleared', this);
    }

    // Close context menu to prevent stale target references
    this.contextMenu.close();

    // Safety net: clear all dynamic UI contexts, preserve initial ones from config
    const initialCtxs = getAppConfig().ui?.initialContexts;
    resetDynamicContexts(Array.isArray(initialCtxs) ? initialCtxs : undefined);

    this._lastLoadResult = null;

    this.selectionManager.clear();
    this.selectionManager.dispose();

    if (this.raycastManager) {
      this.raycastManager.dispose();
      this.raycastManager = null;
    }

    // Drop the source-markers subscription before nulling out the transport
    // manager — otherwise future settings-store toggles would try to iterate
    // a stale source list.
    this._sourceMarkersUnsub?.();
    this._sourceMarkersUnsub = null;

    // IMPORTANT: Reset transport manager BEFORE scene traverse to remove
    // active MU nodes from scene tree. MU clones share geometry by reference
    // with templates — disposing geometry during traverse would corrupt shared buffers.
    if (this.transportManager) {
      this.transportManager.reset();
      this.transportManager = null;
    }

    // Collect every model root currently parented to the scene. Normally this
    // is just `this.currentModel`, but a `_rvModelRoot`-tagged orphan can
    // remain if a previous switch tracked the wrong child as currentModel
    // (see snapshot logic in loadModel). Sweeping all of them here ensures
    // we never end up with two scenes drawing simultaneously.
    const modelRootsToClear = new Set<Object3D>();
    if (this.currentModel) modelRootsToClear.add(this.currentModel);
    for (const child of this.scene.children) {
      if (child.userData?._rvModelRoot) modelRootsToClear.add(child);
    }

    // After material deduplication, multiple meshes share the same material
    // instance. Use a Set to avoid disposing the same material/texture twice
    // across all roots being torn down in this pass.
    const disposedMaterials = new Set<MeshStandardMaterial>();
    for (const root of modelRootsToClear) {
      this.scene.remove(root);
      root.traverse((node) => {
        const mesh = node as {
          geometry?: { dispose(): void };
          material?: (MeshStandardMaterial & { dispose(): void }) | (MeshStandardMaterial & { dispose(): void })[];
        };
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) {
          const disposeMat = (m: MeshStandardMaterial & { dispose(): void }) => {
            if (disposedMaterials.has(m)) return;
            disposedMaterials.add(m);
            // Shared fixtures (e.g. RVUberMaterial singleton) survive clearModel —
            // they outlive individual model loads and are reused on the next load.
            if (m.userData?._rvShared) return;
            m.map?.dispose();
            m.normalMap?.dispose();
            m.roughnessMap?.dispose();
            m.aoMap?.dispose();
            m.emissiveMap?.dispose();
            m.metalnessMap?.dispose();
            m.alphaMap?.dispose();
            m.envMap?.dispose();
            m.dispose();
          };
          if (Array.isArray(mesh.material)) mesh.material.forEach(disposeMat);
          else disposeMat(mesh.material);
        }
      });
    }
    this.currentModel = null;
    this.drives = [];
    if (this.playback) {
      this.playback.stop();
      this.playback = null;
    }
    this.replayRecordings = [];
    if (this.logicEngine) {
      this.logicEngine.reset();
      this.logicEngine = null;
    }
    if (this.tankFillManager) {
      this.tankFillManager.dispose();
      this.tankFillManager = null;
    }
    if (this.pipeFlowManager) {
      this.pipeFlowManager.dispose();
      this.pipeFlowManager = null;
    }
    // Dispose gizmo entries & dispatcher before registry is cleared
    this.gizmoManager.dispose();
    if (this.componentEventDispatcher) {
      this.componentEventDispatcher.dispose();
      this.componentEventDispatcher = null;
    }
    this.signalStore = null;
    this.registry = null;
    if (this.groups) {
      this.groups.clear();
      this.groups = null;
    }
    if (this.autoFilters) {
      this.autoFilters.clear();
      this.autoFilters = null;
    }
    // Reset dirty flags for next model load
    this._shadowsDirty = true;
    this._renderDirty = true;
    this.emit('model-cleared');
  }

  /** URL of the currently loaded model (null if no model loaded). */
  get currentModelUrl(): string | null {
    return this._currentModelUrl;
  }

  /** Override the stored model URL (e.g. to replace blob: URL with original for display). */
  set currentModelUrl(url: string | null) {
    this._currentModelUrl = url;
  }

  // ─── Scene loading (unified RvScene) ──────────────────────────────────

  /** Active scene record set by `loadScene()`. Read by the Scene window. */
  private _currentScene: RvScene | null = null;

  /** Read the currently loaded scene record, or null if none. */
  get currentScene(): RvScene | null {
    return this._currentScene;
  }

  /** Override the active scene record (used by main.ts after a side-channel
   *  load and by SceneStore once a save bumps modifiedAt). */
  set currentScene(s: RvScene | null) {
    this._currentScene = s;
  }

  /**
   * Load a unified Scene record — base GLB plus optional overlay, planner
   * placements, and camera preset.
   *
   * Apply order (deterministic):
   *   1. Resolve base URL (built-in / empty)
   *   2. Clear any planner placements from the previous scene
   *   3. loadGLB with `overlay` applied during traversal
   *   4. apply planner placements (if any)
   *   5. emit('scene-loaded')
   *
   * The camera preset (scene.cameraStart) is consumed by the camera-startpos
   * plugin, which subscribes to `scene-loaded`.
   * The BVH rebuild (after placements) is wired in PR 4.
   */
  async loadScene(scene: RvScene): Promise<void> {
    // Phase 0 — materialise edits (ops → overlay + placements + cameraStart).
    // The op log is the canonical store; existing engine subsystems
    // (rv-scene-loader.loadGLB, planner.applyPlacements, camera-startpos)
    // still consume their familiar shapes — materialise() bridges between
    // the two.
    const matMod = await import('./hmi/scene/rv-scene-edits');
    const materialised = matMod.materialise(scene.edits.ops);

    // Phase 1 — resolve base URL
    let url: string;
    if (scene.base.kind === 'empty') {
      const emptyGlb = await import('./hmi/scene/empty-glb');
      url = emptyGlb.getEmptyGlbUrl();
    } else {
      url = scene.base.url;
    }

    // Stash the active scene BEFORE loadModel so plugin onModelLoaded handlers
    // (e.g. the camera-startpos plugin) can prefer per-scene presets over the
    // per-base/legacy localStorage default. clearModel fires onModelCleared
    // first; that path doesn't read currentScene so the early stash is safe.
    this._currentScene = scene;

    // Phase 2 — clear previous planner placements + sweep any orphans
    // (defensive — see planner.sweepOrphanLayoutObjects).
    const planner = this.getPlugin<RVViewerPlugin & {
      clearLayout?: () => void;
      applyPlacements?: (snap: PlacementsSnapshot) => Promise<void>;
      ensureAttached?: (viewer: RVViewer) => void;
      sweepOrphanLayoutObjects?: () => void;
      setLayoutFloorVisible?: (visible: boolean) => void;
    }>('layout-planner');
    planner?.clearLayout?.();
    planner?.sweepOrphanLayoutObjects?.();

    // Phase 3 — loadGLB. Overlay is applied during traversal so component
    // constructors see overridden field values directly (no race window).
    const overlay = Object.keys(materialised.overlay.nodes).length > 0
      ? materialised.overlay
      : undefined;
    if (this.loadModelWithProgress) {
      await this.loadModelWithProgress(url, { overlay });
    } else {
      await this.loadModel(url, { overlay });
    }

    // Phase 4 — planner placements
    if (materialised.placements.length > 0) {
      if (!planner?.applyPlacements) {
        throw new Error('Scene has placements but Layout Planner plugin is not registered');
      }
      planner.ensureAttached?.(this);
      await planner.applyPlacements({
        placements: materialised.placements,
        catalogUrls: scene.edits.settings.catalogUrls,
        gridSizeMm: scene.edits.settings.gridSizeMm,
      });
    }

    // Phase 4b — keep the planner's authoring floor (`_layoutFloor`) hidden.
    // Both built-in and empty bases already render a floor: built-ins use
    // their own GLB ground, and empty bases use the viewer's `_groundMesh`
    // (the checker fade, deliberately sized to a 30 m playground when the
    // bbox is empty — see resize logic above loadModel). Showing the planner
    // floor on top would double up with either, producing the "duplicate
    // floor on reload" / "extra floor on empty scenes" symptoms.
    //
    // For empty bases we still call ensureAttached so the planner is wired
    // (raycast targets, ghost root) before any subsequent placement op runs.
    if (scene.base.kind === 'empty') {
      planner?.ensureAttached?.(this);
    }
    // applyPlacements() above unconditionally toggles the floor based on its
    // snapshot's `hasContent` — overrule it here so the visibility tracks
    // intent rather than placement count.
    planner?.setLayoutFloorVisible?.(false);

    // Phase 5 — drain again. loadModel already awaited whenLoadingIdle, but
    // applyPlacements above and any onModelLoaded handlers may have queued
    // additional cascading work after that point. Cheap when the queue is
    // empty; ensures `scene-loaded` only fires once the scene is fully ready.
    await this.whenLoadingIdle();

    // Camera preset has already been applied by the camera-startpos plugin
    // during onModelLoaded (it reads currentScene).
    this.emit('scene-loaded', { scene });
  }

  /**
   * Tear down the current scene without loading a new one. Used when the
   * Scene window deletes the active scene and no fallback exists.
   */
  async loadEmptyScene(): Promise<void> {
    this.clearModel();
    this._currentModelUrl = null;
    this._currentScene = null;
    this.markRenderDirty();
  }

  /** Explicit override for projectAssetsPath (set by ModelPluginManager in dev mode). */
  private _projectAssetsPath: string | null = null;

  /** Base URL for project-specific assets (docs, AASX, logos, branding). Ends with '/'.
   *  Priority: explicit override > settings.json `projectAssetsPath` > BASE_URL. */
  get projectAssetsPath(): string {
    if (this._projectAssetsPath) return this._projectAssetsPath;
    const cfg = getAppConfig().projectAssetsPath;
    if (!cfg) return import.meta.env.BASE_URL;
    // Relative paths resolve against BASE_URL
    if (!cfg.startsWith('http') && !cfg.startsWith('/'))
      return `${import.meta.env.BASE_URL}${cfg}`;
    return cfg;
  }

  set projectAssetsPath(path: string | null) {
    this._projectAssetsPath = path;
  }

  /**
   * Reload the current model. Useful when physics settings change and
   * the world needs to be rebuilt from scratch.
   * Returns the LoadResult, or null if no model was loaded.
   */
  async reloadModel(): Promise<LoadResult | null> {
    if (!this._currentModelUrl) return null;
    const url = this._currentModelUrl;
    return this.loadModel(url);
  }

  /** Clean up all resources. */
  dispose(): void {
    // Plugin lifecycle: dispose (before everything else)
    for (const p of this._plugins) {
      callPlugin(p, 'dispose');
    }
    this.loop.stop();
    this.clearModel();
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.controls.dispose();
    this.renderer.dispose();
    if (this.statsReady) {
      this.stats.dispose();
      this.stats.dom.remove();
    }
    this.removeAllListeners();
  }

  // ─── Highlight & Focus ───────────────────────────────────────────────

  /**
   * Highlight a component by its hierarchy path (orange overlay).
   * @param tracked  If true, overlays follow moving parts each frame.
   */
  highlightByPath(path: string, tracked = false): void {
    const node = this.registry?.getNode(path);
    if (!node) return;
    // Detect if target is a sensor (include sensor viz in highlight)
    const isSensor = !!(node.userData?.realvirtual as Record<string, unknown> | undefined)?.['Sensor'];
    this.highlighter.highlight(node, tracked, { includeSensorViz: isSensor });
  }

  /** Remove the current highlight. */
  clearHighlight(): void {
    this.highlighter.clear();
  }

  /**
   * Scale factor applied to the camera distance so a centered object still
   * clears side panels (left/right) and top/bottom bars without moving the
   * orbit pivot. We pull the camera back symmetrically instead of shifting the
   * orbit target, which keeps the rotation pivot exactly on the bounding-box
   * center while leaving the framed object fully inside the visible viewport.
   */
  private _panelFitScale(offset?: ViewportOffset): number {
    if (!offset) return 1;
    const canvas = this.renderer.domElement;
    const canvasW = canvas.clientWidth || 1;
    const canvasH = canvas.clientHeight || 1;
    const lr = Math.max(offset.left ?? 0, offset.right ?? 0);
    const tb = Math.max(offset.top ?? 0, offset.bottom ?? 0);
    const wScale = canvasW / Math.max(canvasW - 2 * lr, 1);
    const hScale = canvasH / Math.max(canvasH - 2 * tb, 1);
    return Math.max(wScale, hScale, 1);
  }

  /** Smoothly orbit camera to focus on a component by hierarchy path. Also pins the drive tooltip if the target is a drive.
   *  @param offset  Optional pixel offsets for panels obscuring the viewport (the camera is pulled back to keep the
   *                 object clear of the panels; the orbit pivot stays on the bounding-box center). */
  focusByPath(path: string, offset?: ViewportOffset): void {
    const node = this.registry?.getNode(path);
    if (!node) return;

    // Pin drive tooltip if the focused node is (or belongs to) a drive
    const drive = this.registry!.findInParent<RVDrive>(node, 'Drive')
      ?? (this.registry!.getByPath<RVDrive>('Drive', path) || null);
    this.focusedDrive = drive;
    this.focusedNode = node;
    this.emit('object-focus', { path, node });

    const box = this._cameraManager.computeNodeBounds([node]);
    if (box.isEmpty()) return;

    const center = new Vector3();
    const size = new Vector3();
    box.getCenter(center);
    box.getSize(size);

    const maxDim = Math.max(size.x, size.y, size.z, 0.1);
    const fov = this.perspCamera.fov * (Math.PI / 180);
    const effectiveOffset = offset ?? this.getCurrentViewportOffset();
    // Pull back symmetrically to clear panels — never shift the orbit pivot.
    const dist = (maxDim / (2 * Math.tan(fov / 2))) * 2.5 * this._panelFitScale(effectiveOffset);

    // Keep current viewing direction — just move along it to frame the target.
    // The orbit target is the true bounding-box center, so rotation always
    // pivots around the geometric center of the selection.
    const dir = new Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    const endPos = center.clone().add(dir.multiplyScalar(dist));
    this.animateCameraTo(endPos, center);
  }

  /** Smoothly animate camera to frame all given nodes.
   *  @param offset  Optional pixel offsets for panels obscuring the viewport (shifts orbit target). */
  fitToNodes(nodes: Object3D[], offset?: ViewportOffset): void {
    if (nodes.length === 0) return;
    const box = this._cameraManager.computeNodeBounds(nodes);
    if (box.isEmpty()) return;

    const center = new Vector3();
    const size = new Vector3();
    box.getCenter(center);
    box.getSize(size);

    const effectiveOffset = offset ?? this.getCurrentViewportOffset();

    // Compute distance so the bounding box fits in the viewport, then pull back
    // symmetrically to clear any panels. The orbit pivot stays on the true
    // bounding-box center so rotation always pivots around the selection center.
    const maxDim = Math.max(size.x, size.y, size.z, 0.1);
    const fovRad = this.perspCamera.fov * (Math.PI / 180);
    const halfTanFov = Math.tan(fovRad / 2);
    const margin = 1.8;
    const aspect = this.perspCamera.aspect;

    // Distance to fit vertically (full height) and horizontally (full width).
    const distV = maxDim / (2 * halfTanFov);
    const distH = maxDim / (2 * halfTanFov * aspect);
    const dist = Math.max(distV, distH) * margin * this._panelFitScale(effectiveOffset);

    const dir = new Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    const endPos = center.clone().add(dir.multiplyScalar(dist));
    this.animateCameraTo(endPos, center);
  }

  /** Clear pinned drive focus (e.g., user clicked canvas). */
  clearFocus(): void {
    if (this.focusedDrive || this.focusedNode) {
      this.focusedDrive = null;
      this.focusedNode = null;
      this.emit('object-blur', undefined);
    }
  }

  // ─── Scene Click → Hierarchy Selection ────────────────────────────────

  /**
   * Raycast from a mouse/pointer event using the grouped BVH system.
   * Returns the registry path or null.
   */
  private _raycastForRVNode(e: MouseEvent): string | null {
    return this.raycastManager?.raycastForRVNode(e) ?? null;
  }

  /**
   * Coalesce multiple synchronous BVH-rebuild requests into a single
   * microtask-deferred pass. Used by the planner after placement add/remove
   * (and after batch operations like applyPlacements).
   */
  private _bvhRebuildPending = false;
  rebuildGroupedBvh(): void {
    if (this._bvhRebuildPending) return;
    if (!this.currentModel || !this.registry || !this.raycastManager) return;
    this._bvhRebuildPending = true;
    queueMicrotask(() => {
      this._bvhRebuildPending = false;
      if (!this.currentModel || !this.registry || !this.raycastManager) return;
      const driveNodeSet = new Set(this.drives.map(d => d.node));
      const geo = buildRaycastGeometries(this.currentModel, this.drives, this.registry, driveNodeSet);
      const muMeshes = this._collectInstancedMeshes();
      this.raycastManager.setRaycastGeometry(geo, muMeshes);
    });
  }

  /**
   * Collect all InstancedMesh objects that serve as MU pools.
   * These are included in the raycast target list alongside the BVH meshes.
   */
  private _collectInstancedMeshes(): import('three').InstancedMesh[] {
    const result: import('three').InstancedMesh[] = [];
    this.scene.traverse((node) => {
      if (node.userData?._muPool && (node as import('three').InstancedMesh).isInstancedMesh) {
        result.push(node as import('three').InstancedMesh);
      }
    });
    return result;
  }

  // ─── Camera Settings (delegated to CameraManager) ───────────────────

  /** Field of view in degrees (perspective camera). */
  get fov(): number { return this._cameraManager.fov; }
  set fov(v: number) { this._cameraManager.fov = v; }

  /** Camera projection type. */
  get projection(): ProjectionType { return this._cameraManager.projection; }
  set projection(v: ProjectionType) { this._cameraManager.projection = v; }

  // ─── Visual Settings (delegated to VisualSettingsManager) ────────────

  /**
   * Fit the directional light shadow camera.
   *
   * Two modes:
   *   - **Tight-fit** (legacy): clip the shadow camera to the currently
   *     visible area around the orbit target for the best shadow map
   *     resolution. Safe only when every shadow caster is a moving drive
   *     child near the orbit target. Re-runs on every camera change.
   *   - **Full-scene** (used whenever a static uber-merged caster exists):
   *     the shadow camera was already set up at load time in `loadModel`
   *     — centered at the scene bbox center, with `_shadowPadMax` bounds
   *     big enough to cover the whole scene from any orbit target the
   *     user can reach. Rotation/pan/zoom do NOT change it, so this
   *     function is a no-op in full-scene mode. The controls-change
   *     handler skips `_shadowsDirty = true` for the same reason.
   */
  private _fitShadowToView(): void {
    if (!this.dirLight.parent || !this.renderer.shadowMap.enabled) return;

    const hasStaticUberCaster = (this._lastLoadResult?.uberMergeResult?.mergedCount ?? 0) > 0;
    if (hasStaticUberCaster) {
      // Full-scene mode: shadow camera was set up once in loadModel and
      // never needs to move. Don't touch `dirLight.target` here — doing so
      // would shift the shadow frustum when the orbit target moves, and
      // the shadow map would need a rebuild on every pan. Just flag the
      // map dirty (the caller only invokes us when _shadowsDirty was set,
      // i.e. on load / drive movement / MU spawn / shadow toggle).
      (this.renderer.shadowMap as unknown as { needsUpdate: boolean }).needsUpdate = true;
      return;
    }

    // Legacy tight-fit path: clip to the visible area at orbit distance
    const cam = this._activeCamera;
    const target = this.controls.target;
    const dist = cam.position.distanceTo(target);
    let visibleRadius: number;
    if ((cam as PerspectiveCamera).isPerspectiveCamera) {
      const fov = (cam as PerspectiveCamera).fov * Math.PI / 180;
      const halfH = dist * Math.tan(fov / 2);
      const aspect = (cam as PerspectiveCamera).aspect;
      visibleRadius = Math.sqrt(halfH * halfH + (halfH * aspect) * (halfH * aspect));
    } else {
      const oc = cam as OrthographicCamera;
      visibleRadius = Math.sqrt(
        Math.max(Math.abs(oc.left), Math.abs(oc.right)) ** 2 +
        Math.max(Math.abs(oc.top), Math.abs(oc.bottom)) ** 2,
      );
    }
    const pad = Math.min(visibleRadius * 1.3, this._shadowPadMax);

    const sc = this.dirLight.shadow.camera;
    sc.left = -pad;
    sc.right = pad;
    sc.top = pad;
    sc.bottom = -pad;

    // Re-center shadow camera target on orbit target
    this.dirLight.target.position.copy(target);
    this.dirLight.target.updateMatrixWorld();
    sc.updateProjectionMatrix();

    // Force shadow map re-render
    (this.renderer.shadowMap as unknown as { needsUpdate: boolean }).needsUpdate = true;
  }

  private syncOrthoFrustum(): void {
    const dist = this.orthoCamera.position.distanceTo(this.controls.target);
    const halfH = dist * Math.tan((this.perspCamera.fov * Math.PI / 180) / 2);
    const aspect = this.perspCamera.aspect;
    this.orthoCamera.left = -halfH * aspect;
    this.orthoCamera.right = halfH * aspect;
    this.orthoCamera.top = halfH;
    this.orthoCamera.bottom = -halfH;
    this.orthoCamera.updateProjectionMatrix();
  }

  // ─── Visual Settings (pure-delegation proxies) ─────────────────────────
  //
  // The proxies below forward 1:1 to `_visualSettings` with no extra
  // side-effects. They are marked `@deprecated` to nudge new code toward
  // `viewer.visualSettings.*`; removal is planned for v2.0.

  /** @deprecated Use `viewer.visualSettings.lightingMode` instead. Will be removed in v2.0. */
  get lightingMode() { return this._visualSettings.lightingMode; }
  /** @deprecated Use `viewer.visualSettings.lightingMode` instead. Will be removed in v2.0. */
  set lightingMode(mode: import('./hmi/visual-settings-store').LightingMode) { this._visualSettings.lightingMode = mode; }

  /** @deprecated Use `viewer.visualSettings.toneMapping` instead. Will be removed in v2.0. */
  get toneMapping(): ToneMappingType { return this._visualSettings.toneMapping; }
  /** @deprecated Use `viewer.visualSettings.toneMapping` instead. Will be removed in v2.0. */
  set toneMapping(v: ToneMappingType) { this._visualSettings.toneMapping = v; }

  /** @deprecated Use `viewer.visualSettings.toneMappingExposure` instead. Will be removed in v2.0. */
  get toneMappingExposure(): number { return this._visualSettings.toneMappingExposure; }
  /** @deprecated Use `viewer.visualSettings.toneMappingExposure` instead. Will be removed in v2.0. */
  set toneMappingExposure(v: number) { this._visualSettings.toneMappingExposure = v; }

  /** @deprecated Use `viewer.visualSettings.ambientColor` instead. Will be removed in v2.0. */
  get ambientColor(): string { return this._visualSettings.ambientColor; }
  /** @deprecated Use `viewer.visualSettings.ambientColor` instead. Will be removed in v2.0. */
  set ambientColor(hex: string) { this._visualSettings.ambientColor = hex; }

  /** @deprecated Use `viewer.visualSettings.ambientIntensity` instead. Will be removed in v2.0. */
  get ambientIntensity(): number { return this._visualSettings.ambientIntensity; }
  /** @deprecated Use `viewer.visualSettings.ambientIntensity` instead. Will be removed in v2.0. */
  set ambientIntensity(v: number) { this._visualSettings.ambientIntensity = v; }

  /** @deprecated Use `viewer.visualSettings.dirLightEnabled` instead. Will be removed in v2.0. */
  get dirLightEnabled(): boolean { return this._visualSettings.dirLightEnabled; }
  /** @deprecated Use `viewer.visualSettings.dirLightEnabled` instead. Will be removed in v2.0. */
  set dirLightEnabled(v: boolean) { this._visualSettings.dirLightEnabled = v; }

  /** @deprecated Use `viewer.visualSettings.dirLightColor` instead. Will be removed in v2.0. */
  get dirLightColor(): string { return this._visualSettings.dirLightColor; }
  /** @deprecated Use `viewer.visualSettings.dirLightColor` instead. Will be removed in v2.0. */
  set dirLightColor(hex: string) { this._visualSettings.dirLightColor = hex; }

  /** @deprecated Use `viewer.visualSettings.dirLightIntensity` instead. Will be removed in v2.0. */
  get dirLightIntensity(): number { return this._visualSettings.dirLightIntensity; }
  /** @deprecated Use `viewer.visualSettings.dirLightIntensity` instead. Will be removed in v2.0. */
  set dirLightIntensity(v: number) { this._visualSettings.dirLightIntensity = v; }

  /** @deprecated Use `viewer.visualSettings.shadowEnabled` instead. Will be removed in v2.0. */
  get shadowEnabled(): boolean { return this._visualSettings.shadowEnabled; }
  /** @deprecated Use `viewer.visualSettings.shadowEnabled` instead. Will be removed in v2.0. */
  set shadowEnabled(v: boolean) { this._visualSettings.shadowEnabled = v; }

  /** @deprecated Use `viewer.visualSettings.shadowIntensity` instead. Will be removed in v2.0. */
  get shadowIntensity(): number { return this._visualSettings.shadowIntensity; }
  /** @deprecated Use `viewer.visualSettings.shadowIntensity` instead. Will be removed in v2.0. */
  set shadowIntensity(v: number) { this._visualSettings.shadowIntensity = v; }

  /** @deprecated Use `viewer.visualSettings.shadowQuality` instead. Will be removed in v2.0. */
  get shadowQuality(): ShadowQuality { return this._visualSettings.shadowQuality; }
  /** @deprecated Use `viewer.visualSettings.shadowQuality` instead. Will be removed in v2.0. */
  set shadowQuality(v: ShadowQuality) { this._visualSettings.shadowQuality = v; }

  /** @deprecated Use `viewer.visualSettings.lightIntensity` instead. Will be removed in v2.0. */
  get lightIntensity(): number { return this._visualSettings.lightIntensity; }
  /** @deprecated Use `viewer.visualSettings.lightIntensity` instead. Will be removed in v2.0. */
  set lightIntensity(v: number) { this._visualSettings.lightIntensity = v; }

  // ─── Individual Rendering Settings (delegated to VisualSettingsManager) ──

  /**
   * Apply a full set of visual settings in one batch.
   * Delegates to individual setters on VisualSettingsManager.
   */
  applyVisualSettings(settings: import('./hmi/visual-settings-store').VisualSettings): void {
    const ms = settings.modeSettings[settings.lightingMode];

    // 1. Direct properties
    this.toneMappingExposure = ms.toneMappingExposure;
    this.ambientColor = ms.ambientColor;
    this.dirLightColor = ms.dirLightColor;
    this.dirLightIntensity = ms.dirLightIntensity;
    this.shadowIntensity = ms.shadowIntensity;
    this.shadowRadius = settings.shadowRadius ?? 2;

    // 2. Shadow map size (before enabling shadows)
    this.shadowMapSize = settings.shadowMapSize ?? 1024;

    // 3. DirLight on/off (before shadows, since shadowEnabled checks dirLight.parent)
    this.dirLightEnabled = ms.dirLightEnabled;

    // 4. Shadows
    this.shadowEnabled = ms.shadowEnabled;

    // 5. Tone mapping + lighting mode
    this.toneMapping = ms.toneMapping;
    this.lightingMode = settings.lightingMode;

    // 6. Light intensity (depends on lightingMode being set)
    this.lightIntensity = ms.lightIntensity;

    // 7. Camera
    this.fov = settings.fov;
    this.projection = settings.projection;

    // 8. SSAO (WebGL only)
    this.aoMode = settings.aoMode ?? 'gtao';
    this.ssaoIntensity = settings.ssaoIntensity ?? 1.0;
    this.ssaoRadius = settings.ssaoRadius ?? 0.15;

    // 9. Bloom (WebGL only)
    this.bloomEnabled = settings.bloomEnabled ?? true;
    this.bloomIntensity = settings.bloomIntensity ?? 0.2;
    this.bloomThreshold = settings.bloomThreshold ?? 0.85;
    this.bloomRadius = settings.bloomRadius ?? 0.4;

    // 10. Ground / Floor
    this.groundEnabled = settings.groundEnabled ?? true;
    // Apply color BEFORE brightness so the brightness setter's combine math
    // sees the user's chosen base color instead of recomputing twice.
    this.groundColor = settings.groundColor ?? '#ffffff';
    this.groundBrightness = settings.groundBrightness ?? 1.0;
    this.backgroundBrightness = settings.backgroundBrightness ?? 1.0;
    this.checkerContrast = settings.checkerContrast ?? 1.0;

    // 11. Navigation sensitivity (OrbitControls)
    if (this.controls) {
      applyNavigationSettingsToControls(this.controls, settings);
    }
  }

  // ─── Individual Rendering Settings (pure-delegation proxies) ───────────

  /** @deprecated Use `viewer.visualSettings.effectiveDpr` instead. Will be removed in v2.0. */
  get effectiveDpr(): number { return this._visualSettings.effectiveDpr; }

  /** @deprecated Use `viewer.visualSettings.maxDpr` instead. Will be removed in v2.0. */
  set maxDpr(cap: number) { this._visualSettings.maxDpr = cap; }

  /** @deprecated Use `viewer.visualSettings.shadowMapSize` instead. Will be removed in v2.0. */
  set shadowMapSize(size: number) { this._visualSettings.shadowMapSize = size; }

  /** @deprecated Use `viewer.visualSettings.shadowRadius` instead. Will be removed in v2.0. */
  set shadowRadius(radius: number) { this._visualSettings.shadowRadius = radius; }

  // #region VisualSettingsProxies — post-processing side-effect setters
  //
  // The proxies below delegate to PostProcessingManager — the source of
  // truth for all composer-related state since plan-177 phase 7b. They
  // retain the same names as the original RVViewer setters so the 71
  // external consumers continue to work unchanged. The side-effects
  // (composer lazily ensured, `_renderDirty` flag set, AO pass lazy-
  // imported) all happen inside the manager now, not here.
  //
  // NOTE: These are NOT pure delegations — they trigger composer creation
  // and other side-effects, so they are intentionally NOT marked
  // `@deprecated`. They remain the official API surface for these
  // properties until / unless a future refactor exposes
  // `viewer.postProcessing` directly.

  /**
   * Ambient-occlusion backend: 'off' | 'gtao' | 'n8ao'. WebGL only — a no-op
   * on WebGPU. Switching to 'n8ao' triggers a dynamic import of the `n8ao`
   * package; if the module isn't installed or fails to load, the mode
   * silently reverts to 'gtao' with a console warning so the UI stays honest.
   */
  get aoMode(): AOMode { return this._postProcessing.aoMode; }
  set aoMode(mode: AOMode) { this._postProcessing.aoMode = mode; }

  /**
   * Legacy back-compat: boolean toggle mapping onto `aoMode`.
   *   true  → aoMode = 'gtao' (current default)
   *   false → aoMode = 'off'
   * Prefer `aoMode` directly in new code.
   */
  get ssaoEnabled(): boolean { return this._postProcessing.ssaoEnabled; }
  set ssaoEnabled(v: boolean) { this._postProcessing.ssaoEnabled = v; }

  /** AO blend intensity (0 = invisible, 1 = full). Writes to whichever backend
   *  is currently active; non-active backend picks it up on next activation. */
  get ssaoIntensity(): number { return this._postProcessing.ssaoIntensity; }
  set ssaoIntensity(v: number) { this._postProcessing.ssaoIntensity = v; }

  /** AO sampling radius in world units (GTAO scale; N8AO radius is derived). */
  get ssaoRadius(): number { return this._postProcessing.ssaoRadius; }
  set ssaoRadius(v: number) { this._postProcessing.ssaoRadius = v; }

  /** Whether bloom (glow on bright areas) is enabled. WebGL only. */
  get bloomEnabled(): boolean { return this._postProcessing.bloomEnabled; }
  set bloomEnabled(v: boolean) { this._postProcessing.bloomEnabled = v; }

  /** Bloom glow intensity (0–2). */
  get bloomIntensity(): number { return this._postProcessing.bloomIntensity; }
  set bloomIntensity(v: number) { this._postProcessing.bloomIntensity = v; }

  /** Brightness threshold for bloom (0–1). */
  get bloomThreshold(): number { return this._postProcessing.bloomThreshold; }
  set bloomThreshold(v: number) { this._postProcessing.bloomThreshold = v; }

  /** Bloom spread radius (0–1). */
  get bloomRadius(): number { return this._postProcessing.bloomRadius; }
  set bloomRadius(v: number) { this._postProcessing.bloomRadius = v; }

  // #endregion VisualSettingsProxies

  // ─── Profiler Overlay ────────────────────────────────────────────────

  /** Show/hide the stats-gl FPS/CPU/GPU overlay. */
  get showStats(): boolean { return this.statsReady && this.stats.dom.style.display !== 'none'; }
  set showStats(v: boolean) { if (this.statsReady) this.stats.dom.style.display = v ? '' : 'none'; }

  /** Enable/disable periodic renderer.info console logging. */
  rendererInfoLogging = false;

  // ─── Renderer Info (for dev tools) ────────────────────────────────────

  /** Diagnostic GPU info for the DevTools panel. Returns the active GPU
   *  immediately and merges in optional high-perf / low-power adapter
   *  data once the async probe resolves (typically <1 frame). */
  getGPUInfo(): GPUInfo | null {
    return this._gpuInfo;
  }

  /** Performance-tier diagnosis derived from the active GPU and any
   *  available adapter probes. Recomputed each call so it reflects the
   *  latest probe result without needing an event subscription. */
  getGPUAnalysis(): GPUAnalysis | null {
    return this._gpuInfo ? analyzeGPU(this._gpuInfo) : null;
  }

  /** Get renderer performance info (triangles, draw calls, etc.). */
  getRendererInfo(): {
    triangles: number;
    drawCalls: number;
    geometries: number;
    textures: number;
    programs: number;
    /** Materials before dedup (from GLB) */
    materialsOriginal: number;
    /** Materials after dedup + uber-material pass (unique references still on meshes) */
    materialsUnique: number;
    /** Meshes baked onto the RVUberMaterial singleton (0 if uber pass was a no-op) */
    uberBakedMeshCount: number;
    /** Meshes that shared an already-baked BufferGeometry instead of cloning (plan-153) */
    uberSharedGeometryReuses: number;
    /** Meshes that had to clone their geometry because of a material conflict (plan-153) */
    uberClonedGeometryCount: number;
    /** Orphaned source BufferGeometries that Pass 3 disposed (plan-153) */
    uberDisposedSourceGeometries: number;
    /** Number of uber-baked static meshes that fed into the uber static merge */
    uberMergeOriginal: number;
    /** Number of merged meshes created by the uber static batching pass (0 or 1) */
    uberMergeCreated: number;
    /** Kinematic Drive groups that were merged */
    kinGroupsMerged: number;
    /** Total source meshes collapsed by kinematic merge */
    kinSourceMeshes: number;
    /** Merged chunks created by kinematic merge */
    kinChunksCreated: number;
    /** Static meshes before merge */
    staticMeshesOriginal: number;
    /** Merged meshes created */
    staticMeshesMerged: number;
  } {
    const info = this.renderer.info;
    const dedup = this._lastLoadResult?.dedupResult;
    const uber = this._lastLoadResult?.uberResult;
    const uberMerge = this._lastLoadResult?.uberMergeResult;
    const kinMerge = this._lastLoadResult?.kinematicMergeResult;
    const merge = this._lastLoadResult?.mergeResult;
    return {
      // triangles / drawCalls come from the snapshot taken right after
      // renderer.render() — see _lastFrameStats. Reading info.render
      // directly would race with post-processing passes or per-plugin
      // renders that mutate the counter.
      triangles: this._lastFrameStats.triangles,
      drawCalls: this._lastFrameStats.drawCalls,
      geometries: (info as unknown as { memory?: { geometries?: number } }).memory?.geometries ?? 0,
      textures: (info as unknown as { memory?: { textures?: number } }).memory?.textures ?? 0,
      programs: (info as unknown as { programs?: unknown[] }).programs?.length ?? 0,
      materialsOriginal: dedup?.originalCount ?? 0,
      materialsUnique: dedup?.uniqueCount ?? 0,
      uberBakedMeshCount: uber?.bakedMeshCount ?? 0,
      uberSharedGeometryReuses: uber?.sharedGeometryReuses ?? 0,
      uberClonedGeometryCount: uber?.clonedGeometryCount ?? 0,
      uberDisposedSourceGeometries: uber?.disposedSourceGeometries ?? 0,
      uberMergeOriginal: uberMerge?.originalCount ?? 0,
      uberMergeCreated: uberMerge?.mergedCount ?? 0,
      kinGroupsMerged: kinMerge?.groupsMerged ?? 0,
      kinSourceMeshes: kinMerge?.sourceMeshCount ?? 0,
      kinChunksCreated: kinMerge?.chunksCreated ?? 0,
      staticMeshesOriginal: merge?.originalCount ?? 0,
      staticMeshesMerged: merge?.mergedCount ?? 0,
    };
  }

  /**
   * Run a quick GPU benchmark: render N frames in a tight loop (no vsync),
   * return uncapped FPS and average frame time.
   */
  async runBenchmark(frames = 120): Promise<{ uncappedFps: number; avgFrameMs: number; headroom: number }> {
    // Force a GPU flush before starting
    this.renderer.render(this.scene, this.camera);
    const ctx = this.renderer.getContext();
    const isWebGL = 'finish' in ctx;
    if (isWebGL) (ctx as WebGL2RenderingContext).finish();

    const start = performance.now();
    for (let i = 0; i < frames; i++) {
      this.renderer.render(this.scene, this.camera);
    }
    if (isWebGL) (ctx as WebGL2RenderingContext).finish();
    const elapsed = performance.now() - start;

    const avgFrameMs = elapsed / frames;
    const uncappedFps = Math.round(1000 / avgFrameMs);
    // Headroom: how much faster than 60fps are we? e.g., 180fps = 3x headroom
    const headroom = Math.round((1000 / avgFrameMs) / 60 * 100);

    return { uncappedFps, avgFrameMs: +avgFrameMs.toFixed(2), headroom };
  }

  // ─── Viewport Offset (delegated to CameraManager) ──────────────────

  /** Compute current viewport offset from open panels (hierarchy, inspector, left panels).
   *  Returns undefined when no panels obscure the viewport.
   *  NOTE: Uses INSPECTOR_PANEL_WIDTH from layout-constants internally. */
  getCurrentViewportOffset(): ViewportOffset | undefined {
    return this._cameraManager.getCurrentViewportOffset();
  }

  // ─── Camera Animation (delegated to CameraManager) ─────────────────

  /**
   * Smoothly animate the camera to a new position and orbit target.
   * @param position  Target camera position.
   * @param target    Target orbit center.
   * @param duration  Animation duration in seconds (default 0.6).
   */
  animateCameraTo(position: Vector3, target: Vector3, duration = 0.6): void {
    this._cameraManager.animateCameraTo(position, target, duration);
  }

  /** Whether a camera animation is currently in progress. */
  get isCameraAnimating(): boolean { return this._cameraManager.isCameraAnimating; }

  /**
   * Smoothly animate between perspective and orthographic projection.
   * Element-wise lerps between the two cameras' projection matrices, then
   * commits the actual camera swap at the end of the tween.
   */
  animateProjectionTo(v: ProjectionType, duration = 0.4): void {
    this._cameraManager.animateProjectionTo(v, duration);
  }

  /** Whether a projection animation is currently in progress. */
  get isProjectionAnimating(): boolean { return this._cameraManager.isProjectionAnimating; }

  // ──── Helper Methods für HMI/Plugin-Konsumenten (Phase 4b of plan-182) ────
  //
  // Diese Methoden delegieren an die Sub-Facaden (_scene/_camera/_controls)
  // und sind die EMPFOHLENE API für HMI-Komponenten + neue Plugins.
  // Direkte Zugriffe wie `viewer.scene.traverse(...)` sind `@deprecated`.

  /** Iterate over all nodes in the loaded model. Delegates to SceneFacade. */
  eachNode(fn: (node: Object3D, path: string) => void): void {
    this._scene.eachNode(fn);
  }

  /** Project a node's world position to screen pixels. Returns null if camera/renderer
   *  absent or node behind camera. */
  projectToScreen(node: Object3D, out?: Vector2): Vector2 | null {
    return this._scene.projectToScreen(node, out);
  }

  /** Project an arbitrary world point to screen pixels. */
  projectPoint(point: Vector3, out?: Vector2): Vector2 | null {
    return this._scene.projectPoint(point, out);
  }

  /** Snapshot of current camera state (position, OrbitControls target, quaternion).
   *  Optional `out` parameter for GC-free hot paths in HMI useFrame hooks. */
  getCameraState(out?: { position: Vector3; target: Vector3 }) {
    return this._camera.getCameraState(out);
  }

  /** Apply a partial OrbitControls configuration. Used by Settings panels.
   *  Wraps multiple property writes that previously went directly to `viewer.controls.X = val`. */
  setControlsConfig(cfg: Partial<{ rotateSpeed: number; panSpeed: number; zoomSpeed: number; dampingFactor: number; enabled: boolean }>): void {
    this._controls.setConfig(cfg);
  }

  /** Toggle verbose renderer-info logging. Used by DevTools panel.
   *  Replaces direct `viewer.rendererInfoLogging = v` writes. */
  setDebugLogging(enabled: boolean): void {
    this.rendererInfoLogging = enabled;
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private lastHoveredDrive: RVDrive | null = null;
  private lastHoverClientX = 0;
  private lastHoverClientY = 0;
  private lastRenderTime = 0;
  /** Shadow map dirty flag — when false, shadow pass is skipped entirely. */
  private _shadowsDirty = true;
  /** Max shadow padding from model load (scene-wide coverage). */
  private _shadowPadMax = 100;
  /** Render dirty flag — when false, renderer.render() is skipped (Phase 4: render-on-demand). */
  private _renderDirty = true;
  /**
   * Snapshot of the most recent main-scene render's draw-call and triangle
   * counts. Captured immediately after `renderer.render()` / `composer.render()`
   * inside the dirty-flag block, so the 200ms DevTools polling read sees a
   * stable value rather than racing with post-render plugin passes or the
   * next frame's reset.
   */
  private _lastFrameStats = { drawCalls: 0, triangles: 0 };
  /** Frames remaining for damping after last user input (Phase 4). */
  private _dampingFramesRemaining = 0;
  /** Previous MU count — used to detect spawn/despawn for shadow dirty flag. */
  private _prevMuCount = 0;
  /** Reference to the ground plane mesh (if created). */
  private _groundMesh: Mesh | null = null;
  /** Canvas backing the checker CanvasTexture — re-drawn when checkerContrast changes. */
  private _checkerCanvas: HTMLCanvasElement | null = null;
  /** Floor checker pattern contrast (0 = flat midgray, 1 = default, 2 = doubled). */
  private _checkerContrast = 1.0;
  /** Scene background brightness multiplier (0 = black, 1 = default, 2 = white). */
  private _backgroundBrightness = 1.0;
  /** Floor brightness multiplier (0 = black, 1 = default, 2 = double). Combined
   *  with `_groundColor` to compute the actual material tint. */
  private _groundBrightness = 1.0;
  /** Floor base color (default white). */
  private _groundColor = new Color(0xffffff);

  // Isolate-overlay and desaturation pass state now live in PostProcessingManager.

  private fixedUpdate(dt: number): void {
    this.simTickCount++;
    const isConnected = this._connectionState === 'Connected';

    // Recording playback — guarded by DrivesRecorder.Active
    if (this.playback && this.playback.isPlaying && isActiveForState(this.playback.activeOnly, isConnected)) {
      this.playback.update(dt);
    }

    // LogicStep engine — guarded by Active
    if (this.logicEngine && isActiveForState(this.logicEngine.activeOnly, isConnected)) {
      this.logicEngine.fixedUpdate(dt);
    }

    // ReplayRecording signal-triggered sequences — each has its own Active
    for (const rr of this.replayRecordings) {
      if (isActiveForState(rr.activeOnly, isConnected)) {
        rr.fixedUpdate(dt);
      }
    }

    // ── TickStage.PRE ──────────────────────────────────────────────────────
    // 1. Legacy onFixedUpdatePre-Plugins (defensive snapshot — protects against
    //    a plugin that removes itself mid-iteration, e.g. via disablePlugin).
    for (const p of this._snapshotPrePlugins()) {
      callPlugin(p, 'onFixedUpdatePre', dt);
    }
    // 2. SimLoopFacade.onTick(PRE) callbacks — adapters flush incoming PLC signals here.
    this._runTickCallbacks(TickStage.PRE, dt);

    // ── TickStage.SIM (Core) ───────────────────────────────────────────────

    // ── Core Drive Physics (behaviors + motion, drives[] may be topologically sorted) ──
    for (const drive of this.drives) {
      drive.update(dt);
      if (drive.isRunning || drive.positionOverwrite) {
        this._renderDirty = true;
        // Conveyor drives (jogForward/jogBackward) don't move geometry — only belt speed
        // changes. No shadow recompute needed for them.
        if (!drive.jogForward && !drive.jogBackward) {
          this._shadowsDirty = true;
        }
      }
    }

    // Mark shadows + render dirty only when MU count changes (spawn/despawn),
    // not when MUs merely exist. MU position changes already trigger render via
    // drive.isRunning on the transport surface drive.
    const muCount = this.transportManager ? this.transportManager.mus.length : 0;
    if (muCount !== this._prevMuCount) {
      this._shadowsDirty = true;
      this._renderDirty = true;
    }
    this._prevMuCount = muCount;

    // ── Core Transport (kinematic — skipped when physics plugin is active) ──
    if (this.transportManager && !this._physicsPluginActive) {
      this.transportManager.update(dt);
    }

    // ── Texture animation (always runs, even when physics plugin handles transport) ──
    if (this.transportManager) {
      this.transportManager.updateTextureAnimations(dt);
      // Mark render dirty when any surface is actively animating its belt texture
      for (const surface of this.transportManager.surfaces) {
        if (surface.isActive) {
          this._renderDirty = true;
          break;
        }
      }
    }

    // ── Tank fill visualization (clip plane updates) ──
    if (this.tankFillManager && this.tankFillManager.update()) {
      this._renderDirty = true;
    }

    // ── Gizmo overlay blink loop (early-returns when no entries) ──
    this.gizmoManager.tick(dt * 1000);

    // ── Pipe flow visualization (animated rings) ──
    if (this.pipeFlowManager && this.pipeFlowManager.update(dt)) {
      this._renderDirty = true;
    }

    // 3. SimLoopFacade.onTick(SIM) callbacks — run AFTER all core SIM subsystems
    //    (Drive-Physics + Transport + TankFill + PipeFlow + Gizmo) have updated,
    //    so plugins reading drive positions or MU counts see the current-tick values.
    this._runTickCallbacks(TickStage.SIM, dt);

    // 3b. Behavior onFixedUpdate fan-out (auto-disposed on model-cleared).
    this.behaviors.tick(dt);

    // ── TickStage.POST ─────────────────────────────────────────────────────
    // 4. Legacy onFixedUpdatePost-Plugins (defensive snapshot).
    for (const p of this._snapshotPostPlugins()) {
      callPlugin(p, 'onFixedUpdatePost', dt);
    }
    // 5. SimLoopFacade.onTick(POST) callbacks — recorders, stats, adapter readback.
    this._runTickCallbacks(TickStage.POST, dt);

  }

  // ─── Defensive Plugin Iteration (Phase 5 of plan-182) ────────────────────
  //
  // Snapshots protect against iterator-invalidation: a plugin that removes
  // itself during fixedUpdate() (via disablePlugin/removePlugin) would otherwise
  // mutate the array while we are iterating it. slice() returns a shallow copy
  // so that plugins registered in the same tick are deferred to the next one.

  /** @internal */
  _snapshotPrePlugins(): readonly RVViewerPlugin[] {
    return this._prePlugins.slice();
  }

  /** @internal */
  _snapshotPostPlugins(): readonly RVViewerPlugin[] {
    return this._postPlugins.slice();
  }

  // ─── _runTickCallbacks — per-stage SimLoopFacade tick (Phase 5 of plan-182) ─

  /** Run all onTick callbacks for a given stage, with defensive snapshot.
   *  Each callback is wrapped in try/catch — one failing callback does not stop the others.
   *  @internal */
  private _runTickCallbacks(stage: TickStage, dt: number): void {
    const list = this._simLoop._ticks.get(stage);
    if (!list || list.length === 0) return;
    // Defensive snapshot: a callback may register/unregister callbacks during execution.
    const snapshot = list.slice();
    for (const entry of snapshot) {
      try {
        entry.callback(dt);
      } catch (e) {
        console.error(`[RVViewer] onTick(${TickStage[stage]}) callback error:`, e);
      }
    }
  }

  // ─── _tickOnce — Synchronous tick for tests (Phase 5 of plan-182) ────────
  //
  // Calls the EXACT same code path as the production fixedUpdate(), so tests
  // can step the simulation deterministically without spinning up a real
  // SimulationLoop / requestAnimationFrame chain.
  //
  // Usage in tests: `(viewer as any)._tickOnce(0.016)`

  /** @internal */
  _tickOnce(dt: number): void {
    this.fixedUpdate(dt);
  }

  /**
   * Render the overlay-only layers (highlights + measurement markers, lines,
   * distance labels) on top of whatever is currently in the back buffer.
   *
   * Called AFTER the main scene render AND after `plugin.onRender` so the
   * gaussian-splat plugin's library render (which alpha-blends splat pixels
   * with `depthTest=true / depthWrite=false`) cannot overwrite overlays —
   * those visually disappeared into the splat backdrop otherwise even
   * though their materials use depthTest=false.
   *
   * Background-nulling guards three.js' Background.js which would call
   * `forceClear=true` and wipe the back buffer when scene.background is a
   * Color (mirrors the same dance _renderIsolateMode performs).
   */
  private _renderOverlayLayers(): void {
    const gl = this.renderer as unknown as WebGLRenderer;
    const prevAutoClear = gl.autoClear;
    const prevLayerMask = this.camera.layers.mask;
    gl.autoClear = false;
    const savedBg = this.scene.background;
    this.scene.background = null;
    try {
      setOverlayLayersOnly(this.camera);
      gl.clearDepth();
      gl.render(this.scene, this.camera);
    } finally {
      this.scene.background = savedBg;
      this.camera.layers.mask = prevLayerMask;
      gl.autoClear = prevAutoClear;
    }
  }

  private render(): void {
    if (this.statsReady) this.stats.begin();
    const now = performance.now() / 1000;
    const frameDt = this.lastRenderTime > 0 ? Math.min(now - this.lastRenderTime, 0.1) : 0.016;
    this.lastRenderTime = now;

    // FPS counter (updated every 500ms)
    this.fpsFrameCount++;
    this.fpsAccumTime += frameDt;
    if (this.fpsAccumTime >= 0.5) {
      this.currentFps = Math.round(this.fpsFrameCount / this.fpsAccumTime);
      this.currentFrameTime = +(this.fpsAccumTime / this.fpsFrameCount * 1000).toFixed(1);
      this.fpsFrameCount = 0;
      this.fpsAccumTime = 0;
    }

    this._cameraManager.tickCameraAnimation(frameDt);
    // Camera animation keeps render dirty
    if (this._cameraManager.isCameraAnimating) this._renderDirty = true;
    // Projection animation: lerps the active camera's projection matrix in
    // place, so the renderer needs to redraw every frame for the duration.
    this._cameraManager.tickProjectionAnimation(frameDt);
    if (this._cameraManager.isProjectionAnimating) this._renderDirty = true;
    // Damping: keep rendering for N frames after last user input
    if (this._dampingFramesRemaining > 0) {
      this._dampingFramesRemaining--;
      this._renderDirty = true;
    }
    if (this.controls.enabled) this.controls.update();
    // Highlight tracked mode needs rendering when overlays move
    if (this.highlighter.isActive || this.highlighter.isSelectionActive) this._renderDirty = true;
    this.highlighter.update();

    // A pending shadow-dirty flag MUST trigger a render, otherwise the
    // flag would be consumed below without the shadow map ever being
    // regenerated (shadowMap.render only runs inside renderer.render).
    if (this._shadowsDirty) this._renderDirty = true;

    // XR sessions MUST render every frame — the compositor needs a submitted
    // frame each animation tick or the passthrough/scene will freeze.
    const glXR = (this.renderer as unknown as WebGLRenderer).xr;
    if (glXR?.isPresenting) this._renderDirty = true;

    // Render-on-demand: skip expensive GPU render when scene is static
    const didMainRender = this._renderDirty;
    const isXRPresentingNow = (this.renderer as unknown as WebGLRenderer).xr?.isPresenting;
    const isolateActiveNow = this.groups?.isIsolateActive || this.autoFilters?.isIsolateActive;
    if (this._renderDirty) {
      // Shadow dirty flag handling lives INSIDE the render block so a
      // pending shadow update isn't silently cleared on a skipped frame.
      if (this._shadowsDirty) {
        this._fitShadowToView();
      }
      (this.renderer.shadowMap as unknown as { needsUpdate: boolean }).needsUpdate = this._shadowsDirty;
      this._shadowsDirty = false;

      // Manually reset per-frame counters (autoReset was disabled during
      // renderer setup) so the snapshot below reflects the total cost of
      // this frame's render path, summed across all passes.
      (this.renderer.info as unknown as { reset(): void }).reset();
      // Save and restore camera layer mask / autoClear across the render
      // branch so an exception in any pass can't corrupt global renderer
      // state for subsequent frames. autoClear is WebGL-specific, so cast
      // for the getter/setter.
      const prevLayerMask = this.camera.layers.mask;
      const glForClearState = this.renderer as unknown as WebGLRenderer;
      const prevAutoClear = glForClearState.autoClear;
      try {
        // XR sessions must always go through the direct renderer path —
        // EffectComposer renders to its own offscreen render targets, and
        // the multi-pass isolate mode clears/overlays in ways that break
        // the XR compositor. Passthrough camera would still show, but no
        // 3D content lands in the XR framebuffer → invisible scene.
        const xrPresenting = (this.renderer as unknown as WebGLRenderer).xr?.isPresenting;
        if (xrPresenting) {
          this.renderer.render(this.scene, this.camera);
        } else if (this.groups?.isIsolateActive || this.autoFilters?.isIsolateActive) {
          this._renderIsolateMode();
        } else if (this._useComposer) {
          const gtaoPass = this._postProcessing.gtaoPass;
          const n8cam = this._postProcessing.n8aoPass as (Pass & { camera?: PerspectiveCamera | OrthographicCamera }) | null;
          const composer = this._postProcessing.composer!;
          const renderPass = composer.passes[0] as RenderPass;
          if (renderPass) renderPass.camera = this.camera;
          // OutlinePass also caches a camera reference at construction —
          // re-bind to the live active camera so outlines stay aligned
          // with their objects after a projection swap.
          this.outlineManager.syncCamera();

          // Pull overlay layers OUT of the composer's main pass:
          //  (a) any depth accidentally written by a highlight wireframe or a
          //      measurement label sprite (SpriteMaterial defaults depthWrite=true
          //      even when transparent=true) would contaminate the GTAO/N8AO
          //      depth sample → halo artifacts around the overlay;
          //  (b) GTAO darkens the entire color buffer post-AO, so an overlay
          //      drawn over a cavity edge in pass 1 would visibly DIM. Rendering
          //      overlays AFTER the composer fixes both issues — same pattern
          //      as the isolation-mode pass 4.
          //  HIGHLIGHT_OVERLAY_LAYER (hover/select wireframes) and
          //  MEASUREMENT_LAYER (markers, lines, distance labels) are both
          //  semantically overlay (depthTest:false, renderOrder>=11) and share
          //  the same exclusion.
          //
          //  Overlay pass itself runs AFTER the plugin onRender loop below —
          //  otherwise the gaussian-splat plugin's render call (which alpha-
          //  blends splats over whatever is in the back buffer) would
          //  overwrite measurement lines / distance labels with splat pixels.
          disableOverlayLayers(this.camera);
          // AO passes render their own gbuffer with a CLONE of the camera that
          // additionally excludes NO_AO_LAYER, so NO_AO-tagged in-scene UI
          // (ghost, grid, glow gizmos) casts no ambient-occlusion halos. The
          // clone is synced AFTER disableOverlayLayers so it inherits the
          // already-reduced mask (overlay layers stay out of AO too). The
          // RenderPass keeps the real camera so all that UI still renders with
          // correct depth-occlusion and bloom.
          const aoCam = this._postProcessing.syncAoCamera(this.camera);
          if (gtaoPass) gtaoPass.camera = aoCam;
          if (n8cam) n8cam.camera = aoCam;
          composer.render();
        } else {
          // Non-composer path — render scene without overlay layers so the
          // post-plugin overlay pass below can draw them on top of the
          // splat plugin's output (same reason as the composer branch).
          disableOverlayLayers(this.camera);
          this.renderer.render(this.scene, this.camera);
        }
      } finally {
        this.camera.layers.mask = prevLayerMask;
        glForClearState.autoClear = prevAutoClear;
      }
      // Snapshot draw-call / triangle counts into a stable field so the
      // DevTools poller (200ms) sees the last complete frame's totals and
      // not whatever stale or partial values renderer.info holds later.
      const r = (this.renderer.info.render ?? { calls: 0, triangles: 0 }) as {
        calls: number; triangles: number;
      };
      this._lastFrameStats.drawCalls = r.calls;
      this._lastFrameStats.triangles = r.triangles;
      this._renderDirty = false;
    }

    // ── Plugins Render ──
    for (const p of this._renderPlugins) {
      callPlugin(p, 'onRender', frameDt);
    }

    // ── Overlay layers (post-plugins) ──
    //
    // Highlights + measurement markers/lines/labels render LAST, after any
    // plugin onRender has touched the back buffer. This is what guarantees
    // they survive the gaussian-splat plugin's render call (which alpha-
    // blends splats and would otherwise overwrite measurement pixels even
    // though the overlay materials use depthTest=false).
    //
    // Skipped while: nothing was rendered this frame (`!didMainRender` →
    // overlay would draw against a stale buffer); isolate mode (it manages
    // overlay rendering itself); XR (compositor needs the submitted frame
    // untouched).
    if (didMainRender && !isolateActiveNow && !isXRPresentingNow) {
      this._renderOverlayLayers();
    }

    // Emit object-hover + backward-compatible drive-hover events
    if (this.raycastManager) {
      const rm = this.raycastManager;
      const hoveredNode = rm.hoveredNode;
      const hoveredType = rm.hoveredNodeType;
      const hoveredPath = rm.hoveredNodePath;
      const cx = rm.pointerClientX;
      const cy = rm.pointerClientY;

      // Track changes to throttle 'object-hover' to relevant transitions.
      const hoveredDrive = (hoveredNode && hoveredType === 'Drive')
        ? this.registry?.findInParent<RVDrive>(hoveredNode, 'Drive') ?? null
        : null;
      const driveChanged = hoveredDrive !== this.lastHoveredDrive;
      const dx = cx - this.lastHoverClientX;
      const dy = cy - this.lastHoverClientY;
      const movedEnough = dx * dx + dy * dy > 16; // 4px threshold squared
      if (driveChanged || movedEnough) {
        this.lastHoveredDrive = hoveredDrive;
        this.lastHoverClientX = cx;
        this.lastHoverClientY = cy;

        if (hoveredNode && hoveredType && hoveredPath) {
          this.emit('object-hover', {
            node: hoveredNode,
            nodeType: hoveredType,
            nodePath: hoveredPath,
            pointer: { x: cx, y: cy },
            hitPoint: rm.hoveredHitPoint,
            mesh: hoveredNode,
          });
        } else {
          this.emit('object-hover', null);
        }
      }
    }

    if (this.statsReady) { this.stats.end(); this.stats.update(); }

    // --- Renderer.info periodic logging (every 5s at 60fps) ---
    if (this.rendererInfoLogging) {
      this.rendererInfoFrameCount++;
      if (this.rendererInfoFrameCount >= 300) {
        this.rendererInfoFrameCount = 0;
        const info = this.renderer.info;
        const mem = info.memory;
        const rnd = info.render;
        if (!mem || !rnd) return;
        const dedup = this._lastLoadResult?.dedupResult;
        const merge = this._lastLoadResult?.mergeResult;
        debug('render',
          `DC: ${rnd.calls ?? 0} | Tris: ${rnd.triangles ?? 0} | ` +
          `Geo: ${mem.geometries ?? 0} | Tex: ${mem.textures ?? 0}` +
          (dedup ? ` | Mat: ${dedup.uniqueCount}/${dedup.originalCount}` : '') +
          (merge && merge.mergedCount > 0 ? ` | Merge: ${merge.originalCount}→${merge.mergedCount}` : '')
        );
        if (this._lastGeoCount > 0 && (mem.geometries ?? 0) > this._lastGeoCount + 10) {
          console.warn(`[Perf] Geometry count growing: ${this._lastGeoCount} → ${mem.geometries}`);
        }
        if (this._lastTexCount > 0 && (mem.textures ?? 0) > this._lastTexCount + 5) {
          console.warn(`[Perf] Texture count growing: ${this._lastTexCount} → ${mem.textures}`);
        }
        this._lastGeoCount = mem.geometries ?? 0;
        this._lastTexCount = mem.textures ?? 0;
      }
    }
  }

  // ─── Extracted Helper Methods ────────────────────────────────────────

  /** Detect whether the real WebGPU backend is active (not forceWebGL). */
  private _detectWebGPU(renderer: Renderer): boolean {
    if (!('isWebGPURenderer' in renderer)) return false;
    const backend = (renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend;
    return !!backend?.isWebGPUBackend;
  }

  /** Bind all canvas event listeners. Called ONCE in the constructor. */
  private _bindCanvasEvents(canvas: HTMLCanvasElement): void {
    // Trackpad: two-finger drag rotates when no modifier, pinch (ctrl+wheel) zooms.
    canvas.addEventListener('wheel', (e) => {
      if (e.ctrlKey) return;
      if (e.deltaMode !== 0) return;
      const absDY = Math.abs(e.deltaY);
      if (absDY >= 50 && e.deltaX === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const azimuth = e.deltaX * 0.003;
      const polar = e.deltaY * 0.003;
      const spherical = new Spherical().setFromVector3(
        this.camera.position.clone().sub(this.controls.target),
      );
      spherical.theta += azimuth;
      spherical.phi = Math.max(0.01, Math.min(Math.PI - 0.01, spherical.phi + polar));
      const offset = new Vector3().setFromSpherical(spherical);
      this.camera.position.copy(this.controls.target).add(offset);
      this.camera.lookAt(this.controls.target);
      this.controls.update();
    }, { passive: false });

    // #region CanvasInput
    //
    // Canvas pointer / context-menu / long-press input handling. Marked as a
    // region instead of extracted to a separate class because the handlers
    // touch 22+ `this` members across multiple subsystems (raycastManager,
    // registry, drives, highlighter, selectionManager, controls, plus the
    // private long-press and pointer-down tracking fields above). See plan-
    // 177 section 2.4 (DESCOPED CanvasInputHandler) for the rationale.

    // Canvas click: record pointer start, then select on pointerup only if
    // the pointer didn't move (drag threshold).
    const DRAG_THRESHOLD = DRAG_THRESHOLD_PX;
    canvas.addEventListener('pointerdown', (e) => {
      // Left button: track for click selection
      if (e.button === 0) {
        this._pointerDownPos = { x: e.clientX, y: e.clientY };
      }
      // Right button: track for context menu drag guard
      if (e.button === 2) {
        this._rightDownPos = { x: e.clientX, y: e.clientY };
      }
      // Touch long-press: start timer for context menu
      if (e.pointerType !== 'mouse' && e.button === 0) {
        this._cancelLongPress();
        this._longPressPos = { x: e.clientX, y: e.clientY };
        this._longPressTimer = setTimeout(() => {
          this._handleLongPress(e);
        }, 500);
      }
    });
    canvas.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !this._pointerDownPos) return;
      const dx = e.clientX - this._pointerDownPos.x;
      const dy = e.clientY - this._pointerDownPos.y;
      this._pointerDownPos = null;
      if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      // Note: _isOrbiting is NOT checked here — OrbitControls dispatches 'start'
      // on every pointerdown (setting _isOrbiting=true), but its 'end' event only
      // fires in its own pointerup handler which is registered AFTER ours.  The
      // drag-threshold check above is sufficient to distinguish taps from orbits.

      const hoveredNode = this.raycastManager?.hoveredNode ?? null;
      const hoveredType = this.raycastManager?.hoveredNodeType ?? null;
      const hoveredDrive = (hoveredNode && hoveredType === 'Drive')
        ? this.registry?.findInParent<RVDrive>(hoveredNode, 'Drive') ?? null
        : null;

      // Drive chart special mode: filter drives on click
      if (hoveredDrive && this._driveChartOpen) {
        this.filterDrives(hoveredDrive.name);
        return;
      }

      // Sensor chart special mode: filter sensors on click
      if (hoveredNode && hoveredType === 'Sensor' && this._sensorChartOpen) {
        const path = this.registry?.getPathForNode(hoveredNode);
        if (path) {
          this.filterNodes(hoveredNode.name);
          this.emit('object-clicked', { path, node: hoveredNode });
        }
        return;
      }

      // Normal selection: route through SelectionManager
      let hitPath: string | null = null;
      let hitNode: Object3D | null = null;
      let hitPoint: [number, number, number] | undefined;

      if (hoveredDrive) {
        hitPath = this.registry?.getPathForNode(hoveredDrive.node) ?? null;
        hitNode = hoveredDrive.node;
        // Get hit point from detailed raycast
        const detailed = this.raycastManager?.raycastForRVNodeDetailed(e);
        hitPoint = detailed?.hitPoint;
      } else {
        const detailed = this.raycastManager?.raycastForRVNodeDetailed(e);
        hitPath = detailed?.path ?? this._raycastForRVNode(e);
        hitPoint = detailed?.hitPoint;
        hitNode = hitPath && this.registry ? this.registry.getNode(hitPath) ?? null : null;
      }

      if (hitPath && hitNode) {
        if (e.shiftKey) {
          this.selectionManager.toggle(hitPath, hitPoint);
        } else {
          this.selectionManager.select(hitPath, hitPoint);
        }
        // Backward compat: emit object-clicked for existing listeners.
        // hitPoint lets click consumers tell WHERE on the object the click
        // landed (e.g. the snap-flip icon overlay distinguishes a click on its
        // sprite from a click on the object's geometry — both resolve to the
        // same placed root via the aux-target / ancestor-override resolution).
        this.emit('object-clicked', { path: hitPath, node: hitNode, hitPoint });
      } else {
        // Clicked empty space
        this.selectionManager.clear();
        this.clearFocus();
      }
    });

    // Double-click: emit object-focus for camera zoom
    canvas.addEventListener('dblclick', (e) => {
      const hitPath = this.raycastManager?.raycastForRVNode(e) ?? this._raycastForRVNode(e);
      if (hitPath && this.registry) {
        const node = this.registry.getNode(hitPath);
        if (node) {
          this.emit('object-focus', { path: hitPath, node });
          this.fitToNodes([node]);
        }
      }
    });

    // F key: Frame Selected — fit camera to current selection.
    // Industry-standard 3D-tool shortcut (Blender, Unity, Maya all use F).
    // Skipped while typing in form fields. Mirrors a dblclick `object-focus`
    // for the primary selected node so plugins listening on object-focus
    // (e.g. the property inspector) get the same trigger as a double-click.
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyF') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const snap = this.selectionManager.getSnapshot();
      if (snap.selectedPaths.length === 0 || !this.registry) return;
      const nodes: Object3D[] = [];
      for (const p of snap.selectedPaths) {
        const n = this.registry.getNode(p);
        if (n) nodes.push(n);
      }
      if (nodes.length === 0) return;
      e.preventDefault();
      const primary = snap.primaryPath ?? snap.selectedPaths[0];
      const primaryNode = this.registry.getNode(primary);
      if (primaryNode) this.emit('object-focus', { path: primary, node: primaryNode });
      this.fitToNodes(nodes);
    });

    // ── Context Menu (right-click) ───────────────────────────────────
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault(); // Always suppress browser context menu on canvas

      // Drag-distance guard: if user right-dragged (orbit rotation), skip
      if (this._rightDownPos) {
        const dx = e.clientX - this._rightDownPos.x;
        const dy = e.clientY - this._rightDownPos.y;
        if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
          this._rightDownPos = null;
          return;
        }
      }
      this._rightDownPos = null;

      // FPV guard: don't open context menu when FPV plugin is active
      const fpvPlugin = this.getPlugin('fpv') as { active?: boolean } | undefined;
      if (fpvPlugin?.active) return;

      this._openContextMenuFromEvent(e);
    });

    // ── Long-press cancellation ──────────────────────────────────────
    canvas.addEventListener('pointermove', (e) => {
      if (this._longPressTimer && this._longPressPos) {
        const dx = e.clientX - this._longPressPos.x;
        const dy = e.clientY - this._longPressPos.y;
        if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
          this._cancelLongPress();
        }
      }
    });
    canvas.addEventListener('pointerup', () => {
      this._cancelLongPress();
    });
    canvas.addEventListener('pointercancel', () => {
      this._cancelLongPress();
    });
    canvas.addEventListener('touchcancel', () => {
      this._cancelLongPress();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._cancelLongPress();
    });
  }

  // ─── Context Menu Helpers ───────────────────────────────────────────

  /** Cancel the long-press timer (touch context menu). */
  private _cancelLongPress(): void {
    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
    }
    this._longPressPos = null;
  }

  /** Handle long-press firing: raycast and open context menu. */
  private _handleLongPress(e: PointerEvent): void {
    this._longPressTimer = null;
    // _isOrbiting not checked: long-press timer is already cancelled by
    // pointermove beyond drag threshold (see listener above).

    // FPV guard
    const fpvPlugin = this.getPlugin('fpv') as { active?: boolean } | undefined;
    if (fpvPlugin?.active) return;

    // Use stored position for the raycast (finger may have moved slightly)
    const pos = this._longPressPos;
    if (!pos) return;

    // Create a synthetic mouse event at the stored position for raycast
    const syntheticEvent = { clientX: pos.x, clientY: pos.y } as MouseEvent;
    const detailed = this.raycastManager?.raycastForRVNodeDetailed(syntheticEvent);
    const path = detailed?.path ?? this._raycastForRVNode(syntheticEvent);
    if (!path) return;

    const node = this.registry?.getNode(path);
    if (!node) return;

    const target: ContextMenuTarget = {
      path,
      node,
      types: this.registry!.getComponentTypes(path),
      extras: (node.userData?.realvirtual ?? {}) as Record<string, unknown>,
      hitPoint: detailed?.hitPoint,
      hitNormal: detailed?.hitNormal,
    };

    if (this.raycastManager) {
      this.raycastManager.holdHover = true;
      const isLayout = !!(node.userData?.realvirtual as Record<string, unknown> | undefined)?.LayoutObject;
      this.highlighter.highlight(node, false, { includeChildDrives: isLayout });
    }
    this.contextMenu.open({ x: pos.x, y: pos.y }, target);
    navigator.vibrate?.(50);
    this._longPressPos = null;
  }

  /**
   * Raycast from a mouse event and open the context menu on the hit node.
   * Shared by the `contextmenu` event handler and long-press handler.
   */
  private _openContextMenuFromEvent(e: MouseEvent): void {
    const detailed = this.raycastManager?.raycastForRVNodeDetailed(e);
    const path = detailed?.path ?? this._raycastForRVNode(e);
    if (!path) return;

    const node = this.registry?.getNode(path);
    if (!node) return;

    const target: ContextMenuTarget = {
      path,
      node,
      types: this.registry!.getComponentTypes(path),
      extras: (node.userData?.realvirtual ?? {}) as Record<string, unknown>,
      hitPoint: detailed?.hitPoint,
      hitNormal: detailed?.hitNormal,
    };

    // Hold hover highlight while context menu is open.
    // OrbitControls fires 'start' on pointerdown (before contextmenu) which
    // disables the raycast manager and clears hover. Re-apply the highlight
    // here so the object stays highlighted while the menu is open.
    if (this.raycastManager) {
      this.raycastManager.holdHover = true;
      const isLayout = !!(node.userData?.realvirtual as Record<string, unknown> | undefined)?.LayoutObject;
      this.highlighter.highlight(node, false, { includeChildDrives: isLayout });
    }
    this.contextMenu.open({ x: e.clientX, y: e.clientY }, target);
    this.emit('context-menu-request', { pos: { x: e.clientX, y: e.clientY }, path, node });
  }
  // #endregion CanvasInput

  /** Set up XR if available (WebGPU real backend has no XR support). */
  private _setupXR(renderer: Renderer, container: HTMLElement): void {
    if (this.isWebGPU) return;
    const xr = (renderer as unknown as Record<string, unknown>).xr as Record<string, unknown> | undefined;
    if (!xr || typeof xr.addEventListener !== 'function') return;
    const glRenderer = renderer as unknown as WebGLRenderer;
    glRenderer.xr.enabled = true;

    glRenderer.xr.addEventListener('sessionstart', () => {
      this._savedBackground = this.scene.background as Color | null;
      this._savedShadowState = this.renderer.shadowMap.enabled;
      this.renderer.shadowMap.enabled = false;
      this.controls.enabled = false;
      if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler);
      if (this.resizeObserver) this.resizeObserver.disconnect();
      this.emit('xr-session-start', undefined as void);
    });
    glRenderer.xr.addEventListener('sessionend', () => {
      this.scene.background = this._savedBackground;
      this.renderer.shadowMap.enabled = this._savedShadowState;
      this.controls.reset();
      this.controls.enabled = true;
      if (this.resizeHandler) {
        window.addEventListener('resize', this.resizeHandler);
        this.resizeHandler();
      }
      if (this.resizeObserver) this.resizeObserver.observe(container);
      this.emit('xr-session-end', undefined as void);
    });
  }

  /** Initialize stats-gl with fallback for WebGPU incompatibility. */
  private _setupStats(renderer: Renderer): void {
    this.stats = new Stats({
      trackGPU: true,
      trackHz: true,
      trackCPT: false,
      logsPerSecond: 4,
      graphsPerSecond: 30,
      samplesLog: 40,
      samplesGraph: 10,
      precision: 2,
      minimal: false,
      horizontal: true,
    });
    this.stats.dom.style.position = 'absolute';
    this.stats.dom.style.bottom = '12px';
    this.stats.dom.style.left = '12px';
    this.stats.dom.style.display = 'none';
    document.body.appendChild(this.stats.dom);
    try {
      this.stats.init(renderer as unknown as WebGLRenderer);
      this.statsReady = true;
    } catch {
      console.warn('[RVViewer] stats-gl init failed — GPU profiling disabled');
      this.statsReady = false;
    }
  }

  // Ground plane factory (createGroundFade) and the checker pattern helper
  // (drawCheckerPattern) now live in `engine/rv-ground-plane.ts`. The
  // constants FLOOR_FADE_START_RATIO / FLOOR_FADE_END_RATIO are still
  // referenced inside loadModel() above for the dynamic ground scale.
}
