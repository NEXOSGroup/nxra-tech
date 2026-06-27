// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * McpBridgePlugin — WebSocket bridge connecting the browser to the local MCP bridge server.
 *
 * On start, connects to ws://localhost:18714/webviewer and sends a `discover`
 * message containing tool schemas (generated from @McpTool decorators) and the
 * webviewer.mcp.md instructions file. The bridge server registers these as
 * `web_*` MCP tools. When Claude calls a web_* tool, the bridge forwards the
 * call via WebSocket and this plugin dispatches it to the decorated method.
 *
 * The bridge server also streams its own log lines back (type `log`); this plugin
 * buffers them and re-emits `mcp-bridge-log` for the UI. Control messages
 * (type `control`: pause / resume / shutdown) let the UI steer the server.
 *
 * Auto-reconnects with exponential backoff (1s -> 30s max).
 * DEV-only OR gated behind ?mcp=1 URL param.
 */

import { RVBehavior } from '../core/rv-behavior';
import type { RVViewer } from '../core/rv-viewer';
import { lastPathSegment } from '../core/engine/rv-constants';
import type { RVLogicStep } from '../core/engine/rv-logic-step';
import {
  McpTool,
  McpParam,
  generateToolSchemas,
  buildToolDispatcher,
} from '../core/engine/rv-mcp-tools';
import { getLastLogs, queryLogs } from '../core/engine/rv-debug';
import type { LogLevel } from '../core/engine/rv-debug';
import { Box3, Vector3 } from 'three';
import type { LayoutPlannerPlugin } from './layout-planner';
import type { RvExtrasEditorPlugin } from '../core/hmi/rv-extras-editor';
import { clearBySource } from '../core/hmi/instruction-store';
import { setAiActivity } from '../core/hmi/ai-activity-store';
import type { SnapPointPlugin } from './snap-point';
import type { SnapPoint } from '../core/engine/rv-snap-point-registry';
import type { LibraryCatalogEntry } from './layout-planner/rv-layout-store';
import { oppositeDirection } from './snap-point/snap-name-parser';
import { findCompatibleLibraryAssets } from './snap-point/library-snap-index';
import { getSceneStore } from '../core/hmi/scene/scene-store-singleton';
import { getDriveSpeedOverride, setDriveSpeedOverride } from '../core/engine/rv-speed-override';
import { matchMaterialFlows } from '../core/material-flow/registry';

// Vite raw import — embeds the .md content as a string at build time
import MCP_INSTRUCTIONS from '../../webviewer.mcp.md?raw';

/** Serialize any object's own enumerable properties (primitives + shallow). */
function serializeProps(obj: unknown, maxDepth = 2): Record<string, unknown> {
  if (obj === null || obj === undefined || typeof obj !== 'object') return {};
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (key.startsWith('_')) continue;
    const val = (obj as Record<string, unknown>)[key];
    if (val === undefined || val === null) { result[key] = val; continue; }
    if (typeof val === 'function') continue;
    if (typeof val === 'number') { result[key] = +val.toFixed(4); continue; }
    if (typeof val === 'boolean' || typeof val === 'string') { result[key] = val; continue; }
    if (Array.isArray(val)) continue;
    if (typeof val === 'object') {
      if (maxDepth > 0) result[key] = serializeProps(val, maxDepth - 1);
      continue;
    }
  }
  return result;
}

// ── Types ──

interface CallMessage {
  type: 'call';
  id: number;
  tool: string;
  arguments: Record<string, unknown>;
}

/** Live health of the bridge SERVER process, pushed over the WebSocket. Lets the
 *  UI show the full chain (browser ⟷ bridge ⟷ AI client) instead of only the WS
 *  leg. Null until the (Node) bridge sends its first status frame — the legacy
 *  Python bridge never does, so the UI hides these rows for it. */
export interface BridgeServerStatus {
  pid: number;
  port: number;
  uptimeMs: number;
  clientName: string | null;
  clientVersion: string | null;
  clientConnected: boolean;
  lastRequestAgoMs: number | null;
}

/** Snapshot of the MCP bridge state, emitted on every state transition. */
export interface McpBridgeSnapshot {
  connected: boolean;
  port: string;
  toolCount: number;
  toolNames: string[];
  enabled: boolean;
  reconnectAttempt: number;
  reconnectDelay: number;
  /** Bridge-server health (browser ⟷ bridge ⟷ AI client). Null if none received. */
  serverStatus: BridgeServerStatus | null;
}

/** A log line streamed from the MCP bridge server (shown in the UI). */
export interface McpServerLogLine {
  level: string;
  ts: number;
  msg: string;
}

/** server → browser log frame. */
interface LogMessage {
  type: 'log';
  lines: McpServerLogLine[];
}

/** server → browser status frame (full-chain health). */
interface StatusMessage {
  type: 'status';
  status: BridgeServerStatus;
}

/** Max server log lines retained in the browser ring buffer. */
const MAX_SERVER_LOG = 200;

// ── Persistence ──

const STORAGE_KEY = 'rv-ai-bridge';

interface AiBridgeSettings {
  enabled: boolean;
  port: string;
}

function loadSettings(): AiBridgeSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { enabled: false, port: '18714' };
    const parsed = JSON.parse(raw) as Partial<AiBridgeSettings>;
    return {
      enabled: parsed.enabled === true,
      port: parsed.port || '18714',
    };
  } catch { return { enabled: false, port: '18714' }; }
}

function saveSettings(settings: AiBridgeSettings): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); }
  catch { /* quota exceeded */ }
}

// ── Plugin ──

export class McpBridgePlugin extends RVBehavior {
  readonly id = 'mcp-bridge';
  readonly order = 990;

  // WebSocket state
  private _ws: WebSocket | null = null;
  private _dispatcher: Map<string, { methodKey: string; paramNames: string[] }> | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectDelay = 1000;
  private _maxReconnectDelay = 30000;
  private _destroyed = false;
  private _currentPort = '18714';
  private _reconnectAttempt = 0;
  private _serverLog: McpServerLogLine[] = [];
  private _serverStatus: BridgeServerStatus | null = null;

  // ── Public getters ──

  get mcpConnected(): boolean { return this._ws?.readyState === WebSocket.OPEN; }
  get mcpPort(): string { return this._currentPort; }
  get mcpToolCount(): number { return this._dispatcher?.size ?? 0; }
  get mcpEnabled(): boolean { return !this._destroyed; }
  /** Buffered log lines streamed from the bridge server. */
  get serverLog(): McpServerLogLine[] { return this._serverLog; }
  /** Last full-chain status pushed by the bridge server (null until received). */
  get serverStatus(): BridgeServerStatus | null { return this._serverStatus; }

  // ── State emission ──

  /** Current bridge state snapshot. Used to seed the UI on mount so a restored
   *  (persisted) enabled/port state shows immediately, before the next event. */
  getSnapshot(): McpBridgeSnapshot {
    return {
      connected: this.mcpConnected,
      port: this._currentPort,
      toolCount: this.mcpToolCount,
      toolNames: this.mcpToolNames,
      enabled: this.mcpEnabled,
      reconnectAttempt: this._reconnectAttempt,
      reconnectDelay: this._reconnectDelay,
      serverStatus: this._serverStatus,
    };
  }

  private _emitChanged(): void {
    this.emit('mcp-bridge-changed', this.getSnapshot());
  }

  // ── Public API for UI ──

  /** Reconnect to MCP server, optionally changing port. */
  reconnect(port?: string): void {
    if (port) this._currentPort = port;
    this._disconnect();
    this._reconnectAttempt = 0;
    this._reconnectDelay = 1000;
    this._destroyed = false;
    this._connect();
    this._saveSettings();
  }

  /** Set the target port without connecting (stored; applied on the next enable/reconnect). */
  setPort(port: string): void {
    this._currentPort = port;
    this._saveSettings();
    this._emitChanged();
  }

  /** Ask the bridge server to shut down (the process exits — it can only be
   *  restarted by the MCP host / Claude, not from the browser). */
  shutdownServer(): void { this._sendControl('shutdown'); }

  /** Ask the bridge server to stop accepting browser connections. */
  pauseServer(): void { this._sendControl('pause'); }

  /** Resume accepting browser connections. */
  resumeServer(): void { this._sendControl('resume'); }

  private _sendControl(action: 'pause' | 'resume' | 'shutdown'): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify({ type: 'control', action }));
  }

  /** Enable or disable the MCP bridge. */
  setEnabled(enabled: boolean): void {
    if (enabled && this._destroyed) {
      this._destroyed = false;
      this._connect();
    } else if (!enabled && !this._destroyed) {
      this._destroyed = true;
      if (this._reconnectTimer !== null) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      this._disconnect();
    }
    this._saveSettings();
    this._emitChanged();
  }

  private _saveSettings(): void {
    saveSettings({ enabled: !this._destroyed, port: this._currentPort });
  }

  // ── Lifecycle ──

  /** Called once at registration (viewer.use), BEFORE any model load — unlike
   *  onStart/onModelLoaded which never fire for an empty (model-less) scene
   *  (e.g. authoring in an empty Layout Planner). The bridge is viewer-lifetime
   *  infrastructure, so it captures the viewer and initialises its connection
   *  here, independent of model loading. This also fixes the enable toggle: a
   *  disabled bridge now correctly starts with `_destroyed = true`, so
   *  `setEnabled(true)` actually calls `_connect()` instead of no-op'ing. */
  init(viewer: RVViewer): void {
    this.viewer = viewer;
    const saved = loadSettings();
    this._currentPort = new URLSearchParams(window.location.search).get('mcpPort') || saved.port;
    this._destroyed = !saved.enabled;
    if (saved.enabled) {
      this._connect();
    }
    this._emitChanged();
  }

  /** Keep the viewer + connection alive across model load/clear — the bridge is
   *  not a per-model behavior. (Base RVBehavior.onModelCleared would null the
   *  viewer and run onDestroy, tearing down the MCP connection on every model
   *  change.) Final teardown happens in dispose() when the viewer is destroyed. */
  onModelCleared(): void { /* intentionally no-op: bridge spans the viewer lifetime */ }

  protected onDestroy(): void {
    this._destroyed = true;
    // Clear reconnect timer to prevent leak (review fix #4)
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    clearBySource('mcp-bridge');
    this._disconnect();
  }

  // ── WebSocket Connection ──

  private _connect(): void {
    if (this._destroyed) return;
    try {
      this._ws = new WebSocket(`ws://localhost:${this._currentPort}/webviewer`);
    } catch {
      this._scheduleReconnect();
      return;
    }
    this._ws.onopen = () => {
      console.debug('[McpBridge] Connected to', `ws://localhost:${this._currentPort}/webviewer`);
      this._reconnectAttempt = 0;
      this._reconnectDelay = 1000;
      this._sendDiscover();
      this._emitChanged();
    };
    this._ws.onmessage = (e) => { this._handleMessage(e.data); };
    this._ws.onerror = () => {};  // suppress console noise; onclose handles reconnect
    this._ws.onclose = (ev) => {
      console.debug(`[McpBridge] Connection closed: code=${ev.code} reason="${ev.reason}"`);
      this._emitChanged();
      // Code 1008 = "Another tab connected" — server kicked us because a newer tab took over.
      // Do NOT reconnect: the other tab is the active client now.
      if (ev.code === 1008) {
        console.debug('[McpBridge] Another tab took over, stopping reconnect');
        this._destroyed = true;
        return;
      }
      this._scheduleReconnect();
    };
  }

  private _disconnect(): void {
    if (this._ws) {
      this._ws.onclose = null;  // prevent reconnect on intentional close
      this._ws.onerror = null;
      this._ws.onmessage = null;
      this._ws.close();
      this._ws = null;
    }
    this._dispatcher = null;
    this._serverStatus = null;
  }

  private _scheduleReconnect(): void {
    if (this._destroyed) return;
    this._ws = null;
    this._serverStatus = null; // stale once the link drops
    this._reconnectAttempt++;

    // Exponential backoff with jitter
    const jitter = Math.random() * 1000;
    const delay = Math.min(this._reconnectDelay + jitter, this._maxReconnectDelay);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay);
    this._emitChanged();
  }

  private _sendDiscover(): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const schemas = generateToolSchemas(this);
    this._dispatcher = buildToolDispatcher(this);
    this._ws.send(JSON.stringify({
      type: 'discover',
      tools: schemas,
      instructions: MCP_INSTRUCTIONS,
      schema_version: '1.0.0',
    }));
    // Reset backoff on successful connection
    this._reconnectDelay = 1000;
    this._emitChanged();
  }

  // ── Message Handling ──

  private async _handleMessage(raw: string): Promise<void> {
    // Review fix: wrap entire body in try/catch to prevent UnhandledPromiseRejection
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'call') {
        await this._handleCall(msg as CallMessage);
      } else if (msg.type === 'log') {
        this._handleLog(msg as LogMessage);
      } else if (msg.type === 'status') {
        this._serverStatus = (msg as StatusMessage).status;
        this._emitChanged();
      }
    } catch (e) {
      console.warn('[McpBridge] Failed to handle message:', e);
    }
  }

  /** Append server log lines to the ring buffer and notify the UI. */
  private _handleLog(msg: LogMessage): void {
    if (!Array.isArray(msg.lines)) return;
    this._serverLog = this._serverLog.concat(msg.lines).slice(-MAX_SERVER_LOG);
    this.emit('mcp-bridge-log', this._serverLog);
  }

  /** Show a brief in-scene indicator that the AI is interacting. Reuses the
   *  standard Instruction overlay (canvas-centered pill, auto-clearing). A fixed
   *  id means rapid calls replace (never stack) and refresh the auto-clear timer. */
  private _showActivity(tool: string): void {
    // Feed the persistent AI-activity overlay (AiActivityOverlay) with a readable
    // label, e.g. "web_snap_attach" -> "Snap attach". The overlay shows the robot
    // icon whenever the bridge is connected and appends this text during a call.
    const label = tool.replace(/^web_/, '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
    setAiActivity(label);
  }

  private async _handleCall(msg: CallMessage): Promise<void> {
    const { id, tool, arguments: args } = msg;

    if (!this._dispatcher) {
      this._sendResult(id, undefined, 'Dispatcher not ready');
      return;
    }

    const entry = this._dispatcher.get(tool);
    if (!entry) {
      this._sendResult(id, undefined, `Unknown tool: ${tool}`);
      return;
    }

    this._showActivity(tool);

    try {
      const method = (this as unknown as Record<string, Function>)[entry.methodKey];
      if (typeof method !== 'function') {
        this._sendResult(id, undefined, `Method not found: ${entry.methodKey}`);
        return;
      }

      // Build ordered arguments from named params
      const orderedArgs = entry.paramNames.map(name => args[name]);
      const result = await method.apply(this, orderedArgs);
      this._sendResult(id, result);
    } catch (e) {
      this._sendResult(id, undefined, String(e));
    }
  }

  private _sendResult(id: number, result?: string, error?: string): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const msg: Record<string, unknown> = { type: 'result', id };
    if (error !== undefined) {
      msg.error = error;
    } else {
      msg.result = result;
    }
    this._ws.send(JSON.stringify(msg));
  }

  /** Get tool names registered via @McpTool decorators. */
  get mcpToolNames(): string[] {
    return this._dispatcher ? [...this._dispatcher.keys()] : [];
  }

  // ═══════════════════════════════════════════════════════════════════
  // @McpTool Definitions
  // ═══════════════════════════════════════════════════════════════════

  @McpTool('Get WebViewer status: connection, FPS, model info, component counts')
  async webStatus(): Promise<string> {
    return JSON.stringify({
      connected: true,
      fps: this.viewer?.currentFps ?? 0,
      connectionState: this.viewer?.connectionState ?? 'unknown',
      model: this.viewer?.currentModelUrl ?? null,
      loadInfo: this.viewer?.lastLoadInfo ?? null,
      driveCount: this.drives.length,
      sensorCount: this.sensors.length,
      signalCount: this.signals?.size ?? 0,
      muCount: this.transportManager?.mus.length ?? 0,
      logicRoots: this.viewer?.logicEngine?.roots.length ?? 0,
    });
  }

  @McpTool('Capture a screenshot of the current 3D scene (returned as an image). Optionally CROP to a sub-region: pass `path` to frame a specific node/machine (cropped to its on-screen bounding box + a small margin), or pass x/y/w/h as fractions (0..1 of the canvas) for a manual rectangle. Omit all for the full view.')
  async webScreenshot(
    @McpParam('path', "Node path to frame — crops to this object's on-screen bounding box (e.g. a machine). Omit for the whole view.", 'string', false) path: string,
    @McpParam('x', 'Manual crop: left edge as a fraction 0..1 of canvas width (provide x,y,w,h together; overrides path).', 'number', false) x: number,
    @McpParam('y', 'Manual crop: top edge as a fraction 0..1 of canvas height.', 'number', false) y: number,
    @McpParam('w', 'Manual crop: width as a fraction 0..1 of canvas width.', 'number', false) w: number,
    @McpParam('h', 'Manual crop: height as a fraction 0..1 of canvas height.', 'number', false) h: number,
  ): Promise<string> {
    const v = this.viewer;
    const renderer = v?.renderer;
    const scene = v?.scene;
    const camera = v?.camera;
    if (!renderer || !scene || !camera) return JSON.stringify({ error: 'Renderer not ready' });
    // The main renderer has no preserveDrawingBuffer, so render then read the
    // canvas synchronously in the same tick (the crop math below is sync too).
    renderer.render(scene, camera);
    const src = renderer.domElement;
    const BW = src.width, BH = src.height; // drawing-buffer pixels

    // Resolve the crop rectangle (in drawing-buffer pixels).
    let crop = { left: 0, top: 0, width: BW, height: BH };
    const hasManual = [x, y, w, h].every(n => typeof n === 'number' && !Number.isNaN(n));
    const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
    if (hasManual) {
      crop = {
        left: Math.round(clamp01(x) * BW),
        top: Math.round(clamp01(y) * BH),
        width: Math.round(clamp01(w) * BW),
        height: Math.round(clamp01(h) * BH),
      };
    } else if (path) {
      const node = v?.registry?.getNode(path);
      if (!node) return JSON.stringify({ error: `Node not found: "${path}"` });
      const box = new Box3().setFromObject(node);
      if (box.isEmpty()) return JSON.stringify({ error: `Node "${path}" has no renderable bounds` });
      const { min, max } = box;
      const corners = [
        new Vector3(min.x, min.y, min.z), new Vector3(min.x, min.y, max.z),
        new Vector3(min.x, max.y, min.z), new Vector3(min.x, max.y, max.z),
        new Vector3(max.x, min.y, min.z), new Vector3(max.x, min.y, max.z),
        new Vector3(max.x, max.y, min.z), new Vector3(max.x, max.y, max.z),
      ];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const c of corners) {
        c.project(camera); // world -> NDC (-1..1)
        const px = (c.x * 0.5 + 0.5) * BW;
        const py = (1 - (c.y * 0.5 + 0.5)) * BH;
        minX = Math.min(minX, px); maxX = Math.max(maxX, px);
        minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
      const pad = 0.08 * Math.max(maxX - minX, maxY - minY); // breathing room
      const left = Math.max(0, Math.round(minX - pad));
      const top = Math.max(0, Math.round(minY - pad));
      const right = Math.min(BW, Math.round(maxX + pad));
      const bottom = Math.min(BH, Math.round(maxY + pad));
      crop = { left, top, width: right - left, height: bottom - top };
    }
    // Degenerate crop (off-screen / behind camera) → fall back to the full frame.
    if (crop.width < 1 || crop.height < 1) crop = { left: 0, top: 0, width: BW, height: BH };

    // Downscale the cropped region to keep the payload small.
    const maxDim = 1400;
    const k = Math.min(1, maxDim / Math.max(crop.width, crop.height));
    const outW = Math.max(1, Math.round(crop.width * k));
    const outH = Math.max(1, Math.round(crop.height * k));
    const off = document.createElement('canvas');
    off.width = outW;
    off.height = outH;
    const ctx = off.getContext('2d');
    if (!ctx) return JSON.stringify({ error: 'No 2D context' });
    ctx.drawImage(src, crop.left, crop.top, crop.width, crop.height, 0, 0, outW, outH);
    const data = off.toDataURL('image/jpeg', 0.72).split(',')[1] ?? '';
    return JSON.stringify({ __rvImage: { data, mimeType: 'image/jpeg', width: outW, height: outH, crop } });
  }

  @McpTool('List all drives with current position, speed, direction, and limits')
  async webDriveList(): Promise<string> {
    return JSON.stringify(this.drives.map(d => ({
      name: d.name,
      currentPosition: +d.currentPosition.toFixed(3),
      targetPosition: +d.targetPosition.toFixed(3),
      targetSpeed: +d.targetSpeed.toFixed(3),
      isRunning: d.isRunning,
      jogForward: d.jogForward,
      jogBackward: d.jogBackward,
      direction: d.Direction,
      upperLimit: d.UpperLimit,
      lowerLimit: d.LowerLimit,
      acceleration: d.Acceleration,
    })));
  }

  @McpTool('List all PLC signals with current values (bool, int, or float)')
  async webSignalList(): Promise<string> {
    const all = this.signals?.getAll();
    if (!all) return JSON.stringify([]);
    const result: Array<{ name: string; value: boolean | number; type: string }> = [];
    for (const [name, value] of all) {
      result.push({
        name,
        value,
        type: typeof value,
      });
    }
    return JSON.stringify(result);
  }

  @McpTool('Set a boolean signal value in the browser')
  async webSignalSetBool(
    @McpParam('name', 'Signal name') name: string,
    @McpParam('value', 'Boolean value to set', 'boolean') value: boolean,
  ): Promise<string> {
    if (!this.signals) return JSON.stringify({ error: 'No signal store available' });
    const current = this.signals.get(name);
    if (current === undefined) return JSON.stringify({ error: `Signal "${name}" not found` });
    this.signals.set(name, value);
    return JSON.stringify({ name, value, previous: current });
  }

  @McpTool('Set a float signal value in the browser')
  async webSignalSetFloat(
    @McpParam('name', 'Signal name') name: string,
    @McpParam('value', 'Float value to set', 'number') value: number,
  ): Promise<string> {
    if (!this.signals) return JSON.stringify({ error: 'No signal store available' });
    const current = this.signals.get(name);
    if (current === undefined) return JSON.stringify({ error: `Signal "${name}" not found` });
    this.signals.set(name, value);
    return JSON.stringify({ name, value, previous: current });
  }

  @McpTool('Jog a drive forward or backward')
  async webDriveJog(
    @McpParam('name', 'Drive name') name: string,
    @McpParam('forward', 'true for forward, false for backward', 'boolean', false) forward: boolean,
  ): Promise<string> {
    const drive = this.drives.find(d => d.name === name);
    if (!drive) return JSON.stringify({ error: `Drive "${name}" not found` });
    const dir = forward !== false;  // default to true if not specified
    drive.jogForward = dir;
    drive.jogBackward = !dir;
    return JSON.stringify({ name, jogForward: dir, jogBackward: !dir });
  }

  @McpTool('Play / pause the WebViewer simulation (toggles or sets the user pause reason)')
  async webSimPlayPause(
    @McpParam('paused', 'true to pause, false to play; omit to toggle', 'boolean', false) paused: boolean,
  ): Promise<string> {
    if (!this.viewer) return JSON.stringify({ error: 'No viewer' });
    const userPaused = this.viewer.simulationPauseReasons.includes('user');
    const next = paused === undefined || paused === null ? !userPaused : paused;
    this.viewer.setSimulationPaused('user', next);
    return JSON.stringify({
      paused: this.viewer.isSimulationPaused,
      userPaused: next,
      reasons: [...this.viewer.simulationPauseReasons],
    });
  }

  @McpTool('Show or hide the always-visible floor markers (ring + label) under each Source. Persists in localStorage.')
  async webSetSourceMarkers(
    @McpParam('visible', 'true to show, false to hide', 'boolean', true) visible: boolean,
  ): Promise<string> {
    if (!this.viewer) return JSON.stringify({ error: 'No viewer' });
    this.viewer.setSourceMarkersVisible(visible);
    const sources = this.transportManager?.sources ?? [];
    return JSON.stringify({
      ok: true,
      visible,
      affectedSources: sources.length,
    });
  }

  @McpTool('Reset the WebViewer simulation: clear MUs + LogicSteps (drives and signals are untouched)')
  async webSimReset(): Promise<string> {
    if (!this.viewer) return JSON.stringify({ error: 'No viewer' });
    const before = {
      mus: this.transportManager?.mus.length ?? 0,
      totalSpawned: this.transportManager?.totalSpawned ?? 0,
    };
    this.viewer.resetSimulation();
    return JSON.stringify({
      ok: true,
      before,
      after: {
        mus: this.transportManager?.mus.length ?? 0,
        totalSpawned: this.transportManager?.totalSpawned ?? 0,
      },
    });
  }

  @McpTool('Stop a drive (clear jog flags and stop motion)')
  async webDriveStop(
    @McpParam('name', 'Drive name') name: string,
  ): Promise<string> {
    const drive = this.drives.find(d => d.name === name);
    if (!drive) return JSON.stringify({ error: `Drive "${name}" not found` });
    drive.jogForward = false;
    drive.jogBackward = false;
    drive.stop();
    return JSON.stringify({ name, stopped: true });
  }

  @McpTool('Central drive-speed override for continuous simulation: one master factor that scales the effective speed of ALL drives at runtime (1 = normal, 0.5 = half, 2 = double, 0 = stopped). Relative speeds are preserved. Omit factor to just read the current value.')
  async webDriveSpeedOverride(
    @McpParam('factor', 'Master speed factor (1 = normal). Omit to read the current value.', 'number', false) factor: number,
  ): Promise<string> {
    if (factor === undefined || factor === null) {
      return JSON.stringify({ factor: getDriveSpeedOverride() });
    }
    return JSON.stringify({ factor: setDriveSpeedOverride(factor) });
  }

  @McpTool('List all sensors with occupancy status')
  async webSensorList(): Promise<string> {
    return JSON.stringify(this.sensors.map(s => ({
      name: s.node.name,
      occupied: s.occupied,
      mode: s.mode,
      signalOccupied: s.SensorOccupied,
      signalNotOccupied: s.SensorNotOccupied,
    })));
  }

  @McpTool('Get transport status: MU counts, active sources and sinks')
  async webTransportStatus(): Promise<string> {
    const tm = this.transportManager;
    if (!tm) return JSON.stringify({ error: 'No transport manager' });
    return JSON.stringify({
      totalSpawned: tm.totalSpawned,
      totalConsumed: tm.totalConsumed,
      activeMUs: tm.mus.length,
      mus: tm.mus.map(mu => ({
        name: mu.getName(),
        ...serializeProps(mu, 1),
      })),
      sources: tm.sources.map(src => ({
        name: src.node.name,
        ...serializeProps(src, 1),
      })),
      sinks: tm.sinks.map(sink => ({
        name: sink.node.name,
        ...serializeProps(sink, 1),
      })),
    });
  }

  @McpTool('Get LogicStep flow hierarchy with step states and progress')
  async webLogicFlow(): Promise<string> {
    const engine = this.viewer?.logicEngine;
    if (!engine) return JSON.stringify({ error: 'No logic engine' });

    const mapStep = (step: RVLogicStep): object => {
      const props = serializeProps(step, 1);
      const base: Record<string, unknown> = {
        name: step.name,
        type: step.constructor.name,
        state: step.state,
        progress: step.progress,
        ...props,
      };
      if ('children' in step) {
        base.children = (step as { children: RVLogicStep[] }).children.map(mapStep);
      }
      return base;
    };

    return JSON.stringify({
      stats: engine.stats,
      roots: engine.roots.map(mapStep),
    });
  }

  @McpTool('Get browser console logs (errors, warnings, debug messages)')
  async webLogs(
    @McpParam('level', 'Minimum log level: trace|debug|info|warn|error', 'string', false) level: string,
    @McpParam('limit', 'Max number of entries to return', 'integer', false) limit: number,
  ): Promise<string> {
    if (level || limit) {
      return JSON.stringify(queryLogs({
        level: (level as LogLevel) || undefined,
        limit: limit || 100,
      }));
    }
    return JSON.stringify(getLastLogs(100));
  }

  // ═══════════════════════════════════════════════════════════════════
  // Generic Component & Node Tools
  // ═══════════════════════════════════════════════════════════════════

  @McpTool('Search nodes by name (case-insensitive substring match). Returns paths and component types.')
  async webFind(
    @McpParam('term', 'Search term (matched against node name, case-insensitive)') term: string,
  ): Promise<string> {
    const reg = this.viewer?.registry;
    if (!reg) return JSON.stringify({ error: 'No registry available' });
    const results = reg.search(term);
    return JSON.stringify(results.map(r => ({
      path: r.path,
      name: lastPathSegment(r.path),
      types: r.types,
    })));
  }

  @McpTool('Get scene hierarchy tree from a root path (or entire scene). Returns nested children with component types.')
  async webHierarchy(
    @McpParam('root', 'Root path to start from (empty = entire scene)', 'string', false) root: string,
    @McpParam('depth', 'Max depth to traverse (default 3)', 'integer', false) depth: number,
  ): Promise<string> {
    const reg = this.viewer?.registry;
    if (!reg) return JSON.stringify({ error: 'No registry available' });

    const maxDepth = depth || 3;
    const scene = this.viewer?.scene;
    if (!scene) return JSON.stringify({ error: 'No scene loaded' });

    let startNode = root ? reg.getNode(root) : scene;
    if (!startNode) return JSON.stringify({ error: `Node not found: "${root}"` });

    const buildTree = (node: import('three').Object3D, d: number): object | null => {
      const path = reg.getPathForNode(node);
      const types = path ? reg.getComponentTypes(path) : [];
      const entry: Record<string, unknown> = {
        name: node.name,
        path: path ?? node.name,
        types,
      };
      if (d < maxDepth && node.children.length > 0) {
        entry.children = node.children
          .map(c => buildTree(c, d + 1))
          .filter(Boolean);
      } else if (node.children.length > 0) {
        entry.childCount = node.children.length;
      }
      return entry;
    };

    return JSON.stringify(buildTree(startNode, 0));
  }

  @McpTool('Get all components on a node by path. Returns component types and their properties.')
  async webComponentGetAll(
    @McpParam('path', 'Full hierarchy path of the node') path: string,
  ): Promise<string> {
    const reg = this.viewer?.registry;
    if (!reg) return JSON.stringify({ error: 'No registry available' });

    const node = reg.getNode(path);
    if (!node) return JSON.stringify({ error: `Node not found: "${path}"` });

    const nodePath = reg.getPathForNode(node) ?? path;
    const entries = reg.getComponentsAt(nodePath);
    if (entries.length === 0) {
      return JSON.stringify({ path: nodePath, components: [] });
    }

    const components = entries.map(([type, instance]) => ({
      type,
      properties: serializeProps(instance, 2),
    }));
    return JSON.stringify({ path: nodePath, components });
  }

  @McpTool('Get a specific component on a node by path and type. Returns component properties.')
  async webComponentGet(
    @McpParam('path', 'Full hierarchy path of the node') path: string,
    @McpParam('type', 'Component type name (e.g. Drive, Sensor, TransportSurface, Source, Sink, Grip, GripTarget)') type: string,
  ): Promise<string> {
    const reg = this.viewer?.registry;
    if (!reg) return JSON.stringify({ error: 'No registry available' });

    const instance = reg.getByPath(type, path);
    if (!instance) return JSON.stringify({ error: `Component "${type}" not found at "${path}"` });

    return JSON.stringify({
      path,
      type,
      properties: serializeProps(instance, 2),
    });
  }

  @McpTool('Get all components of a given type across the entire scene. Returns paths and properties.')
  async webComponentsByType(
    @McpParam('type', 'Component type name (e.g. Drive, Sensor, TransportSurface, Source, Sink, Grip, GripTarget)') type: string,
  ): Promise<string> {
    const reg = this.viewer?.registry;
    if (!reg) return JSON.stringify({ error: 'No registry available' });

    const all = reg.getAll(type);
    if (all.length === 0) {
      // List available types for discoverability
      const stats = reg.size;
      return JSON.stringify({
        error: `No components of type "${type}" found`,
        availableTypes: stats.types,
      });
    }

    return JSON.stringify(all.map(({ path, instance }) => ({
      path,
      name: lastPathSegment(path),
      properties: serializeProps(instance, 1),
    })));
  }

  // ═══════════════════════════════════════════════════════════════════
  // Authoring tools — BUILD layouts (not just inspect/run). They wrap the
  // mode manager, the layout-planner and the extras-editor. Typical flow:
  // web_set_mode('planner') -> web_library_list -> web_place -> web_move /
  // web_component_set -> web_sim_play_pause -> web_scene_save.
  // ═══════════════════════════════════════════════════════════════════

  /** Resolve the layout-planner plugin (helper — not an MCP tool). */
  private _planner(): LayoutPlannerPlugin | undefined {
    return this.viewer?.getPlugin<LayoutPlannerPlugin>('layout-planner');
  }

  /** Resolve a library entry to its behavior definition (for description/docs).
   *  Matches by the entry name + a de-spaced variant + the id, so e.g. "Chain
   *  Transfer Left" resolves to the ChainTransfer behavior (model glob `*ChainTransfer*`). */
  private _behaviorForEntry(entry: LibraryCatalogEntry): ReturnType<typeof matchMaterialFlows>[number] | undefined {
    for (const c of [entry.name, entry.name.replace(/\s+/g, ''), entry.id]) {
      const m = matchMaterialFlows(c);
      if (m.length) return m[0];
    }
    return undefined;
  }

  @McpTool('Switch the workspace mode. mode = hmi (operate/monitor), planner (build layouts) or des (preview). Switch to planner before placing components.')
  async webSetMode(
    @McpParam('mode', 'Target mode: hmi | planner | des') mode: string,
  ): Promise<string> {
    const modes = this.viewer?.modes;
    if (!modes) return JSON.stringify({ error: 'No viewer' });
    if (!modes.has(mode)) {
      return JSON.stringify({ error: `Unknown mode "${mode}"`, available: modes.list().map(m => m.id) });
    }
    modes.setMode(mode);
    return JSON.stringify({ mode: modes.activeMode, available: modes.list().map(m => m.id) });
  }

  @McpTool('List the available library components (the parts catalog): catalogId, name, category, footprintMm ([x,z] mm) and a short description. Pass catalogId to web_place / web_snap_attach, or web_library_describe for full build docs.')
  async webLibraryList(): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available' });
    const out: Array<{ catalogId: string; name: string; category: string; footprintMm: [number, number] | null; description: string | null }> = [];
    for (const cat of planner.store.getSnapshot().catalogs.values()) {
      for (const e of cat.entries) {
        out.push({
          catalogId: e.id, name: e.name, category: e.category,
          footprintMm: e.footprintMm ?? null,
          description: this._behaviorForEntry(e)?.description ?? null,
        });
      }
    }
    return JSON.stringify(out);
  }

  @McpTool('Describe a library component for building: purpose, material-flow direction, how to connect it (snaps) and key config. Pass a catalogId from web_library_list.')
  async webLibraryDescribe(
    @McpParam('catalogId', 'Library entry id (from web_library_list)') catalogId: string,
  ): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available' });
    let entry: LibraryCatalogEntry | undefined;
    for (const cat of planner.store.getSnapshot().catalogs.values()) {
      const f = cat.entries.find(e => e.id === catalogId);
      if (f) { entry = f; break; }
    }
    if (!entry) return JSON.stringify({ error: `No library entry "${catalogId}". Use web_library_list.` });
    const def = this._behaviorForEntry(entry);
    return JSON.stringify({
      catalogId,
      name: entry.name,
      category: entry.category,
      footprintMm: entry.footprintMm ?? null,
      behaviorType: def?.type ?? null,
      description: def?.description ?? null,
      docs: def?.mcpDocs ?? null,
    });
  }

  @McpTool('Place a library component at a world position (meters). catalogId comes from web_library_list. Returns the new placement id. Requires planner mode.')
  async webPlace(
    @McpParam('catalogId', 'Library entry id (from web_library_list)') catalogId: string,
    @McpParam('x', 'X position in meters', 'number') x: number,
    @McpParam('y', 'Y position in meters', 'number') y: number,
    @McpParam('z', 'Z position in meters', 'number') z: number,
  ): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available' });
    let entry: import('./layout-planner/rv-layout-store').LibraryCatalogEntry | undefined;
    for (const cat of planner.store.getSnapshot().catalogs.values()) {
      const found = cat.entries.find(e => e.id === catalogId);
      if (found) { entry = found; break; }
    }
    if (!entry) return JSON.stringify({ error: `No library entry "${catalogId}". Use web_library_list.` });
    const id = await planner.placeComponent(entry, [x, y, z]);
    return JSON.stringify({ id, catalogId, position: [x, y, z] });
  }

  @McpTool('Move and rotate a placed component. Position in meters, rotation in degrees (XYZ Euler).')
  async webMove(
    @McpParam('id', 'Placement id (from web_place / web_placement_list)') id: string,
    @McpParam('x', 'X position in meters', 'number') x: number,
    @McpParam('y', 'Y position in meters', 'number') y: number,
    @McpParam('z', 'Z position in meters', 'number') z: number,
    @McpParam('rx', 'X rotation in degrees (optional)', 'number', false) rx: number,
    @McpParam('ry', 'Y rotation in degrees (optional)', 'number', false) ry: number,
    @McpParam('rz', 'Z rotation in degrees (optional)', 'number', false) rz: number,
  ): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available' });
    const rot: [number, number, number] = [rx ?? 0, ry ?? 0, rz ?? 0];
    planner.applyTransformById(id, [x, y, z], rot, [1, 1, 1]);
    return JSON.stringify({ id, position: [x, y, z], rotation: rot });
  }

  @McpTool('Remove a placed component by id.')
  async webRemove(
    @McpParam('id', 'Placement id (from web_placement_list)') id: string,
  ): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available' });
    planner.removePlacementById(id);
    return JSON.stringify({ id, removed: true });
  }

  @McpTool('List placed components in the current layout: id, catalogId, label, position (meters), rotation (degrees) and the world bounding box (center + size in meters) for geometric understanding.')
  async webPlacementList(): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available' });
    const snap = planner.snapshotPlacements();
    const box = new Box3();
    const center = new Vector3();
    const size = new Vector3();
    const round3 = (v: Vector3): [number, number, number] => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];
    return JSON.stringify(snap.placements.map(p => {
      let bounds: { center: [number, number, number]; size: [number, number, number] } | null = null;
      const root = planner.getPlacedRootById(p.id);
      if (root) {
        box.setFromObject(root);
        if (!box.isEmpty()) {
          box.getCenter(center);
          box.getSize(size);
          bounds = { center: round3(center), size: round3(size) };
        }
      }
      return {
        id: p.id,
        catalogId: p.catalogId,
        label: p.label,
        position: p.position,
        rotation: p.rotation,
        bounds,
      };
    }));
  }

  @McpTool('Save the current layout as a PERSISTED scene. With a name, saves a NEW named scene and returns its id; without a name, saves the active scene. Switch back later via web_scene_open. (For the raw JSON snapshot use web_scene_export.)')
  async webSceneSave(
    @McpParam('name', 'Scene name (optional — omit to save the active scene in place)', 'string', false) name: string,
  ): Promise<string> {
    const store = getSceneStore();
    if (!store) return JSON.stringify({ error: 'Scene store not available' });
    try {
      if (name && name.trim()) {
        const id = await store.saveAs(name.trim());
        return JSON.stringify({ saved: true, id, name: name.trim() });
      }
      await store.save();
      return JSON.stringify({ saved: true });
    } catch (e) { return JSON.stringify({ error: String(e) }); }
  }

  @McpTool('Create a NEW empty scene (clears the current layout, switches to a fresh empty draft). Use before building a new layout — this is the clean way to reset.')
  async webSceneNew(): Promise<string> {
    const store = getSceneStore();
    if (!store) return JSON.stringify({ error: 'Scene store not available' });
    try { await store.newEmpty(); return JSON.stringify({ ok: true }); }
    catch (e) { return JSON.stringify({ error: String(e) }); }
  }

  @McpTool('Open / switch to a saved scene by id (from web_scene_list).')
  async webSceneOpen(
    @McpParam('id', 'Saved scene id (from web_scene_list)') id: string,
  ): Promise<string> {
    const store = getSceneStore();
    if (!store) return JSON.stringify({ error: 'Scene store not available' });
    try { await store.openScene(id); return JSON.stringify({ ok: true, id }); }
    catch (e) { return JSON.stringify({ error: String(e) }); }
  }

  @McpTool('List scenes: saved scenes (id, name) — pass an id to web_scene_open — plus built-in scenes.')
  async webSceneList(): Promise<string> {
    const store = getSceneStore();
    if (!store) return JSON.stringify({ error: 'Scene store not available' });
    return JSON.stringify({
      saved: store.listScenes().map(s => ({ id: s.id, name: s.name, baseKind: s.baseKind })),
      builtins: store.listBuiltins().map(b => ({ url: b.url, label: b.label })),
    });
  }

  @McpTool('Export the current layout as a raw JSON snapshot (placements + catalog sources + grid) without persisting it as a scene.')
  async webSceneExport(): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available' });
    return JSON.stringify(planner.snapshotAsLayoutFile('Untitled'));
  }

  @McpTool('Set one or more config properties on a component (writes rv_extras overrides, e.g. a drive TargetSpeed or a source spawn interval). props is a JSON object of fieldName -> value.')
  async webComponentSet(
    @McpParam('path', 'Full hierarchy path of the node') path: string,
    @McpParam('type', 'Component type (e.g. Drive, Source, Sensor, TransportSurface)') type: string,
    @McpParam('props', 'JSON object of fieldName -> value, e.g. {"TargetSpeed": 500}') props: string,
  ): Promise<string> {
    const editor = this.viewer?.getPlugin<RvExtrasEditorPlugin>('rv-extras-editor');
    if (!editor) return JSON.stringify({ error: 'Extras editor not available' });
    let parsed: unknown;
    try { parsed = JSON.parse(props); }
    catch { return JSON.stringify({ error: 'props must be a JSON object string, e.g. {"TargetSpeed": 500}' }); }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return JSON.stringify({ error: 'props must be a JSON object' });
    }
    const applied: Record<string, unknown> = {};
    const rejected: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (editor.updateOverlayField(path, type, field, value)) applied[field] = value;
      else rejected[field] = value;
    }
    return JSON.stringify({ path, type, applied, rejected });
  }

  // ── Snap-attach helpers/tools (connect a matching next component) ──

  /** Resolve a target snap from a free-snap list by name, or auto-pick the only
   *  one (helper — not an MCP tool). Mirrors the UI's free-snap derivation. */
  private _pickSnap(free: readonly SnapPoint[], name?: string):
    { snap: SnapPoint } | { error: string; available: string[] } {
    const available = free.map(s => s.object3D.name);
    if (name) {
      const s = free.find(sp => sp.object3D.name === name);
      return s ? { snap: s } : { error: `Snap "${name}" not free or not found`, available };
    }
    if (free.length === 1) return { snap: free[0] };
    if (free.length === 0) return { error: 'No free snap points on this component', available };
    return { error: 'Ambiguous — pass targetSnapName (multiple free snaps)', available };
  }

  /** Free, live snaps of a placed root (the UI's own "open ports" derivation). */
  private _freeSnaps(root: import('three').Object3D): readonly SnapPoint[] {
    const reg = this.viewer?.getPlugin<SnapPointPlugin>('snap-point')?.getRegistry();
    if (!reg) return [];
    return reg.getByOwnerRoot(root).filter(s => !s.occupied && s.object3D.parent);
  }

  @McpTool('List the free (unoccupied) snap points of a placed component. Pass a placement id (from web_place / web_placement_list). Returns snapName, typeId, flow, axis and dirCode for each open port — feed snapName + the placement id into web_snap_attach.')
  async webSnapList(
    @McpParam('id', 'Placement id (from web_place / web_placement_list)') id: string,
  ): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available' });
    const root = planner.getPlacedRootById(id);
    if (!root) return JSON.stringify({ error: `No placement "${id}". Use web_placement_list.` });
    const reg = this.viewer?.getPlugin<SnapPointPlugin>('snap-point')?.getRegistry();
    if (!reg) return JSON.stringify({ error: 'Snap-point system not available' });
    const snaps = reg.getByOwnerRoot(root);
    const free = snaps.filter(s => !s.occupied && s.object3D.parent);
    return JSON.stringify({
      id,
      label: root.name,
      freeSnaps: free.map(s => ({
        snapName: s.object3D.name,
        typeId: s.typeId,
        flow: s.flow ?? 'bidi',
        axis: s.dir.axis,
        dirCode: s.dir.code,
      })),
      occupiedCount: snaps.filter(s => s.occupied).length,
    });
  }

  @McpTool('Suggest library components compatible with a free snap of a placed component (same typeId + compatible flow, like the snap picker). Returns [{catalogId, name, ownSnapName}] — pass catalogId into web_snap_attach.')
  async webSnapSuggest(
    @McpParam('targetId', 'Placement id to attach onto') targetId: string,
    @McpParam('targetSnapName', 'Target snap node name (from web_snap_list); omit to auto-pick the only free snap', 'string', false) targetSnapName: string,
  ): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available' });
    const root = planner.getPlacedRootById(targetId);
    if (!root) return JSON.stringify({ error: `No placement "${targetId}". Use web_placement_list.` });
    const picked = this._pickSnap(this._freeSnaps(root), targetSnapName);
    if ('error' in picked) return JSON.stringify(picked);
    const target = picked.snap;
    const entries: LibraryCatalogEntry[] = [];
    for (const cat of planner.store.getSnapshot().catalogs.values()) entries.push(...cat.entries);
    const compat = await findCompatibleLibraryAssets(entries, target.typeId, oppositeDirection(target.dir), target.flow);
    return JSON.stringify({
      targetId,
      targetSnapName: target.object3D.name,
      typeId: target.typeId,
      flow: target.flow ?? 'bidi',
      suggestions: compat.map(m => ({ catalogId: m.entry.id, name: m.entry.name, ownSnapName: m.ownSnapName })),
    });
  }

  @McpTool('Attach a library component onto a free snap of an existing placement (auto-aligned, like the snap picker). targetId = existing placement id; catalogId = part to attach (from web_library_list / web_snap_suggest); targetSnapName optional (defaults to the only free snap). Returns the new placement id. Use planner mode.')
  async webSnapAttach(
    @McpParam('targetId', 'Placement id to attach onto') targetId: string,
    @McpParam('catalogId', 'Library entry id to attach (from web_library_list / web_snap_suggest)') catalogId: string,
    @McpParam('targetSnapName', 'Target snap node name (from web_snap_list); omit to auto-pick the only free snap', 'string', false) targetSnapName: string,
  ): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available' });
    const root = planner.getPlacedRootById(targetId);
    if (!root) return JSON.stringify({ error: `No placement "${targetId}". Use web_placement_list.` });
    const picked = this._pickSnap(this._freeSnaps(root), targetSnapName);
    if ('error' in picked) return JSON.stringify(picked);
    const target = picked.snap;

    let entry: LibraryCatalogEntry | undefined;
    for (const cat of planner.store.getSnapshot().catalogs.values()) {
      const f = cat.entries.find(e => e.id === catalogId);
      if (f) { entry = f; break; }
    }
    if (!entry) return JSON.stringify({ error: `No library entry "${catalogId}". Use web_library_list.` });

    const matches = await findCompatibleLibraryAssets([entry], target.typeId, oppositeDirection(target.dir), target.flow);
    const chosen = matches.find(m => m.entry.id === catalogId);
    if (!chosen) {
      return JSON.stringify({ error: `"${catalogId}" has no snap compatible with typeId=${target.typeId}, flow=${target.flow ?? 'bidi'}` });
    }

    const newId = await planner.placeAtSnap(entry, target, chosen.ownSnapName);
    if (!newId) return JSON.stringify({ error: 'Placement rejected (snap occupied, non-uniform scale, or own-snap not found)' });
    return JSON.stringify({
      id: newId,
      catalogId,
      attachedTo: { placementId: targetId, snapName: target.object3D.name, typeId: target.typeId },
      ownSnapName: chosen.ownSnapName,
    });
  }
}
