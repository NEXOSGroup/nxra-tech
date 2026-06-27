// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ai-activity-store — the current AI/MCP interaction label, shown next to the
 * persistent robot icon in the AiActivityOverlay (over the 3D scene).
 *
 * The MCP bridge calls `setAiActivity(label)` whenever it handles a tool call;
 * the label auto-clears a short while after the last activity, so the overlay
 * shows status text only DURING interaction and just the icon when idle.
 */

import { useSyncExternalStore } from 'react';

const IDLE_CLEAR_MS = 3000;

let _activity: string | null = null;
let _timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void { for (const l of listeners) l(); }

/** Set the current AI interaction label (auto-clears after a short idle). */
export function setAiActivity(label: string | null): void {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (_activity !== label) { _activity = label; emit(); }
  if (label) {
    _timer = setTimeout(() => { _activity = null; _timer = null; emit(); }, IDLE_CLEAR_MS);
  }
}

/** Current AI interaction label, or null when idle. */
export function getAiActivity(): string | null {
  return _activity;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** React hook — the current AI interaction label (null when idle). */
export function useAiActivity(): string | null {
  return useSyncExternalStore(subscribe, getAiActivity, getAiActivity);
}
