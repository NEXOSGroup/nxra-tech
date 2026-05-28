// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Model plugins for the DemoProcessIndustry demo scene.
 *
 * Activates the ProcessIndustryPlugin when DemoProcessIndustry.glb is loaded.
 */

import type { RVViewer } from '../../../core/rv-viewer';
import type { ModelPluginModule } from '../../../core/rv-model-plugin-manager';

import { ProcessIndustryPlugin } from '../../processindustry-plugin';
import { TankFillHistoryPlugin } from '../../tank-fill-history-plugin';
import { PipeColoringPlugin } from '../../pipe-coloring-plugin';
import { ProcessingUnitModePlugin } from '../../processing-unit-mode-plugin';
import { FpvPlugin } from '../../fpv-plugin';

/** Model filenames (without .glb) that this module handles. */
export const models = [
  'DemoProcessIndustry',
  'demoprocessindustry',
  // Legacy / alternate casing kept for backward compatibility.
  'DemoProcessIndustryPlant',
  'demoprocessindustryplant',
];

/** Default environment preset applied on every load of this model — gives the
 *  pumping plant a soft outdoor look (sky background, olive-green floor). The
 *  user can still override it via the Environment settings tab. */
export const defaultEnvironmentPreset = 'Outdoor' as const;

const registeredIds: string[] = [];

export function registerModelPlugins(viewer: RVViewer): void {
  // Order matters: ProcessIndustryPlugin must be use()d first so the
  // TankFillHistoryPlugin can resolve it via viewer.getPlugin() during
  // its own onModelLoaded.
  const instances = [
    new ProcessIndustryPlugin(),
    new TankFillHistoryPlugin(),
    new PipeColoringPlugin(),
    new ProcessingUnitModePlugin(),
    // Walk-through exploration — lets users get inside the plant.
    new FpvPlugin(),
  ];
  for (const p of instances) {
    viewer.use(p);
    registeredIds.push(p.id);
  }
}

export function unregisterModelPlugins(viewer: RVViewer): void {
  for (const id of registeredIds) {
    viewer.removePlugin(id);
  }
  registeredIds.length = 0;
}

export default { models, defaultEnvironmentPreset, registerModelPlugins, unregisterModelPlugins } satisfies ModelPluginModule;
