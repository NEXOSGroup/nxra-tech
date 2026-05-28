// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tree-walking test helpers for the hierarchy-utils tests.
 */

import type { TreeNode } from '../../src/core/hmi/hierarchy-utils';

/** Collect every `types` entry from a TreeNode forest (DFS, parents first). */
export function collectAllTypes(nodes: TreeNode[]): string[] {
  const all: string[] = [];
  function walk(n: TreeNode): void {
    for (const t of n.types) all.push(t);
    for (const c of n.children) walk(c);
  }
  for (const n of nodes) walk(n);
  return all;
}

/** Flat list of every path in the forest (DFS, parents first). Skips null paths. */
export function collectAllPaths(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  function walk(n: TreeNode): void {
    if (n.path) out.push(n.path);
    for (const c of n.children) walk(c);
  }
  for (const n of nodes) walk(n);
  return out;
}

/** Find first node matching predicate in DFS order. */
export function findNode(
  nodes: TreeNode[],
  predicate: (n: TreeNode) => boolean,
): TreeNode | null {
  for (const n of nodes) {
    if (predicate(n)) return n;
    if (n.children.length > 0) {
      const r = findNode(n.children, predicate);
      if (r) return r;
    }
  }
  return null;
}
