// @vitest-environment jsdom
//
// Suite for src/ui/screens/hud.ts: the ONE actuator that writes the score, the
// best score and the terminal overlay.
//
// WHAT THIS FILE PINS
//   single ownership   two components used to own the same three outlets —
//                      `ScorePanel` owned the two score outlets and the
//                      number-only renderer owned the same two plus the overlay,
//                      each with a previous-score cache of its own. Mounting
//                      both cleared the other's accessible-name node and dropped
//                      the rising delta. The renderer is now board-only and this
//                      module is the sole writer.
//   renderer independence  because the HUD subscribes to `state:commit` itself,
//                      selecting a different board renderer changes what draws
//                      the board and nothing else.
//   ported behaviour   the write order, the two state classes and the two
//                      verdict strings of js/html_actuator.js.

import { afterEach, describe, expect, it } from 'vitest';

import { createEngineEvents } from '../../../src/engine/engine-events';
import type {
  EngineEvents,
  StateCommitEvent,
} from '../../../src/engine/engine-events';
import { EMPTY_RELIC_CONTEXT, EMPTY_STAGE_CONTEXT } from '../../../src/engine/types';
import { Grid } from '../../../src/engine/grid';
import { createNumberOnlyRenderer } from '../../../src/render/number-only-renderer';
import { HUD_Z_INDEX, createHud, hudCopy } from '../../../src/ui/screens/hud';
import type { Hud, HudAnnouncerPort } from '../../../src/ui/screens/hud';
import type { ActiveRelic, Rarity } from '../../../src/relics/relic-types';
import type { StageScreenContext } from '../../../src/ui/screen-router';
import { LocalStorageManager } from '../../../src/storage/local-storage-manager';
import { BEST_SCORE_KEY } from '../../../src/storage/storage-keys';
import { zIndex } from '../../../src/theme/tokens';
import type {
  BestScoreValue,
  RelicCommitContext,
  StageCommitContext,
} from '../../../src/engine/types';

interface Fixture {
  readonly score: HTMLElement;
  readonly best: HTMLElement;
  readonly message: HTMLElement;
  readonly board: HTMLElement;
}

function fixture(): Fixture {
  document.body.innerHTML = `
    <div class="score-container"><span class="visually-hidden">Score</span>0</div>
    <div class="best-container"><span class="visually-hidden">Best score</span>0</div>
    <div class="game-message"><p></p><div class="lower"></div></div>
    <div class="board-number-only" hidden></div>
  `;

  return {
    score: document.querySelector<HTMLElement>('.score-container')!,
    best: document.querySelector<HTMLElement>('.best-container')!,
    message: document.querySelector<HTMLElement>('.game-message')!,
    board: document.querySelector<HTMLElement>('.board-number-only')!,
  };
}

function commit(
  score: number,
  flags: {
    bestScore?: BestScoreValue;
    over?: boolean;
    won?: boolean;
    terminated?: boolean;
  } = {},
): StateCommitEvent {
  return {
    turn: 1,
    degraded: false,
    board: new Grid(4),
    score,
    bestScore: flags.bestScore ?? 0,
    over: flags.over ?? false,
    won: flags.won ?? false,
    terminated: flags.terminated ?? false,
    stage: EMPTY_STAGE_CONTEXT,
    relics: EMPTY_RELIC_CONTEXT,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

/**
 * The value an outlet shows, without its accessible name.
 *
 * ScorePanel writes the visually-hidden label as an element child and the value
 * as a direct text node, so reading only the direct text nodes separates the
 * quantity from the name that precedes it. Asserting on raw `textContent` would
 * conflate the two and would silently pass if the label were ever dropped.
 */
const valueOf = (outlet: HTMLElement): string => {
  let text = '';

  for (const node of Array.from(outlet.childNodes)) {
    if (node.nodeType === outlet.TEXT_NODE) {
      text += node.textContent ?? '';
    }
  }

  return text;
};

/** The accessible name an outlet carries, read from its visually-hidden label. */
const labelOf = (outlet: HTMLElement): string =>
  outlet.querySelector('.visually-hidden')?.textContent ?? '';

describe('the HUD writes the score, the best score and the overlay', () => {
  it('writes both quantities in the vanilla order', () => {
    const surfaces = fixture();
    const hud = createHud({
      scoreContainer: surfaces.score,
      bestContainer: surfaces.best,
      messageContainer: surfaces.message,
      document,
    });

    hud.render(commit(120, { bestScore: '900' }));

    expect(valueOf(surfaces.score)).toContain('120');
    expect(valueOf(surfaces.best)).toBe('900');

    // The label survives the write and precedes the value, so a screen reader
    // reads "Score 120" rather than a bare number.
    expect(labelOf(surfaces.score)).toBe('Score');
    expect(labelOf(surfaces.best)).toBe('Best score');
    expect(hud.readRendered()?.score).toBe(120);

    hud.destroy();
  });

  it('appends the rising delta and keeps its own cache', () => {
    const surfaces = fixture();
    const hud = createHud({
      scoreContainer: surfaces.score,
      bestContainer: surfaces.best,
      messageContainer: surfaces.message,
      document,
    });

    hud.render(commit(0));
    hud.render(commit(16));

    const addition = surfaces.score.querySelector('.score-addition');

    expect(addition?.textContent).toBe('+16');

    hud.render(commit(16));

    // No rise, so no delta node this time.
    expect(surfaces.score.querySelector('.score-addition')).toBeNull();

    hud.destroy();
  });

  it('carries the best score through without coercing a stored string', () => {
    const surfaces = fixture();
    const hud = createHud({
      scoreContainer: surfaces.score,
      bestContainer: surfaces.best,
      messageContainer: surfaces.message,
      document,
    });

    hud.render(commit(1, { bestScore: '2048' }));

    expect(valueOf(surfaces.best)).toBe('2048');
    expect(hud.readRendered()?.bestScore).toBe('2048');

    hud.destroy();
  });
});

describe('the terminal overlay carries the ported classes and verdicts', () => {
  it('shows the loss verdict', () => {
    const surfaces = fixture();
    const hud = createHud({
      scoreContainer: surfaces.score,
      bestContainer: surfaces.best,
      messageContainer: surfaces.message,
      document,
    });

    const snapshot = hud.render(
      commit(64, { over: true, terminated: true }),
    );

    expect(surfaces.message.classList.contains('game-over')).toBe(true);
    expect(surfaces.message.querySelector('p')?.textContent).toBe(
      hudCopy.overMessage,
    );
    expect(snapshot.terminal).toBe('over');

    hud.destroy();
  });

  it('shows the win verdict and clears it on continued play', () => {
    const surfaces = fixture();
    const hud = createHud({
      scoreContainer: surfaces.score,
      bestContainer: surfaces.best,
      messageContainer: surfaces.message,
      document,
    });

    hud.render(commit(2048, { won: true, terminated: true }));

    expect(surfaces.message.classList.contains('game-won')).toBe(true);
    expect(surfaces.message.querySelector('p')?.textContent).toBe(
      hudCopy.wonMessage,
    );

    // The vanilla `continueGame()`: keep-playing and restart both arrive as a
    // commit whose `terminated` is `false`.
    hud.render(commit(2048, { won: true, terminated: false }));

    expect(surfaces.message.classList.contains('game-won')).toBe(false);
    expect(hud.readRendered()?.terminal).toBeNull();

    hud.destroy();
  });

  it('prefers the loss verdict where a board carries both flags', () => {
    const surfaces = fixture();
    const hud = createHud({
      scoreContainer: surfaces.score,
      bestContainer: surfaces.best,
      messageContainer: surfaces.message,
      document,
    });

    hud.render(commit(2048, { won: true, over: true, terminated: true }));

    expect(surfaces.message.classList.contains('game-over')).toBe(true);
    expect(surfaces.message.classList.contains('game-won')).toBe(false);

    hud.destroy();
  });

  it('reports an absent overlay and keeps writing the scores', () => {
    const surfaces = fixture();

    surfaces.message.remove();

    const hud = createHud({
      scoreContainer: surfaces.score,
      bestContainer: surfaces.best,
      document,
    });

    expect(hud.hasOverlay()).toBe(false);
    expect(() => {
      hud.render(commit(8, { over: true, terminated: true }));
    }).not.toThrow();
    expect(surfaces.score.textContent).toContain('8');

    hud.destroy();
  });
});

describe('the HUD is driven by its host, not by an emitter of its own', () => {
  /**
   * The composition root's own subscription, restated here.
   *
   * src/ui/screens/hud.ts subscribes to NO emitter: a commit reaches it through
   * `render`, which is what src/main.ts and src/ui/screen-router.ts both drive.
   * Attaching the listener in the suite is what the root does at
   * src/main.ts's `stopHud`.
   */
  const drive = (events: EngineEvents, hud: Hud): (() => void) =>
    events.on('state:commit', (payload): void => {
      hud.render(payload);
    });

  it('exposes no engine subscription of its own', () => {
    const surfaces = fixture();
    const hud = createHud({
      scoreContainer: surfaces.score,
      bestContainer: surfaces.best,
      messageContainer: surfaces.message,
      document,
    });

    // The engine port is not part of this screen's surface at all: a payload
    // arrives from the host, so nothing here can attach a second listener to a
    // turn and no ordering between two subscribers has to be reasoned about.
    expect('subscribe' in hud).toBe(false);

    hud.destroy();
  });

  it('writes on every commit its host forwards', () => {
    const surfaces = fixture();
    const events = createEngineEvents();
    const hud = createHud({
      scoreContainer: surfaces.score,
      bestContainer: surfaces.best,
      messageContainer: surfaces.message,
      document,
    });

    const stop = drive(events, hud);

    events.emit('state:commit', commit(4));
    expect(surfaces.score.textContent).toContain('4');

    events.emit('state:commit', commit(12));
    expect(surfaces.score.textContent).toContain('12');

    stop();
    events.emit('state:commit', commit(99));

    // The subscription is released, so the outlet keeps the last value written.
    expect(surfaces.score.textContent).toContain('12');

    hud.destroy();
  });

  it('keeps writing while the board renderer is mounted beside it', () => {
    const surfaces = fixture();
    const events = createEngineEvents();
    const hud = createHud({
      scoreContainer: surfaces.score,
      bestContainer: surfaces.best,
      messageContainer: surfaces.message,
      document,
    });
    const renderer = createNumberOnlyRenderer({ host: surfaces.board });

    drive(events, hud);
    renderer.subscribe(events);

    events.emit('state:commit', commit(0));
    events.emit('state:commit', commit(48, { over: true, terminated: true }));

    // The renderer is BOARD-ONLY: it neither clears the accessible name nor
    // competes for the delta, and the overlay is still written.
    expect(labelOf(surfaces.score)).toBe('Score');
    expect(surfaces.score.querySelector('.score-addition')?.textContent).toBe(
      '+48',
    );
    expect(surfaces.message.classList.contains('game-over')).toBe(true);

    renderer.dispose();
    hud.destroy();
  });

  it('leaves the renderer with no score, best or overlay option at all', () => {
    const surfaces = fixture();
    const renderer = createNumberOnlyRenderer({ host: surfaces.board });
    const events = createEngineEvents();

    renderer.subscribe(events);
    events.emit('state:commit', commit(256, { over: true, terminated: true }));

    // Nothing the renderer does reaches these three surfaces.
    expect(valueOf(surfaces.score)).toBe('0');
    expect(valueOf(surfaces.best)).toBe('0');
    expect(surfaces.message.classList.contains('game-over')).toBe(false);

    // It still reports the score it saw, which is what the announcer reads.
    expect(renderer.readRenderedBoard()).toBeNull();

    renderer.dispose();
  });
});

describe('a destroyed HUD writes nothing further', () => {
  it('clears the overlay and reports later calls', () => {
    const surfaces = fixture();
    const hud = createHud({
      scoreContainer: surfaces.score,
      bestContainer: surfaces.best,
      messageContainer: surfaces.message,
      document,
    });

    hud.render(commit(2, { over: true, terminated: true }));
    hud.destroy();

    expect(surfaces.message.classList.contains('game-over')).toBe(false);

    const before = valueOf(surfaces.score);

    hud.render(commit(4096));

    expect(valueOf(surfaces.score)).toBe(before);
    expect(() => {
      hud.destroy();
    }).not.toThrow();
  });
});

/* ==========================================================================
 * The in-run status half: stage indicator and relic tray
 * ========================================================================== */

/** The fixture above, plus the three run-status outlets index.html declares. */
function runFixture(): {
  readonly hudGroup: HTMLElement;
  readonly stage: HTMLElement;
  readonly tray: HTMLElement;
} {
  document.body.innerHTML = `
    <div class="score-container"><span class="visually-hidden">Score</span>0</div>
    <div class="best-container"><span class="visually-hidden">Best score</span>0</div>
    <div class="hud" id="screen-hud" data-screen="hud" role="group"
         aria-label="Run status" hidden>
      <div class="hud-stage" id="hud-stage"></div>
      <ul class="relic-tray" id="relic-tray" role="list"
          aria-label="Active relics, in pickup order"></ul>
    </div>
    <div class="game-message"><p></p><div class="lower"></div></div>
  `;

  return {
    hudGroup: document.querySelector<HTMLElement>('#screen-hud')!,
    stage: document.querySelector<HTMLElement>('#hud-stage')!,
    tray: document.querySelector<HTMLElement>('#relic-tray')!,
  };
}

/** A commit carrying a stage slice and a relic slice. */
function runCommit(
  score: number,
  stage: StageCommitContext,
  relics: RelicCommitContext,
): StateCommitEvent {
  return { ...commit(score), stage, relics };
}

const stageSlice = (
  stageIndex: number,
  kind: 'highest-tile' | 'score-threshold',
  target: number,
  goalProgress: number,
): StageCommitContext =>
  Object.freeze({ stageIndex, goal: { kind, target }, goalProgress });

/**
 * The visually-hidden runs one tray row carries, in document order.
 *
 * A row from src/ui/components/relic-card.ts states its pickup slot and its
 * tier as hidden text, so a suite reading one of them looks it up among them
 * rather than taking the first.
 */
const hiddenTexts = (row: Element | null | undefined): string[] =>
  row === null || row === undefined
    ? []
    : Array.from(row.querySelectorAll('.visually-hidden')).map(
        (node): string => node.textContent ?? '',
      );

describe('the stage indicator', () => {
  it('writes the one-based stage number and the goal readout', () => {
    const outlets = runFixture();
    const hud = createHud({ document });

    const snapshot = hud.render(
      runCommit(96, stageSlice(2, 'highest-tile', 64, 0.25), []),
    );

    expect(hud.hasStageIndicator()).toBe(true);

    // ONE-BASED on screen, zero-based in the engine: index 2 is the third stage.
    expect(snapshot.stage).toBe(3);
    expect(
      outlets.stage.querySelector('.hud-stage-index .hud-value')?.textContent,
    ).toBe('3');
    expect(
      outlets.stage.querySelector('.hud-stage-index .hud-label')?.textContent,
    ).toBe(hudCopy.stageLabel);

    // The measured quantity is derived from the target and the fraction, so the
    // readout cannot disagree with the progress the run reported.
    expect(
      outlets.stage.querySelector('.hud-goal .hud-value')?.textContent,
    ).toBe('16 / 64 tile');

    hud.destroy();
  });

  it('drives the track from the reported fraction', () => {
    const outlets = runFixture();
    const hud = createHud({ document });

    hud.render(runCommit(0, stageSlice(0, 'score-threshold', 500, 0.4), []));

    const fill = outlets.stage.querySelector<HTMLElement>(
      '.hud-goal-meter-fill',
    );

    expect(fill?.style.getPropertyValue('--hud-goal-fraction')).toBe('0.4');

    // The track duplicates a quantity `.hud-value` already carries as text, so
    // it is hidden from assistive technology rather than announced twice.
    expect(
      outlets.stage
        .querySelector('.hud-goal-meter')
        ?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(
      outlets.stage.querySelector('.hud-goal .hud-value')?.textContent,
    ).toBe('200 / 500 score');

    hud.destroy();
  });

  it('clamps a fraction outside the closed unit interval', () => {
    const outlets = runFixture();
    const hud = createHud({ document });

    hud.render(runCommit(0, stageSlice(0, 'highest-tile', 16, 3.5), []));

    expect(
      outlets.stage
        .querySelector<HTMLElement>('.hud-goal-meter-fill')
        ?.style.getPropertyValue('--hud-goal-fraction'),
    ).toBe('1');
    expect(
      outlets.stage.querySelector('.hud-goal .hud-value')?.textContent,
    ).toBe('16 / 16 tile');

    hud.destroy();
  });

  it('releases the group hidden on the first commit', () => {
    const outlets = runFixture();
    const hud = createHud({ document });

    expect(outlets.hudGroup.hidden).toBe(true);

    hud.render(runCommit(0, stageSlice(0, 'highest-tile', 16, 0), []));

    expect(outlets.hudGroup.hidden).toBe(false);

    hud.destroy();
  });

  it('rebuilds nothing while the stage is unchanged', () => {
    const outlets = runFixture();
    const hud = createHud({ document });

    hud.render(runCommit(0, stageSlice(0, 'highest-tile', 16, 0.5), []));

    const first = outlets.stage.querySelector('.hud-stage-index');

    hud.render(runCommit(4, stageSlice(0, 'highest-tile', 16, 0.5), []));

    // A commit arrives every turn and the indicator changes on a transition
    // alone, so the same elements are still in place rather than replaced.
    expect(outlets.stage.querySelector('.hud-stage-index')).toBe(first);

    hud.render(runCommit(4, stageSlice(1, 'highest-tile', 32, 0), []));

    expect(outlets.stage.querySelector('.hud-stage-index')).not.toBe(first);
    expect(
      outlets.stage.querySelector('.hud-stage-index .hud-value')?.textContent,
    ).toBe('2');

    hud.destroy();
  });

  it('reports no indicator, and writes the score, when the outlets are absent', () => {
    const outlets = fixture();
    const hud = createHud({
      scoreContainer: outlets.score,
      bestContainer: outlets.best,
      messageContainer: outlets.message,
      document,
    });

    const snapshot = hud.render(commit(12));

    expect(hud.hasStageIndicator()).toBe(false);
    expect(hud.hasRelicTray()).toBe(false);
    expect(snapshot.stage).toBeNull();
    expect(snapshot.relics).toEqual([]);

    // The score half is unaffected: the run-status markup being absent is what
    // every legacy fixture is, and it must not stop the HUD writing.
    expect(valueOf(outlets.score)).toBe('12');

    hud.destroy();
  });
});

describe('the relic tray', () => {
  it('lists the relics in pickup order with their charge counts', () => {
    const outlets = runFixture();
    const hud = createHud({ document });

    const snapshot = hud.render(
      runCommit(0, stageSlice(0, 'highest-tile', 16, 0), [
        { id: 'twin-seed' },
        { id: 'frostbind', charges: 5 },
      ]),
    );

    const items = Array.from(
      outlets.tray.querySelectorAll('.relic-tray-item'),
    );

    // PICKUP ORDER IS THE TRAY'S DOCUMENT ORDER, because it is the order the
    // hook bus dispatches in and therefore what decides how effects compound.
    expect(items.map((item) => item.getAttribute('data-relic-id'))).toEqual([
      'twin-seed',
      'frostbind',
    ]);
    expect(snapshot.relics).toEqual(['twin-seed', 'frostbind']);

    expect(
      items[0]?.querySelector('.relic-tray-name')?.textContent,
    ).toBe('twin-seed');
    expect(items[0]?.querySelector('.relic-tray-charges')).toBeNull();
    expect(
      items[1]?.querySelector('.relic-tray-charges')?.textContent,
    ).toBe(hudCopy.relicCharges(5));

    hud.destroy();
  });

  it('carries the rarity tier as an attribute and as accessible text', () => {
    const outlets = runFixture();
    const hud = createHud({
      document,
      relicName: (relicId): string => `Name of ${relicId}`,
      relicRarity: (relicId): string =>
        relicId === 'twin-seed' ? 'common' : 'legendary',
    });

    hud.render(
      runCommit(0, stageSlice(0, 'highest-tile', 16, 0), [
        { id: 'twin-seed' },
        { id: 'frostbind', charges: 5 },
      ]),
    );

    const items = Array.from(
      outlets.tray.querySelectorAll('.relic-tray-item'),
    );

    // style/_hud.scss declares one accent rule per rarity tier, keyed on this
    // attribute; without it written no rule could ever match.
    expect(items.map((item) => item.getAttribute('data-rarity'))).toEqual([
      'common',
      'legendary',
    ]);

    // AND IN TEXT, for the reader the accent cannot reach. Visually hidden,
    // because the accent states the tier twice over already. The row's hidden
    // runs are the pickup slot and the tier, so the tier is looked for among
    // them rather than assumed to be the first.
    expect(hiddenTexts(items[1])).toContain(hudCopy.relicRarity('legendary'));
    expect(items[1]?.textContent).toContain('legendary');

    hud.destroy();
  });

  it('leaves the rarity unwritten where no resolver answers', () => {
    const outlets = runFixture();
    const hud = createHud({
      document,
      relicRarity: (): string => {
        throw new Error('the catalogue is unavailable');
      },
    });

    hud.render(
      runCommit(0, stageSlice(0, 'highest-tile', 16, 0), [{ id: 'twin-seed' }]),
    );

    const item = outlets.tray.querySelector('.relic-tray-item');

    // An empty attribute would match no rule and would state a tier the tray
    // does not know; a resolver that raises must not fail the commit either.
    expect(item?.hasAttribute('data-rarity')).toBe(false);
    expect(
      hiddenTexts(item).some((text) => text.startsWith('Rarity')),
    ).toBe(false);
    expect(item?.getAttribute('data-relic-id')).toBe('twin-seed');

    hud.destroy();
  });

  it('rebuilds the tray when only the rarity became resolvable', () => {
    const outlets = runFixture();
    let tier = '';
    const hud = createHud({
      document,
      relicRarity: (): string => tier,
    });
    const held = [{ id: 'twin-seed' }];

    hud.render(runCommit(0, stageSlice(0, 'highest-tile', 16, 0), held));

    expect(
      outlets.tray
        .querySelector('.relic-tray-item')
        ?.hasAttribute('data-rarity'),
    ).toBe(false);

    // The tray skips a rebuild whose signature is unchanged, so the rarity is
    // part of that signature: a tier resolved between two commits would
    // otherwise never reach the DOM.
    tier = 'rare';
    hud.render(runCommit(0, stageSlice(0, 'highest-tile', 16, 0), held));

    expect(
      outlets.tray
        .querySelector('.relic-tray-item')
        ?.getAttribute('data-rarity'),
    ).toBe('rare');

    hud.destroy();
  });

  it('marks an exhausted relic through data-charges, including at zero', () => {
    const outlets = runFixture();
    const hud = createHud({ document });

    hud.render(
      runCommit(0, stageSlice(0, 'highest-tile', 16, 0), [
        { id: 'scouring-wind', charges: 0 },
      ]),
    );

    // Written even at zero, because that is the value the stylesheet dims off.
    expect(
      outlets.tray
        .querySelector('.relic-tray-item')
        ?.getAttribute('data-charges'),
    ).toBe('0');

    hud.destroy();
  });

  it('shows an empty state as a valid list item', () => {
    const outlets = runFixture();
    const hud = createHud({ document });

    hud.render(runCommit(0, stageSlice(0, 'highest-tile', 16, 0), []));

    const item = outlets.tray.querySelector('.relic-tray-item');

    expect(item?.textContent).toBe(hudCopy.relicTrayEmpty);

    // No role of its own, so the implicit `listitem` of an `<li>` inside a
    // `<ul>` stands. `role="none"` was tried here and removed the only child
    // role a `role="list"` permits, which left the list ARIA-invalid and
    // announced as empty; a browser accessibility audit flagged it as
    // `aria-required-children`.
    expect(item?.hasAttribute('role')).toBe(false);
    expect(item?.getAttribute('data-relic-empty')).toBe('true');
    expect(outlets.tray.getAttribute('aria-label')).toBe(
      hudCopy.relicTrayLabel,
    );

    hud.destroy();
  });

  it('renders a readout and binds no control of its own', () => {
    const outlets = runFixture();
    const hud = createHud({ document });

    hud.render(
      runCommit(0, stageSlice(0, 'highest-tile', 16, 0), [
        { id: 'twin-seed' },
        { id: 'tumbler', charges: 3 },
      ]),
    );

    // src/input/on-screen-controls.ts owns EVERY element-to-action binding,
    // including the relic-activation control, so the tray is a readout: a
    // focusable button here would be a second control for the same action.
    expect(outlets.tray.querySelector('button')).toBeNull();
    expect(
      outlets.tray.querySelectorAll('.relic-tray-control'),
    ).toHaveLength(2);
    expect(
      outlets.tray.querySelector('.relic-tray-control')?.tagName,
    ).toBe('SPAN');

    hud.destroy();
  });

  it('shows the catalogue name a resolver supplies, not the identifier', () => {
    const outlets = runFixture();
    const names: Record<string, string> = {
      'alloy-forge': 'Alloy Forge',
      tumbler: 'Tumbler',
    };
    const hud = createHud({
      document,
      relicName: (relicId): string => names[relicId] ?? '',
    });

    hud.render(
      runCommit(0, stageSlice(0, 'highest-tile', 16, 0), [
        { id: 'alloy-forge' },
        { id: 'tumbler', charges: 3 },
        { id: 'unnamed-relic' },
      ]),
    );

    const shown = Array.from(
      outlets.tray.querySelectorAll('.relic-tray-name'),
    ).map((node) => node.textContent);

    // The reward card and the announcement both used the display name, so the
    // tray showing the raw identifier would name the same relic two ways.
    expect(shown).toEqual(['Alloy Forge', 'Tumbler', 'unnamed-relic']);

    // A blank answer falls back to the identifier rather than an empty pill, and
    // `data-relic-id` stays the identifier either way.
    expect(
      Array.from(outlets.tray.querySelectorAll('.relic-tray-item')).map(
        (item) => item.getAttribute('data-relic-id'),
      ),
    ).toEqual(['alloy-forge', 'tumbler', 'unnamed-relic']);

    // The full name is carried as a title, so a name the stylesheet truncates is
    // still readable.
    expect(
      outlets.tray
        .querySelector<HTMLElement>('.relic-tray-name')
        ?.getAttribute('title'),
    ).toBe('Alloy Forge');

    hud.destroy();
  });

  it('updates a spent charge in the row already on screen', () => {
    const outlets = runFixture();
    const hud = createHud({ document });
    const stage = stageSlice(0, 'highest-tile', 16, 0);

    hud.render(runCommit(0, stage, [{ id: 'frostbind', charges: 5 }]));

    const first = outlets.tray.querySelector('.relic-tray-item');

    hud.render(runCommit(4, stage, [{ id: 'frostbind', charges: 5 }]));

    expect(outlets.tray.querySelector('.relic-tray-item')).toBe(first);

    hud.render(runCommit(8, stage, [{ id: 'frostbind', charges: 4 }]));

    // THE SAME ROW, updated in place. A payload arrives on every turn, so a
    // relic still held costs no element: only a relic that joined or left does.
    expect(outlets.tray.querySelector('.relic-tray-item')).toBe(first);
    expect(
      outlets.tray.querySelector('.relic-tray-charges')?.textContent,
    ).toBe(hudCopy.relicCharges(4));
    expect(first?.getAttribute('data-charges')).toBe('4');

    hud.destroy();
  });

  it('adds and removes only the rows that changed, keeping the order', () => {
    const outlets = runFixture();
    const hud = createHud({ document });
    const stage = stageSlice(0, 'highest-tile', 16, 0);

    hud.render(
      runCommit(0, stage, [{ id: 'twin-seed' }, { id: 'tumbler' }]),
    );

    const rowsBefore = Array.from(
      outlets.tray.querySelectorAll('.relic-tray-item'),
    );

    // A third relic is taken: the two rows standing are reused and one is
    // created, and the newcomer takes the last slot because pickup order is the
    // order it arrived in.
    hud.render(
      runCommit(0, stage, [
        { id: 'twin-seed' },
        { id: 'tumbler' },
        { id: 'frostbind', charges: 2 },
      ]),
    );

    const rowsAfter = Array.from(
      outlets.tray.querySelectorAll('.relic-tray-item'),
    );

    expect(rowsAfter).toHaveLength(3);
    expect(rowsAfter[0]).toBe(rowsBefore[0]);
    expect(rowsAfter[1]).toBe(rowsBefore[1]);
    expect(
      rowsAfter.map((row) => row.getAttribute('data-relic-id')),
    ).toEqual(['twin-seed', 'tumbler', 'frostbind']);

    // A relic that left takes its row with it, and the survivors keep theirs.
    hud.render(
      runCommit(0, stage, [
        { id: 'twin-seed' },
        { id: 'frostbind', charges: 2 },
      ]),
    );

    const rowsFinal = Array.from(
      outlets.tray.querySelectorAll('.relic-tray-item'),
    );

    expect(
      rowsFinal.map((row) => row.getAttribute('data-relic-id')),
    ).toEqual(['twin-seed', 'frostbind']);
    expect(rowsFinal[0]).toBe(rowsBefore[0]);
    expect(rowsFinal[1]).toBe(rowsAfter[2]);

    hud.destroy();
  });
});

/* ==========================================================================
 * The unconfirmed terminal or stage status
 * ========================================================================== */

describe('the unconfirmed-status notice', () => {
  it('shows the notice and marks the group while a commit is degraded', () => {
    const outlets = runFixture();
    const hud = createHud({ document });
    const stage = stageSlice(0, 'highest-tile', 16, 0);

    const settled = hud.render(runCommit(0, stage, []));

    // Nothing while the engine can measure: no attribute, and the notice is
    // built but held out of the rendering and accessibility trees.
    expect(settled.degraded).toBe(false);
    expect(outlets.hudGroup.hasAttribute('data-degraded')).toBe(false);
    expect(
      outlets.hudGroup.querySelector<HTMLElement>('.hud-degraded')?.hidden,
    ).toBe(true);

    const unknown = hud.render({
      ...runCommit(4, stage, []),
      degraded: true,
    });
    const notice = outlets.hudGroup.querySelector<HTMLElement>('.hud-degraded');

    // THE FLAG REACHES THE PRESENTATION. Before this the commit carried
    // `degraded` and the HUD rendered only the ordinary terminal flags, so a
    // player was shown a settled board whose status the engine could not
    // establish.
    expect(unknown.degraded).toBe(true);
    expect(outlets.hudGroup.getAttribute('data-degraded')).toBe('true');
    expect(notice?.hidden).toBe(false);

    // Real text, so a screen reader reaching the run-status group reads it; the
    // once-per-transition announcement belongs to the announcer.
    expect(notice?.textContent).toBe(hudCopy.degradedNotice);

    hud.destroy();
  });

  it('clears the notice once a measurement succeeds again', () => {
    const outlets = runFixture();
    const hud = createHud({ document });
    const stage = stageSlice(0, 'highest-tile', 16, 0);

    hud.render({ ...runCommit(0, stage, []), degraded: true });
    hud.render(runCommit(4, stage, []));

    expect(outlets.hudGroup.hasAttribute('data-degraded')).toBe(false);
    expect(
      outlets.hudGroup.querySelector<HTMLElement>('.hud-degraded')?.hidden,
    ).toBe(true);
    expect(hud.readRendered()?.degraded).toBe(false);

    hud.destroy();
  });

  it('takes its notice and its attribute away on destroy', () => {
    const outlets = runFixture();
    const hud = createHud({ document });

    hud.render({
      ...runCommit(0, stageSlice(0, 'highest-tile', 16, 0), []),
      degraded: true,
    });
    hud.destroy();

    expect(outlets.hudGroup.querySelector('.hud-degraded')).toBeNull();
    expect(outlets.hudGroup.hasAttribute('data-degraded')).toBe(false);
  });
});

/* ==========================================================================
 * The live board dimension
 * ========================================================================== */

describe('the board dimension is read live, never cached', () => {
  it('reads it off the board each payload carries', () => {
    const outlets = runFixture();
    const hud = createHud({ document });
    const stage = stageSlice(0, 'highest-tile', 16, 0);

    hud.render(runCommit(0, stage, []));

    expect(
      outlets.stage.querySelector('.hud-board .hud-value')?.textContent,
    ).toBe(hudCopy.boardValue(4));
    expect(hud.readRendered()?.boardSize).toBe(4);

    // A board-mutating cursed relic shrinks the board mid-run. The dimension is
    // read from the payload on every write, so the readout follows it rather
    // than showing the size the screen mounted at.
    hud.render({ ...runCommit(4, stage, []), board: new Grid(3) });

    expect(
      outlets.stage.querySelector('.hud-board .hud-value')?.textContent,
    ).toBe(hudCopy.boardValue(3));
    expect(hud.readRendered()?.boardSize).toBe(3);

    hud.destroy();
  });

  it('falls back to the injected reader, and calls it per write', () => {
    const outlets = runFixture();
    let configured = 5;
    const hud = createHud({
      document,
      boardSize: (): number => configured,
    });
    const stage = stageSlice(0, 'highest-tile', 16, 0);

    // A payload with no readable board: the reader answers instead, and is
    // consulted again on the next write rather than remembered.
    const withoutBoard = {
      ...runCommit(0, stage, []),
      board: undefined,
    } as unknown as StateCommitEvent;

    hud.render(withoutBoard);

    expect(hud.readRendered()?.boardSize).toBe(5);

    configured = 6;
    hud.render({ ...withoutBoard, score: 8 });

    expect(hud.readRendered()?.boardSize).toBe(6);
    expect(
      outlets.stage.querySelector('.hud-board .hud-value')?.textContent,
    ).toBe(hudCopy.boardValue(6));

    hud.destroy();
  });

  it('omits the readout, and does not throw, when neither answers', () => {
    const outlets = runFixture();
    const hud = createHud({
      document,
      boardSize: (): number | null => {
        throw new Error('the configuration is unavailable');
      },
    });

    hud.render({
      ...runCommit(0, stageSlice(0, 'highest-tile', 16, 0), []),
      board: null,
    } as unknown as StateCommitEvent);

    expect(outlets.stage.querySelector('.hud-board')).toBeNull();
    expect(hud.readRendered()?.boardSize).toBeNull();

    // The rest of the indicator is still written.
    expect(outlets.stage.querySelector('.hud-stage-index .hud-value')
      ?.textContent).toBe(hudCopy.stageValue(0));

    hud.destroy();
  });
});

/* ==========================================================================
 * The relic tray reads the registry, live
 * ========================================================================== */

/** One held relic, as `RelicRegistry.active()` returns it. */
const held = (
  id: string,
  name: string,
  rarity: Rarity,
  charges?: number,
): ActiveRelic => ({
  definition: {
    id,
    name,
    rarity,
    description: `${name} does something.`,
    hooks: {},
  },
  pickupOrder: 0,
  charges,
  state: undefined,
});

describe('the tray renders the held relics in pickup order', () => {
  it('prefers the injected reader and calls it on every write', () => {
    const outlets = runFixture();
    let active: ActiveRelic[] = [
      { ...held('twin-seed', 'Twin Seed', 'common'), pickupOrder: 0 },
      { ...held('frostbind', 'Frostbind', 'legendary', 5), pickupOrder: 1 },
    ];
    const hud = createHud({
      document,
      relics: (): readonly ActiveRelic[] => active,

      // Deliberately wrong, so a row taking its name from the resolver instead
      // of from the held declaration would be visible.
      relicName: (): string => 'RESOLVER',
    });
    const stage = stageSlice(0, 'score-threshold', 200, 0.5);

    hud.render(runCommit(100, stage, []));

    expect(
      Array.from(outlets.tray.querySelectorAll('.relic-tray-name')).map(
        (node) => node.textContent,
      ),
    ).toEqual(['Twin Seed', 'Frostbind']);
    expect(hud.readRendered()?.relics).toEqual(['twin-seed', 'frostbind']);

    // The registry holds the live budget, so the count comes from the record
    // read at the moment of the write rather than from anything snapshotted.
    active = [
      active[0]!,
      { ...held('frostbind', 'Frostbind', 'legendary', 0), pickupOrder: 1 },
    ];
    hud.render(runCommit(104, stage, []));

    const rows = Array.from(
      outlets.tray.querySelectorAll('.relic-tray-item'),
    );

    expect(rows[1]?.getAttribute('data-charges')).toBe('0');
    expect(
      rows[1]?.querySelector('.relic-tray-charges')?.textContent,
    ).toBe(hudCopy.relicCharges(0));

    hud.destroy();
  });

  it('never re-sorts, groups or reverses what it was given', () => {
    const outlets = runFixture();
    const hud = createHud({
      document,

      // Supplied legendary-first and common-last: a tray sorting by rarity, by
      // name or by charges would reorder this, and pickup order is what the
      // hook bus dispatches in.
      relics: (): readonly ActiveRelic[] => [
        { ...held('zulu', 'Zulu', 'legendary', 1), pickupOrder: 0 },
        { ...held('alpha', 'Alpha', 'common'), pickupOrder: 1 },
        { ...held('mike', 'Mike', 'rare', 9), pickupOrder: 2 },
      ],
    });

    hud.render(runCommit(0, stageSlice(0, 'highest-tile', 16, 0), []));

    expect(
      Array.from(outlets.tray.querySelectorAll('.relic-tray-item')).map(
        (row) => row.getAttribute('data-relic-id'),
      ),
    ).toEqual(['zulu', 'alpha', 'mike']);

    hud.destroy();
  });

  it('falls back to the payload slice when the reader answers badly', () => {
    const outlets = runFixture();
    const hud = createHud({
      document,
      relics: (): readonly ActiveRelic[] => {
        throw new Error('the registry is unavailable');
      },
      relicName: (relicId): string => `Name of ${relicId}`,
    });

    hud.render(
      runCommit(0, stageSlice(0, 'highest-tile', 16, 0), [
        { id: 'tumbler', charges: 2 },
      ]),
    );

    expect(
      outlets.tray.querySelector('.relic-tray-name')?.textContent,
    ).toBe('Name of tumbler');
    expect(hud.readRendered()?.relics).toEqual(['tumbler']);

    hud.destroy();
  });
});

/* ==========================================================================
 * Announcements
 * ========================================================================== */

/** A recording stand-in for the one announcer of ../a11y/live-region. */
function recorder(): {
  readonly announcer: HudAnnouncerPort;
  readonly lines: string[];
  readonly structured: { kind: string; name?: string; rarity?: string }[];
} {
  const lines: string[] = [];
  const structured: { kind: string; name?: string; rarity?: string }[] = [];

  return {
    announcer: {
      announce: (input): void => {
        structured.push({ ...input });
      },
      announceText: (text): void => {
        lines.push(text);
      },
    },
    lines,
    structured,
  };
}

describe('the tray is readable through the live region', () => {
  it('announces a charge that changed, and only when it changed', () => {
    runFixture();

    const sink = recorder();
    const hud = createHud({
      document,
      announcer: (): HudAnnouncerPort => sink.announcer,
      relicName: (relicId): string => `Name of ${relicId}`,
    });
    const stage = stageSlice(0, 'highest-tile', 16, 0);

    // The loadout standing at the first write is the restored one, so it is
    // recorded silently rather than narrated as a change.
    hud.render(runCommit(0, stage, [{ id: 'frostbind', charges: 5 }]));

    expect(sink.lines).toEqual([]);

    hud.render(runCommit(4, stage, [{ id: 'frostbind', charges: 4 }]));

    expect(sink.lines).toEqual([
      hudCopy.chargeAnnouncement('Name of frostbind', 4),
    ]);

    // An unchanged budget says nothing: the canvas is aria-hidden, so this is
    // the only channel a count reaches a screen-reader user through, and it
    // must not repeat itself once per turn.
    hud.render(runCommit(8, stage, [{ id: 'frostbind', charges: 4 }]));

    expect(sink.lines).toHaveLength(1);

    // Down to zero, which the bus's charge guard skips from and the tray still
    // shows.
    hud.render(runCommit(12, stage, [{ id: 'frostbind', charges: 0 }]));

    expect(sink.lines).toEqual([
      hudCopy.chargeAnnouncement('Name of frostbind', 4),
      hudCopy.chargeAnnouncement('Name of frostbind', 0),
    ]);

    hud.destroy();
  });

  it('announces an acquisition as primitives, when asked to', () => {
    runFixture();

    const sink = recorder();
    const hud = createHud({
      document,
      announcer: sink.announcer,
      announceAcquisitions: true,
      relics: (): readonly ActiveRelic[] => active,
    });
    let active: ActiveRelic[] = [held('twin-seed', 'Twin Seed', 'common')];
    const stage = stageSlice(0, 'highest-tile', 16, 0);

    hud.render(runCommit(0, stage, []));

    expect(sink.structured).toEqual([]);

    active = [
      active[0]!,
      { ...held('frostbind', 'Frostbind', 'legendary', 5), pickupOrder: 1 },
    ];
    hud.render(runCommit(4, stage, []));

    // PRIMITIVES, not the relic: ../a11y/live-region types the variant over a
    // name, a tier and a budget and composes the line itself.
    expect(sink.structured).toEqual([
      {
        kind: 'relicAcquired',
        name: 'Frostbind',
        rarity: 'legendary',
        charges: 5,
      },
    ]);

    hud.destroy();
  });

  it('leaves the acquisition to its host by default', () => {
    runFixture();

    const sink = recorder();
    const hud = createHud({
      document,
      announcer: sink.announcer,
      relics: (): readonly ActiveRelic[] => active,
    });
    let active: ActiveRelic[] = [];
    const stage = stageSlice(0, 'highest-tile', 16, 0);

    hud.render(runCommit(0, stage, []));

    active = [held('frostbind', 'Frostbind', 'legendary', 5)];
    hud.render(runCommit(4, stage, []));

    expect(sink.structured).toEqual([]);

    hud.destroy();
  });

  it('survives an announcer that raises', () => {
    runFixture();

    const hud = createHud({
      document,
      announcer: {
        announce: (): void => {
          throw new Error('the region is gone');
        },
        announceText: (): void => {
          throw new Error('the region is gone');
        },
      },
      announceAcquisitions: true,
    });
    const stage = stageSlice(0, 'highest-tile', 16, 0);

    hud.render(runCommit(0, stage, [{ id: 'frostbind', charges: 5 }]));

    expect(() => {
      hud.render(runCommit(4, stage, [{ id: 'frostbind', charges: 4 }]));
    }).not.toThrow();
    expect(hud.readRendered()?.score).toBe(4);

    hud.destroy();
  });
});

/* ==========================================================================
 * The router lifecycle
 * ========================================================================== */

/** One stage context, as src/ui/screen-router.ts builds it. */
const stageContext = (
  overrides: Partial<StageScreenContext> = {},
): StageScreenContext => ({
  screen: 'stage',
  trigger: 'beginRun',
  reducedMotion: false,
  host: null,
  refresh: false,
  score: 0,
  bestScore: 0,
  stageIndex: 0,
  goal: { kind: 'highest-tile', target: 16 },
  goalProgress: { achieved: 4, progress: 0.25, cleared: false },
  relics: [],
  boardSize: 4,
  degraded: false,
  ...overrides,
});

/** The run fixture, plus the region focus is placed inside. */
function routedFixture(): {
  readonly hudGroup: HTMLElement;
  readonly stage: HTMLElement;
  readonly tray: HTMLElement;
  readonly board: HTMLElement;
} {
  document.body.innerHTML = `
    <div class="score-container"><span class="visually-hidden">Score</span>0</div>
    <div class="best-container"><span class="visually-hidden">Best score</span>0</div>
    <main class="game-main" id="game-main">
      <div class="hud" id="screen-hud" data-screen="hud" role="group"
           aria-label="Run status" hidden>
        <div class="hud-stage" id="hud-stage"></div>
        <ul class="relic-tray" id="relic-tray" role="list"
            aria-label="Active relics, in pickup order"></ul>
      </div>
      <div class="board-a11y" id="board-a11y" role="grid" tabindex="0"></div>
    </main>
  `;

  return {
    hudGroup: document.querySelector<HTMLElement>('#screen-hud')!,
    stage: document.querySelector<HTMLElement>('#hud-stage')!,
    tray: document.querySelector<HTMLElement>('#relic-tray')!,
    board: document.querySelector<HTMLElement>('#board-a11y')!,
  };
}

describe('the HUD is the stage screen of the router', () => {
  it('declares the whole lifecycle the router calls', () => {
    const hud = createHud({ document });

    for (const member of ['mount', 'enter', 'update', 'leave', 'unmount']) {
      expect(typeof (hud as unknown as Record<string, unknown>)[member]).toBe(
        'function',
      );
    }

    hud.destroy();
  });

  it('resolves its outlets inside the container the router injects', () => {
    const outlets = routedFixture();

    // Nothing injected and no document: every outlet is a miss at construction,
    // which is reported rather than raised, and `mount` supplies the container.
    const hud = createHud({
      hudContainer: null,
      stageContainer: null,
      relicTrayContainer: null,
      document,
    });

    hud.mount(outlets.hudGroup);

    expect(hud.hasStageIndicator()).toBe(true);
    expect(hud.hasRelicTray()).toBe(true);

    hud.enter(stageContext({ score: 24, stageIndex: 2 }));

    expect(
      outlets.stage.querySelector('.hud-stage-index .hud-value')?.textContent,
    ).toBe(hudCopy.stageValue(2));
    expect(outlets.hudGroup.hidden).toBe(false);

    hud.destroy();
  });

  it('places focus on entry and never on a refresh', () => {
    const outlets = routedFixture();
    const hud = createHud({ document });

    hud.mount(outlets.hudGroup);
    hud.enter(stageContext({ host: outlets.hudGroup }));

    // `SCREEN_INITIAL_FOCUS.stage` names the parallel board layer, which lives
    // inside `#game-main` and not inside `#screen-hud`.
    expect(document.activeElement).toBe(outlets.board);
    expect(hud.isActive()).toBe(true);

    outlets.board.blur();
    hud.update(stageContext({ refresh: true, score: 8 }));

    // The refresh path runs on every turn: moving focus there would drag a
    // keyboard user's caret back to the board on every move.
    expect(document.activeElement).not.toBe(outlets.board);

    hud.leave();

    expect(hud.isActive()).toBe(false);

    hud.destroy();
  });

  it('opts out of placing focus when asked to', () => {
    const outlets = routedFixture();
    const hud = createHud({ document, focusContainer: null });

    hud.mount(outlets.hudGroup);
    hud.enter(stageContext({ host: outlets.hudGroup }));

    expect(document.activeElement).not.toBe(outlets.board);

    hud.destroy();
  });

  it('renders a context in place, without rebuilding the tray', () => {
    const outlets = routedFixture();
    const hud = createHud({ document });
    const relics = [{ id: 'frostbind', charges: 3 }];

    hud.mount(outlets.hudGroup);
    hud.enter(stageContext({ relics }));

    const row = outlets.tray.querySelector('.relic-tray-item');

    // The refresh path runs on every turn, so a screen is not torn down and
    // rebuilt: the row standing is the row updated.
    hud.update(
      stageContext({
        refresh: true,
        score: 16,
        relics: [{ id: 'frostbind', charges: 2 }],
        goalProgress: { achieved: 8, progress: 0.5, cleared: false },
      }),
    );

    expect(outlets.tray.querySelector('.relic-tray-item')).toBe(row);
    expect(row?.getAttribute('data-charges')).toBe('2');
    expect(hud.readRendered()?.score).toBe(16);

    hud.destroy();
  });

  it('uses the measured quantity the context states, unrescaled', () => {
    const outlets = routedFixture();
    const hud = createHud({ document });

    hud.mount(outlets.hudGroup);
    hud.enter(
      stageContext({
        goal: { kind: 'score-threshold', target: 500 },

        // `evaluateStageGoal` already clamped this fraction and stated the
        // quantity beside it, so neither is re-derived here: a rescale would
        // show 150 rather than the 137 the run measured.
        goalProgress: { achieved: 137, progress: 0.274, cleared: false },
        score: 137,
      }),
    );

    expect(
      outlets.stage.querySelector('.hud-goal .hud-value')?.textContent,
    ).toBe(hudCopy.goalValue('score-threshold', 500, 137));
    expect(
      outlets.stage
        .querySelector<HTMLElement>('.hud-goal-meter-fill')
        ?.style.getPropertyValue('--hud-goal-fraction'),
    ).toBe('0.274');

    hud.destroy();
  });

  it('writes the stage number alone when no goal is in force', () => {
    const outlets = routedFixture();
    const hud = createHud({ document });

    hud.mount(outlets.hudGroup);
    hud.enter(stageContext({ goal: null, goalProgress: null, stageIndex: 3 }));

    expect(
      outlets.stage.querySelector('.hud-stage-index .hud-value')?.textContent,
    ).toBe(hudCopy.stageValue(3));
    expect(outlets.stage.querySelector('.hud-goal')).toBeNull();
    expect(hud.readRendered()?.stage).toBe(4);

    hud.destroy();
  });

  it('refuses a context for another screen and keeps what stands', () => {
    const outlets = routedFixture();
    const hud = createHud({ document });

    hud.mount(outlets.hudGroup);
    hud.enter(stageContext({ score: 32, stageIndex: 1 }));

    const written = hud.readRendered();

    hud.update({
      screen: 'reward',
      trigger: 'stageEnd',
      reducedMotion: false,
      host: null,
      refresh: false,
      offers: [],
      drawn: [],
      stageIndex: 1,
    });

    expect(hud.readRendered()).toBe(written);
    expect(
      outlets.stage.querySelector('.hud-stage-index .hud-value')?.textContent,
    ).toBe(hudCopy.stageValue(1));

    hud.destroy();
  });

  it('keeps the delta a commit showed across an unchanged refresh', () => {
    const outlets = routedFixture();
    const hud = createHud({
      scoreContainer: document.querySelector<HTMLElement>('.score-container'),
      bestContainer: document.querySelector<HTMLElement>('.best-container'),
      document,
    });

    hud.mount(outlets.hudGroup);
    hud.render(commit(0));
    hud.render(commit(16));

    const score = document.querySelector<HTMLElement>('.score-container')!;

    expect(score.querySelector('.score-addition')?.textContent).toBe('+16');

    // A second driver reporting the same turn must not rewrite the outlet: the
    // rewrite would clear the delta node the commit just appended.
    hud.update(stageContext({ refresh: true, score: 16, bestScore: 0 }));

    expect(score.querySelector('.score-addition')?.textContent).toBe('+16');

    hud.destroy();
  });

  it('tears everything down on unmount', () => {
    const outlets = routedFixture();
    const hud = createHud({ document });

    hud.mount(outlets.hudGroup);
    hud.enter(stageContext({ relics: [{ id: 'frostbind', charges: 3 }] }));
    hud.unmount();

    expect(outlets.tray.querySelector('.relic-tray-item')).toBeNull();
    expect(outlets.hudGroup.querySelector('.hud-degraded')).toBeNull();

    // Every later call is a reported no-op rather than a throw.
    expect(() => {
      hud.mount(outlets.hudGroup);
      hud.enter(stageContext());
      hud.update(stageContext({ refresh: true }));
      hud.leave();
      hud.unmount();
    }).not.toThrow();
  });
});

/* ==========================================================================
 * Layering and the frozen best-score contract
 * ========================================================================== */

describe('the HUD occupies the documented rung', () => {
  it('reads the HUD rung from the token layer', () => {
    // The first step of the ladder extension above the retained ceiling of 100,
    // and below the diagnostics overlay, which this surface must never shadow.
    expect(HUD_Z_INDEX).toBe(zIndex.hud);
    expect(HUD_Z_INDEX).toBe(200);
    expect(HUD_Z_INDEX).toBeLessThanOrEqual(zIndex.modal);
    expect(HUD_Z_INDEX).toBeLessThan(zIndex.diagnosticsOverlay);
  });
});

describe('the frozen best-score contract survives the HUD', () => {
  afterEach(() => {
    // The application never deletes this key, so a suite that ignores it leaks
    // the highest score into every later test.
    window.localStorage.removeItem(BEST_SCORE_KEY);
  });

  it('shows a value the vanilla game wrote, unchanged', () => {
    const surfaces = fixture();

    // Written by the pre-migration game before this page load.
    window.localStorage.setItem(BEST_SCORE_KEY, '13580');

    const storage = new LocalStorageManager();
    const persisted = storage.getBestScore();

    // The port's frozen return: the raw stored STRING when a value is present.
    expect(persisted).toBe('13580');
    expect(typeof persisted).toBe('string');

    const hud = createHud({
      scoreContainer: surfaces.score,
      bestContainer: surfaces.best,
      document,
    });

    hud.render(commit(120, { bestScore: persisted }));

    // Carried straight through: not coerced, not compared, not formatted.
    expect(valueOf(surfaces.best)).toBe('13580');
    expect(hud.readRendered()?.bestScore).toBe('13580');
    expect(typeof hud.readRendered()?.bestScore).toBe('string');

    // The promotion comparison of js/game_manager.js L80-L82 still relies on
    // the relational coercion of that string, which rendering has not
    // disturbed. The assertion widens the operand exactly as
    // src/engine/engine.ts does, so the comparison performed here is the one
    // the engine performs.
    expect((storage.getBestScore() as number) < 20000).toBe(true);
    expect((storage.getBestScore() as number) < 900).toBe(false);

    hud.destroy();
  });

  it('shows the absent value as the number zero the port returns', () => {
    const surfaces = fixture();
    const storage = new LocalStorageManager();
    const absent = storage.getBestScore();

    expect(absent).toBe(0);

    const hud = createHud({
      scoreContainer: surfaces.score,
      bestContainer: surfaces.best,
      document,
    });

    hud.render(commit(0, { bestScore: absent }));

    expect(valueOf(surfaces.best)).toBe('0');
    expect(hud.readRendered()?.bestScore).toBe(0);

    hud.destroy();
  });
});
