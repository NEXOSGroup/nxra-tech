// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * LayoutStore.setThumbnailPending — drives the per-card "auto-generating"
 * spinner. Verifies the pending set is reflected in the snapshot and that
 * redundant updates do not churn snapshot identity.
 */

import { describe, it, expect } from 'vitest';
import { LayoutStore } from '../src/plugins/layout-planner/rv-layout-store';

describe('LayoutStore.setThumbnailPending', () => {
  it('reflects pending entry ids in the snapshot', () => {
    const store = new LayoutStore();
    expect(store.getSnapshot().thumbnailPending.has('a')).toBe(false);

    store.setThumbnailPending('a', true);
    expect(store.getSnapshot().thumbnailPending.has('a')).toBe(true);

    store.setThumbnailPending('a', false);
    expect(store.getSnapshot().thumbnailPending.has('a')).toBe(false);
  });

  it('is a no-op (no new snapshot) when the state does not change', () => {
    const store = new LayoutStore();
    const before = store.getSnapshot();
    store.setThumbnailPending('x', false); // already absent
    expect(store.getSnapshot()).toBe(before); // same identity → no notify
  });

  it('notifies subscribers when a pending id is added', () => {
    const store = new LayoutStore();
    let calls = 0;
    store.subscribe(() => { calls++; });
    store.setThumbnailPending('y', true);
    expect(calls).toBe(1);
  });
});
