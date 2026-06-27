# Signal Architecture — GLB Import to React UI

This document describes the complete signal data flow in realvirtual WEB: how signals are imported from GLB files, wired between components, driven by behavior models, updated by external interfaces, and bound to React UI components.

---

## 1. Overview

```
 GLB (rv_extras)              CONNECT / Interface (WS/MQTT/TcHmi)
      │                                    │
      │ PLCOutputBool, PLCInputFloat...    │ import_answer / data messages
      │ ConnectSignal refs                 │ bufferIncoming()
      ▼                                    ▼
┌──────────────────────────────────────────────────────────────┐
│                       SIGNALSTORE                            │
│  byName:    Map<signalName, boolean | number>                │
│  pathToName: Map<hierarchyPath, signalName>                  │
│  subscribe(name, cb) → unsubscribe                           │
│  set(name, value) — equality check, then notify              │
│  setMany(batch) — atomic: all values first, then listeners   │
│  version — monotonic counter for polling optimization        │
└─────┬──────────┬──────────┬──────────┬───────────────────────┘
      │          │          │          │
   WIRING    DRIVES     SENSORS    LOGICSTEPS
   Connect   Behaviors  AABB/Ray   WaitFor/Set
   Signal    read/write collision  signal conditions
      │          │          │          │
      └──────────┴──────────┴──────────┘
                     │
              ┌──────┴──────┐
              │ REACT HOOKS │
              │ useSignal   │  ← event-driven (per-change)
              │ useSignalTick│ ← polling (200ms, version check)
              │ useDrives   │  ← model-loaded event
              │ useSensorSt │  ← sensor-changed event
              └─────────────┘
                     │
                     ▼
              React Components
              (re-render on change)
```

---

## 2. GLB Import — rv_extras to SignalStore

### 2.1 Signal Types in rv_extras

The Unity GLB exporter embeds signal definitions in each node's `userData.realvirtual`:

```json
{
  "PLCOutputBool": {
    "Status": { "Value": false },
    "Name": "ConveyorStart"
  },
  "PLCInputFloat": {
    "Status": { "Value": 100.0 },
    "Name": "DriveSpeed"
  }
}
```

**Six signal types** are recognized:

| rv_extras Key | SignalType | Direction | Meaning |
|---------------|-----------|-----------|---------|
| `PLCOutputBool` | bool | output (PLC writes) | Viewer reads this signal |
| `PLCInputBool` | bool | input (Viewer writes) | Viewer writes this signal |
| `PLCOutputFloat` | float | output | Numeric output from PLC |
| `PLCInputFloat` | float | input | Numeric input to PLC |
| `PLCOutputInt` | int | output | Integer output from PLC |
| `PLCInputInt` | int | input | Integer input to PLC |

**Direction convention** (from PLC perspective, identical to Unity C#):
- **Output** = PLC writes → Viewer reads (e.g., sensor state, encoder position)
- **Input** = Viewer writes → PLC reads (e.g., start button, speed setpoint)

### 2.2 Two-Phase Loading (Awake/Start)

The scene loader (`rv-scene-loader.ts`) processes components in two phases, mirroring Unity's `Awake()`/`Start()` lifecycle:

**Phase 1 — Awake (Construct + Register):**

```
traverseAndRegister(root):
  for each node with userData.realvirtual:
    1. Parse signal types → signalStore.register(name, path, initialValue)
    2. Construct component via registered factory (ComponentRegistry)
    3. Apply schema: map rv_extras fields → TypeScript instance properties
    4. Add to pending[] for Phase 2
```

**Phase 2 — Start (Initialize + Wire):**

```
initializeComponents(pending):
  for each pending component:
    1. Resolve ComponentRefs → signal addresses, sensor/drive instances
    2. Call component.init(context) → components wire their signals
```

**Why two phases?** ComponentRefs (e.g., Drive referencing a Sensor) can only be resolved after ALL nodes are constructed. Phase 2 runs after the full tree is built, so forward references work.

### 2.3 Signal Name Resolution

When registering a signal, the name is determined by priority:

1. Explicit `Name` field in rv_extras (highest priority)
2. Node alias (handles Three.js name deduplication like `Sensor_1`, `Sensor_2`)
3. Node name (fallback)

---

## 3. SignalStore — Central Signal Bus

### 3.1 Data Structure

```typescript
class SignalStore {
  private byName = new Map<string, boolean | number>();    // PRIMARY lookup
  private pathToName = new Map<string, string>();           // path → name mapping
  private listeners = new Map<string, Set<Callback>>();     // per-signal subscribers
  private _version = 0;                                     // monotonic change counter
}
```

**Dual-key design:**
- **byName**: Primary access — all reads/writes use signal name
- **pathToName**: Secondary — maps hierarchy paths to signal names (built by `buildIndex()` after load)

### 3.2 Core API

**Reading:**

```typescript
get(name: string): boolean | number | undefined
getBool(name: string): boolean           // coerced
getFloat(name: string): number           // coerced
getByPath(path: string): ...             // resolves path → name → value
```

**Writing:**

```typescript
set(name: string, value: boolean | number): void
  // 1. Equality check — skip if value unchanged
  // 2. Update byName map
  // 3. Increment version counter
  // 4. Notify all listeners for this signal

setMany(updates: Record<string, boolean | number>): void
  // ATOMIC batch: all values written first, then ALL listeners notified
  // Used by interfaces to flush incoming buffer in one shot
```

**Subscribing:**

```typescript
subscribe(name: string, cb: (value) => void): () => void
  // Returns unsubscribe function
  // Callback fires ONLY on actual value change (equality check in set())

subscribeByPath(path: string, cb): () => void
  // Resolves path to name, then subscribes by name
```

### 3.3 Path Resolution (Suffix Matching)

After `buildIndex()`, paths support suffix matching:

```typescript
// Full path: "DemoCell/Signals/ConveyorStart"
// All of these resolve to the same signal:
store.getByPath("DemoCell/Signals/ConveyorStart")  // exact match
store.getByPath("Signals/ConveyorStart")            // suffix match
store.getByPath("ConveyorStart")                    // shortest suffix
```

This allows components to reference signals by short names without knowing the full hierarchy.

---

## 4. Signal Wiring — ConnectSignal

### 4.1 Purpose

`ConnectSignal` (`rv-connect-signal.ts`) creates a one-way signal bridge: when the source signal changes, the value is copied to the target signal (this node's own signal path).

This mirrors Unity's `ConnectSignal` component which wires signals across the hierarchy.

### 4.2 rv_extras Format

```json
{
  "ConnectSignal": {
    "ConnectedSignal": {
      "type": "ComponentReference",
      "path": "Signals/SourceSignal",
      "componentType": "PLCOutputBool"
    }
  }
}
```

### 4.3 Wiring Flow

```typescript
// In init() (Phase 2 — Start):
init(context) {
  const sourceAddr = resolvedRef.signalAddress;  // resolved from ComponentRef
  const thisPath = this.node.userData.rvPath;

  // 1. Subscribe to source signal
  this._unsub = store.subscribeByPath(sourceAddr, (value) => {
    store.setByPath(thisPath, value);  // copy to self
  });

  // 2. Sync initial value immediately
  const initial = store.getByPath(sourceAddr);
  if (initial !== undefined) store.setByPath(thisPath, initial);
}
```

### 4.4 Wiring Helpers

`rv-signal-wiring.ts` provides shorthand functions that eliminate repetitive subscription boilerplate:

```typescript
// Subscribe a boolean signal to a setter function
wireBoolSignal(store, signalAddress, setter, debugLabel)

// Resolve ComponentRef first, then wire
wireRefBoolSignal(registry, store, componentRef, setter, debugLabel)
```

Used by sensors, safety doors, and other components that need to bind PLC signals to internal state.

---

## 5. Behavior Models — Components Using Signals

### 5.1 Drive

**File:** `rv-drive.ts`

Drives don't directly subscribe to signals. Instead, **DriveBehaviors** read signals and control the drive:

```
DriveBehavior (e.g., Drive_Simple, Drive_Cylinder)
  │
  │ init(): wire signals (JogForward, JogBackward, TargetSpeed, etc.)
  │
  │ update(dt):
  │   read wired signals
  │   set drive.jogForward / drive.targetSpeed / etc.
  │
  ▼
RVDrive
  │
  │ update(dt):
  │   [1] call behaviors[].update(dt)     // behaviors set targets
  │   [2] apply physics (acceleration, limits)
  │   [3] applyToNode()                    // write to Three.js transform
  │   [4] onAfterUpdate?.()               // feedback signals
```

**Signal pattern:**
- **Input signals** (PLC → Drive): JogForward, JogBackward, TargetSpeed, DriveTo
- **Output signals** (Drive → PLC): CurrentPosition, CurrentSpeed, AtTarget, IsAtLimit

### 5.2 Sensor

**File:** `rv-sensor.ts`

Sensors detect MU (Moving Unit) presence via AABB intersection or raycast.

```
init():
  store.register(sensorName, sensorPath, false)
  wireBoolSignal(store, SignalOccupied, setter)

update(dt):
  occupied = checkCollision(MUs)    // AABB or raycast
  store.set(sensorName, occupied)   // → listeners notified → PLC reads this
```

### 5.3 LogicStep

**File:** `rv-logic-step.ts`

LogicSteps form a sequencer (SerialContainer/ParallelContainer):

```
State machine: Idle → Active → Waiting → Finished

Subclasses:
  LogicStep_SetSignalBool:   store.set(signalName, value)    on activate
  LogicStep_WaitForSignalBool: poll store.get(signalName)     each tick
  LogicStep_WaitForSensor:    poll store.get(sensorSignal)    each tick
```

LogicSteps read signals via `store.get()` in their tick function (polling, not subscription) because they need to check conditions synchronously within the simulation loop.

### 5.4 Source / Sink

- **Source**: Subscribes to a start signal → spawns MU when signal goes true
- **Sink**: Destroys MUs that enter its AABB zone

### 5.5 TransportSurface

- Reads a boolean start signal to enable/disable conveyor motion
- Speed comes from a linked Drive's current speed

---

## 6. External Interfaces — CONNECT / Live Mode

### 6.1 Buffer-Flush Pattern

All external interfaces (WebSocket Realtime, MQTT, TwinCAT HMI, CONNECT) use the same pattern defined in `base-industrial-interface.ts`:

```
┌─────────────────────────────────────────────────────────┐
│  Async Protocol Callbacks                                │
│  (WebSocket.onmessage, MQTT.on('message'), etc.)         │
│                                                          │
│  → bufferIncoming({ signalName: value, ... })            │
│    writes to pendingIncoming Map (dedup, last-wins)      │
└──────────────────────┬──────────────────────────────────┘
                       │
  ─── 60 Hz Simulation Loop ───────────────────────────────
                       │
  onFixedUpdatePre(dt):│  ← BEFORE drive physics
    flush pendingIncoming → signalStore.setMany(batch)
    pendingIncoming.clear()
                       │
  [Drive Physics, Sensor Updates, LogicStep Ticks]
                       │
  onFixedUpdatePost(dt):│ ← AFTER drive physics
    drain dirtyOutgoing → sendSignals(outgoing)
    dirtyOutgoing.clear()
                       │
  ─────────────────────────────────────────────────────────
```

**Why buffered?** Async protocol callbacks arrive on the event loop at arbitrary times. The buffer ensures all signal updates are applied atomically at a consistent point in the simulation frame — synchronized with drive physics.

### 6.2 Signal Registration

Interface-discovered signals are registered with a prefix to avoid collision with GLB signals:

```typescript
// GLB signal:      signalStore.register("ConveyorStart", "Signals/ConveyorStart", false)
// Interface signal: signalStore.register("ConveyorStart", "__iface__/ConveyorStart", false)
```

When both exist, the interface value overwrites the GLB value on every flush (live mode override).

### 6.3 Output Signal Tracking

For signals where the Viewer writes to the PLC:

```typescript
// During discovery, subscribe to all 'output' direction signals:
subscribeToOutputSignals(signals) {
  for (const sig of signals.filter(s => s.direction === 'input')) {
    store.subscribe(sig.name, (value) => {
      // Don't echo back values we just received from the PLC
      if (this.pendingIncoming.has(sig.name)) return;
      this.dirtyOutgoing.set(sig.name, value);
    });
  }
}
```

### 6.4 CONNECT Integration

CONNECT uses the **existing WebSocket Realtime v2 protocol** — from realvirtual WEB's perspective, it's identical to connecting to Unity. realvirtual WEB doesn't know (or care) whether signals come from Unity or CONNECT:

```
Unity + PLC:     PLC → Unity → WebSocket v2 → realvirtual WEB
CONNECT + PLC:   PLC → CONNECT → WebSocket v2 → realvirtual WEB
```

Same protocol, same SignalStore, same React hooks, same behavior models.

---

## 7. React UI Binding — SignalStore to Components

### 7.1 useSignal — Event-Driven Binding

**File:** `hooks/use-signal.ts`

The primary hook for binding a React component to a single signal:

```typescript
function useSignal(addr: string): boolean | number | undefined {
  const viewer = useViewer();
  const [value, setValue] = useState(() => viewer.signalStore?.get(addr));

  useEffect(() => {
    const store = viewer.signalStore;
    if (!store) { setValue(undefined); return; }

    setValue(store.get(addr));                    // sync initial
    return store.subscribe(addr, setValue);       // re-render on change
  }, [viewer, addr]);

  return value;
}
```

**Characteristics:**
- Re-renders **immediately** on every signal change
- Unsubscribes on unmount or addr change
- Re-subscribes on `model-loaded` / `model-cleared`

**Use case:** Control panels, status indicators, real-time displays

### 7.2 useSignalWrite — Write-Only Binding

```typescript
function useSignalWrite(addr: string): (v: boolean | number) => void {
  const viewer = useViewer();
  return useCallback(
    (v) => viewer.signalStore?.set(addr, v),
    [viewer]
  );
}
```

**Use case:** Buttons, sliders, input fields that write to PLC signals

### 7.3 useSignalTick — Polling Binding

**File:** `hooks/use-signal-tick.ts`

For UI that doesn't need instant updates (dashboards, badges):

```typescript
function useSignalTick(store: SignalStore, intervalMs = 200): number {
  const [tick, setTick] = useState(0);
  const lastVersion = useRef(-1);

  useEffect(() => {
    const id = setInterval(() => {
      if (store.version !== lastVersion.current) {
        lastVersion.current = store.version;
        setTick(t => t + 1);  // force re-render
      }
    }, intervalMs);
    return () => clearInterval(id);
  }, [store, intervalMs]);

  return tick;
}
```

**Characteristics:**
- Polls every 200ms (configurable)
- Skips re-render if no signals changed (version counter optimization)
- Lower CPU cost than per-signal subscriptions for many signals

**Use case:** Property Inspector, Hierarchy Browser signal badges

### 7.4 Component-Specific Hooks

| Hook | Data Source | Trigger | Use Case |
|------|-----------|---------|----------|
| `useDrives()` | `viewer.drives` | `model-loaded` event | Drive list in TopBar |
| `useSensorState(path)` | Viewer event | `sensor-changed` event | Sensor status indicator |
| `useInterfaceStatus(id)` | Viewer events | `interface-connected/disconnected` | Connection badge |
| `useDriveChartOpen()` | Viewer event | `drive-chart-toggle` | Drive chart overlay open/close state |
| `useSensorChartOpen()` | Viewer event | `sensor-chart-toggle` | Sensor chart overlay open/close state |
| `useKpiData()` | SignalStore + timer | Periodic polling | KPI dashboard cards |

### 7.5 Pattern Selection Guide

| Scenario | Hook | Why |
|----------|------|-----|
| Single signal, instant update | `useSignal` | Event-driven, minimal latency |
| Write a signal from UI | `useSignalWrite` | Stable callback ref, no re-render |
| Dashboard with many values | `useSignalTick` | Polling avoids per-signal subscription overhead |
| Drive/Sensor list | `useDrives` / `useSensorState` | Event-based, not signal-based |
| Drive/Sensor chart overlay state | `useDriveChartOpen` / `useSensorChartOpen` | Toggle chart panel visibility |

The actual chart data sampling / ring-buffer lives inside `DriveRecorderPlugin` / `SensorRecorderPlugin`, not in these hooks. `useDriveChartOpen()` / `useSensorChartOpen()` only return whether the chart overlay is open.

---

## 8. Component Registry — Auto-Mapping C# to TypeScript

### 8.1 Schema-Based Mapping

The ComponentRegistry (`rv-component-registry.ts`) maps C# component types to TypeScript implementations:

```typescript
registry.register('Drive', {
  factory: (node, extras) => new RVDrive(node, extras),
  schema: {
    TargetSpeed:   { type: 'number', default: 100 },
    Acceleration:  { type: 'number', default: 200 },
    Direction:     { type: 'enum', enumMap: DriveDirectionMap, default: 0 },
    JogForward:    { type: 'componentRef' },  // resolved in Phase 2
    JogBackward:   { type: 'componentRef' },
  }
});
```

### 8.2 Schema Types

| Schema Type | rv_extras Value | TypeScript Result |
|-------------|----------------|-------------------|
| `number` | `42.5` | `Number(42.5)` |
| `boolean` | `true` | `Boolean(true)` |
| `string` | `"hello"` | `String("hello")` |
| `vector3` | `{x, y, z}` | `new Vector3()` (with coord transform) |
| `componentRef` | `{type, path, componentType}` | Resolved to signal address or component instance in Phase 2 |
| `componentRefArray` | `[{...}, {...}]` | Array of resolved refs |
| `enum` | `1` | Looked up via `enumMap` |

### 8.3 ComponentRef Resolution

In Phase 2, ComponentRefs are resolved based on their `componentType`:

```
PLCOutputBool/Float/Int → resolves to signal address (string)
PLCInputBool/Float/Int  → resolves to signal address (string)
Sensor                  → resolves to RVSensor instance
Drive                   → resolves to RVDrive instance
IKPath/IKTarget         → resolves to component instance
Other                   → resolves to node path (string)
```

---

## 9. Signal Lifecycle — Complete Example

A conveyor start button pressed in the realvirtual WEB React UI:

```
1. User clicks button in React HMI
   └─ useSignalWrite("ConveyorStart") → store.set("ConveyorStart", true)

2. SignalStore.set()
   └─ equality check (was false, now true) → update + notify
   └─ version++ (for polling hooks)
   └─ notify listeners:
       ├─ Interface subscriber → dirtyOutgoing.set("ConveyorStart", true)
       ├─ ConnectSignal subscriber → copies to linked signals
       └─ React useSignal subscriber → setValue(true) → re-render

3. onFixedUpdatePost (60Hz, after physics)
   └─ Interface.sendSignals({ "ConveyorStart": true })
   └─ WebSocket/MQTT/TcHmi → PLC receives the signal

4. PLC sets ConveyorSpeed = 500mm/s (output signal)

5. Interface receives PLC response
   └─ bufferIncoming({ "ConveyorSpeed": 500 })

6. onFixedUpdatePre (next frame, before physics)
   └─ signalStore.setMany({ "ConveyorSpeed": 500 })
   └─ Drive_Simple behavior reads ConveyorSpeed → sets drive.targetSpeed
   └─ TransportSurface starts moving MUs

7. React hooks update
   └─ useSignal("ConveyorSpeed") → re-renders speed display
   └─ useSignalTick → version changed → Inspector badge updates
```

---

## 10. Key Design Principles

### Signal-Agnostic Components

Drives, sensors, and LogicSteps read/write signals by name. They don't know whether the signal comes from:
- GLB defaults (standalone simulation)
- Unity via WebSocket (live mode)
- CONNECT via WebSocket (direct PLC)
- MQTT broker (IoT mode)
- TwinCAT HMI server (Beckhoff direct)

This makes adding new signal sources trivial — implement `BaseIndustrialInterface`, connect to SignalStore, done.

### Accessing SignalStore from Plugins

In addition to the direct `viewer.signalStore` reference, plugins that extend
`BaseViewerPlugin` can access signals via the `PluginContext` live-getter:

```typescript
// ctx.signals is a live getter — returns null before model load.
// Prefer this in init() callbacks and onTick() handlers:
const signals = this.context.signals;
if (signals) {
  signals.setMany({ ConveyorStart: true, Speed: 500 });
}
```

`this.context.signals` and `viewer.signalStore` point to the same `SignalStore`
instance after model load. The context version is preferred because it makes the
null-before-model-load contract explicit.

### Subscription vs Polling

| Pattern | When to Use | Cost |
|---------|------------|------|
| `subscribe()` | Single signal, instant response needed | 1 callback per change per listener |
| `version` polling | Many signals, periodic UI refresh | 1 interval timer, 1 integer compare |
| Direct `get()` | Synchronous read in simulation loop | Zero overhead (Map.get) |

### Atomic Batch Updates

`setMany()` ensures all interface signals are applied in one shot before any listener fires. This prevents intermediate states where some signals are updated but others aren't — critical for coordinated PLC logic.

### No Signal Validation

Type coercion happens on read (`getBool`, `getFloat`), not on write. Any value can be set for any signal. This matches Unity's behavior where signals are dynamically typed.
