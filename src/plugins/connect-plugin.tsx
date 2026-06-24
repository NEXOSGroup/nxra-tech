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
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import { CONNECT_PANEL_WIDTH } from '../core/hmi/layout-constants';
import { WebSocketRealtimeInterface } from '../interfaces/websocket-realtime-interface';
import { INTERFACE_DEFAULTS, type InterfaceSettings } from '../interfaces/interface-settings-store';
import {
  subscribeConnectStore,
  getConnectSnapshot,
  connectToServer,
} from '../core/hmi/connect-store';
import { Tooltip, IconButton, Box } from '@mui/material';

// ── Activity Bar Button Component (opens the CONNECT left window) ─────

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
    <Tooltip title={isConnected ? 'CONNECT (connected)' : 'realvirtual CONNECT'} placement="right">
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

// ── Auto WS stream ────────────────────────────────────────────────────

/** Build WebSocket-Realtime settings targeting a CONNECT gateway's /ws from its REST URL. */
function buildConnectWsSettings(serverUrl: string): InterfaceSettings {
  let host = 'localhost';
  let port = 5100;
  let ssl = false;
  try {
    const u = new URL(serverUrl);
    host = u.hostname || host;
    ssl = u.protocol === 'https:';
    port = u.port ? parseInt(u.port, 10) : (ssl ? 443 : 80);
  } catch {
    // keep defaults
  }
  return {
    ...INTERFACE_DEFAULTS,
    activeType: 'websocket-realtime',
    autoConnect: true,
    wsAddress: host,
    wsPort: port,
    wsUseSSL: ssl,
    wsPath: '/ws',
  };
}

// ── Plugin Class ─────────────────────────────────────────────────────

export class ConnectPlugin implements RVViewerPlugin {
  readonly id = 'connect';
  readonly order = 55;

  readonly slots: UISlotEntry[] = [
    // Opens a left-docked window → lives in the activity bar.
    { slot: 'activity-bar', component: ConnectToolbarButton, order: 60 },
  ];

  /**
   * Embedded WebSocket-Realtime client that streams live signal values from the connected
   * CONNECT gateway (ws://…/ws) into the viewer SignalStore. Owned here — not registered with the
   * InterfaceManager — so it never consumes the single-interface mutex of the Interfaces tab.
   */
  private readonly wsStream = new WebSocketRealtimeInterface();
  private viewer: RVViewer | null = null;
  private unsubscribe: (() => void) | null = null;
  private streaming = false;

  /** Auto-connect when model is loaded (if not already connected) and wire the live stream. */
  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this.viewer = viewer;
    this.wsStream.onModelLoaded(result, viewer);

    if (!this.unsubscribe) {
      this.unsubscribe = subscribeConnectStore(() => this.syncStream());
    }

    const snap = getConnectSnapshot();
    if (snap.state === 'disconnected') {
      connectToServer().catch(() => {
        // Silent fail — user can connect manually via panel
      });
    }
    this.syncStream();
  }

  /** Open/close the live value stream so it follows the CONNECT REST connection state. */
  private syncStream(): void {
    if (!this.viewer) return;
    const snap = getConnectSnapshot();
    const shouldStream = snap.state === 'connected';

    if (shouldStream && !this.streaming) {
      this.streaming = true;
      this.wsStream.connect(buildConnectWsSettings(snap.serverUrl)).catch(() => {
        this.streaming = false;
      });
    } else if (!shouldStream && this.streaming) {
      this.streaming = false;
      this.wsStream.disconnect();
    }
  }

  // Forward the fixed-step ticks so the embedded interface flushes incoming values into the
  // SignalStore (onFixedUpdatePre) and pushes outgoing writes back to the gateway (onFixedUpdatePost).
  onFixedUpdatePre(dt: number): void {
    this.wsStream.onFixedUpdatePre(dt);
  }

  onFixedUpdatePost(dt: number): void {
    this.wsStream.onFixedUpdatePost(dt);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.wsStream.dispose();
    this.viewer = null;
  }
}
