// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MqttInterface -- MQTT over WebSocket interface implementation.
 *
 * Connects to an MQTT broker via WebSocket (ws:// or wss://) using mqtt.js.
 * Implements signal discovery via wildcard subscription on retained messages
 * and bidirectional signal exchange (subscribe + publish).
 *
 * mqtt.js built-in reconnect is DISABLED (reconnectPeriod: 0) to avoid
 * conflicting with BaseIndustrialInterface's exponential backoff reconnect.
 */

import {
  BaseIndustrialInterface,
  type SignalDescriptor,
  type SignalDirection,
  type SignalType,
} from './base-industrial-interface';
import type { InterfaceSettings } from './interface-settings-store';
import { debug } from '../core/engine/rv-debug';

// ── mqtt.js type imports (runtime-loaded via dynamic import) ──

/** Minimal type for the mqtt.js MqttClient we use. */
interface MqttClient {
  on(event: 'message', cb: (topic: string, payload: Uint8Array) => void): this;
  on(event: 'error', cb: (err: Error) => void): this;
  on(event: 'close', cb: () => void): this;
  removeAllListeners(): this;
  subscribe(topic: string, opts: { qos: 0 | 1 | 2 }, cb?: (err: Error | null) => void): this;
  publish(topic: string, message: string, opts: { qos: 0 | 1 | 2; retain: boolean }, cb?: (err?: Error) => void): this;
  end(force?: boolean, cb?: () => void): this;
  connected: boolean;
}

/** Minimal type for mqtt.js module's connectAsync function. */
interface MqttModule {
  connectAsync(brokerUrl: string, opts: Record<string, unknown>): Promise<MqttClient>;
}

// ── Topic Parsing Utilities (exported for testing) ──

/**
 * Normalize a topic prefix to ensure it ends with '/' (or is empty).
 */
export function normalizePrefix(prefix: string): string {
  if (!prefix) return '';
  return prefix.endsWith('/') ? prefix : prefix + '/';
}

/**
 * Remove the topic prefix from a full topic string.
 * Returns the remainder after the prefix.
 */
export function topicToSignalName(topic: string, prefix: string): string {
  const normalized = normalizePrefix(prefix);
  if (normalized && topic.startsWith(normalized)) {
    return topic.slice(normalized.length);
  }
  return topic;
}

/**
 * Detect signal direction from topic structure (PLC perspective, same nomenclature as Unity).
 * The 'in/' and 'out/' subfolders are named from the PLC's perspective:
 *   '{prefix}out/' = a PLC output (PLC writes, viewer reads)  → direction 'output' (viewer subscribes only).
 *   '{prefix}in/'  = a PLC input  (PLC reads, viewer writes)  → direction 'input'  (viewer publishes).
 * All other topics default to 'output' (display-only / read-only).
 */
export function detectDirection(topicWithoutPrefix: string): SignalDirection {
  if (topicWithoutPrefix.startsWith('out/')) return 'output';
  if (topicWithoutPrefix.startsWith('in/')) return 'input';
  return 'output';
}

/**
 * Remove direction subfolder (in/ or out/) from the signal name.
 */
export function stripDirectionPrefix(name: string): string {
  if (name.startsWith('in/')) return name.slice(3);
  if (name.startsWith('out/')) return name.slice(4);
  return name;
}

/**
 * Detect signal type from payload string.
 * Matches C# MQTTInterface.DetermineSignalType logic:
 *   "true"/"false"/"0"/"1" -> bool
 *   integer-parseable      -> int
 *   float-parseable        -> float (fallback)
 */
export function detectSignalType(payload: string): SignalType {
  const lower = payload.toLowerCase().trim();
  if (lower === 'true' || lower === 'false') return 'bool';
  // "0" and "1" alone are bool (matching C# convention)
  if (lower === '0' || lower === '1') return 'bool';
  // Check integer (no decimal point, no exponent)
  if (/^-?\d+$/.test(lower)) return 'int';
  // Check float (has decimal point or exponent)
  if (!isNaN(Number(lower)) && lower !== '') return 'float';
  // Fallback
  return 'float';
}

/**
 * Parse a payload string to a typed value.
 */
export function parsePayloadValue(text: string): boolean | number {
  const lower = text.toLowerCase().trim();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  const num = Number(lower);
  if (!isNaN(num)) return num;
  return 0; // fallback
}

// ── MqttInterface ──

export class MqttInterface extends BaseIndustrialInterface {
  readonly id = 'mqtt';
  readonly protocolName = 'MQTT';

  private client: MqttClient | null = null;
  private topicToSignalMap = new Map<string, string>();
  private signalToTopicMap = new Map<string, string>();
  private _topicPrefix = '';
  private readonly decoder = new TextDecoder();
  private _discoveryAborted = false;

  /** Discovery timeout in milliseconds. Override in tests for faster execution. */
  protected discoveryTimeoutMs = 5000;

  // ── Protocol Implementation ──

  protected async doConnect(settings: InterfaceSettings): Promise<void> {
    const mqtt = await import('mqtt') as unknown as MqttModule;

    this._topicPrefix = normalizePrefix(settings.mqttTopicPrefix);
    this._discoveryAborted = false;
    const clientId = `rv-webviewer-${crypto.randomUUID()}`;

    debug('interface', `[mqtt] Connecting to ${settings.mqttBrokerUrl} (prefix: "${this._topicPrefix}", clientId: ${clientId})`);

    this.client = await mqtt.connectAsync(settings.mqttBrokerUrl, {
      username: settings.mqttUsername || undefined,
      password: settings.mqttPassword || undefined,
      clientId,
      clean: true,
      reconnectPeriod: 0, // Disable mqtt.js reconnect — BaseIndustrialInterface handles it
      connectTimeout: 5000,
    });

    this.client.on('message', (topic: string, payload: Uint8Array) => {
      this.handleMessage(topic, payload);
    });

    this.client.on('error', (err: Error) => {
      this.onProtocolError(`MQTT error: ${err.message}`);
    });

    this.client.on('close', () => {
      this.onConnectionLost('MQTT connection closed');
    });

    debug('interface', '[mqtt] Connected successfully');
  }

  protected doDisconnect(): void {
    this._discoveryAborted = true;
    if (this.client) {
      this.client.removeAllListeners();
      this.client.end(true);
      this.client = null;
    }
    this.topicToSignalMap.clear();
    this.signalToTopicMap.clear();
  }

  protected async doDiscoverSignals(): Promise<SignalDescriptor[]> {
    if (!this.client) return [];

    const discovered = new Map<string, SignalDescriptor & { topic: string }>();
    const subscriptionTopic = this._topicPrefix ? `${this._topicPrefix}#` : '#';
    let discoveryDone = false;

    return new Promise<SignalDescriptor[]>((resolve) => {
      const onDiscoveryMessage = (topic: string, payload: Uint8Array) => {
        if (discoveryDone) return;
        const text = this.decoder.decode(payload);
        const nameWithDir = topicToSignalName(topic, this._topicPrefix);
        const direction = detectDirection(nameWithDir);
        const signalName = stripDirectionPrefix(nameWithDir);
        const type = detectSignalType(text);
        const initialValue = parsePayloadValue(text);

        discovered.set(topic, { name: signalName, type, direction, initialValue, topic });
      };

      this.client!.on('message', onDiscoveryMessage);

      this.client!.subscribe(subscriptionTopic, { qos: 1 }, (err) => {
        if (err) {
          debug('interface', `[mqtt] Subscribe error: ${err.message}`);
        }
      });

      setTimeout(() => {
        discoveryDone = true;

        // Abort if disconnected during discovery
        if (this._discoveryAborted) {
          resolve([]);
          return;
        }

        const signals: SignalDescriptor[] = [];
        for (const [topic, desc] of discovered) {
          this.topicToSignalMap.set(topic, desc.name);
          this.signalToTopicMap.set(desc.name, topic);
          signals.push({ name: desc.name, type: desc.type, direction: desc.direction, initialValue: desc.initialValue });
        }

        debug('interface', `[mqtt] Discovery complete: ${signals.length} signals found`);
        resolve(signals);
      }, this.discoveryTimeoutMs);
    });
  }

  protected sendSignals(signals: Record<string, boolean | number>): void {
    if (!this.client) return;

    for (const name in signals) {
      const topic = this.signalToTopicMap.get(name) ?? `${this._topicPrefix}${name}`;
      const payload = String(signals[name]);

      this.client.publish(topic, payload, { qos: 1, retain: true }, (err) => {
        if (err) {
          this.onProtocolError(`Publish failed for ${topic}: ${err.message}`);
        }
      });
    }
  }

  // ── Internal ──

  private handleMessage(topic: string, payload: Uint8Array): void {
    const text = this.decoder.decode(payload);
    const nameWithDir = topicToSignalName(topic, this._topicPrefix);
    const signalName = stripDirectionPrefix(nameWithDir);
    const value = parsePayloadValue(text);

    // Register topic mapping if not already known (live signal discovery)
    if (!this.topicToSignalMap.has(topic)) {
      this.topicToSignalMap.set(topic, signalName);
      this.signalToTopicMap.set(signalName, topic);
    }

    this.bufferIncoming({ [signalName]: value });
  }
}
