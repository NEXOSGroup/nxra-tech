// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ConnectPanel — LeftPanel for realvirtual CONNECT gateway configuration.
 *
 * Sections:
 *   1. Server URL input + Connect/Disconnect + status indicator
 *   2. Interface list (accordion per interface, online/offline, signal count)
 *   3. Add Interface dialog
 *   4. Signal Browser table (discovery results with checkboxes)
 *   5. Bind Selected action
 */

import { useState, useSyncExternalStore, useCallback, useRef, useMemo, useEffect } from 'react';
import {
  Box,
  Typography,
  IconButton,
  Button,
  TextField,
  Divider,
  Chip,
  Checkbox,
  Collapse,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  MenuItem,
  Menu,
  Select,
  FormControl,
  InputLabel,
  CircularProgress,
  InputAdornment,
  Tooltip,
} from '@mui/material';
import {
  Cable,
  Delete,
  Edit,
  ExpandMore,
  ExpandLess,
  Search,
  Add,
  Check,
  Close,
  Circle,
  SelectAll,
  Deselect,
  Upload,
  Visibility,
  Article,
  PlayArrow,
  Pause,
  ClearAll,
} from '@mui/icons-material';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useViewer } from '../../hooks/use-viewer';
import { LeftPanel } from './LeftPanel';
import { ChartPanel } from './ChartPanel';
import { CONNECT_PANEL_WIDTH } from './layout-constants';
import { RV_SCROLL_CLASS } from './shared-sx';
import {
  subscribeConnectStore,
  getConnectSnapshot,
  setServerUrl,
  connectToServer,
  disconnectFromServer,
  setActiveInterface,
  startDiscovery,
  updateInterface,
  toggleSignalSelection,
  selectAllSignals,
  bindSelectedSignals,
  removeInterface,
  addInterface,
  importTagTable,
  fetchLogs,
  fetchStatus,
  type ConnectInterface,
  type ConnectInterfaceSignal,
  type ConnectLogEntry,
  type ConnectState,
} from './connect-store';
import { parseTagTable, type ParsedTagTable } from '../import/s7-tag-table';
import { ISA_GREEN, ISA_RED, ISA_AMBER, connectionStateColor } from './isa-colors';
import { SignalBadge } from './rv-signal-badge';

// ── Signal-count helper (counts ProcessImage topic signals + legacy signals) ──

function interfaceSignalCount(iface: ConnectInterface): number {
  const topicCount = (iface.topics ?? []).reduce((sum, t) => sum + (t.signals?.length ?? 0), 0);
  return topicCount + (iface.signals?.length ?? 0);
}

/** Flatten all signals (topic + legacy) for an interface. */
function interfaceSignals(iface: ConnectInterface): ConnectInterfaceSignal[] {
  const topicSignals = (iface.topics ?? []).flatMap(t => t.signals ?? []);
  return [...topicSignals, ...(iface.signals ?? [])];
}

// ── Status helpers ─────────────────────────────────────────────────────

function statusColor(state: ConnectState): string {
  return connectionStateColor(state) ?? '#757575';
}

function statusLabel(state: ConnectState): string {
  switch (state) {
    case 'connected': return 'Connected';
    case 'connecting': return 'Connecting...';
    case 'error': return 'Error';
    default: return 'Disconnected';
  }
}

/** Dot color for a per-interface worker status (green = Connected, red = Error, amber = (re)connecting). */
function interfaceDotColor(status: string | undefined, enabled: boolean): string {
  if (!enabled) return '#757575';
  switch (status) {
    case 'Connected': return ISA_GREEN;
    case 'Error': return ISA_RED;
    case 'Connecting':
    case 'Reconnecting': return ISA_AMBER;
    default: return '#757575'; // Stopped / not yet known
  }
}

// ── ConnectPanel ───────────────────────────────────────────────────────

export function ConnectPanel() {
  const viewer = useViewer();
  const lpm = viewer.leftPanelManager;
  const panelSnap = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  const snap = useSyncExternalStore(subscribeConnectStore, getConnectSnapshot);
  const [urlInput, setUrlInput] = useState(snap.serverUrl);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editIface, setEditIface] = useState<ConnectInterface | null>(null);
  const [expandedIface, setExpandedIface] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importTarget, setImportTarget] = useState<string | null>(null);
  const [signalsViewId, setSignalsViewId] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  const isOpen = panelSnap.activePanel === 'connect';

  const handleClose = useCallback(() => {
    lpm.close('connect');
  }, [lpm]);

  const handleConnect = useCallback(async () => {
    setServerUrl(urlInput);
    await connectToServer();
  }, [urlInput]);

  const handleDisconnect = useCallback(() => {
    disconnectFromServer();
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      setServerUrl(urlInput);
      connectToServer();
    }
  }, [urlInput]);

  const handleBrowse = useCallback(async (ifaceId: string) => {
    setActiveInterface(ifaceId);
    await startDiscovery(ifaceId);
  }, []);

  const handleRemoveInterface = useCallback(async (id: string) => {
    await removeInterface(id);
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIface(prev => prev === id ? null : id);
  }, []);

  const handleViewSignals = useCallback((id: string) => {
    setSignalsViewId(prev => (prev === id ? null : id));
  }, []);

  const handleOpenImport = useCallback((targetId: string | null) => {
    setImportTarget(targetId);
    setImportOpen(true);
  }, []);

  // Poll per-interface worker status while connected — drives the green/red status dots.
  useEffect(() => {
    if (snap.state !== 'connected') return;
    fetchStatus();
    const id = setInterval(fetchStatus, 2000);
    return () => clearInterval(id);
  }, [snap.state]);

  if (!isOpen) return null;

  const isConnected = snap.state === 'connected';

  return (
    <LeftPanel
      title={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Cable sx={{ fontSize: 16, color: 'primary.main' }} />
          <Typography variant="subtitle2" sx={{ fontSize: '0.8rem', fontWeight: 600, color: 'text.primary' }}>
            realvirtual CONNECT
          </Typography>
          <Circle sx={{ fontSize: 6, color: statusColor(snap.state), ml: 0.5 }} />
        </Box>
      }
      onClose={handleClose}
      width={CONNECT_PANEL_WIDTH}
      footer={isConnected ? (
        <Button
          size="small"
          fullWidth
          variant="text"
          startIcon={<Article sx={{ fontSize: 14 }} />}
          onClick={() => setLogOpen(true)}
          sx={{ fontSize: 10, textTransform: 'none', py: 0.5, color: 'text.secondary' }}
        >
          Log
        </Button>
      ) : undefined}
    >
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* ── Section 1: Server URL + Connect ── */}
        <Box sx={{ p: 1, flexShrink: 0 }}>
          <Typography sx={{ fontSize: 10, color: 'text.secondary', mb: 0.5 }}>
            CONNECT Server
          </Typography>
          <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
            <TextField
              size="small"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="http://localhost:5100"
              sx={{
                flex: 1,
                '& .MuiInputBase-input': { fontSize: 11, py: 0.5, px: 1 },
              }}
            />
            {isConnected ? (
              <Button
                size="small"
                variant="outlined"
                color="error"
                onClick={handleDisconnect}
                sx={{ fontSize: 10, textTransform: 'none', minWidth: 80 }}
              >
                Disconnect
              </Button>
            ) : (
              <Button
                size="small"
                variant="contained"
                onClick={handleConnect}
                disabled={snap.state === 'connecting'}
                sx={{ fontSize: 10, textTransform: 'none', minWidth: 80 }}
              >
                {snap.state === 'connecting' ? 'Connecting...' : 'Connect'}
              </Button>
            )}
          </Box>
          {/* Status line */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
            <Circle sx={{ fontSize: 6, color: statusColor(snap.state) }} />
            <Typography sx={{ fontSize: 10, color: statusColor(snap.state) }}>
              {statusLabel(snap.state)}
            </Typography>
            {snap.errorMessage && (
              <Typography sx={{ fontSize: 9, color: ISA_RED, ml: 0.5 }}>
                {snap.errorMessage}
              </Typography>
            )}
          </Box>
          {/* Server version info — "CONNECT vX.Y.Z (build N) · YYYY-MM-DD"; build/date shown when present */}
          {isConnected && snap.serverVersion && (
            <Typography sx={{ fontSize: 9, color: 'text.disabled', mt: 0.25 }}>
              CONNECT v{snap.serverVersion}
              {snap.serverBuild && ` (build ${snap.serverBuild})`}
              {snap.serverBuildDate && ` · ${snap.serverBuildDate}`}
            </Typography>
          )}
        </Box>

        <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />

        {/* ── Section 2: Interface List ── */}
        {isConnected && (
          <Box sx={{ p: 1, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5, flexShrink: 0 }}>
              <Typography sx={{ fontSize: 10, color: 'text.secondary', flex: 1 }}>
                Interfaces ({snap.interfaces.length})
              </Typography>
              <Button
                size="small"
                startIcon={<Upload sx={{ fontSize: 12 }} />}
                onClick={() => handleOpenImport(null)}
                sx={{ fontSize: 10, textTransform: 'none', minWidth: 0, mr: 0.5 }}
              >
                Import
              </Button>
              <Button
                size="small"
                startIcon={<Add sx={{ fontSize: 12 }} />}
                onClick={() => setAddDialogOpen(true)}
                sx={{ fontSize: 10, textTransform: 'none', minWidth: 0 }}
              >
                Add
              </Button>
            </Box>

            {snap.interfaces.length === 0 && (
              <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', textAlign: 'center', py: 2 }}>
                No interfaces configured.
              </Typography>
            )}

            <Box
              className={RV_SCROLL_CLASS}
              sx={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}
            >
              {snap.interfaces.map((iface) => {
                const showSignals = signalsViewId === iface.id;
                return (
                  <Box
                    key={iface.id}
                    sx={showSignals
                      ? { flex: 1, minHeight: 140, display: 'flex', flexDirection: 'column' }
                      : { flexShrink: 0 }}
                  >
                    <Box sx={{ flexShrink: 0 }}>
                      <InterfaceCard
                        iface={iface}
                        status={snap.interfaceStatus[iface.id]?.status}
                        statusError={snap.interfaceStatus[iface.id]?.error}
                        expanded={expandedIface === iface.id}
                        onToggle={() => toggleExpand(iface.id)}
                        onBrowse={() => handleBrowse(iface.id)}
                        onViewSignals={() => handleViewSignals(iface.id)}
                        onImport={() => handleOpenImport(iface.id)}
                        onEdit={() => setEditIface(iface)}
                        onDelete={() => handleRemoveInterface(iface.id)}
                      />
                    </Box>
                    {/* View Signals — inline tree that grows to fill remaining space */}
                    {showSignals && <SignalListView iface={iface} />}
                  </Box>
                );
              })}
            </Box>
          </Box>
        )}

      </Box>

      {/* ── Add Interface Dialog ── */}
      <AddInterfaceDialog
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
      />

      {/* ── Edit Interface Dialog ── */}
      {editIface && (
        <EditInterfaceDialog
          iface={editIface}
          open={!!editIface}
          onClose={() => setEditIface(null)}
        />
      )}

      {/* ── Import S7 Tag Table Dialog ── */}
      <ImportTagTableDialog
        open={importOpen}
        interfaces={snap.interfaces}
        initialTargetId={importTarget}
        onClose={() => setImportOpen(false)}
      />

      {/* ── Log Window ── */}
      <ConnectLogDialog open={logOpen} onClose={() => setLogOpen(false)} />

      {/* ── Browse Window (discovery + add to signals) ── */}
      <BrowseWindow open={!!snap.activeInterfaceId} onClose={() => setActiveInterface(null)} />
    </LeftPanel>
  );
}

// ── InterfaceCard ──────────────────────────────────────────────────────

function InterfaceCard({
  iface,
  status,
  statusError,
  expanded,
  onToggle,
  onBrowse,
  onViewSignals,
  onImport,
  onEdit,
  onDelete,
}: {
  iface: ConnectInterface;
  status?: string;
  statusError?: string;
  expanded: boolean;
  onToggle: () => void;
  onBrowse: () => void;
  onViewSignals: () => void;
  onImport: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  // Count ProcessImage topic signals + legacy signals (R19 — otherwise always 0 for ProcessImage).
  const signalCount = interfaceSignalCount(iface);

  // Extract display info based on interface type
  const getEndpointLabel = (): string => {
    if (iface.type === 'OpcUa') return (iface.endpoint as string) ?? '';
    if (iface.type === 'S7') return `${iface.ipAddress ?? ''} R:${iface.rack ?? 0} S:${iface.slot ?? 1}`;
    if (iface.type === 'MQTT') return (iface.brokerUrl as string) ?? '';
    return iface.id;
  };

  return (
    <Box sx={{ mb: 0.5, borderRadius: 1, bgcolor: 'rgba(255,255,255,0.03)', overflow: 'hidden' }}>
      {/* Header */}
      <Box
        onClick={onToggle}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1,
          py: 0.5,
          cursor: 'pointer',
          '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
        }}
      >
        {expanded ? <ExpandLess sx={{ fontSize: 14 }} /> : <ExpandMore sx={{ fontSize: 14 }} />}
        <Tooltip title={`${status ?? (iface.enabled ? 'Unknown' : 'Disabled')}${statusError ? ` — ${statusError}` : ''}`}>
          <Circle sx={{ fontSize: 6, color: interfaceDotColor(status, iface.enabled) }} />
        </Tooltip>
        <Typography sx={{ fontSize: 11, fontWeight: 600, color: 'text.primary', flex: 1 }}>
          {iface.type}
        </Typography>
        <Typography sx={{ fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>
          {signalCount} signals
        </Typography>
      </Box>

      {/* Expanded content */}
      <Collapse in={expanded}>
        <Box sx={{ px: 1, pb: 0.75 }}>
          <Typography sx={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', fontFamily: 'monospace', mb: 0.5 }}>
            {getEndpointLabel()}
          </Typography>
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
            {(iface.type === 'OpcUa' || iface.type === 'MQTT') && (
              <Button
                size="small"
                startIcon={<Search sx={{ fontSize: 12 }} />}
                onClick={(e) => { e.stopPropagation(); onBrowse(); }}
                sx={{ fontSize: 9, textTransform: 'none', minWidth: 0 }}
              >
                Browse
              </Button>
            )}
            {signalCount > 0 && (
              <Button
                size="small"
                startIcon={<Visibility sx={{ fontSize: 12 }} />}
                onClick={(e) => { e.stopPropagation(); onViewSignals(); }}
                sx={{ fontSize: 9, textTransform: 'none', minWidth: 0 }}
              >
                View Signals
              </Button>
            )}
            {iface.type === 'MQTT' && (
              <Button
                size="small"
                startIcon={<Upload sx={{ fontSize: 12 }} />}
                onClick={(e) => { e.stopPropagation(); onImport(); }}
                sx={{ fontSize: 9, textTransform: 'none', minWidth: 0 }}
              >
                Import
              </Button>
            )}
            <Button
              size="small"
              startIcon={<Edit sx={{ fontSize: 12 }} />}
              onClick={(e) => { e.stopPropagation(); onEdit(); }}
              sx={{ fontSize: 9, textTransform: 'none', minWidth: 0 }}
            >
              Edit
            </Button>
            <Box sx={{ flex: 1 }} />
            <IconButton
              size="small"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              sx={{ p: 0.25, color: 'rgba(255,255,255,0.3)', '&:hover': { color: ISA_RED } }}
            >
              <Delete sx={{ fontSize: 14 }} />
            </IconButton>
          </Box>
        </Box>
      </Collapse>
    </Box>
  );
}

// ── Add Interface Dialog ──────────────────────────────────────────────

function AddInterfaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [type, setType] = useState<'OpcUa' | 'S7' | 'MQTT'>('OpcUa');
  const [endpoint, setEndpoint] = useState('opc.tcp://localhost:4840');
  const [ipAddress, setIpAddress] = useState('192.168.1.50');
  const [rack, setRack] = useState('0');
  const [slot, setSlot] = useState('1');
  const [brokerUrl, setBrokerUrl] = useState('mqtt://localhost:1883');
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const base = { type, enabled: true };
      if (type === 'OpcUa') {
        await addInterface({ ...base, endpoint } as Omit<ConnectInterface, 'id' | 'signals'>);
      } else if (type === 'S7') {
        await addInterface({ ...base, ipAddress, rack: parseInt(rack, 10), slot: parseInt(slot, 10) } as Omit<ConnectInterface, 'id' | 'signals'>);
      } else if (type === 'MQTT') {
        await addInterface({ ...base, brokerUrl } as Omit<ConnectInterface, 'id' | 'signals'>);
      }
      onClose();
    } catch {
      // Error already logged in store
    }
    setSaving(false);
  }, [type, endpoint, ipAddress, rack, slot, brokerUrl, onClose]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 14 }}>
        <Add sx={{ color: 'primary.main' }} />
        Add Interface
      </DialogTitle>
      <DialogContent>
        <FormControl fullWidth size="small" sx={{ mt: 1, mb: 1.5 }}>
          <InputLabel id="iface-type-label">Type</InputLabel>
          <Select
            labelId="iface-type-label"
            value={type}
            label="Type"
            onChange={(e) => setType(e.target.value as 'OpcUa' | 'S7' | 'MQTT')}
          >
            <MenuItem value="OpcUa">OPC-UA</MenuItem>
            <MenuItem value="S7">S7 TCP/IP</MenuItem>
            <MenuItem value="MQTT">MQTT</MenuItem>
          </Select>
        </FormControl>

        {type === 'OpcUa' && (
          <TextField
            fullWidth
            size="small"
            label="Endpoint URL"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="opc.tcp://192.168.1.100:4840"
            sx={{ mb: 1 }}
          />
        )}

        {type === 'S7' && (
          <>
            <TextField
              fullWidth
              size="small"
              label="IP Address"
              value={ipAddress}
              onChange={(e) => setIpAddress(e.target.value)}
              placeholder="192.168.1.50"
              sx={{ mb: 1 }}
            />
            <Box sx={{ display: 'flex', gap: 1 }}>
              <TextField
                size="small"
                label="Rack"
                value={rack}
                onChange={(e) => setRack(e.target.value)}
                sx={{ flex: 1 }}
              />
              <TextField
                size="small"
                label="Slot"
                value={slot}
                onChange={(e) => setSlot(e.target.value)}
                sx={{ flex: 1 }}
              />
            </Box>
          </>
        )}

        {type === 'MQTT' && (
          <TextField
            fullWidth
            size="small"
            label="Broker URL"
            value={brokerUrl}
            onChange={(e) => setBrokerUrl(e.target.value)}
            placeholder="mqtt://localhost:1883"
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} sx={{ textTransform: 'none' }}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={saving}
          sx={{ textTransform: 'none' }}
        >
          {saving ? 'Adding...' : 'Add'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ── Edit Interface Dialog ────────────────────────────────────────────

function EditInterfaceDialog({ iface, open, onClose }: { iface: ConnectInterface; open: boolean; onClose: () => void }) {
  const [endpoint, setEndpoint] = useState((iface.endpoint as string) ?? 'opc.tcp://localhost:4840');
  const [ipAddress, setIpAddress] = useState((iface.ipAddress as string) ?? '192.168.1.50');
  const [rack, setRack] = useState(String(iface.rack ?? 0));
  const [slot, setSlot] = useState(String(iface.slot ?? 1));
  const [brokerUrl, setBrokerUrl] = useState((iface.brokerUrl as string) ?? 'mqtt://localhost:1883');
  const [enabled, setEnabled] = useState(iface.enabled);
  const [updateCycleMs, setUpdateCycleMs] = useState(String(iface.updateCycleMs ?? 50));
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const updates: Partial<ConnectInterface> = { enabled, updateCycleMs: parseInt(updateCycleMs, 10) || 50 };
      if (iface.type === 'OpcUa') updates.endpoint = endpoint;
      else if (iface.type === 'S7') { updates.ipAddress = ipAddress; updates.rack = parseInt(rack, 10); updates.slot = parseInt(slot, 10); }
      else if (iface.type === 'MQTT') updates.brokerUrl = brokerUrl;
      await updateInterface(iface.id, updates);
      onClose();
    } catch { /* logged in store */ }
    setSaving(false);
  }, [iface, endpoint, ipAddress, rack, slot, brokerUrl, enabled, updateCycleMs, onClose]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 14 }}>
        <Edit sx={{ color: 'primary.main' }} />
        Edit {iface.type} Interface
      </DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1, mb: 1.5 }}>
          <Checkbox checked={enabled} onChange={(e) => setEnabled(e.target.checked)} size="small" />
          <Typography sx={{ fontSize: 13 }}>Enabled</Typography>
        </Box>

        {iface.type === 'OpcUa' && (
          <TextField fullWidth size="small" label="Endpoint URL" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} sx={{ mb: 1 }} />
        )}

        {iface.type === 'S7' && (
          <>
            <TextField fullWidth size="small" label="IP Address" value={ipAddress} onChange={(e) => setIpAddress(e.target.value)} sx={{ mb: 1 }} />
            <Box sx={{ display: 'flex', gap: 1 }}>
              <TextField size="small" label="Rack" value={rack} onChange={(e) => setRack(e.target.value)} sx={{ flex: 1 }} />
              <TextField size="small" label="Slot" value={slot} onChange={(e) => setSlot(e.target.value)} sx={{ flex: 1 }} />
            </Box>
          </>
        )}

        {iface.type === 'MQTT' && (
          <TextField fullWidth size="small" label="Broker URL" value={brokerUrl} onChange={(e) => setBrokerUrl(e.target.value)} sx={{ mb: 1 }} />
        )}

        <TextField fullWidth size="small" label="Update Cycle (ms)" value={updateCycleMs} onChange={(e) => setUpdateCycleMs(e.target.value)} sx={{ mt: 1 }} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} sx={{ textTransform: 'none' }}>Cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={saving} sx={{ textTransform: 'none' }}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ── Signal List View (tree: Interface > Topic > Signals, shared SignalBadge chips) ──

const SIGNAL_ROW_HEIGHT = 34;
const GROUP_ROW_HEIGHT = 24;

type SignalListRow =
  | { kind: 'group'; topic: string; total: number }
  | { kind: 'signal'; sig: ConnectInterfaceSignal };

/**
 * Searchable, virtualized signal view grouped as Interface > Topic > Signals (topic-bundled MQTT
 * ProcessImage) or Interface > Signals (flat, other protocols). Each signal renders with the shared
 * SignalBadge chip; live values stream in from the viewer SignalStore.
 */
function SignalListView({ iface }: { iface: ConnectInterface }) {
  const viewer = useViewer();
  const signalStore = viewer.signalStore ?? null;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Bump counter re-renders the list when any subscribed signal changes.
  const [, setTick] = useState(0);

  const allSignals = useMemo(() => interfaceSignals(iface), [iface]);
  const hasTopics = (iface.topics?.length ?? 0) > 0;

  const toggleGroup = useCallback((topic: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(topic)) next.delete(topic); else next.add(topic);
      return next;
    });
  }, []);

  const rows = useMemo<SignalListRow[]>(() => {
    const q = filter.trim().toLowerCase();
    const match = (s: ConnectInterfaceSignal) =>
      !q || s.name.toLowerCase().includes(q) || s.protocolAddress.toLowerCase().includes(q);

    const out: SignalListRow[] = [];
    for (const t of iface.topics ?? []) {
      const sigs = (t.signals ?? []).filter(match);
      if (q && sigs.length === 0) continue;       // hide empty groups while filtering
      out.push({ kind: 'group', topic: t.topic, total: t.signals?.length ?? 0 });
      const open = q.length > 0 || !collapsed.has(t.topic);  // a filter expands all groups
      if (open) for (const s of sigs) out.push({ kind: 'signal', sig: s });
    }
    // Flat (non-topic) signals: Interface > Signals
    for (const s of (iface.signals ?? []).filter(match)) out.push({ kind: 'signal', sig: s });
    return out;
  }, [iface, filter, collapsed]);

  // Subscribe to live value changes for every signal in this interface.
  useEffect(() => {
    if (!signalStore) return;
    const unsubs: Array<() => void> = [];
    for (const s of allSignals) {
      unsubs.push(signalStore.subscribe(s.name, () => setTick(t => t + 1)));
    }
    return () => { for (const u of unsubs) u(); };
  }, [signalStore, allSignals]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i].kind === 'group' ? GROUP_ROW_HEIGHT : SIGNAL_ROW_HEIGHT),
    overscan: 12,
  });

  return (
    <Box sx={{ px: 1, pb: 1, flex: 1, minHeight: 120, display: 'flex', flexDirection: 'column' }}>
      <TextField
        size="small"
        fullWidth
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter signals..."
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <Search sx={{ fontSize: 14, color: 'rgba(255,255,255,0.4)' }} />
            </InputAdornment>
          ),
        }}
        sx={{ mb: 0.5, flexShrink: 0, '& .MuiInputBase-input': { fontSize: 11, py: 0.5 } }}
      />

      <Box
        ref={scrollRef}
        className={RV_SCROLL_CLASS}
        sx={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' }}
      >
        {rows.length === 0 ? (
          <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', textAlign: 'center', py: 2 }}>
            No matching signals.
          </Typography>
        ) : (
          <Box sx={{ height: rowVirtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
            {rowVirtualizer.getVirtualItems().map((vRow) => {
              const row = rows[vRow.index];
              const base = {
                position: 'absolute' as const,
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vRow.start}px)`,
                display: 'flex',
                alignItems: 'center',
              };

              if (row.kind === 'group') {
                const open = filter.trim().length > 0 || !collapsed.has(row.topic);
                return (
                  <Box
                    key={`g:${row.topic}`}
                    onClick={() => toggleGroup(row.topic)}
                    sx={{ ...base, height: GROUP_ROW_HEIGHT, gap: 0.25, px: 0.25, cursor: 'pointer', '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' } }}
                  >
                    {open ? <ExpandLess sx={{ fontSize: 13 }} /> : <ExpandMore sx={{ fontSize: 13 }} />}
                    <Typography sx={{ fontSize: 9, color: 'rgba(255,255,255,0.6)', fontFamily: 'monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.topic}
                    </Typography>
                    <Typography sx={{ fontSize: 9, color: 'rgba(255,255,255,0.35)' }}>{row.total}</Typography>
                  </Box>
                );
              }

              const sig = row.sig;
              const raw = signalStore?.get(sig.name) as boolean | number | undefined;
              const plcType = sig.type;
              const direction: 'input' | 'output' = plcType.startsWith('PLCOutput') ? 'output' : 'input';
              return (
                <Box
                  key={`s:${sig.name}`}
                  sx={{ ...base, height: SIGNAL_ROW_HEIGHT, gap: 0.5, pr: 0.5, pl: hasTopics ? 1.5 : 0.5, '&:hover': { bgcolor: 'rgba(79,195,247,0.06)' } }}
                >
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {sig.name}
                    </Typography>
                    <Typography sx={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace' }}>
                      {sig.protocolAddress}{sig.dataType ? ` · ${sig.dataType}` : ''}
                    </Typography>
                  </Box>
                  <SignalBadge direction={direction} plcType={plcType} raw={raw} />
                </Box>
              );
            })}
          </Box>
        )}
      </Box>
    </Box>
  );
}

// ── Browse Window (discovery results + add to interface signals) ──────────

/** Floating window showing discovery results; selected signals can be added to the interface. */
function BrowseWindow({ open, onClose }: { open: boolean; onClose: () => void }) {
  const snap = useSyncExternalStore(subscribeConnectStore, getConnectSnapshot);
  const iface = snap.interfaces.find(i => i.id === snap.activeInterfaceId) ?? null;
  const selectedCount = snap.discoveredSignals.filter(s => s.selected).length;

  const handleAdd = useCallback(async () => {
    if (!snap.activeInterfaceId || selectedCount === 0) return;
    await bindSelectedSignals(snap.activeInterfaceId);
    onClose();
  }, [snap.activeInterfaceId, selectedCount, onClose]);

  return (
    <ChartPanel
      open={open}
      onClose={onClose}
      title={`Browse${iface ? ` — ${iface.type}` : ''}`}
      panelId="connect-browse"
      defaultWidth={440}
      defaultHeight={460}
    >
      <Box sx={{ p: 1, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {snap.discoveryLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={20} />
          </Box>
        )}

        {!snap.discoveryLoading && snap.discoveredSignals.length === 0 && (
          <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', textAlign: 'center', py: 2 }}>
            No signals discovered.
          </Typography>
        )}

        {!snap.discoveryLoading && snap.discoveredSignals.length > 0 && (
          <>
            <Box sx={{ display: 'flex', gap: 0.5, mb: 0.5, flexShrink: 0 }}>
              <Button size="small" startIcon={<SelectAll sx={{ fontSize: 12 }} />} onClick={() => selectAllSignals(true)} sx={{ fontSize: 9, textTransform: 'none', minWidth: 0 }}>All</Button>
              <Button size="small" startIcon={<Deselect sx={{ fontSize: 12 }} />} onClick={() => selectAllSignals(false)} sx={{ fontSize: 9, textTransform: 'none', minWidth: 0 }}>None</Button>
            </Box>

            <Box className={RV_SCROLL_CLASS} sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              {snap.discoveredSignals.map((sig) => (
                <Box key={sig.protocolAddress} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, py: 0.25, '&:hover': { bgcolor: 'rgba(79,195,247,0.06)' } }}>
                  <Checkbox size="small" checked={sig.selected ?? false} onChange={() => toggleSignalSelection(sig.protocolAddress)} sx={{ p: 0.25, '& .MuiSvgIcon-root': { fontSize: 14 } }} />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sig.displayName}</Typography>
                    <Typography sx={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace' }}>{sig.protocolAddress}</Typography>
                  </Box>
                  <Chip label={sig.dataType} size="small" sx={{ fontSize: 9, height: 16, '& .MuiChip-label': { px: 0.5 } }} />
                  <Chip label={sig.direction} size="small" color={sig.direction === 'input' ? 'info' : sig.direction === 'output' ? 'success' : 'default'} sx={{ fontSize: 9, height: 16, '& .MuiChip-label': { px: 0.5 } }} />
                </Box>
              ))}
            </Box>

            <Button variant="contained" size="small" startIcon={<Add sx={{ fontSize: 14 }} />} onClick={handleAdd} disabled={selectedCount === 0} sx={{ mt: 1, flexShrink: 0, fontSize: 10, textTransform: 'none', width: '100%' }}>
              Add to signals ({selectedCount})
            </Button>
          </>
        )}
      </Box>
    </ChartPanel>
  );
}

// ── Connect Log Window (polls /logs, level filter, auto-scroll) ───────────

const LOG_POLL_MS = 1000;
const LOG_MAX_ROWS = 2000;

/** Color a log line by its level — matches the ISA status palette used elsewhere. */
function logLevelColor(level: string): string {
  const l = level.toLowerCase();
  if (l === 'error' || l === 'critical') return ISA_RED;
  if (l === 'warning' || l === 'warn') return ISA_AMBER;
  if (l === 'information' || l === 'info') return '#4fc3f7';
  return 'rgba(255,255,255,0.45)';
}

/** Short HH:MM:SS from an ISO timestamp (gateway logs are UTC ISO strings). */
function logTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

/**
 * Log window. Opens as a modal dialog and tails CONNECT's /logs endpoint incrementally
 * (via the `latest` sequence number) with level filtering, pause, clear, and auto-scroll.
 */
function ConnectLogDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [entries, setEntries] = useState<ConnectLogEntry[]>([]);
  const [level, setLevel] = useState<string>('');
  const [paused, setPaused] = useState(false);
  const sinceRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);

  // Re-query from scratch when the window (re)opens or the level filter changes.
  useEffect(() => {
    if (!open) return;
    sinceRef.current = 0;
    setEntries([]);
  }, [open, level]);

  useEffect(() => {
    if (!open || paused) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const { latest, entries: fresh } = await fetchLogs(sinceRef.current, 500, level || undefined);
        if (cancelled) return;
        const wasInitial = sinceRef.current === 0;
        sinceRef.current = latest;
        if (fresh.length === 0) return;
        setEntries(prev => {
          const merged = wasInitial ? fresh : [...prev, ...fresh];
          return merged.length > LOG_MAX_ROWS ? merged.slice(merged.length - LOG_MAX_ROWS) : merged;
        });
      } catch {
        // Gateway unreachable — keep the last entries, retry on next tick.
      }
    };
    poll();
    const id = setInterval(poll, LOG_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [open, paused, level]);

  // Auto-scroll to the newest line unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  // Controls live in the ChartPanel title bar; stop mousedown so using them never drags the window.
  const toolbar = (
    <Box onMouseDown={(e) => e.stopPropagation()} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      <FormControl size="small" variant="standard" sx={{ minWidth: 72 }}>
        <Select
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          disableUnderline
          sx={{ fontSize: 11 }}
        >
          <MenuItem value="" sx={{ fontSize: 12 }}>All</MenuItem>
          <MenuItem value="Information" sx={{ fontSize: 12 }}>Info+</MenuItem>
          <MenuItem value="Warning" sx={{ fontSize: 12 }}>Warn+</MenuItem>
          <MenuItem value="Error" sx={{ fontSize: 12 }}>Error</MenuItem>
        </Select>
      </FormControl>
      <Tooltip title={paused ? 'Resume' : 'Pause'}>
        <IconButton size="small" onClick={() => setPaused(p => !p)} sx={{ p: 0.3 }}>
          {paused ? <PlayArrow sx={{ fontSize: 16 }} /> : <Pause sx={{ fontSize: 16 }} />}
        </IconButton>
      </Tooltip>
      <Tooltip title="Clear view">
        <IconButton size="small" onClick={() => setEntries([])} sx={{ p: 0.3 }}>
          <ClearAll sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
    </Box>
  );

  return (
    <ChartPanel
      open={open}
      onClose={onClose}
      title="Log"
      panelId="connect-log"
      defaultWidth={640}
      defaultHeight={360}
      toolbar={toolbar}
    >
      <Box
        ref={scrollRef}
        onScroll={handleScroll}
        className={RV_SCROLL_CLASS}
        sx={{ flex: 1, minHeight: 0, overflow: 'auto', bgcolor: 'rgba(0,0,0,0.3)', p: 1, fontFamily: 'monospace' }}
      >
          {entries.length === 0 ? (
            <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', textAlign: 'center', py: 3 }}>
              {paused ? 'Paused.' : 'No log entries.'}
            </Typography>
          ) : (
            entries.map((e) => (
              <Box key={e.seq} sx={{ display: 'flex', gap: 0.75, alignItems: 'baseline', py: 0.1 }}>
                <Typography component="span" sx={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', fontFamily: 'monospace', flexShrink: 0 }}>
                  {logTime(e.time)}
                </Typography>
                <Typography component="span" sx={{ fontSize: 10, fontWeight: 600, color: logLevelColor(e.level), fontFamily: 'monospace', flexShrink: 0, minWidth: 34 }}>
                  {e.level.slice(0, 4).toUpperCase()}
                </Typography>
                <Typography component="span" sx={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace', flexShrink: 0 }}>
                  {e.category}
                </Typography>
                <Typography component="span" sx={{ fontSize: 10, color: 'rgba(255,255,255,0.85)', fontFamily: 'monospace', wordBreak: 'break-word' }}>
                  {e.message}
                </Typography>
              </Box>
            ))
          )}
      </Box>
    </ChartPanel>
  );
}

// ── Import S7 Tag Table Dialog ────────────────────────────────────────────

function ImportTagTableDialog({
  open,
  interfaces,
  initialTargetId,
  onClose,
}: {
  open: boolean;
  interfaces: ConnectInterface[];
  initialTargetId: string | null;
  onClose: () => void;
}) {
  const mqttInterfaces = useMemo(() => interfaces.filter(i => i.type === 'MQTT'), [interfaces]);

  const [target, setTarget] = useState<string>(initialTargetId ?? '__new__');
  const [brokerUrl, setBrokerUrl] = useState('mqtt://localhost:1883');
  const [topic, setTopic] = useState('rv/plc/process-image/raw');
  const [parsed, setParsed] = useState<ParsedTagTable | null>(null);
  const [fileName, setFileName] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);

  // Topic browse: discover topics on the broker and pick one instead of typing.
  const snap = useSyncExternalStore(subscribeConnectStore, getConnectSnapshot);
  const [topicMenuAnchor, setTopicMenuAnchor] = useState<HTMLElement | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const discoveredTopics = useMemo(
    () => [...new Set(snap.discoveredSignals.map(s => s.browsePath || s.displayName).filter(Boolean))],
    [snap.discoveredSignals],
  );
  const handleBrowseTopics = useCallback(async (anchor: HTMLElement) => {
    if (target === '__new__') return; // discovery needs a running worker on an existing interface
    setBrowsing(true);
    try { await startDiscovery(target); } finally { setBrowsing(false); }
    setTopicMenuAnchor(anchor);
  }, [target]);

  // Sync state when the dialog opens with a (possibly different) target.
  useEffect(() => {
    if (!open) return;
    const tgt = initialTargetId ?? '__new__';
    setTarget(tgt);
    setParsed(null);
    setFileName('');
    setParseError(null);
    const existing = interfaces.find(i => i.id === initialTargetId);
    if (existing) {
      setBrokerUrl((existing.brokerUrl as string) ?? 'mqtt://localhost:1883');
    }
  }, [open, initialTargetId, interfaces]);

  const handlePickFile = useCallback(() => {
    setParseError(null);
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.csv';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setFileName(file.name);
      try {
        const result = await parseTagTable(file);
        setParsed(result);
        setParseError(null);
      } catch (err) {
        setParsed(null);
        setParseError(err instanceof Error ? err.message : 'Import failed.');
      }
    };
    input.click();
  }, []);

  const handlePush = useCallback(async () => {
    if (!parsed || parsed.tags.length === 0) return;
    setPushing(true);
    try {
      await importTagTable({
        tags: parsed.tags,
        brokerUrl,
        topic,
        targetInterfaceId: target === '__new__' ? null : target,
      });
      onClose();
    } catch {
      // Error already logged in store
    }
    setPushing(false);
  }, [parsed, brokerUrl, topic, target, onClose]);

  const canPush = !!parsed && parsed.tags.length > 0 && topic.trim().length > 0 && !pushing;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 14 }}>
        <Upload sx={{ color: 'primary.main' }} />
        Import S7 Tag Table → Topic
      </DialogTitle>
      <DialogContent>
        {/* Target: New vs existing interface */}
        <FormControl fullWidth size="small" sx={{ mt: 1, mb: 1.5 }}>
          <InputLabel id="import-target-label">Target</InputLabel>
          <Select
            labelId="import-target-label"
            value={target}
            label="Target"
            onChange={(e) => setTarget(e.target.value)}
          >
            <MenuItem value="__new__">New MQTT Interface</MenuItem>
            {mqttInterfaces.map(i => (
              <MenuItem key={i.id} value={i.id}>{i.id}</MenuItem>
            ))}
          </Select>
        </FormControl>

        <TextField
          fullWidth
          size="small"
          label="Broker URL"
          value={brokerUrl}
          onChange={(e) => setBrokerUrl(e.target.value)}
          placeholder="mqtt://localhost:1883"
          sx={{ mb: 1 }}
        />
        <TextField
          fullWidth
          size="small"
          label="Topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="rv/plc/process-image/raw"
          sx={{ mb: 1.5 }}
          InputProps={{
            endAdornment: (
              <InputAdornment position="end">
                <Tooltip title={target === '__new__'
                  ? 'Select an existing MQTT interface to browse topics'
                  : 'Browse topics on the broker (MQTT discovery)'}>
                  <span>
                    <IconButton
                      size="small"
                      edge="end"
                      disabled={target === '__new__' || browsing}
                      onClick={(e) => handleBrowseTopics(e.currentTarget)}
                    >
                      {browsing ? <CircularProgress size={16} /> : <Search sx={{ fontSize: 16 }} />}
                    </IconButton>
                  </span>
                </Tooltip>
              </InputAdornment>
            ),
          }}
        />
        <Menu
          anchorEl={topicMenuAnchor}
          open={!!topicMenuAnchor}
          onClose={() => setTopicMenuAnchor(null)}
          slotProps={{ paper: { sx: { maxHeight: 320 } } }}
        >
          {discoveredTopics.length === 0 && (
            <MenuItem disabled sx={{ fontSize: 12 }}>No topics discovered</MenuItem>
          )}
          {discoveredTopics.map(t => (
            <MenuItem
              key={t}
              selected={t === topic}
              onClick={() => { setTopic(t); setTopicMenuAnchor(null); }}
              sx={{ fontSize: 12 }}
            >
              {t}
            </MenuItem>
          ))}
        </Menu>

        <Button
          variant="outlined"
          size="small"
          startIcon={<Upload sx={{ fontSize: 14 }} />}
          onClick={handlePickFile}
          sx={{ textTransform: 'none', mb: 1 }}
        >
          Choose file (.xlsx / .csv)
        </Button>
        {fileName && (
          <Typography sx={{ fontSize: 10, color: 'text.secondary', mb: 1 }}>
            {fileName}
          </Typography>
        )}

        {parseError && (
          <Typography sx={{ fontSize: 11, color: ISA_RED, mb: 1 }}>
            {parseError}
          </Typography>
        )}

        {/* Preview */}
        {parsed && (
          <Box sx={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 1, p: 1 }}>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
              <Typography sx={{ fontSize: 11, color: 'text.primary' }}>
                {parsed.tags.length} Tags
              </Typography>
              <Typography sx={{ fontSize: 11, color: parsed.warnings.length > 0 ? ISA_RED : 'text.secondary' }}>
                · {parsed.warnings.length} Errors
              </Typography>
              <Typography sx={{ fontSize: 11, color: parsed.overlaps.length > 0 ? ISA_AMBER : 'text.secondary' }}>
                · {parsed.overlaps.length} Overlaps
              </Typography>
            </Box>

            {parsed.warnings.length > 0 && (
              <Box className={RV_SCROLL_CLASS} sx={{ maxHeight: 80, overflow: 'auto', mb: 0.5 }}>
                {parsed.warnings.map((w, idx) => (
                  <Typography key={idx} sx={{ fontSize: 9, color: ISA_RED, fontFamily: 'monospace' }}>
                    {w}
                  </Typography>
                ))}
              </Box>
            )}

            {parsed.overlaps.length > 0 && (
              <Box className={RV_SCROLL_CLASS} sx={{ maxHeight: 80, overflow: 'auto', mb: 0.5 }}>
                {parsed.overlaps.map((o, idx) => (
                  <Typography key={idx} sx={{ fontSize: 9, color: ISA_AMBER, fontFamily: 'monospace' }}>
                    {o}
                  </Typography>
                ))}
              </Box>
            )}

            <Box className={RV_SCROLL_CLASS} sx={{ maxHeight: 160, overflow: 'auto' }}>
              {parsed.tags.slice(0, 200).map((t, idx) => (
                <Box key={t.name + idx} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, py: 0.1 }}>
                  <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.85)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.name}
                  </Typography>
                  <Chip label={t.dataType} size="small" sx={{ fontSize: 9, height: 16, '& .MuiChip-label': { px: 0.5 } }} />
                  <Typography sx={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace', minWidth: 56, textAlign: 'right' }}>
                    {t.address}
                  </Typography>
                </Box>
              ))}
              {parsed.tags.length > 200 && (
                <Typography sx={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', textAlign: 'center', py: 0.5 }}>
                  … {parsed.tags.length - 200} more
                </Typography>
              )}
            </Box>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} sx={{ textTransform: 'none' }}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handlePush}
          disabled={!canPush}
          sx={{ textTransform: 'none' }}
        >
          {pushing ? 'Pushing...' : 'Push to CONNECT'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
