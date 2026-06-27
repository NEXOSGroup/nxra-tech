// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TwinCatHmiInterface Tests
 *
 * Validates TcHmi protocol command building, response parsing, type mapping,
 * lifecycle management, and edge-case robustness.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TwinCatHmiInterface,
  mapTcHmiType,
  mapTcHmiAccess,
  type TcHmiRequest,
  type TcHmiResponse,
} from '../src/interfaces/twincat-hmi-interface';
import type { InterfaceSettings } from '../src/interfaces/interface-settings-store';

// ── Mock WebSocket ──────────────────────────────────────────────────────

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;

  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });

  /** Simulate the server accepting the connection. */
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  /** Simulate a message from the server. */
  simulateMessage(data: string): void {
    this.onmessage?.({ data });
  }

  /** Simulate the connection closing. */
  simulateClose(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

// ── Test Helpers ─────────────────────────────────────────────────────────

function defaultSettings(overrides?: Partial<InterfaceSettings>): InterfaceSettings {
  return {
    activeType: 'twincat-hmi',
    autoConnect: false,
    reconnectIntervalMs: 3000,
    wsAddress: '192.168.1.100',
    wsPort: 1010,
    wsUseSSL: false,
    wsPath: '/',
    wsAuthToken: '',
    mqttBrokerUrl: '',
    mqttUsername: '',
    mqttPassword: '',
    mqttTopicPrefix: '',
    ...overrides,
  };
}

/**
 * Helper: create a TwinCatHmiInterface, mock the global WebSocket,
 * connect it, and return both the interface and the mock WS.
 */
async function createConnectedInterface(
  settingsOverrides?: Partial<InterfaceSettings>,
): Promise<{ iface: TwinCatHmiInterface; mockWs: MockWebSocket }> {
  const iface = new TwinCatHmiInterface();
  let mockWs!: MockWebSocket;

  // Intercept WebSocket constructor
  const OriginalWebSocket = globalThis.WebSocket;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = class extends MockWebSocket {
    constructor(_url: string) {
      super();
      mockWs = this;
      // Auto-open on next tick so the connect promise resolves
      setTimeout(() => this.simulateOpen(), 0);
    }
  } as unknown as typeof WebSocket;

  // Also need the static constants on the prototype for readyState checks
  (globalThis.WebSocket as unknown as Record<string, number>).OPEN = MockWebSocket.OPEN;
  (globalThis.WebSocket as unknown as Record<string, number>).CONNECTING = MockWebSocket.CONNECTING;

  const settings = defaultSettings(settingsOverrides);

  try {
    // connect() calls doConnect internally — use the internal method via the public API
    await (iface as unknown as { doConnect(s: InterfaceSettings): Promise<void> }).doConnect(settings);
  } finally {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = OriginalWebSocket;
  }

  return { iface, mockWs };
}

// ── Type Mapping Tests ──────────────────────────────────────────────────

describe('mapTcHmiType', () => {
  it('maps BOOL to bool', () => {
    expect(mapTcHmiType('BOOL')).toBe('bool');
    expect(mapTcHmiType('bool')).toBe('bool');
  });

  it('maps INT/DINT/WORD to int', () => {
    expect(mapTcHmiType('INT')).toBe('int');
    expect(mapTcHmiType('UINT')).toBe('int');
    expect(mapTcHmiType('SINT')).toBe('int');
    expect(mapTcHmiType('DINT')).toBe('int');
    expect(mapTcHmiType('UDINT')).toBe('int');
    expect(mapTcHmiType('WORD')).toBe('int');
    expect(mapTcHmiType('DWORD')).toBe('int');
    expect(mapTcHmiType('BYTE')).toBe('int');
  });

  it('maps REAL/LREAL to float', () => {
    expect(mapTcHmiType('REAL')).toBe('float');
    expect(mapTcHmiType('LREAL')).toBe('float');
  });

  it('maps undefined type to float (default)', () => {
    expect(mapTcHmiType(undefined)).toBe('float');
    expect(mapTcHmiType('')).toBe('float');
  });

  it('maps unknown types to float', () => {
    expect(mapTcHmiType('CUSTOM_TYPE')).toBe('float');
  });
});

describe('mapTcHmiAccess', () => {
  // PLC perspective: a 'write' symbol is a PLC input (viewer writes it); everything else
  // is a PLC output (viewer reads it, read-only).
  it('maps read access to output direction', () => {
    expect(mapTcHmiAccess('read')).toBe('output');
    expect(mapTcHmiAccess('Read')).toBe('output');
  });

  it('maps write access to input direction', () => {
    expect(mapTcHmiAccess('write')).toBe('input');
    expect(mapTcHmiAccess('Write')).toBe('input');
  });

  it('maps readwrite/undefined to output (default)', () => {
    expect(mapTcHmiAccess('readwrite')).toBe('output');
    expect(mapTcHmiAccess(undefined)).toBe('output');
    expect(mapTcHmiAccess('')).toBe('output');
  });
});

// ── Command Building Tests ──────────────────────────────────────────────

describe('TwinCatHmiInterface - Command Building', () => {
  it('builds correct ReadWrite command JSON', async () => {
    const { iface, mockWs } = await createConnectedInterface();

    // Trigger sendSignals (which builds a ReadWrite command)
    const sendSignals = (iface as unknown as {
      sendSignals(signals: Record<string, boolean | number>): void;
    }).sendSignals.bind(iface);

    sendSignals({ 'PLC1.MAIN.bStart': true });

    expect(mockWs.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(mockWs.send.mock.calls[0][0] as string) as TcHmiRequest;
    expect(sent.requestType).toBe('ReadWrite');
    expect(sent.commands).toHaveLength(1);
    expect(sent.commands[0].symbol).toBe('PLC1.MAIN.bStart');
    expect(sent.commands[0].commandOptions).toEqual(['SendWriteValue']);
    expect(sent.commands[0].writeValue).toBe(true);
  });

  it('builds correct Subscription command JSON', async () => {
    const { iface, mockWs } = await createConnectedInterface();

    // Access private subscribeAll via doDiscoverSignals simulation
    const subscribeAll = (iface as unknown as {
      subscribeAll(symbols: Array<{ name: string; type: string; direction: string; initialValue: boolean | number }>): Promise<void>;
      allocateId(): number;
    });

    // Call subscribeAll directly — it will send subscription commands
    const subscribePromise = (iface as unknown as {
      subscribeAll(symbols: Array<{ name: string; type: string; direction: string; initialValue: boolean | number }>): Promise<void>;
    }).subscribeAll.call(iface, [
      { name: 'PLC1.MAIN.nCounter', type: 'int', direction: 'input', initialValue: 0 },
    ]);

    // Wait for the send call, then simulate response
    await vi.waitFor(() => {
      expect(mockWs.send).toHaveBeenCalled();
    });

    const sent = JSON.parse(mockWs.send.mock.calls[0][0] as string) as TcHmiRequest;
    expect(sent.requestType).toBe('Subscription');
    expect(sent.commands[0].symbol).toBe('PLC1.MAIN.nCounter');
    expect(sent.commands[0].commandOptions).toEqual(['Subscribe']);
    expect(sent.commands[0].interval).toBe(100);

    // Simulate subscription accepted response
    const response: TcHmiResponse = {
      requestType: 'Subscription',
      id: sent.id,
      commands: [{ symbol: 'PLC1.MAIN.nCounter', error: 0 }],
    };
    mockWs.simulateMessage(JSON.stringify(response));
    await subscribePromise;
  });

  it('builds correct WriteValue with batched signals', async () => {
    const { iface, mockWs } = await createConnectedInterface();

    const sendSignals = (iface as unknown as {
      sendSignals(signals: Record<string, boolean | number>): void;
    }).sendSignals.bind(iface);

    sendSignals({
      'PLC1.MAIN.bStart': true,
      'PLC1.MAIN.nSpeed': 500,
      'PLC1.MAIN.rTemp': 23.5,
    });

    const sent = JSON.parse(mockWs.send.mock.calls[0][0] as string) as TcHmiRequest;
    expect(sent.commands).toHaveLength(3);
    expect(sent.commands[0].writeValue).toBe(true);
    expect(sent.commands[1].writeValue).toBe(500);
    expect(sent.commands[2].writeValue).toBe(23.5);
  });
});

// ── Response Parsing Tests ──────────────────────────────────────────────

describe('TwinCatHmiInterface - Response Parsing', () => {
  it('parses ListSymbols response to SignalDescriptors', async () => {
    const { iface, mockWs } = await createConnectedInterface();

    // Auto-respond to every send: first one is ListSymbols, rest are Subscriptions
    let sendCount = 0;
    mockWs.send = vi.fn((data: string) => {
      sendCount++;
      const req = JSON.parse(data) as TcHmiRequest;

      if (sendCount === 1) {
        // ListSymbols response
        setTimeout(() => {
          mockWs.simulateMessage(JSON.stringify({
            requestType: 'ReadWrite',
            id: req.id,
            commands: [{
              symbol: 'ListSymbols',
              readValue: {
                'PLC1.MAIN.bStart': { type: 'BOOL', accessRights: 'readwrite' },
                'PLC1.MAIN.nCounter': { type: 'INT', accessRights: 'read' },
                'PLC1.MAIN.rTemp': { type: 'REAL', accessRights: 'write' },
                'PLC1.MAIN.sName': { type: 'STRING', accessRights: 'read' },
              },
              error: 0,
            }],
          }));
        }, 0);
      } else {
        // Subscription response
        setTimeout(() => {
          mockWs.simulateMessage(JSON.stringify({
            requestType: 'Subscription',
            id: req.id,
            commands: [{ symbol: req.commands[0].symbol, error: 0 }],
          }));
        }, 0);
      }
    });

    const signals = await (iface as unknown as {
      doDiscoverSignals(): Promise<Array<{ name: string; type: string; direction: string; initialValue: boolean | number }>>;
    }).doDiscoverSignals.call(iface);

    // STRING should be filtered out
    expect(signals).toHaveLength(3);
    // PLC perspective: readwrite/read → 'output' (viewer reads), write → 'input' (viewer writes).
    expect(signals.find((s: { name: string }) => s.name === 'PLC1.MAIN.bStart')).toMatchObject({
      type: 'bool', direction: 'output',
    });
    expect(signals.find((s: { name: string }) => s.name === 'PLC1.MAIN.nCounter')).toMatchObject({
      type: 'int', direction: 'output',
    });
    expect(signals.find((s: { name: string }) => s.name === 'PLC1.MAIN.rTemp')).toMatchObject({
      type: 'float', direction: 'input',
    });
    // STRING signal should NOT be present
    expect(signals.find((s: { name: string }) => s.name === 'PLC1.MAIN.sName')).toBeUndefined();

    // Verify that 4 sends happened: 1 ListSymbols + 3 subscriptions
    expect(sendCount).toBe(4);
  });

  it('handles ListSymbols with error !== 0 gracefully', async () => {
    const { iface, mockWs } = await createConnectedInterface();

    const discoverPromise = (iface as unknown as {
      doDiscoverSignals(): Promise<Array<{ name: string }>>;
    }).doDiscoverSignals.call(iface);

    await vi.waitFor(() => {
      expect(mockWs.send).toHaveBeenCalled();
    });

    const listRequest = JSON.parse(mockWs.send.mock.calls[0][0] as string) as TcHmiRequest;

    mockWs.simulateMessage(JSON.stringify({
      requestType: 'ReadWrite',
      id: listRequest.id,
      commands: [{ symbol: 'ListSymbols', error: 1, errorMessage: 'Not supported' }],
    }));

    const signals = await discoverPromise;
    expect(signals).toHaveLength(0);
  });
});

// ── Lifecycle Tests ─────────────────────────────────────────────────────

describe('TwinCatHmiInterface - Lifecycle', () => {
  it('doDisconnect rejects all pending requests and clears timeouts', async () => {
    const { iface, mockWs } = await createConnectedInterface();

    // Create a pending request via sendCommand directly (lower level than doDiscoverSignals)
    const sendCommand = (iface as unknown as {
      sendCommand(request: TcHmiRequest): Promise<unknown>;
      allocateId(): number;
    });

    const reqId = sendCommand.allocateId.call(iface);
    const pendingPromise = sendCommand.sendCommand.call(iface, {
      requestType: 'ReadWrite' as const,
      id: reqId,
      commands: [{ symbol: 'TestSymbol' }],
    });

    // Verify request is pending
    expect((iface as unknown as { pendingRequests: Map<number, unknown> }).pendingRequests.size).toBe(1);

    // Disconnect while request is pending
    (iface as unknown as { doDisconnect(): void }).doDisconnect.call(iface);

    // The pending request should reject with 'Disconnected'
    await expect(pendingPromise).rejects.toThrow('Disconnected');

    // Verify cleanup
    expect((iface as unknown as { pendingRequests: Map<number, unknown> }).pendingRequests.size).toBe(0);
    expect((iface as unknown as { subscriptionIds: Map<string, number> }).subscriptionIds.size).toBe(0);
  });

  it('allocateId wraps around at 0x7FFFFFFF', () => {
    const iface = new TwinCatHmiInterface();
    // Set nextId to just before overflow
    (iface as unknown as { nextId: number }).nextId = 0x7FFFFFFF;

    const id1 = (iface as unknown as { allocateId(): number }).allocateId.call(iface);
    expect(id1).toBe(0x7FFFFFFF);

    // Next should wrap to 1
    const id2 = (iface as unknown as { allocateId(): number }).allocateId.call(iface);
    expect(id2).toBe(1);
  });

  it('buildUrl uses protocol-specific ports (1010/1020)', () => {
    const iface = new TwinCatHmiInterface();
    const buildUrl = (iface as unknown as {
      buildUrl(settings: InterfaceSettings): string;
    }).buildUrl.bind(iface);

    // HTTP -> port 1010
    const httpUrl = buildUrl(defaultSettings({ wsUseSSL: false }));
    expect(httpUrl).toBe('ws://192.168.1.100:1010/');

    // HTTPS -> port 1020
    const httpsUrl = buildUrl(defaultSettings({ wsUseSSL: true }));
    expect(httpsUrl).toBe('wss://192.168.1.100:1020/');
  });

  it('buildUrl includes auth token as ?cid= when provided', () => {
    const iface = new TwinCatHmiInterface();
    const buildUrl = (iface as unknown as {
      buildUrl(settings: InterfaceSettings): string;
    }).buildUrl.bind(iface);

    const url = buildUrl(defaultSettings({ wsAuthToken: 'my-session-token' }));
    expect(url).toBe('ws://192.168.1.100:1010/?cid=my-session-token');
  });

  it('buildUrl omits ?cid= when token is empty', () => {
    const iface = new TwinCatHmiInterface();
    const buildUrl = (iface as unknown as {
      buildUrl(settings: InterfaceSettings): string;
    }).buildUrl.bind(iface);

    const url = buildUrl(defaultSettings({ wsAuthToken: '' }));
    expect(url).toBe('ws://192.168.1.100:1010/');
  });

  it('handleMessage does not crash on malformed JSON', async () => {
    const { iface, mockWs: _mockWs } = await createConnectedInterface();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Simulate malformed JSON — should not throw
    const handleMessage = (iface as unknown as {
      handleMessage(raw: string): void;
    }).handleMessage.bind(iface);

    expect(() => handleMessage('{{invalid json')).not.toThrow();
    expect(() => handleMessage('')).not.toThrow();
    expect(() => handleMessage('not json at all')).not.toThrow();

    errorSpy.mockRestore();
  });

  it('sendSignals skips when WS not OPEN', async () => {
    const { iface, mockWs } = await createConnectedInterface();

    // Close the WebSocket
    mockWs.readyState = MockWebSocket.CLOSED;

    const sendSignals = (iface as unknown as {
      sendSignals(signals: Record<string, boolean | number>): void;
    }).sendSignals.bind(iface);

    // Should not throw, should not call send
    expect(() => sendSignals({ 'PLC1.MAIN.bStart': true })).not.toThrow();
    expect(mockWs.send).not.toHaveBeenCalled();
  });

  it('subscription update for unknown symbol does not crash', async () => {
    const { iface } = await createConnectedInterface();

    const handleMessage = (iface as unknown as {
      handleMessage(raw: string): void;
    }).handleMessage.bind(iface);

    // A subscription update with an ID that is NOT in subscriptionIds
    // should be treated as a regular response (no pending → ignored silently)
    const msg: TcHmiResponse = {
      requestType: 'Subscription',
      id: 99999,
      commands: [{ symbol: 'PLC1.UNKNOWN.var', readValue: 42 }],
    };

    expect(() => handleMessage(JSON.stringify(msg))).not.toThrow();
  });
});

// ── Subscription Update Buffering ───────────────────────────────────────

describe('TwinCatHmiInterface - Subscription Updates', () => {
  it('buffers incoming subscription updates', async () => {
    const { iface, mockWs } = await createConnectedInterface();

    // Manually register a subscription ID to simulate active subscription
    const subscriptionIds = (iface as unknown as { subscriptionIds: Map<string, number> }).subscriptionIds;
    const subscriptionIdSet = (iface as unknown as { subscriptionIdSet: Set<number> }).subscriptionIdSet;
    subscriptionIds.set('PLC1.MAIN.nCounter', 42);
    subscriptionIdSet.add(42);

    // Simulate subscription update
    const update: TcHmiResponse = {
      requestType: 'Subscription',
      id: 42,
      commands: [{ symbol: 'PLC1.MAIN.nCounter', readValue: 123, error: 0 }],
    };
    mockWs.simulateMessage(JSON.stringify(update));

    // Check that pendingIncoming has the value
    const pending = (iface as unknown as { pendingIncoming: Map<string, boolean | number> }).pendingIncoming;
    expect(pending.get('PLC1.MAIN.nCounter')).toBe(123);
  });

  it('handles boolean subscription updates', async () => {
    const { iface, mockWs } = await createConnectedInterface();

    const subscriptionIds = (iface as unknown as { subscriptionIds: Map<string, number> }).subscriptionIds;
    const subscriptionIdSet = (iface as unknown as { subscriptionIdSet: Set<number> }).subscriptionIdSet;
    subscriptionIds.set('PLC1.MAIN.bStart', 10);
    subscriptionIdSet.add(10);

    mockWs.simulateMessage(JSON.stringify({
      requestType: 'Subscription',
      id: 10,
      commands: [{ symbol: 'PLC1.MAIN.bStart', readValue: true, error: 0 }],
    }));

    const pending = (iface as unknown as { pendingIncoming: Map<string, boolean | number> }).pendingIncoming;
    expect(pending.get('PLC1.MAIN.bStart')).toBe(true);
  });

  it('skips subscription commands with errors', async () => {
    const { iface, mockWs } = await createConnectedInterface();

    const subscriptionIds = (iface as unknown as { subscriptionIds: Map<string, number> }).subscriptionIds;
    const subscriptionIdSet = (iface as unknown as { subscriptionIdSet: Set<number> }).subscriptionIdSet;
    subscriptionIds.set('PLC1.MAIN.nCounter', 42);
    subscriptionIdSet.add(42);

    mockWs.simulateMessage(JSON.stringify({
      requestType: 'Subscription',
      id: 42,
      commands: [{ symbol: 'PLC1.MAIN.nCounter', readValue: 999, error: 3, errorMessage: 'Symbol not found' }],
    }));

    const pending = (iface as unknown as { pendingIncoming: Map<string, boolean | number> }).pendingIncoming;
    expect(pending.has('PLC1.MAIN.nCounter')).toBe(false);
  });
});
