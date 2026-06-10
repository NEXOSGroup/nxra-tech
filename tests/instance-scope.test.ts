// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { instanceScope, scopeSignalName } from '../src/core/engine/rv-instance-scope';

function placedRoot(name: string): Object3D {
  const o = new Object3D();
  o.name = name;
  o.userData.realvirtual = { LayoutObject: { Label: name, CatalogId: 'c', Locked: false } };
  return o;
}

describe('instanceScope', () => {
  it('returns the nearest LayoutObject root name for any descendant (self included)', () => {
    const root = placedRoot('RollConveyor2m_2');
    const child = new Object3D(); child.name = 'Sensor'; root.add(child);
    const grandchild = new Object3D(); child.add(grandchild);
    expect(instanceScope(root)).toBe('RollConveyor2m_2');
    expect(instanceScope(child)).toBe('RollConveyor2m_2');
    expect(instanceScope(grandchild)).toBe('RollConveyor2m_2');
  });

  it("returns '' when not inside a LayoutObject (standalone asset)", () => {
    const root = new Object3D(); root.name = 'Scene';
    const child = new Object3D(); root.add(child);
    expect(instanceScope(child)).toBe('');
  });
});

describe('scopeSignalName', () => {
  it('prefixes with the scope', () => {
    expect(scopeSignalName('Inst', 'Flow.Run')).toBe('Inst/Flow.Run');
  });
  it('passes through unchanged when scope is empty', () => {
    expect(scopeSignalName('', 'Flow.Run')).toBe('Flow.Run');
  });
  it('treats a leading "/" as a global signal (strips it, never prefixes)', () => {
    expect(scopeSignalName('Inst', '/Machine.EStop')).toBe('Machine.EStop');
    expect(scopeSignalName('', '/Machine.EStop')).toBe('Machine.EStop');
  });
});
