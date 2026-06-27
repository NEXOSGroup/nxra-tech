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
| Building a layout / scene in the browser (no Unity) | `web_set_mode` + `web_library_list` + `web_place` + … (authoring tools) |

## Important: web_* Tools Operate on Browser State

- `web_drive_list` shows Three.js drive positions (may differ from Unity if playback diverges)
- `web_signal_set_bool` / `web_signal_set_float` write directly in the browser's SignalStore
- Unity tools modify the Unity scene; `web_*` tools modify the browser scene
- Both can run simultaneously for side-by-side comparison
- The **authoring** tools (`web_place`, `web_move`, `web_component_set`, …) build a layout in the browser's Layout Planner — no Unity required. Switch to planner mode first with `web_set_mode`.

## Available Tools

### Inspect (read browser state)

| Tool | Description | Parameters |
|------|-------------|------------|
| `web_status` | Connection info, FPS, model URL, drive/signal/sensor counts | none |
| `web_drive_list` | All drives with current position, speed, direction, limits | none |
| `web_signal_list` | All PLC signals with current values (bool/int/float) | none |
| `web_sensor_list` | All sensors with occupancy status | none |
| `web_transport_status` | MU counts, source/sink stats, active transport surfaces | none |
| `web_logic_flow` | LogicStep hierarchy with step states and progress | none |
| `web_logs` | Recent browser console logs (errors, warnings, debug) | `level` (optional), `limit` (optional) |
| `web_find` | Search nodes by name (case-insensitive substring); returns paths + component types | `term` |
| `web_hierarchy` | Scene hierarchy tree from a root path (or whole scene) with component types | `root` (optional), `depth` (optional, default 3) |
| `web_component_get_all` | All components on a node (types + properties) | `path` |
| `web_component_get` | A specific component on a node (properties) | `path`, `type` |
| `web_components_by_type` | All components of a type across the scene (paths + properties) | `type` |
| `web_screenshot` | Capture a JPEG screenshot of the 3D scene. Optionally crop to a node's bounding box or a manual region (fractions 0..1). Returns base64 image data. | `path` (optional), `x`/`y`/`w`/`h` (optional) |

### Control & run

| Tool | Description | Parameters |
|------|-------------|------------|
| `web_signal_set_bool` | Write a boolean signal in the browser | `name`, `value` |
| `web_signal_set_float` | Write a float signal in the browser | `name`, `value` |
| `web_drive_jog` | Jog a drive forward or backward | `name`, `forward` (optional, default true) |
| `web_drive_stop` | Stop a drive (clear jog flags) | `name` |
| `web_drive_speed_override` | Master speed multiplier for all drives (1=normal, 0.5=half, 2=double, 0=stopped). Omit `factor` to read the current value. | `factor` (optional) |
| `web_sim_play_pause` | Play / pause the realvirtual WEB simulation (`'user'` pause reason) | `paused` (optional — omit to toggle) |
| `web_sim_reset` | Clear MUs + LogicSteps (drives and signals untouched) | none |
| `web_set_source_markers` | Show or hide the floor markers (ring + label) under every Source. Persists in localStorage. | `visible` (default true) |

### Build & author (Layout Planner)

Switch to planner mode first: `web_set_mode` with `mode=planner`.

| Tool | Description | Parameters |
|------|-------------|------------|
| `web_set_mode` | Switch workspace mode: `hmi` / `planner` / `des` | `mode` |
| `web_library_list` | List available library components (parts catalog): catalogId, name, category, footprintMm (`[x,z]` mm when known) | none |
| `web_library_describe` | Detailed build docs for a library component: purpose, material-flow direction, snaps, key config. Pass a `catalogId` from web_library_list. | `catalogId` |
| `web_place` | Place a library component at a world position (meters). Returns the new placement id | `catalogId`, `x`, `y`, `z` |
| `web_snap_list` | List the free (unoccupied) snap points of a placed component: snapName, typeId, flow, axis, dirCode | `id` |
| `web_snap_suggest` | Library components compatible with a free snap (same typeId + compatible flow): `[{catalogId, name, ownSnapName}]` | `targetId`, `targetSnapName` (optional) |
| `web_snap_attach` | Attach a component onto a free snap of an existing placement (auto-aligned). Returns the new placement id | `targetId`, `catalogId`, `targetSnapName` (optional) |
| `web_move` | Move / rotate a placement (position meters, rotation degrees) | `id`, `x`, `y`, `z`, `rx`/`ry`/`rz` (optional) |
| `web_remove` | Remove a placement by id | `id` |
| `web_placement_list` | List placed components: id, catalogId, label, position, rotation, and world `bounds` (center + size, meters) | none |
| `web_component_set` | Set component config properties (rv_extras overrides), e.g. a drive speed | `path`, `type`, `props` (JSON object) |
| `web_scene_save` | Export the current layout as a JSON scene snapshot (placements + catalogs + grid) | `name` (optional) |
| `web_scene_new` | Create a new empty scene, clearing the current layout. | none |
| `web_scene_open` | Open/switch to a saved scene by id (from web_scene_list). | `id` |
| `web_scene_list` | List all saved scenes (id, name, baseKind) plus built-in scenes. | none |
| `web_scene_export` | Export the current layout as a raw JSON snapshot (placements + catalog sources + grid) without persisting it. | none |

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

### Build a conveyor layout in the browser (no Unity)
1. `web_set_mode` (`mode=planner`) — enter the Layout Planner
2. `web_library_list` — discover available parts (catalogId, name, category, footprintMm)
3. `web_place` — drop the first part at a world position (meters)
4. `web_snap_list` (placement id) — see the part's free snap points (open ports)
5. `web_snap_suggest` (id, snapName) — see which parts fit that snap *(optional)*
6. `web_snap_attach` (targetId, catalogId, snapName) — attach the matching next part, auto-aligned; repeat to chain the line
7. `web_component_set` — configure behavior (e.g. a drive `TargetSpeed`, a source spawn interval)
8. `web_placement_list` — review positions + world `bounds` (geometric check)
9. `web_set_mode` (`mode=hmi`) + `web_sim_play_pause` — run it
10. `web_scene_save` — export the layout JSON

> `web_move` is the manual alternative to snap-attach when you need free positioning instead of snapped connections.

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
Claude (Desktop / Code) <-- stdio (MCP) --> Node MCP bridge (mcp-bridge/)
                                              |
                                              |-- WS SERVER (:18714)
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
  - realvirtual WEB connects to `ws://localhost:18714/webviewer` (Node bridge; the Unity Python bridge stays on 18712)
- If data seems stale, the browser pushes fresh data on every tool call (no polling)
