// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * WebSocket Realtime adapter — import_answer registration test (R15, viewer side).
 *
 * Verifies that an `import_answer` carrying both signalTypes AND values registers
 * every signal in the SignalStore with the correct type/direction, and that a
 * subsequent `data` delta updates those signals. This is the viewer-side guard
 * against "import_answer without values → 0 signals registered".
 */

import { describe, it, expect, vi } from 'vitest';
import { WebSocketRealtimeInterface } from '../src/interfaces/websocket-realtime-interface';
import type { InterfaceSettings } from '../src/interfaces/interface-settings-store';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import type { RVViewer } from '../src/core/rv-viewer';
import { SignalStore } from '../src/core/engine/rv-signal-store';

// ── Mock WebSocket ──────────────────────────────────────────────────────────

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
  close = vi.fn(() => { this.readyState = MockWebSocket.CLOSED; });

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  simulateMessage(data: string): void {
    this.onmessage?.({ data });
  }
}

function defaultSettings(): InterfaceSettings {
  return {
    activeType: 'websocket-realtime',
    autoConnect: false,
    reconnectIntervalMs: 3000,
    wsAddress: '127.0.0.1',
    wsPort: 8080,
    wsUseSSL: false,
    wsPath: '/',
    wsAuthToken: '',
    mqttBrokerUrl: '',
    mqttUsername: '',
    mqttPassword: '',
    mqttTopicPrefix: '',
  } as InterfaceSettings;
}

/** Minimal RVViewer stub exposing a real SignalStore. */
function stubViewer(signalStore: SignalStore): RVViewer {
  return {
    signalStore,
    emit: vi.fn(),
    on: vi.fn(),
    setConnectionState: vi.fn(),
  } as unknown as RVViewer;
}

describe('WebSocketRealtimeInterface — import_answer registration', () => {
  it('importAnswerThenData: registers all signals with correct types, then applies data delta', async () => {
    const signalStore = new SignalStore();
    const iface = new WebSocketRealtimeInterface();

    // Wire the viewer/signalStore via the plugin lifecycle.
    iface.onModelLoaded({} as LoadResult, stubViewer(signalStore));

    // Intercept the WebSocket constructor.
    let mockWs!: MockWebSocket;
    const OriginalWebSocket = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = class extends MockWebSocket {
      constructor(_url: string) {
        super();
        mockWs = this;
        setTimeout(() => this.simulateOpen(), 0);
      }
    } as unknown as typeof WebSocket;
    (globalThis.WebSocket as unknown as Record<string, number>).OPEN = MockWebSocket.OPEN;
    (globalThis.WebSocket as unknown as Record<string, number>).CONNECTING = MockWebSocket.CONNECTING;

    try {
      const connectPromise = iface.connect(defaultSettings());

      // Wait a tick for the mock to open and for import_request to be sent.
      await new Promise(r => setTimeout(r, 5));

      // Server answers with TYPES and VALUES (R15).
      mockWs.simulateMessage(JSON.stringify({
        type: 'import_answer',
        version: 2,
        signalTypes: {
          Motor_Start: 'PLCInputBool',
          ActualTemp: 'PLCInputInt',
          Pressure: 'PLCInputFloat',
        },
        signals: {
          Motor_Start: false,
          ActualTemp: 234,
          Pressure: 1.5,
        },
      }));

      await connectPromise;

      // All 3 signals discovered with the correct type + direction.
      const discovered = iface.discoveredSignals;
      expect(discovered).toHaveLength(3);
      const byName = Object.fromEntries(discovered.map(s => [s.name, s]));
      expect(byName['Motor_Start'].type).toBe('bool');
      expect(byName['Motor_Start'].direction).toBe('input');
      expect(byName['ActualTemp'].type).toBe('int');
      expect(byName['Pressure'].type).toBe('float');

      // All 3 registered in the SignalStore with their initial values.
      expect(signalStore.get('Motor_Start')).toBe(false);
      expect(signalStore.get('ActualTemp')).toBe(234);
      expect(signalStore.get('Pressure')).toBe(1.5);

      // A subsequent data delta is buffered and flushed to the store.
      mockWs.simulateMessage(JSON.stringify({
        type: 'data',
        version: 2,
        signals: { Motor_Start: true, ActualTemp: 240 },
      }));
      // Flush the incoming buffer (normally driven by onFixedUpdatePre).
      iface.onFixedUpdatePre(0.016);

      expect(signalStore.get('Motor_Start')).toBe(true);
      expect(signalStore.get('ActualTemp')).toBe(240);
      // Unchanged signal keeps its value.
      expect(signalStore.get('Pressure')).toBe(1.5);
    } finally {
      iface.disconnect();
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = OriginalWebSocket;
    }
  });
});
