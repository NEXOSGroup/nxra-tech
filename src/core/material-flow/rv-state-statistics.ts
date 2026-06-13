// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-state-statistics.ts — flexible per-component state statistics (Plan 201).
 *
 * Pure, framework-free accumulator. A simulation clock is injected (`clockFn`)
 * so the SAME class works in BOTH engines:
 *  - Continuous (60 Hz fixed-step): clockFn = () => viewer.simTime (advanced by dt)
 *  - DES (discrete-event, time-jumping): clockFn = () => viewer.simTime (= scheduler.now)
 *
 * States are arbitrary strings, set explicitly from component code via
 * `self.setState(name)` (no auto-derive). Time is accumulated record-on-change:
 * on every state change the elapsed time of the previous state is booked. This
 * is allocation-free in the hot path (only Map arithmetic; a new bucket is
 * allocated once per never-seen-before state name).
 *
 * `freeStates` are states that do NOT count towards utilization
 * (utilization = 1 - freeFraction). Default mirrors the DES convention.
 *
 * This is the single source of truth for state timing — the private DES layer
 * (`DESComponent`) delegates to it (Plan 201, E1) so there is no double count.
 */

/**
 * States excluded from utilization by default. Configurable per instance.
 * Matched CASE-INSENSITIVELY so both the DES vocabulary ('Empty'/'Blocked') and
 * the continuous-behaviour FSM vocabulary ('idle') resolve as free.
 */
export const DEFAULT_FREE_STATES: readonly string[] = ['Empty', 'Blocked', 'Stopped', 'Idle'];

/**
 * Default initial state name. Mirrors `MaterialFlowSelf`'s historical 'idle'
 * (a load-bearing FSM sentinel in the Turntable behaviour) so a component's
 * stats start in the same state its FSM does. `idle` is a free state.
 */
export const INITIAL_STATE = 'idle';

/** One state's accumulated timing. */
export interface StateTiming {
  duration: number; // seconds spent in this state
  entries: number;  // how many times the state was entered
}

/** Immutable view of an accumulator's current numbers (allocated on read). */
export interface StateStatsSnapshot {
  currentState: string;
  /** Total tracked time in seconds (since construction / last reset). */
  totalTime: number;
  /** Utilization 0..1 (= 1 - free fraction). */
  utilization: number;
  /** Per-state distribution including the still-open current state. */
  states: Record<string, { duration: number; percent: number; entries: number }>;
  /** Completed-part counter (statOutput). */
  output: number;
  /** Cycle time stats (statCycleStart/End), seconds. */
  cycleAvg: number;
  cycleMin: number;
  cycleMax: number;
  cycleCount: number;
}

export interface StateStatisticsOptions {
  /** States not counted towards utilization. Defaults to DEFAULT_FREE_STATES. */
  freeStates?: readonly string[];
  /** Initial state name. Defaults to INITIAL_STATE ('Empty'). */
  initialState?: string;
  /** When false, setState/output/cycle are ignored. Defaults to true. */
  enabled?: boolean;
}

/**
 * Flexible per-component state-time accumulator. Owned by one component
 * instance; fed from component code via `setState`.
 */
export class StateStatistics {
  /** States excluded from utilization (mutable — flexible per component). */
  freeStates: string[];
  enabled: boolean;

  private readonly clockFn: () => number;
  private readonly timings = new Map<string, StateTiming>();
  private current: string;
  private stateStartTime: number;
  private trackingStartTime: number;

  // statOutput / statCycle counters
  private outputCount = 0;
  private cycleStartTime: number | null = null;
  private cycleSum = 0;
  private cycleCount = 0;
  private cycleMinV = Number.POSITIVE_INFINITY;
  private cycleMaxV = Number.NEGATIVE_INFINITY;

  constructor(clockFn: () => number, opts: StateStatisticsOptions = {}) {
    this.clockFn = clockFn;
    this.freeStates = [...(opts.freeStates ?? DEFAULT_FREE_STATES)];
    this.enabled = opts.enabled ?? true;
    this.current = opts.initialState ?? INITIAL_STATE;
    const now = clockFn();
    this.stateStartTime = now;
    this.trackingStartTime = now;
    this.timings.set(this.current, { duration: 0, entries: 1 });
  }

  /** Current state name. */
  get state(): string {
    return this.current;
  }

  /**
   * Change state, booking the elapsed time of the previous state.
   * No-op when disabled or when `name` equals the current state (the running
   * interval keeps accumulating — re-entering the same state is not a new
   * interval).
   */
  setState(name: string): void {
    if (!this.enabled || name === this.current) return;
    const now = this.clockFn();
    const prev = this.timings.get(this.current);
    if (prev) prev.duration += now - this.stateStartTime;
    this.current = name;
    this.stateStartTime = now;
    const next = this.timings.get(name);
    if (next) next.entries++;
    else this.timings.set(name, { duration: 0, entries: 1 });
  }

  /** Count completed output (parts). */
  output(n = 1): void {
    if (!this.enabled) return;
    this.outputCount += n;
  }

  /** Start a cycle timer (statCycleStart). */
  cycleStart(): void {
    if (!this.enabled) return;
    this.cycleStartTime = this.clockFn();
  }

  /** Close a cycle timer (statCycleEnd). Ignored if no cycle was started. */
  cycleEnd(): void {
    if (!this.enabled || this.cycleStartTime === null) return;
    const dur = this.clockFn() - this.cycleStartTime;
    this.cycleStartTime = null;
    if (dur < 0) return;
    this.cycleSum += dur;
    this.cycleCount++;
    if (dur < this.cycleMinV) this.cycleMinV = dur;
    if (dur > this.cycleMaxV) this.cycleMaxV = dur;
  }

  /** Total tracked time in seconds (since construction / reset). */
  getTotalTime(): number {
    return Math.max(0, this.clockFn() - this.trackingStartTime);
  }

  /** Percentage (0..100) of time spent in `state`, including the open interval. */
  getStatePercentage(state: string): number {
    const total = this.getTotalTime();
    if (total <= 0) return 0;
    return (this.durationOf(state) / total) * 100;
  }

  /** Utilization 0..1 (= 1 - free fraction). Free states matched case-insensitively. */
  getUtilization01(): number {
    const total = this.getTotalTime();
    if (total <= 0) return 0;
    const free = new Set(this.freeStates.map(s => s.toLowerCase()));
    let freeTime = 0;
    for (const [name, entry] of this.timings) {
      if (free.has(name.toLowerCase())) freeTime += this.durationFromEntry(name, entry);
    }
    return Math.max(0, Math.min(1, (total - freeTime) / total));
  }

  /** Utilization 0..100. */
  getUtilizationPercent(): number {
    return this.getUtilization01() * 100;
  }

  /** Allocated snapshot of all numbers (for UI / aggregation / export). */
  getSnapshot(): StateStatsSnapshot {
    const total = this.getTotalTime();
    const denom = total > 0 ? total : 1;
    const states: Record<string, { duration: number; percent: number; entries: number }> = {};
    for (const [name, entry] of this.timings) {
      const dur = this.durationFromEntry(name, entry);
      states[name] = { duration: dur, percent: (dur / denom) * 100, entries: entry.entries };
    }
    return {
      currentState: this.current,
      totalTime: total,
      utilization: this.getUtilization01(),
      states,
      output: this.outputCount,
      cycleAvg: this.cycleCount > 0 ? this.cycleSum / this.cycleCount : 0,
      cycleMin: this.cycleCount > 0 ? this.cycleMinV : 0,
      cycleMax: this.cycleCount > 0 ? this.cycleMaxV : 0,
      cycleCount: this.cycleCount,
    };
  }

  /** Clear all accumulated data; restart tracking from the current clock. */
  reset(): void {
    this.timings.clear();
    const now = this.clockFn();
    this.stateStartTime = now;
    this.trackingStartTime = now;
    this.timings.set(this.current, { duration: 0, entries: 1 });
    this.outputCount = 0;
    this.cycleStartTime = null;
    this.cycleSum = 0;
    this.cycleCount = 0;
    this.cycleMinV = Number.POSITIVE_INFINITY;
    this.cycleMaxV = Number.NEGATIVE_INFINITY;
  }

  private durationOf(state: string): number {
    const entry = this.timings.get(state);
    if (!entry) return 0;
    return this.durationFromEntry(state, entry);
  }

  private durationFromEntry(name: string, entry: StateTiming): number {
    return name === this.current
      ? entry.duration + (this.clockFn() - this.stateStartTime)
      : entry.duration;
  }
}
