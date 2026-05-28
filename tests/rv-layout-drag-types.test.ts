// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { setLayoutDragData, getLayoutDragData, DT_CATALOG_ID } from '../src/plugins/layout-planner/drag-types';

describe('drag-types', () => {
  it('should roundtrip drag data via set/get', () => {
    const dt = new DataTransfer();
    setLayoutDragData(dt, { id: 'belt-01', glbUrl: 'test.glb', name: 'Belt', category: 'Transport' });

    const result = getLayoutDragData(dt);
    expect(result).not.toBeNull();
    expect(result!.catalogId).toBe('belt-01');
    expect(result!.glbUrl).toBe('test.glb');
    expect(result!.entryName).toBe('Belt');
    expect(result!.category).toBe('Transport');
  });

  it('should return null for non-layout drag', () => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'hello');
    expect(getLayoutDragData(dt)).toBeNull();
  });

  it('should handle missing glbUrl gracefully', () => {
    const dt = new DataTransfer();
    setLayoutDragData(dt, { id: 'x', name: 'X', category: 'C' });
    const result = getLayoutDragData(dt);
    expect(result!.glbUrl).toBe('');
  });

  it('should export DT_CATALOG_ID constant', () => {
    expect(DT_CATALOG_ID).toBe('text/x-layout-catalog-id');
  });
});
