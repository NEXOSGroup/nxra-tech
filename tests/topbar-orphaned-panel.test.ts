// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Regression tests for the "empty grey strip on the left" bug.
 *
 * The leftPanelManager slot (`activePanel`) persists in localStorage and is
 * restored on boot, but the gates that actually mount each panel don't persist
 * the same way — `settingsOpen` is never persisted, and the SceneStore singleton
 * may not exist yet when the slot is restored. `orphanedLeftSlot` detects that
 * desync so TopBar can drop the orphaned slot (otherwise the inset reserves an
 * empty strip). Plugin-backed panels (machine-control) drop their own slot.
 */

import { describe, it, expect } from 'vitest';
import { orphanedLeftSlot } from '../src/core/hmi/TopBar';

const READY = { settingsOpen: true, hierarchyOpen: true, sceneStoreReady: true };

describe('orphanedLeftSlot', () => {
  it('flags settings as orphaned when the lpm slot is open but settingsOpen is false (post-reload)', () => {
    expect(orphanedLeftSlot('settings', { ...READY, settingsOpen: false })).toBe('settings');
  });

  it('flags hierarchy as orphaned when the lpm slot is open but hierarchyOpen is false', () => {
    expect(orphanedLeftSlot('hierarchy', { ...READY, hierarchyOpen: false })).toBe('hierarchy');
  });

  it('flags scene as orphaned when the lpm slot is open but the SceneStore is not ready (init race)', () => {
    expect(orphanedLeftSlot('scene', { ...READY, sceneStoreReady: false })).toBe('scene');
  });

  it('returns null when settings slot and renderer agree (normal open)', () => {
    expect(orphanedLeftSlot('settings', READY)).toBeNull();
  });

  it('returns null when hierarchy slot and renderer agree (normal open)', () => {
    expect(orphanedLeftSlot('hierarchy', READY)).toBeNull();
  });

  it('returns null when scene slot and the SceneStore are both ready (normal open)', () => {
    expect(orphanedLeftSlot('scene', READY)).toBeNull();
  });

  it('returns null for unrelated panels (e.g. annotations/machine-control) — gated elsewhere', () => {
    expect(orphanedLeftSlot('annotations', { settingsOpen: false, hierarchyOpen: false, sceneStoreReady: false })).toBeNull();
    expect(orphanedLeftSlot('machine-control', { settingsOpen: false, hierarchyOpen: false, sceneStoreReady: false })).toBeNull();
  });

  it('returns null when no panel slot is active', () => {
    expect(orphanedLeftSlot(null, { settingsOpen: false, hierarchyOpen: false, sceneStoreReady: false })).toBeNull();
  });
});
