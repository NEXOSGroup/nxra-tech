// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Object3D, Vector3, Quaternion, MeshBasicMaterial, type Material, type Mesh, type Sprite, type Texture } from 'three';
import {
  RVMovingUnit, InstancedMovingUnit, MUInstancePool,
  computeTemplateAABBInfo, analyzeTemplate,
} from './rv-mu';
import type { IMUAccessor } from './rv-mu';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent } from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';
import { debug } from './rv-debug';
import { MM_TO_METERS } from './rv-constants';
import { buildSourceMarker } from './rv-source-marker';

// Pre-allocated temp vectors (no GC in hot path)
const _sourcePos = new Vector3();
const _lastMUPos = new Vector3();
const _identityQuat = new Quaternion();

/**
 * Strip authored component / layout metadata from a cloned subtree so it can
 * never be re-instantiated as a live component (Source, Drive, …) or treated
 * as a selectable Layout-Planner object.
 *
 * Three.js `Object3D.clone()` deep-copies `userData`, so the source's ghost,
 * held preview, and every spawned-MU clone would otherwise inherit the source's
 * `realvirtual` rv-extras (including its `Source` entry). When the placed
 * subtree is later (re)processed by `processExtras` (placement re-scan,
 * persistence restore, layout op, multiuser sync) those copies get turned into
 * live `RVSource`s — which spawn their own clones recursively and nest under
 * the source. Removing the metadata from clones breaks that cycle. Pure-visual
 * markers (`_isSourceGhost`, `_isSourcePreview`) are intentionally preserved.
 */
function stripComponentMetadata(obj: Object3D): void {
  obj.traverse((child) => {
    const ud = child.userData;
    if (!ud) return;
    delete ud.realvirtual;
    delete ud._layoutObject;
    delete ud._layoutId;
  });
}

// Shared white transparent material for the always-visible source ghost. The
// ghost previews the spawned MU at the source position; a flat translucent
// white reads clearly as a "template preview" distinct from the solid spawned
// MUs. Shared across all sources (read-only) — disposed never (module-lived).
const _sourceGhostMaterial = new MeshBasicMaterial({
  color: 0xffffff,
  transparent: true,
  opacity: 0.3,
  depthWrite: false,
});

/**
 * RVSource - Spawns new MU instances at regular intervals or by distance.
 *
 * Uses a template MU node from the GLB (found by name) and clones it.
 * Template is hidden at load time and used as a clone source.
 */
export class RVSource implements RVComponent {
  static readonly schema: ComponentSchema = {
    AutomaticGeneration: { type: 'boolean', default: true },
    Interval: { type: 'number', default: 0, aliases: ['SpawnInterval'] },
    GenerateIfDistance: { type: 'number', default: 300, aliases: ['SpawnDistance'] },
    PlaceOnTransportSurface: { type: 'boolean', default: true },
    ThisObjectAsMU: { type: 'string', default: '' },
  };

  readonly node: Object3D;
  isOwner = true;

  // Properties — exact C# Inspector field names
  AutomaticGeneration = true;
  Interval = 0;
  GenerateIfDistance = 300;
  PlaceOnTransportSurface = true;
  ThisObjectAsMU = '';

  // Derived properties (computed from schema properties)
  spawnMode: 'Interval' | 'Distance' | 'OnSignal' = 'Interval';
  spawnInterval = 3;
  spawnDistance = 300;
  muName = '';
  sourceIsTemplate = false;

  /** Template to clone for new MUs */
  muTemplate: Object3D | null = null;
  /** Cached half-size from template (computed once) */
  private templateHalfSize: Vector3 | null = null;
  /** Cached local center offset from template (mesh center vs node origin) */
  private templateLocalCenter: Vector3 | null = null;

  /** Timer for interval-based spawning */
  private timer = 0;
  /** Counter for unique MU names */
  private spawnCount = 0;
  /** Last spawned MU (for distance mode) */
  private lastSpawnedMU: (RVMovingUnit | InstancedMovingUnit) | null = null;
  /** MU ID counter for instanced MUs */
  private muIdCounter = 0;

  /** Parent scene node to add spawned MUs to */
  spawnParent: Object3D | null = null;

  /** Instance pool (non-null when template uses instancing) */
  pool: MUInstancePool | null = null;

  /** Whether this source uses instancing (determined by template analysis) */
  useInstancing = false;

  /** Raw GLB extras for computing spawn config in init() */
  rawExtras: Record<string, unknown> | null = null;

  /** Always-visible white-transparent preview of the spawned MU, shown at the
   *  source position. Lets the user always see (and select / place in the
   *  Layout-Planner) the source, even before the first MU spawns and while the
   *  simulation runs. Built in `setTemplate`, removed in `dispose`. */
  private _ghostNode: Object3D | null = null;

  /** When the source IS its own MU template (`sourceIsTemplate`), the source
   *  node is rendered in place as a white ghost. We keep the original mesh
   *  materials (in subtree-traversal order) so spawned clones restore the real
   *  look. Null for the separate-template case (which uses `_ghostNode`). */
  private _selfGhostOriginalMaterials: Array<Material | Material[]> | null = null;

  /** Showcase instance: a real-material preview MU held at the source origin
   *  while spawning is disabled (planner). Rendered ALONGSIDE the ghost. When
   *  spawning is (re-)enabled the held instance is released into the simulation
   *  (the first real spawn) and this is cleared. Parented to `this.node` so it
   *  tracks the source as it is moved. Built lazily in `update()`. */
  private _previewInstance: Object3D | null = null;

  // ── Floor-Marker (plan-181) ─────────────────────────────────────────
  // Always-visible identifier under the source: floor ring + label sprite,
  // both children of `this.node` so they automatically track Source
  // movement (Layout-Planner drag). Built in `setTemplate` alongside the
  // ghost, freed via `_markerDispose()` in `dispose()`.
  private _markerNode: Object3D | null = null;
  private _markerRing: Mesh | null = null;
  private _markerLabel: Sprite | null = null;
  private _markerLabelTexture: Texture | null = null;
  private _markerLabelText: string | null = null;
  private _markerDispose: (() => void) | null = null;

  constructor(node: Object3D) {
    this.node = node;
  }

  /**
   * Resolve the node spawned MUs are added to. MUs must NEVER be added inside
   * the source's own subtree — that would make every MU a child of the source
   * (so it moves with the source) and, for a self-template source, each new
   * `clone()` would copy the growing subtree → exponential, nested duplication.
   *
   * The main `loadGLB` path passes the model root as `context.root` (an
   * ancestor of this source) → used as-is. The Layout-Planner places a source
   * via `processExtras(clone, …)` where `context.root` IS the placed source's
   * own subtree root → walking up from it reaches this source node, so we spawn
   * into the source's parent (the model root the clone was added to) instead.
   */
  private _resolveSpawnParent(contextRoot: Object3D): Object3D {
    let p: Object3D | null = contextRoot;
    while (p) {
      if (p === this.node) return this.node.parent ?? contextRoot;
      p = p.parent;
    }
    return contextRoot;
  }

  /**
   * Compute spawn config, resolve template, and register with transport manager.
   * Called after applySchema + resolveComponentRefs.
   */
  init(context: ComponentContext): void {
    // Read raw extras from node (self-contained — no loader dependency)
    if (!this.rawExtras) {
      const rv = this.node.userData?.realvirtual as Record<string, unknown> | undefined;
      this.rawExtras = (rv?.['Source'] as Record<string, unknown>) ?? null;
    }

    // Compute derived spawn properties from raw extras
    if (this.rawExtras) {
      this.computeSpawnConfig(this.rawExtras);
    }
    this.spawnParent = this._resolveSpawnParent(context.root);

    // Find MU template via registry (path-based, safe)
    let template: Object3D | null = null;
    if (this.sourceIsTemplate) {
      template = this.node;
      debug('loader', `Source: ${this.node.name} mode=${this.spawnMode} interval=${this.spawnInterval}s template=SELF`);
    } else if (this.muName) {
      template = context.registry.getNode(this.muName);
      if (template) {
        debug('loader', `Source: ${this.node.name} mode=${this.spawnMode} interval=${this.spawnInterval}s template="${this.muName}"`);
      } else {
        console.warn(`  Source: ${this.node.name} - MU template "${this.muName}" not found in registry`);
      }
    } else {
      console.warn(`  Source: ${this.node.name} - no MU template configured`);
    }

    // If the resolved MU template IS the source node itself (e.g. a placed
    // source whose `ThisObjectAsMU` path resolves back to its own node but did
    // not match the name-based `sourceIsTemplate` heuristic), treat it as
    // self-template. Otherwise `_buildGhost` would attach a `_isSourceGhost`
    // child that `spawn()` would clone into every MU (a ghost moving with the
    // instance), and the source node would be hidden instead of ghost-rendered.
    if (template === this.node) this.sourceIsTemplate = true;

    if (template) {
      this.setTemplate(template);
    }

    // Register in transport manager
    context.transportManager.sources.push(this);
  }

  /**
   * Compute derived spawn properties from schema properties.
   * Called by loader after applySchema + legacy field handling.
   */
  computeSpawnConfig(extras: Record<string, unknown>): void {
    const interval = this.Interval;
    const distance = this.GenerateIfDistance;
    const autoGen = this.AutomaticGeneration;

    let mode: 'Interval' | 'Distance' | 'OnSignal' = 'Interval';
    if (interval > 0) {
      mode = 'Interval';
    } else if (autoGen && distance > 0) {
      mode = 'Distance';
    }
    // Override with explicit Spawn field if present (legacy WebViewer format)
    const spawnStr = extras['Spawn'] as string | undefined;
    if (spawnStr === 'Distance') mode = 'Distance';
    else if (spawnStr === 'OnSignal') mode = 'OnSignal';

    this.spawnMode = mode;
    this.spawnInterval = interval > 0 ? interval : 3; // default 3s if not set
    this.spawnDistance = distance;

    // ThisObjectAsMU is serialized as a relative path string (or null/empty if self)
    const templateRef = this.ThisObjectAsMU;
    const nodeName = this.node.name;
    this.sourceIsTemplate = !templateRef || templateRef === '' ||
      templateRef === nodeName || templateRef.endsWith('/' + nodeName);
    this.muName = this.sourceIsTemplate ? nodeName : templateRef;
  }

  /** Set the template MU and pre-compute its half-size and center offset */
  setTemplate(template: Object3D): void {
    this.muTemplate = template;
    const info = computeTemplateAABBInfo(template);
    this.templateHalfSize = info.halfSize;
    this.templateLocalCenter = info.localCenter;

    // Analyze template for instancing capability FIRST — captures the real
    // geometry + material before any ghost recolor below, so spawned instances
    // keep the original look.
    const analysis = analyzeTemplate(template);
    if (analysis) {
      this.useInstancing = true;
      this.pool = new MUInstancePool(
        analysis.geometry,
        analysis.material,
        template.name,
        this.templateHalfSize,
        this.templateLocalCenter ?? undefined,
      );
      debug('loader', `Source "${this.node.name}": using InstancedMesh for template "${template.name}"`);
    } else {
      this.useInstancing = false;
      debug('loader', `Source "${this.node.name}": using clone() for multi-mesh template "${template.name}"`);
    }

    if (this.sourceIsTemplate) {
      // The source node IS the MU template. Render it in place as a white
      // ghost (kept visible) so the user always sees the source; spawned
      // clones/instances restore the real materials.
      this._ghostifySelf(template);
    } else {
      // Separate template: hide it and show an always-visible white ghost clone
      // under the source — a clickable, draggable 3D preview even before the
      // first MU spawns.
      template.visible = false;
      this._buildGhost(template);
      // Always-visible floor marker (ring + label) under the source.
      this._buildMarker();
    }
  }

  /**
   * Render the source node itself as a white-transparent ghost (used when the
   * source IS its own MU template). Keeps the node visible and stores the
   * original materials so spawned clones can restore the real look. The
   * instancing pool (built before this) already captured the real material.
   */
  private _ghostifySelf(node: Object3D): void {
    if (this._selfGhostOriginalMaterials) return; // idempotent
    const originals: Array<Material | Material[]> = [];
    node.traverse((child) => {
      const mesh = child as Mesh;
      if (mesh.isMesh) {
        originals.push(mesh.material);
        mesh.material = _sourceGhostMaterial;
      }
    });
    this._selfGhostOriginalMaterials = originals;
    node.visible = true; // keep the source visible as its own ghost preview
  }

  /**
   * Clone the template and pin a placeholder at the source's position. The
   * placeholder is parented to `this.node` so it tracks any movement of the
   * source (e.g. dragging a placed pallet around in the Layout-Planner).
   * Materials are NOT cloned — `Object3D.clone()` shares them with the
   * template, which is fine because we only toggle `.visible`, never opacity.
   *
   * Initial visibility is `false` (hidden) because the viewer boots with the
   * simulation running. Visibility is updated reactively via the
   * `'simulation-pause-changed'` subscription installed in `init()`.
   */
  private _buildGhost(template: Object3D): void {
    if (this._ghostNode) return; // already built (e.g. setTemplate called twice)

    // Skip when source IS the template — `this.muTemplate === this.node`
    // means every clone produced by `spawn()` would include the ghost as a
    // sub-child, so we just skip for that rarer setup.
    if (this.sourceIsTemplate) return;

    const ghost = template.clone();
    // The clone inherited the template's rv-extras / layout metadata via
    // Object3D.clone(); strip them so the ghost is a pure visual and never
    // becomes a live (recursively-spawning) Source when the subtree is rescanned.
    stripComponentMetadata(ghost);
    ghost.name = `${template.name}_ghost`;
    ghost.userData._isSourceGhost = true;
    // Reset transform — the clone inherits the template's world position,
    // but we want it anchored at the source's local origin (transform-wise
    // it becomes a direct child of `this.node`).
    ghost.position.set(0, 0, 0);
    ghost.rotation.set(0, 0, 0);
    ghost.scale.set(1, 1, 1);

    // Force every descendant visible-flag to true (the template was hidden,
    // and its traversal flags carry over via clone), and swap each mesh to the
    // shared white-transparent ghost material so the source always shows as a
    // translucent preview. We reassign the clone's material reference only —
    // the template (and the materials the real spawned MUs share) are untouched.
    ghost.traverse((child) => {
      child.visible = true;
      child.userData._isSourceGhost = true;
      const mesh = child as Mesh;
      if (mesh.isMesh) mesh.material = _sourceGhostMaterial;
    });

    // Always visible — the source ghost is a constant preview of the spawned
    // MU at the source position (during play, pause, and planner placement).
    ghost.visible = true;

    this.node.add(ghost);
    this._ghostNode = ghost;
  }

  /** Toggle the ghost's visibility. Called from the pause-event subscriber. */
  setGhostVisible(visible: boolean): void {
    if (this._ghostNode) this._ghostNode.visible = visible;
  }

  /**
   * Build the always-visible floor marker (ring + label) under the source.
   * Same lifecycle rules as `_buildGhost`:
   *  - Idempotency guard — second call is a no-op.
   *  - Skip when `sourceIsTemplate=true` (would otherwise be cloned into
   *    every spawned MU and pollute the scene).
   *  - Skip if `templateHalfSize` is missing (no template resolved).
   */
  private _buildMarker(): void {
    if (this._markerNode) return;
    if (this.sourceIsTemplate) return;
    if (!this.templateHalfSize) return;

    const handles = buildSourceMarker({
      templateHalfSize: this.templateHalfSize,
      name: this.node.name,
      visible: true,
    });

    this.node.add(handles.root);
    this._markerNode = handles.root;
    this._markerRing = handles.ring;
    this._markerLabel = handles.label;
    this._markerLabelTexture = handles.labelTexture;
    this._markerLabelText = handles.labelText;
    this._markerDispose = handles.dispose;
  }

  /** Toggle the floor-marker's visibility (visibility-only, no rebuild). */
  setMarkerVisible(visible: boolean): void {
    if (this._markerNode) this._markerNode.visible = visible;
  }

  /**
   * Test-only accessor — exposes the marker internals for unit tests so
   * they don't need direct private-field access. Do not use in production
   * code.
   */
  get markerForTesting(): {
    root: Object3D | null;
    ring: Mesh | null;
    label: Sprite | null;
    texture: Texture | null;
    labelText: string | null;
  } {
    return {
      root: this._markerNode,
      ring: this._markerRing,
      label: this._markerLabel,
      texture: this._markerLabelTexture,
      labelText: this._markerLabelText,
    };
  }

  /** Free resources held by the ghost AND the floor marker. Called when the
   *  source is removed from the scene (e.g. layout-planner remove, model
   *  clear via TransportManager.reset). */
  dispose(): void {
    this._disposePreview();
    if (this._ghostNode) {
      if (this._ghostNode.parent) this._ghostNode.parent.remove(this._ghostNode);
      this._ghostNode = null;
    }
    // Marker disposal — frees ring geometry/material + label texture/material
    // and detaches the marker node from `this.node`.
    if (this._markerDispose) {
      this._markerDispose();
      this._markerDispose = null;
    }
    this._markerNode = null;
    this._markerRing = null;
    this._markerLabel = null;
    this._markerLabelTexture = null;
    this._markerLabelText = null;
  }

  /**
   * Update source timer and spawn MU if ready.
   * Returns new MU (clone or instanced) or null.
   *
   * @param spawningEnabled  When false (e.g. Layout-Planner active), the source
   *   does not spawn; instead it shows a held "showcase" preview instance at
   *   its origin (alongside the ghost). The frame spawning flips back to true,
   *   the held preview is released as the first real spawn.
   */
  update(dt: number, spawningEnabled = true): (RVMovingUnit | InstancedMovingUnit) | null {
    if (!this.isOwner) return null; // Server is authority for MU lifecycle
    if (!this.muTemplate || !this.spawnParent) return null;

    if (!spawningEnabled) {
      // Inactive: show the held showcase instance, do not spawn.
      this._ensurePreview();
      return null;
    }

    // Spawning is enabled. If a held preview exists we just (re-)activated —
    // release it as the first real spawn and restart the spawn rhythm.
    if (this._previewInstance) {
      this._disposePreview();
      this.timer = 0;
      return this.spawn();
    }

    if (this.spawnMode === 'Interval') {
      this.timer += dt;
      if (this.timer >= this.spawnInterval) {
        this.timer -= this.spawnInterval;
        return this.spawn();
      }
    } else if (this.spawnMode === 'Distance') {
      // Distance mode: spawn when previous MU has moved spawnDistance mm away
      // (or immediately if no MU has been spawned yet)
      if (!this.lastSpawnedMU || this.lastSpawnedMU.markedForRemoval) {
        return this.spawn();
      }
      // Measure distance from source to last spawned MU (in meters)
      this.node.getWorldPosition(_sourcePos);
      this.lastSpawnedMU.getWorldPosition(_lastMUPos);
      const distM = _sourcePos.distanceTo(_lastMUPos);
      const distMM = distM * MM_TO_METERS;
      if (distMM >= this.spawnDistance) {
        return this.spawn();
      }
    }
    // OnSignal mode not implemented for PoC

    return null;
  }

  /** Create a new MU at this source's position (clone or instanced) */
  private spawn(): (RVMovingUnit | InstancedMovingUnit) | null {
    if (!this.muTemplate || !this.spawnParent || !this.templateHalfSize) return null;

    // ── Instanced path ──
    if (this.useInstancing && this.pool) {
      // Add pool's InstancedMesh to scene if not already added
      if (!this.pool.instancedMesh.parent) {
        this.spawnParent.add(this.pool.instancedMesh);
      }

      this.node.getWorldPosition(_sourcePos);
      const muId = `imu_${this.node.name}_${this.muIdCounter++}`;

      const mu = this.pool.spawn(_sourcePos, _identityQuat, muId, this.node.name);
      this.lastSpawnedMU = mu;
      this.spawnCount++;
      return mu;
    }

    // ── Clone path (multi-mesh fallback) ──
    const clone = this._buildRealClone();
    clone.name = `${this.muTemplate.name}_${this.spawnCount++}`;

    // Position at source location (convert world → spawnParent local space)
    this.node.getWorldPosition(clone.position);
    this.spawnParent.worldToLocal(clone.position);

    this.spawnParent.add(clone);

    const mu = new RVMovingUnit(clone, this.node.name, this.templateHalfSize.clone(), this.templateLocalCenter?.clone());
    this.lastSpawnedMU = mu;
    return mu;
  }

  /**
   * Clone the MU template into a fully-visible, real-material subtree. When the
   * source node is its own white ghost (`sourceIsTemplate`), the captured
   * original materials are restored (subtree-traversal order matches). Shared
   * by `spawn()` (clone path) and the showcase preview.
   */
  private _buildRealClone(): Object3D {
    const clone = this.muTemplate!.clone();

    // Strip any editor-only ghost / showcase-preview subtrees that were cloned
    // in. This happens when the MU template subtree overlaps the source node
    // that carries them — e.g. a (placed) source whose `ThisObjectAsMU` path
    // resolves back to the source node but isn't detected as `sourceIsTemplate`,
    // so `_buildGhost` attached a `_isSourceGhost` child. A real spawned MU must
    // never contain a ghost/preview, so remove them BEFORE restoring materials
    // (keeps the restore index aligned with the captured originals).
    const strip: Object3D[] = [];
    clone.traverse((child) => {
      if (child.userData?._isSourceGhost || child.userData?._isSourcePreview) strip.push(child);
    });
    for (const n of strip) n.parent?.remove(n);

    // The clone inherited the template's rv-extras / layout metadata via
    // Object3D.clone(). A spawned MU (and the held preview) is a pure visual
    // driven by RVMovingUnit — it must never carry a `Source`/`LayoutObject`
    // definition, or `processExtras` would turn it into a recursive Source.
    stripComponentMetadata(clone);

    clone.visible = true;
    const restore = this.sourceIsTemplate ? this._selfGhostOriginalMaterials : null;
    let matIdx = 0;
    clone.traverse((child) => {
      child.visible = true;
      if (restore) {
        const mesh = child as Mesh;
        if (mesh.isMesh) {
          const orig = restore[matIdx++];
          if (orig) mesh.material = orig;
        }
      }
    });
    return clone;
  }

  /**
   * Build the held showcase instance (a real-material preview MU) at the source
   * origin, parented to `this.node` so it tracks the source. Idempotent. Shown
   * while spawning is disabled, alongside the ghost; released by `update()`
   * when spawning re-enables. Not registered as a simulation MU, so transport
   * never moves it — it stays pinned at the source.
   */
  /** Build the held showcase instance now (used when the simulation is paused
   *  — e.g. the planner pauses the sim, so the update loop won't build it). */
  showPreview(): void {
    this._ensurePreview();
  }

  private _ensurePreview(): void {
    if (this._previewInstance || !this.muTemplate) return;
    const inst = this._buildRealClone();
    inst.name = `${this.muTemplate.name}_preview`;
    inst.userData._isSourcePreview = true;
    inst.position.set(0, 0, 0);
    inst.quaternion.identity();
    inst.scale.set(1, 1, 1);
    this.node.add(inst);
    this._previewInstance = inst;
  }

  /** Remove the held showcase instance (shared geometry/materials are NOT
   *  disposed — they belong to the template). */
  private _disposePreview(): void {
    if (!this._previewInstance) return;
    this._previewInstance.parent?.remove(this._previewInstance);
    this._previewInstance = null;
  }
}

// Self-register for auto-discovery by scene loader
registerComponent({
  type: 'Source',
  schema: RVSource.schema,
  capabilities: {
    badgeColor: '#ab47bc',
    simulationActive: true,
  },
  create: (node) => new RVSource(node),
});
