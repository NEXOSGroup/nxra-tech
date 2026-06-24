// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import {
  Scene, PerspectiveCamera, Mesh, BufferGeometry, MeshStandardMaterial,
  MeshToonMaterial, Object3D, Texture, DoubleSide, NearestFilter, WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildToonGradient, RVToonMaterialManager, type ToonHostViewer } from '../src/core/rv-toon-materials';

/**
 * Lightweight host. `isWebGPU: true` short-circuits the composer/outline path
 * so the material-swap logic can be tested without a real WebGL context.
 */
function makeHost(overrides: Partial<ToonHostViewer> = {}): ToonHostViewer {
  return {
    scene: new Scene(),
    camera: new PerspectiveCamera(),
    renderer: {} as unknown as WebGLRenderer,
    isWebGPU: true,
    sceneFixtures: new Set<Object3D>(),
    groundMesh: null,
    _ensureComposer() { /* noop */ },
    get _composer() { return null; },
    markRenderDirty() { /* noop */ },
    ...overrides,
  };
}

/** Host backed by a real renderer + composer for the outline-pass tests. */
function makeComposerHost(): { host: ToonHostViewer; composer: EffectComposer } {
  const canvas = document.createElement('canvas');
  canvas.width = 200; canvas.height = 100;
  const renderer = new WebGLRenderer({ canvas });
  renderer.setSize(200, 100, false);
  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 2, 0.01, 1000);
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new OutputPass());
  const host: ToonHostViewer = {
    scene, camera, renderer, isWebGPU: false,
    sceneFixtures: new Set<Object3D>(),
    _ensureComposer() {}, get _composer() { return composer; }, markRenderDirty() {},
  };
  return { host, composer };
}

describe('buildToonGradient', () => {
  it('produces a bands×1 NearestFilter ramp, dark→light, cool tint when set', () => {
    const tex = buildToonGradient(3, false);
    expect(tex.image.width).toBe(3);
    expect(tex.image.height).toBe(1);
    expect(tex.magFilter).toBe(NearestFilter);
    const d = tex.image.data as Uint8Array;
    expect(d[0]).toBeLessThan(d[4]);
    expect(d[4]).toBeLessThan(d[8]);
    const cool = buildToonGradient(3, true).image.data as Uint8Array;
    expect(cool[2]).toBeGreaterThan(cool[0]); // blue > red in the shadow band
  });
  it('clamps band count to 2..6', () => {
    expect(buildToonGradient(1, false).image.width).toBe(2);
    expect(buildToonGradient(9, false).image.width).toBe(6);
  });
});

describe('RVToonMaterialManager — material swap', () => {
  it('swaps MeshStandardMaterial → MeshToonMaterial copying key props', () => {
    const mgr = new RVToonMaterialManager(makeHost());
    const map = new Texture();
    const src = new MeshStandardMaterial({ color: 0x336699, transparent: true, opacity: 0.5, side: DoubleSide, vertexColors: true });
    src.map = map;
    const mesh = new Mesh(new BufferGeometry(), src);
    const root = new Object3D(); root.add(mesh);

    mgr.enable(root);
    expect(mesh.material).toBeInstanceOf(MeshToonMaterial);
    const toon = mesh.material as unknown as MeshToonMaterial;
    expect(toon.color.getHexString()).toBe(src.color.getHexString());
    expect(toon.opacity).toBe(0.5);
    expect(toon.side).toBe(DoubleSide);
    expect(toon.vertexColors).toBe(true);
    expect(toon.map).toBe(map);
    expect(toon.gradientMap).not.toBeNull();
  });

  it('restores the exact original material on disable', () => {
    const mgr = new RVToonMaterialManager(makeHost());
    const src = new MeshStandardMaterial({ color: 0xff0000 });
    const mesh = new Mesh(new BufferGeometry(), src);
    const root = new Object3D(); root.add(mesh);
    mgr.enable(root);
    expect(mesh.material).not.toBe(src);
    mgr.disable(root);
    expect(mesh.material).toBe(src);
  });

  it('dedups a shared source material to one toon material', () => {
    const mgr = new RVToonMaterialManager(makeHost());
    const shared = new MeshStandardMaterial({ color: 0x00ff00 });
    const a = new Mesh(new BufferGeometry(), shared);
    const b = new Mesh(new BufferGeometry(), shared);
    const root = new Object3D(); root.add(a); root.add(b);
    mgr.enable(root);
    expect(a.material).toBe(b.material);
  });

  it('skips fixtures from conversion', () => {
    const fixtures = new Set<Object3D>();
    const mgr = new RVToonMaterialManager(makeHost({ sceneFixtures: fixtures }));
    const src = new MeshStandardMaterial({ color: 0x123456 });
    const mesh = new Mesh(new BufferGeometry(), src);
    const root = new Object3D(); root.add(mesh);
    fixtures.add(mesh);
    mgr.enable(root);
    expect(mesh.material).toBe(src);
  });

  it('force-converts the ground fixture floor and restores it on disable', () => {
    const fixtures = new Set<Object3D>();
    const src = new MeshStandardMaterial({ color: 0x808080 });
    const ground = new Mesh(new BufferGeometry(), src);
    fixtures.add(ground); // the floor is a fixture (normally skipped)
    const mgr = new RVToonMaterialManager(makeHost({ sceneFixtures: fixtures, groundMesh: ground }));

    mgr.enable(null);
    expect(ground.material).toBeInstanceOf(MeshToonMaterial); // converted despite being a fixture
    mgr.disable(null);
    expect(ground.material).toBe(src); // original restored
  });
});

describe('RVToonMaterialManager — settings', () => {
  it('clamps bands to 2..6', () => {
    const mgr = new RVToonMaterialManager(makeHost());
    mgr.enable(null);
    mgr.setGradient(99, true); expect(mgr.bands).toBe(6);
    mgr.setGradient(1, true); expect(mgr.bands).toBe(2);
  });
  it('stores the edge distance cutoff (clamped to >= 0); defaults to 100m', () => {
    const mgr = new RVToonMaterialManager(makeHost());
    expect(mgr.outlineDistance).toBe(100);
    mgr.setOutline(1, 1.5, 0.3, '#000000', 25);
    expect(mgr.outlineDistance).toBe(25);
    mgr.setOutline(1, 1.5, 0.3, '#000000', -5);
    expect(mgr.outlineDistance).toBe(0);
    // omitting the distance arg keeps the current value
    mgr.setOutline(1, 1.5, 0.3, '#000000', 40);
    mgr.setOutline(0.5, 2, 0.2, '#111111');
    expect(mgr.outlineDistance).toBe(40);
  });
  it('clamps the metallic strength to 0..1 (default 0.85)', () => {
    const mgr = new RVToonMaterialManager(makeHost());
    expect(mgr.metallic).toBeCloseTo(0.85);
    mgr.setMetallic(2); expect(mgr.metallic).toBe(1);
    mgr.setMetallic(-1); expect(mgr.metallic).toBe(0);
  });
  it('round-trips the metallic colour (default #b0b4bc)', () => {
    const mgr = new RVToonMaterialManager(makeHost());
    expect(mgr.metallicColorHex).toBe('#b0b4bc');
    mgr.setMetallicColor('#ff0000');
    expect(mgr.metallicColorHex).toBe('#ff0000');
  });
  it('defaults the albedo grade to an identity transform', () => {
    const mgr = new RVToonMaterialManager(makeHost());
    expect(mgr.albedoMinBrightness).toBe(0);
    expect(mgr.albedoMaxBrightness).toBe(1);
    expect(mgr.albedoSaturation).toBe(1);
  });
  it('clamps albedo brightness to 0..1 and saturation to 0..2', () => {
    const mgr = new RVToonMaterialManager(makeHost());
    mgr.setAlbedo(2, 2, 5); // over-range
    expect(mgr.albedoMinBrightness).toBe(1);
    expect(mgr.albedoMaxBrightness).toBe(1);
    expect(mgr.albedoSaturation).toBe(2);
    mgr.setAlbedo(-1, -1, -1);
    expect(mgr.albedoMinBrightness).toBe(0);
    expect(mgr.albedoMaxBrightness).toBe(0);
    expect(mgr.albedoSaturation).toBe(0);
    // min/max clamped independently — an inverted ramp (min > max) is allowed.
    mgr.setAlbedo(0.8, 0.2, 1);
    expect(mgr.albedoMinBrightness).toBe(0.8);
    expect(mgr.albedoMaxBrightness).toBe(0.2);
  });
});

describe('RVToonMaterialManager — outline pass', () => {
  it('inserts the Sobel pass after OutputPass on enable; disables on leave', () => {
    const { host, composer } = makeComposerHost();
    const mgr = new RVToonMaterialManager(host);
    mgr.enable(null);
    const names = composer.passes.map((p) => p.constructor.name);
    const outIdx = composer.passes.findIndex((p) => p instanceof OutputPass);
    // After OutputPass: the Sobel outline (inserted at outIdx+1) then the
    // saturation grade (appended last).
    expect(names.slice(outIdx + 1)).toEqual(['ShaderPass', 'ShaderPass']);
    expect(mgr.outlineActive).toBe(true);
    expect(mgr.passActive).toBe(true);
    // gbuffer texture survives ShaderPass's uniform clone.
    const sobel = composer.passes[outIdx + 1] as unknown as { uniforms: Record<string, { value: unknown }> };
    expect(sobel.uniforms.tNormalDepth.value).not.toBeNull();

    mgr.disable(null);
    expect(mgr.outlineActive).toBe(false);
    expect(mgr.passActive).toBe(false);
  });

  it('2× supersample rebuilds the gbuffer and keeps the Sobel texture wired', () => {
    const { host } = makeComposerHost();
    const mgr = new RVToonMaterialManager(host);
    mgr.enable(null);
    expect(mgr.outlineSupersample).toBe(false);
    mgr.setSupersample(true);
    expect(mgr.outlineSupersample).toBe(true);
    // The Sobel still points at a (freshly rebuilt) gbuffer texture.
    const sobel = (host._composer!.passes.find((p) => p.constructor.name === 'ShaderPass')) as unknown as {
      uniforms: Record<string, { value: unknown }>;
    };
    expect(sobel.uniforms.tNormalDepth.value).not.toBeNull();
    mgr.setSupersample(false);
    expect(mgr.outlineSupersample).toBe(false);
  });

  it('outline off when amount is 0', () => {
    const { host, composer } = makeComposerHost();
    const mgr = new RVToonMaterialManager(host);
    mgr.setOutline(0, 2, 0.3, '#000000');
    mgr.enable(null);
    expect(mgr.outlineActive).toBe(false);
    const sobel = composer.passes.find((p) => p.constructor.name === 'ShaderPass');
    expect(sobel && sobel.enabled).toBe(false);
  });

  it('is inert on WebGPU', () => {
    const mgr = new RVToonMaterialManager(makeHost({ isWebGPU: true }));
    mgr.enable(null);
    expect(mgr.passActive).toBe(false);
    expect(mgr.outlineActive).toBe(false);
  });
});

describe('RVToonMaterialManager — saturation pass', () => {
  it('appends a saturation pass last and engages only when saturation != 1', () => {
    const { host, composer } = makeComposerHost();
    const mgr = new RVToonMaterialManager(host);
    // No outline, so the composer is needed ONLY for saturation.
    mgr.setOutline(0, 2, 0.3, '#000000');
    mgr.enable(null);

    // The saturation pass is the LAST pass and exposes uSaturation.
    const last = composer.passes[composer.passes.length - 1] as unknown as {
      enabled: boolean; uniforms: Record<string, { value: unknown }>;
    };
    expect(last.uniforms.uSaturation).toBeDefined();

    // Default saturation = 1 → identity → pass off, composer not forced on.
    expect(last.enabled).toBe(false);
    expect(mgr.saturationActive).toBe(false);
    expect(mgr.passActive).toBe(false);

    // Non-identity saturation enables the pass and forces the composer path.
    mgr.setAlbedo(0, 1, 0.5);
    expect(last.uniforms.uSaturation.value).toBe(0.5);
    expect(last.enabled).toBe(true);
    expect(mgr.saturationActive).toBe(true);
    expect(mgr.passActive).toBe(true);

    // Back to identity disables it again.
    mgr.setAlbedo(0, 1, 1);
    expect(last.enabled).toBe(false);
    expect(mgr.saturationActive).toBe(false);

    // Leaving toon mode disables the pass.
    mgr.setAlbedo(0, 1, 0.5);
    mgr.disable(null);
    expect(last.enabled).toBe(false);
    expect(mgr.saturationActive).toBe(false);
  });
});
