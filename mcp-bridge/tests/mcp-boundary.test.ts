// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createBridgeServer, type BridgeServer } from '../src/server-factory.js';
import { MockBrowserClient, waitFor } from './mock-browser-client.js';

beforeAll(() => {
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

function discoverMsg(names: string[]) {
  return {
    type: 'discover',
    schema_version: '1.0.0',
    instructions: '# test instructions',
    tools: names.map((name) => ({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {}, required: [] },
    })),
  };
}

async function connectClient(bs: BridgeServer): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([bs.server.connect(serverT), client.connect(clientT)]);
  return client;
}

describe('MCP boundary (InMemoryTransport)', () => {
  it('lists no tools before discover, the announced tools after, and routes a call', async () => {
    const bs = createBridgeServer({ port: 0, autoStart: false, instructions: 'hi' });
    await bs.bridge.start();
    const client = await connectClient(bs);

    let listChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { listChanged++; });

    expect((await client.listTools()).tools).toEqual([]);

    const browser = await MockBrowserClient.connect(bs.bridge.port);
    await waitFor(() => bs.bridge.connected);
    browser.send(discoverMsg(['web_status', 'web_drive_list']));
    await waitFor(() => listChanged > 0, 3000);

    const after = await client.listTools();
    expect(after.tools.map((t) => t.name).sort()).toEqual(['web_drive_list', 'web_status']);

    const callP = client.callTool({ name: 'web_status', arguments: {} });
    const call = await browser.nextOfType('call');
    expect(call.tool).toBe('web_status');
    browser.send({ type: 'result', id: call.id, result: '{"fps":60}' });
    const res = await callP;
    expect((res.content as Array<{ text: string }>)[0].text).toContain('fps');

    await browser.close();
    await bs.bridge.close();
    await bs.server.close();
    await client.close();
  });

  it('unwraps a single stringified "kwargs" argument before forwarding', async () => {
    const bs = createBridgeServer({ port: 0, autoStart: false });
    await bs.bridge.start();
    const client = await connectClient(bs);

    const browser = await MockBrowserClient.connect(bs.bridge.port);
    await waitFor(() => bs.bridge.connected);
    browser.send(discoverMsg(['web_signal_set_bool']));
    await waitFor(() => bs.registry.has('web_signal_set_bool'), 3000);

    const callP = client.callTool({
      name: 'web_signal_set_bool',
      arguments: { kwargs: '{"name":"D1","value":true}' },
    });
    const call = await browser.nextOfType('call');
    expect(call.arguments).toEqual({ name: 'D1', value: true });
    browser.send({ type: 'result', id: call.id, result: '{"ok":true}' });
    await callP;

    await browser.close();
    await bs.bridge.close();
    await bs.server.close();
    await client.close();
  });

  it('returns an isError result for an unknown tool', async () => {
    const bs = createBridgeServer({ port: 0, autoStart: false });
    await bs.bridge.start();
    const client = await connectClient(bs);

    const res = await client.callTool({ name: 'web_does_not_exist', arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain('Unknown tool');

    await bs.bridge.close();
    await bs.server.close();
    await client.close();
  });

  it('returns an isError result when no browser is connected', async () => {
    const bs = createBridgeServer({ port: 0, autoStart: false });
    await bs.bridge.start();
    const client = await connectClient(bs);
    // register a tool without any browser by replacing the registry directly
    bs.registry.replace([
      { name: 'web_status', description: 'status', inputSchema: { type: 'object', properties: {}, required: [] } },
    ]);

    const res = await client.callTool({ name: 'web_status', arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain('not connected');

    await bs.bridge.close();
    await bs.server.close();
    await client.close();
  });

  it('clears the tool registry and emits list_changed when the browser disconnects', async () => {
    const bs = createBridgeServer({ port: 0, autoStart: false });
    await bs.bridge.start();
    const client = await connectClient(bs);
    let listChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { listChanged++; });

    const browser = await MockBrowserClient.connect(bs.bridge.port);
    await waitFor(() => bs.bridge.connected);
    browser.send(discoverMsg(['web_a', 'web_b']));
    await waitFor(() => bs.registry.size === 2, 3000);
    const afterDiscover = listChanged;

    await browser.close();
    await waitFor(() => bs.registry.size === 0, 3000);
    expect((await client.listTools()).tools).toEqual([]);
    expect(listChanged).toBeGreaterThan(afterDiscover); // list_changed also fires on disconnect

    await bs.bridge.close();
    await bs.server.close();
    await client.close();
  });
});
