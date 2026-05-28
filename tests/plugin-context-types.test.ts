// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Phase 3 of plan-182: PluginContext interface surface.
 * Pure type-level test via expectTypeOf.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  PluginContext,
  SceneFacade,
  CameraFacade,
  ControlsFacade,
  TransportFacade,
  SimLoopFacade,
} from '../src/core/rv-plugin-context';
import { TickStage } from '../src/core/rv-plugin-context';
import type { Vector3, Object3D } from 'three';

describe('PluginContext type surface (plan-182 Phase 3)', () => {
  it('PluginContext exposes the expected fields', () => {
    expectTypeOf<PluginContext['scene']>().toEqualTypeOf<SceneFacade>();
    expectTypeOf<PluginContext['camera']>().toEqualTypeOf<CameraFacade>();
    expectTypeOf<PluginContext['controls']>().toEqualTypeOf<ControlsFacade>();
    expectTypeOf<PluginContext['simLoop']>().toEqualTypeOf<SimLoopFacade>();
    expectTypeOf<PluginContext['transport']>().toEqualTypeOf<TransportFacade | null>();
  });

  it('SceneFacade.eachNode has expected signature', () => {
    type Fn = SceneFacade['eachNode'];
    expectTypeOf<Fn>().parameters.toEqualTypeOf<[(node: Object3D, path: string) => void]>();
    expectTypeOf<Fn>().returns.toBeVoid();
  });

  it('CameraFacade.getCameraState supports out-param', () => {
    type Fn = CameraFacade['getCameraState'];
    expectTypeOf<Fn>().parameter(0).toEqualTypeOf<{ position: Vector3; target: Vector3 } | undefined>();
  });

  it('SimLoopFacade.onTick uses TickStage and returns disposer', () => {
    type Fn = SimLoopFacade['onTick'];
    expectTypeOf<Fn>().parameter(0).toEqualTypeOf<TickStage>();
    expectTypeOf<Fn>().returns.toEqualTypeOf<() => void>();
  });

  it('TickStage re-export matches Phase 0 enum', () => {
    expect(TickStage.PRE).toBe(0);
    expect(TickStage.SIM).toBe(1);
    expect(TickStage.POST).toBe(2);
  });
});
