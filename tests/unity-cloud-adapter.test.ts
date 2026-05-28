// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi, afterEach } from 'vitest';
import { UnityCloudAdapter } from '../../realvirtual-WebViewer-Private~/src/plugins/layout-cloud/unity-cloud-adapter';

const mockConfig = {
  keyId: 'test-key-id',
  secretKey: 'test-secret-key',
  projectId: 'test-project-id',
};

function mockFetch(...responses: Array<{ ok: boolean; status?: number; statusText?: string; json?: () => Promise<unknown>; text?: () => Promise<string>; blob?: () => Promise<Blob> }>) {
  const impl = vi.fn();
  for (const resp of responses) {
    impl.mockResolvedValueOnce({
      ok: resp.ok,
      status: resp.status ?? (resp.ok ? 200 : 500),
      statusText: resp.statusText ?? '',
      json: resp.json ?? (() => Promise.resolve({})),
      text: resp.text ?? (() => Promise.resolve('')),
      blob: resp.blob ?? (() => Promise.resolve(new Blob())),
    });
  }
  return vi.spyOn(globalThis, 'fetch').mockImplementation(impl);
}

describe('UnityCloudAdapter', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.restoreAllMocks();
  });

  it('should use Basic auth with base64-encoded credentials', async () => {
    fetchSpy = mockFetch({
      ok: true,
      json: () => Promise.resolve({ assets: [] }),
    });

    const adapter = new UnityCloudAdapter(mockConfig);
    await adapter.listAssets({ limit: 1 });

    const call = fetchSpy.mock.calls[0];
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    const decoded = atob(headers['Authorization'].replace('Basic ', ''));
    expect(decoded).toBe('test-key-id:test-secret-key');
  });

  it('should POST to /assets/v1/projects/{projectId}/assets/search', async () => {
    fetchSpy = mockFetch({
      ok: true,
      json: () => Promise.resolve({ assets: [] }),
    });

    const adapter = new UnityCloudAdapter(mockConfig);
    await adapter.listAssets();

    const call = fetchSpy.mock.calls[0];
    const url = call[0] as string;
    expect(url).toContain('/assets/v1/projects/test-project-id/assets/search');
    expect((call[1] as RequestInit).method).toBe('POST');
  });

  it('should list assets from project', async () => {
    const mockAssets = [
      { assetId: 'asset-1', name: 'Conveyor 1m', tags: ['conveyor'], assetVersion: 'v1' },
      { assetId: 'asset-2', name: 'Robot ABB', tags: ['robot'], assetVersion: 'v2' },
    ];
    fetchSpy = mockFetch({
      ok: true,
      json: () => Promise.resolve({ assets: mockAssets }),
    });

    const adapter = new UnityCloudAdapter(mockConfig);
    const result = await adapter.listAssets();

    expect(result.assets).toHaveLength(2);
    expect(result.assets[0].name).toBe('Conveyor 1m');
    expect(result.assets[1].tags).toContain('robot');
  });

  it('should handle list failure gracefully', async () => {
    fetchSpy = mockFetch({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: () => Promise.resolve('auth error'),
    });

    const adapter = new UnityCloudAdapter(mockConfig);
    await expect(adapter.listAssets()).rejects.toThrow('Failed to list assets');
  });

  it('should return connection test result on success', async () => {
    fetchSpy = mockFetch({
      ok: true,
      json: () => Promise.resolve({ assets: [] }),
    });

    const adapter = new UnityCloudAdapter(mockConfig);
    const result = await adapter.testConnection();

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return connection test error on failure', async () => {
    fetchSpy = mockFetch({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: () => Promise.resolve('forbidden'),
    });

    const adapter = new UnityCloudAdapter(mockConfig);
    const result = await adapter.testConnection();

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should include search in filter body', async () => {
    fetchSpy = mockFetch({
      ok: true,
      json: () => Promise.resolve({ assets: [] }),
    });

    const adapter = new UnityCloudAdapter(mockConfig);
    await adapter.listAssets({ search: 'conveyor' });

    const call = fetchSpy.mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.filter.names).toEqual({ type: 'wildcard', value: '*conveyor*' });
  });

  it('should include pagination with sortingField', async () => {
    fetchSpy = mockFetch({
      ok: true,
      json: () => Promise.resolve({ assets: [] }),
    });

    const adapter = new UnityCloudAdapter(mockConfig);
    await adapter.listAssets({ limit: 25 });

    const call = fetchSpy.mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.pagination.sortingField).toBe('Name');
    expect(body.pagination.limit).toBe(25);
  });
});
