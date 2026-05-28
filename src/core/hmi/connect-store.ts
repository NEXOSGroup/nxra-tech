// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * connect-store.ts — Zustand-style pub/sub store for the realvirtual CONNECT panel.
 *
 * Manages CONNECT server URL, connection state, configured interfaces,
 * discovery results, and all REST API calls against the CONNECT gateway.
 *
 * Uses module-level state with subscribe/getSnapshot for React useSyncExternalStore.
 */

import { createStore } from './create-store';

// ── Types ──────────────────────────────────────────────────────────────

export type ConnectState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectInterfaceSignal {
  protocolAddress: string;
  name: string;
  type: string;
  record: boolean;
}

export interface ConnectInterface {
  id: string;
  type: 'OpcUa' | 'S7' | 'MQTT';
  enabled: boolean;
  /** Protocol-specific connection settings (endpoint, ipAddress, etc.) */
  [key: string]: unknown;
  signals: ConnectInterfaceSignal[];
}

export interface DiscoveredSignal {
  protocolAddress: string;
  displayName: string;
  dataType: string;
  direction: 'input' | 'output' | 'unknown';
  browsePath: string;
  currentValue?: unknown;
  /** UI selection state (not from server). */
  selected?: boolean;
}

export interface ConnectSnapshot {
  serverUrl: string;
  state: ConnectState;
  errorMessage: string;
  /** Server version string (from /health appVersion). */
  serverVersion: string;
  /** Server build date (from /health buildDate). */
  serverBuildDate: string;
  interfaces: ConnectInterface[];
  activeInterfaceId: string | null;
  discoveredSignals: DiscoveredSignal[];
  discoveryLoading: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────

const LS_KEY_URL = 'rv-connect-url';
const DEFAULT_URL = 'http://localhost:5100';

// ── Module-level Store ─────────────────────────────────────────────────

type Listener = () => void;

function _readInitialUrl(): string {
  try {
    return localStorage.getItem(LS_KEY_URL) || DEFAULT_URL;
  } catch {
    return DEFAULT_URL;
  }
}

const _store = createStore<ConnectSnapshot>({
  serverUrl: _readInitialUrl(),
  state: 'disconnected',
  errorMessage: '',
  serverVersion: '',
  serverBuildDate: '',
  interfaces: [],
  activeInterfaceId: null,
  discoveredSignals: [],
  discoveryLoading: false,
});

// ── React Integration (useSyncExternalStore) ───────────────────────────

export function subscribeConnectStore(listener: Listener): () => void {
  return _store.subscribe(listener);
}

export function getConnectSnapshot(): ConnectSnapshot {
  return _store.getSnapshot();
}

// ── URL Management ─────────────────────────────────────────────────────

export function setServerUrl(url: string): void {
  try {
    localStorage.setItem(LS_KEY_URL, url);
  } catch { /* ignore */ }
  _store.set({ serverUrl: url });
}

// ── REST API Helpers ───────────────────────────────────────────────────

async function _fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${_store.getSnapshot().serverUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  }
  return resp.json() as Promise<T>;
}

// ── Actions ────────────────────────────────────────────────────────────

/** Connect to CONNECT server: check /health, then load interfaces. */
export async function connectToServer(): Promise<void> {
  _store.set({ state: 'connecting', errorMessage: '' });

  try {
    const health = await _fetchJson<{ status: string; appVersion?: string; buildDate?: string }>('/health');
    if (health.status !== 'ok') {
      throw new Error(`Server reports status: ${health.status}`);
    }
    _store.set({
      state: 'connected',
      errorMessage: '',
      serverVersion: health.appVersion ?? '',
      serverBuildDate: health.buildDate ?? '',
    });

    // Load interfaces after successful connect
    await fetchInterfaces();
  } catch (err) {
    _store.set({
      state: 'error',
      errorMessage: err instanceof Error ? err.message : String(err),
      interfaces: [],
    });
  }
}

/** Disconnect from CONNECT server. */
export function disconnectFromServer(): void {
  _store.set({
    state: 'disconnected',
    errorMessage: '',
    serverVersion: '',
    serverBuildDate: '',
    interfaces: [],
    activeInterfaceId: null,
    discoveredSignals: [],
    discoveryLoading: false,
  });
}

/** Fetch the list of configured interfaces from the CONNECT REST API. */
export async function fetchInterfaces(): Promise<void> {
  try {
    const ifaces = await _fetchJson<ConnectInterface[]>('/config/interfaces');
    _store.set({ interfaces: ifaces });
  } catch (err) {
    console.error('[connect-store] Failed to fetch interfaces:', err);
  }
}

/** Add a new interface via REST API. */
export async function addInterface(iface: Omit<ConnectInterface, 'id' | 'signals'>): Promise<void> {
  try {
    const created = await _fetchJson<ConnectInterface>('/config/interfaces', {
      method: 'POST',
      body: JSON.stringify(iface),
    });
    _store.set(prev => ({ ...prev, interfaces: [...prev.interfaces, created] }));
  } catch (err) {
    console.error('[connect-store] Failed to add interface:', err);
    throw err;
  }
}

/** Update an existing interface via REST API. */
export async function updateInterface(id: string, iface: Partial<ConnectInterface>): Promise<void> {
  try {
    await _fetchJson<unknown>(`/config/interfaces/${id}`, {
      method: 'PUT',
      body: JSON.stringify(iface),
    });
    // Refresh from server
    await fetchInterfaces();
  } catch (err) {
    console.error('[connect-store] Failed to update interface:', err);
    throw err;
  }
}

/** Remove an interface via REST API. */
export async function removeInterface(id: string): Promise<void> {
  try {
    await fetch(`${_store.getSnapshot().serverUrl}/config/interfaces/${id}`, { method: 'DELETE' });
    _store.set(prev => {
      const interfaces = prev.interfaces.filter(i => i.id !== id);
      const cleared = prev.activeInterfaceId === id;
      return {
        ...prev,
        interfaces,
        activeInterfaceId: cleared ? null : prev.activeInterfaceId,
        discoveredSignals: cleared ? [] : prev.discoveredSignals,
      };
    });
  } catch (err) {
    console.error('[connect-store] Failed to remove interface:', err);
    throw err;
  }
}

/** Set the active interface for the signal browser. */
export function setActiveInterface(id: string | null): void {
  _store.set({
    activeInterfaceId: id,
    discoveredSignals: [],
    discoveryLoading: false,
  });
}

/** Start signal discovery for the active interface. */
export async function startDiscovery(interfaceId: string): Promise<void> {
  _store.set({ discoveryLoading: true, discoveredSignals: [] });

  try {
    // POST to start discovery, then GET results
    await _fetchJson<unknown>(`/discover/${interfaceId}/start`, { method: 'POST' });
    const results = await _fetchJson<DiscoveredSignal[]>(`/discover/${interfaceId}/results`);
    _store.set({
      discoveredSignals: results.map(s => ({ ...s, selected: false })),
      discoveryLoading: false,
    });
  } catch (err) {
    console.error('[connect-store] Discovery failed:', err);
    _store.set({ discoveryLoading: false });
  }
}

/** Toggle selection of a discovered signal. */
export function toggleSignalSelection(protocolAddress: string): void {
  _store.set(prev => ({
    ...prev,
    discoveredSignals: prev.discoveredSignals.map(s =>
      s.protocolAddress === protocolAddress ? { ...s, selected: !s.selected } : s,
    ),
  }));
}

/** Select or deselect all discovered signals. */
export function selectAllSignals(selected: boolean): void {
  _store.set(prev => ({
    ...prev,
    discoveredSignals: prev.discoveredSignals.map(s => ({ ...s, selected })),
  }));
}

/** Bind selected discovered signals to the active interface. */
export async function bindSelectedSignals(interfaceId: string): Promise<void> {
  const selected = _store.getSnapshot().discoveredSignals.filter(s => s.selected);
  if (selected.length === 0) return;

  const bindings = selected.map(s => ({
    protocolAddress: s.protocolAddress,
    signalName: s.displayName.replace(/[^a-zA-Z0-9_]/g, '_'),
    type: `PLC${s.direction === 'input' ? 'Input' : 'Output'}${s.dataType === 'Bool' ? 'Bool' : s.dataType === 'Int' ? 'Int' : 'Float'}`,
    record: false,
  }));

  try {
    await _fetchJson<unknown>(`/discover/${interfaceId}/bind`, {
      method: 'POST',
      body: JSON.stringify(bindings),
    });
    // Refresh interfaces to reflect new signals
    await fetchInterfaces();
    // Clear discovery state
    _store.set({ discoveredSignals: [] });
  } catch (err) {
    console.error('[connect-store] Bind failed:', err);
    throw err;
  }
}

// ── Test Helpers ───────────────────────────────────────────────────────

/** @internal Reset store state (for testing only). */
export function _resetConnectStore(): void {
  _store.set({
    serverUrl: DEFAULT_URL,
    state: 'disconnected',
    errorMessage: '',
    serverVersion: '',
    serverBuildDate: '',
    interfaces: [],
    activeInterfaceId: null,
    discoveredSignals: [],
    discoveryLoading: false,
  });
}
