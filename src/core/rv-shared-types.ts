// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-shared-types.ts — Shared types that bridge core and plugin layers.
 *
 * Defines structural types referenced by `rv-viewer.ts` whose canonical
 * data shape originates in a plugin module. Hosting these types in core
 * eliminates the "core imports from plugin" layer violation while keeping
 * each plugin in charge of its own runtime code.
 *
 * Type-only re-imports from plugin modules (e.g. `PlacedComponent`) are
 * acceptable because they have zero runtime cost (TypeScript `import type`
 * is erased after compilation) and match the precedent already established
 * by `src/core/hmi/scene/rv-scene-edits.ts`.
 */

import type { PlacedComponent } from '../plugins/layout-planner/rv-layout-store';

/**
 * Lean placements snapshot — what the unified Scene model stores instead of
 * a full LayoutFile. No version/name/createdAt: those live on the enclosing
 * RvScene record.
 *
 * Produced by `LayoutPlannerPlugin.snapshotPlacements()` and consumed by
 * `RVViewer.loadScene()` to restore the planner state for a saved scene.
 */
export interface PlacementsSnapshot {
  placements: PlacedComponent[];
  catalogUrls: string[];
  gridSizeMm: number;
}
