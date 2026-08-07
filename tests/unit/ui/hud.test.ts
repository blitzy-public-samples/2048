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
import type { StateCommitEvent } from '../../../src/engine/engine-events';
import { EMPTY_RELIC_CONTEXT, EMPTY_STAGE_CONTEXT } from '../../../src/engine/types';
import { Grid } from '../../../src/engine/grid';
import { createNumberOnlyRenderer } from '../../../src/render/number-only-renderer';
import { createHud, hudCopy } from '../../../src/ui/screens/hud';
import type { BestScoreValue } from '../../../src/engine/types';

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

describe('the HUD is wired to the engine, not to a renderer', () => {
  it('writes on every commit the emitter carries', () => {
    const surfaces = fixture();
    const events = createEngineEvents();
    const hud = createHud({
      scoreContainer: surfaces.score,
      bestContainer: surfaces.best,
      messageContainer: surfaces.message,
      document,
    });

    const stop = hud.subscribe(events);

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

    hud.subscribe(events);
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
