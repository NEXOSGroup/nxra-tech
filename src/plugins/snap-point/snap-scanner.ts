// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * scanAndRegisterSnaps — traverses an Object3D subtree, parses node names
 * against the Snap-<DIR>-<TYPEID> convention, and registers every match
 * with the SnapPointRegistry.
 */

import type { Object3D } from 'three';
import type { SnapPoint, SnapPointRegistry } from '../../core/engine/rv-snap-point-registry';
import { parseSnapName } from './snap-name-parser';

/**
 * Walk the subtree, register every node whose name matches Snap-<DIR>-<TYPEID>.
 *
 * @param root      Subtree to scan (typically a GLB root or a placed asset)
 * @param registry  Registry to register into
 * @param ownerRoot Asset root recorded on each snap point. Defaults to `root`.
 * @returns The newly registered SnapPoints.
 */
export function scanAndRegisterSnaps(
  root: Object3D,
  registry: SnapPointRegistry,
  ownerRoot?: Object3D,
): SnapPoint[] {
  const owner = ownerRoot ?? root;
  const added: SnapPoint[] = [];
  root.traverse((node: Object3D) => {
    const parsed = parseSnapName(node.name);
    if (!parsed) return;
    const sp: SnapPoint = {
      id: node.uuid,
      object3D: node,
      dir: parsed.dir,
      typeId: parsed.typeId,
      flow: parsed.flow,
      ownerRoot: owner,
      scenePath: computeScenePath(node),
      occupied: false,
    };
    registry.register(sp);
    added.push(sp);
  });
  return added;
}

/** Compute a Unity-style hierarchy path 'Root/Child/Snap-ZN-foo'. */
function computeScenePath(node: Object3D): string {
  const parts: string[] = [node.name];
  let p: Object3D | null = node.parent;
  while (p && p.parent) {
    parts.unshift(p.name);
    p = p.parent;
  }
  return parts.join('/');
}
