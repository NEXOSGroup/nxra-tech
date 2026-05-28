// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Discrete simulation tick stages. Plugins register callbacks per stage via
 * SimLoopFacade.onTick(stage, callback, order?). Within a stage, callbacks
 * are sorted by ascending order (lower = earlier).
 *
 * Phase 0: only the enum exists. Full integration with fixedUpdate() comes
 * in Phase 5; see plan-182.
 */
export enum TickStage {
  /** Before sim logic. Industrial adapters flush incoming PLC signals here. */
  PRE = 0,
  /** Sim logic. Drives, sensors, transport, logic steps. */
  SIM = 1,
  /** After sim logic. Recorders, stats, adapter readback of outgoing signals. */
  POST = 2,
}
