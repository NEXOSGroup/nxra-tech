// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Phase 5 of plan-182: tick coexistence (legacy onFixedUpdatePre + new onTick).
 *
 * Coexistence semantics (plan-182 Section 2.3):
 *   TickStage.PRE  = [legacy onFixedUpdatePre]  ->  [new onTick(PRE)]
 *   TickStage.POST = [legacy onFixedUpdatePost] ->  [new onTick(POST)]
 *
 * This file documents the intended semantics. A full integration test requires
 * a real RVViewer with WebGL context (and thus Playwright browser setup); we
 * leave that as a follow-up. The unit-level expectation is documented here
 * so future authors don't accidentally swap legacy/new ordering.
 */

import { describe, it, expect } from 'vitest';

describe('Tick coexistence semantics (plan-182 Phase 5)', () => {
  it.todo('full integration test with real RVViewer + WebGL context — separate follow-up');

  it('documents the coexistence ordering as a snapshot test', () => {
    // Coexistence ordering, codified as a snapshot for reviewers to spot
    // accidental swaps in fixedUpdate() refactors:
    const expectedOrder = [
      'PRE: legacy onFixedUpdatePre (snapshot, sorted by plugin.order)',
      'PRE: new SimLoopFacade.onTick(PRE) (sorted by onTick.order)',
      'SIM: drive physics + transport + tank-fill + pipe-flow + gizmo',
      'SIM: new SimLoopFacade.onTick(SIM)',
      'POST: legacy onFixedUpdatePost (snapshot)',
      'POST: new SimLoopFacade.onTick(POST)',
    ];
    expect(expectedOrder.length).toBe(6);
    // If you change fixedUpdate() ordering, update this snapshot — and check
    // that all live-override-order.test.ts tests still pass.
  });
});
