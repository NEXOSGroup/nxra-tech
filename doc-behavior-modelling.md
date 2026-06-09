# Behavior Modelling — Continuous & DES

realvirtual WEB models material-flow components — conveyors, turntables, sources, sinks,
stations, storages — as **component definitions** that run in two simulation paradigms from
a single source of truth:

- **Continuous** — fixed 60 Hz step, MUs move over transport surfaces, sensors are AABB
  overlaps, drives jog belts and axes.
- **DES (discrete-event)** — an event queue jumps time between events; flow is driven by a
  `canAccept → accept → transfer` handshake instead of physics.

The same component definition serves both. The decision logic is written once; only the way it
is *triggered* and the *effect* it produces differ per paradigm.

## defineMaterialFlow — three layers

A component is one `defineMaterialFlow({ type, kind, models, schema, logic, continuous, des })`
in one file:

```ts
defineMaterialFlow({
  type: 'Conveyor',           // stable id: rv_extras key AND DES action namespace
  kind: 'conveyor',           // conveyor | router | station | source | sink | storage
  models: ['*Conveyor*'],     // GLB / placed-asset name matcher (glob)
  schema: { /* mode-agnostic params from rv_extras */ },
  logic:      { /* shared: state machine + routing decisions — no time, no physics */ },
  continuous: { setup, fixedUpdate },   // adapter: trigger = sensor/surface/poll, effect = physics
  des:        { onAccept, onArrival, /* ... */ }, // adapter: trigger = events, effect = time
})
```

- **schema** — parameters parsed from the GLB `rv_extras`, identical in both worlds.
- **logic** — the paradigm-independent brain: routing (`selectInput`/`selectOutput`),
  the flow decision (`shouldFlow`), and state-machine transitions (`enter`, `onPartArrived`,
  `onRotationDone`, …). It reads and mutates `self` only; it never touches time or geometry.
- **continuous** — a thin adapter. `setup(self)` resolves nodes, declares signals, wires
  sensor subscriptions and context menus. `fixedUpdate(self, dt)` reads triggers (sensor edges,
  surface occupancy, `drive.isAtTarget`) and applies physical effects (belt jog, drive moveTo).
- **des** — a thin adapter consumed by the DES runner. Hooks (`canAccept`, `onAccept`,
  `onArrival`, `onRotateComplete`, `onDownstreamReady`, …) react to scheduled events and apply
  time-based effects (`self.in(delay, 'Arrival', mu)`, `self.transfer(mu, port)`).

The `logic` block is the shared core both adapters call; `continuous` and `des` are only the
edges where the same decisions meet 60 Hz physics or an event queue.

## The `self` context

Every layer receives the same per-instance `self` — a facade over the runtime:

| Member | Purpose |
|---|---|
| `signals.get/set/on`, `signal(name, opts)` | instance-scoped PLC signals; live signals override local behavior |
| `drive(ref)` | resolved drive handle (`moveTo`, `jogForward`, `isAtTarget`, `currentSpeed`) |
| `ports`, `inputs()`, `outputs()`, `freeOutputs()` | connections resolved from the snap graph |
| `state`, `setState(name)` | the FSM string |
| `prop` | snapshot-safe key/value bag (survives DES snapshots) |
| `transfer(mu, fromPort?)` | hand a MU to a downstream component |
| `in(delay, hook, mu?)`, `at(time, hook, mu?)` | DES scheduling (continuous: inert) |
| `contextMenu(target, items)` | right-click actions |

Signals are always available and runner-independent: in continuous mode they are live
subscriptions; in DES mode signal edges become events. This is what lets one logic layer run
unchanged in both worlds — and what lets a live PLC override local behavior in either.

## Zone occupancy is surface-based

A conveyor or turntable zone is **occupied** when a MU is physically on its belt surface —
not merely at a point sensor. `isSurfaceOccupied(viewer, beltNode)` detects this, and the
component publishes `Conveyor.Occupied` from it **every tick**, reflecting "a good anywhere on
the belt" (one good per zone).

This is distinct from the local point sensor. The sensor drives a separate `partAtSensor`
discharge trigger (and the part counter); it does not publish occupancy. So:

- **published occupancy** (surface) = what the upstream neighbour reads as back-pressure.
- **local sensor trigger** = what gates discharge in the ZPA rule.

## The interlock is a name convention

Components coordinate through **named signals, not object references** — so the same logic
works in continuous, live-PLC, and DES modes. There is no compile-time interface; participation
is by publishing the agreed signal name:

- each component publishes `Conveyor.Occupied` (root), and a multi-port router additionally
  publishes `Conveyor.Occupied@<portId>` per input port, keyed by the **stable snap id**.
- an upstream component reads its downstream neighbour's `Conveyor.Occupied[@id]` — the per-port
  signal for the exact port it mates to, falling back to the root signal. No successor → treated
  as **blocked** (a part holds at the end of the line instead of discharging into nothing).
- the **ZPA release rule**: run unless a part is held locally **and** the downstream zone is
  occupied.

Any component that publishes `Conveyor.Occupied` joins the line: a conveyor, a turntable, a sink
(which publishes `false` so the line discharges into it), or a customer machine. The snap graph
defines *who* the downstream neighbour is; the signal name defines *how* they coordinate.

## Continuous modelling

- `continuous.fixedUpdate(self, dt)` runs at a fixed 60 Hz after transport surfaces advance MUs.
- belt/axis motion is commanded through drive handles; topology (downstream neighbour, router
  ports) is resolved from the snap graph and refreshed periodically as the layout changes.
- back-pressure is physical: when the flow decision is false, the belt stops and parts queue.

## DES modelling

- a downstream component is reached by reference through its port: `port.ownerComponent`.
- flow is a blocking handshake: an upstream offers a MU (`canAccept(mu)`); if accepted it
  `transfer`s; if refused the MU is held (`blockedMUs`) and released later via
  `onDownstreamReady`. Durations are scheduled (`self.in(transitTime, 'Arrival', mu)`).
- in DES the published `Conveyor.Occupied` signal becomes an observability / overlay value
  (keeping HMI and live overlays consistent) while the handshake drives the actual flow.
- the simulation kernel switches Continuous ↔ DES with a clean restart (reset-on-switch); animated
  parity comes from a central sim-time tween registry, so the same layout looks identical and
  can be fast-forwarded for throughput analysis.

## Shared building blocks

| Module | Provides |
|---|---|
| `_shared/transport-links.ts` | the interlock: `createDownstreamInterlock`, `outputLink(s)`, `linkOf`, `portIds`, `conveyorShouldRun`, `declareConveyorSignals` |
| `_shared/lazy-drive.ts` | `attachBelt` / `attachDrive` — drive handles that resolve on demand |
| `_shared/surface-occupancy.ts` | `isSurfaceOccupied(viewer, node)` |
| `_shared/snap-graph-helpers.ts` | port topology: `findOutputPairings`, `classifyConnections`, `listOwnSnaps` |
| `_shared/turntable-angle-math.ts` | rotary alignment / dispatch angles |
| `_shared/behavior-badge.ts` | the shared hierarchy/inspector badge |

## Authoring a new component

1. add `src/behaviors/MyComponent.ts` → `defineMaterialFlow({ type, kind, models, schema, logic, continuous, des })`.
2. put routing and state-machine decisions in `logic` (so both paradigms share them).
3. `continuous.setup` resolves nodes, declares signals, wires sensors and the context menu;
   `continuous.fixedUpdate` publishes surface occupancy and applies physical effects.
4. add `des` hooks for the event-driven path.
5. coordinate with neighbours by publishing/reading `Conveyor.Occupied[@id]`.
6. add tests under `tests/`.

## See also

- `doc-webviewer.md` — architecture and component overview
- `doc-extending-webviewer.md` — plugin system and custom components
- `doc-lifecycle.md` — model load, fixed-step loop, dispose
