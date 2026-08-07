// Reload snapshots: an interrupted run resumed from storage reaches the same
// state as one that was never interrupted.
//
// THE PROPERTY
//   AAP V2 requires the same seed and the same move list to yield an identical
//   board and identical relic offers "across repeated runs AND ACROSS A RELOAD".
//   The reload half is a different claim from the repeated-run half and fails
//   differently: repeated runs share one process and one set of substreams,
//   while a reload rebuilds the substreams from a persisted cursor map. A build
//   that resumed by REPLAYING rather than fast-forwarding, or that restarted the
//   substreams at zero, or that persisted the cursors one commit late, passes
//   every repeated-run test and fails this one.
//
// HOW IT IS PROVED
//   Two runs of one seed and one move list. The first plays the whole list
//   uninterrupted. The second plays part of it, is torn down entirely — engine,
//   controller, substreams, all of it — and is rebuilt from nothing but what is
//   in storage, then plays the rest. The two boards are compared to each other
//   AND recorded, so the suite catches both "the resume diverged" and "the
//   sequence changed for both".
//
// THE RUN IDENTIFIER
//   Originated per run instance, so it cannot appear in a stored snapshot unless
//   the spec originates it deterministically. These specs do: the token factory
//   is a fixed list, which also makes the recorded envelope show that a resumed
//   run adopts the STORED identifier rather than the next token in that list.
//
// The project environment is `node`. Storage is a `MemoryStorage` behind the
// real manager, which is what makes a "reload" expressible here at all: the
// backing store outlives the composition built over it, exactly as a browser's
// Web Storage outlives the page.

import { describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../src/config/default-config';
import { createDefaultStageConfig } from '../../src/config/stage-config';
import { Engine } from '../../src/engine/engine';
import {
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_RIGHT,
  DIRECTION_UP,
  type Direction,
  type SerializedGameState,
} from '../../src/engine/types';
import { createRngStreams, type RngStreams } from '../../src/rng/rng-streams';
import { RunController, resolveRunIdentity } from '../../src/run/run-controller';
import type { RunState } from '../../src/run/run-state';
import { RunStateStore } from '../../src/run/run-state-store';
import { LocalStorageManager } from '../../src/storage/local-storage-manager';
import { MemoryStorage } from '../../src/storage/memory-storage';
import { RUN_STATE_KEY } from '../../src/storage/storage-keys';
import { formatBoard, formatRunState } from '../fixtures/snapshot-format';

/* ==========================================================================
 * Harness
 * ========================================================================== */

/** The move list, cycling all four directions so every seed resolves turns. */
const MOVES: readonly Direction[] = [
  DIRECTION_UP,
  DIRECTION_RIGHT,
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_UP,
  DIRECTION_RIGHT,
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_UP,
  DIRECTION_RIGHT,
  DIRECTION_DOWN,
  DIRECTION_LEFT,
];

/** Where the interrupted run is torn down. */
const INTERRUPT_AFTER = 5;

/**
 * Deterministic run tokens.
 *
 * A fresh composition takes the first for its seed and the second for its run
 * identifier. A resumed composition takes NEITHER — it adopts both from storage
 * — which is why a resumed envelope below still carries `run-instance-1`.
 */
const TOKENS: readonly string[] = [
  'snapshot-run-seed',
  'run-instance-1',
  'run-instance-2',
  'run-instance-3',
];

interface Composition {
  readonly controller: RunController;
  readonly engine: Engine;
  readonly streams: RngStreams;
  readonly stop: () => void;
}

/**
 * Composes a run over an existing backing store, in the composition root's
 * order: storage, identity, store, controller, substreams, engine, subscribers.
 *
 * Deliberately excludes the renderer, the HUD, the input layer, the announcer
 * and the observability layer. None of them may influence the recorded state,
 * and leaving them out is how that is guaranteed rather than assumed.
 */
function compose(backing: MemoryStorage): Composition {
  const manager = new LocalStorageManager({ storage: backing });
  const config = createDefaultRulesConfig();
  const stages = createDefaultStageConfig();

  let next = 0;
  const createToken = (): string => {
    const token = TOKENS[next] ?? `token-${String(next)}`;

    next += 1;

    return token;
  };

  const identity = resolveRunIdentity({ storage: manager, createToken });

  const controller = new RunController({
    store: new RunStateStore({ storage: manager, config }),
    identity,
    config,
    stages,
    createToken,
  });

  controller.begin();

  const streams = createRngStreams(controller.seed(), controller.cursors());

  const engine = new Engine({
    config,
    streams,
    storage: manager,
    stageContext: () => controller.stageContext(),
    relicContext: () => controller.relicContext(),
  });

  const stop = controller.observe(engine, () => streams.snapshotCursors());

  engine.setup();

  return { controller, engine, streams, stop };
}

function play(engine: Engine, moves: readonly Direction[]): void {
  for (const direction of moves) {
    engine.move(direction);
  }
}

/** The stored envelope, parsed. Throws where none is stored, which is a failure. */
function storedRun(backing: MemoryStorage): RunState {
  const raw = backing.getItem(RUN_STATE_KEY);

  if (raw === undefined) {
    throw new Error('no run envelope was stored');
  }

  return JSON.parse(raw) as RunState;
}

/** Renders a board and the envelope that was persisted alongside it. */
function render(board: SerializedGameState, state: RunState): string {
  return [
    'board as played',
    formatBoard(board),
    '',
    'run envelope as persisted',
    formatRunState(state, { showRunId: true }),
  ].join('\n');
}

/* ==========================================================================
 * 1. One uninterrupted run
 * ========================================================================== */

describe('an uninterrupted run', () => {
  it('reproduces its recorded board and envelope', () => {
    const backing = new MemoryStorage();
    const run = compose(backing);

    play(run.engine, MOVES);
    run.stop();

    expect(render(run.engine.serialize(), storedRun(backing))).toMatchSnapshot();
  });

  it('reproduces its recorded state at the interruption point', () => {
    // Recorded separately, so a divergence can be localised: a mismatch here
    // and not below means the first half changed, and a mismatch below and not
    // here means the resume changed.
    const backing = new MemoryStorage();
    const run = compose(backing);

    play(run.engine, MOVES.slice(0, INTERRUPT_AFTER));
    run.stop();

    expect(render(run.engine.serialize(), storedRun(backing))).toMatchSnapshot();
  });
});

/* ==========================================================================
 * 2. The same run, interrupted and resumed
 * ========================================================================== */

describe('a run interrupted and resumed from storage', () => {
  it('reaches the state the uninterrupted run reached', () => {
    const straight = new MemoryStorage();
    const first = compose(straight);

    play(first.engine, MOVES);
    first.stop();

    const expected = render(first.engine.serialize(), storedRun(straight));

    // The same seed, torn down halfway and rebuilt from storage alone.
    const interrupted = new MemoryStorage();
    const before = compose(interrupted);

    play(before.engine, MOVES.slice(0, INTERRUPT_AFTER));
    before.stop();

    const after = compose(interrupted);

    expect(after.controller.identity.resumed).toBe(true);
    expect(after.controller.seed()).toBe(first.controller.seed());
    expect(after.controller.runId()).toBe(first.controller.runId());

    play(after.engine, MOVES.slice(INTERRUPT_AFTER));
    after.stop();

    const resumed = render(after.engine.serialize(), storedRun(interrupted));

    // Byte for byte, including the cursors: the resumed run took the draws that
    // came next in the sequence rather than the draws it had already taken.
    expect(resumed).toBe(expected);

    // And recorded, so a change that moves BOTH sides together is caught too.
    expect(resumed).toMatchSnapshot();
  });

  it('reaches the same state however many times it is interrupted', () => {
    const straight = new MemoryStorage();
    const uninterrupted = compose(straight);

    play(uninterrupted.engine, MOVES);
    uninterrupted.stop();

    const expected = formatBoard(uninterrupted.engine.serialize());

    // Torn down and rebuilt after every single move: twelve compositions over
    // one backing store. Persisting the cursors one commit late, or rounding a
    // cursor, would show up here long before it showed up in a single resume.
    const stepwise = new MemoryStorage();

    for (const direction of MOVES) {
      const composition = compose(stepwise);

      play(composition.engine, [direction]);
      composition.stop();
    }

    expect(formatBoard(uninterrupted.engine.serialize())).toBe(expected);
    expect(formatBoard(compose(stepwise).engine.serialize())).toBe(expected);
  });

  it('takes no opening spawn on resume', () => {
    const backing = new MemoryStorage();
    const before = compose(backing);

    play(before.engine, MOVES.slice(0, INTERRUPT_AFTER));

    const cursorsBefore = before.streams.snapshotCursors();

    before.stop();

    const after = compose(backing);

    // `setup()` restored the board rather than seeding one, so the two starting
    // tiles were not spawned again. A resume that replayed instead of
    // fast-forwarding would show these cursors two higher and a board with two
    // extra tiles.
    expect(after.streams.snapshotCursors()).toEqual(cursorsBefore);
  });
});

/* ==========================================================================
 * 3. What a resume does NOT carry over
 * ========================================================================== */

describe('resuming', () => {
  it('adopts the stored run identifier rather than originating one', () => {
    const backing = new MemoryStorage();
    const first = compose(backing);

    first.stop();

    const second = compose(backing);

    // The token factory would have handed out `snapshot-run-seed` and
    // `run-instance-1` again; the resumed composition asked it for neither.
    expect(second.controller.runId()).toBe('run-instance-1');
    expect(second.controller.identity.seedProvided).toBe(false);
    expect(second.controller.identity.resumed).toBe(true);
  });

  it('reproduces its recorded envelope after a resume', () => {
    const backing = new MemoryStorage();
    const first = compose(backing);

    play(first.engine, MOVES.slice(0, INTERRUPT_AFTER));
    first.stop();

    const second = compose(backing);

    play(second.engine, MOVES.slice(INTERRUPT_AFTER));
    second.stop();

    expect(
      formatRunState(storedRun(backing), { showRunId: true }),
    ).toMatchSnapshot();
  });
});
