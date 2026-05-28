// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * CameraManager — Manages perspective/orthographic camera switching,
 * camera animation, viewport offset computation, and FOV control.
 *
 * Internal implementation detail of RVViewer — not part of public API.
 * Receives a reference to shared viewer state via ViewerCameraState.
 */

import {
  PerspectiveCamera,
  OrthographicCamera,
  Vector3,
  Box3,
  Matrix4,
  Mesh,
  Object3D,
} from 'three';
import type { Renderer } from 'three/webgpu';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ProjectionType } from './hmi/visual-settings-store';
import { INSPECTOR_PANEL_WIDTH } from './hmi/layout-constants';
import type { RvExtrasEditorPlugin } from './hmi/rv-extras-editor';
import type { LeftPanelManager } from './hmi/left-panel-manager';

/** Check if property inspector is in detached (floating) mode. */
function isInspectorDetached(): boolean {
  try { return localStorage.getItem('rv-inspector-detached') === 'true'; }
  catch { return false; }
}

/** Pixel offsets for panels obscuring the 3D viewport. */
export interface ViewportOffset {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

/** Shared state that CameraManager reads/writes on the facade. */
export interface ViewerCameraState {
  perspCamera: PerspectiveCamera;
  orthoCamera: OrthographicCamera;
  _activeCamera: PerspectiveCamera | OrthographicCamera;
  controls: OrbitControls;
  renderer: Renderer;
  _renderDirty: boolean;
  leftPanelManager: LeftPanelManager;
  getPlugin<T>(id: string): T | undefined;
}

/** Camera animation state. */
export interface CameraAnimation {
  startPos: Vector3;
  endPos: Vector3;
  startTgt: Vector3;
  endTgt: Vector3;
  elapsed: number;
  duration: number;
}

/**
 * Projection-swap animation state. Element-wise lerp between two camera
 * projection matrices. The intermediate matrices aren't strictly valid
 * projections, but the lerp visually reads as a smooth perspective ↔
 * orthographic crossfade.
 */
export interface ProjectionAnimation {
  /** Camera whose projectionMatrix we mutate during the tween. */
  driveCam: PerspectiveCamera | OrthographicCamera;
  fromMatrix: Matrix4;
  toMatrix: Matrix4;
  toType: ProjectionType;
  elapsed: number;
  duration: number;
}

/**
 * CameraManager handles perspective/orthographic switching,
 * smooth camera animations, FOV, and viewport offset computation.
 */
export class CameraManager {
  private state: ViewerCameraState;
  cameraAnim: CameraAnimation | null = null;
  projectionAnim: ProjectionAnimation | null = null;

  constructor(state: ViewerCameraState) {
    this.state = state;
  }

  // ─── FOV ──────────────────────────────────────────────────────────

  get fov(): number { return this.state.perspCamera.fov; }
  set fov(v: number) {
    this.state.perspCamera.fov = v;
    this.state.perspCamera.updateProjectionMatrix();
    if (this.state._activeCamera === this.state.orthoCamera) {
      this.syncOrthoFrustum();
    }
  }

  // ─── Projection ───────────────────────────────────────────────────

  get projection(): ProjectionType {
    return this.state._activeCamera === this.state.perspCamera ? 'perspective' : 'orthographic';
  }

  set projection(v: ProjectionType) {
    const wantPersp = v === 'perspective';
    const isPersp = this.state._activeCamera === this.state.perspCamera;
    if (wantPersp === isPersp) return;

    const oldCam = this.state._activeCamera;
    const newCam = wantPersp ? this.state.perspCamera : this.state.orthoCamera;

    newCam.position.copy(oldCam.position);
    newCam.quaternion.copy(oldCam.quaternion);

    if (!wantPersp) {
      this.syncOrthoFrustum();
    }

    this.state._activeCamera = newCam;
    (this.state.controls as unknown as { object: unknown }).object = newCam;
    this.state.controls.update();
  }

  syncOrthoFrustum(): void {
    const dist = this.state.orthoCamera.position.distanceTo(this.state.controls.target);
    const halfH = dist * Math.tan((this.state.perspCamera.fov * Math.PI / 180) / 2);
    const aspect = this.state.perspCamera.aspect;
    this.state.orthoCamera.left = -halfH * aspect;
    this.state.orthoCamera.right = halfH * aspect;
    this.state.orthoCamera.top = halfH;
    this.state.orthoCamera.bottom = -halfH;
    this.state.orthoCamera.updateProjectionMatrix();
  }

  // ─── Camera Animation ─────────────────────────────────────────────

  /** Whether a camera animation is currently in progress. */
  get isCameraAnimating(): boolean { return this.cameraAnim !== null; }

  /** Cancel any in-progress camera animation. */
  cancelCameraAnimation(): void {
    this.cameraAnim = null;
  }

  /**
   * Smoothly animate the camera to a new position and orbit target.
   */
  animateCameraTo(position: Vector3, target: Vector3, duration = 0.6): void {
    const xr = (this.state.renderer as unknown as Record<string, unknown>).xr as Record<string, unknown> | undefined;
    if (xr?.isPresenting) return;
    this.cameraAnim = {
      startPos: this.state._activeCamera.position.clone(),
      endPos: position.clone(),
      startTgt: this.state.controls.target.clone(),
      endTgt: target.clone(),
      elapsed: 0,
      duration,
    };
  }

  /** Advance camera animation by frame delta. */
  tickCameraAnimation(dtSec: number): void {
    if (!this.cameraAnim) return;
    this.cameraAnim.elapsed += dtSec;
    const t = Math.min(this.cameraAnim.elapsed / this.cameraAnim.duration, 1);
    const e = 1 - Math.pow(1 - t, 3); // Smooth ease-out (cubic)

    this.state._activeCamera.position.lerpVectors(this.cameraAnim.startPos, this.cameraAnim.endPos, e);
    this.state.controls.target.lerpVectors(this.cameraAnim.startTgt, this.cameraAnim.endTgt, e);

    if (t >= 1) this.cameraAnim = null;
  }

  // ─── Projection Animation ─────────────────────────────────────────

  /** Whether a projection-swap animation is currently in progress. */
  get isProjectionAnimating(): boolean { return this.projectionAnim !== null; }

  /**
   * Smoothly transition between perspective and orthographic. Element-wise
   * lerp between the two cameras' projection matrices over `duration`
   * seconds, then commit the actual camera swap. Visually this looks like
   * the perspective foreshortening fades out (or in) gradually.
   *
   * No-op if already in the requested mode. Restarts cleanly if called
   * again mid-animation.
   */
  animateProjectionTo(v: ProjectionType, duration = 0.4): void {
    const wantPersp = v === 'perspective';
    const isPersp = this.projection === 'perspective';
    if (wantPersp === isPersp && !this.projectionAnim) return;

    // The driver camera is the one we keep rendering with for the duration of
    // the tween — its projectionMatrix gets overwritten each frame. We always
    // drive with the CURRENT active camera so the renderer doesn't see a
    // mid-frame swap; the actual swap happens at t=1.
    const driveCam = this.state._activeCamera;
    const targetCam = wantPersp ? this.state.perspCamera : this.state.orthoCamera;

    // Bring the target into sync so its projection matrix is the visual
    // endpoint we're lerping toward.
    targetCam.position.copy(driveCam.position);
    targetCam.quaternion.copy(driveCam.quaternion);
    if (!wantPersp) this.syncOrthoFrustum();
    targetCam.updateProjectionMatrix();

    this.projectionAnim = {
      driveCam,
      fromMatrix: driveCam.projectionMatrix.clone(),
      toMatrix: targetCam.projectionMatrix.clone(),
      toType: v,
      elapsed: 0,
      duration,
    };
  }

  /** Cancel any in-progress projection animation; leaves whichever camera
   *  is currently active in place (matrix is restored by the next render
   *  pass via updateProjectionMatrix when needed). */
  cancelProjectionAnimation(): void {
    if (!this.projectionAnim) return;
    // Restore the drive camera's matrix so it isn't left mid-lerp.
    this.projectionAnim.driveCam.updateProjectionMatrix();
    this.projectionAnim = null;
  }

  /** Advance projection animation by frame delta. */
  tickProjectionAnimation(dtSec: number): void {
    const anim = this.projectionAnim;
    if (!anim) return;
    anim.elapsed += dtSec;
    const t = Math.min(anim.elapsed / anim.duration, 1);
    const e = 1 - Math.pow(1 - t, 3); // ease-out cubic

    // Element-wise lerp into the drive camera's projection matrix.
    const out = anim.driveCam.projectionMatrix.elements;
    const a = anim.fromMatrix.elements;
    const b = anim.toMatrix.elements;
    for (let i = 0; i < 16; i++) {
      out[i] = a[i] + (b[i] - a[i]) * e;
    }
    anim.driveCam.projectionMatrixInverse.copy(anim.driveCam.projectionMatrix).invert();

    if (t >= 1) {
      // Commit the actual camera swap (rebinds OrbitControls, restores the
      // target camera's clean projection matrix).
      this.projectionAnim = null;
      this.projection = anim.toType;
    }
  }

  // ─── Viewport Offset ──────────────────────────────────────────────

  /** Compute current viewport offset from open panels. */
  getCurrentViewportOffset(): ViewportOffset | undefined {
    let left = 0;

    const editorPlugin = this.state.getPlugin<RvExtrasEditorPlugin>('rv-extras-editor');
    if (editorPlugin) {
      const snapshot = editorPlugin.getSnapshot();
      if (snapshot.panelOpen) {
        // Only count inspector width when docked (not detached as floating window)
        const inspectorDocked = snapshot.selectedNodePath && snapshot.showInspector
          && !isInspectorDetached();
        left = snapshot.panelWidth + (inspectorDocked ? INSPECTOR_PANEL_WIDTH : 0);
      }
    }

    if (left === 0 && this.state.leftPanelManager.activePanelWidth > 0) {
      left = this.state.leftPanelManager.activePanelWidth;
    }

    return left > 0 ? { left } : undefined;
  }

  // ─── Focus & Fit ──────────────────────────────────────────────────

  /** Compute bounding box for a set of nodes. */
  computeNodeBounds(nodes: Object3D[]): Box3 {
    const box = new Box3();
    for (const node of nodes) {
      node.updateWorldMatrix(true, true);
      node.traverse((child) => {
        const m = child as Mesh;
        if (m.isMesh && m.geometry) {
          m.geometry.computeBoundingBox();
          if (m.geometry.boundingBox) {
            const mb = m.geometry.boundingBox.clone();
            mb.applyMatrix4(m.matrixWorld);
            box.union(mb);
          }
        }
      });
    }
    return box;
  }
}
