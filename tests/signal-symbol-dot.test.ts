// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-symbol-dot.test.ts — Plan 200 §9.1 (SYM dot-symbol + interlock).
 *
 * The PLC-facing signal SYMBOL is dot-scoped (`${scope}.${name}`); the per-root
 * Occupied interlock symbol is built by the single shared `flowOccupiedRootSignal`
 * helper so producer (the publishing side) and consumer (the reading side) can
 * never diverge on the separator. This test pins both the scope separator and the
 * interlock-symbol shape, plus the round-trip that a leading `/` (the
 * already-qualified marker) survives the scope strip.
 */

import { describe, it, expect } from 'vitest';
import { scopeSignalName } from '../src/core/engine/rv-instance-scope';
import { FLOW_OCCUPIED, flowOccupiedRootSignal } from '../src/behaviors/_shared/transport-links';

describe('scopeSignalName — dot symbol', () => {
  it('joins scope and name with a dot (the PLC symbol token)', () => {
    expect(scopeSignalName('RollConveyor-1m', 'Flow.Occupied')).toBe('RollConveyor-1m.Flow.Occupied');
    expect(scopeSignalName('Turntable_2', 'Flow.Run')).toBe('Turntable_2.Flow.Run');
  });

  it('passes through unchanged when the scope is empty (standalone asset)', () => {
    expect(scopeSignalName('', 'Flow.Occupied')).toBe('Flow.Occupied');
  });

  it('treats a leading "/" as already-qualified (strips it, never prefixes)', () => {
    expect(scopeSignalName('Inst', '/Machine.EStop')).toBe('Machine.EStop');
    expect(scopeSignalName('', '/Machine.EStop')).toBe('Machine.EStop');
  });
});

describe('flowOccupiedRootSignal — shared interlock symbol (SSOT)', () => {
  it('builds the `/`-qualified per-root Occupied symbol with the dot separator', () => {
    expect(flowOccupiedRootSignal('RollConveyor-1m')).toBe('/RollConveyor-1m.Flow.Occupied');
    expect(flowOccupiedRootSignal('TT')).toBe(`/TT.${FLOW_OCCUPIED}`);
  });

  it('resolves to the SAME store key the dot-scoped publisher writes', () => {
    // Publisher side: a conveyor publishes its Occupied via the scoped `Flow.Occupied`
    // symbol → scopeSignalName('ConvB','Flow.Occupied') = 'ConvB.Flow.Occupied'.
    const published = scopeSignalName('ConvB', FLOW_OCCUPIED);
    // Consumer side: an upstream interlock reads flowOccupiedRootSignal('ConvB'),
    // whose leading `/` (already-qualified marker) is stripped by scopeSignalName
    // when the bind context resolves it → identical store key.
    const consumed = scopeSignalName('AnyOtherScope', flowOccupiedRootSignal('ConvB'));
    expect(consumed).toBe(published);
    expect(consumed).toBe('ConvB.Flow.Occupied');
  });
});
