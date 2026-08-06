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
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

// The stylesheet enters through the module graph. index.html's <link> to
// the committed generated CSS was removed; this import is its replacement
// and it is the only one in the module graph.
import '../style/main.scss';

import { createDefaultRulesConfig } from './config/default-config';
import type { RulesConfig } from './config/rules-config';
import { Engine } from './engine/engine';
import type { EngineReporter } from './engine/types';
import { createInputManager } from './input/input-manager';
import type { InputReporter } from './input/keymap';
import { createNumberOnlyRenderer } from './render/number-only-renderer';
import { createRenderLoop } from './render/render-loop';
import type {
  RenderDiagnostic,
  RenderReporter,
  WebGLSupportResult,
} from './render/webgl-support';
import {
  createRenderReporter,
  probeWebGLSupport,
} from './render/webgl-support';
import type { RngStreams } from './rng/rng-streams';
import { createRngStreams } from './rng/rng-streams';
import { LocalStorageManager } from './storage/local-storage-manager';

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
const SELECTORS = Object.freeze({
  boardNumberOnly: '#board-number-only',
  boardCanvas: '#board-canvas',
  score: '.score-container',
  best: '.best-container',
  message: '.game-message',
});

/**
 * One control the markup declares, and the action a pointer activation on
 * it publishes.
 *
 * Ported from the three `bindButtonPress` calls at
 * js/keyboard_input_manager.js L72-L74: `.retry-button` and
 * `.restart-button` both published `restart`, and `.keep-playing-button`
 * published `keepPlaying`. The order below is the order those three lines
 * bound them in.
 *
 * src/input/input-manager.ts binds no control element itself — it exposes
 * `restart` and `keepPlaying` for a caller to invoke — so the binding lives
 * here, at the composition root that already owns every other selector.
 */
const CONTROL_BINDINGS: readonly {
  readonly selector: string;
  readonly action: 'restart' | 'keepPlaying';
}[] = Object.freeze([
  Object.freeze({ selector: '.retry-button', action: 'restart' as const }),
  Object.freeze({ selector: '.restart-button', action: 'restart' as const }),
  Object.freeze({
    selector: '.keep-playing-button',
    action: 'keepPlaying' as const,
  }),
]);

/* --------------------------------------------------------------------------
 * Reporting
 * ----------------------------------------------------------------------- */

/**
 * Writes a diagnostic to the console.
 *
 * The vanilla sources contained no `console` call of any kind and their
 * only `catch` clause discarded its error object
 * (js/local_storage_manager.js L37-L39). Every layer below reports
 * through an injected sink, and this is the sink the browser build
 * supplies.
 *
 * @param diagnostic Record to write.
 */
function writeDiagnostic(diagnostic: RenderDiagnostic): void {
  const prefix = `[${diagnostic.source}] ${diagnostic.message}`;

  if (diagnostic.level === 'error') {
    console.error(prefix, diagnostic.detail ?? '', diagnostic.error ?? '');

    return;
  }

  if (diagnostic.level === 'warning') {
    console.warn(prefix, diagnostic.detail ?? '');

    return;
  }

  console.info(prefix, diagnostic.detail ?? '');
}

/**
 * Builds the render sink: diagnostics to the console, counters and
 * timings discarded.
 *
 * @returns A frozen reporter.
 */
function createSink(): RenderReporter {
  return createRenderReporter({ onDiagnostic: writeDiagnostic });
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
  };
}

/**
 * Adapts a render sink to the engine's sink shape.
 *
 * @param reporter Render sink to write through.
 * @returns An engine sink.
 */
function createEngineSink(reporter: RenderReporter): EngineReporter {
  return {
    onHookError(report): void {
      reporter.onDiagnostic({
        level: 'error',
        source: 'engine',
        message: `A ${report.hook} handler threw.`,
        detail: Object.freeze({
          runId: report.runId,
          hook: report.hook,
          subscriber: report.subscriberId,
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
      reporter.onCount({
        name: report.metric,
        value: report.value,
        detail: Object.freeze({
          runId: report.runId,
          hook: report.hook ?? null,
        }),
      });
    },
  };
}

/* --------------------------------------------------------------------------
 * Run seed
 * ----------------------------------------------------------------------- */

/** Bytes drawn for a run seed. */
const SEED_BYTES = 8;

/** Radix every seed component is written in. */
const SEED_RADIX = 36;

/**
 * Creates a run seed.
 *
 * Web Crypto is the source where it is available. Where it is not, the
 * two clocks are combined, which yields a distinct seed per page load
 * without reaching for `Math.random()`: no module under src/ calls it,
 * and a test asserts the global is never replaced.
 *
 * @returns A seed string, used verbatim by the substreams.
 */
function createRunSeed(): string {
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

/** How the board is drawn, and why that mode was chosen. */
export interface BoardRenderSelection {
  /** The rendering mode in use. */
  readonly mode: 'number-only';

  /**
   * Whether the mode is standing in for an unavailable WebGL context,
   * rather than being the mode this build draws with. Read by the
   * capability report below.
   */
  readonly fallback: boolean;

  /** The probe result the selection was made from. */
  readonly support: WebGLSupportResult;
}

/**
 * Selects the board rendering mode.
 *
 * The probe is consulted before any renderer is mounted, which is the
 * order a WebGL prerequisite has to be checked in: it is a hard runtime
 * prerequisite the product has never had. The number-only renderer is
 * both this build's board renderer and the mode a machine with no WebGL
 * context is served, and the two cases are distinguished in the report
 * so the capability is observable rather than assumed.
 *
 * @param reporter Sink the probe reports through.
 * @returns The selected mode, and the probe result behind it.
 */
function selectBoardRenderer(
  reporter: RenderReporter,
): BoardRenderSelection {
  const support = probeWebGLSupport(reporter);

  return Object.freeze({
    mode: 'number-only' as const,
    fallback: !support.supported,
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

  /** Stops the frame loop and removes every listener that was bound. */
  readonly dispose: () => void;
}

/**
 * Builds and starts the application.
 *
 * The order is load-bearing. The configuration and the substreams are
 * built first because the engine reads both; the engine is constructed
 * before any subscriber so the subscribers can attach to it; and
 * `setup()` runs last, so the first state commit reaches a renderer that
 * is already listening. js/game_manager.js L13 called `setup()` from its
 * own constructor and therefore emitted its first actuation before
 * anything else could have attached.
 *
 * @param ownerDocument Document to mount into. Defaults to the ambient
 *   `document`.
 * @returns The composed application.
 */
export function start(ownerDocument: Document): Application {
  const reporter = createSink();
  const config = createDefaultRulesConfig();
  const seed = createRunSeed();
  const streams = createRngStreams(seed);
  const storage = new LocalStorageManager({
    reporter: {
      onFailure: (failure): void => {
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
      },
    },
  });

  const engine = new Engine({
    config,
    streams,
    storage,
    reporter: createEngineSink(reporter),
  });

  const selection = selectBoardRenderer(reporter);

  reporter.onDiagnostic({
    level: 'info',
    source: 'main',
    message: `Board drawn by the ${selection.mode} renderer.`,
    detail: Object.freeze({
      mode: selection.mode,
      webglFallback: selection.fallback,
      webglLevel: selection.support.level,
      boardSize: config.boardSize,
      seed,
    }),
  });

  const loop = createRenderLoop({
    reporter,
    autoStopWhenIdle: true,
  });

  const renderer = createNumberOnlyRenderer({
    host: ownerDocument.querySelector(SELECTORS.boardNumberOnly),
    canvas: ownerDocument.querySelector(SELECTORS.boardCanvas),
    scoreContainer: ownerDocument.querySelector(SELECTORS.score),
    bestContainer: ownerDocument.querySelector(SELECTORS.best),
    messageContainer: ownerDocument.querySelector(SELECTORS.message),
    ownerDocument,
    superThreshold: config.winValue,
    reporter,
    onWork: (): void => {
      loop.invalidate();
    },
  });

  const stopRendering = renderer.subscribe(engine.events);
  const frameSubscription = loop.addFrameCallback((): boolean =>
    renderer.frame(),
  );

  const input = createInputManager({
    ownerDocument,
    reporter: createInputSink(reporter),
  });

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

  // Pointer activation of the three controls the markup declares, which is
  // what js/keyboard_input_manager.js L72-L74 bound through
  // `bindButtonPress`. Each lookup is guarded: an absent control is
  // reported and skipped rather than throwing, because none of the vanilla
  // selector lookups was null-checked.
  const stopControls: (() => void)[] = [];

  for (const binding of CONTROL_BINDINGS) {
    const element = ownerDocument.querySelector(binding.selector);

    if (element === null) {
      reporter.onDiagnostic({
        level: 'warning',
        source: 'input',
        message: 'An input control is absent.',
        detail: Object.freeze({
          selector: binding.selector,
          action: binding.action,
        }),
      });

      continue;
    }

    const onActivate = (event: Event): void => {
      if (binding.action === 'restart') {
        input.restart(event);

        return;
      }

      input.keepPlaying(event);
    };

    element.addEventListener('click', onActivate);
    stopControls.push((): void => {
      element.removeEventListener('click', onActivate);
    });
  }

  loop.start();
  engine.setup();

  return Object.freeze({
    engine,
    config,
    streams,
    renderer: selection,
    dispose: (): void => {
      stopMove();
      stopRestart();
      stopContinue();

      for (const stop of stopControls) {
        stop();
      }

      stopRendering();
      frameSubscription.remove();
      input.detach();
      loop.stop();
      renderer.destroy();
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
function bootstrap(): void {
  if (typeof document === 'undefined') {
    return;
  }

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      (): void => {
        start(document);
      },
      { once: true },
    );

    return;
  }

  start(document);
}

bootstrap();
