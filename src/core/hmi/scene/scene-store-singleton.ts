// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SceneStore singleton holder.
 *
 * The SceneStore is created once in main.ts after the planner plugin is
 * registered, then read by TopBar and any other UI that needs to dispatch
 * scene loads. A singleton avoids prop-drilling through the React tree.
 */

import type { RVViewer } from '../../rv-viewer';
import { SceneStore } from './scene-store';

let _instance: SceneStore | null = null;

export function initSceneStore(viewer: RVViewer): SceneStore {
  if (!_instance) _instance = new SceneStore(viewer);
  return _instance;
}

export function getSceneStore(): SceneStore | null {
  return _instance;
}
