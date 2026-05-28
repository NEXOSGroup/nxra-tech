// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SimControllerToolbar — Two icon buttons (Play/Pause toggle + Reset) plus
 * an optional Pause-Badge displayed in the TopBar's `toolbar-button` slot.
 *
 * Subscribes to `'simulation-pause-changed'` via `useSyncExternalStore`, so
 * UI updates fire only on idle↔paused transitions (or pause-reason add/
 * remove), not every render frame.
 */

import { useSyncExternalStore, useCallback, useMemo } from 'react';
import { PlayArrow, Pause, Replay } from '@mui/icons-material';
import { Tooltip, IconButton, Box, Divider } from '@mui/material';
import type { UISlotProps } from '../../core/rv-ui-plugin';
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
  // held, e.g. on entering the Layout-Planner.
  const playPauseIcon = snap.paused ? <PlayArrow fontSize="small" /> : <Pause fontSize="small" />;
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
  const playPauseColor: 'primary' | 'warning' | 'inherit' =
    userPaused ? 'primary' : pausedByOther ? 'warning' : 'inherit';

  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
      <Tooltip title={playPauseTitle} placement="bottom">
        <IconButton
          size="small"
          color={playPauseColor}
          sx={{ p: 0.75 }}
          onClick={handleTogglePlayPause}
          data-testid="sim-controller-playpause"
        >
          {playPauseIcon}
        </IconButton>
      </Tooltip>
      <Tooltip title="Reset MUs and LogicSteps (Shift+R)" placement="bottom">
        <IconButton
          size="small"
          color="inherit"
          sx={{ p: 0.75 }}
          onClick={handleReset}
          data-testid="sim-controller-reset"
        >
          <Replay fontSize="small" />
        </IconButton>
      </Tooltip>
      {/* Vertical divider visually groups Play/Pause + Reset and separates
          them from whatever toolbar plugin renders next (Hierarchy, Models,
          LayoutPlanner, …). */}
      <Divider
        orientation="vertical"
        flexItem
        sx={{ mx: 0.5, my: 0.5, borderColor: 'divider' }}
        data-testid="sim-controller-divider"
      />
    </Box>
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
