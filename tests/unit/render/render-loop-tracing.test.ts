// Integration suite over the frame-callback seam: src/render/render-loop.ts
// composed with src/observability/tracer.ts exactly as src/main.ts composes
// them.
//
// The seam is the system's only asynchronous boundary and the one validation
// gate V8 names as previously unmeasured. The loop CONTAINS a throw from a
// registered callback and from either lifecycle hook, so a frame that failed
// still ran to completion and the loop kept scheduling — and the lifecycle pair
// the root wires carried no error channel, so the `render.frame` span closed as
// though the frame had been clean. This suite drives the two production modules
// through the real wiring and asserts what the closed span says about a frame
// that failed.
//
// Nothing here reads a DOM node: the scheduler and the clock are injected, so
// each frame runs synchronously and the durations are exact.
//
// Decisions: DL-LOOP-05, DL-TRACE-14 (docs/DECISION_LOG.md).

import { beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../../../src/observability/logger';
import type { Logger } from '../../../src/observability/logger';
import { createMetricsRegistry } from '../../../src/observability/metrics';
import type { MetricsRegistry } from '../../../src/observability/metrics';
import {
  SPAN_ATTRIBUTES,
  SPAN_NAMES,
  SPAN_OUTCOMES,
  createTracer,
} from '../../../src/observability/tracer';
import type { SpanRecord, Tracer } from '../../../src/observability/tracer';
import { createRenderLoop } from '../../../src/render/render-loop';
import type {
  FrameScheduler,
  RenderLoop,
} from '../../../src/render/render-loop';
import type {
  RenderDiagnostic,
  RenderReporter,
} from '../../../src/render/webgl-support';

/** Correlation identifier the injected logger carries. */
const CORRELATION_ID = 'frame-seam-correlation';

/** A scheduler that hands its callback back rather than scheduling it. */
interface ManualScheduler extends FrameScheduler {
  /** Runs the pending frame, if one is pending, at `timestamp`. */
  run(timestamp: number): void;

  /** Whether a frame is pending. */
  pending(): boolean;
}

/**
 * A scheduler under the suite's control, so a frame runs when this suite says
 * so and at a timestamp it chooses.
 *
 * @returns The scheduler.
 */
function manualScheduler(): ManualScheduler {
  let held: FrameRequestCallback | null = null;
  let handle = 0;

  return {
    request: (callback: FrameRequestCallback): number => {
      held = callback;
      handle += 1;

      return handle;
    },

    cancel: (): void => {
      held = null;
    },

    run: (timestamp: number): void => {
      const callback = held;

      held = null;

      callback?.(timestamp);
    },

    pending: (): boolean => held !== null,
  };
}

/** Every diagnostic one loop reported, for the containment assertions. */
interface RecordingReporter extends RenderReporter {
  readonly diagnostics: RenderDiagnostic[];
}

/**
 * A render sink that records rather than logs.
 *
 * @returns The sink and what it received.
 */
function recordingReporter(): RecordingReporter {
  const diagnostics: RenderDiagnostic[] = [];

  return {
    diagnostics,
    onDiagnostic: (diagnostic: RenderDiagnostic): void => {
      diagnostics.push(diagnostic);
    },
    onCount: (): void => undefined,
    onTiming: (): void => undefined,
  };
}

let logger: Logger;
let metrics: MetricsRegistry;
let tracer: Tracer;
let scheduler: ManualScheduler;
let reporter: RecordingReporter;

beforeEach(() => {
  logger = createLogger({
    correlationId: CORRELATION_ID,
    consoleOutput: false,
  });
  metrics = createMetricsRegistry({ logger });
  tracer = createTracer({ logger, metrics });
  scheduler = manualScheduler();
  reporter = recordingReporter();
});

/**
 * Builds the loop the composition root builds: the same three lifecycle hooks,
 * read off the tracer, with the scheduler and clock injected so the frames of
 * this suite are deterministic.
 *
 * @returns The loop.
 */
function tracedLoop(): RenderLoop {
  const lifecycle = tracer.frameLifecycleHooks();

  return createRenderLoop({
    reporter,
    scheduler,
    now: (): number => 0,
    onFrameBegin: lifecycle.onFrameBegin,
    onFrameEnd: lifecycle.onFrameEnd,
    onFrameError: lifecycle.onFrameError,
  });
}

/** Every `render.frame` span the tracer retained. */
const frames = (): readonly SpanRecord[] =>
  tracer.recent().filter((record) => record.name === SPAN_NAMES.frameCallback);

describe('a frame whose callback throws', () => {
  it('closes its span as failed, carrying the error and its source', () => {
    const loop = tracedLoop();

    loop.addFrameCallback((): boolean => {
      throw new Error('the callback threw');
    });
    loop.start();
    scheduler.run(16);

    const [frame] = frames();

    expect(frames()).toHaveLength(1);

    // The span the root's lifecycle pair opened is closed as the failure it
    // was, where it used to close as a clean frame. DL-TRACE-14.
    expect(frame.attributes[SPAN_ATTRIBUTES.failed]).toBe(true);
    expect(frame.attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.failed,
    );
    expect(frame.attributes[SPAN_ATTRIBUTES.failureSource]).toBe(
      'frame-callback',
    );
    expect(frame.error?.message).toContain('the callback threw');

    // The frame still ran to completion and the loop still counted it, which is
    // the containment the loop already had and this must not change.
    expect(loop.getFrameStats().frames).toBe(1);
    expect(loop.getFrameStats().callbackErrors).toBe(1);
    expect(tracer.frameStats().frames).toBe(1);

    // And the loop's own report is unchanged: this channel adds an observer, it
    // does not move the record.
    expect(
      reporter.diagnostics.some(
        (diagnostic) =>
          diagnostic.message === 'A frame callback threw and was contained.',
      ),
    ).toBe(true);

    loop.stop();
  });

  it('leaves the next frame clean, so the mark is per frame', () => {
    const loop = tracedLoop();
    let failing = true;

    loop.addFrameCallback((): boolean => {
      if (failing) {
        throw new Error('the callback threw');
      }

      return false;
    });
    loop.start();
    scheduler.run(16);

    failing = false;

    scheduler.run(32);

    const [first, second] = frames();

    expect(frames()).toHaveLength(2);
    expect(first.attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.failed,
    );
    expect(second.attributes[SPAN_ATTRIBUTES.outcome]).toBeUndefined();
    expect(second.attributes[SPAN_ATTRIBUTES.failed]).toBeUndefined();
    expect(second.error).toBeUndefined();

    loop.stop();
  });
});

describe('a frame whose lifecycle hook throws', () => {
  /**
   * The loop the root builds, with one hook of the pair replaced by a thrower
   * so the OTHER two still come from the tracer.
   *
   * @param which Hook that throws.
   * @returns The loop.
   */
  const loopWithThrowingHook = (which: 'begin' | 'end'): RenderLoop => {
    const lifecycle = tracer.frameLifecycleHooks();
    const refuse = (): never => {
      throw new Error(`the ${which} hook threw`);
    };

    return createRenderLoop({
      reporter,
      scheduler,
      now: (): number => 0,
      onFrameBegin:
        which === 'begin' ? refuse : lifecycle.onFrameBegin,
      onFrameEnd: which === 'end' ? refuse : lifecycle.onFrameEnd,
      onFrameError: lifecycle.onFrameError,
    });
  };

  it('reports a frame-end failure on the span that frame opened', () => {
    // `onFrameEnd` is the tracer's own closer, so this case pairs the tracer's
    // begin hook with a throwing end: the span is open, the failure is
    // announced, and the span is left for the NEXT frame to supersede — which
    // is the pre-existing behaviour of an end that never arrived.
    const loop = loopWithThrowingHook('end');

    loop.addFrameCallback((): boolean => false);
    loop.start();
    scheduler.run(16);

    expect(loop.getFrameStats().hookErrors).toBe(1);

    scheduler.run(32);

    const [first] = frames();

    expect(first.attributes[SPAN_ATTRIBUTES.failed]).toBe(true);
    expect(first.attributes[SPAN_ATTRIBUTES.failureSource]).toBe('frame-end');
    expect(first.error?.message).toContain('the end hook threw');

    loop.stop();
  });

  it('reports a frame-begin failure with no span open, without throwing', () => {
    // The tracer's begin hook is the only thing that opens the span, so a
    // begin that threw leaves none — the failure is an anomaly rather than a
    // span attribute, and it must not become an exception.
    const loop = loopWithThrowingHook('begin');

    loop.addFrameCallback((): boolean => false);
    loop.start();

    expect(() => {
      scheduler.run(16);
    }).not.toThrow();

    expect(loop.getFrameStats().hookErrors).toBe(1);
    expect(frames()).toHaveLength(0);
    expect(tracer.snapshot().anomalies).toBeGreaterThan(0);

    loop.stop();
  });
});

describe('a failure observer that itself throws', () => {
  it('is contained and counted, and never re-announced', () => {
    let announced = 0;
    const loop = createRenderLoop({
      reporter,
      scheduler,
      now: (): number => 0,
      onFrameError: (): never => {
        announced += 1;

        throw new Error('the failure observer threw');
      },
    });

    loop.addFrameCallback((): boolean => {
      throw new Error('the callback threw');
    });
    loop.start();

    expect(() => {
      scheduler.run(16);
    }).not.toThrow();

    // Announced once for the callback's failure, and NOT again for its own:
    // re-entering would turn one faulty observer into an unbounded chain.
    expect(announced).toBe(1);
    expect(loop.getFrameStats().hookErrors).toBe(1);
    expect(loop.getFrameStats().callbackErrors).toBe(1);
    expect(
      reporter.diagnostics.filter((diagnostic) =>
        diagnostic.message.includes('frame-error'),
      ),
    ).toHaveLength(1);

    loop.stop();
  });
});

describe('a disabled tracer over a failing frame', () => {
  it('records no span and reports no anomaly', () => {
    tracer.setEnabled(false);

    const loop = tracedLoop();

    loop.addFrameCallback((): boolean => {
      throw new Error('the callback threw');
    });
    loop.start();
    scheduler.run(16);

    expect(frames()).toHaveLength(0);
    expect(tracer.snapshot().anomalies).toBe(0);
    expect(loop.getFrameStats().callbackErrors).toBe(1);

    loop.stop();
  });
});
