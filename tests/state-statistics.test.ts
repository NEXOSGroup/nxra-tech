// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { StateStatistics, DEFAULT_FREE_STATES, INITIAL_STATE } from '../src/core/material-flow/rv-state-statistics';

describe('StateStatistics', () => {
  it('accumulates time per state via the injected clock', () => {
    let t = 0;
    const s = new StateStatistics(() => t, { freeStates: ['Empty'] });
    s.setState('Working'); t = 10;
    s.setState('Blocked'); t = 15;
    s.setState('Working'); t = 20;
    const snap = s.getSnapshot();
    expect(snap.states['Working'].duration).toBeCloseTo(15);
    expect(snap.states['Blocked'].duration).toBeCloseTo(5);
    expect(snap.totalTime).toBeCloseTo(20);
    expect(snap.currentState).toBe('Working');
  });

  it('counts entries per state (re-entering same state is not a new interval)', () => {
    let t = 0;
    const s = new StateStatistics(() => t);
    s.setState('Working'); t = 5;
    s.setState('Working'); // no-op, same state
    t = 10;
    s.setState('Idle'); t = 12;
    s.setState('Working');
    expect(s.getSnapshot().states['Working'].entries).toBe(2);
  });

  it('utilization excludes free states', () => {
    let t = 0;
    const s = new StateStatistics(() => t, { freeStates: ['Empty'] });
    s.setState('Working'); t = 75;
    s.setState('Empty');   t = 100;
    expect(s.getUtilization01()).toBeCloseTo(0.75);
    expect(s.getUtilizationPercent()).toBeCloseTo(75);
    expect(s.getStatePercentage('Working')).toBeCloseTo(75);
  });

  it('handles DES time jumps without drift', () => {
    let t = 0;
    const s = new StateStatistics(() => t);
    s.setState('Working'); t = 3600; // 1h jump
    s.setState('Idle');
    expect(s.getSnapshot().states['Working'].duration).toBeCloseTo(3600);
  });

  it('totalTime=0 yields 0% (no division by zero)', () => {
    const s = new StateStatistics(() => 0);
    s.setState('Working');
    expect(s.getStatePercentage('Working')).toBe(0);
    expect(s.getUtilization01()).toBe(0);
  });

  it('reset clears accumulated time but keeps the current state', () => {
    let t = 0;
    const s = new StateStatistics(() => t);
    s.setState('Working'); t = 50;
    s.reset();
    expect(s.getSnapshot().totalTime).toBe(0);
    expect(s.state).toBe('Working'); // current state preserved across reset
    t = 60; // 10s booked to the preserved current state
    expect(s.getSnapshot().states['Working'].duration).toBeCloseTo(10);
    expect(s.getSnapshot().totalTime).toBeCloseTo(10);
  });

  it('output and cycle counters', () => {
    let t = 0;
    const s = new StateStatistics(() => t);
    s.cycleStart(); t = 12; s.cycleEnd();
    s.cycleStart(); t = 20; s.cycleEnd(); // 8s
    s.output(2);
    const snap = s.getSnapshot();
    expect(snap.output).toBe(2);
    expect(snap.cycleCount).toBe(2);
    expect(snap.cycleAvg).toBeCloseTo(10);
    expect(snap.cycleMin).toBeCloseTo(8);
    expect(snap.cycleMax).toBeCloseTo(12);
  });

  it('cycleEnd without cycleStart is ignored', () => {
    let t = 0;
    const s = new StateStatistics(() => t);
    s.cycleEnd();
    expect(s.getSnapshot().cycleCount).toBe(0);
  });

  it('disabled accumulator ignores setState', () => {
    let t = 0;
    const s = new StateStatistics(() => t, { enabled: false });
    s.setState('Working'); t = 10;
    expect(s.getSnapshot().states['Working']?.duration ?? 0).toBe(0);
  });

  it('starts in INITIAL_STATE with default free states', () => {
    const s = new StateStatistics(() => 0);
    expect(s.state).toBe(INITIAL_STATE);
    expect(s.freeStates).toEqual([...DEFAULT_FREE_STATES]);
  });
});
