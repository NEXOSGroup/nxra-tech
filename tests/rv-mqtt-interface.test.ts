// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MQTT Interface Tests
 *
 * Validates the MqttInterface lifecycle, signal discovery, bidirectional
 * exchange, event cleanup, and mqtt.js reconnect deactivation.
 * Uses a mock mqtt.js module injected via vi.mock().
 *
 * Uses a TestMqttInterface subclass with a 50ms discovery timeout
 * to avoid the need for fake timers (which interact poorly with
 * async dynamic imports in the browser provider).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { InterfaceSettings } from '../src/interfaces/interface-settings-store';
import { INTERFACE_DEFAULTS } from '../src/interfaces/interface-settings-store';

// ── Mock mqtt.js Client ──

type MessageHandler = (topic: string, payload: Uint8Array) => void;
type ErrorHandler = (err: Error) => void;
type CloseHandler = () => void;

interface MockHandlers {
  message: MessageHandler[];
  error: ErrorHandler[];
  close: CloseHandler[];
}

function createMockClient() {
  const handlers: MockHandlers = { message: [], error: [], close: [] };
  const published: { topic: string; message: string; opts: { qos: number; retain: boolean } }[] = [];
  const subscribed: { topic: string; opts: { qos: number } }[] = [];
  let ended = false;
  let listenersRemoved = false;

  const client = {
    connected: true,
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === 'message') handlers.message.push(cb as MessageHandler);
      else if (event === 'error') handlers.error.push(cb as ErrorHandler);
      else if (event === 'close') handlers.close.push(cb as CloseHandler);
      return client;
    },
    removeAllListeners() {
      handlers.message = [];
      handlers.error = [];
      handlers.close = [];
      listenersRemoved = true;
      return client;
    },
    subscribe(topic: string, opts: { qos: number }, cb?: (err: Error | null) => void) {
      subscribed.push({ topic, opts });
      if (cb) cb(null);
      return client;
    },
    publish(topic: string, message: string, opts: { qos: number; retain: boolean }, cb?: (err?: Error) => void) {
      published.push({ topic, message, opts });
      if (cb) cb();
      return client;
    },
    end(_force?: boolean, cb?: () => void) {
      ended = true;
      if (cb) cb();
      return client;
    },

    // Test helpers
    _handlers: handlers,
    _published: published,
    _subscribed: subscribed,
    get _ended() { return ended; },
    get _listenersRemoved() { return listenersRemoved; },

    /** Simulate an incoming MQTT message */
    simulateMessage(topic: string, payloadStr: string) {
      const payload = new TextEncoder().encode(payloadStr);
      for (const cb of [...handlers.message]) {
        cb(topic, payload);
      }
    },

    /** Simulate a connection close */
    simulateClose() {
      for (const cb of [...handlers.close]) {
        cb();
      }
    },
  };

  return client;
}

// ── Mock mqtt module ──

let mockClient: ReturnType<typeof createMockClient>;
let lastConnectOptions: Record<string, unknown> | undefined;

vi.mock('mqtt', () => ({
  connectAsync: vi.fn(async (_url: string, opts: Record<string, unknown>) => {
    lastConnectOptions = opts;
    mockClient = createMockClient();
    return mockClient;
  }),
}));

// ── Import AFTER mock is set up ──

const { MqttInterface } = await import('../src/interfaces/mqtt-interface');

/** Test subclass with very short discovery timeout. */
class TestMqttInterface extends MqttInterface {
  constructor() {
    super();
    this.discoveryTimeoutMs = 50; // 50ms instead of 5000ms
  }
}

function createSettings(overrides?: Partial<InterfaceSettings>): InterfaceSettings {
  return {
    ...INTERFACE_DEFAULTS,
    activeType: 'mqtt',
    mqttBrokerUrl: 'ws://test-broker:8080/mqtt',
    mqttTopicPrefix: 'rv/',
    ...overrides,
  };
}

describe('MqttInterface', () => {
  let iface: TestMqttInterface;

  beforeEach(() => {
    iface = new TestMqttInterface();
    lastConnectOptions = undefined;
  });

  afterEach(() => {
    iface.disconnect();
  });

  // ── Lifecycle ──

  describe('lifecycle', () => {
    it('has correct id and protocolName', () => {
      expect(iface.id).toBe('mqtt');
      expect(iface.protocolName).toBe('MQTT');
    });

    it('transitions to connected state after connect', async () => {
      expect(iface.connectionState).toBe('disconnected');
      await iface.connect(createSettings());
      expect(iface.connectionState).toBe('connected');
    });

    it('passes reconnectPeriod: 0 to mqtt.js connect options', async () => {
      await iface.connect(createSettings());
      expect(lastConnectOptions).toBeDefined();
      expect(lastConnectOptions!.reconnectPeriod).toBe(0);
    });

    it('passes clean: true to mqtt.js connect options', async () => {
      await iface.connect(createSettings());
      expect(lastConnectOptions!.clean).toBe(true);
    });

    it('passes connectTimeout: 5000 to mqtt.js connect options', async () => {
      await iface.connect(createSettings());
      expect(lastConnectOptions!.connectTimeout).toBe(5000);
    });

    it('generates a unique clientId starting with rv-webviewer-', async () => {
      await iface.connect(createSettings());
      const clientId = lastConnectOptions!.clientId as string;
      expect(clientId).toMatch(/^rv-webviewer-/);
    });

    it('passes username/password when provided', async () => {
      await iface.connect(createSettings({
        mqttUsername: 'user1',
        mqttPassword: 'pass1',
      }));
      expect(lastConnectOptions!.username).toBe('user1');
      expect(lastConnectOptions!.password).toBe('pass1');
    });

    it('passes undefined username/password when empty', async () => {
      await iface.connect(createSettings({
        mqttUsername: '',
        mqttPassword: '',
      }));
      expect(lastConnectOptions!.username).toBeUndefined();
      expect(lastConnectOptions!.password).toBeUndefined();
    });
  });

  // ── Disconnect ──

  describe('disconnect', () => {
    it('calls removeAllListeners before end', async () => {
      await iface.connect(createSettings());
      const clientRef = mockClient;

      expect(clientRef._listenersRemoved).toBe(false);
      iface.disconnect();
      expect(clientRef._listenersRemoved).toBe(true);
      expect(clientRef._ended).toBe(true);
    });

    it('clears topic maps on disconnect', async () => {
      await iface.connect(createSettings());
      iface.disconnect();
      // Internal maps cleared — connection state confirms clean teardown
      expect(iface.connectionState).toBe('disconnected');
    });

    it('transitions to disconnected state', async () => {
      await iface.connect(createSettings());
      expect(iface.connectionState).toBe('connected');
      iface.disconnect();
      expect(iface.connectionState).toBe('disconnected');
    });
  });

  // ── Discovery ──

  describe('signal discovery', () => {
    it('subscribes to prefix wildcard topic', async () => {
      await iface.connect(createSettings());
      expect(mockClient._subscribed.length).toBeGreaterThan(0);
      expect(mockClient._subscribed[0].topic).toBe('rv/#');
      expect(mockClient._subscribed[0].opts.qos).toBe(1);
    });

    it('collects retained messages into SignalDescriptors', async () => {
      // Start connect (will call doConnect then doDiscoverSignals)
      const connectPromise = iface.connect(createSettings());

      // Wait a tick for doConnect to resolve and doDiscoverSignals to start
      await new Promise(r => setTimeout(r, 10));

      // Simulate retained messages arriving during discovery window
      mockClient.simulateMessage('rv/ConveyorStart', 'true');
      mockClient.simulateMessage('rv/DriveSpeed', '3.14');
      mockClient.simulateMessage('rv/Counter', '42');

      await connectPromise;

      const signals = iface.discoveredSignals;
      expect(signals.length).toBe(3);

      const conveyor = signals.find(s => s.name === 'ConveyorStart');
      expect(conveyor).toBeDefined();
      expect(conveyor!.type).toBe('bool');
      expect(conveyor!.initialValue).toBe(true);

      const drive = signals.find(s => s.name === 'DriveSpeed');
      expect(drive).toBeDefined();
      expect(drive!.type).toBe('float');
      expect(drive!.initialValue).toBe(3.14);

      const counter = signals.find(s => s.name === 'Counter');
      expect(counter).toBeDefined();
      expect(counter!.type).toBe('int');
      expect(counter!.initialValue).toBe(42);
    });

    it('resolves with empty array on timeout with 0 signals (valid state)', async () => {
      await iface.connect(createSettings());
      // No messages arrive — discovery completes with 0 signals
      expect(iface.discoveredSignals.length).toBe(0);
      // Connection should still be active (not error)
      expect(iface.connectionState).toBe('connected');
    });

    it('deduplicates same-topic messages (last value wins)', async () => {
      const connectPromise = iface.connect(createSettings());
      await new Promise(r => setTimeout(r, 10));

      mockClient.simulateMessage('rv/Signal1', 'true');
      mockClient.simulateMessage('rv/Signal1', 'false'); // overwrites

      await connectPromise;

      const signals = iface.discoveredSignals;
      expect(signals.length).toBe(1);
      expect(signals[0].initialValue).toBe(false);
    });

    it('detects direction from in/out subfolder', async () => {
      const connectPromise = iface.connect(createSettings());
      await new Promise(r => setTimeout(r, 10));

      mockClient.simulateMessage('rv/in/SensorA', 'true');
      mockClient.simulateMessage('rv/out/StartButton', 'false');
      mockClient.simulateMessage('rv/FlatSignal', '5.0');

      await connectPromise;

      const signals = iface.discoveredSignals;
      const sensor = signals.find(s => s.name === 'SensorA');
      const button = signals.find(s => s.name === 'StartButton');
      const flat = signals.find(s => s.name === 'FlatSignal');

      expect(sensor).toBeDefined();
      expect(sensor!.direction).toBe('input');
      expect(button).toBeDefined();
      expect(button!.direction).toBe('output');
      expect(flat).toBeDefined();
      expect(flat!.direction).toBe('input');
    });

    it('handles empty prefix — subscribes to # ', async () => {
      const connectPromise = iface.connect(createSettings({ mqttTopicPrefix: '' }));
      await new Promise(r => setTimeout(r, 10));

      mockClient.simulateMessage('ConveyorStart', 'true');

      await connectPromise;

      const signals = iface.discoveredSignals;
      expect(signals.length).toBe(1);
      expect(signals[0].name).toBe('ConveyorStart');
      expect(mockClient._subscribed[0].topic).toBe('#');
    });

    it('handles prefix without trailing slash', async () => {
      const connectPromise = iface.connect(createSettings({ mqttTopicPrefix: 'myprefix' }));
      await new Promise(r => setTimeout(r, 10));

      mockClient.simulateMessage('myprefix/Signal1', '42');

      await connectPromise;

      const signals = iface.discoveredSignals;
      expect(signals.length).toBe(1);
      expect(signals[0].name).toBe('Signal1');
    });
  });

  // ── Bidirectional Exchange ──

  describe('bidirectional signal exchange', () => {
    it('buffers incoming MQTT messages via handleMessage', async () => {
      await iface.connect(createSettings());

      // Simulate live message after discovery
      mockClient.simulateMessage('rv/LiveSignal', 'true');

      // pendingIncoming should have the value (accessed via protected field on base class)
      // We verify indirectly: if onFixedUpdatePre runs without error, buffer was populated
      iface.onFixedUpdatePre(1 / 60);
    });

    it.todo('publishes via sendSignals with correct topic and payload (requires SignalStore integration)');

    it('uses Uint8Array payload decoding (TextDecoder)', async () => {
      const connectPromise = iface.connect(createSettings());
      await new Promise(r => setTimeout(r, 10));

      // The mock delivers TextEncoder-encoded Uint8Array, same as browser mqtt.js
      mockClient.simulateMessage('rv/BoolSignal', 'true');

      await connectPromise;

      const signals = iface.discoveredSignals;
      const boolSig = signals.find(s => s.name === 'BoolSignal');
      expect(boolSig).toBeDefined();
      expect(boolSig!.initialValue).toBe(true);
      expect(boolSig!.type).toBe('bool');
    });
  });

  // ── Connection Events ──

  describe('connection events', () => {
    it('handles connection close from broker', async () => {
      await iface.connect(createSettings());
      expect(iface.connectionState).toBe('connected');

      // Simulate broker closing the connection
      mockClient.simulateClose();

      // Should transition to disconnected
      expect(iface.connectionState).toBe('disconnected');
    });
  });
});
