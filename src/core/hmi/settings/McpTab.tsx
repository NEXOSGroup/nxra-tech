// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useEffect, type ReactNode } from 'react';
import { Typography, Box, Button, Switch, TextField } from '@mui/material';
import { useViewer } from '../../../hooks/use-viewer';
import { useMcpBridge, useMcpBridgeLog } from '../../../hooks/use-mcp-bridge';
import type { McpBridgePluginAPI } from '../../types/plugin-types';
import { StatRow, SettingsSection, FieldRow } from './settings-helpers';

const MCP_JSON_SNIPPET = `"WebViewerMCP": {
  "command": "node",
  "args": ["<project>/Assets/realvirtual-WebViewer~/mcp-bridge/dist/index.js"]
}`;

const BUILD_CMD = 'cd Assets/realvirtual-WebViewer~/mcp-bridge\nnpm run setup';

/** Quick-switch targets: which bridge (which Claude) drives this browser.
 *  Each Claude client runs its own Node bridge on its own port. */
const BRIDGE_PRESETS: { label: string; port: string }[] = [
  { label: 'Desktop', port: '18714' },
  { label: 'Code', port: '18715' },
  { label: 'Python', port: '18712' },
];

/** Monospace block with a copy-to-clipboard button. */
function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <Box sx={{ position: 'relative', bgcolor: 'rgba(0,0,0,0.35)', borderRadius: 1, p: 1, pr: 5 }}>
      <Typography component="pre" sx={{
        fontFamily: 'monospace', fontSize: 11, m: 0,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'rgba(255,255,255,0.85)',
      }}>
        {text}
      </Typography>
      <Button size="small" variant="text" onClick={copy}
        sx={{ position: 'absolute', top: 2, right: 2, minWidth: 0, px: 0.75, textTransform: 'none', fontSize: 10 }}>
        {copied ? '✓' : 'Copy'}
      </Button>
    </Box>
  );
}

/** A numbered setup step. */
function SetupStep({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Typography variant="caption" sx={{ fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>
        {n}. {title}
      </Typography>
      {children}
    </Box>
  );
}

export function McpTab() {
  const viewer = useViewer();
  const mcp = useMcpBridge();
  const log = useMcpBridgeLog();
  const mcpPlugin = viewer.getPlugin<McpBridgePluginAPI>('mcp-bridge');
  const [portInput, setPortInput] = useState(mcp.port);
  const [portError, setPortError] = useState(false);

  // Sync portInput when mcp.port changes externally
  useEffect(() => { setPortInput(mcp.port); }, [mcp.port]);

  const stateColor = mcp.connected ? '#66bb6a'
    : mcp.reconnectAttempt > 0 ? '#ffa726'
    : mcp.enabled ? '#ef5350'
    : 'rgba(255,255,255,0.5)';

  const stateLabel = mcp.connected ? 'Connected'
    : mcp.reconnectAttempt > 0 ? `Reconnecting (${mcp.reconnectAttempt})...`
    : mcp.enabled ? 'Disconnected'
    : 'Disabled';

  // Full-chain status: the bridge server pushes who's attached (which Claude)
  // and when it was last active. Present only for the Node bridge — the legacy
  // Python bridge sends no status frame, so these rows stay hidden for it.
  const ss = mcp.serverStatus;
  const aiConnected = !!ss?.clientConnected;
  const aiColor = aiConnected ? '#66bb6a' : '#ef5350';
  const aiLabel = aiConnected ? (ss?.clientName ?? 'connected') : 'no AI client';

  const fmtAgo = (ms: number | null | undefined): string => {
    if (ms == null) return 'idle';
    if (ms < 1500) return 'just now';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.round(m / 60)}h ago`;
  };
  const fmtUptime = (ms: number | undefined): string => {
    if (ms == null) return '?';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  };
  const bridgeLabel = ss ? `pid ${ss.pid} · :${ss.port} · up ${fmtUptime(ss.uptimeMs)}` : '—';

  const validatePort = (val: string): boolean => {
    const n = Number(val);
    return Number.isInteger(n) && n >= 1 && n <= 65535;
  };

  const handlePortChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setPortInput(val);
    setPortError(val !== '' && !validatePort(val));
  };

  const handlePortBlur = () => {
    if (portInput !== mcp.port && validatePort(portInput)) {
      // Reconnect if running; otherwise just store the port for the next enable.
      if (mcp.enabled) mcpPlugin?.reconnect(portInput);
      else mcpPlugin?.setPort(portInput);
    } else if (!validatePort(portInput)) {
      setPortInput(mcp.port);
      setPortError(false);
    }
  };

  const handlePortKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
    }
  };

  // One-click switch: set the target port + enable + (re)connect.
  const switchTo = (port: string) => {
    setPortInput(port);
    mcpPlugin?.reconnect(port);
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <SettingsSection id="mcp-bridge" title="AI Bridge">
        {/* Enable toggle */}
        <FieldRow label="AI Bridge">
          <Switch size="small" checked={mcp.enabled}
            onChange={(_, v) => mcpPlugin?.setEnabled(v)} />
        </FieldRow>

        {/* Status — the FULL chain: browser ⟷ bridge ⟷ AI client. "State" is
            only the browser↔bridge WebSocket leg; "AI client" shows whether a
            live Claude is actually attached (and which one), so a connected
            browser on a host-less bridge no longer looks healthy. */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <StatRow label="Browser → Bridge" value={stateLabel} color={stateColor} />
          {mcp.connected && ss && (
            <>
              <StatRow label="AI client" value={aiLabel} color={aiColor} />
              <StatRow label="Last AI activity" value={fmtAgo(ss.lastRequestAgoMs)} />
            </>
          )}
          <StatRow label="Tools" value={String(mcp.toolCount)} />
          <StatRow label="Port" value={mcp.port} />
          {mcp.connected && ss && <StatRow label="Bridge" value={bridgeLabel} />}
        </Box>

        {/* Quick target — pick which Claude (or Python) drives this browser. */}
        <FieldRow label="Connect to">
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
            {BRIDGE_PRESETS.map(p => (
              <Button key={p.port} size="small"
                variant={mcp.port === p.port ? 'contained' : 'outlined'}
                onClick={() => switchTo(p.port)}
                title={`port ${p.port}`}
                sx={{ textTransform: 'none', minWidth: 0, px: 1 }}>
                {p.label}
              </Button>
            ))}
          </Box>
        </FieldRow>

        {/* Port config */}
        <FieldRow label="Port">
          <TextField
            size="small"
            type="number"
            value={portInput}
            onChange={handlePortChange}
            onBlur={handlePortBlur}
            onKeyDown={handlePortKeyDown}
            error={portError}
            helperText={portError ? '1-65535' : undefined}
            slotProps={{ htmlInput: { min: 1, max: 65535 } }}
            sx={{ width: 110, '& input': { fontFamily: 'monospace', fontSize: 13 } }}
          />
        </FieldRow>

        {/* Retry button */}
        {mcp.enabled && !mcp.connected && (
          <Button size="small" variant="outlined" onClick={() => mcpPlugin?.reconnect()}
            sx={{ alignSelf: 'flex-start', textTransform: 'none' }}>
            Retry Now
          </Button>
        )}

        {/* Server controls — the enable toggle above starts/stops the connection;
            these steer the bridge server itself. */}
        {mcp.connected && (
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            <Button size="small" variant="outlined" onClick={() => mcpPlugin?.pauseServer()}
              sx={{ textTransform: 'none' }}>Pause</Button>
            <Button size="small" variant="outlined" onClick={() => mcpPlugin?.resumeServer()}
              sx={{ textTransform: 'none' }}>Resume</Button>
            <Button size="small" variant="outlined" color="error" onClick={() => mcpPlugin?.shutdownServer()}
              sx={{ textTransform: 'none' }}>Shutdown</Button>
          </Box>
        )}
      </SettingsSection>

      {/* Setup helper — shown until the bridge is connected. */}
      {!mcp.connected && (
        <SettingsSection id="mcp-setup" title="Setup — enable the AI Bridge">
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.65)' }}>
            The AI Bridge needs a small local Node server (one-time setup).
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: 0.5 }}>
            <SetupStep n={1} title="Build the bridge (double-click setup.cmd, or run)">
              <CodeBlock text={BUILD_CMD} />
            </SetupStep>
            <SetupStep n={2} title="Register with Claude">
              <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.65)' }}>
                Easiest — in Unity: <b>Tools ▸ realvirtual ▸ Settings ▸ Configure Claude Desktop MCP</b>.
                Or add this to your <code>.mcp.json</code>:
              </Typography>
              <CodeBlock text={MCP_JSON_SNIPPET} />
            </SetupStep>
            <SetupStep n={3} title="Restart Claude, then turn the AI Bridge on (toggle above)">
              <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.65)' }}>
                Restart Claude Desktop / Claude Code so it launches the bridge.
              </Typography>
            </SetupStep>
          </Box>
        </SettingsSection>
      )}

      {/* Tool list */}
      {mcp.toolNames.length > 0 && (
        <SettingsSection id="mcp-tools" title={`Registered Tools (${mcp.toolNames.length})`}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, pl: 1 }}>
            {mcp.toolNames.map(name => (
              <Typography key={name} variant="caption"
                sx={{ fontFamily: 'monospace', fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>
                {name}
              </Typography>
            ))}
          </Box>
        </SettingsSection>
      )}

      {/* Server log — streamed from the bridge server over the WebSocket. */}
      {log.length > 0 && (
        <SettingsSection id="mcp-server-log" title={`Server Log (${log.length})`}>
          <Box sx={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 0.1, pl: 0.5 }}>
            {log.slice(-100).map((line, i) => (
              <Typography key={i} variant="caption"
                sx={{ fontFamily: 'monospace', fontSize: 10.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  color: line.level === 'error' ? '#ef5350' : line.level === 'warn' ? '#ffa726' : 'rgba(255,255,255,0.6)' }}>
                {line.msg}
              </Typography>
            ))}
          </Box>
        </SettingsSection>
      )}
    </Box>
  );
}
