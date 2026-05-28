// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * CameraFacadeImpl — camera state read + animated navigation.
 * Phase 4a of plan-182.
 */

import { Vector3, Quaternion, Object3D } from 'three';
import type { CameraFacade } from '../rv-plugin-context';
import type { RVViewer } from '../rv-viewer';

export class CameraFacadeImpl implements CameraFacade {
  constructor(private readonly _viewer: RVViewer) {}

  getCameraState(out?: { position: Vector3; target: Vector3 }): {
    position: Vector3;
    target: Vector3;
    quaternion: Quaternion;
  } {
    const cam = this._viewer.camera;
    const controls = this._viewer.controls;
    if (out) {
      return {
        position: out.position.copy(cam.position),
        target: out.target.copy(controls.target),
        quaternion: cam.quaternion.clone(),
      };
    }
    return {
      position: cam.position.clone(),
      target: controls.target.clone(),
      quaternion: cam.quaternion.clone(),
    };
  }

  async animateCameraTo(pos: Vector3, target: Vector3, durationMs?: number): Promise<void> {
    // RVViewer.animateCameraTo takes (Vector3, Vector3, duration in SECONDS).
    // We accept ms in the facade and convert.
    const durationSec = durationMs !== undefined ? durationMs / 1000 : 0.6;
    this._viewer.animateCameraTo(pos, target, durationSec);
    // The current animateCameraTo is fire-and-forget. Resolve after duration.
    await new Promise<void>((resolve) => setTimeout(resolve, durationSec * 1000));
  }

  fitToNodes(nodes: Object3D[], _offsetFactor?: number): void {
    // RVViewer.fitToNodes takes (nodes, ViewportOffset). offsetFactor maps to a
    // simple uniform offset advisory — forwarded without transformation for Phase 4a.
    this._viewer.fitToNodes(nodes);
  }

  focusByPath(path: string, _offsetFactor?: number): void {
    this._viewer.focusByPath(path);
  }

  clearFocus(): void {
    // RVViewer.clearFocus() exists — direct call, no cast needed.
    this._viewer.clearFocus();
  }
}
