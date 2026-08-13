// @vitest-environment jsdom
//
// Suite for src/ui/screens/stage-progress.ts: the interstitial between a stage
// ending and the relic offer, and the one control that leaves it.
//
// WHAT THIS FILE PINS
//   one edge out       the continue control forwards to the injected callback
//                      and to nothing else, and driven by the real router that
//                      callback takes `stageClear --stageEnd--> reward`, which
//                      is the edge src/main.ts sends the trigger for.
//   payload authority  the three members of the `stage:end` payload are shown
//                      as they arrive; a run port fills only what the payload
//                      did not carry, and the goal fraction is displayed and
//                      never re-derived.
//   no line unbacked   the progress line is down until a source supplies a
//                      fraction, so no reading states a quantity nothing
//                      measured.
//   one placement      the continue control carries the focus marker AND is the
//                      only focusable descendant, so the marker step and a
//                      trap's first-focusable default resolve to one element.
//   once per visit     the clear is announced on entry and not by a refresh;
//                      `leave` releases the latch so a second visit announces.
//   containment        an absent container, a foreign context, a raising port,
//                      a raising announcer, a raising callback and every call
//                      after `unmount` are reported, never thrown.

import { afterEach, describe, expect, it } from 'vitest';

import { evaluateStageGoal } from '../../../src/config/stage-config';
import type { StageGoal } from '../../../src/config/stage-config';
import { motion, zIndex } from '../../../src/theme/tokens';
import { FOCUS_INITIAL_ATTRIBUTE } from '../../../src/ui/a11y/focus-manager';
import type { UiReportFields, UiReporter } from '../../../src/ui/a11y/settings';
import {
  SCREEN_MOUNTS,
  TRANSITIONS,
  createScreenRouter,
} from '../../../src/ui/screen-router';
import type {
  ScreenContext,
  StageClearScreenContext,
} from '../../../src/ui/screen-router';
import {
  CONTINUE_CONTROL_CLASS,
  CONTINUE_CONTROL_SELECTOR,
  STAGE_PROGRESS_CADENCE,
  STAGE_PROGRESS_LAYER,
  createStageProgressScreen,
  describeStageGoal,
  measureStageProgress,
  stageProgressCopy,
} from '../../../src/ui/screens/stage-progress';
import type {
  StageProgressOptions,
  StageProgressScreen,
} from '../../../src/ui/screens/stage-progress';

/* ==========================================================================
 * Harness
 * ========================================================================== */

interface Report {
  readonly kind: 'log' | 'count' | 'error';
  readonly name: string;
  readonly fields?: UiReportFields | undefined;
}

interface Sink extends UiReporter {
  readonly reports: Report[];
  counts(metric: string): Report[];
  errors(): Report[];
}

function sink(): Sink {
  const reports: Report[] = [];

  return {
    reports,
    log(level, message, fields): void {
      reports.push({ kind: 'log', name: `${level}:${message}`, fields });
    },
    count(metric, fields): void {
      reports.push({ kind: 'count', name: metric, fields });
    },
    error(message, _error, fields): void {
      reports.push({ kind: 'error', name: message, fields });
    },
    counts(metric): Report[] {
      return reports.filter(
        (entry) => entry.kind === 'count' && entry.name === metric,
      );
    },
    errors(): Report[] {
      return reports.filter((entry) => entry.kind === 'error');
    },
  };
}

interface Spoken {
  readonly lines: unknown[];
  announce(input: unknown): void;
}

function announcer(): Spoken {
  const lines: unknown[] = [];

  return {
    lines,
    announce(input): void {
      lines.push(input);
    },
  };
}

/** The container index.html declares for this state, and nothing else. */
function host(): HTMLElement {
  document.body.innerHTML =
    `<div class="screen-layer" id="screen-layer">` +
    `<div class="screen" id="screen-stage-progress"` +
    ` data-screen="stage-progress" role="dialog" aria-modal="true"` +
    ` aria-label="Stage progress"></div>` +
    `</div>`;

  const element = document.querySelector<HTMLElement>(
    SCREEN_MOUNTS.stageClear,
  );

  if (element === null) {
    throw new Error('fixture host missing');
  }

  return element;
}

/** The goal every case below measures against unless it says otherwise. */
const TILE_GOAL: StageGoal = Object.freeze({
  kind: 'highest-tile',
  target: 16,
});

function context(
  overrides: Partial<StageClearScreenContext> = {},
): ScreenContext {
  return {
    screen: 'stageClear',
    trigger: 'stageGoalMet',
    reducedMotion: false,
    host: document.querySelector(SCREEN_MOUNTS.stageClear),
    refresh: false,
    stageIndex: 0,
    cleared: true,
    score: 40,
    goal: TILE_GOAL,
    ...overrides,
  };
}

interface Harness {
  readonly screen: StageProgressScreen;
  readonly reporter: Sink;
  readonly voice: Spoken;
  readonly container: HTMLElement;
  readonly control: HTMLButtonElement;
}

/** A mounted screen that has entered the state once. */
function mounted(
  options: Partial<StageProgressOptions> = {},
  entered: Partial<StageClearScreenContext> = {},
): Harness {
  const container = host();
  const reporter = sink();
  const voice = announcer();
  const screen = createStageProgressScreen({
    reporter,
    announcer: voice,
    ...options,
  });

  screen.mount(container);
  screen.enter(context(entered));

  const control = container.querySelector<HTMLButtonElement>(
    CONTINUE_CONTROL_SELECTOR,
  );

  if (control === null) {
    throw new Error('the continue control was not rendered');
  }

  return { screen, reporter, voice, container, control };
}

afterEach(() => {
  document.body.innerHTML = '';
});

/* ==========================================================================
 * 1. The rendered interstitial
 * ========================================================================== */

describe('the rendered interstitial', () => {
  it('appends one panel to the container, holding its own content', () => {
    const harness = mounted();

    expect(harness.screen.hasHost()).toBe(true);
    expect(harness.screen.isPresented()).toBe(true);

    // The container takes ONE node, the `.screen-panel` surface every
    // sibling screen renders, and the five content nodes are its children.
    // DL-STAGECLEAR-06.
    const panel = harness.container.firstElementChild;

    expect(harness.container.children).toHaveLength(1);
    expect(panel?.tagName).toBe('DIV');
    expect(panel?.className).toBe('screen-panel');
    expect(Array.from(panel?.children ?? []).map((child) => child.tagName))
      .toEqual(['H2', 'P', 'P', 'P', 'DIV']);
    expect(harness.reporter.counts('ui.stageProgress.mounted')).toHaveLength(1);
    expect(harness.reporter.counts('ui.stageProgress.entered')).toHaveLength(1);
    expect(harness.reporter.errors()).toEqual([]);
  });

  it('reads the container selector from the router rather than its own', () => {
    expect(SCREEN_MOUNTS.stageClear).toBe('#screen-stage-progress');
  });

  it('states the stage as a one-based number, and its verdict', () => {
    const cleared = mounted({}, { stageIndex: 2, cleared: true });

    expect(cleared.screen.readRendered()?.stage).toBe(3);
    expect(cleared.screen.readRendered()?.heading).toBe(
      stageProgressCopy.clearedHeading(3),
    );
    expect(cleared.container.querySelector('h2')?.textContent).toBe(
      'Stage 3 cleared',
    );

    // The verdict is the payload's own flag, displayed rather than re-decided:
    // the same stage with `cleared: false` reads as ended, not cleared.
    const ended = mounted({}, { stageIndex: 2, cleared: false });

    expect(ended.screen.readRendered()?.cleared).toBe(false);
    expect(ended.container.querySelector('h2')?.textContent).toBe(
      'Stage 3 ended',
    );
  });

  it('renders the goal, the score and the measured percentage', () => {
    const harness = mounted(
      { measurement: { highestTileValue: (): number => 8 } },
      { score: 40, goal: TILE_GOAL },
    );
    const snapshot = harness.screen.readRendered();
    const evaluated = evaluateStageGoal(TILE_GOAL, {
      score: 40,
      highestTileValue: 8,
    });

    // The measurement is `evaluateStageGoal`'s own, carried through verbatim.
    expect(snapshot?.measurement).toEqual({
      achieved: evaluated.achieved,
      progress: evaluated.progress,
    });
    expect(snapshot?.goalText).toBe('tile 16, reached 8');
    expect(snapshot?.scoreText).toBe('40');
    expect(snapshot?.progressText).toBe('50% of the goal');
    expect(harness.container.textContent).toContain('tile 16, reached 8');
    expect(harness.container.textContent).toContain('50% of the goal');
  });

  it('keeps the progress line down until a source measures one', () => {
    const bare = mounted();

    // No measurement port and no fraction: the tile goal cannot be measured
    // from the payload alone, so the line is not merely blank but hidden.
    expect(bare.screen.readRendered()?.progressText).toBeNull();
    expect(bare.container.querySelectorAll('p[hidden]')).toHaveLength(1);
    expect(bare.container.textContent).not.toContain('% of the goal');
    expect(bare.reporter.counts('ui.stageProgress.measure_skipped'))
      .toHaveLength(1);

    // A run port supplying only the fraction raises the line, with the goal
    // still unmeasured.
    const fraction = mounted({ run: { goalProgress: (): number => 0.25 } });

    expect(fraction.screen.readRendered()?.progressText).toBe(
      '25% of the goal',
    );
    expect(fraction.screen.readRendered()?.measurement.achieved).toBeNull();
    expect(fraction.container.querySelectorAll('p[hidden]')).toHaveLength(0);
  });

  it('takes the stage and goal from a run port the payload left out', () => {
    const scoreGoal: StageGoal = { kind: 'score-threshold', target: 100 };
    const harness = mounted(
      {
        run: {
          stageIndex: (): number => 4,
          stageGoal: (): StageGoal => scoreGoal,
        },
      },
      {
        stageIndex: Number.NaN,
        goal: null,
        score: 40,
      },
    );
    const snapshot = harness.screen.readRendered();

    expect(snapshot?.stageIndex).toBe(4);
    expect(snapshot?.stage).toBe(5);
    expect(snapshot?.goalKind).toBe('score-threshold');
    expect(snapshot?.target).toBe(100);

    // A score goal is measurable from the payload's own score, so the line
    // reads without any board quantity being supplied.
    expect(snapshot?.goalText).toBe('100 score, scored 40');
    expect(snapshot?.progressText).toBe('40% of the goal');
  });

  it('publishes the layer and the cadence from the token layer', () => {
    const harness = mounted();

    expect(STAGE_PROGRESS_LAYER).toBe(zIndex.screenOverlay);
    expect(harness.screen.readRendered()?.layer).toBe(zIndex.screenOverlay);

    // The interval an assertion on the interstitial has to clear: the 800 ms
    // fade after the 1200 ms delay, neither value restated here.
    expect(STAGE_PROGRESS_CADENCE).toEqual({
      delay: motion.fadeIn.delay,
      duration: motion.fadeIn.duration,
      total: motion.fadeIn.delay + motion.fadeIn.duration,
    });
  });

  it('uses a real button and no anchor at all', () => {
    const harness = mounted();

    expect(harness.control.tagName).toBe('BUTTON');
    expect(harness.control.type).toBe('button');
    expect(harness.control.textContent).toBe(
      stageProgressCopy.continueLabel,
    );
    expect(harness.control.classList.contains(CONTINUE_CONTROL_CLASS)).toBe(
      true,
    );
    expect(harness.container.querySelectorAll('a')).toHaveLength(0);
    expect(harness.screen.readContinueControl()).toBe(harness.control);
  });

  it('names the control by its destination, over the visible label', () => {
    const harness = mounted();
    const name = harness.control.getAttribute('aria-label');

    expect(name).toBe(stageProgressCopy.continueName);
    expect(name).toContain(stageProgressCopy.continueLabel);
  });
});

/* ==========================================================================
 * 2. The pure helpers
 * ========================================================================== */

describe('the goal readout', () => {
  it('branches on the goal kind, and names an absent goal', () => {
    expect(describeStageGoal(TILE_GOAL, null)).toBe('tile 16');
    expect(describeStageGoal(TILE_GOAL, 8)).toBe('tile 16, reached 8');
    expect(
      describeStageGoal({ kind: 'score-threshold', target: 100 }, null),
    ).toBe('100 score');
    expect(
      describeStageGoal({ kind: 'score-threshold', target: 100 }, 40),
    ).toBe('100 score, scored 40');
    expect(describeStageGoal(null, 8)).toBe(stageProgressCopy.goalAbsent);
  });
});

describe('the measurement resolution', () => {
  const facts = Object.freeze({ stageIndex: 0, cleared: true, score: 40 });

  it('prefers a whole measurement a caller already holds', () => {
    const result = measureStageProgress(facts, TILE_GOAL, {
      measurement: { achieved: 16, progress: 1, cleared: true },
      fraction: 0.1,
      highestTileValue: 2,
    });

    expect(result).toEqual({
      achieved: 16,
      progress: 1,
      source: 'measurement-port',
    });
  });

  it('evaluates the goal where the quantity for its kind is available', () => {
    expect(
      measureStageProgress(facts, TILE_GOAL, { highestTileValue: 8 }),
    ).toEqual({ achieved: 8, progress: 0.5, source: 'evaluated' });

    // A score goal needs no board quantity: the payload's score is the one it
    // measures against.
    expect(
      measureStageProgress(facts, { kind: 'score-threshold', target: 100 }),
    ).toEqual({ achieved: 40, progress: 0.4, source: 'evaluated' });
  });

  it('falls back to a fraction, and then to neither', () => {
    expect(measureStageProgress(facts, TILE_GOAL, { fraction: 0.75 })).toEqual({
      achieved: null,
      progress: 0.75,
      source: 'fraction-port',
    });
    expect(measureStageProgress(facts, null)).toEqual({
      achieved: null,
      progress: null,
      source: 'none',
    });

    // A fraction outside the closed unit interval is not displayed: it is
    // refused rather than re-bounded here.
    expect(
      measureStageProgress(facts, null, { fraction: 1.5 }).progress,
    ).toBeNull();
  });

  it('is deterministic for identical arguments', () => {
    const first = measureStageProgress(facts, TILE_GOAL, {
      highestTileValue: 8,
    });
    const second = measureStageProgress(facts, TILE_GOAL, {
      highestTileValue: 8,
    });

    expect(second).toEqual(first);
  });
});

/* ==========================================================================
 * 3. The one edge out
 * ========================================================================== */

describe('the continue control', () => {
  it('forwards one press to the callback and counts it', () => {
    let presses = 0;
    const harness = mounted({
      onContinue: (): void => {
        presses += 1;
      },
    });

    harness.control.click();

    expect(presses).toBe(1);
    expect(harness.reporter.counts('ui.stageProgress.continue')).toHaveLength(
      1,
    );
    expect(harness.reporter.errors()).toEqual([]);
  });

  it('ignores a press on anything else inside the container', () => {
    let presses = 0;
    const harness = mounted({
      onContinue: (): void => {
        presses += 1;
      },
    });

    harness.container.querySelector('h2')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );

    expect(presses).toBe(0);
    expect(harness.reporter.counts('ui.stageProgress.continue')).toEqual([]);
  });

  it('binds no listener at all where no callback was supplied', () => {
    // The control is left for src/input/on-screen-controls.ts to promote and
    // bind through `CONTINUE_CONTROL_SELECTOR`, so a composition wires exactly
    // one of the two paths and a press here reaches neither.
    const harness = mounted();

    expect(() => {
      harness.control.click();
    }).not.toThrow();
    expect(harness.reporter.counts('ui.stageProgress.continue')).toEqual([]);
    expect(harness.reporter.errors()).toEqual([]);
  });

  it('contains a callback that raises', () => {
    const harness = mounted({
      onContinue: (): void => {
        throw new Error('the reward screen is not ready');
      },
    });

    expect(() => {
      harness.control.click();
    }).not.toThrow();
    expect(
      harness.reporter.counts('ui.stageProgress.continue_faulted'),
    ).toHaveLength(1);
    expect(harness.reporter.errors()).toHaveLength(1);
    expect(harness.reporter.errors()[0]?.name).toBe(
      'the continue callback raised',
    );
  });

  it('takes the declared edge to the offer, driven by the router', () => {
    document.body.innerHTML =
      `<main id="game-main"><div class="hud" id="screen-hud" hidden></div>` +
      `<div class="game-container"><div class="game-message"><p></p>` +
      `</div></div></main>` +
      `<div class="screen-layer" id="screen-layer">` +
      `<div class="screen" id="screen-stage-progress" hidden></div>` +
      `<div class="screen" id="screen-reward" hidden></div>` +
      `</div>`;

    const reporter = sink();
    let router = createScreenRouter({ document, reporter });
    const screen = createStageProgressScreen({
      reporter,
      onContinue: (): void => {
        router.send('stageEnd');
      },
    });

    router = createScreenRouter({
      document,
      reporter,
      screens: { stageClear: screen },
    });

    expect(router.start()).toBe('runStart');
    expect(router.send('beginRun')).toBe(true);
    expect(router.send('stageGoalMet', { cleared: true })).toBe(true);
    expect(router.current()).toBe('stageClear');

    const interstitial = document.querySelector<HTMLElement>(
      SCREEN_MOUNTS.stageClear,
    );

    expect(interstitial?.hidden).toBe(false);

    const control = interstitial?.querySelector<HTMLButtonElement>(
      CONTINUE_CONTROL_SELECTOR,
    );

    expect(control).not.toBeNull();

    control?.click();

    // THE EDGE AAP Figure 6 declares, and the trigger src/main.ts sends for
    // this action: one press, one transition, and the interstitial leaves.
    expect(TRANSITIONS.stageClear.stageEnd).toBe('reward');
    expect(router.current()).toBe('reward');
    expect(interstitial?.hidden).toBe(true);
    expect(interstitial?.children).toHaveLength(0);
    expect(
      document.querySelector<HTMLElement>(SCREEN_MOUNTS.reward)?.hidden,
    ).toBe(false);

    router.destroy();
  });
});

/* ==========================================================================
 * 4. Focus
 * ========================================================================== */

describe('focus on entry', () => {
  it('places focus on the marked control, the only focusable one', () => {
    const harness = mounted();

    expect(harness.control.hasAttribute(FOCUS_INITIAL_ATTRIBUTE)).toBe(true);
    expect(document.activeElement).toBe(harness.control);

    // ONE PLACEMENT: the marker step and a trap's first-focusable default
    // resolve to the same element because there is only one.
    expect(
      harness.container.querySelectorAll('button, input, [tabindex]'),
    ).toHaveLength(1);
  });

  it('leaves focus alone where the composition places it', () => {
    const harness = mounted({ placeFocus: false });

    expect(harness.control.hasAttribute(FOCUS_INITIAL_ATTRIBUTE)).toBe(true);
    expect(document.activeElement).not.toBe(harness.control);
  });

  it('reads the motion preference through its port, containing a raise', () => {
    let asked = 0;
    const harness = mounted({
      preferences: {
        isReducedMotion: (): boolean => {
          asked += 1;

          return true;
        },
      },
    });

    expect(asked).toBeGreaterThan(0);
    expect(document.activeElement).toBe(harness.control);

    const raising = mounted({
      preferences: {
        isReducedMotion: (): boolean => {
          throw new Error('no preference store');
        },
      },
    });

    // Contained: the placement still happened, and the raise was reported
    // rather than propagated out of the entry.
    expect(document.activeElement).toBe(raising.control);
    expect(
      raising.reporter.counts('ui.stageProgress.port_faulted'),
    ).toHaveLength(1);
  });
});

/* ==========================================================================
 * 5. Announcement, refresh and exit
 * ========================================================================== */

describe('the announcement', () => {
  it('writes the clear once per visit, with primitives only', () => {
    const harness = mounted({}, { stageIndex: 1, cleared: true });

    expect(harness.voice.lines).toEqual([
      { kind: 'stageClear', stageIndex: 1, cleared: true },
    ]);
    expect(harness.screen.readRendered()?.announced).toBe(true);
    expect(harness.reporter.counts('ui.stageProgress.announced')).toHaveLength(
      1,
    );

    // A refresh announces nothing, so a re-render cannot repeat the line.
    harness.screen.update(context({ stageIndex: 1, score: 99 }));

    expect(harness.voice.lines).toHaveLength(1);
    expect(harness.screen.readRendered()?.announced).toBe(false);

    // A SECOND VISIT announces again: `leave` releases the latch.
    harness.screen.leave();
    harness.screen.enter(context({ stageIndex: 1, cleared: false }));

    expect(harness.voice.lines).toHaveLength(2);
    expect(harness.voice.lines[1]).toEqual({
      kind: 'stageClear',
      stageIndex: 1,
      cleared: false,
    });
  });

  it('contains an announcer that raises', () => {
    const container = host();
    const reporter = sink();
    const screen = createStageProgressScreen({
      reporter,
      announcer: {
        announce: (): void => {
          throw new Error('no live region');
        },
      },
    });

    screen.mount(container);

    expect(() => {
      screen.enter(context());
    }).not.toThrow();
    expect(screen.readRendered()?.announced).toBe(false);
    expect(reporter.counts('ui.stageProgress.port_faulted')).toHaveLength(1);
    expect(reporter.errors()[0]?.name).toBe(
      'the stage clear could not be announced',
    );
    expect(container.querySelector('h2')?.textContent).toBe(
      'Stage 1 cleared',
    );
  });
});

describe('a refresh while the state stands', () => {
  it('writes nothing where it would write what is already on screen', () => {
    const harness = mounted();

    harness.screen.update(context());

    expect(harness.reporter.counts('ui.stageProgress.unchanged')).toHaveLength(
      1,
    );
    expect(harness.reporter.counts('ui.stageProgress.updated')).toEqual([]);
  });

  it('writes the changed values, without moving focus', () => {
    const harness = mounted();

    harness.control.blur();
    harness.screen.update(context({ score: 120 }));

    expect(harness.reporter.counts('ui.stageProgress.updated')).toHaveLength(1);
    expect(harness.screen.readRendered()?.scoreText).toBe('120');
    expect(harness.container.textContent).toContain('120');
    expect(document.activeElement).not.toBe(harness.control);
  });
});

describe('leaving the state', () => {
  it('takes its own nodes away and leaves the last render readable', () => {
    const harness = mounted();
    const rendered = harness.screen.readRendered();

    harness.screen.leave();

    expect(harness.container.children).toHaveLength(0);
    expect(harness.screen.isPresented()).toBe(false);
    expect(harness.screen.readRendered()).toBe(rendered);
    expect(harness.reporter.counts('ui.stageProgress.left')).toHaveLength(1);

    // Re-entered, the same container carries the content again.
    harness.screen.enter(context());

    expect(harness.container.children).toHaveLength(1);
    expect(harness.container.firstElementChild?.children).toHaveLength(5);
  });

  it('removes nothing the container already held', () => {
    const container = host();
    const kept = document.createElement('span');

    kept.id = 'kept';
    container.append(kept);

    const screen = createStageProgressScreen({ reporter: sink() });

    screen.mount(container);
    screen.enter(context());
    screen.leave();
    screen.unmount();

    expect(container.querySelector('#kept')).toBe(kept);
  });
});

/* ==========================================================================
 * 6. Containment
 * ========================================================================== */

describe('containment', () => {
  it('reports an absent container and renders nothing', () => {
    document.body.innerHTML = '';

    const reporter = sink();
    const screen = createStageProgressScreen({ reporter, host: '#nowhere' });

    expect(() => {
      screen.enter(context({ host: null }));
    }).not.toThrow();
    expect(screen.hasHost()).toBe(false);
    expect(screen.isPresented()).toBe(false);
    expect(screen.readRendered()).toBeNull();
    expect(
      reporter.counts('ui.stageProgress.mount_missing'),
    ).not.toHaveLength(0);
  });

  it('refuses a context belonging to another state', () => {
    const container = host();
    const reporter = sink();
    const screen = createStageProgressScreen({ reporter });

    screen.mount(container);
    screen.enter({
      screen: 'reward',
      trigger: 'stageEnd',
      reducedMotion: false,
      host: container,
      refresh: false,
      offers: [],
      drawn: [],
      stageIndex: 0,
    });

    expect(screen.readRendered()).toBeNull();
    expect(container.children).toHaveLength(0);

    const refusals = reporter.counts('ui.stageProgress.context_rejected');

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.fields?.member).toBe('enter');
  });

  it('contains a run port that raises, and shows the fallback', () => {
    const harness = mounted(
      {
        run: {
          stageIndex: (): number => {
            throw new Error('no run');
          },
        },
      },
      { stageIndex: Number.NaN },
    );

    // The neutral first stage stands in, so the interstitial still reads.
    expect(harness.screen.readRendered()?.stageIndex).toBe(0);
    expect(harness.container.querySelector('h2')?.textContent).toBe(
      'Stage 1 cleared',
    );

    const faults = harness.reporter.counts('ui.stageProgress.port_faulted');

    expect(faults).toHaveLength(1);
    expect(faults[0]?.fields?.member).toBe('stageIndex');
    expect(harness.reporter.errors()[0]?.name).toBe(
      'a stage progress port raised',
    );
  });

  it('reports every call that reaches an unmounted screen', () => {
    const harness = mounted();

    harness.screen.unmount();

    expect(harness.container.children).toHaveLength(0);
    expect(harness.screen.hasHost()).toBe(false);
    expect(harness.reporter.counts('ui.stageProgress.unmounted')).toHaveLength(
      1,
    );

    expect(() => {
      harness.screen.mount(harness.container);
      harness.screen.enter(context());
      harness.screen.update(context());
      harness.screen.leave();
      harness.screen.unmount();
    }).not.toThrow();

    const refused = harness.reporter.counts(
      'ui.stageProgress.call_after_unmount',
    );

    expect(refused.map((entry) => entry.fields?.member)).toEqual([
      'mount',
      'enter',
      'update',
      'leave',
      'unmount',
    ]);
    expect(harness.container.children).toHaveLength(0);
  });
});
