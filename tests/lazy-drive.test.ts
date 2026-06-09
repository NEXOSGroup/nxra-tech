// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import {
  createBindContext,
  type BindContextHost,
  type KinematicsSpec,
  type RVBindContext,
} from '../src/core/behavior-runtime';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import { attachBelt, attachDrive } from '../src/behaviors/_shared/lazy-drive';

interface FakeBeltDrive {
  name: string; node: Object3D;
  jogForward: boolean; jogBackward: boolean;
  startMove(d?: number): void; stop(): void;
}
interface FakePosDrive {
  name: string; node: Object3D;
  TargetSpeed: number; jogForward: boolean; jogBackward: boolean;
  isAtTarget: boolean; targetPosition: number; stopped: boolean;
  startMove(d?: number): void; stop(): void;
}

/** Build a bind context over a mutable `drives` array so tests can register a drive late. */
function makeRv(drives: BindContextHost['drives']): { rv: RVBindContext; root: Object3D; beltNode: Object3D } {
  const events = new EventEmitter<Record<string, unknown>>();
  const signalStore = {
    get: () => undefined,
    set: () => {},
    subscribe: () => () => {},
  };
  const root = new Object3D(); root.name = 'Conveyor';
  const beltNode = new Object3D(); beltNode.name = 'Transport-X'; root.add(beltNode);
  const host: BindContextHost = {
    signalStore,
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives,
    registry: null,
  };
  const accum: KinematicsSpec = {};
  const { ctx } = createBindContext(root, host, accum);
  return { rv: ctx, root, beltNode };
}

describe('attachBelt — resolve-on-demand belt handle', () => {
  it('no-ops before the drive is registered', () => {
    const drives: BindContextHost['drives'] = [];
    const { rv, beltNode } = makeRv(drives);
    const belt = attachBelt(rv, beltNode);
    expect(() => belt.run(true)).not.toThrow();   // silent no-op while unresolved
    expect(belt.node).toBe(beltNode);
  });

  it('no-ops when the node is null', () => {
    const { rv } = makeRv([]);
    const belt = attachBelt(rv, null);
    expect(() => belt.run(true)).not.toThrow();
    expect(belt.node).toBeNull();
  });

  it('resolves and drives once the drive appears in the live array', () => {
    const drives: BindContextHost['drives'] = [];
    const { rv, beltNode } = makeRv(drives);
    const belt = attachBelt(rv, beltNode);

    // Drive shows up late (load-order race / HMR replay).
    const drive: FakeBeltDrive = {
      name: 'Transport-X', node: beltNode,
      jogForward: false, jogBackward: false,
      startMove() {}, stop() {},
    };
    drives.push(drive);

    belt.run(true);
    expect(drive.jogForward).toBe(true);
    expect(drive.jogBackward).toBe(false);

    belt.run(false);
    expect(drive.jogForward).toBe(false);
  });
});

describe('attachDrive — positioned-drive handle', () => {
  function makePosDrive(node: Object3D): FakePosDrive {
    return {
      name: 'Drive-Rot-Y', node,
      TargetSpeed: 90, jogForward: false, jogBackward: false,
      isAtTarget: true, targetPosition: 0, stopped: false,
      startMove(d?: number) { if (d !== undefined) this.targetPosition = d; this.isAtTarget = false; },
      stop() { this.stopped = true; },
    };
  }

  it('moveTo / isAtTarget / run pass through once resolved', () => {
    const node = new Object3D(); node.name = 'Drive-Rot-Y';
    const drive = makePosDrive(node);
    const { rv } = makeRv([drive as unknown as BindContextHost['drives'][number]]);
    const handle = attachDrive(rv, node);

    // moveTo → startMove (the runtime defines moveTo from startMove when absent).
    handle.moveTo(90);
    expect(drive.targetPosition).toBe(90);
    expect(handle.isAtTarget()).toBe(false);

    drive.isAtTarget = true;
    expect(handle.isAtTarget()).toBe(true);

    handle.run(true);
    expect(drive.jogForward).toBe(true);

    handle.stop();
    expect(drive.stopped).toBe(true);
  });

  it('no-ops and isAtTarget() is false before the drive is registered', () => {
    const node = new Object3D(); node.name = 'Drive-Rot-Y';
    const drives: BindContextHost['drives'] = [];
    const { rv } = makeRv(drives);
    const handle = attachDrive(rv, node);

    expect(handle.isAtTarget()).toBe(false);
    expect(() => { handle.moveTo(45); handle.run(true); handle.stop(); }).not.toThrow();

    // Drive appears late, then resolves.
    const drive = makePosDrive(node);
    drives.push(drive as unknown as BindContextHost['drives'][number]);
    handle.moveTo(45);
    expect(drive.targetPosition).toBe(45);
  });
});
