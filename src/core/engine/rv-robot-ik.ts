// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-robot-ik.ts — TypeScript pendant of RobotIK.cs (realvirtual Robotics Pro).
 *
 * Marks a robot node and resolves its ordered axis drives + child IK paths.
 * Registering it makes "RobotIK" show as a component chip in the hierarchy /
 * inspector (like Drive, IKPath, IKTarget). The actual IK replay/motion is
 * driven by RVIKPath; RobotIK is the anchor that the path visualizer and (later)
 * the interactive solver hang off.
 *
 * Property parity: schema keys = GLB extras keys = C# field names (PascalCase).
 * Object refs (Axis[]) are read from raw node extras in init() (resolveComponentRefs
 * mutates instance ref fields — see RVIKPath for the same pattern).
 */

import type { Object3D } from 'three';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent } from './rv-component-registry';
import type { NodeRegistry } from './rv-node-registry';
import type { RVDrive } from './rv-drive';
import type { RVIKPath } from './rv-ik-path';
import { resolveAxisDrivesFromNode } from './rv-ik-path';
import type { OpwParams } from './rv-ik-solver';
import { debug } from './rv-debug';

export class RVRobotIK implements RVComponent {
  static readonly schema: ComponentSchema = {
    WristType: { type: 'enum', enumMap: { Spherical: 'Spherical', NonSpherical: 'NonSpherical' }, default: 'Spherical', readonly: true },
    ElbowInUnityX: { type: 'boolean', default: false, readonly: true },
    DrawGizmos: { type: 'boolean', default: true },
  };

  readonly node: Object3D;
  isOwner = true;

  WristType: 'Spherical' | 'NonSpherical' = 'Spherical';
  ElbowInUnityX = false;
  DrawGizmos = true;

  private _registry: NodeRegistry | null = null;
  private _axisDrives: RVDrive[] = [];

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    this._registry = context.registry;
    this._axisDrives = this.resolveAxisDrives(context.registry);
    debug('loader', `  RobotIK: ${this.node.name} axes=${this._axisDrives.length} wrist=${this.WristType}`);
  }

  /** Ordered axis drives (Axis[0..5]) resolved from the serialized RobotIK.Axis. */
  getAxisDrives(): RVDrive[] {
    return this._axisDrives;
  }

  /** OPW/Pieper solver parameters from the serialized RobotIK extras.
   *  Returns null if the robot has no analytical params (non-OPW / not rigged). */
  getOpwParams(): OpwParams | null {
    const raw = (this.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['RobotIK'];
    if (!raw || !Number.isFinite(+(raw['a1'] as number))) return null;
    const to = (raw['ToolOffset'] as { x?: number; y?: number; z?: number } | undefined) ?? {};
    return {
      a1: +(raw['a1'] as number), a2: +(raw['a2'] as number), b: +(raw['b'] as number),
      c1: +(raw['c1'] as number), c2: +(raw['c2'] as number), c3: +(raw['c3'] as number), c4: +(raw['c4'] as number),
      elbowInUnityX: !!raw['ElbowInUnityX'],
      toolOffset: [to.x ?? 0, to.y ?? 0, to.z ?? 0],
    };
  }

  /** All IK paths defined under this robot (children with an IKPath component). */
  getPaths(): RVIKPath[] {
    if (!this._registry) return [];
    return this._registry.findAllInChildren<RVIKPath>(this.node, 'IKPath').map((r) => r.instance);
  }

  private resolveAxisDrives(registry: NodeRegistry): RVDrive[] {
    return resolveAxisDrivesFromNode(registry, this.node);
  }
}

registerComponent({
  type: 'RobotIK',
  schema: RVRobotIK.schema,
  capabilities: {
    simulationActive: false,
    selectable: true,
    inspectorVisible: true,
    hierarchyVisible: true,
    badgeColor: '#7e57c2',
    filterLabel: 'Robots',
  },
  create: (node: Object3D) => new RVRobotIK(node),
});
