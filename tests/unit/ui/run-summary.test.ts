// @vitest-environment jsdom
//
// Suite for src/ui/screens/run-summary.ts: the panel a finished run ends on,
// its relic list, its copyable seed and its two actions.
//
// WHAT THIS FILE PINS
//   summary authority  the context's own summary is preferred, a run port fills
//                      what it left out, and the seed is rendered VERBATIM —
//                      never normalised, re-derived or redacted on screen.
//   pickup order       the relic list's source order is pickup order, never
//                      sorted and never reversed, and an identifier the
//                      catalogue does not carry is still shown and counted.
//   action precedence  the new-run action takes the caller's callback, then the
//                      router's `newRun` edge, then the input emitter. The
//                      panel starts no run and ends none itself.
//   copy ladder        the clipboard first, then a selection, and a text
//                      confirmation for every outcome including the one where
//                      there is nothing to copy. Nothing is ever read back.
//   one placement      the copy control carries the focus marker, so the
//                      placement is deterministic rather than first-in-tree.
//   containment        an absent host, a foreign context, a raising port, a
//                      refusing clipboard, a raising callback and every call
//                      after `destroy` are reported, never thrown.

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_STAGE_CONFIG,
  stageGoalForIndex,
} from '../../../src/config/stage-config';
import type {
  PersistedRelic,
  RunSummary,
} from '../../../src/run/run-state';
import { fieldWidth, zIndex } from '../../../src/theme/tokens';
import { FOCUS_INITIAL_ATTRIBUTE } from '../../../src/ui/a11y/focus-manager';
import type { UiReportFields, UiReporter } from '../../../src/ui/a11y/settings';
import {
  SCREEN_MOUNTS,
  TRANSITIONS,
  createScreenRouter,
} from '../../../src/ui/screen-router';
import type {
  RunSummaryScreenContext,
  ScreenContext,
} from '../../../src/ui/screen-router';
import {
  RUN_SUMMARY_SELECTOR,
  createRunSummaryScreen,
  runSummaryAttributes,
  runSummaryClasses,
  runSummaryCopy,
} from '../../../src/ui/screens/run-summary';
import type {
  RunSummaryScreen,
  RunSummaryScreenOptions,
} from '../../../src/ui/screens/run-summary';

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
  readonly lines: string[];
  announceText(text: string): void;
}

function announcer(): Spoken {
  const lines: string[] = [];

  return {
    lines,
    announceText(text): void {
      lines.push(text);
    },
  };
}

/** The container index.html declares for this state. */
function host(): HTMLElement {
  document.body.innerHTML =
    `<div class="screen-layer" id="screen-layer">` +
    `<div class="screen" id="screen-run-summary" data-screen="run-summary"` +
    ` role="dialog" aria-modal="true" aria-label="Run summary"></div>` +
    `</div>`;

  const element = document.querySelector<HTMLElement>(
    SCREEN_MOUNTS.runSummary,
  );

  if (element === null) {
    throw new Error('fixture host missing');
  }

  return element;
}

/** Two relics whose ARRAY ORDER is the order they were picked up in. */
const HELD: readonly PersistedRelic[] = Object.freeze([
  Object.freeze({ id: 'frostbind', charges: 4 }),
  Object.freeze({ id: 'not-a-relic' }),
]);

/** A finished run, as `summarizeRunState` projects one. */
const SUMMARY: RunSummary = Object.freeze({
  runId: 'summary-run',
  seed: '  Player Seed  ',
  score: 4096,
  stageIndex: 2,
  relics: HELD,
});

function context(
  overrides: Partial<RunSummaryScreenContext> = {},
): ScreenContext {
  return {
    screen: 'runSummary',
    trigger: 'endRun',
    reducedMotion: false,
    host: document.querySelector(SCREEN_MOUNTS.runSummary),
    refresh: false,
    summary: SUMMARY,
    outcome: 'won',
    seed: SUMMARY.seed,
    ...overrides,
  };
}

interface Harness {
  readonly screen: RunSummaryScreen;
  readonly reporter: Sink;
  readonly voice: Spoken;
  readonly container: HTMLElement;
  readonly panel: HTMLElement;
}

/** A mounted panel that has entered the state once. */
function mounted(
  options: Partial<RunSummaryScreenOptions> = {},
  entered: Partial<RunSummaryScreenContext> = {},
): Harness {
  const container = host();
  const reporter = sink();
  const voice = announcer();
  const screen = createRunSummaryScreen({
    reporter,

    // The one member this panel calls, which is what its own port declares of
    // an announcer; the whole `LiveRegionAnnouncer` is the composition's.
    announcer: voice as unknown as RunSummaryScreenOptions['announcer'],
    ...options,
  });

  screen.mount(container);
  screen.enter(context(entered));

  const panel = screen.element;

  if (panel === null) {
    throw new Error('the panel was not built');
  }

  return { screen, reporter, voice, container, panel };
}

/** One control the panel rendered, addressed by its action. */
const action = (
  panel: HTMLElement,
  name: string,
): HTMLButtonElement | null =>
  panel.querySelector<HTMLButtonElement>(
    `[${runSummaryAttributes.action}="${name}"]`,
  );

afterEach(() => {
  document.body.innerHTML = '';
});

/* ==========================================================================
 * 1. The rendered panel
 * ========================================================================== */

describe('the rendered panel', () => {
  it('builds one panel into the container the router supplied', () => {
    const harness = mounted();

    expect(harness.screen.isMounted()).toBe(true);
    expect(harness.container.children).toHaveLength(1);
    expect(harness.panel.className).toBe(runSummaryClasses.panel);
    expect(harness.panel.tagName).toBe('SECTION');
    expect(harness.reporter.counts('ui.runSummary.mounted')).toHaveLength(1);
    expect(harness.reporter.counts('ui.runSummary.entered')).toHaveLength(1);
    expect(harness.reporter.errors()).toEqual([]);
  });

  it('reads the container selector from the router rather than its own', () => {
    expect(RUN_SUMMARY_SELECTOR).toBe(SCREEN_MOUNTS.runSummary);
  });

  it('carries the verdict in its heading and on its own attribute', () => {
    const won = mounted();

    expect(won.screen.readSnapshot()?.outcome).toBe('won');
    expect(won.panel.getAttribute(runSummaryAttributes.outcome)).toBe('won');
    expect(won.panel.querySelector('h2')?.textContent).toBe(
      runSummaryCopy.title('won'),
    );

    // index.html carries the page's only `h1`, so the panel's heading is an
    // `h2` and the dialog's own name stays on the container.
    expect(won.panel.querySelectorAll('h1')).toHaveLength(0);

    for (const outcome of ['lost', 'abandoned'] as const) {
      const other = mounted({}, { outcome });

      expect(other.panel.querySelector('h2')?.textContent).toBe(
        runSummaryCopy.title(outcome),
      );
      expect(other.panel.getAttribute(runSummaryAttributes.outcome)).toBe(
        outcome,
      );
    }

    // An unrecorded outcome carries no attribute at all rather than a stand-in.
    const unrecorded = mounted({}, { outcome: null });

    expect(
      unrecorded.panel.hasAttribute(runSummaryAttributes.outcome),
    ).toBe(false);
    expect(unrecorded.panel.querySelector('h2')?.textContent).toBe(
      runSummaryCopy.title(null),
    );
  });

  it('reads the score and the stage the summary carried', () => {
    const harness = mounted();
    const snapshot = harness.screen.readSnapshot();

    expect(snapshot?.score).toBe(4096);
    expect(snapshot?.stageIndex).toBe(2);

    const values = Array.from(
      harness.panel.querySelectorAll(`.${runSummaryClasses.scoreValue}`),
    ).map((element) => element.textContent);

    // The stage READS one-based while the index stays zero-based everywhere
    // else, which is the only place that offset is applied.
    expect(values).toContain('4096');
    expect(values).toContain('3');
  });

  it('derives the stage goal from the curve where no port supplies one', () => {
    const harness = mounted();
    const derived = stageGoalForIndex(2, DEFAULT_STAGE_CONFIG);

    expect(harness.screen.readSnapshot()?.goal).toEqual(derived);
    expect(harness.screen.readSnapshot()?.goalText).toBe(
      runSummaryCopy.goalValue(derived.kind, derived.target),
    );
    expect(harness.panel.textContent).toContain(
      runSummaryCopy.goalValue(derived.kind, derived.target),
    );
    expect(harness.reporter.errors()).toEqual([]);

    // A run port's own goal is preferred over the derivation.
    const supplied = mounted({
      run: { stageGoal: () => ({ kind: 'score-threshold', target: 900 }) },
    });

    expect(supplied.screen.readSnapshot()?.goalText).toBe('900 score');
  });

  it('renders the relics in pickup order, unknown identifiers included', () => {
    const harness = mounted();
    const rows = harness.screen.readSnapshot()?.relics ?? [];

    expect(rows.map((row) => row.id)).toEqual(['frostbind', 'not-a-relic']);
    expect(rows.map((row) => row.slot)).toEqual([1, 2]);
    expect(rows.map((row) => row.known)).toEqual([true, false]);
    expect(rows[0]?.charges).toBe(4);

    // The list is an ordered list, so its SOURCE ORDER is the pickup order for
    // a reader as much as for the snapshot — read off the rendered rows rather
    // than off the snapshot, which is a different projection of the same list.
    const list = harness.panel.querySelector(
      `.${runSummaryClasses.relicList}`,
    );

    expect(list?.tagName).toBe('OL');
    expect(list?.children).toHaveLength(2);
    expect(
      Array.from(
        harness.panel.querySelectorAll('[data-relic-id]'),
      ).map((row) => row.getAttribute('data-relic-id')),
    ).toEqual(['frostbind', 'not-a-relic']);
    expect(
      harness.panel
        .querySelector('[data-relic-id="frostbind"]')
        ?.getAttribute('data-charges'),
    ).toBe('4');
    expect(
      harness.reporter.counts('ui.runSummary.relic_unknown'),
    ).toHaveLength(1);
  });

  it('renders the notice instead of a list where nothing was collected', () => {
    const harness = mounted(
      {},
      { summary: { ...SUMMARY, relics: [] } },
    );

    expect(harness.screen.readSnapshot()?.relics).toEqual([]);
    expect(harness.panel.textContent).toContain(
      runSummaryCopy.relicsEmpty,
    );
    expect(
      harness.panel.querySelector(`.${runSummaryClasses.relicList}`)?.children,
    ).toHaveLength(0);
  });

  it('shows the seed verbatim, selectable and out of the tab order', () => {
    const harness = mounted();
    const seed = harness.panel.querySelector<HTMLElement>(
      `.${runSummaryClasses.seedValue}`,
    );

    // VERBATIM: the surrounding whitespace the player typed is what the run is
    // played under, so the readout is not trimmed on its way to the screen.
    expect(harness.screen.readSnapshot()?.seed).toBe('  Player Seed  ');
    expect(seed?.textContent).toBe('  Player Seed  ');
    expect(seed?.tagName).toBe('CODE');
    expect(seed?.hasAttribute('tabindex')).toBe(false);
  });

  it('states there is no seed rather than rendering an empty readout', () => {
    const harness = mounted(
      {},
      { summary: { ...SUMMARY, seed: '' }, seed: null },
    );

    expect(harness.screen.readSnapshot()?.seed).toBeNull();
    expect(harness.panel.textContent).toContain(runSummaryCopy.seedMissing);
    expect(
      harness.reporter.counts('ui.runSummary.seed_missing'),
    ).not.toHaveLength(0);
  });

  it('publishes the measure, the leading and the rung from the tokens', () => {
    const harness = mounted();

    expect(harness.screen.layout().measure).toBe(fieldWidth);
    expect(harness.screen.layout().layer).toBe(zIndex.screenOverlay);
    expect(harness.screen.layout().ceiling).toBe(zIndex.modal);

    // The panel stays below the modal rung, so the diagnostics surface above
    // both is never shadowed.
    expect(harness.screen.layout().layer).toBeLessThan(
      harness.screen.layout().ceiling,
    );
  });

  it('uses a real button and no anchor at all', () => {
    const harness = mounted({
      onNewRun: (): void => undefined,
    });
    const control = action(harness.panel, 'newRun');

    expect(control?.tagName).toBe('BUTTON');
    expect(control?.type).toBe('button');

    // The bare `<a>` elements with no `href` of index.html L36-L40 are the
    // defect this screen was written past: every control it renders is a button.
    expect(harness.panel.querySelectorAll('a')).toHaveLength(0);
  });
});

/* ==========================================================================
 * 2. The two actions
 * ========================================================================== */

describe('the new-run action', () => {
  it('prefers the caller callback over every other sink', () => {
    let calls = 0;
    let sent = 0;
    const harness = mounted({
      onNewRun: (): void => {
        calls += 1;
      },
      router: {
        send: (): boolean => {
          sent += 1;

          return true;
        },
      },
    });

    action(harness.panel, 'newRun')?.click();

    expect(calls).toBe(1);
    expect(sent).toBe(0);
    expect(
      harness.reporter.counts('ui.runSummary.action')[0]?.fields?.sink,
    ).toBe('callback');
  });

  it('sends the declared edge where only a router is attached', () => {
    const triggers: string[] = [];
    const harness = mounted({
      router: {
        send: (trigger): boolean => {
          triggers.push(trigger);

          return true;
        },
      },
    });

    action(harness.panel, 'newRun')?.click();

    // The edge AAP Figure 6 declares out of this state, and the only one.
    expect(triggers).toEqual(['newRun']);
    expect(TRANSITIONS.runSummary.newRun).toBe('runStart');
    expect(
      harness.reporter.counts('ui.runSummary.action')[0]?.fields?.sink,
    ).toBe('router');
  });

  it('publishes the input action where neither of the two is attached', () => {
    const emitted: { event: string; payload: unknown }[] = [];
    const harness = mounted({
      input: {
        emit: (event, payload): number => {
          emitted.push({ event, payload });

          return 1;
        },
      },
    });

    action(harness.panel, 'newRun')?.click();

    // The root's own `startRun` subscription is what answers this, so the panel
    // starts no run of its own.
    expect(emitted).toEqual([{ event: 'startRun', payload: undefined }]);
  });

  it('renders no control where nothing would answer it', () => {
    const harness = mounted();

    expect(harness.screen.readSnapshot()?.newRunOffered).toBe(false);
    expect(action(harness.panel, 'newRun')).toBeNull();
  });

  it('contains a callback that raises', () => {
    const harness = mounted({
      onNewRun: (): void => {
        throw new Error('the run-start screen is gone');
      },
    });

    expect(() => {
      action(harness.panel, 'newRun')?.click();
    }).not.toThrow();
    expect(harness.reporter.errors()[0]?.name).toBe(
      'the new-run action raised',
    );
  });
});

describe('ending the run, which this screen does not offer', () => {
  it('renders no end-run control, because the run has already ended', () => {
    const harness = mounted({ onNewRun: (): void => undefined });

    // ONE ACTION ON THIS SCREEN. A run is ended from the terminal screen — whose
    // `End run` control sends the `endRun` trigger the router routes here — so by
    // the time the summary is on screen there is nothing left to end, and the
    // only edge out of it is the new run. Decisions DL-SUMMARY-02, DL-GAMEOVER-02.
    expect(action(harness.panel, 'endRun')).toBeNull();
    expect(action(harness.panel, 'newRun')).not.toBeNull();

    // The outcome the ended run carried is still what the panel REPORTS, which
    // is the part of the transaction this screen owns.
    expect(harness.screen.readSnapshot()?.outcome).toBe('won');
  });

  it('offers the new run alone, and only where something answers it', () => {
    expect(mounted().screen.readSnapshot()?.newRunOffered).toBe(false);
    expect(
      mounted({ onNewRun: (): void => undefined }).screen.readSnapshot()
        ?.newRunOffered,
    ).toBe(true);
  });
});

/* ==========================================================================
 * 3. The copy ladder
 * ========================================================================== */

describe('copying the seed', () => {
  it('writes the seed to the clipboard and confirms it as text', async () => {
    const written: string[] = [];
    const harness = mounted({
      clipboard: {
        writeText: (text): void => {
          written.push(text);
        },
      },
    });

    await expect(harness.screen.copySeed()).resolves.toBe(true);

    expect(written).toEqual(['  Player Seed  ']);
    expect(harness.screen.readSnapshot()?.copyState).toBe('idle');
    expect(harness.panel.getAttribute(runSummaryAttributes.copyState)).toBe(
      'copied',
    );
    expect(harness.panel.textContent).toContain(runSummaryCopy.copySucceeded);
    expect(harness.voice.lines).toContain(runSummaryCopy.copySucceeded);
    expect(
      harness.reporter.counts('ui.runSummary.seed_copy')[0]?.fields?.path,
    ).toBe('clipboard');
  });

  it('falls back to the selection when the clipboard refuses', async () => {
    const harness = mounted({
      clipboard: {
        writeText: (): Promise<void> =>
          Promise.reject(new Error('permission denied')),
      },
    });

    // jsdom implements no `execCommand`, so the selection path cannot report a
    // performed copy and the ladder ends on its failure rung — which is the
    // rung that leaves the seed selected and says so in words.
    await expect(harness.screen.copySeed()).resolves.toBe(false);

    expect(harness.panel.getAttribute(runSummaryAttributes.copyState)).toBe(
      'failed',
    );
    expect(harness.panel.textContent).toContain(runSummaryCopy.copyFailed);
    expect(harness.reporter.errors()[0]?.name).toBe(
      'the clipboard refused the seed',
    );
    expect(document.getSelection()?.toString()).toBe('  Player Seed  ');
  });

  it('says there is nothing to copy where no seed resolved', async () => {
    const harness = mounted(
      { clipboard: null },
      { summary: { ...SUMMARY, seed: '' }, seed: null },
    );

    await expect(harness.screen.copySeed()).resolves.toBe(false);

    expect(harness.panel.getAttribute(runSummaryAttributes.copyState)).toBe(
      'unavailable',
    );
    expect(harness.panel.textContent).toContain(
      runSummaryCopy.copyUnavailable,
    );
    expect(
      harness.reporter.counts('ui.runSummary.seed_copy')[0]?.fields?.outcome,
    ).toBe('unavailable');
  });

  it('is reachable from the control, and confirms before any attempt', () => {
    const written: string[] = [];
    const harness = mounted({
      clipboard: {
        writeText: (text): void => {
          written.push(text);
        },
      },
    });

    // The confirmation is rendered from the first paint, so the line telling a
    // player how to copy is there before they press anything.
    expect(harness.panel.textContent).toContain(runSummaryCopy.copyIdle);

    const control = harness.panel.querySelector<HTMLButtonElement>(
      `.${runSummaryClasses.seedCopy}`,
    );

    expect(control?.tagName).toBe('BUTTON');
    expect(control?.textContent).toBe(runSummaryCopy.copyLabel);

    control?.click();

    expect(written).toEqual(['  Player Seed  ']);
  });
});

/* ==========================================================================
 * 4. Focus, announcement and the lifecycle
 * ========================================================================== */

describe('focus and the announcement', () => {
  it('places focus on the marked control', () => {
    const harness = mounted();
    const marked = harness.panel.querySelector(
      `[${FOCUS_INITIAL_ATTRIBUTE}]`,
    );

    expect(marked).not.toBeNull();
    expect(document.activeElement).toBe(marked);
  });

  it('announces the run once per visit, and again on a later visit', () => {
    const harness = mounted();
    const spoken = harness.voice.lines[0] ?? '';

    expect(harness.voice.lines).toHaveLength(1);
    expect(spoken).toContain(runSummaryCopy.title('won'));
    expect(spoken).toContain('4096');
    expect(spoken).toContain('Stage 3');

    // The seed itself is never announced, only its availability.
    expect(spoken).not.toContain('Player Seed');

    harness.screen.update(context());

    expect(harness.voice.lines).toHaveLength(1);

    harness.screen.leave();
    harness.screen.enter(context());

    expect(harness.voice.lines).toHaveLength(2);
  });

  it('reads a summary from the run port where the context carried none', () => {
    const harness = mounted(
      {
        run: {
          lastSummary: (): RunSummary => ({ ...SUMMARY, score: 77 }),
        },
      },
      { summary: null, seed: null },
    );

    expect(harness.screen.readSnapshot()?.score).toBe(77);
    expect(harness.screen.readSnapshot()?.seed).toBe(SUMMARY.seed);
  });
});

describe('the lifecycle', () => {
  it('re-renders in place, duplicating no relic row', () => {
    const harness = mounted();

    harness.screen.update(
      context({ summary: { ...SUMMARY, score: 8192 } }),
    );

    expect(harness.container.children).toHaveLength(1);
    expect(harness.screen.readSnapshot()?.score).toBe(8192);
    expect(
      harness.panel.querySelector(`.${runSummaryClasses.relicList}`)?.children,
    ).toHaveLength(2);
    expect(harness.reporter.counts('ui.runSummary.rendered')).toHaveLength(2);
  });

  it('clears the visit on leaving, and leaves the tree in place', () => {
    const harness = mounted();

    harness.screen.leave();

    expect(harness.screen.isMounted()).toBe(true);
    expect(
      harness.panel.querySelector(`.${runSummaryClasses.relicList}`)?.children,
    ).toHaveLength(0);
    expect(harness.reporter.counts('ui.runSummary.left')).toHaveLength(1);
  });

  it('removes its own nodes and reports every call after destroy', async () => {
    const harness = mounted({ onNewRun: (): void => undefined });
    const kept = document.createElement('span');

    kept.id = 'kept';
    harness.container.append(kept);

    harness.screen.destroy();

    expect(harness.container.querySelector('#kept')).toBe(kept);
    expect(harness.container.children).toHaveLength(1);
    expect(harness.screen.isMounted()).toBe(false);
    expect(harness.screen.element).toBeNull();
    expect(harness.reporter.counts('ui.runSummary.destroyed')).toHaveLength(1);

    harness.screen.enter(context());
    harness.screen.update(context());
    harness.screen.leave();
    harness.screen.unmount();

    await expect(harness.screen.copySeed()).resolves.toBe(false);

    const refused = harness.reporter.counts('ui.runSummary.after_destroy');

    expect(refused.map((entry) => entry.fields?.member)).toEqual([
      'enter',
      'update',
      'leave',
      'destroy',
      'copySeed',
    ]);
  });

  it('is driven end to end by the real router', () => {
    document.body.innerHTML =
      `<main id="game-main"><div class="hud" id="screen-hud" hidden></div>` +
      `<div class="game-container"><div class="game-message"><p></p>` +
      `</div></div></main>` +
      `<div class="screen-layer" id="screen-layer">` +
      `<div class="screen" id="screen-game-over" hidden></div>` +
      `<div class="screen" id="screen-run-summary" hidden></div>` +
      `<div class="screen" id="screen-run-start" hidden></div>` +
      `</div>`;

    const reporter = sink();
    const screen = createRunSummaryScreen({
      reporter,
      run: { summary: (): RunSummary => SUMMARY },
    });
    const router = createScreenRouter({
      document,
      reporter,
      screens: { runSummary: screen },
    });

    expect(router.start()).toBe('runStart');
    expect(router.send('beginRun')).toBe(true);
    expect(router.send('noMovesAvailable')).toBe(true);
    expect(router.send('acknowledge', { outcome: 'lost' })).toBe(true);
    expect(router.current()).toBe('runSummary');

    const container = document.querySelector<HTMLElement>(
      SCREEN_MOUNTS.runSummary,
    );

    expect(container?.hidden).toBe(false);
    expect(screen.isMounted()).toBe(true);
    expect(screen.readSnapshot()?.outcome).toBe('lost');
    expect(screen.readSnapshot()?.score).toBe(4096);

    router.destroy();

    expect(screen.element).toBeNull();
    expect(container?.children).toHaveLength(0);
  });
});

/* ==========================================================================
 * 5. Containment
 * ========================================================================== */

describe('containment', () => {
  it('reports a host it looked for and did not find', () => {
    document.body.innerHTML = '';

    const reporter = sink();
    const screen = createRunSummaryScreen({
      reporter,
      hostSelector: '#nowhere',
    });

    expect(() => {
      screen.enter(context({ host: null }));
    }).not.toThrow();
    expect(screen.isMounted()).toBe(false);
    expect(screen.element).toBeNull();
    expect(
      reporter.counts('ui.runSummary.mount_missing'),
    ).not.toHaveLength(0);
  });

  it('renders the neutral panel for a context of another state', () => {
    const container = host();
    const reporter = sink();
    const screen = createRunSummaryScreen({ reporter });

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

    // Counted rather than thrown, and nothing of the foreign context is shown:
    // no outcome, no seed and no relic row.
    expect(
      reporter.counts('ui.runSummary.foreign_context'),
    ).not.toHaveLength(0);
    expect(screen.readSnapshot()?.outcome).toBeNull();
    expect(screen.readSnapshot()?.seed).toBeNull();
    expect(screen.readSnapshot()?.relics).toEqual([]);
  });

  it('contains a run port that raises, and renders the fallback', () => {
    const harness = mounted(
      {
        run: {
          summary: (): RunSummary => {
            throw new Error('no run');
          },
        },
      },
      { summary: null, seed: null },
    );

    expect(harness.screen.isMounted()).toBe(true);
    expect(harness.screen.readSnapshot()?.score).toBe(0);
    expect(harness.screen.readSnapshot()?.seed).toBeNull();

    const faults = harness.reporter.counts('ui.runSummary.port_faulted');

    expect(faults).toHaveLength(1);
    expect(faults[0]?.fields?.member).toBe('summary');
    expect(harness.reporter.errors()[0]?.name).toBe(
      'a run summary port member raised',
    );
  });

  it('contains an announcer that raises', () => {
    const container = host();
    const reporter = sink();
    const screen = createRunSummaryScreen({
      reporter,
      announcer: {
        announceText: (): void => {
          throw new Error('no live region');
        },
      } as unknown as RunSummaryScreenOptions['announcer'],
    });

    screen.mount(container);

    expect(() => {
      screen.enter(context());
    }).not.toThrow();
    expect(screen.readSnapshot()?.score).toBe(4096);
    expect(reporter.errors()[0]?.name).toBe(
      'a run summary announcement raised',
    );
  });
});
