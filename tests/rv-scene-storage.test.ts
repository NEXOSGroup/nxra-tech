// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import {
  listMetas,
  readScene,
  writeScene,
  deleteScene,
  readActiveId,
  writeActiveId,
  readDraft,
  writeDraft,
  clearDraft,
  listDraftBaseKeys,
  clearAllScenes,
} from '../src/core/hmi/scene/rv-scene-storage';
import {
  type RvScene,
  type SceneBase,
  baseKeyOf,
  baseLabelOf,
  newSceneId,
  metaOf,
  makeDraftScene,
  scenesEqual,
} from '../src/core/hmi/scene/rv-scene-types';

const builtin: SceneBase = { kind: 'builtin', url: '/models/Demo.glb', label: 'Demo' };
const empty: SceneBase = { kind: 'empty' };

function makeScene(name: string, base: SceneBase = empty): RvScene {
  const now = new Date().toISOString();
  return {
    id: newSceneId(),
    name,
    createdAt: now,
    modifiedAt: now,
    schemaVersion: 2,
    base,
    edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
  };
}

describe('rv-scene-storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('scene CRUD', () => {
    it('starts with no scenes', () => {
      expect(listMetas()).toEqual([]);
      expect(readActiveId()).toBeNull();
    });

    it('writes and reads a scene', () => {
      const s = makeScene('Cell A', builtin);
      const persisted = writeScene(s);
      expect(persisted.id).toBe(s.id);
      const got = readScene(s.id);
      expect(got?.name).toBe('Cell A');
      expect(got?.base.kind).toBe('builtin');
    });

    it('writeScene updates the index', () => {
      const s = writeScene(makeScene('Cell A'));
      const metas = listMetas();
      expect(metas).toHaveLength(1);
      expect(metas[0].id).toBe(s.id);
      expect(metas[0].baseKind).toBe('empty');
      expect(metas[0].baseLabel).toBe('(empty)');
    });

    it('writeScene bumps modifiedAt', async () => {
      const s = writeScene(makeScene('A'));
      await new Promise(r => setTimeout(r, 10));
      const updated = writeScene({
        ...s,
        edits: { ...s.edits, settings: { ...s.edits.settings, gridSizeMm: 250 } },
      });
      expect(updated.modifiedAt > s.modifiedAt).toBe(true);
      expect(readScene(s.id)?.edits.settings.gridSizeMm).toBe(250);
    });

    it('deleteScene removes blob + index entry, idempotent', () => {
      const s = writeScene(makeScene('A'));
      deleteScene(s.id);
      expect(readScene(s.id)).toBeNull();
      expect(listMetas()).toEqual([]);
      expect(() => deleteScene(s.id)).not.toThrow();
    });

    it('deleteScene clears active if it pointed at the deleted scene', () => {
      const s = writeScene(makeScene('A'));
      writeActiveId(s.id);
      deleteScene(s.id);
      expect(readActiveId()).toBeNull();
    });

    it('index is sorted by modifiedAt desc', async () => {
      const a = writeScene(makeScene('A'));
      await new Promise(r => setTimeout(r, 5));
      const b = writeScene(makeScene('B'));
      await new Promise(r => setTimeout(r, 5));
      const c = writeScene(makeScene('C'));
      const order = listMetas().map(m => m.id);
      expect(order).toEqual([c.id, b.id, a.id]);
    });

    it('readScene returns null for missing or wrong-schema records', () => {
      expect(readScene('does-not-exist')).toBeNull();
      localStorage.setItem('rv-scenes/bad', JSON.stringify({ id: 'bad', schemaVersion: 99 }));
      expect(readScene('bad')).toBeNull();
    });

    it('persists edits.ops + settings round-trip', () => {
      const s = makeScene('Rich');
      const rich: RvScene = {
        ...s,
        edits: {
          ops: [
            { id: 'op_1', ts: 1000, schemaV: 1, kind: 'setField',
              nodePath: 'Conveyor1', componentType: 'Drive', fieldName: 'TargetSpeed',
              value: 250, prev: 100 },
            { id: 'op_2', ts: 1001, schemaV: 1, kind: 'addPlacement',
              placement: {
                id: 'p1', catalogId: 'cat-a', glbUrl: '/models/x.glb', label: 'X',
                position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1],
              } },
            { id: 'op_3', ts: 1002, schemaV: 1, kind: 'setCamera',
              preset: { px: 1, py: 2, pz: 3, tx: 0, ty: 0, tz: 0 }, prev: null },
          ],
          settings: { catalogUrls: [], gridSizeMm: 100 },
        },
      };
      writeScene(rich);
      const got = readScene(s.id)!;
      expect(got.edits.ops).toHaveLength(3);
      expect(got.edits.ops[0].kind).toBe('setField');
      expect(got.edits.ops[1].kind).toBe('addPlacement');
      expect(got.edits.ops[2].kind).toBe('setCamera');
      expect(got.edits.settings.gridSizeMm).toBe(100);
    });
  });

  describe('active id', () => {
    it('round-trips an id', () => {
      writeActiveId('scn_abc');
      expect(readActiveId()).toBe('scn_abc');
    });

    it('clears with null', () => {
      writeActiveId('scn_abc');
      writeActiveId(null);
      expect(readActiveId()).toBeNull();
    });

    it('returns null for malformed payload', () => {
      localStorage.setItem('rv-scenes/active', 'not-json');
      expect(readActiveId()).toBeNull();
    });
  });

  describe('per-base drafts', () => {
    it('empty and builtin bases have distinct draft slots', () => {
      const draftEmpty = makeDraftScene(empty, 'Untitled empty');
      const draftBuiltin = makeDraftScene(builtin, 'Untitled demo');
      writeDraft(empty, draftEmpty);
      writeDraft(builtin, draftBuiltin);
      expect(readDraft(empty)?.name).toBe('Untitled empty');
      expect(readDraft(builtin)?.name).toBe('Untitled demo');
    });

    it('clearDraft removes a single base slot only', () => {
      writeDraft(empty, makeDraftScene(empty));
      writeDraft(builtin, makeDraftScene(builtin));
      clearDraft(empty);
      expect(readDraft(empty)).toBeNull();
      expect(readDraft(builtin)).not.toBeNull();
    });

    it('listDraftBaseKeys enumerates all stored draft slots', () => {
      writeDraft(empty, makeDraftScene(empty));
      writeDraft(builtin, makeDraftScene(builtin));
      const keys = listDraftBaseKeys().sort();
      expect(keys).toEqual([baseKeyOf(builtin), baseKeyOf(empty)].sort());
    });

    it('readDraft returns null for missing slots', () => {
      expect(readDraft(empty)).toBeNull();
      expect(readDraft(builtin)).toBeNull();
    });
  });

  describe('clearAllScenes', () => {
    it('removes scenes, index, active and drafts', () => {
      writeScene(makeScene('A'));
      writeScene(makeScene('B'));
      writeActiveId('scn_x');
      writeDraft(empty, makeDraftScene(empty));
      writeDraft(builtin, makeDraftScene(builtin));
      clearAllScenes();
      expect(listMetas()).toEqual([]);
      expect(readActiveId()).toBeNull();
      expect(listDraftBaseKeys()).toEqual([]);
    });
  });
});

describe('rv-scene-types helpers', () => {
  it('baseKeyOf is stable and distinguishes empty from builtin', () => {
    expect(baseKeyOf({ kind: 'empty' })).toBe('empty');
    const k = baseKeyOf({ kind: 'builtin', url: '/models/Demo.glb', label: 'Demo' });
    expect(k.startsWith('builtin:')).toBe(true);
    expect(k).not.toBe('empty');
  });

  it('baseLabelOf', () => {
    expect(baseLabelOf({ kind: 'empty' })).toBe('(empty)');
    expect(baseLabelOf({ kind: 'builtin', url: '/x.glb', label: 'Demo' })).toBe('Demo');
  });

  it('newSceneId is prefixed and unique per call', () => {
    const a = newSceneId();
    const b = newSceneId();
    expect(a).toMatch(/^scn_/);
    expect(a).not.toBe(b);
  });

  it('metaOf projects the right fields', () => {
    const s: RvScene = {
      ...makeDraftScene({ kind: 'builtin', url: '/x.glb', label: 'X' }, 'Hello'),
      id: 'scn_test',
    };
    const m = metaOf(s);
    expect(m.id).toBe('scn_test');
    expect(m.name).toBe('Hello');
    expect(m.baseKind).toBe('builtin');
    expect(m.baseLabel).toBe('X');
  });

  it('scenesEqual treats deep-equal scenes as equal regardless of modifiedAt', () => {
    const base: SceneBase = { kind: 'empty' };
    const a: RvScene = {
      id: 'scn_x',
      name: 'X',
      createdAt: '2025-01-01T00:00:00.000Z',
      modifiedAt: '2025-01-01T00:00:00.000Z',
      schemaVersion: 2,
      base,
      edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
    };
    const b: RvScene = { ...a, modifiedAt: '2099-01-01T00:00:00.000Z' };
    expect(scenesEqual(a, b)).toBe(true);
  });

  it('scenesEqual detects ops differences', () => {
    const a: RvScene = makeDraftScene({ kind: 'empty' }, 'A');
    const b: RvScene = {
      ...a,
      edits: {
        ...a.edits,
        ops: [{
          id: 'op_x', ts: 1, schemaV: 1, kind: 'setField',
          nodePath: 'N', componentType: 'Drive', fieldName: 'Speed', value: 100, prev: 0,
        }],
      },
    };
    expect(scenesEqual(a, b)).toBe(false);
  });

  it('scenesEqual treats two scenes with the same op id sequence as equal', () => {
    const op = {
      id: 'op_shared', ts: 1, schemaV: 1 as const, kind: 'setField' as const,
      nodePath: 'N', componentType: 'C', fieldName: 'F', value: 1, prev: 0,
    };
    const a: RvScene = { ...makeDraftScene({ kind: 'empty' }, 'A'),
      edits: { ops: [op], settings: { catalogUrls: [], gridSizeMm: 500 } } };
    const b: RvScene = { ...a };
    expect(scenesEqual(a, b)).toBe(true);
  });
});
