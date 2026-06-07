// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Scene mutation primitives for the LayoutPlannerPlugin.
 *
 * Pure module functions that add/remove placed layout objects to/from the
 * live Three.js scene with full rv-extras processing, raycast aux-target
 * registration, drive/transport-component sync, and unique-name resolution.
 *
 * Extracted from `index.ts` (Plan-177 Phase 8) to keep the planner class
 * focused on lifecycle + public API. The functions take an explicit deps
 * bundle so the plugin retains ownership of `_objectMap`, `_idByObject`,
 * `_layoutRoot`, and the active `_transformControls` — no hidden state.
 *
 * Behavior is BIT-FOR-BIT equivalent to the previous private methods; the
 * existing lifecycle and persistence tests cover the integration paths.
 */

import { Mesh } from 'three';
import type { Group, Object3D } from 'three';

import type { RVViewer } from '../../core/rv-viewer';
import { NodeRegistry } from '../../core/engine/rv-node-registry';
import { processExtras, type ProcessExtrasResult } from '../../core/engine/rv-scene-loader';
import { applyShadowFlags } from '../../core/engine/rv-mesh-classifier';
import { scanLibraryComponent } from '../../core/library-component-loader';
import { applyKinematicsSpec } from '../../core/behavior-runtime';
import type { SnapPoint, SnapPointRegistry } from '../../core/engine/rv-snap-point-registry';

import { alignToFloor, pivotToFloorCenter } from './model-cache';
import type { FloorGizmo } from './floor-gizmo';
import type { GaussianSplatPluginApi } from './gaussian-splat-plugin-type';
import { computeSnapAlignedWorldMatrix } from '../snap-point/snap-alignment';
import { parseSnapName } from '../snap-point/snap-name-parser';
import { scanAndRegisterSnaps } from '../snap-point/snap-scanner';
import type { SnapPointPlugin } from '../snap-point';

/** Dependencies needed by the scene-mutation primitives. The planner
 *  passes a stable object whose getters/refs read its own private state,
 *  so mutating `_objectMap` inside these functions mutates the planner.
 *  Live fields (viewer, transformControls) are exposed as getters so the
 *  helpers see the freshest value across the planner's lifecycle. */
export interface SceneMutationDeps {
  /** Live viewer — null only during boot. Same field as `LayoutPlannerPlugin._viewer`. */
  getViewer(): RVViewer | null;
  /** id → root Object3D, mutated by add/remove. */
  readonly objectMap: Map<string, Object3D>;
  /** Reverse lookup, kept in sync with `objectMap`. */
  readonly idByObject: WeakMap<Object3D, string>;
  /** Fallback parent when no GLB model root is available. */
  getLayoutRoot(): Group;
  /** Current FloorGizmo (detached before any removal). */
  getTransformControls(): FloorGizmo | null;
  /** Returns the GLB root node to parent layout objects under, or null. */
  getModelRoot(): Object3D | null;
}

/**
 * Resolve a unique name for a placed object by checking the model root's
 * direct children. Uses the clone's existing name (GLB internal root
 * name). Appends `_2`, `_3`, … only when a name collision exists.
 */
export function resolveUniqueName(deps: SceneMutationDeps, clone: Object3D): void {
  if (!deps.getViewer()?.registry) return;
  const baseName = clone.name;

  const modelRoot = deps.getModelRoot();
  if (!modelRoot) return;

  let suffix = 1;
  let candidate = baseName;
  while (modelRoot.children.some(c => c !== clone && c.name === candidate)) {
    suffix++;
    candidate = `${baseName}_${suffix}`;
  }
  clone.name = candidate;
}

/**
 * Run the naming-convention scanner on a freshly-placed subtree, mirroring
 * what `loadGLB` does for the top-level scene. Without this, library items
 * that rely on `Drive-Lin-*` / `Drive-Rot-*` / `Transport-*` naming get
 * placed as inert meshes — `processExtras` finds nothing in their
 * `userData.realvirtual` because the scanner never ran on the cached clone.
 *
 * Idempotent: deep-merge into existing rv_extras, so a clone that already
 * carries hand-authored extras keeps them.
 */
function _applyNamingConventionScan(clone: Object3D): void {
  const spec = scanLibraryComponent(clone);
  if ((spec.drives?.length ?? 0) > 0 || (spec.transports?.length ?? 0) > 0 || (spec.sensors?.length ?? 0) > 0) {
    applyKinematicsSpec(clone, spec);
  }
}

/**
 * Add a placed layout object to the scene under the model root with full
 * rv-extras processing (signals, drives, components — same pipeline as
 * `loadGLB`). Returns the `ProcessExtrasResult` (or `null` if the viewer
 * isn't fully wired) so callers can react to newly registered drives.
 */
export function addPlacedToScene(
  deps: SceneMutationDeps,
  clone: Object3D,
  id: string,
  label: string,
  catalogId: string,
): ProcessExtrasResult | null {
  // Mark layout metadata — ADD alongside existing rv-extras, don't overwrite
  clone.userData._layoutObject = true;
  clone.userData._layoutId = id;
  if (clone.userData.realvirtual && typeof clone.userData.realvirtual === 'object') {
    (clone.userData.realvirtual as Record<string, unknown>).LayoutObject = { Label: label, CatalogId: catalogId, Locked: false };
  } else {
    clone.userData.realvirtual = { LayoutObject: { Label: label, CatalogId: catalogId, Locked: false } };
  }
  clone.traverse((child) => { child.userData._layoutObject = true; });
  // Cast/receive shadows using the same opaque-vs-transparent policy as the
  // static GLB scene (processMeshes) so placed library objects match it.
  applyShadowFlags(clone);

  // Always center pivot to floor
  pivotToFloorCenter(clone as Group);
  alignToFloor(clone as Group);

  // Add to model root (under the GLB root node)
  const modelRoot = deps.getModelRoot();
  if (modelRoot) {
    modelRoot.add(clone);
  } else {
    deps.getLayoutRoot().add(clone); // fallback if no model loaded
  }

  // NOTE: dropToSurface is NOT called here — it runs at drag-end when the
  // user has finished positioning the object at its final XZ location.
  // Calling it here would raycast at XZ=(0,0) before the position is set.

  // Capture the original GLB root name BEFORE the rename. RVSource's
  // self-template detection compares the authored `ThisObjectAsMU` against this
  // original name — without it the 2nd placement (renamed `Foo_2`) would be
  // mis-classified and resolve its template to the first source's node.
  clone.userData._originalName = clone.name;

  // Resolve unique name (uses GLB root name, adds _2, _3 for dupes)
  resolveUniqueName(deps, clone);

  // Naming-convention scan: inject Drive/TransportSurface rv_extras for
  // nodes whose names follow the standard convention. Mirrors what loadGLB
  // does for the top-level scene; library placements skipped this step
  // before, leaving drives/transports invisible on standard-named assets.
  _applyNamingConventionScan(clone);

  // Process rv-extras: register signals, create drives, instantiate components
  const viewer = deps.getViewer();
  let result: ProcessExtrasResult | null = null;
  if (viewer?.registry && viewer.signalStore && viewer.transportManager) {
    result = processExtras(
      clone,
      viewer.registry,
      viewer.signalStore,
      viewer.transportManager,
      viewer.scene,
      viewer.gizmoManager,
      viewer,
    );

    // Append new drives to viewer and rebuild the grouped BVH so the new
    // placement participates in fast hover/click (debounced to coalesce
    // multiple synchronous adds).
    if (result.drives.length > 0) {
      viewer.drives.push(...result.drives);
      viewer.rebuildGroupedBvh();
    }

    // Dispatch any behavior file matching this placed library asset, scoped to
    // its subtree (matched by the asset's GLB root name). Runs after components
    // are constructed + drives registered, so rv.drives.get() resolves them.
    viewer.behaviors?.dispatchPlaced(clone);
  } else {
    // Fallback: just register root node in registry
    if (viewer?.registry) {
      const path = NodeRegistry.computeNodePath(clone);
      viewer.registry.registerNode(path, clone);
    }
  }

  deps.objectMap.set(id, clone);
  deps.idByObject.set(clone, id);

  // Register every Mesh in the placed subtree as an auxiliary raycast target,
  // resolving back to the layout root. The standard raycast pipeline uses
  // pre-built BVH groups for the originally loaded model — placed objects
  // aren't in those groups, so without aux targets they would not be hittable
  // (no hover, no click selection). Aux targets bypass BVH and are added
  // directly to the raycast intersection list.
  if (viewer?.raycastManager) {
    const rm = viewer.raycastManager;
    clone.traverse((node) => {
      if ((node as Mesh).isMesh && !node.userData?._highlightOverlay && !node.userData?._isGhostOverlay) {
        rm.addAuxRaycastTarget(node, clone);
      }
    });
  }

  // Register the placed asset's Snap-<DIR>-<TYPEID> nodes with the snap-point
  // registry so they show markers and can be used as attachment targets for
  // subsequent placements (chaining). Also resize the marker InstancedMesh so
  // the newly registered points become visible. Silently no-ops if the snap
  // plugin isn't installed.
  if (viewer) {
    const snapPlugin = viewer.getPlugin<SnapPointPlugin>('snap-point');
    const snapRegistry = snapPlugin?.getRegistry();
    if (snapRegistry) {
      scanAndRegisterSnaps(clone, snapRegistry, clone);
      snapPlugin?.getMarkerRenderer?.()?.rebuild(snapRegistry.size);
    }
  }

  // The shadow map runs with autoUpdate=false and only rebuilds when dirtied.
  // Dirty it once so the newly placed object's shadow appears immediately.
  viewer?.markShadowsDirty?.();

  return result;
}

/**
 * Register a splat container (already added to scene by `loadSplat()`) as a
 * layout object. No `pivotToFloorCenter` / `alignToFloor` — splats have
 * their own coordinate system.
 */
export function addSplatPlacedToScene(
  deps: SceneMutationDeps,
  container: Object3D,
  id: string,
  label: string,
  catalogId: string,
  splatUrl: string,
): void {
  container.userData._layoutObject = true;
  container.userData._layoutId = id;
  container.userData._isSplat = true;
  container.userData._splatUrl = splatUrl;
  container.userData.realvirtual = { LayoutObject: { Label: label, CatalogId: catalogId, Locked: false } };
  container.name = label;

  deps.objectMap.set(id, container);
  deps.idByObject.set(container, id);

  // Register in NodeRegistry so it appears in the hierarchy
  const viewer = deps.getViewer();
  if (viewer?.registry) {
    const path = NodeRegistry.computeNodePath(container);
    viewer.registry.registerNode(path, container);
  }
}

/**
 * Snap-aligned placement primitive.
 *
 * Computes the world matrix that lands `ownSnap` exactly on `target`, applies
 * it to `clone`, runs the full `addPlacedToScene` pipeline, marks the target
 * occupied, and scans the newly-placed asset's hierarchy for new snap points
 * (enabling chained assembly).
 *
 * Returns `null` if validation fails (occupied / non-uniform scale / missing
 * snap inside the asset).
 */
export function placeAtSnapPoint(
  deps: SceneMutationDeps,
  clone: Object3D,
  id: string,
  label: string,
  catalogId: string,
  target: SnapPoint,
  ownSnapName: string,
  snapRegistry: SnapPointRegistry,
): ProcessExtrasResult | null {
  // Pre-flight: target not occupied
  if (target.occupied) return null;

  // Uniform-scale check (matches SnapPlacementService.canPlace).
  const s = clone.scale;
  const eps = 1e-4;
  if (
    Math.abs(s.x - s.y) > eps ||
    Math.abs(s.x - s.z) > eps ||
    Math.abs(s.y - s.z) > eps
  ) {
    return null;
  }

  // Find the named snap inside the asset
  let ownSnap: Object3D | null = null;
  clone.traverse((n) => {
    if (!ownSnap && n.name === ownSnapName) ownSnap = n;
  });
  if (!ownSnap) return null;

  // Compute alignment BEFORE adding to scene so existing world matrices are
  // taken from the clone's pre-place transform. Parse the own snap's name to
  // get its outward direction — the alignment math needs both to compute the
  // swing rotation that aligns outward axes anti-parallel (handles same-axis
  // chains AND cross-axis attachments).
  clone.updateMatrixWorld(true);
  const parsedOwn = parseSnapName((ownSnap as Object3D).name);
  const M = computeSnapAlignedWorldMatrix(
    target.object3D,
    clone,
    ownSnap,
    target.dir,
    parsedOwn?.dir,
  );
  // Apply
  clone.matrixAutoUpdate = false;
  clone.matrix.copy(M);
  M.decompose(clone.position, clone.quaternion, clone.scale);
  clone.matrixAutoUpdate = true;
  clone.updateMatrixWorld(true);

  // Add to scene under the layout root using the standard pipeline.
  // Note: addPlacedToScene calls pivotToFloorCenter + alignToFloor which would
  // override our snap-aligned matrix. Replicate the essential parts inline.
  clone.userData._layoutObject = true;
  clone.userData._layoutId = id;
  if (clone.userData.realvirtual && typeof clone.userData.realvirtual === 'object') {
    (clone.userData.realvirtual as Record<string, unknown>).LayoutObject = {
      Label: label, CatalogId: catalogId, Locked: false,
    };
  } else {
    clone.userData.realvirtual = {
      LayoutObject: { Label: label, CatalogId: catalogId, Locked: false },
    };
  }
  clone.traverse((child) => { child.userData._layoutObject = true; });
  // Cast/receive shadows using the same policy as the static scene (see
  // addPlacedToScene).
  applyShadowFlags(clone);

  // Attach to layout/model root preserving world transform
  const modelRoot = deps.getModelRoot();
  const targetParent = modelRoot ?? deps.getLayoutRoot();
  targetParent.attach(clone);

  // Capture original GLB root name before rename (see addPlacedToScene).
  clone.userData._originalName = clone.name;

  resolveUniqueName(deps, clone);

  // Naming-convention scan (see _applyNamingConventionScan docstring).
  _applyNamingConventionScan(clone);

  // Process rv-extras (signals, drives, components)
  const viewer = deps.getViewer();
  let result: ProcessExtrasResult | null = null;
  if (viewer?.registry && viewer.signalStore && viewer.transportManager) {
    result = processExtras(
      clone,
      viewer.registry,
      viewer.signalStore,
      viewer.transportManager,
      viewer.scene,
      viewer.gizmoManager,
      viewer,
    );
    if (result.drives.length > 0) {
      viewer.drives.push(...result.drives);
      viewer.rebuildGroupedBvh();
    }
    // Dispatch behaviors for this placement — mirrors addPlacedToScene. Without
    // this, an asset that snaps to a neighbour during drag never binds its
    // behaviors (only the floor-dropped first placement did), so a 2nd / 3rd
    // conveyor in a snapped line had no Conveyor.* signals and no belt control.
    viewer.behaviors?.dispatchPlaced(clone);
  } else if (viewer?.registry) {
    const path = NodeRegistry.computeNodePath(clone);
    viewer.registry.registerNode(path, clone);
  }

  deps.objectMap.set(id, clone);
  deps.idByObject.set(clone, id);

  // Register clone meshes as aux raycast targets (so they're hittable for selection)
  if (viewer?.raycastManager) {
    const rm = viewer.raycastManager;
    clone.traverse((node) => {
      if ((node as Mesh).isMesh && !node.userData?._highlightOverlay && !node.userData?._isGhostOverlay) {
        rm.addAuxRaycastTarget(node, clone);
      }
    });
  }

  // Mark target occupied; scan new asset for snaps (Kettenbau).
  snapRegistry.markOccupied(target.id, id);
  const placedSnaps = scanAndRegisterSnaps(clone, snapRegistry, clone);
  // The own snap that was paired with `target` is now also occupied. Locate
  // it by name (the picker passed `ownSnapName`) and establish the
  // bidirectional pairing so chain-resolver walks across this edge.
  const ownSnapReg = placedSnaps.find((s) => s.object3D.name === ownSnapName);
  if (ownSnapReg) {
    snapRegistry.markOccupied(ownSnapReg.id, target.occupiedBy ?? id);
    snapRegistry.pair(target.id, ownSnapReg.id);
  }
  // Resize marker InstancedMesh so the newly registered snap points actually
  // get a marker slot allocated.
  if (viewer) {
    const snapPlugin = viewer.getPlugin<SnapPointPlugin>('snap-point');
    snapPlugin?.getMarkerRenderer?.()?.rebuild(snapRegistry.size);
  }

  // Dirty the shadow map so the snapped object's shadow appears immediately
  // (shadowMap.autoUpdate is off — see addPlacedToScene).
  viewer?.markShadowsDirty?.();

  return result;
}

/** Remove a placed layout object from the scene with full system cleanup. */
export function removePlacedFromScene(deps: SceneMutationDeps, id: string): void {
  const obj = deps.objectMap.get(id);
  if (!obj) return;

  const gizmo = deps.getTransformControls();
  if (gizmo) gizmo.detach();

  const viewer = deps.getViewer();

  // Dispose any behavior bound to this placed object (mirrors dispatchPlaced).
  viewer?.behaviors?.disposeObject(obj);

  // Unregister auxiliary raycast targets we added in addPlacedToScene.
  if (viewer?.raycastManager) {
    const rm = viewer.raycastManager;
    obj.traverse((node) => {
      if ((node as Mesh).isMesh) rm.removeAuxRaycastTarget(node);
    });
  }

  // Capture the root path BEFORE unregistration so the overlay purge below
  // can find sub-path overlay entries to clean up.
  const rootPathBeforeUnregister = viewer?.registry?.getPathForNode(obj) ?? null;

  // Unregister subtree from NodeRegistry and collect removed paths
  if (viewer?.registry) {
    const removedPaths = viewer.registry.unregisterSubtree(obj);

    // Filter removed drives out of viewer.drives
    if (viewer.drives.length > 0 && removedPaths.size > 0) {
      const before = viewer.drives.length;
      viewer.drives = viewer.drives.filter(d => {
        const dPath = viewer.registry!.getPathForNode(d.node);
        // If path is null, the node was already unregistered → it's a removed drive
        return dPath !== null;
      });
      // Rebuild the grouped BVH so the removed drives no longer participate
      // (debounced to coalesce multiple synchronous removes).
      if (viewer.drives.length !== before) {
        viewer.rebuildGroupedBvh();
      }
    }

    // Filter removed components from transport manager
    if (viewer.transportManager && removedPaths.size > 0) {
      const tm = viewer.transportManager;
      const isRemoved = (component: { node: Object3D }) => {
        const p = NodeRegistry.computeNodePath(component.node);
        return removedPaths.has(p);
      };
      tm.sensors = tm.sensors.filter(s => !isRemoved(s));
      tm.surfaces = tm.surfaces.filter(s => !isRemoved(s));
      // Dispose removed sources so their ghost materials are freed.
      for (const s of tm.sources) { if (isRemoved(s)) s.dispose?.(); }
      tm.sources = tm.sources.filter(s => !isRemoved(s));
      tm.sinks = tm.sinks.filter(s => !isRemoved(s));
      tm.grips = tm.grips.filter(s => !isRemoved(s));
      tm.gripTargets = tm.gripTargets.filter(s => !isRemoved(s));
    }
  }

  // Splat placements: dispose via the splat plugin (handles GPU cleanup)
  if (obj.userData._isSplat && viewer) {
    const splatPlugin = viewer.getPlugin?.('gaussian-splat') as
      GaussianSplatPluginApi | undefined;
    if (splatPlugin) {
      splatPlugin.disposeSplat(obj as Group);
    } else {
      // Fallback: remove from scene directly
      if (obj.parent) obj.parent.remove(obj);
    }
  } else {
    // Remove from scene — do NOT dispose geometry/materials here because
    // clones share BufferGeometry/Material references with the ModelCache
    // master. Disposing them would corrupt the cache and all other clones.
    // GPU cleanup happens in ModelCache.dispose() when the plugin unloads.
    if (obj.parent) obj.parent.remove(obj);
  }

  // Unregister snap-points carried by the removed subtree and free the
  // marker slot. Also clear `occupied` on the snap this object was attached
  // to (if any), so the spot can be reused by a fresh placement.
  if (viewer) {
    const snapPlugin = viewer.getPlugin<SnapPointPlugin>('snap-point');
    const snapRegistry = snapPlugin?.getRegistry();
    if (snapRegistry) {
      snapRegistry.unregisterUnder(obj);
      // Free any snap that this placement occupied (look up by placed id).
      for (const sp of snapRegistry.getAll()) {
        if (sp.occupiedBy === id) snapRegistry.markFree(sp.id);
      }
      snapPlugin?.getMarkerRenderer?.()?.rebuild(snapRegistry.size);
    }
  }

  // Op-log cleanup for sub-path overlays. Re-placing a catalog item with the
  // same root name must not inherit the previous instance's overlay state for
  // nested drives/sensors. Best-effort: silently no-op if the editor plugin
  // isn't installed.
  if (viewer && rootPathBeforeUnregister) {
    const editor = viewer.getPlugin?.('rv-extras-editor') as unknown as
      | { purgeOverlaysForSubtree?: (prefix: string) => number }
      | undefined;
    editor?.purgeOverlaysForSubtree?.(rootPathBeforeUnregister);
  }

  deps.objectMap.delete(id);
  deps.idByObject.delete(obj);
}
