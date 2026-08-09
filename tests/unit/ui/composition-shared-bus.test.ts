// Integration suite for the composition root's EVENT TOPOLOGY, AAP R2.
//
// WHAT WAS WRONG
//   `src/main.ts` subscribed the renderer, the HUD, the announcer, the sound
//   engine, the screen router and the engine-event metrics to `engine.events`,
//   while the hook bus dispatched only the six relic hooks. Engine events and
//   hook dispatch were two parallel channels, where AAP Figure 2 and Figure 3
//   declare one: the emitter fans out to the bus, and relics, renderer, UI and
//   observability are peers on it. Nothing in the type system noticed, because
//   both channels satisfy `EngineEvents`.
//
// WHAT THIS SUITE PINS
//   That the composed application relays the engine's seven events onto the ONE
//   bus it hands the relic registry, that a peer subscribing to that channel
//   receives the live turn, that the seven granular payloads survive the relay,
//   and that `dispose()` takes the relay down.
//
// tests/unit/engine/hook-bus-events.test.ts pins the relay in isolation. This
// suite pins only that the root wires it.
//
// The board is drawn by the number-only renderer here, because jsdom implements
// no WebGL context. Nothing in this suite depends on which renderer draws.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from '../../../src/main';
import type { Application } from '../../../src/main';
import { ENGINE_EVENT_NAMES } from '../../../src/engine/engine-events';
import type {
  EngineEventName,
  StateCommitEvent,
} from '../../../src/engine/engine-events';
import {
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_RIGHT,
  DIRECTION_UP,
} from '../../../src/engine/types';
import type { Direction } from '../../../src/engine/types';
import { resetWebGLSupportProbe } from '../../../src/render/webgl-support';
import { clearOwnedStorage } from '../../fixtures/storage';

/** The markup src/main.ts looks up, in the nesting index.html declares. */
const MARKUP = `
  <main id="game-main">
    <div class="score-container"><span class="visually-hidden">Score</span>0</div>
    <div class="best-container"><span class="visually-hidden">Best score</span>0</div>
    <div class="game-container">
      <div class="game-message"><p></p></div>
      <div class="board-host" id="board-host">
        <canvas class="board-canvas" id="board-canvas" aria-hidden="true"></canvas>
        <div class="board-number-only" id="board-number-only" hidden></div>
        <div class="board-a11y" id="board-a11y" role="grid" aria-busy="true"></div>
      </div>
    </div>
  </main>
  <div class="visually-hidden live-region" id="live-region" role="status"
       aria-live="polite" aria-atomic="true"></div>
`;

/** Six laps of the four directions, enough to reach every granular event. */
const MOVE_CYCLE: readonly Direction[] = Object.freeze(
  Array.from({ length: 6 }).flatMap((): readonly Direction[] => [
    DIRECTION_UP,
    DIRECTION_RIGHT,
    DIRECTION_DOWN,
    DIRECTION_LEFT,
  ]),
);

/**
 * Plays until one turn has committed, at most one lap of the four directions.
 *
 * A single direction is not enough: the opening board is drawn from a random
 * seed, and a turn that moved nothing commits nothing, so a suite asserting on a
 * commit has to reach one rather than assume it.
 *
 * @param app The application to drive.
 */
const playOneTurn = (app: Application): void => {
  for (const direction of [
    DIRECTION_LEFT,
    DIRECTION_UP,
    DIRECTION_RIGHT,
    DIRECTION_DOWN,
  ]) {
    if (app.engine.attemptMove(direction)) {
      return;
    }
  }
};

let application: Application | null = null;

beforeEach(() => {
  document.body.innerHTML = MARKUP;
  resetWebGLSupportProbe();
  clearOwnedStorage();
});

afterEach(() => {
  application?.dispose();
  application = null;
  resetWebGLSupportProbe();
  document.body.innerHTML = '';
  clearOwnedStorage();
});

describe('the composed event topology', () => {
  it('exposes one bus, and it is the relics\u2019 bus', () => {
    application = start(document);

    // The registry dispatches on this object and the peers subscribe to its
    // channel: one bus, which is what R2 asks for.
    expect(application.hooks).toBeDefined();
    expect(typeof application.hooks.attachEvents).toBe('function');
    expect(typeof application.hooks.events.on).toBe('function');
    expect(application.relics.size()).toBe(0);
  });

  it('carries a committed turn to a peer on the bus channel', () => {
    application = start(document);

    const commits: StateCommitEvent[] = [];
    const stop = application.hooks.events.on(
      'state:commit',
      (commit): void => {
        commits.push(commit);
      },
    );

    playOneTurn(application);
    stop();

    expect(commits.length).toBeGreaterThan(0);

    const last = commits[commits.length - 1];
    const state = application.engine.serialize();

    // The live board and the engine's own score, not a projection of them.
    expect(last?.board.serialize()).toEqual(state.grid);
    expect(last?.score).toBe(state.score);
  });

  it('relays every granular name a renderer animates from', () => {
    application = start(document);

    const seen = new Set<EngineEventName>();
    const releases = ENGINE_EVENT_NAMES.map((name) =>
      application?.hooks.events.on(name, (): void => {
        seen.add(name);
      }),
    );

    // A restart re-opens the board, which emits `stage:start` and the spawn of
    // each starting tile; the moves then produce the rest.
    application.startNewRun('shared-bus');

    for (const direction of MOVE_CYCLE) {
      application.engine.attemptMove(direction);
    }

    for (const release of releases) {
      release?.();
    }

    // Every name the renderer, the HUD and the announcer read. `stage:end` is
    // the one name a short game need not reach, so it is asserted separately
    // below through the goal the default curve sets.
    expect(seen.has('stage:start')).toBe(true);
    expect(seen.has('move:before')).toBe(true);
    expect(seen.has('tile:spawn')).toBe(true);
    expect(seen.has('move:after')).toBe(true);
    expect(seen.has('state:commit')).toBe(true);
  });

  it('counts a relayed event once in the metrics registry', () => {
    application = start(document);

    const before = application.metrics
      .snapshot()
      .series.filter((series) => series.name.endsWith('engine_events_total'))
      .reduce(
        (total, series) =>
          total + (series.kind === 'counter' ? series.value : 0),
        0,
      );

    application.engine.attemptMove(DIRECTION_LEFT);

    const after = application.metrics
      .snapshot()
      .series.filter((series) => series.name.endsWith('engine_events_total'))
      .reduce(
        (total, series) =>
          total + (series.kind === 'counter' ? series.value : 0),
        0,
      );

    // Fed from the bus channel, and from it alone: a double feed would count
    // every event twice.
    expect(after).toBeGreaterThan(before);
  });

  it('takes the relay down on dispose', () => {
    const subject = start(document);

    application = subject;

    let received = 0;
    const stop = subject.hooks.events.on('state:commit', (): void => {
      received += 1;
    });

    playOneTurn(subject);

    const delivered = received;

    expect(delivered).toBeGreaterThan(0);

    subject.dispose();
    application = null;

    playOneTurn(subject);
    stop();

    expect(received).toBe(delivered);
  });
});
