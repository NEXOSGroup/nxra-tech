// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * React hook for event-based sensor state (no polling).
 *
 * Subscribes to the generic `component-event` (componentType: 'sensor',
 * kind: 'changed') and returns the occupied state for a specific sensor path.
 *
 * Usage:
 *   const occupied = useSensorState('DemoCell/EntrySensor');
 */

import { useState, useEffect } from 'react';
import { useViewer } from './use-viewer';

/** Returns the occupied state for a sensor, updated via events. */
export function useSensorState(sensorPath: string): boolean {
  const viewer = useViewer();
  const [occupied, setOccupied] = useState(false);

  useEffect(() => {
    return viewer.on('component-event', (e) => {
      if (e.componentType !== 'sensor' || e.kind !== 'changed') return;
      if (e.path !== sensorPath) return;
      const occupiedVal = (e.payload as { occupied: boolean } | undefined)?.occupied;
      if (typeof occupiedVal === 'boolean') setOccupied(occupiedVal);
    });
  }, [viewer, sensorPath]);

  return occupied;
}
