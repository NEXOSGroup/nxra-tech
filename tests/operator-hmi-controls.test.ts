// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OperatorHmiControlsPlugin, OPERATOR_HMI_CONTEXT } from '../src/plugins/models/DemoRealvirtualWeb/operator-hmi-controls';
import { _resetStore, isUIElementVisible, getActiveContexts, isContextActive } from '../src/core/hmi/ui-context-store';
import { getHmiVisible, toggleHmiVisible } from '../src/core/hmi/hmi-visibility-store';

function setHmiVisible(v: boolean): void {
  if (getHmiVisible() !== v) toggleHmiVisible();
}

/** Whether the Play/Pause+Reset toolbar slot would render in the current context. */
function simToolbarVisible(): boolean {
  return isUIElementVisible('sim-controller-toolbar', getActiveContexts());
}

describe('OperatorHmiControlsPlugin', () => {
  let plugin: OperatorHmiControlsPlugin;

  beforeEach(() => {
    _resetStore();
    setHmiVisible(true);
    plugin = new OperatorHmiControlsPlugin();
  });

  afterEach(() => {
    plugin.dispose();
    setHmiVisible(true);
  });

  it('hides the engineering sim controls while HMI mode is on', () => {
    plugin.onModelLoaded();
    expect(isContextActive(OPERATOR_HMI_CONTEXT)).toBe(true);
    expect(simToolbarVisible()).toBe(false);
    expect(isUIElementVisible('sim-mode-toggle', getActiveContexts())).toBe(false);
  });

  it('shows the controls when HMI mode is toggled off, hides again when back on', () => {
    plugin.onModelLoaded();
    toggleHmiVisible();               // leave HMI mode (engineering view)
    expect(simToolbarVisible()).toBe(true);
    toggleHmiVisible();               // back to HMI mode
    expect(simToolbarVisible()).toBe(false);
  });

  it('restores visibility on dispose', () => {
    plugin.onModelLoaded();
    expect(simToolbarVisible()).toBe(false);
    plugin.dispose();
    expect(isContextActive(OPERATOR_HMI_CONTEXT)).toBe(false);
    expect(simToolbarVisible()).toBe(true);
  });

  it('leaves the controls visible for models that never register the plugin', () => {
    // No onModelLoaded() → no rule registered → slot is always visible.
    expect(simToolbarVisible()).toBe(true);
  });
});
