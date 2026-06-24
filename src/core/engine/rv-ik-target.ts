// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ik-target.ts — TypeScript pendant of IKTarget.cs (realvirtual Robotics Pro).
 *
 * A waypoint in a robot IK path. Carries the same authoring properties as the
 * C# IKTarget plus the pre-computed joint angles (`AxisPos`) that the WebViewer
 * replays. Pure config + lifecycle helpers — RVIKPath owns the per-frame tick.
 *
 * Property parity: schema keys = GLB extras keys = C# field names (PascalCase).
 *
 * Replay model: `AxisPos[6]` is the per-axis solution serialized from Unity. The
 * path drives each robot axis drive to AxisPos[i]. Targets that were never solved
 * in Unity (AxisPos all zero / absent) are flagged not-replayable.
 *
 * Interactive re-solving (moving a target → recompute AxisPos) needs the WASM
 * solver (plan-212) and is out of scope for the replay MVP.
 */

import type { Object3D } from 'three';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent } from './rv-component-registry';
import type { ComponentRef } from './rv-node-registry';
import type { SignalStore } from './rv-signal-store';
import type { RVGrip } from './rv-grip';
import { debug } from './rv-debug';

export type IKInterpolation = 'PointToPoint' | 'PointToPointUnsynced' | 'Linear';

export class RVIKTarget implements RVComponent {
  static readonly schema: ComponentSchema = {
    FollowInEditMode:     { type: 'boolean', default: true },
    SpeedToTarget:        { type: 'number',  default: 1 },
    LinearAcceleration:   { type: 'number',  default: 100 },
    InterpolationToTarget: { type: 'enum', enumMap: {
      PointToPoint: 'PointToPoint',
      PointToPointUnsynced: 'PointToPointUnsynced',
      Linear: 'Linear',
    }, default: 'PointToPoint' },
    LinearSpeedToTarget:  { type: 'number',  default: 500 },
    TurnCorrection:       { type: 'boolean', default: false },
    SetSignalDuration:    { type: 'number',  default: 0.5 },
    WaitForSeconds:       { type: 'number',  default: 0 },
    PickAndPlace:         { type: 'boolean', default: false },
    Pick:                 { type: 'boolean', default: false },
    Place:                { type: 'boolean', default: false },
    EnableBlending:       { type: 'boolean', default: false },
    BlendRadius:          { type: 'number',  default: 25 },
    // Signal refs → resolved to address strings by resolveComponentRefs()
    SetSignal:            { type: 'componentRef' },
    WaitForSignal:        { type: 'componentRef' },
    // NOTE: AxisPos (number[6]), gripTarget/fixer (object refs) are NOT schema
    //       fields — they are captured raw in beforeSchema() (see below), because
    //       the schema mapper has no numberArray type and drops object refs.
  };

  readonly node: Object3D;
  isOwner = true;

  // ── Authoring properties (parity with IKTarget.cs) ──
  FollowInEditMode = true;
  SpeedToTarget = 1;
  LinearAcceleration = 100;
  InterpolationToTarget: IKInterpolation = 'PointToPoint';
  LinearSpeedToTarget = 500;
  TurnCorrection = false;
  SetSignalDuration = 0.5;
  WaitForSeconds = 0;
  PickAndPlace = false;
  Pick = false;
  Place = false;
  EnableBlending = false;
  BlendRadius = 25;

  // After resolveComponentRefs these hold resolved signal address strings (or null).
  SetSignal: string | null = null;
  WaitForSignal: string | null = null;

  /** Pre-computed joint angles per axis (deg for rotary, mm for linear). Read
   *  from raw node extras in init() — see the note there. */
  AxisPos: number[] = [];

  // ── Resolved in init() ──
  setSignalAddr: string | null = null;
  waitForSignalAddr: string | null = null;
  gripTarget: RVGrip | null = null;
  private _store: SignalStore | null = null;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    this._store = context.signalStore;
    // SetSignal / WaitForSignal are address strings after resolveComponentRefs.
    this.setSignalAddr = typeof this.SetSignal === 'string' ? this.SetSignal : null;
    this.waitForSignalAddr = typeof this.WaitForSignal === 'string' ? this.WaitForSignal : null;

    // Read AxisPos (number[]) and grip/fixer refs DIRECTLY from node extras.
    // resolveComponentRefs() (run before init) mutates instance ref fields, so we
    // must read these from the untouched raw extras, not from instance fields.
    const raw = (this.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['IKTarget'];
    if (raw) {
      if (Array.isArray(raw['AxisPos'])) this.AxisPos = (raw['AxisPos'] as unknown[]).map((v) => Number(v));
      // gripTarget (RVGrip) takes priority over fixer for pick/place.
      const gt = raw['gripTarget'];
      const fx = raw['fixer'];
      if (isRef(gt) && typeof gt.path === 'string') {
        this.gripTarget = context.registry.getByPath<RVGrip>('Grip', gt.path);
      }
      if (!this.gripTarget && isRef(fx) && typeof fx.path === 'string') {
        // RVFixer has no WebViewer pendant yet — fall back to a Grip at the same path.
        this.gripTarget = context.registry.getByPath<RVGrip>('Grip', fx.path);
      }
    }
  }

  /** True when this target has usable replay angles (was solved in Unity). */
  hasReplayAngles(axisCount: number): boolean {
    if (this.AxisPos.length < axisCount) return false;
    for (let i = 0; i < axisCount; i++) {
      if (this.AxisPos[i] !== 0) return true; // any non-zero ⇒ solved
    }
    return false;
  }

  /** Called when the robot reaches this target: raise SetSignal + pick/place. */
  onAtTarget(): void {
    if (this.setSignalAddr && this._store) {
      this._store.setByPath(this.setSignalAddr, true);
    }
    if (this.PickAndPlace && this.gripTarget) {
      if (this.Pick) this.gripTarget.pick();
      if (this.Place) this.gripTarget.place();
    }
    debug('logic', `IKTarget "${this.node.name}": atTarget (pick=${this.Pick} place=${this.Place})`);
  }
}

function isRef(v: unknown): v is ComponentRef {
  return !!v && typeof v === 'object'
    && (v as Record<string, unknown>).type === 'ComponentReference'
    && typeof (v as Record<string, unknown>).path === 'string';
}

registerComponent({
  type: 'IKTarget',
  schema: RVIKTarget.schema,
  capabilities: { simulationActive: false, selectable: true, badgeColor: '#ce93d8', filterLabel: 'IK Targets' },
  create: (node: Object3D) => new RVIKTarget(node),
});
