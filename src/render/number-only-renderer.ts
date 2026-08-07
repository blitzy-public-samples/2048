// The number-only renderer: the board drawn as numbered DOM elements.
//
// It is the board renderer a machine with no WebGL context is served, and
// it is also selectable while a context is available. It reads no
// capability probe: `mount()` takes no probe argument and consults none.
//
// PRODUCED STRUCTURE
// style/main.scss L419-L478 names this module as the producer of four
// class names index.html no longer contains, and this module builds them
// into the `#board-number-only` layer at the configured size:
//   .grid-container  the empty-cell layer, one .grid-row per row
//   .grid-row        one row of the lattice
//   .grid-cell       one cell of the lattice
//   .tile-container  the tile layer
//   .tile            one tile, holding one .tile-inner
// index.html L43-L68 held sixteen `.grid-cell` elements and L70-L72 an
// empty `.tile-container`; both were removed, and every element above is
// generated from the board size a commit carries.
//
// The lattice carries the grid semantics — `role="grid"`, `role="row"`,
// `role="gridcell"`, the four ARIA position attributes and one accessible
// name per cell — and the tile layer carries `aria-hidden="true"`.
// `#live-region` of index.html L105 and the parallel board of
// `#board-a11y` at L65 belong to src/ui/a11y/; this module announces
// nothing and builds neither, and `readRenderedBoard()` is what it
// exposes for them to read.
//
// SUPERSEDES js/html_actuator.js, which is deleted. It is a subscriber,
// not a callee: js/game_manager.js L91-L97 pushed to the actuator, and
// this module reads the `state:commit` event instead. Construct for
// construct:
//   js/html_actuator.js L1-L8     constructor       -> the guarded
//                                                      lookups of
//                                                      `mount()`
//   js/html_actuator.js L10-L36   actuate()         -> paint()
//   js/html_actuator.js L39-L41   continueGame()    -> continueGame()
//   js/html_actuator.js L43-L47   clearContainer()  -> clearElement()
//   js/html_actuator.js L49-L91   addTile()         -> addTile()
//   js/html_actuator.js L93-L95   applyClasses()    -> applyClasses()
//   js/html_actuator.js L97-L99   normalizePosition() -> positionClass()
//   js/html_actuator.js L101-L104 positionClass()   -> positionClass()
//   js/html_actuator.js L106-L121 updateScore()     -> updateScore()
//   js/html_actuator.js L123-L125 updateBestScore() -> updateBestScore()
//   js/html_actuator.js L127-L133 message()         -> showMessage()
//   js/html_actuator.js L135-L139 clearMessage()    -> clearMessage()
//
// FOUR CHANGES TO THE PORTED BEHAVIOUR
//   1. Every element lookup is guarded. L2-L5 held four unchecked
//      `querySelector` results and L44, L90, L107, L124, L131, L132, L137
//      and L138 dereferenced them, and L132 also indexed
//      `getElementsByTagName("p")` without checking the result. An absent
//      element is reported once through the injected reporter and the
//      remaining surfaces still render.
//   2. The two nested `requestAnimationFrame` calls at L13 and L69 become
//      `render()` and `frame()`, which src/render/render-loop.ts drives.
//      The two-phase paint they produced is preserved: a tile that moved
//      is drawn at its previous cell on one frame and moved to its new
//      cell on the next.
//   3. `applyClasses` uses `classList` rather than the wholesale
//      `setAttribute("class", …)` of L93-L95, whose comment at L57 cited
//      js/classlist_polyfill.js. That file is deleted.
//   4. The fill, the numeral colour and the numeral size of each tile are
//      resolved through `resolveTileTheme` of src/theme/themes.ts and
//      `tileFontSize` of src/theme/tokens.ts and published as custom
//      properties, where L58 emitted a value class alone.
//
// Invariants of this module: it consumes no randomness, touches no
// storage, reads no clock, imports no rendering library and holds no
// engine reference. It reads the `state:commit` event, and it retains no
// part of a payload after the event that carried it.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import type { RulesConfig } from '../config/rules-config';
import type {
  EngineEvents,
  EngineEventSubscription,
  StateCommitEvent,
} from '../engine/engine-events';
import type { TileTheme } from '../theme/tile-ramp';
import { tileRampConstants } from '../theme/tile-ramp';
import type { Theme, ThemeId } from '../theme/themes';
import {
  getActiveTheme,
  getTheme,
  resolveTileTheme,
  subscribeToThemeChange,
} from '../theme/themes';
import type { ScaleName } from '../theme/tokens';
import { tileFontSize } from '../theme/tokens';
import type { RenderReporter } from './webgl-support';
import {
  NOOP_RENDER_REPORTER,
  createGuardedRenderReporter,
} from './webgl-support';

/* --------------------------------------------------------------------------
 * 1. How a commit carries the board
 * ----------------------------------------------------------------------- */

/**
 * The board as `state:commit` carries it: the engine's live grid.
 *
 * Read off the payload during the event, exactly as
 * js/html_actuator.js L16-L22 read `grid.cells` off the grid
 * js/game_manager.js L91 handed it. Derived from the event type, so this
 * module names no engine module other than the event contract.
 */
type CommitBoard = StateCommitEvent['board'];

/**
 * One tile as `state:commit` carries it: a live tile of the grid, whose
 * `value`, `previousPosition` and `mergedFrom` js/html_actuator.js read at
 * L58, L54, L67 and L73-L80.
 *
 * The board's cells hold `null` where a cell is empty, which this type
 * excludes.
 */
type CommitTile = NonNullable<CommitBoard['cells'][number][number]>;

/* --------------------------------------------------------------------------
 * 2. Class names, attributes and copy
 * ----------------------------------------------------------------------- */

/** The empty-cell layer. style/main.scss L440-L443 gives it `z-index: 1`. */
const GRID_CONTAINER_CLASS = 'grid-container';

/** One row of the empty-cell layer. style/main.scss L445-L457. */
const GRID_ROW_CLASS = 'grid-row';

/** One cell of the empty-cell layer. style/main.scss L459-L472. */
const GRID_CELL_CLASS = 'grid-cell';

/** The tile layer. style/main.scss L474-L477 gives it `z-index: 2`. */
const TILE_CONTAINER_CLASS = 'tile-container';

/** One tile. Ported from js/html_actuator.js L58. */
const TILE_CLASS = 'tile';

/** The numeral-bearing child of a tile. Ported from L64. */
const TILE_INNER_CLASS = 'tile-inner';

/** Prefix of the per-value class. Ported from L58, `"tile-" + tile.value`. */
const TILE_VALUE_CLASS_PREFIX = 'tile-';

/** Prefix of the position class. Ported from L103. */
const TILE_POSITION_CLASS_PREFIX = 'tile-position-';

/** The class a tile above the ramp carries. Ported from L60. */
const SUPER_TILE_CLASS = 'tile-super';

/** The class a tile produced by a merge carries. Ported from L74. */
const MERGED_TILE_CLASS = 'tile-merged';

/** The class a newly spawned tile carries. Ported from L82. */
const NEW_TILE_CLASS = 'tile-new';

/** The class the score delta carries. Ported from L116. */
const SCORE_ADDITION_CLASS = 'score-addition';

/** The class the terminal overlay carries on a win. Ported from L128. */
const WON_MESSAGE_CLASS = 'game-won';

/** The class the terminal overlay carries on a loss. Ported from L128. */
const OVER_MESSAGE_CLASS = 'game-over';

/** Tag of the overlay child the verdict is written into. From L132. */
const MESSAGE_VERDICT_TAG = 'p';

/** Tag every generated element uses. Ported from L52-L53. */
const ELEMENT_TAG = 'div';

/**
 * Custom property carrying a tile's resolved fill.
 *
 * The value is `TileTheme.colorHex`, which is the fill the `@while` loop of
 * style/main.scss L555-L602 compiles for the same value under the default
 * palette.
 */
const FILL_PROPERTY = '--tile-fill';

/** Custom property carrying a tile's resolved numeral colour. */
const NUMERAL_PROPERTY = '--tile-numeral';

/** Custom property carrying a tile's numeral size above the breakpoint. */
const NUMERAL_SIZE_PROPERTY = '--tile-numeral-size';

/** Custom property carrying a tile's numeral size at the breakpoint. */
const NUMERAL_SIZE_MOBILE_PROPERTY = '--tile-numeral-size-mobile';

/** Custom property carrying the board's edge length in cells. */
const BOARD_SIZE_PROPERTY = '--board-size';

/** Unit appended to a token length written into a custom property. */
const LENGTH_UNIT = 'px';

/**
 * Names the guarded lookups are reported under: the selector index.html
 * declares each surface with.
 */
const ELEMENT_NAMES = Object.freeze({
  /** index.html L64. */
  host: '#board-number-only',

  /** index.html L28. From js/html_actuator.js L3. */
  score: '.score-container',

  /** index.html L29. From js/html_actuator.js L4. */
  best: '.best-container',

  /** index.html L48. From js/html_actuator.js L5. */
  message: '.game-message',

  /** index.html L49. From js/html_actuator.js L132. */
  verdict: '.game-message > p',

  /** The document elements are created in. */
  document: 'document',
});

/** Attribute the three grid roles are written to. */
const ROLE_ATTRIBUTE = 'role';

/** Role of the lattice. */
const GRID_ROLE = 'grid';

/** Role of one row of the lattice. */
const ROW_ROLE = 'row';

/** Role of one cell of the lattice. */
const GRIDCELL_ROLE = 'gridcell';

/** Attribute an accessible name is written to. */
const LABEL_ATTRIBUTE = 'aria-label';

/** Attribute the lattice's row count is written to. */
const ROWCOUNT_ATTRIBUTE = 'aria-rowcount';

/** Attribute the lattice's column count is written to. */
const COLCOUNT_ATTRIBUTE = 'aria-colcount';

/** Attribute a row's one-based index is written to. */
const ROWINDEX_ATTRIBUTE = 'aria-rowindex';

/** Attribute a cell's one-based index is written to. */
const COLINDEX_ATTRIBUTE = 'aria-colindex';

/** Attribute that removes the tile layer from the accessibility tree. */
const ARIA_HIDDEN_ATTRIBUTE = 'aria-hidden';

/** Attribute a cell's tab-stop state is written to. */
const TABINDEX_ATTRIBUTE = 'tabindex';

/** The `true` value of a boolean ARIA attribute. */
const ARIA_TRUE = 'true';

/** Event the roving tab stop follows. */
const FOCUS_EVENT = 'focusin';

/** Attribute carrying a cell's tile value, absent on an empty cell. */
const CELL_VALUE_ATTRIBUTE = 'data-tile-value';

/** Attribute carrying the rendered board's edge length. */
const BOARD_SIZE_ATTRIBUTE = 'data-board-size';

/** Attribute carrying the theme the presentation was resolved under. */
const THEME_ATTRIBUTE_NAME = 'data-rendered-theme';

/** `tabindex` of the one cell that is a tab stop. */
const TAB_STOP = '0';

/** `tabindex` of every other cell. */
const NOT_A_TAB_STOP = '-1';

/**
 * The copy this module writes.
 *
 * Every string is a caller-overridable default. The two verdicts are
 * ported verbatim from js/html_actuator.js L129.
 */
export interface NumberOnlyRendererCopy {
  /** Accessible name of the lattice. */
  readonly boardLabel: string;

  /** Accessible name of one cell holding a tile, given its position. */
  readonly cellLabel: (row: number, column: number, value: number) => string;

  /** Accessible name of one empty cell, given its position. */
  readonly emptyCellLabel: (row: number, column: number) => string;

  /** The verdict on a win. Ported from js/html_actuator.js L129. */
  readonly wonMessage: string;

  /** The verdict on a loss. Ported from js/html_actuator.js L129. */
  readonly overMessage: string;
}

/**
 * The default copy.
 *
 * The lattice name differs from the `aria-label` index.html L65 gives
 * `#board-a11y`.
 */
export const numberOnlyRendererCopy: NumberOnlyRendererCopy = Object.freeze({
  boardLabel: 'Game board, numbers only',

  cellLabel: (row: number, column: number, value: number): string =>
    `Row ${row}, column ${column}, ${value}`,

  emptyCellLabel: (row: number, column: number): string =>
    `Row ${row}, column ${column}, empty`,

  wonMessage: 'You win!',
  overMessage: 'Game over!',
});

/* --------------------------------------------------------------------------
 * 3. Counter and diagnostic names
 * ----------------------------------------------------------------------- */

/** Source field every diagnostic this module raises carries. */
const DIAGNOSTIC_SOURCE = 'render/number-only-renderer';

/** Counter name for one mount. */
const MOUNT_METRIC = 'render.numberOnly.mount';

/** Counter name for one unmount. */
const UNMOUNT_METRIC = 'render.numberOnly.unmount';

/** Counter name for one queued commit. */
const RENDER_METRIC = 'render.numberOnly.render';

/** Counter name for one painted commit. */
const PAINT_METRIC = 'render.numberOnly.paint';

/** Counter name for one built lattice. */
const LATTICE_METRIC = 'render.numberOnly.lattice';

/** Counter name for an absent element the renderer looked up. */
const MISSING_ELEMENT_METRIC = 'render.numberOnly.element.missing';

/** Counter name for a tile value the ramp could not resolve. */
const UNRESOLVED_VALUE_METRIC = 'render.numberOnly.value.unresolved';

/** Counter name for one theme change the renderer repainted for. */
const THEME_CHANGE_METRIC = 'render.numberOnly.theme.change';

/* --------------------------------------------------------------------------
 * 4. What the renderer exposes for the announcer
 * ----------------------------------------------------------------------- */

/**
 * One cell of the rendered board, as plain data.
 *
 * Derived from the live tile during the event that carried it and holding
 * no reference to it, so it stays valid after the engine has mutated the
 * board that produced it.
 */
export interface RenderedCell {
  /** Zero-based column index, the outer index of `cells[x][y]`. */
  readonly x: number;

  /** Zero-based row index, the inner index of `cells[x][y]`. */
  readonly y: number;

  /** Face value, or `null` where the cell is empty. */
  readonly value: number | null;

  /** The cell's accessible name, as written to the DOM. */
  readonly label: string;

  /** Whether the value took `.tile-super`. */
  readonly isSuper: boolean;

  /** Whether the tile was produced by a merge. From L73-L74. */
  readonly isMerged: boolean;

  /** Whether the tile was newly spawned. From L81-L82. */
  readonly isNew: boolean;

  /** Whether the tile moved into this cell. From L67. */
  readonly moved: boolean;

  /** Resolved fill, or `null` where the value is off the ramp. */
  readonly fill: string | null;

  /** Resolved numeral colour, or `null` where the value is off the ramp. */
  readonly numeralColor: string | null;
}

/**
 * Everything one paint put on screen, as plain data.
 *
 * `readRenderedBoard()` returns it so src/ui/a11y/ can announce what is
 * rendered without reading the engine and without this module announcing
 * anything itself.
 */
export interface RenderedBoard {
  /** Edge length in cells. */
  readonly size: number;

  /** Every cell, in row-major order: row 0 left to right, then row 1. */
  readonly cells: readonly RenderedCell[];

  /** The score this paint wrote. */
  readonly score: number;

  /** The delta this paint appended, or `0` where it appended none. */
  readonly scoreDelta: number;

  /** The best score this paint wrote, uncoerced. */
  readonly bestScore: string | number;

  /** Whether the win verdict is shown. */
  readonly won: boolean;

  /** Whether the loss verdict is shown. */
  readonly over: boolean;

  /** Whether play is blocked pending acknowledgement. */
  readonly terminated: boolean;

  /** The verdict written into the overlay, or `null` where none was. */
  readonly verdict: string | null;

  /** The theme the presentation was resolved under. */
  readonly themeId: ThemeId;
}

/* --------------------------------------------------------------------------
 * 5. Contract
 * ----------------------------------------------------------------------- */

/** Construction parameters. Every member is optional. */
export interface NumberOnlyRendererOptions {
  /**
   * Element the board is built inside. index.html L64 declares
   * `#board-number-only` for it, which ships with the `hidden` attribute
   * style/main.scss L210 reads; `mount()` clears that attribute and
   * `unmount()` restores it.
   *
   * Supplying it constructs a mounted renderer. Omitting it defers the
   * mount to `mount(host)`.
   */
  readonly host?: Element | null;

  /**
   * The score outlet. index.html L28 declares `.score-container`. From
   * js/html_actuator.js L3.
   */
  readonly scoreContainer?: Element | null;

  /**
   * The best-score outlet. index.html L29 declares `.best-container`. From
   * js/html_actuator.js L4.
   */
  readonly bestContainer?: Element | null;

  /**
   * The terminal overlay. index.html L48 declares `.game-message`. From
   * js/html_actuator.js L5.
   */
  readonly messageContainer?: Element | null;

  /**
   * The canvas layer, hidden while this renderer owns the board. index.html
   * L63 declares `#board-canvas`. Its prior `hidden` state is restored by
   * `unmount()`. No context is requested from it here.
   */
  readonly canvas?: Element | null;

  /** Document elements are created in. Defaults to the ambient `document`. */
  readonly ownerDocument?: Document;

  /**
   * The rules the board is built from. `boardSize` seeds the lattice
   * before the first commit and `winValue` is the fallback super
   * threshold; both are read afresh at each use, which is how
   * `RulesConfig` requires its members to be read.
   */
  readonly config?: RulesConfig;

  /**
   * Fallback value above which a tile takes `.tile-super`, used only where
   * the ramp cannot resolve the value. The resolved `TileTheme.isSuper` is
   * the authority otherwise. Defaults to `config.winValue` where a
   * configuration was supplied, and to `tileRampConstants.superThreshold`
   * otherwise, which is the value js/html_actuator.js L60 compared
   * against.
   */
  readonly superThreshold?: number;

  /**
   * Theme the presentation is resolved under. Defaults to the theme in
   * force, and a theme change repaints unless this pins one.
   */
  readonly theme?: Theme | ThemeId;

  /** Copy overrides. Absent members take `numberOnlyRendererCopy`. */
  readonly copy?: Partial<NumberOnlyRendererCopy>;

  /** Sink for counters and diagnostics. Defaults to `NOOP_RENDER_REPORTER`. */
  readonly reporter?: RenderReporter;

  /**
   * Called whenever work has been queued, so the caller can schedule a
   * frame. Absent, the caller drives `frame()` on its own schedule.
   */
  readonly onWork?: () => void;
}

/**
 * The renderer.
 *
 * Frozen: the members below are its whole surface. `subscribe`, `mount`,
 * `unmount` and `dispose` are the four members every renderer under
 * src/render/ exposes.
 */
export interface NumberOnlyRenderer {
  /** Whether a host is mounted and the renderer will paint. */
  readonly mounted: boolean;

  /**
   * Mounts a host and builds the lattice.
   *
   * Performs the four lookups js/html_actuator.js L2-L5 performed in its
   * constructor, each guarded, and clears the host's `hidden` attribute.
   * Mounting while already mounted unmounts the previous host first, so
   * the call is repeatable.
   *
   * @param host Element to build into. Omitted, the host supplied at
   *   construction is used.
   * @returns `true` when a host was mounted.
   */
  mount(host?: Element | null): boolean;

  /**
   * Removes everything this renderer put in the document and every
   * listener it bound, and restores the `hidden` state of the host and of
   * the canvas layer.
   *
   * Leaves the score, the best score and the overlay as they stand, and
   * leaves any engine subscription in place. Unmounting while not mounted
   * does nothing.
   */
  unmount(): void;

  /**
   * Subscribes to an engine's `state:commit` event.
   *
   * @param events Emitter to subscribe to.
   * @returns A handle that removes this subscription.
   */
  subscribe(events: EngineEvents): EngineEventSubscription;

  /**
   * Queues a commit for the next frame.
   *
   * A commit queued while another is queued replaces it, so only the
   * latest state is painted — the behaviour the single
   * `requestAnimationFrame` of js/html_actuator.js L13 produced. The
   * payload is consumed here and no part of it is retained.
   *
   * @param commit The state commit to paint.
   */
  render(commit: StateCommitEvent): void;

  /**
   * Runs one frame of queued work.
   *
   * @returns `true` while work remains, which src/render/render-loop.ts
   *   reads as outstanding work.
   */
  frame(): boolean;

  /**
   * Clears the terminal overlay.
   *
   * Ported from js/html_actuator.js L39-L41, which js/game_manager.js
   * called on restart (L19) and on keep-playing (L26). A commit carrying
   * `terminated` as `false` clears it too.
   */
  continueGame(): void;

  /**
   * Everything the last paint put on screen, as plain data, or `null`
   * before the first paint.
   *
   * @returns A frozen snapshot, safe to read after the engine has moved on.
   */
  readRenderedBoard(): RenderedBoard | null;

  /**
   * Unmounts, drops the queued work, and releases every subscription this
   * renderer holds. Idempotent.
   */
  dispose(): void;

  /** `dispose()` under the name the composition root calls it by. */
  destroy(): void;
}

/* --------------------------------------------------------------------------
 * 6. The paint plan
 * ----------------------------------------------------------------------- */

/**
 * One tile as the plan holds it: plain data read off a live tile during the
 * event that carried it.
 *
 * js/html_actuator.js L13 closed over the grid and read it on the next
 * frame. The plan is read synchronously instead, so nothing reachable
 * through a payload is dereferenced after the emission that delivered it.
 */
interface PlannedTile {
  /** Face value. From js/html_actuator.js L58 and L65. */
  readonly value: number;

  /** Destination column. From L70. */
  readonly x: number;

  /** Destination row. From L70. */
  readonly y: number;

  /** Cell the tile is first drawn in, or `null`. From L54 and L67. */
  readonly from: { readonly x: number; readonly y: number } | null;

  /** The pair this tile merged from, empty otherwise. From L73-L80. */
  readonly merged: readonly PlannedTile[];
}

/** One commit reduced to the data one paint needs. */
interface PaintPlan {
  /** Edge length in cells. */
  readonly size: number;

  /** Every tile to draw, in the order L16-L22 walked the cells. */
  readonly tiles: readonly PlannedTile[];

  /** The value of each cell in row-major order, `null` where empty. */
  readonly values: readonly (number | null)[];

  /** Score to write. From L24. */
  readonly score: number;

  /** Best score to write, uncoerced. From L25. */
  readonly bestScore: string | number;

  /** Whether the game is lost. From L28. */
  readonly over: boolean;

  /** Whether the win value has been reached. From L30. */
  readonly won: boolean;

  /** Whether play is blocked pending acknowledgement. From L27. */
  readonly terminated: boolean;
}

/**
 * Every state the `hidden` property carries.
 *
 * Read from the property rather than declared as `boolean`: the property
 * carries the attribute's non-boolean state alongside the two boolean
 * ones.
 */
type HiddenState = HTMLElement['hidden'];

/** A tile element painted by the last paint, and the value it carries. */
interface PaintedTile {
  /** The `.tile` element. */
  readonly element: HTMLElement;

  /** Face value the element was painted for. */
  readonly value: number;
}

/** A tile value's resolved presentation. */
interface TilePresentation {
  /** Whether the value takes `.tile-super`. */
  readonly isSuper: boolean;

  /** Resolved fill, or `null` where the value is off the ramp. */
  readonly fill: string | null;

  /** Resolved numeral colour, or `null` where the value is off the ramp. */
  readonly numeralColor: string | null;

  /** Numeral size above the breakpoint, or `null` where unresolved. */
  readonly fontSize: number | null;

  /** Numeral size at the breakpoint, or `null` where unresolved. */
  readonly fontSizeMobile: number | null;
}

/* --------------------------------------------------------------------------
 * 7. Helpers
 * ----------------------------------------------------------------------- */

/**
 * Reads the ambient `document`.
 *
 * @returns The document, or `null` where no document exists.
 */
function readAmbientDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

/**
 * Narrows an element to one carrying `hidden` and `style`, without
 * assuming the constructor is defined.
 *
 * @param element Element to narrow.
 * @returns The element as an `HTMLElement`, or `null`.
 */
function asHtmlElement(
  element: Element | null | undefined,
): HTMLElement | null {
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
 * Ported from js/html_actuator.js L97-L104: the coordinates are one-based
 * in the class name, which is the range the nested `@for` loops of
 * style/main.scss L489-L497 generate.
 *
 * @param x Zero-based column index.
 * @param y Zero-based row index.
 * @returns The class name, such as `tile-position-1-1`.
 */
function positionClass(x: number, y: number): string {
  return `${TILE_POSITION_CLASS_PREFIX}${x + 1}-${y + 1}`;
}

/**
 * Replaces one class with another.
 *
 * js/html_actuator.js L93-L95 rewrote the whole class attribute; its
 * comment at L57 cited `classList` misbehaviour on the engines
 * js/classlist_polyfill.js shimmed. That file is deleted, so the tokens
 * are edited individually here. The token is added where it was not
 * present, so no stale position class survives either way.
 *
 * @param element Element to edit.
 * @param from Class to remove.
 * @param to Class to add.
 */
function replaceClass(element: Element, from: string, to: string): void {
  if (from === to) {
    return;
  }

  if (!element.classList.replace(from, to)) {
    element.classList.add(to);
  }
}

/**
 * Reads one cell of a board without assuming the matrix matches its size.
 *
 * The matrix is indexed `cells[x][y]` with the column outermost, which is
 * the order js/grid.js L58-L64 walked it in.
 *
 * @param board Board to read.
 * @param x Zero-based column index.
 * @param y Zero-based row index.
 * @returns The tile, or `null` where the cell is empty or out of bounds.
 */
function readCell(board: CommitBoard, x: number, y: number): CommitTile | null {
  const column = board.cells.at(x);

  if (column === undefined) {
    return null;
  }

  return column.at(y) ?? null;
}

/**
 * Reduces one live tile, and the pair it merged from, to plain data.
 *
 * @param tile Tile to read.
 * @returns The planned tile.
 */
function planTile(tile: CommitTile): PlannedTile {
  const previous = tile.previousPosition;

  return {
    value: tile.value,
    x: tile.x,
    y: tile.y,
    from: previous === null ? null : { x: previous.x, y: previous.y },

    // L73-L80: the two source tiles are drawn beneath the merged one, and
    // each is drawn by the same path, so the pair is planned the same way.
    merged:
      previous === null && tile.mergedFrom !== null
        ? tile.mergedFrom.map(planTile)
        : [],
  };
}

/**
 * Reduces one commit to the data one paint needs.
 *
 * Every value is read here, inside the emission that delivered the
 * payload. `state:commit` carries the live board, so no member of the
 * result holds a reference into it.
 *
 * @param commit Commit to read.
 * @returns The plan, frozen.
 */
function planCommit(commit: StateCommitEvent): PaintPlan {
  const board = commit.board;
  const size = board.size;
  const tiles: PlannedTile[] = [];
  const values: (number | null)[] = [];

  // L16-L22 walked the columns outermost and drew every cell that held a
  // tile.
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) {
      const tile = readCell(board, x, y);

      if (tile !== null) {
        tiles.push(planTile(tile));
      }
    }
  }

  // Row-major, which is the order the lattice's cells are built in.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const tile = readCell(board, x, y);

      values.push(tile === null ? null : tile.value);
    }
  }

  return Object.freeze({
    size,
    tiles: Object.freeze(tiles),
    values: Object.freeze(values),
    score: commit.score,
    bestScore: commit.bestScore,
    over: commit.over,
    won: commit.won,
    terminated: commit.terminated,
  });
}

/**
 * Numeral size for a tile value at one scale, in px.
 *
 * `tileFontSize` of src/theme/tokens.ts carries the thresholds
 * style/main.scss states at L585-L598 for the ramp and at L609-L612 above
 * it, so the steps are read from the token layer rather than restated.
 *
 * @param value Face value.
 * @param scale Scale to read.
 * @returns The size in px.
 * @throws RangeError when `value` is not a finite positive number.
 */
function readNumeralSize(value: number, scale: ScaleName): number {
  return tileFontSize(value, scale);
}

/**
 * Writes a custom property, or removes it where the value is absent.
 *
 * @param element Element to write to.
 * @param name Property name.
 * @param value Value to write, or `null` to remove the property.
 */
function writeProperty(
  element: HTMLElement,
  name: string,
  value: string | null,
): void {
  if (value === null) {
    element.style.removeProperty(name);

    return;
  }

  element.style.setProperty(name, value);
}

/**
 * Completes a partial copy set with the defaults.
 *
 * @param overrides Members the caller supplies. Any subset is accepted.
 * @returns A frozen copy set carrying every member.
 */
function mergeCopy(
  overrides: Partial<NumberOnlyRendererCopy> | undefined,
): NumberOnlyRendererCopy {
  if (overrides === undefined) {
    return numberOnlyRendererCopy;
  }

  return Object.freeze({
    boardLabel: overrides.boardLabel ?? numberOnlyRendererCopy.boardLabel,
    cellLabel: overrides.cellLabel ?? numberOnlyRendererCopy.cellLabel,
    emptyCellLabel:
      overrides.emptyCellLabel ?? numberOnlyRendererCopy.emptyCellLabel,
    wonMessage: overrides.wonMessage ?? numberOnlyRendererCopy.wonMessage,
    overMessage: overrides.overMessage ?? numberOnlyRendererCopy.overMessage,
  });
}

/**
 * Reduces a caught value to a name and a message.
 *
 * @param error Caught value.
 * @returns The pair a diagnostic carries.
 */
function describeError(error: unknown): {
  readonly name: string;
  readonly message: string;
} {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }

  return { name: 'RenderError', message: String(error) };
}

/* --------------------------------------------------------------------------
 * 8. Construction
 * ----------------------------------------------------------------------- */

/**
 * Creates a number-only renderer.
 *
 * Supplying `host` mounts immediately; omitting it defers the mount to
 * `mount(host)`. Nothing here requests a rendering context, so the
 * renderer is constructible and paints where no WebGL context can be
 * obtained at all.
 *
 * @param options Mount points, configuration, theme, copy, reporter and
 *   work callback. Every member is optional.
 * @returns A frozen renderer. One constructed with no host reports the
 *   absence, paints nothing, and every member stays safe to call.
 *
 * @example
 * ```ts
 * const renderer = createNumberOnlyRenderer({
 *   host: document.querySelector('#board-number-only'),
 *   scoreContainer: document.querySelector('.score-container'),
 *   bestContainer: document.querySelector('.best-container'),
 *   messageContainer: document.querySelector('.game-message'),
 *   config,
 *   onWork: () => loop.invalidate(),
 * });
 *
 * renderer.subscribe(engine.events);
 * loop.addFrameCallback(() => renderer.frame());
 * ```
 */
export function createNumberOnlyRenderer(
  options: NumberOnlyRendererOptions = {},
): NumberOnlyRenderer {
  const reporter = createGuardedRenderReporter(
    options.reporter ?? NOOP_RENDER_REPORTER,
  );
  const owner = options.ownerDocument ?? readAmbientDocument();
  const copy = mergeCopy(options.copy);
  const scoreContainer = options.scoreContainer ?? null;
  const bestContainer = options.bestContainer ?? null;
  const messageContainer = options.messageContainer ?? null;

  /** Names already reported absent, so each is reported once. */
  const reportedAbsent = new Set<string>();

  /** Tile values already reported unresolvable, so each is reported once. */
  const reportedValues = new Set<number>();

  /**
   * Reports one absent element, once.
   *
   * The four lookups js/html_actuator.js L2-L5 performed were unchecked
   * and their results were dereferenced at L44, L90, L107, L124, L131,
   * L132, L137 and L138, so a renamed class was a startup failure.
   *
   * @param name Element that is absent.
   * @param fatal Whether the board cannot be drawn without it.
   */
  const reportAbsent = (name: string, fatal: boolean): void => {
    if (reportedAbsent.has(name)) {
      return;
    }

    reportedAbsent.add(name);

    reporter.onCount({
      name: MISSING_ELEMENT_METRIC,
      value: 1,
      detail: Object.freeze({ element: name, fatal }),
    });

    reporter.onDiagnostic({
      level: fatal ? 'error' : 'warning',
      source: DIAGNOSTIC_SOURCE,
      message: `The \`${name}\` element is absent.`,
      detail: Object.freeze({ element: name, fatal }),
    });
  };

  /**
   * The theme pinned at construction, or `null` to follow the theme in
   * force.
   */
  const pinnedTheme = ((): Theme | null => {
    const requested = options.theme;

    if (requested === undefined) {
      return null;
    }

    if (typeof requested !== 'string') {
      return requested;
    }

    try {
      return getTheme(requested);
    } catch (error: unknown) {
      reporter.onDiagnostic({
        level: 'warning',
        source: DIAGNOSTIC_SOURCE,
        message: 'The requested theme is unknown; the active theme is used.',
        detail: Object.freeze({ theme: requested }),
        error: describeError(error),
      });

      return null;
    }
  })();

  /**
   * The theme presentation is resolved under.
   *
   * @returns The pinned theme, or the theme in force.
   */
  const readTheme = (): Theme => pinnedTheme ?? getActiveTheme();

  /**
   * The value above which a tile takes `.tile-super` where the ramp cannot
   * resolve it.
   *
   * `RulesConfig` requires its members be read afresh at each use, so
   * `winValue` is read here and not captured.
   *
   * @returns The threshold.
   */
  const readSuperThreshold = (): number =>
    options.superThreshold ??
    options.config?.winValue ??
    tileRampConstants.superThreshold;

  /**
   * The edge length the lattice is built at before the first commit.
   *
   * @returns The configured board size, or `0` where none is configured.
   */
  const readConfiguredSize = (): number => options.config?.boardSize ?? 0;

  /* ---- Mounted state ---- */

  /** The mounted host, or `null`. */
  let host: Element | null = null;

  /** The mounted host as an `HTMLElement`, where it is one. */
  let hostElement: HTMLElement | null = null;

  /**
   * The host's `hidden` state before this renderer mounted it.
   *
   * Typed from the property, which carries the attribute's `until-found`
   * value alongside the two boolean states, so a host that shipped in that
   * state is restored to it.
   */
  let hostWasHidden: HiddenState = false;

  /** The canvas layer's `hidden` state before this renderer mounted. */
  let canvasWasHidden: HiddenState = false;

  /** The empty-cell layer, once built. */
  let gridLayer: HTMLElement | null = null;

  /** The tile layer, once built. */
  let tileLayer: HTMLElement | null = null;

  /** Every cell of the lattice, in row-major order. */
  let cellElements: HTMLElement[] = [];

  /** Edge length the lattice was last built at. */
  let latticeSize = 0;

  /** Index into `cellElements` of the one cell that is a tab stop. */
  let activeCellIndex = 0;

  /* ---- Paint state ---- */

  /** The score the last paint wrote. Ported from js/html_actuator.js L7. */
  let shownScore = 0;

  /** The plan awaiting a paint, or `null`. */
  let queued: PaintPlan | null = null;

  /** Position rewrites the next frame applies. From L67-L72. */
  let deferred: (() => void)[] = [];

  /** The tiles the last paint drew. */
  let paintedTiles: PaintedTile[] = [];

  /** What the last paint put on screen, or `null` before the first. */
  let rendered: RenderedBoard | null = null;

  /** Engine subscriptions this renderer holds. */
  let subscriptions: EngineEventSubscription[] = [];

  /** Whether `dispose()` has run. */
  let disposed = false;

  /* ---- Presentation ---- */

  /**
   * Resolves one tile value's fill, numeral colour, numeral sizes and super
   * band.
   *
   * `resolveTileTheme` rejects a value that is not a power of the ramp's
   * base, which a rule producing an off-ramp value can yield. The call is
   * guarded: the value is reported once, the tile is drawn with no
   * resolved presentation and takes the stylesheet's own defaults, and the
   * super band falls back to the configured threshold, which is the
   * comparison js/html_actuator.js L60 made.
   *
   * @param value Face value to resolve.
   * @param theme Theme to resolve under.
   * @returns The resolved presentation.
   */
  const resolvePresentation = (
    value: number,
    theme: Theme,
  ): TilePresentation => {
    let resolved: TileTheme | null = null;
    let desktopSize: number | null = null;
    let mobileSize: number | null = null;

    try {
      resolved = resolveTileTheme(value, theme);

      // style/main.scss L585-L598 steps the numeral down as the value
      // gains digits, and L609-L612 steps it again above the ramp.
      // `tileFontSize` carries those thresholds.
      desktopSize = readNumeralSize(value, 'desktop');
      mobileSize = readNumeralSize(value, 'mobile');
    } catch (error: unknown) {
      if (!reportedValues.has(value)) {
        reportedValues.add(value);

        reporter.onCount({
          name: UNRESOLVED_VALUE_METRIC,
          value: 1,
          detail: Object.freeze({ tileValue: value, theme: theme.id }),
        });

        reporter.onDiagnostic({
          level: 'warning',
          source: DIAGNOSTIC_SOURCE,
          message:
            'A tile value is off the ramp; it is drawn without a resolved ' +
            'presentation.',
          detail: Object.freeze({ tileValue: value, theme: theme.id }),
          error: describeError(error),
        });
      }
    }

    if (resolved === null) {
      return {
        isSuper: value > readSuperThreshold(),
        fill: null,
        numeralColor: null,
        fontSize: null,
        fontSizeMobile: null,
      };
    }

    return {
      // The ramp is the authority: `isSuper` holds where the value is
      // STRICTLY above `tileRampConstants.superThreshold`, which is the
      // comparison js/html_actuator.js L60 made.
      isSuper: resolved.isSuper,
      fill: resolved.colorHex,
      numeralColor: resolved.numeralColor,
      fontSize: desktopSize,
      fontSizeMobile: mobileSize,
    };
  };

  /**
   * Writes a resolved presentation onto a tile as custom properties.
   *
   * Writes custom properties only. No CSS declaration is written here.
   *
   * @param element The `.tile` element.
   * @param presentation Presentation to write.
   */
  const applyPresentation = (
    element: HTMLElement,
    presentation: TilePresentation,
  ): void => {
    writeProperty(element, FILL_PROPERTY, presentation.fill);
    writeProperty(element, NUMERAL_PROPERTY, presentation.numeralColor);
    writeProperty(
      element,
      NUMERAL_SIZE_PROPERTY,
      presentation.fontSize === null
        ? null
        : `${presentation.fontSize}${LENGTH_UNIT}`,
    );
    writeProperty(
      element,
      NUMERAL_SIZE_MOBILE_PROPERTY,
      presentation.fontSizeMobile === null
        ? null
        : `${presentation.fontSizeMobile}${LENGTH_UNIT}`,
    );

    if (presentation.isSuper) {
      element.classList.add(SUPER_TILE_CLASS);
    } else {
      element.classList.remove(SUPER_TILE_CLASS);
    }
  };

  /* ---- The roving tab stop ---- */

  /**
   * Marks one cell as the lattice's tab stop and every other cell as not
   * one, so the board is a single stop in the tab order.
   */
  const applyRovingTabStop = (): void => {
    for (let index = 0; index < cellElements.length; index += 1) {
      const cell = cellElements.at(index);

      if (cell === undefined) {
        continue;
      }

      cell.setAttribute(
        TABINDEX_ATTRIBUTE,
        index === activeCellIndex ? TAB_STOP : NOT_A_TAB_STOP,
      );
    }
  };

  /**
   * Moves the tab stop to the cell that has taken focus.
   *
   * @param event The focus event, whose target is compared by identity
   *   against the lattice's cells.
   */
  const onFocusIn = (event: Event): void => {
    const target = event.target;

    if (target === null) {
      return;
    }

    const index = cellElements.findIndex((cell) => cell === target);

    if (index < 0 || index === activeCellIndex) {
      return;
    }

    activeCellIndex = index;
    applyRovingTabStop();
  };

  /** Binds the focus listener to the lattice. */
  const attachFocusListener = (): void => {
    gridLayer?.addEventListener(FOCUS_EVENT, onFocusIn);
  };

  /** Removes the focus listener from the lattice. */
  const detachFocusListener = (): void => {
    gridLayer?.removeEventListener(FOCUS_EVENT, onFocusIn);
  };

  /* ---- The lattice ---- */

  /**
   * Builds the empty-cell layer and the tile layer for a board of `size`
   * cells to a side.
   *
   * Rebuilt only where the size changed, so a move relabels the cells it
   * already built and the focused cell keeps its focus. index.html L43-L72
   * declared this structure statically for one size; style/main.scss
   * L419-L478 records this module as its producer.
   *
   * The lattice carries the grid semantics and the tile layer carries
   * `aria-hidden`, so each cell's position and value reach assistive
   * technology once.
   *
   * @param size Edge length in cells.
   */
  const buildLayers = (size: number): void => {
    if (host === null || owner === null || size <= 0) {
      return;
    }

    if (gridLayer !== null && tileLayer !== null && latticeSize === size) {
      return;
    }

    detachFocusListener();
    clearElement(host);

    host.setAttribute(BOARD_SIZE_ATTRIBUTE, String(size));

    if (hostElement !== null) {
      writeProperty(hostElement, BOARD_SIZE_PROPERTY, String(size));
    }

    const grid = owner.createElement(ELEMENT_TAG);

    grid.classList.add(GRID_CONTAINER_CLASS);
    grid.setAttribute(ROLE_ATTRIBUTE, GRID_ROLE);
    grid.setAttribute(LABEL_ATTRIBUTE, copy.boardLabel);
    grid.setAttribute(ROWCOUNT_ATTRIBUTE, String(size));
    grid.setAttribute(COLCOUNT_ATTRIBUTE, String(size));

    const cells: HTMLElement[] = [];

    for (let y = 0; y < size; y += 1) {
      const row = owner.createElement(ELEMENT_TAG);

      row.classList.add(GRID_ROW_CLASS);
      row.setAttribute(ROLE_ATTRIBUTE, ROW_ROLE);
      row.setAttribute(ROWINDEX_ATTRIBUTE, String(y + 1));

      for (let x = 0; x < size; x += 1) {
        const cell = owner.createElement(ELEMENT_TAG);

        cell.classList.add(GRID_CELL_CLASS);
        cell.setAttribute(ROLE_ATTRIBUTE, GRIDCELL_ROLE);
        cell.setAttribute(COLINDEX_ATTRIBUTE, String(x + 1));
        cell.setAttribute(LABEL_ATTRIBUTE, copy.emptyCellLabel(y + 1, x + 1));

        row.appendChild(cell);
        cells.push(cell);
      }

      grid.appendChild(row);
    }

    const tiles = owner.createElement(ELEMENT_TAG);

    tiles.classList.add(TILE_CONTAINER_CLASS);
    tiles.setAttribute(ARIA_HIDDEN_ATTRIBUTE, ARIA_TRUE);

    host.appendChild(grid);
    host.appendChild(tiles);

    gridLayer = grid;
    tileLayer = tiles;
    cellElements = cells;
    latticeSize = size;
    activeCellIndex = 0;
    paintedTiles = [];

    applyRovingTabStop();
    attachFocusListener();

    reporter.onCount({
      name: LATTICE_METRIC,
      value: 1,
      detail: Object.freeze({ size, cells: cells.length }),
    });
  };

  /* ---- Tiles ---- */

  /**
   * Draws one tile, and the pair it merged from.
   *
   * Ported from js/html_actuator.js L49-L91, including the recursion at
   * L78-L80 that draws both source tiles of a merge beneath the merged one,
   * and the deferred position rewrite at L67-L72 that lets the movement
   * transition run.
   *
   * @param planned Tile to draw.
   * @param theme Theme the presentation is resolved under.
   */
  const addTile = (planned: PlannedTile, theme: Theme): void => {
    if (owner === null || tileLayer === null) {
      return;
    }

    const wrapper = owner.createElement(ELEMENT_TAG);
    const inner = owner.createElement(ELEMENT_TAG);
    const from = planned.from;

    // L54: a tile that moved is drawn in the cell it came from.
    const drawnAt = from ?? { x: planned.x, y: planned.y };
    const drawnClass = positionClass(drawnAt.x, drawnAt.y);

    // L58: the tile, its value and its position.
    wrapper.classList.add(
      TILE_CLASS,
      `${TILE_VALUE_CLASS_PREFIX}${planned.value}`,
      drawnClass,
    );

    applyPresentation(wrapper, resolvePresentation(planned.value, theme));

    // L64-L65.
    inner.classList.add(TILE_INNER_CLASS);
    inner.textContent = String(planned.value);

    if (from !== null) {
      // L67-L72: the tile is in the document at its previous cell now, and
      // moves on the next frame.
      const movedClass = positionClass(planned.x, planned.y);

      deferred.push((): void => {
        replaceClass(wrapper, drawnClass, movedClass);
      });
    } else if (planned.merged.length > 0) {
      // L73-L80.
      wrapper.classList.add(MERGED_TILE_CLASS);

      for (const source of planned.merged) {
        addTile(source, theme);
      }
    } else {
      // L81-L83.
      wrapper.classList.add(NEW_TILE_CLASS);
    }

    // L86-L90.
    wrapper.appendChild(inner);
    tileLayer.appendChild(wrapper);

    paintedTiles.push({ element: wrapper, value: planned.value });
  };

  /* ---- The score surfaces ---- */

  /**
   * Writes the score and, where it rose, the delta.
   *
   * Ported from js/html_actuator.js L106-L121: the delta is the difference
   * against the score the previous paint wrote, which is held from L7 and
   * replaced at L110, and the `.score-addition` element carrying it is
   * appended after the score text is written, which is the order L112 and
   * L119 used. style/main.scss gives that element the `move-up` animation,
   * so it removes itself from view without this module timing anything.
   *
   * The held score is replaced whether or not the outlet is present, so an
   * absent outlet cannot make a later delta wrong.
   *
   * @param score Score to write.
   * @returns The delta, which is `0` or negative where none was appended.
   */
  const updateScore = (score: number): number => {
    // L109-L110.
    const difference = score - shownScore;

    shownScore = score;

    if (scoreContainer === null || owner === null) {
      return difference;
    }

    // L107, then L112. The clear is what that file did before writing.
    clearElement(scoreContainer);
    scoreContainer.textContent = String(score);

    if (difference > 0) {
      // L114-L120.
      const addition = owner.createElement(ELEMENT_TAG);

      addition.classList.add(SCORE_ADDITION_CLASS);
      addition.textContent = `+${difference}`;
      scoreContainer.appendChild(addition);
    }

    return difference;
  };

  /**
   * Writes the best score.
   *
   * Ported from js/html_actuator.js L123-L125. The value arrives exactly as
   * the storage layer returned it — the raw stored STRING where one is
   * stored and the number `0` where none is — and is written as text, which
   * is the assignment L124 made. `String` is the conversion that assignment
   * performed itself, so a stored string is written unchanged.
   *
   * @param bestScore Best score to write.
   */
  const updateBestScore = (bestScore: string | number): void => {
    if (bestContainer === null) {
      return;
    }

    bestContainer.textContent = String(bestScore);
  };

  /* ---- The terminal overlay ---- */

  /**
   * Shows the terminal overlay and writes the verdict into it.
   *
   * Ported from js/html_actuator.js L127-L133. L132 indexed
   * `getElementsByTagName("p")` without checking the result; the lookup is
   * guarded here and its absence reported once.
   *
   * @param won Whether the verdict is a win.
   * @returns The verdict written, or `null` where no overlay is present.
   */
  const showMessage = (won: boolean): string | null => {
    if (messageContainer === null) {
      return null;
    }

    // L128.
    messageContainer.classList.add(
      won ? WON_MESSAGE_CLASS : OVER_MESSAGE_CLASS,
    );

    // L129.
    const verdict = won ? copy.wonMessage : copy.overMessage;
    const paragraph = messageContainer
      .getElementsByTagName(MESSAGE_VERDICT_TAG)
      .item(0);

    if (paragraph === null) {
      reportAbsent(ELEMENT_NAMES.verdict, false);

      return verdict;
    }

    // L132.
    paragraph.textContent = verdict;

    return verdict;
  };

  /**
   * Hides the terminal overlay.
   *
   * Ported from js/html_actuator.js L135-L139. L136 recorded that one value
   * is removed at a time, and the two removals are kept in that form.
   */
  const clearMessage = (): void => {
    if (messageContainer === null) {
      return;
    }

    messageContainer.classList.remove(WON_MESSAGE_CLASS);
    messageContainer.classList.remove(OVER_MESSAGE_CLASS);
  };

  /* ---- One paint ---- */

  /**
   * Relabels every cell of the lattice and describes what each now holds.
   *
   * @param plan Plan being painted.
   * @param theme Theme the presentation is resolved under.
   * @returns One descriptor per cell, in row-major order.
   */
  const paintCells = (plan: PaintPlan, theme: Theme): RenderedCell[] => {
    const size = plan.size;
    const occupants = new Map<number, PlannedTile>();

    for (const planned of plan.tiles) {
      occupants.set(planned.y * size + planned.x, planned);
    }

    const cells: RenderedCell[] = [];

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const index = y * size + x;
        const value = plan.values.at(index) ?? null;
        const label =
          value === null
            ? copy.emptyCellLabel(y + 1, x + 1)
            : copy.cellLabel(y + 1, x + 1, value);
        const element = cellElements.at(index);

        if (element !== undefined) {
          element.setAttribute(LABEL_ATTRIBUTE, label);

          if (value === null) {
            element.removeAttribute(CELL_VALUE_ATTRIBUTE);
          } else {
            element.setAttribute(CELL_VALUE_ATTRIBUTE, String(value));
          }
        }

        const occupant = occupants.get(index);
        const moved = occupant !== undefined && occupant.from !== null;
        const isMerged = occupant !== undefined && occupant.merged.length > 0;
        const presentation =
          value === null ? null : resolvePresentation(value, theme);

        cells.push(
          Object.freeze({
            x,
            y,
            value,
            label,
            isSuper: presentation === null ? false : presentation.isSuper,
            isMerged,
            isNew: occupant !== undefined && !moved && !isMerged,
            moved,
            fill: presentation === null ? null : presentation.fill,
            numeralColor:
              presentation === null ? null : presentation.numeralColor,
          }),
        );
      }
    }

    return cells;
  };

  /**
   * Paints one plan.
   *
   * Ported from the body of js/html_actuator.js L13-L35: the tile layer is
   * emptied, every tile is drawn, the two score surfaces are written, and
   * the overlay is resolved.
   *
   * @param plan Plan to paint.
   */
  const paint = (plan: PaintPlan): void => {
    if (host === null || owner === null) {
      return;
    }

    buildLayers(plan.size);

    const layer = tileLayer;

    if (layer === null) {
      return;
    }

    const theme = readTheme();

    // L14.
    clearElement(layer);
    paintedTiles = [];

    // L16-L22.
    for (const planned of plan.tiles) {
      addTile(planned, theme);
    }

    const cells = paintCells(plan, theme);

    // L24-L25.
    const scoreDelta = updateScore(plan.score);

    updateBestScore(plan.bestScore);

    let verdict: string | null = null;

    // L27-L33.
    if (plan.terminated) {
      if (plan.over) {
        verdict = showMessage(false);
      } else if (plan.won) {
        verdict = showMessage(true);
      }
    } else {
      // js/html_actuator.js L39-L41, which js/game_manager.js called on
      // restart (L19) and on keep-playing (L26). Both reach this module as
      // a commit carrying `terminated` as `false`.
      clearMessage();
    }

    host.setAttribute(THEME_ATTRIBUTE_NAME, theme.id);

    rendered = Object.freeze({
      size: plan.size,
      cells: Object.freeze(cells),
      score: plan.score,
      scoreDelta,
      bestScore: plan.bestScore,
      won: plan.won,
      over: plan.over,
      terminated: plan.terminated,
      verdict,
      themeId: theme.id,
    });

    reporter.onCount({
      name: PAINT_METRIC,
      value: 1,
      detail: Object.freeze({
        size: plan.size,
        tiles: paintedTiles.length,
        deferred: deferred.length,
      }),
    });
  };

  /**
   * Re-resolves every drawn tile against a theme, without rebuilding the
   * DOM, so a theme change keeps the movement and merge animations running.
   *
   * @param theme Theme now in force.
   */
  const repaintTheme = (theme: Theme): void => {
    for (const painted of paintedTiles) {
      applyPresentation(
        painted.element,
        resolvePresentation(painted.value, theme),
      );
    }

    if (host !== null) {
      host.setAttribute(THEME_ATTRIBUTE_NAME, theme.id);
    }

    const previous = rendered;

    if (previous === null) {
      return;
    }

    rendered = Object.freeze({
      ...previous,
      cells: Object.freeze(
        previous.cells.map((cell): RenderedCell => {
          if (cell.value === null) {
            return cell;
          }

          const presentation = resolvePresentation(cell.value, theme);

          return Object.freeze({
            ...cell,
            isSuper: presentation.isSuper,
            fill: presentation.fill,
            numeralColor: presentation.numeralColor,
          });
        }),
      ),
      themeId: theme.id,
    });
  };

  /** Released by `dispose()`; `null` where no theme change is followed. */
  const releaseTheme: (() => void) | null =
    pinnedTheme === null
      ? subscribeToThemeChange((theme: Theme): void => {
          reporter.onCount({
            name: THEME_CHANGE_METRIC,
            value: 1,
            detail: Object.freeze({ theme: theme.id }),
          });

          repaintTheme(theme);
        })
      : null;

  /* ---- Mounting ---- */

  /**
   * Reports the absence of each optional surface, once.
   *
   * The three outlets are looked up by the caller and handed in, which is
   * what js/html_actuator.js L3-L5 looked up for itself. An absent outlet
   * is reported and skipped; L107, L124, L131 and L137 dereferenced theirs
   * unchecked.
   */
  const reportAbsentSurfaces = (): void => {
    if (scoreContainer === null) {
      reportAbsent(ELEMENT_NAMES.score, false);
    }

    if (bestContainer === null) {
      reportAbsent(ELEMENT_NAMES.best, false);
    }

    if (messageContainer === null) {
      reportAbsent(ELEMENT_NAMES.message, false);
    }
  };

  /**
   * Removes everything this renderer put in the document, and restores the
   * two `hidden` states it changed.
   */
  const unmount = (): void => {
    const mountedHost = host;

    if (mountedHost === null) {
      return;
    }

    detachFocusListener();
    clearElement(mountedHost);
    mountedHost.removeAttribute(BOARD_SIZE_ATTRIBUTE);
    mountedHost.removeAttribute(THEME_ATTRIBUTE_NAME);

    if (hostElement !== null) {
      writeProperty(hostElement, BOARD_SIZE_PROPERTY, null);
      hostElement.hidden = hostWasHidden;
    }

    const canvasElement = asHtmlElement(options.canvas);

    if (canvasElement !== null) {
      canvasElement.hidden = canvasWasHidden;
    }

    host = null;
    hostElement = null;
    gridLayer = null;
    tileLayer = null;
    cellElements = [];
    latticeSize = 0;
    activeCellIndex = 0;
    paintedTiles = [];
    deferred = [];

    reporter.onCount({ name: UNMOUNT_METRIC, value: 1 });
  };

  /**
   * Mounts a host and builds the lattice at the configured size.
   *
   * @param requested Element to build into, or omitted for the host given
   *   at construction.
   * @returns `true` when a host was mounted.
   */
  const mount = (requested?: Element | null): boolean => {
    if (disposed) {
      return false;
    }

    const next = requested ?? options.host ?? null;

    unmount();

    // Reported before the fatal checks below, so a mount attempt with every
    // surface absent reports every one of them and not only the first.
    reportAbsentSurfaces();

    if (owner === null) {
      reportAbsent(ELEMENT_NAMES.document, true);

      return false;
    }

    if (next === null) {
      reportAbsent(ELEMENT_NAMES.host, true);

      return false;
    }

    host = next;
    hostElement = asHtmlElement(next);

    if (hostElement !== null) {
      // index.html L64 ships the layer with `hidden`, which
      // style/main.scss L210 reads as `display: none`.
      hostWasHidden = hostElement.hidden;
      hostElement.hidden = false;
    }

    const canvasElement = asHtmlElement(options.canvas);

    if (canvasElement !== null) {
      // Nothing draws into the canvas layer while the board is drawn as
      // DOM elements. No context is requested from it.
      canvasWasHidden = canvasElement.hidden;
      canvasElement.hidden = true;
    }

    // Built at the configured size so the board is present before the
    // first commit; a commit carrying another size rebuilds it.
    buildLayers(readConfiguredSize());

    // `latticeSize` is 0 until a size is known, so the deferral is stated
    // rather than left to be read out of a zero.
    const latticeDeferred = latticeSize === 0;

    reporter.onCount({
      name: MOUNT_METRIC,
      value: 1,
      detail: Object.freeze({ latticeSize, latticeDeferred }),
    });

    reporter.onDiagnostic({
      level: 'info',
      source: DIAGNOSTIC_SOURCE,
      message: latticeDeferred
        ? 'The number-only board is mounted; its lattice is built on the ' +
          'first commit, which is what carries the board size.'
        : `The number-only board is mounted at size ${latticeSize}.`,
      detail: Object.freeze({
        latticeSize,
        latticeDeferred,
        theme: readTheme().id,
      }),
    });

    return true;
  };

  /**
   * Consumes one commit into a plan and queues it.
   *
   * @param commit Commit to paint.
   */
  const render = (commit: StateCommitEvent): void => {
    if (disposed) {
      return;
    }

    // Read here, inside the emission: `state:commit` carries the live
    // board, and the next turn mutates the same objects.
    queued = planCommit(commit);

    reporter.onCount({
      name: RENDER_METRIC,
      value: 1,
      detail: Object.freeze({ size: queued.size, tiles: queued.tiles.length }),
    });

    options.onWork?.();
  };

  /**
   * Runs one frame of queued work.
   *
   * @returns `true` while work remains.
   */
  const frame = (): boolean => {
    const plan = queued;

    if (plan !== null) {
      queued = null;
      deferred = [];
      paint(plan);

      // js/html_actuator.js nested a second `requestAnimationFrame` at L69
      // inside the one at L13, so a position rewrite ran on the frame after
      // the one that drew the tile.
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
  };

  /**
   * Subscribes to an engine's `state:commit` event.
   *
   * @param events Emitter to subscribe to.
   * @returns A handle that removes this subscription.
   */
  const subscribe = (events: EngineEvents): EngineEventSubscription => {
    const release = events.on('state:commit', render);

    subscriptions.push(release);

    let released = false;

    return (): void => {
      if (released) {
        return;
      }

      released = true;
      subscriptions = subscriptions.filter((held) => held !== release);
      release();
    };
  };

  /** Unmounts and releases every subscription this renderer holds. */
  const dispose = (): void => {
    if (disposed) {
      return;
    }

    disposed = true;

    unmount();

    queued = null;
    rendered = null;

    for (const release of subscriptions) {
      release();
    }

    subscriptions = [];
    releaseTheme?.();
  };

  if (options.host !== undefined && options.host !== null) {
    mount(options.host);
  }

  return Object.freeze({
    get mounted(): boolean {
      return host !== null;
    },

    mount,
    unmount,
    subscribe,
    render,
    frame,

    continueGame: clearMessage,

    readRenderedBoard: (): RenderedBoard | null => rendered,

    dispose,
    destroy: dispose,
  });
}
