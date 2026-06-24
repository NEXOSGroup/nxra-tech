// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Mode UI-gating tests (plan-198).
 *
 * Validates:
 *   - the `shownOnlyInAny` OR-gate in evaluateVisibilityRule (and that the
 *     existing `shownOnlyIn` ALL-gate is unchanged);
 *   - UIPluginRegistry.register compiling `plugin.modes` into a
 *     `shownOnlyInAny` rule + visibilityId on each slot entry, merging (not
 *     clobbering) any pre-existing rule, and leaving shared plugins untouched.
 */
import { describe, it, expect } from 'vitest';
import { evaluateVisibilityRule } from '../src/core/hmi/ui-context-store';
import { UIPluginRegistry } from '../src/core/rv-ui-registry';
import type { UISlotEntry } from '../src/core/rv-ui-plugin';

const ctx = (...c: string[]) => new Set(c);
const Dummy = (() => null) as unknown as UISlotEntry['component'];

describe('evaluateVisibilityRule — shownOnlyInAny (OR)', () => {
  it('visible when ANY listed context is active', () => {
    const rule = { shownOnlyInAny: ['mode:hmi', 'mode:des'] };
    expect(evaluateVisibilityRule(rule, ctx('mode:hmi'))).toBe(true);
    expect(evaluateVisibilityRule(rule, ctx('mode:des'))).toBe(true);
    expect(evaluateVisibilityRule(rule, ctx('mode:planner'))).toBe(false);
    expect(evaluateVisibilityRule(rule, ctx())).toBe(false);
  });

  it('shownOnlyIn keeps ALL semantics (unchanged)', () => {
    const rule = { shownOnlyIn: ['a', 'b'] };
    expect(evaluateVisibilityRule(rule, ctx('a', 'b'))).toBe(true);
    expect(evaluateVisibilityRule(rule, ctx('a'))).toBe(false);
  });

  it('shownOnlyInAny AND-combines with hiddenIn', () => {
    const rule = { shownOnlyInAny: ['mode:hmi'], hiddenIn: ['fpv'] };
    expect(evaluateVisibilityRule(rule, ctx('mode:hmi'))).toBe(true);
    expect(evaluateVisibilityRule(rule, ctx('mode:hmi', 'fpv'))).toBe(false);
    expect(evaluateVisibilityRule(rule, ctx('fpv'))).toBe(false);
  });

  it('shownOnlyInAny AND-combines with shownOnlyIn', () => {
    const rule = { shownOnlyInAny: ['mode:hmi', 'mode:des'], shownOnlyIn: ['kiosk'] };
    expect(evaluateVisibilityRule(rule, ctx('mode:hmi', 'kiosk'))).toBe(true);
    expect(evaluateVisibilityRule(rule, ctx('mode:hmi'))).toBe(false);     // kiosk missing
    expect(evaluateVisibilityRule(rule, ctx('kiosk'))).toBe(false);        // no mode
  });

  it('empty rule is always visible', () => {
    expect(evaluateVisibilityRule({}, ctx())).toBe(true);
  });
});

describe('UIPluginRegistry — modes → visibility compile', () => {
  it('injects shownOnlyInAny + visibilityId for a single-mode plugin', () => {
    const reg = new UIPluginRegistry();
    reg.register({
      id: 'layout-planner',
      modes: ['planner'],
      slots: [{ slot: 'button-group', component: Dummy }],
    });
    const [entry] = reg.getSlotComponents('button-group');
    expect(entry.visibilityRule?.shownOnlyInAny).toEqual(['mode:planner']);
    expect(entry.visibilityId).toBeTruthy(); // required so HMIShell applies the rule
    expect(entry.pluginId).toBe('layout-planner');
  });

  it('maps multi-mode plugin to multiple mode contexts (OR)', () => {
    const reg = new UIPluginRegistry();
    reg.register({
      id: 'shared-ish',
      modes: ['hmi', 'des'],
      slots: [{ slot: 'views', component: Dummy }],
    });
    const [entry] = reg.getSlotComponents('views');
    expect(entry.visibilityRule?.shownOnlyInAny).toEqual(['mode:hmi', 'mode:des']);
  });

  it('merges (does not clobber) an existing visibilityRule', () => {
    const reg = new UIPluginRegistry();
    reg.register({
      id: 'planner-btn',
      modes: ['planner'],
      slots: [{
        slot: 'button-group',
        component: Dummy,
        visibilityId: 'planner-grid',
        visibilityRule: { shownOnlyIn: ['planner'] }, // legacy context preserved
      }],
    });
    const [entry] = reg.getSlotComponents('button-group');
    expect(entry.visibilityRule?.shownOnlyIn).toEqual(['planner']);          // kept
    expect(entry.visibilityRule?.shownOnlyInAny).toEqual(['mode:planner']);  // added
    expect(entry.visibilityId).toBe('planner-grid');                         // kept
  });

  it('leaves shared plugins (no modes) untouched', () => {
    const reg = new UIPluginRegistry();
    reg.register({
      id: 'shared',
      slots: [{ slot: 'messages', component: Dummy }],
    });
    const [entry] = reg.getSlotComponents('messages');
    expect(entry.visibilityRule).toBeUndefined();
    expect(entry.visibilityId).toBeUndefined();
  });
});
