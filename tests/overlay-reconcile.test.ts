// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for reconcileOverlayOverrides — the reload-time safety net that applies
 * overrides whose stored node-path didn't match the path used during the GLB
 * traverse (e.g. kinematic re-parenting changes a drive's path, or space/
 * underscore/suffix differences). This is the fix for: "after reload the field
 * is marked as an override but shows the original GLB value."
 */
import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RVDrive } from '../src/core/engine/rv-drive';
import { applySchema } from '../src/core/engine/rv-component-registry';
import { reconcileOverlayOverrides } from '../src/core/engine/rv-scene-loader';
import type { RVExtrasOverlay } from '../src/core/engine/rv-extras-overlay-store';

/** Build a registry with a Drive registered at `canonical`, config TargetSpeed=200. */
function setup(canonical: string) {
  const registry = new NodeRegistry();
  const node = new Object3D();
  node.name = canonical.split('/').pop()!;
  node.userData.realvirtual = { Drive: { Direction: 'LinearX', TargetSpeed: 200 } };
  registry.registerNode(canonical, node);

  const drive = new RVDrive(node);
  applySchema(drive as unknown as Record<string, unknown>, RVDrive.schema, node.userData.realvirtual.Drive);
  drive.initDrive();
  registry.register('Drive', canonical, drive);
  return { registry, node, drive };
}

function overlayWith(path: string, fields: Record<string, unknown>): RVExtrasOverlay {
  return {
    $schema: 'rv-extras-overlay/1.0',
    $source: 'test',
    nodes: { [path]: { Drive: fields } },
  } as RVExtrasOverlay;
}

describe('reconcileOverlayOverrides', () => {
  it('applies an override stored under a non-exact (suffix) path to the right node', () => {
    const { registry, node, drive } = setup('Root/RC/Conveyor');
    expect(drive.targetSpeed).toBe(200);

    // Override keyed by a SUFFIX of the canonical path — the kind of mismatch
    // kinematic re-parenting / path normalization produces.
    reconcileOverlayOverrides(registry, overlayWith('RC/Conveyor', { TargetSpeed: 500 }));

    const rv = node.userData.realvirtual as Record<string, Record<string, unknown>>;
    expect(rv.Drive.TargetSpeed).toBe(500);   // display value (userData)
    expect(drive.TargetSpeed).toBe(500);       // config field
    expect(drive.targetSpeed).toBe(500);       // runtime (reapplyConfig synced it)
  });

  it('does not compound the StartPosition offset when re-syncing', () => {
    const { registry, node, drive } = setup('Root/RC/Lift');
    // Give it a non-zero start so a naive initDrive() re-run would double the offset.
    drive.StartPosition = 100;
    drive.currentPosition = 100;
    drive.applyToNode();
    const posAfterInit = node.position.clone();

    reconcileOverlayOverrides(registry, overlayWith('RC/Lift', { TargetSpeed: 750 }));

    expect(drive.targetSpeed).toBe(750);
    // reapplyConfig() must NOT re-cache the base transform → position is stable.
    expect(node.position.x).toBeCloseTo(posAfterInit.x, 5);
    expect(node.position.y).toBeCloseTo(posAfterInit.y, 5);
    expect(node.position.z).toBeCloseTo(posAfterInit.z, 5);
  });

  it('is a no-op when the override was already applied during traversal (exact path)', () => {
    const { registry, node } = setup('Root/RC/Conveyor');
    // Simulate the traverse having already applied the override.
    const rv = node.userData.realvirtual as Record<string, Record<string, unknown>>;
    rv.Drive.TargetSpeed = 500;

    // Same value via reconcile → applyOverlayToNode reports no change → skipped.
    expect(() =>
      reconcileOverlayOverrides(registry, overlayWith('Root/RC/Conveyor', { TargetSpeed: 500 })),
    ).not.toThrow();
    expect(rv.Drive.TargetSpeed).toBe(500);
  });

  it('ignores override keys that resolve to no node', () => {
    const { registry, node } = setup('Root/RC/Conveyor');
    reconcileOverlayOverrides(registry, overlayWith('Does/Not/Exist', { TargetSpeed: 999 }));
    const rv = node.userData.realvirtual as Record<string, Record<string, unknown>>;
    expect(rv.Drive.TargetSpeed).toBe(200); // untouched
  });
});
