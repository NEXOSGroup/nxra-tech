// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Model loading, caching, and GLB post-processing helpers for the Layout Planner.
 *
 * - ModelCache: loads + caches GLB models, returns clones
 * - unwrapGltfRoot: strips UnityGLTF `__root__` wrapper nodes
 * - pivotToFloorCenter: recalculates pivot to bottom-center of full AABB
 * - alignToFloor: shifts a group so its bounding box bottom sits at Y=0
 */

import {
  Group,
  Mesh,
  Vector3,
  Box3,
  Raycaster,
  Camera,
  Light,
} from 'three';
import type { Object3D, Scene } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { disposeSubtree } from './three-utils';
import { RVAssetBlobCache } from '../../core/engine/rv-asset-blob-cache';

// ─── GLB Wrapper Removal ────────────────────────────────────────────────

/** Names of non-content nodes created by UnityGLTF that should be stripped. */
const WRAPPER_NAMES = new Set(['__root__']);
const STRIP_NAMES = new Set(['default camera', 'hdrskybox', 'hdrSkyBox']);

/**
 * Detects names that are scene-container metadata rather than content.
 * Matches UnityGLTF's `__root__` wrapper plus any name that ends in `.glb`
 * (or `glb` after Three.js sanitization) — UnityGLTF sets `scenes[0].name`
 * to the export filename, so the gltf.scene Three.js Group ends up with a
 * filename-based wrapper name like `EuropalletEmpty.glb` / `EuropalletEmptyglb`.
 * Those wrappers exist only because gltf-format requires a scene, but they
 * carry no semantic meaning and should be peeled off before the content
 * node is registered as a library/layout object.
 */
function isWrapperName(name: string): boolean {
  if (!name) return true;
  if (WRAPPER_NAMES.has(name)) return true;
  return /\.?glb$/i.test(name);
}

/**
 * Unwrap the `__root__` wrapper node created by UnityGLTF and strip
 * non-content children (default camera, hdrSkyBox, lights, cameras).
 * Returns the actual content node as the new root Group.
 *
 * Also peels off the gltf.scene wrapper that Three.js gives the filename-
 * based name (e.g. `EuropalletEmpty.glb`) when there's exactly one
 * content child — otherwise the library asset would appear inside a
 * filename-shaped LayoutObject instead of being one itself.
 */
export function unwrapGltfRoot(root: Group): Group {
  let node: Group = root;

  // Walk through single-child wrappers
  while (
    isWrapperName(node.name) ||
    (node.children.length <= 3 && !hasContentChildren(node))
  ) {
    const contentChildren = node.children.filter(c => isContentNode(c));
    // Descend into a single non-mesh content child. Three.js GLTFLoader
    // creates plain Object3D (not Group) for empty container nodes, so we
    // can't gate this on `instanceof Group` — we just need a node that
    // could carry children (anything that isn't a leaf Mesh).
    if (contentChildren.length === 1 && !(contentChildren[0] as Mesh).isMesh) {
      node = contentChildren[0] as Group;
    } else if (contentChildren.length > 0) {
      // Multiple content children — keep this node but strip non-content
      stripNonContent(node);
      return node;
    } else {
      break;
    }
  }

  stripNonContent(node);
  return node;
}

function isContentNode(obj: Object3D): boolean {
  const name = obj.name.toLowerCase();
  if (STRIP_NAMES.has(name) || STRIP_NAMES.has(obj.name)) return false;
  if ((obj as unknown as Camera).isCamera) return false;
  if ((obj as unknown as Light).isLight) return false;
  return true;
}

function hasContentChildren(group: Group): boolean {
  return group.children.some(c => isContentNode(c) && ((c as Mesh).isMesh || c.children.length > 0));
}

function stripNonContent(group: Group): void {
  const toRemove = group.children.filter(c => !isContentNode(c));
  for (const child of toRemove) {
    group.remove(child);
  }
}

// ─── Pivot to Floor ─────────────────────────────────────────────────────

const _pivotBox = new Box3();
const _pivotCenter = new Vector3();
const _pivotWorld = new Vector3();
const _pivotOrigPos = new Vector3();

/** Marker component name written by the Unity WebPivot MonoBehaviour into
 *  rv_extras. Presence of this key on any descendant signals an explicit,
 *  hand-authored pivot point that overrides the auto AABB pivot. */
const WEB_PIVOT_KEY = 'WebPivot';

/**
 * Find the first descendant whose rv_extras carries a WebPivot marker.
 * Walks the subtree depth-first and stops at the first match — multiple
 * markers per library object are not supported and the first wins.
 */
function findWebPivotMarker(root: Object3D): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((node) => {
    if (found) return;
    const rv = (node.userData as { realvirtual?: Record<string, unknown> } | undefined)?.realvirtual;
    if (rv && rv[WEB_PIVOT_KEY]) found = node;
  });
  return found;
}

/**
 * Recalculate pivot so the local origin lands at either:
 *   1. an explicit Unity-authored WebPivot marker child (if present), or
 *   2. the bottom-center of the model's full axis-aligned bounding box.
 *
 * WebPivot path: the marker's world position is taken as the new origin —
 * both XZ and Y come from the marker. Use this when a library object needs
 * its rotation/snap origin somewhere other than the AABB floor-center
 * (e.g. a robot mounted on a wall, a fixture with an off-center base).
 *
 * AABB path: XZ = AABB centroid, Y = AABB.min.y. Predictable and explicit;
 * asymmetric models (robot with long arm overhang, L-shaped fixture) get a
 * pivot at the AABB centroid above the floor — that's the documented
 * fallback. Callers that need a contact-footprint pivot should provide a
 * WebPivot marker instead.
 *
 * In both cases every direct child of `obj` is shifted by the negative
 * offset so the visual position of the geometry is unchanged.
 */
export function pivotToFloorCenter(obj: Group): void {
  // We compute everything in obj's LOCAL space so the offsets we add to
  // child.position (which are local-space values) line up with the AABB
  // that Three.js' setFromObject reports (which is world-space). To bridge
  // the two, temporarily neutralize obj's own transform — then world-space
  // coordinates _are_ obj's local-space coordinates. Without this step,
  // any non-zero obj.position would offset the gizmo from the mesh by
  // exactly obj.position (Unity-authored library objects whose root sat at
  // a non-origin position are the typical trigger).
  _pivotOrigPos.copy(obj.position);
  const origRotX = obj.rotation.x;
  const origRotY = obj.rotation.y;
  const origRotZ = obj.rotation.z;
  obj.position.set(0, 0, 0);
  obj.rotation.set(0, 0, 0);
  obj.updateMatrixWorld(true);

  const marker = findWebPivotMarker(obj);
  let offsetX: number;
  let offsetY: number;
  let offsetZ: number;

  if (marker) {
    // WebPivot wins. With obj reset to identity, the marker's world position
    // _is_ its position in obj's local space — which is exactly the value
    // we need to subtract from every direct child.
    marker.getWorldPosition(_pivotWorld);
    offsetX = -_pivotWorld.x;
    offsetY = -_pivotWorld.y;
    offsetZ = -_pivotWorld.z;
  } else {
    _pivotBox.setFromObject(obj);
    if (_pivotBox.isEmpty()) {
      obj.position.copy(_pivotOrigPos);
      obj.rotation.set(origRotX, origRotY, origRotZ);
      return;
    }
    _pivotBox.getCenter(_pivotCenter);
    offsetX = -_pivotCenter.x;
    offsetZ = -_pivotCenter.z;
    offsetY = -_pivotBox.min.y;
  }

  for (const child of obj.children) {
    child.position.x += offsetX;
    child.position.y += offsetY;
    child.position.z += offsetZ;
  }

  obj.position.copy(_pivotOrigPos);
  obj.rotation.set(origRotX, origRotY, origRotZ);
}

// ─── Align to Floor ─────────────────────────────────────────────────────

const _alignBox = new Box3();

/** Shift group so its bounding box bottom sits at Y=0. */
export function alignToFloor(obj: Group): void {
  _alignBox.setFromObject(obj);
  if (_alignBox.isEmpty()) return;
  obj.position.y -= _alignBox.min.y;
}

// ─── Drop to Surface ───────────────────────────────────────────────────

const _dropBox = new Box3();
const _dropOrigin = new Vector3();
const _dropDir = new Vector3(0, -1, 0);
const _dropRaycaster = new Raycaster();

/**
 * Build the list of meshes a `dropToSurface` raycast should consider — every
 * visible scene mesh except `selfObj`'s own descendants and infrastructure
 * (ghosts, gizmos, layout floor, ground plane, highlight/ghost overlays).
 *
 * Exposed as a separate helper so callers can cache the result across many
 * raycasts of the SAME object — e.g. live drop-to-surface during a drag,
 * where the scene composition doesn't change between pointermove frames.
 * The `scene.traverse` is the expensive part of `dropToSurface`; caching
 * cuts a per-frame O(scene-mesh-count) walk down to a single raycast.
 */
export function collectDropTargets(scene: Scene, selfObj: Object3D): Mesh[] {
  const selfMeshes = new Set<Object3D>();
  selfObj.traverse((child) => { selfMeshes.add(child); });

  const targets: Mesh[] = [];
  scene.traverse((child) => {
    if (!(child as Mesh).isMesh) return;
    if (selfMeshes.has(child)) return;
    if (!child.visible) return;
    if (child.userData._isGhost) return;
    if (child.userData._isSourceGhost) return; // source preview ghost — not a drop surface
    if (child.userData._isSourcePreview) return; // source showcase instance — not a drop surface
    if (child.userData._layoutFloor) return;
    if (child.userData._rvGizmo || hasAncestorTag(child, '_rvGizmo')) return;
    if (child.userData._rvGizmoOverlay) return;
    if (child.userData._highlightOverlay) return;
    if (child.userData._isGhostOverlay) return;
    if (child.userData._rvGroundPlane || hasAncestorTag(child, '_rvGroundPlane')) return;
    // FloorGizmo: walk ancestors. The gizmo's hidden Y-axis bars sit inside
    // a Group with visible=false, but Three.js's per-mesh raycast only checks
    // the mesh's own visibility, so the seg meshes still get hit. Match the
    // gizmo root by name to exclude every descendant in one check.
    if (hasAncestorNamed(child, '_floorGizmo')) return;
    targets.push(child as Mesh);
  });
  return targets;
}

/**
 * Raycast downward to find the highest surface below the object's XZ footprint
 * and place its bounding box bottom on that surface. Falls back to Y=0 (floor)
 * if no elevated surface is hit.
 *
 * @param obj      The placed object (must already be in the scene).
 * @param scene    The Three.js scene to raycast against.
 * @param targets  Optional pre-computed candidate-mesh list (see
 *                 `collectDropTargets`). When omitted, this function
 *                 traverses the scene itself — the expected cost on
 *                 single one-shot drops at drag-end. Pass a cached list
 *                 for live drop during a drag (60 Hz).
 * @returns        The surface Y the object was placed on (0 if floor).
 */
export function dropToSurface(obj: Object3D, scene: Scene, targets?: Mesh[]): number {
  scene.updateMatrixWorld(true);
  _dropBox.setFromObject(obj);
  if (_dropBox.isEmpty()) return 0;

  // Offset from obj.position.y to the bounding box bottom — we preserve this
  // so the pivot stays correct regardless of where the object's local origin is.
  // ASSUMPTION: obj.parent is at world identity (no scaling, no Y offset). True
  // for single-select planner placements parented to layoutRoot / modelRoot.
  // Multi-select members are temporarily under a centroid pivot Group — callers
  // should NOT invoke this from inside a multi-select drag.
  const pivotToBottom = obj.position.y - _dropBox.min.y;

  const candidates = targets ?? collectDropTargets(scene, obj);

  if (candidates.length === 0) {
    obj.position.y = pivotToBottom;
    return 0;
  }

  // Cast a single downward ray from the bbox XZ center
  const cx = (_dropBox.min.x + _dropBox.max.x) / 2;
  const cz = (_dropBox.min.z + _dropBox.max.z) / 2;
  const castY = 50; // well above any scene content
  _dropRaycaster.far = 100;
  _dropOrigin.set(cx, castY, cz);
  _dropRaycaster.set(_dropOrigin, _dropDir);

  const hits = _dropRaycaster.intersectObjects(candidates, false);
  if (hits.length > 0) {
    const surfaceY = hits[0].point.y;
    if (surfaceY > 0.01) {
      obj.position.y = surfaceY + pivotToBottom;
      return surfaceY;
    }
  }

  // No elevated surface — place on floor (Y=0)
  obj.position.y = pivotToBottom;
  return 0;
}

/**
 * Drop a multi-select PIVOT Group to the surface below.
 *
 * Companion to {@link dropToSurface} for the centroid pivot built by
 * MultiSelectPivot during multi-object drags. Key differences:
 *
 *   - **Cast XZ:** the pivot's CURRENT world XZ (= the transform gizmo's
 *     position). The bbox center would be wrong for asymmetric selections
 *     (e.g. one big + one small object), because the user reads the gizmo,
 *     not the bbox.
 *   - **Adjust target:** shifts `pivot.position.y` by the delta required to
 *     put the UNION AABB bottom on the surface. Members move rigidly as
 *     the pivot's children, so relative Y offsets between selected objects
 *     are preserved.
 *
 * @param pivot    The selection pivot Group (members live as its children).
 * @param scene    The Three.js scene to raycast against.
 * @param targets  Optional pre-computed candidate-mesh list (see
 *                 {@link collectDropTargets}). Pass a cached list for live
 *                 drop during a drag (60 Hz).
 * @returns        The surface Y the selection was placed on (0 if floor).
 */
export function dropPivotToSurface(
  pivot: Object3D,
  scene: Scene,
  targets?: Mesh[],
): number {
  scene.updateMatrixWorld(true);
  _dropBox.setFromObject(pivot);
  if (_dropBox.isEmpty()) return 0;

  const candidates = targets ?? collectDropTargets(scene, pivot);

  // Cast from the pivot's WORLD XZ — that's exactly where the user sees
  // the gizmo. The pivot is always parented to the scene root, so world
  // XZ equals local XZ; getWorldPosition is the defensive choice.
  pivot.getWorldPosition(_dropOrigin);
  const castX = _dropOrigin.x;
  const castZ = _dropOrigin.z;

  let surfaceY = 0;
  if (candidates.length > 0) {
    const castUp = 50; // well above any scene content
    _dropRaycaster.far = 100;
    _dropOrigin.set(castX, castUp, castZ);
    _dropRaycaster.set(_dropOrigin, _dropDir);
    const hits = _dropRaycaster.intersectObjects(candidates, false);
    if (hits.length > 0 && hits[0].point.y > 0.01) {
      surfaceY = hits[0].point.y;
    }
  }

  // delta = where the union-bbox bottom should land minus where it is now.
  // Apply to pivot.position.y so every child member shifts rigidly.
  pivot.position.y += surfaceY - _dropBox.min.y;
  return surfaceY;
}

/** Check if `child` is a descendant of `ancestor` (or is `ancestor` itself). */
function isDescendantOf(child: Object3D, ancestor: Object3D): boolean {
  let cur: Object3D | null = child;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

/** Check if any ancestor (including self) has the given userData tag set to truthy. */
function hasAncestorTag(obj: Object3D, tag: string): boolean {
  let cur: Object3D | null = obj.parent;
  while (cur) {
    if (cur.userData[tag]) return true;
    cur = cur.parent;
  }
  return false;
}

/** Check if `obj` itself or any ancestor has the given name. */
function hasAncestorNamed(obj: Object3D, name: string): boolean {
  let cur: Object3D | null = obj;
  while (cur) {
    if (cur.name === name) return true;
    cur = cur.parent;
  }
  return false;
}

// ─── Model Cache ────────────────────────────────────────────────────────

/** Cache API bucket for all planner GLBs (catalog, GitHub, AM). */
const GLB_CACHE_BUCKET = 'rv-planner-glbs';

/** Shared blob cache singleton — also exposed for tooling that needs to wipe it. */
const _glbBlobCache = new RVAssetBlobCache({ bucket: GLB_CACHE_BUCKET });

export class ModelCache {
  /** Decoded Three.js Group cache — clones are returned to callers. */
  private _decoded = new Map<string, Group>();
  private _loader: GLTFLoader;

  constructor(loader: GLTFLoader) {
    this._loader = loader;
  }

  /** Get a clone of the cached model, loading it first if needed. */
  async getOrLoad(url: string): Promise<Group> {
    const cached = this._decoded.get(url);
    if (cached) return cached.clone();

    // Resolve bytes via the generic blob cache (in-memory + Cache API).
    // For blob: URLs the cache pass-throughs so the GLTFLoader can read
    // them directly without an extra fetch hop.
    const loadUrl = url.startsWith('blob:')
      ? url
      : await _glbBlobCache.getObjectUrl(url);

    try {
      const gltf = await this._loader.loadAsync(loadUrl);
      let source = gltf.scene as Group;
      // Strip UnityGLTF __root__ wrapper and non-content nodes
      source = unwrapGltfRoot(source);
      this._decoded.set(url, source);
      return source.clone();
    } finally {
      if (loadUrl !== url) URL.revokeObjectURL(loadUrl);
    }
  }

  get size(): number { return this._decoded.size; }

  /** Clear the persistent browser cache for all planner GLBs. */
  static async clearPersistentCache(): Promise<void> {
    await _glbBlobCache.clearPersistent();
  }

  dispose(): void {
    for (const [, model] of this._decoded) {
      disposeSubtree(model);
    }
    this._decoded.clear();
  }
}
