// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Integration test for plan-198 applied to the Conveyor behavior.
 *
 * After binding the real `ConveyorBehavior`, its DES timing fields
 * (ConveyorLength / ConveyorSpeed / CalculatedArcLength) must appear as
 * read-only "consumed" rows tagged "(DES)" — NOT as editable live fields. The
 * real belt speed is owned by the Transport Drive's TargetSpeed (a separate
 * editable section); the conveyor's DES fallback must not contradict it.
 *
 * This verifies display/editability ONLY — the simulation parity tests
 * (conveyor-behavior, conveyor-des-timing) remain unchanged.
 */
import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import {
  createBindContext,
  applyKinematicsSpec,
  type BindContextHost,
  type KinematicsSpec,
} from '../src/core/behavior-runtime';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import {
  getFieldDescriptor,
  isFieldDisplayReadonly,
} from '../src/core/engine/rv-component-registry';
import { getConsumedFields } from '../src/core/engine/rv-extras-validator';
import { isFieldEditable } from '../src/core/hmi/rv-field-row';
import Conveyor from '../src/behaviors/Conveyor';

const DES_FIELDS = ['ConveyorLength', 'ConveyorSpeed', 'CalculatedArcLength'] as const;

/** Bind the real Conveyor behavior on a minimal Transport-X + Sensor root. */
function bindConveyor(): { root: Object3D } {
  const signalValues = new Map<string, boolean | number>();
  const signalSubs = new Map<string, Set<(v: boolean | number) => void>>();
  const signalStore = {
    get(name: string) { return signalValues.get(name); },
    set(name: string, value: boolean | number) {
      signalValues.set(name, value);
      const subs = signalSubs.get(name);
      if (subs) for (const cb of subs) cb(value);
    },
    subscribe(name: string, cb: (v: boolean | number) => void) {
      let s = signalSubs.get(name);
      if (!s) { s = new Set(); signalSubs.set(name, s); }
      s.add(cb);
      return () => { s!.delete(cb); };
    },
  };
  const events = new EventEmitter<Record<string, unknown>>();
  const contextMenu = new ContextMenuStore();

  const root = new Object3D(); root.name = 'Conveyor';
  const beltNode = new Object3D(); beltNode.name = 'Transport-X'; root.add(beltNode);
  const sensorNode = new Object3D(); sensorNode.name = 'Sensor-1'; root.add(sensorNode);

  const drive = { name: 'Transport-X', node: beltNode, jogForward: false, jogBackward: false, startMove() {}, stop() {} };

  const host: BindContextHost = {
    signalStore,
    on: (event, cb) => events.on(event, cb as never),
    contextMenu,
    drives: [drive],
    registry: null,
  };

  const accum: KinematicsSpec = {};
  const { ctx } = createBindContext(root, host, accum);
  Conveyor.bind(ctx);
  applyKinematicsSpec(root, accum);
  return { root };
}

describe('Conveyor inspector — DES fields are read-only "(DES)", not editable', () => {
  it('reports every DES timing field as scope:"des"', () => {
    for (const f of DES_FIELDS) {
      const desc = getFieldDescriptor('ConveyorBehavior', f);
      expect(desc?.scope).toBe('des');
      expect(isFieldDisplayReadonly(desc)).toBe(true);
    }
  });

  it('keeps the DES fields in the consumed list (shown), but not editable', () => {
    const consumed = getConsumedFields('ConveyorBehavior');
    for (const f of DES_FIELDS) {
      expect(consumed).toContain(f); // still visible as a read-only row
      const desc = getFieldDescriptor('ConveyorBehavior', f);
      expect(isFieldEditable('consumed', false, desc)).toBe(false);
    }
  });

  it('stamps the DES defaults onto the ConveyorBehavior marker (diagnostic display)', () => {
    const { root } = bindConveyor();
    const rv = root.userData.realvirtual as Record<string, Record<string, unknown>>;
    // The factory still stamps scope:'des' defaults (only scope:'none' is dropped),
    // so the inspector shows the configured DES values as read-only rows.
    expect(rv.ConveyorBehavior).toMatchObject({
      ConveyorLength: 1000,
      ConveyorSpeed: 200,
      CalculatedArcLength: 0,
      Belt: 'Transport-X',
      Sensor: 'Sensor-1',
    });
  });
});
