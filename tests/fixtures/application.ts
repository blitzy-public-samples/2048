// Boot fixtures for the composed application, shared by every suite that needs
// a playable board.
//
// WHY THIS EXISTS. A cold load enters `runStart` and opens NO board: AAP Figure 6
// has the cold load land on the run-start screen and leave it only on a begin-run
// action, which is what makes the seed field and the begin-run control reachable
// at all. `start()` alone therefore leaves an empty grid and an overlay input
// context, and a suite that presses a movement key resolves nothing.
//
// A run stored under the versioned envelope, or a board stored under the frozen
// `gameState` key, is RESUMED by `start()` on its own — so a suite that seeds
// storage before booting needs none of this and must not use it, because
// beginning a run discards what was stored.

import { start } from '../../src/main';
import type { Application } from '../../src/main';

/**
 * Boots the page and begins a run: the two steps a player takes on a first
 * visit.
 *
 * The seed is originated rather than supplied, exactly as pressing the begin-run
 * control with an empty seed field does, so every board this opens is the one the
 * run's own substreams produced.
 *
 * @param ownerDocument Document to compose against.
 * @returns The composed application, with a stage in force and a playable board.
 */
export function startWithRun(ownerDocument: Document): Application {
  const application = start(ownerDocument);

  application.startNewRun();

  return application;
}
