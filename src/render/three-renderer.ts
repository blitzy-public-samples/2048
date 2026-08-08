// The 2.5D board renderer: the replacement for js/html_actuator.js.
//
// AAP R1 and R7. The vanilla actuator was PUSHED to — js/game_manager.js L91
// held a reference to it and called `actuate(grid, metadata)` at the end of
// every turn. This module inverts that: it SUBSCRIBES to the engine's events
// and the engine holds no reference to it, which is the whole point of the
// engine/renderer split and the reason this file exists rather than the
// actuator being patched to host 3D.
//
// WHAT IT OWNS, AND WHAT IT DOES NOT
//   It owns the board and nothing else. The score outlets, the rising score
//   delta and the terminal overlay belong to src/ui/screens/hud.ts, which
//   subscribes to the same `state:commit` independently; selecting this
//   renderer instead of the number-only one therefore changes what draws the
//   board and nothing more.
//
//   It also owns the OUTPUT SURFACE: the canvas host is looked up and guarded
//   here, so the `WebGLRenderer`, its pixel ratio, its clear colour, its
//   drawing-buffer size and its context-loss listeners are held here as well.
//   src/render/scene.ts builds the scene graph, the camera and the lighting rig
//   and constructs no renderer.
//
// THE PARALLEL ACCESSIBILITY BOARD
//   `#board-canvas` carries `aria-hidden="true"` and is one opaque node to
//   assistive technology: a screen reader perceives the entire 2.5D board as a
//   single block. This renderer therefore MOUNTS and updates the parallel
//   `role="grid"` layer beside the canvas rather than claiming it, which is the
//   mirror image of what src/render/number-only-renderer.ts does — that
//   renderer's own lattice carries the semantics, so it takes the parallel
//   layer down. Exactly one of the two lattices is exposed at a time, and each
//   renderer hands the surface over through the layer's own api.
//
// HOW A TURN IS DRAWN
//   `state:commit` carries the live board, and every animation the vanilla
//   actuator ran is derivable from it: `previousPosition` says a tile moved,
//   `mergedFrom` says it is the product of a merge and carries the two tiles
//   that produced it, and a tile with neither is a spawn. The plan is built
//   INSIDE the emission, because the next turn mutates the same objects, and
//   applied on the next frame. `tile:merge` is subscribed to as well, for the
//   particle burst and the camera punch: it fires once per merge with the
//   `resultValue` an `onMerge` relic handler may have transformed, which the
//   commit's board cannot report per merge.
//
// MOTION PARITY
//   The tweens are the stylesheet's own keyframes over the stylesheet's own
//   timing, built by src/render/animations.ts: a move is `100ms ease-in-out`, a
//   spawn is `appear` over `200ms ease` after a `100ms` hold at scale zero, and
//   a merge is `pop` over the same cadence overshooting to 1.2. The 2D game
//   therefore feels the same rendered as blocks.
//
//   The 100ms hold at scale zero is load-bearing rather than decorative: the
//   two tiles a merge consumed finish their slide exactly as the merged block
//   begins to grow, so the three blocks never occupy one cell at full size and
//   no depth test has to break the tie.
//
// REDUCED MOTION
//   Every animating member follows the effective preference of
//   src/render/webgl-support.ts on its own: a tween built while motion is to be
//   reduced starts complete, a particle burst is refused outright, and a camera
//   effect is suppressed. Nothing here re-implements that decision.
//
// This module reads no storage and consumes no randomness.

import { Color, SRGBColorSpace, WebGLRenderer } from 'three';
import type { Vector3 } from 'three';

import { isSupportedBoardSize } from '../config/default-config';
import type { EngineEvents, EngineEventSubscription } from '../engine/engine-events';
import type { StateCommitEvent, TileMergeEvent } from '../engine/engine-events';
import type { RulesConfig } from '../config/rules-config';
import { DEFAULT_BOARD_SIZE } from '../config/default-config';
import { mobileThreshold } from '../theme/tokens';
import type { GeometryScale, ScaleName } from '../theme/tokens';
import {
  getActiveTheme,
  getTheme,
  isThemeId,
  resolveTileTheme,
  subscribeToThemeChange,
} from '../theme/themes';
import type { Theme, ThemeId } from '../theme/themes';
import {
  createMergeTween,
  createMoveTween,
  createSpawnTween,
  createTweenGroup,
  requiresMoveTween,
} from './animations';
import type {
  MergeTweenValue,
  MoveTweenValue,
  SpawnTweenValue,
  Tween,
  TweenGroup,
} from './animations';
import { createCameraEffects } from './camera-effects';
import type { CameraEffects } from './camera-effects';
import type { FrameContext } from './render-loop';
import { createParticleSystem } from './particles';
import type { ParticleSystem } from './particles';
import { createScene } from './scene';
import type { BoardScene } from './scene';
import { createTileMaterialCache } from './tile-materials';
import type { TileMaterialCache } from './tile-materials';
import {
  cellToWorldIn,
  createTileMeshFactory,
  resolveBoardGeometry,
} from './tile-mesh-factory';
import type { BoardMeshes, TileMesh, TileMeshFactory } from './tile-mesh-factory';
import type { RenderedBoard, RenderedCell } from './number-only-renderer';
import { numberOnlyRendererCopy } from './number-only-renderer';
import type { RenderDetail, RenderReporter } from './webgl-support';
import {
  NOOP_RENDER_REPORTER,
  attachContextLossHandlers,
  createGuardedRenderReporter,
  describeRenderError,
} from './webgl-support';

/* ==========================================================================
 * 1. Names carried into reports
 * ========================================================================== */

const DIAGNOSTIC_SOURCE = 'render/three-renderer';

/** Counter raised once per mount. */
const MOUNT_METRIC = 'render.three.mount';

/** Counter raised once per unmount. */
const UNMOUNT_METRIC = 'render.three.unmount';

/** Counter raised once per commit accepted into the queue. */
const RENDER_METRIC = 'render.three.render';

/** Counter raised once per plan applied to the scene. */
const PAINT_METRIC = 'render.three.paint';

/** Counter raised once per board generated. */
const BOARD_METRIC = 'render.three.board';

/** Counter raised once per commit refused for its board size. */
const REFUSED_SIZE_METRIC = 'render.three.size.refused';

/** Counter raised once per subscription refused after disposal. */
const REFUSED_SUBSCRIBE_METRIC = 'render.three.subscribe.refused';

/** Counter raised once per mount that found no canvas to draw into. */
const MISSING_CANVAS_METRIC = 'render.three.canvas.missing';

/** Counter raised once per claim or release of the parallel board. */
const PARALLEL_BOARD_METRIC = 'render.three.parallelBoard';

/** Counter raised once per theme change the renderer repainted for. */
const THEME_CHANGE_METRIC = 'render.three.theme.change';

/** Counter raised once per resize applied to the drawing surface. */
const RESIZE_METRIC = 'render.three.resize';

/** Counter raised once per failed WebGL context acquisition. */
const CONTEXT_FAILED_METRIC = 'render.three.context.failed';

/** Counter raised once per merge recorded for its burst and punch. */
const MERGE_METRIC = 'render.three.merge';

/* ==========================================================================
 * 2. The drawing buffer
 * ========================================================================== */

/**
 * Alpha the drawing buffer is cleared to.
 *
 * Zero: the canvas replaces z-index layers 1 and 2 of style/main.scss —
 * `.grid-container` at L254 and `.tile-container` at L288 — which were drawn
 * inside `.game-container`, and its own background at style/main.scss L188 is
 * what shows through every pixel the tilted board does not cover.
 */
const CLEAR_ALPHA = 0;

/**
 * Highest device pixel ratio the drawing buffer is sized at. Above it the
 * buffer grows fourfold for a board of flat fills.
 */
const MAX_PIXEL_RATIO = 2;

/** Pixel ratio used where the platform reports none. */
const DEFAULT_PIXEL_RATIO = 1;

/**
 * The device pixel ratio the drawing buffer is sized at.
 *
 * @returns The platform's ratio, confined to `MAX_PIXEL_RATIO`, and
 *   `DEFAULT_PIXEL_RATIO` where the platform reports none or reports one that
 *   is not a positive finite number.
 */
function resolvePixelRatio(): number {
  const candidate =
    typeof globalThis.devicePixelRatio === 'number'
      ? globalThis.devicePixelRatio
      : DEFAULT_PIXEL_RATIO;

  if (!Number.isFinite(candidate) || candidate <= 0) {
    return DEFAULT_PIXEL_RATIO;
  }

  return Math.min(candidate, MAX_PIXEL_RATIO);
}

/* ==========================================================================
 * 3. Geometry scale
 * ========================================================================== */

/**
 * The breakpoint of style/main.scss, as a media query.
 *
 * `smaller($mobile-threshold)` compiles to `(max-width: 520px)`, and
 * `mobileThreshold` of src/theme/tokens.ts is the port of that token, so the
 * scale this renderer resolves lengths at and the scale the stylesheet lays the
 * page out at cannot disagree.
 */
const MOBILE_SCALE_QUERY = `(max-width: ${mobileThreshold}px)`;

/** The part of `MediaQueryList` this module reads. */
interface ScaleQueryList {
  readonly matches: boolean;
  readonly addEventListener?: (type: 'change', listener: () => void) => void;
  readonly removeEventListener?: (
    type: 'change',
    listener: () => void,
  ) => void;
  readonly addListener?: (listener: () => void) => void;
  readonly removeListener?: (listener: () => void) => void;
}

/**
 * Narrows a value to a media-query list.
 *
 * A stand-in `matchMedia` that returns something else is refused here rather
 * than read, so a host whose implementation is partial resolves the default
 * scale instead of throwing during mount.
 */
function isScaleQueryList(value: unknown): value is ScaleQueryList {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  return typeof (value as { matches?: unknown }).matches === 'boolean';
}

/**
 * Opens the breakpoint query against one view.
 *
 * @param view View to query. A view without `matchMedia` yields `null`.
 * @returns The list, or `null` where the query could not be opened.
 */
function openScaleQuery(view: Window | null): ScaleQueryList | null {
  if (view === null || typeof view.matchMedia !== 'function') {
    return null;
  }

  try {
    const list: unknown = view.matchMedia(MOBILE_SCALE_QUERY);

    return isScaleQueryList(list) ? list : null;
  } catch {
    // A throwing `matchMedia` is a host defect, not a board defect: the
    // default scale stands and the board still draws.
    return null;
  }
}

/* ==========================================================================
 * 4. The surfaces this renderer drives
 * ========================================================================== */

/** One cell of the parallel accessibility board. */
export interface ParallelBoardCell {
  readonly x: number;
  readonly y: number;

  /** Face value, or `null` where the cell is empty. */
  readonly value: number | null;
}

/**
 * The part of `ParallelBoardLayer` this renderer drives.
 *
 * Declared structurally, and satisfied by `ParallelBoardLayer` of
 * src/ui/a11y/focus-manager.ts, so the render layer names the surface it hands
 * the semantics to without importing the accessibility layer.
 */
export interface ParallelBoardSurface {
  /** Whether the layer holds a resolved host and built cells. */
  isMounted(): boolean;

  /** Cells per row currently built, or `0` while unmounted. */
  boardSize(): number;

  /** Resolves the host and builds the cell counterparts. */
  mount(host: Element | string | null | undefined, boardSize: number): boolean;

  /** Tears the counterparts down and recreates them at a new size. */
  rebuild(boardSize: number): boolean;

  /** Applies the board's contents. Any cell absent from the list is empty. */
  update(cells: readonly ParallelBoardCell[]): void;

  /** Removes the counterparts and releases the host. */
  unmount(): void;
}

/**
 * The cell naming carried into `readRenderedBoard()`.
 *
 * The two functions are src/render/number-only-renderer.ts's own, so a consumer
 * reading a rendered board names a cell identically no matter which renderer
 * drew it.
 */
export type BoardCellCopy = {
  readonly cellLabel: (row: number, column: number, value: number) => string;
  readonly emptyCellLabel: (row: number, column: number) => string;
};

/** The default cell naming. */
export const threeRendererCopy: BoardCellCopy = Object.freeze({
  cellLabel: numberOnlyRendererCopy.cellLabel,
  emptyCellLabel: numberOnlyRendererCopy.emptyCellLabel,
});

/* ==========================================================================
 * 5. Construction parameters
 * ========================================================================== */

/**
 * Every construction parameter. `canvas` is the only one a working renderer
 * needs; each of the rest either has a default or leaves one capability out.
 */
export interface ThreeRendererOptions {
  /**
   * The WebGL surface, as an element. Resolved at construction so a caller
   * that has already probed for support decides whether to construct at all.
   */
  readonly canvas?: Element | null;

  /**
   * The number-only host, hidden while this renderer draws. Handed in so the
   * two board layers of index.html are mutually exclusive without either
   * renderer reaching for the other's element by selector.
   */
  readonly numberOnlyHost?: Element | null;

  /** The parallel accessibility board's host element. */
  readonly parallelBoard?: Element | null;

  /**
   * The layer that owns the parallel board's cells. Handed in so the semantics
   * are mounted through the layer's own api and its mounted state stays
   * truthful.
   */
  readonly parallelBoardLayer?: ParallelBoardSurface | null;

  /** Document elements are resolved against. Defaults to the ambient one. */
  readonly ownerDocument?: Document;

  /**
   * The rules in force. Read for `boardSize` alone, so the board is generated
   * at mount rather than deferred to the first commit.
   */
  readonly config?: RulesConfig;

  /**
   * Geometry scale lengths resolve at. `'auto'`, the default, follows
   * `MOBILE_SCALE_QUERY` and re-resolves when the breakpoint is crossed.
   */
  readonly scale?: ScaleName | 'auto';

  /** Palette the materials are built from. Defaults to the active theme. */
  readonly theme?: Theme | ThemeId;

  /** Sink this renderer reports through. Wrapped so no channel can throw. */
  readonly reporter?: RenderReporter;

  /** The cell naming carried into `readRenderedBoard()`. */
  readonly copy?: Partial<BoardCellCopy>;

  /**
   * Called whenever the renderer has work for the next frame, so a loop that
   * stops when idle is woken. Defaults to doing nothing.
   */
  readonly onWork?: () => void;
}

/** What one renderer has done and where it stands. */
export interface ThreeRendererStats {
  readonly mounted: boolean;
  readonly boardSize: number;
  readonly scale: ScaleName;
  readonly themeId: ThemeId;
  readonly commits: number;
  readonly paints: number;
  readonly boardsBuilt: number;
  readonly liveTiles: number;
  readonly activeTweens: number;

  /** Merges awaiting the frame that starts their animation. */
  readonly pendingMerges: number;
  readonly refusedSizes: number;
  readonly contextLost: boolean;
  readonly disposed: boolean;
}

/**
 * The 2.5D board renderer.
 *
 * Frozen: the members below are its whole surface, and they are deliberately
 * the same set src/render/number-only-renderer.ts exposes, so the composition
 * root drives either renderer through one shape.
 */
export interface ThreeRenderer {
  readonly mounted: boolean;

  /**
   * Acquires the WebGL context, generates the board and mounts the parallel
   * accessibility layer.
   *
   * @param canvas Canvas to draw into. Defaults to the one given at
   *   construction.
   * @returns Whether the renderer mounted. A miss is reported and leaves every
   *   other method a working no-op, which is the path a caller that skipped the
   *   support probe lands on.
   */
  mount(canvas?: Element | null): boolean;

  /** Releases the context, the meshes and the parallel layer. */
  unmount(): void;

  /** Subscribes to the engine. */
  subscribe(events: EngineEvents): EngineEventSubscription;

  /** Queues one commit. Called by the subscription; public for tests. */
  render(commit: StateCommitEvent): void;

  /**
   * Advances one frame: applies a queued commit, steps every tween, and draws.
   *
   * @param context The loop's frame context. Absent, the delta is measured
   *   from this renderer's own last frame.
   * @returns Whether work is outstanding for the next frame.
   */
  frame(context?: FrameContext): boolean;

  /** The board as last drawn, as plain data, or `null` before the first. */
  readRenderedBoard(): RenderedBoard | null;

  dispose(): void;
  destroy(): void;
  readStats(): ThreeRendererStats;
}

/* ==========================================================================
 * 6. Plan built from one commit
 * ========================================================================== */

type CommitBoard = StateCommitEvent['board'];

type CommitTile = NonNullable<CommitBoard['cells'][number][number]>;

/** A cell coordinate pair, as plain data. */
interface PlannedPosition {
  readonly x: number;
  readonly y: number;
}

/** One tile of a plan, and the two tiles a merge consumed. */
interface PlannedTile {
  readonly value: number;
  readonly x: number;
  readonly y: number;

  /** Where it started the turn, or `null` where it did not exist before it. */
  readonly from: PlannedPosition | null;

  /** The two tiles a merge consumed, empty for every other tile. */
  readonly merged: readonly PlannedTile[];
}

/** Everything one commit asks to be drawn. */
interface PaintPlan {
  readonly size: number;
  readonly tiles: readonly PlannedTile[];
  readonly score: number;
  readonly scoreDelta: number;
  readonly bestScore: StateCommitEvent['bestScore'];
  readonly over: boolean;
  readonly won: boolean;
  readonly terminated: boolean;

  /**
   * Set on a plan queued to redraw the board the commit already drew, rather
   * than to draw a turn. `restPlan` builds one.
   */
  readonly repaint?: boolean;
}

/**
 * The same plan, with every animation input removed.
 *
 * A tile whose `from` is its own cell takes no move tween, and one carrying
 * neither a `from` nor a merge pair would be taken for a spawn, so each tile
 * carries its own cell as its origin and no merge pair: every block is placed
 * where it already stands and no tween starts. Queued when the board is
 * generated again at the other scale, where the lattice is rebuilt outside a
 * turn and the blocks that stood on it have been recalled with it.
 */
function restPlan(plan: PaintPlan): PaintPlan {
  return {
    ...plan,
    repaint: true,
    tiles: plan.tiles.map((tile) => ({
      value: tile.value,
      x: tile.x,
      y: tile.y,
      from: { x: tile.x, y: tile.y },
      merged: [],
    })),
  };
}

function readCell(board: CommitBoard, x: number, y: number): CommitTile | null {
  const column = board.cells.at(x);

  if (column === undefined) {
    return null;
  }

  return column.at(y) ?? null;
}

/**
 * Projects one live tile, and the pair it was merged from, into plain data.
 *
 * `previousPosition` and `mergedFrom` are read here, inside the emission that
 * carried the tile, because the next turn mutates the same objects.
 */
function planTile(tile: CommitTile): PlannedTile {
  const previous = tile.previousPosition;

  return {
    value: tile.value,
    x: tile.x,
    y: tile.y,
    from: previous === null ? null : { x: previous.x, y: previous.y },

    // js/html_actuator.js L60-L65 drew the two source tiles by the same path it
    // drew every other tile, so the pair is planned the same way. Each source
    // carries its own `previousPosition` and the merge cell as its position, so
    // each slides from where it started to where the merge happened.
    merged:
      previous === null && tile.mergedFrom !== null
        ? tile.mergedFrom.map(planTile)
        : [],
  };
}

/**
 * Builds the plan for one commit.
 *
 * @param commit The commit, read synchronously.
 * @param scoreDelta Amount this commit added to the score.
 */
function planCommit(commit: StateCommitEvent, scoreDelta: number): PaintPlan {
  const board = commit.board;
  const size = board.size;
  const tiles: PlannedTile[] = [];

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

  return Object.freeze({
    size,
    tiles: Object.freeze(tiles),
    score: commit.score,
    scoreDelta,
    bestScore: commit.bestScore,
    over: commit.over,
    won: commit.won,
    terminated: commit.terminated,
  });
}

/* ==========================================================================
 * 7. One block on screen
 * ========================================================================== */

/**
 * A block the scene holds, and the tweens driving it.
 *
 * `retireOnArrival` marks the two blocks a merge consumed: each finishes its
 * slide exactly as the merged block starts to grow, and is released then rather
 * than being left inside the block that replaced it.
 */
interface LiveTile {
  readonly mesh: TileMesh;
  readonly value: number;
  readonly target: PlannedPosition;
  readonly move: Tween<MoveTweenValue> | null;
  readonly spawn: Tween<SpawnTweenValue> | null;
  readonly merge: Tween<MergeTweenValue> | null;
  readonly retireOnArrival: boolean;
}

/** A merge awaiting the frame that starts its animation. */
interface PendingMerge {
  readonly x: number;
  readonly y: number;
  readonly value: number;
}

/* ==========================================================================
 * 8. Element resolution
 * ========================================================================== */

/**
 * Narrows an element to an `HTMLElement`, by the members this module writes.
 *
 * `instanceof` is avoided so an element from another realm, and a stand-in in a
 * test, are both accepted.
 */
/**
 * The `hidden` states an element can carry.
 *
 * Typed from the property, which carries the attribute's `until-found` value
 * alongside the two boolean states, so an element that shipped in that state is
 * restored to it rather than flattened to `false`.
 */
type HiddenState = HTMLElement['hidden'];

function asHtmlElement(value: Element | null | undefined): HTMLElement | null {
  if (value === null || value === undefined) {
    return null;
  }

  const candidate = value as { hidden?: unknown; style?: unknown };

  return typeof candidate.hidden === 'boolean' &&
    typeof candidate.style === 'object'
    ? (value as HTMLElement)
    : null;
}

/**
 * Narrows an element to a canvas, by the one method this module calls on it.
 *
 * `getContext` is what `WebGLRenderer` reaches for, so an element that carries
 * it is one this renderer can draw into and an element that does not is refused
 * before a context is requested.
 */
function asCanvas(value: Element | null | undefined): HTMLCanvasElement | null {
  if (value === null || value === undefined) {
    return null;
  }

  return typeof (value as { getContext?: unknown }).getContext === 'function'
    ? (value as HTMLCanvasElement)
    : null;
}

/** The measured size of one element, or `null` where it has none yet. */
function measureElement(
  element: Element,
): { readonly width: number; readonly height: number } | null {
  const width = element.clientWidth;
  const height = element.clientHeight;

  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  return { width, height };
}

/* ==========================================================================
 * 9. Construction
 * ========================================================================== */

/**
 * Builds the 2.5D renderer.
 *
 * The WebGL context is acquired by `mount()`, not here, so a caller can
 * construct the renderer, read its stats and dispose it on a machine with no
 * context at all.
 *
 * @param options Canvas, surfaces, rules, scale, palette and report sink.
 * @returns A frozen renderer holding no context.
 *
 * @example
 * ```ts
 * const renderer = createThreeRenderer({ canvas, config, parallelBoardLayer });
 * renderer.mount();
 * const release = renderer.subscribe(engine.events);
 * loop.addFrameCallback((context) => renderer.frame(context));
 * ```
 */
export function createThreeRenderer(
  options: ThreeRendererOptions = {},
): ThreeRenderer {
  const reporter = createGuardedRenderReporter(
    options.reporter ?? NOOP_RENDER_REPORTER,
  );
  const copy: BoardCellCopy = Object.freeze({
    cellLabel: options.copy?.cellLabel ?? threeRendererCopy.cellLabel,
    emptyCellLabel:
      options.copy?.emptyCellLabel ?? threeRendererCopy.emptyCellLabel,
  });

  const owner =
    options.ownerDocument ??
    (typeof document === 'undefined' ? null : document);

  const parallelBoardLayer = options.parallelBoardLayer ?? null;
  const requestedScale = options.scale ?? 'auto';

  let canvas: HTMLCanvasElement | null = null;

  // The output surface is owned HERE, beside the canvas host this module looks
  // up and guards: src/render/scene.ts builds the scene, the camera and the
  // lights alone and constructs no renderer.
  let webgl: WebGLRenderer | null = null;
  let releaseContextLoss: (() => void) | null = null;
  let contextLost = false;
  let scene: BoardScene | null = null;
  let materials: TileMaterialCache | null = null;
  let factory: TileMeshFactory | null = null;
  let particles: ParticleSystem | null = null;
  let camera: CameraEffects | null = null;
  let tweens: TweenGroup | null = null;
  let board: BoardMeshes | null = null;
  let geometry: GeometryScale | null = null;
  let scaleQuery: ScaleQueryList | null = null;
  let releaseScaleQuery: (() => void) | null = null;
  let releaseTheme: (() => void) | null = null;
  let releaseResize: (() => void) | null = null;

  let numberOnlyWasHidden: HiddenState = false;
  let parallelBoardClaimed = false;
  let parallelBoardState: {
    readonly hidden: HiddenState;
    readonly ariaHidden: string | null;
  } | null = null;

  const live: LiveTile[] = [];
  const pendingMerges: PendingMerge[] = [];
  const subscriptions: EngineEventSubscription[] = [];
  const worldScratch: Vector3[] = [];

  let queued: PaintPlan | null = null;

  /**
   * The plan the scene currently shows.
   *
   * Retained so a palette switch can re-project the board a consumer reads
   * without waiting for the next turn; it holds no reference to any live tile.
   */
  let lastPlan: PaintPlan | null = null;
  let rendered: RenderedBoard | null = null;
  let lastScore = 0;
  let lastFrameAt: number | null = null;
  let boardSize = 0;
  let commits = 0;
  let paints = 0;
  let boardsBuilt = 0;
  let refusedSizes = 0;
  let mounted = false;
  let disposed = false;

  /* ------------------------------------------------------------------
   * Scale and geometry
   * --------------------------------------------------------------- */

  const resolveScale = (): ScaleName => {
    if (requestedScale !== 'auto') {
      return requestedScale;
    }

    return scaleQuery !== null && scaleQuery.matches ? 'mobile' : 'desktop';
  };

  const readConfiguredSize = (): number => {
    const configured = options.config?.boardSize ?? DEFAULT_BOARD_SIZE;

    return isSupportedBoardSize(configured) ? configured : DEFAULT_BOARD_SIZE;
  };

  /* ------------------------------------------------------------------
   * The output surface
   * --------------------------------------------------------------- */

  /** Scratch a theme's page background is read into. */
  const clearColor = new Color();

  /**
   * The theme the surface and the scene are pinned to, where one was supplied.
   *
   * `options.theme` accepts a catalogue entry or an id; the scene's rig and the
   * clear colour both read a palette, so an id is resolved once here.
   *
   * @returns The pinned theme, or `undefined` where the renderer follows the
   *   theme in force.
   */
  const readPinnedTheme = (): Theme | undefined => {
    const supplied = options.theme;

    if (supplied === undefined) {
      return undefined;
    }

    return isThemeId(supplied) ? getTheme(supplied) : supplied;
  };

  /**
   * Builds the renderer over one canvas.
   *
   * `alpha` is on and the clear alpha is zero, so the canvas is composited over
   * the `$game-container-background` of `.game-container` at style/main.scss
   * L188 rather than over a colour of its own. Shadow maps are left off; the
   * casters and receivers the 2D design has are flat fills.
   *
   * @throws Error when the canvas yields no WebGL context, which is the signal
   *   `mount()` converts into its number-only fallback.
   */
  const openSurface = (surface: HTMLCanvasElement): WebGLRenderer => {
    const renderer = new WebGLRenderer({
      canvas: surface,
      antialias: true,
      alpha: true,
    });

    renderer.setPixelRatio(resolvePixelRatio());
    renderer.shadowMap.enabled = false;

    return renderer;
  };

  /** Writes one theme's page background into the clear colour. */
  const applyClearColor = (theme: Theme): void => {
    const surface = webgl;

    if (surface === null) {
      return;
    }

    try {
      clearColor.setStyle(theme.palette.pageBackground, SRGBColorSpace);
      surface.setClearColor(clearColor, CLEAR_ALPHA);
    } catch (error: unknown) {
      reporter.onDiagnostic({
        level: 'warning',
        source: DIAGNOSTIC_SOURCE,
        message:
          'A theme background could not be read; the clear colour stands.',
        detail: Object.freeze({ theme: theme.id }),
        error: describeRenderError(error),
        thrown: error,
      });
    }
  };

  /* ------------------------------------------------------------------
   * Drawing-surface size
   * --------------------------------------------------------------- */

  /**
   * Pushes the canvas's measured size into the scene.
   *
   * A canvas the layout has not measured yet — which is every canvas under a
   * document with no layout engine — falls back to the field width, so the
   * frustum is always valid and the board is always framed.
   */
  const applySize = (): void => {
    const active = scene;
    const surface = canvas;

    if (active === null || surface === null || geometry === null) {
      return;
    }

    // The content box of `.game-container`, which is the box the canvas
    // occupies, is the fallback a canvas the layout has not measured yet takes —
    // which is every canvas under a document with no layout engine.
    const measured = measureElement(surface);
    const unmeasured = geometry.fieldWidth - geometry.gridSpacing * 2;
    const width = measured?.width ?? unmeasured;
    const height = measured?.height ?? unmeasured;

    // `false` for the third argument: the canvas's CSS size belongs to
    // style/main.scss, and writing it here would fight the layout.
    webgl?.setSize(width, height, false);

    if (active.resize(width, height)) {
      reporter.onCount({
        name: RESIZE_METRIC,
        value: 1,
        detail: Object.freeze({ width, height, measured: measured !== null }),
      });
    }
  };

  /* ------------------------------------------------------------------
   * Board generation
   * --------------------------------------------------------------- */

  /**
   * Generates the board at one size, releasing every block on screen first.
   *
   * `buildBoard` recalls every outstanding block into its pool, so the records
   * held here are dropped BEFORE it runs rather than left pointing at meshes
   * the factory considers idle.
   *
   * @returns Whether a board stands afterwards.
   */
  const ensureBoard = (size: number): boolean => {
    const activeFactory = factory;
    const activeScene = scene;

    if (activeFactory === null || activeScene === null) {
      return false;
    }

    const scale = resolveScale();
    const previous = board;

    if (previous !== null && previous.boardSize === size && geometry !== null) {
      return true;
    }

    live.length = 0;

    try {
      const built = activeFactory.buildBoard(size);

      board = built;
      boardSize = built.boardSize;
      geometry = built.geometry;
      activeScene.mountBoard(built.group);
      activeScene.reframe(built.boardSize, built.geometry);

      // Read off the scene's own rest transform rather than off the live
      // camera: a camera effect displaces the camera itself, so the live
      // transform stops being the framing's the moment one runs.
      camera?.setRestTransform(activeScene.readRestTransform());
      particles?.attachTo(built.group);
      applySize();

      boardsBuilt += 1;
      reporter.onCount({
        name: BOARD_METRIC,
        value: 1,
        detail: Object.freeze({ boardSize: built.boardSize, scale }),
      });

      return true;
    } catch (error: unknown) {
      board = null;
      boardSize = 0;
      geometry = null;

      reporter.onDiagnostic({
        level: 'error',
        source: DIAGNOSTIC_SOURCE,
        message: 'The board could not be generated; nothing is drawn.',
        detail: Object.freeze({ boardSize: size, scale }),
        error: describeRenderError(error),
      });

      return false;
    }
  };

  /* ------------------------------------------------------------------
   * The parallel accessibility board
   * --------------------------------------------------------------- */

  /**
   * Shows the parallel board and mounts its cells.
   *
   * The mirror image of what src/render/number-only-renderer.ts does: the
   * canvas is `aria-hidden` and cannot carry the board's semantics, so this
   * renderer needs the layer beside it populated rather than taken down.
   */
  const claimParallelBoard = (size: number): void => {
    const host = options.parallelBoard ?? null;

    if (host === null) {
      return;
    }

    if (!parallelBoardClaimed) {
      const element = asHtmlElement(host);

      parallelBoardClaimed = true;
      parallelBoardState = {
        hidden: element === null ? false : element.hidden,
        ariaHidden: host.getAttribute('aria-hidden'),
      };

      // Shown and exposed: this is the surface a screen reader reads the board
      // from while the canvas draws it. `aria-busy` belongs to the layer, which
      // clears it once the cells are populated.
      host.removeAttribute('aria-hidden');

      if (element !== null) {
        element.hidden = false;
      }

      reporter.onCount({
        name: PARALLEL_BOARD_METRIC,
        value: 1,
        detail: Object.freeze({ claimed: true, boardSize: size }),
      });
    }

    if (parallelBoardLayer === null) {
      return;
    }

    if (!parallelBoardLayer.isMounted()) {
      parallelBoardLayer.mount(host, size);

      return;
    }

    if (parallelBoardLayer.boardSize() !== size) {
      parallelBoardLayer.rebuild(size);
    }
  };

  /** Restores the parallel board to the state it was found in. */
  const releaseParallelBoard = (): void => {
    const host = options.parallelBoard ?? null;
    const state = parallelBoardState;

    parallelBoardClaimed = false;
    parallelBoardState = null;

    if (host === null || state === null) {
      return;
    }

    if (state.ariaHidden === null) {
      host.removeAttribute('aria-hidden');
    } else {
      host.setAttribute('aria-hidden', state.ariaHidden);
    }

    const element = asHtmlElement(host);

    if (element !== null) {
      element.hidden = state.hidden;
    }

    reporter.onCount({
      name: PARALLEL_BOARD_METRIC,
      value: 1,
      detail: Object.freeze({ claimed: false }),
    });
  };

  /* ------------------------------------------------------------------
   * Block placement
   * --------------------------------------------------------------- */

  /**
   * The lengths in force.
   *
   * A board that has been generated states them; before that, and after a
   * failed generation, they are resolved from the configured size so a caller
   * reading a position never receives one derived from nothing.
   */
  const requireGeometry = (): GeometryScale =>
    geometry ?? resolveBoardGeometry(readConfiguredSize(), resolveScale());

  /** A scratch vector per depth of nesting, so no call allocates per frame. */
  const scratchAt = (depth: number): Vector3 => {
    const existing = worldScratch.at(depth);

    if (existing !== undefined) {
      return existing;
    }

    // `cellToWorldIn` allocates only when handed no target, which is the one
    // call that grows this pool. It is bounded by the deepest nesting a frame
    // reaches, which is one.
    const created = cellToWorldIn({ x: 0, y: 0 }, requireGeometry());

    worldScratch.push(created);

    return created;
  };

  /**
   * Writes one block's transform from the tweens driving it.
   *
   * @returns Whether the block still has a tween running.
   */
  const placeTile = (tile: LiveTile): boolean => {
    const lengths = requireGeometry();
    const target = scratchAt(0);
    const move = tile.move;

    if (move === null) {
      cellToWorldIn(tile.target, lengths, target);
    } else {
      const at = move.value();

      cellToWorldIn({ x: at.x, y: at.y }, lengths, target);
    }

    tile.mesh.position.copy(target);

    // The spawn keyframes of style/main.scss animate `opacity` alongside
    // `transform: scale()`. Only the scale is applied here: the materials are
    // shared per value by src/render/tile-materials.ts — which is what keeps one
    // material per value rather than one per block — so a per-block opacity
    // would need a clone per tile. Scale zero already draws nothing, so the
    // keyframe's visual outcome is reproduced without the clone.
    const spawn = tile.spawn;
    const merge = tile.merge;

    if (spawn !== null) {
      tile.mesh.scale.setScalar(spawn.value().scale);
    } else if (merge !== null) {
      tile.mesh.scale.setScalar(merge.value().scale);
    }

    const moving = move !== null && !move.isComplete();
    const spawning = spawn !== null && !spawn.isComplete();
    const merging = merge !== null && !merge.isComplete();

    return moving || spawning || merging;
  };

  /* ------------------------------------------------------------------
   * Applying one plan
   * --------------------------------------------------------------- */

  /** Releases every block on screen back to the factory's pool. */
  const clearLiveTiles = (): void => {
    const activeFactory = factory;

    if (activeFactory !== null) {
      for (const tile of live) {
        activeFactory.releaseTileMesh(tile.mesh);
      }
    }

    live.length = 0;
  };

  /**
   * Adds one block for one planned tile.
   *
   * @param planned The tile to draw.
   * @param retireOnArrival Whether the block is released once it arrives, which
   *   is true of exactly the two blocks a merge consumed.
   */
  const addTile = (planned: PlannedTile, retireOnArrival: boolean): void => {
    const activeFactory = factory;
    const activeBoard = board;

    if (activeFactory === null || activeBoard === null) {
      return;
    }

    let mesh: TileMesh;

    try {
      mesh = activeFactory.acquireTileMesh(planned.value);
    } catch (error: unknown) {
      reporter.onDiagnostic({
        level: 'warning',
        source: DIAGNOSTIC_SOURCE,
        message: 'A block could not be built and its cell is left empty.',
        detail: Object.freeze({
          tileValue: planned.value,
          x: planned.x,
          y: planned.y,
        }),
        error: describeRenderError(error),
      });

      return;
    }

    const group = tweens;
    const target: PlannedPosition = { x: planned.x, y: planned.y };
    const from = planned.from;
    const isMerged = planned.merged.length > 0;
    const isNew = from === null && !isMerged;

    // A merge source ALWAYS takes a move tween, even where it did not move.
    // js/html_actuator.js kept the stationary source painted beneath the merged
    // tile — `.tile-inner` at z-index 10 under `.tile-merged .tile-inner` at 20
    // — for the 100ms the merged tile is held at scale zero, and the tween is
    // what holds it on screen for exactly that interval here. Its duration and
    // the merged block's delay are both `$transition-speed`, so the source
    // leaves on the frame the merged block starts to grow.
    const move =
      group !== null &&
      from !== null &&
      (retireOnArrival || requiresMoveTween(from, target))
        ? group.add(createMoveTween({ from, to: target, reporter }))
        : null;

    const spawn =
      group !== null && isNew
        ? group.add(createSpawnTween({ reporter }))
        : null;

    const merge =
      group !== null && isMerged
        ? group.add(createMergeTween({ reporter }))
        : null;

    const tile: LiveTile = {
      mesh,
      value: planned.value,
      target,
      move,
      spawn,
      merge,

      // A source block with no move tween never arrives, so it is retired at
      // once by the first frame rather than being kept forever.
      retireOnArrival,
    };

    activeBoard.tileLayer.add(mesh);
    live.push(tile);
    placeTile(tile);
  };

  /** Fires the burst and the punch for every merge this turn produced. */
  const startMergeEffects = (): void => {
    if (pendingMerges.length === 0) {
      return;
    }

    const lengths = requireGeometry();

    for (const merge of pendingMerges) {
      camera?.punchForMerge(merge.value);

      if (particles !== null) {
        const origin = cellToWorldIn(
          { x: merge.x, y: merge.y },
          lengths,
          scratchAt(0),
        );

        particles.burstAt(origin, merge.value);
      }
    }

    pendingMerges.length = 0;
  };

  /** Projects one plan into the shape a consumer reads the board through. */
  const projectRendered = (plan: PaintPlan): RenderedBoard => {
    const themeInForce = materials?.getTheme() ?? getActiveTheme();
    const byCell = new Map<string, PlannedTile>();

    for (const tile of plan.tiles) {
      byCell.set(`${tile.x}:${tile.y}`, tile);
    }

    const cells: RenderedCell[] = [];

    // Row-major, which is the order the parallel layer's cells are built in.
    for (let y = 0; y < plan.size; y += 1) {
      for (let x = 0; x < plan.size; x += 1) {
        const tile = byCell.get(`${x}:${y}`) ?? null;
        const row = y + 1;
        const column = x + 1;

        if (tile === null) {
          cells.push(
            Object.freeze({
              x,
              y,
              value: null,
              label: copy.emptyCellLabel(row, column),
              isSuper: false,
              isMerged: false,
              isNew: false,
              moved: false,
              fill: null,
              numeralColor: null,
            }),
          );

          continue;
        }

        const superThreshold = options.config?.winValue;
        let fill: string | null = null;
        let numeralColor: string | null = null;

        try {
          // The same call src/render/number-only-renderer.ts projects through,
          // so the two renderers describe one tile identically and a consumer
          // reading a rendered board cannot tell which drew it.
          const resolved = resolveTileTheme(tile.value, themeInForce);

          fill = resolved.colorHex;
          numeralColor = resolved.numeralColor;
        } catch {
          // `resolveTileTheme` rejects a value that is not a power of the
          // ramp's base, which is what `null` states for both fields.
          fill = null;
          numeralColor = null;
        }

        cells.push(
          Object.freeze({
            x,
            y,
            value: tile.value,
            label: copy.cellLabel(row, column, tile.value),
            isSuper:
              superThreshold !== undefined && tile.value > superThreshold,
            isMerged: tile.merged.length > 0,
            isNew: tile.from === null && tile.merged.length === 0,
            moved: tile.from !== null,

            fill,
            numeralColor,
          }),
        );
      }
    }

    return Object.freeze({
      size: plan.size,
      cells: Object.freeze(cells),
      score: plan.score,
      scoreDelta: plan.scoreDelta,
      bestScore: plan.bestScore,
      won: plan.won,
      over: plan.over,
      terminated: plan.terminated,
      themeId: themeInForce.id,
    });
  };

  /** Updates the parallel accessibility board from one plan. */
  const updateParallelBoard = (plan: PaintPlan): void => {
    if (parallelBoardLayer === null) {
      return;
    }

    claimParallelBoard(plan.size);

    const cells: ParallelBoardCell[] = plan.tiles.map((tile) => ({
      x: tile.x,
      y: tile.y,
      value: tile.value,
    }));

    parallelBoardLayer.update(cells);
  };

  /** Draws one plan. */
  const paint = (plan: PaintPlan): void => {
    if (!ensureBoard(plan.size)) {
      return;
    }

    clearLiveTiles();

    for (const planned of plan.tiles) {
      // js/html_actuator.js L60-L65 drew the two source tiles first and the
      // merged tile over them; the order is kept so a depth tie, if the tweens
      // ever produced one, resolves the way the 2D board resolved it.
      for (const source of planned.merged) {
        addTile(source, true);
      }

      addTile(planned, false);
    }

    startMergeEffects();

    // A terminal turn shakes the camera once: the 2D board's own terminal
    // treatment is the overlay src/ui/screens/hud.ts fades in, and this is the
    // board's half of the same moment. Suppressed while motion is reduced by
    // the effects module itself, and on a repaint, which redraws a commit whose
    // own shake has already run.
    if (plan.over && plan.repaint !== true) {
      camera?.shake();
    }

    updateParallelBoard(plan);
    lastPlan = plan;
    rendered = projectRendered(plan);
    paints += 1;

    reporter.onCount({
      name: PAINT_METRIC,
      value: 1,
      detail: Object.freeze({ size: plan.size, tiles: plan.tiles.length }),
    });
  };

  /* ------------------------------------------------------------------
   * The frame
   * --------------------------------------------------------------- */

  /** Retires the blocks whose tweens have finished and that asked to be. */
  const retireArrived = (): void => {
    const activeFactory = factory;

    if (activeFactory === null) {
      return;
    }

    for (let index = live.length - 1; index >= 0; index -= 1) {
      const tile = live.at(index);

      if (tile === undefined || !tile.retireOnArrival) {
        continue;
      }

      if (tile.move !== null && !tile.move.isComplete()) {
        continue;
      }

      activeFactory.releaseTileMesh(tile.mesh);
      live.splice(index, 1);
    }
  };

  /**
   * Measures the step since the last frame, in ms.
   *
   * The loop's own context is used where one is handed in. A caller driving the
   * renderer directly — a test, or a host with no loop — is measured against
   * the ambient clock instead, and the first such frame steps nothing.
   */
  const readDelta = (context: FrameContext | undefined): number => {
    if (context !== undefined) {
      lastFrameAt = context.timestamp;

      return context.delta;
    }

    const now = typeof performance === 'undefined' ? 0 : performance.now();
    const previous = lastFrameAt;

    lastFrameAt = now;

    return previous === null ? 0 : Math.max(0, now - previous);
  };

  const frame = (context?: FrameContext): boolean => {
    if (disposed || !mounted) {
      return false;
    }

    const delta = readDelta(context);
    const plan = queued;

    if (plan !== null) {
      queued = null;
      paint(plan);
    }

    tweens?.advance(delta);
    particles?.advance({ delta });
    camera?.advance({ delta });

    let animating = false;

    for (const tile of live) {
      if (placeTile(tile)) {
        animating = true;
      }
    }

    retireArrived();

    const activeScene = scene;
    const surface = webgl;

    // Nothing is drawn against a lost context: the handlers of
    // src/render/webgl-support.ts report the loss and the restoration, and this
    // frame and every frame between the two is skipped rather than issued.
    if (activeScene !== null && surface !== null && !contextLost) {
      surface.render(activeScene.scene, activeScene.camera);
    }

    return (
      animating ||
      (tweens?.hasOutstandingWork() ?? false) ||
      (particles?.isActive() ?? false) ||
      (camera?.isActive() ?? false)
    );
  };

  /* ------------------------------------------------------------------
   * Mount and unmount
   * --------------------------------------------------------------- */

  const openScale = (): void => {
    if (requestedScale !== 'auto') {
      return;
    }

    scaleQuery = openScaleQuery(owner?.defaultView ?? null);

    const list = scaleQuery;

    if (list === null) {
      return;
    }

    const onChange = (): void => {
      const size = boardSize > 0 ? boardSize : readConfiguredSize();

      // The scale changes every length, so the board is generated again rather
      // than rescaled: `tileSize`, the field, the plates and the numeral
      // textures are all functions of it.
      board = null;
      geometry = null;
      ensureBoard(size);

      // Generating the board recalls every block into the factory's pool, so
      // the plan the board last showed is queued again. Without it the
      // regenerated lattice stands empty until the next turn commits.
      if (lastPlan !== null) {
        queued = restPlan(lastPlan);
      }

      options.onWork?.();
    };

    if (typeof list.addEventListener === 'function') {
      list.addEventListener('change', onChange);
      releaseScaleQuery = (): void => {
        list.removeEventListener?.('change', onChange);
      };

      return;
    }

    if (typeof list.addListener === 'function') {
      // The pre-`EventTarget` form of `MediaQueryList`, which Safari carried
      // for years and which `js/keyboard_input_manager.js`-era browsers were
      // the only ones to need.
      list.addListener(onChange);
      releaseScaleQuery = (): void => {
        list.removeListener?.(onChange);
      };
    }
  };

  const closeScale = (): void => {
    releaseScaleQuery?.();
    releaseScaleQuery = null;
    scaleQuery = null;
  };

  const openResize = (): void => {
    const view = owner?.defaultView ?? null;

    if (view === null) {
      return;
    }

    const onResize = (): void => {
      applySize();
      options.onWork?.();
    };

    if (typeof view.addEventListener === 'function') {
      view.addEventListener('resize', onResize);
      releaseResize = (): void => {
        view.removeEventListener('resize', onResize);
      };
    }
  };

  const closeResize = (): void => {
    releaseResize?.();
    releaseResize = null;
  };

  const mount = (target?: Element | null): boolean => {
    if (disposed) {
      reporter.onDiagnostic({
        level: 'warning',
        source: DIAGNOSTIC_SOURCE,
        message: 'A mount was refused because the renderer is disposed.',
      });

      return false;
    }

    if (mounted) {
      return true;
    }

    const surface = asCanvas(target ?? options.canvas ?? null);

    if (surface === null) {
      reporter.onCount({ name: MISSING_CANVAS_METRIC, value: 1 });
      reporter.onDiagnostic({
        level: 'error',
        source: DIAGNOSTIC_SOURCE,
        message:
          'No canvas was found, so the 2.5D board did not mount. Every ' +
          'other method is a working no-op and a caller can select the ' +
          'number-only renderer instead.',
      });

      return false;
    }

    canvas = surface;
    openScale();

    const scale = resolveScale();
    const size = readConfiguredSize();

    try {
      // The context is acquired here and nowhere else, so a caller that has
      // already probed for support decides whether to mount at all.
      webgl = openSurface(surface);
      scene = createScene({
        boardSize: size,
        geometry: resolveBoardGeometry(size, scale),
        theme: readPinnedTheme(),
        reporter,
      });
    } catch (error: unknown) {
      canvas = null;
      webgl?.dispose();
      webgl = null;
      scene = null;
      closeScale();

      reporter.onCount({ name: CONTEXT_FAILED_METRIC, value: 1 });
      reporter.onDiagnostic({
        level: 'error',
        source: DIAGNOSTIC_SOURCE,
        message:
          'A WebGL context could not be acquired, so the 2.5D board did ' +
          'not mount. A caller selects the number-only renderer instead.',
        detail: Object.freeze({ boardSize: size, scale }),
        error: describeRenderError(error),
      });

      return false;
    }

    materials = createTileMaterialCache({
      theme: options.theme,
      followActiveTheme: options.theme === undefined,
      reporter,
    });

    factory = createTileMeshFactory({
      config: { boardSize: size },
      materials,
      scale,
      reporter,
    });

    applyClearColor(readPinnedTheme() ?? getActiveTheme());

    // The context-loss handler the product has never had: WebGL is a hard
    // runtime prerequisite of this renderer, and a lost context is silent
    // without one.
    releaseContextLoss = attachContextLossHandlers(
      surface,
      {
        onContextLost: (): void => {
          contextLost = true;
        },
        onContextRestored: (): void => {
          contextLost = false;
          options.onWork?.();
        },
      },
      reporter,
    );

    tweens = createTweenGroup({ reporter });
    particles = createParticleSystem({ reporter });
    camera = createCameraEffects(scene.camera, { reporter });

    // The number-only layer and the canvas are mutually exclusive: exactly one
    // of the two draws the board, and index.html ships the number-only host
    // hidden.
    const numberOnly = asHtmlElement(options.numberOnlyHost);

    if (numberOnly !== null) {
      numberOnlyWasHidden = numberOnly.hidden;
      numberOnly.hidden = true;
    }

    const canvasElement = asHtmlElement(surface);

    if (canvasElement !== null) {
      canvasElement.hidden = false;
    }

    mounted = true;
    ensureBoard(size);
    claimParallelBoard(boardSize > 0 ? boardSize : size);
    openResize();

    releaseTheme = subscribeToThemeChange((theme: Theme): void => {
      // The material cache, the mesh factory and the scene's lighting rig each
      // follow the theme through their own subscription; this repaints so the
      // change reaches the screen without waiting for a turn, refreshes the
      // projection's theme id, and carries the palette into the clear colour,
      // which belongs to the renderer this module owns.
      applyClearColor(theme);

      reporter.onCount({
        name: THEME_CHANGE_METRIC,
        value: 1,
        detail: Object.freeze({ theme: theme.id }),
      });

      if (lastPlan !== null) {
        rendered = projectRendered(lastPlan);
      }

      options.onWork?.();
    });

    reporter.onCount({
      name: MOUNT_METRIC,
      value: 1,
      detail: Object.freeze({ boardSize, scale }),
    });

    options.onWork?.();

    return true;
  };

  const unmount = (): void => {
    if (!mounted) {
      return;
    }

    mounted = false;

    releaseTheme?.();
    releaseTheme = null;
    closeResize();
    closeScale();

    clearLiveTiles();
    pendingMerges.length = 0;
    queued = null;

    particles?.dispose();
    particles = null;
    camera?.destroy();
    camera = null;
    tweens?.dispose();
    tweens = null;
    factory?.dispose();
    factory = null;
    materials?.destroy();
    materials = null;
    scene?.dispose();
    scene = null;
    releaseContextLoss?.();
    releaseContextLoss = null;
    contextLost = false;
    webgl?.dispose();
    webgl = null;
    board = null;
    geometry = null;
    boardSize = 0;
    lastFrameAt = null;
    lastPlan = null;

    // Handed back the way it was taken: the layer stays mounted so the surface
    // the next renderer takes over is populated rather than an empty
    // `role="grid"`, and only the attributes this renderer wrote are restored.
    releaseParallelBoard();

    const numberOnly = asHtmlElement(options.numberOnlyHost);

    if (numberOnly !== null) {
      numberOnly.hidden = numberOnlyWasHidden;
    }

    // HIDDEN, not restored. index.html ships the canvas shown, because it is
    // the layer this build draws with; restoring that state would leave a blank
    // canvas over the board after this renderer has released its context. The
    // number-only host above IS restored, because it belongs to the other
    // renderer and its shipped state is the one that renderer expects.
    const canvasElement = asHtmlElement(canvas);

    if (canvasElement !== null) {
      canvasElement.hidden = true;
    }

    canvas = null;

    reporter.onCount({ name: UNMOUNT_METRIC, value: 1 });
  };

  /* ------------------------------------------------------------------
   * Subscription
   * --------------------------------------------------------------- */

  const render = (commit: StateCommitEvent): void => {
    if (disposed) {
      return;
    }

    // A board size beyond what the product supports is refused before the walk
    // and before any allocation, exactly as the number-only path refuses it:
    // the board already on screen stands, which is the bounded fallback.
    if (!isSupportedBoardSize(commit.board.size)) {
      refusedSizes += 1;

      reporter.onCount({
        name: REFUSED_SIZE_METRIC,
        value: 1,
        detail: Object.freeze({ size: commit.board.size }),
      });

      reporter.onDiagnostic({
        level: 'error',
        source: DIAGNOSTIC_SOURCE,
        message:
          'The 2.5D board refused a commit whose board size is above the ' +
          'supported maximum and kept the board it had drawn.',
        detail: Object.freeze({ size: commit.board.size, boardSize }),
      });

      // Dropped rather than carried: a burst queued against a board that is
      // never drawn would otherwise fire at a cell of the next board.
      pendingMerges.length = 0;

      return;
    }

    const delta = Math.max(0, commit.score - lastScore);

    lastScore = commit.score;

    // Read here, inside the emission: `state:commit` carries the live board and
    // the next turn mutates the same objects.
    queued = planCommit(commit, delta);
    commits += 1;

    reporter.onCount({
      name: RENDER_METRIC,
      value: 1,
      detail: Object.freeze({
        size: queued.size,
        tiles: queued.tiles.length,
        scoreDelta: delta,
      }),
    });

    options.onWork?.();
  };

  /**
   * Records one merge for the frame that starts its animation.
   *
   * `resultValue` is the value an `onMerge` relic handler left, and the target
   * tile's coordinates are the merge cell: the merged tile was inserted over
   * the target, so its position is the target's.
   */
  const onMerge = (merge: TileMergeEvent): void => {
    if (disposed) {
      return;
    }

    const detail: RenderDetail = Object.freeze({
      tileValue: merge.resultValue,
      x: merge.target.x,
      y: merge.target.y,
    });

    pendingMerges.push({
      x: merge.target.x,
      y: merge.target.y,
      value: merge.resultValue,
    });

    reporter.onCount({ name: MERGE_METRIC, value: 1, detail });
  };

  const subscribe = (events: EngineEvents): EngineEventSubscription => {
    if (disposed) {
      reporter.onCount({
        name: REFUSED_SUBSCRIBE_METRIC,
        value: 1,
        detail: Object.freeze({ phase: 'before' }),
      });

      return (): void => {
        // Nothing was registered, so there is nothing to release.
      };
    }

    const releaseCommit = events.on('state:commit', render);
    const releaseMerge = events.on('tile:merge', onMerge);

    // `events.on` can dispose this renderer before it returns, by way of a
    // listener the same emitter already holds.
    if (disposed) {
      releaseCommit();
      releaseMerge();

      reporter.onCount({
        name: REFUSED_SUBSCRIBE_METRIC,
        value: 1,
        detail: Object.freeze({ phase: 'during' }),
      });

      return (): void => {
        // Already released above.
      };
    }

    subscriptions.push(releaseCommit, releaseMerge);

    let released = false;

    return (): void => {
      if (released) {
        return;
      }

      released = true;
      releaseCommit();
      releaseMerge();
    };
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }

    unmount();
    disposed = true;

    for (const release of subscriptions) {
      release();
    }

    subscriptions.length = 0;
    rendered = null;
  };

  // Mounted at construction where a canvas was handed in, which is the
  // convention src/render/number-only-renderer.ts follows for its own host: the
  // composition root then reads `mounted` to learn whether the mode it selected
  // is available, rather than having to sequence a separate call.
  if (options.canvas !== undefined && options.canvas !== null) {
    mount(options.canvas);
  }

  return Object.freeze({
    get mounted(): boolean {
      return mounted;
    },

    mount,
    unmount,
    subscribe,
    render,
    frame,
    readRenderedBoard: (): RenderedBoard | null => rendered,
    dispose,
    destroy: dispose,

    readStats: (): ThreeRendererStats =>
      Object.freeze({
        mounted,
        boardSize,
        scale: resolveScale(),
        themeId: (materials?.getTheme() ?? getActiveTheme()).id,
        commits,
        paints,
        boardsBuilt,
        liveTiles: live.length,
        activeTweens: tweens?.size() ?? 0,
        pendingMerges: pendingMerges.length,
        refusedSizes,
        contextLost,
        disposed,
      }),
  });
}
