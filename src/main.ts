// The composition root: the single module index.html loads.
//
// Supersedes js/application.js, which is deleted. That file was four
// lines — `new GameManager(4, KeyboardInputManager, HTMLActuator,
// LocalStorageManager);` inside a `DOMContentLoaded` listener — and it
// injected constructors rather than instances, which is the seam the
// engine/renderer split is built on. The wiring below keeps that
// injection and reverses one direction of it: the engine no longer holds
// a view; the renderer subscribes to the engine's events.
//
// WHAT THIS FILE OWNS
//   the stylesheet import, which is how style/main.scss reaches the page
//   now that index.html carries no <link>;
//   the run seed and the four seeded substreams every draw is taken from;
//   the rules configuration the engine and the renderer read;
//   the WebGL capability probe, and the renderer selection it decides;
//   the frame loop the renderer's work is scheduled on;
//   the report sink every layer's counters and diagnostics reach;
//   the ONE tracer, and the wrappers that carry it to every measured boundary;
//   the ONE health surface, and the readiness the renderer decision reads.
//
// THE BOARD-SIZE LITERAL
//   js/application.js L3 carried the only board-size value in the vanilla
//   JavaScript. It is gone: the size comes from
//   src/config/default-config.ts, and src/render/number-only-renderer.ts
//   builds the board from the size the engine commits.
//
// THE TWO RANDOMNESS CALL SITES
//   `Math.random()` appears nowhere in src/. The spawn value and the
//   spawn cell are drawn from the `spawn-value` and `spawn-position`
//   substreams of the seed created here, and the seed itself comes from
//   Web Crypto or, where that is unavailable, from the two clocks — never
//   from `Math.random`.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated:
//   TR-MAIN-01  js/application.js L1, L4  the `DOMContentLoaded` wrapper
//   TR-MAIN-02  js/application.js L3      the construction that injected four
//                                         constructors and carried the only
//                                         board-size literal
//   TR-MAIN-03  index.html L7             the <link> to the committed generated
//                                         CSS, replaced by the stylesheet
//                                         import below
//   TR-MAIN-04  target-only row           the run seed and the four seeded
//                                         substreams
//   TR-MAIN-05  target-only row           the WebGL capability probe and the
//                                         renderer selection it decides
//   TR-MAIN-06  target-only row           the frame loop the renderer's work is
//                                         scheduled on
//   TR-MAIN-07  target-only row           the one tracer, its boundary wrappers
//                                         and the hook bus built with them
//   TR-MAIN-08  target-only row           the one health surface and its
//                                         readiness verdict
//   TR-MAIN-09  target-only row           the diagnostics overlay and the
//                                         `Application` surface
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-MAIN-01  the stylesheet entering through the module graph
//   DL-MAIN-02  the run seed drawn from Web Crypto with the two clocks as the
//               fallback, and never from `Math.random`
//   DL-MAIN-03  one tracer, one health surface and one report sink constructed
//               here and injected everywhere
//   DL-MAIN-04  `setup()` called after every subscriber has attached
//   DL-MAIN-06  one mutable run-correlation context: the logger is the sole
//               authority, every reporter is handed a reader of it rather
//               than a captured value, and the scope is rotated as a run is
//               adopted, before the board opens

// The stylesheet enters through the module graph. index.html's <link> to
// the committed generated CSS was removed; this import is its replacement
// and it is the only one in the module graph.
import '../style/main.scss';

import { createDefaultRulesConfig } from './config/default-config';
import type { RulesConfig } from './config/rules-config';
import { Engine } from './engine/engine';
import { createHookBus } from './engine/hook-bus';
import {
  SPAWN_ATTEMPT_METRIC,
  SPAWN_SUPPRESSED_METRIC,
} from './engine/engine';
import type {
  EngineEventListener,
  EngineEventName,
  EngineEventPayloadMap,
  EngineEventSubscription,
  EngineEvents,
  StateCommitEvent,
} from './engine/engine-events';
import type { CorrelationId, EngineReporter } from './engine/types';
import { ENGINE_EVENT_NAMES } from './engine/engine-events';
import type { SpawnDetail } from './observability/metrics';
import { createInputManager } from './input/input-manager';
import type { InputReporter, InputSpan, Keymap } from './input/keymap';
import {
  DEFAULT_KEY_BINDINGS,
  deserializeKeymap,
  serializeKeymap,
} from './input/keymap';
import { detectPointerEventFamily } from './input/touch-input';
import type {
  LogFields,
  LogLevel,
  Logger,
} from './observability/logger';
import { createLogger, deriveCorrelationId } from './observability/logger';
import type { HealthSurface } from './observability/health';
import { createHealthSurface } from './observability/health';
import type {
  BoundaryTracing,
  EngineTracingSubscription,
  FinalMoveResolution,
  Span,
  Tracer,
} from './observability/tracer';
import {
  SPAN_ATTRIBUTES,
  SPAN_NAMES,
  attachEngineTracing,
  createBoundaryTracing,
  createTracer,
} from './observability/tracer';
import type { MetricsRegistry } from './observability/metrics';
import { METRIC_PREFIX, createMetricsRegistry } from './observability/metrics';
import type { WebGLProbeView } from './observability/health';
import type { DiagnosticsOverlay } from './observability/diagnostics-overlay';
import {
  createDiagnosticsOverlay,
  isDiagnosticsRequested,
} from './observability/diagnostics-overlay';
import { createNumberOnlyRenderer } from './render/number-only-renderer';
import { createRenderLoop } from './render/render-loop';
import type { FrameContext } from './render/render-loop';
import type { ContextRestoreOutcome } from './render/three-renderer';
import { createThreeRenderer } from './render/three-renderer';
import type {
  RenderCount,
  RenderDiagnostic,
  RenderReporter,
  RenderTiming,
  WebGLSupportResult,
} from './render/webgl-support';
import {
  createRenderReporter,
  describeRenderError,
  probeWebGLSupport,
  queryReducedMotion,
  setReducedMotionOverride,
  subscribeReducedMotion,
} from './render/webgl-support';
import type { RngReporter, RngStreams } from './rng/rng-streams';
import { createRngStreams } from './rng/rng-streams';
import type { HookBus } from './engine/hook-bus';
import { RelicRegistry } from './relics/relic-registry';
import { drawRelicOffers } from './relics/relic-draw';
import type { PersistedRelic } from './relics/relic-types';
import { HOOK_NAMES } from './engine/hooks';
import { createDefaultStageConfig } from './config/stage-config';
import type {
  RewardOffer,
  RewardSelection,
  RunIdentity,
  RunScope,
} from './run/run-controller';
import {
  RunController,
  normalizeEnteredSeed,
  originateRunSeed,
  resolveRunIdentity,
} from './run/run-controller';
import type { RunReporter } from './run/run-state';
import { RunStateStore } from './run/run-state-store';
import type { StorageFailure } from './storage/local-storage-manager';
import { LocalStorageManager } from './storage/local-storage-manager';
import { KEYMAP_KEY } from './storage/storage-keys';
import {
  LEGACY_CONTROL_BINDINGS,
  mountOnScreenControls,
} from './input/on-screen-controls';
import type { MarkupControlBinding } from './input/on-screen-controls';
import { getTheme, isThemeId } from './theme/themes';
import {
  createFocusManager,
  createParallelBoardLayer,
} from './ui/a11y/focus-manager';
import type { FocusManager } from './ui/a11y/focus-manager';
import type {
  SoundEngine,
  SoundMetricsRecorder,
  SoundReporter,
} from './audio/sound-engine';
import { createSoundEngine } from './audio/sound-engine';
import type { LiveRegionAnnouncer } from './ui/a11y/live-region';
import {
  ASSERTIVE_POLARITY,
  createLiveRegionAnnouncer,
} from './ui/a11y/live-region';
import type { EngineAnnouncer } from './ui/a11y/engine-announcer';
import { createEngineAnnouncer } from './ui/a11y/engine-announcer';
import { createScreenRouter } from './ui/screen-router';
import type { RewardCard } from './ui/screen-router';
import { createSettingsPanel } from './ui/components/settings-panel';
import type { SettingsPanel } from './ui/components/settings-panel';
import type { Hud } from './ui/screens/hud';
import { createHud } from './ui/screens/hud';
import type { PreferenceStore, UiReporter } from './ui/a11y/settings';
import {
  createPreferenceStore,
  reflectReducedMotion,
} from './ui/a11y/settings';

/* --------------------------------------------------------------------------
 * Mount points
 * ----------------------------------------------------------------------- */

/**
 * The elements index.html declares that this root looks up.
 *
 * Every lookup is guarded: the eight-selector contract of the vanilla
 * markup was dereferenced unchecked in four places in
 * js/html_actuator.js and two in js/keyboard_input_manager.js, so a
 * renamed class was a startup failure. An absent element is reported and
 * the rest of the page still starts.
 */
/**
 * Renders a theme id as the prose name a preference announcement carries.
 *
 * src/ui/a11y/live-region.ts deliberately imports no theme module, so its
 * default reads an id with its hyphens as spaces — "colourblind safe". This
 * supplies the catalogue's own `name` instead, and falls back to the id where
 * the value is not one this build knows.
 *
 * @param theme Theme id to render.
 * @returns The prose name.
 */
function describeThemeName(theme: string): string {
  return isThemeId(theme) ? getTheme(theme).name : theme;
}

/**
 * Name the inter-frame gap is reported under.
 *
 * Deliberately NOT the canonical frame metric: that one carries how long the
 * frame callbacks occupied the frame, which the loop measures and the tracer
 * records exactly once. This is the gap between frames, which is a different
 * quantity and therefore a different series.
 */
const FRAME_INTERVAL_TIMING = 'render.frame.interval';

const SELECTORS = Object.freeze({
  boardNumberOnly: '#board-number-only',
  boardCanvas: '#board-canvas',
  boardA11y: '#board-a11y',
  score: '.score-container',
  best: '.best-container',
  message: '.game-message',
  settingsPanel: '#settings-panel',
  settingsButton: '#settings-button',
  gameRegion: '#game-main',
  liveRegion: '#live-region',
  diagnostics: '#diagnostics-overlay',
  rewardScreen: '#screen-reward',
  // BOTH the host and a descendant. The parallel board's roving tab stop sits on
  // the HOST under the Three renderer and on the active CELL under the
  // number-only renderer, so a descendant-only selector matched nothing on every
  // WebGL session and the reward screen's focus restore fell back to the body.
  boardTabStop: '#board-a11y[tabindex="0"], #board-a11y [tabindex="0"]',
  hudGroup: '#screen-hud',
  hudStage: '#hud-stage',
  relicTray: '#relic-tray',
});

/**
 * The markup controls this root binds, and the action each publishes.
 *
 * `LEGACY_CONTROL_BINDINGS` is the three of js/keyboard_input_manager.js
 * L72-L74, and `mountOnScreenControls` is their ONE binding owner: this root
 * used to bind the same three elements a second time from a loop of its own, so
 * every pointer activation published twice — a double restart, and a double
 * `keepPlaying`. `#settings-button` is appended here rather than bound
 * separately, for the same reason: one owner per element.
 */
const MARKUP_CONTROLS: readonly MarkupControlBinding[] = Object.freeze([
  ...LEGACY_CONTROL_BINDINGS,
  Object.freeze({
    selector: SELECTORS.settingsButton,
    action: 'openSettings' as const,
  }),
]);

/* --------------------------------------------------------------------------
 * Reporting
 * ----------------------------------------------------------------------- */

/**
 * Maps a render diagnostic level onto a log level.
 *
 * The two vocabularies differ by one name: the render layer says `'warning'`
 * where the logger says `'warn'`.
 *
 * @param level Level as the render layer states it.
 * @returns The logger's name for it.
 */
function toLogLevel(level: RenderDiagnostic['level']): LogLevel {
  if (level === 'warning') {
    return 'warn';
  }

  return level === 'error' ? 'error' : 'info';
}

/**
 * Builds the sink every layer of the application reports through.
 *
 * THE ONE SINK. `RenderReporter` is the hub the whole reporting graph adapts
 * onto — the engine, input, storage, preference and UI adapters below all
 * narrow to it — so wiring its three channels to the structured logger and the
 * metrics registry is what puts the entire graph into real sinks rather than
 * some of it.
 *
 * Before this, the browser build wrote diagnostics straight to `console` and
 * DISCARDED every count and every timing: the logger and the metrics registry
 * were both fully implemented, and neither was ever constructed, so nothing
 * carried a correlation identifier, no counter ever moved and the diagnostics
 * surface had nothing to show. Console output is retained — the logger writes it
 * itself under `consoleOutput` — so nothing that used to be visible stops being
 * visible.
 *
 * @param logger Structured logger diagnostics are recorded through.
 * @param metrics Registry counts and timings are recorded into.
 * @returns A frozen reporter whose channels cannot throw into their callers.
 */
function createSink(logger: Logger, metrics: MetricsRegistry): RenderReporter {
  return createRenderReporter({
    onDiagnostic: (diagnostic: RenderDiagnostic): void => {
      const target = logger.child(diagnostic.source);
      const fields: LogFields = {
        ...(diagnostic.detail ?? {}),
      };

      if (diagnostic.level === 'error' || diagnostic.level === 'warning') {
        // `failure` is the form that carries a caught value of unknown type:
        // the throwable travels in `detail.thrown` and its presence is read
        // with `in`, so a thrown `null` or `undefined` is still serialised
        // rather than being mistaken for no throwable at all.
        target.failure(toLogLevel(diagnostic.level), diagnostic.message, {
          fields,
          ...('thrown' in diagnostic
            ? { thrown: diagnostic.thrown }
            : diagnostic.error === undefined
              ? {}
              : { thrown: diagnostic.error }),
        });

        return;
      }

      target.info(diagnostic.message, fields);
    },

    onCount: (count: RenderCount): void => {
      // Counted under a Prometheus-safe name: the report's own dotted name is
      // kept as a label so the original is still readable in a snapshot.
      metrics.counter(toMetricName(count.name), readCountLabels(count)).inc(
        count.value,
      );
    },

    onTiming: (timing: RenderTiming): void => {
      // Every named timer becomes a span observation, so the frame-callback
      // seam and the turn pipeline land in the same histogram family and one
      // snapshot shows both.
      metrics.recordSpanDuration(timing.name, timing.durationMs);
    },
  });
}

/**
 * Renders a dotted report name as a Prometheus-safe metric name.
 *
 * The reporting layers name counters as `'render.webgl.probe'`; Prometheus
 * accepts `[a-zA-Z_:][a-zA-Z0-9_:]*`. Separators become underscores and any
 * other unaccepted character is replaced rather than dropped, so two distinct
 * report names cannot collapse onto one metric.
 *
 * @param name Report name to render.
 * @returns The metric name, prefixed by the registry's namespace.
 */
function toMetricName(name: string): string {
  const normalized = String(name)
    .replace(/[.\-/\s]+/g, '_')
    .replace(/[^a-zA-Z0-9_:]/g, '_');

  return `${METRIC_PREFIX}${normalized === '' ? 'unnamed' : normalized}`;
}

/**
 * Reads the labels a counter increment carries.
 *
 * Only the report's own name, because a label set of unbounded cardinality is
 * how a metrics registry is turned into a memory leak: `detail` can carry a
 * board size, a selector or a caught message, and any of those as a label
 * would mint a new series per distinct value. The detail stays in the log
 * record, which is bounded by the buffer, rather than in the metric.
 *
 * @param count The increment.
 * @returns The label set.
 */
function readCountLabels(count: RenderCount): Readonly<Record<string, string>> {
  return Object.freeze({ report: String(count.name) });
}

/**
 * Adapts a render sink to the input layer's sink shape.
 *
 * The two interfaces are declared by different layers and neither
 * imports the other; this is the adapter between them.
 *
 * @param reporter Render sink to write through.
 * @returns An input sink.
 */
function createInputSink(
  reporter: RenderReporter,
  tracer: Tracer | null = null,
): InputReporter {
  return {
    /**
     * The `input.dispatch` boundary of validation gate V8.
     *
     * src/input/input-manager.ts opens a span around its whole listener walk
     * and reports the event name as `input.dispatch.<event>`; the tracer's
     * vocabulary is closed, so the name becomes the span's `action` attribute
     * rather than a span name of its own. Omitting the tracer leaves the
     * manager's own no-op span in place.
     */
    ...(tracer === null
      ? {}
      : {
          startSpan(name: string): InputSpan {
            const span = tracer.startSpan(SPAN_NAMES.inputDispatch, {
              attributes: { [SPAN_ATTRIBUTES.action]: name },
            });

            return {
              end(): void {
                span.end();
              },
            };
          },
        }),

    log(level, message, fields): void {
      reporter.onDiagnostic({
        level: level === 'warn' ? 'warning' : level,
        source: 'input',
        message,
        detail: fields === undefined ? undefined : Object.freeze({ ...fields }),
      });
    },

    count(metric, fields): void {
      reporter.onCount({
        name: metric,
        value: 1,
        detail: fields === undefined ? undefined : Object.freeze({ ...fields }),
      });
    },

    failure(level, message, thrown, fields): void {
      reporter.onDiagnostic({
        level: level === 'warn' ? 'warning' : level,
        source: 'input',
        message,
        detail: fields === undefined ? undefined : Object.freeze({ ...fields }),
        error: describeRenderError(thrown),
        thrown,
      });
    },
  };
}

/**
 * Adapts a render sink to the accessibility surface's sink shape.
 *
 * @param reporter Render sink to write through.
 * @returns A preference-store sink.
 */
function createPreferenceSink(reporter: RenderReporter): UiReporter {
  return {
    log(level, message, fields): void {
      reporter.onDiagnostic({
        level: level === 'warn' ? 'warning' : level,
        source: 'ui/a11y',
        message,
        detail: fields === undefined ? undefined : Object.freeze({ ...fields }),
      });
    },

    count(metric, fields): void {
      reporter.onCount({
        name: metric,
        value: 1,
        detail: fields === undefined ? undefined : Object.freeze({ ...fields }),
      });
    },

    error(message, caught, fields): void {
      reporter.onDiagnostic({
        level: 'error',
        source: 'ui/a11y',
        message,
        detail: fields === undefined ? undefined : Object.freeze({ ...fields }),

        // The ONE total reduction, shared with src/render/: reading `name`,
        // `message` or `String(value)` here would let a hostile getter or a
        // throwing `toString` replace the failure being reported. `thrown`
        // carries the value ITSELF, so `serializeError` of
        // src/observability/logger.ts keeps the stack, the cause chain and a
        // non-`Error` throwable's own structure that a two-field summary cannot.
        error: describeRenderError(caught),
        thrown: caught,
      });
    },
  };
}

/**
 * Adapts a render sink to the audio layer's sink shape.
 *
 * The whole report is carried on one member, so the level, the code, the
 * details and the caught value all reach the logger through it.
 *
 * @param reporter Render sink to write through.
 * @returns An audio sink.
 */
function createSoundSink(reporter: RenderReporter): SoundReporter {
  return {
    report(report): void {
      reporter.onDiagnostic({
        level: report.level === 'warn' ? 'warning' : report.level,
        source: 'audio',
        message: report.message,
        detail: Object.freeze({
          code: report.code,
          ...(report.details === undefined ? {} : report.details),
        }),
        error:
          report.error === undefined
            ? undefined
            : describeRenderError(report.error),
        ...(report.error === undefined ? {} : { thrown: report.error }),
      });
    },
  };
}

/**
 * Adapts a render sink to the audio layer's counter shape.
 *
 * @param reporter Render sink to write through.
 * @returns An audio counter recorder.
 */
function createSoundMetrics(reporter: RenderReporter): SoundMetricsRecorder {
  return {
    increment(name, value): void {
      reporter.onCount({ name, value: value ?? 1 });
    },
  };
}

/**
 * Adapts a render sink to the engine's sink shape.
 *
 * @param reporter Render sink to write through.
 * @returns An engine sink.
 */
function createEngineSink(
  reporter: RenderReporter,
  metrics: MetricsRegistry,
): EngineReporter {
  return {
    onHookError(report): void {
      reporter.onDiagnostic({
        level: 'error',
        source: 'engine',
        message: `A ${report.hook} handler threw.`,
        detail: Object.freeze({
          correlationId: report.correlationId,

          hook: report.hook,
          subscriber: report.subscriberId,
        }),
        // The one total reduction, shared with src/render/: reading
        // `name`, `message` or `String(value)` here would let a hostile
        // getter or a throwing `toString` replace the failure being
        // reported. `thrown` carries the value itself for a sink that can
        // keep more of it than the summary does.
        error: describeRenderError(report.error),
        thrown: report.error,
      });
    },

    onListenerError(report): void {
      reporter.onDiagnostic({
        level: 'error',
        source: 'engine',
        message:
          `A ${report.event} listener threw and was contained; the ` +
          'emission continued with the listeners after it.',
        detail: Object.freeze({
          reportedCorrelationId: report.correlationId,
          event: report.event,
          listenerIndex: report.listenerIndex,
        }),

        // The same pairing the hook-error member above uses: the bounded
        // summary through the one total reducer, and the caught value itself for
        // a sink that can keep more of it than two fields.
        error: describeRenderError(report.error),
        thrown: report.error,
      });
    },

    onCount(report): void {
      // The engine's own spawn counters are the AUTHORITATIVE attempt boundary:
      // `onSpawn` is not dispatched and `tile:spawn` is not emitted on a full
      // board, so an attempt is countable from the engine alone. They reach the
      // declared `game2048_spawn_attempts_total` and
      // `game2048_spawn_suppressed_total` families through their purpose-built
      // recorders rather than a generic counter under a dotted name.
      if (report.metric === SPAWN_ATTEMPT_METRIC) {
        metrics.recordSpawnAttempt();
      } else if (report.metric === SPAWN_SUPPRESSED_METRIC) {
        metrics.recordSpawnSuppressed();
      }

      // `hook` and `event` are separate dimensions of `EngineCountReport`
      // and a report carries at most one, so both are forwarded and the
      // absent one is `null`.
      reporter.onCount({
        name: report.metric,
        value: report.value,
        detail: Object.freeze({
          correlationId: report.correlationId,

          hook: report.hook ?? null,
          event: report.event ?? null,
        }),
      });
    },
  };
}

/**
 * Adapts the render reporter to the run folder's sink.
 *
 * Every member of `RunReporter` is routed: the four failure and resolution
 * reports as diagnostics, the four lifecycle reports as counted events. The
 * board-size reconciliation and the refused payload are the reports the
 * guarded loader produces, and this is the sink they reach — before this
 * adapter existed, `RunStateStore` was constructed nowhere and they reached
 * nothing at all.
 *
 * NO SEED IS FORWARDED. A seed is text the player may have typed, and none of
 * these report shapes carries one: `RunStartedReport` carries `seedProvided`
 * and `RunEndedReport` carries the summary with the seed already redacted out
 * of it.
 *
 * @param reporter The one sink of the composition.
 * @returns A complete `RunReporter`.
 */
function createRunSink(reporter: RenderReporter): RunReporter {
  return {
    onLoadCorrupted(report): void {
      reporter.onDiagnostic({
        level: 'warning',
        source: 'run/state',
        message:
          `The stored run was refused (${report.verdict}); a fresh run ` +
          'was started.',
        detail: Object.freeze({
          key: report.key,
          verdict: report.verdict,
          problems: report.problems.join('; '),
        }),
        thrown: report.error,
      });
    },

    onVersionMigrated(report): void {
      reporter.onDiagnostic({
        level: 'info',
        source: 'run/state',
        message: 'The stored run was migrated to the current schema.',
        detail: Object.freeze({
          fromVersion: report.fromVersion ?? null,
          toVersion: report.toVersion,
        }),
      });
    },

    onBoardSizeReconciled(report): void {
      reporter.onDiagnostic({
        level: 'info',
        source: 'run/state',
        message:
          `The board size was reconciled to ${report.appliedSize} ` +
          `(stored ${report.savedSize}, configured ${report.configuredSize}).`,
        detail: Object.freeze({
          savedSize: report.savedSize,
          configuredSize: report.configuredSize,
          relicSize: report.relicSize,
          appliedSize: report.appliedSize,
        }),
      });
    },

    onWriteFailed(report): void {
      reporter.onDiagnostic({
        level: 'error',
        source: 'run/state',
        message: `The run could not be persisted under ${report.key}.`,
        detail: Object.freeze({
          key: report.key,
          byteLength: report.byteLength,
        }),
        thrown: report.error,
      });
    },

    onRunStarted(report): void {
      reporter.onCount({
        name: 'run.started',
        value: 1,
        detail: Object.freeze({
          resumed: report.resumed,
          seedProvided: report.seedProvided,
          stageIndex: report.stageIndex,
        }),
      });
      reporter.onDiagnostic({
        level: 'info',
        source: 'run/controller',
        message: report.resumed
          ? `Resumed a run at stage ${report.stageIndex}.`
          : 'Started a new run.',
        detail: Object.freeze({
          runId: report.runId,
          stageIndex: report.stageIndex,
          resumed: report.resumed,
          seedProvided: report.seedProvided,
        }),
      });
    },

    onStageAdvanced(report): void {
      reporter.onCount({
        name: 'run.stageAdvanced',
        value: 1,
        detail: Object.freeze({ toStageIndex: report.toStageIndex }),
      });
      reporter.onDiagnostic({
        level: 'info',
        source: 'run/controller',
        message:
          `Stage ${report.fromStageIndex} cleared; stage ` +
          `${report.toStageIndex} targets ${report.goal.target} ` +
          `(${report.goal.kind}).`,
        detail: Object.freeze({
          fromStageIndex: report.fromStageIndex,
          toStageIndex: report.toStageIndex,
          goalKind: report.goal.kind,
          goalTarget: report.goal.target,
        }),
      });
    },

    onRewardOffered(report): void {
      reporter.onCount({
        name: 'run.rewardOffered',
        value: 1,
        detail: Object.freeze({
          stageIndex: report.stageIndex,
          offered: report.offeredRelicIds.length,
        }),
      });
    },

    onRewardDrawn(report): void {
      reporter.onCount({
        name: 'run.rewardDrawn',
        value: 1,

        // `accepted` and `refusal` carry the outcome of the reward transition,
        // so a refused offer or a refused selection is counted as such rather
        // than as an indistinguishable draw.
        detail: Object.freeze({
          stageIndex: report.stageIndex,
          offered: report.offeredRelicIds.length,
          accepted: report.accepted ?? false,
          refusal: report.refusal ?? 'none',
        }),
      });
    },

    // A loaded envelope whose relics the catalogue refused. Reported at `warn`
    // rather than counted alone, because the identifiers are what tell a
    // maintainer whether the save predates a catalogue change or was tampered
    // with, and a bare count says neither.
    onRelicsNormalized(report): void {
      reporter.onDiagnostic({
        level: 'warning',
        source: 'run',
        message: `Hydration refused ${report.requested - report.restored} of ${report.requested} stored relics.`,
        detail: Object.freeze({
          requested: report.requested,
          restored: report.restored,

          // Joined rather than carried as an array: a diagnostic detail is a
          // flat record of scalars, so the identifiers travel as one field.
          refused: report.refused.join(', '),
        }),
      });
    },

    onRunEnded(report): void {
      reporter.onCount({
        name: 'run.ended',
        value: 1,
        detail: Object.freeze({ outcome: report.outcome }),
      });
      reporter.onDiagnostic({
        level: 'info',
        source: 'run/controller',
        message:
          `The run ended (${report.outcome}) at stage ` +
          `${report.summary.stageIndex} with score ${report.summary.score}.`,
        detail: Object.freeze({
          runId: report.summary.runId,
          outcome: report.outcome,
          stageIndex: report.summary.stageIndex,
          score: report.summary.score,
          relics: report.summary.relics.length,
        }),
      });
    },
  };
}

/**
 * Adapts the render reporter to the RNG folder's sink.
 *
 * The substreams are resumed from a cursor map that came back out of Web
 * Storage, so a refused cursor is a real event with a real consequence — that
 * substream restarts at zero and the run's sequence diverges from the one it
 * was playing. It is reported as a warning rather than absorbed.
 *
 * @param reporter The one sink of the composition.
 * @returns A complete `RngReporter`.
 */
function createRngSink(reporter: RenderReporter): RngReporter {
  return {
    onRejected(rejection): void {
      reporter.onDiagnostic({
        level: 'warning',
        source: 'rng',
        message:
          `A ${rejection.kind} value was refused` +
          `${rejection.stream === undefined ? '' : ` for ${rejection.stream}`}` +
          '; that substream starts at zero.',
        detail: Object.freeze({
          kind: rejection.kind,
          stream: rejection.stream ?? null,
          observed: rejection.observed,
          maximum: rejection.maximum,
        }),
      });
    },
  };
}

/* --------------------------------------------------------------------------
 * Boundary tracing, injected rather than imported
 * ----------------------------------------------------------------------- */

// Rule 3 requires trace coverage of the whole chain validation gate V8 names —
// input, engine turn, move resolution, hook dispatch, relic handler, renderer,
// and the frame callback — and AAP 0.4.1.2 requires the observability layer to
// attach as ordinary subscribers with no engine-side call site. Every one of
// those boundaries is spanned by a collaborator this root injects, so no module
// under src/engine, src/input, src/relics or src/render imports anything from
// src/observability. Decision DL-MAIN-05.
//
// WHERE EACH ONE IS SPANNED, so a reader does not go looking for a wrapper that
// is not here:
//   input.dispatch      `createInputSink(reporter, tracer)`, whose `startSpan`
//                       the input manager calls around its whole listener walk.
//   engine.turn         `attachEngineTracing`, opened on `move:before`, closed
//                       by the turn's commit or settled by the caller for an
//                       attempt that moved nothing.
//   engine.move.resolve `EngineOptions.tracing.traceMoveResolution`, which the
//                       engine runs around the traversal walk alone, so the
//                       resolution nests INSIDE the turn it belongs to.
//   hook.dispatch       `HookBusOptions.tracing`, which `BoundaryTracing`
//                       satisfies structurally.
//   relic.handler       the same seam, once per handler invocation.
//   render.commit       `createTracedRenderEvents` below, on the one emitter the
//                       board renderer subscribes through.
//   render.frame        `Tracer.frameLifecycleHooks()`, handed to the loop.

/* --------------------------------------------------------------------------
 * Run identity
 * ----------------------------------------------------------------------- */

/** Bytes drawn for one run token. */
const SEED_BYTES = 8;

/** Radix every token component is written in. */
const SEED_RADIX = 36;

/**
 * Creates one random run token.
 *
 * Called twice per page load, once for the run seed and once for the
 * run-instance identifier, and the two draws are independent.
 *
 * Web Crypto is the source where it is available. Where it is not, the
 * two clocks are combined, which yields a distinct token per page load
 * without reaching for `Math.random()`: no module under src/ calls it,
 * and a test asserts the global is never replaced.
 *
 * @returns A token string. The seed form is used verbatim by the
 *   substreams.
 */
function createRunToken(): string {
  const source = globalThis.crypto;

  if (source !== undefined && typeof source.getRandomValues === 'function') {
    const bytes = new Uint8Array(SEED_BYTES);

    source.getRandomValues(bytes);

    return Array.from(bytes, (byte: number) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
  }

  const wallClock = Date.now().toString(SEED_RADIX);
  const monotonic =
    typeof performance === 'undefined'
      ? '0'
      : Math.trunc(performance.now() * 1000).toString(SEED_RADIX);

  return `${wallClock}-${monotonic}`;
}

/* --------------------------------------------------------------------------
 * Renderer selection
 * ----------------------------------------------------------------------- */

/** The two ways the board can be drawn. */
export type BoardRenderMode = 'three' | 'number-only';

/**
 * The WebGL failure the health check reports while a context stands lost.
 *
 * Distinct from every failure the startup probe can report, all of which
 * describe a context that could not be OBTAINED; this one describes a context
 * that was obtained and then taken away.
 */
const CONTEXT_LOST_FAILURE = 'context-lost';

/**
 * The WebGL failure the health check reports while a restored context's
 * resources could not be rebuilt.
 *
 * The context came back and the board still cannot draw, which is neither an
 * unobtainable context nor a lost one.
 */
const CONTEXT_UNREBUILT_FAILURE = 'context-not-rebuilt';

/**
 * The WebGL failure the health check reports while the 2.5D board is selected
 * but not mounted.
 */
const RENDERER_UNMOUNTED_FAILURE = 'renderer-not-mounted';

/**
 * The WebGL failure the health check reports while the number-only board is
 * standing in for a WebGL board that could not be served.
 *
 * A number-only board the PLAYER chose reports no failure: that is the
 * accessible rendering mode of R9 working as intended, not a capability gap.
 */
const FORCED_FALLBACK_FAILURE = 'number-only-forced';

/** How the board is drawn, and why that mode is in force. */
export interface BoardRenderSelection {
  /** The rendering mode in use. */
  readonly mode: BoardRenderMode;

  /**
   * Whether number-only rendering is standing in for an unavailable WebGL
   * context, rather than having been chosen. The two cases are distinguished
   * so the capability is observable rather than assumed.
   */
  readonly fallback: boolean;

  /** Whether number-only rendering was chosen deliberately. */
  readonly chosen: boolean;

  /** The probe result the selection was made from. */
  readonly support: WebGLSupportResult;
}

/**
 * The part of a board renderer this root drives.
 *
 * Declared structurally and satisfied by BOTH renderers, which is what lets the
 * mode be selected — and switched — without the wiring below knowing which one
 * it holds. `frame` accepts the loop's context, which the 2.5D renderer reads a
 * delta from and the number-only renderer ignores.
 */
interface BoardRenderer {
  readonly mounted: boolean;
  mount(target?: Element | null): boolean;
  unmount(): void;
  subscribe(events: EngineEvents): EngineEventSubscription;
  render(commit: StateCommitEvent): void;
  frame(context?: FrameContext): boolean;
  destroy(): void;

  /**
   * The renderer's own counters, where it keeps any. Optional, because the
   * number-only renderer has no GPU state to report.
   */
  readStats?(): { readonly contextLost: boolean };
}

/**
 * How long a lost WebGL context is waited on before the number-only board takes
 * over.
 *
 * BOUNDED, DELIBERATELY. A loss the browser restores is common — a driver
 * reset, a tab restored from the background — and swapping renderers on every
 * one of them would replace a board that recovers in two frames with a
 * different board altogether. A loss the browser never restores is the case that
 * left the board frozen for the rest of the session, which is what this bound
 * ends.
 *
 * 1200 ms is the delay the terminal overlay already waits before it fades in
 * (`$transition-speed` x 12), so the fallback cannot appear faster than the
 * slowest thing the product already shows a player.
 */
export const CONTEXT_RESTORE_GRACE_MS = 1200;

/**
 * Reads whether the renderer in force is reporting a lost context.
 *
 * @param renderer The renderer in force.
 * @returns `true` only where the renderer both reports its context state and
 *   reports it lost.
 */
function readContextLost(renderer: BoardRenderer): boolean {
  return renderer.readStats?.().contextLost === true;
}

/**
 * Selects the board rendering mode from the capability and the preference.
 *
 * TWO INDEPENDENT REASONS produce number-only rendering, and they are not
 * interchangeable: WebGL is a hard runtime prerequisite the product has never
 * had, so a machine without a context must be served the number-only board
 * (implicit requirement I6); and number-only mode is a first-class accessible
 * rendering mode a player may choose with a context available (R9). The
 * preference store holds both as one effective value — `isNumberOnlyMode()` —
 * and reports which of the two produced it, so the report below can say why.
 *
 * The probe is therefore consulted BEFORE this, and its result is pushed into
 * the store as a force, which is the order a prerequisite has to be checked in.
 *
 * @param support The probe result.
 * @param preferences The store holding the effective number-only value.
 * @returns The selected mode, and why it is in force.
 */
function selectBoardRenderer(
  support: WebGLSupportResult,
  preferences: PreferenceStore,
): BoardRenderSelection {
  const numberOnly = preferences.isNumberOnlyMode();

  return Object.freeze({
    mode: numberOnly ? 'number-only' : 'three',
    fallback: numberOnly && preferences.isNumberOnlyForced(),
    chosen: numberOnly && !preferences.isNumberOnlyForced(),
    support,
  });
}

/**
 * Wraps an emitter so a board renderer's `state:commit` listener runs inside
 * the `render.commit` boundary span.
 *
 * The renderer registers its own listeners from inside `subscribe`, so the span
 * is applied where the listener is REGISTERED rather than around a call this
 * module makes. Every other event name is registered unchanged, and `off`
 * resolves a caller's listener back to the wrapper it was registered as, so
 * removal behaves exactly as it does on the engine's own emitter.
 *
 * @param events The engine's emitter.
 * @param traceRenderCommit The `render.commit` boundary wrapper.
 * @param readTurnSpan Reads the turn span open right now, which the commit span
 *   is opened as a CHILD of explicitly. The listener that closes the turn span
 *   is another `state:commit` listener, so relying on the implicit-parent stack
 *   made the parent link depend on which of the two was registered first.
 * @returns A frozen emitter with the same three members.
 */
function createTracedRenderEvents(
  events: EngineEvents,
  traceRenderCommit: BoundaryTracing['traceRenderCommit'],
  readTurnSpan: () => Span | undefined,
): EngineEvents {
  type CommitListener = EngineEventListener<'state:commit'>;

  const wrapped = new Map<CommitListener, CommitListener>();

  return Object.freeze({
    on<K extends EngineEventName>(
      event: K,
      listener: EngineEventListener<K>,
    ): EngineEventSubscription {
      if (event !== 'state:commit') {
        return events.on(event, listener);
      }

      const commitListener = listener as CommitListener;
      const traced: CommitListener = (commit): void => {
        traceRenderCommit((): void => {
          commitListener(commit);
        }, readTurnSpan() ?? null);
      };

      wrapped.set(commitListener, traced);

      const release = events.on('state:commit', traced);

      return (): void => {
        wrapped.delete(commitListener);
        release();
      };
    },

    off<K extends EngineEventName>(
      event: K,
      listener: EngineEventListener<K>,
    ): void {
      if (event !== 'state:commit') {
        events.off(event, listener);

        return;
      }

      const commitListener = listener as CommitListener;
      const traced = wrapped.get(commitListener);

      wrapped.delete(commitListener);
      events.off('state:commit', traced ?? commitListener);
    },

    emit<K extends EngineEventName>(
      event: K,
      payload: EngineEventPayloadMap[K],
    ): void {
      events.emit(event, payload);
    },
  });
}

/**
 * The reward moment as a caller drives it: what is on the table, and taking one.
 */
export interface RewardSurface {
  /**
   * The offer on the table, and an empty array while none is.
   *
   * Three relics drawn without replacement from the sixteen-relic catalogue
   * through the run's own substreams, so the same seed and the same move list
   * yield the same three and no set can hold a duplicate.
   */
  offers(): readonly RewardOffer[];

  /**
   * Takes one offered relic on: it joins the run's envelope AND becomes a live
   * dispatching subscriber on the hook bus.
   *
   * @param relicId Identifier of the chosen relic, which must be on the table.
   * @returns Whether the relic joined the run. An identifier that was not
   *   offered, one the run already holds and one beyond the persisted bound are
   *   each refused and reported rather than raising.
   */
  choose(relicId: string): boolean;
}

/* --------------------------------------------------------------------------
 * Composition
 * ----------------------------------------------------------------------- */

/** What `start()` built, so a caller can drive or dismantle it. */
export interface Application {
  /** The rules engine. */
  readonly engine: Engine;

  /** The rules the engine and the renderer read. */
  readonly config: RulesConfig;

  /** The run's seeded substreams. */
  readonly streams: RngStreams;

  /** The board rendering mode in use. */
  readonly renderer: BoardRenderSelection;

  /** The one HUD actuator: the score outlets and the terminal overlay. */
  readonly hud: Hud;

  /**
   * The diagnostics surface, this build's stand-in for a metrics endpoint.
   *
   * Exposed so the capability is exercisable — from a console, a test or a key
   * binding — rather than only reachable if something happens to open it.
   */
  readonly diagnostics: DiagnosticsOverlay;

  /** The structured logger every layer reports through. */
  readonly logger: Logger;

  /** The metrics registry every count and timing lands in. */
  readonly metrics: MetricsRegistry;

  /**
   * The Performance-API tracer every span of the input -> engine -> hook bus ->
   * relic handler -> renderer chain, and of the frame callback, is opened on —
   * every module boundary validation gate V8 enumerates.
   *
   * Exposed for the same reason the diagnostics surface is: a capability that
   * cannot be exercised locally is not delivered, and `snapshot()` on this is
   * how the span records are read from a console or a test without the overlay
   * having to be opened.
   */
  readonly tracer: Tracer;

  /**
   * The health surface: the five reused capability probes plus the WebGL probe,
   * their roll-up report and the two readiness verdicts.
   *
   * Exposed so `check()`, `report()` and `readiness()` are reachable at will
   * against the running page rather than only against a unit test — a static
   * bundle has no port for an orchestrator to poll, so this object IS the
   * readiness probe (AAP 0.7.2.4).
   */
  readonly health: HealthSurface;


  /**
   * The run in progress: its identity, its stage, its relics and its summary.
   *
   * Exposed because it is the only reachable source of the run seed — which the
   * player is meant to be able to read and copy — and of the finished run a
   * summary is drawn from once the stored envelope has been cleared.
   */
  readonly run: RunController;

  /**
   * The reward moment: the offer a cleared stage earned, and taking one.
   *
   * Exposed because the reward screen is driven from outside this module and the
   * seeded draw lives inside it: without a reachable surface the offer would be
   * drawn, recorded, announced and then impossible to act on.
   */
  readonly rewards: RewardSurface;

  /**
   * The relic registry: the catalogue, the relics held in pickup order, their
   * charge budgets, and the manual activation a player's `activateRelic` press
   * reaches.
   *
   * Exposed for the same reason the tracer and the health surface are: a
   * capability that cannot be exercised from a console or a test is not
   * delivered. A press activates through this object, and the budget it spends
   * is the one src/engine/hook-bus.ts holds.
   */
  readonly relics: RelicRegistry;

  /**
   * The accessibility and presentation preferences in force.
   *
   * Exposed because it is the surface that decides which renderer draws the
   * board, which palette is applied and whether motion is reduced, and because
   * nothing outside this module could otherwise reach the running application's
   * settings at all.
   */
  readonly preferences: PreferenceStore;

  /**
   * The audio layer, which FOLLOWS `preferences` and cannot be written to
   * directly.
   *
   * Exposed for the same reason the store is: it is otherwise unreachable, and
   * it is the only place the effect of a mute or a volume change can be read
   * back. `setMuted` and `setVolume` on it are refused — the store is the single
   * owner of both (N1).
   */
  readonly soundEngine: SoundEngine;

  /** Stops the frame loop and removes every listener that was bound. */
  /**
   * Discards the run in force and starts a FRESH one: a new run identifier, a
   * new seed, substreams rebuilt at cursor zero, no relics, stage 0, and a new
   * board.
   *
   * THE EXPLICIT NEW-RUN PATH. `start()` resumes, and this replaces — the two
   * are separate calls rather than one call that guesses. Every piece of run
   * identity is replaced together, so a second run played without a reload can
   * neither inherit the previous run's seed and cursors nor report under its
   * correlation identifier.
   *
   * @param seed Seed to play, reduced by `normalizeEnteredSeed`. Originated when
   *   absent.
   * @returns The seed the new run is played under.
   */
  readonly startNewRun: (seed?: string) => string;

  readonly dispose: () => void;
}

/**
 * Builds and starts the application.
 *
 * The order is load-bearing, and it is a chain rather than a preference:
 *
 *   storage -> run identity -> correlation identifier -> logger, metrics,
 *   tracer and health -> run controller -> substreams -> hook bus -> engine ->
 *   engine tracing -> subscribers -> `setup()`
 *
 * Storage comes first because the run's identity is read out of it. That
 * identity supplies the correlation identifier, which everything that reports is
 * keyed on. The controller's load then supplies the seed and the cursors the
 * substreams are built from, and the engine reads the substreams and the
 * configuration. Every subscriber attaches after the engine exists, and
 * `setup()` runs last so the first state commit reaches a renderer that is
 * already listening — js/game_manager.js L13 called `setup()` from its own
 * constructor and therefore emitted its first actuation before anything else
 * could have attached.
 *
 * @param ownerDocument Document to mount into. Defaults to the ambient
 *   `document`.
 * @returns The composed application.
 */
/**
 * `RngStreams` whose backing instance can be replaced.
 *
 * WHY A FACADE. The engine takes its substreams at construction and reads them
 * through `this.streams` at every use site, caching no stream object. A run
 * that starts fresh needs substreams built from a NEW seed at cursor zero, and
 * rebuilding the engine to deliver them would tear down every subscription the
 * composition root installed. Swapping what this delegates to replaces the
 * randomness without disturbing anything holding a reference to it.
 *
 * `seed` is a getter rather than a captured value, so it reports the seed of the
 * run in force.
 */
interface SwappableRngStreams extends RngStreams {
  /** Replaces the backing instance. Later draws come from `next`. */
  replace(next: RngStreams): void;
}

function createSwappableRngStreams(
  initial: RngStreams,
): SwappableRngStreams {
  let inner = initial;

  return {
    get seed(): string {
      return inner.seed;
    },

    stream: (name) => inner.stream(name),
    snapshotCursors: () => inner.snapshotCursors(),

    replace: (next: RngStreams): void => {
      inner = next;
    },
  };
}

export function start(ownerDocument: Document): Application {
  // A caller composing the application supersedes the automatic boot deferred by
  // `bootstrap()`: one document hosts one application, and a second composition
  // over the same markup would bind every control twice. The boot's own call is
  // exempt.
  cancelPendingBoot();

  const config = createDefaultRulesConfig();
  const stages = createDefaultStageConfig();

  // Storage is composed FIRST, ahead of the observability layer, because the
  // run's identity is read out of it and everything that reports is keyed on a
  // value derived from that identity.
  //
  // Its own failure sink therefore does not exist yet. Failures raised before it
  // does are held and replayed the moment it is attached, so a quota exhausted
  // during the identity read is reported rather than dropped.
  const earlyStorageFailures: StorageFailure[] = [];
  let reportStorageFailure = (failure: StorageFailure): void => {
    earlyStorageFailures.push(failure);
  };

  const storage = new LocalStorageManager({
    reporter: {
      onFailure: (failure): void => {
        reportStorageFailure(failure);
      },
    },
  });

  // The run's identity: the seed it plays and the instance that plays it.
  //
  // Read from the stored envelope where one is readable, so a reload CONTINUES
  // the run it interrupted — same seed, same run identifier, and therefore the
  // same correlation identifier — rather than starting a new one. Originated
  // only when there is nothing to continue. Reports nothing: it is what makes
  // reporting possible.
  const identity: RunIdentity = resolveRunIdentity({
    storage,
    createToken: createRunToken,
  });

  // The one derivation of the run correlation identifier. Every module
  // that reports receives this value; none derives one of its own, and
  // neither the seed nor the run identifier is carried into a report.
  //
  // Both inputs: the run instance makes it unique, and the seed keeps the
  // seed-grouping prefix, so a stream can still be grouped by seed. The seed is
  // displayed and copyable by design, so replays of one seed are an expected
  // event rather than an edge case, and an identifier derived from the seed
  // alone would put every one of them under a single value. No engine behaviour
  // reads this, so gameplay determinism is unaffected.
  //
  // HELD IN A SCOPE RATHER THAN A CONSTANT. A run started without a reload mints
  // a new identity, so an identifier captured by each module at construction
  // attributed the second run's records, counters, spans, health reports, hook
  // contexts, relic reports and persistence reports to the first run.
  // `readCorrelationId` is what every module receives, and `rotateCorrelation`
  // below is the ONE writer — of this scope and, through
  // `Logger.setCorrelationId`, of the logger the metrics registry, the tracer
  // and the health surface read theirs from.
  let runCorrelationId = deriveCorrelationId(identity.seed, identity.runId);

  /** Reads the correlation identifier of the run in force. */
  const readCorrelationId = (): CorrelationId => runCorrelationId;

  // The structured logger and the metrics registry, both of which shipped fully
  // implemented and neither of which was ever constructed. `consoleOutput` keeps
  // everything that used to reach the console reaching it, now as a structured
  // record carrying the correlation identifier rather than a bare string.
  const logger = createLogger({
    correlationId: runCorrelationId,
    subsystem: 'main',
    consoleOutput: true,
  });

  // The logger is handed to the registry so its own internal reports correlate
  // with everything else under the same identifier.
  const metrics = createMetricsRegistry({ logger });
  const reporter = createSink(logger, metrics);

  // The ONE tracer of the running application. Every span the diagnostics
  // trace panel shows is opened on it, and the correlation identifier its span
  // identifiers derive from is the same one the logger and the registry carry.
  const tracer = createTracer({
    logger,
    metrics,

    // The READER, so the tracer's span identifiers and its snapshot follow the
    // rotation rather than the identifier this page loaded with.
    correlationId: readCorrelationId,
  });

  // The module-boundary wrappers, one per boundary of the input -> engine ->
  // hook bus -> relic handler -> renderer chain. Injected into the layers that
  // need them, so no layer below src/observability imports a tracer.
  const boundaries: BoundaryTracing = createBoundaryTracing(tracer);

  /**
   * The WebGL probe result, once taken. Held in a slot because the health
   * surface is composed before the probe runs — it is read by the storage sink
   * replay above — and because the probe must run exactly once per session.
   */
  let webglProbeResult: WebGLProbeView | undefined;

  /**
   * The WebGL failure the board is living with right now, or `null` while the
   * capability the boot probe found is the one in force.
   *
   * A SLOT, because the health surface is built before the renderer it asks
   * about: `probeWebGLSupport` holds its startup result and hands the same one to
   * every later caller, so a surface reading it alone would report the capability
   * the machine had at BOOT for the rest of the session — a context taken away
   * ten minutes in, a 2.5D board that never mounted, or a rebuild that failed
   * would all still read as healthy. Filled once the renderer exists, and answers
   * `null` until then.
   */
  let readLiveWebGLFailure: () => string | null = (): string | null => null;

  // The health surface: the five capability probes the vanilla sources
  // performed and reported nowhere, plus the WebGL probe the Three.js renderer
  // introduced. The live storage manager is handed over so its
  // construction-time probe result is read instead of a second write-and-remove
  // round trip being taken.
  //
  // `webglProbe` hands back the ONE probe result taken below rather than taking
  // a second: a second probe would request a second WebGL context. The slot is
  // read at call time and falls through to the module's own probe until the
  // result exists, so a check taken before boot completed still answers.
  const health = createHealthSurface({
    logger,
    metrics,
    storage,

    // THE POINTER FAMILY IS PROBED, not inferred. Derived from whether the input
    // manager happened to be listening, it answered a different question — one
    // about this application's own wiring rather than about what the platform
    // resolves to — and reported a healthy platform as unhealthy for as long as
    // dispatch was suspended.
    pointerProbe: detectPointerEventFamily,
    webglProbe: (): WebGLProbeView => {
      const probed = webglProbeResult ?? probeWebGLSupport();

      // THE LIVE VERDICT. A context that was obtained and then taken away, one
      // whose resources could not be rebuilt after a restoration, a 2.5D board
      // that never mounted, and a number-only board forced in place of one are
      // each a WebGL failure NOW, whatever the boot probe found, and each is the
      // verdict the readiness roll-up has to act on: the number-only board is
      // required for as long as any of them holds.
      const failure = readLiveWebGLFailure();

      return failure === null
        ? probed
        : { supported: false, level: probed.level, failure };
    },
  });

  /**
   * Whether the last restoration attempt failed to rebuild the board.
   *
   * Held so the live verdict above can tell a context that is merely lost from
   * one that came back and could not be rebuilt.
   */
  let contextRebuildFailed = false;

  /**
   * Recomputes the held health report and readiness verdicts.
   *
   * `HealthSurface.report()` and `readiness()` return the report `check()` last
   * produced, so a renderer transition that happens after boot — a fallback, a
   * mode switch, a lost context, a rebuild that failed — left the diagnostics
   * panel and every exported snapshot showing BOOT readiness against a board
   * that was no longer the one drawing. Every such transition calls this.
   *
   * Nothing is probed that was not probed at boot: the WebGL result is the held
   * one plus the live verdict above, and the Web Storage result is the manager's
   * cached state, so this takes no second context and makes no second write.
   *
   * Silent before the boot check, so the six per-check records and gauges are
   * still emitted once, by that call, in composition order.
   *
   * @param reason What changed, carried into the record.
   */
  const refreshHealth = (reason: string): void => {
    if (health.lastReport() === null) {
      return;
    }

    const refreshed = health.check();
    const verdicts = health.readiness();

    logger.debug('Health rechecked.', {
      reason,
      status: refreshed.status,
      renderer: verdicts.renderer,
      requiresNumberOnlyFallback: verdicts.requiresNumberOnlyFallback,
      webglStatus: verdicts.webglStatus,
    });
  };

  // The storage sink now exists. Anything reported before it did is replayed
  // through it in the order it occurred.
  reportStorageFailure = (failure: StorageFailure): void => {
    reporter.onDiagnostic({
      level: 'error',
      source: 'storage',
      message: `Storage ${failure.operation} failed for ${failure.key}.`,
      detail: Object.freeze({
        operation: failure.operation,
        key: failure.key,
        strategy: failure.strategy,
        quota: failure.error.quota,
      }),
      error: failure.error,
    });
  };

  for (const failure of earlyStorageFailures) {
    reportStorageFailure(failure);
  }

  earlyStorageFailures.length = 0;

  logger.info('Run starting.', {
    runId: identity.runId,
    resumed: identity.resumed,
    boardSize: config.boardSize,
  });

  // The hook bus, built HERE rather than inside the engine, because the relic
  // registry needs it and the registry must exist before the run controller
  // loads: a resumed envelope hands its relics back through
  // `RelicRegistryPort.restoreRelics`, and a registry composed after that load
  // would be handed nothing. The engine takes this same instance below, so there
  // is exactly one bus and every registered relic is dispatched to.
  // The two boundary wrappers are injected here: `hook.dispatch` spans each
  // dispatch and `relic.handler` spans each handler invocation, both attributed
  // to the hook. `BoundaryTracing` satisfies `HookDispatchTracing` structurally,
  // so src/engine imports nothing from src/observability.
  // Hoisted ahead of its first use, because the hook bus, the relic registry and
  // the engine all report through ONE sink rather than through three of their
  // own.
  const engineReporter = createEngineSink(reporter, metrics);

  const hooks: HookBus = createHookBus({
    correlationId: readCorrelationId,
    reporter: engineReporter,
    tracing: boundaries,
  });

  // The relic registry: the sixteen-relic catalogue, pickup order, charge
  // accounting and the hook subscriptions that make a held relic fire.
  //
  // AAP 0.6.2.5 and R3. It shipped fully implemented and was constructed
  // NOWHERE, so `RELIC_CATALOGUE` reached no bus and a run could hold no relic
  // whatever the reward screen said. This is the one construction of it.
  // NO `catalogue` IS SUPPLIED. The default is `RELIC_CATALOGUE` used as it
  // stands, already frozen at every level by the module that owns it; supplying
  // it explicitly takes the injected path, which adopts a fresh copy of every
  // declaration and would replace the array the seeded reward snapshots resolve
  // their drawn indices against.
  const registry = new RelicRegistry({
    bus: hooks,
    correlationId: readCorrelationId,
    reporter: engineReporter,
  });

  /**
   * Projects a catalogue relic as a reward card.
   *
   * The hook names are read off the relic's own `hooks` table in
   * `HOOK_NAMES` order, so the badges a card shows are the hooks the relic
   * actually binds and their order does not depend on how the table was
   * written.
   */
  const asRewardOffer = (relic: {
    readonly id: string;
    readonly name: string;
    readonly rarity: string;
    readonly description: string;
    readonly hooks: Readonly<Record<string, unknown>>;
    readonly charges?: number;
  }): RewardOffer => {
    const bound = HOOK_NAMES.filter(
      (name) => relic.hooks[name] !== undefined,
    );

    return Object.freeze({
      id: relic.id,
      name: relic.name,
      rarity: relic.rarity,
      description: relic.description,
      hooks: Object.freeze([...bound]),
      ...(relic.charges === undefined ? {} : { charges: relic.charges }),
    });
  };

  // Assigned below, once the run's seed and cursors are known. Read only when a
  // reward is drawn, which cannot happen before a stage is cleared.
  let streams: RngStreams | null = null;

  // The run: the versioned envelope's load, save and clear, the stage and relic
  // slices of every commit, and stage advancement. Composed before the
  // substreams because it supplies the seed they are built from and the cursors
  // they are resumed at.
  const runSink = createRunSink(reporter);

  /**
   * The substreams in force.
   *
   * Held rather than captured because a new run REPLACES them: they are built
   * from the run's seed, so a run started mid-session must draw from its own
   * sequence and not from wherever the previous run's substreams had reached.
   * Every reader below goes through this holder.
   */
  const streamHolder: { streams: RngStreams } = {
    streams: createRngStreams(
      identity.seed,
      {},
      createRngSink(reporter),
    ),
  };

  /**
   * Replaces the substreams behind the swappable facade, once that facade
   * exists.
   *
   * `run.begin()` publishes a run scope before the facade is built — the facade
   * is built from the loaded run's own seed — so the callback cannot close over
   * it. Left absent until then, when replacing nothing is exactly right.
   */
  let replaceSwappableStreams: ((next: RngStreams) => void) | undefined;

  /**
   * Rotates the one correlation scope every reporting module reads.
   *
   * ONE WRITE, and every observer follows it: the scope itself for the engine,
   * the emitter, the hook bus, the relic registry, the run controller and the
   * run-state store, and `Logger.setCorrelationId` for the logger and for every
   * logger sharing its state — which is what the metrics registry, the tracer
   * and the health surface read theirs from. Records, counters, spans and
   * reports already emitted are not relabelled: they were true when they were
   * written.
   *
   * @param next The identifier the run now in force is keyed under.
   */
  const rotateCorrelation = (next: CorrelationId): void => {
    if (next.length === 0 || next === runCorrelationId) {
      return;
    }

    const previous = runCorrelationId;

    runCorrelationId = next;
    logger.setCorrelationId(next);

    reporter.onCount({
      name: 'observability.correlation.rotated',
      value: 1,
      detail: Object.freeze({ previous, correlationId: next }),
    });
  };

  /**
   * Rebuilds every construct scoped to the run.
   *
   * A new run mints a new seed and a new run identifier, and the substreams are
   * built from that seed. Without this the substreams of the run before it
   * stayed in place and a "new" run replayed the previous sequence, which is
   * the determinism guarantee the seed provides. Invoked before the engine
   * opens a board, so the opening spawns come from the new sequence.
   *
   * The correlation scope is rotated HERE for the same reason and at the same
   * moment: this is the one point before a new run's first emission, so every
   * record, counter, span, hook context and persistence report the new run
   * produces — the opening `stage:start` and `state:commit` included — is
   * attributed to it rather than to the run the page loaded with.
   */
  const adoptRunScope = (scope: RunScope): void => {
    // THE CORRELATION SCOPE, ROTATED FIRST. The controller publishes this scope
    // BEFORE it opens the engine's board, so every report of the new run — the
    // engine's, the bus's, the registry's, the store's, the controller's and
    // every span the tracer opens — carries the new run's identifier from the
    // opening spawns onward. Rotating after the run had opened left the first
    // reports of a second run attributed to the run before it.
    //
    // Derived from the scope the controller published rather than from a later
    // query, so the identifier matches the seed and the run identifier the
    // envelope carries. Idempotent at composition time: the scope published by
    // `begin()` carries the same identity `deriveCorrelationId` was first
    // called with above, so a resumed run keeps the identifier it was stored
    // under and `rotateCorrelation` short-circuits.
    rotateCorrelation(deriveCorrelationId(scope.seed, scope.runId));

    const next = createRngStreams(
      scope.seed,
      scope.cursors,
      createRngSink(reporter),
    );

    streamHolder.streams = next;
    replaceSwappableStreams?.(next);

    reporter.onCount({
      name: 'run.scope.rebuilt',
      value: 1,
      detail: Object.freeze({ runId: scope.runId, seed: scope.seed }),
    });
  };

  const run = new RunController({
    store: new RunStateStore({
      storage,
      config,
      correlationId: readCorrelationId,
      reporter: runSink,
    }),
    identity,
    config,
    stages,
    createToken: createRunToken,
    reporter: runSink,
    correlationId: readCorrelationId,

    // The registry, reached through the port so the controller names no relic
    // type. Every member delegates on each call rather than being captured, so a
    // charge a handler spent and a state slot a handler advanced are read at
    // write time rather than at composition time.
    relics: {
      snapshotRelics: (): readonly PersistedRelic[] => registry.serialize(),
      activateRelic: (relicId): PersistedRelic | null => {
        const taken = registry.pickUp(relicId);

        if (taken === undefined) {
          return null;
        }

        // The entry as the registry now holds it, so the envelope records the
        // budget the registry seeded rather than the catalogue's declaration.
        return registry.serialize().find((entry) => entry.id === relicId) ?? null;
      },
      ownedRelicIds: (): readonly string[] => registry.ownedIds(),
      restoreRelics: (relics): void => {
        registry.restore(relics);
      },
      knows: (relicId): boolean => registry.knows(relicId),

      // THE CONFIRMATION READER. `resolveReward()` appends the entry the pickup
      // produced and then asks this whether the live registry agrees, withdrawing
      // the append where it does not — so the envelope can never carry a relic
      // the bus is not dispatching.
      holdsRelic: (relicId): boolean => registry.has(relicId),

      // The entry-returning pickup, so the persisted record is exactly what the
      // registry accepted rather than one the controller assembled beside it.
      pickUpRelic: (relicId): PersistedRelic | null => {
        if (registry.pickUp(relicId) === undefined) {
          return null;
        }

        return registry.persistedEntry(relicId);
      },
      pickUp: (relicId): unknown => registry.pickUp(relicId),
      activate: (relicId, amount) => registry.activate(relicId, amount),
      persistedEntry: (relicId): PersistedRelic | null =>
        registry.persistedEntry(relicId),
      resolveRelic: (relicId): PersistedRelic | null => {
        const known = registry
          .catalogue()
          .find((relic) => relic.id === relicId);

        if (known === undefined) {
          return null;
        }

        return Object.freeze({
          id: known.id,
          ...(known.charges === undefined ? {} : { charges: known.charges }),
        });
      },
    },

    // The seeded draw. Consumes the run's `relic-draw` and `rarity-weight`
    // substreams, so one seed and one move list yield one offer sequence
    // (AAP V2, Contract 6).
    rewards: {
      draw: ({ count, ownedIds }): readonly RewardOffer[] => {
        if (streams === null) {
          // Unreachable in composition order: a reward follows a cleared stage,
          // which follows the engine, which follows the substreams. Reported
          // rather than raised so a reward can never take down a run.
          reporter.onCount({
            name: 'run.reward.draw_before_streams',
            value: 1,
            detail: Object.freeze({ count }),
          });

          return [];
        }

        return drawRelicOffers({
          pool: registry.catalogue(),
          ownedIds,
          count,
          streams,
        }).map(asRewardOffer);
      },
    },

    onRunScope: adoptRunScope,
  });

  // The authoritative load, and the one that reports: a refused payload, a
  // migrated version and a board-size reconciliation all reach the sink here.
  const runOutcome = run.begin();

  reporter.onCount({
    name: 'run.loaded',
    value: 1,
    detail: Object.freeze({ outcome: runOutcome }),
  });

  // Built from the run rather than from the identity, so the sequence played and
  // the sequence recorded cannot diverge: `seed()` is the seed of the envelope
  // in force, and `cursors()` is where that envelope left each substream. A
  // fresh run yields zeros, so its opening spawns are taken rather than skipped.
  // ONE BACKING INSTANCE, reached two ways. `streamHolder` is the slot
  // `adoptRunScope` replaces when a new run mints a new seed, and the facade
  // below is what the reward draw and the diagnostics surface hold, so neither
  // has to be rebuilt for a run started mid-session to draw from its own
  // sequence. Both are updated by `adoptRunScope` and nowhere else.
  streamHolder.streams = createRngStreams(
    run.seed(),
    run.cursors(),
    createRngSink(reporter),
  );

  const swappableStreams = createSwappableRngStreams(streamHolder.streams);

  // Bound now that the facade exists. `run.begin()` above already published a
  // scope, before there was a facade to replace, which is why the callback
  // reaches it through a slot rather than closing over it.
  replaceSwappableStreams = (next: RngStreams): void => {
    swappableStreams.replace(next);
  };

  streams = swappableStreams;

  const engine = new Engine({
    config,

    // Read through the holder on every draw, so a run started mid-session draws
    // from the substreams that run's seed produced.
    streams: {
      get seed(): string {
        return streamHolder.streams.seed;
      },
      stream: (name) => streamHolder.streams.stream(name),
      snapshotCursors: () => streamHolder.streams.snapshotCursors(),
    },
    storage,

    // The bus the registry is already registered with, in place of the one the
    // engine would have built for itself, so a relic held from a resumed
    // envelope fires from the first dispatch of this engine and every dispatch
    // is spanned.
    hooks,
    correlationId: readCorrelationId,
    reporter: engineReporter,

    // The stage and relic slices of every commit. Read through the controller on
    // each call rather than captured, so a stage that advances and a relic that
    // spends a charge are visible on the next commit.
    stageContext: () => run.stageContext(),
    relicContext: () => run.relicContext(),

    // THE RESOLUTION SPAN IS INJECTED, not wrapped from out here. The turn span
    // opens on `move:before`, which the engine emits from inside `move()`, so a
    // wrapper placed around `move()` would OPEN BEFORE that emission and become
    // the turn's parent — the resolution appearing to contain the turn it is part
    // of, and the turn left open across its own parent's end. Handed to the
    // engine, it runs around the traversal walk alone, which is the one placement
    // that nests correctly.
    tracing: { traceMoveResolution: boundaries.traceMoveResolution },
  });

  // The relic registry is composed ABOVE, before the run controller, because a
  // resumed envelope hands its relics back during `run.begin()` and a registry
  // built here would be handed nothing. The relics an adopted envelope carried
  // are re-hydrated now that the engine's bus has dispatched nothing yet, so a
  // held relic fires from this engine's first dispatch.
  run.restoreHeldRelics();

  // The frame callback is the system's only asynchronous boundary. Its span is
  // opened and closed by the tracer's own lifecycle pair, so a frame that
  // overran the budget is visible as a span and not only as a histogram sample.
  const frameLifecycle = tracer.frameLifecycleHooks();
  const loop = createRenderLoop({
    reporter,
    autoStopWhenIdle: true,
    onFrameBegin: frameLifecycle.onFrameBegin,
    onFrameEnd: frameLifecycle.onFrameEnd,
  });

  // The preference store, composed BEFORE the renderer because the renderer
  // selection reads it: number-only mode is a mode a player may choose as well
  // as the mode a machine without WebGL is served, and the store is where those
  // two are combined into one effective value.
  const preferences = createPreferenceStore({
    reporter: createPreferenceSink(reporter),
  });

  const reflectMotion = (reduced: boolean): void => {
    const written = reflectReducedMotion(
      ownerDocument.documentElement,
      reduced,
    );

    reporter.onCount({
      name: 'ui.reducedMotion.reflect',
      value: 1,
      detail: Object.freeze({ reduced, written }),
    });
  };

  // The reduced-motion preference is pushed into the render layer's store and
  // reflected onto the document element before any renderer is built, so the
  // first frame a renderer draws already honours it rather than animating once
  // and then settling down.
  setReducedMotionOverride(preferences.reducedMotionOverride());
  reflectMotion(queryReducedMotion());

  // The WebGL capability probe. Consulted once, before any renderer is built,
  // and its result pushed into the store as a FORCE rather than compared against
  // at each use: number-only mode then has one effective value, and the settings
  // surface can refuse to turn it off on a machine that cannot draw without it.
  //
  // Called before the readiness below so the render layer's own diagnostic
  // carries the probe. The probe holds its result, so the readiness below reads
  // the same one and the two cannot disagree.
  const support = probeWebGLSupport(reporter);

  // Handed to the health surface, which reads the slot rather than probing again.
  webglProbeResult = support;

  if (!support.supported) {
    preferences.forceNumberOnlyMode(
      `no WebGL context is available (${support.level})`,
    );
  }

  // The parallel accessibility board: the focusable, labelled per-cell
  // counterparts beside the board. It is built here rather than by a renderer,
  // because it is the surface a canvas renderer CANNOT provide — a canvas is one
  // opaque node to assistive technology — and every renderer therefore has to be
  // able to hand it over rather than own it.
  const parallelBoardHost = ownerDocument.querySelector(SELECTORS.boardA11y);
  const parallelBoard = createParallelBoardLayer({
    host: parallelBoardHost,
    document: ownerDocument,
    reporter: createPreferenceSink(reporter),
  });

  const onRendererWork = (): void => {
    loop.invalidate();
  };

  /**
   * Builds the renderer for one mode.
   *
   * Both renderers receive the parallel board's element AND the layer that owns
   * its cells, and each does the opposite thing with them: the 2.5D renderer
   * mounts the layer, because `#board-canvas` is `aria-hidden` and carries no
   * semantics at all, while the number-only renderer takes the layer down,
   * because its own lattice carries `role="grid"` over the same board. Exactly
   * one of the two lattices is exposed, and the hand-over goes through the
   * layer's own api rather than through either renderer emptying an element.
   */
  /**
   * The bounded wait for a lost WebGL context, or `null` when none is running.
   */
  let contextRestoreWait: ReturnType<typeof setTimeout> | null = null;

  /** Ends the bounded wait without acting on it. */
  const cancelContextRestoreWait = (): void => {
    if (contextRestoreWait === null) {
      return;
    }

    clearTimeout(contextRestoreWait);
    contextRestoreWait = null;
  };

  /**
   * Serves the number-only board because the context did not come back.
   *
   * Nothing is done where the context HAS come back, or where the number-only
   * board is already in force, so a loss the browser restored inside the window
   * costs the player nothing at all.
   *
   * The swap itself goes through the preference store rather than being done
   * here: forcing number-only mode is what `applyRenderMode` follows, and that
   * path already destroys the old renderer, mounts the new one, subscribes it and
   * REPLAYS THE LAST COMMIT into it — so the board arrives populated instead of
   * standing empty until the next turn.
   *
   * @param reason Why the wait ended, carried into the record.
   */
  const resolveLostContext = (reason: string): void => {
    if (selection.mode !== 'three' || !readContextLost(renderer)) {
      return;
    }

    reporter.onDiagnostic({
      level: 'error',
      source: 'main',
      message: `The WebGL board is unavailable (${reason}); the number-only ` +
        'board is taking over.',
      detail: Object.freeze({
        reason,
        graceMs: CONTEXT_RESTORE_GRACE_MS,
        webglLevel: support.level,
        correlationId: readCorrelationId(),
      }),
    });

    preferences.forceNumberOnlyMode(
      'the WebGL context was lost and not restored',
    );

    // Announced, because a player who cannot see the board changing renderer is
    // otherwise given no signal that anything happened. A forced number-only
    // fallback interrupts, because the board the player is reading has just been
    // replaced by a different one.
    announcer.announceText(
      'The 3D board is unavailable. The number board is now in use.',
      ASSERTIVE_POLARITY,
    );
  };

  /**
   * Starts the bounded wait after the browser has taken the context away.
   *
   * The renderer has already suspended drawing by the time this runs, and it will
   * resume by itself if the context is restored. This adds the only thing it
   * cannot do: an end to the wait.
   */
  const onContextLost = (): void => {
    reporter.onCount({
      name: 'render.context.lost.observed',
      value: 1,
      detail: Object.freeze({ graceMs: CONTEXT_RESTORE_GRACE_MS }),
    });

    // A fresh loss supersedes the verdict of the previous restoration.
    contextRebuildFailed = false;

    cancelContextRestoreWait();

    contextRestoreWait = setTimeout((): void => {
      contextRestoreWait = null;
      resolveLostContext('the context was not restored');
    }, CONTEXT_RESTORE_GRACE_MS);

    // The board that is drawing has changed state, so the held report is no
    // longer the report of the board in force.
    refreshHealth('a lost WebGL context');
  };

  /**
   * Ends the bounded wait, but ONLY for a restoration that rebuilt the board.
   *
   * A restored context is a new context, and the renderer's rebuild of every
   * resource that context owns can fail. Ending the wait on the restoration
   * alone ended it on a board that never came back: the 2.5D board stayed
   * parked, the number-only fallback was cancelled, and nothing was drawing.
   *
   * @param outcome The renderer's verdict on its own rebuild.
   */
  const onContextRestored = (outcome: ContextRestoreOutcome): void => {
    if (outcome.rebuilt || !outcome.contextLost) {
      contextRebuildFailed = false;
      cancelContextRestoreWait();

      reporter.onCount({
        name: 'render.context.restored.observed',
        value: 1,
        detail: Object.freeze({
          mode: selection.mode,
          rebuilt: outcome.rebuilt,
          attempted: outcome.attempted,
        }),
      });

      refreshHealth('a restored WebGL context');

      return;
    }

    // The rebuild did not complete and the context still reads as lost, which is
    // final: waiting longer cannot rebuild it, so the number-only board takes
    // over now rather than at the deadline.
    contextRebuildFailed = true;

    reporter.onCount({
      name: 'render.context.rebuild.failed',
      value: 1,
      detail: Object.freeze({ mode: selection.mode }),
    });

    cancelContextRestoreWait();
    resolveLostContext('its resources could not be rebuilt');
    refreshHealth('a WebGL context that could not be rebuilt');
  };

  const buildNumberOnly = (): BoardRenderer =>
    createNumberOnlyRenderer({
      host: ownerDocument.querySelector(SELECTORS.boardNumberOnly),
      canvas: ownerDocument.querySelector(SELECTORS.boardCanvas),
      parallelBoard: parallelBoardHost,
      parallelBoardLayer: parallelBoard,
      config,
      ownerDocument,
      superThreshold: config.winValue,
      reporter,
      onWork: onRendererWork,
    });

  const buildRenderer = (mode: BoardRenderMode): BoardRenderer => {
    if (mode === 'three') {
      // GUARDED AT THE FACTORY TOO, not only inside the mount. The mount unwinds
      // its own failures and reports `mounted: false`, which the fallback below
      // acts on; this covers the narrower case of the factory itself raising
      // before a mount is attempted, which would otherwise escape `start()` and
      // take down the whole application — losing the input manager, the screens
      // and the focus manager along with the board.
      try {
        return createThreeRenderer({
          canvas: ownerDocument.querySelector(SELECTORS.boardCanvas),
          numberOnlyHost: ownerDocument.querySelector(SELECTORS.boardNumberOnly),
          parallelBoard: parallelBoardHost,
          parallelBoardLayer: parallelBoard,
          // Handed in so the board is generated at mount rather than deferred to
          // the first commit, which is what makes the board present before the
          // first turn is resolved.
          config,
          ownerDocument,
          reporter,
          onWork: onRendererWork,

          // The bounded restoration window. The renderer parks itself on a loss
          // and rebuilds on a restore; these two callbacks add the end of the
          // wait, which it cannot decide for itself.
          onContextLost,
          onContextRestored,
        });
      } catch (error: unknown) {
        // THE ACTIVE MODE IS MADE AUTHORITATIVE BEFORE THE FALLBACK IS
        // RETURNED. A factory that raised leaves the number-only board drawing,
        // and `selection` is what every later reader consults for the mode that
        // is drawing: the mounted-state guard in `fallBackToNumberOnly` below,
        // the live context-loss reader handed to the health surface, the
        // context-restoration wait, and the settings surface. Leaving
        // `selection.mode` as 'three' described a renderer that does not exist,
        // and the fallback helper then refused to act because the number-only
        // renderer it was meant to install had already mounted.
        //
        // The preference is forced as well as the selection recomputed, so the
        // settings surface reports that the 2.5D choice is no longer available
        // — the same pair `fallBackToNumberOnly` applies for a mount that
        // failed.
        preferences.forceNumberOnlyMode(
          'the 2.5D renderer could not be constructed',
        );
        selection = selectBoardRenderer(support, preferences);

        reporter.onDiagnostic({
          level: 'error',
          source: 'main',
          message:
            'The 2.5D renderer could not be constructed, so the number-only ' +
            'board is drawing instead. Input, the screen flow and focus are ' +
            'unaffected.',
          detail: Object.freeze({ correlationId: readCorrelationId() }),

          // THE TOTAL REDUCTION, shared with src/render/ and with the engine
          // sink above. Reading `name`, `message` or `String(value)` here let a
          // hostile getter or a throwing `toString` raise from inside the catch
          // that exists to contain it, which would take `start()` down with the
          // board. `thrown` carries the value itself for a sink that can keep
          // more of it than the two-field summary does.
          error: describeRenderError(error),
          thrown: error,
        });

        return buildNumberOnly();
      }
    }

    return buildNumberOnly();
  };

  let selection = selectBoardRenderer(support, preferences);
  let renderer = buildRenderer(selection.mode);

  const reportSelection = (): void => {
    reporter.onDiagnostic({
      level: 'info',
      source: 'main',
      message: `Board drawn by the ${selection.mode} renderer.`,
      detail: Object.freeze({
        mode: selection.mode,
        webglFallback: selection.fallback,
        numberOnlyChosen: selection.chosen,
        webglLevel: selection.support.level,
        boardSize: config.boardSize,
        correlationId: readCorrelationId(),
      }),
    });
  };

  /**
   * Falls back to the number-only board when the 2.5D one did not mount.
   *
   * The probe reporting a context available is not the same as a context being
   * acquired: a driver can refuse the second one, and a canvas can be absent
   * from the markup entirely. The fallback is recorded in the store as a force,
   * so the settings surface reflects that the choice is no longer available.
   *
   * @returns Whether a fallback was applied.
   */
  const fallBackToNumberOnly = (reason: string): boolean => {
    if (selection.mode !== 'three' || renderer.mounted) {
      return false;
    }

    renderer.destroy();
    preferences.forceNumberOnlyMode(reason);
    selection = selectBoardRenderer(support, preferences);
    renderer = buildRenderer(selection.mode);

    return true;
  };

  fallBackToNumberOnly('the WebGL board could not be mounted');
  reportSelection();

  // The health surface can now ask the board itself, which is the only holder of
  // the live answer. Read through `selection` and `renderer` rather than captured
  // from them, so a renderer swapped mid-session is the one consulted.
  //
  // Four live states, in the order a reader needs them: a context taken away, a
  // restored context whose resources could not be rebuilt, a 2.5D board that is
  // selected but not mounted, and a number-only board FORCED in place of one. A
  // number-only board the player chose reports nothing, because that mode is a
  // feature rather than a failure.
  readLiveWebGLFailure = (): string | null => {
    if (selection.mode === 'three') {
      if (readContextLost(renderer)) {
        return contextRebuildFailed
          ? CONTEXT_UNREBUILT_FAILURE
          : CONTEXT_LOST_FAILURE;
      }

      return renderer.mounted ? null : RENDERER_UNMOUNTED_FAILURE;
    }

    return selection.fallback ? FORCED_FALLBACK_FAILURE : null;
  };

  // RUN ONCE AT BOOT, rather than left until something reads the panel: the
  // per-check log records and the six status gauges ARE the delivery of Rule 3's
  // health capability, and a check nobody ran reports nothing. `readiness()`
  // below reads the report this call leaves, so it probes nothing further.
  const bootHealth = health.check();

  logger.info('Health checked.', {
    status: bootHealth.status,
    passed: bootHealth.counts.pass,
    failed: bootHealth.counts.fail,
    notApplicable: bootHealth.counts['not-applicable'],
  });

  // The readiness verdicts the health surface derives from its own webgl and
  // storage checks: whether a WebGL board may be mounted at all, and whether
  // the run persists or is ephemeral. Logged once, here, so the running page
  // states the two decisions rather than leaving them implicit in the renderer
  // it happens to have selected.
  const readiness = health.readiness();

  logger.info('Readiness resolved.', {
    ready: readiness.ready,
    renderer: readiness.renderer,
    mayMountWebGLRenderer: readiness.mayMountWebGLRenderer,
    requiresNumberOnlyFallback: readiness.requiresNumberOnlyFallback,
    webglLevel: readiness.webglLevel,
    webglStatus: readiness.webglStatus,
    storage: readiness.storage,
    storageStrategy: readiness.storageStrategy,
    storageStatus: readiness.storageStatus,
    healthStatus: readiness.healthStatus,
    selected: selection.mode,
  });

  // COUNTED AS WELL AS LOGGED. A verdict that is only logged is a verdict a
  // dashboard cannot see was acted on: the counter is what puts boot readiness on
  // the metrics surface beside the renderer it selected, and the detail carries
  // the two decisions themselves rather than only their roll-up.
  reporter.onCount({
    name: 'health.readiness',
    value: 1,
    detail: Object.freeze({
      ready: readiness.ready,
      renderer: readiness.renderer,
      mayMountWebGLRenderer: readiness.mayMountWebGLRenderer,
      requiresNumberOnlyFallback: readiness.requiresNumberOnlyFallback,
      storage: readiness.storage,
      selected: selection.mode,
    }),
  });

  // The turn and stage spans, subscribed to the emitter through `on` alone.
  const stopEngineTracing: EngineTracingSubscription = attachEngineTracing(
    engine.events,
    tracer,
  );

  // Subscribed through the traced emitter, so every commit the renderer
  // reconciles is one `render.commit` span inside the turn span that produced
  // it.
  const renderEvents = createTracedRenderEvents(
    engine.events,
    boundaries.traceRenderCommit,
    stopEngineTracing.currentTurnSpan,
  );

  let stopRendering = renderer.subscribe(renderEvents);

  // MOVED TO THE END OF THE ORDER, after the renderer's own commit listener.
  // The tracing subscription's `state:commit` listener closes the turn span, and
  // listeners run in registration order, so the turn used to be closed before
  // the renderer's `render.commit` span was opened.
  stopEngineTracing.reattachCommitClosing();
  const frameSubscription = loop.addFrameCallback((context): boolean => {
    // INTER-FRAME CADENCE, UNDER ITS OWN NAME. `FrameContext.delta` is the gap
    // since the previous frame, clamped at `maxDelta` and zero on the first
    // frame; it is not how long this callback occupied the frame. It used to be
    // written to the canonical frame metric, which made that metric read as
    // renderer occupancy while carrying cadence. Occupancy is measured by the
    // loop and recorded once through the tracer's frame hooks above, and
    // cadence is kept here as a separately named series so neither is lost.
    reporter.onTiming({
      name: FRAME_INTERVAL_TIMING,
      durationMs: context.delta,
    });

    return renderer.frame(context);
  });

  /**
   * The last state the engine committed.
   *
   * Retained so a renderer built mid-run is given the board at once rather than
   * standing empty until the next turn. `state:commit` carries the live grid,
   * which is unchanged between turns, so replaying the last commit into a fresh
   * renderer is a full reconciliation and not a stale one.
   */
  let lastCommit: StateCommitEvent | null = null;
  const stopCommitCapture = engine.events.on(
    'state:commit',
    (commit): void => {
      lastCommit = commit;
    },
  );

  let switchingRenderer = false;

  /**
   * Brings the renderer in force into line with the effective preference.
   *
   * Called whenever `numberOnlyMode` changes, which is how the accessible
   * number-only mode is reached and left without a reload. Re-entry is guarded
   * because the fallback path writes a preference of its own.
   */
  const applyRenderMode = (): void => {
    if (switchingRenderer) {
      return;
    }

    const next = selectBoardRenderer(support, preferences);

    if (next.mode === selection.mode) {
      selection = next;

      return;
    }

    switchingRenderer = true;

    try {
      stopRendering();
      renderer.destroy();
      selection = next;
      renderer = buildRenderer(next.mode);
      fallBackToNumberOnly('the WebGL board could not be remounted');
      stopRendering = renderer.subscribe(renderEvents);

      // The new renderer's commit listener is now the last registration, so the
      // turn-closing listener is moved after it again.
      stopEngineTracing.reattachCommitClosing();

      if (lastCommit !== null) {
        renderer.render(lastCommit);
      }

      onRendererWork();
      reportSelection();

      // The board in force has changed, so the held health report is no longer
      // the report of the renderer actually drawing.
      refreshHealth(`a switch to the ${next.mode} board`);
    } finally {
      switchingRenderer = false;
    }
  };

  // The HUD is mounted BESIDE the renderer, not inside it. The score outlets,
  // the rising score delta and the terminal overlay have exactly one owner, and
  // that owner subscribes to `state:commit` directly, so selecting a different
  // board renderer changes what draws the board and nothing else.
  /**
   * Names a relic, falling back to its identifier.
   *
   * The catalogue is the authority, so the tray and every announcement carry the
   * relic's real name rather than the identifier the input layer published.
   * Declared HERE, above the first consumer, rather than beside the reward
   * binding that also uses it.
   */
  /**
   * Reads one catalogue definition by identifier.
   *
   * @param relicId Identifier to resolve.
   * @returns The definition, or `undefined` where the catalogue carries none.
   */
  const relicDefinition = (
    relicId: string,
  ): { name: string; rarity: string; charges?: number } | undefined =>
    registry.catalogue().find((relic) => relic.id === relicId);

  const relicName = (relicId: string): string =>
    relicDefinition(relicId)?.name ?? relicId;

  const hud = createHud({
    scoreContainer: ownerDocument.querySelector<HTMLElement>(SELECTORS.score),
    bestContainer: ownerDocument.querySelector<HTMLElement>(SELECTORS.best),
    messageContainer: ownerDocument.querySelector(SELECTORS.message),

    // The in-run status outlets. index.html has declared all three since the
    // markup was written and nothing filled them, so a run reported its stage,
    // its goal progress and the relics it held nowhere on screen — the reward the
    // player had just chosen included.
    hudContainer: ownerDocument.querySelector(SELECTORS.hudGroup),
    stageContainer: ownerDocument.querySelector(SELECTORS.hudStage),
    relicTrayContainer: ownerDocument.querySelector(SELECTORS.relicTray),

    // The catalogue is the only place a display name exists, and the commit's
    // relic slice carries identifiers alone, so the tray reads the name through
    // here rather than showing the raw identifier.
    relicName: (relicId): string => relicName(relicId),

    // The rarity tier, from the same catalogue definition and for the same
    // reason: style/_hud.scss declares an accent rule per rarity tier and the
    // reward card states the tier on the way in, so without this the tray was
    // the one surface that named neither the tier visually nor to a screen
    // reader. Resolved on each call, so a tray rebuilt for a relic taken later
    // in the run carries its tier too.
    relicRarity: (relicId): string => relicDefinition(relicId)?.rarity ?? '',
    document: ownerDocument,
    reporter: createPreferenceSink(reporter),
  });
  const stopHud = hud.subscribe(engine.events);

  // The ONE announcer for the page, and the translator that feeds it.
  //
  // `createLiveRegionAnnouncer` and its whole `Announcement` vocabulary shipped
  // fully built and were never constructed, so `#live-region` stayed empty for
  // the life of a run and a screen-reader user was told nothing about a move, a
  // merge, a spawn or a verdict. One announcer rather than several, because
  // three live regions announcing at once race and suppress one another — which
  // is why the score outlets give up their own `role="status"` in index.html and
  // become labelled values this narrates instead.
  const announcer: LiveRegionAnnouncer = createLiveRegionAnnouncer({
    selector: SELECTORS.liveRegion,
    root: ownerDocument,
    reporter: createPreferenceSink(reporter),
    describeTheme: (theme): string => describeThemeName(theme),
  });
  const engineAnnouncer: EngineAnnouncer = createEngineAnnouncer({
    announcer,
    reporter: createPreferenceSink(reporter),
  });
  const stopAnnouncer = engineAnnouncer.subscribe(engine.events);

  // Preference changes are announced by the announcer itself, from the store's
  // own change notifications, so no second subscriber narrates them.
  const stopAnnouncedPreferences = announcer.observePreferences(preferences);

  // Follows the store rather than the setting, so an operating-system change
  // under the `'system'` setting is reflected too. Reflecting is the ONLY
  // thing done here: the reflected attribute is the single channel the style
  // layer and the on-screen controls both read, so pushing the value into the
  // controls separately would give them a second, competing source.
  const stopMotion = subscribeReducedMotion((reduced): void => {
    reflectMotion(reduced);
  });

  const stopPreferences = preferences.subscribe((_snapshot, changed): void => {
    if (changed.includes('numberOnlyMode')) {
      // The board renderer follows the effective value, so number-only mode is
      // reached and left without a reload — which is what makes it a mode
      // rather than a build-time choice.
      applyRenderMode();
    }

    if (!changed.includes('reducedMotion')) {
      return;
    }

    // Pushed into the store, which dispatches to every animating member and
    // back through the subscription above; an explicit `reduce` or `allow`
    // therefore reaches the style layer and the controls as well as the canvas.
    setReducedMotionOverride(preferences.reducedMotionOverride());
    reflectMotion(preferences.isReducedMotion());
  });

  // The screen router: the ONE owner of the effective input context, and the
  // owner of the settings dialog's shown state. It is built BEFORE the input
  // manager and the control layer because both take `router.context` as their
  // own context source — which is what makes the keyboard, the gesture path and
  // the generated controls read one function rather than three.
  //
  // The settings panel is filled in after the input manager exists, because its
  // rebinding rows own the keymap; the router only ever reaches it through the
  // two hooks below, which run when the dialog is opened and closed.
  let settings: SettingsPanel | null = null;
  const settingsPanelHost = ownerDocument.querySelector<HTMLElement>(
    SELECTORS.settingsPanel,
  );

  // ONE focus manager for the page, shared by the router and the settings
  // dialog, so both push onto and pop from a single trap stack.
  const focusManager: FocusManager = createFocusManager({
    reporter: createPreferenceSink(reporter),
    isReducedMotion: (): boolean => preferences.isReducedMotion(),
  });

  const router = createScreenRouter({
    document: ownerDocument,
    reporter: createPreferenceSink(reporter),
    focus: focusManager,
    settingsPanel: settingsPanelHost,
    settingsTrigger: ownerDocument.querySelector(SELECTORS.settingsButton),
    gameRegion: ownerDocument.querySelector(SELECTORS.gameRegion),
    onSettingsOpen: (): void => {
      settings?.open();
    },
    onSettingsClose: (): void => {
      settings?.close();
    },

    // The reward screen. The router owns when it is shown and what it looks
    // like; the run controller owns whether a choice is legal and what it does.
    // A card press arrives here as an identifier and is handed straight into the
    // controller's transaction, which validates it against the offer that is
    // actually standing.
    rewardScreen: ownerDocument.querySelector(SELECTORS.rewardScreen),

    // Resolved per open, because the parallel board's tab stop roves: the cell
    // that can take focus is whichever one carries `tabindex="0"` at the moment
    // the screen goes up.
    rewardRestoreFocusTo: (): Element | null =>
      ownerDocument.querySelector(SELECTORS.boardTabStop),
    onRewardSelect: (relicId): void => {
      takeReward(relicId);
    },
  });

  /**
   * Takes one offered relic on, and is the ONE path that does.
   *
   * A card press from the reward screen and a call on the application's own
   * reward surface both arrive here, so the validation, the reporting, the
   * announcement and the re-show of a refused offer cannot differ between them.
   * The controller owns whether the choice is legal; this owns what the page does
   * about the answer.
   *
   * @param relicId Identifier pressed or supplied.
   * @returns The controller's own selection outcome.
   */
  function takeReward(relicId: string): RewardSelection {
    const selection = run.selectReward(relicId, engine);

    // COUNTED BY OUTCOME, in two series rather than one. A refusal and an
    // acceptance answer different questions — how often a run gained a relic,
    // and how often a press was turned away — and a single series with the
    // outcome in its detail cannot be summed for either.
    reporter.onCount({
      name:
        selection.outcome === 'accepted'
          ? 'run.rewardTaken'
          : 'run.rewardRefused',
      value: 1,
      detail: Object.freeze({
        outcome: selection.outcome,
        stageIndex: selection.stageIndex,
      }),
    });

    if (selection.outcome !== 'accepted') {
      // A refused press leaves the offer standing, so the screen goes back up
      // carrying the same three cards rather than the run stalling with no
      // screen and no way to choose.
      showPendingReward();

      return selection;
    }

    // THE STRUCTURED ANNOUNCEMENT, not free text. src/ui/a11y/live-region.ts
    // models a relic acquisition as its own kind, composes it as "Relic
    // acquired: name, rarity. N charges.", and holds it in the queue at the
    // priority a pickup deserves — free text is discarded before it is. Passing
    // the three fields lets that module do the composing, which is why the copy
    // lives there and not here.
    const taken = relicDefinition(relicId);

    announcer.announce({
      kind: 'relicAcquired',
      name: taken?.name ?? relicId,
      rarity: taken?.rarity ?? '',
      charges: taken?.charges,
    });

    announcer.announceText(`Stage ${selection.stageIndex + 1}.`);

    return selection;
  }

  /**
   * The offer whose cards were last read into the live region, as their joined
   * identifiers, or the empty string while none stands.
   *
   * Declared beside its only reader so the once-per-offer gate below is visible
   * from the announcement it guards.
   */
  let announcedOffer = '';

  /**
   * Puts the standing offer on screen, or takes the screen down when none
   * stands.
   *
   * Called after every commit rather than only on the commit that drew the
   * offer, so a reward that survived a reload is shown on the first commit of the
   * resumed run and the screen is never left up over a run that has moved on.
   *
   * @returns Whether the screen is showing after the call.
   */
  const showPendingReward = (): boolean => {
    if (!run.isRewardPending()) {
      router.hideReward();
      announcedOffer = '';

      return false;
    }

    const cards: readonly RewardCard[] = run.currentOffer();

    // ANNOUNCED ONCE PER OFFER, AND NOT ONLY WHEN THE SCREEN WENT UP. The live
    // region is the accessible channel in its own right, so an offer a
    // screen-reader user has to choose from is spoken even where the reward
    // screen's mount point is missing from the page. Keyed on the offer's own
    // identifiers, because this runs after EVERY commit and a standing offer
    // must not be re-read on every move.
    const signature = cards.map((card): string => card.id).join(',');

    if (signature !== announcedOffer) {
      announcedOffer = signature;

      announcer.announceText(
        `Stage cleared. Choose a relic: ${cards
          .map((card, index): string => `${index + 1}, ${card.name}`)
          .join('; ')}.`,
      );
    }

    if (router.isRewardOpen()) {
      return true;
    }

    return router.showReward(cards);
  };

  // The control layer, filled in immediately below. Declared first because the
  // input manager announces every rebind to it, and the layer takes the manager
  // as its own emitter, so exactly one of the two can be constructed first.
  let controlLayer: { refresh(): void } | null = null;

  /**
   * Reads the persisted binding table, or the defaults where none is stored.
   *
   * @returns The table this session starts on.
   */
  const readStoredKeymap = (): Keymap => {
    const stored = storage.readJson(KEYMAP_KEY);

    if (stored === null || stored === undefined) {
      return DEFAULT_KEY_BINDINGS;
    }

    return deserializeKeymap(stored, createInputSink(reporter));
  };

  const input = createInputManager({
    ownerDocument,

    // The router's context, not the document's: it composes the document rule
    // with the two pieces of state only it knows — the dialog it owns and the
    // terminal turn the engine reported.
    context: router.context,

    // A remap made in an earlier session, validated by `deserializeKeymap`,
    // which answers with the defaults for a payload it cannot read rather than
    // throwing. An ABSENT key is not an unreadable payload — it is the first run
    // — so it is not put through the guard at all, and a fresh load reports
    // nothing.
    keymap: readStoredKeymap(),

    // The durable half of the manager's single rebind api. Failure is reported
    // by the storage layer and counted by the manager; it never fails the
    // rebind, which is already live in memory.
    persistKeymap: (next: Keymap): boolean =>
      storage.writeJson(KEYMAP_KEY, serializeKeymap(next)),

    // The ONE follower of a rebind: the generated controls carry each action's
    // key in their accessible names, so they re-read the table the manager now
    // holds. Nothing else needs telling — the manager's own keydown listener
    // reads that table directly (N2).
    onKeymapChange: (): void => {
      controlLayer?.refresh();
    },

    // THE TRACER IS SUPPLIED HERE AND NOWHERE ELSE in the input layer: the
    // manager is the one place a dispatch is walked, and it opens the
    // `input.dispatch` span around that whole walk, naming the event in the
    // span's `action` attribute. The on-screen controls and the touch layer
    // dispatch THROUGH this manager, so that span already covers them and a
    // second sink carrying a tracer would nest a duplicate.
    reporter: createInputSink(reporter, tracer),
  });

  // `reducedMotion` is deliberately NOT supplied: supplying it pins a value
  // that takes precedence over the reflected attribute for the rest of the
  // mount, which would make the attribute — the one source the style layer also
  // reads — unable to move these controls. The attribute is written above,
  // before this mount, so it is already correct here, and the controls observe
  // it for every later change.
  const controls = mountOnScreenControls({
    host: input,
    ownerDocument,
    context: router.context,

    // `#settings-button` joins the three legacy controls here rather than being
    // bound separately, so every markup control has exactly one binding owner.
    markupControls: MARKUP_CONTROLS,
    reporter: createInputSink(reporter),
  });

  controlLayer = controls;

  // The dialog owns its own containment and its own body; the router owns when
  // it is shown. The keymap arrives as a value and leaves through
  // `onKeymapChange`: src/ui/a11y/settings.ts holds no keymap, so the input
  // manager stays its owner and the control layer follows every rebind.
  // The audio layer (A5): synthesised through the Web Audio API, with no binary
  // asset.
  //
  // `preferences` IS supplied, which makes the store the single owner of mute
  // and volume: the engine takes both from it, follows it for the rest of its
  // life through its own subscription, and refuses `setMuted`/`setVolume` so a
  // second writer cannot exist. The settings dialog therefore writes only the
  // store and pushes nothing into the engine, which is the one application-level
  // subscriber the audio effect is applied by (N1). `muted` and `volume` seeds
  // are omitted because a supplied store makes them ignored.
  //
  // Where no AudioContext constructor exists the engine reports itself
  // unavailable and every member stays safe to call. The dialog states that in
  // real text.
  const soundEngine: SoundEngine = createSoundEngine({
    reporter: createSoundSink(reporter),
    metrics: createSoundMetrics(reporter),
    preferences,
    unlockTargets: [ownerDocument],
  });

  soundEngine.subscribe(engine.events);

  settings = createSettingsPanel({
    host: settingsPanelHost,
    hostSelector: SELECTORS.settingsPanel,
    preferences,
    focusManager,
    soundEngine,
    // The manager owns the table; the dialog reads it and asks for a rebind
    // through the one api that validates, applies, persists and announces it.
    keymapOwner: input,

    // The router holds the trap on this container: it knows the trigger to
    // restore focus to and the game region to make inert. Two traps on one
    // container is what this turns off (N7).
    trapFocus: false,
    input,
    suspendInput: (): void => {
      input.suspend();
    },
    resumeInput: (): void => {
      input.resume();
    },
    announcer,
    document: ownerDocument,
    reporter: createPreferenceSink(reporter),
  });

  // Subscribes the dialog actions and pushes the effective context into the
  // controls, which is what makes a control whose action is inactive leave both
  // the accessibility tree and the tab order.
  router.attach({ input, controls });

  const stopRouter = router.subscribe(engine.events);

  /**
   * Feeds the registry's CANONICAL metric families.
   *
   * The generic sink routes every reported count into a counter named after the
   * report, which is enough to see that something happened. It is NOT enough to
   * populate `game2048_turns_total`, `game2048_merges_total`,
   * `game2048_spawns_total`, `game2048_engine_events_total{event}` or
   * `game2048_frames_rendered_total` — the families the registry declares with
   * real help text, and the only names a dashboard or an alert would ever be
   * keyed to. Those have purpose-built recorders, and without calling them every
   * one of those series reads a flat zero forever while the real numbers sit in
   * counters no dashboard knows the names of.
   *
   * `recordEngineEvent` also reads a spawn's `position`, which is how the
   * registry separates a spawn that inserted a tile from a spawn attempt on a
   * full board — a distinction the generic counter cannot express.
   */
  const stopEventMetrics: (() => void)[] = ENGINE_EVENT_NAMES.map((name) =>
    engine.events.on(name, (payload): void => {
      metrics.recordEngineEvent(
        name,
        // Only `tile:spawn` carries a position, and the recorder reads the
        // member structurally, so every other payload passes through as the
        // no-detail case.
        name === 'tile:spawn' ? (payload as SpawnDetail) : undefined,
      );
    }),
  );

  // The diagnostics surface: this build's stand-in for the metrics endpoint
  // Rule 3 requires, since a static bundle has no server to serve one from and
  // no port for an orchestrator to poll (AAP 0.7.2.4).
  //
  // Without this the registry would be write-only — every counter moving and
  // nobody able to read one — which is the state the review found.
  const diagnostics = createDiagnosticsOverlay({
    metrics,
    logger,
    selector: SELECTORS.diagnostics,
    document: ownerDocument,

    // The one health surface, handed over WHOLE rather than as a boolean
    // projection of it: the overlay reads its probe views and its report, so the
    // panel and the exported snapshot carry the three-state status, the
    // reused-versus-added provenance, the per-check gauges and the readiness
    // verdicts that a `{name, healthy}` list threw away.
    health,

    // The one tracer, so the trace panel shows the frame statistics and the
    // span records of the spans the running application actually opened.
    tracer,

    // Pull integration: the bus keeps its per-hook counts and the registry only
    // has them if something asks. This asks, before every snapshot.
    hookCounts: (): ReturnType<typeof engine.hooks.metrics> =>
      engine.hooks.metrics(),
  });

  /**
   * Run persistence, attached LAST among the commit subscribers.
   *
   * A stage whose goal has been met is resolved from inside the commit handler,
   * and resolving it commits again. Every commit subscriber registered after
   * this one would therefore see the stage-end commit BEFORE the commit that
   * triggered it, and a view that reconciles from the last commit it received
   * would settle on the older state. Registering last leaves every view already
   * up to date when the second commit reaches it.
   */
  const stopRunPersistence = run.observe(engine, () =>
    streamHolder.streams.snapshotCursors(),
  );

  // The reward screen follows the controller, and is subscribed AFTER
  // `run.observe` so this handler runs on the commit the controller has already
  // drawn the offer on. Reading `isRewardPending()` rather than the commit's own
  // members keeps the controller the single authority on whether a choice is
  // owed: the screen is a view of that state and never a second copy of it.
  const stopRewardScreen = engine.events.on('state:commit', (): void => {
    showPendingReward();
  });

  /**
   * Discards the run in force and starts a fresh one.
   *
   * THE ORDER IS THE CONTRACT, and every step of it replaces rather than
   * reuses:
   *   1. The seed is decided FIRST, because the substreams are built from it and
   *      the board is seeded from the substreams. Deciding it later would seed
   *      the opening tiles from the run that just ended.
   *   2. The reward screen comes down, so a fresh run cannot be reached with the
   *      previous run's offer still on screen.
   *   3. The registry is cleared, so no relic is carried across and pickup order
   *      restarts at zero.
   *   4. The substreams are REPLACED, at cursor zero, from the new seed. This is
   *      what closes the determinism hole: without it a second run played in one
   *      page load continues the first run's sequence.
   *   5. `run.startRun` clears the stored envelope, assembles a fresh one with a
   *      new run identifier at stage 0, and calls `engine.setup()`, whose commit
   *      persists it.
   *   6. The correlation scope every observer reads is rotated to the one
   *      derived from the new run, so later records, counters, spans, health
   *      reports, hook contexts and persistence reports are attributed to the
   *      run that emitted them rather than to the run this page loaded with.
   *      Rotated by `adoptRunScope`, which step 5 publishes to BEFORE the board
   *      opens, so the new run's FIRST emission already carries it.
   *
   * @param seed Seed to play. Originated when absent.
   * @returns The seed the new run is played under.
   */
  const startNewRun = (seed?: string): string => {
    const nextSeed =
      seed === undefined ? originateRunSeed() : normalizeEnteredSeed(seed);

    router.hideReward();
    registry.clear();

    // The board snapshot goes too. `Engine.restart()` cleared `gameState` and
    // this path replaces that call, so without it a fresh run would leave the
    // ended run's board readable under the frozen key until the first commit
    // overwrote it.
    storage.clearGameState();

    // The substreams AND the correlation scope are replaced by `adoptRunScope`,
    // which `run.startRun` publishes to BEFORE it opens the board — so the
    // opening spawns are drawn from the new seed rather than from wherever the
    // ended run had reached, and the new run's first reports already carry the
    // new run's identifier. Doing either here as well would build the same
    // instance twice and would rotate after the emissions it is meant to label.
    run.startRun(engine, { seed: nextSeed });

    logger.info('A new run started.', {
      runId: run.runId(),
      seedProvided: seed !== undefined,
      stageIndex: run.state().stageIndex,
    });

    reporter.onCount({
      name: 'run.started',
      value: 1,
      detail: Object.freeze({ seedProvided: seed !== undefined }),
    });

    return run.seed();
  };

  // The three subscriptions js/game_manager.js L9-L11 installed, by the
  // same three event names.
  //
  // NONE OF THE SIX HANDLERS BELOW OPENS AN `input.dispatch` SPAN OF ITS OWN.
  // The input manager opens exactly one around its whole listener walk, through
  // the `startSpan` its sink carries, and every handler here runs inside that
  // span — so it is the parent of every span the turn opens, it names the event
  // in its `action` attribute, and it covers the five events dispatched to
  // subscribers outside this block too. A wrapper here would nest a second span
  // of the same name inside it and count every input twice.
  const stopMove = input.on('move', (direction): void => {
    // `'failed'` UNTIL THE CALL RETURNS. An attempt that throws leaves the turn
    // span open with no outcome at all, and the `finally` below is the only
    // place that still runs; the default therefore names the path the attempt
    // actually took rather than the one an unset value would suggest.
    let resolution: FinalMoveResolution = 'failed';

    try {
      // THE STRUCTURED OUTCOME, not the boolean. `move()` returns `false` for
      // three different turns — one refused because the game is over, one a
      // listener or an `onBeforeMove` handler withdrew, and one the resolver
      // found changed nothing — so settling on the boolean labelled a withdrawn
      // move as an idle one and could never report a blocked or a failed
      // attempt at all.
      resolution = engine.attemptMove(direction).resolution;
    } finally {
      // An attempt that moved nothing emits no `move:after`, so nothing an event
      // listener sees can close the turn span it opened; the caller holding the
      // outcome closes it. A committed turn has already closed its own span and
      // a blocked move opened none, so both are no-ops here.
      //
      // SETTLED INSIDE THE INPUT SPAN, which is still open for the length of
      // this listener: settling after it had ended left the turn span open
      // across its own parent's end, which the tracer unwinds as an
      // out-of-order end and then reports again for every attribute and for the
      // second end that arrives on the closed span.
      stopEngineTracing.settleMove({ resolution });
    }
  });

  // `restart` STARTS A NEW RUN rather than only reseeding the board. The vanilla
  // control reset a board because a board was all there was; a run carries a
  // seed, a stage, a relic set and an identity, and leaving those in place would
  // make "New Game" continue the run it claims to end — and would have the new
  // board draw from the ended run's cursor position.
  const stopRestart = input.on('restart', (): void => {
    // THROUGH `startNewRun`, not straight to the engine. A bare
    // `engine.restart()` left the envelope, the seed, the substreams, the relics
    // and the correlation identifier of the run being abandoned in place.
    startNewRun();
  });
  const stopContinue = input.on('keepPlaying', (): void => {
    engine.continuePlaying();
  });

  // The reward screen's selection. The index is the card the player activated,
  // resolved against the offer the CONTROLLER is standing on — the same set the
  // screen is showing — so an index outside it selects nothing. The press then
  // goes through `takeReward`, which is the one path a relic is taken on by, so a
  // keyboard activation and a card press cannot differ.
  const stopSelectReward = input.on('selectReward', (index): void => {
    const chosen = run.currentOffer()[index];

    if (chosen === undefined) {
      return;
    }

    takeReward(chosen.id);
  });

  // `activateRelic` WAS EMITTED BY EVERY INPUT SURFACE AND SUBSCRIBED TO BY
  // NOTHING, so a press reached the event bus and stopped there and no charge
  // was ever spent by a player. This is the subscription. The index names a slot
  // of the HUD's relic tray, which is rendered in pickup order, so it resolves
  // against the relics held directly.
  //
  // The deduction is the bus's, made through `HookBus.consumeCharge`, so a
  // manual activation and a relic handler's own request spend from ONE pool. An
  // index naming no held relic, and a relic whose budget is already spent, are
  // both reported and change nothing.
  //
  // THROUGH THE CONTROLLER, so the budget that remains is WRITTEN. An activation
  // is not a move, so no commit follows it on its own; without the write a
  // reload resumed on a budget that had never fallen.
  const stopActivateRelic = input.on('activateRelic', (index): void => {
    const held = registry.ownedIds()[index];

    if (held === undefined) {
      reporter.onCount({
        name: 'relics.activation.refused',
        value: 1,
        detail: Object.freeze({ index, relicId: null, remaining: null }),
      });

      return;
    }

    const activation = run.activateRelic(
      engine,
      () => streamHolder.streams.snapshotCursors(),
      held,
    );
    const remaining = activation.remaining ?? null;
    const consumed = activation.consumed;

    reporter.onCount({
      name: consumed > 0 ? 'relics.activated' : 'relics.activation.refused',
      value: 1,
      detail: Object.freeze({
        index,
        relicId: held,
        remaining,
        persisted: activation.persisted,
      }),
    });

    if (consumed > 0) {
      // THE PRESENTATION STATE IS PUBLISHED, not left until the next commit. A
      // manual activation spends a charge BETWEEN turns: the registry's budget
      // and the persisted envelope both moved, and the tray — which is a
      // projection of the commit's relic slice — went on showing the count the
      // last commit carried until the player made a move. Republished here, from
      // the last commit with the relic slice re-read through the controller, so
      // the tray and the announcement below describe the same moment.
      //
      // THE HUD ALONE, not a re-emitted commit. Re-emitting `state:commit`
      // through the engine would reach both renderers as a fresh turn and replay
      // the previous turn's move, spawn and merge tweens; an activation changes
      // charges, not the board, so the board must not be re-planned.
      if (lastCommit !== null) {
        hud.render({ ...lastCommit, relics: run.relicContext() });
      }

      // Announced through the live region as well, because a charge count is a
      // state change a player who cannot see the tray still has to perceive.
      announcer.announceText(
        `Relic activated. ${String(remaining ?? 0)} charges remaining.`,
      );
    }
  });

  // `startRun` had no subscriber either: the run-start screen's own control
  // emitted it and nothing acted on it. It starts a run through the composed
  // path, so the seed, the substreams, the relics, the envelope and the
  // correlation identifier are all replaced together.
  const stopStartRun = input.on('startRun', (): void => {
    startNewRun();
  });

  loop.start();

  // THE BOARD THE LOAD RESOLVED, through the controller so the three cases are
  // decided in one place: an adopted envelope opens on its reconciled board, an
  // envelope read and refused opens fresh, and no envelope at all falls back to
  // the engine's own legacy read so a save written before the upgrade still
  // loads. A bare `engine.setup()` took the legacy read in every case, so the
  // board played and the metadata describing it could come from two runs.
  run.openEngineBoard(engine);

  // The diagnostics surface's runtime opt-in, DEFAULT OFF: it mounts and opens
  // only for a session carrying `?diagnostics` or `#diagnostics`, and every
  // other session — the recorded-gameplay run of requirement R11 included —
  // leaves it dormant. `isDiagnosticsRequested` of
  // src/observability/diagnostics-overlay.ts is the single declaration of the
  // flag. Decision DL-DIAG-01.
  if (isDiagnosticsRequested()) {
    diagnostics.mount();
    diagnostics.open();
  }

  return Object.freeze({
    engine,
    config,
    streams,

    // A getter, because a preference change swaps the renderer: a value
    // captured here would report the mode that was in force at boot.
    get renderer(): BoardRenderSelection {
      return selection;
    },

    hud,
    preferences,
    soundEngine,
    diagnostics,
    logger,
    metrics,
    tracer,
    health,
    relics: registry,
    run,

    // Expressed over the run controller, which owns the immutable active offer
    // and the single-use validated selection, so this surface adds a reachable
    // shape and no second authority.
    rewards: Object.freeze({
      offers: (): readonly RewardOffer[] => run.currentOffer(),
      choose: (relicId: string): boolean =>
        takeReward(relicId).outcome === 'accepted',
    }),
    startNewRun,
    dispose: (): void => {
      stopMove();
      stopRestart();
      stopContinue();
      stopSelectReward();
      stopActivateRelic();
      stopStartRun();
      stopRewardScreen();
      cancelContextRestoreWait();
      stopRunPersistence();
      stopEngineTracing();
      stopHud();
      hud.destroy();

      for (const release of stopEventMetrics) {
        release();
      }

      stopAnnouncer();
      stopAnnouncedPreferences();
      engineAnnouncer.destroy();
      announcer.destroy();
      stopRouter();
      settings?.destroy();
      router.destroy();
      focusManager.destroy();
      soundEngine.dispose();
      // Detaches the turn and stage listeners and closes whatever they left
      // open, so a disposed application leaves no span on the stack.
      stopEngineTracing();
      stopRendering();
      stopCommitCapture();
      frameSubscription.remove();
      stopMotion();
      stopPreferences();
      controls.unmount();
      parallelBoard.unmount();
      input.detach();
      loop.stop();

      // Read through the binding rather than captured: a mode switch replaced
      // it, and the renderer in force is the one that has to be taken down.
      renderer.destroy();
      diagnostics.destroy();
      preferences.destroy();
    },
  });
}

/**
 * Starts the application once the document is ready.
 *
 * js/application.js L1 and L4 wrapped its one statement in a
 * `DOMContentLoaded` listener because the ten classic script elements it
 * belonged to were loaded before `</body>`. A module script is deferred
 * by definition, so the document is already parsed by the time this runs;
 * the readiness check is kept for the one case a module can still be
 * evaluated early, which is an injected or dynamically imported entry.
 */
/**
 * Name the running application is published under for local inspection.
 *
 * Namespaced and underscore-prefixed, so it cannot collide with anything the
 * page or a future dependency declares.
 */
const APPLICATION_GLOBAL = '__blitzy2048';

/**
 * Publishes the running application for local inspection.
 *
 * Rule 3's standard is that a capability which cannot be exercised locally is
 * not delivered, and the diagnostics surface has no on-screen affordance: no
 * control opens it and the input vocabulary binds no action to it. Without a
 * handle it would be built, wired, and unreachable from a browser — delivered
 * only in the sense that it exists.
 *
 * A read-only handle, and the ONLY global this module writes. Nothing in the
 * application reads it back, so removing it would change no behaviour; it exists
 * for a developer console, and the failure to publish is contained because a
 * frozen or hostile global object must not stop the game booting.
 *
 * @param application The application to publish.
 */
function publishForInspection(application: Application): void {
  try {
    Object.defineProperty(globalThis, APPLICATION_GLOBAL, {
      value: application,
      writable: true,
      configurable: true,

      // Not enumerable: it should not appear in an enumeration of the global
      // object, only be reachable by name.
      enumerable: false,
    });
  } catch {
    // A global that cannot be written is not a reason to fail the boot.
    application.logger.debug('The inspection handle could not be published.', {
      name: APPLICATION_GLOBAL,
    });
  }
}

/**
 * Runs a callback once on the next animation frame.
 *
 * Falls back to a zero-delay timer in an environment with no
 * `requestAnimationFrame` — the same gap js/animframe_polyfill.js shimmed, which
 * deleting that polyfill narrowed the browser matrix for but did not remove the
 * need for a path around.
 *
 * @param callback Callback to run once, on the next frame.
 */
function onNextFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame((): void => {
      callback();
    });

    return;
  }

  setTimeout(callback, 0);
}

/** How `bootstrap()` composes. Every member has a working default. */
export interface BootstrapOptions {
  /** Document to compose against. Defaults to the ambient `document`. */
  readonly ownerDocument?: Document;

  /**
   * Defers the composition by one frame. Defaults to `onNextFrame`, and is
   * injectable so the deferral itself is observable without a real frame.
   */
  readonly schedule?: (callback: () => void) => void;

  /** Composes the application. Defaults to `start`. */
  readonly compose?: (ownerDocument: Document) => Application;
}

/** What `bootstrap()` did. */
export type BootstrapOutcome =
  /** A composition was deferred to the next frame. */
  | 'scheduled'
  /** The document is still parsing; the deferral waits for `DOMContentLoaded`. */
  | 'awaiting-document'
  /** No document to compose against. */
  | 'unavailable';

/**
 * One token per composition `bootstrap()` has scheduled and not yet run.
 *
 * A TOKEN PER BOOT RATHER THAN ONE SHARED FLAG. A page load calls `bootstrap()`
 * once, but a test or an embedder may call it more than once, and a single flag
 * makes those calls interfere: the first boot to reach its frame would clear the
 * flag the second is waiting on and the second would stand down for no reason. A
 * token is deleted by the boot that owns it, so only `start()` — which clears the
 * set — cancels a boot that is not its own.
 */
const pendingBoots = new Set<object>();

/** Whether the composition in progress is the automatic boot's own. */
let booting = false;

/**
 * Cancels a deferred automatic boot, called by `start()` when a CALLER composes
 * first.
 *
 * ONE DOCUMENT, ONE APPLICATION. `start()` is exported so an embedder — or a
 * test — can compose the application itself, and the automatic boot must not then
 * compose a second one over the same markup: every control would be bound twice
 * and every keystroke handled twice. A caller that composes first supersedes the
 * boot; the boot's own call is exempt, which `booting` distinguishes.
 */
function cancelPendingBoot(): void {
  if (!booting) {
    pendingBoots.clear();
  }
}

/**
 * Composes and publishes the application ON THE NEXT ANIMATION FRAME.
 *
 * Ported from js/application.js L1-L4, whose whole body was one
 * `window.requestAnimationFrame` callback wrapping the composition. Deferring by
 * exactly ONE FRAME — not a loop, not a poll, not an immediate call — is what let
 * the first paint happen before any of the application's own work, and it is
 * preserved rather than replaced: an immediate composition delays that first
 * paint by however long the whole graph takes to build, which the vanilla game
 * deliberately avoided.
 *
 * The readiness guard around it is NEW, because the vanilla scripts were the last
 * elements of the body and the document was therefore already parsed when they
 * ran. A module script is deferred but can still be evaluated while the document
 * is loading, and the composition reads several markup mount points. The guard
 * waits, and the one-frame deferral still applies afterwards.
 *
 * @param options Document, scheduler and composer. Every member has a default.
 * @returns What was done.
 */
export function bootstrap(options: BootstrapOptions = {}): BootstrapOutcome {
  const ownerDocument =
    options.ownerDocument ??
    (typeof document === 'undefined' ? undefined : document);

  if (ownerDocument === undefined) {
    return 'unavailable';
  }

  const schedule = options.schedule ?? onNextFrame;
  const compose = options.compose ?? start;

  const defer = (): void => {
    const token = {};

    pendingBoots.add(token);

    schedule((): void => {
      // `delete` reports whether the token was still pending: a caller that
      // composed in the meantime cleared it, and this boot then stands down
      // rather than binding the same markup a second time.
      if (!pendingBoots.delete(token)) {
        return;
      }

      booting = true;

      try {
        publishForInspection(compose(ownerDocument));
      } finally {
        booting = false;
      }
    });
  };

  if (ownerDocument.readyState === 'loading') {
    ownerDocument.addEventListener('DOMContentLoaded', defer, { once: true });

    return 'awaiting-document';
  }

  defer();

  return 'scheduled';
}

bootstrap();
