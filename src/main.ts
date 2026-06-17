// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * realvirtual Web Viewer — Entry Point
 *
 * Thin orchestrator that creates an RVViewer, handles model selection
 * (URL params, localStorage, Firebase demo mode), and initializes the HMI.
 *
 * All 3D, simulation, and data logic lives in RVViewer (core/rv-viewer.ts)
 * and the engine subsystems (core/engine/).
 * All UI lives in core/hmi/ (layout) and custom/ (content).
 */

import { RVViewer } from './core/rv-viewer';
import type { RVExtrasOverlay } from './core/engine/rv-extras-overlay-store';
import { debug, logInfo } from './core/engine/rv-debug';
import { initTestRunner } from './rv-test-runner';
import { fetchAppConfig, setAppConfig, initAnalytics } from './core/rv-app-config';
import { loadVisualSettings } from './core/hmi/visual-settings-store';
import { isMobileDevice } from './hooks/use-mobile-layout';
import { activateContext, registerUIElement } from './core/hmi/ui-context-store';
import { isSupported as isFsApiSupported, listSubfolderFiles, readFileAsUrl } from './core/engine/rv-local-filesystem';

// Private content (resolves to stubs when private folder is absent)
import { initHMI } from '@rv-private/custom/hmi-entry';
import { registerPrivatePlugins } from '@rv-private/private-plugins';

// Hide AGPL watermark for commercial/private builds
// (private projects show "powered by realvirtual" in the logo badge instead)
if (__RV_COMMERCIAL__ || __RV_HAS_PRIVATE__) {
  const wm = document.getElementById('rv-watermark');
  if (wm) wm.style.display = 'none';
}

// Core Plugins (always included in public AGPL build)
import { SensorMonitorPlugin } from './plugins/sensor-monitor-plugin';
import { TransportStatsPlugin } from './plugins/transport-stats-plugin';
import { CameraEventsPlugin } from './plugins/camera-events-plugin';
import { DriveOrderPlugin } from './plugins/drive-order-plugin';
import { CameraStartPosPlugin } from './plugins/camera-startpos-plugin';
import { KioskPlugin } from './plugins/kiosk-plugin';
import { AdaptiveNavPlugin } from './plugins/adaptive-nav-plugin';
import { MeasurementPlugin } from './plugins/measurement-plugin';
import { OrientationGizmoPlugin } from './plugins/rv-orientation-gizmo-plugin';
import { WebErrorPlugin } from './plugins/web-error-plugin';

// Extras editor plugin (hierarchy browser + property editor)
import { RvExtrasEditorPlugin } from './core/hmi/rv-extras-editor';

// Layout Planner (public — private extensions can attach via setExtension())
import { LayoutPlannerPlugin } from './plugins/layout-planner';
import { SnapPointPlugin } from './plugins/snap-point';
import { SnapFlipIconOverlay } from './plugins/snap-point/snap-flip-icon-overlay';

// SimController: Play/Pause-Toggle + Reset (TopBar toolbar widget).
import { SimControllerPlugin } from './plugins/sim-controller';

// Scene window: multi-scene browser + layout registry
import { initSceneStore } from './core/hmi/scene/scene-store-singleton';
import { migrateLegacyAutosave } from './core/hmi/scene/layout-registry';
import { readActiveId } from './core/hmi/scene/rv-scene-storage';

// CONNECT gateway plugin (NavButton + LeftPanel for interface management)
import { ConnectPlugin } from './plugins/connect-plugin';

// Industrial interface plugins (WebSocket Realtime, ctrlX, etc.)
import { InterfaceManager } from './interfaces/interface-manager';
import { WebSocketRealtimeInterface } from './interfaces/websocket-realtime-interface';
import { CtrlXInterface } from './interfaces/ctrlx-interface';
import { MqttInterface } from './interfaces/mqtt-interface';
import { TwinCatHmiInterface } from './interfaces/twincat-hmi-interface';

// Per-model plugin manager (loads/unloads plugins on model switch)
import { ModelPluginManager } from './core/rv-model-plugin-manager';

// Microsoft Teams JS SDK — dynamically imported only when ?teams=1

// --- localStorage keys ---
const LS_KEY_MODEL = 'rv-webviewer-last-model';
const LS_KEY_RENDERER = 'rv-webviewer-renderer';

// --- Renderer selection via URL parameter (fallback to localStorage) ---
// Mobile/touch devices always use WebGL — WebGPU is desktop-only unless explicitly overridden.
const params = new URLSearchParams(window.location.search);
const isTouchDevice = isMobileDevice();
const useWebGPU = !isTouchDevice
  && (params.get('renderer') ?? localStorage.getItem(LS_KEY_RENDERER)) === 'webgpu';

// --- Loading overlay ---
const loadingOverlay = document.getElementById('loading-overlay')!;
const loadingModelName = document.getElementById('loading-model-name')!;
const loadingProgressBar = document.getElementById('loading-progress-bar')!;
const loadingProgressPct = document.getElementById('loading-progress-pct')!;

function showLoadingOverlay(modelName: string) {
  loadingModelName.textContent = modelName;
  loadingProgressBar.classList.add('indeterminate');
  loadingProgressBar.style.width = '';
  loadingProgressPct.textContent = '';
  loadingOverlay.classList.remove('fade-out', 'hidden');
}

function setLoadingProgress(loaded: number, total: number) {
  const pct = Math.round((loaded / total) * 100);
  loadingProgressBar.classList.remove('indeterminate');
  loadingProgressBar.style.width = `${pct}%`;
  const loadedMB = (loaded / (1024 * 1024)).toFixed(1);
  const totalMB = (total / (1024 * 1024)).toFixed(1);
  loadingProgressPct.textContent = `${loadedMB} / ${totalMB} MB`;
}

function hideLoadingOverlay() {
  loadingOverlay.classList.add('fade-out');
  setTimeout(() => {
    loadingOverlay.classList.add('hidden');
    loadingOverlay.classList.remove('fade-out');
  }, 600);
}

async function init() {
  // --- Microsoft Teams integration ---
  // When running inside a Teams tab (?teams=1), dynamically import the Teams JS SDK
  // so the iframe handshake completes and Teams shows the content.
  const isTeams = params.has('teams');
  if (isTeams) {
    try {
      const microsoftTeams = await import('@microsoft/teams-js');
      await microsoftTeams.app.initialize();
      logInfo('Teams SDK initialized');
      microsoftTeams.app.notifySuccess();

      // Extract Teams display name and inject as URL param for multiuser auto-join
      if (!params.has('name')) {
        try {
          const ctx = await microsoftTeams.app.getContext();
          const teamsName = (ctx as any)?.user?.userPrincipalName?.split('@')[0]
            ?? (ctx as any)?.user?.id?.slice(0, 8)
            ?? 'TeamsUser';
          params.set('name', teamsName);
          const newUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
          window.history.replaceState(null, '', newUrl);
          logInfo(`Teams user name: ${teamsName}`);
        } catch { /* context unavailable — no-op */ }
      }
    } catch (e) {
      console.warn('[main] Teams SDK init failed (running outside Teams?)', e);
    }
  }

  // --- Load App Config (MUST complete before React mount — no flicker) ---
  const appConfig = await fetchAppConfig();

  // URL param override for lockSettings (highest priority)
  if (params.has('lockSettings')) {
    appConfig.lockSettings = params.get('lockSettings') !== 'false';
  }

  // Perf test mode: suppress UI chrome
  const perfMode = params.has('perf');
  if (perfMode) {
    appConfig.lockSettings = true;
  }

  // Set singleton — from here all stores have access via getAppConfig()
  setAppConfig(appConfig);

  // --- Analytics (only when configured in settings.json) ---
  initAnalytics();

  // --- Bootstrap context-aware UI visibility (from settings.json `ui` key) ---
  {
    const uiCfg = appConfig.ui;
    // Activate initial contexts (e.g. "kiosk" mode)
    const initCtxs = Array.isArray(uiCfg?.initialContexts) ? uiCfg!.initialContexts : [];
    for (const ctx of initCtxs) {
      if (typeof ctx === 'string' && ctx) activateContext(ctx);
    }
    // Apply visibility overrides (override code-declared defaults)
    const overrides = (typeof uiCfg?.visibilityOverrides === 'object' && uiCfg?.visibilityOverrides !== null)
      ? uiCfg!.visibilityOverrides
      : {};
    for (const [id, rule] of Object.entries(overrides)) {
      if (rule && typeof rule === 'object') registerUIElement(id, rule);
    }
  }

  const container = document.getElementById('app')!;

  // --- Resolve antialias BEFORE renderer creation (constructor-only param) ---
  const initialSettings = loadVisualSettings();
  const wantAntialias = initialSettings.antialias !== false && !isTouchDevice;

  // --- Create Viewer ---
  const viewer = await RVViewer.create(container, { useWebGPU, antialias: wantAntialias });

  // Apply persisted DPR cap (runtime-changeable, no reload needed)
  viewer.maxDpr = initialSettings.maxDpr;

  // Apply persisted visual settings NOW — before any model load. This kicks
  // off the env-map (IBL) generation early so it overlaps with the GLB
  // download/parse instead of starting AFTER initHMI mounts the HMI and
  // its useEffect runs (which was the source of the "scene appears unlit,
  // then lighting kicks in" pop). Trackable via viewer.trackLoadingWork,
  // so `await viewer.loadModel(...)` waits for the IBL too.
  // The HMI's useApplyPersistedSettings still runs on mount; it's
  // idempotent for the same values and serves as a fallback if settings
  // change between boot and HMI mount.
  viewer.applyVisualSettings(initialSettings);

  // Expose viewer globally for console debugging
  (window as unknown as { viewer: RVViewer }).viewer = viewer;

  // --- Register Industrial Interfaces ---
  const ifaceManager = new InterfaceManager();
  ifaceManager.register(new WebSocketRealtimeInterface());
  ifaceManager.register(new CtrlXInterface());
  ifaceManager.register(new MqttInterface());
  ifaceManager.register(new TwinCatHmiInterface());

  // --- Register Core Plugins ---
  viewer
    .use(ifaceManager)
    .use(new DriveOrderPlugin())
    .use(new SensorMonitorPlugin())
    .use(new TransportStatsPlugin())
    .use(new CameraEventsPlugin())
    .use(new AdaptiveNavPlugin())
    .use(new CameraStartPosPlugin())
    .use(new KioskPlugin())
    .use(new MeasurementPlugin())
    .use(new WebErrorPlugin())
    .use(new RvExtrasEditorPlugin())
    .use(new ConnectPlugin())
    .use(new OrientationGizmoPlugin())
    .use(new LayoutPlannerPlugin())
    .use(new SnapPointPlugin())
    .use(new SnapFlipIconOverlay())
    .use(new SimControllerPlugin());

  // --- Lazy Plugins (code-split, loaded on demand) ---
  viewer.registerLazy('gaussian-splat', () =>
    import('./plugins/gaussian-splat-plugin').then(m => ({ default: m.GaussianSplatPlugin }))
  );

  // --- Per-model plugin manager (loads model-specific plugins on model switch) ---
  viewer.modelPluginManager = new ModelPluginManager();

  // --- Performance test plugin (activated via ?perf URL param) ---
  if (params.has('perf')) {
    const { PerfTestPlugin } = await import('./plugins/demo/perf-test-plugin');
    viewer.use(new PerfTestPlugin());
  }

  // --- Register Private Plugins (no-op in public build) ---
  registerPrivatePlugins(viewer);

  // --- Auto-discover behaviors (src/behaviors/*.ts) ---
  // Each behavior file declares which GLB filenames it applies to via
  // `models[]` and gets a fresh bind context on every matching load.
  const { registerAllBehaviors } = await import('./core/behaviors');
  registerAllBehaviors(viewer.behaviors);

  // --- Model discovery ---
  const modelFiles = import.meta.glob('/public/models/*.glb', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
  const entries = Object.keys(modelFiles).map((key) => {
    const filename = key.split('/').pop()!;
    return { filename, url: `${import.meta.env.BASE_URL}models/${filename}` };
  });

  // Discover private project models (served by privateModelsPlugin in dev)
  try {
    const resp = await fetch('/__api/private-models');
    if (resp.ok) {
      const privateModels: Array<{ project: string; filename: string; url: string }> = await resp.json();
      for (const pm of privateModels) {
        entries.push({ filename: pm.filename, url: pm.url });
      }
    }
  } catch { /* private models endpoint not available (production build) — ignore */ }

  // Runtime model manifest (generated during private project staging, replaces build-time glob).
  // If present, the manifest is AUTHORITATIVE — the build-time glob bundles
  // /public/models/*.glb from the dev environment (e.g. DemoRealvirtualWeb.glb) into every
  // build, but private deploys swap out the models folder on the server. Keeping the
  // build-time entries around would leave stale filenames matchable by localStorage, causing
  // 404s when a returning user had previously opened a model that only exists in another deploy.
  try {
    const resp = await fetch(`${import.meta.env.BASE_URL}models.json`, { cache: 'no-store' });
    if (resp.ok) {
      const runtimeModels: string[] = await resp.json();
      entries.length = 0;
      for (const filename of runtimeModels) {
        entries.push({ filename, url: `${import.meta.env.BASE_URL}models/${filename}` });
      }
    }
  } catch { /* no manifest — use build-time discovery only */ }

  // Discover local working folder models (File System Access API, Chrome/Edge only)
  if (isFsApiSupported()) {
    try {
      const localFiles = await listSubfolderFiles('models', ['.glb']);
      for (const f of localFiles) {
        const blobUrl = await readFileAsUrl(f.handle);
        entries.push({ filename: f.name, url: blobUrl });
      }
    } catch { /* permission denied or handle expired — skip silently */ }
  }

  // Expose discovered models to the HMI model selector
  viewer.availableModels = entries.map((e) => ({ url: e.url, label: e.filename.replace(/\.glb$/i, '') }));

  // ── Scene window: register, migrate any legacy autosave, build store ──
  // Migration runs once: if `rv-layout-autosave` exists from a previous session,
  // import it as an "Untitled Layout" entry in the new registry so users don't
  // lose their work. Idempotent on subsequent boots.
  migrateLegacyAutosave();
  const sceneStore = initSceneStore(viewer);

  // --- Load model helper ---
  // `options.overlay` carries the materialised rv-extras overrides from
  // loadScene(); it MUST be forwarded to viewer.loadModel so overrides are
  // applied to the GLB during traversal. Dropping it here was why saved drafts
  // reloaded with the original GLB values instead of the edited ones.
  async function loadModel(url: string, options?: { overlay?: RVExtrasOverlay }) {
    const modelName = (url.split('/').pop() ?? url).split('?')[0].replace(/\.glb$/i, '');
    showLoadingOverlay(modelName);
    localStorage.setItem(LS_KEY_MODEL, url);

    try {
      const loadStart = performance.now();

      // Fetch with streaming progress
      const resp = await fetch(url);
      const contentLength = resp.headers.get('content-length');
      const totalBytes = contentLength ? parseInt(contentLength) : 0;
      const sizeMB = totalBytes ? (totalBytes / (1024 * 1024)).toFixed(1) + ' MB' : '--';

      let modelUrl = url;
      if (totalBytes && resp.body) {
        // Stream the response to track download progress
        const reader = resp.body.getReader();
        const chunks: Uint8Array[] = [];
        let loaded = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.byteLength;
          setLoadingProgress(loaded, totalBytes);
        }
        const blob = new Blob(chunks as BlobPart[]);
        modelUrl = URL.createObjectURL(blob);
      }

      // Store original URL before loadModel (loadModel will set _currentModelUrl to blob URL)
      viewer.pendingModelUrl = url;

      const result = await viewer.loadModel(modelUrl, options);

      // Restore original URL (not blob:) so model selector can match it
      viewer.currentModelUrl = url;

      // Mark GLB scene active in the scene store (for the Scene window).
      // We re-derive the label so saved-from-localStorage entries stay
      // consistent with the discovered manifest.
      const matched = entries.find(e => e.url === url);
      const label = matched ? matched.filename.replace(/\.glb$/i, '') : modelName;
      // markGlbActive synthesizes a fresh draft RvScene on the new base —
      // viewer.currentScene is updated via that call.
      sceneStore.markGlbActive(url, label);

      // Clean up blob URL after a delay — GLTFLoader may have pending async
      // operations (DRACO decoder, texture loading) that still reference the
      // blob URL after loadModel() resolves.
      if (modelUrl !== url) setTimeout(() => URL.revokeObjectURL(modelUrl), 5000);

      const loadTime = ((performance.now() - loadStart) / 1000).toFixed(1) + 's';
      viewer.lastLoadInfo = { glbSize: sizeMB, loadTime };
      logInfo(`Model loaded: ${sizeMB}, ${loadTime}, ${result.drives.length} drives`);
      hideLoadingOverlay();
    } catch (e) {
      console.error(`[main] Failed to load model: ${url}`, e);
      hideLoadingOverlay();
    }
  }

  // Expose loadModel with progress overlay so Settings > Model can use it
  viewer.loadModelWithProgress = loadModel;

  // --- Firebase demo mode: /demo/webviewer/{demoName} ---
  const pathParts = window.location.pathname.split('/').filter(p => p);
  const webviewerIdx = pathParts.indexOf('webviewer');
  const firebaseDemoName = webviewerIdx >= 0 && pathParts[webviewerIdx + 1] ? pathParts[webviewerIdx + 1] : null;

  if (firebaseDemoName) {
    const bucketName = 'realvirtual-files.firebasestorage.app';
    const storagePath = `demo/webviewer/${firebaseDemoName}/demo.glb`;
    const firebaseGlbUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(storagePath)}?alt=media`;
    debug('config', `Firebase demo: "${firebaseDemoName}" → ${firebaseGlbUrl}`);
    document.title = `${firebaseDemoName} - realvirtual WEB`;
    loadModel(firebaseGlbUrl);
  } else {
    // ── URL routing for the unified Scene model ───────────────────────
    // ?scene=<id>             → open a saved scene by id (highest priority)
    // ?scene=builtin:<file>   → open a built-in by filename match
    // ?scene=empty            → fresh empty scene
    // ?model=<url>            → legacy alias (handled below)
    let sceneRouted = false;
    // ?mode=planner boots a fresh empty scene (unless an explicit ?scene/?model
    // is given) so a published link drops the user straight into layout authoring.
    const plannerMode = params.get('mode') === 'planner';
    const urlScene = params.get('scene') ?? (plannerMode && !params.get('model') ? 'empty' : null);
    if (urlScene) {
      try {
        if (urlScene === 'empty') {
          // Resume the autosaved per-base draft if there is one (mirror of
          // openBuiltin's resume semantics). `newEmpty()` would discard it —
          // that's reserved for the explicit "New empty scene" UI gesture.
          await sceneStore.openEmpty();
          hideLoadingOverlay();
          sceneRouted = true;
        } else if (urlScene.startsWith('builtin:')) {
          const wanted = decodeURIComponent(urlScene.slice('builtin:'.length));
          const match = entries.find(e => e.filename === wanted || e.url === wanted || e.url.endsWith(`/${wanted}`));
          if (match) {
            const label = match.filename.replace(/\.glb$/i, '');
            await sceneStore.openBuiltin(match.url, label);
            hideLoadingOverlay();
            sceneRouted = true;
          }
          // No match — fall through to default model resolution below.
        } else {
          // Treat as a saved scene id.
          await sceneStore.openScene(urlScene);
          hideLoadingOverlay();
          sceneRouted = true;
        }
      } catch (e) {
        console.warn(`[main] Failed to open ?scene=${urlScene}:`, e);
        // Fall through to default model resolution.
      }
    }

    // Model priority: URL param > last opened (localStorage, if still available) > settings.json defaultModel > first model.
    // The user's last choice wins over the deployer's default — `defaultModel` only kicks in on first visit
    // (empty localStorage) or when the saved model no longer exists in the manifest (e.g. after a deploy removed it).
    const urlModel = params.get('model');
    const configModel = appConfig.defaultModel;
    const savedModel = localStorage.getItem(LS_KEY_MODEL);

    // Resolve configModel: match against discovered entries, or build a URL from filename/path
    let resolvedConfigModel: string | null = null;
    if (configModel) {
      const match = entries.find((e) => e.url === configModel || e.filename === configModel);
      if (match) {
        resolvedConfigModel = match.url;
      } else {
        // Not in build-time manifest — resolve relative to BASE_URL (e.g. private deploy with swapped models)
        const isAbsoluteOrUrl = configModel.startsWith('http') || configModel.startsWith('/');
        resolvedConfigModel = isAbsoluteOrUrl
          ? configModel
          : `${import.meta.env.BASE_URL}${configModel.startsWith('models/') ? '' : 'models/'}${configModel}`;
      }
    }

    // Match saved model by URL or by filename (handles base path changes).
    // Only matches if the saved model is ACTUALLY available in this deploy — a user that
    // previously visited another deploy (or an older version of this one) gets fresh defaults
    // from settings.json instead of a 404 on a stale localStorage value.
    const savedEntry = savedModel
      ? entries.find((e) => e.url === savedModel || e.filename === savedModel.split('/').pop())
      : null;
    if (savedModel && !savedEntry) {
      debug('config', `Saved model "${savedModel}" not available in this deploy — falling back to settings.json defaultModel`);
      localStorage.removeItem(LS_KEY_MODEL);
    }

    const modelToLoad = urlModel
      ?? savedEntry?.url
      ?? resolvedConfigModel
      ?? null;

    // Defense-in-depth: if no `?scene=` param and a saved scene was active
    // last session (rv-scenes/active), resume it. This covers the path
    // where the user opened a saved scene from the panel — that flow now
    // also writes `?scene=`, but reload-after-save without URL refresh,
    // bookmarks predating the URL-write fix, or future code paths that
    // forget to update the URL still recover here.
    if (!sceneRouted) {
      try {
        const activeId = readActiveId();
        if (activeId) {
          await sceneStore.openScene(activeId);
          hideLoadingOverlay();
          sceneRouted = true;
        }
      } catch (e) {
        console.warn('[main] Failed to resume active saved scene:', e);
      }
    }

    if (sceneRouted) {
      // ?scene=… or active id already loaded — skip legacy model resolution.
    } else {
      // Default-model boot. Route through sceneStore.openBuiltin(...) so the
      // per-base draft (rv-scenes/draft/<base>) is consulted on every reload —
      // not just for explicit `?scene=builtin:` URLs. This restores
      // property-inspector edits (setField ops) which the legacy loadModel()
      // path discards via markGlbActive's empty-baseline workspace.
      const finalUrl = modelToLoad ?? entries[0]?.url ?? null;
      if (finalUrl) {
        const matched = entries.find(e => e.url === finalUrl);
        const label = matched
          ? matched.filename.replace(/\.glb$/i, '')
          : (finalUrl.split('/').pop() ?? finalUrl).split('?')[0].replace(/\.glb$/i, '');
        try {
          await sceneStore.openBuiltin(finalUrl, label);
          hideLoadingOverlay();
        } catch (e) {
          // Defence-in-depth: corrupted draft or transient error → fall back
          // to the legacy boot so the page still loads.
          console.warn('[main] sceneStore.openBuiltin failed, falling back to loadModel:', e);
          loadModel(finalUrl);
        }
      } else {
        hideLoadingOverlay();
      }
    }
  }

  // Deep-link: ?mode=planner opens the layout planner immediately — on the empty
  // scene routed above, or on whatever model/scene was explicitly requested.
  if (params.get('mode') === 'planner') {
    viewer.getPlugin<LayoutPlannerPlugin>('layout-planner')?.openPlanner();
  }

  // --- Initialize HMI React Overlay ---
  initHMI(viewer);

  // --- Dev-only: test runner + debug endpoint ---
  if (import.meta.env.DEV) {
    initTestRunner();
    const { DebugEndpointPlugin } = await import('./plugins/debug-endpoint-plugin');
    viewer.use(new DebugEndpointPlugin());

    // --- Dev-only: expose window.__rvInstruction for Playwright E2E + manual QA ---
    const instrStore = await import('./core/hmi/instruction-store');
    (window as unknown as { __rvInstruction?: unknown }).__rvInstruction = {
      show: instrStore.showInstruction,
      hide: instrStore.hideInstruction,
      clearBySource: instrStore.clearBySource,
      list: instrStore.getInstructions,
    };
  }

  // --- MCP bridge: DEV mode or ?mcp=1 URL param ---
  if (import.meta.env.DEV || params.has('mcp')) {
    const { McpBridgePlugin } = await import('./plugins/mcp-bridge-plugin');
    viewer.use(new McpBridgePlugin());
  }
}

init().catch(console.error);
