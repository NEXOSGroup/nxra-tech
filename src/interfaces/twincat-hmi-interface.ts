// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TwinCatHmiInterface — Beckhoff TwinCAT HMI WebSocket interface.
 *
 * Connects directly to the TcHmiServer running on a Beckhoff IPC/PLC using
 * the native Browser WebSocket and the TcHmi JSON protocol.
 *
 * Extends BaseIndustrialInterface DIRECTLY (NOT WebSocketRealtimeInterface —
 * the TcHmi protocol is fundamentally different from the realvirtual WS Realtime v2 protocol).
 *
 * Protocol features:
 *   - ListSymbols discovery via ReadWrite request
 *   - Per-symbol Subscription with configurable interval
 *   - ReadWrite commands for bidirectional signal access
 *   - Token-based authentication via ?cid= query parameter
 *
 * Port conventions:
 *   - HTTP (ws://): Port 1010
 *   - HTTPS (wss://): Port 1020
 */

import {
  BaseIndustrialInterface,
  defaultValueForType,
  type SignalDescriptor,
  type SignalDirection,
  type SignalType,
} from './base-industrial-interface';
import type { InterfaceSettings } from './interface-settings-store';
import { debug, debugWarn } from '../core/engine/rv-debug';

// ── TcHmi Protocol Types ─────────────────────────────────────────────────

/** TcHmi Command (Client -> Server) */
export interface TcHmiCommand {
  symbol: string;
  commandOptions?: string[];
  writeValue?: boolean | number | string;
  interval?: number;
}

/** TcHmi Request (Client -> Server) */
export interface TcHmiRequest {
  requestType: 'ReadWrite' | 'Subscription' | 'UnSubscription';
  id: number;
  commands: TcHmiCommand[];
}

/** TcHmi Response Command (Server -> Client) */
export interface TcHmiResponseCommand {
  symbol: string;
  readValue?: unknown;
  writeValue?: unknown;
  /** Data type of the symbol (BOOL, INT, REAL, etc.) — needed for mapType() */
  type?: string;
  /** Alternative property (TcHmi-version-dependent) */
  dataType?: string;
  /** Access rights (read, write, readwrite) — needed for mapDirection() */
  accessRights?: string;
  error?: number;
  errorMessage?: string;
}

/** TcHmi Response (Server -> Client) */
export interface TcHmiResponse {
  requestType: string;
  id: number;
  commands: TcHmiResponseCommand[];
}

// ── Pending Request Tracking ─────────────────────────────────────────────

interface PendingRequest {
  resolve: (cmds: TcHmiResponseCommand[]) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

// ── Type Mapping Utilities (exported for tests) ──────────────────────────

/** Default subscription polling interval in milliseconds. */
const SUBSCRIPTION_INTERVAL_MS = 100;

/** Default command timeout in milliseconds. */
const COMMAND_TIMEOUT_MS = 10_000;

/** Connect timeout in milliseconds. */
const CONNECT_TIMEOUT_MS = 5_000;

const TC_INTEGER_TYPES = new Set([
  'INT', 'UINT', 'SINT', 'DINT', 'UDINT', 'WORD', 'DWORD', 'BYTE', 'USINT', 'LINT', 'ULINT',
]);

/**
 * Maps a TwinCAT type string to SignalType.
 * BOOL -> bool, integer types -> int, floating types -> float.
 * Default: float.
 */
export function mapTcHmiType(tcType: string | undefined): SignalType {
  if (!tcType) return 'float';
  const upper = tcType.toUpperCase();
  if (upper === 'BOOL') return 'bool';
  if (TC_INTEGER_TYPES.has(upper)) return 'int';
  if (upper === 'REAL' || upper === 'LREAL') return 'float';
  return 'float';
}

/**
 * Maps TcHmi access rights to SignalDirection.
 * 'read' -> input, 'write' -> output, default -> input.
 */
export function mapTcHmiAccess(access: string | undefined): SignalDirection {
  if (!access) return 'input';
  if (access.toLowerCase() === 'write') return 'output';
  return 'input';
}

function isStringType(tcType: string | undefined): boolean {
  if (!tcType) return false;
  return tcType.toUpperCase() === 'STRING';
}

// ── TwinCatHmiInterface ──────────────────────────────────────────────────

export class TwinCatHmiInterface extends BaseIndustrialInterface {
  readonly id = 'twincat-hmi';
  readonly protocolName = 'TwinCAT HMI (Beckhoff)';

  private ws: WebSocket | null = null;
  private nextId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private subscriptionIds = new Map<string, number>();
  private subscriptionIdSet = new Set<number>();
  private _connectTimeout: ReturnType<typeof setTimeout> | null = null;

  // ── Protocol Implementation ──

  protected async doConnect(settings: InterfaceSettings): Promise<void> {
    const url = this.buildUrl(settings);

    return new Promise<void>((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        reject(new Error(`Failed to create WebSocket: ${err}`));
        return;
      }

      this._connectTimeout = setTimeout(() => {
        this._connectTimeout = null;
        if (this.ws?.readyState !== WebSocket.OPEN) {
          this.ws?.close();
          reject(new Error(`Connection to ${url} timed out (${CONNECT_TIMEOUT_MS}ms)`));
        }
      }, CONNECT_TIMEOUT_MS);

      this.ws.onopen = () => {
        if (this._connectTimeout) {
          clearTimeout(this._connectTimeout);
          this._connectTimeout = null;
        }
        debug('interface', `[twincat-hmi] Connected to ${url}`);
        resolve();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data as string);
      };

      this.ws.onclose = (event) => {
        if (this._connectTimeout) {
          clearTimeout(this._connectTimeout);
          this._connectTimeout = null;
        }
        if (this.isConnected) {
          this.onConnectionLost(event.reason || `WebSocket closed (code ${event.code})`);
        }
      };

      this.ws.onerror = () => {
        if (this._connectTimeout) {
          clearTimeout(this._connectTimeout);
          this._connectTimeout = null;
        }
        // onclose will also fire — error handling happens there
      };
    });
  }

  protected doDisconnect(): void {
    if (this._connectTimeout) {
      clearTimeout(this._connectTimeout);
      this._connectTimeout = null;
    }

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Disconnected'));
    }
    this.pendingRequests.clear();
    this.subscriptionIds.clear();
    this.subscriptionIdSet.clear();

    if (this.ws) {
      // Prevent onclose from triggering reconnect
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, 'Client disconnect');
      }
      this.ws = null;
    }
  }

  protected async doDiscoverSignals(): Promise<SignalDescriptor[]> {
    // Send ListSymbols command
    const request: TcHmiRequest = {
      requestType: 'ReadWrite',
      id: this.allocateId(),
      commands: [{ symbol: 'ListSymbols', commandOptions: ['SendErrorMessage'] }],
    };

    let response: TcHmiResponseCommand[];
    try {
      response = await this.sendCommand(request);
    } catch (err) {
      debugWarn('interface', `[twincat-hmi] ListSymbols failed: ${err}`);
      return [];
    }

    const listCmd = response[0];
    if (listCmd && listCmd.error !== undefined && listCmd.error !== 0) {
      debugWarn('interface', `[twincat-hmi] ListSymbols returned error ${listCmd.error}: ${listCmd.errorMessage ?? 'unknown'}`);
      return [];
    }

    const symbols = listCmd?.readValue;
    if (!symbols || typeof symbols !== 'object') {
      debugWarn('interface', '[twincat-hmi] ListSymbols returned no symbols');
      return [];
    }

    const descriptors: SignalDescriptor[] = [];

    for (const [symbolName, meta] of Object.entries(symbols as Record<string, TcHmiResponseCommand>)) {
      const typeName = meta?.type ?? meta?.dataType;
      if (isStringType(typeName)) {
        debug('interface', `[twincat-hmi] Skipping STRING symbol: ${symbolName}`);
        continue;
      }

      const type = mapTcHmiType(typeName);
      const direction = mapTcHmiAccess(meta?.accessRights);
      const initialValue = defaultValueForType(type);

      descriptors.push({ name: symbolName, type, direction, initialValue });
    }

    // Subscribe to all discovered symbols
    await this.subscribeAll(descriptors);

    debug('interface', `[twincat-hmi] Discovered ${descriptors.length} signals`);
    return descriptors;
  }

  protected sendSignals(signals: Record<string, boolean | number>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const commands: TcHmiCommand[] = [];
    for (const name in signals) {
      commands.push({
        symbol: name,
        commandOptions: ['SendWriteValue'],
        writeValue: signals[name],
      });
    }

    if (commands.length === 0) return;

    const request: TcHmiRequest = {
      requestType: 'ReadWrite',
      id: this.allocateId(),
      commands,
    };

    try {
      this.ws.send(JSON.stringify(request));
    } catch (err) {
      debugWarn('interface', `[twincat-hmi] Failed to send write command: ${err}`);
    }
  }

  // ── Command / Response ──

  /**
   * Send a command and wait for the response.
   * Returns the response commands array. Rejects on timeout or disconnect.
   */
  private sendCommand(request: TcHmiRequest): Promise<TcHmiResponseCommand[]> {
    return new Promise<TcHmiResponseCommand[]>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not open'));
        return;
      }

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(new Error(`Command ${request.id} timed out (${COMMAND_TIMEOUT_MS}ms)`));
      }, COMMAND_TIMEOUT_MS);

      this.pendingRequests.set(request.id, { resolve, reject, timeout });

      try {
        this.ws.send(JSON.stringify(request));
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(request.id);
        reject(new Error(`Failed to send command: ${err}`));
      }
    });
  }

  // ── Message Handling ──

  private handleMessage(raw: string): void {
    let msg: TcHmiResponse;
    try {
      msg = JSON.parse(raw) as TcHmiResponse;
    } catch {
      this.onProtocolError(`Invalid JSON: ${raw.substring(0, 100)}`);
      return;
    }

    if (msg.requestType === 'Subscription' && this.subscriptionIdSet.has(msg.id)) {
      this.handleSubscriptionUpdate(msg);
      return;
    }

    this.handleResponse(msg);
  }

  private handleSubscriptionUpdate(msg: TcHmiResponse): void {
    if (!msg.commands) return;

    const incoming: Record<string, boolean | number> = {};
    let hasData = false;
    for (const cmd of msg.commands) {
      if (cmd.error !== undefined && cmd.error !== 0) continue;
      if (cmd.readValue === undefined || cmd.readValue === null) continue;

      const value = cmd.readValue;
      if (typeof value === 'boolean' || typeof value === 'number') {
        incoming[cmd.symbol] = value;
        hasData = true;
      } else if (typeof value === 'string') {
        const lower = value.toLowerCase();
        if (lower === 'true') { incoming[cmd.symbol] = true; hasData = true; }
        else if (lower === 'false') { incoming[cmd.symbol] = false; hasData = true; }
        else {
          const num = Number(value);
          if (!isNaN(num)) { incoming[cmd.symbol] = num; hasData = true; }
        }
      }
    }

    if (hasData) {
      this.bufferIncoming(incoming);
    }
  }

  private handleResponse(msg: TcHmiResponse): void {
    const pending = this.pendingRequests.get(msg.id);
    if (!pending) return; // Response for unknown/expired request — ignore

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(msg.id);
    pending.resolve(msg.commands ?? []);
  }

  // ── Subscription Management ──

  private async subscribeAll(symbols: SignalDescriptor[]): Promise<void> {
    if (symbols.length === 0) return;

    for (const sig of symbols) {
      const id = this.allocateId();

      const request: TcHmiRequest = {
        requestType: 'Subscription',
        id,
        commands: [{
          symbol: sig.name,
          commandOptions: ['Subscribe'],
          interval: SUBSCRIPTION_INTERVAL_MS,
        }],
      };

      try {
        const response = await this.sendCommand(request);
        const cmd = response[0];
        if (cmd && cmd.error !== undefined && cmd.error !== 0) {
          debugWarn('interface', `[twincat-hmi] Subscription error for ${sig.name}: ${cmd.errorMessage ?? `error ${cmd.error}`}`);
          continue;
        }
        this.subscriptionIds.set(sig.name, id);
        this.subscriptionIdSet.add(id);
      } catch (err) {
        debugWarn('interface', `[twincat-hmi] Failed to subscribe to ${sig.name}: ${err}`);
      }
    }
  }

  // ── URL Building ──

  /**
   * Build the WebSocket URL with protocol-specific ports.
   * SSL on:  wss://address:1020/
   * SSL off: ws://address:1010/
   * With auth token: ws://address:1010/?cid=TOKEN
   */
  private buildUrl(settings: InterfaceSettings): string {
    const scheme = settings.wsUseSSL ? 'wss' : 'ws';
    const port = settings.wsUseSSL ? 1020 : 1010;
    let url = `${scheme}://${settings.wsAddress}:${port}/`;

    if (settings.wsAuthToken) {
      url += `?cid=${encodeURIComponent(settings.wsAuthToken)}`;
    }

    return url;
  }

  // ── ID Allocation ──

  /**
   * Allocate a unique request ID with overflow protection.
   * Wraps around at 0x7FFFFFFF to stay within safe integer range.
   */
  private allocateId(): number {
    const id = this.nextId;
    this.nextId = this.nextId >= 0x7FFFFFFF ? 1 : this.nextId + 1;
    return id;
  }
}
