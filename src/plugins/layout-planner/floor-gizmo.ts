// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * FloorGizmo — Minimal floor-plane manipulator for the Layout Planner.
 *
 * Replaces Three.js TransformControls with a focused multi-handle widget:
 *   - Inner disc → drag for XZ translation (snaps to planner grid when enabled)
 *   - Outer ring → drag for Y rotation (snaps to 15° when grid enabled)
 *   - X axis bar (red) → drag for X-only translation
 *   - Z axis bar (blue) → drag for Z-only translation
 *
 * Visual properties:
 *   - Always lies flat on the floor at the target's Y
 *   - Scale-invariant in screen space (constant pixel size at any zoom)
 *   - Renders on top of all other geometry (depthTest off, high renderOrder)
 *   - Live cursor-anchored readout during drag (Δx/Δz or Δ°)
 *
 * Events (callbacks):
 *   - onDraggingChanged → (value: boolean)     (start/stop, for OrbitControls)
 *   - onChange           → no payload            (during drag, per move)
 *   - onDragEnd          → no payload            (fires once at end of drag)
 */

import {
  Group,
  Mesh,
  RingGeometry,
  BoxGeometry,
  CylinderGeometry,
  ConeGeometry,
  MeshBasicMaterial,
  LineLoop,
  LineBasicMaterial,
  BufferGeometry,
  Float32BufferAttribute,
  Plane,
  Vector2,
  Vector3,
  Quaternion,
  Raycaster,
  MathUtils,
} from 'three';
import type { Object3D, PerspectiveCamera, OrthographicCamera, WebGLRenderer } from 'three';
import { pointerToNDC } from '../../core/engine/rv-pointer-utils';
import { HIGHLIGHT_OVERLAY_LAYER } from '../../core/engine/rv-group-registry';
import type { CustomSnapFn, SnapAxisLock } from './bbox-snap';

// ─── Constants & shared temps ─────────────────────────────────────────

/** Screen-space pixel size of the disc radius at default zoom. */
const DISC_SCREEN_RADIUS_PX = 29.4; // 70% of the former 42 px
/** Ring outer radius as a multiple of disc radius. */
const RING_OUTER_FACTOR = 1.55;
/** Ring inner radius as a multiple of disc radius. */
const RING_INNER_FACTOR = 1.25;

/** Visible arm length (shaft + cone) for every axis arrow, in disc-radius units.
 *  X/Z arrows extend outward from the ring edge; the Y arrow extends upward
 *  from the floor lift. Same value for all three so the three arrowheads sit
 *  at equal distances from their respective baselines. */
const AXIS_ARM_LENGTH = 0.9;
/** Cylinder shaft radius as a multiple of disc radius. */
const AXIS_SHAFT_RADIUS = 0.025;
/** Cone tip base radius as a multiple of disc radius. */
const AXIS_TIP_RADIUS = 0.085;
/** Cone tip length cap (used for the long vertical Y bar). */
const AXIS_TIP_MAX_LENGTH = 0.30;
/** Cone tip length as a fraction of total bar length (capped by MAX). */
const AXIS_TIP_FRACTION = 0.45;
/** Radial subdivisions for cylinders & cones — 16 looks round, costs ~96 tris per arrow. */
const AXIS_RADIAL_SEGMENTS = 16;
/** Axis bar picker (invisible) half-width — wider for easy clicking. */
const AXIS_PICKER_HALF_WIDTH = 0.14;

/** Outline color (green, matches selection brand). */
const COLOR_OUTLINE = 0x4fc34f;
/** Fill color (near-black for the smoked-glass look). */
const COLOR_FILL = 0x000000;

/** Axis colors. */
const COLOR_AXIS_X = 0xe03131;
const COLOR_AXIS_Y = 0x2f9e44;
const COLOR_AXIS_Z = 0x1971c2;
/** Axis hover colors (lighter). */
const COLOR_AXIS_X_HOVER = 0xff6b6b;
const COLOR_AXIS_Y_HOVER = 0x69db7c;
const COLOR_AXIS_Z_HOVER = 0x4dabf7;

/** Fill opacities — semi-transparent so the floor stays visible underneath. */
const FILL_OPACITY_IDLE = 0.35;
const FILL_OPACITY_HOVER = 0.55;
const FILL_OPACITY_DRAG = 0.70;

/** Outline opacities — always crisp; pop further on hover/drag. */
const OUTLINE_OPACITY_IDLE = 0.95;
const OUTLINE_OPACITY_HOVER = 1.00;
const OUTLINE_OPACITY_DRAG = 1.00;


/**
 * CSS cursors per handle. `move` is the standard 4-way arrow used for
 * translation in every 3D editor. For rotation there's no built-in CSS
 * cursor, so we use an inline SVG data URI of a circular rotation arrow.
 * Hotspot at (12, 12) — the centre of the icon.
 */
const CURSOR_TRANSLATE = 'move';
const CURSOR_ROTATE = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>` +
  `<g fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'>` +
    `<path d='M19.5 12 A7.5 7.5 0 1 1 12 4.5'/>` +
    `<polyline points='12,1.5 12,7.5 18,7.5'/>` +
  `</g>` +
  `<g fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'>` +
    `<path d='M19.5 12 A7.5 7.5 0 1 1 12 4.5'/>` +
    `<polyline points='12,1.5 12,7.5 18,7.5'/>` +
  `</g>` +
  `</svg>`,
)}") 12 12, crosshair`;
const CURSOR_AXIS_X = 'ew-resize';
const CURSOR_AXIS_Y = 'ns-resize';
const CURSOR_AXIS_Z = 'ns-resize';
const CURSOR_DRAGGING = 'grabbing';

const _ndcPointer = new Vector2();
const _raycaster = new Raycaster();
const _v3a = new Vector3();
const _v3b = new Vector3();
const _projHelper = new Vector3();

/** Floor plane (Y up, offset set per drag from target.y). */
const _floorPlane = new Plane(new Vector3(0, 1, 0), 0);
/** Vertical plane facing camera (for Y-axis drag). */
const _verticalPlane = new Plane(new Vector3(0, 0, 1), 0);
const _camDir = new Vector3();

// ─── Types ────────────────────────────────────────────────────────────

type Handle = 'disc' | 'ring' | 'axis-x' | 'axis-y' | 'axis-z';

// ─── FloorGizmo ───────────────────────────────────────────────────────

export class FloorGizmo {
  /** Root Group added to the scene (positions track the target). */
  readonly root = new Group();

  /** Set by the host (planner) — fires on drag start (true) and end (false). */
  onDraggingChanged: ((value: boolean) => void) | null = null;
  /** Set by the host — fires per pointer-move while dragging. */
  onChange: (() => void) | null = null;
  /** Set by the host — fires once when a drag completes (after onDraggingChanged(false)). */
  onDragEnd: (() => void) | null = null;

  private readonly _disc: Mesh;
  private readonly _ring: Mesh;
  private readonly _axisX: Mesh;       // visual
  private readonly _axisY: Mesh;       // visual (vertical)
  private readonly _axisZ: Mesh;       // visual
  private readonly _axisXPicker: Mesh; // invisible wide hit-test mesh
  private readonly _axisYPicker: Mesh; // invisible wide hit-test mesh (vertical)
  private readonly _axisZPicker: Mesh; // invisible wide hit-test mesh
  /** Outline materials — opacity is animated alongside the fills. */
  private readonly _discOutlineMat: LineBasicMaterial;
  private readonly _ringInnerOutlineMat: LineBasicMaterial;
  private readonly _ringOuterOutlineMat: LineBasicMaterial;
  private readonly _axisXMat: MeshBasicMaterial;
  private readonly _axisYMat: MeshBasicMaterial;
  private readonly _axisZMat: MeshBasicMaterial;
  /** Live camera getter — the viewer hot-swaps between perspective and
   *  orthographic; we must always read the active one for raycasting and
   *  for screen-space scale, otherwise clicks miss the handles in ortho. */
  private readonly _getCamera: () => PerspectiveCamera | OrthographicCamera;
  private readonly _renderer: WebGLRenderer;
  private readonly _scene: import('three').Scene;
  private readonly _domElement: HTMLElement;

  /** Convenience accessor — every read site uses `this._camera`. */
  private get _camera(): PerspectiveCamera | OrthographicCamera {
    return this._getCamera();
  }

  private _target: Object3D | null = null;
  private _enabled = true;
  private _yAxisEnabled = false;

  private _hovered: Handle | null = null;
  private _dragging: Handle | null = null;

  /** Set per-drag from the target's Y so translation stays in the same plane. */
  private _dragStartTargetPos = new Vector3();
  private _dragStartTargetQuat = new Quaternion();
  private _dragStartHitWorld = new Vector3();
  private _dragStartAngle = 0;

  private _translationSnap: number | null = null;
  private _rotationSnap: number | null = null;

  /** Optional pre-grid snap hook (e.g. magnetic bbox snap). When it returns a
   *  result for an axis, that axis bypasses the grid quantizer this frame. */
  private _customSnap: CustomSnapFn | null = null;

  private _readoutEl: HTMLDivElement | null = null;

  // Cached event handlers (so we can remove them on dispose)
  private readonly _onPointerDown: (e: PointerEvent) => void;
  private readonly _onPointerMove: (e: PointerEvent) => void;
  private readonly _onPointerUp: (e: PointerEvent) => void;

  constructor(
    camera: (PerspectiveCamera | OrthographicCamera) | (() => PerspectiveCamera | OrthographicCamera),
    renderer: WebGLRenderer,
    scene: import('three').Scene,
  ) {
    // Accept either a fixed camera (legacy) or a getter (preferred — handles
    // perspective ↔ orthographic toggles without dangling references).
    this._getCamera = typeof camera === 'function' ? camera : () => camera;
    this._renderer = renderer;
    this._scene = scene;
    this._domElement = renderer.domElement;

    // Disc geometry: inner=0 → solid filled circle; lies flat on floor (rot -π/2 around X).
    const discGeo = new RingGeometry(0, 1, 48);
    const discMat = new MeshBasicMaterial({
      color: COLOR_FILL,
      transparent: true,
      opacity: FILL_OPACITY_IDLE,
      depthTest: false,
      depthWrite: false,
    });
    discMat.name = '_floorGizmoDisc';
    this._disc = new Mesh(discGeo, discMat);
    this._disc.rotation.x = -Math.PI / 2;
    this._disc.userData._floorGizmoHandle = 'disc';
    this._disc.renderOrder = 9999;
    this._disc.frustumCulled = false;

    // Disc outline — single circle at the disc edge.
    this._discOutlineMat = makeOutlineMaterial();
    const discOutline = new LineLoop(makeCircleGeometry(1, 64), this._discOutlineMat);
    discOutline.renderOrder = 10000; // on top of the fill
    discOutline.frustumCulled = false;
    discOutline.raycast = () => {};
    this._disc.add(discOutline);

    // Ring geometry: thin annular ring around the disc.
    const ringGeo = new RingGeometry(RING_INNER_FACTOR, RING_OUTER_FACTOR, 64);
    const ringMat = new MeshBasicMaterial({
      color: COLOR_FILL,
      transparent: true,
      opacity: FILL_OPACITY_IDLE,
      depthTest: false,
      depthWrite: false,
    });
    ringMat.name = '_floorGizmoRing';
    this._ring = new Mesh(ringGeo, ringMat);
    this._ring.rotation.x = -Math.PI / 2;
    this._ring.userData._floorGizmoHandle = 'ring';
    this._ring.renderOrder = 9999;
    this._ring.frustumCulled = false;

    // Ring outlines — inner + outer circles.
    this._ringInnerOutlineMat = makeOutlineMaterial();
    this._ringOuterOutlineMat = makeOutlineMaterial();
    const ringInner = new LineLoop(makeCircleGeometry(RING_INNER_FACTOR, 64), this._ringInnerOutlineMat);
    const ringOuter = new LineLoop(makeCircleGeometry(RING_OUTER_FACTOR, 96), this._ringOuterOutlineMat);
    for (const o of [ringInner, ringOuter]) {
      o.renderOrder = 10000;
      o.frustumCulled = false;
      o.raycast = () => {};
      this._ring.add(o);
    }

    // ── Axis handles (X = red, Y = green, Z = blue) ──────────────────
    // Each axis has a visible thin bar + invisible wider picker mesh.

    // X axis — extends along gizmo-local X (lies flat via -π/2 X rotation)
    const { visual: axisXVisual, picker: axisXPicker, material: axisXMat } =
      makeAxisBar('axis-x', COLOR_AXIS_X, AXIS_ARM_LENGTH, AXIS_PICKER_HALF_WIDTH);
    this._axisX = axisXVisual;
    this._axisXPicker = axisXPicker;
    this._axisXMat = axisXMat;
    this._axisX.rotation.x = -Math.PI / 2;
    this._axisXPicker.rotation.x = -Math.PI / 2;

    // Y axis — single vertical pole rising from the gizmo center (not split
    // around the ring like X/Z, since the disc/ring don't occlude the Y axis).
    const { visual: axisYVisual, picker: axisYPicker, material: axisYMat } =
      makeVerticalBar('axis-y', COLOR_AXIS_Y, AXIS_ARM_LENGTH, AXIS_PICKER_HALF_WIDTH);
    this._axisY = axisYVisual;
    this._axisYPicker = axisYPicker;
    this._axisYMat = axisYMat;
    // Hidden by default — only shown when explicitly enabled
    this._axisY.visible = false;
    this._axisYPicker.visible = false;

    // Z axis — same bar rotated 90° around Y so it extends along Z
    const { visual: axisZVisual, picker: axisZPicker, material: axisZMat } =
      makeAxisBar('axis-z', COLOR_AXIS_Z, AXIS_ARM_LENGTH, AXIS_PICKER_HALF_WIDTH);
    this._axisZ = axisZVisual;
    this._axisZPicker = axisZPicker;
    this._axisZMat = axisZMat;
    this._axisZ.rotation.x = -Math.PI / 2;
    this._axisZ.rotation.z = Math.PI / 2;
    this._axisZPicker.rotation.x = -Math.PI / 2;
    this._axisZPicker.rotation.z = Math.PI / 2;

    // ── Assemble root ────────────────────────────────────────────────
    this.root.add(this._disc);
    this.root.add(this._ring);
    this.root.add(this._axisX);
    this.root.add(this._axisXPicker);
    this.root.add(this._axisY);
    this.root.add(this._axisYPicker);
    this.root.add(this._axisZ);
    this.root.add(this._axisZPicker);
    this.root.visible = false;
    this.root.name = '_floorGizmo';
    // Mark so it's excluded from the planner allow filter.
    this.root.userData._layoutObject = true;

    // Move every gizmo node onto the highlight-overlay layer. The viewer
    // pulls this layer OUT of the EffectComposer pass and renders it in a
    // second renderer.render() call AFTER GTAO/N8AO — without this, the
    // screen-space AO multiplies onto the gizmo pixels and darkens them
    // (the gizmo has depthWrite:false, so AO samples the geometry behind
    // it, then applies that darkening to the gizmo's color in the buffer).
    this.root.traverse((obj) => { obj.layers.set(HIGHLIGHT_OVERLAY_LAYER); });
    // Raycaster.layers defaults to layer 0; enable the overlay layer too
    // or hit-tests against the gizmo silently miss.
    _raycaster.layers.enable(HIGHLIGHT_OVERLAY_LAYER);

    // Bind pointer handlers so we can remove them later
    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerUp = this._handlePointerUp.bind(this);

    this._domElement.addEventListener('pointerdown', this._onPointerDown);
    this._domElement.addEventListener('pointermove', this._onPointerMove);
    // pointerup on window so we still get the release if cursor leaves canvas
    window.addEventListener('pointerup', this._onPointerUp);
  }

  // ─── Public API ──────────────────────────────────────────────────────

  /** Attach the gizmo to a target Object3D (its world position drives the gizmo). */
  attach(target: Object3D): void {
    this._target = target;
    this.root.visible = true;
    this._sync();
  }

  /** Detach the gizmo and hide it. */
  detach(): void {
    if (this._dragging) this._endDrag();
    this._target = null;
    this.root.visible = false;
    this._setHovered(null);
  }

  /** The current target, or null. */
  get target(): Object3D | null { return this._target; }

  /** Whether the gizmo is currently being dragged. */
  get isDragging(): boolean { return this._dragging !== null; }

  /** Translation snap step in meters (null → free). */
  setTranslationSnap(step: number | null): void { this._translationSnap = step; }

  /**
   * Optional callback that runs *before* the grid-translation snap. When it
   * returns a non-null result, axes flagged as snapped (`snappedX`/`snappedZ`)
   * use the callback's value; un-snapped axes still fall through to the grid
   * quantizer. Pass `null` to disable.
   */
  setCustomSnap(fn: CustomSnapFn | null): void { this._customSnap = fn; }

  /** Rotation snap step in radians (null → free). */
  setRotationSnap(step: number | null): void { this._rotationSnap = step; }

  /** Enable/disable pointer interaction (does not hide the gizmo). */
  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
    if (!enabled) this._setHovered(null);
  }

  /** Show/hide the vertical Y-axis handle (hidden by default — floor planning is XZ). */
  setYAxisEnabled(enabled: boolean): void {
    this._yAxisEnabled = enabled;
    this._axisY.visible = enabled;
    this._axisYPicker.visible = enabled;
    if (!enabled && (this._hovered === 'axis-y')) this._setHovered(null);
  }

  /** Whether the Y-axis handle is currently visible. */
  get yAxisEnabled(): boolean { return this._yAxisEnabled; }

  /**
   * Begin a drag on the given handle as if the user had clicked it directly.
   * Used by the planner for "drag the object itself" UX — the planner does
   * the hit-test on the layout mesh, then hands off here to reuse all the
   * gizmo's snap / readout / writeback / OrbitControls-disable logic. The
   * gizmo's own pointermove/pointerup listeners drive the drag from there.
   * No-op when disabled or when no target is attached.
   */
  beginExternalDrag(e: PointerEvent, handle: Handle): void {
    if (!this._enabled || !this._target) return;
    this._beginDrag(handle, e);
  }

  /**
   * Per-frame update — called from the plugin's onRender hook.
   * Keeps the gizmo at the target's position and scaled to constant
   * screen-space pixel size.
   */
  update(): void {
    if (!this._target || !this.root.visible) return;
    this._sync();
  }

  /** Tear down and remove from scene. Safe to call multiple times. */
  dispose(): void {
    this._domElement.removeEventListener('pointerdown', this._onPointerDown);
    this._domElement.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    this._removeReadout();
    // Dispose fill geometries + materials
    this._disc.geometry.dispose();
    (this._disc.material as MeshBasicMaterial).dispose();
    this._ring.geometry.dispose();
    (this._ring.material as MeshBasicMaterial).dispose();
    // Axis handles are Groups with child Meshes — traverse to dispose
    for (const axis of [this._axisX, this._axisXPicker, this._axisY, this._axisYPicker, this._axisZ, this._axisZPicker]) {
      axis.traverse((n) => {
        const m = n as Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material && (m.material as MeshBasicMaterial).dispose) (m.material as MeshBasicMaterial).dispose();
      });
    }
    this._axisXMat.dispose();
    this._axisYMat.dispose();
    this._axisZMat.dispose();
    // Dispose outline geometries (children of disc/ring) + materials
    this._disc.traverse((n) => { const g = (n as LineLoop).geometry; if (g) g.dispose(); });
    this._ring.traverse((n) => { const g = (n as LineLoop).geometry; if (g) g.dispose(); });
    this._discOutlineMat.dispose();
    this._ringInnerOutlineMat.dispose();
    this._ringOuterOutlineMat.dispose();
    this.root.parent?.remove(this.root);
  }

  // ─── Per-frame sync ──────────────────────────────────────────────────

  /** Position the gizmo at the target and rescale to constant screen size. */
  private _sync(): void {
    const target = this._target;
    if (!target) return;
    target.updateWorldMatrix(true, false);
    target.getWorldPosition(_v3a);
    this.root.position.copy(_v3a);
    // Always level on the floor — no inheritance of target rotation.
    this.root.quaternion.identity();

    // Scale-invariant: choose root.scale so that 1 unit at the gizmo's depth
    // corresponds to DISC_SCREEN_RADIUS_PX pixels on screen.
    const cam = this._camera;
    const distance = cam.position.distanceTo(_v3a);
    const canvasH = this._renderer.domElement.clientHeight;
    let worldPerPx: number;
    const persp = cam as PerspectiveCamera;
    if (persp.isPerspectiveCamera) {
      const fovRad = persp.fov * MathUtils.DEG2RAD;
      worldPerPx = (2 * Math.tan(fovRad / 2) * distance) / canvasH;
    } else {
      const ortho = cam as OrthographicCamera;
      worldPerPx = (ortho.top - ortho.bottom) / ortho.zoom / canvasH;
    }
    const radius = DISC_SCREEN_RADIUS_PX * worldPerPx;
    this.root.scale.setScalar(radius);
    this.root.updateMatrixWorld(true);
  }

  // ─── Pointer handling ────────────────────────────────────────────────

  private _handlePointerDown(e: PointerEvent): void {
    if (!this._enabled || !this._target || e.button !== 0) return;
    const handle = this._raycastHandle(e);
    if (!handle) return;
    e.preventDefault();
    e.stopPropagation();
    this._beginDrag(handle, e);
  }

  private _handlePointerMove(e: PointerEvent): void {
    if (!this._enabled || !this._target) return;

    if (this._dragging) {
      this._updateDrag(e);
      return;
    }

    // Hover detection
    const handle = this._raycastHandle(e);
    this._setHovered(handle);
  }

  private _handlePointerUp(_e: PointerEvent): void {
    if (this._dragging) this._endDrag();
  }

  /**
   * Raycast against gizmo handles. Returns the handle type or null.
   * Priority: axis pickers first (they sit on top of disc), then disc, then ring.
   */
  private _raycastHandle(e: PointerEvent): Handle | null {
    if (!this.root.visible) return null;
    pointerToNDC(e.clientX, e.clientY, this._domElement, _ndcPointer);
    _raycaster.setFromCamera(_ndcPointer, this._camera);

    // Axis pickers first (Groups with invisible child meshes for easy clicking)
    if (this._yAxisEnabled) {
      const axisYHits = _raycaster.intersectObject(this._axisYPicker, true);
      if (axisYHits.length > 0) return 'axis-y';
    }
    const axisXHits = _raycaster.intersectObject(this._axisXPicker, true);
    if (axisXHits.length > 0) return 'axis-x';
    const axisZHits = _raycaster.intersectObject(this._axisZPicker, true);
    if (axisZHits.length > 0) return 'axis-z';

    // Disc (it's inside the ring footprint).
    const discHits = _raycaster.intersectObject(this._disc, false);
    if (discHits.length > 0) return 'disc';
    const ringHits = _raycaster.intersectObject(this._ring, false);
    if (ringHits.length > 0) return 'ring';
    return null;
  }

  // ─── Hover state ─────────────────────────────────────────────────────

  private _setHovered(handle: Handle | null): void {
    if (this._hovered === handle) return;
    this._hovered = handle;
    this._refreshOpacity();
    this._refreshCursor();
  }

  /** Pick a cursor based on current drag/hover state. */
  private _refreshCursor(): void {
    if (this._dragging) {
      this._domElement.style.cursor = CURSOR_DRAGGING;
      return;
    }
    if (this._hovered === 'disc') this._domElement.style.cursor = CURSOR_TRANSLATE;
    else if (this._hovered === 'ring') this._domElement.style.cursor = CURSOR_ROTATE;
    else if (this._hovered === 'axis-x') this._domElement.style.cursor = CURSOR_AXIS_X;
    else if (this._hovered === 'axis-y') this._domElement.style.cursor = CURSOR_AXIS_Y;
    else if (this._hovered === 'axis-z') this._domElement.style.cursor = CURSOR_AXIS_Z;
    else this._domElement.style.cursor = '';
  }

  private _refreshOpacity(): void {
    const discFill = this._disc.material as MeshBasicMaterial;
    const ringFill = this._ring.material as MeshBasicMaterial;
    const discState = this._dragging === 'disc' ? 'drag' : this._hovered === 'disc' ? 'hover' : 'idle';
    const ringState = this._dragging === 'ring' ? 'drag' : this._hovered === 'ring' ? 'hover' : 'idle';
    const axisXState = this._dragging === 'axis-x' ? 'drag' : this._hovered === 'axis-x' ? 'hover' : 'idle';
    const axisZState = this._dragging === 'axis-z' ? 'drag' : this._hovered === 'axis-z' ? 'hover' : 'idle';

    discFill.opacity = fillOpacityFor(discState);
    ringFill.opacity = fillOpacityFor(ringState);
    this._discOutlineMat.opacity = outlineOpacityFor(discState);
    this._ringInnerOutlineMat.opacity = outlineOpacityFor(ringState);
    this._ringOuterOutlineMat.opacity = outlineOpacityFor(ringState);

    // Axis arrows are fully opaque — hover is signaled by color change only.
    this._axisXMat.color.setHex(axisXState === 'idle' ? COLOR_AXIS_X : COLOR_AXIS_X_HOVER);
    const axisYState = this._dragging === 'axis-y' ? 'drag' : this._hovered === 'axis-y' ? 'hover' : 'idle';
    this._axisYMat.color.setHex(axisYState === 'idle' ? COLOR_AXIS_Y : COLOR_AXIS_Y_HOVER);
    this._axisZMat.color.setHex(axisZState === 'idle' ? COLOR_AXIS_Z : COLOR_AXIS_Z_HOVER);
  }

  // ─── Drag lifecycle ──────────────────────────────────────────────────

  private _beginDrag(handle: Handle, e: PointerEvent): void {
    const target = this._target!;
    target.updateWorldMatrix(true, false);
    target.getWorldPosition(this._dragStartTargetPos);
    target.getWorldQuaternion(this._dragStartTargetQuat);

    if (handle === 'axis-y') {
      // Vertical plane facing camera for Y-axis drag
      _camDir.copy(this._camera.position).sub(this._dragStartTargetPos);
      _camDir.y = 0; // keep plane vertical
      _camDir.normalize();
      _verticalPlane.setFromNormalAndCoplanarPoint(_camDir, this._dragStartTargetPos);
      if (!this._raycastPlane(e, _verticalPlane, this._dragStartHitWorld)) return;
    } else {
      // Floor plane at the target's current Y, normal up.
      _floorPlane.setComponents(0, 1, 0, -this._dragStartTargetPos.y);
      if (!this._raycastFloor(e, this._dragStartHitWorld)) return;
    }

    if (handle === 'ring') {
      // Initial angle from gizmo center to cursor in floor plane.
      this._dragStartAngle = Math.atan2(
        this._dragStartHitWorld.z - this._dragStartTargetPos.z,
        this._dragStartHitWorld.x - this._dragStartTargetPos.x,
      );
    }

    this._dragging = handle;
    this._refreshOpacity();
    this._refreshCursor();
    this._showReadout(e);
    this.onDraggingChanged?.(true);
  }

  private _updateDrag(e: PointerEvent): void {
    const target = this._target;
    if (!target || !this._dragging) return;

    // Y-axis drag uses a vertical plane facing the camera
    if (this._dragging === 'axis-y') {
      this._updateDragY(e);
      return;
    }

    if (!this._raycastFloor(e, _v3a)) return;

    if (this._dragging === 'disc' || this._dragging === 'axis-x' || this._dragging === 'axis-z') {
      // Translation: delta in floor plane, optionally constrained to one axis.
      const dx = _v3a.x - this._dragStartHitWorld.x;
      const dz = _v3a.z - this._dragStartHitWorld.z;

      let nx: number;
      let nz: number;

      if (this._dragging === 'axis-x') {
        // X-only: apply dx, keep Z fixed
        nx = this._dragStartTargetPos.x + dx;
        nz = this._dragStartTargetPos.z;
      } else if (this._dragging === 'axis-z') {
        // Z-only: apply dz, keep X fixed
        nx = this._dragStartTargetPos.x;
        nz = this._dragStartTargetPos.z + dz;
      } else {
        // Free XZ movement (disc)
        nx = this._dragStartTargetPos.x + dx;
        nz = this._dragStartTargetPos.z + dz;
      }

      // Custom (magnetic) snap runs first; per-axis result overrides the
      // grid quantizer for any axis it claims. Axes the custom snap leaves
      // alone fall through to the grid as before.
      const axisLock: SnapAxisLock =
        this._dragging === 'axis-x' ? 'x'
        : this._dragging === 'axis-z' ? 'z'
        : 'free';
      const custom = this._customSnap?.(nx, nz, axisLock) ?? null;
      if (custom?.snappedX) nx = custom.x;
      if (custom?.snappedZ) nz = custom.z;
      if (this._translationSnap && this._translationSnap > 0) {
        if (this._dragging !== 'axis-z' && !custom?.snappedX) {
          nx = Math.round(nx / this._translationSnap) * this._translationSnap;
        }
        if (this._dragging !== 'axis-x' && !custom?.snappedZ) {
          nz = Math.round(nz / this._translationSnap) * this._translationSnap;
        }
      }

      this._setTargetWorldPositionXZ(target, nx, nz);

      // Readout: show only constrained axis or both
      if (this._dragging === 'axis-x') {
        this._updateReadout(e, `Δx ${formatM(nx - this._dragStartTargetPos.x)}`);
      } else if (this._dragging === 'axis-z') {
        this._updateReadout(e, `Δz ${formatM(nz - this._dragStartTargetPos.z)}`);
      } else {
        this._updateReadout(e, `Δx ${formatM(nx - this._dragStartTargetPos.x)}   Δz ${formatM(nz - this._dragStartTargetPos.z)}`);
      }
    } else {
      // Rotation: delta angle around target Y.
      const angle = Math.atan2(
        _v3a.z - this._dragStartTargetPos.z,
        _v3a.x - this._dragStartTargetPos.x,
      );
      let delta = this._dragStartAngle - angle; // visual: drag CW = rotate CW
      if (this._rotationSnap && this._rotationSnap > 0) {
        delta = Math.round(delta / this._rotationSnap) * this._rotationSnap;
      }
      this._setTargetWorldRotationY(target, this._dragStartTargetQuat, delta);
      this._updateReadout(e, `Δ ${formatDeg(delta)}`);
    }

    this.onChange?.();
  }

  /** Handle Y-axis vertical drag — move object up/down. */
  private _updateDragY(e: PointerEvent): void {
    const target = this._target;
    if (!target) return;

    if (!this._raycastPlane(e, _verticalPlane, _v3a)) return;

    let ny = this._dragStartTargetPos.y + (_v3a.y - this._dragStartHitWorld.y);
    if (ny < 0) ny = 0; // don't go below floor

    if (this._translationSnap && this._translationSnap > 0) {
      ny = Math.round(ny / this._translationSnap) * this._translationSnap;
    }

    // Set world Y, keep XZ unchanged
    const parent = target.parent;
    if (!parent) {
      target.position.y = ny;
    } else {
      parent.updateWorldMatrix(true, false);
      _v3b.set(this._dragStartTargetPos.x, ny, this._dragStartTargetPos.z);
      parent.worldToLocal(_v3b);
      target.position.y = _v3b.y;
    }

    this._updateReadout(e, `\u0394y ${formatM(ny - this._dragStartTargetPos.y)}`);
    this.onChange?.();
  }

  private _endDrag(): void {
    this._dragging = null;
    this._refreshOpacity();
    this._refreshCursor();
    this._removeReadout();
    this.onDraggingChanged?.(false);
    this.onDragEnd?.();
  }

  /** Raycast the cursor against an arbitrary plane; writes the world-space hit to `out`. */
  private _raycastPlane(e: PointerEvent, plane: Plane, out: Vector3): boolean {
    pointerToNDC(e.clientX, e.clientY, this._domElement, _ndcPointer);
    _raycaster.setFromCamera(_ndcPointer, this._camera);
    const hit = _raycaster.ray.intersectPlane(plane, _projHelper);
    if (!hit) return false;
    out.copy(hit);
    return true;
  }

  /** Raycast the cursor into the floor plane; writes the world-space hit to `out`. */
  private _raycastFloor(e: PointerEvent, out: Vector3): boolean {
    pointerToNDC(e.clientX, e.clientY, this._domElement, _ndcPointer);
    _raycaster.setFromCamera(_ndcPointer, this._camera);
    const hit = _raycaster.ray.intersectPlane(_floorPlane, _projHelper);
    if (!hit) return false;
    out.copy(hit);
    return true;
  }

  /**
   * Set target's WORLD position in the XZ plane (preserving Y), regardless
   * of how deep the target sits in a parent hierarchy.
   */
  private _setTargetWorldPositionXZ(target: Object3D, worldX: number, worldZ: number): void {
    const parent = target.parent;
    if (!parent) {
      target.position.set(worldX, this._dragStartTargetPos.y, worldZ);
      return;
    }
    parent.updateWorldMatrix(true, false);
    _v3b.set(worldX, this._dragStartTargetPos.y, worldZ);
    parent.worldToLocal(_v3b);
    target.position.copy(_v3b);
  }

  /**
   * Set target's WORLD rotation by composing a Y-axis rotation `delta` onto
   * the start orientation `q0`. Converts to parent-local on assignment.
   */
  private readonly _qDelta = new Quaternion();
  private readonly _qWorld = new Quaternion();
  private readonly _qParent = new Quaternion();
  private _setTargetWorldRotationY(target: Object3D, q0: Quaternion, deltaRad: number): void {
    this._qDelta.setFromAxisAngle(_AXIS_Y, deltaRad);
    this._qWorld.copy(this._qDelta).multiply(q0);
    const parent = target.parent;
    if (!parent) {
      target.quaternion.copy(this._qWorld);
      return;
    }
    parent.getWorldQuaternion(this._qParent).invert();
    target.quaternion.copy(this._qParent).multiply(this._qWorld);
  }

  // ─── Readout HUD ─────────────────────────────────────────────────────

  private _showReadout(e: PointerEvent): void {
    if (this._readoutEl) return;
    const el = document.createElement('div');
    el.style.cssText = `
      position: fixed; pointer-events: none; z-index: 10000;
      background: rgba(20,30,20,0.85); color: #c9ffc9;
      font: 12px/1.3 ui-monospace, monospace;
      padding: 4px 8px; border-radius: 4px;
      border: 1px solid rgba(120,255,120,0.4);
      transform: translate(12px, 18px);
      white-space: nowrap;
    `;
    document.body.appendChild(el);
    this._readoutEl = el;
    this._updateReadout(e, '');
  }

  private _updateReadout(e: PointerEvent, text: string): void {
    if (!this._readoutEl) return;
    this._readoutEl.style.left = `${e.clientX}px`;
    this._readoutEl.style.top = `${e.clientY}px`;
    if (text) this._readoutEl.textContent = text;
  }

  private _removeReadout(): void {
    if (!this._readoutEl) return;
    this._readoutEl.remove();
    this._readoutEl = null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const _AXIS_Y = new Vector3(0, 1, 0);

/**
 * Build a closed line loop in the XY plane (z=0) at the given radius.
 * The disc/ring meshes are rotated -π/2 around X, so this loop ends up
 * lying flat on the XZ floor when added as a child.
 */
function makeCircleGeometry(radius: number, segments: number): BufferGeometry {
  const positions = new Float32Array(segments * 3);
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    positions[i * 3] = Math.cos(a) * radius;
    positions[i * 3 + 1] = Math.sin(a) * radius;
    positions[i * 3 + 2] = 0;
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return geo;
}

function makeOutlineMaterial(): LineBasicMaterial {
  const mat = new LineBasicMaterial({
    color: COLOR_OUTLINE,
    transparent: true,
    opacity: OUTLINE_OPACITY_IDLE,
    depthTest: false,
    depthWrite: false,
    linewidth: 1, // WebGL ignores >1 but Line2 would; kept for completeness
  });
  mat.name = '_floorGizmoOutline';
  return mat;
}

/**
 * Create a single axis arrow (visual + invisible picker) for the FloorGizmo.
 *
 * Visual: two cylindrical shafts (positive + negative direction) capped with
 * cone arrowheads. CylinderGeometry / ConeGeometry default axis is +Y; we
 * rotate around Z by ±π/2 to align them with local X. The parent Group's
 * own -π/2 X rotation (applied by the caller) then flattens everything onto
 * the floor for X / Z axes.
 *
 * Picker: two wider 3D boxes (not paper-thin) so cursor hits register no
 * matter the camera angle.
 */
function makeAxisBar(
  handleName: string,
  color: number,
  armLength: number,
  pickerHalfWidth: number,
): { visual: Mesh; picker: Mesh; material: MeshBasicMaterial } {
  // armLength is the visible arrow length (shaft + cone). Each X/Z arm starts
  // at the ring outer edge and extends `armLength` outward to the tip.
  // Cone occupies a fraction of each arm, capped by AXIS_TIP_MAX_LENGTH.
  const tipLength = Math.min(armLength * AXIS_TIP_FRACTION, AXIS_TIP_MAX_LENGTH);
  const shaftLength = Math.max(0.001, armLength - tipLength);
  // Distances along +X / -X from gizmo center
  const shaftCenter = RING_OUTER_FACTOR + shaftLength / 2;
  const tipCenter = RING_OUTER_FACTOR + shaftLength + tipLength / 2;

  const visualMat = new MeshBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
  });
  visualMat.name = `_floorGizmo_${handleName}`;

  // Geometries are shared between +/- segments — same shape, different transforms
  const shaftGeo = new CylinderGeometry(
    AXIS_SHAFT_RADIUS, AXIS_SHAFT_RADIUS, shaftLength, AXIS_RADIAL_SEGMENTS,
  );
  const tipGeo = new ConeGeometry(AXIS_TIP_RADIUS, tipLength, AXIS_RADIAL_SEGMENTS);

  const visual = new Group();
  // +X direction: rotate.z = -π/2 maps cylinder's local +Y → world +X.
  const shaftPos = new Mesh(shaftGeo, visualMat);
  shaftPos.position.x = shaftCenter;
  shaftPos.rotation.z = -Math.PI / 2;
  shaftPos.renderOrder = 10001;
  shaftPos.frustumCulled = false;
  const tipPos = new Mesh(tipGeo, visualMat);
  tipPos.position.x = tipCenter;
  tipPos.rotation.z = -Math.PI / 2;
  tipPos.renderOrder = 10001;
  tipPos.frustumCulled = false;
  // -X direction: rotate.z = +π/2 maps cone's local +Y → -X (so arrowhead points outward).
  const shaftNeg = new Mesh(shaftGeo, visualMat);
  shaftNeg.position.x = -shaftCenter;
  shaftNeg.rotation.z = Math.PI / 2;
  shaftNeg.renderOrder = 10001;
  shaftNeg.frustumCulled = false;
  const tipNeg = new Mesh(tipGeo, visualMat);
  tipNeg.position.x = -tipCenter;
  tipNeg.rotation.z = Math.PI / 2;
  tipNeg.renderOrder = 10001;
  tipNeg.frustumCulled = false;
  visual.add(shaftPos, tipPos, shaftNeg, tipNeg);
  visual.userData._floorGizmoHandle = handleName;

  // Picker: two 3D boxes (square cross-section, not paper-thin) so the hit
  // volume is the same from any camera angle. Length matches the full arm.
  const pickerMat = new MeshBasicMaterial({ visible: false });
  pickerMat.name = `_floorGizmo_${handleName}_picker`;
  const picker = new Group();
  const pickGeo = new BoxGeometry(armLength, pickerHalfWidth * 2, pickerHalfWidth * 2);
  const pickCenter = RING_OUTER_FACTOR + armLength / 2;
  const pick1 = new Mesh(pickGeo, pickerMat);
  pick1.position.x = pickCenter;
  const pick2 = new Mesh(pickGeo, pickerMat);
  pick2.position.x = -pickCenter;
  picker.add(pick1, pick2);
  picker.userData._floorGizmoHandle = handleName;

  return { visual: visual as unknown as Mesh, picker: picker as unknown as Mesh, material: visualMat };
}

/**
 * Single vertical arrow standing UP from the gizmo center (Y axis "pole").
 * Unlike makeAxisBar (which splits around the disc/ring), this arrow starts
 * at the origin and extends straight up along +Y. Cylinder/cone default axis
 * is already +Y, so no rotation needed on the meshes themselves.
 */
function makeVerticalBar(
  handleName: string,
  color: number,
  armLength: number,
  pickerHalfWidth: number,
): { visual: Mesh; picker: Mesh; material: MeshBasicMaterial } {
  const tipLength = Math.min(armLength * AXIS_TIP_FRACTION, AXIS_TIP_MAX_LENGTH);
  const shaftLength = Math.max(0.001, armLength - tipLength);

  const visualMat = new MeshBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
  });
  visualMat.name = `_floorGizmo_${handleName}`;

  const visual = new Group();
  const shaftGeo = new CylinderGeometry(
    AXIS_SHAFT_RADIUS, AXIS_SHAFT_RADIUS, shaftLength, AXIS_RADIAL_SEGMENTS,
  );
  const tipGeo = new ConeGeometry(AXIS_TIP_RADIUS, tipLength, AXIS_RADIAL_SEGMENTS);
  const shaft = new Mesh(shaftGeo, visualMat);
  shaft.position.y = shaftLength / 2;
  shaft.renderOrder = 10001;
  shaft.frustumCulled = false;
  const tip = new Mesh(tipGeo, visualMat);
  tip.position.y = shaftLength + tipLength / 2;
  tip.renderOrder = 10001;
  tip.frustumCulled = false;
  visual.add(shaft, tip);
  visual.userData._floorGizmoHandle = handleName;

  const pickerMat = new MeshBasicMaterial({ visible: false });
  pickerMat.name = `_floorGizmo_${handleName}_picker`;
  const pickerGeo = new BoxGeometry(pickerHalfWidth * 2, armLength, pickerHalfWidth * 2);
  const picker = new Mesh(pickerGeo, pickerMat);
  picker.position.y = armLength / 2;
  picker.userData._floorGizmoHandle = handleName;

  return { visual: visual as unknown as Mesh, picker, material: visualMat };
}

function fillOpacityFor(state: 'idle' | 'hover' | 'drag'): number {
  return state === 'drag' ? FILL_OPACITY_DRAG
    : state === 'hover' ? FILL_OPACITY_HOVER
    : FILL_OPACITY_IDLE;
}

function outlineOpacityFor(state: 'idle' | 'hover' | 'drag'): number {
  return state === 'drag' ? OUTLINE_OPACITY_DRAG
    : state === 'hover' ? OUTLINE_OPACITY_HOVER
    : OUTLINE_OPACITY_IDLE;
}

function formatM(v: number): string {
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}m`;
}

function formatDeg(rad: number): string {
  const deg = rad * MathUtils.RAD2DEG;
  const sign = deg >= 0 ? '+' : '';
  return `${sign}${deg.toFixed(0)}°`;
}
