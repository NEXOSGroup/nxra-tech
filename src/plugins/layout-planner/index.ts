// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * LayoutPlannerPlugin — Factory layout planning tool for the realvirtual WebViewer.
 *
 * Users browse GLB component libraries (multi-tab catalog system), click or drag
 * components into the 3D scene, and reposition/rotate them using TransformControls.
 * Layouts persist as lightweight JSON files (auto-save to localStorage).
 *
 * This is a PRIVATE plugin — it self-registers its UI into the public HMI shell
 * via the UISlot system (toolbar-button + overlay slots).
 *
 * Module structure:
 *   - index.ts                — Plugin class (lifecycle, public API, event wiring, slot registration)
 *   - model-cache.ts          — GLB loading, caching, wrapper removal, pivot helpers
 *   - ghost-manager.ts        — Transparent 3D preview during placement
 *   - thumbnail-renderer.ts   — Offscreen thumbnail generation for library icons
 *   - rv-layout-store.ts      — Reactive state management
 *   - LayoutLibraryPanel.tsx   — React UI (library panel + toolbar button)
 */

import {
  Group,
  Mesh,
  PlaneGeometry,
  MeshBasicMaterial,
  DoubleSide,
  GridHelper,
  MathUtils,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three';
import type { Object3D, WebGLRenderer, PerspectiveCamera } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

import type { ComponentType } from 'react';
import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { LoadResult } from '../../core/engine/rv-scene-loader';
import type { ProcessExtrasResult } from '../../core/engine/rv-scene-loader';
import type { RVViewer } from '../../core/rv-viewer';
import type { UISlotEntry, UISlotProps } from '../../core/rv-ui-plugin';
import type { RvExtrasEditorPlugin } from '../../core/hmi/rv-extras-editor';
import type { HighlightStyle } from '../../core/engine/rv-highlight-manager';
import { DEFAULT_SELECTION_STYLE } from '../../core/engine/rv-highlight-manager';
import type { SelectionSnapshot } from '../../core/engine/rv-selection-manager';
import type { OutlineStyle } from '../../core/engine/rv-outline-manager';
import {
  LayoutStore,
  serializeLayout,
  deserializeLayout,
  type PlacedComponent,
  type LibraryCatalogEntry,
} from './rv-layout-store';
import {
  getWorkFolder,
  requestWriteAccess,
  getOrCreateSubfolder,
  writeBlobFile,
  readFileAsUrl,
} from '../../core/engine/rv-local-filesystem';

// PlacementsSnapshot moved to core/rv-shared-types to eliminate the previous
// core → plugin layer violation. Re-exported here for backwards compatibility
// with existing external consumers.
export type { PlacementsSnapshot } from '../../core/rv-shared-types';
import type { PlacementsSnapshot } from '../../core/rv-shared-types';
import { ModelCache, dropToSurface, dropPivotToSurface, collectDropTargets } from './model-cache';
import { GhostManager } from './ghost-manager';
import { ThumbnailRenderer } from './thumbnail-renderer';
import { ThumbnailCache } from './thumbnail-cache';
import { FloorGizmo } from './floor-gizmo';
import { markNoAO } from '../../core/engine/rv-group-registry';
import {
  addPlacedToScene as smAddPlacedToScene,
  addSplatPlacedToScene as smAddSplatPlacedToScene,
  removePlacedFromScene as smRemovePlacedFromScene,
  resolveUniqueName as smResolveUniqueName,
  placeAtSnapPoint as smPlaceAtSnapPoint,
  type SceneMutationDeps,
} from './scene-mutations';
import type { SnapPoint, PlacedComponentId } from '../../core/engine/rv-snap-point-registry';
import type { SnapPointPlugin } from '../snap-point';
import { computeProximityPairings, type RebuildSnapInput } from '../snap-point/snap-pairing-rebuild';
import {
  loadBundledLibrary as plLoadBundledLibrary,
  findCatalogEntryById as plFindCatalogEntryById,
  resolvePlacementUrl as plResolvePlacementUrl,
  waitForCloudReady as plWaitForCloudReady,
  refreshCloudGlbUrl as plRefreshCloudGlbUrl,
} from './planner-persistence';

import { LAYOUT_PANEL_WIDTH } from '../../core/hmi/layout-constants';
import { disposeSubtree } from './three-utils';
import { setContext } from '../../core/hmi/ui-context-store';
import { CanvasInteractionManager, type CanvasInteractionDeps } from './canvas-interaction';
import { MuReconciler } from './mu-reconciler';
import { MultiSelectPivot, type MultiSelectPivotDeps } from './multi-select-pivot';
import { BoxSelectController } from './box-select-controller';

// UI components for slot registration
import { LayoutPlannerButton, LayoutLibraryPanel } from './LayoutLibraryPanel';
import { PlannerGridButton, PlannerDropToSurfaceButton, PlannerDeleteButton, PlannerSnapButton } from './PlannerToolbarButtons';
import { BboxSnapController } from './bbox-snap';
import { showInfoOverlay, hideInfoOverlay } from '../../core/hmi/info-overlay-store';
import { freshOpId as opId } from '../../core/hmi/scene/rv-scene-edits';
import type { PrimitiveEditOp } from '../../core/hmi/scene/rv-scene-edits';
import { getSceneStore } from '../../core/hmi/scene/scene-store-singleton';

/**
 * Emit a planner-originated op into the SceneStore (for undo/redo). The
 * planner's existing direct mutations to scene + LayoutStore happen first;
 * the executor's forward is idempotent so this won't double-apply. When
 * SceneStore isn't available (boot/test), the op is dropped silently —
 * the visual state is still correct.
 */
function emitPlannerOp(viewer: RVViewer | null, op: PrimitiveEditOp): void {
  if (!viewer) return;
  const sceneStore = getSceneStore();
  if (!sceneStore) return;
  void sceneStore.applyOp(op);
}

// Register inspector/hierarchy capabilities for the two layout-planner
// marker components. Module-side-effect import — runs once when the planner
// plugin code is evaluated. LayoutObject keeps default capabilities; Splat
// gets its own badge color so users can spot splat placements in the
// hierarchy at a glance. Both `inspectorVisible` defaults to true, so the
// Inspector renders them as regular ComponentSections automatically.
import { registerCapabilities } from '../../core/engine/rv-component-registry';
import { LAYOUT_EDIT_PAUSE_REASON } from '../../core/engine/rv-constants';
import { componentActionRegistry, type ComponentActionContext } from '../../core/hmi/rv-component-action-registry';
import { SwapHoriz, SwapVert } from '@mui/icons-material';
registerCapabilities('Splat', { badgeColor: '#ab47bc' });

// Splat axis-inversion action buttons — three toggles, one per axis. Each
// click flips the corresponding boolean field on the Splat component via
// the standard rv-extras overlay (same persistence path as Drive.Speed,
// Sensor.Mode, …), so the value survives reload and goes through undo/redo.
// The visual effect is applied by `applySplatTransformFromUserData` —
// driven from the SceneStore op subscriber installed in onModelLoaded,
// plus once during placement/restore to honour saved overrides.
type SplatAxisField = 'InvertX' | 'InvertY' | 'InvertZ';

function readSplatInvert(node: Object3D, axisField: SplatAxisField): boolean {
  const rv = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
  return !!rv?.Splat?.[axisField];
}

function toggleSplatInvert(ctx: ComponentActionContext, axisField: SplatAxisField): void {
  const next = !readSplatInvert(ctx.node, axisField);
  // Route through the extras-editor plugin so the change enters the
  // SceneStore op log → autosave → reload pipeline that every other
  // component edit already uses. Both the SceneStore op-executor and the
  // legacy fallback write userData synchronously, so we can apply the
  // visual effect right after.
  const editor = ctx.viewer.getPlugin('rv-extras-editor') as unknown as {
    updateOverlayField(nodePath: string, componentType: string, fieldName: string, value: unknown): boolean;
  } | undefined;
  editor?.updateOverlayField(ctx.nodePath, 'Splat', axisField, next);
  applySplatTransformFromUserData(ctx.node, ctx.viewer);
}

// Three.js axis colour convention — matches the AXIS_COLORS used by the
// Vector3Editor in TRANSFORM's Position / Rotation rows. Keeps the Splat
// invert buttons visually aligned with the same axes the user sees there.
//
// Three.js is right-handed: +X right, +Y up, +Z out-of-screen. The
// gaussian-splats-3d library renders into the same Three.js scene
// coordinate frame, so `splatMesh.scale.x = -1` mirrors along the same
// axis as Position X / Rotation X — no extra conversion involved.
const AXIS_COLOR_X = '#ef5350';  // red   — Position X / Rotation X
const AXIS_COLOR_Y = '#66bb6a';  // green — Position Y / Rotation Y (up)
const AXIS_COLOR_Z = '#4fc3f7';  // blue  — Position Z / Rotation Z

componentActionRegistry.register('Splat', [
  {
    id: 'invertX',
    label: 'X',
    icon: SwapHoriz,
    color: AXIS_COLOR_X,
    tooltip: 'Mirror along Three.js X axis (red — same axis as Position X / Rotation X).',
    isActive: (ctx) => readSplatInvert(ctx.node, 'InvertX'),
    onClick: (ctx) => toggleSplatInvert(ctx, 'InvertX'),
    order: 10,
  },
  {
    id: 'invertY',
    label: 'Y',
    icon: SwapVert,
    color: AXIS_COLOR_Y,
    tooltip: 'Mirror along Three.js Y axis (green — vertical / up axis).',
    isActive: (ctx) => readSplatInvert(ctx.node, 'InvertY'),
    onClick: (ctx) => toggleSplatInvert(ctx, 'InvertY'),
    order: 20,
  },
  {
    id: 'invertZ',
    label: 'Z',
    icon: SwapHoriz,
    color: AXIS_COLOR_Z,
    tooltip: 'Mirror along Three.js Z axis (blue — same axis as Position Z / Rotation Z).',
    isActive: (ctx) => readSplatInvert(ctx.node, 'InvertZ'),
    onClick: (ctx) => toggleSplatInvert(ctx, 'InvertZ'),
    order: 30,
  },
]);

/**
 * Read the Splat.Invert* booleans from a node's userData and push the
 * resulting per-axis scale into the gaussian-splat plugin. The library
 * renders splats through its own pipeline and ignores the parent Three.js
 * container's scale — `setSplatScale` mutates the library's `splatMesh`
 * directly. No-op when the node has no Splat component.
 */
function applySplatTransformFromUserData(node: Object3D, viewer: import('../../core/rv-viewer').RVViewer): void {
  if (!node.userData?._isSplat) return;
  const splatPlugin = viewer.getPlugin('gaussian-splat') as
    | import('./gaussian-splat-plugin-type').GaussianSplatPluginApi
    | undefined;
  if (!splatPlugin?.setSplatScale) return;
  const sx = readSplatInvert(node, 'InvertX') ? -1 : 1;
  const sy = readSplatInvert(node, 'InvertY') ? -1 : 1;
  const sz = readSplatInvert(node, 'InvertZ') ? -1 : 1;
  splatPlugin.setSplatScale(node as import('three').Group, [sx, sy, sz]);
  applySplatCropFromUserData(node, viewer);
}

/**
 * Read the Splat.Crop{Min,Max}{X,Y,Z} numbers from userData and push them as
 * an axis-aligned crop box into the gaussian-splat plugin. Each axis defaults
 * to ±NO_CROP (effectively "no clip"). Used to hide e.g. the ceiling of a
 * scanned room — Splats whose centre lies outside the box are culled in the
 * vertex shader. No-op when the node has no Splat component.
 */
const SPLAT_NO_CROP = 1e6;
function readSplatNumber(node: Object3D, field: string, fallback: number): number {
  const rv = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
  const v = rv?.Splat?.[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function applySplatCropFromUserData(node: Object3D, viewer: import('../../core/rv-viewer').RVViewer): void {
  if (!node.userData?._isSplat) return;
  const splatPlugin = viewer.getPlugin('gaussian-splat') as
    | import('./gaussian-splat-plugin-type').GaussianSplatPluginApi
    | undefined;
  if (!splatPlugin?.setSplatCrop) return;
  splatPlugin.setSplatCrop(node as import('three').Group, {
    min: [
      readSplatNumber(node, 'CropMinX', -SPLAT_NO_CROP),
      readSplatNumber(node, 'CropMinY', -SPLAT_NO_CROP),
      readSplatNumber(node, 'CropMinZ', -SPLAT_NO_CROP),
    ],
    max: [
      readSplatNumber(node, 'CropMaxX', SPLAT_NO_CROP),
      readSplatNumber(node, 'CropMaxY', SPLAT_NO_CROP),
      readSplatNumber(node, 'CropMaxZ', SPLAT_NO_CROP),
    ],
  });
}

/**
 * Restore time helper: copy saved Splat.* overrides from `viewer.currentScene`
 * into a freshly-placed splat container's `userData.realvirtual.Splat`, then
 * push the resulting transform through the splat plugin. Necessary because
 * splat containers are created AFTER `loadGLB` applies the overlay — the
 * rv-extras-editor's overlay-apply pass therefore never touches them.
 *
 * Walks the op log (canonical source) and keeps the last `setField` per
 * `(nodePath, fieldName)` — same semantics as the regular overlay materialise.
 */
function applySplatOverridesFromScene(node: Object3D, viewer: import('../../core/rv-viewer').RVViewer): void {
  if (!node.userData?._isSplat) return;
  const scene = viewer.currentScene;
  const path = viewer.registry?.getPathForNode(node);
  if (scene && path) {
    const ops = scene.edits.ops as ReadonlyArray<{
      kind: string;
      nodePath?: string;
      componentType?: string;
      fieldName?: string;
      value?: unknown;
    }>;
    const rv = (node.userData.realvirtual ?? {}) as Record<string, Record<string, unknown>>;
    if (!rv.Splat) rv.Splat = {};
    for (const op of ops) {
      if (op.kind !== 'setField') continue;
      if (op.nodePath !== path) continue;
      if (op.componentType !== 'Splat') continue;
      if (typeof op.fieldName === 'string') {
        rv.Splat[op.fieldName] = op.value;
      }
    }
    node.userData.realvirtual = rv;
  }
  applySplatTransformFromUserData(node, viewer);
}

/**
 * Mirror the live Three.js node state into the two layout-planner marker
 * components so the Inspector renders the correct values right after a
 * restore. Without this, a splat that was saved with `scale.x = -1` shows
 * `Splat.InvertX = false` in the Inspector on the next reload because the
 * GLB-extras default (false) wins over the actual state on the node.
 *
 * Called from the placement and restore paths. Splat-component is only
 * touched when the node is actually a splat (others get LayoutObject only).
 */
function syncLayoutMarkerComponents(node: Object3D, visible: boolean): void {
  const rv = (node.userData.realvirtual ?? {}) as Record<string, Record<string, unknown>>;
  if (!rv.LayoutObject) rv.LayoutObject = {};
  rv.LayoutObject.Visible = visible;
  // Splat axis state is read live from node.scale by the registered
  // ComponentActions — nothing to mirror into userData for that one.
  if (node.userData._isSplat && !rv.Splat) rv.Splat = {};
  node.userData.realvirtual = rv;
}

/** Extensions the gaussian-splat plugin can resolve to a known format.
 *  Anything else returns `undefined` and the plugin falls back to URL-based
 *  guessing (which only works for HTTP URLs with a visible extension). */
const SPLAT_FILE_EXTENSIONS = new Set(['splat', 'ksplat', 'ply', 'pcd']);

/**
 * Derive the splat file extension from any of the available hints.
 *
 * Why this exists: local-folder splats are served as `blob:` URLs which
 * carry no path — the gaussian-splat plugin cannot infer the file format
 * from such a URL and the underlying library throws "File format not
 * supported". We pass the extension explicitly via `loadSplat(url, ext)`.
 *
 * Resolution order: caller-provided `localPath` first (always carries the
 * real on-disk extension), then the URL as a fallback for HTTP catalog
 * sources where the URL itself encodes the extension. Query strings and
 * fragments are stripped so signed S3-style URLs still resolve correctly.
 */
function extractSplatFileExt(opts: { localPath?: string | null; url?: string | null }): string | undefined {
  const candidates = [opts.localPath, opts.url].filter((s): s is string => !!s);
  for (const cand of candidates) {
    const clean = cand.split('?')[0].split('#')[0];
    const lastDot = clean.lastIndexOf('.');
    if (lastDot < 0) continue;
    const ext = clean.slice(lastDot + 1).toLowerCase();
    if (SPLAT_FILE_EXTENSIONS.has(ext)) return ext;
  }
  return undefined;
}

// ─── Cloud extension contract ───────────────────────────────────────────
//
// The public AGPL planner is cloud-agnostic. A private extension (Unity
// Asset Manager) plugs in via `setExtension()` and supplies a structural
// `cloudStore` plus an optional library-tab component. When the extension
// is absent (public-only build), all cloud UI is hidden and the restore
// path skips cloud-asset resolution.
//
// Definitions live in `./cloud-types`; re-exported here so existing
// external consumers (private Unity Asset Manager extension) keep working.
export type {
  LayoutPlannerCloudConnConfig,
  LayoutPlannerCloudConn,
  LayoutPlannerCloudConnState,
  LayoutPlannerCloudStore,
  LayoutPlannerCloudTabProps,
  LayoutPlannerExtension,
} from './cloud-types';
import type {
  LayoutPlannerCloudStore,
  LayoutPlannerExtension,
} from './cloud-types';

// Re-export everything that tests and UI components need
export { ModelCache, unwrapGltfRoot, pivotToFloorCenter, alignToFloor, dropToSurface, dropPivotToSurface } from './model-cache';
export { GhostManager } from './ghost-manager';
export { ThumbnailRenderer } from './thumbnail-renderer';
export {
  LayoutStore,
  snapToGrid,
  serializeLayout,
  deserializeLayout,
  resolveUrl,
  normalizeCatalogEntry,
} from './rv-layout-store';
export type {
  PlacedComponent,
  LayoutFile,
  LibraryCatalog,
  LibraryCatalogEntry,
  LayoutSnapshot,
} from './rv-layout-store';

// Note: Pre-allocated vectors are now owned by CanvasInteractionManager
// and MultiSelectPivot respectively. No module-level vectors needed.

// ─── Layout-instance predicates (re-exported from leaf module) ────────
export { isLayoutInstance, isLockedLayoutInstance, findLayoutAncestor } from './layout-predicates';
import {
  isLayoutInstance, isLockedLayoutInstance,
  isMuSelectable, isPlannerSelectable, findPlannerSelectableAncestor,
} from './layout-predicates';
import type { RVMovingUnit } from '../../core/engine/rv-mu';

// ─── Planner-mode highlight styles ─────────────────────────────────────

/**
 * Selection-style override applied while planner mode is active.
 * Mutes the default RVHighlightManager selection visual entirely —
 * the planner replaces it with a post-process OutlinePass (see
 * PLANNER_OUTLINE_STYLE below). Both overlay and edges suppressed.
 */
const PLANNER_SELECTION_MUTE_STYLE: HighlightStyle = {
  ...DEFAULT_SELECTION_STYLE,
  showOverlay: false,
  showEdges: false,
};

/** Hover style applied while planner mode is active. On WebGL the hovered
 *  object is drawn as a vivid-green OutlinePass silhouette (edgeColor) — the
 *  same green as the selection outline, so the focused object always reads as
 *  "green" whether hovered or selected. The overlay fields only matter on the
 *  WebGPU fallback (no OutlinePass). */
const PLANNER_HOVER_STYLE: HighlightStyle = {
  overlayColor: 0x4fc34f,
  overlayOpacity: 0.10,
  overlayWireframe: false,
  edgeColor: 0x4fc34f,
  edgeOpacity: 0,
  edgeLinewidth: 1,
  showOverlay: true,
  showEdges: false,
};

/**
 * OutlinePass parameters applied while planner mode is active.
 * Drives the green silhouette around selected layout instances and the
 * placement-preview ghost. Quiet glow, crisp edge.
 */
const PLANNER_OUTLINE_STYLE: OutlineStyle = {
  visibleEdgeColor: 0x4fc34f,
  hiddenEdgeColor: 0x2a6b2a,
  edgeStrength: 4,
  edgeThickness: 2,
  edgeGlow: 0.3,
  pulsePeriod: 0,
};

// ─── Plugin ─────────────────────────────────────────────────────────────

/** Standard parts library shipped with every build. Loaded from a pre-built
 *  `catalog.json` served via raw.githubusercontent.com — unlike the GitHub
 *  tree API (60 req/h per IP, anonymous), the raw host is not rate-limited, so
 *  the public demo never hits a 403. Regenerate the manifest with
 *  `scripts/build-library-catalog.mjs` whenever the library repo changes.
 *  Always loaded by `_loadCatalogs`, in addition to any constructor- or
 *  `?library=`-provided catalogs. */
const DEFAULT_LIBRARY_URLS = [
  'https://raw.githubusercontent.com/game4automation/realvirtual-Library/main/catalog.json',
];

export interface LayoutPlannerOptions {
  catalogUrls?: string[];
}

/** Max world-space distance (metres) at which two restored snaps count as
 *  mated. Mated snaps are placed exactly coincident, so this only needs to
 *  absorb float drift from the pivot/align recompute — kept small to avoid
 *  pairing genuinely separate (but nearby) compatible ports. */
const SNAP_PAIR_REBUILD_EPS_M = 0.005;

export class LayoutPlannerPlugin implements RVViewerPlugin {
  readonly id = 'layout-planner';
  readonly order = 250;

  /** Self-register toolbar button and overlay panel via the UISlot system. */
  readonly slots: UISlotEntry[] = [
    { slot: 'toolbar-button', component: LayoutPlannerButton as ComponentType<UISlotProps>, order: 100 },
    { slot: 'overlay', component: LayoutLibraryPanel as ComponentType<UISlotProps>, order: 100 },
    // Left-toolbar buttons — visible ONLY while the 'planner' UI context is
    // active. ButtonPanel filters entries by visibilityRule; non-planner
    // toolbar buttons (Drives, Sensors, …) are hidden in planner mode so the
    // user gets a focused layout-editing workspace.
    {
      slot: 'button-group',
      component: PlannerGridButton as ComponentType<UISlotProps>,
      order: 200,
      visibilityRule: { shownOnlyIn: ['planner'] },
    },
    {
      slot: 'button-group',
      component: PlannerDropToSurfaceButton as ComponentType<UISlotProps>,
      order: 210,
      visibilityRule: { shownOnlyIn: ['planner'] },
    },
    {
      slot: 'button-group',
      component: PlannerDeleteButton as ComponentType<UISlotProps>,
      order: 220,
      visibilityRule: { shownOnlyIn: ['planner'] },
    },
    {
      slot: 'button-group',
      component: PlannerSnapButton as ComponentType<UISlotProps>,
      order: 230,
      visibilityRule: { shownOnlyIn: ['planner'] },
    },
  ];

  private _viewer: RVViewer | null = null;
  private _layoutRoot: Group;
  private _floorPlane: Mesh;
  /** Visible 30 m × 30 m authoring floor — shown only while a layout scene
   *  is active. Hidden when the user is on a baked GLB scene. */
  private _layoutFloor: Mesh;
  private _gridHelper: GridHelper | null = null;
  private _transformControls: FloorGizmo | null = null;
  private _modelCache: ModelCache;
  private _ghost: GhostManager;
  private _dragEntry: LibraryCatalogEntry | null = null;
  private _thumbnailRenderer: ThumbnailRenderer | null = null;
  // ── Auto preview generation ──────────────────────────────────────────
  /** Persistent (Cache-API) store of generated previews, keyed by glbUrl. */
  private _thumbCache = new ThumbnailCache();
  /** entryIds awaiting a preview render. */
  private _previewQueue: string[] = [];
  /** glbUrls already queued/generated this session — dedupes across entries. */
  private _previewSeen = new Set<string>();
  private _previewRunning = false;
  /** Unsubscribe for the store listener that auto-enqueues missing previews. */
  private _previewStoreUnsub: (() => void) | null = null;
  private _objectMap = new Map<string, Object3D>();
  private _unsubs: (() => void)[] = [];
  private _options: LayoutPlannerOptions;
  private _active = false;
  private _ancestorOverrideFn: ((node: Object3D) => Object3D | null) | null = null;

  /** Allow filter installed when planner is active (so we can restore prior on deactivate). */
  private _priorAllowFilter: ((node: Object3D) => boolean) | null = null;
  /** Unsubscribe handle for the selection-changed listener (active only while planner is on). */
  private _selectionUnsub: (() => void) | null = null;
  private _transformUpdateUnsub: (() => void) | null = null;
  /** Unsubscribe handle for the store listener (drives Y-axis bar visibility). */
  private _storeUnsub: (() => void) | null = null;
  /** Reverse lookup: Object3D → layout id (avoids O(n) scan of _objectMap on every event). */
  private _idByObject = new WeakMap<Object3D, string>();
  /** Extracted canvas event handler (pointer, keyboard, D&D, blur). */
  private _canvasInteraction: CanvasInteractionManager | null = null;
  /** Keeps spawned clone-MU scene nodes registered as selectable (registry +
   *  aux raycast targets + `_muSelectable` marker) so they flow through the
   *  shared hover/click/box/multi/outline/delete pipeline. NOT persisted. */
  private _muReconciler: MuReconciler | null = null;
  /** Coalesces snap-pairing rebuilds across a burst of op-replay placements. */
  private _pairingRebuildTimer: ReturnType<typeof setTimeout> | null = null;
  /** Extracted multi-select pivot logic. */
  private _multiSelectPivot: MultiSelectPivot | null = null;
  /** Magnetic bbox snap controller — armed at drag-start, disarmed at end. */
  private _bboxSnap: BboxSnapController | null = null;
  /** Tracked ALT key state — read at drag-start to populate layout-drag-start.
   *  The snap-point plugin treats ALT-held drags as "drag solo + detach the
   *  moved asset's chain connections" (mouse-equivalent of an explicit
   *  Detach action; touch users reach the same outcome via the Chain mode
   *  toggle in the Magnetic snap settings panel). */
  private _altDown = false;
  /** Bound window key listeners — installed by the planner alongside the
   *  gizmo, removed on deactivation. */
  private _onWindowKeyDownBound: ((e: KeyboardEvent) => void) | null = null;
  private _onWindowKeyUpBound: ((e: KeyboardEvent) => void) | null = null;
  /** Marquee (rubber-band) selection controller. */
  private _boxSelect: BoxSelectController | null = null;
  /** Clipboard for Ctrl+C / Ctrl+V — deep clones of `PlacedComponent` records
   *  captured at copy time. Paste keeps the source records intact so repeat
   *  pastes always offset from the *original* copied positions. */
  private _clipboard: PlacedComponent[] = [];
  /** Cached drop-to-surface raycast candidates for the active drag. Built once
   *  at drag-start (via `collectDropTargets`) so live drop-during-drag doesn't
   *  re-traverse the entire scene per pointermove. For multi-select drags the
   *  selfObj is the centroid pivot (every selected member is a descendant and
   *  gets excluded automatically). Null when no drag is active or
   *  dropToSurface mode is off. */
  private _dragDropTargets: Mesh[] | null = null;
  /** Resolves once `_loadCatalogs` has finished its first pass. Awaited by
   *  `_restorePlacements` so we can re-resolve placement glbUrls (dead
   *  `blob:` URLs from a prior session) against the freshly-loaded
   *  catalogs by `catalogId`. */
  private _catalogsLoaded: Promise<void> = Promise.resolve();

  /** The layout store — public so tests and UI can access it. */
  readonly store: LayoutStore;
  /** Optional cloud extension (Unity Asset Manager). Set via `setExtension()`. */
  private _extension: LayoutPlannerExtension | null = null;

  /** Stable deps bundle for the scene-mutations module. Getters read live
   *  state so the helpers always see the freshest `_viewer` / gizmo /
   *  `_layoutRoot` (initialized in the constructor). */
  private readonly _sceneMutDeps: SceneMutationDeps = {
    getViewer: () => this._viewer,
    objectMap: this._objectMap,
    idByObject: this._idByObject,
    getLayoutRoot: () => this._layoutRoot,
    getTransformControls: () => this._transformControls,
    getModelRoot: () => this._getModelRoot(),
  };

  /**
   * Register a cloud extension (typically the private Unity Asset Manager
   * extension). Called once at startup before the planner activates.
   */
  setExtension(ext: LayoutPlannerExtension): void {
    this._extension = ext;
  }

  /** The active cloud extension, or null in public-only builds. */
  get extension(): LayoutPlannerExtension | null {
    return this._extension;
  }

  /** Convenience: cloud store from the extension, or null. */
  get cloudStore(): LayoutPlannerCloudStore | null {
    return this._extension?.cloudStore ?? null;
  }

  constructor(options?: LayoutPlannerOptions) {
    this._options = options ?? {};
    this.store = new LayoutStore();

    // Create layout root
    this._layoutRoot = new Group();
    this._layoutRoot.name = '_layoutRoot';
    this._layoutRoot.userData._isLayoutRoot = true;

    // Invisible floor plane for raycast (100x100 meters)
    const floorGeo = new PlaneGeometry(100, 100);
    const floorMat = new MeshBasicMaterial({ visible: false, side: DoubleSide });
    this._floorPlane = new Mesh(floorGeo, floorMat);
    this._floorPlane.rotation.x = -Math.PI / 2;
    this._floorPlane.userData._layoutFloor = true;
    this._layoutRoot.add(this._floorPlane);

    // Visible 30 m × 30 m authoring floor. Sits flush with the raycast
    // plane and just below it (y = -0.001) to avoid z-fighting. Hidden by
    // default — `setLayoutFloorVisible(true)` is called from the Scene
    // window's layout-load path.
    const layoutFloorGeo = new PlaneGeometry(30, 30);
    const layoutFloorMat = new MeshBasicMaterial({ color: 0x9aa0a6, side: DoubleSide });
    this._layoutFloor = new Mesh(layoutFloorGeo, layoutFloorMat);
    this._layoutFloor.rotation.x = -Math.PI / 2;
    this._layoutFloor.position.y = -0.001;
    this._layoutFloor.visible = false;
    this._layoutFloor.userData._layoutFloor = true;
    this._layoutFloor.receiveShadow = true;
    this._layoutRoot.add(this._layoutFloor);

    // Own GLTFLoader + DRACOLoader
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
    const gltfLoader = new GLTFLoader();
    gltfLoader.setDRACOLoader(dracoLoader);

    this._modelCache = new ModelCache(gltfLoader);
    this._ghost = new GhostManager(this._layoutRoot, this._modelCache);

    // Whenever the ghost appears, moves into view, hides, or is replaced,
    // refresh the OutlinePass selection so its silhouette tracks the change.
    this._ghost.onGhostStateChange = () => this._refreshOutline();
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this._attachToViewer(viewer);
    this._installLayoutTransformListener(viewer);
    this._installLayoutDeleteListener(viewer);
    this._installSplatSceneStoreListener(viewer);
    // Auto-preview generation is wired in _attachToViewer (so the empty-scene
    // path via ensureAttached gets it too).
    // Entering / being in planner mode no longer stops the simulation — it
    // keeps running (sources spawn) until the user actively edits. So we do NOT
    // pause or disable spawning here; the auto-stop happens on edit gestures
    // (placement / move / transform) via `_beginEditPause()`/`_endEditPause()`.
  }

  /**
   * Subscribe to the SceneStore so live Inspector edits to Splat fields
   * (Invert{X,Y,Z}, CropMin/Max{X,Y,Z}) re-apply on the running splatMesh
   * without needing a reload. The action-button path already calls
   * `applySplatTransformFromUserData` directly; this covers the case where
   * the user types a number into the property inspector instead.
   */
  private _splatSceneStoreUnsub: (() => void) | null = null;
  private _installSplatSceneStoreListener(viewer: RVViewer): void {
    this._splatSceneStoreUnsub?.();
    const sceneStore = getSceneStore();
    if (!sceneStore) return;
    this._splatSceneStoreUnsub = sceneStore.subscribe(() => {
      // Cheap and correct — typically a handful of splats per scene.
      for (const [, obj] of this._objectMap) {
        if (obj.userData?._isSplat) applySplatTransformFromUserData(obj, viewer);
      }
    });
  }

  /**
   * Listen for `layout-objects-deleted` (emitted by the hierarchy browser
   * context-menu's Delete action). The context-menu only knows node paths;
   * we resolve them to placement IDs and route through the planner's normal
   * removal pipeline so undo/redo + SceneStore ops stay consistent.
   */
  private _layoutDeleteUnsub: (() => void) | null = null;
  private _installLayoutDeleteListener(viewer: RVViewer): void {
    this._layoutDeleteUnsub?.();
    this._layoutDeleteUnsub = viewer.on('layout-objects-deleted', (data: unknown) => {
      const evt = data as { paths?: string[] };
      const paths = evt?.paths ?? [];
      if (paths.length === 0) return;
      void this.removeByPaths(paths);
    });
  }

  /**
   * Idempotent host-scene setup. Called from `onModelLoaded` (the normal
   * path: a GLB just loaded) and from `ensureAttached()` (the empty-scene
   * path: the Scene window created a new layout without a base GLB).
   */
  ensureAttached(viewer: RVViewer): void {
    this._attachToViewer(viewer);
  }

  /** Open the planner panel and enter planner mode. Used by the `?mode=planner`
   *  deep-link so a published viewer boots straight into layout authoring. */
  openPlanner(): void {
    const viewer = this._viewer;
    if (!viewer) return;
    viewer.leftPanelManager.open('layout-planner', LAYOUT_PANEL_WIDTH, 'right');
    this.setActive(true);
  }

  private _attachToViewer(viewer: RVViewer): void {
    this._viewer = viewer;

    // Auto-generate previews for any library entry that lacks one. Installed
    // here — not just in onModelLoaded — so the empty-scene path (ensureAttached,
    // a new layout without a base GLB) also auto-thumbnails. A single store
    // subscription covers every add path (URL / GitHub / boot restore / local);
    // enqueue is debounced via the seen-set + queue. Idempotent: drop any prior
    // listener first so repeated attaches don't stack subscriptions.
    this._previewStoreUnsub?.();
    this._previewStoreUnsub = this.store.subscribe(() => this._enqueueMissingPreviews());
    this._enqueueMissingPreviews();

    // Double-add guard: only add to scene once
    if (!this._layoutRoot.parent) {
      viewer.scene.add(this._layoutRoot);
      (viewer as unknown as { sceneFixtures: Set<Object3D> }).sceneFixtures.add(this._layoutRoot);
    }

    // Exclude only ghost, floor, and grid from standard raycasts (NOT placed objects)
    if (viewer.raycastManager) {
      viewer.raycastManager.addExcludeFilter(
        (node: Object3D) => !!node.userData._isGhost || !!node.userData._layoutFloor || !!node.userData._isLayoutRoot,
      );

      // Register ancestor override: when planner is active, hover/click resolves
      // to the full placed object instead of individual sub-components — for
      // BOTH layout instances and spawned MUs (sub-mesh hits resolve to the MU
      // root). The allow filter set in setActive() also gates non-selectable hits.
      if (!this._ancestorOverrideFn) {
        this._ancestorOverrideFn = (node: Object3D): Object3D | null => {
          if (!this._active) return null;
          const root = findPlannerSelectableAncestor(node);
          if (!root) return null;
          if (isLockedLayoutInstance(root)) return null;
          return root;
        };
        viewer.raycastManager.addAncestorOverride(this._ancestorOverrideFn);
      }
    }

    // Initialize the FloorGizmo (replaces Three.js TransformControls).
    // Disc on the floor for XZ translation, ring around it for Y rotation.
    if (!this._transformControls) {
      // Pass a live getter so the gizmo follows perspective ↔ orthographic
      // camera swaps (clicks/raycasts use the camera that's actually drawing).
      this._transformControls = new FloorGizmo(
        () => viewer.camera as PerspectiveCamera,
        viewer.renderer as unknown as WebGLRenderer,
        viewer.scene,
      );
      viewer.scene.add(this._transformControls.root);
      // Register as a sceneFixture so clearModel skips it on every model
      // switch — the gizmo persists across loads and must not look like a
      // GLB root candidate to the viewer's clear/load logic.
      (viewer as unknown as { sceneFixtures: Set<Object3D> })
        .sceneFixtures.add(this._transformControls.root);

      // Magnetic bbox snap — wired permanently into the gizmo via a callback;
      // the controller self-checks store.bboxSnapEnabled, so toggling the
      // toolbar button takes effect mid-drag without re-wiring.
      const sceneFixtures = (viewer as unknown as { sceneFixtures: Set<Object3D> }).sceneFixtures;
      this._bboxSnap = new BboxSnapController({
        scene: viewer.scene,
        store: this.store,
        getAllPlaced: () => this._objectMap.values(),
        markRenderDirty: () => this._viewer?.markRenderDirty(),
        markAsFixture: (node) => sceneFixtures.add(node),
        unmarkAsFixture: (node) => sceneFixtures.delete(node),
      });
      this._transformControls.setCustomSnap(
        (nx, nz, lock) => this._bboxSnap?.applySnap(nx, nz, lock) ?? null,
      );

      this._transformControls.onDraggingChanged = (dragging: boolean) => {
        const v = this._viewer;
        if (v) {
          v.controls.enabled = !dragging;
          // Suppress hover while dragging — clear any active hover overlay
          // and disable the raycast manager so new hover doesn't fire as
          // the cursor passes over other objects mid-drag. Restored on end.
          if (dragging) {
            v.highlighter.clear();
            v.raycastManager?.setEnabled?.(false);
          } else {
            v.raycastManager?.setEnabled?.(true);
          }
          // Auto-stop the simulation when the user starts moving a placed
          // object (or MU) via the gizmo, and auto-resume on drag-end if the
          // sim was running before the edit (refcounted; manual pause kept).
          if (dragging) this._beginEditPause();
          else this._endEditPause();
        }
        if (dragging) {
          // Arm magnetic bbox snap — captures the moving root's AABB and
          // freezes every other placed object's AABB. Cheap one-time cost
          // (~1 ms for typical layouts). Disarm fires below at drag-end.
          const movingRoot = this._transformControls?.target ?? null;
          if (movingRoot) this._bboxSnap?.armForDrag(movingRoot);

          // Broadcast drag-start so external plugins (snap-point magnetic
          // snap) can arm their own per-drag state. Pass the current ALT
          // modifier state so the snap plugin can treat ALT-held drags as
          // "solo + detach this asset's chain connections".
          if (movingRoot) this._viewer?.emit('layout-drag-start', {
            node: movingRoot,
            altKey: this._altDown,
          });

          // Cache drop-to-surface targets ONCE per drag. For single-select
          // the selfObj is the placed object; for multi-select it's the
          // centroid pivot Group — every member is a descendant and gets
          // excluded automatically. The live drop runs in onChange below
          // and uses the dispatch path for the active selection kind.
          const isMulti = !!this._multiSelectPivot?.isActive
            && this._multiSelectPivot.memberCount > 0;
          if (this.store.dropToSurface && v) {
            if (isMulti) {
              const pivot = this._transformControls?.target;
              if (pivot) this._dragDropTargets = this._collectDropTargetsWithTransport(pivot);
            } else {
              const selectedId = this.store.getSnapshot().selectedId;
              const obj = selectedId ? this._objectMap.get(selectedId) : null;
              if (obj) this._dragDropTargets = this._collectDropTargetsWithTransport(obj);
            }
          }
        } else {
          // Disarm bbox snap — drop frozen state, hide guide lines.
          this._bboxSnap?.disarm();
          this._dragDropTargets = null;

          // Broadcast drag-end so external plugins can finalise their per-
          // drag state (snap-point magnetic snap marks occupied here).
          const endRoot = this._transformControls?.target ?? null;
          if (endRoot) this._viewer?.emit('layout-drag-end', { node: endRoot });
          // Multi-select: snapshot each member's transform back into
          // its original parent's local frame and write to the store.
          // CRITICAL: writeTransformsOnDragEnd() must run synchronously
          // before any tearDown() — see MultiSelectPivot JSDoc.
          if (this._multiSelectPivot?.isActive && this._multiSelectPivot.memberCount > 0) {
            this._multiSelectPivot.writeTransformsOnDragEnd();
          } else {
            // Single-select: flush final transform to store + autosave
            // only at drag-end (not every pointermove frame).
            const selectedId = this.store.getSnapshot().selectedId;
            if (selectedId) {
              const obj = this._objectMap.get(selectedId);
              if (obj) this._writeSingleTransform(selectedId, obj);
            }
          }
        }
      };

      this._transformControls.onChange = () => {
        const v = this._viewer;
        if (!v) return;
        // Live drop-to-surface during drag. Uses the cached candidate list
        // so the cost per pointermove is one raycast, not a full scene
        // traverse. Multi-select drags drop the entire centroid pivot: ray
        // casts from the gizmo's XZ, union AABB bottom snaps to surface,
        // members shift rigidly with the pivot.
        if (this._dragDropTargets) {
          const isMulti = !!this._multiSelectPivot?.isActive
            && this._multiSelectPivot.memberCount > 0;
          if (isMulti) {
            const pivot = this._transformControls?.target;
            if (pivot) dropPivotToSurface(pivot, v.scene, this._dragDropTargets);
          } else {
            const selectedId = this.store.getSnapshot().selectedId;
            const obj = selectedId ? this._objectMap.get(selectedId) : null;
            if (obj) dropToSurface(obj, v.scene, this._dragDropTargets);
          }
        }
        // Broadcast per-frame drag tick so external plugins (snap-point
        // magnetic snap) can override the gizmo's position/rotation before
        // render. Listeners must NOT keep allocations alive across calls.
        const tickRoot = this._transformControls?.target ?? null;
        if (tickRoot) v.emit('layout-drag-tick', { node: tickRoot });
        // Auto-drop on snap-point engage: the moment the magnetic snap mates a
        // pair (set synchronously by the tick above), finish the drag so the
        // object stays in the connection — the user re-grabs it to move again.
        // (Only snap-point connections drop; bbox/grid alignment snaps don't.)
        const snapPlugin = v.getPlugin<SnapPointPlugin>('snap-point');
        if (snapPlugin?.getMagnetic?.()?.getLastPair?.()) {
          this._transformControls?.endDrag();
        }
        v.markRenderDirty();
        // Store write + autoSave deferred to onDraggingChanged(false)
        // to avoid O(placed) allocations + JSON.stringify on every frame.
      };

      this._transformControls.onDragEnd = () => {
        // Final safety drop at drag-end. For single-select, _dragDropTargets
        // is null at this point (onDraggingChanged(false) cleared it just
        // before); we re-traverse once for the final commit. The live
        // dropping during onChange already left obj at the right Y; this
        // call just normalises against the freshly-stable scene state.
        if (!this._viewer || !this.store.dropToSurface) return;
        if (this._multiSelectPivot?.isActive) return;  // multi-select: skip (frame-mismatch)
        const selectedId = this.store.getSnapshot().selectedId;
        if (!selectedId) return;
        const obj = this._objectMap.get(selectedId);
        if (obj) {
          dropToSurface(obj, this._viewer.scene, this._collectDropTargetsWithTransport(obj));
          this._writeSingleTransform(selectedId, obj);
          this._viewer.markRenderDirty();
        }
      };

      // Y-axis bar is the manual lift handle — show it only when dropToSurface
      // is off (otherwise the dropToSurface logic snaps Y back on every release).
      this._transformControls.setYAxisEnabled(!this.store.dropToSurface);
    }

    // Wire canvas events via the extracted CanvasInteractionManager.
    // IDEMPOTENT: onModelLoaded fires on every scene switch under the
    // unified Scene model. Re-running wire() would register duplicate
    // document-level drop / pointer listeners — and each drag-drop would
    // then call placeComponent twice. Same for _loadCatalogs which would
    // re-run loadAutoSave and re-place every component.
    if (!this._canvasInteraction) {
      // Build the marquee controller first so we can hand its `start` API
      // to the CanvasInteractionManager via deps. Mounted div lifecycle is
      // owned by the controller (see attach()/dispose()).
      this._boxSelect = new BoxSelectController({
        viewer,
        canvas: viewer.renderer.domElement,
        objectMap: this._objectMap,
        // Read viewer.registry fresh on every commit — it's replaced on
        // each model load. Caching here used to silently break box-select
        // after the first model switch.
        getRegistry: () => viewer.registry,
        getActive: () => this._active,
        // Spawned MUs participate in the marquee too (read lazily — the
        // reconciler is built just below and its map mutates as MUs spawn).
        getMuMap: () => this._muReconciler?.objectMap.values() ?? null,
      });
      this._boxSelect.attach();

      // Reconciler that registers spawned clone-MU nodes as selectable scene
      // nodes (registry + aux raycast targets + `_muSelectable` marker), so MUs
      // flow through the SAME hover/click/box/multi/outline/delete pipeline as
      // layout objects — without `_layoutId`, `_objectMap`, or persistence.
      this._muReconciler = new MuReconciler({
        viewer,
        getMUs: () => viewer.transportManager?.mus ?? [],
        onSelectionDropped: () => this._refreshOutline(),
      });

      const canvasDeps: CanvasInteractionDeps = {
        viewer,
        store: this.store,
        canvas: viewer.renderer.domElement,
        objectMap: this._objectMap,
        idByObject: this._idByObject,
        ghost: this._ghost,
        floorPlane: this._floorPlane,
        transformControls: this._transformControls,
        modelRoot: this._getModelRoot(),
        getPlacementEntry: () => this._getPlacementEntry(),
        setDragEntry: (entry) => this.setDragEntry(entry),
        getDragEntry: () => this._dragEntry,
        placeComponent: (entry, pos) => this.placeComponent(entry, pos),
        placeAtSnap: (entry, target, ownSnapName) => this.placeAtSnap(entry, target, ownSnapName),
        removeSelected: () => this.removeSelected(),
        duplicateSelected: () => this.duplicateSelected(),
        copySelected: () => this.copySelected(),
        pasteClipboard: () => this.pasteClipboard(),
        selectObjectById: (id) => this._selectObject(id),
        isActive: () => this._active,
        boxSelect: this._boxSelect,
        // bboxSnap was constructed alongside the FloorGizmo a few lines above
        // — non-null by the time we reach this canvas-interaction init block.
        bboxSnap: this._bboxSnap!,
      };
      this._canvasInteraction = new CanvasInteractionManager(canvasDeps);
      this._canvasInteraction.wire();

      this._catalogsLoaded = this._loadCatalogs().catch((e) => {
        console.warn('[LayoutPlanner] _loadCatalogs failed:', e);
      });
    }

    // Selection is driven by the global SelectionManager pipeline
    // (canvas pointerup → raycast → allow-filter → SelectionManager.select).
    // The planner subscribes to 'selection-changed' inside setActive() to attach
    // TransformControls and manage the multi-pivot — see _onSelectionChanged.
    // No 'object-clicked' listener is needed.

    // Restore planner open state from localStorage. Planner docks to the
    // right slot — use isOpen() which is side-agnostic.
    viewer.leftPanelManager.restore?.({ 'layout-planner': LAYOUT_PANEL_WIDTH });
    if (viewer.leftPanelManager.isOpen?.('layout-planner')) {
      this.setActive(true);
    }

    // Defense-in-Depth: if another plugin replaces the panel by calling
    // `lpm.open('other', w, 'right')` (which displaces our 'layout-planner'
    // panel without ever calling our close path), auto-release the
    // 'layout-edit' pause reason. Without this, opening a competing right
    // panel while planner was active would leave the simulation frozen.
    const lpm = viewer.leftPanelManager;
    if (typeof lpm.subscribe === 'function' && typeof lpm.isOpen === 'function') {
      const lpmUnsub = lpm.subscribe(() => {
        if (this._active && !lpm.isOpen?.('layout-planner')) {
          this.setActive(false);
        }
      });
      this._unsubs.push(lpmUnsub);
    }
  }

  onModelCleared(_viewer: RVViewer): void {
    // The previous scene's MUs are disposed on model clear — unregister all
    // MU selectable nodes so we don't hold dangling registry/aux entries.
    this._muReconciler?.disposeAll();
    if (this._pairingRebuildTimer !== null) {
      clearTimeout(this._pairingRebuildTimer);
      this._pairingRebuildTimer = null;
    }
    // Layout state survives model clear — _layoutRoot is in sceneFixtures
    // Drop the always-on persistence listener; onModelLoaded re-installs it
    // for the next scene.
    this._transformUpdateUnsub?.();
    this._transformUpdateUnsub = null;
    this._layoutDeleteUnsub?.();
    this._layoutDeleteUnsub = null;
    this._splatSceneStoreUnsub?.();
    this._splatSceneStoreUnsub = null;
    // Auto-preview subscription is re-installed by the next onModelLoaded.
    this._previewStoreUnsub?.();
    this._previewStoreUnsub = null;
  }

  /**
   * Install the `layout-transform-update` persistence listener. Runs once
   * per model load (in `onModelLoaded`) so inspector/dialog edits persist
   * regardless of whether the planner is in active edit mode — locking,
   * visibility, axis inversion, and Set-Position all flow through this
   * single sink. Detached in `onModelCleared` / `dispose`.
   */
  private _installLayoutTransformListener(viewer: RVViewer): void {
    this._transformUpdateUnsub?.();
    this._transformUpdateUnsub = viewer.on('layout-transform-update', (data: unknown) => {
      const evt = data as {
        path: string;
        position: [number, number, number];
        rotation: [number, number, number];
        scale?: [number, number, number];
        visible?: boolean;
      };
      // Find the placed component by matching the node path
      for (const [id, obj] of this._objectMap) {
        const nodePath = viewer.registry?.getPathForNode(obj);
        if (nodePath !== evt.path) continue;
        const prevSnap = this.store.getSnapshot().placed.find(c => c.id === id);
        const prev = prevSnap
          ? { position: [...prevSnap.position] as [number, number, number],
              rotation: [...prevSnap.rotation] as [number, number, number],
              scale: [...prevSnap.scale] as [number, number, number] }
          : { position: [0, 0, 0] as [number, number, number],
              rotation: [0, 0, 0] as [number, number, number],
              scale: [1, 1, 1] as [number, number, number] };
        this.store.updateTransform(id, evt.position, evt.rotation);
        // Optional fields: scale (axis inversion) + visible (hide/show) ride
        // on the same event so a single inspector edit produces one
        // coalesced store change and one op-log entry.
        const nextScale = evt.scale ?? prev.scale;
        if (evt.scale) this.store.updateScale(id, evt.scale);
        if (evt.visible !== undefined) this.store.updateVisibility(id, evt.visible);
        this.store.autoSave();
        emitPlannerOp(viewer, {
          id: opId(), ts: Date.now(), schemaV: 1,
          kind: 'transformPlacement', placementId: id,
          position: evt.position, rotation: evt.rotation, scale: nextScale,
          prev,
        });
        break;
      }
    });
  }

  /** Per-frame hook: keep the FloorGizmo positioned and scale-invariant. */
  onRender(_frameDt: number): void {
    // Keep spawned-MU selectable registration in sync with the sim (register
    // new clone MUs, unregister consumed ones + drop their selection).
    if (this._active) this._muReconciler?.reconcile();
    this._transformControls?.update();
  }

  dispose(): void {
    // Box-select first — removes any active window/document listeners before
    // the canvas interaction manager tears down its own listeners.
    this._boxSelect?.dispose();
    this._boxSelect = null;

    // Canvas interaction next — removes all event listeners before teardown
    this._canvasInteraction?.dispose();
    this._canvasInteraction = null;

    // MU reconciler — unregister all MU selectable nodes (registry + aux).
    this._muReconciler?.disposeAll();
    this._muReconciler = null;
    if (this._viewer?.transportManager) this._viewer.transportManager.preferCloneMU = false;

    if (this._pairingRebuildTimer !== null) {
      clearTimeout(this._pairingRebuildTimer);
      this._pairingRebuildTimer = null;
    }

    // Multi-select pivot next — restores parenting before gizmo detach
    this._multiSelectPivot?.tearDown();
    this._multiSelectPivot = null;

    if (this._transformControls) {
      this._transformControls.setCustomSnap(null);
      this._transformControls.detach();
      // Deregister from sceneFixtures before disposing so the set doesn't
      // hold a stale reference (matches the add in _attachToViewer).
      if (this._viewer) {
        (this._viewer as unknown as { sceneFixtures: Set<Object3D> })
          .sceneFixtures.delete(this._transformControls.root);
      }
      this._transformControls.dispose();
      this._transformControls = null;
    }
    this._bboxSnap?.dispose();
    this._bboxSnap = null;
    if (this._layoutRoot.parent) {
      this._layoutRoot.parent.remove(this._layoutRoot);
    }
    if (this._viewer) {
      (this._viewer as unknown as { sceneFixtures: Set<Object3D> }).sceneFixtures.delete(this._layoutRoot);
    }

    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];

    // Remove ancestor override from raycast manager
    if (this._ancestorOverrideFn && this._viewer?.raycastManager) {
      this._viewer.raycastManager.removeAncestorOverride(this._ancestorOverrideFn);
      this._ancestorOverrideFn = null;
    }

    this._modelCache.dispose();
    this._ghost.dispose();

    if (this._thumbnailRenderer) {
      this._thumbnailRenderer.dispose();
      this._thumbnailRenderer = null;
    }
    // Stop the auto preview queue (the drain loop bails once _viewer is null).
    this._previewStoreUnsub?.();
    this._previewStoreUnsub = null;
    this._previewQueue = [];
    this._previewSeen.clear();
    if (this._gridHelper) {
      disposeSubtree(this._gridHelper);
      this._gridHelper = null;
    }
    for (const [, obj] of this._objectMap) {
      disposeSubtree(obj);
    }
    this._objectMap.clear();
    this._selectionUnsub?.();
    this._selectionUnsub = null;
    this._transformUpdateUnsub?.();
    this._transformUpdateUnsub = null;
    // Safety net: release any granular pause reasons we may still hold.
    // setActive(false) above is the primary release path; this handles edge
    // cases where dispose() is called while still active (plugin teardown,
    // viewer shutdown, model swap without explicit close). Also releases the
    // legacy 'layout-edit' reason in case any external code still sets it.
    this._viewer?.setSimulationPaused?.('layout-drag', false);
    this._viewer?.setSimulationPaused?.('layout-placement', false);
    this._viewer?.setSimulationPaused?.('layout-edit', false);
    // Reset edit-pause bookkeeping so a fresh attach starts clean.
    this._editPauseDepth = 0;
    this._editWasRunning = false;
    this._dragEntryEditActive = false;
    this._viewer = null;
  }

  // ─── Public API ───────────────────────────────────────────────────

  get active(): boolean { return this._active; }

  /** Refcount of in-flight 3D edit gestures (drag / transform / placement). */
  private _editPauseDepth = 0;
  /** Whether the sim was running when the FIRST overlapping edit gesture began. */
  private _editWasRunning = false;

  /**
   * Begin an edit-gesture pause: dragging in an asset, moving a placed object,
   * or transforming one via the gizmo. Uses a DEDICATED pause reason (distinct
   * from the user's manual pause) and refcounts overlapping gestures. The
   * "was running" state is captured on the first (0→1) acquisition so the
   * matching `_endEditPause()` can auto-resume — but only when no other reason
   * (e.g. a manual user pause engaged mid-edit) still holds the sim.
   */
  private _beginEditPause(): void {
    const v = this._viewer;
    if (!v) return;
    if (this._editPauseDepth === 0) {
      this._editWasRunning = !v.isSimulationPaused;
      v.setSimulationPaused?.(LAYOUT_EDIT_PAUSE_REASON, true);
    }
    this._editPauseDepth++;
  }

  /**
   * End an edit-gesture pause. When the last overlapping gesture finishes,
   * release the edit reason. The sim then resumes ONLY if it was running before
   * the edit AND nothing else holds it paused — `setSimulationPaused` keys are
   * independent, so a manual `USER_PAUSE_REASON` engaged during the edit keeps
   * the sim paused.
   */
  private _endEditPause(): void {
    if (this._editPauseDepth === 0) return;
    this._editPauseDepth--;
    if (this._editPauseDepth === 0 && this._editWasRunning) {
      this._viewer?.setSimulationPaused?.(LAYOUT_EDIT_PAUSE_REASON, false);
    }
  }

  setActive(active: boolean): void {
    if (this._active === active) return;
    this._active = active;
    setContext('planner', active);

    const viewer = this._viewer;
    if (!viewer) {
      if (this._gridHelper) this._gridHelper.visible = active && this.store.gridEnabled;
      return;
    }

    // Planner mode no longer stops the simulation on enter — it keeps running
    // so the user sees live behaviour while laying out. The sim is auto-stopped
    // only when the user actively edits (place / move / transform), via
    // `_beginEditPause()`, and auto-resumes on gesture end if it was running.

    if (!active) {
      // Drop modifier listeners installed when entering planner mode.
      if (this._onWindowKeyDownBound) window.removeEventListener('keydown', this._onWindowKeyDownBound);
      if (this._onWindowKeyUpBound) window.removeEventListener('keyup', this._onWindowKeyUpBound);
      this._onWindowKeyDownBound = null;
      this._onWindowKeyUpBound = null;
      this._altDown = false;
    }

    if (active) {
      // Track the ALT modifier on the window so drag-start can capture it.
      // Using window listeners (rather than reading from the most recent
      // pointer event) handles the case where the user presses ALT AFTER
      // mousedown but BEFORE the first pointermove that promotes to a drag.
      this._onWindowKeyDownBound = (e: KeyboardEvent) => { if (e.key === 'Alt') this._altDown = true; };
      this._onWindowKeyUpBound = (e: KeyboardEvent) => { if (e.key === 'Alt') this._altDown = false; };
      window.addEventListener('keydown', this._onWindowKeyDownBound);
      window.addEventListener('keyup', this._onWindowKeyUpBound);

      // Entering planner mode — clear any pre-existing (non-layout) selection
      // so we start clean. The new allow filter would otherwise leave a
      // now-unreachable selection in place visually until the next click.
      viewer.selectionManager.clear();

      // 1. Restrict raycast hits to planner-selectable nodes (layout instances
      //    AND spawned MUs). Save prior filter for coexistence with other plugins.
      this._priorAllowFilter = viewer.raycastManager?.getAllowFilter?.() ?? null;
      viewer.raycastManager?.setAllowFilter((node) =>
        isPlannerSelectable(node) && !isLockedLayoutInstance(node));

      // Spawn MUs as clones (real Object3Ds) while planner is active so they can
      // be registered as selectable scene nodes (instanced MUs have no per-
      // instance node). Reset on exit.
      if (viewer.transportManager) viewer.transportManager.preferCloneMU = true;

      // 2. Mute the default selection overlay — OutlinePass takes over the
      //    selection visual via outlineManager. Hover stays as overlay-mesh
      //    (faint green) since hover has many call sites and is per-frame.
      viewer.highlighter.setSelectionStyle(PLANNER_SELECTION_MUTE_STYLE);
      viewer.highlighter.setHoverStyle(PLANNER_HOVER_STYLE);

      // 3. Configure the outline pass for planner-mode green silhouette.
      //    No-op on WebGPU (outlineManager.available === false).
      viewer.outlineManager.setStyle(PLANNER_OUTLINE_STYLE);

      // 4. Subscribe to selection changes — drives TransformControls + multi-pivot
      //    + OutlinePass selectedObjects (via _refreshOutline).
      this._selectionUnsub = viewer.on('selection-changed',
        this._onSelectionChanged as (data: unknown) => void);

      // 5. Track dropToSurface toggle → show/hide the gizmo's Y-axis lift handle.
      //    The Y bar lets users place objects above the floor; when dropToSurface
      //    is on it would just be re-snapped, so we hide it.
      //    Also track placementMode → pause the simulation while a library
      //    entry is being placed (ghost preview is following the cursor), so
      //    sources don't spawn before the user drops the object.
      let lastDts = this.store.dropToSurface;
      let lastPlacing = this.store.getSnapshot().placementMode !== null;
      this._storeUnsub = this.store.subscribe(() => {
        const dts = this.store.dropToSurface;
        if (dts !== lastDts) {
          lastDts = dts;
          this._transformControls?.setYAxisEnabled(!dts);
          this._viewer?.markRenderDirty();
        }
        const placing = this.store.getSnapshot().placementMode !== null;
        if (placing !== lastPlacing) {
          lastPlacing = placing;
          // Auto-stop while a click-to-place gesture is active (the ghost
          // follows the cursor), auto-resume when it ends if the sim was
          // running before — balanced begin/end via the edit-pause refcount.
          if (placing) this._beginEditPause();
          else this._endEditPause();
        }
      });

      // Persistence listener used to be wired here, but inspector edits
      // (Visible toggle, Splat Invert, Set-Position dialog, …) fire even
      // when the planner is NOT in edit mode — the user just wants to
      // tweak a value via the property panel. We now install/teardown the
      // listener in onModelLoaded/onModelCleared instead, so persistence
      // works regardless of planner-mode state.
    } else {
      // Leaving planner mode — clear selection FIRST so the existing
      // overlay meshes / outline are removed before we restore styles.
      viewer.selectionManager.clear();
      viewer.outlineManager.clear();
      // Unregister MU selectable nodes + stop forcing clone-mode spawning.
      this._muReconciler?.disposeAll();
      if (viewer.transportManager) viewer.transportManager.preferCloneMU = false;

      this._multiSelectPivot?.tearDown();
      this._transformControls?.detach();

      this._selectionUnsub?.();
      this._selectionUnsub = null;
      // _transformUpdateUnsub is now owned by onModelLoaded/onModelCleared
      // (always-on) — do NOT tear it down on planner deactivation.
      this._storeUnsub?.();
      this._storeUnsub = null;

      viewer.highlighter.setSelectionStyle(null);
      viewer.highlighter.setHoverStyle(null);

      viewer.raycastManager?.setAllowFilter(this._priorAllowFilter);
      this._priorAllowFilter = null;
    }

    if (this._gridHelper) this._gridHelper.visible = active && this.store.gridEnabled;
    viewer.markRenderDirty();
  }

  /**
   * React to global selection changes. While planner is active, selection is
   * always restricted to layout instances by the allow filter, so any path in
   * the snapshot resolves to either a layout instance or nothing.
   */
  private _onSelectionChanged = (snap: SelectionSnapshot): void => {
    if (!this._active || !this._viewer) return;
    // MUs and layout objects share ONE selection (SelectionManager paths). The
    // gizmo + store sync below filter to `isLayoutInstance`, so MUs are
    // naturally excluded from the gizmo and persistence; the outline includes
    // both (see _refreshOutline).
    this._syncTransformControlsToSelection(snap);
    this._syncLayoutStoreToSelection(snap);
    this._refreshOutline();
  };

  /** Write a single member's local transform (position + Euler) to the store.
   *  Per-frame coalescing on the SceneStore side merges drag updates into
   *  a single transformPlacement op (one undo step per drag). */
  private _writeSingleTransform(id: string, obj: Object3D): void {
    const prevSnap = this.store.getSnapshot().placed.find(c => c.id === id);
    const prev = prevSnap
      ? { position: [...prevSnap.position] as [number, number, number],
          rotation: [...prevSnap.rotation] as [number, number, number],
          scale: [...prevSnap.scale] as [number, number, number] }
      : { position: [0, 0, 0] as [number, number, number],
          rotation: [0, 0, 0] as [number, number, number],
          scale: [1, 1, 1] as [number, number, number] };

    const newPos: [number, number, number] = [obj.position.x, obj.position.y, obj.position.z];
    const newRot: [number, number, number] = [
      MathUtils.radToDeg(obj.rotation.x),
      MathUtils.radToDeg(obj.rotation.y),
      MathUtils.radToDeg(obj.rotation.z),
    ];

    this.store.updateTransform(id, newPos, newRot);
    this.store.autoSave();

    emitPlannerOp(this._viewer, {
      id: opId(), ts: Date.now(), schemaV: 1,
      kind: 'transformPlacement', placementId: id,
      position: newPos, rotation: newRot, scale: [...prev.scale],
      prev,
    });

    // Broadcast the new transform so listeners that don't own the
    // layout-store path can react too — primarily the gaussian-splat
    // plugin, whose splatMesh lives outside the host scene graph and
    // needs an explicit sync on every Gizmo-drag tick. Cheap; subscribers
    // typically O(1).
    if (this._viewer) {
      const path = this._viewer.registry?.getPathForNode(obj);
      if (path) {
        this._viewer.emit('layout-transform-update', {
          path,
          position: newPos,
          rotation: newRot,
        });
      }
    }
  }

  /**
   * Build the drop-to-surface raycast candidates for `selfObj`: the usual
   * scene meshes (via `collectDropTargets`) PLUS a transient top-plane for each
   * transport surface in the scene. The transport planes let objects be placed
   * on a conveyor top even when the surface has no solid top geometry (e.g. an
   * AABB-only / virtual conveyor). The dragged object's own surface(s) are
   * skipped so it never drops onto itself.
   */
  private _collectDropTargetsWithTransport(selfObj: Object3D): Mesh[] {
    const v = this._viewer;
    if (!v) return [];
    const targets = collectDropTargets(v.scene, selfObj);
    const surfaces = v.transportManager?.surfaces ?? [];
    if (surfaces.length === 0) return targets;
    const selfNodes = new Set<Object3D>();
    selfObj.traverse((c) => selfNodes.add(c));
    for (const s of surfaces) {
      if (selfNodes.has(s.node)) continue; // don't target the dragged object's own surface
      const plane = s.createDropPlane();
      if (plane) targets.push(plane);
    }
    return targets;
  }

  /**
   * Push the current outlined-objects list to the viewer's OutlinePass.
   * The list is the union of:
   *   - all currently selected layout instance roots
   *   - the placement-preview ghost root (when visible)
   *
   * Call this whenever the selection changes, the ghost is shown/hidden/
   * replaced, or the planner activates/deactivates. Cheap when nothing
   * outlined; OutlinePass early-outs on empty selectedObjects.
   */
  private _refreshOutline(): void {
    const viewer = this._viewer;
    if (!viewer) return;
    if (!this._active) {
      viewer.outlineManager.clear();
      return;
    }

    const objs: Object3D[] = [];

    // Selection: resolve each selected path to a planner-selectable node. This
    // covers BOTH layout instances AND spawned MUs (registered selectable
    // scene nodes), so MUs get the same green outline as layout objects.
    const snap = viewer.selectionManager.getSnapshot();
    for (const path of snap.selectedPaths) {
      const node = viewer.registry?.getNode(path);
      if (node && isPlannerSelectable(node)) objs.push(node);
    }

    // Ghost: only when visible (and not the same object as selection).
    const ghost = this._ghost.ghost;
    if (ghost && this._ghost.visible) objs.push(ghost);

    viewer.outlineManager.setOutlined(objs);
  }

  /**
   * Attach TransformControls to the current selection, delegating multi-select
   * pivot management to MultiSelectPivot.
   */
  private _syncTransformControlsToSelection(snap: SelectionSnapshot): void {
    const tc = this._transformControls;
    const viewer = this._viewer;
    if (!tc || !viewer) return;

    const objs: Object3D[] = [];
    for (const path of snap.selectedPaths) {
      const node = viewer.registry?.getNode(path);
      if (node && isLayoutInstance(node)) objs.push(node);
    }

    // Ensure MultiSelectPivot exists (lazy-init on first selection)
    if (!this._multiSelectPivot) {
      this._multiSelectPivot = new MultiSelectPivot({
        scene: viewer.scene,
        store: this.store,
        transformControls: tc,
        viewer,
        idByObject: this._idByObject,
      });
    }

    this._multiSelectPivot.syncToSelection(
      objs,
      this.store.gridEnabled,
      this.store.gridSizeMm,
      this.store.rotationSnapDeg,
    );
  }

  /**
   * Mirror the SelectionManager primary selection into LayoutStore.selectedId
   * so the panel UI stays in sync. One-way (SelectionManager → store).
   */
  private _syncLayoutStoreToSelection(snap: SelectionSnapshot): void {
    const viewer = this._viewer;
    if (!viewer) return;
    let id: string | null = null;
    if (snap.primaryPath) {
      const node = viewer.registry?.getNode(snap.primaryPath);
      if (node) id = this._idByObject.get(node) ?? null;
    }
    if (this.store.selectedId !== id) this.store.selectComponent(id);
  }

  /** Whether a library drag-in gesture currently holds an edit-pause. */
  private _dragEntryEditActive = false;

  /** Set the entry being dragged from the library panel (for drag ghost). */
  setDragEntry(entry: LibraryCatalogEntry | null): void {
    this._dragEntry = entry;
    if (entry) {
      // Dragging an asset in from the library is an edit gesture — auto-stop
      // the simulation; auto-resume on drop/cancel if it was running before.
      // Guarded so begin/end balance exactly once per drag-in gesture.
      if (!this._dragEntryEditActive) {
        this._dragEntryEditActive = true;
        this._beginEditPause();
      }
      this._ghost.ensureForEntry(entry);
    } else {
      this._ghost.hide();
      if (this._dragEntryEditActive) {
        this._dragEntryEditActive = false;
        this._endEditPause();
      }
    }
  }

  /** Place a component in the scene from a catalog entry. */
  async placeComponent(
    entry: LibraryCatalogEntry,
    position: [number, number, number],
  ): Promise<string> {
    if (!this._viewer) throw new Error('Viewer not initialized');

    let node!: Object3D;

    let isSplat = false;

    if (entry.splatUrl) {
      // Gaussian Splat — load via the splat plugin's multi-instance API.
      // Local-folder splats use blob: URLs that hide the file extension,
      // so we pass it explicitly from entry.localPath.
      const splatPlugin = await this._viewer.resolvePlugin('gaussian-splat');
      if (!splatPlugin) throw new Error('gaussian-splat plugin not available');
      const fileExt = extractSplatFileExt({ localPath: entry.localPath, url: entry.splatUrl });
      node = await (splatPlugin as unknown as import('./gaussian-splat-plugin-type').GaussianSplatPluginApi).loadSplat(entry.splatUrl, fileExt);
      isSplat = true;
    } else if (entry.virtual && entry.desType) {
      // Virtual DES component — try component's createGizmo(), fall back to generic wireframe
      const gizmoSize = entry.gizmoSize ?? [500, 500, 500] as [number, number, number];
      let gizmoCreated = false;

      // Look for registered component class with createGizmo
      try {
        const { getRegisteredFactories } = await import(
          '../../core/engine/rv-component-registry'
        );
        const factories = getRegisteredFactories();
        const factory = factories.get(entry.desType);
        if (factory && typeof (factory as any).ctor?.createGizmo === 'function') {
          node = (factory as any).ctor.createGizmo(gizmoSize);
          gizmoCreated = true;
        }
      } catch { /* ignore — use fallback */ }

      if (!gizmoCreated) {
        const { createVirtualPlaceholder } = await import('./ghost-manager');
        node = createVirtualPlaceholder(gizmoSize, entry.desType);
      }

      node.name = entry.name;
      node.userData.realvirtual = {
        [entry.desType]: entry.desConfig ?? {},
      };
    } else {
      // Standard GLB-based component
      node = await this._modelCache.getOrLoad(entry.glbUrl ?? '');
    }

    const id = crypto.randomUUID();

    if (isSplat) {
      // Splats are already added to the scene by loadSplat() —
      // just mark layout metadata (no pivotToFloorCenter, no alignToFloor)
      this._addSplatPlacedToScene(node, id, entry.name, entry.id, entry.splatUrl!);
    } else {
      this._addPlacedToScene(node, id, entry.name, entry.id);
    }
    node.position.x = position[0];
    node.position.z = position[2];
    // Mirror the live node state into the marker components so the Inspector
    // renders the Splat section (Invert X/Y/Z buttons) immediately on first
    // placement — without this, `rv.Splat` only appears after a reload via the
    // restore path, so the axis-invert controls are missing for fresh splats.
    syncLayoutMarkerComponents(node, true);

    // Broadcast initial placement so transform-coupled subscribers
    // (notably the gaussian-splat plugin, whose splatMesh sits outside
    // the host scene graph) can sync up. Without this, fresh splats
    // would render at world origin until the user nudges them.
    if (this._viewer) {
      const placedPath = this._viewer.registry?.getPathForNode(node);
      if (placedPath) {
        this._viewer.emit('layout-transform-update', {
          path: placedPath,
          position: [node.position.x, node.position.y, node.position.z],
          rotation: [
            MathUtils.radToDeg(node.rotation.x),
            MathUtils.radToDeg(node.rotation.y),
            MathUtils.radToDeg(node.rotation.z),
          ],
        });
      }
    }

    const comp: PlacedComponent = {
      id,
      catalogId: entry.id,
      glbUrl: entry.glbUrl ?? '',
      label: entry.name,
      position: [node.position.x, node.position.y, node.position.z],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      ...(isSplat ? { splatUrl: entry.splatUrl } : {}),
    };
    this.store.addComponent(comp);
    this.store.autoSave();
    this._refreshHierarchy();

    // Record the placement in the SceneStore op log for undo/redo.
    // The executor's forward is idempotent (won't double-add), so this
    // doesn't fight the direct mutation above.
    emitPlannerOp(this._viewer, {
      id: opId(), ts: Date.now(), schemaV: 1,
      kind: 'addPlacement', placement: { ...comp },
    });

    // Place-one-at-a-time UX: exit placement mode and hide the ghost so the
    // user can immediately work with the just-placed object instead of
    // accidentally placing duplicates on the next click/move.
    this.store.setPlacementMode(null);
    this._dragEntry = null;
    this._ghost.hide();

    // Auto-select the newly placed object so the user can immediately move/rotate it.
    // Routes through SelectionManager → 'selection-changed' → TransformControls attach.
    this._selectObject(id);

    this._viewer.markRenderDirty();
    this._viewer.emit('layout:component-placed' as any, { id, entry });
    return id;
  }

  /**
   * Remove ALL currently selected layout instances. Multi-select aware —
   * pulls paths from the global SelectionManager so a marquee selection of
   * N items is deleted with one click (or one Delete-key press).
   *
   * All removals are wrapped in a single SceneStore transaction, so undo
   * brings every deleted item back as one step, in their original positions.
   */
  async removeSelected(): Promise<void> {
    const viewer = this._viewer;
    if (!viewer) return;

    const selectionPaths = viewer.selectionManager.getSnapshot().selectedPaths;

    // Spawned MUs are sim-owned (not layout placements) — delete them via the
    // transport manager (works while paused). One Delete press removes a mixed
    // layout + MU selection: MUs here, layout placements below.
    const muPaths: string[] = [];
    for (const path of selectionPaths) {
      const node = viewer.registry?.getNode(path);
      const mu = node && isMuSelectable(node)
        ? (node.userData._muRef as RVMovingUnit | undefined)
        : undefined;
      if (mu) { viewer.transportManager?.removeMU(mu); muPaths.push(path); }
    }
    if (muPaths.length > 0) {
      const remaining = selectionPaths.filter(p => !muPaths.includes(p));
      viewer.selectionManager.selectPaths(remaining);
      this._refreshOutline();
    }

    // Resolve the set of placement IDs to remove. Prefer SelectionManager
    // (multi-aware); fall back to LayoutStore.selectedId for any code path
    // that still drives single-select without going through SelectionManager.
    const ids = this._pathsToPlacementIds(selectionPaths);
    if (ids.length === 0 && muPaths.length === 0 && this.store.selectedId) {
      ids.push(this.store.selectedId);
    }
    if (ids.length > 0) await this._removeByPlacementIds(ids);
  }

  /**
   * Remove layout instances by node path. Used by the hierarchy browser's
   * context-menu Delete action — the menu only knows paths.
   */
  async removeByPaths(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const ids = this._pathsToPlacementIds(paths);
    await this._removeByPlacementIds(ids);
  }

  /** Map node paths to unique placement IDs (preserving order, dedup'd). */
  private _pathsToPlacementIds(paths: readonly string[]): string[] {
    const viewer = this._viewer;
    if (!viewer) return [];
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const path of paths) {
      const node = viewer.registry?.getNode(path);
      if (!node) continue;
      const id = this._idByObject.get(node);
      if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
    }
    return ids;
  }

  /** Core removal pipeline shared by `removeSelected` and `removeByPaths`. */
  private async _removeByPlacementIds(ids: string[]): Promise<void> {
    const viewer = this._viewer;
    if (!viewer || ids.length === 0) return;

    // Snapshot all placements BEFORE mutation so each removePlacement op
    // carries the full record for undo.
    const placedNow = this.store.getSnapshot().placed;
    const snapsById = new Map<string, PlacedComponent>();
    for (const id of ids) {
      const snap = placedNow.find(c => c.id === id);
      if (snap) snapsById.set(id, { ...snap });
    }

    // Clear the selection up-front so the gizmo / outline detach before the
    // underlying objects disappear (avoids brief flash of dangling outlines).
    viewer.selectionManager.clear();

    const sceneStore = getSceneStore();
    const removeOne = (id: string): void => {
      this._removePlacedFromScene(id);
      this.store.removeComponent(id);
    };

    if (sceneStore) {
      // Single composite op → single undo restores all deleted items.
      await sceneStore.withTransaction(
        ids.length > 1 ? `Delete ${ids.length} items` : 'Delete item',
        async () => {
          for (const id of ids) {
            const snap = snapsById.get(id);
            removeOne(id);
            if (snap) {
              await sceneStore.applyOp({
                id: opId(), ts: Date.now(), schemaV: 1,
                kind: 'removePlacement', placementId: id, placement: snap,
              });
            }
          }
        },
      );
    } else {
      // SceneStore not available (boot/test) — still perform the removal.
      for (const id of ids) removeOne(id);
    }

    this.store.autoSave();
    this._refreshHierarchy();
    viewer.markRenderDirty();
  }

  /** Duplicate the currently selected component. */
  async duplicateSelected(): Promise<string | null> {
    const snapshot = this.store.getSnapshot();
    const id = snapshot.selectedId;
    if (!id) return null;

    const comp = snapshot.placed.find(c => c.id === id);
    if (!comp) return null;

    let node: Object3D;
    const newId = crypto.randomUUID();
    const label = comp.label + ' (copy)';
    const isSplat = !!comp.splatUrl;

    if (isSplat) {
      // Splat duplicate — create a new viewer instance. Resolve the file
      // extension via the source catalog entry so blob:-URL splats still
      // load correctly.
      const splatPlugin = await this._viewer!.resolvePlugin('gaussian-splat');
      if (!splatPlugin) return null;
      const dupEntry = this._findCatalogEntryById(comp.catalogId);
      const fileExt = extractSplatFileExt({ localPath: dupEntry?.localPath, url: comp.splatUrl });
      node = await (splatPlugin as unknown as import('./gaussian-splat-plugin-type').GaussianSplatPluginApi).loadSplat(comp.splatUrl!, fileExt);
      this._addSplatPlacedToScene(node, newId, label, comp.catalogId, comp.splatUrl!);
    } else {
      node = await this._modelCache.getOrLoad(comp.glbUrl);
      this._addPlacedToScene(node, newId, label, comp.catalogId);
    }

    node.position.set(comp.position[0] + 0.5, node.position.y, comp.position[2] + 0.5);
    node.rotation.set(
      MathUtils.degToRad(comp.rotation[0]),
      MathUtils.degToRad(comp.rotation[1]),
      MathUtils.degToRad(comp.rotation[2]),
    );
    // Re-drop after position override (addPlacedToScene dropped at the original spot)
    if (!isSplat && this.store.dropToSurface && this._viewer) {
      dropToSurface(node, this._viewer.scene);
    }

    const newComp: PlacedComponent = {
      id: newId,
      catalogId: comp.catalogId,
      glbUrl: comp.glbUrl,
      label,
      position: [node.position.x, node.position.y, node.position.z],
      rotation: [...comp.rotation],
      scale: [...comp.scale],
      ...(isSplat ? { splatUrl: comp.splatUrl } : {}),
    };
    this.store.addComponent(newComp);
    this.store.autoSave();
    this._selectObject(newId);
    this._refreshHierarchy();

    if (this._viewer) this._viewer.markRenderDirty();

    emitPlannerOp(this._viewer, {
      id: opId(), ts: Date.now(), schemaV: 1,
      kind: 'addPlacement', placement: { ...newComp },
    });

    return newId;
  }

  /**
   * Capture the current selection into the planner's internal clipboard.
   * Multi-aware (uses SelectionManager) with fallback to `store.selectedId`.
   * Returns the number of placements captured. Source records remain in
   * place; only deep clones are stored so the originals can't drift.
   */
  copySelected(): number {
    const viewer = this._viewer;
    const placedNow = this.store.getSnapshot().placed;
    const ids: string[] = [];
    const seen = new Set<string>();

    if (viewer) {
      const selectionPaths = viewer.selectionManager.getSnapshot().selectedPaths;
      for (const path of selectionPaths) {
        const node = viewer.registry?.getNode(path);
        if (!node) continue;
        const id = this._idByObject.get(node);
        if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
      }
    }
    if (ids.length === 0 && this.store.selectedId) {
      ids.push(this.store.selectedId);
    }
    if (ids.length === 0) {
      this._clipboard = [];
      return 0;
    }

    this._clipboard = ids
      .map(id => placedNow.find(c => c.id === id))
      .filter((c): c is PlacedComponent => !!c)
      .map(c => ({
        ...c,
        position: [...c.position] as [number, number, number],
        rotation: [...c.rotation] as [number, number, number],
        scale: [...c.scale] as [number, number, number],
      }));
    return this._clipboard.length;
  }

  /**
   * Paste the planner clipboard. Each entry becomes a new placement with a
   * fresh UUID, offset by +0.5 m on X/Z (matches `duplicateSelected`). All
   * newly pasted items become the new selection. Returns the list of new
   * placement IDs (empty when the clipboard is empty).
   */
  async pasteClipboard(): Promise<string[]> {
    if (this._clipboard.length === 0) return [];

    const newIds: string[] = [];

    for (const comp of this._clipboard) {
      let node: Object3D;
      const newId = crypto.randomUUID();
      const label = comp.label + ' (copy)';
      const isSplat = !!comp.splatUrl;

      // Look up the catalog entry by id — the entry is the source of truth
      // for how a component is constructed (splat / virtual DES / GLB).
      // Falls back to the clipboard record when the catalog entry is gone.
      const entry = this._findCatalogEntryById(comp.catalogId);

      if (isSplat) {
        const splatPlugin = await this._viewer!.resolvePlugin('gaussian-splat');
        if (!splatPlugin) continue;
        const fileExt = extractSplatFileExt({ localPath: entry?.localPath, url: comp.splatUrl });
        node = await (splatPlugin as unknown as import('./gaussian-splat-plugin-type').GaussianSplatPluginApi).loadSplat(comp.splatUrl!, fileExt);
        this._addSplatPlacedToScene(node, newId, label, comp.catalogId, comp.splatUrl!);
      } else if (entry?.virtual && entry.desType) {
        // Virtual DES component — recreate via createGizmo / createVirtualPlaceholder
        // (same path as placeComponent). Without this branch, paste would call
        // _modelCache.getOrLoad('') and fail because virtual entries have no glbUrl.
        const gizmoSize = entry.gizmoSize ?? [500, 500, 500] as [number, number, number];
        let gizmoCreated = false;
        try {
          const { getRegisteredFactories } = await import('../../core/engine/rv-component-registry');
          const factories = getRegisteredFactories();
          const factory = factories.get(entry.desType);
          if (factory && typeof (factory as any).ctor?.createGizmo === 'function') {
            node = (factory as any).ctor.createGizmo(gizmoSize);
            gizmoCreated = true;
          }
        } catch { /* fall through to placeholder */ }
        if (!gizmoCreated) {
          const { createVirtualPlaceholder } = await import('./ghost-manager');
          node = createVirtualPlaceholder(gizmoSize, entry.desType);
        }
        node!.name = entry.name;
        node!.userData.realvirtual = { [entry.desType]: entry.desConfig ?? {} };
        this._addPlacedToScene(node!, newId, label, comp.catalogId);
      } else {
        // Standard GLB-based component
        if (!comp.glbUrl) {
          console.warn(`[LayoutPlanner] Cannot paste "${comp.label}" — no glbUrl and no virtual catalog entry.`);
          continue;
        }
        node = await this._modelCache.getOrLoad(comp.glbUrl);
        this._addPlacedToScene(node, newId, label, comp.catalogId);
      }

      node!.position.set(comp.position[0] + 0.5, node!.position.y, comp.position[2] + 0.5);
      node!.rotation.set(
        MathUtils.degToRad(comp.rotation[0]),
        MathUtils.degToRad(comp.rotation[1]),
        MathUtils.degToRad(comp.rotation[2]),
      );
      if (!isSplat && this.store.dropToSurface && this._viewer) {
        dropToSurface(node!, this._viewer.scene);
      }

      const newComp: PlacedComponent = {
        id: newId,
        catalogId: comp.catalogId,
        glbUrl: comp.glbUrl,
        label,
        position: [node!.position.x, node!.position.y, node!.position.z],
        rotation: [...comp.rotation],
        scale: [...comp.scale],
        ...(isSplat ? { splatUrl: comp.splatUrl } : {}),
      };
      this.store.addComponent(newComp);

      emitPlannerOp(this._viewer, {
        id: opId(), ts: Date.now(), schemaV: 1,
        kind: 'addPlacement', placement: { ...newComp },
      });

      newIds.push(newId);
    }

    if (newIds.length === 0) return [];

    this.store.autoSave();
    this._refreshHierarchy();

    // Select all freshly pasted items via SelectionManager.selectPaths so
    // multi-paste lands on a multi-selection (single-paste falls through to
    // the same code path with a one-element array).
    const viewer = this._viewer;
    if (viewer) {
      const paths: string[] = [];
      for (const id of newIds) {
        const obj = this._objectMap.get(id);
        if (!obj) continue;
        const path = viewer.registry?.getPathForNode(obj);
        if (path) paths.push(path);
      }
      if (paths.length > 0) viewer.selectionManager.selectPaths(paths);
      viewer.markRenderDirty();
    }

    return newIds;
  }

  /** Select a placed object by ID. */
  selectById(id: string | null): void {
    this._selectObject(id);
  }

  /** Save layout to a downloadable JSON file. */
  downloadLayout(name: string): void {
    const layout = this.snapshotAsLayoutFile(name);
    const json = JSON.stringify(layout, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/\s+/g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Capture the current placed state as a LayoutFile. Used by the
   *  Scene window to persist named layouts in the layout-registry.
   *
   *  @deprecated Prefer `snapshotPlacements()` and the unified Scene model.
   *  Kept as an alias while the legacy layout-registry path is being phased out.
   */
  snapshotAsLayoutFile(name: string): import('./rv-layout-store').LayoutFile {
    const s = this.snapshotPlacements();
    return serializeLayout(name, s.placements, s.catalogUrls, s.gridSizeMm);
  }

  /** Restore a layout from an in-memory LayoutFile. Re-places all components.
   *
   *  @deprecated Prefer `applyPlacements({ placements, catalogUrls, gridSizeMm })`.
   *  Kept as an alias while the legacy layout-registry path is being phased out.
   */
  async applyLayoutFile(layout: import('./rv-layout-store').LayoutFile): Promise<void> {
    return this.applyPlacements({
      placements: layout.components,
      catalogUrls: layout.catalogUrls,
      gridSizeMm: layout.gridSizeMm,
    });
  }

  /**
   * Capture the planner's current state as a placements snapshot — the
   * lean, layout-file-free form consumed by the unified Scene model.
   */
  snapshotPlacements(): PlacementsSnapshot {
    const snap = this.store.getSnapshot();
    return {
      placements: snap.placed,
      catalogUrls: snap.catalogUrls,
      gridSizeMm: snap.gridSizeMm,
    };
  }

  /**
   * Re-place all components from a placements snapshot. Used by the unified
   * Scene model to restore a saved scene's planner contents.
   */
  async applyPlacements(snap: PlacementsSnapshot): Promise<void> {
    const hasContent = snap.placements.length > 0 || snap.catalogUrls.length > 0;
    this.setLayoutFloorVisible(hasContent);
    return this._restorePlacements(snap);
  }

  // ───────────────────────────────────────────────────────────────────
  // Op executor primitives — single placement add / remove / transform.
  // Called by `rv-scene-executors.ts` when applying EditOp records to the
  // live scene. Each one is idempotent: re-running the same forward op is
  // safe (no duplicate adds, no errors on missing ids).
  // ───────────────────────────────────────────────────────────────────

  /**
   * Add a single placement clone from a `PlacedComponent` record (op
   * forward executor). Idempotent: returns silently if a placement with
   * the same id already exists.
   */
  async placeFromRecord(p: PlacedComponent): Promise<void> {
    if (this._objectMap.has(p.id)) return;

    let node: Object3D;

    if (p.splatUrl) {
      // Splat placement — load via the splat plugin
      const splatPlugin = await this._viewer!.resolvePlugin('gaussian-splat');
      if (!splatPlugin) {
        console.warn(`[LayoutPlanner] gaussian-splat plugin not available — skipping "${p.label}"`);
        return;
      }
      const pEntry = this._findCatalogEntryById(p.catalogId);
      const fileExt = extractSplatFileExt({ localPath: pEntry?.localPath, url: p.splatUrl });
      node = await (splatPlugin as unknown as import('./gaussian-splat-plugin-type').GaussianSplatPluginApi).loadSplat(p.splatUrl, fileExt);
      this._addSplatPlacedToScene(node, p.id, p.label, p.catalogId, p.splatUrl);
    } else {
      node = await this._modelCache.getOrLoad(p.glbUrl);
      this._addPlacedToScene(node, p.id, p.label, p.catalogId);
    }

    node.position.set(p.position[0], p.position[1], p.position[2]);
    node.rotation.set(
      MathUtils.degToRad(p.rotation[0]),
      MathUtils.degToRad(p.rotation[1]),
      MathUtils.degToRad(p.rotation[2]),
    );
    node.scale.set(p.scale[0], p.scale[1], p.scale[2]);
    // Restore visibility flag (defaults to true / visible on legacy entries)
    if (p.visible === false) node.visible = false;
    // Mirror the live Three.js state back into the marker components so the
    // Inspector renders the correct values right after restore.
    syncLayoutMarkerComponents(node, p.visible !== false);
    // Splat overlay overrides aren't applied by loadGLB (splats are created
    // after that pass) — copy them out of the op log and push the resulting
    // scale into the splat library so InvertX/Y/Z visibly stick on reload.
    if (p.splatUrl) applySplatOverridesFromScene(node, this._viewer!);
    // Broadcast restored transform so loosely-coupled subscribers (splat
    // plugin, …) can sync to the just-loaded position/rotation.
    if (this._viewer && p.splatUrl) {
      const restoredPath = this._viewer.registry?.getPathForNode(node);
      if (restoredPath) {
        this._viewer.emit('layout-transform-update', {
          path: restoredPath,
          position: p.position,
          rotation: p.rotation,
        });
      }
    }
    // Mirror placement record into the layout store so existing UI
    // (selection, hierarchy) sees the new entry without going through
    // the legacy add path. We've already verified above that no entry
    // with this id exists, so addComponent is safe here.
    this.store.addComponent({ ...p });
    // Op-replay (redo / multiuser / scene load) adds placements one at a time
    // and does not pair snaps. Coalesce a rebuild so a chained assembly's
    // connections are reconstructed once the whole burst has landed.
    this._scheduleSnapPairingRebuild();
    if (this._viewer) this._viewer.markRenderDirty();
  }

  /**
   * Remove a single placement by id (op forward / undo of add).
   * Idempotent: silent no-op if id not found.
   */
  removePlacementById(id: string): void {
    if (!this._objectMap.has(id)) return;
    this._removePlacedFromScene(id);
    this.store.removeComponent(id);
    if (this._viewer) this._viewer.markRenderDirty();
  }

  /**
   * Apply a transform (position / rotation / scale, all in mm + degrees as
   * stored on `PlacedComponent`) to an existing placement.
   * Idempotent: silent no-op if id not found.
   */
  applyTransformById(
    id: string,
    position: [number, number, number],
    rotation: [number, number, number],
    scale: [number, number, number],
  ): void {
    const obj = this._objectMap.get(id);
    if (!obj) return;

    // The placement record's position/rotation are in the obj's normal
    // (layout-root or model-root) frame. While a multi-select pivot is
    // active, `obj.parent` is the pivot Group — its frame is the centroid,
    // NOT the layout root. Setting `obj.position.set(...)` in that state
    // would land the layout-root values into the pivot frame and shift the
    // world position by the centroid (the "jump on release" bug).
    //
    // Detour: re-park under originalParent (Object3D.attach preserves world
    // transform), set the placement-record local values, then re-attach to
    // the pivot. Forward apply during drag-end becomes a no-op; undo applies
    // the prev pose correctly.
    const pivotOriginalParent =
      this._multiSelectPivot?.getOriginalParent(obj) ?? null;
    const heldByPivot = pivotOriginalParent !== null && obj.parent !== pivotOriginalParent;

    if (heldByPivot && pivotOriginalParent) {
      const pivotParent = obj.parent;
      pivotOriginalParent.attach(obj);
      obj.position.set(position[0], position[1], position[2]);
      obj.rotation.set(
        MathUtils.degToRad(rotation[0]),
        MathUtils.degToRad(rotation[1]),
        MathUtils.degToRad(rotation[2]),
      );
      obj.scale.set(scale[0], scale[1], scale[2]);
      pivotParent?.attach(obj);
    } else {
      obj.position.set(position[0], position[1], position[2]);
      obj.rotation.set(
        MathUtils.degToRad(rotation[0]),
        MathUtils.degToRad(rotation[1]),
        MathUtils.degToRad(rotation[2]),
      );
      obj.scale.set(scale[0], scale[1], scale[2]);
    }

    // updateTransform stores position + rotation; scale changes stay on the
    // Three.js node only (the materialised view from ops carries the canonical
    // scale and is re-applied on scene reload).
    this.store.updateTransform(id, position, rotation);
    if (this._viewer) this._viewer.markRenderDirty();
  }

  /**
   * Defensive: traverse the live scene and remove any node carrying a
   * `_layoutId` userData marker. Used by `clearLayout` (and by viewer
   * scene-switch flow) to catch placements that escaped the `_objectMap`
   * tracking — shouldn't happen, but guarantees clean visual state.
   */
  sweepOrphanLayoutObjects(): void {
    if (!this._viewer) return;
    const orphans: Object3D[] = [];
    this._viewer.scene.traverse((node) => {
      // Skip spawned MUs — they carry `_muSelectable` (never `_layoutId`) and
      // are sim-owned; the sweep must never remove them as layout orphans.
      if (node.userData?._muSelectable) return;
      if (node.userData?._layoutId) orphans.push(node);
    });
    for (const o of orphans) o.parent?.remove(o);
  }

  /** Load a layout from a JSON string. Re-places all components. */
  async loadLayout(json: string): Promise<void> {
    const layout = deserializeLayout(json);
    return this.applyPlacements({
      placements: layout.components,
      catalogUrls: layout.catalogUrls,
      gridSizeMm: layout.gridSizeMm,
    });
  }

  /** Toggle the visible 30 m authoring floor. Called by the Scene window
   *  when entering/leaving a layout scene so baked GLBs aren't covered by
   *  the planner's own floor. */
  setLayoutFloorVisible(visible: boolean): void {
    this._layoutFloor.visible = visible;
    if (this._viewer) this._viewer.markRenderDirty();
  }

  /** Resize the visible authoring floor (square, in meters). Default 30 m. */
  setLayoutFloorSize(meters: number): void {
    const m = Math.max(1, meters);
    this._layoutFloor.scale.set(m / 30, m / 30, 1);
    if (this._viewer) this._viewer.markRenderDirty();
  }

  /** Internal: shared restore path for placements (called by both the
   *  legacy applyLayoutFile and the new applyPlacements entry points).
   *
   *  Resolution order per placement:
   *   1. saved glbUrl, IF it's still a stable URL (not blob:)
   *   2. current catalog entry's glbUrl (looked up by catalogId), IF non-blob
   *   3. for `unity-cloud:` assets — re-download fresh via cloud extension
   *   4. anything else (the saved URL even if blob:) — almost certainly fails
   *      and we log a clear warning.
   */
  private async _restorePlacements(snap: PlacementsSnapshot): Promise<void> {
    this._clearPlaced();

    // Add referenced catalogs to the planner — addCatalog is idempotent on
    // the same URL so this is safe even if some are already loaded.
    for (const url of snap.catalogUrls) {
      if (!this.store.getSnapshot().catalogUrls.includes(url)) {
        this.store.addCatalog(url).catch(() => {});
      }
    }

    // Wait for the boot-time catalog load to finish (or fail). After this,
    // per-placement re-resolution has the freshest in-memory catalog state.
    await this._catalogsLoaded;

    // Wait for any in-flight Asset Manager connections too if our placements
    // include cloud assets. The cloud connection populates `assets[]` async
    // after auth + listing complete; without this wait the cloud-download
    // fallback in `_resolvePlacementUrl` returns null on first call.
    const cloud = this._extension?.cloudStore ?? null;
    const hasCloudAssets = snap.placements.some(c => c.catalogId.startsWith('unity-cloud:'));
    if (cloud && hasCloudAssets) {
      await plWaitForCloudReady(cloud);
    }

    // Resolve each placement to its best-available URL. Cloud download
    // is async so this is a sequenced loop, not a map.
    const resolved: { comp: PlacedComponent; url: string | null; isSplat: boolean }[] = [];
    for (const comp of snap.placements) {
      const url = await this._resolvePlacementUrl(comp);
      resolved.push({ comp, url, isSplat: !!comp.splatUrl });
    }

    // Pre-fetch distinct GLBs in parallel (skip splats), then place sequentially
    const distinctGlbUrls = [...new Set(
      resolved
        .filter(r => !r.isSplat && r.url != null)
        .map(r => r.url as string),
    )];
    await Promise.all(distinctGlbUrls.map(url =>
      this._modelCache.getOrLoad(url).catch(() => null),
    ));
    for (const { comp, url, isSplat } of resolved) {
      try {
        // Dedup: SceneStore op replay (loadScene Phase 4) and the planner's
        // own legacy autosave restore (_loadCatalogs) can both run on a
        // single boot. _addPlacedToScene overwrites _objectMap but leaves
        // the prior clone in the scene tree — without this guard the same
        // component would render twice.
        if (this._objectMap.has(comp.id)) continue;
        if (!url) {
          console.warn(
            `[LayoutPlanner] Cannot restore "${comp.label}" (${comp.catalogId}): ` +
            'no source URL could be resolved. ' +
            'Re-add the source catalog (or sign in to Asset Manager) to recover.',
          );
          continue;
        }

        if (isSplat) {
          // Splat placement — load via the splat plugin
          const splatPlugin = await this._viewer!.resolvePlugin('gaussian-splat');
          if (!splatPlugin) {
            console.warn(`[LayoutPlanner] gaussian-splat plugin not available — skipping "${comp.label}"`);
            continue;
          }
          const restoreEntry = this._findCatalogEntryById(comp.catalogId);
          const fileExt = extractSplatFileExt({ localPath: restoreEntry?.localPath, url });
          const container = await (splatPlugin as unknown as import('./gaussian-splat-plugin-type').GaussianSplatPluginApi).loadSplat(url, fileExt);
          this._addSplatPlacedToScene(container, comp.id, comp.label, comp.catalogId, url);
          container.position.set(comp.position[0], comp.position[1], comp.position[2]);
          container.rotation.set(
            MathUtils.degToRad(comp.rotation[0]),
            MathUtils.degToRad(comp.rotation[1]),
            MathUtils.degToRad(comp.rotation[2]),
          );
          container.scale.set(comp.scale[0] || 1, comp.scale[1] || 1, comp.scale[2] || 1);
          if (comp.visible === false) container.visible = false;
          syncLayoutMarkerComponents(container, comp.visible !== false);
          // See note in applyPlacement: replay Splat overrides here too.
          applySplatOverridesFromScene(container, this._viewer!);
          // Broadcast for loose-coupled subscribers (splat plugin) — they
          // need the new position/rotation to sync their off-graph state.
          const restoredAutoPath = this._viewer!.registry?.getPathForNode(container);
          if (restoredAutoPath) {
            this._viewer!.emit('layout-transform-update', {
              path: restoredAutoPath,
              position: comp.position,
              rotation: comp.rotation,
            });
          }
        } else {
          const clone = await this._modelCache.getOrLoad(url);
          this._addPlacedToScene(clone, comp.id, comp.label, comp.catalogId);
          clone.position.set(comp.position[0], comp.position[1], comp.position[2]);
          clone.rotation.set(
            MathUtils.degToRad(comp.rotation[0]),
            MathUtils.degToRad(comp.rotation[1]),
            MathUtils.degToRad(comp.rotation[2]),
          );
          // Restore scale too — without this a scaled GLB placement reverted to
          // 1:1 on reload (the splat branch above and placeFromRecord already do
          // this; this GLB bulk branch silently dropped it).
          clone.scale.set(comp.scale?.[0] || 1, comp.scale?.[1] || 1, comp.scale?.[2] || 1);
          if (comp.visible === false) clone.visible = false;
          syncLayoutMarkerComponents(clone, comp.visible !== false);
          if (url !== comp.glbUrl) {
            this.store.updateGlbUrl(comp.id, url);
          }
        }
      } catch (e) {
        console.warn(`[LayoutPlanner] Failed to restore ${comp.label}: ${e}`);
      }
    }

    this.store.setComponents(snap.placements);
    if (snap.gridSizeMm > 0) this.store.setGridSize(snap.gridSizeMm);

    // All placements are now in the scene with their saved transforms and their
    // snap points re-scanned — reconstruct the snap-point connection graph from
    // geometry so chained assemblies survive reload.
    this._rebuildSnapPairings();

    this.store.autoSave();
    // Hierarchy browser caches the editable-node list; bulk restore mutates
    // the scene without going through any of the per-placement code paths
    // that emit the refresh, so we have to do it ourselves here. Without
    // this, the planner objects render in the 3D view but stay invisible
    // in the hierarchy until any other action triggers a refresh.
    this._refreshHierarchy();
    if (this._viewer) this._viewer.markRenderDirty();
  }

  /** Toggle grid overlay visibility. */
  toggleGrid(): void {
    const next = !this.store.gridEnabled;
    this.store.setGridEnabled(next);
    if (!this._gridHelper && next && this._viewer) {
      this._createGridHelper();
    }
    if (this._gridHelper) {
      this._gridHelper.visible = next && this._active;
    }
    // Update FloorGizmo snap settings immediately so the currently
    // selected object respects the new grid state without re-selecting.
    if (this._transformControls) {
      if (next) {
        this._transformControls.setTranslationSnap(this.store.gridSizeMm / 1000);
        this._transformControls.setRotationSnap(MathUtils.degToRad(this.store.rotationSnapDeg));
      } else {
        this._transformControls.setTranslationSnap(null);
        this._transformControls.setRotationSnap(null);
      }
    }
    if (this._viewer) this._viewer.markRenderDirty();
  }

  /** Update grid size — rebuilds the grid overlay and updates snap settings. */
  setGridSize(mm: number): void {
    this.store.setGridSize(mm);
    // Rebuild grid overlay with new spacing
    if (this._gridHelper) {
      disposeSubtree(this._gridHelper);
      this._gridHelper.removeFromParent();
      this._gridHelper = null;
    }
    if (this.store.gridEnabled && this._viewer) {
      this._createGridHelper();
    }
    // Update snap settings for the FloorGizmo
    if (this._transformControls && this.store.gridEnabled) {
      this._transformControls.setTranslationSnap(mm / 1000);
    }
    if (this._viewer) this._viewer.markRenderDirty();
  }

  /** Update rotation snap step (degrees) and push it to the live gizmo. */
  setRotationSnapDeg(deg: number): void {
    this.store.setRotationSnapDeg(deg);
    if (this._transformControls && this.store.gridEnabled) {
      this._transformControls.setRotationSnap(MathUtils.degToRad(deg));
    }
    if (this._viewer) this._viewer.markRenderDirty();
  }

  /** Fit camera to show all placed objects. */
  fitToLayout(): void {
    if (!this._viewer || this._objectMap.size === 0) return;
    this._viewer.fitToNodes([...this._objectMap.values()]);
  }

  /** Remove all placed components and clear the autosave. */
  clearLayout(): void {
    this._clearPlaced();
    this.store.setComponents([]);
    this.store.autoSave();
    this._refreshHierarchy();
    // Hide the authoring floor when leaving a layout scene (e.g. switching
    // back to a baked GLB). The Scene window calls clearLayout() in that path.
    this.setLayoutFloorVisible(false);
    if (this._viewer) this._viewer.markRenderDirty();
  }

  /**
   * Generate a thumbnail PNG data URL for a catalog entry.
   * Uses the viewer's WebGL renderer with an offscreen target.
   */
  async generateThumbnail(glbUrl: string, size = 256): Promise<string> {
    if (!this._thumbnailRenderer && this._viewer) {
      this._thumbnailRenderer = new ThumbnailRenderer(
        this._viewer.renderer as unknown as WebGLRenderer,
        this._viewer.scene,
      );
    }
    const model = await this._modelCache.getOrLoad(glbUrl);
    return this._thumbnailRenderer!.render(model, size);
  }

  /**
   * Generate and save a thumbnail.
   *
   * - For Local-Folder entries (entry has `localPath`): persists the PNG
   *   into `library/.thumbnails/<mirror-path>.png` inside the user's
   *   working folder via the File System Access API. Survives reloads
   *   and works without any dev server.
   * - Otherwise: posts to the Vite dev-server middleware
   *   (`POST /api/library-thumbnail`) which writes into `public/`.
   *
   * Returns the persisted URL on success, or `null` if only the
   * in-memory data URL could be set.
   */
  async saveThumbnail(entryId: string, glbUrl: string): Promise<string | null> {
    const dataUrl = await this.generateThumbnail(glbUrl);
    // Immediately show the generated thumbnail as data URL — the user
    // gets feedback even if the persistence step fails or is skipped.
    this.store.setEntryThumbnail(entryId, dataUrl);

    // Locate the entry across all catalogs to decide the persistence path.
    let entry: LibraryCatalogEntry | undefined;
    for (const catalog of this.store.getSnapshot().catalogs.values()) {
      const found = catalog.entries.find(e => e.id === entryId);
      if (found) { entry = found; break; }
    }

    // ── Local-folder branch ─────────────────────────────────────────
    if (entry?.localPath) {
      try {
        const root = await getWorkFolder(false);
        if (!root) return null;
        const granted = await requestWriteAccess(root);
        if (!granted) return null;

        const libDir = await root.getDirectoryHandle('library');
        const thumbsDir = await getOrCreateSubfolder(libDir, '.thumbnails');

        // Mirror the source path under .thumbnails/ with .png extension.
        // Ensure parent subfolders exist (e.g. conveyor/).
        const segments = entry.localPath.split('/');
        const fileName = (segments.pop() ?? entry.localPath).replace(/\.(glb|splat|ksplat|ply)$/i, '.png');
        let dir = thumbsDir;
        for (const seg of segments) {
          if (!seg) continue;
          dir = await getOrCreateSubfolder(dir, seg);
        }

        const blob = await (await fetch(dataUrl)).blob();
        await writeBlobFile(dir, fileName, blob);

        // Read back as a fresh blob URL so the UI keeps a stable handle
        // after the data URL is dropped.
        const fileHandle = await dir.getFileHandle(fileName);
        const persistedUrl = await readFileAsUrl(fileHandle);
        this.store.setEntryThumbnail(entryId, persistedUrl);
        return persistedUrl;
      } catch (e) {
        console.warn('[layout-planner] saveThumbnail: local persistence failed', e);
        return null;
      }
    }

    // ── Dev-server fallback (catalog/URL libraries) ────────────────
    try {
      const resp = await fetch('/api/library-thumbnail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ catalogId: entryId, dataUrl }),
      });
      if (resp.ok) {
        const result = await resp.json();
        const savedUrl = result.url ?? null;
        // Update to file URL so it persists after rebuild
        if (savedUrl) this.store.setEntryThumbnail(entryId, savedUrl);
        return savedUrl;
      }
    } catch { /* dev server not available — data URL still shows */ }
    return null;
  }

  // ─── Auto preview generation ────────────────────────────────────

  /**
   * Scan all catalog entries and queue a background preview render for every
   * GLB asset that has no thumbnail yet. Called on model load and on every
   * store change (new library added, GitHub scan completed, …). Cheap and
   * idempotent — entries already seen are skipped. No-op on WebGPU (thumbnail
   * rendering needs the WebGL renderer) — those cards keep the manual button.
   */
  private _enqueueMissingPreviews(): void {
    const viewer = this._viewer;
    if (!viewer || viewer.isWebGPU) return;

    let added = false;
    for (const catalog of this.store.getSnapshot().catalogs.values()) {
      for (const entry of catalog.entries) {
        const glbUrl = entry.glbUrl;
        if (!glbUrl || entry.virtual || entry.splatUrl) continue; // GLB assets only
        if (entry.thumbnailUrl) continue;                          // already has a preview
        if (this._previewSeen.has(entry.id)) continue;             // already queued/done
        this._previewSeen.add(entry.id);
        this.store.setThumbnailPending(entry.id, true);
        this._previewQueue.push(entry.id);
        added = true;
      }
    }
    if (added) void this._drainPreviewQueue();
  }

  /**
   * Process the preview queue one entry per animation frame so the live sim
   * and UI stay responsive. Cache hits skip GLB decode + render entirely.
   */
  private async _drainPreviewQueue(): Promise<void> {
    if (this._previewRunning) return;
    this._previewRunning = true;
    try {
      while (this._previewQueue.length > 0 && this._viewer) {
        const entryId = this._previewQueue.shift()!;
        const glbUrl = this._findEntryGlbUrl(entryId);
        try {
          if (!glbUrl) continue;
          // Persistent cache → instant, no decode/render.
          const cached = await this._thumbCache.get(glbUrl);
          if (!this._viewer) break; // disposed mid-await
          if (cached) {
            this.store.setEntryThumbnail(entryId, cached);
          } else {
            const dataUrl = await this.generateThumbnail(glbUrl);
            if (!this._viewer) break;
            this.store.setEntryThumbnail(entryId, dataUrl);
            // Persist for future sessions (best-effort).
            try {
              const blob = await (await fetch(dataUrl)).blob();
              await this._thumbCache.put(glbUrl, blob);
            } catch { /* cache unavailable — in-memory is enough */ }
          }
        } catch (e) {
          // Leave the thumbnail empty; the card falls back to the manual button.
          console.warn('[layout-planner] auto preview failed for', entryId, e);
        } finally {
          this.store.setThumbnailPending(entryId, false);
        }
        // Yield a frame between renders to avoid jank on large libraries.
        await new Promise<void>(r => requestAnimationFrame(() => r()));
      }
    } finally {
      this._previewRunning = false;
    }
  }

  /** Resolve an entry's glbUrl by id across all catalogs (queue items are ids). */
  private _findEntryGlbUrl(entryId: string): string | undefined {
    for (const catalog of this.store.getSnapshot().catalogs.values()) {
      const found = catalog.entries.find(e => e.id === entryId);
      if (found) return found.glbUrl;
    }
    return undefined;
  }

  // ─── Internal: Selection & Grid ─────────────────────────────────

  /**
   * Select a placed object by its layout id.
   * Routes through the global SelectionManager — the 'selection-changed'
   * subscription (see _onSelectionChanged) handles TransformControls and
   * the LayoutStore.selectedId mirror automatically.
   */
  private _selectObject(id: string | null): void {
    const viewer = this._viewer;
    if (!viewer) return;
    if (!id) {
      viewer.selectionManager.clear();
      return;
    }
    const obj = this._objectMap.get(id);
    if (!obj) return;
    const path = viewer.registry?.getPathForNode(obj);
    if (path) viewer.selectionManager.select(path);
  }

  private _clearPlaced(): void {
    if (this._transformControls) this._transformControls.detach();
    for (const [id] of this._objectMap) {
      this._removePlacedFromScene(id);
    }
    this._objectMap.clear();
    this._refreshHierarchy();
  }

  private _createGridHelper(): void {
    const gridStepM = this.store.gridSizeMm / 1000; // e.g. 0.5 for 500mm
    // Size must be an exact multiple of the grid step so lines land on
    // multiples of gridStepM from the center — matching the checkerboard
    // floor whose tiles are 0.5 m aligned to the floor center.
    const rawSize = 50;
    const size = Math.floor(rawSize / gridStepM) * gridStepM;
    const divisions = Math.round(size / gridStepM);
    this._gridHelper = new GridHelper(size, divisions, 0x444444, 0x333333);
    this._gridHelper.position.y = 0.001;
    // Align grid center with the checkerboard floor center (model bbox center)
    const groundMesh = this._viewer?.groundMesh;
    if (groundMesh) {
      // Snap the ground center to the nearest grid step so lines stay on
      // exact multiples of gridStepM — guaranteeing alignment with the
      // checker tiles (which repeat from the floor center outward).
      this._gridHelper.position.x = Math.round(groundMesh.position.x / gridStepM) * gridStepM;
      this._gridHelper.position.z = Math.round(groundMesh.position.z / gridStepM) * gridStepM;
    }
    this._gridHelper.userData._layoutObject = true;
    // Keep the grid out of SSAO (its lines sit just above the floor and would
    // otherwise cast faint AO halos along every line) while still rendering
    // normally and depth-occluded by placed objects.
    markNoAO(this._gridHelper);
    this._layoutRoot.add(this._gridHelper);
  }

  /** Get the model root (GLB root node) to parent layout objects under. */
  private _getModelRoot(): Object3D | null {
    if (!this._viewer) return null;
    return (this._viewer as unknown as { currentModel: Object3D | null }).currentModel;
  }

  /**
   * Resolve a unique name for a placed object by checking the model root.
   * Delegates to `./scene-mutations.resolveUniqueName`.
   */
  private _resolveUniqueName(clone: Object3D): void {
    smResolveUniqueName(this._sceneMutDeps, clone);
  }

  /**
   * Add a placed layout object to the scene under the model root with full
   * rv-extras processing (signals, drives, components — same pipeline as loadGLB).
   * Delegates to `./scene-mutations.addPlacedToScene`.
   */
  private _addPlacedToScene(clone: Object3D, id: string, label: string, catalogId: string): ProcessExtrasResult | null {
    return smAddPlacedToScene(this._sceneMutDeps, clone, id, label, catalogId);
  }

  /**
   * Snap-aligned placement entry point — used by the SnapPointPickerPopup.
   *
   * Loads the asset via the model cache, then delegates to
   * `./scene-mutations.placeAtSnapPoint` for snap-aligned matrix math + scene
   * insertion. Returns the new placement id, or `null` if placement was
   * rejected (occupied / non-uniform scale / missing snap).
   */
  async placeAtSnap(
    entry: LibraryCatalogEntry,
    target: SnapPoint,
    ownSnapName: string,
  ): Promise<string | null> {
    if (!this._viewer) return null;
    if (!entry.glbUrl) return null;

    const snapPlugin = this._viewer.getPlugin<SnapPointPlugin>('snap-point');
    const snapRegistry = snapPlugin?.getRegistry();
    if (!snapRegistry) return null;
    if (target.occupied) return null;

    const node = await this._modelCache.getOrLoad(entry.glbUrl);
    const id = crypto.randomUUID();

    const result = smPlaceAtSnapPoint(
      this._sceneMutDeps,
      node,
      id,
      entry.name,
      entry.id,
      target,
      ownSnapName,
      snapRegistry,
    );
    if (result === null) return null;

    const comp: PlacedComponent = {
      id,
      catalogId: entry.id,
      glbUrl: entry.glbUrl,
      label: entry.name,
      position: [node.position.x, node.position.y, node.position.z],
      rotation: [
        MathUtils.radToDeg(node.rotation.x),
        MathUtils.radToDeg(node.rotation.y),
        MathUtils.radToDeg(node.rotation.z),
      ],
      scale: [node.scale.x, node.scale.y, node.scale.z],
    };
    this.store.addComponent(comp);
    this.store.autoSave();
    this._refreshHierarchy();

    // Record the placement in the Scene op log so it persists across save /
    // load / scene-switch cycles — the same way `placeComponent` does for
    // the regular drag-from-library path. Without this, snap-picker
    // placements only survive the in-memory store + localStorage autosave
    // and are dropped by the persistent Scene model.
    emitPlannerOp(this._viewer, {
      id: opId(), ts: Date.now(), schemaV: 1,
      kind: 'addPlacement', placement: { ...comp },
    });

    this._viewer.markRenderDirty();
    return id;
  }

  /**
   * Register a splat container (already added to scene by loadSplat()) as a
   * layout object. Delegates to `./scene-mutations.addSplatPlacedToScene`.
   */
  private _addSplatPlacedToScene(container: Object3D, id: string, label: string, catalogId: string, splatUrl: string): void {
    smAddSplatPlacedToScene(this._sceneMutDeps, container, id, label, catalogId, splatUrl);
  }

  /** O(1) lookup: returns the placed-id whose root === `root`, or null. */
  findPlacedIdByRoot(root: Object3D): string | null {
    return this._idByObject.get(root) ?? null;
  }

  /** Walk up from `node` to the nearest placed root and return its id +
   *  root, or null if `node` does not live under any placed asset. */
  findPlacedAncestor(node: Object3D): { id: string; root: Object3D } | null {
    let cur: Object3D | null = node;
    while (cur) {
      const id = this._idByObject.get(cur);
      if (id) return { id, root: cur };
      cur = cur.parent;
    }
    return null;
  }

  /**
   * Reconstruct snap-point connections from geometry after a restore.
   *
   * Restore replays each placement's saved transform but does NOT recreate the
   * runtime snap-registry state (`pairedSnapId` / `occupied`) — so chained
   * assemblies lose their connections on reload (no chain-mode drag, no
   * occupancy, no reverse-direction). Because mated snaps are placed exactly
   * coincident in world space, we pair any two compatible, currently-unoccupied
   * snaps from different owners whose world positions coincide.
   *
   * Safe to call repeatedly: it only adds pairings for unoccupied coincident
   * snaps and never disturbs connections already established live.
   */
  private _rebuildSnapPairings(): void {
    const v = this._viewer;
    if (!v) return;
    const snapPlugin = v.getPlugin<SnapPointPlugin>('snap-point');
    const reg = snapPlugin?.getRegistry();
    if (!reg) return;

    // Some snaps ride on a drive-controlled node (e.g. a turntable's rotating
    // platform `Drive-Rot-Y` owns its connection ports). Two snaps were mated
    // at the drive's HOME pose, so we must sample at that pose — otherwise a
    // rotated/translated drive moves the port far from its (static) partner and
    // the coincidence test fails. Snapshot each drive node, move it to home,
    // sample all snap world positions, then restore.
    const drives = v.drives ?? [];
    const restore: { node: Object3D; pos: Vector3; quat: Quaternion }[] = [];
    for (const d of drives) {
      restore.push({ node: d.node, pos: d.node.position.clone(), quat: d.node.quaternion.clone() });
      d.getHomeLocalPosition(d.node.position);
      d.getHomeLocalQuaternion(d.node.quaternion);
    }
    v.scene.updateMatrixWorld(true);

    const wp = new Vector3();
    const inputs: RebuildSnapInput[] = [];
    for (const sp of reg.getAll()) {
      if (sp.occupied) continue; // keep any pairing already established live
      sp.object3D.getWorldPosition(wp);
      inputs.push({
        id: sp.id, typeId: sp.typeId, flow: sp.flow,
        owner: sp.ownerRoot, x: wp.x, y: wp.y, z: wp.z,
      });
    }

    // Restore the live drive poses before we apply pairings / return.
    for (const r of restore) {
      r.node.position.copy(r.pos);
      r.node.quaternion.copy(r.quat);
    }
    if (restore.length > 0) v.scene.updateMatrixWorld(true);

    if (inputs.length < 2) return;

    const pairs = computeProximityPairings(inputs, SNAP_PAIR_REBUILD_EPS_M);
    for (const { aId, bId } of pairs) {
      const a = reg.getById(aId);
      const b = reg.getById(bId);
      if (!a || !b) continue;
      // Each snap is occupied BY the asset on the OPPOSITE side — mirrors the
      // convention used by placeAtSnapPoint and the magnetic drag controller.
      const aPlaced = (this.findPlacedIdByRoot(a.ownerRoot) ?? `snap:${a.id}`) as PlacedComponentId;
      const bPlaced = (this.findPlacedIdByRoot(b.ownerRoot) ?? `snap:${b.id}`) as PlacedComponentId;
      reg.markOccupied(a.id, bPlaced);
      reg.markOccupied(b.id, aPlaced);
      reg.pair(a.id, b.id);
    }
    if (pairs.length > 0) v.markRenderDirty();
  }

  /**
   * Coalesce snap-pairing rebuilds. Op-replay (redo / multiuser / scene load)
   * adds placements one at a time via `placeFromRecord`; a trailing-edge timer
   * runs a single rebuild once the burst settles and both ends of each
   * connection are present.
   */
  private _scheduleSnapPairingRebuild(): void {
    if (this._pairingRebuildTimer !== null) return;
    this._pairingRebuildTimer = setTimeout(() => {
      this._pairingRebuildTimer = null;
      this._rebuildSnapPairings();
    }, 0);
  }

  /**
   * Reverse a connected placement's direction.
   *
   * Rotates the placed asset 180° around the outward axis of its current
   * snap-point connection. The pivot is the snap world position, so the
   * connection point stays exactly where it is — only the asset's
   * orientation around the connecting axis is flipped (e.g. a conveyor's
   * motor / sensor ends swap sides, but the connector stays mated).
   *
   * No-ops if the asset has no paired snap (= not part of a chain).
   *
   * Used by the Inspector "Reverse direction" button. Chain-mode-aware:
   * a placed asset is its own pivot, downstream chain members do NOT
   * follow (they're independent placements with their own orientations).
   */
  reversePlacement(placedId: string): boolean {
    const v = this._viewer;
    if (!v) return false;
    const obj = this._objectMap.get(placedId);
    if (!obj) return false;
    const snapPlugin = v.getPlugin<SnapPointPlugin>('snap-point');
    const reg = snapPlugin?.getRegistry();
    if (!reg) return false;

    // Find any paired snap owned by this placement — that's the connection
    // axis we rotate around. If multiple pairings exist (e.g. middle module
    // of a 3-member chain), pick the first; the user can chain-reverse the
    // rest individually if needed.
    let pivot: Vector3 | null = null;
    let axis: Vector3 | null = null;
    for (const sp of reg.getAll()) {
      if (sp.ownerRoot !== obj) continue;
      if (!sp.pairedSnapId) continue;
      sp.object3D.updateWorldMatrix(true, false);
      pivot = new Vector3().setFromMatrixPosition(sp.object3D.matrixWorld);
      // Outward axis derived from the snap's local position relative to its
      // asset root — same convention as the alignment math. We need a unit
      // vector along which to perform the 180° spin.
      const tmp = new Vector3().setFromMatrixPosition(sp.object3D.matrixWorld);
      const rootW = new Vector3().setFromMatrixPosition(obj.matrixWorld);
      tmp.sub(rootW);
      // Dominant-axis pick in the asset's own local frame, then transform back to world.
      const rootInvQ = new Quaternion().setFromRotationMatrix(obj.matrixWorld).invert();
      tmp.applyQuaternion(rootInvQ);
      const ax = Math.abs(tmp.x);
      const ay = Math.abs(tmp.y);
      const az = Math.abs(tmp.z);
      const mx = Math.max(ax, ay, az);
      const localOut = new Vector3();
      if (mx < 1e-4) {
        // Fall back to the snap's named axis if position is ambiguous.
        const a = sp.dir.axis;
        localOut.set(a === 'X' ? 1 : 0, a === 'Y' ? 1 : 0, a === 'Z' ? 1 : 0);
      } else if (ax === mx) localOut.set(tmp.x > 0 ? 1 : -1, 0, 0);
      else if (ay === mx) localOut.set(0, tmp.y > 0 ? 1 : -1, 0);
      else localOut.set(0, 0, tmp.z > 0 ? 1 : -1);
      const rootQ = new Quaternion().setFromRotationMatrix(obj.matrixWorld);
      localOut.applyQuaternion(rootQ).normalize();
      axis = localOut;
      break;
    }

    if (!pivot || !axis) return false;

    // Build the rotation: 180° around `axis`, pivoted at `pivot`.
    // result = T2 * spinMat * T1 * M  (apply M, shift pivot to origin, spin, shift back)
    obj.updateMatrixWorld(true);
    const spinQ = new Quaternion().setFromAxisAngle(axis, Math.PI);
    const step = new Matrix4().makeRotationFromQuaternion(spinQ);
    const T1 = new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
    const T2 = new Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z);
    // Build right-to-left, never mutating an existing operand in place.
    const result = new Matrix4()
      .multiplyMatrices(T1, obj.matrixWorld)
      .premultiply(step)
      .premultiply(T2);
    obj.matrixAutoUpdate = false;
    obj.matrix.copy(result);
    result.decompose(obj.position, obj.quaternion, obj.scale);
    obj.matrixAutoUpdate = true;
    obj.updateMatrixWorld(true);

    // Persist the new transform via the same path the gizmo uses on
    // drag-end, so undo / autosave / multi-user sync all stay coherent.
    this._writeSingleTransform(placedId, obj);
    v.markRenderDirty();
    return true;
  }

  /**
   * Remove a placed layout object from the scene with full system cleanup.
   * Delegates to `./scene-mutations.removePlacedFromScene`.
   */
  private _removePlacedFromScene(id: string): void {
    smRemovePlacedFromScene(this._sceneMutDeps, id);
  }

  /** Find a catalog entry by its stable id across all loaded catalogs.
   *  Thin wrapper over `./planner-persistence.findCatalogEntryById`. */
  private _findCatalogEntryById(catalogId: string): LibraryCatalogEntry | null {
    return plFindCatalogEntryById(this.store, catalogId);
  }

  /**
   * Pick the freshest valid glbUrl for a placement during scene restore.
   * Thin wrapper over `./planner-persistence.resolvePlacementUrl`.
   */
  private async _resolvePlacementUrl(comp: PlacedComponent): Promise<string | null> {
    return plResolvePlacementUrl(this.store, this._extension?.cloudStore ?? null, comp);
  }

  /** Notify the extras editor plugin to refresh its hierarchy after layout changes. */
  private _refreshHierarchy(): void {
    if (!this._viewer) return;
    const editor = this._viewer.getPlugin<RvExtrasEditorPlugin>('rv-extras-editor');
    editor?.refreshEditableNodes();
  }

  /** Find the catalog entry for current placementMode. */
  private _getPlacementEntry(): LibraryCatalogEntry | null {
    const snapshot = this.store.getSnapshot();
    if (!snapshot.placementMode) return null;
    for (const [, catalog] of snapshot.catalogs) {
      const entry = catalog.entries.find(e => e.id === snapshot.placementMode);
      if (entry) return entry;
    }
    return null;
  }

  // ─── Internal: Catalog Loading ──────────────────────────────────

  private async _loadCatalogs(): Promise<void> {
    await plLoadBundledLibrary(this.store);

    const constructorUrls = this._options.catalogUrls ?? [];
    const params = new URLSearchParams(window.location.search);
    const paramUrls = params.getAll('library');
    const allUrls = [...new Set([...DEFAULT_LIBRARY_URLS, ...constructorUrls, ...paramUrls])];

    for (const url of allUrls) {
      await this.store.addCatalog(url).catch(() => {});
    }

    await this.store.restoreFromStorage();
    await this.store.restoreLocalFolder();
    this.store.loadAutoSave();

    // Re-place auto-saved components under model root
    const saved = this.store.getSnapshot().placed;
    if (saved.length > 0 && this._viewer) {
      // Wait for AM connections to finish connecting AND loading assets.
      // Only meaningful when a cloud extension is available; public-only
      // builds with cloud-derived layout entries skip those entries below.
      const cloud = this._extension?.cloudStore ?? null;
      const hasAmAssets = saved.some(c => c.catalogId.startsWith('unity-cloud:') && c.glbUrl.startsWith('blob:'));
      if (hasAmAssets && cloud) {
        showInfoOverlay('Waiting for Asset Manager…');
        await plWaitForCloudReady(cloud);
      }

      showInfoOverlay(`Restoring layout (0/${saved.length})…`);
      let restored = 0;

      for (const comp of saved) {
        try {
          // Dedup: if SceneStore op replay (loadScene Phase 4) already
          // placed this component, skip the legacy restore for it. Both
          // paths run on boot — without this the same component renders
          // twice (see applyPlacements for matching guard).
          if (this._objectMap.has(comp.id)) {
            restored++;
            continue;
          }

          // Asset Manager assets have blob: URLs that die on reload.
          // Re-download via the cloud store if the extension is wired.
          const glbUrl = await plRefreshCloudGlbUrl(this.store, cloud, comp, (label) => {
            showInfoOverlay(`${label} (${restored + 1}/${saved.length})`);
          });
          if (glbUrl == null) continue;

          showInfoOverlay(`Restoring ${comp.label}… (${restored + 1}/${saved.length})`);
          const clone = await this._modelCache.getOrLoad(glbUrl);
          this._addPlacedToScene(clone, comp.id, comp.label, comp.catalogId);
          // Restore saved position (including Y), rotation and scale — don't re-drop
          clone.position.set(comp.position[0], comp.position[1], comp.position[2]);
          clone.rotation.set(
            MathUtils.degToRad(comp.rotation[0]),
            MathUtils.degToRad(comp.rotation[1]),
            MathUtils.degToRad(comp.rotation[2]),
          );
          clone.scale.set(comp.scale?.[0] || 1, comp.scale?.[1] || 1, comp.scale?.[2] || 1);
          restored++;
        } catch (e) {
          console.warn(`[LayoutPlanner] Failed to restore component ${comp.label}:`, e);
        }
      }
      this.store.autoSave(); // persist any updated blob URLs
      this._refreshHierarchy();
      this._viewer.markRenderDirty();
      hideInfoOverlay();
    }
  }
}
