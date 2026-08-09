// The markup the composition root reads, and the actions that drive one run
// through the states AAP Figure 6 declares.
//
// ONE FIXTURE, so no suite carries a private copy of the document that can
// drift from index.html. Every element below is one index.html declares, in
// the nesting it declares: the page shell that a modal screen makes inert, the
// score outlets with their real visually-hidden labels, the in-flow HUD with
// its stage and relic-tray outlets, the retained `.game-message` overlay
// OUTSIDE the
// screen layer, the board host with its three surfaces and the parallel board,
// the generated-control host, the five overlay screen roots with their
// `role="dialog"` and `aria-modal` attributes, the settings dialog, the
// diagnostics root and the one live region.
//
// The flow helpers below press the controls a player presses rather than
// sending router triggers: `runStart -> stage` is taken by the begin-run
// control,
// `stageClear -> reward` by the continue control, and `reward -> stage` by a
// relic card. A suite that reaches a state by these helpers has proved the edge
// as well as the state.

/** The body markup of index.html, as one string. */
export const COMPOSITION_MARKUP = `
  <div class="container">
    <header class="heading">
      <h1 class="title">2048</h1>
      <div class="scores-container" role="group" aria-label="Scores">
        <div class="score-container">
          <span class="visually-hidden">Score</span>0</div>
        <div class="best-container">
          <span class="visually-hidden">Best score</span>0</div>
      </div>
    </header>

    <main class="game-main" id="game-main">
      <div class="above-game">
        <p class="game-intro">Join the numbers and get to the
          <strong>2048 tile!</strong></p>
        <button type="button" class="restart-button">New Game</button>
        <button type="button" class="settings-button" id="settings-button"
                aria-haspopup="dialog"
                aria-controls="settings-panel">Settings</button>
      </div>

      <div class="hud" id="screen-hud" data-screen="hud" role="group"
           aria-label="Run status" hidden>
        <div class="hud-stage" id="hud-stage"></div>
        <ul class="relic-tray" id="relic-tray" role="list"
            aria-label="Active relics, in pickup order"></ul>
      </div>

      <div class="game-container">
        <div class="game-message">
          <p></p>
          <div class="lower">
            <button type="button"
                    class="keep-playing-button">Keep going</button>
            <button type="button" class="retry-button">Try again</button>
          </div>
        </div>

        <div class="board-host" id="board-host">
          <canvas class="board-canvas" id="board-canvas"
                  aria-hidden="true"></canvas>
          <div class="board-number-only" id="board-number-only" hidden></div>
          <div class="board-a11y" id="board-a11y" role="grid"
               aria-label="Game board" aria-busy="true"></div>
        </div>
      </div>

      <div class="on-screen-controls" id="on-screen-controls"></div>
    </main>

    <footer class="page-footer"><hr><p>Note</p></footer>
  </div>

  <div class="screen-layer" id="screen-layer">
    <div class="screen" id="screen-run-start" data-screen="run-start"
         role="dialog" aria-modal="true" aria-label="Start a run" hidden></div>
    <div class="screen" id="screen-stage-progress" data-screen="stage-progress"
         role="dialog" aria-modal="true" aria-label="Stage progress"
         hidden></div>
    <div class="screen" id="screen-reward" data-screen="reward" role="dialog"
         aria-modal="true" aria-label="Choose a relic" hidden></div>
    <div class="screen" id="screen-game-over" data-screen="game-over"
         role="dialog" aria-modal="true" aria-label="Game over" hidden></div>
    <div class="screen" id="screen-run-summary" data-screen="run-summary"
         role="dialog" aria-modal="true" aria-label="Run summary" hidden></div>
    <div class="settings-panel" id="settings-panel" role="dialog"
         aria-modal="true" aria-label="Settings" hidden></div>
  </div>

  <div class="diagnostics-overlay" id="diagnostics-overlay" hidden></div>
  <div class="visually-hidden live-region" id="live-region" role="status"
       aria-live="polite" aria-atomic="true"></div>
`;

/**
 * Dispatches one key press on the document, which is where the input manager
 * listens.
 *
 * @param key `KeyboardEvent.key`.
 * @param code `KeyboardEvent.code`, defaulting to the key itself.
 */
export const pressKey = (key: string, code: string = key): void => {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key, code, bubbles: true }),
  );
};

/**
 * Begins a run from the run-start screen, optionally under a supplied seed.
 *
 * Takes the `runStart -> stage` edge the way a player does: the seed field is
 * filled where one is given, and the begin-run control is pressed.
 *
 * @param seed Seed to type, or `undefined` to let the run originate one.
 * @returns Whether the control was found and pressed.
 */
export const beginRun = (seed?: string): boolean => {
  if (seed !== undefined) {
    const field = document.querySelector<HTMLInputElement>('#run-start-seed');

    if (field === null) {
      return false;
    }

    field.value = seed;
  }

  const begin = document.querySelector<HTMLButtonElement>('#run-start-begin');

  if (begin === null) {
    return false;
  }

  begin.click();

  return true;
};

/**
 * Leaves the stage-clear screen for the reward offer, by its continue control.
 *
 * @returns Whether the control was found and pressed.
 */
export const continueToReward = (): boolean => {
  const control = document.querySelector<HTMLButtonElement>(
    '#screen-stage-progress .stage-progress-continue',
  );

  if (control === null) {
    return false;
  }

  control.click();

  return true;
};

/** One card on the reward screen: the relic it offers, and its visible name. */
export interface OfferedCard {
  readonly id: string;
  readonly name: string;
}

/**
 * The cards the reward screen is showing, in the order it rendered them.
 *
 * @returns One entry per card.
 */
export const offeredCards = (): OfferedCard[] =>
  [...document.querySelectorAll('#screen-reward .relic-card')].map(
    (card): OfferedCard => ({
      id: card.getAttribute('data-relic-id') ?? '',
      name: card.querySelector('.relic-card-name')?.textContent ?? '',
    }),
  );

/**
 * Presses one offered card.
 *
 * @param relicId Identifier of the card to press.
 * @returns Whether the card was found and pressed.
 */
export const chooseCard = (relicId: string): boolean => {
  const card = document.querySelector<HTMLElement>(
    `#screen-reward .relic-card[data-relic-id="${relicId}"]`,
  );

  if (card === null) {
    return false;
  }

  card.click();

  return true;
};
