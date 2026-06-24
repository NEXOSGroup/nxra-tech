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
import { deriveWireType, type S7Tag } from '../import/s7-tag-table';

// ── Types ──────────────────────────────────────────────────────────────

export type ConnectState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectInterfaceSignal {
  protocolAddress: string;
  name: string;
  type: string;
  /** Siemens data type for ProcessImage signals (Bool/Word/Int/...). Optional for legacy signals. */
  dataType?: string;
  record: boolean;
}

/** MQTT topic config — one topic carries either a Single scalar or a ProcessImage byte array. */
export interface ConnectMqttTopic {
  topic: string;
  mode: string; // 'Single' | 'ProcessImage'
  signals?: ConnectInterfaceSignal[];
}

export interface ConnectInterface {
  id: string;
  type: 'OpcUa' | 'S7' | 'MQTT';
  enabled: boolean;
  /** MQTT per-topic config (ProcessImage signals live here, not in `signals`). */
  topics?: ConnectMqttTopic[];
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

/** Live per-interface worker connection status from CONNECT's /status endpoint. */
export interface ConnectInterfaceStatus {
  /** "Connected" | "Connecting" | "Reconnecting" | "Error" | "Stopped" | "Disabled" */
  status: string;
  error?: string;
}

export interface ConnectSnapshot {
  serverUrl: string;
  state: ConnectState;
  errorMessage: string;
  /** Server version string (from /health `version`, else legacy `appVersion`). */
  serverVersion: string;
  /** Server build number (from /health `build`). Empty for older gateways. */
  serverBuild: string;
  /** Server build date (from /health buildDate). */
  serverBuildDate: string;
  interfaces: ConnectInterface[];
  /** Live worker status keyed by interface id (from /status). */
  interfaceStatus: Record<string, ConnectInterfaceStatus>;
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
  serverBuild: '',
  serverBuildDate: '',
  interfaces: [],
  interfaceStatus: {},
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
    const health = await _fetchJson<{
      status: string;
      /** New gateways: semantic version "X.Y.Z". */
      version?: string;
      /** New gateways: build number. */
      build?: number | string;
      /** Legacy gateways: full version "X.Y.Z.BUILD" (still sent for compatibility). */
      appVersion?: string;
      buildDate?: string;
    }>('/health');
    if (health.status !== 'ok') {
      throw new Error(`Server reports status: ${health.status}`);
    }
    // Prefer the new version/build fields; fall back to legacy appVersion for older gateways.
    const version = health.version ?? health.appVersion ?? '';
    const build = health.build != null ? String(health.build) : '';
    _store.set({
      state: 'connected',
      errorMessage: '',
      serverVersion: version,
      serverBuild: build,
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
    serverBuild: '',
    serverBuildDate: '',
    interfaces: [],
    interfaceStatus: {},
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

/** Fetch live per-interface worker status (/status) and update the snapshot map. */
export async function fetchStatus(): Promise<void> {
  try {
    const resp = await _fetchJson<{ interfaces: Array<{ id: string; status: string; error?: string | null }> }>('/status');
    const map: Record<string, ConnectInterfaceStatus> = {};
    for (const i of resp.interfaces) {
      map[i.id] = { status: i.status, error: i.error ?? undefined };
    }
    _store.set({ interfaceStatus: map });
  } catch {
    // Older gateways without /status — leave the map untouched.
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

/**
 * Update an existing interface via REST API.
 *
 * CONNECT's `PUT /config/interfaces/{id}` REPLACES the whole interface, so any field
 * absent from the body resets to its server-side default — most damagingly `Type → ""`,
 * which makes the WorkerManager start no worker (no connection, no decoded signals).
 * We therefore merge the partial `patch` onto the current interface and always send the
 * complete object.
 */
export async function updateInterface(id: string, patch: Partial<ConnectInterface>): Promise<void> {
  try {
    const existing = _store.getSnapshot().interfaces.find(i => i.id === id);
    const body: Partial<ConnectInterface> = existing ? { ...existing, ...patch, id } : { ...patch, id };
    await _fetchJson<unknown>(`/config/interfaces/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
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
    // POST runs discovery (subscribe to '#' for a window) and returns the signals directly.
    // The gateway's DiscoveredSignal uses name/browsePath (no protocolAddress) — map it here.
    const resp = await _fetchJson<{
      signals?: Array<{ name?: string; displayName?: string; dataType?: string; direction?: string; browsePath?: string; currentValue?: unknown }>;
    }>(`/discover/${interfaceId}/start`, { method: 'POST' });

    const discovered: DiscoveredSignal[] = (resp.signals ?? []).map(s => {
      const addr = s.browsePath || s.name || '';
      const dir: DiscoveredSignal['direction'] =
        s.direction === 'input' || s.direction === 'output' ? s.direction : 'unknown';
      return {
        protocolAddress: addr,
        displayName: s.displayName || s.name || addr,
        dataType: s.dataType || '',
        direction: dir,
        browsePath: s.browsePath || addr,
        currentValue: s.currentValue,
        selected: false,
      };
    });

    _store.set({ discoveredSignals: discovered, discoveryLoading: false });
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

// ── Tag Table Import ─────────────────────────────────────────────────────

export interface ImportTagTableParams {
  /** Imported and validated tags. */
  tags: S7Tag[];
  /** MQTT broker URL for the target interface. */
  brokerUrl: string;
  /** MQTT topic carrying the ProcessImage byte array. */
  topic: string;
  /**
   * Target interface id, or null to create a new interface.
   * When set and the interface exists, it is updated (PUT) and the same-named
   * topic is replaced. Otherwise a new interface is added (POST).
   */
  targetInterfaceId?: string | null;
}

/** Convert parsed S7 tags into CONNECT signal config entries. */
function _tagsToSignals(tags: S7Tag[]): ConnectInterfaceSignal[] {
  return tags.map(t => ({
    protocolAddress: t.address,
    name: t.name,
    type: deriveWireType(t.dataType),
    dataType: t.dataType,
    record: false,
  }));
}

/**
 * Push an imported tag table to CONNECT as an MQTT ProcessImage topic.
 *
 * Update-vs-New: if `targetInterfaceId` names an existing interface, the
 * interface is updated via PUT and the same-named topic is replaced (no
 * duplicate); otherwise a new MQTT interface is created via POST.
 */
export async function importTagTable(params: ImportTagTableParams): Promise<void> {
  const { tags, brokerUrl, topic } = params;
  const signals = _tagsToSignals(tags);
  const newTopic: ConnectMqttTopic = { topic, mode: 'ProcessImage', signals };

  const existing = params.targetInterfaceId
    ? _store.getSnapshot().interfaces.find(i => i.id === params.targetInterfaceId)
    : undefined;

  if (existing) {
    // Replace the same-named topic in place; keep all other topics untouched.
    const prevTopics = existing.topics ?? [];
    const topics = prevTopics.some(t => t.topic === topic)
      ? prevTopics.map(t => (t.topic === topic ? newTopic : t))
      : [...prevTopics, newTopic];
    await updateInterface(existing.id, { brokerUrl, topics });
  } else {
    await addInterface({
      type: 'MQTT',
      enabled: true,
      brokerUrl,
      topics: [newTopic],
    } as Omit<ConnectInterface, 'id' | 'signals'>);
  }
}

// ── Gateway Log ──────────────────────────────────────────────────────────

/** One gateway log line from CONNECT's /logs endpoint. */
export interface ConnectLogEntry {
  seq: number;
  time: string;
  level: string;
  category: string;
  message: string;
}

/**
 * Fetch recent gateway log entries. Pass the previous `latest` as `since` for
 * incremental polling (only entries newer than `since` are returned).
 */
export async function fetchLogs(
  since: number,
  count = 500,
  level?: string,
): Promise<{ latest: number; entries: ConnectLogEntry[] }> {
  const params = new URLSearchParams({ since: String(since), count: String(count) });
  if (level) params.set('level', level);
  return _fetchJson<{ latest: number; entries: ConnectLogEntry[] }>(`/logs?${params.toString()}`);
}

// ── Test Helpers ───────────────────────────────────────────────────────

/** @internal Reset store state (for testing only). */
export function _resetConnectStore(): void {
  _store.set({
    serverUrl: DEFAULT_URL,
    state: 'disconnected',
    errorMessage: '',
    serverVersion: '',
    serverBuild: '',
    serverBuildDate: '',
    interfaces: [],
    interfaceStatus: {},
    activeInterfaceId: null,
    discoveredSignals: [],
    discoveryLoading: false,
  });
}
