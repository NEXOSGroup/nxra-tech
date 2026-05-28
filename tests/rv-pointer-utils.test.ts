// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Vector2 } from 'three';
import { pointerToNDC } from '../src/core/engine/rv-pointer-utils';

describe('pointerToNDC', () => {
  const mockElement = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  } as HTMLElement;

  it('should return (-1,-1) for bottom-left corner', () => {
    const out = new Vector2();
    pointerToNDC(0, 600, mockElement, out);
    expect(out.x).toBeCloseTo(-1);
    expect(out.y).toBeCloseTo(-1);
  });

  it('should return (0,0) for center', () => {
    const out = new Vector2();
    pointerToNDC(400, 300, mockElement, out);
    expect(out.x).toBeCloseTo(0);
    expect(out.y).toBeCloseTo(0);
  });

  it('should return (1,1) for top-right corner', () => {
    const out = new Vector2();
    pointerToNDC(800, 0, mockElement, out);
    expect(out.x).toBeCloseTo(1);
    expect(out.y).toBeCloseTo(1);
  });

  it('should handle offset canvas (rect.left/top != 0)', () => {
    const offset = {
      getBoundingClientRect: () => ({ left: 100, top: 50, width: 400, height: 300 }),
    } as HTMLElement;
    const out = new Vector2();
    pointerToNDC(300, 200, offset, out);
    expect(out.x).toBeCloseTo(0);
    expect(out.y).toBeCloseTo(0);
  });

  it('should use internal pre-allocated vector when no out is provided', () => {
    const result = pointerToNDC(400, 300, mockElement);
    expect(result.x).toBeCloseTo(0);
    expect(result.y).toBeCloseTo(0);
  });
});
