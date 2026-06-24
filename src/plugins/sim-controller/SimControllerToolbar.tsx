// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SimControllerToolbar — the Play/Pause toggle + Reset action group. Registered
 * in the `toolbar-button-leading` slot, which the HMI renders as a floating
 * action group next to the workspace mode switcher (top-left of the viewport).
 *
 * Subscribes to `'simulation-pause-changed'` via `useSyncExternalStore`, so
 * UI updates fire only on idle↔paused transitions (or pause-reason add/
 * remove), not every render frame.
 */

import { useSyncExternalStore, useCallback, useMemo } from 'react';
import { PlayArrow, Pause, Replay } from '@mui/icons-material';
import type { UISlotProps } from '../../core/rv-ui-plugin';
import { ActionSegment, ActionDivider } from '../../core/hmi/action-group';
import { SIM_CONTROLLER_PAUSE_REASON } from './index';

/** Snapshot shape returned by `getPauseSnapshot`. Compared by reference so
 *  `useSyncExternalStore` re-renders only when the underlying state changes. */
interface PauseSnapshot {
  paused: boolean;
  reasons: readonly string[];
  /** Stable signature used as the version key for `getSnapshot`. */
  version: number;
}

export function SimControllerToolbar({ viewer }: UISlotProps) {
  // Local version counter — bumped on every pause-changed event. The snapshot
  // factory closes over this counter, so React sees a stable object identity
  // between events and re-renders only when something actually changes.
  // We persist the version + last snapshot on the viewer via WeakMap-like
  // attachment so concurrent toolbar consumers share the same source of truth.
  const { subscribe, getSnapshot } = useMemo(() => makeStore(viewer), [viewer]);
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const userPaused = snap.reasons.includes(SIM_CONTROLLER_PAUSE_REASON);

  const handleTogglePlayPause = useCallback(() => {
    viewer.setSimulationPaused(SIM_CONTROLLER_PAUSE_REASON, !userPaused);
  }, [viewer, userPaused]);

  const handleReset = useCallback(() => {
    viewer.resetSimulation();
  }, [viewer]);

  // Icon reflects the ACTUAL sim state (paused by ANY reason — user, planner
  // 'layout-edit', AR, …) so the toolbar shows "paused" whenever the sim is
  // held, e.g. on entering the Layout-Planner. (Size is normalized by ActionSegment.)
  const playPauseIcon = snap.paused ? <PlayArrow /> : <Pause />;
  // Detailed tooltip surfaces *all* active pause reasons — replaces the inline
  // chip that used to render in the toolbar. Keeps the info discoverable on
  // hover without cluttering the main menu.
  const reasonsList = snap.paused && snap.reasons.length > 0
    ? ` — paused by: ${snap.reasons.join(', ')}`
    : '';
  const playPauseTitle = (snap.paused ? 'Play (Space)' : 'Pause (Space)') + reasonsList;

  // Subtle visual hint when paused by *something else* (not the user button):
  // the play/pause button picks up the warning colour so the user notices the
  // sim is being held by another plugin (Planner, AR, …) even when they did
  // not press Pause themselves.
  const pausedByOther = snap.paused && !userPaused;
  const playPauseColor = userPaused ? 'primary.main' : pausedByOther ? 'warning.main' : 'inherit';

  // Segmented action group (shared design): full-height rectangular segments
  // split by a divider. The pill wrapper is provided by the host (TopBar).
  return (
    <>
      <ActionSegment
        title={playPauseTitle}
        onClick={handleTogglePlayPause}
        color={playPauseColor}
        icon={playPauseIcon}
        buttonProps={{ 'data-testid': 'sim-controller-playpause' }}
      />
      <ActionDivider />
      <ActionSegment
        title="Reset MUs and LogicSteps (Shift+R)"
        onClick={handleReset}
        icon={<Replay />}
        buttonProps={{ 'data-testid': 'sim-controller-reset' }}
      />
    </>
  );
}

// ── Per-viewer pause-state store ───────────────────────────────────────────
//
// We attach a single subscribe/getSnapshot pair per viewer instance so
// multiple toolbar consumers share the same memoised snapshot.

interface PauseStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => PauseSnapshot;
}

const _storeCache = new WeakMap<object, PauseStore>();

function makeStore(viewer: UISlotProps['viewer']): PauseStore {
  const cached = _storeCache.get(viewer);
  if (cached) return cached;

  let version = 0;
  let snapshot: PauseSnapshot = {
    paused: viewer.isSimulationPaused,
    reasons: [...viewer.simulationPauseReasons],
    version,
  };
  const listeners = new Set<() => void>();

  const refresh = (): void => {
    version++;
    snapshot = {
      paused: viewer.isSimulationPaused,
      reasons: [...viewer.simulationPauseReasons],
      version,
    };
    for (const l of listeners) l();
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    const off = viewer.on('simulation-pause-changed', refresh as (data: unknown) => void);
    return () => {
      listeners.delete(listener);
      off();
    };
  };

  const getSnapshot = (): PauseSnapshot => snapshot;

  const store: PauseStore = { subscribe, getSnapshot };
  _storeCache.set(viewer, store);
  return store;
}
