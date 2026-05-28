// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SimLoopFacadeImpl — pause-control + tick subscription.
 *
 * Phase 4a: onTick stores callbacks in an in-memory registry, but the
 * integration with fixedUpdate() comes in Phase 5. Plugins can register now;
 * callbacks will actually fire once Phase 5 ships.
 */

import type { SimLoopFacade } from '../rv-plugin-context';
import { TickStage } from '../rv-tick-stages';
import type { RVDrive } from '../engine/rv-drive';
import type { RVViewer } from '../rv-viewer';

interface TickEntry {
  callback: (dt: number) => void;
  order: number;
  insertIdx: number;  // for stable secondary sort
}

export class SimLoopFacadeImpl implements SimLoopFacade {
  // Public so RVViewer (Phase 5) can read & iterate during fixedUpdate.
  readonly _ticks: Map<TickStage, TickEntry[]> = new Map([
    [TickStage.PRE, []],
    [TickStage.SIM, []],
    [TickStage.POST, []],
  ]);
  private _insertCounter = 0;

  constructor(private readonly _viewer: RVViewer) {}

  setPaused(reason: string, paused: boolean): void {
    this._viewer.setSimulationPaused(reason, paused);
  }

  clearPauseReasons(reason?: string): void {
    this._viewer.clearPauseReasons(reason);
  }

  isPaused(): boolean {
    return this._viewer.isSimulationPaused;
  }

  onTick(stage: TickStage, callback: (dt: number) => void, order = 100): () => void {
    const entry: TickEntry = { callback, order, insertIdx: this._insertCounter++ };
    const list = this._ticks.get(stage)!;
    list.push(entry);
    // Stable sort: primary by order, secondary by insert index.
    list.sort((a, b) => a.order - b.order || a.insertIdx - b.insertIdx);
    return () => {
      const idx = list.indexOf(entry);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  eachDrive(fn: (drive: RVDrive, index: number) => void): void {
    const drives = this._viewer.drives;
    if (!drives) return;
    for (let i = 0; i < drives.length; i++) fn(drives[i], i);
  }

  get driveCount(): number {
    return this._viewer.drives?.length ?? 0;
  }
}
