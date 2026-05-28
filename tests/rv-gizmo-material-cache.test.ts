// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshBasicMaterial, SpriteMaterial } from 'three';
import {
  GizmoMaterialCache,
  type GizmoMaterialInputs,
} from '../src/core/engine/rv-gizmo-material-cache';

function inputs(overrides: Partial<GizmoMaterialInputs> = {}): GizmoMaterialInputs {
  return {
    color: 0xff0000,
    baseOpacity: 0.5,
    depthTest: true,
    blinkHz: 0,
    emissiveIntensity: 0,
    ...overrides,
  };
}

describe('GizmoMaterialCache', () => {
  let cache: GizmoMaterialCache;
  beforeEach(() => {
    cache = new GizmoMaterialCache();
  });

  it('initial size is 0 and values() iterator is empty', () => {
    expect(cache.size).toBe(0);
    expect(Array.from(cache.values())).toEqual([]);
  });

  describe('getOrCreateMesh', () => {
    it('returns the same instance for identical params (cache hit)', () => {
      const m1 = cache.getOrCreateMesh(inputs());
      const m2 = cache.getOrCreateMesh(inputs());
      expect(m1).toBe(m2);
      expect(cache.size).toBe(1);
    });

    it('returns distinct instances for different colors', () => {
      const m1 = cache.getOrCreateMesh(inputs({ color: 0xff0000 }));
      const m2 = cache.getOrCreateMesh(inputs({ color: 0x00ff00 }));
      expect(m1).not.toBe(m2);
      expect(cache.size).toBe(2);
    });

    it('returns distinct instances for different blinkHz (KEY guard)', () => {
      const m1 = cache.getOrCreateMesh(inputs({ blinkHz: 1 }));
      const m2 = cache.getOrCreateMesh(inputs({ blinkHz: 2 }));
      expect(m1).not.toBe(m2);
      expect(cache.size).toBe(2);
    });

    it('produced material is transparent and uses provided opacity', () => {
      const mat = cache.getOrCreateMesh(inputs({ baseOpacity: 0.25 }));
      expect(mat.transparent).toBe(true);
      expect(mat.opacity).toBeCloseTo(0.25);
    });
  });

  describe('getOrCreateLine', () => {
    it('caches LineBasicMaterial under line_ prefix (independent of getOrCreateMesh)', () => {
      // Same visual inputs → different cache entries (line vs mesh).
      const meshMat = cache.getOrCreateMesh(inputs());
      const lineMat = cache.getOrCreateLine(inputs());
      expect(meshMat).not.toBe(lineMat as unknown as MeshBasicMaterial);
      expect(cache.size).toBe(2);
    });

    it('returns cached instance on second call', () => {
      const a = cache.getOrCreateLine(inputs());
      const b = cache.getOrCreateLine(inputs());
      expect(a).toBe(b);
      expect(cache.size).toBe(1);
    });
  });

  describe('getOrCreateEmissive', () => {
    it('caches MeshStandardMaterial under em_ prefix', () => {
      const mat = cache.getOrCreateEmissive(inputs({ emissiveIntensity: 2 }));
      // emissive carries the color; base color is black per the manager's design
      expect(mat.color.getHex()).toBe(0x000000);
      expect(mat.emissive.getHex()).toBe(0xff0000);
      expect(mat.emissiveIntensity).toBe(2);
      expect(cache.size).toBe(1);
    });

    it('returns cached instance for identical params (cache hit)', () => {
      const a = cache.getOrCreateEmissive(inputs({ emissiveIntensity: 1.5 }));
      const b = cache.getOrCreateEmissive(inputs({ emissiveIntensity: 1.5 }));
      expect(a).toBe(b);
      expect(cache.size).toBe(1);
    });

    it('produces distinct instances for different emissiveIntensity', () => {
      const a = cache.getOrCreateEmissive(inputs({ emissiveIntensity: 1 }));
      const b = cache.getOrCreateEmissive(inputs({ emissiveIntensity: 2 }));
      expect(a).not.toBe(b);
      expect(cache.size).toBe(2);
    });
  });

  describe('release', () => {
    it('reduces refcount and evicts material on last release', () => {
      const mat = cache.getOrCreateMesh(inputs());
      cache.getOrCreateMesh(inputs()); // refCount → 2
      expect(cache.size).toBe(1);
      const disposeSpy = vi.spyOn(mat, 'dispose');

      cache.release(inputs(), 'mesh'); // refCount → 1
      expect(cache.size).toBe(1);
      expect(disposeSpy).not.toHaveBeenCalled();

      cache.release(inputs(), 'mesh'); // refCount → 0 → evict + dispose
      expect(cache.size).toBe(0);
      expect(disposeSpy).toHaveBeenCalled();
    });

    it('release uses line_ prefix correctly', () => {
      cache.getOrCreateLine(inputs());
      expect(cache.size).toBe(1);
      cache.release(inputs(), 'line');
      expect(cache.size).toBe(0);
    });

    it('release uses em_ prefix correctly', () => {
      cache.getOrCreateEmissive(inputs({ emissiveIntensity: 2 }));
      expect(cache.size).toBe(1);
      cache.release(inputs({ emissiveIntensity: 2 }), 'emissive');
      expect(cache.size).toBe(0);
    });

    it('release for unknown key is a no-op', () => {
      // Never created → release should not throw or change size.
      expect(() => cache.release(inputs(), 'mesh')).not.toThrow();
      expect(cache.size).toBe(0);
    });
  });

  describe('dedicated blink registration', () => {
    it('registerDedicated tracks the material under the caller-provided key', () => {
      const mat = new MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.8 });
      cache.registerDedicated('dedicated_gz_1', mat, 0.8, 3);
      expect(cache.size).toBe(1);
      const meta = cache.get('dedicated_gz_1')!;
      expect(meta.material).toBe(mat);
      expect(meta.baseOpacity).toBeCloseTo(0.8);
      expect(meta.blinkHz).toBe(3);
      expect(meta.lastPhase).toBe('on');
    });

    it('registerDedicated also works with SpriteMaterial', () => {
      const mat = new SpriteMaterial({ transparent: true, opacity: 1 });
      cache.registerDedicated('dedicated_gz_2', mat, 1, 2);
      const meta = cache.get('dedicated_gz_2')!;
      expect(meta.material).toBe(mat as unknown as MeshBasicMaterial);
      expect(meta.blinkHz).toBe(2);
    });

    it('updateDedicated mutates existing entry and returns true', () => {
      const mat = new MeshBasicMaterial();
      cache.registerDedicated('k', mat, 0.5, 1);
      const ok = cache.updateDedicated('k', 0.9, 4);
      expect(ok).toBe(true);
      const meta = cache.get('k')!;
      expect(meta.baseOpacity).toBeCloseTo(0.9);
      expect(meta.blinkHz).toBe(4);
    });

    it('updateDedicated returns false for unknown key', () => {
      expect(cache.updateDedicated('does_not_exist', 1, 1)).toBe(false);
    });

    it('unregisterDedicated removes the entry and returns true; false on missing', () => {
      const mat = new MeshBasicMaterial();
      cache.registerDedicated('k', mat, 0.5, 1);
      expect(cache.unregisterDedicated('k')).toBe(true);
      expect(cache.size).toBe(0);
      expect(cache.unregisterDedicated('k')).toBe(false);
    });

    it('dedicated entries appear in values() iterator (blink tick consumer)', () => {
      cache.registerDedicated('k1', new MeshBasicMaterial(), 1, 1);
      cache.getOrCreateMesh(inputs({ blinkHz: 2 }));
      const all = Array.from(cache.values());
      expect(all.length).toBe(2);
      const hzs = all.map((m) => m.blinkHz).sort();
      expect(hzs).toEqual([1, 2]);
    });
  });

  describe('clear', () => {
    it('drops all tracked entries without disposing (manager owns dispose)', () => {
      const mat = cache.getOrCreateMesh(inputs());
      const disposeSpy = vi.spyOn(mat, 'dispose');
      cache.getOrCreateLine(inputs());
      expect(cache.size).toBe(2);
      cache.clear();
      expect(cache.size).toBe(0);
      // clear() does NOT dispose — the manager calls .dispose() per-entry as needed.
      expect(disposeSpy).not.toHaveBeenCalled();
    });
  });
});
