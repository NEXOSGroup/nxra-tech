// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi } from 'vitest';
import { Object3D, MathUtils } from 'three';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { AABB } from '../src/core/engine/rv-aabb';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import type { EventEmitter } from '../src/core/rv-events';
import type { ViewerEvents } from '../src/core/rv-viewer-events';

/** Build the minimal ComponentContext the sensor needs to `init()`. */
function makeCtx(opts: { withEvents?: boolean } = {}): {
  ctx: ComponentContext;
  events: EventEmitter<ViewerEvents> | null;
  fire: (e: ViewerEvents['layout-transform-update']) => void;
} {
  // Tiny mock — we only need `.on(name, cb) → unsub`. The cast keeps the
  // ComponentContext shape happy; `RVSensor` only touches the bits we provide.
  let listener: ((data: ViewerEvents['layout-transform-update']) => void) | null = null;
  const events = opts.withEvents
    ? ({
        on: (_name: string, cb: (data: ViewerEvents['layout-transform-update']) => void) => {
          listener = cb;
          return () => { listener = null; };
        },
      } as unknown as EventEmitter<ViewerEvents>)
    : null;

  const ctx = {
    signalStore: { register: () => {}, set: () => {}, setByPath: () => {} },
    transportManager: { sensors: [] as RVSensor[] },
    events: events ?? undefined,
  } as unknown as ComponentContext;
  return {
    ctx,
    events,
    fire: (e) => listener?.(e),
  };
}

/**
 * Build a sensor whose node sits under a LayoutObject root. BoxCollider offset
 * is along local +Z so we can detect parent rotation cleanly (the offset
 * direction visibly changes in world space).
 */
function buildSensor(opts: { useRaycast?: boolean; boxColliderOffsetZ?: number }): {
  sensor: RVSensor;
  root: Object3D;
  node: Object3D;
} {
  // computeNodePath stops one short of the topmost root (treats it as "scene"),
  // so a real-looking three-level chain is needed for paths like
  // "LayoutRoot/Sensor" — otherwise we'd just get "Sensor" and the ancestor
  // prefix match wouldn't fire.
  const scene = new Object3D();
  scene.name = 'Scene';
  const root = new Object3D();
  root.name = 'LayoutRoot';
  root.userData.realvirtual = { LayoutObject: { Label: 'x', CatalogId: 'c', Locked: false } };
  const node = new Object3D();
  node.name = 'Sensor';
  scene.add(root);
  root.add(node);

  const offsetZ = opts.boxColliderOffsetZ ?? 0.5;
  const center = { x: 0, y: 0, z: offsetZ };
  const size = { x: 0.2, y: 0.2, z: 0.2 };
  const aabb = AABB.fromBoxCollider(node, center, size);
  const sensor = new RVSensor(node, aabb);
  sensor.boxColliderData = { center, size };
  if (opts.useRaycast) {
    sensor.UseRaycast = true;
    sensor.RayCastDirection = { x: 0, y: 0, z: 1 };
    sensor.RayCastLength = 500;
  }
  return { sensor, root, node };
}

describe('RVSensor + AABB — parent rotation tracking', () => {
  it('collision AABB centre follows a 90° parent rotation around Y', () => {
    const { sensor, root } = buildSensor({ boxColliderOffsetZ: 0.5 });
    const { ctx } = makeCtx();
    sensor.init(ctx);

    // Sanity: at neutral, AABB centre is at offset (0,0,0.5).
    sensor.updateAABB();
    expect(sensor.aabb.center.x).toBeCloseTo(0, 6);
    expect(sensor.aabb.center.z).toBeCloseTo(0.5, 6);

    // Rotate parent 90° around Y. Local +Z → world +X.
    root.rotation.y = MathUtils.degToRad(90);
    root.updateMatrixWorld(true);

    sensor.updateAABB();
    // After rotation: centre should be at world (+0.5, 0, 0).
    expect(sensor.aabb.center.x).toBeCloseTo(0.5, 5);
    expect(sensor.aabb.center.z).toBeCloseTo(0, 5);
  });

  it('raycast tube is parented to the sensor node (follows parent via the scene graph)', () => {
    const { sensor, node } = buildSensor({ useRaycast: true });
    const { ctx } = makeCtx();
    sensor.init(ctx);

    // Locate the tube as the child mesh suffixed `_sensorRay` — keeps the test
    // robust to refactors that rename the private field.
    const tube = node.children.find((c) => c.name === `${node.name}_sensorRay`);
    expect(tube).toBeDefined();
    expect(tube!.parent).toBe(node);
  });

  it('layout-transform-update on an ancestor triggers updateAABB on the sensor', () => {
    const { sensor, root } = buildSensor({ boxColliderOffsetZ: 0.5 });
    const { ctx, fire } = makeCtx({ withEvents: true });
    sensor.init(ctx);

    // After init: subscribe is live. Rotate the parent BUT don't manually
    // call updateAABB — the event should drive it.
    root.rotation.y = MathUtils.degToRad(90);
    // Note: not calling root.updateMatrixWorld; the sensor's listener does it.

    const spy = vi.spyOn(sensor, 'updateAABB');
    fire({
      path: 'LayoutRoot',
      position: [0, 0, 0],
      rotation: [0, 90, 0],
    });
    expect(spy).toHaveBeenCalledTimes(1);
    // After the event-driven refresh, the AABB has the rotated centre.
    expect(sensor.aabb.center.x).toBeCloseTo(0.5, 5);
    expect(sensor.aabb.center.z).toBeCloseTo(0, 5);
  });

  it('layout-transform-update for an unrelated path does NOT refresh', () => {
    const { sensor } = buildSensor({});
    const { ctx, fire } = makeCtx({ withEvents: true });
    sensor.init(ctx);

    const spy = vi.spyOn(sensor, 'updateAABB');
    fire({
      path: 'SomeOtherLayoutObject',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('dispose() releases the layout-transform-update subscription', () => {
    const { sensor } = buildSensor({});
    const { ctx, fire } = makeCtx({ withEvents: true });
    sensor.init(ctx);

    sensor.dispose();
    const spy = vi.spyOn(sensor, 'updateAABB');
    fire({
      path: 'LayoutRoot',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
