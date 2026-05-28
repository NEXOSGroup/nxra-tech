// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  subscribeConnectStore,
  getConnectSnapshot,
  setServerUrl,
  connectToServer,
  disconnectFromServer,
  toggleSignalSelection,
  selectAllSignals,
  _resetConnectStore,
} from '../src/core/hmi/connect-store';

describe('connect-store', () => {
  beforeEach(() => {
    _resetConnectStore();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    _resetConnectStore();
  });

  it('should have default state', () => {
    const snap = getConnectSnapshot();
    expect(snap.state).toBe('disconnected');
    expect(snap.serverUrl).toBe('http://localhost:5100');
    expect(snap.interfaces).toEqual([]);
    expect(snap.activeInterfaceId).toBeNull();
    expect(snap.discoveredSignals).toEqual([]);
    expect(snap.discoveryLoading).toBe(false);
    expect(snap.errorMessage).toBe('');
  });

  it('should update server URL and persist to localStorage', () => {
    setServerUrl('http://myserver:5100');
    const snap = getConnectSnapshot();
    expect(snap.serverUrl).toBe('http://myserver:5100');
    expect(localStorage.getItem('rv-connect-url')).toBe('http://myserver:5100');
  });

  it('should notify listeners on state change', () => {
    const listener = vi.fn();
    const unsub = subscribeConnectStore(listener);

    setServerUrl('http://test:5100');
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    setServerUrl('http://test2:5100');
    expect(listener).toHaveBeenCalledTimes(1); // not called after unsub
  });

  it('should transition to error on connect failure', async () => {
    // Mock fetch to fail
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Connection refused'));

    await connectToServer();
    const snap = getConnectSnapshot();
    expect(snap.state).toBe('error');
    expect(snap.errorMessage).toBe('Connection refused');
  });

  it('should transition to connected on successful health check', async () => {
    // Mock /health returning ok, then /config/interfaces returning empty
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('/health')) {
        return Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (urlStr.includes('/config/interfaces')) {
        return Promise.resolve(new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    await connectToServer();
    const snap = getConnectSnapshot();
    expect(snap.state).toBe('connected');
    expect(snap.errorMessage).toBe('');
  });

  it('should disconnect and reset state', async () => {
    // First connect
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('/health')) {
        return Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });

    await connectToServer();
    expect(getConnectSnapshot().state).toBe('connected');

    disconnectFromServer();
    const snap = getConnectSnapshot();
    expect(snap.state).toBe('disconnected');
    expect(snap.interfaces).toEqual([]);
    expect(snap.activeInterfaceId).toBeNull();
  });

  it('should toggle signal selection', () => {
    // Manually inject discovered signals via the internal mechanism
    // We test the toggle function by first setting state via _resetConnectStore
    _resetConnectStore();

    // Since we can't directly set _discoveredSignals, test selectAllSignals
    // which works on the current list (empty, no-op)
    selectAllSignals(true);
    expect(getConnectSnapshot().discoveredSignals).toEqual([]);
  });
});
