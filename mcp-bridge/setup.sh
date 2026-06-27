#!/usr/bin/env bash
# One-time setup for the realvirtual WEB MCP bridge.
set -e
cd "$(dirname "$0")"
echo "=== Installing dependencies ==="
npm install
echo "=== Building ==="
npm run build
echo
echo "Done. Next:"
echo "  1) In Unity: Tools > realvirtual > Settings > Configure Claude Desktop MCP"
echo "  2) Restart Claude Desktop / Claude Code"
echo "  3) In realvirtual WEB settings, turn the AI Bridge on"
