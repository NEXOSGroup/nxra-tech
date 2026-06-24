// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ik-path-step.ts — LogicStep leaf that starts an RVIKPath and blocks until
 * the path finishes. Mirrors how IKPath is triggered from a LogicStep in Unity.
 *
 * The path's own per-frame state machine is driven by RVViewer (before the drive
 * loop); this step only kicks it off and observes `PathIsFinished`.
 */

import { RVLogicStep, StepState } from './rv-logic-step';
import type { RVIKPath } from './rv-ik-path';

export class RVIKPathStep extends RVLogicStep {
  constructor(private readonly ikPath: RVIKPath | null) {
    super();
  }

  get progress(): number {
    if (this.state === StepState.Finished) return 100;
    if (this.state === StepState.Idle || !this.ikPath) return 0;
    return this.ikPath.PathIsActive ? 50 : 0;
  }

  start(): void {
    if (!this.ikPath) {
      console.warn(`[LogicStep] IKPath "${this.name}": null path — skipping`);
      this.state = StepState.Finished;
      return;
    }
    this.ikPath.startPath();
    this.state = StepState.Active;
    // A degenerate (empty) path finishes within startPath() synchronously.
    if (this.ikPath.PathIsFinished) this.finish();
  }

  fixedUpdate(_dt: number): void {
    if (this.state !== StepState.Active || !this.ikPath) return;
    if (this.ikPath.PathIsFinished) this.finish();
  }

  reset(): void {
    super.reset();
    this.ikPath?.reset();
  }
}
