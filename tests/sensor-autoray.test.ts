// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D, Mesh, BoxGeometry, MeshBasicMaterial } from 'three';
import { computeBeamFromBounds, RVSensor } from '../src/core/engine/rv-sensor';
import { AABB } from '../src/core/engine/rv-aabb';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

describe('computeBeamFromBounds — sensor auto-ray', () => {
  it('beams along the longest box edge (Z), from min-face centre to max-face centre', () => {
    const mesh = new Mesh(new BoxGeometry(0.1, 0.1, 0.5), new MeshBasicMaterial());
    const beam = computeBeamFromBounds(mesh);
    expect(beam).not.toBeNull();
    expect(beam!.direction).toEqual({ x: 0, y: 0, z: 1 });
    expect(beam!.lengthMm).toBeCloseTo(500);          // 0.5 m extent
    expect(beam!.originOffset.x).toBeCloseTo(0);       // centred on the short axes
    expect(beam!.originOffset.y).toBeCloseTo(0);
    expect(beam!.originOffset.z).toBeCloseTo(-0.25);   // centre of the min face
  });

  it('picks X when X is the longest edge', () => {
    const mesh = new Mesh(new BoxGeometry(0.8, 0.1, 0.2), new MeshBasicMaterial());
    const beam = computeBeamFromBounds(mesh)!;
    expect(beam.direction).toEqual({ x: 1, y: 0, z: 0 });
    expect(beam.lengthMm).toBeCloseTo(800);
    expect(beam.originOffset.x).toBeCloseTo(-0.4);
  });

  it('aggregates geometry across child meshes (node-local bounds)', () => {
    const root = new Object3D();
    const a = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
    a.position.set(0, 0, -0.2);
    const b = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
    b.position.set(0, 0, 0.2);
    root.add(a, b);
    const beam = computeBeamFromBounds(root)!;
    // Combined span on Z: -0.25 .. 0.25 → 0.5 m, longest axis Z.
    expect(beam.direction).toEqual({ x: 0, y: 0, z: 1 });
    expect(beam.lengthMm).toBeCloseTo(500);
    expect(beam.originOffset.z).toBeCloseTo(-0.25);
  });

  it('returns null for a node with no geometry', () => {
    expect(computeBeamFromBounds(new Object3D())).toBeNull();
  });
});

describe('RVSensor — per-instance signal scoping', () => {
  function makeCtx() {
    const registered: { name: string; path: string }[] = [];
    const ctx = {
      signalStore: {
        register: (name: string, path: string) => { registered.push({ name, path }); },
        set: () => {},
        setByPath: () => {},
      },
      transportManager: { sensors: [] },
    } as unknown as ComponentContext;
    return { ctx, registered };
  }

  it('scopes the occupied signal under the LayoutObject root', () => {
    const root = new Object3D(); root.name = 'RollConveyor2m_2';
    root.userData.realvirtual = { LayoutObject: { Label: 'x', CatalogId: 'c', Locked: false } };
    const sensorNode = new Object3D(); sensorNode.name = 'Sensor'; root.add(sensorNode);
    const sensor = new RVSensor(sensorNode, new AABB());
    const { ctx, registered } = makeCtx();
    sensor.init(ctx);
    expect(registered[0].name).toBe('RollConveyor2m_2/Sensor');
  });

  it('keeps the bare sensor name when standalone (no LayoutObject)', () => {
    const root = new Object3D(); root.name = 'Scene';
    const sensorNode = new Object3D(); sensorNode.name = 'Sensor'; root.add(sensorNode);
    const sensor = new RVSensor(sensorNode, new AABB());
    const { ctx, registered } = makeCtx();
    sensor.init(ctx);
    expect(registered[0].name).toBe('Sensor');
  });
});
