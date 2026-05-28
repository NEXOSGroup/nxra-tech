// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-gizmo-material-cache.ts — Shared material cache used by GizmoOverlayManager.
 *
 * Tracks reference-counted Three.js materials keyed by visual parameters
 * (color, opacity, depthTest, blinkHz, emissiveIntensity). Materials are
 * created lazily, shared across gizmo entries that match the same key, and
 * disposed automatically when the last reference is released.
 *
 * Also tracks materials that participate in the central blink tick. Sharable
 * materials are registered automatically by the `getOrCreate*` paths; dedicated
 * (non-shared) materials — such as the hull material for `mesh-glow-hull` —
 * register themselves via `registerDedicated()` with a caller-provided key.
 *
 * The cache exposes a `size` getter and `values()` iterator so existing test
 * code that reaches into the manager via `(mgr as any)._cache.size` continues
 * to work after extraction.
 */

import {
  BackSide as _BackSide, // kept for type-only re-export consistency (not used directly)
  LineBasicMaterial,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SpriteMaterial,
  type Material,
} from 'three';

// Silence unused import (BackSide is referenced via comment for future maintainers).
void _BackSide;

/** Inputs that determine a material's identity in the shared cache. */
export interface GizmoMaterialInputs {
  color: number;
  /** 0..1, already clamped by the caller. */
  baseOpacity: number;
  depthTest: boolean;
  /** Hz; 0 = no blink. */
  blinkHz: number;
  /** 0 = no emissive (uses MeshBasicMaterial); >0 = MeshStandardMaterial. */
  emissiveIntensity?: number;
}

/** Per-material metadata tracked by the cache. */
export interface MaterialMeta {
  material: Material;
  /** Cache-key (deterministic from inputs). */
  key: string;
  /** Base opacity shared by all entries that use this material. */
  baseOpacity: number;
  /** Blink frequency (Hz). 0 = no blink. */
  blinkHz: number;
  /** Last phase written ('on' | 'off' | 'static'). */
  lastPhase: 'on' | 'off' | 'static';
  /** Reference count — material evicted from cache when refCount → 0. */
  refCount: number;
}

/**
 * Reference-counted shared material cache for GizmoOverlayManager.
 *
 * Public surface stays minimal:
 * - `getOrCreateMesh()`, `getOrCreateLine()`, `getOrCreateEmissive()` —
 *   shared, refcounted, blink-tracked materials.
 * - `release()` — refcount decrement; disposes when last reference released.
 * - `registerDedicated()` / `unregisterDedicated()` — track non-shared
 *   materials (hull/sprite) so the central blink loop can modulate them.
 * - `values()`, `size` — for the blink tick + tests.
 * - `clear()` — full reset (used by manager dispose).
 */
export class GizmoMaterialCache {
  private _materials = new Map<string, MaterialMeta>();

  /** Number of tracked material entries. */
  get size(): number {
    return this._materials.size;
  }

  /** Iterate all tracked material entries (used by the central blink tick). */
  values(): IterableIterator<MaterialMeta> {
    return this._materials.values();
  }

  /** Drop all tracked materials without disposing — manager dispose handles
   *  scene-graph removal and dedicated material disposal separately. */
  clear(): void {
    this._materials.clear();
  }

  /** Compose the shared-material cache key. */
  private _makeKey(inputs: GizmoMaterialInputs): string {
    const e = inputs.emissiveIntensity ?? 0;
    return `${inputs.color}_${inputs.baseOpacity}_${inputs.depthTest}_${inputs.blinkHz}_e${e}`;
  }

  /**
   * Get-or-create a shared MeshBasicMaterial for flat opaque/transparent fills
   * (transparent-shell, mesh-overlay, sphere without emissive, floor-disk).
   * Increments refCount on cache hit.
   */
  getOrCreateMesh(inputs: GizmoMaterialInputs): MeshBasicMaterial {
    const key = this._makeKey(inputs);
    const existing = this._materials.get(key);
    if (existing) {
      existing.refCount++;
      return existing.material as MeshBasicMaterial;
    }
    const mat = new MeshBasicMaterial({
      color: inputs.color,
      transparent: true,
      opacity: inputs.baseOpacity,
      depthTest: inputs.depthTest,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });
    this._materials.set(key, {
      material: mat,
      key,
      baseOpacity: inputs.baseOpacity,
      blinkHz: inputs.blinkHz,
      lastPhase: inputs.blinkHz > 0 ? 'on' : 'static',
      refCount: 1,
    });
    return mat;
  }

  /**
   * Get-or-create a shared LineBasicMaterial (box wireframe, mesh-edges,
   * sphere-edges). Increments refCount on cache hit.
   */
  getOrCreateLine(inputs: GizmoMaterialInputs): LineBasicMaterial {
    const key = `line_${this._makeKey(inputs)}`;
    const existing = this._materials.get(key);
    if (existing) {
      existing.refCount++;
      return existing.material as LineBasicMaterial;
    }
    const mat = new LineBasicMaterial({
      color: inputs.color,
      transparent: true,
      opacity: inputs.baseOpacity,
      depthTest: inputs.depthTest,
      depthWrite: false,
    });
    this._materials.set(key, {
      material: mat,
      key,
      baseOpacity: inputs.baseOpacity,
      blinkHz: inputs.blinkHz,
      lastPhase: inputs.blinkHz > 0 ? 'on' : 'static',
      refCount: 1,
    });
    return mat;
  }

  /**
   * Get-or-create a shared MeshStandardMaterial that glows via emissive
   * (used by sphere when emissiveIntensity > 0). The visible color is
   * carried by `emissive` so the sphere is independent of scene lighting.
   * Increments refCount on cache hit.
   */
  getOrCreateEmissive(inputs: GizmoMaterialInputs): MeshStandardMaterial {
    const key = `em_${this._makeKey(inputs)}`;
    const existing = this._materials.get(key);
    if (existing) {
      existing.refCount++;
      return existing.material as MeshStandardMaterial;
    }
    const mat = new MeshStandardMaterial({
      color: 0x000000,
      emissive: inputs.color,
      emissiveIntensity: inputs.emissiveIntensity ?? 0,
      transparent: inputs.baseOpacity < 1,
      opacity: inputs.baseOpacity,
      depthTest: inputs.depthTest,
      depthWrite: false,
      // Bloom requires the renderer's tone-mapped output. emissive needs to map > 0.85
      // (default bloom threshold) AFTER tone mapping. emissiveIntensity ≥ 1.5 typically
      // suffices.
      toneMapped: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });
    this._materials.set(key, {
      material: mat,
      key,
      baseOpacity: inputs.baseOpacity,
      blinkHz: inputs.blinkHz,
      lastPhase: inputs.blinkHz > 0 ? 'on' : 'static',
      refCount: 1,
    });
    return mat;
  }

  /**
   * Release a shared material reference. When `kind` is 'line', the cache key
   * uses the `line_` prefix. When `kind` is 'emissive', the `em_` prefix is
   * used. When `kind` is 'mesh', no prefix.
   *
   * Disposes the underlying GPU resource when the last reference is released.
   * No-op when the key is not tracked (e.g. when the caller manages its own
   * dedicated material).
   */
  release(inputs: GizmoMaterialInputs, kind: 'mesh' | 'line' | 'emissive'): void {
    const prefix = kind === 'line' ? 'line_' : kind === 'emissive' ? 'em_' : '';
    const key = `${prefix}${this._makeKey(inputs)}`;
    const meta = this._materials.get(key);
    if (!meta) return;
    meta.refCount--;
    if (meta.refCount <= 0) {
      this._materials.delete(key);
      (meta.material as Material).dispose();
    }
  }

  /**
   * Register a dedicated (non-shared) material so the central blink loop can
   * modulate its opacity. The caller chooses the key (typically
   * `dedicated_<entryId>`). The cache does NOT dispose dedicated materials —
   * the owning entry is responsible for that on dispose.
   */
  registerDedicated(
    key: string,
    material: MeshBasicMaterial | SpriteMaterial,
    baseOpacity: number,
    blinkHz: number,
  ): void {
    this._materials.set(key, {
      material: material as unknown as Material,
      key,
      baseOpacity,
      blinkHz,
      lastPhase: 'on',
      refCount: 1,
    });
  }

  /** Update tracked opacity/blink params for a dedicated material entry. */
  updateDedicated(key: string, baseOpacity: number, blinkHz: number): boolean {
    const meta = this._materials.get(key);
    if (!meta) return false;
    meta.baseOpacity = baseOpacity;
    meta.blinkHz = blinkHz;
    return true;
  }

  /** Drop a dedicated entry from blink tracking (no dispose — caller owns). */
  unregisterDedicated(key: string): boolean {
    return this._materials.delete(key);
  }

  /** Lookup raw metadata by key (used by manager to sync dedicated state). */
  get(key: string): MaterialMeta | undefined {
    return this._materials.get(key);
  }
}
