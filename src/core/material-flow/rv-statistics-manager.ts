// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-statistics-manager.ts — per-component statistics registry + aggregator
 * (Plan 201, Phase 3).
 *
 * The single PUBLIC registry of every component's `StateStatistics`. It does NOT
 * set states itself (no auto-derive) — components feed their own `StateStatistics`
 * via `self.setState(...)` from their `logic`/`continuous`/`des` code. The
 * manager only collects, aggregates (OEE / utilization / throughput / bottleneck)
 * and exposes a snapshot for UI / export.
 *
 * One manager lives on `RVViewer.statisticsManager`. The continuous bind path
 * (`defineLibraryComponent`) and — once unified (Plan 201 E1) — the DES path
 * register each component's `StateStatistics` here, keyed by node path. Because
 * registration is keyed by path, both engines feed the SAME registry, so the
 * existing DES stats UI can read a single unified source across modes.
 */

import type { StateStatistics } from './rv-state-statistics';

/** One component's row in the aggregate snapshot. */
export interface ComponentStatRow {
  /** Node path (registry key). */
  path: string;
  /** Current state name. */
  state: string;
  /** Utilization 0..1. */
  utilization: number;
  /** Completed-output counter. */
  output: number;
  /** Total tracked time in seconds. */
  totalTime: number;
}

/** Aggregate snapshot across all registered components. */
export interface StatisticsAggregate {
  /** Per-component rows. */
  components: ComponentStatRow[];
  /** Mean utilization across components with tracked time (0..1). */
  meanUtilization: number;
  /** Aggregate throughput (parts per hour) — sum of per-component rates. */
  throughputPerHour: number;
  /**
   * Bottleneck = highest-utilization component (matches the DES KPI convention),
   * or null when nothing has accumulated time yet.
   */
  bottleneck: { path: string; utilization: number } | null;
}

/** Registry + aggregator of per-component `StateStatistics`. */
export class StatisticsManager {
  private readonly map = new Map<string, StateStatistics>();

  /** Register (or replace) a component's statistics under `path`. */
  register(path: string, stats: StateStatistics): void {
    this.map.set(path, stats);
  }

  /** Remove a component's statistics (on component dispose). */
  unregister(path: string): void {
    this.map.delete(path);
  }

  /** Lookup a component's statistics by path. */
  get(path: string): StateStatistics | undefined {
    return this.map.get(path);
  }

  /** Number of registered components. */
  get size(): number {
    return this.map.size;
  }

  /** Live view of all registered entries. */
  entries(): ReadonlyArray<readonly [string, StateStatistics]> {
    return [...this.map.entries()];
  }

  /** Drop all registrations (model unload). */
  clear(): void {
    this.map.clear();
  }

  /** Reset every registered accumulator without dropping registrations (sim reset / mode switch). */
  resetAll(): void {
    for (const s of this.map.values()) s.reset();
  }

  /** Build the aggregate snapshot (allocates — call at UI poll rate, not per tick). */
  getAggregate(): StatisticsAggregate {
    const components: ComponentStatRow[] = [];
    let utilSum = 0;
    let utilCount = 0;
    let throughput = 0;
    let bottleneck: { path: string; utilization: number } | null = null;

    for (const [path, stats] of this.map) {
      const snap = stats.getSnapshot();
      const utilization = snap.utilization;
      components.push({
        path,
        state: snap.currentState,
        utilization,
        output: snap.output,
        totalTime: snap.totalTime,
      });
      if (snap.totalTime > 0) {
        utilSum += utilization;
        utilCount++;
        throughput += (snap.output / snap.totalTime) * 3600;
        if (!bottleneck || utilization > bottleneck.utilization) {
          bottleneck = { path, utilization };
        }
      }
    }

    return {
      components,
      meanUtilization: utilCount > 0 ? utilSum / utilCount : 0,
      throughputPerHour: throughput,
      bottleneck,
    };
  }
}
