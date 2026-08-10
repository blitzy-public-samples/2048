# Data Flow

Two figures live here. `Figure 4` follows one turn from a keystroke to a
composited frame and a persisted run. `Figure 7` follows the run seed, because
every random value in the game comes from it and reproducibility is a contract
rather than a nicety.

Rationale is not argued here. It lives in
[`docs/DECISION_LOG.md`](../DECISION_LOG.md), cited below by identifier.

## Contents

- [1. One turn, end to end](#1-one-turn-end-to-end)
- [2. Two behaviours preserved from the pre-migration game](#2-two-behaviours-preserved-from-the-pre-migration-game)
- [3. The seed and its substreams](#3-the-seed-and-its-substreams)
- [4. Where to look next](#4-where-to-look-next)

## 1. One turn, end to end

A turn is not "apply the move". It is a sequence with three places a relic can
intervene, two places the turn can end early, and exactly one place a tile is
spawned.

**Figure 4 — Turn Data Flow: From Keystroke to Composited Frame and Persisted Run
State.**

```mermaid
flowchart TD
    K["Key, swipe or on-screen control"] --> D["Direction 0-3"]
    D --> BM["onBeforeMove dispatch<br/>cancellable"]
    BM -->|"vetoed"| END1["Turn ends, no state change"]
    BM -->|"allowed"| PREP["prepareTiles<br/>clear mergedFrom, snapshot position"]
    PREP --> TRAV["Traversal walk<br/>over the configured board size"]
    TRAV --> MG{"Merge condition<br/>from config.merge.canMerge"}
    MG -->|"yes"| MH["onMerge dispatch<br/>score delta applied"]
    MG -->|"no"| MV["Reposition tile"]
    MH --> CHK["Win check against<br/>config.winValue"]
    MV --> CHK
    CHK --> MOVED{"Any position changed?"}
    MOVED -->|"no"| END2["Turn ends, no spawn"]
    MOVED -->|"yes"| SP["onSpawn dispatch<br/>value and position from<br/>named RNG substreams"]
    SP --> AF["onAfterMove dispatch"]
    AF --> LOSS{"Moves still available?"}
    LOSS -->|"no"| OVER["Game over"]
    LOSS -->|"yes"| COMMIT["state:commit"]
    OVER --> COMMIT
    COMMIT --> R["Renderer tweens<br/>and composites a frame"]
    COMMIT --> PERSIST["Run state written<br/>under a namespaced key"]
    COMMIT --> BEST["Best score promoted,<br/>then re-read from storage"]
    COMMIT --> SG{"Stage goal met?"}
    SG -->|"yes"| SE["onStageEnd dispatch<br/>to the reward screen"]
    SG -->|"no"| WAIT["Await next input"]
```

**Legend for Figure 4.** *Turn Data Flow: From Keystroke to Composited Frame and
Persisted Run State.* A **rectangle** is a processing step and a **diamond** is a
decision. The four hook names mark the dispatch points a relic can act on; the
remaining two hooks, `onStageStart` and `onStageEnd`, sit at the stage boundary
rather than inside a turn. Three edges are worth naming: `onBeforeMove` is the
only **cancellable** dispatch, so a relic can withdraw a move; the `Any position
changed?` diamond is the sole signal that a move occurred, ported unchanged from
the pre-migration change detector; and `state:commit` fans out to four
independent consumers, none of which the engine knows by name.

## 2. Two behaviours preserved from the pre-migration game

`Figure 4` deliberately keeps two properties that a redesign would have lost:

- **A spawn happens only when a position actually changed.** The `MOVED` diamond
  gates the spawn, exactly as the pre-migration `moved` flag did, so a move into
  a wall costs nothing and adds no tile.
- **The displayed best score is re-read from storage after the write.** The
  promotion writes, then reads back, so the value on screen always equals the
  value persisted rather than a cached copy of what was intended.

The merge dispatch also fires **once per merge**, so a move that resolves two
merges dispatches `onMerge` twice and a relic bound to it fires twice.

## 3. The seed and its substreams

A run has one seed. If every consumer drew from a single stream, adding one relic
that draws once would shift every later draw, and a snapshot recorded before that
relic existed would stop reproducing. Substreams make each concern's sequence
independent, so relic composition cannot perturb spawn reproducibility.

**Figure 7 — Seeded Determinism: One Run Seed Fanned into Named RNG Substreams.**

```mermaid
graph LR
    SEED["Run seed<br/>string, displayed and copyable"]
    SEED --> DERIVE["Substream derivation"]
    DERIVE --> S1["spawn-value stream"]
    DERIVE --> S2["spawn-position stream"]
    DERIVE --> S3["relic-draw stream"]
    DERIVE --> S4["rarity-weight stream"]
    S1 -->|"replaces game_manager.js L71"| SPAWNV["Spawn value from<br/>config.spawn weights"]
    S2 -->|"replaces grid.js L41"| SPAWNP["Spawn position from<br/>the available cells"]
    S3 --> DRAW["Sample three<br/>without replacement"]
    S4 --> DRAW
    DRAW --> OFFER["Reward offer set<br/>no duplicates possible"]
    S1 --> C1["cursor persisted"]
    S2 --> C2["cursor persisted"]
    S3 --> C3["cursor persisted"]
    S4 --> C4["cursor persisted"]
    C1 --> RS["Run state<br/>rngCursor map"]
    C2 --> RS
    C3 --> RS
    C4 --> RS
    GUARD["Test invariant:<br/>Math.random is never patched"] -.-> DERIVE
```

**Legend for Figure 7.** *Seeded Determinism: One Run Seed Fanned into Named RNG
Substreams.* A **solid arrow** is a derivation or a consumption. A **labelled
arrow** into `SPAWNV` or `SPAWNP` names the exact pre-migration call site that
substream replaced — those two were the **only** `Math.random()` sites in the
retired tree, which is what made the substitution exhaustive rather than a
search. The **dotted arrow** is an enforced test invariant, not a runtime
dependency: the generator is always a local instance and is never installed onto
`Math.random`, and a unit test asserts it. Persisting each **cursor** is what
keeps a *resumed* run deterministic; without it a reload would silently restart
each sequence.

## 4. Where to look next

- [`hook-dispatch-sequence.md`](hook-dispatch-sequence.md) — `Figure 5`, what
  happens inside each dispatch box of `Figure 4`.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — `Figure 1` and `Figure 2`, the modules
  these values flow through.
- [`component-interaction.md`](component-interaction.md) — `Figure 6b`, the
  screen states a committed turn can move the flow into.
- [`../CONFIGURATION.md`](../CONFIGURATION.md) — the `spawn`, `merge` and
  `winValue` fields `Figure 4` reads.
