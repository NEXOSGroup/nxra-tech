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
import { fetchAppConfig, setAppConfig, initAnalytics, trackAnalyticsEvent } from './core/rv-app-config';
import { requireAnalyticsConsent } from './core/hmi/consent-gate';
import { loadVisualSettings } from './core/hmi/visual-settings-store';
import { loadPublishedPresets, seedInitialVisualPreset } from './core/hmi/visual-presets';
import { isMobileDevice } from './hooks/use-mobile-layout';
import { activateContext, registerUIElement } from './core/hmi/ui-context-store';
import { isSupported as isFsApiSupported, listSubfolderFiles, readFileAsUrl } from './core/engine/rv-local-filesystem';

// Private content (resolves to stubs when private folder is absent)
import { initHMI } from '@rv-private/custom/hmi-entry';
import { registerPrivatePlugins } from '@rv-private/private-plugins';

// Hide AGPL watermark only for explicitly commercial builds (RV_COMMERCIAL=1).
// Presence of the private folder alone no longer hides it, so the AGPL
// watermark stays visible in normal dev/private builds as well.
if (__RV_COMMERCIAL__) {
  const wm = document.getElementById('rv-watermark');
  if (wm) wm.style.display = 'none';
}

// Core Plugins (always included in public AGPL build)
import { SensorMonitorPlugin } from './plugins/sensor-monitor-plugin';
import { TransportStatsPlugin } from './plugins/transport-stats-plugin';
import { CameraEventsPlugin } from './plugins/camera-events-plugin';
import { DriveOrderPlugin } from './plugins/drive-order-plugin';
import { IKPathVisualizerPlugin } from './plugins/ik-path-visualizer-plugin';
import { IKTargetEditPlugin } from './plugins/ik-target-edit-plugin';
import { CameraStartPosPlugin } from './plugins/camera-startpos-plugin';
import { CameraFollowPlugin } from './plugins/camera-follow-plugin';
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

// DES workspace shell (plan-198) — UI surface for the DES mode.
import { DESWorkspacePlugin } from './plugins/des/des-workspace-plugin';

// Scene window: multi-scene browser + layout registry
import { initSceneStore } from './core/hmi/scene/scene-store-singleton';
import { migrateLegacyAutosave } from './core/hmi/scene/layout-registry';
import { parsePublishedIndex, publishedEntryFromFile, type PublishedSceneEntry } from './core/hmi/scene/rv-published-scenes';
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
const loadingStatus = document.getElementById('loading-status')!;
const loadingLabel = document.getElementById('loading-label')!;
const loadingModelName = document.getElementById('loading-model-name')!;
const loadingProgressBar = document.getElementById('loading-progress-bar')!;
const loadingProgressPct = document.getElementById('loading-progress-pct')!;
const loadingProgressWrap = loadingProgressBar.parentElement?.parentElement ?? null;
const loadingError = document.getElementById('loading-error')!;
const loadingErrorDetail = document.getElementById('loading-error-detail')!;
const loadingRetryBtn = document.getElementById('loading-retry-btn') as HTMLButtonElement;
const loadingReloadBtn = document.getElementById('loading-reload-btn') as HTMLButtonElement;

function showLoadingOverlay(modelName: string) {
  loadingLabel.textContent = 'Loading ';
  loadingModelName.textContent = modelName;
  loadingProgressBar.classList.add('indeterminate');
  loadingProgressBar.style.width = '';
  loadingProgressPct.textContent = '';
  hideLoadingError();
  loadingOverlay.classList.remove('fade-out', 'hidden');
}

// Show the error card inside the loading overlay (download/parse failed after all
// retries, or the WebGL context was lost). On mobile the console is invisible, so
// surfacing the failure here — with a Retry — is the difference between a usable
// error and a silent "empty scene". `detail` is a short, user-readable reason.
function showLoadingError(detail: string) {
  if (loadingProgressWrap) loadingProgressWrap.style.display = 'none';
  loadingStatus.style.display = 'none';
  loadingErrorDetail.textContent = detail;
  loadingError.classList.remove('hidden');
  loadingOverlay.classList.remove('fade-out', 'hidden');
}

function hideLoadingError() {
  loadingError.classList.add('hidden');
  loadingStatus.style.display = '';
  if (loadingProgressWrap) loadingProgressWrap.style.display = '';
}

// Indeterminate "Retrying (n/total)…" status between failed download attempts.
function setLoadingRetrying(attempt: number, total: number) {
  loadingLabel.textContent = `Connection problem — retrying (${attempt}/${total})…`;
  loadingModelName.textContent = '';
  loadingProgressBar.classList.add('indeterminate');
  loadingProgressBar.style.width = '';
  loadingProgressPct.textContent = '';
}

function setLoadingProgress(loaded: number, total: number) {
  // Download finished — what's left is GLB parse + scene construction, which
  // report no byte progress. Hand off to the indeterminate "preparing" state so
  // the bar doesn't sit deceptively full while seconds of work remain.
  if (total > 0 && loaded >= total) {
    setLoadingPreparing();
    return;
  }
  const pct = Math.round((loaded / total) * 100);
  loadingProgressBar.classList.remove('indeterminate');
  loadingProgressBar.style.width = `${pct}%`;
  const loadedMB = (loaded / (1024 * 1024)).toFixed(1);
  const totalMB = (total / (1024 * 1024)).toFixed(1);
  loadingProgressPct.textContent = `${loadedMB} / ${totalMB} MB`;
}

// Post-download phase: bytes are in, now parsing the GLB + building the scene.
// Animated (indeterminate) bar + label so the user knows work is still ongoing.
function setLoadingPreparing() {
  loadingProgressBar.classList.add('indeterminate');
  loadingProgressBar.style.width = '';
  loadingProgressPct.textContent = 'Preparing scene…';
}

function hideLoadingOverlay() {
  loadingOverlay.classList.add('fade-out');
  setTimeout(() => {
    loadingOverlay.classList.add('hidden');
    loadingOverlay.classList.remove('fade-out');
  }, 600);
}

/**
 * Download a GLB into a single ArrayBuffer with progress, a timeout and retries.
 *
 * Replaces the old fetch → chunks[] → Blob → object-URL path, which buffered the
 * file TWICE (chunk array + Blob). For large CAD GLBs on memory-constrained
 * mobile browsers that doubled peak memory and was a frequent out-of-memory →
 * blank-scene cause. Here the body streams straight into one pre-sized buffer.
 *
 * Robustness (all mobile-only failure modes in practice):
 * - `timeoutMs` aborts a stalled fetch — mobile networks silently drop requests.
 * - Up to `attempts` tries with linear back-off recover transient drops.
 * - A short stream (fewer bytes than content-length, i.e. a dropped connection)
 *   is treated as a failed attempt, not a corrupt model handed to the parser.
 * - A longer stream than content-length (gzip/br transfer-encoding) falls back
 *   to a growable collector instead of truncating.
 *
 * Throws after the final attempt; the caller surfaces a visible error overlay.
 */
async function downloadGlb(
  url: string,
  opts: { attempts: number; timeoutMs: number; onRetry: (attempt: number, total: number) => void },
): Promise<ArrayBuffer> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const len = parseInt(resp.headers.get('content-length') || '0', 10);

      // Streamed path: single pre-sized buffer + byte-accurate progress.
      if (resp.body && len > 0) {
        const buf = new Uint8Array(len);
        const reader = resp.body.getReader();
        let offset = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (offset + value.byteLength > len) {
            // Actual bytes exceed content-length (compressed transfer-encoding) —
            // switch to a growable collector seeded with what we already have.
            const parts: Uint8Array[] = [buf.slice(0, offset), value];
            let extraLen = offset + value.byteLength;
            for (;;) {
              const r = await reader.read();
              if (r.done) break;
              parts.push(r.value);
              extraLen += r.value.byteLength;
            }
            clearTimeout(timer);
            const out = new Uint8Array(extraLen);
            let o = 0;
            for (const c of parts) { out.set(c, o); o += c.byteLength; }
            return out.buffer;
          }
          buf.set(value, offset);
          offset += value.byteLength;
          setLoadingProgress(offset, len);
        }
        clearTimeout(timer);
        if (offset === len) return buf.buffer;
        throw new Error(`incomplete download (${offset}/${len} bytes)`);
      }

      // No content-length / no readable stream → single buffer, indeterminate bar.
      setLoadingPreparing();
      const data = await resp.arrayBuffer();
      clearTimeout(timer);
      return data;
    } catch (e) {
      clearTimeout(timer);
      lastErr = controller.signal.aborted
        ? new Error(`Timed out after ${Math.round(opts.timeoutMs / 1000)}s`)
        : e;
      if (attempt < opts.attempts) {
        opts.onRetry(attempt, opts.attempts);
        await new Promise(r => setTimeout(r, 700 * attempt));
      }
    }
  }
  throw lastErr ?? new Error('download failed');
}

/**
 * Discover read-only "Example" scenes shipped under public/scenes/.
 *
 * Prefers a curated `public/scenes/index.json` (`[{ file, name, mode }]`) so the
 * Examples list can carry display names and a per-scene preferred workspace
 * mode. Falls back to a build-time glob of the folder (filename-derived labels,
 * no mode) when the index is absent — e.g. during local dev before authoring it.
 */
async function discoverPublishedScenes(): Promise<PublishedSceneEntry[]> {
  try {
    const resp = await fetch(`${import.meta.env.BASE_URL}scenes/index.json`, { cache: 'no-store' });
    if (resp.ok) {
      const entries = parsePublishedIndex(await resp.json());
      if (entries.length > 0) return entries;
    }
  } catch { /* no index — fall through to glob */ }

  // The glob pattern only matches *.scene.json, so index.json is never included.
  const files = import.meta.glob('/public/scenes/*.scene.json', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
  return Object.keys(files)
    .map((k) => k.split('/').pop()!)
    .map(publishedEntryFromFile);
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

  // Load shipped visual presets (public/presets/index.json). Non-blocking for
  // correctness — the preset picker re-reads on open — but awaited here so the
  // first Settings open already has them. Missing manifest → no-op.
  await loadPublishedPresets();

  // Fresh install: seed the "Default" visual preset as the initial look so the
  // viewer boots on Default (and the Visual-settings dropdown shows it) instead
  // of "Custom". No-op once the user has saved visual settings. Must run after
  // loadPublishedPresets() (needs the preset list) and before the first
  // loadVisualSettings() below.
  seedInitialVisualPreset('Default');

  // --- Analytics consent gate ---
  // When a tracker is configured (settings.json analytics.googleAnalyticsId), GA
  // may not load without prior opt-in (GDPR / §25 TDDDG). Block boot until the
  // user accepts — without consent the app does not run. Private deploys with no
  // tracker id skip the gate entirely (this resolves immediately).
  await requireAnalyticsConsent();
  // Inject GA now that consent is in place (no-op when no id is configured).
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

  const app = document.getElementById('app')!;

  // Dedicated viewport container holding ONLY the WebGL canvas. It is full-bleed
  // by default; on desktop the HMI's <ViewportFrame> reactively insets it (left
  // for the activity bar + an open left window, right for an open right window)
  // so the 3D renders only in the central viewport region — never behind the
  // chrome. The renderer's ResizeObserver watches this container, so insetting it
  // resizes the canvas + camera aspect automatically. Loading overlay / watermark
  // stay on #app (full-screen), unaffected.
  const container = document.createElement('div');
  container.id = 'rv-viewport';
  container.style.cssText = 'position:fixed; inset:0;';
  app.appendChild(container);

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

  // --- Analytics: distinguish what the visitor views (no-op unless GA configured + consented) ---
  // Standard demo (model_view: DemoRealvirtualWeb) vs. Planner demo (workspace_mode: planner), etc.
  // trackAnalyticsEvent fires only when window.gtag exists, i.e. only after the consent gate granted.
  viewer.on('model-loaded', () => {
    const url = viewer.currentModelUrl ?? '';
    const model = url.split(/[?#]/)[0].split('/').pop()?.replace(/\.glb$/i, '') || 'unknown';
    trackAnalyticsEvent('model_view', { model });
  });
  viewer.on('mode-changed', ({ to }) => {
    trackAnalyticsEvent('workspace_mode', { mode: to });
  });

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
    .use(new CameraFollowPlugin())
    .use(new KioskPlugin())
    .use(new MeasurementPlugin())
    .use(new WebErrorPlugin())
    .use(new RvExtrasEditorPlugin())
    .use(new ConnectPlugin())
    .use(new OrientationGizmoPlugin())
    .use(new LayoutPlannerPlugin())
    .use(new SnapPointPlugin())
    .use(new SnapFlipIconOverlay())
    .use(new SimControllerPlugin())
    .use(new IKPathVisualizerPlugin())
    .use(new IKTargetEditPlugin())
    .use(new DESWorkspacePlugin());

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

  // --- Workspace modes (plan-198): HMI / DES / Planner ---
  // Registered after all plugins so the dropdown reflects the full set. The
  // active mode is applied AFTER the model loads (see mode-boot block below).
  viewer.modes
    .register({ id: 'hmi', label: 'HMI', icon: 'ViewQuilt', order: 10 })
    .register({ id: 'des', label: 'DES', icon: 'AccountTree', order: 20 })
    .register({ id: 'planner', label: 'Planner', icon: 'GridView', order: 30 });

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

  // Discover private project models. `/__api/private-models` is served ONLY by
  // the dev-time Vite middleware (privateModelsPlugin); no deployed build serves
  // it, so the fetch is dev-only — gating it keeps the public/private builds from
  // logging a guaranteed 404 on every page load. (Deployed private projects swap
  // models in via the runtime `models.json` manifest below, not this endpoint.)
  if (import.meta.env.DEV) {
    try {
      const resp = await fetch('/__api/private-models');
      if (resp.ok) {
        const privateModels: Array<{ project: string; filename: string; url: string }> = await resp.json();
        for (const pm of privateModels) {
          entries.push({ filename: pm.filename, url: pm.url });
        }
      }
    } catch { /* private models endpoint not available — ignore */ }
  }

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

  // Expose discovered models to the HMI model selector.
  // A base entry may be expanded with selectable "model options" (supplier variants)
  // declared in a model folder's model-options.ts. An option entry reuses the SAME
  // GLB url plus an `?option=<id>` marker that the model plugin reads in onModelLoaded
  // to apply its manipulation (e.g. AAS remap) — no duplicate GLB, no build step.
  const optionModules = import.meta.glob('/src/plugins/models/*/model-options.ts', { eager: true }) as
    Record<string, { baseModel?: string; modelOptions?: Array<{ id: string; label: string }> }>;
  const optionsByModel = new Map<string, Array<{ id: string; label: string }>>();
  for (const mod of Object.values(optionModules)) {
    if (mod.baseModel && Array.isArray(mod.modelOptions) && mod.modelOptions.length > 0) {
      optionsByModel.set(mod.baseModel, mod.modelOptions);
    }
  }
  viewer.availableModels = entries.flatMap((e) => {
    const baseLabel = e.filename.replace(/\.glb$/i, '');
    const base = { url: e.url, label: baseLabel };
    const opts = optionsByModel.get(baseLabel);
    if (!opts) return [base];
    const sep = e.url.includes('?') ? '&' : '?';
    return [
      base,
      ...opts.map((o) => ({ url: `${e.url}${sep}option=${o.id}`, label: `${baseLabel} (${o.label})` })),
    ];
  });

  // Discover read-only "Example" scenes (public/scenes/) BEFORE the scene store
  // is built so its constructor mirrors them into the Examples section. Examples
  // are an additive, non-essential feature — never let discovery brick boot.
  try {
    viewer.availablePublishedScenes = await discoverPublishedScenes();
  } catch (e) {
    console.warn('[main] published scene discovery failed', e);
    viewer.availablePublishedScenes = [];
  }

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
  // Remember the last requested model so the error overlay's Retry button can
  // re-run it after a failure.
  let lastLoadRequest: { url: string; options?: { overlay?: RVExtrasOverlay } } | null = null;

  async function loadModel(url: string, options?: { overlay?: RVExtrasOverlay }) {
    const modelName = (url.split('/').pop() ?? url).split('?')[0].replace(/\.glb$/i, '');
    lastLoadRequest = { url, options };
    showLoadingOverlay(modelName);
    localStorage.setItem(LS_KEY_MODEL, url);

    try {
      const loadStart = performance.now();

      // Download into a single buffer with progress, timeout and retries (see
      // downloadGlb). The bytes are handed to the parser directly — no blob URL,
      // no double-buffering. 90 s timeout suits large GLBs on slow mobile links.
      const data = await downloadGlb(url, {
        attempts: 3,
        timeoutMs: 90_000,
        onRetry: setLoadingRetrying,
      });
      const sizeMB = (data.byteLength / (1024 * 1024)).toFixed(1) + ' MB';

      viewer.pendingModelUrl = url;

      // Download done — the parse + scene build below is the long pole with no
      // byte progress. Show the preparing state.
      setLoadingPreparing();

      const result = await viewer.loadModel(url, { ...options, data });

      // Keep the original URL (model selector matches against it).
      viewer.currentModelUrl = url;

      // Mark GLB scene active in the scene store (for the Scene window).
      // We re-derive the label so saved-from-localStorage entries stay
      // consistent with the discovered manifest.
      const matched = entries.find(e => e.url === url);
      const label = matched ? matched.filename.replace(/\.glb$/i, '') : modelName;
      // markGlbActive synthesizes a fresh draft RvScene on the new base —
      // viewer.currentScene is updated via that call.
      sceneStore.markGlbActive(url, label);

      const loadTime = ((performance.now() - loadStart) / 1000).toFixed(1) + 's';
      viewer.lastLoadInfo = { glbSize: sizeMB, loadTime };
      logInfo(`Model loaded: ${sizeMB}, ${loadTime}, ${result.drives.length} drives`);
      hideLoadingOverlay();
    } catch (e) {
      // Surface the failure instead of leaving a silent empty scene. On mobile the
      // console is invisible, so without this the user just sees a blank viewer.
      console.error(`[main] Failed to load model: ${url}`, e);
      const reason = e instanceof Error ? e.message : String(e);
      showLoadingError(`${reason}\n${url}`);
    }
  }

  // Expose loadModel with progress overlay so Settings > Model can use it
  viewer.loadModelWithProgress = loadModel;

  // --- Error overlay actions ---
  // Retry re-runs the last requested load; Reload is the hard fallback (also the
  // recovery path for a lost WebGL context, which cannot be re-initialised in place).
  loadingRetryBtn.onclick = () => {
    if (lastLoadRequest) loadModel(lastLoadRequest.url, lastLoadRequest.options);
  };
  loadingReloadBtn.onclick = () => window.location.reload();

  // A lost WebGL context (mobile GPU memory pressure, long-backgrounded tab)
  // leaves a permanently blank canvas. Surface it with a reload prompt.
  viewer.on('renderer-context-lost', () => {
    showLoadingError('The 3D graphics context was lost (often low memory on mobile). Reload to recover.');
  });

  // Preferred workspace mode derived from an opened published example's catalogue
  // entry — applied in the mode-boot block below (unless ?mode= overrides it). Lets
  // a bare ?scene=published:<name> reload/share restore the right mode (e.g. planner)
  // without relying on the URL carrying ?mode= or on localStorage persistence.
  let publishedBootMode: string | null = null;

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
        } else if (urlScene.startsWith('published:')) {
          // ?scene=published:<name> → fetch a static, read-only scene shipped
          // with the build (public/scenes/<name>.scene.json) and load it
          // transiently. Lets a saved scene (GLB + edits) be shared by URL
          // without server-side scene storage and without touching localStorage.
          const name = decodeURIComponent(urlScene.slice('published:'.length));
          const resp = await fetch(`${import.meta.env.BASE_URL}scenes/${name}.scene.json`, { cache: 'no-store' });
          if (resp.ok) {
            await sceneStore.openPublished(await resp.json(), name);
            // Restore the example's preferred workspace mode (e.g. planner) from the
            // catalogue, so a shared/reloaded ?scene=published:<name> lands in the right
            // mode even without ?mode= in the URL. An explicit ?mode= still wins.
            const entry = viewer.availablePublishedScenes.find(e => e.urlName === name);
            if (entry?.mode) publishedBootMode = entry.mode;
            hideLoadingOverlay();
            sceneRouted = true;
          }
          // Not found / fetch failed — fall through to default model resolution below.
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

    let modelToLoad = urlModel
      ?? savedEntry?.url
      ?? resolvedConfigModel
      ?? null;

    // A top-level `?option=<id>` deep link (e.g. `?model=…&option=sew`) is folded
    // into the model URL so the selector, localStorage and currentModelUrl all carry
    // the variant. ModelOptionPlugin and the demo HMI also read it straight from the
    // page URL, so this is belt-and-suspenders for reload/selector consistency.
    const urlOption = params.get('option');
    if (modelToLoad && urlOption && !/[?&]option=/.test(modelToLoad)) {
      modelToLoad += (modelToLoad.includes('?') ? '&' : '?') + 'option=' + encodeURIComponent(urlOption);
    }

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

  // Workspace mode boot (plan-198). Precedence: ?mode= URL param (if a
  // registered mode) > opened published example's catalogue mode > persisted
  // localStorage > 'hmi'. Applied AFTER the model/scene has loaded so mode plugins
  // (e.g. Planner) see live model state in their onModeActivate hook. The legacy
  // ?mode=planner empty-scene routing above is unchanged; entering Planner mode
  // now runs through the mode system.
  const urlMode = params.get('mode');
  if (urlMode && viewer.modes.has(urlMode)) {
    viewer.modes.setMode(urlMode);
  } else if (publishedBootMode && viewer.modes.has(publishedBootMode)) {
    viewer.modes.setMode(publishedBootMode);
  } else {
    viewer.modes.restore('hmi');
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

  // --- MCP bridge (AI integration) ---
  // Always registered so the Settings -> AI tab is available everywhere,
  // including the public demo. The bridge does NOT auto-connect: it stays
  // disabled until the user enables it in the AI tab (loadSettings defaults
  // enabled=false), so a normal page load makes no localhost connection
  // attempts. DEV / ?mcp=1 are no longer required just to see the tab.
  {
    const { McpBridgePlugin } = await import('./plugins/mcp-bridge-plugin');
    viewer.use(new McpBridgePlugin());
  }
}

init().catch(console.error);
