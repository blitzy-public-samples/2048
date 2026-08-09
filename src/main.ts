// The composition root: the single module index.html L113 loads.
//
// Ported from js/application.js L1-L4, the whole of it:
//   L1-L2, L4  the one-animation-frame deferral, reproduced by `bootstrap()`
//   L3         `new GameManager(4, KeyboardInputManager, HTMLActuator,
//              LocalStorageManager)` — the constructor injection reproduced by
//              `start()`, and the board-size literal `4`, now read from
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
// named beside the constructs they belong to. DL-MAIN-01 to DL-MAIN-11 are
// this file's own rows.

// Ported from index.html L7. DL-MAIN-01.
import '../style/main.scss';

import { createDefaultRulesConfig } from './config/default-config';
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
import type { ActiveRelic, PersistedRelic } from './relics/relic-types';
import { HOOK_NAMES } from './engine/hooks';
import { createDefaultStageConfig } from './config/stage-config';
import type { StageGoal } from './config/stage-config';
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
import type {
  RunOutcome,
  RunReporter,
  RunSummary,
} from './run/run-state';
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
import type { RewardCard, RouterInputSurface } from './ui/screen-router';
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
 * Renders a theme id as the prose name a preference announcement carries. Falls
 * back to the id where the value is not one this build knows.
 *
 * @param theme Theme id to render.
 * @returns The prose name.
 */
function describeThemeName(theme: string): string {
  return isThemeId(theme) ? getTheme(theme).name : theme;
}

/**
 * Name the gap BETWEEN frames is reported under. The canonical frame metric
 * carries how long the frame callbacks occupied one frame; this is a different
 * quantity and therefore a different series.
 */
const FRAME_INTERVAL_TIMING = 'render.frame.interval';

/**
 * The elements index.html declares that this root looks up.
 *
 * Every lookup below is guarded. The vanilla markup's eight-selector contract
 * was dereferenced unchecked in four places in js/html_actuator.js L2-L5 and one
 * in js/keyboard_input_manager.js L141, so a renamed class was a startup
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
  liveRegion: '#live-region',
  diagnostics: '#diagnostics-overlay',
  rewardScreen: '#screen-reward',
  // Both the host and a descendant: the parallel board's roving tab stop sits on
  // the HOST under the Three renderer and on the active CELL under the
  // number-only renderer.
  boardTabStop: '#board-a11y[tabindex="0"], #board-a11y [tabindex="0"]',
  hudGroup: '#screen-hud',
  hudStage: '#hud-stage',
  relicTray: '#relic-tray',
});

/**
 * The markup controls this root binds, and the action each publishes.
 *
 * `LEGACY_CONTROL_BINDINGS` is the three of js/keyboard_input_manager.js
 * L72-L74. `mountOnScreenControls` is their one binding owner, and
 * `#settings-button` is appended to the same list rather than bound separately:
 * one owner per element.
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
 * The one counter family every generic report increment lands on.
 *
 * The report's own dotted name travels as the `report` label and its leading
 * segment as the `subsystem` label — the shape `recordSpanDuration` gives the
 * timing channel in `src/observability/metrics.ts`. DL-METRIC-04, DL-MAIN-11.
 */
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
 * `RenderReporter` is the hub the whole reporting graph adapts onto: the engine,
 * input, storage, preference and UI adapters below all narrow to it, and its
 * three channels are wired here to the structured logger and the metrics
 * registry. Console output is retained — the logger writes it itself under
 * `consoleOutput`. DL-MAIN-03, DL-MAIN-07.
 *
 * @param logger Structured logger diagnostics are recorded through.
 * @param metrics Registry counts and timings are recorded into.
 * @returns A frozen reporter whose channels cannot throw into their callers.
 */
function createSink(logger: Logger, metrics: MetricsRegistry): RenderReporter {
  // `# HELP` and `# TYPE` for the collapsed counter family, recorded once.
  // DL-MAIN-11.
  metrics.describe(REPORT_COUNTER_NAME, REPORT_COUNTER_HELP, 'counter');

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
      // One family, the report's dotted name carried as a label rather than
      // rendered into a family name of its own. DL-METRIC-04, DL-MAIN-11.
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
 * `'render.webgl.probe'` reads as `'render'`. A name carrying no separator
 * reads whole, and an empty one reads as `UNKNOWN_SUBSYSTEM`, so the label is
 * always present and always non-empty.
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
 * and the subsystem it belongs to, and nothing else. `detail` stays in the log
 * record and is carried into no label. DL-METRIC-04, DL-MAIN-11.
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
      } else if (report.metric === MOVE_RESOLVED_METRIC) {
        // THE TURN COUNTER IS FED FROM HERE, for the same reason the two spawn
        // families are: `engine.move.resolved` is raised once per move that
        // changed the board, while `move:after` is emitted for every turn that
        // reached the walk — carrying `moved: false` for one that moved nothing.
        // Forwarding the emission instead counted a press into a wall as a turn,
        // so `game2048_turns_total` over-reported by exactly the idle inputs and
        // every rate derived from it — merges, score and spawns per turn — was
        // skewed with it.
        metrics.recordTurnResolved();
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
 * board-size reconciliation and the refused payload are the reports the guarded
 * loader produces, and this is the sink they reach.
 *
 * No seed is forwarded. None of these report shapes carries one:
 * `RunStartedReport` carries `seedProvided`, and `RunEndedReport` carries the
 * summary with the seed already redacted out of it. DL-LOG-06.
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
 * run-instance identifier; the two draws are independent. Web Crypto is the
 * source where it is available, and the two clocks combined where it is not.
 * `Math.random()` is called by no module under src/, and a test asserts the
 * global is never replaced. DL-MAIN-02.
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
 * The part of a board renderer this root drives. Declared structurally and
 * satisfied by BOTH renderers, so the mode can be selected and switched without
 * the wiring below knowing which one it holds. `frame` accepts the loop's
 * context, which the 2.5D renderer reads a delta from and the number-only
 * renderer ignores.
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
 * 1200 ms is the delay the terminal overlay waits before it fades in
 * (`$transition-speed` x 12 of style/main.scss). DL-MAIN-10.
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
 * Two distinct inputs produce number-only rendering and the selection reports
 * which: an absent WebGL context, which the probe pushes into the store as a
 * force (implicit requirement I6), and the player's own choice of number-only
 * as a rendering mode (R9). The store holds both as the one effective value
 * `isNumberOnlyMode()`, and the probe is consulted before this call.
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
 * The renderer registers its own listeners from inside `subscribe`, so the span
 * is applied where the listener is REGISTERED rather than around a call this
 * module makes. Every other event name is registered unchanged, and `off`
 * resolves a caller's listener back to the wrapper it was registered as.
 *
 * @param events The engine's emitter.
 * @param traceRenderCommit The `render.commit` boundary wrapper.
 * @param readTurnSpan Reads the turn span open right now. The commit span is
 *   opened as an explicit CHILD of it, because the listener that closes the turn
 *   span is another `state:commit` listener and the implicit-parent stack would
 *   make the link depend on registration order.
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

  /** The diagnostics surface, this build's stand-in for a metrics endpoint. */
  readonly diagnostics: DiagnosticsOverlay;

  /** The structured logger every layer reports through. */
  readonly logger: Logger;

  /** The metrics registry every count and timing lands in. */
  readonly metrics: MetricsRegistry;

  /**
   * The Performance-API tracer every span of the input -> engine -> hook bus ->
   * relic handler -> renderer chain, and of the frame callback, is opened on —
   * every module boundary validation gate V8 enumerates. `snapshot()` on it
   * reads the span records without the overlay being opened.
   */
  readonly tracer: Tracer;

  /**
   * The health surface: the five reused capability probes plus the WebGL probe,
   * their roll-up report and the two readiness verdicts. `check()`, `report()`
   * and `readiness()` on it are the readiness probe a static bundle has no port
   * for an orchestrator to poll (AAP 0.7.2.4).
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
   * The relic registry: the catalogue, the relics held in pickup order, their
   * charge budgets, and the manual activation a player's `activateRelic` press
   * reaches. The budget it spends is the one src/engine/hook-bus.ts holds.
   */
  readonly relics: RelicRegistry;

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
   * board. `start()` resumes; this replaces.
   *
   * @param seed Seed to play, reduced by `normalizeEnteredSeed`. Originated when
   *   absent.
   * @returns The seed the new run is played under.
   */
  readonly startNewRun: (seed?: string) => string;

  /** Stops the frame loop and removes every listener that was bound. */
  readonly dispose: () => void;
}

/**
 * `RngStreams` whose backing instance can be replaced, so a fresh run's
 * substreams reach every holder of a reference without the engine being rebuilt.
 * `seed` is a getter, so it reports the seed of the run in force. DL-MAIN-09.
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
 * The order is a chain: storage -> run identity -> correlation identifier ->
 * logger, metrics, tracer and health -> run controller -> substreams -> hook
 * bus -> engine -> engine tracing -> subscribers -> the board. The board opens
 * last, after every subscriber has attached, which is where js/game_manager.js
 * L13 called `setup()` from its own constructor instead. DL-MAIN-03,
 * DL-MAIN-04, DL-MAIN-06.
 *
 * @param ownerDocument Document to mount into.
 * @returns The composed application.
 */
export function start(ownerDocument: Document): Application {
  // A caller composing the application supersedes the automatic boot deferred by
  // `bootstrap()`. The boot's own call is exempt. DL-MAIN-09.
  cancelPendingBoot();

  const config = createDefaultRulesConfig();
  const stages = createDefaultStageConfig();

  // Storage is composed FIRST, ahead of the observability layer: the run's
  // identity is read out of it and the correlation identifier is derived from
  // that identity. Its own failure sink therefore does not exist yet, so
  // failures raised before it does are held and replayed the moment it is
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
  // from the stored envelope where one is readable, so a reload CONTINUES the run
  // it interrupted under the same seed, run identifier and correlation
  // identifier; originated only where there is nothing to continue.
  const identity: RunIdentity = resolveRunIdentity({
    storage,
    createToken: createRunToken,
  });

  // The one derivation of the run correlation identifier, from both inputs: the
  // run instance makes it unique and the seed keeps the seed-grouping prefix.
  // Every module that reports receives it; none derives one of its own, and
  // neither the seed nor the run identifier is carried into a report. No engine
  // behaviour reads it.
  //
  // Held in a SCOPE, not a constant: a run started without a reload mints a new
  // identity. `readCorrelationId` is what every module receives, and
  // `rotateCorrelation` below is the one writer — of this scope and, through
  // `Logger.setCorrelationId`, of the logger the metrics registry, the tracer and
  // the health surface read theirs from. DL-MAIN-06, DL-LOG-01.
  let runCorrelationId = deriveCorrelationId(identity.seed, identity.runId);

  /** Reads the correlation identifier of the run in force. */
  const readCorrelationId = (): CorrelationId => runCorrelationId;

  // The structured logger and the metrics registry. `consoleOutput` keeps
  // everything that reaches the console reaching it, as a structured record
  // carrying the correlation identifier. DL-MAIN-03, DL-LOG-01.
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
   * The WebGL probe result, once taken. A slot, because the health surface is
   * composed before the probe runs and the probe runs exactly once per session.
   */
  let webglProbeResult: WebGLProbeView | undefined;

  /**
   * The WebGL failure the board is living with right now, or `null` while the
   * capability the boot probe found is the one in force. A slot, filled once the
   * renderer exists and answering `null` until then: `probeWebGLSupport` hands
   * every later caller its startup result, so a surface reading that alone
   * reports the capability the machine had at BOOT for the rest of the session.
   */
  let readLiveWebGLFailure: () => string | null = (): string | null => null;

  // The health surface: the five capability probes the vanilla sources performed
  // and reported nowhere, plus the WebGL probe the Three.js renderer introduced.
  // The live storage manager is handed over, so its construction-time probe
  // result is read instead of a second write-and-remove round trip. `webglProbe`
  // hands back the ONE probe result taken below; the slot is read at call time
  // and falls through to the module's own probe until that result exists.
  // DL-HEALTH-02.
  const health = createHealthSurface({
    logger,
    metrics,
    storage,

    // The pointer family is PROBED, not inferred from whether the input manager
    // is listening: js/keyboard_input_manager.js L4-L13 probed the platform.
    pointerProbe: detectPointerEventFamily,
    webglProbe: (): WebGLProbeView => {
      const probed = webglProbeResult ?? probeWebGLSupport();

      // The live verdict, which the readiness roll-up acts on: a context taken
      // away, one whose resources could not be rebuilt, a 2.5D board that never
      // mounted, and a forced number-only board are each a WebGL failure NOW,
      // whatever the boot probe found.
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

  // The one sink the hook bus, the relic registry and the engine all report
  // through. DL-MAIN-07.
  const engineReporter = createEngineSink(reporter, metrics);

  // The hook bus, built HERE rather than inside the engine: the relic registry
  // takes it, and the registry has to exist before the run controller loads,
  // because a resumed envelope hands its relics back through
  // `RelicRegistryPort.restoreRelics`. The engine takes this same instance below,
  // so there is exactly one bus.
  //
  // The two boundary wrappers are injected here: `hook.dispatch` spans each
  // dispatch and `relic.handler` spans each handler invocation, both attributed
  // to the hook. `BoundaryTracing` satisfies `HookDispatchTracing` structurally,
  // so src/engine imports nothing from src/observability. DL-HOOKBUS-05.

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
  // already frozen at every level by the module that owns it; supplying it takes
  // the injected path, which adopts a fresh copy of every declaration and would
  // replace the array the seeded reward snapshots resolve their drawn indices
  // against. DL-REGISTRY-01.
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
   * The substreams in force. Held rather than captured: a new run REPLACES them,
   * because they are built from the run's seed. Every reader below goes through
   * this holder.
   */
  const streamHolder: { streams: RngStreams } = {
    streams: createRngStreams(
      identity.seed,
      {},
      createRngSink(reporter),
    ),
  };

  /**
   * Replaces the substreams behind the swappable facade, once that facade exists.
   * `run.begin()` publishes a run scope before the facade is built, from the
   * loaded run's own seed, so the callback cannot close over it and is absent
   * until then.
   */
  let replaceSwappableStreams: ((next: RngStreams) => void) | undefined;

  /**
   * Rotates the one correlation scope every reporting module reads.
   *
   * One write, which every observer follows: the scope itself for the engine, the
   * emitter, the hook bus, the relic registry, the run controller and the
   * run-state store, and `Logger.setCorrelationId` for the logger and every
   * logger sharing its state, which is where the metrics registry, the tracer and
   * the health surface read theirs from. Records, counters, spans and reports
   * already emitted are not relabelled. DL-MAIN-06.
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
   * Rebuilds every construct scoped to the run: the substreams, from the run's
   * own seed, and the correlation scope, from its identity. Invoked before the
   * engine opens a board, so the opening spawns come from the new sequence and
   * the opening `stage:start` and `state:commit` are attributed to the new run.
   * DL-MAIN-06, DL-RNG-05.
   */
  const adoptRunScope = (scope: RunScope): void => {
    // The correlation scope, rotated FIRST: the controller publishes this scope
    // before it opens the engine's board, so every report of the new run carries
    // the new identifier from the opening spawns onward. Derived from the scope
    // published rather than from a later query, so the identifier matches the
    // seed and run identifier the envelope carries; at composition time
    // `begin()` publishes the identity `deriveCorrelationId` was already called
    // with above and `rotateCorrelation` short-circuits. DL-MAIN-06.
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
    // write time.
    //
    // One member per name `RelicRegistryPort` of src/run/run-controller.ts
    // actually reads. The alternative spellings it also accepts —
    // `activateRelic`, `pickUp`, `resolveRelic`, `knowsRelic` and `serialize` —
    // are left off: it resolves `pickUpRelic ?? activateRelic`,
    // `persistedEntry ?? resolveRelic`, `knowsRelic ?? knows` and
    // `serialize ?? snapshotRelics`, so a second spelling is a second
    // implementation of one step that can never run. DL-MAIN-09.
    relics: {
      snapshotRelics: (): readonly PersistedRelic[] => registry.serialize(),
      ownedRelicIds: (): readonly string[] => registry.ownedIds(),
      restoreRelics: (relics): void => {
        registry.restore(relics);
      },
      knows: (relicId): boolean => registry.knows(relicId),

      // The confirmation reader: `resolveReward()` appends the entry the pickup
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
      activate: (relicId, amount) => registry.activate(relicId, amount),
      persistedEntry: (relicId): PersistedRelic | null =>
        registry.persistedEntry(relicId),
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

  // Built from the run rather than from the identity: `seed()` is the seed of the
  // envelope in force and `cursors()` is where that envelope left each substream,
  // and a fresh run yields zeros so its opening spawns are taken rather than
  // skipped.
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

    // The resolution span is INJECTED, not wrapped from out here: the engine runs
    // it around the traversal walk alone, so it nests inside the turn span, which
    // opens on the `move:before` the engine emits from inside `move()`.
    // DL-HOOKBUS-05.
    tracing: { traceMoveResolution: boundaries.traceMoveResolution },
  });

  // The relics an adopted envelope carried, re-hydrated onto the engine's bus
  // before it has dispatched anything, so a held relic fires from the first
  // dispatch.
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

  // Pushed into the render layer's store and reflected onto the document element
  // before any renderer is built, so the first frame already honours it.
  setReducedMotionOverride(preferences.reducedMotionOverride());
  reflectMotion(queryReducedMotion());

  // The WebGL capability probe (implicit requirement I6). Consulted once, before
  // any renderer is built, and its result pushed into the store as a FORCE, so
  // number-only mode has one effective value and the settings surface can refuse
  // to turn it off on a machine that cannot draw without it. The probe holds its
  // result, so the readiness below reads the same one. DL-WEBGL-02.
  const support = probeWebGLSupport(reporter);

  // Handed to the health surface, which reads the slot rather than probing again.
  webglProbeResult = support;

  if (!support.supported) {
    preferences.forceNumberOnlyMode(
      `no WebGL context is available (${support.level})`,
    );
  }

  // The parallel accessibility board of index.html L70: the focusable, labelled
  // per-cell counterparts beside the canvas, which is `aria-hidden`. Built here
  // rather than by a renderer, so a mode switch hands it over instead of one
  // renderer owning it (R9).
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
   * Serves the number-only board because the context did not come back. Does
   * nothing where the context HAS come back or the number-only board is already
   * in force.
   *
   * The swap goes through the preference store, which `applyRenderMode` follows:
   * that path destroys the old renderer, mounts the new one, subscribes it and
   * replays the last commit into it. DL-MAIN-10.
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

    // Announced assertively: the board the player is reading has been replaced by
    // a different one.
    announcer.announceText(
      'The 3D board is unavailable. The number board is now in use.',
      ASSERTIVE_POLARITY,
    );
  };

  /**
   * Starts the bounded wait after the browser has taken the context away. The
   * renderer has already suspended drawing and resumes by itself where the
   * context is restored; this adds an end to the wait. DL-MAIN-10.
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
   * Ends the bounded wait, but ONLY for a restoration that rebuilt the board: a
   * restored context is a new context, and the renderer's rebuild of every
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

    // The rebuild did not complete and the context still reads as lost, so the
    // number-only board takes over now rather than at the deadline.
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
      // Guarded at the factory as well as inside the mount: the mount unwinds its
      // own failures and reports `mounted: false`, which the fallback below acts
      // on, and this covers the factory itself raising before a mount is
      // attempted, which would otherwise escape `start()`.
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
        // The active mode is made authoritative BEFORE the fallback is returned.
        // `selection` is what every later reader consults for the mode that is
        // drawing: the mounted-state guard in `fallBackToNumberOnly` below, the
        // live context-loss reader handed to the health surface, the
        // context-restoration wait and the settings surface. The preference is
        // forced as well as the selection recomputed, which is the same pair
        // `fallBackToNumberOnly` applies for a mount that failed.
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

          // The total reduction, shared with src/render/ and with the engine sink
          // above: reading `name`, `message` or `String(value)` here lets a
          // hostile getter or a throwing `toString` raise from inside the catch
          // that contains it. `thrown` carries the value itself for a sink that
          // keeps more than the two-field summary.
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
   * Recorded in the store as a force, so the settings surface reflects that the
   * choice is no longer available.
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

  // The live answer, read through `selection` and `renderer` rather than captured
  // from them, so a renderer swapped mid-session is the one consulted. Four
  // states report a failure: a context taken away, a restored context whose
  // resources could not be rebuilt, a 2.5D board selected but not mounted, and a
  // number-only board FORCED in place of one. A number-only board the player
  // chose reports nothing.
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

  // Run once at boot: the per-check log records and the six status gauges are
  // written by this call, and `readiness()` below reads the report it leaves.
  const bootHealth = health.check();

  logger.info('Health checked.', {
    status: bootHealth.status,
    passed: bootHealth.counts.pass,
    failed: bootHealth.counts.fail,
    notApplicable: bootHealth.counts['not-applicable'],
  });

  // The readiness verdicts the health surface derives from its own webgl and
  // storage checks: whether a WebGL board may be mounted at all, and whether the
  // run persists or is ephemeral. Logged once, here.
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

  // Counted as well as logged, so boot readiness reaches the metrics surface
  // beside the renderer it selected. DL-HEALTH-06.
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

  // Moved to the END of the registration order, after the renderer's own commit
  // listener: the tracing subscription's `state:commit` listener closes the turn
  // span, and listeners run in registration order.
  stopEngineTracing.reattachCommitClosing();
  const frameSubscription = loop.addFrameCallback((context): boolean => {
    // Inter-frame cadence, under its own name. `FrameContext.delta` is the gap
    // since the previous frame, clamped at `maxDelta` and zero on the first
    // frame; occupancy is a different quantity, measured by the loop and recorded
    // once through the tracer's frame hooks above.
    reporter.onTiming({
      name: FRAME_INTERVAL_TIMING,
      durationMs: context.delta,
    });

    return renderer.frame(context);
  });

  /**
   * The last state the engine committed, retained so a renderer built mid-run is
   * given the board at once. `state:commit` carries the live grid, which is
   * unchanged between turns, so a replay of it is a full reconciliation.
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

  /**
   * Names a relic, falling back to its identifier.
   *
   * @param relicId Identifier to name.
   * @returns The catalogue's name, or the identifier.
   */
  const relicName = (relicId: string): string =>
    relicDefinition(relicId)?.name ?? relicId;

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

    // NO ACTIVATION CALLBACK IS PASSED. src/ui/screens/hud.ts hosts the
    // relic-activation control but never binds it: `mountOnScreenControls` is
    // the single owner of every element-to-action binding, and `activateRelic`
    // is one of its indexed actions, so the tray press arrives through the
    // `activateRelic` subscription below rather than through the HUD. The tray
    // is in pickup order, which is the order the registry keeps, so the slot the
    // press names is the identifier's position in it. DL-MAIN-09, DL-CONTROL-04.

    // The catalogue is the only place a display name exists, and the commit's
    // relic slice carries identifiers alone, so the tray reads the name through
    // here rather than showing the raw identifier.
    relicName: (relicId): string => relicName(relicId),

    // The rarity tier, from the same catalogue definition: style/_hud.scss
    // declares an accent rule per tier. Resolved on each call, so a tray rebuilt
    // for a relic taken later in the run carries its tier too. DL-HUD-04.
    relicRarity: (relicId): string => relicDefinition(relicId)?.rarity ?? '',

    // The held relics IN PICKUP ORDER, read at the moment of every write rather
    // than snapshotted, so a budget the hook bus spent between turns is on
    // screen. The registry is the authority for that order and this reads it as
    // it stands.
    relics: (): readonly ActiveRelic[] => registry.active(),

    // Read per write as well: a board-mutating relic changes the dimension
    // mid-run, so nothing derived from it is held.
    boardSize: (): number => config.boardSize,

    // Resolved per announcement, because the ONE announcer for the page is
    // constructed below this call.
    announcer: (): LiveRegionAnnouncer | null => announcer,
    document: ownerDocument,
    reporter: createPreferenceSink(reporter),
  });

  // The HUD is a screen module, not an engine subscriber: src/ui/screens/hud.ts
  // subscribes to no emitter and takes a commit through `render`. Registered
  // BEFORE the router's own subscription, which the append-only `on` of
  // js/keyboard_input_manager.js L18-L32 preserves, so the outlets carry the
  // turn's values before a terminal commit moves the flow off the stage state.
  const stopHud = engine.events.on('state:commit', (commit): void => {
    hud.render(commit);
  });

  // The ONE announcer for the page, over `#live-region` of index.html L109, and
  // the translator that feeds it from the engine's events. One announcer rather
  // than several: live regions announcing at once race and suppress one another,
  // which is why the score outlets carry labels rather than `role="status"`.
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
  const stopAnnouncer = engineAnnouncer.subscribe(engine.events);

  // Preference changes are announced by the announcer itself, from the store's
  // own change notifications, so no second subscriber narrates them.
  const stopAnnouncedPreferences = announcer.observePreferences(preferences);

  // Follows the store rather than the setting, so an operating-system change
  // under the `'system'` setting is reflected too. Reflecting is the only thing
  // done here: the reflected attribute is the one channel the style layer and the
  // on-screen controls both read.
  const stopMotion = subscribeReducedMotion((reduced): void => {
    reflectMotion(reduced);
  });

  const stopPreferences = preferences.subscribe((_snapshot, changed): void => {
    if (changed.includes('numberOnlyMode')) {
      // The board renderer follows the effective value, so number-only mode is
      // reached and left without a reload. DL-NUMBER-01.
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

  // The screen router: the ONE owner of the effective input context, of the
  // screen state machine and of the settings dialog's shown state. Built BEFORE
  // the input manager and the control layer, both of which take `router.context`
  // as their context source. The settings panel is filled in after the input
  // manager exists, because its rebinding rows own the keymap, and the router
  // reaches it through the two hooks below. DL-ROUTER-01.
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

    rewardScreen: ownerDocument.querySelector(SELECTORS.rewardScreen),

    // Resolved per open: the parallel board's tab stop roves, so the cell
    // carrying `tabindex="0"` is read at the moment the screen goes up.
    rewardRestoreFocusTo: (): Element | null =>
      ownerDocument.querySelector(SELECTORS.boardTabStop),

    // The ONE path a chosen relic is applied through. `chooseReward()` of
    // src/ui/screen-router.ts calls this on both of its branches, so no second
    // applier is wired: the run port's `resolveReward` and `advanceStage` are
    // left off below for that reason. DL-MAIN-09.
    onRewardSelect: (relicId): void => {
      takeReward(relicId);
    },

    // Left to src/ui/screens/hud.ts, the sole writer of `.game-message`.
    // DL-HUD-01, DL-ROUTER-03.
    terminalOverlay: null,

    // Read-only members only. `startRun` is left off because the `startRun`
    // input action below reaches `startNewRun()`; `advanceStage` and
    // `resolveReward` are left off because `RunController.selectReward()`
    // already clears the offer, advances the stage and opens the next board.
    // DL-MAIN-09.
    run: {
      seed: (): string => run.seed(),
      runId: (): string => run.runId(),
      stageIndex: (): number => run.state().stageIndex,
      stageGoal: (): StageGoal => run.stageGoal(),
      goalProgress: (): number => run.goalProgress(),
      relics: (): readonly PersistedRelic[] => registry.serialize(),
      summary: (): RunSummary => run.summary(),
      endRun: (outcome: RunOutcome): RunSummary => run.endRun(outcome),
    },

    // The announcer is NOT handed over, for the reason `announceGameplay`
    // defaults to false: src/ui/a11y/engine-announcer.ts and this root own
    // narration. `SCREEN_ANNOUNCEMENTS` of src/ui/screen-router.ts restates the
    // same moments generically, and the queue of src/ui/a11y/live-region.ts
    // coalesces within a flush, so the generic string superseded the offer list
    // and the acquisition this root announces. DL-MAIN-09.
    preferences,
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

    // Counted by outcome, in two series rather than one, so each can be summed.
    // DL-METRIC-04.
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
      // carrying the same three cards.
      showPendingReward();

      return selection;
    }

    // The structured announcement, not free text: src/ui/a11y/live-region.ts
    // models a relic acquisition as its own kind, composes the copy and holds it
    // in the queue above free text. DL-LIVE-03.
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

    // Announced once per offer, and not only where the screen went up, so an
    // offer is spoken even with the reward mount point missing. Keyed on the
    // offer's own identifiers, because this runs after EVERY commit.
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

    // A remap made in an earlier session, validated by `deserializeKeymap`, which
    // answers with the defaults for a payload it cannot read. An ABSENT key is
    // the first run, not an unreadable payload, so it never reaches the guard.
    keymap: readStoredKeymap(),

    // The durable half of the manager's single rebind api. Failure is reported
    // by the storage layer and counted by the manager; it never fails the
    // rebind, which is already live in memory.
    persistKeymap: (next: Keymap): boolean =>
      storage.writeJson(KEYMAP_KEY, serializeKeymap(next)),

    // The ONE follower of a rebind: the generated controls carry each action's
    // key in their accessible names, so they re-read the table the manager holds.
    // The manager's own keydown listener reads that table directly.
    onKeymapChange: (): void => {
      controlLayer?.refresh();
    },

    // The tracer is supplied HERE AND NOWHERE ELSE in the input layer: the
    // manager is the one place a dispatch is walked, and it opens the
    // `input.dispatch` span around that whole walk, naming the event in the span's
    // `action` attribute. The on-screen controls and the touch layer dispatch
    // through this manager, so that span already covers them.
    reporter: createInputSink(reporter, tracer),
  });

  // `reducedMotion` is NOT supplied: a supplied value takes precedence over the
  // reflected attribute for the rest of the mount, and that attribute is the one
  // source the style layer reads too. It is written above, before this mount, and
  // the controls observe it for every later change.
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

  // The audio layer (AAP A5): synthesised through the Web Audio API, with no
  // binary asset. `preferences` IS supplied, which makes the store the single
  // owner of mute and volume — the engine follows it and refuses
  // `setMuted`/`setVolume` — so the `muted` and `volume` seeds are omitted.
  // Where no AudioContext constructor exists the engine reports itself
  // unavailable and every member stays safe to call. DL-AUDIO-01.
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
    // restore focus to and the game region to make inert. This turns off the
    // dialog's own, so one container carries one trap.
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
  // optional suspension members of `RouterInputSurface`. `SCREEN_SUSPENDS_INPUT`
  // of src/ui/screen-router.ts marks `reward` as a suspending state, and
  // `InputManager.handleKeyDown` drops EVERY key while suspended, including the
  // `Digit1`-`Digit3` bindings src/input/keymap.ts declares for `selectReward`
  // in the `'overlay'` context and the slot bindings it declares for
  // `activateRelic`. The overlay context alone withholds movement: every
  // movement binding is declared in the `'game'` context only. DL-MAIN-09.
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

  const stopRouter = router.subscribe(engine.events);

  /**
   * Feeds the registry's CANONICAL metric families: `game2048_merges_total`,
   * `game2048_spawns_total`, `game2048_engine_events_total{event}` and
   * `game2048_frames_rendered_total`, the families the registry declares with
   * help text and the names a dashboard is keyed to. `recordEngineEvent` also
   * reads a spawn's `position`, which separates a spawn that inserted a tile from
   * an attempt on a full board.
   *
   * `game2048_turns_total` is NOT fed from here: the turn family is fed from the
   * engine's `engine.move.resolved` counter in the report sink above, and a
   * second feed would double every turn. DL-METRIC-02.
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

  // The diagnostics surface: this build's stand-in for the metrics endpoint,
  // since a static bundle has no server to serve one from and no port for an
  // orchestrator to poll (AAP 0.7.2.4). DL-METRIC-05.
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

  // The reward screen follows the controller, subscribed AFTER `run.observe` so
  // this handler runs on the commit the controller has already drawn the offer on.
  // `isRewardPending()` is read rather than the commit's own members, so the
  // controller stays the single authority on whether a choice is owed.
  const stopRewardScreen = engine.events.on('state:commit', (): void => {
    showPendingReward();
  });

  /**
   * Discards the run in force and starts a fresh one. The order is the contract,
   * and every step replaces rather than reuses:
   *   1. the seed, decided first, because the substreams are built from it and
   *      the board is seeded from the substreams;
   *   2. the reward screen, taken down;
   *   3. the registry, cleared, so pickup order restarts at zero;
   *   4. the substreams, replaced at cursor zero from the new seed;
   *   5. `run.startRun`, which clears the stored envelope, assembles a fresh one
   *      with a new run identifier at stage 0 and opens the board;
   *   6. the correlation scope, rotated by `adoptRunScope`, which step 5
   *      publishes to BEFORE the board opens.
   * DL-MAIN-06.
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
    // which `run.startRun` publishes to BEFORE it opens the board.
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

  // The three subscriptions js/game_manager.js L9-L11 installed, under the same
  // three event names.
  //
  // No handler below opens an `input.dispatch` span of its own: the input manager
  // opens exactly one around its whole listener walk, through the `startSpan` its
  // sink carries, so every handler here already runs inside it.
  const stopMove = input.on('move', (direction): void => {
    // `'failed'` until the call returns: an attempt that throws reaches only the
    // `finally` below, and the default names the path it took.
    let resolution: FinalMoveResolution = 'failed';

    try {
      // The structured outcome, not the boolean. `move()` returns `false` for a
      // turn refused because the game is over, a turn a listener or an
      // `onBeforeMove` handler withdrew, and a turn the resolver found changed
      // nothing.
      resolution = engine.attemptMove(direction).resolution;
    } finally {
      // An attempt that moved nothing emits no `move:after`, so no event listener
      // can close the turn span; the caller holding the outcome closes it.
      // Settled INSIDE the input span, which is still open for the length of this
      // listener. A committed turn has closed its own span and a blocked move
      // opened none, so both are no-ops here.
      stopEngineTracing.settleMove({ resolution });
    }
  });

  // `restart` starts a NEW RUN rather than only reseeding the board: a run carries
  // a seed, a stage, a relic set and an identity, and `startNewRun` replaces all
  // of them. js/game_manager.js L17-L21 reset a board, which was all there was.
  const stopRestart = input.on('restart', (): void => {
    startNewRun();
  });
  const stopContinue = input.on('keepPlaying', (): void => {
    engine.continuePlaying();
  });

  // `selectReward` is NOT subscribed here. `attach()` of
  // src/ui/screen-router.ts registers that binding itself and routes the press
  // through `chooseReward()`, which reaches `onRewardSelect` above; a second
  // subscription applied the same choice twice, and the second call was refused
  // as `'already-resolved'` and counted under `run.rewardRefused` on a
  // successful selection. One owner per binding, as `MARKUP_CONTROLS` above.
  // DL-MAIN-09.

  // The index names a slot of the HUD's relic tray, which is rendered in pickup
  // order, so it resolves against the relics held directly. The deduction is
  // made through `HookBus.consumeCharge`, so a manual activation and a relic
  // handler's own request spend from one pool. The call goes through the
  // controller, which writes the budget that remains: an activation is not a
  // move, so no commit follows it on its own.
  const activateHeldRelic = (index: number, relicId: string): void => {
    const activation = run.activateRelic(
      engine,
      () => streamHolder.streams.snapshotCursors(),
      relicId,
    );
    const remaining = activation.remaining ?? null;
    const consumed = activation.consumed;

    reporter.onCount({
      name: consumed > 0 ? 'relics.activated' : 'relics.activation.refused',
      value: 1,
      detail: Object.freeze({
        index,
        relicId,
        remaining,
        persisted: activation.persisted,
      }),
    });

    if (consumed === 0) {
      return;
    }

    // The HUD alone, re-rendered from the last commit with the relic slice
    // re-read through the controller. A `state:commit` re-emitted through the
    // engine would reach both renderers as a fresh turn and replay the previous
    // turn's move, spawn and merge tweens.
    if (lastCommit !== null) {
      hud.render({ ...lastCommit, relics: run.relicContext() });
    }

    announcer.announceText(
      `Relic activated. ${String(remaining ?? 0)} charges remaining.`,
    );
  };

  // The indexed slot bindings of src/input/keymap.ts, and the generated
  // on-screen control per slot.
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

    activateHeldRelic(index, held);
  });

  // Emitted by the run-start screen's own control and by the `startRun` action.
  // Starts a run through the composed path, so the seed, the substreams, the
  // relics, the envelope and the correlation identifier are replaced together.
  //
  // THE PAYLOAD IS FORWARDED. `InputEventPayload['startRun']` of
  // src/input/keymap.ts is `string | undefined` and carries the seed the
  // run-start screen of src/ui/screens/run-start.ts reduced through
  // `normalizeEnteredSeed()`; a listener taking no argument dropped it, so a
  // typed seed reached nothing and every run was played under an originated
  // one. `startNewRun` already distinguishes the two cases — `undefined`
  // originates, a value is normalised — so the seed is handed straight to it.
  const stopStartRun = input.on('startRun', (seed): void => {
    startNewRun(seed);
  });

  // The two overlay actions src/input/keymap.ts declares for a screen's own
  // control: `continueStage` leaves stage progress for the reward offer and
  // `endRun` leaves the win state for the run summary. Both are edges of
  // `TRANSITIONS` in src/ui/screen-router.ts, so each is sent rather than
  // acted on here. DL-MAIN-09.
  const stopContinueStage = input.on('continueStage', (): void => {
    router.send('stageEnd');
  });

  const stopEndRun = input.on('endRun', (): void => {
    router.send('endRun');
  });

  loop.start();

  // What held focus before the flow started, so the boot can put it back.
  // js/application.js moved focus nowhere at load.
  const focusHeldBeforeBoot = ownerDocument.activeElement;
  const nothingHeldFocusBeforeBoot =
    focusHeldBeforeBoot === null ||
    focusHeldBeforeBoot === ownerDocument.body;

  // The state machine of AAP Figure 6, entered at `INITIAL_SCREEN` before the
  // board opens below. `readStageStart` of src/ui/screen-router.ts takes the
  // `runStart -> stage` edge on the `stage:start` that `openEngineBoard()`
  // emits, so the two calls are ordered and not interchangeable: started after
  // the board opened, the machine would hold `runStart` over a playable board.
  // DL-MAIN-09.
  const entered = router.start();

  logger.info('The screen flow started.', {
    screen: entered,
    missingMounts: router.missingMounts().length,
  });

  // The board the load resolved, through the controller so the three cases are
  // decided in one place: an adopted envelope opens on its reconciled board, an
  // envelope read and refused opens fresh, and no envelope at all falls back to
  // the engine's own legacy read, so a save written before the upgrade loads.
  run.openEngineBoard(engine);

  // The boot's own focus placement, undone. `enterScreen` of
  // src/ui/screen-router.ts places focus for every state it enters and the boot
  // enters two, and `focusContainerFor('stage')` resolves to `#game-main`, whose
  // first focusable element in DOM order is `.restart-button`. Released only
  // where nothing held focus beforehand, so a composition over a document with
  // a focused element leaves it alone, and every transition after the boot still
  // places focus. DL-MAIN-09.
  const focusHeldAfterBoot = ownerDocument.activeElement;
  const bootWindow = ownerDocument.defaultView;

  if (
    nothingHeldFocusBeforeBoot &&
    focusHeldAfterBoot !== focusHeldBeforeBoot &&
    bootWindow !== null &&
    focusHeldAfterBoot instanceof bootWindow.HTMLElement
  ) {
    focusHeldAfterBoot.blur();
    reporter.onCount({
      name: 'ui.boot.focusReleased',
      value: 1,
      detail: Object.freeze({ screen: router.current() }),
    });
  }

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

    // Expressed over the run controller, which owns the immutable active offer and
    // the single-use validated selection, so this surface adds no second
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
 * Name the running application is published under for local inspection.
 * Namespaced and underscore-prefixed, so it cannot collide with anything the
 * page or a dependency declares.
 */
const APPLICATION_GLOBAL = '__blitzy2048';

/**
 * Publishes the running application for local inspection: the handle a console
 * reaches the diagnostics surface, the tracer, the metrics registry and the
 * health surface through. The only global this module writes, and nothing in the
 * application reads it back. A global that cannot be written is contained.
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
 * Runs a callback once on the next animation frame, falling back to a zero-delay
 * timer where `requestAnimationFrame` is absent — the gap
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
 * One token per composition `bootstrap()` has scheduled and not yet run. A token
 * is deleted by the boot that owns it; `start()` clears the whole set.
 * DL-MAIN-09.
 */
const pendingBoots = new Set<object>();

/** Whether the composition in progress is the automatic boot's own. */
let booting = false;

/**
 * Cancels a deferred automatic boot, called by `start()` when a CALLER composes
 * first: one document holds one application. The boot's own call is exempt,
 * which `booting` distinguishes. DL-MAIN-09.
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
 * `window.requestAnimationFrame` callback wrapping the composition: exactly one
 * frame, not a loop, not a poll and not an immediate call.
 *
 * The readiness guard around it is new. The vanilla scripts were the last
 * elements of the body, so the document was already parsed when they ran; a
 * module script is deferred but can still be evaluated while the document is
 * loading, and the composition reads markup mount points. The one-frame deferral
 * still applies after the guard.
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
