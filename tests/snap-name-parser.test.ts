// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import {
  parseSnapName,
  oppositeDirection,
} from '../src/plugins/snap-point/snap-name-parser';

describe('parseSnapName', () => {
  it('parses canonical Snap-ZN-convroll', () => {
    const r = parseSnapName('Snap-ZN-convroll');
    expect(r).not.toBeNull();
    expect(r!.dir.code).toBe('ZN');
    expect(r!.dir.axis).toBe('Z');
    expect(r!.dir.sign).toBe('N');
    expect(r!.typeId).toBe('convroll');
  });

  it('parses Snap-ZP-convroll', () => {
    const r = parseSnapName('Snap-ZP-convroll');
    expect(r!.dir.code).toBe('ZP');
    expect(r!.typeId).toBe('convroll');
  });

  it('handles TypeId with embedded hyphens (greedy)', () => {
    const r = parseSnapName('Snap-XN-conv-roll-heavy');
    expect(r).not.toBeNull();
    expect(r!.typeId).toBe('conv-roll-heavy');
    expect(r!.dir.code).toBe('XN');
  });

  it('handles all axis-sign combinations including B (bidi)', () => {
    for (const code of ['XN', 'XP', 'XB', 'YN', 'YP', 'YB', 'ZN', 'ZP', 'ZB'] as const) {
      const r = parseSnapName(`Snap-${code}-foo`);
      expect(r!.dir.code).toBe(code);
    }
  });

  it('maps sign letter to flow semantics (N=in, P=out, B=bidi)', () => {
    expect(parseSnapName('Snap-ZN-convroll')!.flow).toBe('in');
    expect(parseSnapName('Snap-ZP-convroll')!.flow).toBe('out');
    expect(parseSnapName('Snap-ZB-convroll')!.flow).toBe('bidi');
    expect(parseSnapName('Snap-XN-foo')!.flow).toBe('in');
    expect(parseSnapName('Snap-XP-foo')!.flow).toBe('out');
    expect(parseSnapName('Snap-XB-foo')!.flow).toBe('bidi');
  });

  it('rejects unrelated names', () => {
    expect(parseSnapName('Base')).toBeNull();
    expect(parseSnapName('')).toBeNull();
    expect(parseSnapName('Snap-AB-foo')).toBeNull();      // invalid dir
    expect(parseSnapName('snap-zn-convroll')).toBeNull(); // case-sensitive
    expect(parseSnapName('Snap-ZN-')).toBeNull();          // empty typeId
    expect(parseSnapName('Snap-ZN')).toBeNull();           // no typeId at all
    expect(parseSnapName('SnapZNconvroll')).toBeNull();    // no hyphens
  });

  it('opposite direction maps correctly for N/P; B returns itself', () => {
    expect(oppositeDirection({ axis: 'Z', sign: 'N', code: 'ZN' })).toBe('ZP');
    expect(oppositeDirection({ axis: 'Z', sign: 'P', code: 'ZP' })).toBe('ZN');
    expect(oppositeDirection({ axis: 'X', sign: 'N', code: 'XN' })).toBe('XP');
    expect(oppositeDirection({ axis: 'X', sign: 'P', code: 'XP' })).toBe('XN');
    expect(oppositeDirection({ axis: 'Y', sign: 'N', code: 'YN' })).toBe('YP');
    expect(oppositeDirection({ axis: 'Y', sign: 'P', code: 'YP' })).toBe('YN');
    expect(oppositeDirection({ axis: 'Z', sign: 'B', code: 'ZB' })).toBe('ZB');
  });
});

describe('flowsCompatible', () => {
  it('in ↔ out is allowed', async () => {
    const { flowsCompatible } = await import('../src/plugins/snap-point/snap-name-parser');
    expect(flowsCompatible('in', 'out')).toBe(true);
    expect(flowsCompatible('out', 'in')).toBe(true);
  });

  it('bidi ↔ anything is allowed', async () => {
    const { flowsCompatible } = await import('../src/plugins/snap-point/snap-name-parser');
    expect(flowsCompatible('bidi', 'in')).toBe(true);
    expect(flowsCompatible('bidi', 'out')).toBe(true);
    expect(flowsCompatible('bidi', 'bidi')).toBe(true);
    expect(flowsCompatible('in', 'bidi')).toBe(true);
  });

  it('in ↔ in is rejected', async () => {
    const { flowsCompatible } = await import('../src/plugins/snap-point/snap-name-parser');
    expect(flowsCompatible('in', 'in')).toBe(false);
  });

  it('out ↔ out is rejected', async () => {
    const { flowsCompatible } = await import('../src/plugins/snap-point/snap-name-parser');
    expect(flowsCompatible('out', 'out')).toBe(false);
  });

  it('undefined is treated as bidi', async () => {
    const { flowsCompatible } = await import('../src/plugins/snap-point/snap-name-parser');
    expect(flowsCompatible(undefined, 'in')).toBe(true);
    expect(flowsCompatible('out', undefined)).toBe(true);
    expect(flowsCompatible(undefined, undefined)).toBe(true);
  });
});
