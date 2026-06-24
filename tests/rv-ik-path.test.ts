// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVIKPath / RVIKTarget — replay engine unit tests (plan-215 Phase 1).
 *
 * Verifies the path state machine, signal contract (SignalStart/IsStarted/Ended,
 * per-target SetSignal/WaitForSignal/WaitForSeconds), LoopPath / StartNextPath,
 * AxisPos replay onto axis drives, and the RVIKPathStep LogicStep wrapper.
 */
import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry, type ComponentRef } from '../src/core/engine/rv-node-registry';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import { RVIKTarget } from '../src/core/engine/rv-ik-target';
import { RVIKPath } from '../src/core/engine/rv-ik-path';
import { RVIKPathStep } from '../src/core/engine/rv-ik-path-step';
import { StepState } from '../src/core/engine/rv-logic-step';

const driveRef = (path: string): ComponentRef => ({ type: 'ComponentReference', path, componentType: 'realvirtual.Drive' });
const targetRef = (path: string): ComponentRef => ({ type: 'ComponentReference', path, componentType: 'realvirtual.IKTarget' });
const pathRef = (path: string): ComponentRef => ({ type: 'ComponentReference', path, componentType: 'realvirtual.IKPath' });

function makeDrive(path: string): RVDrive {
  const node = new Object3D();
  node.name = path.split('/').pop()!;
  const drive = new RVDrive(node);
  drive.Direction = DriveDirection.LinearX;
  drive.StartPosition = 0;
  drive.TargetSpeed = 100;
  drive.UseAcceleration = false;
  drive.UseLimits = false;
  drive.initDrive();
  return drive;
}

interface SceneOpts {
  axisCount?: number;
  targets?: Array<{ axisPos: number[]; setSignal?: string; waitForSignal?: string; waitSeconds?: number; setDuration?: number }>;
  loop?: boolean;
  startPath?: boolean;
  signalStart?: string;
  withStartSignals?: boolean; // register IsStarted/Ended
  startNextPath?: string;     // path id of a chained RVIKPath
}

interface Scene {
  ikPath: RVIKPath;
  drives: RVDrive[];
  store: SignalStore;
  registry: NodeRegistry;
  context: ComponentContext;
  tick: (dt: number) => void;
  runUntil: (pred: () => boolean, maxFrames?: number, dt?: number) => number;
}

function buildScene(opts: SceneOpts = {}): Scene {
  const axisCount = opts.axisCount ?? 1;
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const transportManager = new RVTransportManager();

  // Signals
  store.register('sigStart', 'sigStart', false, 'PLCOutputBool');
  store.register('sigIsStarted', 'sigIsStarted', false, 'PLCInputBool');
  store.register('sigEnded', 'sigEnded', false, 'PLCInputBool');
  store.register('sigSet', 'sigSet', false, 'PLCInputBool');
  store.register('sigWait', 'sigWait', false, 'PLCOutputBool');

  // Axis drives
  const drives: RVDrive[] = [];
  const axisRefs: ComponentRef[] = [];
  for (let i = 0; i < axisCount; i++) {
    const p = `Robot/a${i}`;
    const d = makeDrive(p);
    registry.register('Drive', p, d);
    drives.push(d);
    axisRefs.push(driveRef(p));
  }

  // Robot node carrying serialized RobotIK.Axis + IKPath child node
  const robotNode = new Object3D();
  robotNode.name = 'Robot';
  robotNode.userData.realvirtual = { RobotIK: { Axis: axisRefs } };
  const ikPathNode = new Object3D();
  ikPathNode.name = 'Path';
  robotNode.add(ikPathNode);

  // Targets
  const targetSpecs = opts.targets ?? [{ axisPos: [90] }];
  const targetRefs: ComponentRef[] = [];
  targetSpecs.forEach((spec, idx) => {
    const tp = `Robot/Path/T${idx}`;
    const tnode = new Object3D();
    tnode.name = `T${idx}`;
    const t = new RVIKTarget(tnode);
    t.AxisPos = spec.axisPos;
    t.SpeedToTarget = 1;
    t.SetSignal = spec.setSignal ?? null;
    t.WaitForSignal = spec.waitForSignal ?? null;
    t.WaitForSeconds = spec.waitSeconds ?? 0;
    if (spec.setDuration !== undefined) t.SetSignalDuration = spec.setDuration;
    t.init({ registry, signalStore: store } as unknown as ComponentContext);
    registry.register('IKTarget', tp, t);
    targetRefs.push(targetRef(tp));
  });

  // IKPath — raw refs live on node extras (init reads them from there).
  ikPathNode.userData.realvirtual = {
    IKPath: {
      Path: targetRefs,
      ...(opts.startNextPath ? { StartNextPath: pathRef(opts.startNextPath) } : {}),
    },
  };
  const ikPath = new RVIKPath(ikPathNode);
  ikPath.LoopPath = opts.loop ?? false;
  ikPath.StartPath = opts.startPath ?? false;
  // Simulate post-resolveComponentRefs: signal refs become address strings.
  ikPath.SignalStart = opts.signalStart ?? null;
  if (opts.withStartSignals) {
    ikPath.SignalIsStarted = 'sigIsStarted';
    ikPath.SignalEnded = 'sigEnded';
  }

  const context: ComponentContext = {
    registry, signalStore: store, scene: new Object3D() as never, transportManager,
    root: robotNode,
  } as ComponentContext;
  ikPath.init(context);
  registry.register('IKPath', 'Robot/Path', ikPath);

  const tick = (dt: number) => {
    ikPath.fixedUpdate(dt);
    for (const d of drives) d.update(dt);
  };
  const runUntil = (pred: () => boolean, maxFrames = 2000, dt = 0.05): number => {
    let n = 0;
    while (n < maxFrames && !pred()) { tick(dt); n++; }
    return n;
  };

  return { ikPath, drives, store, registry, context, tick, runUntil };
}

describe('RVIKPath — startPath signal contract', () => {
  it('startPath sets SignalIsStarted=true and SignalEnded=false immediately', () => {
    const s = buildScene({ withStartSignals: true });
    s.store.set('sigEnded', true); // pre-set to verify it gets cleared
    s.ikPath.startPath();
    expect(s.store.getBool('sigIsStarted')).toBe(true);
    expect(s.store.getBool('sigEnded')).toBe(false);
    expect(s.ikPath.PathIsActive).toBe(true);
  });

  it('path end sets SignalEnded=true and SignalIsStarted=false', () => {
    const s = buildScene({ withStartSignals: true, targets: [{ axisPos: [90] }] });
    s.ikPath.startPath();
    s.runUntil(() => s.ikPath.PathIsFinished);
    expect(s.ikPath.PathIsFinished).toBe(true);
    expect(s.store.getBool('sigEnded')).toBe(true);
    expect(s.store.getBool('sigIsStarted')).toBe(false);
  });
});

describe('RVIKPath — AxisPos replay', () => {
  it('drives all axes to the target AxisPos and finishes', () => {
    const s = buildScene({ axisCount: 3, targets: [{ axisPos: [90, -45, 30] }] });
    s.ikPath.startPath();
    s.runUntil(() => s.ikPath.PathIsFinished);
    expect(s.drives[0].currentPosition).toBeCloseTo(90, 1);
    expect(s.drives[1].currentPosition).toBeCloseTo(-45, 1);
    expect(s.drives[2].currentPosition).toBeCloseTo(30, 1);
  });

  it('runs through multiple targets in order', () => {
    const s = buildScene({ targets: [{ axisPos: [50] }, { axisPos: [120] }] });
    s.ikPath.startPath();
    s.runUntil(() => s.ikPath.PathIsFinished);
    expect(s.drives[0].currentPosition).toBeCloseTo(120, 1);
  });

  it('synced PTP: all axes reach their targets together (longest axis paces)', () => {
    const s = buildScene({ axisCount: 2, targets: [{ axisPos: [100, 10] }] });
    s.ikPath.startPath();
    // After the first axis (delta 100) is ~half done, the short axis (delta 10)
    // must not yet be finished — proves synced timing, not independent speeds.
    let frames = 0;
    while (frames < 4) { s.tick(0.05); frames++; }
    const longProgress = s.drives[0].currentPosition / 100;
    const shortProgress = s.drives[1].currentPosition / 10;
    expect(Math.abs(longProgress - shortProgress)).toBeLessThan(0.2);
  });
});

describe('RVIKPath — LoopPath and StartNextPath', () => {
  it('LoopPath restarts after finishing', () => {
    const s = buildScene({ loop: true, targets: [{ axisPos: [90] }] });
    s.ikPath.startPath();
    // Run a while; with loop it should never settle into Finished+inactive.
    s.runUntil(() => s.ikPath.NumTarget >= 1); // first target reached at least once
    let sawRestart = false;
    for (let i = 0; i < 400; i++) {
      s.tick(0.05);
      if (s.ikPath.PathIsActive && s.ikPath.NumTarget === 0) { sawRestart = true; break; }
    }
    expect(sawRestart).toBe(true);
  });

  it('StartNextPath takes precedence over LoopPath', () => {
    const next = buildScene({ targets: [{ axisPos: [10] }] });
    // Build the main path that chains to `next`.
    const s = buildScene({ loop: true, targets: [{ axisPos: [90] }], startNextPath: 'Robot/Path' });
    // Wire the chained path into the main path's registry resolution by injecting it.
    (s.ikPath as unknown as { _startNextPath: RVIKPath })._startNextPath = next.ikPath;
    s.ikPath.startPath();
    s.runUntil(() => next.ikPath.PathIsActive, 2000);
    expect(next.ikPath.PathIsActive).toBe(true);
  });
});

describe('RVIKPath — per-target signals', () => {
  it('WaitForSignal blocks advancing until the signal is true', () => {
    const s = buildScene({ targets: [
      { axisPos: [30], waitForSignal: 'sigWait' },
      { axisPos: [60] },
    ] });
    s.ikPath.startPath();
    // Reach target 0 and start waiting.
    s.runUntil(() => s.ikPath.WaitForSignal, 2000);
    expect(s.ikPath.WaitForSignal).toBe(true);
    // It must NOT progress to target 1 while the signal is false.
    for (let i = 0; i < 50; i++) s.tick(0.05);
    expect(s.drives[0].currentPosition).toBeCloseTo(30, 1);
    expect(s.ikPath.PathIsFinished).toBe(false);
    // Release the signal → path completes.
    s.store.set('sigWait', true);
    s.runUntil(() => s.ikPath.PathIsFinished);
    expect(s.drives[0].currentPosition).toBeCloseTo(60, 1);
  });

  it('SetSignal is raised on arrival and reset after SetSignalDuration', () => {
    const s = buildScene({ targets: [
      { axisPos: [40], setSignal: 'sigSet', setDuration: 0.5, waitSeconds: 2 },
      { axisPos: [80] },
    ] });
    s.ikPath.startPath();
    s.runUntil(() => s.store.getBool('sigSet'), 2000);
    expect(s.store.getBool('sigSet')).toBe(true);
    // After SetSignalDuration elapses (within the 2s dwell) it resets to false.
    s.runUntil(() => !s.store.getBool('sigSet'), 200);
    expect(s.store.getBool('sigSet')).toBe(false);
  });

  it('WaitForSeconds delays advancing to the next target', () => {
    const s = buildScene({ targets: [
      { axisPos: [20], waitSeconds: 1 },
      { axisPos: [50] },
    ] });
    s.ikPath.startPath();
    // Reach + register arrival at target 0 (NumTarget advances to 1 in atTarget()).
    s.runUntil(() => s.ikPath.NumTarget >= 1, 2000);
    expect(s.drives[0].currentPosition).toBeCloseTo(20, 1);
    // During the 1s dwell the drive must NOT start moving toward target 1 (50).
    for (let i = 0; i < 10; i++) s.tick(0.05); // 0.5s < 1s dwell
    expect(s.drives[0].currentPosition).toBeCloseTo(20, 1);
    expect(s.ikPath.PathIsFinished).toBe(false);
    // After the dwell elapses the path completes at target 1.
    s.runUntil(() => s.ikPath.PathIsFinished);
    expect(s.drives[0].currentPosition).toBeCloseTo(50, 1);
  });
});

describe('RVIKPath — start triggers', () => {
  it('StartPath=true auto-starts on first tick', () => {
    const s = buildScene({ startPath: true, withStartSignals: true });
    expect(s.ikPath.PathIsActive).toBe(false);
    s.tick(0.05);
    expect(s.ikPath.PathIsActive).toBe(true);
    expect(s.store.getBool('sigIsStarted')).toBe(true);
  });

  it('SignalStart rising edge triggers startPath', () => {
    const s = buildScene({ signalStart: 'sigStart' });
    s.tick(0.05);
    expect(s.ikPath.PathIsActive).toBe(false);
    s.store.set('sigStart', true); // subscription updates internal value
    s.tick(0.05);
    expect(s.ikPath.PathIsActive).toBe(true);
  });
});

describe('RVIKPath — degenerate', () => {
  it('empty path finishes immediately on start', () => {
    const s = buildScene({ targets: [] });
    s.ikPath.startPath();
    expect(s.ikPath.PathIsFinished).toBe(true);
    expect(s.ikPath.PathIsActive).toBe(false);
  });
});

describe('RVIKPathStep — LogicStep wrapper', () => {
  it('starts the path and finishes when the path finishes', () => {
    const s = buildScene({ targets: [{ axisPos: [70] }] });
    const step = new RVIKPathStep(s.ikPath);
    step.start();
    expect(step.state).toBe(StepState.Active);
    expect(s.ikPath.PathIsActive).toBe(true);
    // Drive the path; the step observes PathIsFinished.
    for (let i = 0; i < 2000 && step.state !== StepState.Finished; i++) {
      s.tick(0.05);
      step.fixedUpdate(0.05);
    }
    expect(step.state).toBe(StepState.Finished);
    expect(s.drives[0].currentPosition).toBeCloseTo(70, 1);
  });

  it('null path finishes immediately (no crash)', () => {
    const step = new RVIKPathStep(null);
    step.start();
    expect(step.state).toBe(StepState.Finished);
  });

  it('reset() returns the path to idle', () => {
    const s = buildScene({ targets: [{ axisPos: [70] }] });
    const step = new RVIKPathStep(s.ikPath);
    step.start();
    step.reset();
    expect(step.state).toBe(StepState.Idle);
    expect(s.ikPath.PathIsActive).toBe(false);
    expect(s.ikPath.NumTarget).toBe(0);
  });
});
