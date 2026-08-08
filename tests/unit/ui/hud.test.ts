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

  it('renders a readout, not a button, when nothing can be activated', () => {
    const outlets = runFixture();
    const hud = createHud({ document });

    hud.render(
      runCommit(0, stageSlice(0, 'highest-tile', 16, 0), [{ id: 'twin-seed' }]),
    );

    // A focusable button that does nothing is worse for a keyboard user than no
    // button at all, so the control is a span until a handler exists.
    expect(outlets.tray.querySelector('button')).toBeNull();
    expect(
      outlets.tray.querySelector('.relic-tray-control')?.tagName,
    ).toBe('SPAN');

    hud.destroy();
  });

  it('reports the relic a pressed control addresses', () => {
    const outlets = runFixture();
    const activated: string[] = [];
    const hud = createHud({
      document,
      onRelicActivate: (relicId): void => {
        activated.push(relicId);
      },
    });

    hud.render(
      runCommit(0, stageSlice(0, 'highest-tile', 16, 0), [
        { id: 'twin-seed' },
        { id: 'tumbler', charges: 3 },
      ]),
    );

    const controls = outlets.tray.querySelectorAll<HTMLButtonElement>(
      'button.relic-tray-control',
    );

    expect(controls).toHaveLength(2);

    controls[1]?.click();

    expect(activated).toEqual(['tumbler']);

    // Released with the HUD, so a destroyed HUD reports nothing further.
    hud.destroy();
    controls[0]?.click();

    expect(activated).toEqual(['tumbler']);
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

  it('rebuilds when a charge is spent, and not otherwise', () => {
    const outlets = runFixture();
    const hud = createHud({ document });
    const stage = stageSlice(0, 'highest-tile', 16, 0);

    hud.render(runCommit(0, stage, [{ id: 'frostbind', charges: 5 }]));

    const first = outlets.tray.querySelector('.relic-tray-item');

    hud.render(runCommit(4, stage, [{ id: 'frostbind', charges: 5 }]));

    expect(outlets.tray.querySelector('.relic-tray-item')).toBe(first);

    hud.render(runCommit(8, stage, [{ id: 'frostbind', charges: 4 }]));

    expect(outlets.tray.querySelector('.relic-tray-item')).not.toBe(first);
    expect(
      outlets.tray.querySelector('.relic-tray-charges')?.textContent,
    ).toBe(hudCopy.relicCharges(4));

    hud.destroy();
  });
});
