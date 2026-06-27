// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { LogLine } from './protocol.js';

/** Receives newly emitted log lines (e.g. the WS mirror to the browser). */
export type LogSink = (lines: LogLine[]) => void;

/**
 * stderr logger with a ring buffer and an optional sink (mirrored to the browser).
 *
 * CRITICAL: stdout is reserved for the JSON-RPC stdio transport. This logger
 * writes ONLY to stderr — never call console.log / process.stdout.write elsewhere.
 */
export class Logger {
  private readonly _buffer: LogLine[] = [];
  private _sink: LogSink | null = null;

  constructor(private readonly bufferSize = 200) {}

  /** Snapshot of the buffered backlog (used to seed a newly connected client). */
  get buffer(): LogLine[] {
    return [...this._buffer];
  }

  /** Attach (or clear) the sink. Immediately flushes the current backlog. */
  setSink(sink: LogSink | null): void {
    this._sink = sink;
    if (sink && this._buffer.length > 0) sink([...this._buffer]);
  }

  info(msg: string): void { this._emit('info', msg); }
  warn(msg: string): void { this._emit('warn', msg); }
  error(msg: string): void { this._emit('error', msg); }

  private _emit(level: string, msg: string): void {
    const line: LogLine = { level, ts: Date.now(), msg };
    process.stderr.write(`[${level}] ${msg}\n`);
    this._buffer.push(line);
    if (this._buffer.length > this.bufferSize) this._buffer.shift();
    this._sink?.([line]);
  }
}
