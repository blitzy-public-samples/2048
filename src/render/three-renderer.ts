// The 2.5D board renderer. AAP R1 and R7.
//
// The canvas carries `aria-hidden="true"`; the parallel `role="grid"` layer
// beside it carries the board's semantics and is mounted through that layer's
// own api. src/render/number-only-renderer.ts takes the same layer down while
// its own lattice draws, so exactly one of the two is exposed at a time.
//
// Every payload carries the LIVE board and the LIVE tiles, per AAP Contract 1,
// so each listener plans its paint synchronously INSIDE the emission and holds
// no engine object past it.
//
// Reduced motion is resolved by each animating member against
// src/render/webgl-support.ts and is not re-decided here. This module reads no
// storage and consumes no randomness.
//
// in either direction. One traceability row of docs/TRACEABILITY_MATRIX.md
// apiece, every row of this module's area enumerated:
//   TR-THREE-01  actuate            L10-L36   `render()` queues, `frame()`
//                                             draws
//   TR-THREE-02  the x-major walk   L16-L22   `planCommit()`
//   TR-THREE-03  clearContainer     L43-L47   `clearLiveTiles()`
//   TR-THREE-04  addTile            L49-L91   `planTile()` and `addTile()`
//   TR-THREE-05  previousPosition   L54       `PlannedTile.from`
//   TR-THREE-06  super threshold    L60       `resolveTileTheme().isSuper`
//   TR-THREE-07  nested-frame move  L67-L72   `createMoveTween` of
//                                             ./animations
//   TR-THREE-08  the mergedFrom     L73-L80   `PlannedTile.merged`,
//                                             `addTile(_, true)` recursion
//   TR-THREE-09  the tile-new       L82       `createSpawnTween` of
//                                             ./animations
//   TR-THREE-10  applyClasses       L93-L95   material and mesh acquisition;
//                                             no class attribute is written
//                                             and the classList workaround is
//                                             not carried forward
//   TR-THREE-11  normalizePosition  L97-L99   `cellToWorldIn` of
//                                             ./tile-mesh-factory
//   TR-THREE-12  positionClass      L101-L104 `cellToWorldIn` of
//                                             ./tile-mesh-factory
//   TR-THREE-13  updateScore        L106-L121 src/ui/components/score-panel.ts.
//                                             NOT here: this module carries the
//                                             difference as
//                                             `PaintPlan.scoreDelta` into
//                                             `readRenderedBoard()` and writes
//                                             no score outlet and no
//                                             rising-delta node
//   TR-THREE-14  updateBestScore    L123-L125 src/ui/screens/hud.ts. Not here
//   TR-THREE-15  message            L127-L133 src/ui/screens/hud.ts. Not here
//   TR-THREE-16  clearMessage       L135-L139 src/ui/screens/hud.ts. Not here
//   TR-THREE-17  continueGame       L39-L41   src/ui/screens/hud.ts. Not here
//   TR-THREE-18  target-only row              the hook-free subscription
//                                             surface
//   TR-THREE-19  target-only row              the WebGL surface and its
//                                             context-loss handling
//   TR-THREE-20  target-only row              the parallel accessibility board
//   TR-THREE-21  target-only row              the stage lighting and the
//                                             stage-clear punch
//   TR-THREE-22  target-only row              `degraded` carried by the paint
//                                             plan, the same member
//                                             src/render/number-only-renderer.ts
//                                             carries
//   TR-THREE-23  target-only row              the factory-scale
//                                             reconciliation, which rebuilds
//                                             the tile-mesh factory when the
//                                             breakpoint is crossed
//   TR-THREE-24  target-only row              the all-or-nothing engine-event
//                                             subscription, rolled back when a
//                                             registration refuses
//
// Decisions: DL-THREE-01, DL-THREE-02, DL-THREE-03, DL-THREE-04, DL-THREE-05,
//   DL-THREE-06, DL-THREE-07, DL-THREE-08, DL-THREE-09, DL-THREE-10,
//   DL-THREE-11
// (docs/DECISION_LOG.md).

import { Color, SRGBColorSpace, WebGLRenderer } from 'three';
import type { Vector3 } from 'three';

import { isSupportedBoardSize } from '../config/default-config';
import type {
  EngineEvents,
  EngineEventSubscription,
} from '../engine/engine-events';
import type {
  MoveAfterEvent,
  StageEndEvent,
  StageStartEvent,
  StateCommitEvent,
  TileMergeEvent,
  TileSpawnEvent,
} from '../engine/engine-events';
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
import type {
  BoardMeshes,
  TileMesh,
  TileMeshFactory,
} from './tile-mesh-factory';
import type { RenderedBoard, RenderedCell } from './number-only-renderer';
import { numberOnlyRendererCopy } from './number-only-renderer';
import type {
  RenderDetail,
  RenderReporter,
  WebGLContextLossInfo,
} from './webgl-support';
import {
  NOOP_RENDER_REPORTER,
  attachContextLossHandlers,
  createGuardedRenderReporter,
  describeRenderError,
} from './webgl-support';

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

/** Counter raised once per spawn recorded for its `appear` tween. */
const SPAWN_METRIC = 'render.three.spawn';

/** Counter raised once per spawn that resolved to no cell. */
const SPAWN_SUPPRESSED_METRIC = 'render.three.spawn.suppressed';

/**
 * Counter raised per animation trigger discarded for belonging to a turn other
 * than the one being drawn.
 */
const ORPHANED_TRIGGERS_METRIC = 'render.three.orphaned_triggers';

/** Counter raised once per resolved move whose origins were recorded. */
const MOVE_METRIC = 'render.three.move';

/** Counter raised once per stage the board was re-framed and lit for. */
const STAGE_START_METRIC = 'render.three.stage.start';

/** Counter raised once per stage index the lighting rig was tuned for. */
const STAGE_LIGHTING_METRIC = 'render.three.stage.lighting';

/** Counter raised once per stage resolution presented. */
const STAGE_END_METRIC = 'render.three.stage.end';

/** ADDED: counter raised once per `WebGLRenderer` constructed. DL-THREE-06. */
const SURFACE_OPENED_METRIC = 'render.three.surface.opened';

/** ADDED: counter raised once per parked `WebGLRenderer` reused. DL-THREE-06. */
const SURFACE_REUSED_METRIC = 'render.three.surface.reused';

/**
 * ADDED: counter raised once per `WebGLRenderer` released for good, on BOTH
 * release paths — the context-loss disposal inside a renderer and the normal
 * final release a caller makes through `releaseParkedRenderer`. DL-THREE-11.
 */
const SURFACE_RELEASED_METRIC = 'render.three.surface.released';

/**
 * ADDED: counter raised once per release that released nothing, carrying the
 * reason on its `reason` detail. DL-THREE-12.
 */
const SURFACE_RELEASE_REFUSED_METRIC = 'render.three.surface.release_refused';

/** Alpha the drawing buffer is cleared to. */
const CLEAR_ALPHA = 0;

/** Highest device pixel ratio the drawing buffer is sized at. */
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

/** The breakpoint of style/main.scss, as a media query. */
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

/** Narrows a value to a media-query list. */
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
 * The cell naming carried into `readRenderedBoard`.
 *
 * The two functions are src/render/number-only-renderer.ts's own, so a
 * consumer reading a rendered board names a cell identically no matter which
 * renderer drew it.
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

/**
 * What one `webglcontextrestored` rebuild achieved, as
 * `ThreeRendererOptions.onContextRestored` receives it.
 */
export interface ContextRestoreOutcome {
  /**
   * Whether every renderer-owned GPU resource was rebuilt and the board is
   * drawing again. `false` leaves the 2.5D board parked.
   */
  readonly rebuilt: boolean;

  /**
   * Whether the context still stands lost after the attempt, which is what
   * `readStats.contextLost` reports.
   */
  readonly contextLost: boolean;

  /**
   * Whether a rebuild was attempted at all. `false` on a restoration that
   * reached a disposed or unmounted renderer, which owns no resources to
   * rebuild and no board to park.
   */
  readonly attempted: boolean;
}

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

  /** The rules in force. */
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

  /** The cell naming carried into `readRenderedBoard`. */
  readonly copy?: Partial<BoardCellCopy>;

  /**
   * Called whenever the renderer has work for the next frame, so a loop that
   * stops when idle is woken. Defaults to doing nothing.
   */
  readonly onWork?: () => void;

  /**
   * Called once the browser has taken this renderer's WebGL context away,
   * after the loss has been reported and restoration requested.
   *
   * Defaults to doing nothing, which leaves the wait-for-restoration behaviour
   * a renderer built without it has always had.
   */
  readonly onContextLost?: (info: WebGLContextLossInfo) => void;

  /**
   * Called once the browser has restored the context, after this renderer has
   * attempted the rebuild the new context requires, with the verdict of that
   * attempt. Defaults to doing nothing.
   *
   * The verdict is what tells a caller whether the 2.5D board is drawing
   * again: a restored context whose resources could NOT be rebuilt leaves the
   * board parked, so a caller that ended its fallback on the restoration alone
   * ended it on a board that never came back (implicit requirement I6).
   */
  readonly onContextRestored?: (outcome: ContextRestoreOutcome) => void;
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

  /** Spawned cells awaiting the plan that draws them. */
  readonly pendingSpawns: number;

  /** Move origins awaiting the plan that draws them. */
  readonly pendingMoves: number;

  /** `tile:spawn` emissions that carried a cell. */
  readonly spawnsAnnounced: number;

  /** `tile:spawn` emissions that inserted nothing. */
  readonly spawnsSuppressed: number;

  /** `move:after` emissions whose origins were recorded. */
  readonly movesAnnounced: number;

  /** `stage:start` emissions the board was re-framed and lit for. */
  readonly stagesStarted: number;

  /** Stage index the lighting rig stands tuned for, or `null` before any. */
  readonly litStageIndex: number | null;

  /** `stage:end` emissions presented. */
  readonly stagesEnded: number;
  readonly refusedSizes: number;

  /**
   * Animation triggers discarded for belonging to a turn other than the one
   * being drawn. Non-zero means granular events and commits arrived
   * interleaved, which the turn key is what protects the board from.
   */
  readonly orphanedTriggers: number;

  /** Contexts lost since the mount. */
  readonly contextLosses: number;

  /** Restorations whose GPU resources were rebuilt. */
  readonly contextRestores: number;

  /**
   * The turn the armed triggers belong to, and `null` while none are armed.
   */
  readonly pendingTurn: number | null;
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
   * @returns Whether the renderer mounted. A miss is reported and leaves
   *   every other method a working no-op, which is the path a caller that
   *   skipped the support probe lands on.
   */
  mount(canvas?: Element | null): boolean;

  /** Releases the context, the meshes and the parallel layer. */
  unmount(): void;

  /**
   * Registers this renderer's listeners on one emitter.
   *
   * Six of the seven names of AAP Contract 1: `stage:start`, `tile:merge`,
   * `tile:spawn`, `move:after`, `stage:end` and `state:commit`. `move:before`
   * is not among them.
   *
   * @param events The engine's emitter.
   * @returns A handle releasing every listener taken. Idempotent.
   */
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
   * `StateCommitEvent.degraded`, carried so `projectRendered` can put it on
   * the shared `RenderedBoard` snapshot exactly as the number-only renderer
   * does.
   */
  readonly degraded: boolean;

  /**
   * Set on a plan queued to redraw the board the commit already drew, rather
   * than to draw a turn. `restPlan` builds one.
   */
  readonly repaint?: boolean;
}

/** The same plan, with every animation input removed. */
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
 * Projects one tile of a commit, and the pair it was merged from, into the
 * plain data one paint reads.
 */
function planTile(tile: CommitTile): PlannedTile {
  const previous = tile.previousPosition;

  return {
    value: tile.value,
    x: tile.x,
    y: tile.y,
    from: previous === null ? null : { x: previous.x, y: previous.y },

    // js/html_actuator.js L78-L80 passed each member of `mergedFrom` back
    // through `addTile`, so the pair is planned by this same function.
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
    degraded: commit.degraded,
  });
}

/** A block the scene holds, and the tweens driving it. */
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

/** The `hidden` states an element can carry. */
type HiddenState = HTMLElement['hidden'];

/**
 * Narrows an element to an `HTMLElement`, by the members this module writes.
 */
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
 */
function asCanvas(value: Element | null | undefined): HTMLCanvasElement | null {
  if (value === null || value === undefined) {
    return null;
  }

  return typeof (value as { getContext?: unknown }).getContext === 'function'
    ? (value as HTMLCanvasElement)
    : null;
}

/**
 * CHANGED: what is parked over a canvas — the `WebGLRenderer` and the sink to
 * report its release through.
 *
 * `releaseParkedRenderer` is a module function, so it has no renderer instance
 * and therefore no reporter of its own; without one it disposed the instance
 * silently and `render.three.surface.released` counted the context-loss releases
 * alone, undercounting the NORMAL final release that the composition root makes
 * exactly once per page. Parking the sink beside the instance is what lets that
 * release be reported by whoever performs it. `DL-THREE-11`.
 */
interface ParkedSurface {
  readonly renderer: WebGLRenderer;

  /**
   * The guarded sink of the renderer that last mounted over this canvas. Guarded
   * at construction by `createGuardedRenderReporter`, so a throwing sink cannot
   * escape through a release.
   */
  reporter: RenderReporter;
}

/**
 * ADDED: the `WebGLRenderer` parked over each canvas, held weakly so a canvas
 * that goes out of scope takes its entry with it.
 *
 * A WebGL context belongs to its canvas and outlives every renderer built over
 * it, and this application re-mounts the same canvas for the life of the page —
 * once per appearance switch. One renderer per canvas is therefore the honest
 * lifetime: it is built on the first mount, reused by every later one, and
 * released only where the context is gone or a caller says the canvas is
 * finished with. DL-THREE-06.
 */
const parkedRenderers = new WeakMap<HTMLCanvasElement, ParkedSurface>();

/**
 * ADDED: the canvases whose parked renderer is currently MOUNTED and drawing.
 *
 * `releaseParkedRenderer` refuses one of these: a renderer in use is not a
 * parked renderer, and disposing it would take the context away from the board
 * on screen. DL-THREE-06.
 */
const mountedSurfaces = new WeakSet<HTMLCanvasElement>();

/**
 * ADDED: returns the pixel-store unpack state to its initial values, reporting
 * nothing.
 *
 * Extracted from the factory's own `restoreUnpackState` so the module-level
 * release below shares one implementation with it. The reasoning is unchanged
 * and is stated there. DL-THREE-05.
 *
 * @param renderer Renderer whose context is reset.
 * @returns Whether the reset completed.
 */
function resetPixelStoreUnpack(renderer: WebGLRenderer | null): boolean {
  if (renderer === null) {
    return true;
  }

  try {
    // Guarded because a renderer double may implement no accessor, and a
    // context taken away by the browser answers no constants.
    const gl: unknown =
      typeof renderer.getContext === 'function' ? renderer.getContext() : null;

    if (gl === null || typeof gl !== 'object') {
      return true;
    }

    const state = gl as {
      readonly UNPACK_FLIP_Y_WEBGL?: unknown;
      readonly UNPACK_PREMULTIPLY_ALPHA_WEBGL?: unknown;
      readonly pixelStorei?: unknown;
    };

    if (typeof state.pixelStorei !== 'function') {
      return true;
    }

    const pixelStorei = state.pixelStorei.bind(gl) as (
      parameter: number,
      value: boolean,
    ) => void;

    // A call on a context the browser has already taken away is a defined
    // no-op, so the loss path needs no separate branch.
    if (typeof state.UNPACK_FLIP_Y_WEBGL === 'number') {
      pixelStorei(state.UNPACK_FLIP_Y_WEBGL, false);
    }

    if (typeof state.UNPACK_PREMULTIPLY_ALPHA_WEBGL === 'number') {
      pixelStorei(state.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * ADDED: why a release released nothing, as the refusal count's `reason`.
 * DL-THREE-12.
 */
const RELEASE_REFUSALS = Object.freeze({
  /** The value handed over was not a canvas. */
  notACanvas: 'not-a-canvas',

  /** The canvas holds no parked renderer — released already, or never built. */
  notParked: 'not-parked',

  /** The renderer is mounted and drawing, so it is not parked. */
  mounted: 'mounted',
} as const);

/**
 * ADDED: releases the renderer parked over one canvas, for good.
 *
 * The counterpart of the parking: an unmount keeps the renderer so the next
 * mount reuses it, and this is how a caller that is finished with the canvas —
 * the composition root disposing the application — gives the context's
 * resources back. Calling it for a canvas holding no parked renderer is a
 * no-op. DL-THREE-06.
 *
 * CHANGED: it REPORTS, through an optional sink. The instance-level release
 * inside the factory counts `render.three.surface.released` and warns where the
 * unpack reset fails; this one did neither, so the ONE release that happens in
 * an ordinary session — the composition root's disposal — was the one release
 * nothing counted, and a failed reset here disappeared where the same failure
 * inside the factory is a warning. The sink is optional and guarded, so a caller
 * that supplies none behaves exactly as before. DL-THREE-12.
 *
 * @param candidate Canvas whose parked renderer is released.
 * @param sink Sink the release, the refusal and a failed reset are reported
 *   through. Defaults to the no-op reporter.
 * @returns Whether a renderer was released.
 */
export function releaseParkedRenderer(
  candidate: Element | null | undefined,
  sink: RenderReporter = NOOP_RENDER_REPORTER,
): boolean {
  const reporter = createGuardedRenderReporter(sink);

  /**
   * Counts one release that released nothing, naming why.
   *
   * @param reason One of `RELEASE_REFUSALS`.
   * @returns `false`, the value the caller is given.
   */
  const refuse = (reason: string): false => {
    reporter.onCount({
      name: SURFACE_RELEASE_REFUSED_METRIC,
      value: 1,
      detail: Object.freeze({ reason }),
    });

    return false;
  };

  const surface = asCanvas(candidate);

  if (surface === null) {
    return refuse(RELEASE_REFUSALS.notACanvas);
  }

  const parked = parkedRenderers.get(surface);

  if (parked === undefined) {
    return refuse(RELEASE_REFUSALS.notParked);
  }

  // A renderer still drawing is not parked: the caller unmounts or destroys the
  // renderer first, and this refuses rather than pulling the context out from
  // under a live board.
  if (mountedSurfaces.has(surface)) {
    return refuse(RELEASE_REFUSALS.mounted);
  }

  parkedRenderers.delete(surface);

  // As at every other release: the canvas is handed on carrying the initial
  // unpack state. DL-THREE-05.
  const reset = resetPixelStoreUnpack(parked.renderer);

  parked.renderer.dispose();

  // CHANGED: and it is REPORTED, exactly once. This is the normal final release
  // — the one the composition root makes when it disposes the application — and
  // it went uncounted, so the released counter answered only for a lost context
  // and never balanced the opened counter on an ordinary teardown. A caller that
  // supplied a sink asked for this release, so its sink is the one told; a caller
  // that supplied none is reported to through the sink parked beside the
  // instance, which is already guarded, so a release is never lost and never
  // counted twice. DL-THREE-11.
  const releaseReporter =
    sink === NOOP_RENDER_REPORTER ? parked.reporter : reporter;

  releaseReporter.onCount({
    name: SURFACE_RELEASED_METRIC,
    value: 1,
    detail: Object.freeze({ unpackReset: reset }),
  });

  if (!reset) {
    // The same wording, and the same non-fatal reading, as the factory's own
    // `restoreUnpackState`: the reset is hygiene, and a renderer that cannot be
    // asked for its context still has to be released. DL-THREE-05.
    releaseReporter.onDiagnostic({
      level: 'warning',
      source: DIAGNOSTIC_SOURCE,
      message:
        'The pixel-store unpack state could not be reset before the ' +
        'renderer was released; a later re-mount may warn about a ' +
        'placeholder texture upload.',
    });
  }

  return true;
}

/** The attribute a canvas is marked with, and the value it carries. */
const CANVAS_ARIA_ATTRIBUTE = 'aria-hidden';
const CANVAS_ARIA_VALUE = 'true';

/** A cell coordinate pair as one key, for the pending-animation lookups. */
function cellKey(x: number, y: number): string {
  return `${x}:${y}`;
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

/**
 * Builds the 2.5D renderer.
 *
 * The WebGL context is acquired by `mount`, not here, so a caller can
 * construct the renderer, read its stats and dispose it on a machine with no
 * context at all.
 *
 * @param options Canvas, surfaces, rules, scale, palette and report sink.
 * @returns A frozen renderer holding no context.
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

  /**
   * The scale the live `factory` was CONSTRUCTED at.
   *
   * ADDED: the factory resolves every length from the scale handed to it once,
   * at construction, and publishes no way to change it — so a breakpoint
   * crossing that rebuilt the board left desktop geometry on a board this
   * renderer was reporting as mobile. `null` while no factory stands.
   * DL-THREE-08.
   */
  let factoryScale: ScaleName | null = null;
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

  /**
   * Whether the host swap has run, so a teardown knows the recorded host
   * states are real and may be restored.
   */
  let hostsSwapped = false;
  let parallelBoardClaimed = false;
  let parallelBoardState: {
    readonly hidden: HiddenState;
    readonly ariaHidden: string | null;
  } | null = null;

  const live: LiveTile[] = [];
  const pendingMerges: PendingMerge[] = [];

  /**
   * Cells `tile:spawn` resolved this turn, keyed by `cellKey`.
   *
   * Consumed by `addTile`: a planned tile standing in one of these cells takes
   * the spawn tween whatever origin the plan carries.
   */
  const pendingSpawns = new Set<string>();

  /**
   * Origins `move:after` reported this turn, keyed by destination `cellKey`.
   *
   * Consumed by `addTile` as the move tween's origin where the plan taken from
   * the commit carries none.
   */
  const pendingMoveOrigins = new Map<string, PlannedPosition>();

  /**
   * The turn the armed triggers belong to, and `null` while none are armed.
   *
   * Every granular event and every commit carries a monotonic `turn`
   * (src/engine/engine-events.ts), so the buffers admit triggers for ONE turn
   * and a commit drains only the triggers belonging to its own.
   */
  let pendingTurn: number | null = null;

  const subscriptions: EngineEventSubscription[] = [];
  const worldScratch: Vector3[] = [];

  /**
   * The `aria-hidden` state the canvas was found in, or `undefined` while no
   * canvas is held. Restored by `unmount`.
   */
  let canvasAriaHidden: string | null | undefined;

  let queued: PaintPlan | null = null;

  /**
   * The plan the scene currently shows.
   *
   * Retained so a palette switch can re-project the board a consumer reads
   * without waiting for the next turn; it holds no reference to any live tile.
   */
  let lastPlan: PaintPlan | null = null;
  let rendered: RenderedBoard | null = null;

  /**
   * Stage index the lighting rig stands tuned for, or `null` before the first
   * tuning.
   */
  let litStageIndex: number | null = null;
  let lastScore = 0;
  let lastFrameAt: number | null = null;
  let boardSize = 0;
  let commits = 0;
  let paints = 0;
  let boardsBuilt = 0;
  let refusedSizes = 0;
  let spawnsAnnounced = 0;
  let spawnsSuppressed = 0;

  /** Animation triggers discarded for belonging to a superseded turn. */
  let orphanedTriggers = 0;

  /**
   * Contexts lost, and contexts whose resources were rebuilt after a restore.
   */
  let contextLosses = 0;
  let contextRestores = 0;
  let movesAnnounced = 0;
  let stagesStarted = 0;
  let stagesEnded = 0;
  let mounted = false;
  let disposed = false;

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

  /** Scratch a theme's page background is read into. */
  const clearColor = new Color();

  /**
   * The theme the surface and the scene are pinned to, where one was supplied.
   *
   * `options.theme` accepts a catalogue entry or an id; the scene's rig and
   * the clear colour both read a palette, so an id is resolved once here.
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
   * @throws Error when the canvas yields no WebGL context, which is the
   *   signal `mount` converts into its number-only fallback.
   */
  const openSurface = (surface: HTMLCanvasElement): WebGLRenderer => {
    // CHANGED: a renderer already parked over this canvas is REUSED, where this
    // constructed one per mount.
    //
    // Each construction takes a fresh set of GL objects from the canvas's own
    // context — among them the two placeholder textures its state cache uploads
    // for `TEXTURE_2D_ARRAY` and `TEXTURE_3D`, named in DL-THREE-05 — and
    // `dispose()` does not delete them, so ten appearance switches over one
    // canvas grew the live `WebGLTexture` count from 12 to 71 and the
    // `WebGLProgram` count from 6 to 15. One renderer per canvas removes the
    // growth at its source rather than chasing the objects it leaves behind.
    // `releaseParkedRenderer` is how the instance is finally released.
    // DL-THREE-06.
    const parked = parkedRenderers.get(surface);
    const renderer =
      parked?.renderer ??
      new WebGLRenderer({
        canvas: surface,
        antialias: true,
        alpha: true,
      });

    if (parked === undefined) {
      parkedRenderers.set(surface, { renderer, reporter });
    } else {
      // CHANGED: the parked entry adopts THIS renderer's sink on every mount, so
      // a release reported after an appearance switch is reported through the
      // reporter of the renderer that last held the context rather than through
      // one whose owner has been destroyed. DL-THREE-11.
      parked.reporter = reporter;
    }

    mountedSurfaces.add(surface);

    reporter.onCount({
      name: parked === undefined ? SURFACE_OPENED_METRIC : SURFACE_REUSED_METRIC,
      value: 1,
    });

    // Re-applied on every mount, reused or not: the platform's pixel ratio can
    // have changed while the renderer was parked, and the size and the clear
    // colour are written by `applySize` and `applyClearColor` after this.
    renderer.setPixelRatio(resolvePixelRatio());
    renderer.shadowMap.enabled = false;

    return renderer;
  };

  /**
   * ADDED: leaves the renderer parked over its canvas for the next mount.
   *
   * The mount's counterpart of `discardSurface` below: nothing is disposed and
   * the registry entry stands, so the next mount over this canvas takes the
   * same instance and the same GL objects. DL-THREE-06.
   *
   * It writes NO pixel-store state. DL-THREE-05 places that reset immediately
   * before each `webgl.dispose()`, and parking disposes nothing: the instance
   * that wrote the state is the one that takes the context back, and its own
   * state cache is the record of what it wrote. DL-THREE-07.
   */
  const parkSurface = (): void => {
    if (canvas !== null) {
      mountedSurfaces.delete(canvas);
    }

    webgl = null;
  };

  /**
   * ADDED: releases the renderer and un-parks it, for a context that is gone.
   *
   * A lost context takes every GL object with it, so the instance holding it
   * has nothing left to reuse and a later mount must build over the restored
   * context instead. DL-THREE-06.
   */
  const discardSurface = (): void => {
    restoreUnpackState(webgl);

    const surface = canvas;
    const released = webgl;

    if (
      surface !== null &&
      released !== null &&
      parkedRenderers.get(surface)?.renderer === released
    ) {
      parkedRenderers.delete(surface);
    }

    if (surface !== null) {
      mountedSurfaces.delete(surface);
    }

    released?.dispose();
    webgl = null;

    if (released !== null) {
      reporter.onCount({ name: SURFACE_RELEASED_METRIC, value: 1 });
    }
  };

  /**
   * ADDED: returns the pixel-store unpack state to its initial values before
   * the renderer that changed it lets go of the context.
   *
   * A `WebGLRenderer` releases its resources on `dispose()` but the CONTEXT
   * belongs to the canvas and outlives it, carrying whatever unpack state was
   * last written. Every numeral texture is a `CanvasTexture`, whose `flipY` is
   * `true`, so uploading one leaves `UNPACK_FLIP_Y_WEBGL` set — and a
   * replacement renderer built on the same canvas begins by uploading the two
   * placeholder textures its state cache needs for `TEXTURE_2D_ARRAY` and
   * `TEXTURE_3D`, for which the specification forbids both flips. That is two
   * `INVALID_OPERATION: texImage3D` warnings on every re-mount, with no visual
   * consequence and no deduplication.
   *
   * Restoring the state here rather than before the next construction keeps the
   * fix with the instance that caused it: this renderer leaves the context as it
   * found it, so any later consumer — this one re-mounting, or another entirely
   * — starts from the initial state the specification promises.
   *
   * `forceContextLoss()` was rejected: it makes the canvas permanently unable to
   * take another context, and this canvas is re-used for the life of the page.
   * DL-THREE-05.
   *
   * @param renderer Renderer about to be disposed, or `null`.
   */
  const restoreUnpackState = (renderer: WebGLRenderer | null): void => {
    // CHANGED: the reset itself moved to the module-level `resetPixelStoreUnpack`
    // so `releaseParkedRenderer` shares it; this wrapper keeps the report.
    if (resetPixelStoreUnpack(renderer)) {
      return;
    }

    // Never fatal: the reset is hygiene, and a renderer that cannot be asked
    // for its context still has to be released.
    reporter.onDiagnostic({
      level: 'warning',
      source: DIAGNOSTIC_SOURCE,
      message:
        'The pixel-store unpack state could not be reset before the ' +
        'renderer was released; a later re-mount may warn about a ' +
        'placeholder texture upload.',
    });
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
    // occupies, is the fallback a canvas the layout has not measured yet takes
    // — which is every canvas under a document with no layout engine.
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

  /**
   * Builds the tile-mesh factory at one scale and records the scale it was
   * built at.
   *
   * ADDED: the one construction site for the factory, so `factoryScale` cannot
   * fall out of step with the factory it describes. DL-THREE-08.
   *
   * @param size Board size the factory is configured for.
   * @param scale Scale every length is resolved from.
   * @param cache Material cache the blocks draw their materials from.
   */
  const buildFactory = (
    size: number,
    scale: ScaleName,
    cache: TileMaterialCache,
  ): void => {
    factory = createTileMeshFactory({
      config: { boardSize: size },
      materials: cache,
      scale,
      reporter,
    });
    factoryScale = scale;
  };

  /**
   * Rebuilds the factory where the scale in force is no longer the scale it was
   * built at.
   *
   * ADDED: this is the step a breakpoint crossing was missing. The factory
   * resolves the cell pitch, the tile footprint, the extrusion depth and the
   * numeral font size from its construction scale, so reusing it across a
   * crossing produced desktop blocks on a board the scene had reframed for
   * mobile — every length wrong by the ratio between the two token sets, and
   * invisible to a test that read the renderer's own reported scale.
   *
   * Every block on screen is released FIRST, because a block returns to the
   * pool of the factory that made it and a pooled desktop mesh must not be
   * handed out for a mobile board. The tweens driving those blocks are cleared
   * for the same reason: a tween holds the mesh it animates.
   *
   * @param size Board size the rebuilt factory is configured for.
   * @param scale Scale in force.
   * @returns Whether the factory was rebuilt.
   */
  const reconcileFactoryScale = (size: number, scale: ScaleName): boolean => {
    const cache = materials;

    if (factory === null || cache === null || factoryScale === scale) {
      return false;
    }

    clearLiveTiles();
    tweens?.clear();
    factory.dispose();
    buildFactory(size, scale, cache);

    // The board standing was laid out by the factory just disposed, so it is
    // discarded rather than reused: `ensureBoard` rebuilds it at the new scale.
    board = null;
    geometry = null;

    return true;
  };

  /**
   * Generates the board at one size, releasing every block on screen first.
   *
   * @returns Whether a board stands afterwards.
   */
  const ensureBoard = (size: number): boolean => {
    const activeScene = scene;

    if (factory === null || activeScene === null) {
      return false;
    }

    const scale = resolveScale();

    // CHANGED: reconciled BEFORE the up-to-date check below, so a board of the
    // same size at a different scale is rebuilt rather than kept. DL-THREE-08.
    reconcileFactoryScale(size, scale);

    const activeFactory = factory;

    if (activeFactory === null) {
      return false;
    }

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

      camera?.setRestTransform(activeScene.readRestTransform());
      particles?.attachTo(built.group);

      // CHANGED: the two effect controllers are re-measured against the geometry
      // this board was built at, beside the rest transform the reframe produced.
      // Both hold a magnitude derived from a planar length — the burst's spread
      // is one cell pitch and the punch's peak is a share of the field measure —
      // and this is the ONE path every rebuild takes: a configured board size
      // that changed, the breakpoint handler that nulls `board` and `geometry`
      // and rebuilds, and the rebuild after a restored context. Without it a
      // board whose geometry differed from the desktop 4x4 sprayed the wrong
      // number of cell pitches — about 1.80 at the mobile scale, 0.75 on a 3x3
      // desktop board. DL-THREE-10, DL-PARTICLE-07, DL-CAMERA-05.
      particles?.useGeometry(built.geometry);
      camera?.useGeometry(built.geometry);
      applySize();

      boardsBuilt += 1;

      const rest = activeScene.readRestTransform();

      reporter.onCount({
        name: BOARD_METRIC,
        value: 1,

        // CHANGED: the geometry the board was ACTUALLY laid out with, and the
        // framing the camera came to rest at, rather than the scale's name
        // alone. The name was already correct while every length behind it was
        // wrong, so a report carrying only the name could not tell a mobile
        // board from a desktop one wearing a mobile label. DL-THREE-08.
        detail: Object.freeze({
          boardSize: built.boardSize,
          scale,
          factoryScale,
          cellPitch: built.geometry.tileBoxSize + built.geometry.gridSpacing,
          tileSize: built.geometry.tileSize,
          tileBoxSize: built.geometry.tileBoxSize,
          fieldWidth: built.geometry.fieldWidth,
          gridSpacing: built.geometry.gridSpacing,
          cameraDistance: Math.hypot(
            rest.position.x,
            rest.position.y,
            rest.position.z,
          ),
        }),
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

        // The bounded summary AND the value itself.
        error: describeRenderError(error),
        thrown: error,
      });

      return false;
    }
  };

  /**
   * Marks the canvas hidden from assistive technology, recording the state it
   * was found in.
   *
   * @param surface The canvas being mounted.
   */
  const markCanvasAria = (surface: Element): void => {
    if (typeof surface.getAttribute !== 'function') {
      canvasAriaHidden = undefined;

      return;
    }

    canvasAriaHidden = surface.getAttribute(CANVAS_ARIA_ATTRIBUTE);

    if (canvasAriaHidden === CANVAS_ARIA_VALUE) {
      return;
    }

    if (typeof surface.setAttribute !== 'function') {
      return;
    }

    surface.setAttribute(CANVAS_ARIA_ATTRIBUTE, CANVAS_ARIA_VALUE);

    reporter.onDiagnostic({
      level: 'info',
      source: DIAGNOSTIC_SOURCE,
      message: 'The canvas was marked hidden from assistive technology.',
      detail: Object.freeze({ found: canvasAriaHidden }),
    });
  };

  /**
   * Restores the `aria-hidden` state `markCanvasAria` recorded.
   *
   * @param surface The canvas being released, or `null` where none is held.
   */
  const restoreCanvasAria = (surface: Element | null): void => {
    const found = canvasAriaHidden;

    canvasAriaHidden = undefined;

    if (surface === null || found === undefined) {
      return;
    }

    if (found === null) {
      surface.removeAttribute?.(CANVAS_ARIA_ATTRIBUTE);

      return;
    }

    surface.setAttribute?.(CANVAS_ARIA_ATTRIBUTE, found);
  };

  /** Shows the parallel board and mounts its cells. */
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
      // from while the canvas draws it.
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
    // call that grows this pool.
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
    // `transform: scale`.
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
   * @param retireOnArrival Whether the block is released once it arrives,
   *   which is true of exactly the two blocks a merge consumed.
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
        thrown: error,
      });

      return;
    }

    const group = tweens;
    const target: PlannedPosition = { x: planned.x, y: planned.y };
    const key = cellKey(planned.x, planned.y);
    const isMerged = planned.merged.length > 0;

    // js/html_actuator.js L82 took a tile carrying neither a previous position
    // nor a merge pair for a new one.
    const isNew =
      !isMerged &&
      !retireOnArrival &&
      (planned.from === null || pendingSpawns.has(key));

    // Where a tile came from, in three cases and in this order: a merge source
    // keeps its planned origin, and takes its own cell where the plan reports
    // it did not move, so the move tween below always exists to hold it on
    // screen; a new tile has no origin; every other tile takes its planned
    // origin, or the one `move:after` reported for its destination cell where
    // the plan carries none.
    const from: PlannedPosition | null = retireOnArrival
      ? planned.from ?? target
      : isNew
        ? null
        : planned.from ?? pendingMoveOrigins.get(key) ?? null;

    // A merge source ALWAYS takes a move tween, even where it did not move.
    // js/html_actuator.js L73-L80 left the stationary source painted beneath
    // the merged tile — `.tile-inner` at z-index 10 under `.tile-merged
    // .tile-inner` at 20 — for the 100ms the merged tile is held at scale
    // zero, and the tween is what holds it on screen for exactly that interval
    // here.
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

  /**
   * Tunes the lighting rig for one stage index, at most once per index.
   *
   * @param stageIndex Zero-based stage index. A non-finite index is ignored;
   *   src/render/scene.ts confines and reports the rest.
   * @returns Whether the rig was asked to re-tune.
   */
  const lightForStage = (stageIndex: number): boolean => {
    if (!Number.isFinite(stageIndex) || stageIndex === litStageIndex) {
      return false;
    }

    const activeScene = scene;

    if (activeScene === null) {
      return false;
    }

    litStageIndex = stageIndex;

    // The rig's own tuning of the key light's share and warmth, which is the
    // evolving lighting theme of AAP R7.
    activeScene.applyStageTheme(stageIndex);

    reporter.onCount({
      name: STAGE_LIGHTING_METRIC,
      value: 1,
      detail: Object.freeze({ stageIndex }),
    });

    return true;
  };

  /**
   * Drops every animation trigger the granular events armed.
   *
   * Called once a plan has been drawn, and once a commit has been refused for
   * its board size.
   */
  const clearPendingTriggers = (): void => {
    pendingMerges.length = 0;
    pendingSpawns.clear();
    pendingMoveOrigins.clear();
    pendingTurn = null;
  };

  /**
   * Admits a granular event's triggers to the buffers, discarding an older
   * turn's if a newer turn has begun arming.
   *
   * @param turn The turn the arriving event belongs to.
   * @returns Whether the event may arm a trigger.
   */
  const admitTurn = (turn: number): boolean => {
    if (!Number.isFinite(turn)) {
      return true;
    }

    if (pendingTurn === null) {
      pendingTurn = turn;

      return true;
    }

    if (turn === pendingTurn) {
      return true;
    }

    if (turn > pendingTurn) {
      const orphaned =
        pendingMerges.length + pendingSpawns.size + pendingMoveOrigins.size;

      pendingMerges.length = 0;
      pendingSpawns.clear();
      pendingMoveOrigins.clear();
      pendingTurn = turn;

      if (orphaned > 0) {
        orphanedTriggers += orphaned;

        reporter.onCount({
          name: ORPHANED_TRIGGERS_METRIC,
          value: orphaned,
          detail: Object.freeze({ turn, discarded: orphaned }),
        });
      }

      return true;
    }

    orphanedTriggers += 1;

    reporter.onCount({
      name: ORPHANED_TRIGGERS_METRIC,
      value: 1,
      detail: Object.freeze({ turn, pendingTurn }),
    });

    return false;
  };

  /**
   * Whether a commit may drain the armed triggers.
   *
   * A commit whose turn is not the buffers' turn discards them instead: the
   * board it carries is not the board they were armed against.
   *
   * @param turn The commit's turn.
   * @returns Whether the triggers belong to this commit.
   */
  const triggersBelongTo = (turn: number): boolean => {
    if (pendingTurn === null) {
      return true;
    }

    if (!Number.isFinite(turn) || turn === pendingTurn) {
      return true;
    }

    const orphaned =
      pendingMerges.length + pendingSpawns.size + pendingMoveOrigins.size;

    clearPendingTriggers();

    if (orphaned > 0) {
      orphanedTriggers += orphaned;

      reporter.onCount({
        name: ORPHANED_TRIGGERS_METRIC,
        value: orphaned,
        detail: Object.freeze({ commitTurn: turn, discarded: orphaned }),
      });
    }

    return false;
  };

  /** Projects one plan into the shape a consumer reads the board through. */
  const projectRendered = (plan: PaintPlan): RenderedBoard => {
    const themeInForce = materials?.getTheme() ?? getActiveTheme();
    const byCell = new Map<string, PlannedTile>();

    for (const tile of plan.tiles) {
      byCell.set(cellKey(tile.x, tile.y), tile);
    }

    const cells: RenderedCell[] = [];

    // Row-major, which is the order the parallel layer's cells are built in.
    for (let y = 0; y < plan.size; y += 1) {
      for (let x = 0; x < plan.size; x += 1) {
        const tile = byCell.get(cellKey(x, y)) ?? null;
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

        // js/html_actuator.js L60 compared against the literal 2048; the ramp
        // of src/theme/tile-ramp.ts carries that comparison as `isSuper`, and
        // a configured win value replaces it where one was supplied.
        let rampIsSuper = false;

        try {
          // The same call src/render/number-only-renderer.ts projects through,
          // so the two renderers describe one tile identically and a consumer
          // reading a rendered board cannot tell which drew it.
          const resolved = resolveTileTheme(tile.value, themeInForce);

          fill = resolved.colorHex;
          numeralColor = resolved.numeralColor;
          rampIsSuper = resolved.isSuper;
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
              superThreshold === undefined
                ? rampIsSuper
                : tile.value > superThreshold,
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
      degraded: plan.degraded,
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
    // Before the GPU GUARD, DELIBERATELY. The parallel accessibility board is
    // DOM and `lastPlan` is plain data, so neither depends on a board
    // standing: both follow the commit even on a frame that cannot draw one.
    updateParallelBoard(plan);
    lastPlan = plan;

    if (!ensureBoard(plan.size)) {
      // No board stands, so no trigger armed for this plan can ever play.
      clearPendingTriggers();

      return;
    }

    clearLiveTiles();

    for (const planned of plan.tiles) {
      // js/html_actuator.js L73-L80 appended the two source tiles after the
      // merged tile had been classed, leaving them beneath it in the
      // container; the order is kept so a depth tie, if the tweens ever
      // produced one, resolves the way the 2D board resolved it.
      for (const source of planned.merged) {
        addTile(source, true);
      }

      addTile(planned, false);
    }

    startMergeEffects();

    // Every trigger this plan consumed is dropped here, so the next plan
    // starts from the events of its own turn alone.
    clearPendingTriggers();

    // A terminal turn shakes the camera once: the 2D board's own terminal
    // treatment is the overlay src/ui/screens/hud.ts fades in, and this is the
    // board's half of the same moment.
    if (plan.over && plan.repaint !== true) {
      camera?.shake();
    }

    rendered = projectRendered(plan);
    paints += 1;

    reporter.onCount({
      name: PAINT_METRIC,
      value: 1,
      detail: Object.freeze({ size: plan.size, tiles: plan.tiles.length }),
    });
  };

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
   * The loop's own context is used where one is handed in. A caller driving
   * the renderer directly — a test, or a host with no loop — is measured
   * against the ambient clock instead, and the first such frame steps nothing.
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

      board = null;
      geometry = null;
      ensureBoard(size);

      // Generating the board recalls every block into the factory's pool, so
      // the plan the board last showed is queued again.
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

  /** Parks rendering for a lost context. */
  const parkForContextLoss = (): void => {
    contextLost = true;
    contextLosses += 1;

    // Read before the release, which zeroes it: the diagnostic reports the
    // board the loss interrupted, not the absence left behind.
    const lostSize = boardSize;

    // Every tween, burst and camera displacement in flight targets a mesh
    // whose GPU resources have just been invalidated.
    tweens?.clear();
    particles?.reset();
    camera?.reset();

    queued = null;
    clearPendingTriggers();

    // Released here, not at restoration. `webglcontextrestored` fires only
    // after the browser has already put a NEW context on the canvas, so a
    // delete issued from the restore handler targets that new context with a
    // handle belonging to the destroyed one — twenty `INVALID_OPERATION:
    // object does not belong to this context` warnings per restoration, one
    // per geometry, texture and vertex array.
    releaseGpuResources();

    reporter.onDiagnostic({
      level: 'error',
      source: DIAGNOSTIC_SOURCE,
      message:
        'The WebGL context was lost, so the 2.5D board has stopped drawing ' +
        'and is waiting for restoration. The game itself keeps running: every ' +
        'move still resolves, the board\'s accessible grid and the live region ' +
        'stay current, and drawing resumes when the context comes back.',
      detail: Object.freeze({ boardSize: lostSize, losses: contextLosses }),
    });
  };

  /**
   * Releases every collaborator that owns a GPU resource, leaving the mount,
   * the hosts, the parallel board, the resize observer and the theme
   * subscription in place.
   *
   * Shared by the context-loss park and the restoration rebuild, so the
   * release order is stated once: the reverse of the order a mount takes them.
   */
  const releaseGpuResources = (): void => {
    clearLiveTiles();
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

    // CHANGED: released and un-parked rather than parked, because this path
    // serves a LOST context and a rebuild over the restored one. The unpack
    // reset still runs first, inside `discardSurface`. DL-THREE-05, DL-THREE-06.
    discardSurface();
    board = null;
    geometry = null;
    boardSize = 0;
    litStageIndex = null;
  };

  /**
   * Rebuilds the renderer-owned GPU resources after a restored context and
   * reconciles the board that was last committed.
   *
   * @param surface The canvas the restored context belongs to.
   * @param size Board size to rebuild at.
   * @param scale Scale the geometry is resolved for.
   * @returns The verdict of the attempt, which a caller acts on: a rebuild
   *   that did not complete leaves the board parked and the context reported
   *   lost.
   */
  const rebuildAfterContextRestore = (
    surface: HTMLCanvasElement,
    size: number,
    scale: ScaleName,
  ): ContextRestoreOutcome => {
    contextLost = false;

    if (disposed || !mounted) {
      return Object.freeze({
        rebuilt: false,
        contextLost: false,
        attempted: false,
      });
    }

    const carried = lastPlan;

    try {
      // Normally a no-op: `parkForContextLoss` already released everything
      // while the lost context still owned it.
      releaseGpuResources();

      webgl = openSurface(surface);

      // CHANGED: resolved into a local, so the scene and the two effect
      // controllers below are built against ONE geometry rather than the scene
      // against this one and the controllers against the desktop defaults.
      // DL-THREE-10.
      const restoredGeometry = resolveBoardGeometry(size, scale);

      scene = createScene({
        boardSize: size,
        geometry: restoredGeometry,
        theme: readPinnedTheme(),
        reporter,
      });
      materials = createTileMaterialCache({
        theme: options.theme,
        followActiveTheme: options.theme === undefined,
        reporter,
      });
      buildFactory(size, scale, materials);
      tweens = createTweenGroup({ reporter });
      particles = createParticleSystem({
        reporter,
        geometry: restoredGeometry,
      });
      camera = createCameraEffects(scene.camera, {
        reporter,
        geometry: restoredGeometry,
      });

      applyClearColor(readPinnedTheme() ?? getActiveTheme());
      ensureBoard(carried?.size ?? size);
    } catch (error: unknown) {
      contextLost = true;

      // And nothing is left allocated. The try above builds in order, so a
      // failure part-way through it leaves every resource created before the
      // throwing line holding a context this renderer will not draw with.
      releaseGpuResources();

      reporter.onCount({ name: CONTEXT_FAILED_METRIC, value: 1 });
      reporter.onDiagnostic({
        level: 'error',
        source: DIAGNOSTIC_SOURCE,
        message:
          'The WebGL context was restored but its resources could not be ' +
          'rebuilt, so the 2.5D board stays parked. The number-only board ' +
          'carries the same information.',
        detail: Object.freeze({ boardSize: size, scale }),
        error: describeRenderError(error),
        thrown: error,
      });

      return Object.freeze({
        rebuilt: false,
        contextLost: true,
        attempted: true,
      });
    }

    contextRestores += 1;

    // The LATEST committed state, re-queued so the next frame reconciles in
    // full.
    if (carried !== null) {
      queued = restPlan(carried);
    }

    reporter.onDiagnostic({
      level: 'info',
      source: DIAGNOSTIC_SOURCE,
      message:
        'The WebGL context was restored and the 2.5D board rebuilt its ' +
        'resources.',
      detail: Object.freeze({
        boardSize,
        reconciled: carried !== null,
        restores: contextRestores,
      }),
    });

    options.onWork?.();

    return Object.freeze({
      rebuilt: true,
      contextLost: false,
      attempted: true,
    });
  };

  const mount = (target?: Element | null): boolean => {
    if (disposed) {
      reporter.onDiagnostic({
        level: 'warning',
        source: DIAGNOSTIC_SOURCE,
        message: 'A mount was refused: the renderer is disposed.',
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

    // EVERY initialisation step is inside this guard, not just the context and
    // the scene.
    try {
      // The context is acquired here and nowhere else, so a caller that has
      // already probed for support decides whether to mount at all.
      webgl = openSurface(surface);

      // CHANGED, as at the rebuild site: one geometry for the scene and for both
      // effect controllers, so a session that mounts at the mobile scale never
      // starts with desktop magnitudes. DL-THREE-10.
      const mountedGeometry = resolveBoardGeometry(size, scale);

      scene = createScene({
        boardSize: size,
        geometry: mountedGeometry,
        theme: readPinnedTheme(),
        reporter,
      });

      materials = createTileMaterialCache({
        theme: options.theme,
        followActiveTheme: options.theme === undefined,
        reporter,
      });

      buildFactory(size, scale, materials);

      applyClearColor(readPinnedTheme() ?? getActiveTheme());

      // The context-loss handler the product has never had.
      releaseContextLoss = attachContextLossHandlers(
        surface,
        {
          onContextLost: (info: WebGLContextLossInfo): void => {
            parkForContextLoss();

            // Surfaced to whoever built this renderer, after this renderer's
            // own response, so a handler that reads `readStats.contextLost`
            // sees the loss the call is telling it about.
            options.onContextLost?.(info);
          },
          onContextRestored: (): void => {
            // The rebuild is run FIRST and its verdict held: an optional call
            // does not evaluate its arguments, so passing the rebuild inline
            // would skip it entirely for a renderer built with no callback.
            //
            // CHANGED: the LIVE size and the LIVE scale, resolved now. This
            // closure captured the two values `mount()` read once, so a context
            // lost and restored after a breakpoint crossing — or after the board
            // was rebuilt at another size — came back at the size and scale the
            // renderer had mounted at rather than the ones in force.
            // DL-THREE-08.
            const outcome = rebuildAfterContextRestore(
              surface,
              boardSize > 0 ? boardSize : readConfiguredSize(),
              resolveScale(),
            );

            options.onContextRestored?.(outcome);
          },
        },
        reporter,
      );

      tweens = createTweenGroup({ reporter });
      particles = createParticleSystem({ reporter, geometry: mountedGeometry });
      camera = createCameraEffects(scene.camera, {
        reporter,
        geometry: mountedGeometry,
      });

      // The number-only layer and the canvas are mutually exclusive: exactly
      // one of the two draws the board, and index.html ships the number-only
      // host hidden.
      const numberOnly = asHtmlElement(options.numberOnlyHost);

      if (numberOnly !== null) {
        numberOnlyWasHidden = numberOnly.hidden;
        numberOnly.hidden = true;
      }

      const canvasElement = asHtmlElement(surface);

      if (canvasElement !== null) {
        canvasElement.hidden = false;
      }

      markCanvasAria(surface);

      // Recorded the moment the swap completes, so a failure after this point
      // restores both hosts and a failure before it leaves them untouched.
      hostsSwapped = true;

      mounted = true;
      ensureBoard(size);
      claimParallelBoard(boardSize > 0 ? boardSize : size);
      openResize();

      releaseTheme = subscribeToThemeChange((theme: Theme): void => {
        // The material cache, the mesh factory and the scene's lighting rig
        // each follow the theme through their own subscription; this repaints
        // so the change reaches the screen without waiting for a turn,
        // refreshes the projection's theme id, and carries the palette into
        // the clear colour, which belongs to the renderer this module owns.
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
    } catch (error: unknown) {
      // The mount is UNWOUND, not abandoned. `mounted` is cleared first so
      // every guarded member refuses during the teardown, then `teardown`
      // releases whatever the try block reached and restores both hosts if the
      // swap ran.
      mounted = false;

      teardown();
      closeScale();

      reporter.onCount({ name: CONTEXT_FAILED_METRIC, value: 1 });
      reporter.onDiagnostic({
        level: 'error',
        source: DIAGNOSTIC_SOURCE,
        message:
          'The 2.5D board did not mount: a WebGL context or one of the ' +
          'renderer resources could not be created. Every partial resource ' +
          'was released and a caller selects the number-only renderer ' +
          'instead, which keeps the game playable.',
        detail: Object.freeze({ boardSize: size, scale }),
        error: describeRenderError(error),
        thrown: error,
      });

      return false;
    }

    options.onWork?.();

    return true;
  };

  /**
   * Releases every resource a mount may have taken, in the reverse of the
   * order it takes them, and restores every host it may have written.
   */
  const teardown = (): void => {
    releaseTheme?.();
    releaseTheme = null;
    closeResize();
    closeScale();

    clearLiveTiles();

    // Every trigger, not just the merge list.
    clearPendingTriggers();
    queued = null;

    lastScore = 0;

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
    contextLosses = 0;
    contextRestores = 0;
    orphanedTriggers = 0;

    // CHANGED: PARKED rather than disposed, so the next mount over this canvas
    // takes the same renderer and the same GL objects, and the pixel-store
    // state is left exactly as this renderer wrote it.
    // `releaseParkedRenderer` is the caller's way to give the context back, and
    // it resets that state as every release does. DL-THREE-06, DL-THREE-07.
    parkSurface();
    board = null;
    geometry = null;
    boardSize = 0;
    lastFrameAt = null;
    lastPlan = null;

    releaseParallelBoard();

    // Restored only where the swap actually ran.
    if (hostsSwapped) {
      const numberOnly = asHtmlElement(options.numberOnlyHost);

      if (numberOnly !== null) {
        numberOnly.hidden = numberOnlyWasHidden;
      }

      const canvasElement = asHtmlElement(canvas);

      if (canvasElement !== null) {
        canvasElement.hidden = true;
      }

      hostsSwapped = false;
    }

    // Released with the scene: a remount builds a new rig, which stands at the
    // scene's own default index until a stage is announced again.
    litStageIndex = null;

    // The `aria-hidden="true"` mount asserted is restored to the state the
    // canvas was found in.
    restoreCanvasAria(canvas);

    canvas = null;
  };

  const unmount = (): void => {
    if (!mounted) {
      return;
    }

    // Set FIRST, so `frame` and every other guarded member refuses while the
    // teardown runs and a remount starts from a known state.
    mounted = false;

    teardown();

    reporter.onCount({ name: UNMOUNT_METRIC, value: 1 });
  };

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

      clearPendingTriggers();

      return;
    }

    // Triggers armed by a turn other than this commit's are DISCARDED before
    // the plan is built, so a merge pop or a spawn tween can never play
    // against a board it was not armed for.
    triggersBelongTo(commit.turn);

    const delta = Math.max(0, commit.score - lastScore);

    lastScore = commit.score;

    // The stage slice of AAP Contract 1, which is the authority on the stage
    // in force: a board that carries across a stage boundary reports the new
    // index here, and the rig is tuned for it.
    lightForStage(commit.stage.stageIndex);

    // Planned here, inside the emission that carried the live board, and drawn
    // on the next frame.
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
    if (disposed || !admitTurn(merge.turn)) {
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

  /**
   * Records the cell one spawn resolved into, for its `appear` tween.
   *
   * `position` is absent for a spawn that inserted nothing — a full board, a
   * cell an `onSpawn` handler withheld, or one outside the lattice — per the
   * `TileSpawnEvent` contract of src/engine/engine-events.ts. Such an emission
   * arms nothing and is counted apart.
   */
  const onSpawn = (spawn: TileSpawnEvent): void => {
    if (disposed || !admitTurn(spawn.turn)) {
      return;
    }

    const position = spawn.position;

    if (position === undefined) {
      spawnsSuppressed += 1;

      reporter.onCount({
        name: SPAWN_SUPPRESSED_METRIC,
        value: 1,
        detail: Object.freeze({ tileValue: spawn.value }),
      });

      return;
    }

    pendingSpawns.add(cellKey(position.x, position.y));
    spawnsAnnounced += 1;

    reporter.onCount({
      name: SPAWN_METRIC,
      value: 1,
      detail: Object.freeze({
        tileValue: spawn.value,
        x: position.x,
        y: position.y,
      }),
    });
  };

  /**
   * Records the origin of every cell the resolved move repositioned a tile
   * into, keyed by destination.
   *
   * Read from the same `previousPosition` member js/html_actuator.js L54 read,
   * off the live board `move:after` carries.
   */
  const onMoveAfter = (move: MoveAfterEvent): void => {
    if (disposed || !move.moved || !admitTurn(move.turn)) {
      return;
    }

    const board = move.board;
    const size = board.size;
    let recorded = 0;

    for (let x = 0; x < size; x += 1) {
      for (let y = 0; y < size; y += 1) {
        const tile = readCell(board, x, y);
        const previous = tile?.previousPosition ?? null;

        if (tile === null || previous === null) {
          continue;
        }

        pendingMoveOrigins.set(cellKey(tile.x, tile.y), {
          x: previous.x,
          y: previous.y,
        });
        recorded += 1;
      }
    }

    movesAnnounced += 1;

    reporter.onCount({
      name: MOVE_METRIC,
      value: 1,
      detail: Object.freeze({ size, moved: recorded }),
    });
  };

  /**
   * Re-frames the board for the stage's size and re-tunes the lighting rig for
   * its index.
   *
   * `boardSize` is the size the stage's grid was built at, which for a board
   * restored from a snapshot is the size that snapshot carried. Generating the
   * board recalls every block into the factory's pool, so the plan the board
   * last showed is queued again, as the change of scale does.
   */
  const onStageStart = (stage: StageStartEvent): void => {
    if (disposed) {
      return;
    }

    stagesStarted += 1;

    const detail: RenderDetail = Object.freeze({
      stageIndex: stage.stageIndex,
      boardSize: stage.boardSize,
    });

    if (!isSupportedBoardSize(stage.boardSize)) {
      refusedSizes += 1;

      reporter.onCount({ name: REFUSED_SIZE_METRIC, value: 1, detail });
      reporter.onDiagnostic({
        level: 'warning',
        source: DIAGNOSTIC_SOURCE,
        message:
          'A stage announced a board size above the supported maximum; the ' +
          'board already drawn stands.',
        detail,
      });
    } else if (mounted && stage.boardSize !== boardSize) {
      ensureBoard(stage.boardSize);

      if (lastPlan !== null && lastPlan.size === stage.boardSize) {
        queued = restPlan(lastPlan);
      }
    }

    lightForStage(stage.stageIndex);

    reporter.onCount({ name: STAGE_START_METRIC, value: 1, detail });
    options.onWork?.();
  };

  /**
   * Presents one stage resolution on the board.
   *
   * A cleared stage punches the camera once. Suppressed while motion is to be
   * reduced by src/render/camera-effects.ts itself. The stage-clear copy, the
   * reward screen and the run summary belong to src/ui.
   */
  const onStageEnd = (stage: StageEndEvent): void => {
    if (disposed) {
      return;
    }

    stagesEnded += 1;

    const punched = stage.cleared ? (camera?.punch() ?? false) : false;

    reporter.onCount({
      name: STAGE_END_METRIC,
      value: 1,
      detail: Object.freeze({
        stageIndex: stage.stageIndex,
        cleared: stage.cleared,
        score: stage.score,
        punched,
      }),
    });

    if (punched) {
      options.onWork?.();
    }
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

    // The six names of AAP Contract 1 this renderer reads.
    const taken: EngineEventSubscription[] = [];

    // CHANGED: released in full whichever release raises, so one refusing
    // listener cannot strand the five behind it. DL-THREE-09.
    const releaseTaken = (): void => {
      let raised: unknown = null;
      let failed = false;

      for (const release of taken) {
        try {
          release();
        } catch (error: unknown) {
          if (!failed) {
            failed = true;
            raised = error;
          }
        }
      }

      // `taken` is NOT cleared here: the returned release reads it a second time
      // to remove each entry from the shared `subscriptions` collection.
      if (failed) {
        throw raised;
      }
    };

    // CHANGED: ONE AT A TIME, so a registration that raises part-way rolls the
    // ones already taken back. They were taken in an array literal, so a throw
    // from the third `on()` left the first two attached to the emitter with no
    // reference to them anywhere — this renderer went on drawing for an engine
    // it had reported it was not subscribed to, and neither `dispose()` nor the
    // returned release could reach them. Rolling back and rethrowing leaves the
    // emitter as it was, so the caller can retry. DL-THREE-09.
    try {
      taken.push(events.on('stage:start', onStageStart));
      taken.push(events.on('tile:merge', onMerge));
      taken.push(events.on('tile:spawn', onSpawn));
      taken.push(events.on('move:after', onMoveAfter));
      taken.push(events.on('stage:end', onStageEnd));
      taken.push(events.on('state:commit', render));
    } catch (error: unknown) {
      try {
        releaseTaken();
      } catch {
        // A release that refuses during a rollback is contained: the
        // registration failure below is the one the caller has to act on.
      }

      taken.length = 0;

      reporter.onCount({
        name: REFUSED_SUBSCRIBE_METRIC,
        value: 1,
        detail: Object.freeze({ phase: 'registering' }),
      });

      throw error;
    }

    // `events.on` can dispose this renderer before it returns, by way of a
    // listener the same emitter already holds.
    if (disposed) {
      try {
        releaseTaken();
      } catch {
        // Contained: this path already answers "not subscribed", and there is
        // no caller left to act on a release that refused.
      }

      reporter.onCount({
        name: REFUSED_SUBSCRIBE_METRIC,
        value: 1,
        detail: Object.freeze({ phase: 'during' }),
      });

      return (): void => {
        // Already released above.
      };
    }

    subscriptions.push(...taken);

    let released = false;

    return (): void => {
      if (released) {
        return;
      }

      released = true;

      // CHANGED: `try`/`finally`, so a listener release that raises still
      // leaves the shared collection accurate. It used to run the removal after
      // the releases, so one refusing release left every entry of this
      // subscription in `subscriptions` — and `dispose()` then called each of
      // them a second time. DL-THREE-09.
      try {
        releaseTaken();
      } finally {
        // Removed from the shared collection, not merely called.
        for (const release of taken) {
          const index = subscriptions.indexOf(release);

          if (index >= 0) {
            subscriptions.splice(index, 1);
          }
        }
      }
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
        pendingSpawns: pendingSpawns.size,
        pendingMoves: pendingMoveOrigins.size,
        orphanedTriggers,
        contextLosses,
        contextRestores,
        pendingTurn,
        spawnsAnnounced,
        spawnsSuppressed,
        movesAnnounced,
        stagesStarted,
        litStageIndex,
        stagesEnded,
        refusedSizes,
        contextLost,
        disposed,
      }),
  });
}
