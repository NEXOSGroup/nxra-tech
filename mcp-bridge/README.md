# realvirtual WEB — MCP Bridge (Node/TS)

Local MCP server that connects an AI assistant (Claude Desktop / Claude Code) to a
running **realvirtual WEB** browser session.

- **stdio side:** exposes itself as an MCP server (low-level `@modelcontextprotocol/sdk` `Server`).
- **WebSocket side:** hosts a server on `127.0.0.1:18714` (`/webviewer`); the browser connects as a client.
- **Dynamic tools:** the browser announces its `web_*` tools via a `discover` handshake; they are
  registered as MCP tools at runtime. Adding a tool means decorating a method in the browser
  (`@McpTool`) — no change here.

The browser side (`src/plugins/mcp-bridge-plugin.ts`) is unchanged; this Node bridge replaces the
WebViewer half of the legacy Python MCP server on the same port.

## Build & run

```bash
npm install
npm run build       # tsc -> dist/index.js
npm run typecheck   # tsc --noEmit over src + tests
npm test            # vitest (node environment)
```

> **First use:** `dist/` is git-ignored. Run `npm install && npm run build` before pointing
> `.mcp.json` at `dist/index.js`.

## Wire-up (`.mcp.json`)

```jsonc
{
  "mcpServers": {
    "UnityMCP":  { "command": "<python>", "args": ["unity_mcp_server.py"] },
    "WebViewerMCP": { "command": "node", "args": ["<abs>/mcp-bridge/dist/index.js", "--web-port", "18714"] }
  }
}
```

The Unity Python server keeps its old standard (Unity 18711 + its own WebViewer bridge 18712);
this Node bridge runs in parallel on a **separate port 18714**. Point the browser at 18714
(Settings -> AI Bridge -> Port) to use the Node bridge. Override with `--web-port <N>` or `RV_WEB_PORT`.

## WebSocket protocol

| Direction | type | fields |
|-----------|------|--------|
| browser → server | `discover` | `tools[]`, `instructions`, `schema_version` |
| browser → server | `result`   | `id`, `result` \| `error` |
| browser → server | `control`  | `action`: `pause` \| `resume` \| `shutdown` |
| server → browser | `call`     | `id`, `tool`, `arguments` |
| server → browser | `log`      | `lines[]`: `{ level, ts, msg }` |

stdout is reserved for JSON-RPC — all logging goes to stderr (and is mirrored to the browser via `log`).
