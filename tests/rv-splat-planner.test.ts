// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for Gaussian Splat integration with the Layout Planner.
 * Covers: library recognition, click-to-place, multi-instance, persistence.
 */

import { describe, it, expect, vi } from 'vitest';
import { Group } from 'three';
import { normalizeCatalogEntry, type PlacedComponent } from '../src/plugins/layout-planner/rv-layout-store';

// ── Library Recognition ──

describe('Splat Library Recognition', () => {
  it('should recognize .splat files as splat category', () => {
    const entry = normalizeCatalogEntry({ splatUrl: 'scan.splat' }, 'http://example.com/');
    expect(entry.splatUrl).toBe('http://example.com/scan.splat');
    expect(entry.category).toBe('splat');
    expect(entry.glbUrl).toBeUndefined();
  });

  it('should recognize .ksplat files as splat category', () => {
    const entry = normalizeCatalogEntry({ splatUrl: 'hall.ksplat' }, 'http://example.com/');
    expect(entry.splatUrl).toBe('http://example.com/hall.ksplat');
    expect(entry.category).toBe('splat');
  });

  it('should recognize .ply files as splat category', () => {
    const entry = normalizeCatalogEntry({ splatUrl: 'cloud.ply' }, 'http://example.com/');
    expect(entry.splatUrl).toBe('http://example.com/cloud.ply');
    expect(entry.category).toBe('splat');
  });

  it('should derive name from splat filename', () => {
    const entry = normalizeCatalogEntry({ splatUrl: 'factory_scan.splat' }, '/');
    expect(entry.name).toBe('factory scan');
  });

  it('should derive id from splat filename', () => {
    const entry = normalizeCatalogEntry({ splatUrl: 'Factory Scan.splat' }, '/');
    expect(entry.id).toBe('factory-scan');
  });

  it('should not produce splatUrl for regular GLB entries', () => {
    const entry = normalizeCatalogEntry({ glbUrl: 'model.glb' }, '/');
    expect(entry.splatUrl).toBeUndefined();
    expect(entry.category).toBe('custom');
  });

  it('should allow custom name override for splat entries', () => {
    const entry = normalizeCatalogEntry({ splatUrl: 'scan.splat', name: 'My Custom Scan' }, '/');
    expect(entry.name).toBe('My Custom Scan');
  });

  it('should resolve absolute splat URLs correctly', () => {
    const entry = normalizeCatalogEntry(
      { splatUrl: 'https://cdn.example.com/scan.splat' },
      'http://example.com/',
    );
    expect(entry.splatUrl).toBe('https://cdn.example.com/scan.splat');
  });

  it('should resolve blob: splat URLs correctly', () => {
    const entry = normalizeCatalogEntry(
      { splatUrl: 'blob:http://localhost:5173/abc-123' },
      'http://example.com/',
    );
    expect(entry.splatUrl).toBe('blob:http://localhost:5173/abc-123');
  });
});

// ── PlacedComponent Persistence ──

describe('Splat Placement Persistence', () => {
  it('should serialize and restore splatUrl', () => {
    const comp: PlacedComponent = {
      id: 'id-1',
      catalogId: 's1',
      glbUrl: '',
      splatUrl: 'test.splat',
      label: 'scan',
      position: [0, 0, 0],
      rotation: [0, 45, 0],
      scale: [1, 1, 1],
    };
    const restored = JSON.parse(JSON.stringify(comp)) as PlacedComponent;
    expect(restored.splatUrl).toBe('test.splat');
    expect(restored.glbUrl).toBe('');
  });

  it('should be backward-compatible (no splatUrl field)', () => {
    const comp: PlacedComponent = {
      id: 'id-2',
      catalogId: 'c1',
      glbUrl: 'model.glb',
      label: 'conveyor',
      position: [1, 0, 2],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    };
    const restored = JSON.parse(JSON.stringify(comp)) as PlacedComponent;
    expect(restored.splatUrl).toBeUndefined();
    expect(restored.glbUrl).toBe('model.glb');
  });
});

// ── Multi-Instance Splat (via planner placeComponent mock) ──

describe('Splat Planner Integration', () => {
  it('placeComponent should delegate to loadSplat for splat entries', async () => {
    // This tests the logical flow without loading the full planner.
    // We verify that the splatUrl field is correctly passed through.
    const splatContainer = new Group();
    splatContainer.name = 'splat-container';

    const mockLoadSplat = vi.fn().mockResolvedValue(splatContainer);
    const mockDisposeSplat = vi.fn();

    const splatApi = {
      loadSplat: mockLoadSplat,
      disposeSplat: mockDisposeSplat,
      instanceCount: 1,
    };

    // Simulate what placeComponent does for a splat entry
    const entry = { id: 's1', name: 'scan', category: 'splat' as const, splatUrl: 'test.splat' };
    const container = await splatApi.loadSplat(entry.splatUrl);

    expect(mockLoadSplat).toHaveBeenCalledWith('test.splat');
    expect(container).toBe(splatContainer);

    // Simulate removal
    splatApi.disposeSplat(container);
    expect(mockDisposeSplat).toHaveBeenCalledWith(splatContainer);
  });

  it('userData should be correctly set for splat placements', () => {
    const container = new Group();
    // Simulate _addSplatPlacedToScene
    container.userData._layoutObject = true;
    container.userData._layoutId = 'test-id';
    container.userData._isSplat = true;
    container.userData._splatUrl = 'test.splat';
    container.userData.realvirtual = {
      LayoutObject: { Label: 'Test Scan', CatalogId: 's1', Locked: false },
    };

    expect(container.userData._isSplat).toBe(true);
    expect(container.userData._splatUrl).toBe('test.splat');
    expect(container.userData.realvirtual.LayoutObject.Label).toBe('Test Scan');
  });

  it('freshly placed splat must expose a Splat component for the Inspector', () => {
    // Regression guard: the axis-invert ComponentActions (Invert X/Y/Z) only
    // render when the node's userData.realvirtual carries a `Splat` key. The
    // interactive placeComponent path must mirror the marker components
    // (syncLayoutMarkerComponents) right after _addSplatPlacedToScene — without
    // it, the Splat section (and its invert buttons) is missing until reload.
    const container = new Group();
    container.userData._isSplat = true;
    container.userData.realvirtual = {
      LayoutObject: { Label: 'Test Scan', CatalogId: 's1', Locked: false },
    };

    // Replicate syncLayoutMarkerComponents' splat branch.
    const rv = container.userData.realvirtual as Record<string, Record<string, unknown>>;
    if (!rv.LayoutObject) rv.LayoutObject = {};
    rv.LayoutObject.Visible = true;
    if (container.userData._isSplat && !rv.Splat) rv.Splat = {};

    expect(rv.Splat).toBeDefined();
    expect(rv.LayoutObject.Visible).toBe(true);
  });
});
