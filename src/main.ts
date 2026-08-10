// The composition root: the single module index.html L113 loads.
//
// Ported from js/application.js L1-L4, the whole of it:
//   L1-L2, L4  the one-animation-frame deferral, reproduced by `bootstrap()`
//   L3         `new GameManager(4, KeyboardInputManager, HTMLActuator,
//              LocalStorageManager)`: the constructor injection reproduced
//              by `start()`, and the board-size literal `4`, now read from
//              src/config/default-config.ts
// Ported from js/game_manager.js L1-L14, the constructor body:
//   L3-L5   the three collaborators constructed from injected constructors
//   L7      the starting tile count, now `RulesConfig.startTiles`
//   L9-L11  the `move`, `restart` and `keepPlaying` subscriptions, kept under
//           those names and extended with `startRun`, `selectReward`,
//           `activateRelic`, `continueStage`, `endRun`, `openSettings`,
//           `closeSettings` and `cancel`
//   L13     `setup()`, now `RunController.openEngineBoard()`, called last
// Ported from index.html L7, the <link> to the committed generated CSS,
// replaced by the stylesheet import below.
//
// Decisions behind this file are argued in docs/DECISION_LOG.md; the ids are
// named beside the constructs they belong to. DL-MAIN-01 to DL-MAIN-14 are
// this file's own rows.

// Ported from index.html L7. DL-MAIN-01.
import '../style/main.scss';

import {
  createDefaultRulesConfig,
  restoreRulesConfig,
  snapshotRulesConfig,
} from './config/default-config';
import type { RulesConfig } from './config/rules-config';
import { Engine } from './engine/engine';
import { createHookBus } from './engine/hook-bus';
import {
  MOVE_RESOLVED_METRIC,
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
import type {
  InputAction,
  InputReporter,
  InputSpan,
  Keymap,
} from './input/keymap';
import {
  DEFAULT_KEY_BINDINGS,
  RELIC_SLOT_COUNT,
  REWARD_SLOT_COUNT,
  deserializeKeymap,
  isKeymapPayloadWithinLimit,
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
  SPAN_OUTCOMES,
  attachEngineTracing,
  createBoundaryTracing,
  createTracer,
} from './observability/tracer';
import type { MetricsRegistry } from './observability/metrics';
import {
  METRIC_PREFIX,
  attachRngCursorMetrics,
  createMetricsRegistry,
} from './observability/metrics';
import type { WebGLProbeView } from './observability/health';
import type { DiagnosticsOverlay } from './observability/diagnostics-overlay';
import {
  createDiagnosticsOverlay,
  isDiagnosticsRequested,
} from './observability/diagnostics-overlay';
import { createNumberOnlyRenderer } from './render/number-only-renderer';
import type { BoardFocus } from './render/number-only-renderer';
import { createRenderLoop } from './render/render-loop';
import type { FrameContext } from './render/render-loop';
import type { ContextRestoreOutcome } from './render/three-renderer';
import { createThreeRenderer } from './render/three-renderer';
import type {
  RenderCount,
  RenderDetail,
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
import type {
  ActiveRelic,
  PersistedRelic,
  Relic,
} from './relics/relic-types';
import { HOOK_NAMES } from './engine/hooks';
import { createDefaultStageConfig } from './config/stage-config';
import type { StageGoal } from './config/stage-config';
import type {
  RewardOffer,
  RewardSelection,
  RunIdentity,
  RunScope,
} from './run/run-controller';
// `normalizeEnteredSeed` and `originateRunSeed` are NOT imported here.
// `RunController.startRun` applies both — the reduction to a supplied seed and
// the origination of an absent one — so this root hands over whatever it was
// given and reads the played seed back from `run.seed()`. One normaliser, and it
// is the controller's. DL-RUNCTL-01.
import { RunController, resolveRunIdentity } from './run/run-controller';
import type {
  RunOutcome,
  RunReporter,
  RunSummary,
} from './run/run-state';
import { RunStateStore } from './run/run-state-store';
import type { StorageFailure } from './storage/local-storage-manager';
import { LocalStorageManager } from './storage/local-storage-manager';
import { KEYMAP_KEY, RUN_STATE_KEY } from './storage/storage-keys';
import {
  LEGACY_CONTROL_BINDINGS,
  mountOnScreenControls,
} from './input/on-screen-controls';
import type { MarkupControlBinding } from './input/on-screen-controls';
import { getTheme, isThemeId } from './theme/themes';
import { motion } from './theme/tokens';
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
import type {
  AuthorizedAction,
  RewardCard,
  RouterInputSurface,
  ScreenName,
  ScreenRegistry,
  ScreenRouter,
} from './ui/screen-router';
import { createSettingsPanel } from './ui/components/settings-panel';
import type { SettingsPanel } from './ui/components/settings-panel';
import type { Hud } from './ui/screens/hud';
import { createHud } from './ui/screens/hud';

// The five screens the flow needs besides the HUD. Imported and INSTANTIATED
// here, and handed to the router as its `screens` registry: the router records
// which module renders each state as data and imports none of them, so a module
// this root does not pass is a state the router mounts nothing for. All five were
// unreferenced by any production file, so `runStart`, `stageClear`, `reward`,
// `won`, `gameOver` and `runSummary` each entered as an empty container.
// DL-MAIN-12.
import { createGameOverScreen } from './ui/screens/game-over';
import type { GameOverScreen } from './ui/screens/game-over';
import { createRewardScreen } from './ui/screens/reward';
import type { RewardScreen } from './ui/screens/reward';
import { createRunStartScreen } from './ui/screens/run-start';
import type { RunStartScreen } from './ui/screens/run-start';
import { createRunSummaryScreen } from './ui/screens/run-summary';
import type { RunSummaryScreen } from './ui/screens/run-summary';
import { createStageProgressScreen } from './ui/screens/stage-progress';
import type { StageProgressScreen } from './ui/screens/stage-progress';
import type { PreferenceStore, UiReporter } from './ui/a11y/settings';
import {
  createPreferenceStore,
  reflectReducedMotion,
} from './ui/a11y/settings';

/**
 * Renders a theme id as the prose name a preference announcement carries.
 *
 * @param theme Theme id to render.
 * @returns The prose name.
 */
function describeThemeName(theme: string): string {
  return isThemeId(theme) ? getTheme(theme).name : theme;
}

/**
 * Reads the highest tile value on a committed board, and `0` for a board
 * holding none.
 *
 * READ-ONLY: the board travels by reference on every payload and is neither
 * cloned nor mutated here. `cells[x][y]` is the column-major lattice
 * js/grid.js L60-L69 serialised and this build preserves.
 *
 * @param board Board carried by a commit.
 * @returns The highest value present, or 0.
 */
function readHighestTileValue(board: {
  readonly cells: readonly (readonly ({ readonly value: number } | null)[])[];
}): number {
  let highest = 0;

  for (const column of board.cells) {
    for (const cell of column) {
      if (cell !== null && cell.value > highest) {
        highest = cell.value;
      }
    }
  }

  return highest;
}

/** Name the gap BETWEEN frames is reported under. */
const FRAME_INTERVAL_TIMING = 'render.frame.interval';

/**
 * The elements index.html declares that this root looks up.
 *
 * Every lookup below is guarded. The vanilla markup's eight-selector contract
 * was dereferenced unchecked in four places in js/html_actuator.js L2-L5 and
 * one in js/keyboard_input_manager.js L141, so a renamed class was a startup
 * failure; an absent element is reported here and the rest of the page starts.
 * `.tile-container` of index.html L70-L72 is not among them: the canvas host
 * replaces it.
 */
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

  // The page shell: the heading, the game region and the footer. Everything a
  // modal screen makes inert, and nothing that a modal screen is. DL-ROUTER-25.
  pageShell: '.container',
  liveRegion: '#live-region',
  diagnostics: '#diagnostics-overlay',
  rewardScreen: '#screen-reward',
  // EVERY BOARD TAB STOP, IN DOCUMENT ORDER. The two renderers put the board's
  // tab stop in different places: `ParallelBoardLayer` of
  // src/ui/a11y/focus-manager.ts makes the HOST `#board-a11y` the single stop
  // and leaves its cells programmatic, while src/render/number-only-renderer.ts
  // roves the stop across the CELLS of its own `#board-number-only` lattice and
  // hides the parallel board. `querySelector` answers in document order and
  // index.html declares `#board-number-only` first, so the surface in force is
  // matched and the hidden one is not. Naming only `#board-a11y` restored focus
  // to a hidden element for every number-only session. DL-FOCUS-04.
  boardTabStop:
    '#board-number-only [tabindex="0"], #board-a11y[tabindex="0"], ' +
    '#board-a11y [tabindex="0"]',
  hudGroup: '#screen-hud',
  hudStage: '#hud-stage',
  relicTray: '#relic-tray',
});

/** The markup controls this root binds, and the action each publishes. */
const MARKUP_CONTROLS: readonly MarkupControlBinding[] = Object.freeze([
  ...LEGACY_CONTROL_BINDINGS,
  Object.freeze({
    selector: SELECTORS.settingsButton,
    action: 'openSettings' as const,
  }),
]);

/** The one counter family every generic report increment lands on. */
const REPORT_COUNTER_NAME = `${METRIC_PREFIX}reports_total`;

/** `# HELP` text `REPORT_COUNTER_NAME` is exported with. */
const REPORT_COUNTER_HELP =
  'Reports counted across every subsystem. The report name is the report ' +
  'label and its leading segment the subsystem label.';

/** Label carrying a report's own dotted name. */
const REPORT_LABEL = 'report';

/** Label carrying the leading segment of that name. */
const REPORT_SUBSYSTEM_LABEL = 'subsystem';

/** Subsystem label of a report whose name carries no leading segment. */
const UNKNOWN_SUBSYSTEM = 'unknown';

/** Subsystem every record about the Web Storage adapter carries. */
const STORAGE_SUBSYSTEM = 'storage';

/**
 * Maps a render diagnostic level onto a log level.
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
 * `RenderReporter` is the hub the whole reporting graph adapts onto: the
 * engine, input, storage, preference and UI adapters below all narrow to it,
 * and its three channels are wired here to the structured logger and the
 * metrics registry. Console output is retained — the logger writes it itself
 * under `consoleOutput`. DL-MAIN-03, DL-MAIN-07.
 *
 * @param logger Structured logger diagnostics are recorded through.
 * @param metrics Registry counts and timings are recorded into.
 * @returns A frozen reporter whose channels cannot throw into their callers.
 */
function createSink(logger: Logger, metrics: MetricsRegistry): RenderReporter {
  // `# HELP` and `# TYPE` for the collapsed counter family, recorded once.
  metrics.describe(REPORT_COUNTER_NAME, REPORT_COUNTER_HELP, 'counter');

  return createRenderReporter({
    onDiagnostic: (diagnostic: RenderDiagnostic): void => {
      const target = logger.child(diagnostic.source);
      const fields: LogFields = {
        ...(diagnostic.detail ?? {}),
      };

      if (diagnostic.level === 'error' || diagnostic.level === 'warning') {
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
      metrics
        .counter(REPORT_COUNTER_NAME, readCountLabels(count))
        .inc(count.value);
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
 * Reads the subsystem a dotted report name belongs to: its leading segment.
 *
 * @param name Report name to read.
 * @returns The subsystem label value.
 */
function toReportSubsystem(name: string): string {
  const text = String(name).trim();
  const separator = text.indexOf('.');
  const leading = separator === -1 ? text : text.slice(0, separator);

  return leading === '' ? UNKNOWN_SUBSYSTEM : leading;
}

/**
 * Reads the labels a counter increment carries: the report's own dotted name
 * and the subsystem it belongs to, and nothing else.
 *
 * @param count The increment.
 * @returns The label set.
 */
function readCountLabels(count: RenderCount): Readonly<Record<string, string>> {
  const name = String(count.name);

  return Object.freeze({
    [REPORT_LABEL]: name,
    [REPORT_SUBSYSTEM_LABEL]: toReportSubsystem(name),
  });
}

/**
 * Adapts a render sink to the input layer's sink shape.
 *
 * @param reporter Render sink to write through.
 * @param tracer Tracer the `input.dispatch` span is opened on. Defaults to
 *   `null`, which omits `startSpan` from the returned sink entirely, so the
 *   input layer sees a sink that does not trace rather than one that traces
 *   into nothing.
 * @returns An input sink.
 */
function createInputSink(
  reporter: RenderReporter,
  tracer: Tracer | null = null,
): InputReporter {
  return {
    /** The `input.dispatch` boundary of validation gate V8. */
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
        // non-`Error` throwable's own structure that a two-field summary
        // cannot.
        error: describeRenderError(caught),
        thrown: caught,
      });
    },
  };
}

/**
 * Adapts a render sink to the audio layer's sink shape.
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
 * @param metrics Registry the engine's own spawn and turn counters are recorded
 *   on through their purpose-built recorders, rather than as generic counts
 *   under a dotted name.
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
        // The one total reduction, shared with src/render/: reading `name`,
        // `message` or `String(value)` here would let a hostile getter or a
        // throwing `toString` replace the failure being reported.
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
        // summary through the one total reducer, and the caught value itself
        // for a sink that can keep more of it than two fields.
        error: describeRenderError(report.error),
        thrown: report.error,
      });
    },

    onCount(report): void {
      // Three distinct boundaries, each fed from the counter that owns it:
      // `engine.spawn.attempt` is every attempt, `engine.spawn.suppressed` is
      // every attempt that inserted nothing, and `engine.move.resolved` is
      // every turn whose slide moved a tile. `tile:spawn` is emitted for every
      // attempt and `move:after` for every turn that reached the walk, so
      // neither event is a substitute for either counter.
      if (report.metric === SPAWN_ATTEMPT_METRIC) {
        metrics.recordSpawnAttempt();
      } else if (report.metric === SPAWN_SUPPRESSED_METRIC) {
        metrics.recordSpawnSuppressed();
      } else if (report.metric === MOVE_RESOLVED_METRIC) {
        // THE TURN COUNTER IS FED FROM HERE, as the two spawn families are:
        // `engine.move.resolved` is raised once per move that changed the
        // board, while `move:after` is emitted for every turn that reached the
        // walk, carrying `moved: false` for one that moved nothing.
        // DL-METRIC-04.
        metrics.recordTurnResolved();
      }

      // `hook` and `event` are separate dimensions of `EngineCountReport` and
      // a report carries at most one, so both are forwarded and the absent one
      // is `null`.
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
 * The composition's own reactions to two run reports, beside the logging and
 * counting `createRunSink` does with every report.
 *
 * Passed in rather than reached from inside the sink: the constructs that react
 * — the engine-tracing subscription, the HUD — are composed after the sink is
 * built, so each arrives as a function the composition fills.
 */
interface RunSinkObservers {
  /**
   * Called once a finished run has been reported, with the outcome that ended
   * it. The stage span is closed here: a loss and an explicit end-run both
   * finish a run without emitting `stage:end`.
   */
  readonly onRunEnded?: (outcome: string) => void;
}

/**
 * Adapts the render reporter to the run folder's sink.
 *
 * @param reporter The one sink of the composition.
 * @param observers The composition's reactions to specific reports.
 * @returns A complete `RunReporter`.
 */
function createRunSink(
  reporter: RenderReporter,
  observers: RunSinkObservers = {},
): RunReporter {
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
        // Forwarded ONLY when the loader actually caught something. A refusal
        // reached on a size ceiling or a failed schema check throws nothing, and
        // forwarding an absent value serialised it as a fabricated
        // `UnknownError`, which made a graceful refusal read as an exception.
        // DL-RUNSTORE-06.
        ...(report.error === undefined ? {} : { thrown: report.error }),
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

    // The transition, not the attempt: `onWriteFailed` above already carries
    // one record per refused write, and this one fires only when the run
    // crosses between persisting and not. Both directions are reported, and
    // the crossing back to `persistent` is the recovery, so it is not an
    // error. DL-RUNCTL-20.
    onPersistenceStatusChanged(report): void {
      const ephemeral = report.status === 'ephemeral';

      reporter.onDiagnostic({
        level: ephemeral ? 'warning' : 'info',
        source: 'run/state',
        message: ephemeral
          ? 'The run is no longer being saved and continues in memory only.'
          : 'The run is being saved again.',
        detail: Object.freeze({
          status: report.status,
          previous: report.previous,
          refusedWrites: report.refusedWrites,
        }),
      });

      reporter.onCount({
        name: 'run.persistence.changed',
        value: 1,
        detail: Object.freeze({
          status: report.status,
          previous: report.previous,
          refusedWrites: report.refusedWrites,
        }),
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
        // THE RUN IDENTIFIER IS NOT CARRIED. It keys the correlation identifier
        // every record already carries, and a record carrying both hands a
        // reader of an export the key as well as the value. DL-LOG-09.
        detail: Object.freeze({
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

        detail: Object.freeze({
          stageIndex: report.stageIndex,
          offered: report.offeredRelicIds.length,

          // Read directly: `accepted` is a required member of the report, so
          // there is no absent case left to default. DL-RUNCTL-07.
          accepted: report.accepted,
          refusal: report.refusal ?? 'none',
        }),
      });
    },

    // A loaded envelope whose relics the catalogue refused. Reported at `warn`
    // carrying the refused identifiers, beside the count.
    onRelicsNormalized(report): void {
      reporter.onDiagnostic({
        level: 'warning',
        source: 'run',
        message:
          `Hydration refused ${report.requested - report.restored} of ` +
          `${report.requested} stored relics.`,
        detail: Object.freeze({
          requested: report.requested,
          restored: report.restored,

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
          outcome: report.outcome,
          stageIndex: report.summary.stageIndex,
          score: report.summary.score,
          relics: report.summary.relics.length,
        }),
      });

      // THE STAGE THE RUN WAS PLAYING IS OVER, whether or not it resolved. A
      // run that ends on a loss or on the player's own end-run emits no
      // `stage:end`, so nothing else closes the stage span.
      observers.onRunEnded?.(report.outcome);
    },
  };
}

/**
 * Adapts the render reporter to the RNG folder's sink.
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
          (rejection.stream === undefined
            ? ''
            : ` for ${rejection.stream}`) +
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

// The seven boundaries validation gate V8 names — input, engine turn, move
// resolution, hook dispatch, relic handler, renderer and the frame callback —
// are each spanned by a collaborator this root injects, so no module under
// src/engine, src/input, src/relics or src/render imports anything from
// src/observability. DL-MAIN-05.
//
// Where each one is spanned:
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
//   render.commit       `createTracedRenderEvents` below, on the emitter the
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
 * @returns A token string. The seed form is used verbatim by the substreams.
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

/** The two ways the board can be drawn. */
export type BoardRenderMode = 'three' | 'number-only';

/** The WebGL failure the health check reports while a context stands lost. */
const CONTEXT_LOST_FAILURE = 'context-lost';

/**
 * The WebGL failure the health check reports while a restored context's
 * resources could not be rebuilt.
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
 * A number-only board the PLAYER chose reports no failure: it is the accessible
 * rendering mode of R9, not a capability gap.
 */
const FORCED_FALLBACK_FAILURE = 'number-only-forced';

/** How the board is drawn, and what put that mode in force. */
export interface BoardRenderSelection {
  /** The rendering mode in use. */
  readonly mode: BoardRenderMode;

  /**
   * Whether number-only rendering is standing in for an unavailable WebGL
   * context, rather than having been chosen.
   */
  readonly fallback: boolean;

  /** Whether the player chose number-only rendering. */
  readonly chosen: boolean;

  /** The probe result the selection was made from. */
  readonly support: WebGLSupportResult;
}

/** The part of a board renderer this root drives. */
interface BoardRenderer {
  readonly mounted: boolean;
  mount(target?: Element | null): boolean;
  unmount(): void;
  subscribe(events: EngineEvents): EngineEventSubscription;
  render(commit: StateCommitEvent): void;
  frame(context?: FrameContext): boolean;
  destroy(): void;

  /**
   * The renderer's own counters, where it keeps any. Optional: the number-only
   * renderer keeps none.
   */
  readStats?(): { readonly contextLost: boolean };

  /**
   * The board cell this renderer's tab stop stands on, where the renderer roves
   * one. Optional: the 2.5D renderer keeps no reading position of its own —
   * `ParallelBoardLayer` makes its HOST the single stop — so only the
   * number-only renderer answers. DL-FOCUS-04.
   */
  focusedCell?(): BoardFocus | null;
}

/**
 * How long a lost WebGL context is waited on before the number-only board takes
 * over.
 *
 * READ FROM THE TOKEN LAYER, not restated: `motion.fadeIn.delay` of
 * ./theme/tokens is `$transition-speed * 12` of style/main.scss and resolves to
 * 1200, which is the interval the terminal overlay already waits before it
 * fades in. DL-MAIN-10.
 */
export const CONTEXT_RESTORE_GRACE_MS = motion.fadeIn.delay;

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
 * @param support The probe result.
 * @param preferences The store holding the effective number-only value.
 * @returns The selected mode, and which input put it in force.
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
 * @param events The engine's emitter.
 * @param traceRenderCommit The `render.commit` boundary wrapper.
 * @param readTurnSpan Reads the turn span open right now. The commit span is
 *   opened as an explicit CHILD of it, not through the implicit-parent stack.
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
 * The reward moment as a caller drives it: what is on the table, and taking
 * one.
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
   * @param relicId Identifier of the chosen relic, which must be on the
   *   table.
   * @returns Whether the relic joined the run.
   */
  choose(relicId: string): boolean;
}

/** What `start` built, so a caller can drive or dismantle it. */
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
   * The screen state machine of AAP Figure 6, with every overlay state's module
   * registered on it.
   *
   * Exposed so the composition is EXERCISABLE: `current()` reports the state in
   * force, `missingMounts()` reports every container that did not resolve, and
   * `send()` drives an edge. A registry that is wired and a registry that is
   * absent look identical from the outside otherwise, which is the failure mode
   * this member exists to make visible. DL-MAIN-12.
   */
  readonly screens: ScreenRouter;

  /** The diagnostics surface, this build's stand-in for a metrics endpoint. */
  readonly diagnostics: DiagnosticsOverlay;

  /** The structured logger every layer reports through. */
  readonly logger: Logger;

  /** The metrics registry every count and timing lands in. */
  readonly metrics: MetricsRegistry;

  /**
   * The Performance-API tracer every span of the input -> engine -> hook bus
   * -> relic handler -> renderer chain, and of the frame callback, is opened
   * on — every module boundary validation gate V8 enumerates. `snapshot()` on
   * it reads the span records without the overlay being opened.
   */
  readonly tracer: Tracer;

  /**
   * The health surface: the five reused capability probes plus the WebGL
   * probe, their roll-up report and the two readiness verdicts. `check`,
   * `report` and `readiness` on it are the readiness probe a static bundle has
   * no port for an orchestrator to poll (AAP 0.7.2.4).
   */
  readonly health: HealthSurface;

  /**
   * The run in progress: its identity, its stage, its relics and its summary,
   * and the only reachable source of the run seed.
   */
  readonly run: RunController;

  /** The reward moment: the offer a cleared stage earned, and taking one. */
  readonly rewards: RewardSurface;

  /**
   * The screen flow of AAP Figure 6: the state in force, the edges declared out
   * of it, and the six screen modules registered against the seven states.
   *
   * The recorded gameplay gate drives the same states this reports.
   * DL-MAIN-14.
   */
  readonly router: ScreenRouter;

  /**
   * The relic registry: the catalogue, the relics held in pickup order, and the
   * charge budgets a player's `activateRelic` press reads out and never spends.
   * Those budgets are the ones src/engine/hook-bus.ts withdraws from, on each
   * relic's own hook.
   */
  readonly relics: RelicRegistry;

  /**
   * The ONE hook bus: the relics' six-hook dispatcher AND, through
   * `hooks.events`, the shared channel the renderer, the screen flow and the
   * observability layer receive the seven engine events on. AAP Figure 2 and
   * Figure 3. DL-HOOKBUS-06.
   */
  readonly hooks: HookBus;

  /**
   * The accessibility and presentation preferences in force: the surface that
   * decides which renderer draws the board, which palette is applied and
   * whether motion is reduced.
   */
  readonly preferences: PreferenceStore;

  /**
   * The audio layer, which FOLLOWS `preferences` and cannot be written to
   * directly: `setMuted` and `setVolume` on it are refused, and the store is
   * the single owner of both.
   */
  readonly soundEngine: SoundEngine;

  /**
   * Discards the run in force and starts a FRESH one: a new run identifier, a
   * new seed, substreams rebuilt at cursor zero, no relics, stage 0, and a new
   * board. `start` resumes; this replaces.
   *
   * @param seed Seed to play, reduced by `normalizeEnteredSeed`. Originated
   *   when absent.
   * @returns The seed the new run is played under.
   */
  readonly startNewRun: (seed?: string) => string;

  /** Stops the frame loop and removes every listener that was bound. */
  readonly dispose: () => void;
}

/**
 * `RngStreams` whose backing instance can be replaced, so a fresh run's
 * substreams reach every holder of a reference without the engine being
 * rebuilt. `seed` is a getter, so it reports the seed of the run in force.
 * DL-MAIN-09.
 */
interface SwappableRngStreams extends RngStreams {
  /** Replaces the backing instance. Later draws come from `next`. */
  replace(next: RngStreams): void;
}

/**
 * Builds the facade over an initial set of substreams.
 *
 * @param initial Substreams the facade delegates to until it is replaced.
 * @returns The facade.
 */
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

/**
 * Builds and starts the application.
 *
 * @param ownerDocument Document to mount into.
 * @returns The composed application.
 */
export function start(ownerDocument: Document): Application {
  // A caller composing the application supersedes the automatic boot deferred
  // by `bootstrap()`. The boot's own call is exempt. DL-MAIN-09.
  cancelPendingBoot();

  const config = createDefaultRulesConfig();

  /**
   * The rules this page composed, before any relic wrote to them.
   *
   * `config` is one mutable object every collaborator holds a reference to, and
   * `src/engine/board-effects.ts` writes `boardSize`, `merge.canMerge` and
   * `spawn.weights` through it as relic effects are applied. A run boundary
   * restores this baseline through `restoreRulesConfig`, so a shrunk board, a
   * widened merge rule or a reversed spawn distribution cannot be inherited by
   * the next run. Taken here rather than derived from the defaults at the
   * boundary, so a caller that composes over its own rules gets its own rules
   * back. DL-DEFAULT-04, DL-MAIN-06.
   */
  const baselineConfig = snapshotRulesConfig(config);
  const stages = createDefaultStageConfig();

  // Storage is composed FIRST, ahead of the observability layer. Failures
  // raised before that layer exists are held here and replayed when its sink is
  // attached. DL-MAIN-06.
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

  // The run's identity: the seed it plays and the instance that plays it. Read
  // from the stored envelope where one is readable, and originated only where
  // there is nothing to continue. DL-MAIN-06.
  const identity: RunIdentity = resolveRunIdentity({
    storage,
    createToken: createRunToken,
  });

  // The one derivation of the run correlation identifier, from the seed and the
  // run instance. Every module that reports receives it; none derives one of
  // its own, and neither the seed nor the run identifier is carried into a
  // report — the run identifier is the KEY every segment of the identifier is
  // derived under, so an export carries the value and not the key. No engine
  // behaviour reads it. DL-LOG-09.
  //
  // Held in a SCOPE, not a constant. `readCorrelationId` is what every module
  // receives; `rotateCorrelation` below is its one writer — of this scope
  // and, through `Logger.setCorrelationId`, of the logger the metrics
  // registry, the tracer and the health surface read theirs from. DL-MAIN-06,
  // DL-LOG-01.
  let runCorrelationId = deriveCorrelationId(identity.seed, identity.runId);

  /** Reads the correlation identifier of the run in force. */
  const readCorrelationId = (): CorrelationId => runCorrelationId;

  // The structured logger and the metrics registry.
  const logger = createLogger({
    correlationId: runCorrelationId,
    subsystem: 'main',
    consoleOutput: true,
  });

  // The logger is handed to the registry, so its own internal reports carry the
  // same correlation identifier.
  const metrics = createMetricsRegistry({ logger });
  const reporter = createSink(logger, metrics);

  // The ONE tracer of the running application.
  const tracer = createTracer({
    logger,
    metrics,

    // The READER: the tracer's span identifiers and its snapshot follow the
    // rotation, not the identifier this page loaded with.
    correlationId: readCorrelationId,
  });

  // The module-boundary wrappers, one per boundary of the input -> engine ->
  // hook bus -> relic handler -> renderer chain. Injected into the layers that
  // use them; no layer below src/observability imports a tracer.
  const boundaries: BoundaryTracing = createBoundaryTracing(tracer);

  /**
   * The WebGL probe result, once taken. A slot: the health surface is composed
   * before the probe runs, and the probe runs once per session.
   */
  let webglProbeResult: WebGLProbeView | undefined;

  /**
   * The WebGL failure the board is living with right now, or `null` while the
   * capability the boot probe found is the one in force. A slot, filled once
   * the renderer exists and answering `null` until then: `probeWebGLSupport`
   * hands every later caller its startup result, so a surface reading that
   * alone reports the capability the machine had at BOOT for the rest of the
   * session.
   */
  let readLiveWebGLFailure: () => string | null = (): string | null => null;

  // The health surface: the five capability probes the vanilla sources
  // performed and reported nowhere, plus the WebGL probe the Three.js renderer
  // introduced. The live storage manager is handed over, so its
  // construction-time probe result is read instead of a second write-and-remove
  // round trip. `webglProbe` hands back the ONE probe result taken below; the
  // slot is read at call time and falls through to the module's own probe until
  // that result exists. DL-HEALTH-02.
  const health = createHealthSurface({
    logger,
    metrics,
    storage,

    // The pointer family is PROBED, not inferred from whether the input
    // manager is listening: js/keyboard_input_manager.js L4-L13 probed the
    // platform.
    pointerProbe: detectPointerEventFamily,
    webglProbe: (): WebGLProbeView => {
      const probed = webglProbeResult ?? probeWebGLSupport();

      // The live verdict, which the readiness roll-up acts on: a context taken
      // away, one whose resources could not be rebuilt, a 2.5D board that
      // never mounted, and a forced number-only board are each a WebGL failure
      // NOW, whatever the boot probe found.
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
   * produced, so every renderer transition after boot — a fallback, a mode
   * switch, a lost context, a rebuild that failed — calls this, and the
   * diagnostics panel and every exported snapshot describe the board drawing
   * now.
   *
   * Nothing is probed that was not probed at boot: the WebGL result is the held
   * one plus the live verdict above, and the Web Storage result is the
   * manager's cached state, so this takes no second context and makes no second
   * write.
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
    // A REFUSAL IS NOT A FAILURE. `StorageFailure.thrown` is absent exactly when
    // the adapter declined an operation itself rather than a store raising —
    // an unowned key, a value over its ceiling, a payload the reading module's
    // own limit rejected. Those are the guard working, so they are reported at
    // warning and worded as refusals, which also matches the run-state loader's
    // own refusal record. A store that threw keeps error. DL-STORE-07.
    const refused = !('thrown' in failure);

    // ONE ATTEMPT, ONE AUTHORITATIVE RECORD. A write to the run-state key is
    // reported by the layer ABOVE this one as well: src/run/run-state-store.ts
    // holds the envelope, its serialised size and the error, and reports that
    // attempt through `onWriteFailed`, which the run sink logs at error. This
    // record is the physical CAUSE of the same event, so for that one key and
    // operation it is filed at debug rather than raising a second error record
    // beside the authoritative one. Every other key and operation is unchanged.
    // DL-STORE-08.
    const supersededByRunState =
      failure.key === RUN_STATE_KEY && failure.operation === 'write';

    const detail: RenderDetail = Object.freeze({
      operation: failure.operation,
      key: failure.key,
      strategy: failure.strategy,
      quota: failure.error.quota,
      refused,
      reportedBy: supersededByRunState ? 'run/state' : STORAGE_SUBSYSTEM,
    });

    if (supersededByRunState) {
      // Emitted through the logger's own channel, because the diagnostic
      // channel of `createSink` folds every level below a warning onto `info`
      // and this record needs a true `debug` level to sit beneath the
      // authoritative one at the default level. The subsystem, message and
      // fields are the ones the sink would have written.
      logger
        .child(STORAGE_SUBSYSTEM)
        .failure(
          'debug',
          `Storage ${failure.operation} failed for ${failure.key}.`,
          { fields: detail, thrown: failure.error },
        );

      return;
    }

    reporter.onDiagnostic({
      level: refused ? 'warning' : 'error',
      source: STORAGE_SUBSYSTEM,
      message: refused
        ? `Storage ${failure.operation} refused for ${failure.key}.`
        : `Storage ${failure.operation} failed for ${failure.key}.`,
      detail,
      error: failure.error,
    });
  };

  for (const failure of earlyStorageFailures) {
    reportStorageFailure(failure);
  }

  earlyStorageFailures.length = 0;

  logger.info('Run starting.', {
    resumed: identity.resumed,
    boardSize: config.boardSize,
  });

  // The one sink the hook bus, the relic registry and the engine all report
  // through.
  const engineReporter = createEngineSink(reporter, metrics);

  // The hook bus, built HERE rather than inside the engine. The relic registry
  // takes it and is composed before the run controller, whose resumed envelope
  // hands its relics back through `RelicRegistryPort.restoreRelics`. The engine
  // takes this same instance below, so there is exactly one bus.
  //
  // The two boundary wrappers are injected here: `hook.dispatch` spans each
  // dispatch and `relic.handler` spans each handler invocation, both attributed
  // to the hook. `BoundaryTracing` satisfies `HookDispatchTracing`
  // structurally, so src/engine imports nothing from src/observability.
  // DL-HOOKBUS-05.

  const hooks: HookBus = createHookBus({
    correlationId: readCorrelationId,
    reporter: engineReporter,
    tracing: boundaries,
  });

  // The relic registry: the sixteen-relic catalogue, pickup order, charge
  // accounting and the hook subscriptions that make a held relic fire (AAP
  // 0.6.2.5, R3). The one construction of it.
  //
  // No `catalogue` is supplied. The default is `RELIC_CATALOGUE` as it stands,
  // already frozen at every level by the module that owns it; supplying it
  // takes the injected path, which adopts a fresh copy of every declaration and
  // would replace the array the seeded reward snapshots resolve their drawn
  // indices against. DL-REGISTRY-01.
  const registry = new RelicRegistry({
    bus: hooks,
    correlationId: readCorrelationId,
    reporter: engineReporter,
  });

  /**
   * Projects a catalogue relic as a reward card.
   *
   * The hook names are read off the relic's own `hooks` table in `HOOK_NAMES`
   * order, so the badges a card shows are the hooks the relic actually binds
   * and their order does not depend on how the table was written.
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

  // Assigned below, once the run's seed and cursors are known.
  let streams: RngStreams | null = null;

  /**
   * Closes the traced stage span of a run that has ENDED, or does nothing
   * before the tracing subscription exists.
   *
   * A slot, filled once `attachEngineTracing` has run: the run sink is composed
   * before the tracer's subscription and the report it reacts to cannot arrive
   * until a run has been played, which is after both.
   */
  let settleTracedStage: (outcome: string) => void = (): void => undefined;

  // The run: the versioned envelope's load, save and clear, the stage and relic
  // slices of every commit, and stage advancement. Composed before the
  // substreams, which are built from the seed and cursors it supplies.
  const runSink = createRunSink(reporter, {
    onRunEnded: (outcome): void => {
      settleTracedStage(outcome);
    },
  });

  /**
   * The substreams in force. Held rather than captured: a new run REPLACES
   * them. Every reader below goes through this holder.
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
   * exists. `run.begin()` publishes a run scope before the facade is built,
   * from the loaded run's own seed, so the callback cannot close over it and is
   * absent until then.
   */
  let replaceSwappableStreams: ((next: RngStreams) => void) | undefined;

  /**
   * Rotates the one correlation scope every reporting module reads.
   *
   * One write, which every observer follows: the scope itself for the engine,
   * the emitter, the hook bus, the relic registry, the run controller and the
   * run-state store, and `Logger.setCorrelationId` for the logger and every
   * logger sharing its state, which is where the metrics registry, the tracer
   * and the health surface read theirs from. A log record already emitted keeps
   * the identifier it was emitted under. DL-MAIN-06.
   *
   * AND THE SCOPE IS A PARTITION, not a relabelling. The registry, the tracer
   * and the health surface all read the identifier through that one getter, so
   * an aggregate still held across a rotation would be REPORTED under the new
   * run while describing the previous one: a series total, a span ring, the
   * commit and anomaly counters, the frame statistics and the held health
   * report each carried the run before. All three are therefore returned to
   * their start here — the registry keeps its families, their kinds, their help
   * text and their bucket layouts, the tracer keeps its configuration, and the
   * health surface keeps its probes and its subscribers, so what is discarded
   * is one run's readings and not any capability. `health.check()` is not
   * called here: dropping the held report is what makes the next reader
   * re-probe under the identifier it will carry. DL-MAIN-28.
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

    metrics.reset();
    tracer.reset();

    const forgotten = health.forget();

    // COUNTED AFTER THE PARTITION, so the count lands in the scope it opens
    // rather than in the one it closes, where the reset would have wiped it.
    // The identifier it rotated FROM travels in the detail and in the record
    // below, which is where the trail across a page load lives: the logger's
    // own records are not partitioned, and each keeps the identifier it was
    // emitted under.
    reporter.onCount({
      name: 'observability.correlation.rotated',
      value: 1,
      detail: Object.freeze({ previous, correlationId: next }),
    });

    logger.debug('Telemetry partitioned at the correlation boundary.', {
      previous,
      correlationId: next,
      healthReportDropped: forgotten,
    });
  };

  /**
   * Rebuilds every construct scoped to the run: the substreams, from the run's
   * own seed, and the correlation scope, from its identity. Invoked before the
   * engine opens a board, so the opening spawns come from the new sequence and
   * the opening `stage:start` and `state:commit` are attributed to the new
   * run.
   */
  const adoptRunScope = (scope: RunScope): void => {
    // The correlation scope, rotated FIRST: the controller publishes this scope
    // before it opens the engine's board, so every report of the new run
    // carries the new identifier from the opening spawns onward. Derived from
    // the scope published rather than from a later query, so the identifier
    // matches the seed and run identifier the envelope carries; at composition
    // time `begin()` publishes the identity `deriveCorrelationId` was already
    // called with above and `rotateCorrelation` short-circuits. DL-MAIN-06.
    rotateCorrelation(deriveCorrelationId(scope.seed, scope.runId));

    const next = createRngStreams(
      scope.seed,
      scope.cursors,
      createRngSink(reporter),
    );

    streamHolder.streams = next;
    replaceSwappableStreams?.(next);

    // NEITHER THE SEED NOR THE RUN IDENTIFIER. A count's detail becomes metric
    // LABELS, so this pair put the player's own typed seed text and the key its
    // correlation identifier is derived from into the exported snapshot. The
    // rotated identifier the count is recorded under identifies the scope.
    // DL-LOG-09.
    reporter.onCount({
      name: 'run.scope.rebuilt',
      value: 1,
      detail: Object.freeze({ seedProvided: scope.seedProvided }),
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
    // type. Every member delegates on each call rather than being captured, so
    // a charge a handler spent and a state slot a handler advanced are read at
    // write time.
    //
    // One member per name `RelicRegistryPort` of src/run/run-controller.ts
    // actually reads. The alternative spellings it also accepts —
    // `activateRelic`, `pickUp`, `resolveRelic`, `knowsRelic` and `serialize` —
    // are left off: it resolves `pickUpRelic ?? activateRelic`,
    // `persistedEntry ?? resolveRelic`, `knowsRelic ?? knows` and
    // `serialize ?? snapshotRelics`, so a second spelling is a second
    // implementation of one step that can never run. DL-MAIN-09.
    //
    // NO CHARGE-SPENDING MEMBER IS PASSED, and the port no longer names one:
    // `RelicRegistry.activate()` is reached by src/engine/hook-bus.ts on the
    // dispatch that ran a handler, so a charge is spent by the effect that used
    // it and by nothing else. DL-RUNCTL-11.
    relics: {
      snapshotRelics: (): readonly PersistedRelic[] => registry.serialize(),
      ownedRelicIds: (): readonly string[] => registry.ownedIds(),
      restoreRelics: (relics): void => {
        registry.restore(relics);
      },
      knows: (relicId): boolean => registry.knows(relicId),

      // The confirmation reader: `resolveReward` appends the entry the pickup
      // produced and then asks this whether the live registry agrees,
      // withdrawing the append where it does not.
      holdsRelic: (relicId): boolean => registry.has(relicId),

      // The entry-returning pickup, so the persisted record is what the
      // registry accepted.
      pickUpRelic: (relicId): PersistedRelic | null => {
        if (registry.pickUp(relicId) === undefined) {
          return null;
        }

        return registry.persistedEntry(relicId);
      },
      persistedEntry: (relicId): PersistedRelic | null =>
        registry.persistedEntry(relicId),
    },

    // The seeded draw. Consumes the run's `relic-draw` and `rarity-weight`
    // substreams, so one seed and one move list yield one offer sequence (AAP
    // V2, Contract 6).
    rewards: {
      draw: ({ count, ownedIds }): readonly RewardOffer[] => {
        if (streams === null) {
          // Unreachable in composition order: a reward follows a cleared
          // stage, which follows the engine, which follows the substreams.
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

      // The LOAD-PATH counterpart of `draw`, and the reason a reload shows the
      // same three cards. `drawRelicOffers` is deliberately not reached here:
      // it would move the `relic-draw` and `rarity-weight` cursors a second
      // time for a round the interrupted run already paid for, so the same
      // seed and move list would stop yielding the same offer sequence
      // (AAP V2, Contract 6). The stored round carries identifiers alone, so
      // the cards are rebuilt by resolving those against the catalogue.
      //
      // An identifier the catalogue no longer declares is dropped rather than
      // raised on, which leaves the rest of the round restorable.
      // DL-RUNCTL-08.
      project: (relicIds): readonly RewardOffer[] => {
        const pool = registry.catalogue();
        const offers: RewardOffer[] = [];

        for (const relicId of relicIds) {
          const relic = pool.find((entry): boolean => entry.id === relicId);

          if (relic === undefined) {
            reporter.onCount({
              name: 'run.reward.project_unknown',
              value: 1,
              detail: Object.freeze({ relicId }),
            });

            continue;
          }

          offers.push(asRewardOffer(relic));
        }

        return Object.freeze(offers);
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

  // Built from the run rather than from the identity: `seed()` is the seed of
  // the envelope in force and `cursors()` is where that envelope left each
  // substream, and a fresh run yields zeros so its opening spawns are taken
  // rather than skipped.
  //
  // One backing instance, reached two ways. `streamHolder` is the slot
  // `adoptRunScope` replaces when a new run mints a new seed, and the facade
  // below is what the reward draw and the diagnostics surface hold. Both are
  // updated by `adoptRunScope` and nowhere else. DL-RNG-05.
  streamHolder.streams = createRngStreams(
    run.seed(),
    run.cursors(),
    createRngSink(reporter),
  );

  const swappableStreams = createSwappableRngStreams(streamHolder.streams);

  // Bound now that the facade exists. `run.begin()` above publishes a scope
  // before there is a facade to replace, so the callback reaches it through a
  // slot rather than closing over it.
  replaceSwappableStreams = (next: RngStreams): void => {
    swappableStreams.replace(next);
  };

  streams = swappableStreams;

  const engine = new Engine({
    config,

    // Read through the holder on every draw, so a run started mid-session
    // draws from the substreams that run's seed produced.
    streams: {
      get seed(): string {
        return streamHolder.streams.seed;
      },
      stream: (name) => streamHolder.streams.stream(name),
      snapshotCursors: () => streamHolder.streams.snapshotCursors(),
    },
    storage,

    // The bus the registry is already registered with, in place of the one the
    // engine builds for itself. A relic held from a resumed envelope fires from
    // the first dispatch of this engine, and every dispatch is spanned.
    hooks,
    correlationId: readCorrelationId,
    reporter: engineReporter,

    // The stage and relic slices of every commit. Read through the controller
    // on each call rather than captured, so a stage that advances and a relic
    // that spends a charge are visible on the next commit.
    stageContext: () => run.stageContext(),
    relicContext: () => run.relicContext(),

    // The resolution span is INJECTED, not wrapped from out here: the engine
    // runs it around the traversal walk alone, so it nests inside the turn
    // span, which opens on the `move:before` the engine emits from inside
    // `move()`. DL-HOOKBUS-05.
    tracing: { traceMoveResolution: boundaries.traceMoveResolution },
  });

  // The relics an adopted envelope carried, re-hydrated onto the engine's bus
  // before it has dispatched anything, so a held relic fires from the first
  // dispatch.
  run.restoreHeldRelics();

  // The frame callback is the system's only asynchronous boundary.
  const frameLifecycle = tracer.frameLifecycleHooks();
  const loop = createRenderLoop({
    reporter,
    autoStopWhenIdle: true,
    onFrameBegin: frameLifecycle.onFrameBegin,
    onFrameEnd: frameLifecycle.onFrameEnd,
  });

  // The preference store, composed BEFORE the renderer, whose selection reads
  // the one effective number-only value it combines the choice and the force
  // into.
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

  // Pushed into the render layer's store and reflected onto the document
  // element before any renderer is built, so the first frame already honours
  // it.
  setReducedMotionOverride(preferences.reducedMotionOverride());
  reflectMotion(queryReducedMotion());

  // The WebGL capability probe (implicit requirement I6). Consulted once,
  // before any renderer is built, and its result pushed into the store as a
  // FORCE, so number-only mode has one effective value and the settings surface
  // can refuse to turn it off on a machine that cannot draw without it. The
  // probe holds its result, so the readiness below reads the same one.
  // DL-WEBGL-02.
  const support = probeWebGLSupport(reporter);

  // Handed to the health surface, which reads the slot rather than probing
  // again.
  webglProbeResult = support;

  if (!support.supported) {
    preferences.forceNumberOnlyMode(
      `no WebGL context is available (${support.level})`,
    );
  }

  // READINESS IS RESOLVED BEFORE ANYTHING IS SELECTED OR MOUNTED. The health
  // surface owns the renderer and storage verdicts, and both inputs it derives
  // them from are already in hand here: the WebGL probe result is in the slot
  // above and the live storage manager's own probe ran at its construction. It
  // was resolved after the renderer had been selected AND mounted, so the
  // verdict that decides whether a WebGL board may be mounted at all was
  // consulted once that decision had already been taken.
  //
  // This call writes the six per-check records and the six status gauges,
  // once, in composition order, and `readiness` below reads the report it
  // leaves. `refreshHealth` is silent until it has run, so every later
  // renderer transition re-reports against this baseline. DL-MAIN-27.
  const bootHealth = health.check();

  logger.info('Health checked.', {
    status: bootHealth.status,
    passed: bootHealth.counts.pass,
    failed: bootHealth.counts.fail,
    notApplicable: bootHealth.counts['not-applicable'],
  });

  // The two consequential verdicts: whether a WebGL board may be mounted at
  // all, and whether the run persists or is ephemeral. Logged once, here,
  // before the renderer exists.
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
  });

  // THE VERDICT DRIVES THE SELECTION, not the probe result alone. The health
  // check reads the probe through the slot above and then applies its own
  // judgement, so a capability the PROBE reported and the SURFACE refused — a
  // check that failed for a reason the probe does not express — forces the
  // number-only board here rather than being contradicted by a mounted 2.5D
  // one.
  //
  // Guarded on the probe having reported support, so the reason the store
  // carries is the most specific one available: a probe that found no context
  // has already forced the mode above, naming the level it found, and that
  // reason is what the settings surface shows for refusing to turn the mode
  // off.
  if (support.supported && readiness.requiresNumberOnlyFallback) {
    preferences.forceNumberOnlyMode(
      `readiness withheld the 3D board (webgl check ${readiness.webglStatus})`,
    );
  }

  // The parallel accessibility board of index.html L70: the focusable,
  // labelled per-cell counterparts beside the canvas, which is `aria-hidden`.
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
   * Serves the number-only board once the wait for the context has run out.
   * Does nothing where the context HAS come back or the number-only board is
   * already in force.
   *
   * The swap goes through the preference store, which `applyRenderMode`
   * follows: that path destroys the old renderer, mounts the new one,
   * subscribes it and replays the last commit into it. DL-MAIN-10.
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

    // Announced assertively: the board the player is reading has been replaced
    // by a different one.
    announcer.announceText(
      'The 3D board is unavailable. The number board is now in use.',
      ASSERTIVE_POLARITY,
    );
  };

  /**
   * Starts the bounded wait after the browser has taken the context away. The
   * renderer has already suspended drawing and resumes by itself where the
   * context is restored; this adds an end to the wait.
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

    refreshHealth('a lost WebGL context');
  };

  /**
   * Ends the bounded wait, but ONLY for a restoration that rebuilt the board:
   * a restored context is a new context, and the renderer's rebuild of every
   * resource that context owns can fail.
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

  /**
   * The cell the board was last being READ at, carried across a renderer swap.
   *
   * The two surfaces are separate objects with separate lattices, and a swap
   * destroys the outgoing one, so nothing crosses between them on its own: a
   * player reading row 3 who turned number-only mode off and on again came back
   * to the top-left corner. Recorded from the outgoing renderer in
   * `applyRenderMode` below, and handed to a number-only renderer as the cell
   * its first lattice opens on. Left as it stands where the outgoing renderer
   * keeps no position of its own, which is how a `three -> number-only` swap
   * resumes the cell the previous number-only session ended on.
   * DL-FOCUS-04, DL-MAIN-24.
   */
  let boardReadingCell: BoardFocus | null = null;

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

      // Where the tab stop opens, not a focus placement: a swap made from the
      // settings dialog leaves focus in that dialog, and moving it onto the
      // board would be a steal.
      initialCell: boardReadingCell,
    });

  const buildRenderer = (mode: BoardRenderMode): BoardRenderer => {
    if (mode === 'three') {
      // Guarded at the factory as well as inside the mount: the mount unwinds
      // its own failures and reports `mounted: false`, which the fallback below
      // acts on; this covers the factory raising before a mount is attempted.
      try {
        return createThreeRenderer({
          canvas: ownerDocument.querySelector(SELECTORS.boardCanvas),
          numberOnlyHost: ownerDocument.querySelector(
            SELECTORS.boardNumberOnly,
          ),
          parallelBoard: parallelBoardHost,
          parallelBoardLayer: parallelBoard,
          // Handed in so the board is generated at mount rather than at the
          // first commit: the board is present before the first turn resolves.
          config,
          ownerDocument,
          reporter,
          onWork: onRendererWork,

          // The bounded restoration window. The renderer parks itself on a
          // loss and rebuilds on a restore; these two callbacks add the end of
          // the wait, which it cannot decide for itself.
          onContextLost,
          onContextRestored,
        });
      } catch (error: unknown) {
        // The active mode is made authoritative BEFORE the fallback is
        // returned. `selection` is what every later reader consults for the
        // mode that is drawing: the mounted-state guard in
        // `fallBackToNumberOnly` below, the live context-loss reader handed to
        // the health surface, the context-restoration wait and the settings
        // surface. The preference is forced as well as the selection
        // recomputed, which is the same pair `fallBackToNumberOnly` applies for
        // a mount that failed.
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

          // The total reduction, shared with src/render/ and with the engine
          // sink above: reading `name`, `message` or `String(value)` here lets
          // a hostile getter or a throwing `toString` raise from inside the
          // catch that contains it. `thrown` carries the value itself for a
          // sink that keeps more than the two-field summary.
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
   * Falls back to the number-only board where the 2.5D one did not mount: the
   * probe reporting a context available is not the same as one being acquired.
   *
   * @param reason Why the fallback was applied, carried into the store.
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

  // The live answer, read through `selection` and `renderer` rather than
  // captured from them, so a renderer swapped mid-session is the one consulted.
  // Four states report a failure: a context taken away, a restored context
  // whose resources could not be rebuilt, a 2.5D board selected but not
  // mounted, and a number-only board FORCED in place of one. A number-only
  // board the player chose reports nothing.
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

  // THE LIVE VERDICT NOW THAT A BOARD IS DRAWING. `readLiveWebGLFailure` above
  // is filled, so this re-reading is the first that can tell a mounted 2.5D
  // board from one that was selected and did not mount, and it is what the
  // diagnostics panel and every exported snapshot answer from. Nothing is
  // probed a second time: the WebGL result is the boot probe plus the live
  // verdict, and the storage result is the manager's cached state.
  refreshHealth('the renderer was selected and mounted');

  const mounted = health.readiness();

  // Counted as well as logged, so boot readiness reaches the metrics surface
  // beside the renderer it selected. Read from the refreshed verdicts, so the
  // count describes the board that is drawing rather than the one the boot
  // probe alone predicted.
  reporter.onCount({
    name: 'health.readiness',
    value: 1,
    detail: Object.freeze({
      ready: mounted.ready,
      renderer: mounted.renderer,
      mayMountWebGLRenderer: mounted.mayMountWebGLRenderer,
      requiresNumberOnlyFallback: mounted.requiresNumberOnlyFallback,
      storage: mounted.storage,
      selected: selection.mode,
    }),
  });

  // The turn and stage spans, subscribed to the ENGINE's own emitter through
  // `on` alone, and deliberately not to the bus channel below: the turn span
  // opens on `move:before` and closes on `state:commit`, so it has to bracket
  // the relay rather than sit inside it. DL-MAIN-12.
  const stopEngineTracing: EngineTracingSubscription = attachEngineTracing(
    engine.events,
    tracer,
  );

  // The slot declared beside the run sink is filled: from here a finished run
  // closes the span of the stage it was playing. `unwound` is the outcome of a
  // stage that ended without resolving, which is what a loss and an explicit
  // end-run leave behind, and the run outcome that ended it travels on the
  // closing record. DL-MAIN-29.
  settleTracedStage = (outcome): void => {
    stopEngineTracing.settleStage(SPAN_OUTCOMES.unwound, {
      [SPAN_ATTRIBUTES.action]: outcome,
    });
  };

  // The RNG cursor fold, on the ENGINE's own emitter beside the tracing
  // subscription: `rng_draws_total` is the one metric family fed by a READING
  // of the run rather than by a report, and the seeded snapshot suite attaches
  // the same helper, so the graph it proves non-interference for is this one.
  // DL-MAIN-30.
  const stopRngCursorMetrics = attachRngCursorMetrics(
    engine.events,
    metrics,
    () => streamHolder.streams.snapshotCursors(),
  );

  // THE SHARED BUS BECOMES THE PEERS' CHANNEL. `attachEvents` relays the
  // engine's seven events onto `hooks.events`, and every peer below — the
  // renderer, the HUD, the announcer, the sound engine, the screen router and
  // the engine-event metrics — subscribes there rather than to `engine.events`,
  // so relics and peers share ONE bus, which is AAP Figure 2 and Figure 3.
  // Attached HERE, before `reattachCommitClosing()`, so every peer runs inside
  // the turn span. DL-HOOKBUS-06, DL-MAIN-12.
  const stopEventRelay = hooks.attachEvents(engine.events);

  // Subscribed through the traced bus channel, so every commit the renderer
  // reconciles is one `render.commit` span inside the turn span that produced
  // it.
  const renderEvents = createTracedRenderEvents(
    hooks.events,
    boundaries.traceRenderCommit,
    stopEngineTracing.currentTurnSpan,
  );

  let stopRendering = renderer.subscribe(renderEvents);

  // Moved to the END of the registration order, after the renderer's own commit
  // listener: the tracing subscription's `state:commit` listener closes the
  // turn span, and listeners run in registration order.
  stopEngineTracing.reattachCommitClosing();
  const frameSubscription = loop.addFrameCallback((context): boolean => {
    // Inter-frame cadence, under its own name. `FrameContext.delta` is the gap
    // since the previous frame, clamped at `maxDelta` and zero on the first
    // frame; occupancy is a different quantity, measured by the loop and
    // recorded once through the tracer's frame hooks above.
    reporter.onTiming({
      name: FRAME_INTERVAL_TIMING,
      durationMs: context.delta,
    });

    return renderer.frame(context);
  });

  /**
   * The last state the engine committed, retained so a renderer built mid-run
   * is given the board at once. `state:commit` carries the live grid, which is
   * unchanged between turns, so a replay of it is a full reconciliation.
   */
  let lastCommit: StateCommitEvent | null = null;
  const stopCommitCapture = hooks.events.on(
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
   * number-only mode is reached and left without a reload. Re-entry is guarded:
   * the fallback path writes a preference of its own.
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

      // READ BEFORE THE TEARDOWN, and kept where the outgoing renderer has no
      // position to report, so the coordinate survives a round trip through the
      // 2.5D board. DL-FOCUS-04.
      boardReadingCell = renderer.focusedCell?.() ?? boardReadingCell;

      renderer.destroy();
      selection = next;
      renderer = buildRenderer(next.mode);
      fallBackToNumberOnly('the WebGL board could not be remounted');
      stopRendering = renderer.subscribe(renderEvents);

      // The new renderer's commit listener is now the last registration, so
      // the turn-closing listener is moved after it again.
      stopEngineTracing.reattachCommitClosing();

      if (lastCommit !== null) {
        renderer.render(lastCommit);
      }

      onRendererWork();
      reportSelection();

      refreshHealth(`a switch to the ${next.mode} board`);
    } finally {
      switchingRenderer = false;
    }
  };

  /**
   * Reads one catalogue definition by identifier.
   *
   * @param relicId Identifier to resolve.
   * @returns The definition, or `undefined` where the catalogue carries
   *   none.
   */
  const relicDefinition = (
    relicId: string,
  ): { name: string; rarity: string; charges?: number } | undefined =>
    registry.catalogue().find((relic) => relic.id === relicId);

  /**
   * Names a relic, falling back to its identifier.
   *
   * @param relicId Identifier to name.
   * @returns The catalogue's name, or the identifier.
   */
  const relicName = (relicId: string): string =>
    relicDefinition(relicId)?.name ?? relicId;

  /**
   * The catalogue's own description of a relic, for the tray read-out.
   *
   * @param relicId Identifier to describe.
   * @returns The description, or the empty string where the catalogue carries
   *   none.
   */
  const relicDescription = (relicId: string): string =>
    registry.catalogue().find((relic) => relic.id === relicId)?.description ??
    '';

  // The HUD is mounted BESIDE the renderer, not inside it: the score outlets, the
  // rising score delta and the terminal overlay have one owner, and that owner
  // subscribes to `state:commit` directly. DL-HUD-01.
  const hud = createHud({
    scoreContainer: ownerDocument.querySelector<HTMLElement>(SELECTORS.score),
    bestContainer: ownerDocument.querySelector<HTMLElement>(SELECTORS.best),
    messageContainer: ownerDocument.querySelector(SELECTORS.message),

    // The in-run status outlets index.html L47-L49 declares.
    hudContainer: ownerDocument.querySelector(SELECTORS.hudGroup),
    stageContainer: ownerDocument.querySelector(SELECTORS.hudStage),
    relicTrayContainer: ownerDocument.querySelector(SELECTORS.relicTray),

    // Focus placement opted out of: the router places focus for every state,
    // `SCREEN_INITIAL_FOCUS.stage` names the board's own tab stop under either
    // renderer, and the entry line reaches the router through this module's
    // `announcement()`. DL-HUD-11, DL-HUD-12, DL-ROUTER-11, DL-FOCUS-04.
    focusContainer: null,

    // NO TRAY CALLBACK IS PASSED. src/ui/screens/hud.ts hosts the read-only
    // relic tray control but never binds it: `mountOnScreenControls` is
    // the single owner of every element-to-action binding, and `activateRelic`
    // is one of its indexed actions, so the tray press arrives through the
    // `activateRelic` subscription below rather than through the HUD. The tray
    // is in pickup order, which is the order the registry keeps, so the slot
    // the press names is the identifier's position in it. DL-MAIN-09,
    // DL-CONTROL-04.

    relicName: (relicId): string => relicName(relicId),

    // The rarity tier, from the same catalogue definition: style/_hud.scss
    // declares an accent rule per tier. Resolved on each call, so a tray
    // rebuilt for a relic taken later in the run carries its tier too.
    // DL-HUD-04.
    relicRarity: (relicId): string => relicDefinition(relicId)?.rarity ?? '',

    relics: (): readonly ActiveRelic[] => registry.active(),

    // THE TWO FAILURE STATES A PLAYABLE RUN CAN BE IN, both read per write from
    // the module that owns them rather than pushed. `HookBus` marks a relic
    // degraded when one of its handlers throws and then skips it for the rest of
    // its registration, and the registry holds that marking — so without this
    // reader the tray showed an enabled relic that no longer fires. DL-MAIN-31.
    degradedRelics: (): readonly string[] => registry.degradedIds(),

    // The run controller resolves this from each write's own outcome. A refused
    // write leaves the run playable and unsaved, which is a state only the
    // interface can tell the player about. DL-RUNCTL-20.
    persistence: (): 'persistent' | 'ephemeral' => run.persistenceStatus(),

    // Read per write as well: a board-mutating relic changes the dimension
    // mid-run, so nothing derived from it is held.
    boardSize: (): number => config.boardSize,

    // Resolved per announcement: the ONE announcer for the page is constructed
    // below this call.
    announcer: (): LiveRegionAnnouncer | null => announcer,
    document: ownerDocument,
    reporter: createPreferenceSink(reporter),
  });

  // The HUD is a screen module, not an engine subscriber:
  // src/ui/screens/hud.ts subscribes to no emitter and takes a commit through
  // `render`. Registered BEFORE the router's own subscription, so the outlets
  // carry the turn's values before a terminal commit moves the flow off the
  // stage state.
  const stopHud = hooks.events.on('state:commit', (commit): void => {
    hud.render(commit);
  });

  // The ONE announcer for the page, over `#live-region` of index.html L109, and
  // the translator that feeds it from the engine's events. One announcer, not
  // several; the score outlets carry labels rather than `role="status"`.
  // DL-LIVE-01, DL-ANNOUNCE-01.
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
  const stopAnnouncer = engineAnnouncer.subscribe(hooks.events);

  // Preference changes are announced by the announcer itself, from the store's
  // own change notifications, so no second subscriber narrates them.
  const stopAnnouncedPreferences = announcer.observePreferences(preferences);

  // Follows the store rather than the setting, so an operating-system change
  // under the `'system'` setting is reflected too. Reflecting is the only thing
  // done here: the reflected attribute is the one channel the style layer and
  // the on-screen controls both read.
  const stopMotion = subscribeReducedMotion((reduced): void => {
    reflectMotion(reduced);
  });

  const stopPreferences = preferences.subscribe((_snapshot, changed): void => {
    if (changed.includes('numberOnlyMode')) {
      // The board renderer follows the effective value, so number-only mode is
      // reached and left without a reload.
      applyRenderMode();
    }

    if (!changed.includes('reducedMotion')) {
      return;
    }

    // Pushed into the store, which dispatches to every animating member and
    // back through the subscription above; an explicit `reduce` or `allow`
    // therefore reaches the style layer and the controls as well as the
    // canvas.
    setReducedMotionOverride(preferences.reducedMotionOverride());
    reflectMotion(preferences.isReducedMotion());
  });

  // The screen router: the ONE owner of the effective input context, of the
  // screen state machine and of the settings dialog's shown state. Built
  // BEFORE the input manager and the control layer, both of which take
  // `router.context` as their context source. The settings panel is filled
  // in after the input manager exists — its rebinding rows own the keymap —
  // and the router reaches it through the two hooks below. DL-ROUTER-01.
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

  /**
   * The reward screen: the ONE surface an offer is rendered on, and the one
   * owner of the relic cards inside `#screen-reward`.
   *
   * Registered through the router's `screens` table below, so the offer
   * reaches it as the `reward` screen context rather than being built a
   * second time by the router. Focus, the trap and the entry announcement are
   * the router's — `trapFocus` and `announceEntry` are off — and the
   * acquisition announcement stays with the transaction in `takeReward`.
   * DL-MAIN-09, DL-REWARD-12.
   */
  const rewardScreen: RewardScreen = createRewardScreen({
    document: ownerDocument,
    reporter: createPreferenceSink(reporter),

    // NO ANNOUNCER, AND DELIBERATELY SO. With `announceEntry` off this screen's
    // only remaining use of one is the acquisition line, which `takeReward`
    // below already speaks on the transaction that accepted the relic. The
    // screen made that announcement only for a card press, so the same
    // acquisition was spoken twice from a pointer and once from a digit key —
    // the line a player heard depended on how they chose. The entry line is the
    // router's, read from this screen's own `announcement(context)`.
    // DL-REWARD-14, DL-MAIN-09.
    announcer: null,
    preferences,
    focus: focusManager,
    trapFocus: false,
    announceEntry: false,

    // The catalogue this root already holds, so a card renders the relic's own
    // declaration rather than a projection of the offer's plain data.
    resolveRelic: (relicId): Relic | null =>
      registry.catalogue().find((relic) => relic.id === relicId) ?? null,

    // NOT the input manager: a card press reaches the router's one selection
    // path below, which reports the choice into the reward transaction and
    // answers with what the transaction decided. Publishing `selectReward` here
    // as well would apply one press twice. DL-MAIN-09.
    input: null,
    onSelect: (relicId): boolean => router.selectReward(relicId, 'card'),
  });

  /**
   * Whether a run is OPEN: one was resumed by the load, or started since.
   *
   * The router reads it through `isRunActive` as the sole condition on the
   * `runStart -> stage` edge, so a load that resumed nothing holds Run Start
   * until the player begins a run. Written in exactly three places: the boot
   * below, `startNewRun`, and the transition listener that clears it as the run
   * summary is entered. DL-ROUTER-12, DL-MAIN-11.
   */
  let runOpened = false;

  /**
   * The run-start screen: the state a cold load opens on, and the only surface
   * that begins a run.
   *
   * The begin-run press publishes `startRun` carrying the seed the field held,
   * which `stopStartRun` below reaches. `onOpenSettings` renders the settings
   * control INSIDE this screen's trapped subtree, so the dialog is reachable
   * from a state whose background is inert. DL-RUNSTART-07.
   */
  const runStartScreen: RunStartScreen = createRunStartScreen({
    document: ownerDocument,
    reporter: createPreferenceSink(reporter),
    announcer,
    preferences,

    // Resolved per press, so the screen built before the input manager still
    // publishes through the manager that ends up in force.
    input: {
      emit: (event, payload): number => input.emit(event, payload),
    },
    onOpenSettings: (): void => {
      router.openSettings();
    },

    // The seed the run is ACTUALLY played under, read back after the action has
    // been delivered. `RunController.startRun` is the one normaliser — it
    // trims, bounds and case-folds what it is given — and this port is how the
    // screen learns what the text it emitted was reduced to. Left uncomposed,
    // the readback answered nothing, so every reduction was invisible: the
    // field kept the raw text and no notice was written or announced.
    // DL-RUNSTART-03.
    seedInForce: (): string => run.seed(),

    // The router places focus, holds the trap and reads the entry line.
    // DL-ROUTER-11, DL-RUNSTART-08.
    placeFocus: false,
    announceEntry: false,
  });

  /**
   * The stage-clear screen: the state a met goal opens, and the surface whose
   * continue action takes the `stageEnd` edge to the reward offer.
   *
   * THE REWARD IS NOT DRAWN HERE AND NOT SKIPPED HERE. The router stops at this
   * state and the player's own action moves on from it, which is the dwell AAP
   * Figure 6 declares between a cleared stage and its reward. DL-ROUTER-31.
   */
  const stageClearScreen: StageProgressScreen = createStageProgressScreen({
    document: ownerDocument,
    reporter: createPreferenceSink(reporter),
    preferences,

    // The accessors the readouts are measured from, read live.
    run: {
      stageIndex: (): number => run.state().stageIndex,
      stageGoal: (): StageGoal => run.stageGoal(),
      goalProgress: (): number => run.goalProgress(),
    },

    // The measured quantity a highest-tile goal is read against, taken from the
    // last commit rather than from a board scan of the screen's own.
    measurement: {
      highestTileValue: (): number | null =>
        lastCommit === null ? null : readHighestTileValue(lastCommit.board),
    },
    onContinue: (): void => {
      router.send('stageEnd');
    },

    // The announcer is NOT handed over: ./ui/a11y/engine-announcer announces
    // the structured stage clear on `stage:end`, and the router reads this
    // screen's own entry line. DL-STAGECLEAR-05.
    placeFocus: false,
    announceEntry: false,
  });

  /**
   * The terminal screen, serving BOTH the `won` and `gameOver` states, as they
   * share one container.
   *
   * `overlay: null`: ./ui/screens/hud is the one writer of `.game-message`,
   * this screen's panel is the one OPERABLE terminal surface, and the retained
   * overlay stays the visual one. DL-GAMEOVER-02, DL-HUD-01.
   */
  const gameOverScreen: GameOverScreen = createGameOverScreen({
    document: ownerDocument,
    reporter: createPreferenceSink(reporter),
    preferences,
    overlay: null,

    // The router places focus and reads the entry line; the verdict itself is
    // announced by ./ui/a11y/engine-announcer from the commit that terminated.
    // DL-GAMEOVER-10.
    placeFocus: false,
    announce: false,

    // Keep Going CLEARS THE TERMINATION and nothing else: `continuePlaying()`
    // commits, and `readCommit` of src/ui/screen-router.ts takes the one edge
    // out of `won` back to `stage` on the commit that reports the board
    // playable again. Sending the edge here as well would apply it twice.
    onKeepPlaying: (): void => {
      engine.continuePlaying();
    },
    onEndRun: (): void => {
      router.send('endRun');
    },
    onAcknowledge: (): void => {
      router.send('acknowledge');
    },
  });

  /**
   * The run-summary screen: the state both terminal edges land on.
   *
   * `lastSummary()` is offered BEFORE `summary()`: ending a run opens its
   * replacement, and this screen shows the run that ENDED. DL-SUMMARY-12,
   * DL-RUNCTL-08.
   */
  const runSummaryScreen: RunSummaryScreen = createRunSummaryScreen({
    document: ownerDocument,
    reporter: createPreferenceSink(reporter),
    announcer,
    preferences,
    run: {
      lastSummary: (): RunSummary | null => run.lastSummary(),
      summary: (): RunSummary => run.summary(),
      seed: (): string => run.seed(),
      stageIndex: (): number => run.state().stageIndex,
      stageGoal: (): StageGoal => run.stageGoal(),
      relics: (): readonly PersistedRelic[] => registry.serialize(),
    },

    // The live registry, for the charge counts a finished run's relic rows show.
    relics: {
      active: (): readonly ActiveRelic[] => registry.active(),
    },

    // THE EDGE ALONE. `runSummary -> runStart` of AAP Figure 6 returns the
    // player to the run-start screen, where the seed is entered and the run is
    // begun; starting one here would skip that state. DL-SUMMARY-13.
    onNewRun: (): void => {
      router.send('newRun');
    },
    placeFocus: false,
    announceEntry: false,
  });

  /**
   * The seven states and the module that renders each, which is the registry
   * AAP R8 requires the entry point to hand over: without it the router shows a
   * container and calls no lifecycle member, so a delivered screen never
   * renders. `won` and `gameOver` share one module, as they share one
   * container. DL-MAIN-13.
   */
  const screens: ScreenRegistry = Object.freeze({
    runStart: runStartScreen,
    stage: hud,
    stageClear: stageClearScreen,
    reward: rewardScreen,
    won: gameOverScreen,
    gameOver: gameOverScreen,
    runSummary: runSummaryScreen,
  });

  const router = createScreenRouter({
    screens,
    document: ownerDocument,
    reporter: createPreferenceSink(reporter),
    focus: focusManager,
    settingsPanel: settingsPanelHost,
    settingsTrigger: ownerDocument.querySelector(SELECTORS.settingsButton),
    gameRegion: ownerDocument.querySelector(SELECTORS.gameRegion),

    // The WHOLE page shell behind a modal screen: the heading, the game region
    // and the footer all leave the accessibility tree, and `#screen-layer` and
    // `#live-region` — which sit outside it — do not. DL-ROUTER-25.
    backgroundRegions: [ownerDocument.querySelector(SELECTORS.pageShell)],

    onSettingsOpen: (): void => {
      settings?.open();

      // The dialog's own actions become available with it, and `openSettings`
      // becomes unavailable, so the layer is reapplied on both edges.
      // DL-CONTROL-06.
      controlLayer?.refresh();
    },
    onSettingsClose: (): void => {
      settings?.close();
      controlLayer?.refresh();
    },

    rewardScreen: ownerDocument.querySelector(SELECTORS.rewardScreen),

    // Resolved per open: the parallel board's tab stop roves, so the cell
    // carrying `tabindex="0"` is read at the moment the screen goes up. The
    // reward screen registered above engages the trap on that container first
    // and carries the same resolver, so this is the fallback for the trap the
    // router would engage where that module is absent. DL-ROUTER-04.
    rewardRestoreFocusTo: (): Element | null =>
      ownerDocument.querySelector(SELECTORS.boardTabStop),

    // The ONE path a chosen relic is applied through, and the transaction's
    // ANSWER IS RETURNED. `chooseReward` of src/ui/screen-router.ts reads
    // anything other than `false` as acceptance, so a dropped result took the
    // `rewardSelected` edge over a transaction that had rolled the pickup back
    // — an exhausted quota or a refused registry seating left the model without
    // the relic while the router dismissed Reward and exposed Stage.
    // DL-ROUTER-13, DL-MAIN-09.
    onRewardSelect: (relicId): boolean =>
      takeReward(relicId).outcome === 'accepted',

    // Left to src/ui/screens/hud.ts, the sole writer of `.game-message`.
    terminalOverlay: null,

    // Read-only members only. `startRun` is left off — the `startRun` input
    // action below reaches `startNewRun()` — and so are `advanceStage` and
    // `resolveReward`: `RunController.selectReward()` already clears the offer,
    // advances the stage and opens the next board. DL-MAIN-09.
    run: {
      seed: (): string => run.seed(),
      runId: (): string => run.runId(),
      stageIndex: (): number => run.state().stageIndex,
      stageGoal: (): StageGoal => run.stageGoal(),
      goalProgress: (): number => run.goalProgress(),
      relics: (): readonly PersistedRelic[] => registry.serialize(),

      // The offer STANDING, read at the moment the reward state is entered
      // rather than carried on the trigger, so the cards the screen renders are
      // the ones the controller drew — including an offer that survived a
      // reload. DL-ROUTER-14.
      offers: (): readonly RewardCard[] => run.currentOffer(),

      // The FINISHED run first: ending one opens its replacement, so
      // `summary()` alone would describe a run that has not been played. The
      // router keeps `endRun()`'s own return ahead of both. DL-ROUTER-37,
      // DL-RUNCTL-13.
      summary: (): RunSummary => run.lastSummary() ?? run.summary(),
      endRun: (outcome: RunOutcome): RunSummary => run.endRun(outcome),

      // Whether a run is open, which is the sole condition on the
      // `runStart -> stage` edge: a cold load holds `runStart` over a board
      // nobody has started. DL-ROUTER-12.
      isRunActive: (): boolean => runOpened,
    },

    // THE ROUTER IS THE ONE SPEAKER OF AN ENTRY LINE, so the announcer is
    // handed over and every screen module is composed with its own entry
    // announcement off. `announceGameplay` stays at its default of `false`:
    // src/ui/a11y/engine-announcer.ts owns the move, merge, spawn, stage-clear
    // and terminal lines, and each screen supplies the words for its own entry
    // through `announcement()`. DL-ROUTER-11.
    announcer,
    preferences,
  });

  /**
   * Verifies that every routed state has a real screen module, which is what
   * makes the run flow reachable from this entry point.
   *
   * Reported rather than thrown: a missing module degrades one screen and the
   * rest of the page still starts, which is the same posture every mount lookup
   * in this file takes. DL-MAIN-13.
   */
  const unregisteredScreens = router.missingScreens();

  if (unregisteredScreens.length > 0) {
    logger.error('Screen modules are missing from the composition.', {
      screens: unregisteredScreens.join(', '),
    });

    reporter.onCount({
      name: 'ui.composition.screens.missing',
      value: unregisteredScreens.length,
      detail: Object.freeze({ screens: unregisteredScreens.join(', ') }),
    });
  } else {
    logger.info('The screen registry is complete.', {
      screens: Object.keys(screens).length,
    });
  }

  /**
   * Takes one offered relic on, and is the ONE path that does.
   *
   * A card press from the reward screen and a call on the application's own
   * reward surface both arrive here, so the validation, the reporting, the
   * announcement and the re-show of a refused offer cannot differ between them.
   * The controller owns whether the choice is legal; this owns what the page
   * does about the answer.
   *
   * @param relicId Identifier pressed or supplied.
   * @returns The controller's own selection outcome.
   */
  function takeReward(relicId: string): RewardSelection {
    const selection = run.selectReward(relicId, engine);

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
      // A refused press leaves the offer standing, so the flow is brought back
      // to the same three cards.
      presentPendingReward();

      return selection;
    }

    // The structured announcement, not free text: src/ui/a11y/live-region.ts
    // models a relic acquisition as its own kind, composes the copy and holds
    // it in the queue above free text. DL-LIVE-03.
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
   * Follows the standing offer: refreshes the reward screen where that screen is
   * the one showing, and takes the flow to stage clear when an offer stands on a
   * state that is neither.
   *
   * ANNOUNCES NOTHING. The offer's own line belongs to the REWARD STATE'S ENTRY,
   * which the router reads from `announcement(context)` of
   * src/ui/screens/reward.ts at the moment the cards go up and become
   * operable. Announcing here as well spoke the three cards on the commit that
   * drew them — before the state had been entered and while the board was still
   * the surface in force — and then again on entry, so a screen-reader user
   * heard the offer twice and heard it first for cards they could not yet
   * choose. DL-REWARD-14, DL-ROUTER-11.
   *
   * Called after every commit rather than only on the commit that drew the
   * offer, so an offer that survived a reload is followed on the first commit
   * of the resumed run and the screen is never left up over a run that has
   * moved on.
   *
   * THE REWARD STATE IS NOT FORCED FROM HERE. `stage -> stageClear -> reward`
   * of AAP Figure 6 runs one edge per action: the engine's `stage:end` opens
   * Stage Clear and the player's own continue action opens the reward. A
   * pending offer on a state that is neither takes the flow to STAGE CLEAR,
   * which is the legal entry point, so a resumed run reaches its offer through
   * the same two edges a played one does. DL-MAIN-13.
   *
   * @returns Whether the reward screen is showing after the call.
   */
  const presentPendingReward = (): boolean => {
    if (!run.isRewardPending()) {
      return false;
    }

    const cards: readonly RewardCard[] = run.currentOffer();

    if (router.isRewardOpen()) {
      // Already the state in force: the cards are re-rendered in place, so an
      // offer redrawn behind the screen replaces the one on it.
      return router.showReward(cards);
    }

    const screen = router.current();

    if (screen !== 'stageClear' && router.can('stageGoalMet')) {
      router.send('stageGoalMet', { cleared: true });
    }

    return false;
  };

  // The control layer, filled in immediately below. Declared first: the input
  // manager announces every rebind to it, and the layer takes the manager as
  // its own emitter.
  let controlLayer: { refresh(): void } | null = null;

  /**
   * Reads the persisted binding table, or the defaults where none is stored.
   *
   * @returns The table this session starts on.
   */
  const readStoredKeymap = (): Keymap => {
    // `MAX_KEYMAP_PAYLOAD_BYTES` of src/input/keymap.ts is applied to the STORED
    // TEXT, before it is parsed: the predicate measures the raw string and the
    // storage layer refuses an oversized value with nothing parsed, so the byte
    // limit that module declares and documents is the limit actually in force.
    // `deserializeKeymap` receives already-parsed data and cannot measure the
    // text it came from, which is why the bound has to be applied here.
    // DL-KEYMAP-03, DL-MAIN-17.
    const stored = storage.readJson(KEYMAP_KEY, isKeymapPayloadWithinLimit);

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
    // which answers with the defaults for a payload it cannot read. An ABSENT
    // key is the first run, not an unreadable payload, so it never reaches the
    // guard.
    keymap: readStoredKeymap(),

    // The durable half of the manager's single rebind api.
    persistKeymap: (next: Keymap): boolean =>
      storage.writeJson(KEYMAP_KEY, serializeKeymap(next)),

    // The ONE follower of a rebind: the generated controls carry each action's
    // key in their accessible names, so they re-read the table the manager
    // holds. The manager's own keydown listener reads that table directly.
    onKeymapChange: (): void => {
      controlLayer?.refresh();
    },

    // The tracer is supplied here and nowhere else in the input layer: the
    // manager is the one place a dispatch is walked, and it opens the
    // `input.dispatch` span around that whole walk, naming the event in the
    // span's `action` attribute. The on-screen controls and the touch layer
    // dispatch through this manager, so that span already covers them.
    reporter: createInputSink(reporter, tracer),
  });

  /** Every relic slot src/input/keymap.ts binds a key for, in slot order. */
  const RELIC_SLOTS: readonly number[] = Object.freeze(
    Array.from({ length: RELIC_SLOT_COUNT }, (_unused, slot): number => slot),
  );

  /** Every offer slot src/input/keymap.ts binds a key for, in slot order. */
  const REWARD_SLOTS: readonly number[] = Object.freeze(
    Array.from({ length: REWARD_SLOT_COUNT }, (_unused, slot): number => slot),
  );

  /**
   * The states each screen-driven action is offered in, keyed by action.
   *
   * Every entry is an edge `TRANSITIONS` of src/ui/screen-router.ts declares
   * out of the state named, so a control is offered exactly where its action is
   * a legal move. DL-CONTROL-06.
   */
  const ACTION_SCREENS = Object.freeze({
    startRun: Object.freeze<ScreenName[]>(['runStart']),
    continueStage: Object.freeze<ScreenName[]>(['stageClear']),
    selectReward: Object.freeze<ScreenName[]>(['reward']),
    endRun: Object.freeze<ScreenName[]>(['won']),
    keepPlaying: Object.freeze<ScreenName[]>(['won']),
    activateRelic: Object.freeze<ScreenName[]>(['stage']),
  });

  /**
   * Whether one on-screen control is offered right now: the screen in force
   * first, and then the slot, for the two actions whose payload carries one.
   *
   * @param action Action the control publishes.
   * @param index Payload index the control carries.
   * @returns Whether the control is offered.
   */
  const controlAvailable = (action: InputAction, index: number): boolean => {
    // The dialog actions follow the DIALOG, not a screen: closing and
    // cancelling are offered only while it is open, and opening only while it
    // is not.
    if (action === 'closeSettings' || action === 'cancel') {
      return router.isSettingsOpen();
    }

    if (action === 'openSettings') {
      return !router.isSettingsOpen();
    }

    const screens: readonly ScreenName[] | undefined =
      action in ACTION_SCREENS
        ? ACTION_SCREENS[action as keyof typeof ACTION_SCREENS]
        : undefined;

    if (screens !== undefined && !screens.includes(router.current())) {
      return false;
    }

    if (action === 'selectReward') {
      return index < run.currentOffer().length;
    }

    if (action === 'activateRelic') {
      return index < registry.ownedIds().length;
    }

    return true;
  };

  // `reducedMotion` is NOT supplied: a supplied value takes precedence over the
  // reflected attribute for the rest of the mount, and that attribute is the
  // one source the style layer reads too. It is written above, before this
  // mount, and the controls observe it for every later change.
  const controls = mountOnScreenControls({
    host: input,
    ownerDocument,
    context: router.context,

    // ONE CONTROL PER SLOT, not one per action. `activateRelic` and
    // `selectReward` both carry an index in their payload, and a single
    // generated control defaulted every press to slot 0: the second and third
    // offers and every relic past the first had a key binding and no control,
    // so a pointer or screen-reader user could reach none of them. The counts
    // are the ones src/input/keymap.ts declares the bindings for.
    // DL-CONTROL-07.
    indexes: {
      activateRelic: RELIC_SLOTS,
      selectReward: REWARD_SLOTS,
    },

    // The SCREEN, not only the coarse input context. The three contexts are
    // `'game'`, `'overlay'` and `'textEntry'`, and every overlay action shares
    // one of them, so the reward digits, the continue action and the two
    // terminal actions were all exposed on every overlay. This narrows each to
    // the state that offers it, and each indexed control to a slot that is
    // actually filled. DL-CONTROL-06.
    available: (action, index): boolean => controlAvailable(action, index),

    // `#settings-button` joins the three legacy controls here rather than being
    // bound separately, so every markup control has exactly one binding owner.
    markupControls: MARKUP_CONTROLS,
    reporter: createInputSink(reporter),
  });

  controlLayer = controls;

  // The audio layer (AAP A5): synthesised through the Web Audio API, with no
  // binary asset.
  const soundEngine: SoundEngine = createSoundEngine({
    reporter: createSoundSink(reporter),
    metrics: createSoundMetrics(reporter),
    preferences,
    unlockTargets: [ownerDocument],
  });

  soundEngine.subscribe(hooks.events);

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
    // restore focus to and the game region to make inert.
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

  // The surface carries `on`, `getKeymap` and `setContext`, and NOT the three
  // optional suspension members of `RouterInputSurface`.
  // `SCREEN_SUSPENDS_INPUT` of src/ui/screen-router.ts marks `reward` as a
  // suspending state, and `InputManager.handleKeyDown` drops EVERY key while
  // suspended, including the
  // `Digit1`-`Digit3` bindings src/input/keymap.ts declares for `selectReward`
  // in the `'overlay'` context and the slot bindings it declares for
  // `activateRelic`. The overlay context alone withholds movement: every
  // movement binding is declared in the `'game'` context only. DL-MAIN-09.
  //
  // The suspension the constant declares is therefore enforced by
  // `router.authorizes()` rather than by the manager, and read back through
  // `router.isInputSuspended()`: `authorized()` below is the gate every action
  // passes, and it resolves against the exact screen, so a suspending screen
  // authorizes only the actions it owns. DL-MAIN-17.
  const routerInput: RouterInputSurface = {
    on: (
      event: 'openSettings' | 'closeSettings' | 'cancel' | 'selectReward',
      listener: (index: number) => void,
    ): (() => void) =>
      event === 'selectReward'
        ? input.on('selectReward', (index): void => {
            listener(index);
          })
        : input.on(event, (): void => {
            listener(0);
          }),
    getKeymap: (): Keymap => input.getKeymap(),
    setContext: (context): void => {
      input.setContext(context);
    },
  };

  // Subscribes the dialog and reward actions and pushes the effective context
  // into the controls, so a control whose action is inactive leaves both the
  // accessibility tree and the tab order.
  router.attach({ input: routerInput, controls });

  const stopRouter = router.subscribe(hooks.events);

  /**
   * Feeds the registry's CANONICAL metric families: `game2048_merges_total`,
   * `game2048_spawns_total`, `game2048_engine_events_total{event}` and
   * `game2048_frames_rendered_total`, the families the registry declares with
   * help text and the names a dashboard is keyed to. `recordEngineEvent` also
   * reads a spawn's `position`, which separates a spawn that inserted a tile
   * from an attempt on a full board.
   *
   * `game2048_turns_total` is NOT fed from here: the turn family is fed from
   * the engine's `engine.move.resolved` counter in the report sink above, and a
   * second feed would double every turn. DL-METRIC-02.
   */
  const stopEventMetrics: (() => void)[] = ENGINE_EVENT_NAMES.map((name) =>
    hooks.events.on(name, (payload): void => {
      metrics.recordEngineEvent(
        name,
        // Only `tile:spawn` carries a position, and the recorder reads the
        // member structurally, so every other payload passes through as the
        // no-detail case.
        name === 'tile:spawn' ? (payload as SpawnDetail) : undefined,
      );
    }),
  );

  // The diagnostics surface: this build's stand-in for the metrics endpoint,
  // since a static bundle has no server to serve one from and no port for an
  // orchestrator to poll (AAP 0.7.2.4).
  const diagnostics = createDiagnosticsOverlay({
    metrics,
    logger,
    selector: SELECTORS.diagnostics,
    document: ownerDocument,

    // The one health surface, handed over WHOLE: the overlay reads its probe
    // views and its report, so the panel and the exported snapshot carry the
    // three-state status, the reused-versus-added provenance, the per-check
    // gauges and the readiness verdicts.
    health,

    // The one tracer, so the trace panel shows the frame statistics and the
    // span records of the spans the running application actually opened.
    tracer,

    // Pull integration: the bus keeps its per-hook counts and the registry
    // only has them if something asks.
    hookCounts: (): ReturnType<typeof engine.hooks.metrics> =>
      engine.hooks.metrics(),

    // The second pull integration, for the same reason and read the same way:
    // the substreams keep their draw counts and reading one takes no draw. The
    // per-commit fold above keeps the family current while a run is played;
    // this keeps a read taken BETWEEN two commits current too, so the panel and
    // every export answer from one reading. DL-MAIN-30.
    rngCursors: (): Readonly<Record<string, number>> =>
      streamHolder.streams.snapshotCursors(),
  });

  /**
   * Run persistence, attached after every VIEW subscriber and before exactly
   * one other: the reward-screen handler registered immediately below.
   *
   * Resolving a met stage goal happens inside the commit handler and commits
   * again, so a view registered after this one would see the stage-end commit
   * before the commit that triggered it and would settle on the older state.
   * Registering after the views leaves them already up to date when the second
   * commit reaches them.
   */
  const stopRunPersistence = run.observe(engine, () =>
    streamHolder.streams.snapshotCursors(),
  );

  // The reward screen follows the controller, subscribed AFTER `run.observe` so
  // this handler runs on the commit the controller has already drawn the offer
  // on. `isRewardPending()` is read rather than the commit's own members, so
  // the controller stays the single authority on whether a choice is owed.
  const stopRewardScreen = engine.events.on('state:commit', (): void => {
    presentPendingReward();

    // Availability is derived from the slots that are FILLED as well as from
    // the screen, and a commit is where a relic set and an offer change, so the
    // control layer is reapplied here. DL-CONTROL-06.
    controlLayer?.refresh();
  });

  /**
   * The control layer follows the STATE MACHINE, and the run-open flag is
   * cleared as a run ends.
   *
   * `runSummary` is the state both terminal edges land on, and a run is over by
   * the time it is entered, so nothing is open again until one is begun or
   * resumed. DL-MAIN-11, DL-CONTROL-06.
   */
  const stopControlFollow = router.subscribe((transition): void => {
    if (transition.to === 'runSummary') {
      runOpened = false;
    }

    // `runSummary` renders the finished run's own verdict and `runStart` opens
    // on no run at all, so the retained overlay carries no verdict on either.
    // Asked of its sole writer rather than written here. DL-HUD-13.
    if (transition.to === 'runSummary' || transition.to === 'runStart') {
      hud.clearTerminalOverlay();
    }

    controlLayer?.refresh();
  });

  /**
   * Discards the run in force and starts a fresh one. The order is the contract,
   * and every step replaces rather than reuses:
   *   1. the reward screen, taken down;
   *   2. the registry, cleared, so pickup order restarts at zero;
   *   3. the LIVE RULES, restored to the baseline this page composed, so no
   *      relic's board size, merge rule or spawn distribution survives into the
   *      new run. Ordered after the registry clear and before the board opens:
   *      the clear detaches every relic that could write the rules again, and
   *      the board `startRun` opens is allocated from `config.boardSize`;
   *   4. the seed, the substreams at cursor zero and the correlation scope, all
   *      replaced by `adoptRunScope`, which `run.startRun` publishes to BEFORE
   *      it opens the board;
   *   5. `run.startRun`, which clears the stored envelope, assembles a fresh one
   *      with a new run identifier at stage 0 and opens the board.
   * DL-MAIN-06, DL-DEFAULT-04.
   *
   * THE SEED IS NOT REDUCED HERE. `RunController.startRun` applies
   * `normalizeEnteredSeed()` to a supplied seed and `originateRunSeed()` to an
   * absent one, so the raw text is handed straight over and the controller is the
   * ONE normaliser; the value actually played is read back from `run.seed()`.
   * DL-RUNCTL-01.
   *
   * @param seed Seed to play, exactly as it was entered. Originated when absent.
   * @returns The seed the new run is played under, as the controller reduced it.
   */
  const startNewRun = (seed?: string): string => {
    router.hideReward();
    registry.clear();
    restoreRulesConfig(config, baselineConfig);

    // The board snapshot goes too: `Engine.restart` cleared `gameState` and
    // this path replaces that call.
    storage.clearGameState();

    // Marked BEFORE the board opens: opening it emits `stage:start`, which the
    // router takes the `runStart -> stage` edge on only for an open run.
    // DL-ROUTER-12.
    runOpened = true;

    // The substreams AND the correlation scope are replaced by `adoptRunScope`,
    // which `run.startRun` publishes to BEFORE it opens the board.
    run.startRun(engine, seed === undefined ? {} : { seed });

    logger.info('A new run started.', {
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

  /**
   * Whether the screen in force authorizes an action, reporting a refusal.
   *
   * THE ONE GATE every subscription below passes through, and the reason each
   * one is a two-line handler rather than a direct call: `router.authorizes()`
   * of src/ui/screen-router.ts is the single authorization decision, resolved
   * against the exact screen and the topmost modal rather than against the
   * three-member input context, which collapses six of the seven screens onto
   * `'overlay'` and so cannot say which overlay a press belongs to.
   *
   * Every modality converges here: a key, a swipe, a generated control and a
   * markup control all publish the same action, so gating the subscription gates
   * all four. The reward digits and the reward cards are gated inside the router
   * itself, on the same call. Decision DL-MAIN-17.
   *
   * @param action Action about to mutate the board, the run or the dialog.
   * @returns Whether the handler may proceed.
   */
  const authorized = (action: AuthorizedAction): boolean => {
    if (router.authorizes(action)) {
      return true;
    }

    reporter.onCount({
      name: 'input.action.unauthorized',
      value: 1,
      detail: Object.freeze({
        action,
        screen: router.authorizationScreen(),
        suspended: router.isInputSuspended(),
      }),
    });

    return false;
  };

  // The three subscriptions js/game_manager.js L9-L11 installed, under the same
  // three event names.
  //
  // No handler below opens an `input.dispatch` span of its own: the input
  // manager opens exactly one around its whole listener walk, through the
  // `startSpan` its sink carries, so every handler here already runs inside it.
  const stopMove = input.on('move', (direction): void => {
    // A move resolves in the `stage` state alone. The `'game'` input context
    // already withholds every movement binding elsewhere; this refuses the same
    // press for the same reason through the one decision, so a movement binding
    // later declared in another context cannot reach the board behind an
    // overlay. DL-MAIN-17.
    if (!authorized('move')) {
      return;
    }

    // `'failed'` until the call returns: an attempt that throws reaches only
    // the `finally` below, and the default names the path it took. `committed`
    // stays `false` on that path for the same reason.
    let resolution: FinalMoveResolution = 'failed';
    let committed = false;

    try {
      // The structured outcome, not the boolean: `move()` returns `false` alike
      // for a turn refused on a terminated board, a turn a listener or an
      // `onBeforeMove` handler withdrew, and a turn that changed nothing.
      //
      // BOTH MEMBERS TRAVEL. A withdrawn or idle attempt can still report
      // `committed: true` — an `onBeforeMove` handler reseated the board and
      // the slide then resolved to nothing — and the resolution alone cannot
      // tell that turn from one that changed nothing at all.
      const attempt = engine.attemptMove(direction);

      resolution = attempt.resolution;
      committed = attempt.committed;
    } finally {
      // An attempt that moved nothing emits no `move:after`, so no event
      // listener can close the turn span; the caller holding the outcome closes
      // it. Settled INSIDE the input span, which is still open for the length
      // of this listener. A committed turn has closed its own span and a
      // blocked move opened none, so both are no-ops here.
      stopEngineTracing.settleMove({ resolution, committed });
    }
  });

  // `restart` discards the BOARD and opens a fresh one inside the run in force:
  // js/game_manager.js L17-L21 ported verbatim as `Engine.restart()`, which
  // clears the stored snapshot and calls `setup(null)`, so the tiles go and the
  // score returns to zero while the run's seed, stage, relic set and identity all
  // stand. The substreams are NOT rebuilt, so the fresh board's spawns continue
  // the run's own sequence rather than replaying its opening one. That is what
  // `stage --restart--> stage` of AAP Figure 6 declares. Replacing the run is
  // `startNewRun`, which the `startRun` action of the run-start screen, the
  // run-summary screen's `newRun` edge and the application handle reach.
  // DL-MAIN-22, DL-ENGINE-02.
  //
  // Gated as well as bound: `ACTION_SCREENS.restart` of
  // src/ui/screen-router.ts authorizes this action in `stage` alone, so the
  // board is discarded only while a run is being played on it — never from
  // behind an unrelated modal, never on a run that has ended and never before
  // one has begun. The refusal is counted on the action. DL-MAIN-17,
  // DL-ROUTER-39.
  const stopRestart = input.on('restart', (): void => {
    if (!authorized('restart')) {
      return;
    }

    engine.restart();
  });

  // Authorized in `won` alone. `keepPlaying` is bound to `C` in the `'overlay'`
  // context, and that context is also what the settings dialog and every other
  // screen resolve to, so before this gate the default key mutated and persisted
  // hidden board state from behind an unrelated modal. DL-MAIN-17.
  const stopContinue = input.on('keepPlaying', (): void => {
    if (!authorized('keepPlaying')) {
      return;
    }

    engine.continuePlaying();
  });

  // `selectReward` is NOT subscribed here. `attach` of src/ui/screen-router.ts
  // registers that binding itself and routes the press through `chooseReward`,
  // which reaches `onRewardSelect` above; a second subscription applied the
  // same choice twice, and the second call was refused as `'already-resolved'`
  // and counted under `run.rewardRefused` on a successful selection.

  /**
   * Reads out the relic in one tray slot. NO CHARGE IS SPENT.
   *
   * EVERY RELIC IN THIS CATALOGUE IS AUTOMATIC. Each fires on the hooks it binds
   * when its own trigger condition holds, and asks the bus for its charge on that
   * one path — the withdrawal for `temporal-anchor`, the redirection for
   * `tumbler`, the turn for `culling-blade`, the cleared row for
   * `scouring-wind`, the frozen cell for `frostbind`. There is no effect a player
   * can ask for out of turn, so the tray control cannot apply one: spending a
   * charge here took a budget away and gave nothing back, and announced a
   * success. It now reports what the slot holds and changes nothing.
   *
   * The tray is rendered in pickup order, which is the order the registry keeps
   * and the order the hook bus dispatches in, so the slot index is the relic's
   * position in that order and the reading tells the player what will fire next.
   * DL-MAIN-09, DL-CONTROL-04.
   *
   * @param index Zero-based tray slot the press named.
   * @param relicId Identifier held in that slot.
   */
  const describeHeldRelic = (index: number, relicId: string): void => {
    const held = registry.find(relicId);
    const definition = relicDefinition(relicId);
    const remaining = held?.charges ?? null;

    reporter.onCount({
      name: 'relics.inspected',
      value: 1,
      detail: Object.freeze({ index, relicId, remaining }),
    });

    // The charge budget is read from the LIVE registry rather than the
    // catalogue's declaration, so what is read out is what is left.
    const budget =
      remaining === null
        ? 'Unlimited.'
        : `${String(remaining)} charges remaining.`;

    announcer.announceText(
      `Slot ${String(index + 1)}: ${definition?.name ?? relicId}. ` +
        `${budget} ${definition === undefined ? '' : relicDescription(relicId)}`
          .trimEnd(),
    );
  };

  // The indexed slot bindings of src/input/keymap.ts, and the generated
  // on-screen control per slot.
  const stopActivateRelic = input.on('activateRelic', (index): void => {
    // The relic tray is part of the board, so a slot is read out in `stage`
    // alone and never from behind an overlay holding a different choice. No
    // charge is spent on this path at all. DL-MAIN-17, DL-KEYMAP-05.
    if (!authorized('activateRelic')) {
      return;
    }

    const held = registry.ownedIds()[index];

    if (held === undefined) {
      reporter.onCount({
        name: 'relics.inspection.refused',
        value: 1,
        detail: Object.freeze({ index, relicId: null, remaining: null }),
      });

      return;
    }

    describeHeldRelic(index, held);
  });

  // Emitted by the run-start screen's own control and by the `startRun` action.
  // Starts a run through the composed path, so the seed, the substreams, the
  // relics, the envelope and the correlation identifier are replaced together.
  //
  // THE PAYLOAD IS FORWARDED, VERBATIM. `InputEventPayload['startRun']` of
  // src/input/keymap.ts is `string | undefined` and carries the text the
  // run-start screen's field held; a listener taking no argument dropped it, so
  // a typed seed reached nothing and every run was played under an originated
  // one. It is handed on UNNORMALISED: `RunController.startRun()` is the single
  // owner of what a typed seed reduces to, and a second reduction on the way in
  // was a second place the rule could drift from it. `startNewRun`
  // distinguishes only the two cases the payload itself carries — `undefined`
  // originates a seed, a value is offered to the controller. DL-RUNCTL-01,
  // DL-RUNSTART-03.
  const stopStartRun = input.on('startRun', (seed): void => {
    if (!authorized('startRun')) {
      return;
    }

    startNewRun(seed);
  });

  // The two overlay actions src/input/keymap.ts declares for a screen's own
  // control: `continueStage` leaves stage progress for the reward offer and
  // `endRun` leaves the win state for the run summary. Both are edges of
  // `TRANSITIONS` in src/ui/screen-router.ts, so each is sent rather than
  // acted on here. DL-MAIN-09.
  //
  // Gated as well as sent: `send()` refuses an undeclared edge and refuses every
  // edge behind an unrelated modal, and the gate refuses the action before it
  // reaches the router at all, so the refusal is counted on the action rather
  // than only on the transition. DL-MAIN-17.
  const stopContinueStage = input.on('continueStage', (): void => {
    if (!authorized('continueStage')) {
      return;
    }

    router.send('stageEnd');
  });

  const stopEndRun = input.on('endRun', (): void => {
    if (!authorized('endRun')) {
      return;
    }

    router.send('endRun');
  });

  loop.start();

  // The state machine of AAP Figure 6, entered at `INITIAL_SCREEN` before the
  // board opens below.
  const entered = router.start();

  /**
   * Whether the load found a run to resume.
   *
   * `openingBoard()` is non-null for an envelope this run ADOPTED — the store has
   * already reconciled its board against the configured edge length. An envelope
   * that was read and refused belongs to another run, so it is not a resume; no
   * envelope at all still resumes where the frozen `gameState` key holds a board,
   * which is the save written before the upgrade.
   */
  const resumable =
    run.openingBoard() !== null ||
    (!run.hadStoredEnvelope() && storage.getGameState() !== null);

  /**
   * Whether the run-start state has a container to render into, read from the
   * router's own mount resolution rather than from a second lookup here.
   *
   * A document that declares none has no way to reach the begin-run control, so
   * the flow would hold `runStart` over a board that could never be opened. That
   * one absent container degrades to a run begun at once — the behaviour of every
   * markup that predates the screen, and the guarded-lookup posture the rest of
   * this root takes (AAP I12). DL-MAIN-19.
   */
  const canPresentRunStart = router.hostFor('runStart') !== null;
  const openBoardAtBoot = resumable || !canPresentRunStart;

  logger.info('The screen flow started.', {
    screen: entered,
    missingMounts: router.missingMounts().length,
    resumable,
    canPresentRunStart,
    openBoardAtBoot,
  });

  // WHETHER THIS LOAD RESUMED A RUN, decided from the controller's own read of
  // storage rather than from a second read here:
  //   a reconciled board            an envelope was read AND adopted;
  //   no envelope and a board       a save written before the upgrade, which
  //                                 `openEngineBoard()` loads through the
  //                                 engine's legacy read.
  // An envelope that was read and REFUSED resumes nothing: it opens no board
  // and the flow holds Run Start, so the player begins a run rather than being
  // dropped onto a board that came from nowhere — unless this document declares
  // no run-start container, which is the degradation above. DL-MAIN-11,
  // DL-MAIN-19.
  if (openBoardAtBoot) {
    // Marked before the board opens, as `startNewRun` marks it:
    // `openEngineBoard()` emits `stage:start` synchronously, and the router
    // takes the `runStart -> stage` edge on it only for an open run.
    runOpened = true;
    run.openEngineBoard(engine);
  } else {
    reporter.onCount({
      name: 'ui.boot.runStartHeld',
      value: 1,
      detail: Object.freeze({ storedEnvelope: run.hadStoredEnvelope() }),
    });
  }

  logger.info('The boot resolved its opening state.', {
    screen: router.current(),
    resumed: resumable,
    runStartHeld: !openBoardAtBoot,
  });

  // THE FOCUS THE BOOT PLACED STANDS. `enterScreen` of src/ui/screen-router.ts
  // places focus for every state it enters, and the state a load opens on is a
  // modal screen whose background is inert, so the element it focused is the
  // one the player can act on. A blur here left that screen with nothing
  // focused. DL-MAIN-12.

  // The diagnostics surface's runtime opt-in, DEFAULT OFF: it mounts and opens
  // only for a session carrying `?diagnostics` or `#diagnostics`, and every
  // other session — the recorded-gameplay run of requirement R11 included —
  // leaves it dormant.
  if (isDiagnosticsRequested()) {
    diagnostics.mount();
    diagnostics.open();
  }

  // NAMED, so `dispose` below can compare the published inspection handle
  // against THIS application before clearing it. DL-MAIN-25.
  const application: Application = Object.freeze({
    engine,
    config,
    streams,

    // A getter: a preference change swaps the renderer, and a captured value
    // would report the mode that was in force at boot.
    get renderer(): BoardRenderSelection {
      return selection;
    },

    hud,
    screens: router,
    preferences,
    soundEngine,
    diagnostics,
    logger,
    metrics,
    tracer,
    health,
    relics: registry,
    hooks,
    run,
    router,

    // Expressed over the run controller, which owns the immutable active offer
    // and the single-use validated selection, so this surface adds no second
    // authority.
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
      stopActivateRelic();
      stopStartRun();
      stopContinueStage();
      stopEndRun();
      stopRewardScreen();
      stopControlFollow();
      cancelContextRestoreWait();
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

      // THE RENDERER GOES BEFORE THE FOCUS OWNERS. Tearing the number-only
      // renderer down HANDS THE PARALLEL BOARD BACK — it remounts
      // `ParallelBoardLayer` and restores the attributes it hid the board
      // behind — so destroying it after `parallelBoard.unmount()` and
      // `focusManager.destroy()` rebuilt a subtree and its listeners with no
      // owner left to take them down again, and a disposed application left DOM
      // and handlers behind. Destroyed here instead, the handoff lands while its
      // owner is alive and the unmount below is final. The loop is stopped first
      // so no frame callback reaches a destroyed renderer. DL-MAIN-23,
      // DL-NUMBER-07.
      loop.stop();
      renderer.destroy();

      // THE ROUTER IS THE ONE OWNER OF SCREEN TEARDOWN. Every module this root
      // constructs is registered with it, `destroy()` drains the set it mounted,
      // and `unmount` and `destroy` are the same teardown on the two modules that
      // publish both — so a second call from here would land after the module was
      // already torn down and be counted as such. DL-ROUTER-20.
      router.destroy();
      focusManager.destroy();
      soundEngine.dispose();
      // Detaches the turn and stage listeners and closes whatever they left
      // open, so a disposed application leaves no span on the stack.
      stopEngineTracing();

      // The cursor fold reads the substreams; released beside the tracing it
      // was attached with, so a disposed application takes no further reading.
      stopRngCursorMetrics();
      stopRendering();
      stopCommitCapture();

      // The relay last of the event paths: every peer above has released its
      // own subscription on the bus channel, and this removes the seven
      // listeners that fed it.
      stopEventRelay();
      frameSubscription.remove();
      stopMotion();
      stopPreferences();
      controls.unmount();
      parallelBoard.unmount();
      input.detach();
      diagnostics.destroy();
      preferences.destroy();

      // LAST, AND ONLY IF IT IS STILL THIS ONE. The inspection handle held the
      // whole disposed graph — engine, renderer, registry, storage — reachable
      // by name for as long as the page lived, so a console session that had
      // composed a second application read a torn-down one. Cleared here, and
      // compared first so a NEWER application that has taken the name is never
      // clobbered by a late disposal of the one it replaced. DL-MAIN-25.
      unpublishFromInspection(application);
    },
  });

  return application;
}

/** Name the running application is published under for local inspection. */
const APPLICATION_GLOBAL = '__blitzy2048';

/**
 * Publishes the running application for local inspection: the handle a console
 * reaches the diagnostics surface, the tracer, the metrics registry and the
 * health surface through. The only global this module writes, and nothing in
 * the application reads it back. A global that cannot be written is contained.
 * DL-MAIN-03.
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
 * Clears the inspection handle, and only where it still names `application`.
 *
 * The comparison is the whole point: two applications composed over one page
 * take the name in turn, and a disposal of the FIRST must not remove the
 * second's handle. A global that cannot be deleted is contained, as publishing
 * one is. DL-MAIN-03, DL-MAIN-25.
 *
 * @param application The application being disposed.
 */
function unpublishFromInspection(application: Application): void {
  try {
    const holder = globalThis as unknown as Record<string, unknown>;

    if (holder[APPLICATION_GLOBAL] !== application) {
      return;
    }

    Reflect.deleteProperty(holder, APPLICATION_GLOBAL);
  } catch {
    // Symmetrical with publishing: a global that cannot be cleared is not a
    // reason to fail a disposal.
    application.logger.debug('The inspection handle could not be cleared.', {
      name: APPLICATION_GLOBAL,
    });
  }
}

/**
 * Runs a callback once on the next animation frame, falling back to a
 * zero-delay timer where `requestAnimationFrame` is absent — the gap
 * js/animframe_polyfill.js shimmed. DL-MAIN-08.
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

/** How `bootstrap` composes. Every member has a working default. */
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

/** What `bootstrap` did. */
export type BootstrapOutcome =
  /** A composition was deferred to the next frame. */
  | 'scheduled'
  /**
   * The document is still parsing; the deferral waits for `DOMContentLoaded`.
   */
  | 'awaiting-document'
  /** No document to compose against. */
  | 'unavailable';

/**
 * One record per composition `bootstrap()` has begun and not yet run, whether it
 * is waiting for the document or waiting for a frame.
 *
 * A record is claimed by the boot that owns it and removed as it composes;
 * `start()` clears the whole set, which is how a caller that composes first
 * supersedes a boot in flight. `detach` releases whatever the record is waiting
 * on, so a cancelled boot leaves no listener behind. DL-MAIN-09, DL-MAIN-26.
 */
interface PendingBoot {
  /** Releases what this boot is waiting on, where it waits on a listener. */
  detach: (() => void) | null;
}

const pendingBoots = new Set<PendingBoot>();

/** Whether the composition in progress is the automatic boot's own. */
let booting = false;

/**
 * Cancels a deferred automatic boot, called by `start` when a CALLER composes
 * first: one document holds one application.
 */
function cancelPendingBoot(): void {
  if (booting) {
    return;
  }

  for (const pending of pendingBoots) {
    try {
      pending.detach?.();
    } catch {
      // A record whose wait cannot be released is still cancelled: the set is
      // cleared below either way, so the boot composes nothing. Containing it
      // here keeps a caller's own `start()` from failing over the release of a
      // boot it is superseding.
      pending.detach = null;
    }
  }

  pendingBoots.clear();
}

/**
 * Composes and publishes the application on the next animation frame.
 *
 * Ported from js/application.js L1-L4, whose whole body was one
 * `window.requestAnimationFrame` callback wrapping the composition: exactly
 * one frame, not a loop, not a poll and not an immediate call.
 *
 * The readiness guard around it is new. The vanilla scripts were the last
 * elements of the body, so the document was already parsed when they ran; a
 * module script is deferred but can still be evaluated while the document is
 * loading, and the composition reads markup mount points. The one-frame
 * deferral still applies after the guard.
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

  const defer = (pending: PendingBoot): void => {
    schedule((): void => {
      if (!pendingBoots.delete(pending)) {
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

  // THE RECORD IS TAKEN BEFORE THE READINESS WAIT, not inside it. Registered
  // only once the document was ready, a boot that was still waiting for
  // `DOMContentLoaded` was invisible to `cancelPendingBoot()`: a caller that
  // composed during parsing cleared an EMPTY set, and the event then composed a
  // second application over the same document — two engines, two renderers and
  // two input managers on one page. DL-MAIN-26.
  const pending: PendingBoot = { detach: null };

  pendingBoots.add(pending);

  if (ownerDocument.readyState === 'loading') {
    const onDocumentReady = (): void => {
      // Cancelled while the document was still parsing: the caller's own
      // application is the one in force and nothing further is composed.
      if (!pendingBoots.has(pending)) {
        return;
      }

      pending.detach = null;
      defer(pending);
    };

    ownerDocument.addEventListener('DOMContentLoaded', onDocumentReady, {
      once: true,
    });

    // So a cancellation releases the listener as well as the record, rather
    // than leaving an inert handler attached to the document. The member is
    // checked before it is called: a caller may compose against a document
    // double that implements only the subscription half, and a cancellation must
    // not raise through it.
    pending.detach = (): void => {
      const target: { removeEventListener?: unknown } = ownerDocument;

      if (typeof target.removeEventListener === 'function') {
        ownerDocument.removeEventListener('DOMContentLoaded', onDocumentReady);
      }
    };

    return 'awaiting-document';
  }

  defer(pending);

  return 'scheduled';
}

bootstrap();
