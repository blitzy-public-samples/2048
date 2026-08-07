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
import { deriveCorrelationId } from './observability/logger';
import { createNumberOnlyRenderer } from './render/number-only-renderer';
import { createRenderLoop } from './render/render-loop';
import type {
  RenderDiagnostic,
  RenderReporter,
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
import type { RngStreams } from './rng/rng-streams';
import { createRngStreams } from './rng/rng-streams';
import { LocalStorageManager } from './storage/local-storage-manager';
import { mountOnScreenControls } from './input/on-screen-controls';
import type { UiReporter } from './ui/a11y/settings';
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
const SELECTORS = Object.freeze({
  boardNumberOnly: '#board-number-only',
  boardCanvas: '#board-canvas',
  boardA11y: '#board-a11y',
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
    // The caught value itself is written when the record carries one, so the
    // console shows its stack and its cause chain rather than only the
    // bounded two-field summary. Presence is tested with `in`, because a
    // throw can carry `null` or `undefined`.
    const reported: unknown =
      'thrown' in diagnostic ? diagnostic.thrown : (diagnostic.error ?? '');

    console.error(prefix, diagnostic.detail ?? '', reported);

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
      reporter.onCount({
        name: report.metric,
        value: report.value,
        detail: Object.freeze({
          correlationId: report.correlationId,
          hook: report.hook ?? null,
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
  const seed = createRunToken();

  // The one derivation of the run correlation identifier. Every module
  // that reports receives this value; none derives one of its own, and
  // the seed itself is never carried into a report.
  const correlationId = deriveCorrelationId(seed);
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
    correlationId,
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
      correlationId,
    }),
  });

  const loop = createRenderLoop({
    reporter,
    autoStopWhenIdle: true,
  });

  const renderer = createNumberOnlyRenderer({
    host: ownerDocument.querySelector(SELECTORS.boardNumberOnly),
    canvas: ownerDocument.querySelector(SELECTORS.boardCanvas),
    // index.html L65 ships `#board-a11y` with `role="grid"`, and the
    // number-only lattice carries the same role over the same board. Handed in
    // so the renderer that draws the board owns which of the two is exposed.
    parallelBoard: ownerDocument.querySelector(SELECTORS.boardA11y),
    // Handed in so the lattice is built at mount rather than deferred to the
    // first commit, which is what makes the board present before the first
    // turn is resolved.
    config,
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

  // The reduced-motion preference, composed here because it is the only place
  // that sees both the accessibility surface and the render layer. The store in
  // src/render/webgl-support.ts is the single effective source every animating
  // member already reads; this pushes the setting into it and reflects the
  // effective value onto the document element, which is where the stylesheet
  // and the on-screen controls read it from.
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

  setReducedMotionOverride(preferences.reducedMotionOverride());
  reflectMotion(queryReducedMotion());

  // Follows the store rather than the setting, so an operating-system change
  // under the `'system'` setting is reflected too. Reflecting is the ONLY
  // thing done here: the reflected attribute is the single channel the style
  // layer and the on-screen controls both read, so pushing the value into the
  // controls separately would give them a second, competing source.
  const stopMotion = subscribeReducedMotion((reduced): void => {
    reflectMotion(reduced);
  });

  const stopPreferences = preferences.subscribe((_snapshot, changed): void => {
    if (!changed.includes('reducedMotion')) {
      return;
    }

    // Pushed into the store, which dispatches to every animating member and
    // back through the subscription above; an explicit `reduce` or `allow`
    // therefore reaches the style layer and the controls as well as the canvas.
    setReducedMotionOverride(preferences.reducedMotionOverride());
    reflectMotion(preferences.isReducedMotion());
  });

  const input = createInputManager({
    ownerDocument,
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
      stopMotion();
      stopPreferences();
      controls.unmount();
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
