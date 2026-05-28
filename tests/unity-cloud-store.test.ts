// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import { UnityCloudStore } from '../../realvirtual-WebViewer-Private~/src/plugins/layout-cloud/unity-cloud-store';

const testConfig = {
  keyId: 'test-key',
  secretKey: 'test-secret',
  projectId: 'test-proj',
};

describe('UnityCloudStore (multi-connection)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should start with no connections', () => {
    const store = new UnityCloudStore();
    const snap = store.getSnapshot();
    expect(snap.connections).toHaveLength(0);
    expect(snap.activeConnectionId).toBeNull();
  });

  it('should add a connection and set it active', () => {
    const store = new UnityCloudStore();
    const id = store.addConnection('Test', testConfig);
    const snap = store.getSnapshot();
    expect(snap.connections).toHaveLength(1);
    expect(snap.connections[0].conn.label).toBe('Test');
    expect(snap.connections[0].conn.config).toEqual(testConfig);
    expect(snap.activeConnectionId).toBe(id);
  });

  it('should persist connections to localStorage under rv-am-connections', () => {
    const store = new UnityCloudStore();
    store.addConnection('Test', testConfig);
    const stored = localStorage.getItem('rv-am-connections');
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].label).toBe('Test');
  });

  it('should restore connections from localStorage', () => {
    localStorage.setItem('rv-am-connections', JSON.stringify([
      { id: 'restored-1', label: 'Restored', config: testConfig },
    ]));
    const store = new UnityCloudStore();
    const snap = store.getSnapshot();
    expect(snap.connections).toHaveLength(1);
    expect(snap.connections[0].conn.label).toBe('Restored');
    expect(snap.activeConnectionId).toBe('restored-1');
  });

  it('should remove a connection', () => {
    const store = new UnityCloudStore();
    const id = store.addConnection('ToRemove', testConfig);
    expect(store.getSnapshot().connections).toHaveLength(1);
    store.removeConnection(id);
    expect(store.getSnapshot().connections).toHaveLength(0);
    expect(store.getSnapshot().activeConnectionId).toBeNull();
  });

  it('should support multiple connections', () => {
    const store = new UnityCloudStore();
    store.addConnection('First', testConfig);
    const id2 = store.addConnection('Second', { ...testConfig, projectId: 'proj-2' });
    const snap = store.getSnapshot();
    expect(snap.connections).toHaveLength(2);
    expect(snap.activeConnectionId).toBe(id2);
  });

  it('should switch active connection', () => {
    const store = new UnityCloudStore();
    const id1 = store.addConnection('First', testConfig);
    store.addConnection('Second', { ...testConfig, projectId: 'proj-2' });
    store.setActiveConnection(id1);
    expect(store.getSnapshot().activeConnectionId).toBe(id1);
  });

  it('should notify subscribers on changes', () => {
    const store = new UnityCloudStore();
    let notified = 0;
    store.subscribe(() => { notified++; });
    store.addConnection('Test', testConfig);
    expect(notified).toBeGreaterThan(0);
  });

  it('should handle corrupt localStorage gracefully', () => {
    localStorage.setItem('rv-am-connections', 'not-json');
    const store = new UnityCloudStore();
    expect(store.getSnapshot().connections).toHaveLength(0);
  });
});
