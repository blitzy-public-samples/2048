# Observability

Rule 3's standard is that a capability which cannot be exercised locally is not
delivered. This document is therefore written as a set of things you can do on
your own machine, in a browser, with no server: each capability is named, its
surface is stated, and the steps to see it working are given.

It also answers the question Rule 3 asks first — **what was reused and what was
added**. The answer is unusual for this repository, because the pre-migration
game had no observability of any kind and yet performed five capability probes
whose results it reported nowhere. Those five are reused. One is added.

Rationale is not argued here. It lives in
[`docs/DECISION_LOG.md`](DECISION_LOG.md), cited below by identifier.

## Contents

- [1. Reused versus added](#1-reused-versus-added)
- [2. The constraint this design works under](#2-the-constraint-this-design-works-under)
- [3. Structured logging](#3-structured-logging)
- [4. Tracing](#4-tracing)
- [5. Metrics](#5-metrics)
- [6. Health and readiness](#6-health-and-readiness)
- [7. The dashboard template](#7-the-dashboard-template)
- [8. Exercising all of it locally](#8-exercising-all-of-it-locally)
- [9. Known limits](#9-known-limits)

## 1. Reused versus added

### 1.1 What was reused

Five capability probes already existed in the pre-migration tree. Each decided
something at run time and then **discarded the answer**: nothing logged it,
nothing counted it and nothing displayed it. `src/observability/health.ts`
reuses all five by aggregating them into one report, and each carries its origin
in `HEALTH_CHECK_SOURCES` so the reuse is machine-readable rather than a claim in
prose.

| Check | Pre-migration origin | Who performs it now | Disposition |
|---|---|---|---|
| `functionBind` | `js/bind_polyfill.js` L1 | `src/observability/health.ts` | reused |
| `classList` | `js/classlist_polyfill.js` L2-L5 | `src/observability/health.ts` | reused |
| `requestAnimationFrame` | `js/animframe_polyfill.js` L3-L10 and L23 | `src/observability/health.ts` | reused |
| `pointerEvents` | `js/keyboard_input_manager.js` L4-L13 | `detectPointerEventFamily` of `src/input/touch-input.ts` | reused |
| `storage` | `js/local_storage_manager.js` L29-L40 | `probeWebStorage` of `src/storage/local-storage-manager.ts` | reused |

The three polyfills are deleted, so what is reused is the **probe** — the
capability question each asked — rather than the shim that followed it.

### 1.2 What was added

| Capability | Module | Why it did not exist before |
|---|---|---|
| `webgl` health check | `probeWebGLSupport` of `src/render/webgl-support.ts` | The renderer is new, and WebGL is the one hard runtime prerequisite the product never had |
| Structured logging with a run correlation identifier | `src/observability/logger.ts` | There was no logger, and no `console.*` call anywhere in the retired tree |
| Spans across module boundaries | `src/observability/tracer.ts` | The Performance API was never invoked; the frame callback was the one asynchronous boundary and was unmeasured |
| Counters, histograms and a Prometheus-text snapshot | `src/observability/metrics.ts` | There were no metrics of any kind |
| An in-page diagnostics surface | `src/observability/diagnostics-overlay.ts` | There was nothing to display, and no dashboard |

There was also exactly one `catch` in the retired tree, and it discarded its
error object. Every catch on the new paths reports through the logger instead.

## 2. The constraint this design works under

The product must remain a **fully static bundle**: no server, no API route, no
serverless function, no runtime Node process. Three of the capabilities Rule 3
enumerates assume a server, so each is delivered as its browser-native
equivalent. The substitutions are deliberate, and each is recorded as a deviation
in [`docs/DECISION_LOG.md`](DECISION_LOG.md) §11 rather than left implicit.

| Rule 3 capability | Why it cannot exist here | What is delivered instead | Deviation row |
|---|---|---|---|
| A network-served metrics endpoint | There is no server process and none may be added | An in-page diagnostics surface plus an exportable Prometheus-text snapshot and a file download | `DL-METRIC-05` |
| HTTP health and readiness probes an orchestrator can poll | There is no listening port, so there is nothing to poll | Programmatic client-side self-checks reporting all six checks and a readiness verdict | `DL-HEALTH-05` |
| Distributed tracing across service boundaries | The runtime integrates with no external system, so there is no service boundary | Performance-API spans across **module** boundaries, including the frame-callback seam | `DL-TRACE-01` |
| A dashboard a reader can open | Nothing serves a dashboard and nothing scrapes the metrics | Two checked-in templates fed by an exported snapshot, described in [§7](#7-the-dashboard-template) | `DL-DIAG-06` |

Nothing is skipped. The capability is present in every case; only the transport
differs.

## 3. Structured logging

`src/observability/logger.ts` emits one JSON object per record. A record carries
its level, message, timestamp, elapsed milliseconds, the **run correlation
identifier**, the subsystem that wrote it, and a normalised field bag.

Every segment of the correlation identifier is derived from the run identifier
and the seed **together**, so no part of the exported value is a function of the
seed alone, and the run identifier itself is carried in no record, no metric
label and no export (`DL-LOG-09`). A field bag is normalised for shape and size
on the way in — cycles replaced, depth and breadth capped, strings bounded — and
error messages as well as stack locations are redacted on the console and on
every export path (`DL-LOG-06`, `DL-LOG-08`, `DL-LOG-10`).

**To see it:** open the game with the development server, play one move, and read
the browser console. Every line is a JSON object. `logger.toJsonLines()` returns
the buffered records as newline-delimited JSON for copying out.

## 4. Tracing

`src/observability/tracer.ts` opens spans on the Performance API. Nine names are
declared, and they cover the whole path from an input to a composited frame:

| Span | Boundary it measures |
|---|---|
| `input.dispatch` | One key, gesture or on-screen control |
| `engine.turn` | One turn, `move:before` through `state:commit` |
| `engine.move.resolve` | The traversal walk and merge resolution within a turn |
| `engine.stage` | One stage, `stage:start` through `stage:end` |
| `hook.dispatch` | One hook dispatch |
| `relic.handler` | One relic handler invocation, attributed to its relic |
| `render.commit` | One renderer commit |
| `render.frame` | One frame callback — the seam that was never measured |
| `tracer.inert` | The shared span returned while tracing is disabled |

A turn span is settled on the engine's full legal result set, so an effect-only
turn — one an `onBeforeMove` relic committed without moving a tile — is
attributed rather than reported as an anomaly, and its latency is not recorded
into the turn histogram.

**To see it:** open the diagnostics overlay (see [8](#8-exercising-all-of-it-locally))
and read the span table, or open the browser's Performance panel and look at the
User Timing track, where the same spans appear by the names above.

## 5. Metrics

`src/observability/metrics.ts` is an in-page registry. Every family is prefixed
`game2048_`, and the snapshot exports in **Prometheus text format**, so the same
bytes can be pasted into any tool that reads that format.

| Family | Kind | What it counts or times |
|---|---|---|
| `game2048_turns_total` | counter | Turns, by resolution |
| `game2048_merges_total` | counter | Merges — one per merge, so a double-merge turn counts twice |
| `game2048_spawns_total` | counter | Tiles actually inserted |
| `game2048_spawn_attempts_total` | counter | Spawn attempts, whether or not one landed |
| `game2048_spawn_suppressed_total` | counter | Attempts a relic or a full board suppressed |
| `game2048_engine_events_total` | counter | Engine events, by name |
| `game2048_hook_dispatches_total` | counter | Hook dispatches, by hook |
| `game2048_hook_handler_invocations_total` | counter | Handlers actually invoked |
| `game2048_hook_handler_skipped_total` | counter | Handlers skipped, including by the charge guard |
| `game2048_hook_payload_rejections_total` | counter | Returns the bus refused |
| `game2048_relic_handler_errors_total` | counter | Handlers that threw, by relic |
| `game2048_rng_draws_total` | counter | Draws, by substream |
| `game2048_frames_rendered_total` | counter | Frames composited |
| `game2048_reports_total` | counter | Reports across every subsystem, by report and subsystem |
| `game2048_metrics_rejected_total` | counter | The registry's own refusals, by reason |
| `game2048_health_check_status` | gauge | One series per health check |
| `game2048_turn_latency_milliseconds` | histogram | Turn latency |
| `game2048_frame_time_milliseconds` | histogram | Frame time |
| `game2048_span_duration_milliseconds` | histogram | Every span, by name |

The registry bounds itself: a family ceiling, a series-per-family ceiling, label
name and value length ceilings, and a metadata budget charged once per **retained**
series (`DL-METRIC-07`). A refusal is counted in
`game2048_metrics_rejected_total` and reported, never thrown.

**To see it:** use the diagnostics overlay's **Export metrics** control, which
downloads `game2048-metrics.prom`, or call `diagnostics.toPrometheusText()` from
the console for the same bytes. The overlay's second control, **Export
snapshot**, downloads the combined JSON envelope as `game2048-diagnostics.json`
instead.

**Export through the overlay, not through the registry.** Two families are
**pulled** rather than pushed: the hook bus keeps its own per-hook dispatch
counts and the substreams keep their own draw cursors, and the registry holds
either only once something reads it. The overlay's exports fold both sources
first, so they answer from one reading; `metrics.toPrometheusText()` is the
registry's own method and cannot fold what it does not own, so a direct call
answers with the hook families at whatever a previous fold left them — zero, on
a page nothing has folded. The cursor family is the exception: it is folded on
every committed state as well, so it is current either way.

## 6. Health and readiness

`src/observability/health.ts` reports all six checks named in
[1](#1-reused-versus-added). Each result is `pass`, `fail` or `not-applicable`,
and each carries the structured detail its probe read — the resolved pointer
event names, the live storage strategy, the WebGL level.

Readiness is a separate verdict derived from those results, and it is resolved
**before** the renderer and the storage strategy are selected, so the selection
is driven by the verdict rather than discovering the same facts again afterwards.
It reports a renderer of `webgl` or `number-only` and a storage strategy of
`persistent` or `ephemeral`. After the board is mounted the report is refreshed,
so what is displayed describes the application that is actually running.

**To see it:** the console carries `Health checked.` with a pass and fail count,
and `Readiness resolved.` with the renderer, WebGL level, storage strategy and
health status. The diagnostics overlay lists every check with its status and
detail. On a machine with no GPU the `webgl` check is the one that changes, and
the number-only renderer takes over — which is the fallback path working, not a
failure.

## 7. The dashboard template

Two files, in [`docs/dashboards/`](dashboards/):

- `dashboard.json` — a Grafana-compatible dashboard model over the families in
  [5](#5-metrics). It is a template: it declares panels, expressions and units,
  and it expects a Prometheus-compatible data source that the exported snapshot
  has been loaded into.
- `dashboard.html` — a single self-contained page that consumes an exported
  snapshot **directly**. It parses Prometheus text, renders the same panels as
  inline SVG, and needs no server, no data source and no network access. This is
  the form that satisfies "exercisable locally" without a Prometheus install.

**To see it:** export `game2048-metrics.prom` from the diagnostics overlay, open
`docs/dashboards/dashboard.html` in a browser, and load that file with the file
input. The panels populate from the file. The page also loads a small built-in
sample, so it renders something before any file is chosen.

## 8. Exercising all of it locally

```
npm install
npm run dev
```

Then, in the browser:

1. Open the game and append `?diagnostics` to the URL — the flag is read from the
   query string or the hash — to mount the overlay at `#diagnostics-overlay`.
2. Play a few moves. The overlay's counters, histograms and span table update per
   turn, and the console fills with structured records.
3. Read the health panel. All six checks are listed; `webgl` reports the level
   the machine actually offers.
4. Use the overlay's **Export metrics** control to download
   `game2048-metrics.prom`.
5. Open `docs/dashboards/dashboard.html` and load that file with its file input.

Each of the five capabilities Rule 3 enumerates is observed in that sequence:
logging in step 2, tracing in step 2, metrics in step 4, health and readiness in
step 3, and the dashboard in step 5.

The unit suite covers the same surfaces without a browser:

```
npm run typecheck
npm test
```

## 9. Known limits

Stated here because a reader who assumes otherwise will be wrong:

- **The field bag is normalised for shape, not classified for sensitivity.** No
  allowlist is applied, so a caller that logs a sensitive value puts it in the
  buffer and in every export taken from it. The obligation is on callers
  (`DL-LOG-06`).
- **Message and stack redaction covers enumerated forms, not all forms.** A
  location or an identifier written in a form outside those enumerated survives
  (`DL-LOG-08`, `DL-LOG-10`).
- **The record buffer is bounded.** A fault diagnosed long after it happened has
  no history, which is the accepted consequence of having nowhere to ship logs
  to (`DL-LOG-03`).
- **The metadata budget is now a backstop rather than an active guard**, because
  the family and series ceilings bind first. A genuine unbounded-cardinality bug
  surfaces as `seriesLimitReached` or `familyLimitReached`, not as
  `metadataBudgetReached` (`DL-METRIC-07`).
- **`dashboard.json` is a template, not a provisioned dashboard.** It names no
  data source of its own and is not wired to a running Prometheus.
