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

import { useState, useSyncExternalStore, useCallback } from 'react';
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
  Select,
  FormControl,
  InputLabel,
  CircularProgress,
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
} from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import { LeftPanel } from './LeftPanel';
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
  type ConnectInterface,
  type ConnectState,
} from './connect-store';
import { ISA_GREEN, ISA_RED, connectionStateColor } from './isa-colors';

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

  const handleBind = useCallback(async () => {
    if (!snap.activeInterfaceId) return;
    await bindSelectedSignals(snap.activeInterfaceId);
  }, [snap.activeInterfaceId]);

  const handleRemoveInterface = useCallback(async (id: string) => {
    await removeInterface(id);
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIface(prev => prev === id ? null : id);
  }, []);

  if (!isOpen) return null;

  const isConnected = snap.state === 'connected';
  const selectedCount = snap.discoveredSignals.filter(s => s.selected).length;

  return (
    <LeftPanel
      title={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Cable sx={{ fontSize: 14, color: 'primary.main' }} />
          <Typography sx={{ fontSize: 11, fontWeight: 600, color: 'text.primary' }}>
            realvirtual CONNECT
          </Typography>
          <Circle sx={{ fontSize: 6, color: statusColor(snap.state), ml: 0.5 }} />
        </Box>
      }
      onClose={handleClose}
      width={CONNECT_PANEL_WIDTH}
    >
      <Box className={RV_SCROLL_CLASS} sx={{ flex: 1, overflow: 'auto' }}>
        {/* ── Section 1: Server URL + Connect ── */}
        <Box sx={{ p: 1 }}>
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
          {/* Server version info */}
          {isConnected && snap.serverVersion && (
            <Typography sx={{ fontSize: 9, color: 'text.disabled', mt: 0.25 }}>
              CONNECT v{snap.serverVersion} · Build {snap.serverBuildDate}
            </Typography>
          )}
        </Box>

        <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />

        {/* ── Section 2: Interface List ── */}
        {isConnected && (
          <Box sx={{ p: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
              <Typography sx={{ fontSize: 10, color: 'text.secondary', flex: 1 }}>
                Interfaces ({snap.interfaces.length})
              </Typography>
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

            {snap.interfaces.map((iface) => (
              <InterfaceCard
                key={iface.id}
                iface={iface}
                expanded={expandedIface === iface.id}
                onToggle={() => toggleExpand(iface.id)}
                onBrowse={() => handleBrowse(iface.id)}
                onEdit={() => setEditIface(iface)}
                onDelete={() => handleRemoveInterface(iface.id)}
              />
            ))}
          </Box>
        )}

        {/* ── Section 3: Signal Browser (Discovery Results) ── */}
        {isConnected && snap.activeInterfaceId && (
          <>
            <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />
            <Box sx={{ p: 1 }}>
              <Typography sx={{ fontSize: 10, color: 'text.secondary', mb: 0.5 }}>
                Signal Browser
              </Typography>

              {snap.discoveryLoading && (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
                  <CircularProgress size={20} />
                </Box>
              )}

              {!snap.discoveryLoading && snap.discoveredSignals.length === 0 && (
                <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', textAlign: 'center', py: 2 }}>
                  No signals discovered. Click Browse on an interface.
                </Typography>
              )}

              {!snap.discoveryLoading && snap.discoveredSignals.length > 0 && (
                <>
                  {/* Select All / None */}
                  <Box sx={{ display: 'flex', gap: 0.5, mb: 0.5 }}>
                    <Button
                      size="small"
                      startIcon={<SelectAll sx={{ fontSize: 12 }} />}
                      onClick={() => selectAllSignals(true)}
                      sx={{ fontSize: 9, textTransform: 'none', minWidth: 0 }}
                    >
                      All
                    </Button>
                    <Button
                      size="small"
                      startIcon={<Deselect sx={{ fontSize: 12 }} />}
                      onClick={() => selectAllSignals(false)}
                      sx={{ fontSize: 9, textTransform: 'none', minWidth: 0 }}
                    >
                      None
                    </Button>
                  </Box>

                  {/* Signal rows */}
                  {snap.discoveredSignals.map((sig) => (
                    <Box
                      key={sig.protocolAddress}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 0.5,
                        py: 0.25,
                        '&:hover': { bgcolor: 'rgba(79,195,247,0.06)' },
                      }}
                    >
                      <Checkbox
                        size="small"
                        checked={sig.selected ?? false}
                        onChange={() => toggleSignalSelection(sig.protocolAddress)}
                        sx={{ p: 0.25, '& .MuiSvgIcon-root': { fontSize: 14 } }}
                      />
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {sig.displayName}
                        </Typography>
                        <Typography sx={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace' }}>
                          {sig.protocolAddress}
                        </Typography>
                      </Box>
                      <Chip
                        label={sig.dataType}
                        size="small"
                        sx={{ fontSize: 9, height: 16, '& .MuiChip-label': { px: 0.5 } }}
                      />
                      <Chip
                        label={sig.direction}
                        size="small"
                        color={sig.direction === 'input' ? 'info' : sig.direction === 'output' ? 'success' : 'default'}
                        sx={{ fontSize: 9, height: 16, '& .MuiChip-label': { px: 0.5 } }}
                      />
                    </Box>
                  ))}

                  {/* Bind button */}
                  <Button
                    variant="contained"
                    size="small"
                    startIcon={<Check sx={{ fontSize: 14 }} />}
                    onClick={handleBind}
                    disabled={selectedCount === 0}
                    sx={{ mt: 1, fontSize: 10, textTransform: 'none', width: '100%' }}
                  >
                    Bind Selected ({selectedCount})
                  </Button>
                </>
              )}
            </Box>
          </>
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
    </LeftPanel>
  );
}

// ── InterfaceCard ──────────────────────────────────────────────────────

function InterfaceCard({
  iface,
  expanded,
  onToggle,
  onBrowse,
  onEdit,
  onDelete,
}: {
  iface: ConnectInterface;
  expanded: boolean;
  onToggle: () => void;
  onBrowse: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const signalCount = iface.signals?.length ?? 0;

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
        <Circle sx={{ fontSize: 6, color: iface.enabled ? ISA_GREEN : '#757575' }} />
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
          <Box sx={{ display: 'flex', gap: 0.5 }}>
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
