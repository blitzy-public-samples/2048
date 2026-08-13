# Component Interaction

[`ARCHITECTURE.md`](ARCHITECTURE.md) states which modules exist and which way
their dependencies point. This document states what passes **between** them
while a game is running: who the player reaches, what crosses each boundary,
and how one board state reaches the player twice — once as pixels and once as
semantics.

One figure lives here. Figure 3 is the component graph of a running game, and
it is the only diagram this document carries; every other figure is listed with
its owning document in [section 6](#6-where-to-look-next).

Nothing is argued here. Rationale lives in
[`docs/DECISION_LOG.md`](../DECISION_LOG.md) and nowhere else, cited below by
identifier wherever a reader would otherwise ask why.

## Contents

- [1. The components of a running game](#1-the-components-of-a-running-game)
- [2. What crosses each boundary](#2-what-crosses-each-boundary)
- [3. The two paths back to the player](#3-the-two-paths-back-to-the-player)
- [4. Peers on one bus](#4-peers-on-one-bus)
- [5. Two edges a reader can misread](#5-two-edges-a-reader-can-misread)
- [6. Where to look next](#6-where-to-look-next)

## 1. The components of a running game

**Figure 3 — Component Interaction: Input, Engine, Hook Bus, Relics, Renderer,
Persistence.**

```mermaid
graph LR
  P((Player))
  P --> IN2["Input adapter<br/>keys, touch, on-screen controls"]
  IN2 -->|"move, restart, keepPlaying"| ENG2["Engine"]
  IN2 -->|"startRun, endRun, continueStage,<br/>selectReward, activateRelic,<br/>openSettings, closeSettings, cancel"| ROOT["Composition root<br/>main.ts, the only wiring site"]
  ROOT -->|"begin, resolve and end a run"| RUNC["Run controller"]
  ROOT -->|"router triggers"| RT["Screen router"]
  ENG2 ==>|"six hook dispatches"| BUS2["Hook bus"]
  BUS2 -->|"accumulated payload plus<br/>read-only capability views"| REL2["Relic registry<br/>pickup-ordered"]
  REL2 -->|"compounded payload and<br/>recorded board commands"| BUS2
  ENG2 -.->|"seven events, relayed<br/>onto the bus channel"| BUS2
  BUS2 --> REND2["Board renderer<br/>Three.js or number-only"]
  BUS2 --> RT
  BUS2 -->|"subscribed by the root"| HUD2["HUD, announcer<br/>and sound engine"]
  BUS2 --> OBS2["Observability"]
  ENG2 -.->|"observed at the emitter"| RUNC
  ENG2 -.->|"observed at the emitter"| OBS2
  REND2 -->|"frames"| CANVAS["Canvas<br/>aria-hidden"]
  REND2 -->|"cells, labels and the tab stop"| A11Y["Parallel board DOM<br/>plus live region"]
  RT -->|"screen lifecycle"| DOMUI["Screen modules"]
  HUD2 --> DOMUI
  HUD2 --> A11Y
  ENG2 -->|"best score and board snapshot"| STOR["Storage adapter"]
  RUNC --> STOR
  STOR --> LS[("localStorage")]
  CANVAS -->|"pixels"| P
  DOMUI --> P
  A11Y -->|"announcements"| P
```

**Legend.** The **circle** is the human actor. A **rectangle** is a module or a
module group. The **cylinder** is persistence. Three edge kinds are drawn. A
**thick arrow** is the engine's direct hook dispatch, which is a call on
`hook-bus.ts` and not a subscription. A **dotted arrow** is an event edge: the
relay that republishes the emitter's seven events onto the bus channel, and the
consumers that subscribe to the emitter itself. Every **solid arrow** is a
one-way call, construction or write, and its label — where it carries one —
names what travels along it. The **pair of arrows** between the hook bus and the
relic registry is the compounding protocol: the bus hands each handler the
accumulated payload and takes back a possibly transformed one.

**The before state.** Figure 3 is a to-be view. Its before state is
**Figure 1 — As-Is Architecture: Layered Globals with a Push-Based Actuator**,
in [`ARCHITECTURE.md`](ARCHITECTURE.md#1-the-architecture-as-it-was), where the
rules controller held a reference to the DOM writer and pushed a state
projection into it on every commit, and where the relic registry, the screen
router, the run controller and the observability layer of Figure 3 had no
counterpart at all. **Rule 2**'s both-states obligation is discharged for this
architecture by that Figure 1 and Figure 2 pair, so this document draws the
to-be view alone rather than restating the as-is one. **Figure 2 — To-Be
Architecture: Event-Driven Engine with Subscribed Renderer and Hook Bus** is the
module-level view of the same inversion (`DL-ENGINE-01`).

## 2. What crosses each boundary

| Boundary | What crosses it |
|---|---|
| Player → input adapter | A key, a swipe, or a press on an on-screen control |
| Input adapter → engine | The three frozen pre-migration names, and only those three: `move`, whose payload is a bare direction `0`–`3`, `restart` and `keepPlaying` |
| Input adapter → composition root | The eight names added beside them, none of which reaches the engine: `startRun` carries the seed text to `RunController.startRun()`; `continueStage` and `endRun` are sent to the router as the `stageEnd` and `endRun` triggers; `selectReward` applies one offered relic; `activateRelic` **reads** the held tray and announces a slot, spending no charge (`DL-MAIN-17`); `openSettings`, `closeSettings` and `cancel` drive the settings dialog |
| Engine → hook bus | One of six hook dispatches, by direct call to `dispatch()`: `onStageStart`, `onBeforeMove`, `onMerge`, `onSpawn`, `onAfterMove`, `onStageEnd`. `onMerge` is reached through the callback `move-resolver.ts` is handed, so the resolver names no bus (`DL-MOVE-02`) |
| Engine emitter → hook bus | The seven events, republished onto the bus's shared channel by `attachEvents`, by reference and unwrapped, so relics and every non-relic peer share one channel (`DL-HOOKBUS-06`) |
| Hook bus → relic handler | The accumulated payload for that hook, plus a `HookContext` of **read-only capability views** — the rules, the named substreams and the board as a query surface — and a transactional effect queue. A handler cannot write the lattice: it records commands the bus applies once the handler has returned and its return has validated (`DL-BOARD-02`). The board on an event **payload** travels by reference (`DL-EVENT-01`) |
| Relic handler → hook bus | A possibly transformed payload, and the board commands it recorded. A handler that returns nothing leaves the payload as it stands (`DL-HOOKBUS-03`) |
| Hook bus → renderer | `state:commit` for a full board reconciliation, and `stage:start`, `tile:merge`, `tile:spawn`, `move:after` and `stage:end` as animation and re-frame triggers |
| Hook bus → screen router | The events that move the seven-screen state machine |
| Hook bus → HUD, announcer and sound engine | The same events, taken by the three peers the root subscribes on the channel rather than through the router. The HUD is the sole writer of the score, best-score and terminal-overlay outlets (`DL-HUD-01`) |
| Hook bus → observability | The same events, taken by the engine-event metrics |
| Engine emitter → run controller | `stage:start`, `move:after`, `stage:end` and `state:commit`, taken by subscription rather than by call, and deliberately on the emitter rather than the relay so persistence follows the views (`DL-RUNCTL-17`) |
| Engine emitter → observability | `move:before` and `state:commit` for the turn span, `stage:start` and `stage:end` for the stage span, and the commit the RNG cursor fold reads — the four consumers that stay on the emitter for an ordering reason (`DL-MAIN-12`, `DL-MAIN-30`) |
| Engine → storage adapter | The best score, promoted through the injected persistence port when the live score exceeds it, and the board snapshot written or cleared on every commit. The engine names a persistence port; it names no view (`DL-STORE-02`) |
| Run controller → storage adapter | The versioned run-state envelope, carrying the cursor each named substream reached so a resumed run continues the sequence it interrupted (`DL-RNG-04`) |
| Storage adapter → `localStorage` | `roguelike2048:runState`, namespaced under `roguelike2048`, written beside the frozen and deliberately unprefixed `bestScore` and `gameState` (`DL-KEYS-01`) |
| Renderer → canvas | Frames |
| Renderer → parallel board DOM | The labelled, focusable per-cell counterparts and the roving tab stop. **Both** renderers are handed the same parallel-board layer and each writes it, so the semantics survive a renderer swap (`DL-A11Y-08`, `DL-NUMBER-01`) |
| Screen router → screen modules | Which of the seven screens is in force, driving that module's mount, enter, leave and announcement lifecycle |
| Live region → assistive technology | The announcements a move, a merge, a spawn, a stage clear, a relic acquisition and a terminal verdict speak |

The seven screens the router moves between are `runStart`, `stage`,
`stageClear`, `reward`, `won`, `gameOver` and `runSummary`, and the edges
between them are a frozen transition table rather than an imperative
show-and-hide (`DL-ROUTER-12`). At the storage boundary the best-score accessor
keeps the raw stored **string** when a value is present and returns the number
`0` when it is absent (`DL-STORE-02`); the write-then-read ordering that puts
that value on screen is described with the turn that produces it, in
[`data-flow.md`](data-flow.md).

## 3. The two paths back to the player

Three arrows terminate at the player in Figure 3, and they carry two kinds of
information. The canvas carries **pixels**. The screens, the HUD and the
parallel accessibility layer carry **semantics** — text, roles, accessible
names and spoken announcements.

Both modalities carry the same board state. A canvas is a single opaque node to
assistive technology: WebGL emits pixels and no structure, so a screen reader
perceives an entire board as one element and can report nothing about what is on
it. The canvas carries `aria-hidden="true"` and the board is published a
second time beside it, as a real `role="grid"` element with labelled, focusable
per-cell counterparts, with state changes announced through a live region
(`DL-A11Y-08`). Number-only mode is a renderer in its own right rather than a
degraded view of the WebGL one: it exposes the same `subscribe`, `mount`,
`unmount` and `dispose` surface, so the composition root mounts either renderer
interchangeably once the WebGL probe has answered (`DL-NUMBER-01`).

## 4. Peers on one bus

The engine holds **no** reference to the renderer, the screen router or the
observability layer. Each subscribes (`DL-ENGINE-01`). The bus carries the
shared engine-event channel alongside the six relic hooks — `events` is the
channel every non-relic peer subscribes to (`DL-HOOKBUS-06`) — which is why
relics, the renderer, the router and observability sit at one fan-out in
Figure 3 rather than in a hierarchy.

A peer **subscribes without any engine file being edited to admit it**, and the
reason is structural rather than conventional: the emitter's `on()` *appends* to
a per-name listener array and `emit()` walks that array, the append-only shape
carried forward from `js/keyboard_input_manager.js` L18-L23 (`DL-INPUT-03`).
`attachEngineTracing` in `src/observability/tracer.ts` subscribes in exactly
that way, so the observability layer is a first-class peer of the renderer here
and not an annex bolted to the engine (`DL-MAIN-05`).

Subscription is not the whole of the instrumentation, and the difference is
recorded rather than glossed. What the engine, the input layer, the storage
layer, the bus and the renderer carry is a **reporter or tracing contract each
of them declares itself** and calls at its own boundaries — an event carries no
refused direction, no resolution span and no contained throw — and the root
injects the adapter that satisfies each one. The property that holds absolutely
is the direction of the dependency: nothing under `src/engine`, `src/input`,
`src/relics` or `src/render` imports anything from `src/observability`
(`DL-MAIN-05`, `DL-MAIN-07`).

The compounding protocol is an explicit, tested contract, not a property that
emerges from the order handlers happened to register in:

- The relic registry is the authority for pickup order, and a dispatch walks the
  backing array in that order without copying or sorting it (`DL-HOOKBUS-02`).
- Each handler receives the payload the handler before it returned, which is
  what makes two relics on one hook compound rather than overwrite
  (`DL-HOOKBUS-03`).
- The charge guard lives in the bus, not in the handlers: a subscriber whose
  charges are present and not above zero is skipped before its handler is
  reached (`DL-HOOKBUS-01`).
- A handler that throws is caught and reported, its subscriber is marked
  degraded, and the dispatch continues so the turn still completes
  (`DL-HOOKBUS-04`).

The bus surface is `register()`, `unregister()` and `dispatch()`, with
`subscribers()` reporting a **frozen snapshot** taken at the call: each record is
copied, its handler table included, so a caller holds a reading of the registry
at that moment and can neither observe a later registration through it nor reach
the live records to change one. **Figure 5 — Hook Dispatch
Sequence: Pickup-Order Fan-Out with Charge Guard and Error Isolation** in
[`hook-dispatch-sequence.md`](hook-dispatch-sequence.md) draws one dispatch
through those four rules step by step and is not redrawn here.

One registration per relic carries its whole handler table, one charge budget
and one state slot, so every hook a single relic binds shares one mutable pool
and one `state` value (`DL-REGISTRY-02`). The registry is also the only
construct in the system that names a relic — no engine, renderer or UI module
branches on a relic identifier (`DL-REGISTRY-01`) — and the catalogue itself,
with each relic's family, rarity, hooks and charges, is in
[`../RELICS.md`](../RELICS.md).

## 5. Two edges a reader can misread

**The engine-to-run-controller edge carries events, not a call.**
`src/run/run-controller.ts` subscribes to `move:after`, `stage:end` and
`state:commit` and is never called by the engine; it drives the engine back
through a structural port that it declares itself, and `src/engine` imports
nothing from `src/run` (`DL-RUNCTL-17`). The arrow's direction in Figure 3 is
the direction the events travel, and it is not a compile-time dependency.

**Three similar names are three different things.** The engine's
continue-after-win method is `continueAfterWin()` and its flag is
`continuedPlay`; the input event a player's press emits is `keepPlaying`; and
the persisted property is also `keepPlaying`. The method and the flag were
renamed, and both frozen names stayed as they were (`DL-ENGINE-04`).

## 6. Where to look next

Each document below owns its figures and is the authority on its own subject.
Nothing here restates them.

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — `Figure 1`, the before state of this
  figure, and `Figure 2`, the module graph these components belong to, with the
  seven-event contract between them.
- [`data-flow.md`](data-flow.md) — `Figure 4`, one turn from keystroke to
  composited frame and persisted run state, and `Figure 7`, the run seed fanned
  into its named substreams.
- [`hook-dispatch-sequence.md`](hook-dispatch-sequence.md) — `Figure 5`, the
  hook-bus boundary of this figure in detail, and `Figure 6`, the screen-flow
  state machine behind the seven screen names above.
- [`../TRACEABILITY_MATRIX.md`](../TRACEABILITY_MATRIX.md) — `Figure 8`, the
  file transformation map, and the construct-by-construct mapping from each
  retired `js/` source to the module carrying it now. Figure 8 is not in this
  folder and is not reproduced here.
- [`../RELICS.md`](../RELICS.md) — the relic catalogue the registry holds.
- [`../CONFIGURATION.md`](../CONFIGURATION.md) — the rules and stage
  configuration every component above reads.
- [`../OBSERVABILITY.md`](../OBSERVABILITY.md) — the observability signal
  path, the reuse inventory and the six health checks behind the
  `Observability` box.
- [`../DECISION_LOG.md`](../DECISION_LOG.md) — every `DL-` identifier cited
  above, and all rationale.
