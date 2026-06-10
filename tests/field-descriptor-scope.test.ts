// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for the declarative FieldDescriptor.scope flag (plan-198).
 *
 * `scope` is additive on top of `readonly`:
 *   'live' (default) → editable inspector row (today's behavior, unchanged).
 *   'des'            → DES-only config: read-only row, write paths blocked,
 *                       "(DES)" tag. Treated exactly like readonly for editing.
 *   'none'           → no inspector presence: not consumed, not stamped.
 *
 * Covers the four touch-points:
 *   1. isFieldDisplayReadonly + isFieldEditable (pure editability decision).
 *   2. getConsumedFieldsFromSchema filters scope:'none'.
 *   3. getSchemaDefaults (the stamp source) omits scope:'none'.
 *   4. updateOverlayField + applyLiveEdit block scope:'des' writes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import {
  registerComponentSchema,
  getFieldDescriptor,
  getConsumedFieldsFromSchema,
  getSchemaDefaults,
  isFieldDisplayReadonly,
} from '../src/core/engine/rv-component-registry';
import { isFieldEditable } from '../src/core/hmi/rv-field-row';
import { RvExtrasEditorPlugin } from '../src/core/hmi/rv-extras-editor';
import { applyLiveEdit, type ResolverViewer } from '../src/core/hmi/rv-value-resolver';

// ── 1. isFieldDisplayReadonly (pure predicate) ──────────────────────────────

describe('isFieldDisplayReadonly', () => {
  it('is true when readonly:true', () => {
    expect(isFieldDisplayReadonly({ type: 'number', readonly: true })).toBe(true);
  });
  it('is true when scope:"des"', () => {
    expect(isFieldDisplayReadonly({ type: 'number', scope: 'des' })).toBe(true);
  });
  it('is false for scope:"live" / undefined / scope:"none"', () => {
    expect(isFieldDisplayReadonly({ type: 'number', scope: 'live' })).toBe(false);
    expect(isFieldDisplayReadonly({ type: 'number' })).toBe(false);
    expect(isFieldDisplayReadonly({ type: 'number', scope: 'none' })).toBe(false);
    expect(isFieldDisplayReadonly(undefined)).toBe(false);
  });
});

// ── 2. isFieldEditable honours scope ─────────────────────────────────────────

describe('isFieldEditable — scope gate', () => {
  it('is false for a consumed scope:"des" field (not editable)', () => {
    expect(isFieldEditable('consumed', false, { type: 'number', scope: 'des' })).toBe(false);
  });

  it('is true for a consumed scope:"live" field (backward compatible)', () => {
    expect(isFieldEditable('consumed', false, { type: 'number', scope: 'live' })).toBe(true);
  });

  it('is true for a consumed field with no scope (default = live)', () => {
    expect(isFieldEditable('consumed', false, { type: 'number' })).toBe(true);
  });
});

// ── 3. getConsumedFieldsFromSchema filters scope:'none' ──────────────────────

describe('getConsumedFieldsFromSchema — scope:"none" filter', () => {
  it('omits scope:"none" fields (and their aliases), keeps des + live', () => {
    registerComponentSchema('ScopeConsumedType', {
      Live:   { type: 'number' },
      Des:    { type: 'number', scope: 'des' },
      Hidden: { type: 'number', scope: 'none', aliases: ['HiddenAlias'] },
    });
    const fields = getConsumedFieldsFromSchema('ScopeConsumedType');
    expect(fields).toContain('Live');
    expect(fields).toContain('Des');   // 'des' is still consumed (read-only row)
    expect(fields).not.toContain('Hidden');
    expect(fields).not.toContain('HiddenAlias');
  });
});

// ── 4. getSchemaDefaults (stamp source) omits scope:'none' ───────────────────

describe('getSchemaDefaults — scope:"none" not stamped', () => {
  it('omits scope:"none" defaults, keeps des + live defaults', () => {
    registerComponentSchema('ScopeStampType', {
      Live:   { type: 'number', default: 1 },
      Des:    { type: 'number', default: 2, scope: 'des' },
      Hidden: { type: 'number', default: 3, scope: 'none' },
    });
    const defaults = getSchemaDefaults('ScopeStampType');
    expect(defaults).toMatchObject({ Live: 1, Des: 2 });
    expect('Hidden' in defaults).toBe(false);
  });
});

// ── 5. updateOverlayField blocks scope:'des' writes ──────────────────────────

describe('RvExtrasEditorPlugin.updateOverlayField — scope:"des" gate', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  function makeViewer(): { viewer: { registry: NodeRegistry; scene: Object3D }; node: Object3D } {
    const registry = new NodeRegistry();
    const scene = new Object3D();
    const node = new Object3D();
    node.name = 'Widget';
    node.userData.realvirtual = {
      ScopeEditorType: { ConveyorLength: 1000, FreeField: 1 },
    };
    scene.add(node);
    registry.registerNode('Cell/Widget', node);
    return { viewer: { registry, scene }, node };
  }

  it('refuses to write a scope:"des" field and leaves the value untouched', () => {
    registerComponentSchema('ScopeEditorType', {
      ConveyorLength: { type: 'number', scope: 'des' },
      FreeField:      { type: 'number' },
    });
    const plugin = new RvExtrasEditorPlugin();
    const { viewer, node } = makeViewer();
    (plugin as unknown as { _viewer: unknown })._viewer = viewer;

    const ok = plugin.updateOverlayField('Cell/Widget', 'ScopeEditorType', 'ConveyorLength', 9999);

    expect(ok).toBe(false);
    const rv = node.userData.realvirtual as Record<string, Record<string, unknown>>;
    expect(rv.ScopeEditorType.ConveyorLength).toBe(1000); // unchanged
  });

  it('still allows writing a scope:"live" field on the same component', () => {
    registerComponentSchema('ScopeEditorType', {
      ConveyorLength: { type: 'number', scope: 'des' },
      FreeField:      { type: 'number' },
    });
    const plugin = new RvExtrasEditorPlugin();
    const { viewer, node } = makeViewer();
    (plugin as unknown as { _viewer: unknown })._viewer = viewer;

    const ok = plugin.updateOverlayField('Cell/Widget', 'ScopeEditorType', 'FreeField', 5);

    expect(ok).toBe(true);
    const rv = node.userData.realvirtual as Record<string, Record<string, unknown>>;
    expect(rv.ScopeEditorType.FreeField).toBe(5);
  });
});

// ── 6. applyLiveEdit blocks scope:'des' writes ───────────────────────────────

describe('applyLiveEdit — scope:"des" gate', () => {
  class ScopeLiveComponent {
    static schema = {
      ConveyorLength: { type: 'number', scope: 'des' } as const,
      FreeField:      { type: 'number' } as const,
    };
    isOwner = true;
    ConveyorLength = 100;
    FreeField = 1;
    constructor(public node: Object3D) {}
  }

  it('does not push a scope:"des" field into the live component instance', () => {
    registerComponentSchema('ScopeLiveType', ScopeLiveComponent.schema);

    const node = new Object3D();
    const inst = new ScopeLiveComponent(node);
    const registry = new NodeRegistry();
    registry.registerNode('Cell/Live', node);
    registry.register('ScopeLiveType', 'Cell/Live', inst);

    const viewer: ResolverViewer = { registry, signalStore: null };

    applyLiveEdit(viewer, 'Cell/Live', 'ScopeLiveType', 'ConveyorLength', 9999);

    expect(inst.ConveyorLength).toBe(100); // unchanged — scope:'des' blocked the write
  });

  it('blocks a scope:"des" field even when the component type carries an instance suffix', () => {
    registerComponentSchema('ScopeSuffixType', ScopeLiveComponent.schema);

    const node = new Object3D();
    const inst = new ScopeLiveComponent(node);
    const registry = new NodeRegistry();
    registry.registerNode('Cell/Suffixed', node);
    registry.register('ScopeSuffixType_1', 'Cell/Suffixed', inst);

    const viewer: ResolverViewer = { registry, signalStore: null };

    applyLiveEdit(viewer, 'Cell/Suffixed', 'ScopeSuffixType_1', 'ConveyorLength', 9999);

    expect(inst.ConveyorLength).toBe(100); // unchanged — blocked despite the suffix
  });

  it('still pushes a scope:"live" scalar field into the live component', () => {
    registerComponentSchema('ScopeLiveType2', ScopeLiveComponent.schema);

    const node = new Object3D();
    const inst = new ScopeLiveComponent(node);
    const registry = new NodeRegistry();
    registry.registerNode('Cell/Live2', node);
    registry.register('ScopeLiveType2', 'Cell/Live2', inst);

    const viewer: ResolverViewer = { registry, signalStore: null };

    applyLiveEdit(viewer, 'Cell/Live2', 'ScopeLiveType2', 'FreeField', 7);

    expect(inst.FreeField).toBe(7);
  });
});

// ── 7. getFieldDescriptor preserves scope ────────────────────────────────────

describe('getFieldDescriptor — scope round-trips', () => {
  it('returns the scope on the looked-up descriptor (direct + alias)', () => {
    registerComponentSchema('ScopeLookupType', {
      Des:  { type: 'number', scope: 'des', aliases: ['DesAlias'] },
      Live: { type: 'number' },
    });
    expect(getFieldDescriptor('ScopeLookupType', 'Des')?.scope).toBe('des');
    expect(getFieldDescriptor('ScopeLookupType', 'DesAlias')?.scope).toBe('des');
    expect(getFieldDescriptor('ScopeLookupType', 'Live')?.scope).toBeUndefined();
  });
});
