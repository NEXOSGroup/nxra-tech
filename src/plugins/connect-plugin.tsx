// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * connect-plugin.tsx — realvirtual CONNECT gateway plugin.
 *
 * Registers an icon button in the TopBar ('toolbar-button' slot) that
 * toggles the ConnectPanel via the LeftPanelManager. A green dot on the
 * Cable icon indicates an active gateway connection.
 */

import { useSyncExternalStore, useCallback } from 'react';
import { Cable } from '@mui/icons-material';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import { CONNECT_PANEL_WIDTH } from '../core/hmi/layout-constants';
import {
  subscribeConnectStore,
  getConnectSnapshot,
  connectToServer,
} from '../core/hmi/connect-store';
import { Tooltip, IconButton, Box } from '@mui/material';

// ── Toolbar Button Component (TopBar) ────────────────────────────────

function ConnectToolbarButton({ viewer }: UISlotProps) {
  const connectSnap = useSyncExternalStore(subscribeConnectStore, getConnectSnapshot);
  const lpm = viewer.leftPanelManager;
  const panelSnap = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  const isActive = panelSnap.activePanel === 'connect';
  const isConnected = connectSnap.state === 'connected';

  const handleClick = useCallback(() => {
    lpm.toggle('connect', CONNECT_PANEL_WIDTH);
  }, [lpm]);

  return (
    <Tooltip title={isConnected ? 'CONNECT (connected)' : 'realvirtual CONNECT'} placement="bottom">
      <IconButton
        size="small"
        color={isActive ? 'primary' : 'inherit'}
        sx={{ p: 0.75, position: 'relative' }}
        onClick={handleClick}
      >
        <Cable fontSize="small" />
        {/* Green dot when connected */}
        {isConnected && (
          <Box sx={{ position: 'absolute', top: 4, right: 4, width: 6, height: 6, borderRadius: '50%', bgcolor: '#66bb6a' }} />
        )}
      </IconButton>
    </Tooltip>
  );
}

// ── Plugin Class ─────────────────────────────────────────────────────

export class ConnectPlugin implements RVViewerPlugin {
  readonly id = 'connect';
  readonly order = 55;

  readonly slots: UISlotEntry[] = [
    { slot: 'toolbar-button', component: ConnectToolbarButton, order: 10 },
  ];

  /** Auto-connect when model is loaded (if not already connected). */
  onModelLoaded(): void {
    const snap = getConnectSnapshot();
    if (snap.state === 'disconnected') {
      connectToServer().catch(() => {
        // Silent fail — user can connect manually via panel
      });
    }
  }
}
