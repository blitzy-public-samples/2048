// @vitest-environment jsdom
//
// Suite for src/ui/screens/run-start.ts: the cold-load state of the screen
// flow, its optional seed field and its begin-run control.
//
// WHAT THIS FILE PINS
//   seed authority     an empty or whitespace-only field publishes NO seed, so
//                      the run controller originates one; a typed seed is
//                      published VERBATIM and reduced by the controller alone.
//                      The screen mints no seed, reduces no seed and reads no
//                      randomness.
//   shown = played     the seed the run is played under is read back through the
//                      `seedInForce` port and written into the field, shown in
//                      the notice and announced, so the field never keeps a
//                      value the run is not being played under. The port below
//                      is backed by the production `normalizeEnteredSeed`, which
//                      is what `RunController.startRun` applies.
//   one placement      the seed field carries the focus marker AND is the first
//                      focusable descendant, so `focusInitial`'s marker step
//                      and a focus trap's first-focusable default resolve to
//                      one element.
//   one announcement   the entry line is `SCREEN_ANNOUNCEMENTS.runStart`, so a
//                      router announcing the same entry composes one line.
//   refresh safety     `update` writes only the recap: text the player has
//                      typed survives it, focus is not moved and the entry line
//                      is not read again.
//   containment        an absent container, an absent emitter, a raising
//                      emitter, a raising announcer, an unsubscribed action and
//                      every post-unmount call are reported, never thrown.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { zIndex } from '../../../src/theme/tokens';
import {
  RUN_START_IDS,
  RUN_START_LAYER,
  SEED_INPUT_MAX_LENGTH,
  createRunStartScreen,
  runStartCopy,
} from '../../../src/ui/screens/run-start';
import type {
  RunStartOptions,
  RunStartScreen,
} from '../../../src/ui/screens/run-start';
import {
  SCREEN_ANNOUNCEMENTS,
  SCREEN_MOUNTS,
  createScreenRouter,
} from '../../../src/ui/screen-router';
import { createLiveRegionAnnouncer } from '../../../src/ui/a11y/live-region';
import type {
  RunStartScreenContext,
  ScreenContext,
} from '../../../src/ui/screen-router';
import type { UiReportFields, UiReporter } from '../../../src/ui/a11y/settings';
import { MAX_RUN_SEED_LENGTH } from '../../../src/rng/rng-streams';
import {
  MAX_ENTERED_SEED_LENGTH,
  normalizeEnteredSeed,
} from '../../../src/run/run-controller';

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

interface Emitted {
  readonly event: string;
  readonly payload: unknown;
}

interface Emitter {
  readonly emitted: Emitted[];
  emit(event: string, payload: unknown): number;
  subscribers: number;
}

function emitter(subscribers = 1): Emitter {
  const emitted: Emitted[] = [];

  return {
    emitted,
    subscribers,
    emit(event, payload): number {
      emitted.push({ event, payload });

      return this.subscribers;
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

function host(): HTMLElement {
  document.body.innerHTML =
    `<div class="screen-layer" id="screen-layer">` +
    `<div class="screen" id="screen-run-start" data-screen="run-start"` +
    ` role="dialog" aria-modal="true" aria-label="Start a run"></div>` +
    `</div>`;

  const element = document.querySelector<HTMLElement>('#screen-run-start');

  if (element === null) {
    throw new Error('fixture host missing');
  }

  return element;
}

function context(
  overrides: Partial<RunStartScreenContext> = {},
): ScreenContext {
  return {
    screen: 'runStart',
    trigger: 'initial',
    reducedMotion: false,
    host: document.querySelector('#screen-run-start'),
    refresh: false,
    seed: null,
    runId: null,
    previous: null,
    ...overrides,
  };
}

interface Harness {
  readonly screen: RunStartScreen;
  readonly reporter: Sink;
  readonly input: Emitter;
  readonly voice: Spoken;
  readonly container: HTMLElement;
  readonly seed: HTMLInputElement;
  readonly begin: HTMLButtonElement;
  readonly status: HTMLElement;
}

function mounted(options: Partial<RunStartOptions> = {}): Harness {
  const container = host();
  const reporter = sink();
  const input = emitter();
  const voice = announcer();

  /**
   * The seed the run would be played under, through the PRODUCTION reduction.
   *
   * `RunController.startRun` applies `normalizeEnteredSeed()` to the payload it
   * receives and `originateRunSeed()` where it receives none, so this reads the
   * last payload the screen emitted and reduces it exactly as the controller
   * would. It stands in for `() => run.seed()`, which is what src/main.ts wires.
   */
  const seedInForce = (): string | null => {
    const last = input.emitted[input.emitted.length - 1];

    if (last === undefined || typeof last.payload !== 'string') {
      return null;
    }

    return normalizeEnteredSeed(last.payload);
  };

  const screen = createRunStartScreen({
    input,
    announcer: voice,
    reporter,
    seedInForce,
    ...options,
  });

  screen.mount(container);
  screen.enter(context());

  const seed = container.querySelector<HTMLInputElement>(
    `#${RUN_START_IDS.seedInput}`,
  );
  const begin = container.querySelector<HTMLButtonElement>(
    `#${RUN_START_IDS.begin}`,
  );
  const status = container.querySelector<HTMLElement>(
    `#${RUN_START_IDS.seedStatus}`,
  );

  if (seed === null || begin === null || status === null) {
    throw new Error('subtree missing');
  }

  return { screen, reporter, input, voice, container, seed, begin, status };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('the rendered screen', () => {
  it('renders one panel into the container the router supplied', () => {
    const harness = mounted();

    expect(harness.screen.isMounted()).toBe(true);
    expect(harness.container.children).toHaveLength(1);
    expect(harness.container.firstElementChild?.className).toBe(
      'screen-panel',
    );
    expect(harness.reporter.counts('ui.runStart.mounted')).toHaveLength(1);
    expect(harness.reporter.errors()).toEqual([]);
  });

  it('reads the container selector from the router rather than its own', () => {
    expect(SCREEN_MOUNTS.runStart).toBe('#screen-run-start');
  });

  it('gives the seed field a real associated label', () => {
    const harness = mounted();
    const label = harness.container.querySelector('label');

    expect(label?.getAttribute('for')).toBe(RUN_START_IDS.seedInput);
    expect(label?.textContent).toBe(runStartCopy.seedLabel);
    expect(label?.textContent).toContain('optional');
    expect(harness.seed.getAttribute('aria-describedby')).toBe(
      RUN_START_IDS.seedHint,
    );
    expect(
      harness.container.querySelector(`#${RUN_START_IDS.seedHint}`)
        ?.textContent,
    ).toBe(runStartCopy.seedHint);
  });

  it('uses real button, input and label elements only', () => {
    const harness = mounted();

    expect(harness.begin.tagName).toBe('BUTTON');
    expect(harness.begin.type).toBe('button');
    expect(harness.seed.tagName).toBe('INPUT');
    expect(harness.seed.type).toBe('text');
    expect(harness.container.querySelectorAll('a')).toHaveLength(0);
  });

  it('marks the seed field as the first focusable descendant', () => {
    const harness = mounted();
    const focusable = harness.container.querySelectorAll(
      'button, input, [tabindex]',
    );

    expect(focusable[0]).toBe(harness.seed);
    expect(harness.seed.hasAttribute('data-focus-initial')).toBe(true);
  });

  it('names every movement modality index.html names', () => {
    for (const token of ['arrow keys', 'WASD', 'H, J, K, L', 'swipe']) {
      expect(runStartCopy.controls).toContain(token);
    }

    expect(runStartCopy.controls).toContain('Settings');
  });

  it('states the overlay rung without restating its value', () => {
    expect(RUN_START_LAYER).toBe(zIndex.screenOverlay);
    expect(RUN_START_LAYER).toBeLessThan(zIndex.diagnosticsOverlay);
    expect(RUN_START_LAYER).toBeLessThanOrEqual(zIndex.modal);
  });

  it('writes no inline style', () => {
    const harness = mounted();

    for (const element of harness.container.querySelectorAll('*')) {
      expect(element.getAttribute('style')).toBeNull();
    }
  });
});

describe('entry', () => {
  it('places focus on the seed field', () => {
    const harness = mounted();

    expect(document.activeElement).toBe(harness.seed);
  });

  it('announces the entry line once, and the router line is the same', () => {
    const harness = mounted();

    expect(harness.voice.lines).toEqual([SCREEN_ANNOUNCEMENTS.runStart]);
    expect(runStartCopy.announcement).toBe(SCREEN_ANNOUNCEMENTS.runStart);
  });

  it('does not announce or move focus on an in-state refresh', () => {
    const harness = mounted();

    harness.begin.focus();
    harness.screen.update(context({ refresh: true, trigger: 'move' }));

    expect(harness.voice.lines).toHaveLength(1);
    expect(document.activeElement).toBe(harness.begin);
  });

  it('keeps text the player typed across a refresh', () => {
    const harness = mounted();

    harness.seed.value = 'half-typed';
    harness.screen.update(context({ refresh: true }));

    expect(harness.seed.value).toBe('half-typed');
    expect(harness.screen.readSeedValue()).toBe('half-typed');
  });

  it('shows the previous run and hides the recap when there is none', () => {
    const harness = mounted();
    const recap = harness.container.querySelector<HTMLElement>(
      `#${RUN_START_IDS.previous}`,
    );

    expect(recap?.hidden).toBe(true);

    harness.screen.update(
      context({
        previous: {
          runId: 'run-1',
          seed: 'seed-1',
          score: 1234,
          stageIndex: 2,
          relics: [{ id: 'twin-seed' }],
        },
      }),
    );

    expect(recap?.hidden).toBe(false);
    expect(recap?.textContent).toBe(
      'Previous run: 1234 points, stage 3, 1 relic.',
    );

    harness.screen.update(context());

    expect(recap?.hidden).toBe(true);
  });

  it('renders no NaN when a summary carries an unreadable number', () => {
    const harness = mounted();
    const recap = harness.container.querySelector<HTMLElement>(
      `#${RUN_START_IDS.previous}`,
    );

    harness.screen.update(
      context({
        previous: {
          runId: 'run-1',
          seed: 'seed-1',
          score: Number.NaN,
          stageIndex: 0,
          relics: [],
        },
      }),
    );

    expect(recap?.hidden).toBe(true);
    expect(harness.container.textContent).not.toContain('NaN');
  });

  it('reads the preference store when the context omits the value', () => {
    const container = host();
    const isReducedMotion = vi.fn((): boolean => true);
    const screen = createRunStartScreen({
      input: emitter(),
      preferences: { isReducedMotion },
      reporter: sink(),
    });

    screen.mount(container);
    screen.enter({
      ...(context() as RunStartScreenContext),
      reducedMotion: undefined as unknown as boolean,
    });

    expect(isReducedMotion).toHaveBeenCalled();
  });

  it('reports a context belonging to another screen', () => {
    const harness = mounted();

    harness.screen.update({
      screen: 'stageClear',
      trigger: 'stageGoalMet',
      reducedMotion: false,
      host: harness.container,
      refresh: false,
      stageIndex: 1,
      cleared: true,
      score: 10,
      goal: null,
    });

    expect(
      harness.reporter.counts('ui.runStart.context.unexpected'),
    ).toHaveLength(1);
  });
});

describe('beginning a run', () => {
  it('emits no seed for an empty field', () => {
    const harness = mounted();
    const outcome = harness.screen.beginRun();

    expect(harness.input.emitted).toEqual([
      { event: 'startRun', payload: undefined },
    ]);
    expect(outcome).toEqual({
      supplied: false,
      seed: null,
      adjusted: false,
      delivered: 1,
    });
    expect(harness.screen.readLastBegin()).toEqual(outcome);
  });

  it('emits no seed for a whitespace-only field', () => {
    const harness = mounted();

    harness.seed.value = '   ';

    const outcome = harness.screen.beginRun();

    expect(harness.input.emitted[0]?.payload).toBeUndefined();
    expect(outcome.supplied).toBe(false);
    expect(outcome.seed).toBeNull();
  });

  it('emits the typed seed verbatim when nothing needed reducing', () => {
    const harness = mounted();

    harness.seed.value = 'run-seed-2048';

    const outcome = harness.screen.beginRun();

    expect(harness.input.emitted[0]).toEqual({
      event: 'startRun',
      payload: 'run-seed-2048',
    });
    expect(outcome.adjusted).toBe(false);
    expect(harness.status.hidden).toBe(true);
    expect(harness.voice.lines).toHaveLength(1);
  });

  it('shows, announces and reports a seed it had to reduce', () => {
    const harness = mounted();

    harness.seed.value = '  padded-seed  ';

    const outcome = harness.screen.beginRun();

    expect(outcome.adjusted).toBe(true);
    expect(outcome.seed).toBe('padded-seed');
    expect(harness.seed.value).toBe('padded-seed');
    expect(harness.status.hidden).toBe(false);
    expect(harness.status.textContent).toBe(
      runStartCopy.seedAdjusted('padded-seed'),
    );
    expect(harness.voice.lines).toHaveLength(2);
    expect(harness.reporter.counts('ui.runStart.seed.adjusted')).toHaveLength(
      1,
    );

    // THE PAYLOAD IS THE RAW TEXT. The controller is the normaliser, so what
    // travels is what the player typed and what is shown is what came back.
    expect(harness.input.emitted[0]?.payload).toBe('  padded-seed  ');
  });

  it('surfaces a seed the reduction had to shorten', () => {
    const harness = mounted();
    const long = 'x'.repeat(MAX_RUN_SEED_LENGTH + 8);

    harness.seed.value = long;

    const outcome = harness.screen.beginRun();

    expect(outcome.seed).toHaveLength(MAX_RUN_SEED_LENGTH);
    expect(outcome.adjusted).toBe(true);
    expect(harness.seed.value).toBe(outcome.seed);
    expect(harness.status.hidden).toBe(false);
  });

  it('caps what a player can type at the accepted seed domain', () => {
    // `maxlength` is the platform-enforced ceiling on ENTRY: a paste above it is
    // cut visibly, in the field the player is looking at, rather than being
    // accepted and silently reduced afterwards. Decision DL-RUNSTART-07.
    const harness = mounted();

    expect(SEED_INPUT_MAX_LENGTH).toBe(MAX_RUN_SEED_LENGTH);
    expect(harness.seed.maxLength).toBe(SEED_INPUT_MAX_LENGTH);
    expect(harness.seed.getAttribute('maxlength')).toBe(
      String(MAX_RUN_SEED_LENGTH),
    );
  });

  it('bounds a programmatically assigned value before reading it', () => {
    // `maxlength` governs user entry alone, so an assignment ignores it — which
    // is why the screen bounds the text itself before the whole-string presence
    // test, and why the reduction bounds what it is handed.
    const harness = mounted();

    harness.seed.value = 'w'.repeat(1_000_000);

    const outcome = harness.screen.beginRun();

    expect(outcome.supplied).toBe(true);
    expect(outcome.seed).toBe('w'.repeat(MAX_RUN_SEED_LENGTH));
    expect(outcome.adjusted).toBe(true);

    // WHAT TRAVELS IS BOUNDED BUT NOT REDUCED. The screen caps the text it reads
    // at `MAX_ENTERED_SEED_LENGTH` before any whole-string work, so a megabyte
    // assignment never reaches the presence test or the event; the reduction to
    // the accepted domain is the controller's alone, and it is what comes back.
    // Decisions DL-RUNCTL-11, DL-RUNSTART-01.
    const travelled = harness.input.emitted[0]?.payload;

    expect(typeof travelled).toBe('string');
    expect(travelled).toBe('w'.repeat(MAX_ENTERED_SEED_LENGTH));
    expect((travelled as string).length).toBeLessThanOrEqual(
      MAX_ENTERED_SEED_LENGTH,
    );
    expect(normalizeEnteredSeed(travelled as string)).toBe(outcome.seed);
  });

  it('treats a field filled past the ceiling with whitespace as empty', () => {
    // The presence test and the reduction read the SAME bounded text, so the two
    // agree on emptiness — the invariant DL-RUNSTART-01 names. Both see only
    // whitespace here, so no seed is supplied and the controller originates one.
    const harness = mounted();

    harness.seed.value = ' '.repeat(MAX_ENTERED_SEED_LENGTH + 10);

    const outcome = harness.screen.beginRun();

    expect(outcome.supplied).toBe(false);
    expect(outcome.seed).toBeNull();
    expect(harness.input.emitted[0]?.payload).toBeUndefined();
  });

  it('clears a standing notice on the next unadjusted attempt', () => {
    const harness = mounted();

    harness.seed.value = ' padded ';
    harness.screen.beginRun();
    harness.seed.value = 'clean';
    harness.screen.beginRun();

    expect(harness.status.hidden).toBe(true);
    expect(harness.status.textContent).toBe('');
  });

  it('reflects one typed seed as one value however often it is pressed', () => {
    const harness = mounted();

    harness.seed.value = '  Seed-42  ';

    const first = harness.screen.beginRun();

    harness.seed.value = '  Seed-42  ';

    const second = harness.screen.beginRun();

    // The PAYLOAD is the raw text both times, because the controller is the
    // normaliser; the seed REFLECTED is the reduced one both times, because the
    // reduction is idempotent and is read back from the run.
    expect(harness.input.emitted.map((entry) => entry.payload)).toEqual([
      '  Seed-42  ',
      '  Seed-42  ',
    ]);
    expect([first.seed, second.seed]).toEqual(['Seed-42', 'Seed-42']);
    expect(harness.seed.value).toBe('Seed-42');
  });

  it('begins from a pointer press and from Enter, but not from Space', () => {
    const harness = mounted();

    harness.begin.click();
    expect(harness.input.emitted).toHaveLength(1);

    harness.seed.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    expect(harness.input.emitted).toHaveLength(2);

    harness.seed.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
    );
    expect(harness.input.emitted).toHaveLength(2);
  });

  it('reports an action nothing is subscribed to', () => {
    const harness = mounted();

    harness.input.subscribers = 0;

    const outcome = harness.screen.beginRun();

    expect(outcome.delivered).toBe(0);
    expect(
      harness.reporter.counts('ui.runStart.startRun.unsubscribed'),
    ).toHaveLength(1);
  });

  it('reports rather than throws when no emitter was injected', () => {
    const container = host();
    const reporter = sink();
    const screen = createRunStartScreen({ reporter });

    screen.mount(container);
    screen.enter(context());

    expect(() => screen.beginRun()).not.toThrow();
    expect(screen.readLastBegin()?.delivered).toBe(0);
    expect(reporter.counts('ui.runStart.begin.refused')).toHaveLength(1);
  });

  it('contains an emitter that raises', () => {
    const container = host();
    const reporter = sink();
    const screen = createRunStartScreen({
      reporter,
      input: {
        emit(): number {
          throw new Error('emit exploded');
        },
      },
    });

    screen.mount(container);
    screen.enter(context());

    const button = container.querySelector<HTMLButtonElement>(
      `#${RUN_START_IDS.begin}`,
    );

    expect(() => button?.click()).not.toThrow();
    expect(reporter.errors()).toHaveLength(1);
    expect(screen.readLastBegin()?.delivered).toBe(0);
  });

  it('contains an announcer that raises', () => {
    const container = host();
    const reporter = sink();
    const screen = createRunStartScreen({
      reporter,
      input: emitter(),
      announcer: {
        announceText(): void {
          throw new Error('announce exploded');
        },
      },
    });

    screen.mount(container);

    expect(() => screen.enter(context())).not.toThrow();
    expect(reporter.errors()).toHaveLength(1);
  });
});

describe('leaving and unmounting', () => {
  it('clears the field on the way out', () => {
    const harness = mounted();

    harness.seed.value = 'left-over';
    harness.screen.leave();

    expect(harness.seed.value).toBe('');
    expect(harness.reporter.counts('ui.runStart.left')).toHaveLength(1);
  });

  it('removes only what it added and detaches its listeners', () => {
    const harness = mounted();

    harness.screen.unmount();

    expect(harness.container.children).toHaveLength(0);
    expect(harness.container.isConnected).toBe(true);
    expect(harness.screen.isMounted()).toBe(false);

    harness.begin.click();

    expect(harness.input.emitted).toHaveLength(0);
  });

  it('answers every later call as a reported no-op', () => {
    const harness = mounted();

    harness.screen.unmount();

    expect(() => {
      harness.screen.unmount();
      harness.screen.mount(harness.container);
      harness.screen.enter(context());
      harness.screen.update(context());
      harness.screen.leave();
      harness.screen.beginRun();
    }).not.toThrow();

    expect(harness.input.emitted).toHaveLength(0);
    expect(
      harness.reporter.counts('ui.runStart.after_unmount').length,
    ).toBeGreaterThanOrEqual(6);
  });
});

describe('a container that is not there', () => {
  it('reports a miss and renders nothing', () => {
    document.body.innerHTML = '';

    const reporter = sink();
    const screen = createRunStartScreen({ reporter, input: emitter() });

    screen.mount(null as unknown as Element);

    expect(screen.isMounted()).toBe(false);
    expect(reporter.counts('ui.runStart.mount_missing')).toHaveLength(1);
  });

  it('adopts the container a context carries', () => {
    const container = host();
    const reporter = sink();
    const screen = createRunStartScreen({ reporter, input: emitter() });

    screen.enter(context());

    expect(screen.isMounted()).toBe(true);
    expect(container.children).toHaveLength(1);
  });

  it('resolves a selector through the guarded resolver', () => {
    host();

    const reporter = sink();
    const screen = createRunStartScreen({
      reporter,
      input: emitter(),
      host: SCREEN_MOUNTS.runStart,
    });

    screen.mount(null as unknown as Element);

    expect(screen.isMounted()).toBe(true);
  });

  it('rebuilds in a replacement container, undressing the first', () => {
    const first = host();
    const screen = createRunStartScreen({ input: emitter() });

    screen.mount(first);
    expect(first.children).toHaveLength(1);

    const second = document.createElement('div');

    document.body.append(second);
    screen.mount(second);

    expect(first.children).toHaveLength(0);
    expect(second.children).toHaveLength(1);
  });
});

describe('driven by the real router', () => {
  function page(): void {
    document.body.innerHTML =
      `<main class="game-main" id="game-main">` +
      `<div class="hud" id="screen-hud" hidden></div>` +
      `<div class="game-container"><div class="game-message">` +
      `<p></p></div></div></main>` +
      `<div class="screen-layer" id="screen-layer">` +
      `<div class="screen" id="screen-run-start" data-screen="run-start"` +
      ` role="dialog" aria-modal="true" aria-label="Start a run"` +
      ` hidden></div>` +
      `<div class="screen" id="screen-stage-progress" hidden></div>` +
      `<div class="screen" id="screen-reward" hidden></div>` +
      `<div class="screen" id="screen-game-over" hidden></div>` +
      `<div class="screen" id="screen-run-summary" hidden></div>` +
      `</div>` +
      `<div class="visually-hidden live-region" id="live-region"` +
      ` role="status" aria-live="polite" aria-atomic="true"></div>`;
  }

  it('mounts, unhides, focuses the field and reads the line once', () => {
    page();

    const reporter = sink();
    const input = emitter();
    const voice = createLiveRegionAnnouncer({
      selector: '#live-region',
      root: document,
      reporter,
      autoFlush: false,

      // Synchronous, so the clear-then-write sequence completes inside `flush`
      // and the region can be read straight afterwards.
      schedule: (callback): { cancel(): void } => {
        callback();

        return {
          cancel(): void {
            return;
          },
        };
      },
    });
    const screen = createRunStartScreen({
      input,
      announcer: voice,
      reporter,

      // The controller's own reduction, read back: src/main.ts wires
      // `() => run.seed()` here.
      seedInForce: (): string =>
        normalizeEnteredSeed(
          (input.emitted[input.emitted.length - 1]?.payload as string) ?? '',
        ),
    });
    const router = createScreenRouter({
      document,
      reporter,
      screens: { runStart: screen },

      announcer: voice,
    });

    expect(router.start()).toBe('runStart');

    const container = document.querySelector<HTMLElement>('#screen-run-start');
    const seed = document.querySelector<HTMLInputElement>(
      `#${RUN_START_IDS.seedInput}`,
    );

    expect(container?.hidden).toBe(false);
    expect(seed).not.toBeNull();
    expect(document.activeElement).toBe(seed);

    voice.flush();

    const region = document.querySelector('#live-region');
    const spoken = region?.textContent ?? '';
    const line = SCREEN_ANNOUNCEMENTS.runStart;

    expect(spoken).toContain(line);
    expect(spoken.split(line)).toHaveLength(2);

    if (seed !== null) {
      seed.value = ' seeded-run ';
    }

    document
      .querySelector<HTMLButtonElement>(`#${RUN_START_IDS.begin}`)
      ?.click();

    // VERBATIM: the field's own text travels, and the reduced value came back
    // through `seedInForce` and was written into the field.
    expect(input.emitted).toEqual([
      { event: 'startRun', payload: ' seeded-run ' },
    ]);
    expect(seed?.value).toBe('seeded-run');

    // The state machine's only outgoing edge, taken by whoever answers the
    // action: the screen leaves, its field is cleared and the container hides.
    expect(router.send('beginRun', { seed: 'seeded-run' })).toBe(true);
    expect(router.current()).toBe('stage');
    expect(container?.hidden).toBe(true);
    expect(seed?.value).toBe('');

    router.destroy();

    expect(container?.children).toHaveLength(0);
    voice.destroy();
  });
});
