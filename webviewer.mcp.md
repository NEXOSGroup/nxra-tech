# realvirtual WEB MCP Tools

Product: **realvirtual WEB** (browser-based 3D viewer for industrial digital twins)

The `web_*` tools provide runtime access to realvirtual WEB running in a browser.
They read and control the Three.js scene directly — no Unity Editor required.

## When to Use web_* vs Unity Tools

| Scenario | Use |
|----------|-----|
| Working in Unity Editor only | Unity tools (`drive_list`, `component_get`, etc.) |
| Debugging realvirtual WEB rendering or behavior | `web_*` tools |
| realvirtual WEB standalone (no Unity running) | `web_*` tools only |
| Comparing Unity vs realvirtual WEB state | BOTH — e.g. `drive_list` AND `web_drive_list` |
| Writing signals when Unity is not running | `web_signal_set_bool` / `web_signal_set_float` |

## Important: web_* Tools Operate on Browser State

- `web_drive_list` shows Three.js drive positions (may differ from Unity if playback diverges)
- `web_signal_set_bool` / `web_signal_set_float` write directly in the browser's SignalStore
- Unity tools modify the Unity scene; `web_*` tools modify the browser scene
- Both can run simultaneously for side-by-side comparison

## Available Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `web_status` | Connection info, FPS, model URL, drive/signal/sensor counts | none |
| `web_drive_list` | All drives with current position, speed, direction, limits | none |
| `web_signal_list` | All PLC signals with current values (bool/int/float) | none |
| `web_signal_set_bool` | Write a boolean signal in the browser | `name`, `value` |
| `web_signal_set_float` | Write a float signal in the browser | `name`, `value` |
| `web_drive_jog` | Jog a drive forward or backward | `name`, `forward` (optional, default true) |
| `web_drive_stop` | Stop a drive (clear jog flags) | `name` |
| `web_sensor_list` | All sensors with occupancy status | none |
| `web_transport_status` | MU counts, source/sink stats, active transport surfaces | none |
| `web_logic_flow` | LogicStep hierarchy with step states and progress | none |
| `web_logs` | Recent browser console logs (errors, warnings, debug) | `level` (optional), `limit` (optional) |
| `web_sim_play_pause` | Play / pause the realvirtual WEB simulation (`'user'` pause reason) | `paused` (optional — omit to toggle) |
| `web_sim_reset` | Clear MUs + LogicSteps (drives and signals untouched) | none |
| `web_set_source_markers` | Show or hide the floor markers (ring + label) under every Source. Persists in localStorage. | `visible` (default true) |

## Common Workflows

### Debug a drive not moving in realvirtual WEB
1. `web_drive_list` — check position, speed, isRunning
2. `web_signal_list` — check if control signals are set correctly
3. `web_logs` — look for errors during drive initialization

### Compare Unity and realvirtual WEB state
1. `drive_list` (Unity) — get Unity drive positions
2. `web_drive_list` (realvirtual WEB) — get browser drive positions
3. Compare positions — they should match if playback is synced

### Control realvirtual WEB without Unity
1. `web_signal_set_bool` — set start/stop signals
2. `web_drive_jog` — manually jog drives
3. `web_transport_status` — monitor MU flow

### Diagnose sensor issues
1. `web_sensor_list` — check which sensors are occupied
2. `web_transport_status` — verify MUs are being created and consumed
3. `web_signal_list` — check sensor output signals

## Viewer Helper Methods Available to MCP Tools

When writing or extending `@McpTool` handlers in `rv-mcp-tools.ts`, these viewer
helpers are available on the `RVViewer` instance:

```typescript
// Iterate NodeRegistry entries (objects with rv_extras — NOT a full scene.traverse):
viewer.eachNode((path, node) => { /* inspect userData.realvirtual */ });

// Project a 3D node or point to screen pixels:
const screen = viewer.projectToScreen(node);        // Vector2
const screen2 = viewer.projectPoint(worldVec3);     // Vector2

// Get current camera state (position, target, quaternion):
const cam = viewer.getCameraState();    // { position, target, quaternion }

// Set OrbitControls options:
viewer.setControlsConfig({ rotateSpeed: 0.8, enabled: false });

// Toggle renderer info logging:
viewer.setDebugLogging(true);
```

These are safe to call from any MCP tool that receives the viewer reference.

## Architecture

The realvirtual WEB MCP bridge uses WebSocket communication:

```
Claude Code <-- stdio (MCP) --> Python MCP server
                                   |
                                   |-- WS SERVER (:18712)
                                       <-- WS CLIENT (Browser)
```

The browser connects automatically when realvirtual WEB loads (dev mode or `?mcp=1`).
Tools are auto-discovered via TypeScript `@McpTool` / `@McpParam` decorators.

## Connection States

- **Connected**: Browser is connected, all `web_*` tools operational
- **Not connected**: Browser closed or not loaded — tools return `"WebViewer not connected"`
- **Reconnecting**: Browser auto-reconnects with exponential backoff (1s to 30s)

## Troubleshooting

- If `web_*` tools return "WebViewer not connected":
  - Check if the browser tab is open
  - Check browser DevTools console for WebSocket errors
  - realvirtual WEB connects to `ws://localhost:18712/webviewer`
- If data seems stale, the browser pushes fresh data on every tool call (no polling)
