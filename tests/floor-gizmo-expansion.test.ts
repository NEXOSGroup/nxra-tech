// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * FloorGizmo expansion-target hysteresis tests.
 *
 * `resolveExpansionTarget` decides whether the gizmo should be minimized
 * (0 = small green disk) or full (1) from cursor proximity, with a hysteresis
 * band between EXPAND_RADIUS_PX (10.5) and COLLAPSE_RADIUS_PX (19.5). Dragging and
 * "no pointer" force 0; the minimize feature being disabled forces 1.
 */

import { describe, it, expect } from 'vitest';
import { resolveExpansionTarget } from '../src/plugins/layout-planner/floor-gizmo';

const ON = { dragging: false, hasPointer: true, enabled: true };

describe('resolveExpansionTarget', () => {
  it('expands when the cursor is inside the expand radius', () => {
    expect(resolveExpansionTarget(4, 0, ON)).toBe(1);
    expect(resolveExpansionTarget(10, 0, ON)).toBe(1);
  });

  it('collapses when the cursor is beyond the collapse radius', () => {
    expect(resolveExpansionTarget(200, 1, ON)).toBe(0);
    expect(resolveExpansionTarget(22, 1, ON)).toBe(0);
  });

  it('holds the previous state inside the hysteresis band', () => {
    // distPx = 15 is between EXPAND (10.5) and COLLAPSE (19.5).
    expect(resolveExpansionTarget(15, 1, ON)).toBe(1); // stays expanded
    expect(resolveExpansionTarget(15, 0, ON)).toBe(0); // stays collapsed
  });

  it('stays minimal while dragging, regardless of proximity', () => {
    expect(resolveExpansionTarget(0, 1, { ...ON, dragging: true })).toBe(0);
  });

  it('stays minimal when there is no pointer (e.g. touch / cursor left canvas)', () => {
    expect(resolveExpansionTarget(0, 1, { ...ON, hasPointer: false })).toBe(0);
  });

  it('is always full when the minimize feature is disabled', () => {
    expect(resolveExpansionTarget(500, 0, { ...ON, enabled: false })).toBe(1);
    // ...even while dragging.
    expect(resolveExpansionTarget(500, 0, { dragging: true, hasPointer: false, enabled: false })).toBe(1);
  });
});
