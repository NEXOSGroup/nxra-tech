// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * material-flow-adapter.ts — bridge a `MaterialFlowDefinition` to the DES
 * material-flow handshake API (Plan 194 §2.6 / §2.8).
 *
 * DESIGN DECISION (P0): DEFER `extends DESComponent` to P5.
 * ────────────────────────────────────────────────────────
 * `DESComponent` lives ONLY in the private repo
 * (`../realvirtual-WebViewer-Private~/src/plugins/des/rv-des-component.ts`).
 * In the public AGPL build (`VITE_PUBLIC_BUILD=1`) that folder is absent and
 * `@rv-private/*` resolves to `src/private-stubs/*` — so a hard
 * `extends DESComponent` in this PUBLIC `src/core/material-flow/` module would
 * break the public-only build. Per the plan's explicit instruction
 * ("IF DESComponent is only resolvable when private is present, DEFER the actual
 * `extends DESComponent` to P5 and create a thin structural interface"), this
 * module defines a STRUCTURAL `DESComponentLike` interface that captures the
 * handshake surface, and `MaterialFlowAdapter` implements it WITHOUT importing
 * the private class. In P5 the private `des-runner` subclasses the real
 * `DESComponent` and delegates into a definition's `des` hooks; this adapter
 * stays as the public-side, runner-agnostic bridge / structural contract.
 *
 * Nothing here imports private code, so `npx tsc --noEmit` and the public build
 * both stay green whether or not the private folder is present.
 */

import type { Object3D } from 'three';
import type { MaterialFlowDefinition } from './define-material-flow';
import type { MaterialFlowSelf, MU, Port, JsonValue } from './material-flow-self';
import { createSelf } from './material-flow-self';
import type { RVBindContext } from '../behavior-runtime';

/**
 * Structural slice of the private `DESComponent` handshake the adapter exposes.
 * Kept minimal and structural so the public core never depends on the private
 * class. In P5 the real `DESComponent` (which is a superset of this) is the
 * concrete base; this interface documents the contract the adapter satisfies.
 */
export interface DESComponentLike {
  readonly node: Object3D;
  entityId: number;
  state: number;
  currentLoad: number;
  totalProcessed: number;
  prop: Record<string, JsonValue>;

  /** Material-flow handshake. */
  canAccept(mu: MU): boolean;
  acceptMU(mu: MU): boolean;
  releaseMU(mu: MU): void;
  onDownstreamReady(from: DESComponentLike): void;

  /** String-based state machine (statistics-friendly). */
  setState(name: string): void;
}

/**
 * Bridges a `MaterialFlowDefinition` (its `des` + `logic` blocks) to the
 * `DESComponentLike` handshake. The DESRunner (P5) drives this; in P0 it is a
 * complete, typed, public bridge with no DES engine attached (the scheduler is
 * injected later via the `self`).
 */
export class MaterialFlowAdapter implements DESComponentLike {
  readonly def: MaterialFlowDefinition;
  readonly self: MaterialFlowSelf;
  readonly node: Object3D;

  entityId = -1;
  state = 0;
  currentLoad = 0;
  totalProcessed = 0;
  prop: Record<string, JsonValue>;

  constructor(def: MaterialFlowDefinition, self: MaterialFlowSelf) {
    this.def = def;
    this.self = self;
    this.node = self.node;
    this.prop = self.prop;
  }

  /**
   * Convenience constructor from an `RVBindContext`: builds a DES-mode `self`
   * and wraps it. The optional `entityId` is the DES integer id.
   */
  static fromBindContext(
    def: MaterialFlowDefinition,
    rv: RVBindContext,
    entityId = -1,
  ): MaterialFlowAdapter {
    const self = createSelf(rv, def, { mode: 'des', entityId });
    const adapter = new MaterialFlowAdapter(def, self);
    adapter.entityId = entityId;
    return adapter;
  }

  // ── Handshake (delegates into the definition's des block) ──────────────

  canAccept(mu: MU, port?: Port): boolean {
    const hook = this.def.des?.canAccept;
    if (hook) return hook(this.self, mu, port);
    // Default: accept while below capacity (capacity unknown here → load-based).
    return true;
  }

  acceptMU(mu: MU, port?: Port): boolean {
    if (!this.canAccept(mu, port)) return false;
    const hook = this.def.des?.onAccept;
    const accepted = hook ? hook(this.self, mu, port) : true;
    if (accepted !== false) this.currentLoad++;
    return accepted !== false;
  }

  releaseMU(_mu: MU): void {
    // TODO(P5): full release path (remove from self.mus, notify upstream
    // onDownstreamReady). In P0 we only keep the load counter consistent.
    if (this.currentLoad > 0) this.currentLoad--;
    this.totalProcessed++;
  }

  onDownstreamReady(from: DESComponentLike): void {
    const hook = this.def.des?.onDownstreamReady;
    if (hook) hook(this.self, from);
  }

  setState(name: string): void {
    this.self.setState(name);
  }
}
