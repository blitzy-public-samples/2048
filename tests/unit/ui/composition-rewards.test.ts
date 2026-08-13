// Integration suite for the composition root's RELIC wiring, AAP R3 and R5.
//
// tests/unit/relics/** pins each relic, the registry and the sampler in
// isolation. This suite pins only that the root joins them to the engine.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { start } from '../../../src/main';
import type { Application } from '../../../src/main';
import { RELIC_CATALOGUE } from '../../../src/relics/relic-registry';
import { resetWebGLSupportProbe } from '../../../src/render/webgl-support';
import type { StateCommitEvent } from '../../../src/engine/engine-events';
import type { RunState } from '../../../src/run/run-state';
import { RUN_STATE_KEY } from '../../../src/storage/storage-keys';
import { clearOwnedStorage } from '../../fixtures/storage';

/**
 * The markup src/main.ts looks up, in the nesting index.html declares it in.
 */
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
 */
const OPENING_OFFER: readonly string[] = Object.freeze([
  'temporal-anchor',
  'culling-blade',
  'tumbler',
]);

/** A board one move from clearing the opening stage. */
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
 * The envelope this suite resumes from: a fixed seed, no relics, and both
 * relic cursors at zero so the first draw is the first draw of that seed.
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
  spokenLines = [];
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

/** A report counter's value by report name, or `0` where it never moved. */
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

/** Every line the region has held while a settle was running. */
let spokenLines: string[] = [];

/** The text every `aria-live` region holds right now. */
const regionText = (): string =>
  Array.from(document.querySelectorAll('[aria-live]'))
    .map((region) => region.textContent ?? '')
    .join(' ');

/**
 * Lets the announcement queue flush, collecting each line as it appears.
 *
 * The region holds ONE line at a time — src/ui/a11y/live-region.ts clears it
 * and writes on separate tasks — and one moment can produce several: the
 * router reads an entry line for the state it enters and this root announces
 * the offer and the acquisition. Collecting is what makes an assertion about
 * what was said independent of how many lines were said around it.
 */
const settleAnnouncements = async (): Promise<void> => {
  for (let turn = 0; turn < 24; turn += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    const text = regionText();

    if (text.trim() !== '') {
      spokenLines.push(text);
    }
  }
};

/** Everything the regions have said, lower-cased and joined. */
const announced = (): string =>
  [...spokenLines, regionText()].join(' ').toLowerCase();

describe('the reward offer', () => {
  it('is empty before any stage has cleared', () => {
    const subject = startSeededRun();

    expect(subject.rewards.offers()).toEqual([]);
  });

  it('is drawn when the opening stage clears', () => {
    const subject = clearOpeningStage();

    // Nothing drew before this wiring existed: the sampler was never called
    // from anywhere in the running application.
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

  it('announces the offer as the reward state is ENTERED, and not before', async () => {
    const subject = clearOpeningStage();

    await settleAnnouncements();

    // Nothing yet: the cards were drawn on this commit and the state in force is
    // still the board, so the offer is not spoken over a surface that cannot
    // choose from it. DL-REWARD-14.
    expect(announced()).not.toContain('choose a relic');

    expect(subject.router.showReward(subject.rewards.offers())).toBe(true);

    await settleAnnouncements();

    const spoken = announced();

    // Read on entry, from the reward screen's own `announcement(context)`, so
    // the three cards are named at the moment they become operable.
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
    // make.
    expect(subject.rewards.offers()).toHaveLength(3);
  });

  it('holds the reward state when the ROUTER path is refused', () => {
    const subject = clearOpeningStage();

    // stageClear -> reward, which is the state the cards are pressed in. Driven
    // through the router rather than through the stage-clear control, because
    // this suite's markup carries the board and no screen containers.
    expect(subject.router.showReward(subject.rewards.offers())).toBe(true);
    expect(subject.router.current()).toBe('reward');

    // The transaction's own refusal, injected at the storage boundary: the
    // write that commits the pickup fails, the controller rolls the relic and
    // the round back, and `selectReward` reports `'refused'`. Installed on
    // `Storage.prototype`, because jsdom's storage object records an assignment
    // to one of its own members as a stored ITEM.
    const write = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation((): void => {
        throw new Error('quota exceeded');
      });

    const chosen = OPENING_OFFER[0] ?? '';
    const accepted = subject.router.selectReward(chosen, 'card');

    write.mockRestore();

    // THE ROUTER MUST SEE THE REFUSAL. A dropped result reads as acceptance,
    // so the `rewardSelected` edge was taken over a rolled-back transaction and
    // the player was returned to a board holding none of the relic they chose.
    expect(accepted).toBe(false);
    expect(subject.router.current()).toBe('reward');
    expect(subject.rewards.offers().map((offer): string => offer.id)).toEqual([
      ...OPENING_OFFER,
    ]);

    // And the model rolled back with it: the relic is not held, so the run the
    // player is returned to is the run they left. A bus row outlives its
    // registration by design, so the registry is what is read here.
    expect(subject.relics.ownedIds()).not.toContain(chosen);
  });

  // The refusal above is perceivable. The transaction rolls the relic
  // back and the same three cards come back, which on its own is a pressed card
  // that changes nothing and says nothing. DL-MAIN-37.
  it('says why a refused press left the same three cards standing', async () => {
    const subject = clearOpeningStage();

    expect(subject.router.showReward(subject.rewards.offers())).toBe(true);

    const write = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation((): void => {
        throw new Error('quota exceeded');
      });

    const chosen = OPENING_OFFER[0] ?? '';

    expect(subject.router.selectReward(chosen, 'card')).toBe(false);

    await settleAnnouncements();
    write.mockRestore();

    const said = announced();

    // What happened, why, and what is still true — and the reason names the
    // persistence state the HUD shows at the same moment.
    expect(said).toContain('not taken');
    expect(said).toContain('not being saved');
    expect(said).toContain('still on offer');

    // The relic really did not join, so the line is not describing a rollback
    // that failed to happen.
    expect(subject.relics.ownedIds()).not.toContain(chosen);
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

    // A relic in the commit context with no live effect is the state the
    // review found; this asserts the other side of it — the slice and the bus
    // agree.
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

    // A SECOND OFFER, drawn the way the run draws one.
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

/* ==========================================================================
 * THE STAGE TRANSITION AN ACCEPTED REWARD PERFORMS (DL-MAIN-42).
 *
 * `RunController` contains a `startStage` that raises, records the stage as owed
 * an open and publishes `stageOpenPending()` and `openPendingStage()` for a
 * caller to close the record with. Nothing called either, so an accepted reward
 * could leave the run standing on a stage index no board had been opened for.
 * These two cases are the production caller.
 * ========================================================================== */

describe('a stage transition the engine refuses', () => {
  it('retries the open once and completes the transition', () => {
    const subject = clearOpeningStage();
    const id = OPENING_OFFER[0] ?? '';
    const engine = subject.engine;
    const open = engine.startStage.bind(engine);
    let attempts = 0;

    const spy = vi
      .spyOn(engine, 'startStage')
      .mockImplementation((board): void => {
        attempts += 1;

        if (attempts === 1) {
          throw new Error('the stage could not be opened');
        }

        open(board);
      });

    const stageBefore = subject.run.state().stageIndex;

    expect(subject.rewards.choose(id)).toBe(true);

    spy.mockRestore();

    // The first attempt raised, the recovery retried it, and the run is on a
    // stage the engine actually opened.
    expect(attempts).toBe(2);
    expect(subject.run.stageOpenPending()).toBeNull();
    expect(subject.run.state().stageIndex).toBe(stageBefore + 1);
    expect(counter(subject, 'run.stageOpen.recovered')).toBe(1);
    expect(counter(subject, 'run.stageOpen.unrecovered')).toBe(0);
  });

  it('surfaces the failure once when the retry also fails', async () => {
    const subject = clearOpeningStage();
    const id = OPENING_OFFER[0] ?? '';
    const engine = subject.engine;

    const spy = vi
      .spyOn(engine, 'startStage')
      .mockImplementation((): void => {
        throw new Error('the stage could not be opened');
      });

    // The reward itself still commits: the relic is held and the round is
    // closed, because the transaction the controller runs completed before the
    // open was attempted.
    expect(subject.rewards.choose(id)).toBe(true);
    expect(subject.run.relics().map((relic) => relic.id)).toEqual([id]);

    // Two attempts and no more: the original and the one bounded retry.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(subject.run.stageOpenPending()).not.toBeNull();
    expect(counter(subject, 'run.stageOpen.unrecovered')).toBe(1);

    await settleAnnouncements();

    // SAID, not merely counted: the board the player is on is no longer the
    // stage the run reports.
    expect(announced()).toContain('could not be started');

    // A further commit does not retry the same stage again.
    press('ArrowDown', 'ArrowDown');

    expect(spy).toHaveBeenCalledTimes(2);
    expect(counter(subject, 'run.stageOpen.unrecovered')).toBe(1);

    spy.mockRestore();
  });
});
