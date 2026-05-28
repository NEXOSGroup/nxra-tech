// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { ArrowHelper, Box3, Object3D, Vector3, Quaternion, MathUtils, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, DoubleSide, RepeatWrapping } from 'three';
import { debug } from './rv-debug';
import { MM_TO_METERS } from './rv-constants';
import type { MeshStandardMaterial, Texture } from 'three';
import { AABB } from './rv-aabb';
import type { RVDrive } from './rv-drive';
import type { RVMovingUnit, InstancedMovingUnit } from './rv-mu';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent } from './rv-component-registry';
import { traverseMeshes } from './rv-traverse-utils';
import type { GizmoOverlayManager } from './rv-gizmo-manager';

// Pre-allocated temp vectors (no GC in hot path)
const _movement = new Vector3();
const _offset = new Vector3();

// Shared geometry/material for transport-surface drop planes. These transient
// planes are NEVER added to the scene (never rendered, never selectable) — they
// are handed to the planner's drop-to-surface raycast as candidate targets so
// objects can be placed on a conveyor top even when it has no solid top mesh.
const _dropPlaneGeometry = new PlaneGeometry(1, 1);
_dropPlaneGeometry.rotateX(-Math.PI / 2); // unit quad, lying flat (normal = +Y)
const _dropPlaneMaterial = new MeshBasicMaterial({ side: DoubleSide });

/**
 * RVTransportSurface - Moves MUs along a direction at the associated Drive's speed.
 *
 * TransportDirection comes from GLB extras (computed by Unity at export time).
 * Speed comes from the associated RVDrive's currentSpeed.
 */
export class RVTransportSurface implements RVComponent {
  static readonly schema: ComponentSchema = {
    TransportDirection: { type: 'vector3', unityCoords: true },
    Radial: { type: 'boolean', default: false },
    TextureScale: { type: 'number', default: 1 },
    HeightOffsetOverride: { type: 'number', default: 0 },
    AnimateSurface: { type: 'boolean', default: true },
    DriveReference: { type: 'componentRef' },
  };

  readonly node: Object3D;
  readonly aabb: AABB;
  isOwner = true;

  // Properties — exact C# Inspector field names
  TransportDirection = new Vector3(1, 0, 0);
  Radial = false;
  TextureScale = 1;
  HeightOffsetOverride = 0;
  AnimateSurface = true;
  DriveReference: RVDrive | null = null;

  /** Raw Unity local transport direction for UV animation (before coordinate conversion) */
  rawLocalDir: { x: number; y: number; z: number } = { x: 1, y: 0, z: 0 };

  /** Associated drive (provides speed). Found during scene loading. */
  drive: RVDrive | null = null;

  /** Normalized transport direction in world space */
  private direction = new Vector3();
  /** Rotation axis for radial transport */
  private rotationAxis = new Vector3();

  /** Cloned textures for independent conveyor belt animation */
  private _texMaps: Texture[] = [];
  /** Raw Unity local direction X component for UV animation */
  private _uvDirX = 0;
  /** Raw Unity local direction Z component for UV animation */
  private _uvDirZ = 0;
  /** Raw Unity local direction Y component for radial UV direction sign */
  private _uvDirY = 0;
  /** Accumulated radial texture offset (wraps to avoid precision loss) */
  private _radialOffsetX = 0;

  // ── Selection-gizmo state (managed by our own selection subscription) ──
  /** Blue transparent fill over the top face of the surface while selected.
   *  Lives under `this.node` so it follows the asset's transform. */
  private _selTopSurface: Mesh | null = null;
  /** Direction arrow shown alongside the top surface. Lives under `this.node`. */
  private _selArrow: ArrowHelper | null = null;
  /** Captured at init() so we can build the gizmo without the full context. */
  private _selGizmoMgr: GizmoOverlayManager | null = null;
  /** Unsubscribe handle for the direct 'selection-changed' subscription. */
  private _selUnsub: (() => void) | null = null;
  /** Captured registry — used to map selection paths back to nodes. */
  private _selRegistry: { getNode(path: string): Object3D | null | undefined } | null = null;

  constructor(node: Object3D, aabb: AABB) {
    this.node = node;
    this.aabb = aabb;
  }

  /** Reusable quaternion for world-space direction transform */
  private static _worldQuat = new Quaternion();

  /**
   * Transform transport direction to world space, resolve drive, initialize transport.
   * Called after applySchema + resolveComponentRefs.
   */
  init(context: ComponentContext): void {
    // TransportDirection is stored in local space by Unity (InverseTransformDirection).
    // Transform to world space using the node's world quaternion.
    this.node.getWorldQuaternion(RVTransportSurface._worldQuat);
    this.TransportDirection.applyQuaternion(RVTransportSurface._worldQuat).normalize();

    // Initialize transport internals (direction, radial, texture animation)
    this.initTransport();

    // Find associated drive: DriveReference first (explicit ref resolved by resolveComponentRefs),
    // then parent hierarchy walk-up
    if (this.DriveReference) {
      this.drive = this.DriveReference;
    }
    if (!this.drive) {
      this.drive = context.registry.findInParent<RVDrive>(this.node, 'Drive');
    }
    if (!this.drive) {
      console.warn(`  TransportSurface "${this.node.name}": no Drive found - will not transport`);
    }

    // Mark drive as transport surface drive (matches Unity's _istransportsurface flag).
    // This is used by multiuser sync to distinguish conveyor drives from positioning drives.
    if (this.drive) {
      this.drive.isTransportSurface = true;
    }

    // Auto-start: if the drive has a target speed but isn't jogging (Forward signal was false/missing),
    // default to running. In Unity the PLC/LogicStep sets Forward=true during play, but in the
    // WebViewer we want conveyor belts to run out of the box.
    if (this.drive && this.drive.targetSpeed > 0 && !this.drive.jogForward && !this.drive.jogBackward) {
      this.drive.jogForward = true;
    }

    // Stash a reference to the GizmoOverlayManager + node registry so the
    // selection-gizmo logic can build the visualisation without holding
    // the full context.
    this._selGizmoMgr = context.gizmoManager ?? null;
    this._selRegistry = context.registry;

    // Subscribe to selection events DIRECTLY. We can't use the standard
    // `onSelect(selected)` lifecycle hook here because the
    // ComponentEventDispatcher honours only ONE component per node
    // (first-writer wins — see `_rvComponentInstance` in
    // rv-component-registry.ts). Since auto-bound library assets place
    // both `Drive` AND `TransportSurface` on the same node (Transport-Z),
    // the Drive grabs the slot and our `onSelect` would never fire. The
    // direct subscription side-steps that limitation.
    if (context.events) {
      const lastState = { selected: false };
      this._selUnsub = context.events.on('selection-changed', (snap) => {
        const nowSelected = this._isSurfaceImpliedBySelection(snap.selectedPaths ?? []);
        if (nowSelected === lastState.selected) return;
        lastState.selected = nowSelected;
        if (nowSelected) this._showSelectionGizmo();
        else this._hideSelectionGizmo();
      });
    }

    // Register in transport manager
    context.transportManager.surfaces.push(this);

    debug('transport',
      `TransportSurface: ${this.node.name}` +
      ` dir=(${this.TransportDirection.x.toFixed(2)}, ${this.TransportDirection.y.toFixed(2)}, ${this.TransportDirection.z.toFixed(2)})` +
      ` radial=${this.Radial}` +
      (this.drive ? ` drive=${this.drive.name} jogFwd=${this.drive.jogForward}` : ' NO DRIVE')
    );
  }

  /**
   * Whether the current selection should reveal this surface's gizmo. The
   * surface is shown when it sits on the SAME branch as a selected node:
   * either a selected ancestor contains this surface (the common case — the
   * conveyor click resolves to the parent Drive node, which is an ancestor of
   * the child surface node), or a selected child mesh lives under this surface.
   */
  private _isSurfaceImpliedBySelection(paths: readonly string[]): boolean {
    for (const p of paths) {
      const selNode = this._selRegistry?.getNode(p);
      if (!selNode) continue;
      // Selected a parent: the surface is at-or-below the selected node.
      if (this._isAncestorOrSelf(selNode, this.node)) return true;
      // Selected a child mesh: the selection is at-or-below the surface.
      if (this._isAncestorOrSelf(this.node, selNode)) return true;
    }
    return false;
  }

  /** True if `ancestor` is `node` itself or any of its parents. */
  private _isAncestorOrSelf(ancestor: Object3D, node: Object3D): boolean {
    let cur: Object3D | null = node;
    while (cur) {
      if (cur === ancestor) return true;
      cur = cur.parent;
    }
    return false;
  }

  /**
   * Selection-driven visualisation: a wireframe AABB box plus a cyan
   * direction arrow at the AABB centre, both rendered always-on-top and
   * opt-out of raycasting so they never steal hover/click.
   *
   * Subscription is installed in `init()` directly on the viewer event bus
   * (see comment there for why we bypass the standard `onSelect` lifecycle
   * hook). Cleaned up in `dispose()`.
   */
  dispose(): void {
    this._hideSelectionGizmo();
    if (this._selUnsub) { this._selUnsub(); this._selUnsub = null; }
  }

  private _showSelectionGizmo(): void {
    this._hideSelectionGizmo();
    if (!this._selGizmoMgr) return;

    // Blue transparent fill over the TOP face of the surface's bounding box.
    // Built in the node's LOCAL frame and parented to `this.node`, so it
    // follows (and rotates with) the asset.
    this.node.updateMatrixWorld(true);
    const localBox = this._computeLocalAABB();
    if (localBox && !localBox.isEmpty()) {
      const lmin = localBox.min;
      const lmax = localBox.max;
      const sx = Math.max(lmax.x - lmin.x, 1e-4);
      const sz = Math.max(lmax.z - lmin.z, 1e-4);
      const geo = new PlaneGeometry(sx, sz);
      geo.rotateX(-Math.PI / 2); // lie flat in the local XZ plane (normal = +Y)
      const mat = new MeshBasicMaterial({
        color: 0x8ec5ff,         // light blue
        transparent: true,
        opacity: 0.2,
        side: DoubleSide,
        depthTest: false,
        depthWrite: false,
      });
      const surf = new Mesh(geo, mat);
      surf.position.set((lmin.x + lmax.x) / 2, lmax.y, (lmin.z + lmax.z) / 2);
      surf.renderOrder = 2001;
      surf.userData._highlightOverlay = true;
      surf.raycast = () => { /* never a click target */ };
      this.node.add(surf);
      this._selTopSurface = surf;
    }

    // Subtree AABB → local centre for the arrow origin.
    const box = new Box3().setFromObject(this.node);
    const center = new Vector3();
    const size = new Vector3();
    box.getCenter(center);
    box.getSize(size);
    if (!Number.isFinite(size.x) || size.lengthSq() === 0) return;
    const localOrigin = this.node.worldToLocal(center.clone());

    // Use the runtime `direction` (world-space resolved) — but the arrow
    // sits in the surface's LOCAL frame so we transform back to local.
    const worldDir = this.direction.clone();
    if (worldDir.lengthSq() === 0) worldDir.copy(this.TransportDirection);
    if (worldDir.lengthSq() === 0) return;
    worldDir.normalize();

    // worldToLocal works on POINTS — to convert a DIRECTION we apply the
    // inverse rotation (the world quaternion's conjugate) since translation
    // doesn't affect direction vectors.
    const invQuat = new Quaternion();
    this.node.getWorldQuaternion(invQuat).invert();
    const localDir = worldDir.applyQuaternion(invQuat);

    // Fixed 0.5 m arrow in WORLD space. The arrow is parented to `this.node`,
    // so its length is interpreted in node-local units — divide by the node's
    // world scale along the arrow direction so it renders at a true 0.5 m
    // regardless of any scale baked into the surface (e.g. library placements).
    const ARROW_WORLD_LENGTH = 0.5; // metres
    const ws = new Vector3();
    this.node.getWorldScale(ws);
    const scaleAlongDir = Math.hypot(ws.x * localDir.x, ws.y * localDir.y, ws.z * localDir.z) || 1;
    const length = ARROW_WORLD_LENGTH / scaleAlongDir;
    const arrow = new ArrowHelper(
      localDir,
      localOrigin,
      length,
      0x00ddff,         // cyan — high contrast on most scene backgrounds
      length * 0.18,    // head length
      length * 0.10,    // head width
    );
    arrow.line.renderOrder = 2002;
    arrow.cone.renderOrder = 2002;
    type LineMat = { depthTest: boolean };
    type MeshMat = { depthTest: boolean; depthWrite: boolean; transparent: boolean };
    (arrow.line.material as unknown as LineMat).depthTest = false;
    const coneMat = arrow.cone.material as unknown as MeshMat;
    coneMat.depthTest = false;
    coneMat.depthWrite = false;
    coneMat.transparent = true;
    arrow.userData._highlightOverlay = true;
    arrow.raycast = () => { /* never a click target */ };
    this.node.add(arrow);
    this._selArrow = arrow;
  }

  private _hideSelectionGizmo(): void {
    if (this._selTopSurface) {
      this._selTopSurface.parent?.remove(this._selTopSurface);
      this._selTopSurface.geometry.dispose();
      (this._selTopSurface.material as MeshBasicMaterial).dispose();
      this._selTopSurface = null;
    }
    if (this._selArrow) {
      this._selArrow.parent?.remove(this._selArrow);
      this._selArrow.dispose();
      this._selArrow = null;
    }
  }

  /** AABB of all mesh descendants expressed in `this.node`'s LOCAL frame.
   *  Returns null if the subtree has no mesh geometry. */
  private _computeLocalAABB(): Box3 | null {
    const box = new Box3();
    const invNode = new Matrix4().copy(this.node.matrixWorld).invert();
    const m = new Matrix4();
    const tmp = new Box3();
    let found = false;
    this.node.traverse((child) => {
      const mesh = child as Mesh;
      if (mesh.isMesh && mesh.geometry) {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const gb = mesh.geometry.boundingBox;
        if (gb) {
          m.multiplyMatrices(invNode, mesh.matrixWorld);
          tmp.copy(gb).applyMatrix4(m);
          box.union(tmp);
          found = true;
        }
      }
    });
    return found ? box : null;
  }

  /**
   * Build a transient horizontal drop-target plane at the TOP of this surface's
   * AABB, in WORLD space. Used by the planner's drop-to-surface so objects can
   * be placed on the conveyor top even when the surface has no solid top mesh
   * (e.g. an AABB-only / virtual conveyor). The returned mesh is NOT added to
   * the scene — it is only a raycast candidate for the duration of a drag.
   * Returns null for a degenerate (zero-area) footprint.
   */
  createDropPlane(): Mesh | null {
    this.aabb.update();
    const min = this.aabb.min;
    const max = this.aabb.max;
    const sx = max.x - min.x;
    const sz = max.z - min.z;
    if (!Number.isFinite(sx) || !Number.isFinite(sz) || sx <= 1e-4 || sz <= 1e-4) return null;
    const plane = new Mesh(_dropPlaneGeometry, _dropPlaneMaterial);
    plane.position.set((min.x + max.x) / 2, max.y, (min.z + max.z) / 2);
    plane.scale.set(sx, 1, sz);
    plane.userData._rvDropSurface = true;
    plane.updateMatrixWorld(true);
    return plane;
  }

  /**
   * Initialize transport after properties are set (direction, radial, texture animation).
   * Called by the loader after applySchema + quaternion transform.
   */
  initTransport(): void {
    // Normalize the transport direction
    this.direction.copy(this.TransportDirection).normalize();

    if (this.Radial) {
      // For radial transport, the direction IS the rotation axis
      this.rotationAxis.copy(this.direction);
    }

    // Texture animation setup
    if (this.AnimateSurface !== false) {
      this._uvDirX = this.rawLocalDir?.x ?? 0;
      this._uvDirY = this.rawLocalDir?.y ?? 0;
      this._uvDirZ = this.rawLocalDir?.z ?? 0;
      this._initTextureAnimation();
    }
  }

  /** Current transport speed in mm/s from the associated Drive */
  get speed(): number {
    if (!this.drive) return 0;
    // Use drive's actual current speed (respects acceleration ramps)
    return this.drive.currentSpeed;
  }

  /** Is the surface actively transporting? */
  get isActive(): boolean {
    return this.drive != null && this.speed > 0;
  }

  /** Authoritative current runtime value for UI display (live source of truth). */
  getLiveState(): Record<string, unknown> {
    return { Speed: this.speed };
  }

  /**
   * Move a MU along the transport direction.
   * Linear transport: direct position offset.
   */
  transportMU(mu: RVMovingUnit | InstancedMovingUnit, dt: number): void {
    if (this.Radial) {
      this.transportMURadial(mu, dt);
      return;
    }

    // Linear transport: position += direction * speed * dt
    // Speed is in mm/s, Three.js positions are in meters -> divide by MM_TO_METERS
    const speedM = this.speed / MM_TO_METERS;
    _movement.copy(this.direction).multiplyScalar(speedM * dt);
    mu.getPosition().add(_movement);
  }

  /**
   * Rotate a MU around the surface center (turntable).
   */
  private transportMURadial(mu: RVMovingUnit | InstancedMovingUnit, dt: number): void {
    // Speed is in degrees/s for rotational drives
    const angleDeg = this.speed * dt;
    const angleRad = MathUtils.degToRad(angleDeg);

    // Get surface center in world space
    const surfacePos = this.node.getWorldPosition(_offset);

    // Offset from surface center to MU
    _movement.copy(mu.getPosition()).sub(surfacePos);
    // Rotate offset around axis
    _movement.applyAxisAngle(this.rotationAxis, angleRad);
    // Apply new position
    _offset.copy(surfacePos).add(_movement);
    mu.setPosition(_offset);

    // Also rotate the MU itself
    mu.rotateOnAxis(this.rotationAxis, angleRad);
  }

  /**
   * Animate conveyor belt texture based on drive speed.
   * Mirrors Unity's TransportSurface.UpdateTextureAnimation().
   */
  updateTextureAnimation(dt: number): void {
    if (this._texMaps.length === 0 || !this.drive || this.speed === 0) return;

    if (this.Radial) {
      this._updateRadialTexture(dt);
    } else {
      this._updateLinearTexture(dt);
    }
  }

  /** Update AABB (call once per frame, before overlap checks) */
  updateAABB(): void {
    this.aabb.update();
  }

  // ── Texture Animation (private) ──────────────────────────────────

  /**
   * Find mesh children with textures and clone their maps for independent offset control.
   * Mirrors Unity creating material instances for texture animation.
   */
  private _initTextureAnimation(): void {
    let meshCount = 0;
    let texCount = 0;
    traverseMeshes(this.node, (mesh) => {
      meshCount++;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (let i = 0; i < mats.length; i++) {
        const mat = mats[i] as MeshStandardMaterial;
        if (mat.map) {
          // Clone texture to get independent offset (image data stays shared on GPU)
          const tex = mat.map.clone();
          tex.wrapS = RepeatWrapping;
          tex.wrapT = RepeatWrapping;
          tex.needsUpdate = true;
          mat.map = tex;
          this._texMaps.push(tex);
          texCount++;
        }
      }
    });
    if (texCount > 0) {
      debug('transport', `TransportSurface "${this.node.name}": texture animation enabled (${texCount} textures on ${meshCount} meshes, uvDir=(${this._uvDirX.toFixed(2)}, ${this._uvDirZ.toFixed(2)}))`);
    } else {
      debug('transport', `TransportSurface "${this.node.name}": no textures found for animation (${meshCount} meshes, all without map)`);
    }
  }

  /**
   * Linear texture animation: scroll UV based on drive speed and transport direction.
   * Matches Unity: uvOffset = (localDir.x, localDir.z) * TextureScale * dt * speed / Scale
   */
  private _updateLinearTexture(dt: number): void {
    // speed is mm/s, /MM_TO_METERS converts to m/s (matches Unity's /Scale)
    const speedFactor = this.TextureScale * dt * this.speed / MM_TO_METERS;
    // Use raw Unity local direction for UV (UV coords are in Unity space)
    const du = this._uvDirX * speedFactor;
    const dv = this._uvDirZ * speedFactor;

    for (const tex of this._texMaps) {
      tex.offset.x += du;
      tex.offset.y += dv;
    }
  }

  /**
   * Radial texture animation: scroll U based on angular speed.
   * Matches Unity: rotationSpeed = speed/360, offset.x += movement * sign(localDir.y)
   */
  private _updateRadialTexture(dt: number): void {
    // speed is degrees/s for rotational drives
    const rotationSpeed = this.speed / 360; // revolutions per second
    const movement = rotationSpeed * dt;
    const direction = Math.sign(this._uvDirY);

    this._radialOffsetX += movement * direction;
    // Wrap to [0, 1] to avoid float precision loss over long runs
    this._radialOffsetX -= Math.floor(this._radialOffsetX);

    for (const tex of this._texMaps) {
      tex.offset.x = this._radialOffsetX;
    }
  }
}

// Self-register for auto-discovery by scene loader
registerComponent({
  type: 'TransportSurface',
  schema: RVTransportSurface.schema,
  needsAABB: true,
  capabilities: {
    badgeColor: '#ffa726',
    filterLabel: 'Conveyors',
    simulationActive: true,
  },
  create: (node, aabb) => new RVTransportSurface(node, aabb!),
  beforeSchema: (inst, extras) => {
    const rawDir = extras['TransportDirection'] as { x: number; y: number; z: number } | undefined;
    (inst as RVTransportSurface).rawLocalDir = rawDir
      ? { x: rawDir.x, y: rawDir.y, z: rawDir.z } : { x: 1, y: 0, z: 0 };
  },
});
