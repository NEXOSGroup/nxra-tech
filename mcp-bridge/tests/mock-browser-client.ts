// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { WebSocket } from 'ws';

interface CloseInfo {
  code: number;
  reason: string;
}

/**
 * Test fixture: a fake realvirtual WEB browser connecting to the WebBridge.
 *
 * Provides a race-free message/close queue so tests can `await` the next
 * message the server sends, or the close frame it receives.
 */
export class MockBrowserClient {
  private readonly _ws: WebSocket;
  private readonly _queue: unknown[] = [];
  private readonly _waiters: ((msg: unknown) => void)[] = [];
  private _closeInfo: CloseInfo | null = null;
  private readonly _closeWaiters: ((info: CloseInfo) => void)[] = [];

  private constructor(ws: WebSocket) {
    this._ws = ws;
    ws.on('message', (d) => {
      let msg: unknown;
      try { msg = JSON.parse(d.toString()); } catch { return; }
      const w = this._waiters.shift();
      if (w) w(msg);
      else this._queue.push(msg);
    });
    ws.on('close', (code, reason) => {
      const info: CloseInfo = { code, reason: reason.toString() };
      this._closeInfo = info;
      const w = this._closeWaiters.shift();
      if (w) w(info);
    });
  }

  static connect(port: number): Promise<MockBrowserClient> {
    return new Promise((resolveConn, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/webviewer`);
      const client = new MockBrowserClient(ws);
      ws.on('open', () => resolveConn(client));
      ws.on('error', reject);
    });
  }

  send(obj: unknown): void {
    this._ws.send(JSON.stringify(obj));
  }

  /** Send a raw (possibly malformed) string frame. */
  sendRaw(text: string): void {
    this._ws.send(text);
  }

  /** Next message the server sent (with type filter optional). */
  nextMessage(timeoutMs = 3000): Promise<any> {
    if (this._queue.length) return Promise.resolve(this._queue.shift());
    return new Promise((resolveMsg, reject) => {
      const t = setTimeout(() => reject(new Error('nextMessage timeout')), timeoutMs);
      this._waiters.push((m) => { clearTimeout(t); resolveMsg(m); });
    });
  }

  /** Next message of a given type, draining intermediate ones. */
  async nextOfType(type: string, timeoutMs = 3000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`nextOfType("${type}") timeout`);
      const msg = await this.nextMessage(remaining);
      if (msg && (msg as { type?: string }).type === type) return msg;
    }
  }

  nextClose(timeoutMs = 3000): Promise<CloseInfo> {
    if (this._closeInfo) return Promise.resolve(this._closeInfo);
    return new Promise((resolveClose, reject) => {
      const t = setTimeout(() => reject(new Error('nextClose timeout')), timeoutMs);
      this._closeWaiters.push((i) => { clearTimeout(t); resolveClose(i); });
    });
  }

  get readyState(): number {
    return this._ws.readyState;
  }

  close(): Promise<void> {
    return new Promise((resolveClose) => {
      if (this._ws.readyState === WebSocket.CLOSED) { resolveClose(); return; }
      this._ws.on('close', () => resolveClose());
      this._ws.close();
    });
  }
}

/** Poll until `cond()` is true or the deadline passes. */
export async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
