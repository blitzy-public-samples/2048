// The number-only renderer: the board drawn as numbered DOM elements.
//
// It is the board renderer a machine with no WebGL context is served, and it
// is also selectable while a context is available. It reads no capability
// probe: `mount` takes no probe argument and consults none.
//
// The live region and the parallel board that index.html declares belong to
// src/ui/a11y/; this module announces nothing and builds neither, and
// `readRenderedBoard` is what it exposes for them to read.
//
// SUPERSEDES js/html_actuator.js, which is deleted. It is a SUBSCRIBER, not a
// callee: the vanilla manager pushed to the actuator, and this module reads
// the `state:commit` event instead.
//
// This module consumes no randomness, touches no storage, reads no clock,
// imports no rendering library and holds no engine reference. It reads the
// `state:commit` event, and it retains no part of a payload after the event
// that carried it.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated:
//   TR-NUMBER-01  js/html_actuator.js L10-L36   `actuate`, ported as `render()`
//                                               queueing and `frame()` drawing,
//                                               which src/render/render-loop.ts
//                                               drives in place of the two
//                                               nested `requestAnimationFrame`
//                                               calls
//   TR-NUMBER-02  js/html_actuator.js L43-L47   `clearContainer`, ported as
//                                               `clearElement()` and the
//                                               tile-layer reconciliation
//   TR-NUMBER-03  js/html_actuator.js L49-L91   `addTile`, ported as
//                                               `planTile()` and `drawTile()`
//   TR-NUMBER-04  js/html_actuator.js L93-L95   `applyClasses`, ported onto
//                                               `classList` where the actuator
//                                               wrote the whole class
//                                               attribute and cited
//                                               js/classlist_polyfill.js,
//                                               which is deleted
//   TR-NUMBER-05  js/html_actuator.js L97-L104  `normalizePosition` and
//                                               `positionClass`, ported as
//                                               `positionClass()` and
//                                               `positionTransform()`
//   TR-NUMBER-06  js/html_actuator.js L1-L8     the four unchecked
//                                               `querySelector` results, ported
//                                               as guarded lookups that report
//                                               an absent element once
//   TR-NUMBER-07  target-only row               the generated lattice and its
//                                               grid semantics
//   TR-NUMBER-08  target-only row               `readRenderedBoard()`
//   TR-NUMBER-09  target-only row               the fill, numeral colour and
//                                               numeral size published as
//                                               custom properties, resolved
//                                               through `resolveTileTheme` of
//                                               src/theme/themes.ts and
//                                               `tileNumeralSize` of
//                                               src/theme/tokens.ts
//   TR-NUMBER-10  target-only row               `degraded` carried by the
//                                               paint plan and by the
//                                               rendered-board snapshot, from
//                                               `StateCommitEvent.degraded`
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-NUMBER-01  the number-only mode as a first-class renderer that consults
//                 no capability probe
//   DL-NUMBER-02  `classList` as the class-mutation surface
//   DL-NUMBER-03  the tile appearance published as custom properties
//   DL-NUMBER-04  a moved tile's node reconciled across paints while a spawn
//                 and a merge each take a fresh node
//   DL-NUMBER-05  every element lookup guarded and an absent element reported
//                 once
//   DL-NUMBER-06  exactly one `role="grid"` describing the board, so the
//                 parallel accessibility layer is suppressed while this
//                 renderer is mounted

import {
  MAX_BOARD_SIZE,
  isSupportedBoardSize,
} from '../config/default-config';
import type { RulesConfig } from '../config/rules-config';
import type {
  EngineEvents,
  EngineEventSubscription,
  StateCommitEvent,
} from '../engine/engine-events';
import type { BestScoreValue } from '../engine/types';
import type { TileTheme } from '../theme/tile-ramp';
import { tileRampConstants } from '../theme/tile-ramp';
import type { Theme, ThemeId } from '../theme/themes';
import {
  getActiveTheme,
  getTheme,
  resolveTileTheme,
  subscribeToThemeChange,
} from '../theme/themes';
import type { GeometryScale, ScaleName } from '../theme/tokens';
import {
  createGeometryScale,
  desktopGeometry,
  mobileGeometry,
  mobileThreshold,
  tileNumeralSize,
  tilePositionStep,
} from '../theme/tokens';
import type { RenderReporter } from './webgl-support';
import {
  NOOP_RENDER_REPORTER,
  createGuardedRenderReporter,
  describeRenderError,
} from './webgl-support';

type CommitBoard = StateCommitEvent['board'];

type CommitTile = NonNullable<CommitBoard['cells'][number][number]>;

const GRID_CONTAINER_CLASS = 'grid-container';

const GRID_ROW_CLASS = 'grid-row';

const GRID_CELL_CLASS = 'grid-cell';

const TILE_CONTAINER_CLASS = 'tile-container';

const TILE_CLASS = 'tile';

const TILE_INNER_CLASS = 'tile-inner';

const TILE_VALUE_CLASS_PREFIX = 'tile-';

const TILE_POSITION_CLASS_PREFIX = 'tile-position-';

const SUPER_TILE_CLASS = 'tile-super';

const MERGED_TILE_CLASS = 'tile-merged';

const NEW_TILE_CLASS = 'tile-new';

const ELEMENT_TAG = 'div';

const FILL_PROPERTY = '--tile-fill';

const NUMERAL_PROPERTY = '--tile-numeral';

const NUMERAL_SIZE_PROPERTY = '--tile-numeral-size';

const NUMERAL_SIZE_MOBILE_PROPERTY = '--tile-numeral-size-mobile';

const BOARD_SIZE_PROPERTY = '--board-size';

const LENGTH_UNIT = 'px';

/** The property a tile's position is written into. */
const TRANSFORM_PROPERTY = 'transform';

/**
 * Names the guarded lookups are reported under: the selector index.html
 * declares each surface with.
 */
const ELEMENT_NAMES = Object.freeze({
  host: '#board-number-only',
  document: 'document',
});

const ROLE_ATTRIBUTE = 'role';

const GRID_ROLE = 'grid';

const ROW_ROLE = 'row';

const GRIDCELL_ROLE = 'gridcell';

const LABEL_ATTRIBUTE = 'aria-label';

const ROWCOUNT_ATTRIBUTE = 'aria-rowcount';

const COLCOUNT_ATTRIBUTE = 'aria-colcount';

const ROWINDEX_ATTRIBUTE = 'aria-rowindex';

const COLINDEX_ATTRIBUTE = 'aria-colindex';

const ARIA_HIDDEN_ATTRIBUTE = 'aria-hidden';

const TABINDEX_ATTRIBUTE = 'tabindex';

const ARIA_TRUE = 'true';

const FOCUS_EVENT = 'focusin';

const CELL_VALUE_ATTRIBUTE = 'data-tile-value';

/**
 * The two attributes `ParallelBoardLayer` of src/ui/a11y/focus-manager.ts marks
 * each of its cell counterparts with, read here so the focused coordinate can
 * cross the renderer handoff. Restated rather than imported: this module reaches
 * the parallel board as an opaque `Element` and imports nothing from src/ui.
 * DL-FOCUS-04.
 */
const PARALLEL_CELL_X_ATTRIBUTE = 'data-cell-x';

const PARALLEL_CELL_Y_ATTRIBUTE = 'data-cell-y';

const BOARD_SIZE_ATTRIBUTE = 'data-board-size';

const THEME_ATTRIBUTE_NAME = 'data-rendered-theme';

const TAB_STOP = '0';

const NOT_A_TAB_STOP = '-1';

/**
 * The copy this module writes.
 *
 * Every string is a caller-overridable default. The two terminal verdicts are
 * NOT here: they belong to src/ui/screens/hud.ts, which owns the overlay they
 * are written into.
 */
export interface NumberOnlyRendererCopy {
  readonly boardLabel: string;
  readonly cellLabel: (row: number, column: number, value: number) => string;
  readonly emptyCellLabel: (row: number, column: number) => string;

}

/**
 * The default copy.
 *
 * The lattice name differs from the `aria-label` index.html gives
 * `#board-a11y`.
 */
export const numberOnlyRendererCopy: NumberOnlyRendererCopy = Object.freeze({
  boardLabel: 'Game board, numbers only',
  cellLabel: (row: number, column: number, value: number): string =>
    `Row ${row}, column ${column}, ${value}`,

  emptyCellLabel: (row: number, column: number): string =>
    `Row ${row}, column ${column}, empty`,
});

const DIAGNOSTIC_SOURCE = 'render/number-only-renderer';

const MOUNT_METRIC = 'render.numberOnly.mount';

const UNMOUNT_METRIC = 'render.numberOnly.unmount';

const RENDER_METRIC = 'render.numberOnly.render';

const PAINT_METRIC = 'render.numberOnly.paint';

const LATTICE_METRIC = 'render.numberOnly.lattice';

const MISSING_ELEMENT_METRIC = 'render.numberOnly.element.missing';

const UNRESOLVED_VALUE_METRIC = 'render.numberOnly.value.unresolved';

/** Counter name for a commit whose board size this module refused. */
const REFUSED_SIZE_METRIC = 'render.numberOnly.size.refused';

/** Counter name for one theme change the renderer repainted for. */
const THEME_CHANGE_METRIC = 'render.numberOnly.theme.change';

/** Counter name for one claim or release of the parallel board. */
const PARALLEL_BOARD_METRIC = 'render.numberOnly.parallelBoard';

const REFUSED_SUBSCRIBE_METRIC = 'render.numberOnly.subscribe.refused';

/**
 * One cell of the rendered board, as plain data.
 *
 * Derived from the board and tile projection a `state:commit` event carries,
 * and holding no reference back to it, so it stays valid after the engine has
 * moved on from the turn that emitted.
 */
export interface RenderedCell {
  /** Zero-based column index, the outer index of `cells[x][y]`. */
  readonly x: number;

  /** Zero-based row index, the inner index of `cells[x][y]`. */
  readonly y: number;

  /** Face value, or `null` where the cell is empty. */
  readonly value: number | null;
  readonly label: string;
  readonly isSuper: boolean;
  readonly isMerged: boolean;
  readonly isNew: boolean;
  readonly moved: boolean;

  /** Resolved fill, or `null` where the value is off the ramp. */
  readonly fill: string | null;

  /** Resolved numeral colour, or `null` where the value is off the ramp. */
  readonly numeralColor: string | null;
}

/**
 * Everything one paint put on screen, as plain data.
 *
 * `readRenderedBoard` returns it so src/ui/a11y/ can announce what is rendered
 * without reading the engine and without this module announcing anything
 * itself.
 */
export interface RenderedBoard {
  readonly size: number;

  /** Every cell, in row-major order: row 0 left to right, then row 1. */
  readonly cells: readonly RenderedCell[];
  readonly score: number;
  readonly scoreDelta: number;
  readonly bestScore: BestScoreValue;
  readonly won: boolean;
  readonly over: boolean;
  readonly terminated: boolean;

  /**
   * Whether the engine could not establish this turn's terminal or stage
   * status: Both renderers carry it, so a consumer reads one snapshot shape
   * whichever draws the board.
   */
  readonly degraded: boolean;

  readonly themeId: ThemeId;
}

/**
 * The part of `ParallelBoardLayer` this renderer drives.
 *
 * Declared structurally, by the three members called, so the render layer
 * needs no import from the accessibility layer: `ParallelBoardLayer` of
 * src/ui/a11y/focus-manager.ts satisfies it as written.
 */
export interface ParallelBoardLifecycle {
  /** Whether the layer holds a resolved host and built cells. */
  isMounted(): boolean;

  /**
   * Resolves the host and builds the cell counterparts.
   *
   * @param host Host the cells are built inside.
   * @param boardSize Cells per row.
   * @returns Whether the layer mounted.
   */
  mount(host: Element | string | null | undefined, boardSize: number): boolean;

  /**
   * Moves focus to one cell counterpart, so a board handed back to this layer
   * opens on the cell the surface being torn down was reading. OPTIONAL: a
   * caller may supply a layer that only mounts and unmounts. DL-FOCUS-04.
   *
   * @param x Zero-based column.
   * @param y Zero-based row.
   * @returns Whether focus moved.
   */
  focusCell?(x: number, y: number): boolean;

  /** Removes the cell counterparts and every listener the layer added. */
  unmount(): void;
}

/** Construction parameters. Every member is optional. */
export interface NumberOnlyRendererOptions {
  /**
   * Element the board is built inside. index.html declares
   * `#board-number-only` for it, which ships with the `hidden` attribute
   * style/main.scss reads; `mount` clears that attribute and `unmount`
   * restores it.
   *
   * Supplying it constructs a mounted renderer. Omitting it defers the mount
   * to `mount(host)`.
   */
  readonly host?: Element | null;

  /** The WebGL canvas layer, `#board-canvas` of index.html. */
  readonly canvas?: Element | null;

  /**
   * The parallel accessibility board, `#board-a11y` of index.html.
   *
   * SEMANTIC EXCLUSIVITY, the invariant this option exists to hold: exactly one
   * `role="grid"` describes the board at any moment. This renderer publishes
   * its own complete lattice — a `role="grid"` carrying one labelled
   * `role="gridcell"` per cell — so for as long as it is mounted the parallel
   * board is marked `aria-hidden` and `hidden`, which takes it out of both the
   * rendering tree and the accessibility tree. Every attribute it carried is
   * restored on unmount, so the surface is available again to whichever
   * renderer takes over. Decision DL-NUMBER-06.
   *
   * ITS CHILDREN ARE NEVER TOUCHED. They belong to `ParallelBoardLayer`, which
   * holds a reference to each of them; a caller that wants them removed hands
   * in `parallelBoardLayer` below so the layer is unmounted through its own api.
   */
  readonly parallelBoard?: Element | null;

  /**
   * The layer that owns the parallel board's cells, where the caller holds one.
   *
   * Supplied, the other lattice is taken down through its own api —
   * `unmount()` on claim and `mount()` on release — so the layer's
   * `isMounted()` and `boardSize()` stay truthful and its cell references are
   * never left pointing at detached nodes. Omitted, the element is left hidden
   * with its children intact and in the document.
   */
  readonly parallelBoardLayer?: ParallelBoardLifecycle | null;

  /** Document elements are created in. Defaults to the ambient `document`. */
  readonly ownerDocument?: Document;

  /**
   * The rules the board is built from. `boardSize` seeds the lattice before
   * the first commit and `winValue` is the fallback super threshold; both are
   * read afresh at each use, which is how `RulesConfig` requires its members
   * to be read.
   */
  readonly config?: RulesConfig;

  /**
   * Fallback value above which a tile takes `.tile-super`, used only where the
   * ramp cannot resolve the value.
   */
  readonly superThreshold?: number;

  /**
   * Theme to pin, as a `Theme` or a theme id.
   *
   * Supplying it fixes the palette for the renderer's whole life and no theme
   * change is followed. An id that no theme carries is reported and the active
   * theme is used instead. Omitting it follows the theme in force, repainting
   * on every change.
   */
  readonly theme?: Theme | ThemeId;

  /** Copy overrides. Absent members take `numberOnlyRendererCopy`. */
  readonly copy?: Partial<NumberOnlyRendererCopy>;

  /**
   * Sink the counters and diagnostics leave through. Wrapped so a reporter
   * that throws cannot reach a paint.
   */
  readonly reporter?: RenderReporter;

  /**
   * Called whenever work has been queued, so the caller can schedule a frame.
   * Absent, the caller drives `frame` on its own schedule.
   */
  readonly onWork?: () => void;

  /**
   * Coordinate the lattice's tab stop opens on, clamped into the board in
   * force, so a renderer built to replace another resumes on the cell that one
   * was being read at.
   *
   * Adopted for the FIRST lattice this renderer builds and never afterwards: a
   * rebuild carries its own coordinate (`carriedFocus`), and a live handoff from
   * the parallel board outranks both. Focus is NOT moved by it — a coordinate
   * supplied here is where the next Tab lands, not a placement. DL-FOCUS-04,
   * DL-NUMBER-08.
   */
  readonly initialCell?: BoardCoordinate | null;
}

/** One board cell, and whether that cell was the one holding focus. */
export interface BoardFocus {
  /** Zero-based column. */
  readonly x: number;

  /** Zero-based row. */
  readonly y: number;

  /** Whether the surface reporting it was the one holding focus. */
  readonly focused: boolean;
}

/** One board cell. */
export interface BoardCoordinate {
  /** Zero-based column. */
  readonly x: number;

  /** Zero-based row. */
  readonly y: number;
}

/**
 * The renderer.
 *
 * Frozen: the members below are its whole surface. `subscribe`, `mount`,
 * `unmount` and `dispose` are the four members every renderer under
 * src/render/ exposes.
 */
export interface NumberOnlyRenderer {
  readonly mounted: boolean;

  /**
   * Resolves a host, unmounts anything already standing, and builds the board.
   *
   * @param host Host to build inside. Omitted, the constructed `host` option
   *   is used.
   * @returns Whether the board is mounted afterwards. `false` after
   *   `dispose`, where no document is reachable, and where no host resolves;
   *   each of the last two is reported.
   */
  mount(host?: Element | null): boolean;

  /**
   * Removes everything this renderer put in the document and every listener it
   * bound, and restores the `hidden` state of the host and of the canvas
   * layer.
   *
   * Leaves the score, the best score and the overlay as they stand, and leaves
   * any engine subscription in place. Unmounting while not mounted does
   * nothing.
   */
  unmount(): void;

  /**
   * Registers `render` against `state:commit` and returns the release handle.
   *
   * @param events Emitter to subscribe to.
   * @returns The release handle.
   */
  subscribe(events: EngineEvents): EngineEventSubscription;

  /**
   * Queues a commit for the next frame.
   *
   * A commit queued while another is queued replaces it, so only the latest
   * state is painted — the behaviour the single `requestAnimationFrame` of
   * js/html_actuator.js L13 produced. The payload is consumed here and no part
   * of it is retained.
   */
  render(commit: StateCommitEvent): void;

  /**
   * Runs the work of one frame: paints a queued commit, or applies the
   * position rewrites a previous paint deferred.
   *
   * @returns Whether a further frame is still owed. `true` only when this
   *   call painted a commit that left rewrites outstanding — the second
   *   `requestAnimationFrame` js/html_actuator.js nested inside the first — so
   *   a caller drives `frame` again exactly while it returns `true`, and
   *   `false` means nothing is queued and nothing is deferred.
   */
  frame(): boolean;

  /**
   * Everything the last paint put on screen, as plain data, or `null` before
   * the first paint.
   *
   * @returns A frozen snapshot, safe to read after the engine has moved on.
   */
  readRenderedBoard(): RenderedBoard | null;

  /**
   * The coordinate this lattice's tab stop stands on, and whether that cell is
   * the one holding focus.
   *
   * Read by a caller that is about to swap renderers, so the coordinate can be
   * handed to the renderer taking over as its `initialCell`: the two surfaces
   * are separate objects with separate lattices, so nothing carries between them
   * on its own. `null` while no lattice is built. DL-FOCUS-04, DL-NUMBER-08.
   *
   * @returns The coordinate, or `null` where there is no lattice.
   */
  focusedCell(): BoardFocus | null;

  /**
   * Unmounts the board, drops the queued commit and the last rendered board,
   * releases every engine subscription this renderer registered and the theme
   * subscription it holds.
   *
   * Idempotent. Afterwards `mount` returns `false`, `subscribe` registers
   * nothing, `frame` has no work and `readRenderedBoard` returns `null`.
   */
  dispose(): void;

  /** Alias of `dispose`, for callers that hold a renderer by that name. */
  destroy(): void;
}

interface PlannedTile {
  readonly value: number;
  readonly x: number;
  readonly y: number;

  /** Cell the tile is first drawn in, or `null` where it is not moving. */
  readonly from: { readonly x: number; readonly y: number } | null;
  readonly merged: readonly PlannedTile[];
}

interface PaintPlan {
  readonly size: number;

  /** Every tile to draw, in the order the cells were walked. */
  readonly tiles: readonly PlannedTile[];

  /** The value of each cell in row-major order, `null` where empty. */
  readonly values: readonly (number | null)[];
  readonly score: number;
  readonly bestScore: BestScoreValue;
  readonly over: boolean;
  readonly won: boolean;
  readonly terminated: boolean;
  readonly degraded: boolean;
}

type HiddenState = HTMLElement['hidden'];

interface PaintedTile {
  readonly element: HTMLElement;
  readonly value: number;
}

interface RetainedTile {
  /** The `.tile` element. */
  readonly element: HTMLElement;

  /** The `.tile-inner` element carrying the numeral. */
  readonly inner: HTMLElement;

  /** Face value the node is dressed for. */
  value: number;

  /** Position class the node currently carries. */
  positionClass: string;

  /** Cell index the node currently sits at, `y * size + x`. */
  index: number;
}

interface TilePresentation {
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

function readAmbientDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

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

function clearElement(element: Element): void {
  while (element.firstChild !== null) {
    element.removeChild(element.firstChild);
  }
}

function positionClass(x: number, y: number): string {
  return `${TILE_POSITION_CLASS_PREFIX}${x + 1}-${y + 1}`;
}

/** The part of a media-query list this module uses. */
interface ScaleQueryList {
  /** Whether the query currently matches. */
  readonly matches: boolean;

  /** Modern subscription. */
  readonly addEventListener?: (type: 'change', listener: () => void) => void;

  /** Modern unsubscription. */
  readonly removeEventListener?: (
    type: 'change',
    listener: () => void,
  ) => void;

  /** Subscription on engines predating the modern form. */
  readonly addListener?: (listener: () => void) => void;

  /** Unsubscription on engines predating the modern form. */
  readonly removeListener?: (listener: () => void) => void;
}

/** The breakpoint the mobile scale applies at, `$mobile-threshold`. */
const MOBILE_SCALE_QUERY = `(max-width: ${mobileThreshold}px)`;

/**
 * Narrows a value to a media-query list.
 *
 * @param value Candidate list.
 * @returns Whether `value` carries a boolean `matches`.
 */
function isScaleQueryList(value: unknown): value is ScaleQueryList {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate: { readonly matches?: unknown } = value;

  return typeof candidate.matches === 'boolean';
}

/**
 * Opens the breakpoint query, without throwing.
 *
 * @param view Window the query is evaluated against, or `null`.
 * @returns The list, or `null` where the platform offers no usable
 *   `matchMedia`.
 */
function openScaleQuery(view: Window | null): ScaleQueryList | null {
  if (view === null || typeof view.matchMedia !== 'function') {
    return null;
  }

  try {
    const list: unknown = view.matchMedia(MOBILE_SCALE_QUERY);

    return isScaleQueryList(list) ? list : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the geometry of one board size at one scale.
 *
 * @param name Which of the two scales to resolve at.
 * @param boardSize Cells per row.
 * @returns The resolved lengths.
 */
function geometryForBoard(
  name: ScaleName,
  boardSize: number,
): GeometryScale {
  const declared = name === 'mobile' ? mobileGeometry : desktopGeometry;

  if (boardSize === declared.gridRowCells) {
    return declared;
  }

  try {
    return createGeometryScale({
      fieldWidth: declared.fieldWidth,
      gridSpacing: declared.gridSpacing,
      gridRowCells: boardSize,
      tileBorderRadius: declared.tileBorderRadius,
      gameContainerMarginTop: declared.gameContainerMarginTop,
    });
  } catch {
    return declared;
  }
}

/**
 * The translation one cell's tile is drawn at, as a `transform` value.
 *
 * @param x Zero-based column index.
 * @param y Zero-based row index.
 * @param scale Lengths in force.
 * @returns The `transform` value, or `null` where either index is refused.
 */
function positionTransform(
  x: number,
  y: number,
  scale: GeometryScale,
): string | null {
  try {
    const left = tilePositionStep(x, scale);
    const top = tilePositionStep(y, scale);

    return `translate(${left}${LENGTH_UNIT}, ${top}${LENGTH_UNIT})`;
  } catch {
    return null;
  }
}

/**
 * Replaces one class with another.
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

function readCell(board: CommitBoard, x: number, y: number): CommitTile | null {
  const column = board.cells.at(x);

  if (column === undefined) {
    return null;
  }

  return column.at(y) ?? null;
}

function planTile(tile: CommitTile): PlannedTile {
  const previous = tile.previousPosition;

  return {
    value: tile.value,
    x: tile.x,
    y: tile.y,
    from: previous === null ? null : { x: previous.x, y: previous.y },

    // The two source tiles are drawn beneath the merged one, and each is drawn
    // by the same path, so the pair is planned the same way.
    merged:
      previous === null && tile.mergedFrom !== null
        ? tile.mergedFrom.map(planTile)
        : [],
  };
}

function planCommit(commit: StateCommitEvent): PaintPlan {
  const board = commit.board;
  const size = board.size;
  const tiles: PlannedTile[] = [];
  const values: (number | null)[] = [];

  // The vanilla actuator walked the columns outermost and drew every cell that
  // held a tile.
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
    degraded: commit.degraded,
  });
}

/**
 * The numeral size one value is drawn at, at one scale, for the board size in
 * force.
 *
 * @param value Face value the numeral is drawn for.
 * @param scale Which of the two scales to resolve at.
 * @param boardSize Cells per row in force.
 * @returns The size to draw at, in px.
 */
function readNumeralSize(
  value: number,
  scale: ScaleName,
  boardSize: number,
): number {
  return tileNumeralSize(
    value,
    scale,
    geometryForBoard(scale, boardSize).tileSize,
  );
}

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
  });
}

/**
 * Creates a number-only renderer.
 *
 * Supplying `host` mounts immediately; omitting it defers the mount to
 * `mount(host)`. Nothing here requests a rendering context, so the renderer is
 * constructible and paints where no WebGL context can be obtained at all.
 *
 * @returns A frozen renderer. One constructed with no host reports the
 *   absence, paints nothing, and every member stays safe to call.
 */
export function createNumberOnlyRenderer(
  options: NumberOnlyRendererOptions = {},
): NumberOnlyRenderer {
  const reporter = createGuardedRenderReporter(
    options.reporter ?? NOOP_RENDER_REPORTER,
  );
  const owner = options.ownerDocument ?? readAmbientDocument();
  const copy = mergeCopy(options.copy);

  /** Names already reported absent, so each is reported once. */
  const reportedAbsent = new Set<string>();

  const reportedValues = new Set<number>();

  /**
   * Reports one absent element, once.
   *
   * The four lookups js/html_actuator.js L2-L5 performed were unchecked and
   * their results were dereferenced at L44, L90, L107, L124, L131, L132, L137
   * and L138, so a renamed class was a startup failure.
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
   * The theme pinned at construction, or `null` to follow the theme in force.
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
        error: describeRenderError(error),
        thrown: error,
      });

      return null;
    }
  })();

  const readTheme = (): Theme => pinnedTheme ?? getActiveTheme();

  /**
   * The value above which a tile takes `.tile-super` where the ramp cannot
   * resolve it.
   *
   * `RulesConfig` requires its members be read afresh at each use, so
   * `winValue` is read here and not captured.
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

  /** The mounted host, or `null`. */
  let host: Element | null = null;

  let hostElement: HTMLElement | null = null;

  /**
   * The host's `hidden` state before this renderer mounted it.
   *
   * Typed from the property, which carries the attribute's `until-found` value
   * alongside the two boolean states, so a host that shipped in that state is
   * restored to it.
   */
  let hostWasHidden: HiddenState = false;

  /** The canvas layer's `hidden` state before this renderer mounted. */
  let canvasWasHidden: HiddenState = false;

  let gridLayer: HTMLElement | null = null;

  let tileLayer: HTMLElement | null = null;

  /** Every cell of the lattice, in row-major order. */
  let cellElements: HTMLElement[] = [];

  let latticeSize = 0;

  let activeCellIndex = 0;

  /**
   * The coordinate the FIRST lattice opens its tab stop on, from the caller's
   * `initialCell`, and `null` once a lattice has been built or where the caller
   * supplied none. Held separately from `activeCellIndex` because that index is
   * meaningless until an edge length is known. DL-FOCUS-04, DL-NUMBER-08.
   */
  let openingCell: CarriedFocus | null =
    options.initialCell === undefined || options.initialCell === null
      ? null
      : { x: options.initialCell.x, y: options.initialCell.y, focused: false };

  let shownScore = 0;

  /** The plan awaiting a paint, or `null`. */
  let queued: PaintPlan | null = null;

  let deferred: (() => void)[] = [];

  let paintedTiles: PaintedTile[] = [];

  /**
   * Tile nodes the last paint left in place, keyed by the cell they sit at.
   */
  let retained = new Map<number, RetainedTile>();

  /**
   * Nodes drawn for their animation alone: the two source tiles beneath a
   * merge. js/html_actuator.js L73-L80 drew them and L14 removed them on the
   * next actuation, which is when they are removed here too.
   */
  let transient: HTMLElement[] = [];

  /** Reused by `paintCells`, so a paint allocates no occupant table. */
  const occupants = new Map<number, PlannedTile>();

  /** Reused by one paint, so a paint allocates no second table. */
  const claimed = new Map<number, RetainedTile>();

  /** The geometry the tile transforms were last written from. */
  let geometry: GeometryScale = geometryForBoard('desktop', 0);

  /** The breakpoint query, while one is open. */
  let scaleQuery: ScaleQueryList | null = null;

  /** The listener installed on `scaleQuery`, so unmount removes exactly it. */
  let scaleListener: (() => void) | null = null;

  /** The parallel accessibility board, while this renderer holds it. */
  const parallelBoardLayer = options.parallelBoardLayer ?? null;
  let parallelBoard: Element | null = null;

  /** The attributes the parallel board carried before this renderer hid it. */
  let parallelBoardState: {
    hidden: HiddenState;
    ariaHidden: string | null;
    ariaBusy: string | null;
  } | null = null;

  /** What the last paint put on screen, or `null` before the first. */
  let rendered: RenderedBoard | null = null;

  let subscriptions: EngineEventSubscription[] = [];

  let disposed = false;

  /**
   * Resolves one tile value's fill, numeral colour, numeral sizes and super
   * band.
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

      // style/main.scss steps the numeral down as the value gains digits, and
      // steps it again above the ramp.
      const sized = latticeSize > 0 ? latticeSize : readConfiguredSize();

      desktopSize = readNumeralSize(value, 'desktop', sized);
      mobileSize = readNumeralSize(value, 'mobile', sized);
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
          error: describeRenderError(error),
          thrown: error,
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
      // The ramp is the authority: `isSuper` holds where the value is STRICTLY
      // above `tileRampConstants.superThreshold`, which is the comparison
      // js/html_actuator.js L60 made.
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

  /**
   * Marks one cell as the lattice's tab stop and every other cell as not one,
   * so the board is a single stop in the tab order.
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

  /** One board coordinate, and whether focus was on it. */
  type CarriedFocus = BoardFocus;

  /** Whether the active element is one of this lattice's cells. */
  const focusHeldInLattice = (): boolean => {
    const active = owner?.activeElement ?? null;

    return active !== null && cellElements.some((cell) => cell === active);
  };

  /**
   * The coordinate the tab stop stands on, or `null` while no lattice is built.
   *
   * Read BEFORE a rebuild or a handoff, because both discard the nodes the
   * index addresses.
   */
  const carriedFocus = (): CarriedFocus | null =>
    latticeSize > 0
      ? {
          x: activeCellIndex % latticeSize,
          y: Math.floor(activeCellIndex / latticeSize),
          focused: focusHeldInLattice(),
        }
      : null;

  /**
   * Moves the tab stop to a coordinate, clamped into the lattice in force.
   *
   * @param x Zero-based column.
   * @param y Zero-based row.
   */
  const adoptCoordinate = (x: number, y: number): void => {
    if (latticeSize <= 0) {
      return;
    }

    const clampedX = Math.min(Math.max(x, 0), latticeSize - 1);
    const clampedY = Math.min(Math.max(y, 0), latticeSize - 1);

    activeCellIndex = clampedY * latticeSize + clampedX;
  };

  /** Moves focus to the cell the tab stop stands on. */
  const focusActiveCell = (): void => {
    cellElements.at(activeCellIndex)?.focus();
  };

  /** Moves the tab stop to the cell that has taken focus. */
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

  /**
   * The scale in force: the breakpoint's answer where one is readable, and the
   * viewport width where it is not.
   *
   * @returns Which of the two scales style/main.scss declares.
   */
  const currentScaleName = (): ScaleName => {
    if (scaleQuery !== null) {
      return scaleQuery.matches ? 'mobile' : 'desktop';
    }

    const view = owner?.defaultView ?? null;

    if (view !== null && typeof view.innerWidth === 'number') {
      return view.innerWidth <= mobileThreshold ? 'mobile' : 'desktop';
    }

    return 'desktop';
  };

  /** Resolves the geometry for the lattice size at the scale in force. */
  const resolveGeometry = (): void => {
    geometry = geometryForBoard(currentScaleName(), latticeSize);
  };

  /**
   * Rewrites the transform of every retained node at the geometry now in
   * force.
   *
   * The breakpoint restates the field width and the gutter, so the step every
   * transform is written from changes with it.
   */
  const reapplyGeometry = (): void => {
    resolveGeometry();

    for (const held of retained.values()) {
      const x = held.index % latticeSize;
      const y = Math.floor(held.index / latticeSize);

      placeTile(held.element, x, y);
    }
  };

  /** Opens the breakpoint query and follows it, once per mount. */
  const openScale = (): void => {
    scaleQuery = openScaleQuery(owner?.defaultView ?? null);

    if (scaleQuery === null) {
      return;
    }

    const listener = (): void => {
      reapplyGeometry();
    };

    if (typeof scaleQuery.addEventListener === 'function') {
      scaleQuery.addEventListener('change', listener);
      scaleListener = listener;

      return;
    }

    if (typeof scaleQuery.addListener === 'function') {
      scaleQuery.addListener(listener);
      scaleListener = listener;
    }
  };

  /** Stops following the breakpoint. */
  const closeScale = (): void => {
    const query = scaleQuery;
    const listener = scaleListener;

    scaleQuery = null;
    scaleListener = null;

    if (query === null || listener === null) {
      return;
    }

    if (typeof query.removeEventListener === 'function') {
      query.removeEventListener('change', listener);

      return;
    }

    query.removeListener?.(listener);
  };

  /**
   * Builds the empty-cell layer and the tile layer for a board of `size` cells
   * to a side.
   *
   * Rebuilt only where the size changed, so a move relabels the cells it
   * already built and the focused cell keeps its focus. index.html declared
   * this structure statically for one size; style/main.scss records this
   * module as its producer.
   *
   * The lattice carries the grid semantics and the tile layer carries
   * `aria-hidden`, so each cell's position and value reach assistive
   * technology once.
   */
  const buildLayers = (size: number): void => {
    if (host === null || owner === null || size <= 0) {
      return;
    }

    // The lattice below creates `size` by `size` elements, so the edge is
    // measured against MAX_BOARD_SIZE of src/config/default-config.ts before
    // the first element is created.
    if (!isSupportedBoardSize(size)) {
      reporter.onCount({
        name: REFUSED_SIZE_METRIC,
        value: 1,
        detail: Object.freeze({ size, maximum: MAX_BOARD_SIZE }),
      });

      reporter.onDiagnostic({
        level: 'error',
        source: DIAGNOSTIC_SOURCE,
        message:
          'The number-only board refused a board size above the supported ' +
          'maximum and built no lattice',
        detail: Object.freeze({
          size,
          maximum: MAX_BOARD_SIZE,
          latticeSize,
        }),
      });

      return;
    }

    if (gridLayer !== null && tileLayer !== null && latticeSize === size) {
      return;
    }

    // READ BEFORE THE TEARDOWN. The rebuild discards every cell, so the
    // coordinate the tab stop stood on and whether it held focus have to be
    // taken now; both are restored below, clamped into the new edge length.
    // DL-FOCUS-04.
    const carried = carriedFocus();

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

    // The lattice was rebuilt, so every node the retention table held is gone
    // with it and the geometry is resolved for the new edge length.
    retained.clear();
    claimed.clear();
    transient = [];
    resolveGeometry();

    // There is a semantic lattice now, so the other one stands down — and the
    // coordinate it was standing on comes across with it, so a swap from the
    // Three renderer's parallel board resumes on the same cell.
    const handedOver = claimParallelBoard();

    // THREE SOURCES, IN PRECEDENCE ORDER. A live handoff — the parallel board
    // was holding focus as this lattice took the board — outranks a rebuild's
    // own coordinate, which outranks the one the caller supplied for the first
    // build. `supplied` is consumed here whether or not it is used, so it can
    // never re-apply over a later rebuild's carry. DL-FOCUS-04, DL-NUMBER-08.
    const supplied = openingCell;

    openingCell = null;

    const restored = handedOver ?? carried ?? supplied;

    if (restored !== null) {
      adoptCoordinate(restored.x, restored.y);
    }

    applyRovingTabStop();
    attachFocusListener();

    // MOVED ONLY WHERE IT WAS ALREADY HELD. A rebuild or a handoff that happened
    // while focus was elsewhere leaves focus where it is; one that discarded the
    // focused node puts focus back on the cell that replaced it.
    if (restored?.focused === true) {
      focusActiveCell();
    }

    reporter.onCount({
      name: LATTICE_METRIC,
      value: 1,
      detail: Object.freeze({ size, cells: cells.length }),
    });
  };

  /**
   * Places one already-built tile node at a cell, by transform alone.
   *
   * The transform is what positions the tile: the `@for` loop of
   * style/main.scss states a position only for a compiled-size board, so a
   * board at any other edge length is placed from here. A cell the geometry
   * cannot resolve removes the property rather than writing an invalid value,
   * which leaves the node where the stylesheet's own position class put it.
   *
   * @param element Tile node to place.
   * @param x Cell column, zero-based.
   * @param y Cell row, zero-based.
   */
  const placeTile = (
    element: HTMLElement,
    x: number,
    y: number,
  ): void => {
    const transform = positionTransform(x, y, geometry);

    if (transform === null) {
      element.style.removeProperty(TRANSFORM_PROPERTY);

      return;
    }

    element.style.setProperty(TRANSFORM_PROPERTY, transform);
  };

  /**
   * Builds one tile node.
   *
   * Ported from js/html_actuator.js L49-L91 for the node it constructs: the
   * wrapper carrying `.tile`, its value class and its position class, and the
   * `.tile-inner` carrying the numeral.
   *
   * @param planned Tile the node is dressed for.
   * @param at Cell the node is first placed in.
   * @param theme Theme the presentation is resolved under.
   * @returns The node, unattached.
   */
  const buildTile = (
    planned: PlannedTile,
    at: { readonly x: number; readonly y: number },
    theme: Theme,
  ): RetainedTile | null => {
    if (owner === null) {
      return null;
    }

    const element = owner.createElement(ELEMENT_TAG);
    const inner = owner.createElement(ELEMENT_TAG);
    const drawnClass = positionClass(at.x, at.y);

    // L58: the tile, its value and its position.
    element.classList.add(
      TILE_CLASS,
      `${TILE_VALUE_CLASS_PREFIX}${planned.value}`,
      drawnClass,
    );
    applyPresentation(element, resolvePresentation(planned.value, theme));
    placeTile(element, at.x, at.y);

    inner.classList.add(TILE_INNER_CLASS);
    inner.textContent = String(planned.value);

    // L86.
    element.appendChild(inner);

    return {
      element,
      inner,
      value: planned.value,
      positionClass: drawnClass,
      index: at.y * latticeSize + at.x,
    };
  };

  /**
   * Moves a retained node to a cell, rewriting its position class and its
   * transform.
   *
   * @param held Node to move.
   * @param x Destination column.
   * @param y Destination row.
   */
  const moveTile = (held: RetainedTile, x: number, y: number): void => {
    const next = positionClass(x, y);

    replaceClass(held.element, held.positionClass, next);
    held.positionClass = next;
    held.index = y * latticeSize + x;
    placeTile(held.element, x, y);
  };

  /**
   * Clears the animated state classes a previous paint left on a node.
   *
   * `.tile-new` and `.tile-merged` declare the `appear` and `pop` animations.
   * js/html_actuator.js discarded the node instead, so a tile that persisted
   * into the next actuation was rebuilt without them; a retained node is
   * stripped of them here for the same effect.
   *
   * @param held Node to clear.
   */
  const clearAnimationState = (held: RetainedTile): void => {
    held.element.classList.remove(NEW_TILE_CLASS, MERGED_TILE_CLASS);
  };

  /**
   * Claims the node a moved or standing tile can reuse.
   *
   * @param index Cell the node was left at by the previous paint.
   * @param value Value the node must already be dressed for.
   * @returns The node, removed from the retention table, or `null`.
   */
  const claimTile = (index: number, value: number): RetainedTile | null => {
    const held = retained.get(index);

    if (held === undefined || held.value !== value) {
      return null;
    }

    retained.delete(index);

    return held;
  };

  /**
   * Draws one tile, and the pair it merged from, reconciling against the nodes
   * the previous paint left in place.
   *
   * @param planned Tile to draw.
   * @param theme Theme the presentation is resolved under.
   */
  const drawTile = (planned: PlannedTile, theme: Theme): void => {
    if (owner === null || tileLayer === null) {
      return;
    }

    const layer = tileLayer;
    const index = planned.y * latticeSize + planned.x;
    const from = planned.from;

    if (from !== null) {
      const held = claimTile(
        from.y * latticeSize + from.x,
        planned.value,
      );

      if (held !== null) {
        clearAnimationState(held);
        moveTile(held, planned.x, planned.y);
        claimed.set(index, held);
        paintedTiles.push({ element: held.element, value: held.value });

        return;
      }

      const built = buildTile(planned, from, theme);

      if (built === null) {
        return;
      }

      layer.appendChild(built.element);
      claimed.set(index, built);
      paintedTiles.push({ element: built.element, value: built.value });

      // L67-L72: the node is in the document at its previous cell now, and
      // moves on the next frame.
      deferred.push((): void => {
        moveTile(built, planned.x, planned.y);
      });

      return;
    }

    if (planned.merged.length > 0) {
      // L73-L80: each source is drawn beneath the merged tile.
      for (const source of planned.merged) {
        const origin = source.from ?? { x: source.x, y: source.y };
        const heldSource = claimTile(
          origin.y * latticeSize + origin.x,
          source.value,
        );

        if (heldSource !== null) {
          clearAnimationState(heldSource);
          moveTile(heldSource, planned.x, planned.y);
          transient.push(heldSource.element);

          continue;
        }

        const builtSource = buildTile(source, origin, theme);

        if (builtSource === null) {
          continue;
        }

        layer.appendChild(builtSource.element);
        transient.push(builtSource.element);
        deferred.push((): void => {
          moveTile(builtSource, planned.x, planned.y);
        });
      }
    }

    // A node standing at this cell, already dressed for this value, is reused
    // where the tile neither moved nor merged nor spawned.
    const standing =
      planned.merged.length === 0 ? claimTile(index, planned.value) : null;

    if (standing !== null) {
      clearAnimationState(standing);
      moveTile(standing, planned.x, planned.y);
      claimed.set(index, standing);
      paintedTiles.push({ element: standing.element, value: standing.value });

      return;
    }

    const built = buildTile(planned, planned, theme);

    if (built === null) {
      return;
    }

    // L73-L83: the merged tile pops and a spawned tile appears.
    built.element.classList.add(
      planned.merged.length > 0 ? MERGED_TILE_CLASS : NEW_TILE_CLASS,
    );
    layer.appendChild(built.element);
    claimed.set(index, built);
    paintedTiles.push({ element: built.element, value: built.value });
  };

  /**
   * Tracks the score delta. Writes nothing: the score outlets and the
   * `.score-addition` element belong to src/ui/components/score-panel.ts,
   * which src/ui/screens/hud.ts mounts.
   *
   * The delta is the difference against the score of the previous paint, which
   * is the quantity js/html_actuator.js L106-L110 computed against the score
   * it held from L7. The held score is replaced on every call, so a caller
   * that discards a delta cannot make a later one wrong.
   *
   * @returns The delta, which is `0` or negative where the score did not
   *   rise.
   */
  const trackScoreDelta = (score: number): number => {
    const difference = score - shownScore;

    shownScore = score;

    return difference;
  };

  const paintCells = (plan: PaintPlan, theme: Theme): RenderedCell[] => {
    const size = plan.size;

    occupants.clear();

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

    // L14 emptied the tile layer. The nodes are reconciled instead: the
    // transient nodes of the previous paint — the two sources beneath a merge,
    // which L14 was what removed — go now, and every retained node is either
    // claimed by the walk below or removed after it.
    for (const element of transient) {
      element.remove();
    }

    transient = [];
    paintedTiles = [];
    claimed.clear();

    for (const planned of plan.tiles) {
      drawTile(planned, theme);
    }

    for (const held of retained.values()) {
      held.element.remove();
    }

    retained.clear();

    for (const [index, held] of claimed) {
      retained.set(index, held);
    }

    const cells = paintCells(plan, theme);

    // Tracked, not written: the score outlets and the terminal overlay belong
    // to src/ui/screens/hud.ts, which subscribes to the same commit
    // independently of which renderer draws the board.
    const scoreDelta = trackScoreDelta(plan.score);

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
      degraded: plan.degraded,
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

  /** Released by `dispose`; `null` where no theme change is followed. */
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

  /**
   * Reads the coordinate a parallel-board cell holds focus on.
   *
   * The layer marks each counterpart with the cell coordinates as data
   * attributes, which is what makes the handoff possible without importing that
   * module.
   *
   * @param board The parallel board host.
   * @returns The focused coordinate, or `null` where focus is elsewhere.
   */
  const readParallelFocus = (board: Element): CarriedFocus | null => {
    const active = owner?.activeElement ?? null;

    if (active === null || !board.contains(active)) {
      return null;
    }

    const x = Number(active.getAttribute(PARALLEL_CELL_X_ATTRIBUTE));
    const y = Number(active.getAttribute(PARALLEL_CELL_Y_ATTRIBUTE));

    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
      return null;
    }

    return { x, y, focused: true };
  };

  /**
   * Takes the parallel accessibility board out of the accessibility tree for
   * as long as this renderer holds a semantic lattice of its own.
   *
   * @returns The coordinate the parallel board held focus on, for this lattice
   *   to adopt, or `null` where it held none.
   */
  const claimParallelBoard = (): CarriedFocus | null => {
    if (parallelBoard !== null) {
      return null;
    }

    const board = options.parallelBoard ?? null;

    if (board === null) {
      return null;
    }

    const handedOver = readParallelFocus(board);
    const element = asHtmlElement(board);

    parallelBoard = board;
    parallelBoardState = {
      hidden: element === null ? false : element.hidden,
      ariaHidden: board.getAttribute('aria-hidden'),
      ariaBusy: board.getAttribute('aria-busy'),
    };

    // Hidden, never emptied. The children of this element belong to
    // `ParallelBoardLayer` in src/ui/a11y/focus-manager.ts, which holds a
    // reference to every cell it built: removing them left that layer holding
    // detached nodes while `isMounted` still reported `true`, and restoring
    // attributes alone never gave them back.
    board.setAttribute('aria-hidden', 'true');
    board.removeAttribute('aria-busy');

    if (element !== null) {
      element.hidden = true;
    }

    // Where the caller handed in the layer itself, it is unmounted through its
    // OWN api, so its state stays truthful and a later `mount` rebuilds.
    parallelBoardLayer?.unmount();

    reporter.onCount({
      name: PARALLEL_BOARD_METRIC,
      value: 1,
      detail: Object.freeze({ claimed: true, handedOver: handedOver !== null }),
    });

    return handedOver;
  };

  /**
   * Restores the parallel accessibility board to the state it was found in.
   *
   * @param carried The coordinate this lattice's tab stop stood on, so the layer
   *   taking the board back resumes on the same cell. Focus is moved only where
   *   this lattice was the surface holding it.
   */
  const releaseParallelBoard = (carried: CarriedFocus | null = null): void => {
    const board = parallelBoard;
    const state = parallelBoardState;

    parallelBoard = null;
    parallelBoardState = null;

    if (board === null || state === null) {
      return;
    }

    if (state.ariaHidden === null) {
      board.removeAttribute('aria-hidden');
    } else {
      board.setAttribute('aria-hidden', state.ariaHidden);
    }

    if (state.ariaBusy === null) {
      board.removeAttribute('aria-busy');
    } else {
      board.setAttribute('aria-busy', state.ariaBusy);
    }

    const element = asHtmlElement(board);

    if (element !== null) {
      element.hidden = state.hidden;
    }

    let remounted = false;

    if (parallelBoardLayer !== null && !parallelBoardLayer.isMounted()) {
      remounted = parallelBoardLayer.mount(
        board,
        latticeSize > 0 ? latticeSize : readConfiguredSize(),
      );
    }

    // THE COORDINATE CROSSES BACK. A swap away from this renderer discards its
    // lattice, so a player reading the board on one cell would otherwise return
    // to a board with nothing focused. Moved only where this lattice held focus:
    // taking focus from elsewhere would be a steal. DL-FOCUS-04.
    if (remounted && carried?.focused === true) {
      const place = parallelBoardLayer?.focusCell;

      // Called through its owner, and only where the layer publishes it.
      place?.call(parallelBoardLayer, carried.x, carried.y);
    }

    reporter.onCount({
      name: PARALLEL_BOARD_METRIC,
      value: 1,
      detail: Object.freeze({ claimed: false, handedBack: carried !== null }),
    });
  };

  const unmount = (): void => {
    const mountedHost = host;

    if (mountedHost === null) {
      return;
    }

    // READ BEFORE THE LATTICE GOES, and handed to `releaseParallelBoard()` below
    // so the layer taking the board back opens on the same cell. DL-FOCUS-04.
    const carried = carriedFocus();

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

    closeScale();
    releaseParallelBoard(carried);

    host = null;
    hostElement = null;
    gridLayer = null;
    tileLayer = null;
    cellElements = [];
    latticeSize = 0;
    activeCellIndex = 0;
    paintedTiles = [];
    deferred = [];

    retained.clear();
    claimed.clear();
    transient = [];

    reporter.onCount({ name: UNMOUNT_METRIC, value: 1 });
  };

  const mount = (requested?: Element | null): boolean => {
    if (disposed) {
      return false;
    }

    const next = requested ?? options.host ?? null;

    unmount();

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
      // index.html ships the layer with `hidden`, which style/main.scss reads
      // as `display: none`.
      hostWasHidden = hostElement.hidden;
      hostElement.hidden = false;
    }

    const canvasElement = asHtmlElement(options.canvas);

    if (canvasElement !== null) {
      // Nothing draws into the canvas layer while the board is drawn as DOM
      // elements.
      canvasWasHidden = canvasElement.hidden;
      canvasElement.hidden = true;
    }

    // Followed before the lattice is built, so the first transforms are
    // written from the scale that is actually in force.
    openScale();

    // Built at the configured size so the board is present before the first
    // commit; a commit carrying another size rebuilds it.
    buildLayers(readConfiguredSize());

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

  const render = (commit: StateCommitEvent): void => {
    if (disposed) {
      return;
    }

    // `planCommit` walks the board twice at `size` by `size`, so the edge a
    // commit carries is measured against MAX_BOARD_SIZE of
    // src/config/default-config.ts before the plan is built.
    if (!isSupportedBoardSize(commit.board.size)) {
      reporter.onCount({
        name: REFUSED_SIZE_METRIC,
        value: 1,
        detail: Object.freeze({
          size: commit.board.size,
          maximum: MAX_BOARD_SIZE,
        }),
      });

      reporter.onDiagnostic({
        level: 'error',
        source: DIAGNOSTIC_SOURCE,
        message:
          'The number-only board refused a commit whose board size is above ' +
          'the supported maximum and kept the board it had painted',
        detail: Object.freeze({
          size: commit.board.size,
          maximum: MAX_BOARD_SIZE,
          latticeSize,
        }),
      });

      return;
    }

    // `planCommit` consumes the detached projection the event carries here,
    // inside the emission, and the plan it returns is what the next frame
    // paints; no part of the payload is retained past this call.
    queued = planCommit(commit);

    reporter.onCount({
      name: RENDER_METRIC,
      value: 1,
      detail: Object.freeze({ size: queued.size, tiles: queued.tiles.length }),
    });

    options.onWork?.();
  };

  const frame = (): boolean => {
    const plan = queued;

    if (plan !== null) {
      queued = null;
      deferred = [];
      paint(plan);

      // The vanilla actuator nested a second `requestAnimationFrame` inside
      // the first, so a position rewrite ran on the frame after the one that
      // drew the tile.
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

  const subscribe = (events: EngineEvents): EngineEventSubscription => {
    if (disposed) {
      reporter.onCount({
        name: REFUSED_SUBSCRIBE_METRIC,
        value: 1,
        detail: Object.freeze({ phase: 'before' }),
      });

      reporter.onDiagnostic({
        level: 'warning',
        source: DIAGNOSTIC_SOURCE,
        message:
          'A subscription to the number-only renderer was refused because ' +
          'the renderer is disposed. No listener was registered and the ' +
          'returned handle releases nothing.',
      });

      return (): void => {
        // Nothing was registered, so there is nothing to release.
      };
    }

    const release = events.on('state:commit', render);

    // `events.on` can dispose this renderer before it returns, by way of a
    // listener the same emitter already holds.
    if (disposed) {
      release();

      reporter.onCount({
        name: REFUSED_SUBSCRIBE_METRIC,
        value: 1,
        detail: Object.freeze({ phase: 'during' }),
      });

      reporter.onDiagnostic({
        level: 'warning',
        source: DIAGNOSTIC_SOURCE,
        message:
          'A subscription to the number-only renderer was released as soon ' +
          'as it was registered, because the renderer was disposed while ' +
          'the registration was in flight.',
      });

      return (): void => {
        // Already released above.
      };
    }

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

    readRenderedBoard: (): RenderedBoard | null => rendered,

    focusedCell: (): BoardFocus | null => carriedFocus(),

    dispose,
    destroy: dispose,
  });
}
