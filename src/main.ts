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
//   the report sink every layer's counters and diagnostics reach.
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
// Decisions behind this file: DL-MAIN-01, the stylesheet entering through
// the module graph; DL-MAIN-02, the run seed drawn from Web Crypto with the
// two clocks as the fallback and never from `Math.random`; DL-MAIN-03, the
// DL-MAIN-04, `setup()` called after every subscriber has attached.
// Traceability rows: TR-MAIN-01, js/application.js L1 and L4's
// `DOMContentLoaded` wrapper; TR-MAIN-02, its L3 construction with the
// board-size literal; and target-only rows TR-MAIN-03 through TR-MAIN-06 for

// The stylesheet enters through the module graph. index.html's <link> to
// the committed generated CSS was removed; this import is its replacement
// and it is the only one in the module graph.
import '../style/main.scss';

import { createDefaultRulesConfig } from './config/default-config';
import type { RulesConfig } from './config/rules-config';
import { Engine } from './engine/engine';
import {
  SPAWN_ATTEMPT_METRIC,
  SPAWN_SUPPRESSED_METRIC,
} from './engine/engine';
import type {
  EngineEventSubscription,
  EngineEvents,
  StateCommitEvent,
} from './engine/engine-events';
import type { EngineReporter } from './engine/types';
import { ENGINE_EVENT_NAMES } from './engine/engine-events';
import type { SpawnDetail } from './observability/metrics';
import { createInputManager } from './input/input-manager';
import type { InputReporter } from './input/keymap';
import type {
  LogFields,
  LogLevel,
  Logger,
} from './observability/logger';
import { createLogger, deriveCorrelationId } from './observability/logger';
import type { MetricsRegistry } from './observability/metrics';
import { METRIC_PREFIX, createMetricsRegistry } from './observability/metrics';
import type {
  DiagnosticsOverlay,
  HealthCheckResult,
} from './observability/diagnostics-overlay';
import {
  createDiagnosticsOverlay,
  isDiagnosticsRequested,
} from './observability/diagnostics-overlay';
import { createNumberOnlyRenderer } from './render/number-only-renderer';
import { createRenderLoop } from './render/render-loop';
import type { FrameContext } from './render/render-loop';
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
import { createDefaultStageConfig } from './config/stage-config';
import type { RunIdentity } from './run/run-controller';
import { RunController, resolveRunIdentity } from './run/run-controller';
import type { RunReporter } from './run/run-state';
import { RunStateStore } from './run/run-state-store';
import type { StorageFailure } from './storage/local-storage-manager';
import { LocalStorageManager } from './storage/local-storage-manager';
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
import { createLiveRegionAnnouncer } from './ui/a11y/live-region';
import type { EngineAnnouncer } from './ui/a11y/engine-announcer';
import { createEngineAnnouncer } from './ui/a11y/engine-announcer';
import { createScreenRouter } from './ui/screen-router';
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
function createInputSink(reporter: RenderReporter): InputReporter {
  return {
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
 * Projects a caught value onto the render sink's error shape.
 *
 * @param caught Value that was thrown.
 * @returns Its name and message, with a printable fallback for a non-error.
 */
function describeCaught(caught: unknown): {
  readonly name: string;
  readonly message: string;
} {
  if (caught instanceof Error) {
    return Object.freeze({
      name: caught.name.length > 0 ? caught.name : 'Error',
      message: caught.message,
    });
  }

  return Object.freeze({ name: 'UiError', message: String(caught) });
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
        error: describeCaught(caught),
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
          report.error === undefined ? undefined : describeCaught(report.error),
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
        error: Object.freeze({
          name:
            report.error instanceof Error
              ? report.error.name
              : 'EngineError',
          message:
            report.error instanceof Error
              ? report.error.message
              : String(report.error),
        }),
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

    onRewardDrawn(report): void {
      reporter.onCount({
        name: 'run.rewardDrawn',
        value: 1,
        detail: Object.freeze({
          stageIndex: report.stageIndex,
          offered: report.offeredRelicIds.length,
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
   * The run in progress: its identity, its stage, its relics and its summary.
   *
   * Exposed because it is the only reachable source of the run seed — which the
   * player is meant to be able to read and copy — and of the finished run a
   * summary is drawn from once the stored envelope has been cleared.
   */
  readonly run: RunController;

  /**
   * The accessibility and presentation preferences in force.
   *
   * Exposed because it is the surface that decides which renderer draws the
   * board, which palette is applied and whether motion is reduced, and because
   * nothing outside this module could otherwise reach the running application's
   * settings at all.
   */
  readonly preferences: PreferenceStore;

  /** Stops the frame loop and removes every listener that was bound. */
  readonly dispose: () => void;
}

/**
 * Builds and starts the application.
 *
 * The order is load-bearing, and it is a chain rather than a preference:
 *
 *   storage -> run identity -> correlation identifier -> logger and metrics ->
 *   run controller -> substreams -> engine -> subscribers -> `setup()`
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
export function start(ownerDocument: Document): Application {
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
  const correlationId = deriveCorrelationId(identity.seed, identity.runId);

  // The structured logger and the metrics registry, both of which shipped fully
  // implemented and neither of which was ever constructed. `consoleOutput` keeps
  // everything that used to reach the console reaching it, now as a structured
  // record carrying the correlation identifier rather than a bare string.
  const logger = createLogger({
    correlationId,
    subsystem: 'main',
    consoleOutput: true,
  });

  // The logger is handed to the registry so its own internal reports correlate
  // with everything else under the same identifier.
  const metrics = createMetricsRegistry({ logger });
  const reporter = createSink(logger, metrics);

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

  // The run: the versioned envelope's load, save and clear, the stage and relic
  // slices of every commit, and stage advancement. Composed before the
  // substreams because it supplies the seed they are built from and the cursors
  // they are resumed at.
  const runSink = createRunSink(reporter);
  const run = new RunController({
    store: new RunStateStore({
      storage,
      config,
      correlationId,
      reporter: runSink,
    }),
    identity,
    config,
    stages,
    createToken: createRunToken,
    reporter: runSink,
    correlationId,
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
  const streams = createRngStreams(
    run.seed(),
    run.cursors(),
    createRngSink(reporter),
  );

  const engine = new Engine({
    config,
    streams,
    storage,
    correlationId,
    reporter: createEngineSink(reporter, metrics),

    // The stage and relic slices of every commit. Read through the controller on
    // each call rather than captured, so a stage that advances and a relic that
    // spends a charge are visible on the next commit.
    stageContext: () => run.stageContext(),
    relicContext: () => run.relicContext(),
  });

  const loop = createRenderLoop({
    reporter,
    autoStopWhenIdle: true,
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
  const support = probeWebGLSupport(reporter);

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
  const buildRenderer = (mode: BoardRenderMode): BoardRenderer => {
    if (mode === 'three') {
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
      });
    }

    return createNumberOnlyRenderer({
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
        correlationId,
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

  /**
   * The capability probes, reported rather than merely performed.
   *
   * All five of these already ran and none was ever reported anywhere: the
   * vanilla sources probed `Function.prototype.bind`, `Element.classList`,
   * `requestAnimationFrame`, the pointer event family and Web Storage
   * writability, and then discarded every result. This aggregates them and adds
   * the sixth the Three.js renderer introduced, so the health panel answers
   * what the build can actually do on this machine.
   *
   * Read afresh on every render, so a context lost after boot shows as lost.
   */
  const readHealth = (): readonly HealthCheckResult[] => {
    const results: HealthCheckResult[] = [
      {
        name: 'webgl',
        healthy: support.supported,
        detail: `level ${support.level}${
          support.failure === undefined ? '' : `, ${support.failure}`
        }`,
      },
      {
        name: 'storage',
        healthy: storage.probe.supported,
        detail: `strategy ${storage.probe.strategy}`,
      },
      {
        name: 'requestAnimationFrame',
        healthy: typeof requestAnimationFrame === 'function',
      },
      {
        name: 'classList',
        healthy:
          typeof Element !== 'undefined' &&
          'classList' in Element.prototype,
      },
      {
        name: 'functionBind',
        healthy: typeof Function.prototype.bind === 'function',
      },
      {
        name: 'pointerEvents',
        healthy: input.isListening(),
        detail: `renderer ${selection.mode}`,
      },
    ];

    // Recording is the overlay's, not this reader's: it records every result it
    // renders, before it takes its snapshot, so the panel and the exported
    // snapshot cannot disagree. This function observes and returns.
    return results;
  };

  let stopRendering = renderer.subscribe(engine.events);
  const frameSubscription = loop.addFrameCallback((context): boolean => {
    // `game2048_frames_rendered_total` and the frame-time histogram, which the
    // generic timing channel does not populate. The frame callback is the
    // system's only asynchronous boundary and was entirely unmeasured.
    metrics.recordFrame(context.delta);

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
      stopRendering = renderer.subscribe(engine.events);

      if (lastCommit !== null) {
        renderer.render(lastCommit);
      }

      onRendererWork();
      reportSelection();
    } finally {
      switchingRenderer = false;
    }
  };

  // The HUD is mounted BESIDE the renderer, not inside it. The score outlets,
  // the rising score delta and the terminal overlay have exactly one owner, and
  // that owner subscribes to `state:commit` directly, so selecting a different
  // board renderer changes what draws the board and nothing else.
  const hud = createHud({
    scoreContainer: ownerDocument.querySelector<HTMLElement>(SELECTORS.score),
    bestContainer: ownerDocument.querySelector<HTMLElement>(SELECTORS.best),
    messageContainer: ownerDocument.querySelector(SELECTORS.message),
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
  });

  const input = createInputManager({
    ownerDocument,

    // The router's context, not the document's: it composes the document rule
    // with the two pieces of state only it knows — the dialog it owns and the
    // terminal turn the engine reported.
    context: router.context,
    reporter: createInputSink(reporter),
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

  // The dialog owns its own containment and its own body; the router owns when
  // it is shown. The keymap arrives as a value and leaves through
  // `onKeymapChange`: src/ui/a11y/settings.ts holds no keymap, so the input
  // manager stays its owner and the control layer follows every rebind.
  // The audio layer (A5): synthesised through the Web Audio API, with no binary
  // asset. Its state is seeded from the store here and written by the settings
  // dialog. `preferences` is not supplied: src/audio/sound-engine.ts refuses
  // `setMuted` and `setVolume` when it is.
  //
  // Where no AudioContext constructor exists the engine reports itself
  // unavailable and every member stays safe to call. The dialog states that in
  // real text.
  const soundEngine: SoundEngine = createSoundEngine({
    reporter: createSoundSink(reporter),
    metrics: createSoundMetrics(reporter),
    muted: preferences.isMuted(),
    volume: preferences.getVolume(),
    unlockTargets: [ownerDocument],
  });

  soundEngine.subscribe(engine.events);

  settings = createSettingsPanel({
    host: settingsPanelHost,
    hostSelector: SELECTORS.settingsPanel,
    preferences,
    focusManager,
    soundEngine,
    keymap: input.getKeymap(),
    onKeymapChange: (next): void => {
      input.setKeymap(next);
      controls.refresh();
    },
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
  // no port for an orchestrator to poll (AAP 0.7.2.4). Built after the input
  // layer because the health provider reads it.
  //
  // Without this the registry would be write-only — every counter moving and
  // nobody able to read one — which is the state the review found.
  const diagnostics = createDiagnosticsOverlay({
    metrics,
    logger,
    selector: SELECTORS.diagnostics,
    document: ownerDocument,
    health: readHealth,

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
    streams.snapshotCursors(),
  );

  // The three subscriptions js/game_manager.js L9-L11 installed, by the
  // same three event names.
  const stopMove = input.on('move', (direction): void => {
    engine.move(direction);
  });
  const stopRestart = input.on('restart', (): void => {
    engine.restart();
  });
  const stopContinue = input.on('keepPlaying', (): void => {
    engine.continuePlaying();
  });

  loop.start();
  engine.setup();

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
    diagnostics,
    logger,
    metrics,
    run,
    dispose: (): void => {
      stopMove();
      stopRestart();
      stopContinue();
      stopRunPersistence();
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

function bootstrap(): void {
  if (typeof document === 'undefined') {
    return;
  }

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      (): void => {
        publishForInspection(start(document));
      },
      { once: true },
    );

    return;
  }

  publishForInspection(start(document));
}

bootstrap();
