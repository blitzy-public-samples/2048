// The number-only renderer: the board drawn as numbered DOM tiles.
//
// This is the accessible rendering mode, and it is the mode a machine
// without WebGL is served. It draws no pixels of its own: it produces the
// element structure style/main.scss already styles, so the board, the
// tile ramp, the spawn and merge keyframes and the terminal overlay all
// render through the stylesheet the game has always used.
//
// It is the sole producer of five class names that style/main.scss
// declares and index.html no longer contains:
//   .grid-container  the empty-cell layer, one .grid-row per row
//   .grid-row        one row of the lattice
//   .grid-cell       one empty cell
//   .tile-container  the tile layer
//   .tile            one tile, holding one .tile-inner
// Every one of them is generated from the board size the engine commits,
// which is what removing the sixteen static cells of index.html L43-L68
// made possible.
//
// Supersedes js/html_actuator.js, which is deleted. It is a subscriber,
// not a callee: js/game_manager.js L91-L97 pushed to the actuator, and
// this module reads the `state:commit` event instead. Method for
// method:
//   js/html_actuator.js L1-L8     constructor       -> the four lookups
//   js/html_actuator.js L10-L36   actuate()         -> paint()
//   js/html_actuator.js L39-L41   continueGame()    -> paint(), the
//                                                      branch a commit
//                                                      with `terminated`
//                                                      false takes
//   js/html_actuator.js L43-L47   clearContainer()  -> clearElement()
//   js/html_actuator.js L49-L91   addTile()          -> addTile()
//   js/html_actuator.js L93-L95   applyClasses()    -> applyClasses()
//   js/html_actuator.js L97-L104  positionClass()   -> positionClass()
//   js/html_actuator.js L106-L121 updateScore()     -> updateScore()
//   js/html_actuator.js L123-L125 updateBestScore() -> updateBestScore()
//   js/html_actuator.js L127-L133 message()         -> showMessage()
//   js/html_actuator.js L135-L139 clearMessage()    -> clearMessage()
//
// TWO CHANGES TO THE PORTED BEHAVIOUR
//   The two nested `requestAnimationFrame` calls at L13 and L69 become
//   `frame()`, which the composition root drives through
//   src/render/render-loop.ts. The two-phase paint they produced is
//   preserved exactly: a tile that moved is drawn at its previous cell on
//   one frame and moved to its new cell on the next, which is what the
//   $transition-speed transform transition animates.
//
//   Every element lookup is guarded. L2-L5 held four unchecked
//   `querySelector` results and L44, L90, L107 and L131 dereferenced them,
//   so a renamed class was a startup failure; an absent element is now
//   reported once and the remaining surfaces still render.
//
// Invariants of this module: it consumes no randomness, touches no
// storage, reads no clock and holds no engine reference — it reads the
// `state:commit` event and nothing else.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import type {
  EngineEvents,
  StateCommitEvent,
} from '../engine/engine-events';
import type { RenderReporter } from './webgl-support';
import { NOOP_RENDER_REPORTER } from './webgl-support';

/* --------------------------------------------------------------------------
 * How a commit carries the board
 * ----------------------------------------------------------------------- */

/**
 * The board as `state:commit` carries it: the engine's live grid.
 *
 * Read off the payload, exactly as js/html_actuator.js L16-L22 read
 * `grid.cells` off the grid js/game_manager.js L91 handed it. Derived
 * from the event type so this module names no engine module other than
 * the event contract.
 */
type CommitBoard = StateCommitEvent['board'];

/**
 * One tile as `state:commit` carries it: a live tile of the grid, whose
 * `value`, `previousPosition` and `mergedFrom` js/html_actuator.js read
 * at L58, L54, L67 and L73-L80.
 *
 * The board's cells hold `null` where a cell is empty, which this type
 * excludes.
 */
type CommitTile = NonNullable<CommitBoard['cells'][number][number]>;

/* --------------------------------------------------------------------------
 * Class names and copy
 * ----------------------------------------------------------------------- */

/** The empty-cell layer. style/main.scss gives it `z-index: 1`. */
const GRID_CONTAINER_CLASS = 'grid-container';

/** One row of the empty-cell layer. */
const GRID_ROW_CLASS = 'grid-row';

/** One empty cell. */
const GRID_CELL_CLASS = 'grid-cell';

/** The tile layer. style/main.scss gives it `z-index: 2`. */
const TILE_CONTAINER_CLASS = 'tile-container';

/** The class every tile above the win value carries. From L60. */
const SUPER_TILE_CLASS = 'tile-super';

/** The class a tile produced by a merge carries. From L74. */
const MERGED_TILE_CLASS = 'tile-merged';

/** The class a newly spawned tile carries. From L82. */
const NEW_TILE_CLASS = 'tile-new';

/** The class the score delta carries. From L116. */
const SCORE_ADDITION_CLASS = 'score-addition';

/** The class the terminal overlay carries on a win. From L128. */
const WON_MESSAGE_CLASS = 'game-won';

/** The class the terminal overlay carries on a loss. From L128. */
const OVER_MESSAGE_CLASS = 'game-over';

/** The verdict shown on a win. Ported verbatim from L129. */
const WON_MESSAGE_TEXT = 'You win!';

/** The verdict shown on a loss. Ported verbatim from L129. */
const OVER_MESSAGE_TEXT = 'Game over!';

/**
 * Value above which a tile takes the super treatment, when the caller
 * names none.
 *
 * js/html_actuator.js L60 compared against the literal 2048, which is the
 * same literal js/game_manager.js L170 used as the win value. A caller
 * passes `RulesConfig.winValue`, so the band follows the configured win
 * value; this constant is the value that literal carried.
 */
const DEFAULT_SUPER_THRESHOLD = 2048;

/* --------------------------------------------------------------------------
 * Counter names
 * ----------------------------------------------------------------------- */

/** Counter name for one painted commit. */
const PAINT_METRIC = 'render.numberOnly.paint';

/** Counter name for one rebuilt empty-cell layer. */
const LATTICE_METRIC = 'render.numberOnly.lattice';

/** Counter name for an absent mount point. */
const MOUNT_MISSING_METRIC = 'render.numberOnly.mount.missing';

/** Source name every diagnostic this module raises carries. */
const DIAGNOSTIC_SOURCE = 'render.numberOnly';

/* --------------------------------------------------------------------------
 * Contract
 * ----------------------------------------------------------------------- */

/** Construction parameters. */
export interface NumberOnlyRendererOptions {
  /**
   * Element the board is built inside. index.html declares
   * `#board-number-only` for it, which ships with the `hidden`
   * attribute; the renderer removes that attribute when it mounts.
   */
  readonly host: Element | null;

  /**
   * The score outlet. index.html declares `.score-container`. Absent,
   * the score is not shown and the rest of the board still renders.
   */
  readonly scoreContainer?: Element | null;

  /** The best-score outlet. index.html declares `.best-container`. */
  readonly bestContainer?: Element | null;

  /** The terminal overlay. index.html declares `.game-message`. */
  readonly messageContainer?: Element | null;

  /**
   * Element hidden while this renderer owns the board. index.html
   * declares `#board-canvas`, which nothing draws into while the board
   * is drawn as DOM tiles.
   */
  readonly canvas?: Element | null;

  /** Document elements are created in. Defaults to the ambient `document`. */
  readonly ownerDocument?: Document;

  /**
   * Value above which a tile takes the `.tile-super` treatment. A caller
   * passes `RulesConfig.winValue`; it defaults to 2048, the literal
   * js/html_actuator.js L60 compared against.
   */
  readonly superThreshold?: number;

  /** Sink for counters and diagnostics. Defaults to `NOOP_RENDER_REPORTER`. */
  readonly reporter?: RenderReporter;

  /**
   * Called whenever the renderer has queued work, so the caller can run
   * a frame. Absent, the caller drives `frame()` on its own schedule.
   */
  readonly onWork?: () => void;
}

/**
 * The renderer.
 *
 * Frozen: the five members below are its whole surface.
 */
export interface NumberOnlyRenderer {
  /** Whether the mount point was found and the renderer will paint. */
  readonly mounted: boolean;

  /**
   * Queues a commit for the next frame.
   *
   * A commit queued while another is still queued replaces it: only the
   * latest state is ever painted, which is what the single
   * `requestAnimationFrame` of js/html_actuator.js L13 achieved.
   *
   * @param commit The state commit to paint.
   */
  render(commit: StateCommitEvent): void;

  /**
   * Runs one frame of queued work.
   *
   * @returns `true` while work remains, which is the value
   *   src/render/render-loop.ts reads as outstanding work.
   */
  frame(): boolean;

  /**
   * Subscribes to an engine's `state:commit` event.
   *
   * @param events Emitter to subscribe to.
   * @returns A handle that removes the subscription.
   */
  subscribe(events: EngineEvents): () => void;

  /**
   * Empties the board layers and drops the queued work.
   *
   * Leaves the mount point in the document, and leaves the score, best
   * score and overlay as they stand.
   */
  destroy(): void;
}

/* --------------------------------------------------------------------------
 * Construction
 * ----------------------------------------------------------------------- */

/**
 * Reads the ambient `document`.
 *
 * @returns The document, or `null` outside a browser.
 */
function readAmbientDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

/**
 * Narrows an element to one carrying the `hidden` property, without
 * assuming the constructor is defined.
 *
 * @param element Element to narrow.
 * @returns The element as an `HTMLElement`, or `null`.
 */
function asToggleable(element: Element | null | undefined): HTMLElement | null {
  if (element === null || element === undefined) {
    return null;
  }

  if (typeof HTMLElement === 'undefined') {
    return null;
  }

  return element instanceof HTMLElement ? element : null;
}

/**
 * Removes every child of an element.
 *
 * Ported from js/html_actuator.js L43-L47.
 *
 * @param element Element to empty.
 */
function clearElement(element: Element): void {
  while (element.firstChild !== null) {
    element.removeChild(element.firstChild);
  }
}

/**
 * Builds the position class of a cell.
 *
 * Ported from js/html_actuator.js L97-L104: the coordinates are
 * one-based in the class name, which is the range the `@for` loops of
 * style/main.scss generate.
 *
 * @param x Zero-based column index.
 * @param y Zero-based row index.
 * @returns The class name, such as `tile-position-1-1`.
 */
function positionClass(x: number, y: number): string {
  return `tile-position-${x + 1}-${y + 1}`;
}

/**
 * Writes a class list onto an element.
 *
 * Ported from js/html_actuator.js L93-L95, which set the attribute
 * wholesale rather than using `classList`; the comment at L57 recorded
 * why. The behaviour is kept: one assignment replaces the element's
 * whole class list, so a stale position class cannot survive.
 *
 * @param element Element to write to.
 * @param classes Classes to apply.
 */
function applyClasses(element: Element, classes: readonly string[]): void {
  element.setAttribute('class', classes.join(' '));
}

/**
 * Creates a number-only renderer.
 *
 * @param options Mount points, document, reporter and work callback.
 * @returns A frozen renderer. One constructed without its mount point
 *   reports the absence, paints nothing, and every member stays safe to
 *   call.
 *
 * @example
 * ```ts
 * const renderer = createNumberOnlyRenderer({
 *   host: document.querySelector('#board-number-only'),
 *   scoreContainer: document.querySelector('.score-container'),
 *   bestContainer: document.querySelector('.best-container'),
 *   messageContainer: document.querySelector('.game-message'),
 *   onWork: () => loop.invalidate(),
 * });
 *
 * renderer.subscribe(engine.events);
 * loop.addFrameCallback(() => renderer.frame());
 * ```
 */
export function createNumberOnlyRenderer(
  options: NumberOnlyRendererOptions,
): NumberOnlyRenderer {
  const reporter = options.reporter ?? NOOP_RENDER_REPORTER;
  const owner = options.ownerDocument ?? readAmbientDocument();
  const host = options.host ?? null;
  const scoreContainer = options.scoreContainer ?? null;
  const bestContainer = options.bestContainer ?? null;
  const messageContainer = options.messageContainer ?? null;
  const superThreshold = options.superThreshold ?? DEFAULT_SUPER_THRESHOLD;
  const toggleableHost = asToggleable(host);

  const mounted = host !== null && owner !== null;

  if (!mounted) {
    reporter.onCount({ name: MOUNT_MISSING_METRIC, value: 1 });
    reporter.onDiagnostic({
      level: 'error',
      source: DIAGNOSTIC_SOURCE,
      message: 'The number-only board host is absent; the board is not drawn.',
    });
  }

  /** The score the last paint showed. Ported from js/html_actuator.js L7. */
  let shownScore = 0;

  /** Whether a score has been shown, so the first paint reports no delta. */
  let scoreShown = false;

  /** Edge length the empty-cell layer was last built at. */
  let latticeSize = 0;

  /** The empty-cell layer, once built. */
  let gridLayer: Element | null = null;

  /** The tile layer, once built. */
  let tileLayer: Element | null = null;

  /** The commit awaiting a paint, or `null`. */
  let queued: StateCommitEvent | null = null;

  /** Position rewrites the next frame applies. */
  let deferred: (() => void)[] = [];

  /**
   * Signals that work is queued.
   */
  const requestWork = (): void => {
    options.onWork?.();
  };

  /**
   * Builds the two board layers, and the empty-cell lattice inside the
   * first, for a board of `size` cells to a side.
   *
   * The lattice is rebuilt only when the size changes, so a move repaints
   * tiles alone. index.html declared this structure statically at
   * L43-L72 for exactly one size; it is generated here for the size the
   * engine commits.
   *
   * @param size Edge length in cells.
   */
  const buildLayers = (size: number): void => {
    if (host === null || owner === null) {
      return;
    }

    if (gridLayer !== null && tileLayer !== null && latticeSize === size) {
      return;
    }

    clearElement(host);

    const grid = owner.createElement('div');

    grid.className = GRID_CONTAINER_CLASS;

    for (let y = 0; y < size; y += 1) {
      const row = owner.createElement('div');

      row.className = GRID_ROW_CLASS;

      for (let x = 0; x < size; x += 1) {
        const cell = owner.createElement('div');

        cell.className = GRID_CELL_CLASS;
        row.appendChild(cell);
      }

      grid.appendChild(row);
    }

    const tiles = owner.createElement('div');

    tiles.className = TILE_CONTAINER_CLASS;

    host.appendChild(grid);
    host.appendChild(tiles);

    gridLayer = grid;
    tileLayer = tiles;
    latticeSize = size;

    reporter.onCount({
      name: LATTICE_METRIC,
      value: 1,
      detail: Object.freeze({ size }),
    });
  };

  /**
   * Draws one tile, and the pair it merged from.
   *
   * Ported from js/html_actuator.js L49-L91, including the recursion at
   * L78-L80 that draws both source tiles of a merge underneath the merged
   * one, and the deferred class rewrite at L69-L72 that lets the movement
   * transition run.
   *
   * @param tile Tile to draw.
   * @param superThreshold Value above which the super treatment applies.
   */
  const addTile = (tile: CommitTile, superThreshold: number): void => {
    if (owner === null || tileLayer === null) {
      return;
    }

    const wrapper = owner.createElement('div');
    const inner = owner.createElement('div');
    const previous = tile.previousPosition;
    const drawnAt = previous ?? { x: tile.x, y: tile.y };

    const classes: string[] = [
      'tile',
      `tile-${tile.value}`,
      positionClass(drawnAt.x, drawnAt.y),
    ];

    if (tile.value > superThreshold) {
      classes.push(SUPER_TILE_CLASS);
    }

    applyClasses(wrapper, classes);

    inner.className = 'tile-inner';
    inner.textContent = String(tile.value);

    if (previous !== null) {
      // Ported from L67-L72: the tile is in the document at its previous
      // cell now, and moves on the next frame.
      deferred.push((): void => {
        classes[2] = positionClass(tile.x, tile.y);
        applyClasses(wrapper, classes);
      });
    } else if (tile.mergedFrom !== null) {
      classes.push(MERGED_TILE_CLASS);
      applyClasses(wrapper, classes);

      for (const source of tile.mergedFrom) {
        addTile(source, superThreshold);
      }
    } else {
      classes.push(NEW_TILE_CLASS);
      applyClasses(wrapper, classes);
    }

    wrapper.appendChild(inner);
    tileLayer.appendChild(wrapper);
  };

  /**
   * Redraws every tile of a board.
   *
   * @param board The board the commit carried.
   * @param superThreshold Value above which the super treatment applies.
   */
  const drawBoard = (board: CommitBoard, superThreshold: number): void => {
    if (tileLayer === null) {
      return;
    }

    clearElement(tileLayer);

    // The x-outer, y-inner order js/html_actuator.js L16-L22 drew in.
    for (const column of board.cells) {
      for (const cell of column) {
        if (cell !== null) {
          addTile(cell, superThreshold);
        }
      }
    }
  };

  /**
   * Writes the score and, where it rose, the delta.
   *
   * Ported from js/html_actuator.js L106-L121. The delta element is
   * appended after the text is written, which is the order that file
   * used; `.score-addition` carries the `move-up` animation.
   *
   * @param score Score to show.
   */
  const updateScore = (score: number): void => {
    if (scoreContainer === null || owner === null) {
      return;
    }

    clearElement(scoreContainer);

    const difference = scoreShown ? score - shownScore : 0;

    shownScore = score;
    scoreShown = true;
    scoreContainer.textContent = String(score);

    if (difference > 0) {
      const addition = owner.createElement('div');

      addition.className = SCORE_ADDITION_CLASS;
      addition.textContent = `+${difference}`;
      scoreContainer.appendChild(addition);
    }
  };

  /**
   * Writes the best score.
   *
   * Ported from js/html_actuator.js L123-L125. The value arrives exactly
   * as the storage layer returns it — a string when one is stored and the
   * number `0` when none is — and is written as text, which is what that
   * line did.
   *
   * @param bestScore Best score to show.
   */
  const updateBestScore = (bestScore: string | number): void => {
    if (bestContainer === null) {
      return;
    }

    bestContainer.textContent = String(bestScore);
  };

  /**
   * Shows the terminal overlay.
   *
   * Ported from js/html_actuator.js L127-L133, including writing the
   * verdict into the overlay's first paragraph.
   *
   * @param won Whether the verdict is a win.
   */
  const showMessage = (won: boolean): void => {
    if (messageContainer === null) {
      return;
    }

    messageContainer.classList.add(
      won ? WON_MESSAGE_CLASS : OVER_MESSAGE_CLASS,
    );

    const paragraph = messageContainer.getElementsByTagName('p')[0];

    if (paragraph !== undefined) {
      paragraph.textContent = won ? WON_MESSAGE_TEXT : OVER_MESSAGE_TEXT;
    }
  };

  /**
   * Hides the terminal overlay.
   *
   * Ported from js/html_actuator.js L135-L139, which removed the two
   * classes one at a time.
   */
  const clearMessage = (): void => {
    if (messageContainer === null) {
      return;
    }

    messageContainer.classList.remove(WON_MESSAGE_CLASS);
    messageContainer.classList.remove(OVER_MESSAGE_CLASS);
  };

  /**
   * Paints one commit.
   *
   * Ported from the body of js/html_actuator.js L13-L35.
   *
   * @param commit Commit to paint.
   */
  const paint = (commit: StateCommitEvent): void => {
    if (host === null) {
      return;
    }

    // index.html ships the layer hidden; it is shown once, on the first
    // paint, so the board never appears before it has tiles in it.
    if (toggleableHost !== null && toggleableHost.hidden) {
      toggleableHost.hidden = false;
    }

    buildLayers(commit.board.size);
    drawBoard(commit.board, superThreshold);
    updateScore(commit.score);
    updateBestScore(commit.bestScore);

    // Ported from L27-L33.
    if (commit.terminated) {
      if (commit.over) {
        showMessage(false);
      } else if (commit.won) {
        showMessage(true);
      }
    } else {
      // Ported from js/html_actuator.js L39-L41, which the manager called
      // on restart (js/game_manager.js L19) and on keep-playing (L26).
      // Both now reach this module as a commit carrying `terminated` as
      // `false`.
      clearMessage();
    }

    reporter.onCount({ name: PAINT_METRIC, value: 1 });
  };

  /**
   * Queues a commit for the next frame.
   *
   * @param commit Commit to paint.
   */
  const queueCommit = (commit: StateCommitEvent): void => {
    queued = commit;
    requestWork();
  };

  // The canvas carries no drawing while the board is drawn as DOM tiles,
  // so it is hidden once, here.
  const toggleableCanvas = asToggleable(options.canvas);

  if (toggleableCanvas !== null) {
    toggleableCanvas.hidden = true;
  }

  return Object.freeze({
    mounted,

    render: queueCommit,

    frame(): boolean {
      const commit = queued;

      if (commit !== null) {
        queued = null;
        deferred = [];
        paint(commit);

        // Ported from the nesting at js/html_actuator.js L13 and L69: the
        // rewrites run on the frame after the one that drew the tiles.
        return deferred.length > 0;
      }

      if (deferred.length === 0) {
        return false;
      }

      const running = deferred;

      deferred = [];

      for (const rewrite of running) {
        rewrite();
      }

      return false;
    },

    subscribe(events: EngineEvents): () => void {
      return events.on('state:commit', queueCommit);
    },

    destroy(): void {
      queued = null;
      deferred = [];

      if (tileLayer !== null) {
        clearElement(tileLayer);
      }

      if (host !== null) {
        clearElement(host);
      }

      gridLayer = null;
      tileLayer = null;
      latticeSize = 0;
    },
  });
}
