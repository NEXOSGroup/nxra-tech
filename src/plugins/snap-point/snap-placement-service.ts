// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SnapPlacementService — validates and executes snap-aligned placement.
 *
 * Validation rules (canPlace):
 *   - Asset must have uniform scale (epsilon 1e-4) — Matrix4.decompose
 *     misbehaves with non-uniform scale (Three.js issue #3845).
 *   - Target snap must not be occupied.
 *   - Asset must contain the named snap.
 *
 * Placement (place) is delegated to a caller-supplied executor so the
 * service stays decoupled from layout-planner internals.
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { SnapPoint, SnapPointRegistry } from '../../core/engine/rv-snap-point-registry';
import { parseSnapName, flowsCompatible } from './snap-name-parser';

export interface CanPlaceResult {
  ok: boolean;
  reason?: string;
}

const UNIFORM_SCALE_EPS = 1e-4;

export class SnapPlacementService {
  private readonly viewer: RVViewer;
  private readonly registry: SnapPointRegistry;

  constructor(viewer: RVViewer, registry: SnapPointRegistry) {
    this.viewer = viewer;
    this.registry = registry;
  }

  /**
   * Validate a placement. Returns { ok: true } on success or
   * { ok: false, reason: 'non-uniform scale' | 'occupied' | 'missing snap' }.
   *
   * @param target          The target snap (already in the scene)
   * @param assetRoot       The library asset root about to be placed
   * @param ownSnapName     The name of the snap inside the asset to pair
   */
  canPlace(
    target: SnapPoint,
    assetRoot: Object3D,
    ownSnapName: string,
  ): CanPlaceResult {
    // Occupied
    if (target.occupied) {
      return { ok: false, reason: 'Target snap is already occupied' };
    }

    // Uniform scale
    const s = assetRoot.scale;
    if (
      Math.abs(s.x - s.y) > UNIFORM_SCALE_EPS ||
      Math.abs(s.x - s.z) > UNIFORM_SCALE_EPS ||
      Math.abs(s.y - s.z) > UNIFORM_SCALE_EPS
    ) {
      return {
        ok: false,
        reason: `Asset has non-uniform scale (${s.x}, ${s.y}, ${s.z}) — snap placement not possible`,
      };
    }

    // Asset must contain the named snap
    const ownSnap = this._findOwnSnap(assetRoot, ownSnapName);
    if (!ownSnap) {
      return { ok: false, reason: `Snap point '${ownSnapName}' not found in asset` };
    }

    // Compatibility check:
    //   1. same typeId
    //   2. flow-compatible (in↔out, bidi↔any; in↔in / out↔out rejected)
    // Axis direction code is intentionally NOT validated — outward axis comes
    // from the snap's position relative to its asset root, not from the name.
    const parsedOwn = parseSnapName(ownSnap.name);
    if (parsedOwn) {
      if (parsedOwn.typeId !== target.typeId) {
        return {
          ok: false,
          reason: `Snap '${ownSnapName}' has typeId '${parsedOwn.typeId}', target needs '${target.typeId}'`,
        };
      }
      if (!flowsCompatible(target.flow, parsedOwn.flow)) {
        return {
          ok: false,
          reason: `Flow mismatch: target is '${target.flow ?? 'bidi'}', '${ownSnapName}' is '${parsedOwn.flow}' (need in↔out or bidi pairing)`,
        };
      }
    }
    return { ok: true };
  }

  /** Find a snap inside an asset by name (traverses children). */
  private _findOwnSnap(assetRoot: Object3D, name: string): Object3D | null {
    let found: Object3D | null = null;
    assetRoot.traverse((n) => {
      if (!found && n.name === name) found = n;
    });
    return found;
  }

  /** Public helper for the executor flow. */
  findOwnSnap(assetRoot: Object3D, name: string): Object3D | null {
    return this._findOwnSnap(assetRoot, name);
  }

  /** Get the registry for the executor. */
  getRegistry(): SnapPointRegistry { return this.registry; }

  /** Get the viewer for the executor. */
  getViewer(): RVViewer { return this.viewer; }

  dispose(): void { /* no-op for now */ }
}
