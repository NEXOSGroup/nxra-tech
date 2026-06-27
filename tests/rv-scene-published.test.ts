// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SceneStore — "Examples" (published scene) behaviour.
 *
 * Covers the catalogue mirror, transient open (read-only, no localStorage),
 * preferred-mode switching, and the "Add to My Scenes" import that turns a
 * read-only demo into an editable user-owned scene.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import type { PublishedSceneEntry } from '../src/core/hmi/scene/rv-published-scenes';
import { listMetas } from '../src/core/hmi/scene/rv-scene-storage';

const exampleScene: RvScene = {
  id: 'scn_published_src',
  name: 'DemoPlanner',
  createdAt: '2026-01-01T00:00:00.000Z',
  modifiedAt: '2026-01-01T00:00:00.000Z',
  schemaVersion: 2,
  base: { kind: 'empty' },
  edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
};

const entry: PublishedSceneEntry = {
  file: 'DemoPlanner.scene.json',
  urlName: 'DemoPlanner',
  label: 'Planner Demo',
  mode: 'planner',
};

interface FakeViewer {
  loadScene: (s: RvScene) => Promise<void>;
  loadEmptyScene: () => Promise<void>;
  getPlugin: <T>(id: string) => T | undefined;
  availableModels: { url: string; label: string }[];
  availablePublishedScenes: PublishedSceneEntry[];
  currentScene: RvScene | null;
  currentModelUrl: string | null;
  modes: { has: (id: string) => boolean; setMode: (id: string) => void };
  loadScenes: RvScene[];
}

function makeViewer(): FakeViewer {
  const v: FakeViewer = {
    loadScenes: [],
    availableModels: [],
    availablePublishedScenes: [entry],
    currentScene: null,
    currentModelUrl: null,
    modes: { has: (id: string) => id === 'planner', setMode: vi.fn() },
    loadScene: vi.fn(async (s: RvScene) => { v.loadScenes.push(s); v.currentScene = s; }),
    loadEmptyScene: vi.fn(async () => { v.currentScene = null; }),
    getPlugin: () => undefined,
  };
  return v;
}

describe('SceneStore — Examples / published scenes', () => {
  let viewer: FakeViewer;
  let store: SceneStore;

  beforeEach(() => {
    localStorage.clear();
    viewer = makeViewer();
    // Every published fetch resolves to a FRESH example scene Response (a Response
    // body can only be read once, so repeated imports need a new instance each call).
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify(exampleScene), { status: 200 }),
    );
    store = new SceneStore(viewer as unknown as ConstructorParameters<typeof SceneStore>[0]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mirrors viewer.availablePublishedScenes into the snapshot', () => {
    expect(store.getSnapshot().published).toEqual([entry]);
    expect(store.listPublished()).toEqual([entry]);
  });

  it('openPublishedExample loads transiently and switches mode, no localStorage write', async () => {
    await store.openPublishedExample(entry);

    // Not persisted as a My Scene.
    expect(listMetas()).toHaveLength(0);
    // Loaded into the workspace as a fresh (unsaved) draft.
    const snap = store.getSnapshot();
    expect(snap.isDraft).toBe(true);
    expect(snap.saved).toBeNull();
    expect(snap.draft?.name).toBe('DemoPlanner');
    expect(viewer.loadScene).toHaveBeenCalledTimes(1);
    // Preferred mode applied.
    expect(viewer.modes.setMode).toHaveBeenCalledWith('planner');
    // The open example is marked active so its row can highlight.
    expect(snap.activePublishedName).toBe('DemoPlanner');
  });

  it('opening another scene clears the active-example marker', async () => {
    await store.openPublishedExample(entry);
    expect(store.getSnapshot().activePublishedName).toBe('DemoPlanner');
    await store.newEmpty();
    expect(store.getSnapshot().activePublishedName).toBeNull();
  });

  it('rejects an example scene whose edits.settings is missing', async () => {
    const bad = { ...exampleScene, edits: { ops: [] } };
    // Override the beforeEach mock (already a spy) for this case.
    vi.mocked(globalThis.fetch).mockImplementation(
      async () => new Response(JSON.stringify(bad), { status: 200 }),
    );
    await expect(store.openPublishedExample(entry)).rejects.toThrow(/Invalid example scene/);
    expect(listMetas()).toHaveLength(0);
  });

  it('addPublishedToMyScenes creates an editable My Scene under the example label', async () => {
    const id = await store.addPublishedToMyScenes(entry);

    const metas = listMetas();
    expect(metas).toHaveLength(1);
    expect(metas[0].name).toBe('Planner Demo');
    expect(metas[0].id).toBe(id);

    // The new scene is opened and is a saved (editable, non-draft) workspace.
    const snap = store.getSnapshot();
    expect(snap.isDraft).toBe(false);
    expect(snap.saved?.id).toBe(id);
    expect(snap.saved?.name).toBe('Planner Demo');
    expect(snap.dirty).toBe(false);

    // Preferred mode applied for the opened copy too.
    expect(viewer.modes.setMode).toHaveBeenCalledWith('planner');
    // The opened copy is a My Scene, not the transient example — no active marker.
    expect(snap.activePublishedName).toBeNull();
  });

  it('addPublishedToMyScenes does not inherit the source scene id', async () => {
    const id = await store.addPublishedToMyScenes(entry);
    expect(id).not.toBe(exampleScene.id);
  });

  it('disambiguates the name on repeated imports', async () => {
    await store.addPublishedToMyScenes(entry);
    await store.addPublishedToMyScenes(entry);
    await store.addPublishedToMyScenes(entry);
    const names = listMetas().map(m => m.name).sort();
    expect(names).toEqual(['Planner Demo', 'Planner Demo (2)', 'Planner Demo (3)']);
  });
});
