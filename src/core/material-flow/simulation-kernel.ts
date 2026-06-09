// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * simulation-kernel.ts — the single transport-owning orchestrator (Plan 194 §2.1).
 *
 * The `SimulationKernel` holds exactly ONE active `SimulationExecutor` at a time
 * — the public `ContinuousRunner` (default) or, when the private side registers
 * one, the `DESRunner`. It is the static form of the old dynamic
 * `_physicsPluginActive` mutex: `handlesTransport` is a const `true` because the
 * active executor (continuous OR des) is always exactly one, and that one always
 * drives transport (Plan 194 §2.7 / §11.3).
 *
 * `setMode()` is **Reset-on-Switch** (Plan 194 §3.3, F8): `clearMUs()` on the
 * outgoing executor, then `start()` on the incoming one (fresh, empty — Sources
 * re-spawn with the same PRNG seed). There is NO `KernelSnapshot` / reconcile in
 * v1. The switch is guarded against rapid re-entry (W4/W5) and wrapped in
 * try/catch so a half-finished switch can never wedge the toggle.
 *
 * DES availability is injected, never imported: `registerDesRunnerFactory()`
 * takes the factory the private side provides (the public build's
 * `des-runner-stub` exports `null`), and `hasDesRunner()` reports it. The public
 * UI toggle reads `hasDesRunner()` and hides DES when false — `SimModeToggle`
 * (P6) never imports `DESRunner` directly (Plan 194 V7).
 */

import type { MaterialFlowDefinition } from './define-material-flow';
import type {
  SimulationExecutor,
  SimulationTopology,
} from './simulation-executor';
import { ContinuousRunner } from './continuous-runner';

export type SimulationMode = 'continuous' | 'des';

/**
 * Factory the private DES side provides; `null` in the public build. Same shape
 * as `private-stubs/des-runner-stub.ts` `CreateDesRunner`.
 */
export type DesRunnerFactory =
  | ((defs: MaterialFlowDefinition[], topology: SimulationTopology) => SimulationExecutor)
  | null;

/** Construction dependencies — the viewer's EXISTING continuous runner + topology. */
export interface SimulationKernelOptions {
  /** The continuous executor (wrapping the viewer's shared transport + behaviours). */
  readonly continuousRunner: ContinuousRunner;
  /** Topology handed to an executor on `start()` (scene root). */
  readonly topology: SimulationTopology;
  /** Material-flow definitions in play (continuous discovery already binds them). */
  readonly defs?: MaterialFlowDefinition[];
  /** DES runner factory; defaults to the stub (`null`) → continuous-only public build. */
  readonly desRunnerFactory?: DesRunnerFactory;
}

/**
 * The single transport-owning simulation orchestrator. Drives exactly one
 * `SimulationExecutor` and switches mode via Reset-on-Switch.
 */
export class SimulationKernel {
  /**
   * Static transport mutex — the kernel ALWAYS handles transport because its one
   * active executor always does. Replaces the dynamic `_physicsPluginActive`
   * flag (Plan 194 §2.7 / §11.3).
   */
  static readonly handlesTransport = true;

  /** The continuous executor (always present — the default and the fallback). */
  readonly continuousRunner: ContinuousRunner;

  private readonly topology: SimulationTopology;
  private readonly defs: MaterialFlowDefinition[];
  private desRunnerFactory: DesRunnerFactory;

  /** The currently active executor (continuous by default). */
  private _active: SimulationExecutor;
  /** Current mode tag. */
  private _mode: SimulationMode = 'continuous';
  /** Re-entrancy guard for `setMode` (W4/W5 rapid-toggle). */
  private _switching = false;
  /** Lazily-built DES executor (kept so a continuous↔des round-trip reuses it). */
  private _desRunner: SimulationExecutor | null = null;

  constructor(opts: SimulationKernelOptions) {
    this.continuousRunner = opts.continuousRunner;
    this.topology = opts.topology;
    this.defs = opts.defs ?? [];
    this.desRunnerFactory = opts.desRunnerFactory ?? null;
    this._active = this.continuousRunner;
  }

  // ─── Read accessors ───────────────────────────────────────────────────

  /** The active executor (continuous or des). */
  get activeExecutor(): SimulationExecutor {
    return this._active;
  }

  /** Current mode ('continuous' | 'des'). */
  get mode(): SimulationMode {
    return this._mode;
  }

  /** True while a mode switch is in progress (rapid-toggle guard exposes it for the UI). */
  get isSwitching(): boolean {
    return this._switching;
  }

  /**
   * True when a DES runner factory is registered (i.e. the private side is
   * present). The public build's stub registers `null` → `false`, so the
   * Realtime/DES toggle is hidden (Plan 194 §4.1 / P1).
   */
  hasDesRunner(): boolean {
    return this.desRunnerFactory !== null;
  }

  // ─── DES registration (injection, never import) ───────────────────────

  /**
   * Register (or clear) the DES runner factory. Called once at wiring time with
   * the factory the private side exports (`des-runner-stub` exports `null` in
   * the public build). Idempotent.
   */
  registerDesRunnerFactory(factory: DesRunnerFactory): void {
    this.desRunnerFactory = factory;
  }

  // ─── Mode switch (Reset-on-Switch) ────────────────────────────────────

  /**
   * Switch the active simulation mode (Plan 194 §3.3 Reset-on-Switch, F8).
   *
   * Guards (W4/W5): no-op when already in `m` OR a switch is in flight. The body
   * is wrapped in try/catch so a failed half-switch never leaves `_switching`
   * latched (which would wedge the toggle permanently).
   *
   * Sequence: `clearMUs()` on the outgoing executor (removes all live MUs) →
   * select/build the incoming executor → `start(defs, topology)` (fresh, empty).
   * Sources re-spawn with the same seed so both modes stay comparable.
   *
   * Switching to 'des' with no registered runner is a guarded no-op (the toggle
   * is hidden in that case anyway).
   */
  setMode(m: SimulationMode): void {
    // Rapid-toggle / re-entrancy guard (W5).
    if (this._mode === m || this._switching) return;

    // Public build: no DES runner → DES is unavailable, ignore the request.
    if (m === 'des' && !this.hasDesRunner()) {
      console.warn('[SimulationKernel] setMode("des") ignored — no DES runner registered (public build).');
      return;
    }

    this._switching = true;
    try {
      const incoming = this._resolveExecutor(m);
      if (!incoming) {
        // Could not build the target executor — stay in the current mode.
        return;
      }

      // Reset-on-Switch: drop the outgoing MUs, then start the incoming fresh.
      // Commit `_active`/`_mode` only AFTER `start()` succeeds, so a throwing
      // start() leaves the kernel cleanly in the ORIGINAL mode (not a half-
      // switched target with a broken executor).
      this._active.clearMUs();
      incoming.start(this.defs, this.topology);
      this._active = incoming;
      this._mode = m;
    } catch (e) {
      console.error(`[SimulationKernel] setMode("${m}") failed — staying in '${this._mode}':`, e);
    } finally {
      this._switching = false;
    }
  }

  /** Resolve the executor for a mode, lazily building the DES runner once. */
  private _resolveExecutor(m: SimulationMode): SimulationExecutor | null {
    if (m === 'continuous') return this.continuousRunner;
    // m === 'des'
    if (this._desRunner) return this._desRunner;
    if (!this.desRunnerFactory) return null;
    this._desRunner = this.desRunnerFactory(this.defs, this.topology);
    return this._desRunner;
  }

  // ─── Per-tick delegation ──────────────────────────────────────────────

  /** Advance the active executor one fixed tick. */
  tick(dt: number): void {
    this._active.tick(dt);
  }

  /** Optional post-tick pass on the active executor. */
  lateTick(dt: number): void {
    this._active.lateTick?.(dt);
  }

  /** Reset the active executor (delegated from `RVViewer.resetSimulation`, K3). */
  reset(): void {
    this._active.reset();
  }

  /** Tear down both executors (viewer dispose). */
  dispose(): void {
    try { this.continuousRunner.dispose(); } catch { /* ignore */ }
    if (this._desRunner) {
      try { this._desRunner.dispose(); } catch { /* ignore */ }
      this._desRunner = null;
    }
  }
}
