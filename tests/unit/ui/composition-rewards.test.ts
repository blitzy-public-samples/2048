// Integration suite for the composition root's RELIC wiring, AAP R3 and R5.
//
// WHAT WAS WRONG
//   The entire relic subsystem was unreachable from `src/main.ts`. Sixteen
//   relics, four family modules, a pickup-ordered registry, a rarity-weighted
//   sampler and a charge-guarding bus all shipped complete and fully unit
//   tested, and the composition root built NONE of it: no registry existed, no
//   family handler was ever registered on the engine's bus, no draw was ever
//   taken, and the engine built a hook bus of its own that no relic could reach.
//   A relic could enter a run only by being written into storage by hand, and
//   even then it appeared in the commit context while having no effect on
//   anything at all.
//
// WHAT THIS SUITE PINS
//   The whole path, end to end, through the real `start(document)`: a stage that
//   clears draws an offer of three from the catalogue through the run's own
//   substreams; taking one makes it BOTH a persisted member of the envelope and
//   a live dispatching subscriber on the engine's bus; and the relic slice of a
//   commit comes from the registry, so a charge spent this turn is in this
//   turn's commit.
//
// WHY THE RUN IS SEEDED FROM AN ENVELOPE
//   `start()` originates a fresh random seed, and the offer is drawn through the
//   run's `rarity-weight` and `relic-draw` substreams — so on a random seed
//   WHICH three relics are offered is random, and an assertion on any property
//   of a particular relic would pass or fail by luck. Writing an envelope with a
//   fixed seed and zero relic cursors makes the draw the same one every time,
//   which is the reproducibility R5 exists to guarantee and is the only way this
//   suite can assert on the relics it was handed.
//
// tests/unit/relics/** pins each relic, the registry and the sampler in
// isolation. This suite pins only that the root joins them to the engine.
//
// The board is drawn by the number-only renderer here, because jsdom implements
// no WebGL context. Nothing in this suite depends on which renderer draws.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from '../../../src/main';
import type { Application } from '../../../src/main';
import { RELIC_CATALOGUE } from '../../../src/relics/relic-registry';
import { resetWebGLSupportProbe } from '../../../src/render/webgl-support';
import type { StateCommitEvent } from '../../../src/engine/engine-events';
import type { RunState } from '../../../src/run/run-state';
import { RUN_STATE_KEY } from '../../../src/storage/storage-keys';
import { clearOwnedStorage } from '../../fixtures/storage';

/** The markup src/main.ts looks up, in the nesting index.html declares it in. */
const MARKUP = `
  <main id="game-main">
    <div class="score-container"><span class="visually-hidden">Score</span>0</div>
    <div class="best-container"><span class="visually-hidden">Best score</span>0</div>
    <button type="button" class="restart-button">New Game</button>
    <div class="game-container">
      <div class="game-message">
        <p></p>
        <div class="lower">
          <button type="button" class="keep-playing-button">Keep going</button>
          <button type="button" class="retry-button">Try again</button>
        </div>
      </div>
      <div class="board-host" id="board-host">
        <canvas class="board-canvas" id="board-canvas" aria-hidden="true"></canvas>
        <div class="board-number-only" id="board-number-only" hidden></div>
        <div class="board-a11y" id="board-a11y" role="grid" aria-busy="true"></div>
      </div>
    </div>
    <div class="on-screen-controls" id="on-screen-controls"></div>
  </main>
  <div class="visually-hidden live-region" id="live-region" role="status"
       aria-live="polite" aria-atomic="true"></div>
  <div class="diagnostics-overlay" id="diagnostics-overlay" hidden></div>
`;

/** The seed every run in this suite is played under. */
const RUN_SEED = 'stage-clear';

/**
 * The three relics `RUN_SEED` offers on the first draw, in the order drawn.
 *
 * Asserted rather than discovered: this IS the reproducibility property, and a
 * change to the catalogue, to the rarity weights or to either substream has to
 * fail here rather than pass unnoticed. All three carry charges and all three
 * bind a per-move hook, which is why this seed was chosen for the suite.
 */
const OPENING_OFFER: readonly string[] = Object.freeze([
  'temporal-anchor',
  'culling-blade',
  'tumbler',
]);

/**
 * A board one move from clearing the opening stage.
 *
 * The default curve's first goal is `highest-tile: 16`, so two 8s side by side
 * in the top row clear it in one move left.
 *
 * `cells` is column-major — `cells[x][y]` — the shape js/grid.js:L60-L69
 * serialised and this build preserves verbatim.
 */
const NEAR_CLEAR_BOARD = {
  grid: {
    size: 4,
    cells: [
      [{ position: { x: 0, y: 0 }, value: 8 }, null, null, null],
      [{ position: { x: 1, y: 0 }, value: 8 }, null, null, null],
      [null, null, null, null],
      [null, null, null, null],
    ],
  },
  score: 100,
  over: false,
  won: false,
  keepPlaying: false,
};

/**
 * The envelope this suite resumes from: a fixed seed, no relics, and both relic
 * cursors at zero so the first draw is the first draw of that seed.
 */
const seededEnvelope = (): string =>
  JSON.stringify({
    schemaVersion: 1,
    runId: 'reward-run',
    seed: RUN_SEED,
    rngCursor: {
      'spawn-value': 0,
      'spawn-position': 0,
      'relic-draw': 0,
      'rarity-weight': 0,
    },
    stageIndex: 0,
    stageGoal: { kind: 'highest-tile', target: 16 },
    goalProgress: 0,
    relics: [],
    board: NEAR_CLEAR_BOARD,
  });

let application: Application | null = null;

beforeEach(() => {
  document.body.innerHTML = MARKUP;
  resetWebGLSupportProbe();
});

afterEach(() => {
  application?.dispose();
  application = null;
  resetWebGLSupportProbe();
  document.body.innerHTML = '';
  clearOwnedStorage();
});

const press = (key: string, code: string): void => {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key, code, bubbles: true }),
  );
};

/** Starts the seeded run without clearing its stage. */
const startSeededRun = (): Application => {
  window.localStorage.setItem(RUN_STATE_KEY, seededEnvelope());

  const started = start(document);

  application = started;

  return started;
};

/** Starts the seeded run and clears its opening stage in one move. */
const clearOpeningStage = (): Application => {
  const started = startSeededRun();

  press('ArrowLeft', 'ArrowLeft');

  return started;
};

/** Plays one move in every direction, so all four per-move hooks dispatch. */
const playEveryDirection = (): void => {
  press('ArrowDown', 'ArrowDown');
  press('ArrowRight', 'ArrowRight');
  press('ArrowUp', 'ArrowUp');
  press('ArrowLeft', 'ArrowLeft');
};

/** The stored envelope, parsed, or `null` when none is stored. */
const storedRun = (): RunState | null => {
  const raw = window.localStorage.getItem(RUN_STATE_KEY);

  return raw === null ? null : (JSON.parse(raw) as RunState);
};

/** The bus's per-subscriber row for one relic, or `undefined`. */
const busRow = (
  subject: Application,
  relicId: string,
):
  | { readonly invoked: number; readonly charges?: number | undefined }
  | undefined =>
  subject.engine.hooks
    .metrics()
    .subscribers.find((row) => row.id === relicId);

/**
 * A report counter's value by report name, or `0` where it never moved.
 *
 * Every generic report is counted on one family with its own dotted name as
 * the `report` label, so the series is found by that label rather than by a
 * family name of its own. DL-METRIC-04, DL-MAIN-11.
 */
const counter = (subject: Application, report: string): number => {
  const series = subject.metrics
    .snapshot()
    .series.find(
      (candidate) =>
        candidate.name === 'game2048_reports_total' &&
        candidate.labels['report'] === report,
    );

  return series !== undefined && series.kind === 'counter' ? series.value : 0;
};

/** Lets the announcement queue flush: it clears and writes on separate tasks. */
const settleAnnouncements = async (): Promise<void> => {
  for (let turn = 0; turn < 6; turn += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};

/** Every aria-live region's text, lower-cased and joined. */
const announced = (): string =>
  Array.from(document.querySelectorAll('[aria-live]'))
    .map((region) => region.textContent ?? '')
    .join(' ')
    .toLowerCase();

/* ==========================================================================
 * 1. The offer is drawn when a stage clears
 * ========================================================================== */

describe('the reward offer', () => {
  it('is empty before any stage has cleared', () => {
    const subject = startSeededRun();

    expect(subject.rewards.offers()).toEqual([]);
  });

  it('is drawn when the opening stage clears', () => {
    const subject = clearOpeningStage();

    // Nothing drew before this wiring existed: the sampler was never called from
    // anywhere in the running application.
    expect(subject.rewards.offers()).toHaveLength(3);
  });

  it('draws the SAME three relics from the same seed', () => {
    const subject = clearOpeningStage();

    expect(subject.rewards.offers().map((offer) => offer.id)).toEqual([
      ...OPENING_OFFER,
    ]);
  });

  it('offers three DISTINCT relics from the catalogue', () => {
    const subject = clearOpeningStage();

    const ids = subject.rewards.offers().map((offer) => offer.id);

    // Sampling without replacement is what makes a duplicate structurally
    // impossible rather than merely unlikely.
    expect(new Set(ids).size).toBe(ids.length);

    for (const id of ids) {
      expect(RELIC_CATALOGUE.some((relic) => relic.id === id)).toBe(true);
    }
  });

  it('offers nothing the run already holds', () => {
    const subject = clearOpeningStage();
    const taken = subject.rewards.offers()[0]?.id ?? '';

    subject.rewards.choose(taken);

    // A second clear, so a second offer is drawn with one relic already held.
    press('ArrowDown', 'ArrowDown');
    subject.run.advanceStage();
    subject.engine.events.emit('stage:end', {
      stageIndex: 1,
      cleared: true,
      score: subject.engine.score,
    });

    expect(
      subject.rewards.offers().some((offer) => offer.id === taken),
    ).toBe(false);
  });

  it('carries what a reward card has to show, and no handlers', () => {
    const subject = clearOpeningStage();

    for (const offer of subject.rewards.offers()) {
      const declared = RELIC_CATALOGUE.find((relic) => relic.id === offer.id);

      expect(offer.name).toBe(declared?.name);
      expect(offer.rarity).toBe(declared?.rarity);
      expect(offer.description.length).toBeGreaterThan(0);
      expect(offer.hooks.length).toBeGreaterThan(0);
      expect(offer.charges).toBe(declared?.charges);

      // Plain data: a surface that renders a card holds no handler function.
      for (const value of Object.values(offer)) {
        expect(typeof value).not.toBe('function');
      }
    }
  });

  it('announces the offer through the live region', async () => {
    const subject = clearOpeningStage();

    await settleAnnouncements();

    const spoken = announced();

    expect(spoken).toContain('choose a relic');

    for (const offer of subject.rewards.offers()) {
      expect(spoken).toContain(offer.name.toLowerCase());
    }
  });

  it('counts the draw', () => {
    const subject = clearOpeningStage();

    expect(counter(subject, 'run.rewardOffered')).toBeGreaterThan(0);
  });

  it('advances only the two relic substreams', () => {
    const subject = startSeededRun();
    const before = subject.streams.snapshotCursors();

    press('ArrowLeft', 'ArrowLeft');

    const after = subject.streams.snapshotCursors();

    // One draw from each of the two per offer, and none from any other
    // substream: a relic drawn must not shift the spawn sequence, or adding a
    // relic to a run would invalidate every seeded snapshot taken before it.
    expect((after['relic-draw'] ?? 0) - (before['relic-draw'] ?? 0)).toBe(3);
    expect(
      (after['rarity-weight'] ?? 0) - (before['rarity-weight'] ?? 0),
    ).toBe(3);
  });
});

/* ==========================================================================
 * 2. Taking one makes it LIVE, not just persisted
 * ========================================================================== */

describe('taking an offered relic', () => {
  it('joins the run and empties the offer', () => {
    const subject = clearOpeningStage();

    expect(subject.rewards.choose(OPENING_OFFER[0] ?? '')).toBe(true);
    expect(subject.rewards.offers()).toEqual([]);
  });

  it('registers the relic on the ENGINE`s bus', () => {
    const subject = clearOpeningStage();
    const id = OPENING_OFFER[0] ?? '';

    expect(busRow(subject, id)).toBeUndefined();

    subject.rewards.choose(id);

    // THE defect: the engine used to build a hook bus of its own, so a relic the
    // registry registered could never be dispatched to. One bus, shared.
    expect(busRow(subject, id)).toBeDefined();
    expect(busRow(subject, id)?.charges).toBe(
      RELIC_CATALOGUE.find((relic) => relic.id === id)?.charges,
    );
  });

  it('is dispatched to on the next turn', () => {
    const subject = clearOpeningStage();
    const id = OPENING_OFFER[0] ?? '';

    subject.rewards.choose(id);
    playEveryDirection();

    // `temporal-anchor` binds `onBeforeMove` and `onAfterMove`, both of which
    // this seed's board reaches within four moves.
    expect(busRow(subject, id)?.invoked ?? 0).toBeGreaterThan(0);
  });

  it('survives into the persisted envelope', () => {
    const subject = clearOpeningStage();
    const id = OPENING_OFFER[0] ?? '';

    subject.rewards.choose(id);

    // A move, because the envelope is written on a commit: the pick alone
    // changes the controller's state and the next commit persists it.
    press('ArrowDown', 'ArrowDown');

    expect(storedRun()?.relics.map((relic) => relic.id)).toEqual([id]);
  });

  it('is refused for an identifier that was not offered', () => {
    const subject = clearOpeningStage();
    const offered = new Set(OPENING_OFFER);
    const notOffered =
      RELIC_CATALOGUE.find((relic) => !offered.has(relic.id))?.id ?? '';

    expect(subject.rewards.choose(notOffered)).toBe(false);
    expect(busRow(subject, notOffered)).toBeUndefined();

    // The offer is untouched by a refusal: the player still has a choice to
    // make. Without this guard a caller could take any of the sixteen at will,
    // which would make the seeded draw decorative.
    expect(subject.rewards.offers()).toHaveLength(3);
  });

  it('is refused twice over, so one clear earns one relic', () => {
    const subject = clearOpeningStage();
    const id = OPENING_OFFER[0] ?? '';

    expect(subject.rewards.choose(id)).toBe(true);
    expect(subject.rewards.choose(id)).toBe(false);

    press('ArrowDown', 'ArrowDown');

    expect(storedRun()?.relics.filter((relic) => relic.id === id)).toHaveLength(
      1,
    );
  });

  it('counts the pick and the refusal separately', () => {
    const subject = clearOpeningStage();
    const id = OPENING_OFFER[0] ?? '';

    subject.rewards.choose(id);
    subject.rewards.choose(id);

    expect(counter(subject, 'run.rewardTaken')).toBe(1);
    expect(counter(subject, 'run.rewardRefused')).toBe(1);
  });

  it('announces the acquisition by name', async () => {
    const subject = clearOpeningStage();
    const id = OPENING_OFFER[0] ?? '';
    const name = RELIC_CATALOGUE.find((relic) => relic.id === id)?.name ?? '';

    subject.rewards.choose(id);
    await settleAnnouncements();

    expect(announced()).toContain('relic acquired');
    expect(announced()).toContain(name.toLowerCase());
  });
});

/* ==========================================================================
 * 3. The relic slice of a commit comes from the registry
 * ========================================================================== */

describe('the relic commit context', () => {
  it('carries the relic taken, from the turn after it was taken', () => {
    const subject = clearOpeningStage();
    const id = OPENING_OFFER[0] ?? '';

    subject.rewards.choose(id);

    let last: StateCommitEvent | null = null;
    const stop = subject.engine.events.on('state:commit', (commit): void => {
      last = commit;
    });

    playEveryDirection();
    stop();

    const relics = (last as StateCommitEvent | null)?.relics ?? [];

    // A relic in the commit context with no live effect is the state the review
    // found; this asserts the other side of it — the slice and the bus agree.
    expect(relics.map((relic) => relic.id)).toContain(id);
  });

  it('reports the charges the BUS holds, not the charges last written', () => {
    const subject = clearOpeningStage();
    const id = OPENING_OFFER[0] ?? '';

    subject.rewards.choose(id);

    let last: StateCommitEvent | null = null;
    const stop = subject.engine.events.on('state:commit', (commit): void => {
      last = commit;
    });

    playEveryDirection();
    stop();

    const entry = ((last as StateCommitEvent | null)?.relics ?? []).find(
      (relic) => relic.id === id,
    );

    // The envelope's copy is only as fresh as the last write; the registry
    // refreshes from the bus, so this is the budget as it stands.
    expect(entry?.charges).toBe(busRow(subject, id)?.charges);
  });

  it('holds the relics in PICKUP ORDER', () => {
    const subject = clearOpeningStage();

    subject.rewards.choose(OPENING_OFFER[1] ?? '');

    // A SECOND OFFER, drawn the way the run draws one. `offerReward()` is the
    // controller's own draw — the commit path calls exactly this once a stage's
    // goal is met — so the second offer comes off the same two substreams, in
    // sequence, rather than being staged by hand.
    press('ArrowDown', 'ArrowDown');
    subject.run.advanceStage();

    expect(subject.run.offerReward().length).toBeGreaterThan(0);

    const second = subject.rewards.offers()[0]?.id ?? '';

    expect(second).not.toBe('');
    expect(second).not.toBe(OPENING_OFFER[1]);

    subject.rewards.choose(second);

    let last: StateCommitEvent | null = null;
    const stop = subject.engine.events.on('state:commit', (commit): void => {
      last = commit;
    });

    playEveryDirection();
    stop();

    const ids = ((last as StateCommitEvent | null)?.relics ?? []).map(
      (relic) => relic.id,
    );

    // Pickup order is dispatch order, and a HUD renders the tray in it, so the
    // order a commit carries is not cosmetic.
    expect(ids).toEqual([OPENING_OFFER[1], second]);
  });
});
