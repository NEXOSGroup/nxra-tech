// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { ControlsFacadeImpl } from '../src/core/facades/controls-facade';

function makeMockControls() {
  return {
    rotateSpeed: 1, panSpeed: 1, zoomSpeed: 1, dampingFactor: 0.05,
    enabled: true, target: new Vector3(),
  };
}

describe('ControlsFacadeImpl (plan-182 Phase 4a)', () => {
  it('setRotateSpeed/PanSpeed/ZoomSpeed/DampingFactor write to controls', () => {
    const controls = makeMockControls();
    const facade = new ControlsFacadeImpl({ controls } as never);
    facade.setRotateSpeed(2.5);
    facade.setPanSpeed(1.2);
    facade.setZoomSpeed(0.8);
    facade.setDampingFactor(0.1);
    expect(controls.rotateSpeed).toBe(2.5);
    expect(controls.panSpeed).toBe(1.2);
    expect(controls.zoomSpeed).toBe(0.8);
    expect(controls.dampingFactor).toBe(0.1);
  });

  it('setEnabled toggles controls.enabled', () => {
    const controls = makeMockControls();
    const facade = new ControlsFacadeImpl({ controls } as never);
    facade.setEnabled(false);
    expect(controls.enabled).toBe(false);
  });

  it('setTarget copies into controls.target (does not replace ref)', () => {
    const controls = makeMockControls();
    const facade = new ControlsFacadeImpl({ controls } as never);
    const ref = controls.target;
    facade.setTarget(new Vector3(1, 2, 3));
    expect(controls.target).toBe(ref);
    expect(controls.target.x).toBe(1);
  });

  it('setConfig applies only present fields', () => {
    const controls = makeMockControls();
    const facade = new ControlsFacadeImpl({ controls } as never);
    facade.setConfig({ rotateSpeed: 3 });
    expect(controls.rotateSpeed).toBe(3);
    expect(controls.panSpeed).toBe(1);  // unchanged
  });

  it('all setters are no-ops when controls is missing', () => {
    const facade = new ControlsFacadeImpl({ controls: null } as never);
    expect(() => facade.setRotateSpeed(99)).not.toThrow();
    expect(() => facade.setConfig({ panSpeed: 99 })).not.toThrow();
  });
});
