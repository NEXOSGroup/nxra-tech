// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-load-profiler.ts — Lightweight phase timer for model load.
 *
 * Measures the duration of each load phase using performance.now() deltas.
 * The only cost when the 'perf' debug category is inactive is the cheap
 * performance.now() call at each phase boundary; report() is a no-op.
 *
 * Enable via `?debug=perf` (or `localStorage.setItem('rv-debug', 'perf')`).
 */

import { isDebugEnabled, debug } from './rv-debug';

/** A single measured phase. */
interface PhaseTiming {
  phase: string;
  ms: number;
}

/** Profiler instance returned by createLoadProfiler(). */
export interface LoadProfiler {
  /** Record the elapsed time since the previous mark under `phase`. */
  mark(phase: string): void;
  /** Emit a duration-sorted table when 'perf' is enabled; no-op otherwise. */
  report(): void;
}

/**
 * Create a load profiler. Call mark() at each phase boundary (NOT per element)
 * and report() at the end. Uses performance.now() exclusively.
 */
export function createLoadProfiler(label: string): LoadProfiler {
  const timings: PhaseTiming[] = [];
  let last = performance.now();

  return {
    mark(phase: string): void {
      const now = performance.now();
      timings.push({ phase, ms: now - last });
      last = now;
    },

    report(): void {
      if (!isDebugEnabled('perf')) return;
      const total = timings.reduce((sum, t) => sum + t.ms, 0);
      const rows = timings
        .slice()
        .sort((a, b) => b.ms - a.ms)
        .map((t) => ({
          phase: t.phase,
          ms: +t.ms.toFixed(2),
          pct: total > 0 ? +((t.ms / total) * 100).toFixed(1) : 0,
        }));
      debug('perf', `${label}: total ${total.toFixed(2)} ms`, rows);
      // console.table renders the sorted rows nicely in DevTools.
      if (typeof console !== 'undefined' && typeof console.table === 'function') {
        console.table(rows);
      }
    },
  };
}
