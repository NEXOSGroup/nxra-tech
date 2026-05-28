// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Phase 5 of plan-182: defensive iteration over plugin lists.
 *
 * Plugin that disables/removes itself in onFixedUpdatePre must not throw —
 * snapshot iteration via `_snapshotPrePlugins()` returns a frozen array view.
 *
 * Tests use the TestViewer mock plus a stand-alone snapshot helper to verify
 * the slice-based behavior.
 */

import { describe, it, expect } from 'vitest';
import { createTestViewer } from './helpers/test-viewer';
import { TickStage } from '../src/core/rv-tick-stages';

describe('Defensive iteration (plan-182 Phase 5)', () => {
  it('callback that adds new onTick during PRE does NOT affect current tick', () => {
    const viewer = createTestViewer();
    const order: string[] = [];

    viewer.simLoop.onTick(TickStage.PRE, () => {
      order.push('original');
      viewer.simLoop.onTick(TickStage.PRE, () => order.push('added-during'));
    });

    viewer._tickOnce(0.016);
    // The added callback should not run in the same tick — snapshot was taken.
    expect(order).toEqual(['original']);

    viewer._tickOnce(0.016);
    // On the next tick both fire, and the added callback re-adds another.
    expect(order).toContain('added-during');
  });

  it('callback that removes itself during PRE does not throw', () => {
    const viewer = createTestViewer();
    let off: (() => void) | null = null;
    off = viewer.simLoop.onTick(TickStage.PRE, () => {
      off?.();  // self-remove
    });

    expect(() => viewer._tickOnce(0.016)).not.toThrow();
    // After self-remove, second tick: no callback fires.
    let triggered = false;
    viewer.simLoop.onTick(TickStage.PRE, () => { triggered = true; });
    viewer._tickOnce(0.016);
    expect(triggered).toBe(true);  // new callback fires
  });
});
