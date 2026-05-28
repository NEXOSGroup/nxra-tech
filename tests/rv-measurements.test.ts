// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MeasurementPlugin,
  subscribeMeasurements,
  getMeasurementSnapshot,
} from '../src/plugins/measurement-plugin';
import { formatDistance } from '../src/plugins/rv-measurement-renderer';

function makePlugin(): MeasurementPlugin {
  return new MeasurementPlugin();
}

describe('MeasurementPlugin', () => {
  let plugin: MeasurementPlugin;
  beforeEach(() => {
    localStorage.clear();
    plugin = makePlugin();
  });

  // === CRUD (5 Tests) ===

  it('adds a measurement and computes distance correctly', () => {
    const m = plugin.addMeasurement([0, 0, 0], [1, 0, 0]);
    expect(m.id).toBeTruthy();
    expect(m.distance).toBeCloseTo(1.0);
    expect(plugin.getMeasurements()).toHaveLength(1);
  });

  it('removes a measurement by id', () => {
    const m = plugin.addMeasurement([0, 0, 0], [3, 4, 0]);
    plugin.removeMeasurement(m.id);
    expect(plugin.getMeasurements()).toHaveLength(0);
  });

  it('removeAll clears all measurements', () => {
    plugin.addMeasurement([0, 0, 0], [1, 0, 0]);
    plugin.addMeasurement([0, 0, 0], [0, 2, 0]);
    plugin.removeAll();
    expect(plugin.getMeasurements()).toHaveLength(0);
  });

  it('updates measurement name and visibility', () => {
    const m = plugin.addMeasurement([0, 0, 0], [1, 0, 0]);
    plugin.updateMeasurement(m.id, { name: 'Flange', visible: false });
    const updated = plugin.getMeasurements()[0];
    expect(updated.name).toBe('Flange');
    expect(updated.visible).toBe(false);
  });

  it('handles multiple measurements with independent IDs', () => {
    const m1 = plugin.addMeasurement([0, 0, 0], [1, 0, 0]);
    const m2 = plugin.addMeasurement([0, 0, 0], [0, 2, 0]);
    const m3 = plugin.addMeasurement([0, 0, 0], [0, 0, 3]);
    expect(m1.id).not.toBe(m2.id);
    expect(m2.id).not.toBe(m3.id);
    expect(plugin.getMeasurements()).toHaveLength(3);
  });

  // === Distance Computation (3 Tests) ===

  it('computes 3D distance correctly (diagonal)', () => {
    const m = plugin.addMeasurement([1, 2, 3], [4, 6, 3]);
    expect(m.distance).toBeCloseTo(5.0); // sqrt(9+16+0)
  });

  it('handles distance=0 (identical points)', () => {
    const m = plugin.addMeasurement([1, 2, 3], [1, 2, 3]);
    expect(m.distance).toBeCloseTo(0);
    expect(m.id).toBeTruthy();
  });

  it('computes distance correctly with negative coordinates', () => {
    const m = plugin.addMeasurement([-1, -1, -1], [1, 1, 1]);
    expect(m.distance).toBeCloseTo(Math.sqrt(12));
  });

  // === Graceful Error Handling (4 Tests) ===

  it('handles removeMeasurement with non-existent id gracefully', () => {
    expect(() => plugin.removeMeasurement('fake-id')).not.toThrow();
  });

  it('handles updateMeasurement with non-existent id gracefully', () => {
    expect(() => plugin.updateMeasurement('fake-id', { name: 'X' })).not.toThrow();
  });

  it('handles focusMeasurement with non-existent id gracefully', () => {
    expect(() => plugin.focusMeasurement('nonexistent-id')).not.toThrow();
  });

  it('dispose() does not throw', () => {
    plugin.addMeasurement([0, 0, 0], [1, 0, 0]);
    plugin.addMeasurement([0, 0, 0], [0, 2, 0]);
    expect(() => plugin.dispose()).not.toThrow();
  });

  // === Snapshot/Subscribe (5 Tests) ===

  it('notifies subscribers via snapshot on add', () => {
    const listener = vi.fn();
    const unsub = subscribeMeasurements(listener);
    plugin.addMeasurement([0, 0, 0], [1, 0, 0]);
    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it('notifies subscribers via snapshot on remove', () => {
    const m = plugin.addMeasurement([0, 0, 0], [1, 0, 0]);
    const listener = vi.fn();
    const unsub = subscribeMeasurements(listener);
    plugin.removeMeasurement(m.id);
    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it('notifies subscribers via snapshot on removeAll', () => {
    plugin.addMeasurement([0, 0, 0], [1, 0, 0]);
    const listener = vi.fn();
    const unsub = subscribeMeasurements(listener);
    plugin.removeAll();
    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it('does not call listener after unsubscribe', () => {
    const listener = vi.fn();
    const unsub = subscribeMeasurements(listener);
    unsub();
    plugin.addMeasurement([0, 0, 0], [1, 0, 0]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('returns stable snapshot reference when unchanged', () => {
    const snap1 = getMeasurementSnapshot();
    const snap2 = getMeasurementSnapshot();
    expect(snap1).toBe(snap2);
  });

  // === getMeasurements Copy Semantics (1 Test) ===

  it('getMeasurements() returns a copy, not a live reference', () => {
    plugin.addMeasurement([0, 0, 0], [1, 0, 0]);
    const list1 = plugin.getMeasurements();
    plugin.addMeasurement([0, 0, 0], [0, 2, 0]);
    const list2 = plugin.getMeasurements();
    expect(list1).toHaveLength(1);
    expect(list2).toHaveLength(2);
  });

  // === MeasurementMode (2 Tests) ===

  it('toggles measurementMode', () => {
    expect(plugin.measurementMode).toBe(false);
    plugin.measurementMode = true;
    expect(plugin.measurementMode).toBe(true);
    plugin.measurementMode = false;
    expect(plugin.measurementMode).toBe(false);
  });

  it('measurementMode change emits snapshot', () => {
    const listener = vi.fn();
    const unsub = subscribeMeasurements(listener);
    plugin.measurementMode = true;
    expect(listener).toHaveBeenCalled();
    unsub();
  });

  // === localStorage (3 Tests) ===

  it('persists to localStorage and reloads', () => {
    plugin.addMeasurement([0, 0, 0], [1, 0, 0]);
    const plugin2 = makePlugin();
    plugin2._load();
    expect(plugin2.getMeasurements()).toHaveLength(1);
  });

  it('fallback gracefully when localStorage contains invalid JSON', () => {
    localStorage.setItem('rv-measurements-0', 'NOT_VALID_JSON');
    const plugin2 = makePlugin();
    plugin2._load();
    expect(plugin2.getMeasurements()).toHaveLength(0);
  });

  it('handles localStorage QuotaExceededError gracefully', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('QuotaExceededError');
    });
    expect(() => plugin.addMeasurement([0, 0, 0], [1, 0, 0])).not.toThrow();
  });

  // === formatDistance (2 Tests) ===

  it('formats distance as mm when < 1m', () => {
    expect(formatDistance(0.347)).toBe('347 mm');
    expect(formatDistance(0)).toBe('0 mm');
  });

  it('formats distance as m when >= 1m', () => {
    expect(formatDistance(2.5)).toBe('2.50 m');
    expect(formatDistance(100)).toBe('100.00 m');
  });
});
