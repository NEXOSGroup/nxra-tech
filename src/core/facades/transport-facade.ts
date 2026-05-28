// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TransportFacadeImpl — read-only iteration over TransportSurfaces.
 * Phase 4a of plan-182.
 *
 * RVTransportManager.surfaces is an array (not a Map). Paths are resolved via
 * NodeRegistry.getPathForNode using the surface's .node property.
 */

import type { TransportFacade } from '../rv-plugin-context';
import type { RVTransportSurface } from '../engine/rv-transport-surface';
import type { RVTransportManager } from '../engine/rv-transport-manager';
import type { NodeRegistry } from '../engine/rv-node-registry';

export class TransportFacadeImpl implements TransportFacade {
  constructor(
    private readonly _manager: RVTransportManager,
    private readonly _registry: NodeRegistry | null,
  ) {}

  forEachSurface(fn: (surface: RVTransportSurface, path: string) => void): void {
    for (const surface of this._manager.surfaces) {
      const path = this._registry?.getPathForNode(surface.node) ?? surface.node.name;
      fn(surface, path);
    }
  }

  getSurfaceByPath(path: string): RVTransportSurface | null {
    for (const surface of this._manager.surfaces) {
      const surfacePath = this._registry?.getPathForNode(surface.node) ?? surface.node.name;
      if (surfacePath === path) return surface;
    }
    return null;
  }
}
