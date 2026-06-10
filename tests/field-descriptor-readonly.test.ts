// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for the readonly FieldDescriptor flag (plan-197 Step 1, F3).
 *
 * Covers three layers of the readonly gate:
 *   1. `isFieldEditable` — the pure editability decision (no React).
 *   2. `updateOverlayField` — the overlay write path refuses readonly fields.
 *   3. `applyLiveEdit` — the live-edit write path refuses readonly fields.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { registerComponentSchema, getFieldDescriptor } from '../src/core/engine/rv-component-registry';
import { isFieldEditable } from '../src/core/hmi/rv-field-row';
import { RvExtrasEditorPlugin } from '../src/core/hmi/rv-extras-editor';
import { applyLiveEdit, type ResolverViewer } from '../src/core/hmi/rv-value-resolver';

// ── 1. isFieldEditable (pure) ───────────────────────────────────────────────

describe('isFieldEditable', () => {
  it('is false for a consumed, non-reference field marked readonly', () => {
    expect(isFieldEditable('consumed', false, { type: 'number', readonly: true })).toBe(false);
  });

  it('is true for a consumed, non-reference field that is not readonly', () => {
    expect(isFieldEditable('consumed', false, { type: 'number', readonly: false })).toBe(true);
  });

  it('is true for a consumed, non-reference field with no descriptor', () => {
    expect(isFieldEditable('consumed', false, undefined)).toBe(true);
  });

  it('is false for a reference field even when consumed and not readonly', () => {
    expect(isFieldEditable('consumed', true, { type: 'componentRef' })).toBe(false);
  });

  it('is false for a non-consumed field', () => {
    expect(isFieldEditable('ignored', false, { type: 'number' })).toBe(false);
  });
});

// ── getFieldDescriptor lookup (sanity for the readonly metadata source) ──────

describe('getFieldDescriptor', () => {
  it('returns the descriptor for a registered schema field, with readonly intact', () => {
    registerComponentSchema('RoFooLookup', {
      Locked: { type: 'number', readonly: true },
      Free: { type: 'number' },
    });
    expect(getFieldDescriptor('RoFooLookup', 'Locked')?.readonly).toBe(true);
    expect(getFieldDescriptor('RoFooLookup', 'Free')?.readonly).toBeUndefined();
    expect(getFieldDescriptor('RoFooLookup', 'Missing')).toBeUndefined();
    expect(getFieldDescriptor('UnknownType', 'Locked')).toBeUndefined();
  });

  it('resolves a readonly descriptor via an alias', () => {
    registerComponentSchema('RoAliasLookup', {
      MaxSpeed: { type: 'number', readonly: true, aliases: ['TopSpeed'] },
    });
    expect(getFieldDescriptor('RoAliasLookup', 'TopSpeed')?.readonly).toBe(true);
  });
});

// ── 2. updateOverlayField blocks readonly writes ────────────────────────────

describe('RvExtrasEditorPlugin.updateOverlayField — readonly gate', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  /** Build a viewer with one node carrying `RoEditorType` component data. */
  function makeViewer(): { viewer: { registry: NodeRegistry; scene: Object3D }; node: Object3D } {
    const registry = new NodeRegistry();
    const scene = new Object3D();
    const node = new Object3D();
    node.name = 'Widget';
    node.userData.realvirtual = {
      RoEditorType: { MaxSpeed: 1000, Period: 1 },
    };
    scene.add(node);
    registry.registerNode('Cell/Widget', node);
    return { viewer: { registry, scene }, node };
  }

  it('refuses to write a readonly field and leaves the value untouched', () => {
    registerComponentSchema('RoEditorType', {
      MaxSpeed: { type: 'number', readonly: true },
      Period: { type: 'number' },
    });
    const plugin = new RvExtrasEditorPlugin();
    const { viewer, node } = makeViewer();
    // Inject the viewer so readSceneField/applyFieldToScene work in the test.
    (plugin as unknown as { _viewer: unknown })._viewer = viewer;

    const ok = plugin.updateOverlayField('Cell/Widget', 'RoEditorType', 'MaxSpeed', 9999);

    expect(ok).toBe(false);
    const rv = node.userData.realvirtual as Record<string, Record<string, unknown>>;
    expect(rv.RoEditorType.MaxSpeed).toBe(1000); // unchanged
  });

  it('allows writing a non-readonly field on the same component', () => {
    registerComponentSchema('RoEditorType', {
      MaxSpeed: { type: 'number', readonly: true },
      Period: { type: 'number' },
    });
    const plugin = new RvExtrasEditorPlugin();
    const { viewer, node } = makeViewer();
    (plugin as unknown as { _viewer: unknown })._viewer = viewer;

    const ok = plugin.updateOverlayField('Cell/Widget', 'RoEditorType', 'Period', 5);

    expect(ok).toBe(true);
    const rv = node.userData.realvirtual as Record<string, Record<string, unknown>>;
    expect(rv.RoEditorType.Period).toBe(5);
  });
});

// ── 3. applyLiveEdit blocks readonly writes ─────────────────────────────────

describe('applyLiveEdit — readonly gate', () => {
  // applyLiveEdit reads the schema from the instance's constructor static
  // `schema` (via coerceScalar). Use a class with a matching static schema so
  // the positive (non-readonly) case actually coerces and assigns.
  class RoLiveComponent {
    static schema = {
      MaxSpeed: { type: 'number', readonly: true } as const,
      Period: { type: 'number' } as const,
    };
    isOwner = true;
    MaxSpeed = 100;
    Period = 1;
    constructor(public node: Object3D) {}
  }

  it('does not push a readonly field into the live component instance', () => {
    registerComponentSchema('RoLiveType', RoLiveComponent.schema);

    const node = new Object3D();
    const inst = new RoLiveComponent(node);
    const registry = new NodeRegistry();
    registry.registerNode('Cell/Live', node);
    registry.register('RoLiveType', 'Cell/Live', inst);

    const viewer: ResolverViewer = { registry, signalStore: null };

    applyLiveEdit(viewer, 'Cell/Live', 'RoLiveType', 'MaxSpeed', 9999);

    expect(inst.MaxSpeed).toBe(100); // unchanged — readonly blocked the write
  });

  it('still pushes a non-readonly scalar field into the live component', () => {
    registerComponentSchema('RoLiveType2', RoLiveComponent.schema);

    const node = new Object3D();
    const inst = new RoLiveComponent(node);
    const registry = new NodeRegistry();
    registry.registerNode('Cell/Live2', node);
    registry.register('RoLiveType2', 'Cell/Live2', inst);

    const viewer: ResolverViewer = { registry, signalStore: null };

    applyLiveEdit(viewer, 'Cell/Live2', 'RoLiveType2', 'Period', 7);

    expect(inst.Period).toBe(7);
  });
});
