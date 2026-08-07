// Extruded block geometry, instance management, and the generated board of the
// WebGL renderer.
//
// This module owns every geometry the 2.5D board is built from — the tile
// block, the board field, the empty-cell plate and the numeral plane — and the
// mapping from a zero-based engine cell coordinate to a world position. The
// materials that dress those geometries come from src/render/tile-materials.ts
// and are owned by the cache that builds them; the geometries and the numeral
// textures are created here and are released by `dispose()`.
//
// The board is generated from the board size the configuration carries, which
// is what replaced the sixteen static `.grid-cell` elements and the empty
// `.tile-container` of index.html. The size is read from the `RulesConfig` of
// src/config/rules-config.ts on every build; `gridRowCells` of
// src/theme/tokens.ts is the stylesheet's presentation of the same dimension
// and is not read here.
//
// The three extrusion depths are `depthScale` of src/theme/tokens.ts, each an
// arithmetic expression on `gridSpacing`; no length in this module is stated as
// a literal. `bevelSize` of `ExtrudeGeometry` grows the footprint outward and
// `bevelThickness` grows the z-extent at both ends, so the outline is built at
// `tileSize - 2 * depthScale.bevel` and extruded `depthScale.tile -
// 2 * depthScale.bevel`, which resolves the block's bounding box to exactly
// `tileSize` square by `depthScale.tile` deep.
//
// The mobile scale is the mobile-threshold block of style/main.scss, which
// re-invokes the game field with the mobile lengths. Both scales resolve
// through `geometryScales` of src/theme/tokens.ts, and the scale is selected
// once per factory.
//
// This module holds no scene, camera, renderer or engine reference; it reads no
// clock, consumes no randomness and performs no I/O; it imports nothing from
// src/engine or src/observability and no stylesheet. Its only contact with the
// document is the canvas a numeral texture is drawn on, which is created, drawn
// and handed to a texture without ever being appended; `OffscreenCanvas` is
// used where the platform provides it. Reporting is injected and defaults to
// the no-op sink. One geometry is shared by every mesh of a given shape, one
// numeral texture is shared by every mesh carrying a given value, and every
// geometry, texture and material this module creates is released by
// `dispose()`.

import {
  CanvasTexture,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Shape,
  Vector3,
} from 'three';

import type { RulesConfig } from '../config/rules-config';
import type { Position } from '../engine/types';
import { subscribeToThemeChange } from '../theme/themes';
import type { GeometryScale, ScaleName } from '../theme/tokens';
import {
  boardBorderRadius,
  createGeometryScale,
  depthScale,
  fontFamily,
  geometryScales,
  tileFontSize,
  tilePositionStep,
} from '../theme/tokens';
import type { TileMaterialCache } from './tile-materials';
import type { RenderDetail, RenderReporter } from './webgl-support';
import {
  NOOP_RENDER_REPORTER,
  createGuardedRenderReporter,
  describeRenderError,
} from './webgl-support';

const MODULE_SOURCE = 'render.tile-mesh-factory';

const BOARD_BUILT_METRIC = 'render.board.built';

const BOARD_RESIZED_METRIC = 'render.board.resized';

const POOL_HIT_METRIC = 'render.tile.pool.hit';

const POOL_MISS_METRIC = 'render.tile.pool.miss';

const POOL_RELEASE_METRIC = 'render.tile.pool.release';

const POOL_REJECTED_METRIC = 'render.tile.pool.rejected';

const POOL_RECALLED_METRIC = 'render.tile.pool.recalled';

const GEOMETRY_DISPOSED_METRIC = 'render.geometry.disposed';

const NUMERAL_CREATED_METRIC = 'render.numeral.created';

const NUMERAL_DISPOSED_METRIC = 'render.numeral.disposed';

const NUMERAL_UNAVAILABLE_METRIC = 'render.numeral.unavailable';

/** A numeral was refused: the value is undrawable, or the cache is full. */
const NUMERAL_REFUSED_METRIC = 'render.numeral.refused';

/** A cached numeral texture was released to hold the cache at its ceiling. */
const NUMERAL_EVICTED_METRIC = 'render.numeral.evicted';

/** A numeral was narrowed to fit the width of the tile box. */
const NUMERAL_CONDENSED_METRIC = 'render.numeral.condensed';

const NUMERAL_THEME_REBUILD_METRIC = 'render.numeral.theme.rebuild';

/** Counter name for one theme refresh that rebound the live meshes. */
const THEME_REFRESH_METRIC = 'render.tile.theme.refresh';

/** A construction option was replaced by its default. */
const INVALID_OPTION_METRIC = 'render.mesh.option.invalid';

const CORNER_SEGMENTS = 6;

const BEVEL_SEGMENTS = 2;

const DEFAULT_NUMERAL_TEXTURE_SCALE = 2;

const MIN_NUMERAL_TEXTURE_SCALE = 1;

const MAX_NUMERAL_TEXTURE_SCALE = 8;

const NUMERAL_POLYGON_OFFSET = -1;

const MIN_TILE_VALUE = 2;

/**
 * Base every drawable tile value is a power of.
 *
 * A count, not a length: `tileRampConstants.base` of src/theme/tile-ramp.ts
 * states the same base, and `rampExponent` there accepts a value only where
 * `base ** exponent` reproduces it exactly.
 */
const NUMERAL_VALUE_BASE = 2;

/**
 * Lowest exponent whose numeral is drawn.
 *
 * `tileRampConstants.exponentStart` of src/theme/tile-ramp.ts, which is the
 * exponent `MIN_TILE_VALUE` stands for.
 */
const MIN_NUMERAL_EXPONENT = 1;

/**
 * Highest exponent whose numeral is drawn.
 *
 * `NUMERAL_VALUE_BASE ** 52` is the largest power of the base that is a safe
 * integer, so it is the largest value `String(value)` prints the digits of
 * exactly rather than in exponent notation.
 */
const MAX_NUMERAL_EXPONENT = 52;

/**
 * Numeral materials held at once.
 *
 * A count, not a length. It exceeds the sixteen cells of the default board, so
 * every value a 4x4 board carries at one time is held together.
 */
const MAX_CACHED_NUMERALS = 24;

/**
 * Refusal diagnostics emitted over one factory's life.
 *
 * A count, not a length: the refusal counter and its metric carry every
 * refusal, and this bounds only how many of them are also described.
 */
const MAX_REPORTED_NUMERAL_REFUSALS = 8;

/* ==========================================================================
 * 3. Board geometry resolution
 * ========================================================================== */

/**
 * Rejects an argument that is not a positive integer.
 *
 * @param name Parameter name, for the thrown message.
 * @param value Candidate value.
 * @throws RangeError when `value` is not a positive integer.
 */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(
      `tile-mesh-factory: ${name} must be a positive integer, received ` +
        String(value),
    );
  }
}

function assertFiniteNumber(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(
      `tile-mesh-factory: ${name} must be a finite number, received ` +
        String(value),
    );
  }
}

/**
 * Resolves the lengths one board size occupies at one of the stylesheet's two
 * scales.
 *
 * `tileSize` is `(fieldWidth - gridSpacing * (boardSize + 1)) / boardSize` and
 * is therefore a function of the board size: a board rebuilt at another size
 * recomputes it rather than reusing the four-cell value. `fieldWidth`,
 * `gridSpacing` and `tileBorderRadius` are the scale's own, so both the
 * default scale of style/main.scss and its `smaller($mobile-threshold)` scale
 * resolve through this one call.
 *
 * @throws RangeError when `boardSize` is not a positive integer.
 */
export function resolveBoardGeometry(
  boardSize: number,
  scale: ScaleName = 'desktop',
): GeometryScale {
  assertPositiveInteger('boardSize', boardSize);
  const base = geometryScales[scale];
  return createGeometryScale({
    fieldWidth: base.fieldWidth,
    gridSpacing: base.gridSpacing,
    gridRowCells: boardSize,
    tileBorderRadius: base.tileBorderRadius,
    gameContainerMarginTop: base.gameContainerMarginTop,
  });
}

/**
 * Edge length of the block's top face, in px.
 *
 * `bevelSize` grows the extruded outline outward by `depthScale.bevel` on
 * every side, so the outline is built this much narrower than the footprint
 * and the top face resolves to the same length.
 */
export function tileOutlineSize(geometry: GeometryScale): number {
  return geometry.tileSize - depthScale.bevel * 2;
}

/**
 * The z coordinate of each surface of the board stack, in px.
 *
 * Every entry is an expression on `depthScale` of src/theme/tokens.ts. The
 * field's top surface is the origin of the stack, the plate lies on it, and a
 * tile block stands on the plate.
 */
export const boardLayers = Object.freeze({
  fieldBase: -depthScale.board,
  fieldSurface: 0,
  cellPlateSurface: depthScale.bevel,
  tileBase: depthScale.bevel,
  tileSurface: depthScale.bevel + depthScale.tile,
});

/* ==========================================================================
 * 4. Cell coordinate to world position
 * ========================================================================== */

/**
 * Step from the board field's leading edge to one cell index, in px.
 *
 * `tilePositionStep` of src/theme/tokens.ts is the port of
 * `math.floor(($tile-size + $grid-spacing) * ($x - 1))` at style/main.scss
 * L492-L493, and it accepts a non-negative integer alone. This is the anchor
 * every coordinate is measured from.
 *
 * @param index Zero-based cell index along one axis.
 * @param geometry Resolved lengths for the board size and scale in force.
 * @returns The step, in px.
 */
function cellAxisAnchor(index: number, geometry: GeometryScale): number {
  if (index >= 0) {
    return tilePositionStep(index, geometry);
  }

  // Outside the lattice, where the Sass loop states no position; the
  // unfloored expression continues the same line.
  return (geometry.tileSize + geometry.gridSpacing) * index;
}

/**
 * Offset of a cell's centre from the board field's leading edge along one axis,
 * in px.
 *
 * ONE CONTINUOUS FUNCTION over both integer and fractional coordinates. The
 * snapping policy lives entirely in the anchors: every integer coordinate
 * resolves to `cellAxisAnchor`, which is the floored Sass step, and a
 * fractional coordinate — the state a `MoveTweenValue` of
 * src/render/animations.ts carries between two cells — interpolates linearly
 * between the anchors of the two integers bracketing it. The function is
 * therefore exact at every cell AND continuous across every cell boundary;
 * flooring only the integer case left a discontinuity of up to a pixel at each
 * boundary, which a move tween crossed on its way through.
 *
 * @param coordinate Zero-based cell coordinate along one axis; may be
 *   fractional.
 * @param geometry Resolved lengths for the board size and scale in force.
 * @returns Distance from the field's leading edge to the cell's centre, in px.
 */
function cellAxisOffset(coordinate: number, geometry: GeometryScale): number {
  const lower = Math.floor(coordinate);
  const fraction = coordinate - lower;
  const anchor = cellAxisAnchor(lower, geometry);
  const step =
    fraction === 0
      ? anchor
      : anchor + fraction * (cellAxisAnchor(lower + 1, geometry) - anchor);

  return geometry.gridSpacing + step + geometry.tileSize / 2;
}

/**
 * World position of the tile that occupies one cell.
 *
 * Cell `{x, y}` maps to world `x` rightward and world `-y` downward, and z to
 * `boardLayers.tileBase`; the board is centred on the origin by subtracting
 * half the field width along both axes. Coordinates are the engine's
 * zero-based ones — the `+1` normalisation of js/html_actuator.js L97-L104
 * built CSS class names and has no counterpart here.
 *
 * @returns `target`, or the newly allocated vector.
 * @throws RangeError when `boardSize` is not a positive integer, or when
 *   either coordinate is not finite.
 */
export function cellToWorld(
  position: Position,
  boardSize: number,
  scale: ScaleName = 'desktop',
  target?: Vector3,
): Vector3 {
  const geometry = resolveBoardGeometry(boardSize, scale);
  return cellToWorldIn(position, geometry, target);
}

/**
 * World position of the tile that occupies one cell, against lengths already
 * resolved.
 *
 * @returns `target`, or the newly allocated vector.
 * @throws RangeError when either coordinate is not finite.
 */
export function cellToWorldIn(
  position: Position,
  geometry: GeometryScale,
  target?: Vector3,
): Vector3 {
  assertFiniteNumber('position.x', position.x);
  assertFiniteNumber('position.y', position.y);
  const half = geometry.fieldWidth / 2;
  const out = target ?? new Vector3();
  return out.set(
    cellAxisOffset(position.x, geometry) - half,
    half - cellAxisOffset(position.y, geometry),
    boardLayers.tileBase,
  );
}

/**
 * Index of one cell in the flat plate array a build produces.
 *
 * The array is x-major, matching the `CellMatrix` of src/engine/types.ts,
 * whose backing store is indexed `cells[x][y]`.
 *
 * @throws RangeError when `boardSize` is not a positive integer, or when
 *   either coordinate is outside the lattice.
 */
export function cellArrayIndex(position: Position, boardSize: number): number {
  assertPositiveInteger('boardSize', boardSize);
  for (const axis of ['x', 'y'] as const) {
    const coordinate = position[axis];
    if (
      !Number.isInteger(coordinate) ||
      coordinate < 0 ||
      coordinate >= boardSize
    ) {
      throw new RangeError(
        `tile-mesh-factory: position.${axis} must be an integer in ` +
          `0..${boardSize - 1}, received ` +
          String(coordinate),
      );
    }
  }
  return position.x * boardSize + position.y;
}

const QUARTER_TURN = Math.PI / 2;

function createRoundedSquare(edge: number, radius: number): Shape {
  assertFiniteNumber('edge', edge);
  assertFiniteNumber('radius', radius);
  if (edge <= 0) {
    throw new RangeError(
      `tile-mesh-factory: edge must be positive, received ${String(edge)}`,
    );
  }
  const corner = Math.max(0, Math.min(radius, edge / 2));
  const min = -edge / 2;
  const max = edge / 2;
  const shape = new Shape();

  shape.moveTo(min + corner, min);
  shape.lineTo(max - corner, min);
  shape.absarc(max - corner, min + corner, corner, -QUARTER_TURN, 0, false);
  shape.lineTo(max, max - corner);
  shape.absarc(max - corner, max - corner, corner, 0, QUARTER_TURN, false);
  shape.lineTo(min + corner, max);
  shape.absarc(
    min + corner,
    max - corner,
    corner,
    QUARTER_TURN,
    Math.PI,
    false,
  );
  shape.lineTo(min, min + corner);
  shape.absarc(
    min + corner,
    min + corner,
    corner,
    Math.PI,
    Math.PI + QUARTER_TURN,
    false,
  );
  shape.closePath();

  return shape;
}

function createTileGeometry(geometry: GeometryScale): ExtrudeGeometry {
  const built = new ExtrudeGeometry(
    createRoundedSquare(tileOutlineSize(geometry), geometry.tileBorderRadius),
    {
      curveSegments: CORNER_SEGMENTS,
      depth: depthScale.tile - depthScale.bevel * 2,
      bevelEnabled: true,
      bevelThickness: depthScale.bevel,
      bevelSize: depthScale.bevel,
      bevelOffset: 0,
      bevelSegments: BEVEL_SEGMENTS,
    },
  );
  built.translate(0, 0, depthScale.bevel);
  return built;
}

function createFieldGeometry(geometry: GeometryScale): ExtrudeGeometry {
  const built = new ExtrudeGeometry(
    createRoundedSquare(geometry.fieldWidth, boardBorderRadius),
    {
      curveSegments: CORNER_SEGMENTS,
      depth: depthScale.board,
      bevelEnabled: false,
    },
  );
  built.translate(0, 0, boardLayers.fieldBase);
  return built;
}

function createCellPlateGeometry(geometry: GeometryScale): ExtrudeGeometry {
  return new ExtrudeGeometry(
    createRoundedSquare(geometry.tileSize, geometry.tileBorderRadius),
    {
      curveSegments: CORNER_SEGMENTS,
      depth: depthScale.bevel,
      bevelEnabled: false,
    },
  );
}

function createNumeralPlaneGeometry(geometry: GeometryScale): PlaneGeometry {
  return new PlaneGeometry(geometry.tileSize, geometry.tileSize);
}

/* ==========================================================================
 * 6. Numeral layout and its texture
 * ========================================================================== */

/**
 * The bounds a factory holds its numeral textures within, as the names the
 * renderer and its tests read them by.
 */
export const numeralCacheBounds = Object.freeze({
  /** Lowest tile value a numeral is drawn for. */
  minValue: MIN_TILE_VALUE,

  /** Highest tile value a numeral is drawn for. */
  maxValue: NUMERAL_VALUE_BASE ** MAX_NUMERAL_EXPONENT,

  /** Lowest exponent a numeral is drawn for. */
  minExponent: MIN_NUMERAL_EXPONENT,

  /** Highest exponent a numeral is drawn for. */
  maxExponent: MAX_NUMERAL_EXPONENT,

  /** Distinct values the domain holds, and so the widest the cache can be. */
  domainSize: MAX_NUMERAL_EXPONENT - MIN_NUMERAL_EXPONENT + 1,

  /** Numeral materials held at once, drawn and undrawable together. */
  maxCached: MAX_CACHED_NUMERALS,

  /** Refusal diagnostics emitted over one factory's life. */
  maxReportedRefusals: MAX_REPORTED_NUMERAL_REFUSALS,
});

/**
 * Whether a tile value's numeral is drawn at all.
 *
 * The domain is the one `rampExponent` of src/theme/tile-ramp.ts accepts — a
 * power of `NUMERAL_VALUE_BASE` at `MIN_NUMERAL_EXPONENT` or above — narrowed
 * at the top to the exponent whose value is still a safe integer, so the
 * decimal digits `drawNumeral` writes are the value's own. Every other value,
 * including a non-integer, a negative, a non-finite and a power of another
 * base, is outside it.
 *
 * @param value Tile value.
 * @returns Whether a numeral texture is drawn and cached for `value`.
 */
export function isDrawableTileValue(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return false;
  }
  if (value < MIN_TILE_VALUE) {
    return false;
  }
  const exponent = Math.round(Math.log2(value));
  return (
    exponent >= MIN_NUMERAL_EXPONENT &&
    exponent <= MAX_NUMERAL_EXPONENT &&
    NUMERAL_VALUE_BASE ** exponent === value
  );
}

/** How a numeral is laid out on its texture, in px. */
export interface NumeralLayout {
  readonly canvasPixels: number;
  readonly boxSize: number;

  /**
   * Numeral size before any narrowing, in px. The digit-count step
   * style/main.scss declares for this value, resolved by `tileFontSize` of
   * src/theme/tokens.ts.
   */
  readonly fontSize: number;
  readonly textureScale: number;
  readonly maxTextWidth: number;
}

/**
 * Resolves how one tile value's numeral is laid out.
 *
 * The canvas is the tile box of style/main.scss multiplied by the
 * texel-density multiplier, and the numeral takes the digit-count step
 * style/main.scss declares, which `tileFontSize`
 * of src/theme/tokens.ts resolves. The drawable width insets the box by one
 * `tileBorderRadius` a side.
 *
 * @throws RangeError when `value` is not a finite positive number.
 */
export function resolveNumeralLayout(
  value: number,
  geometry: GeometryScale,
  scale: ScaleName = 'desktop',
  textureScale: number = DEFAULT_NUMERAL_TEXTURE_SCALE,
): NumeralLayout {
  assertFiniteNumber('value', value);
  if (value <= 0) {
    throw new RangeError(
      `tile-mesh-factory: value must be positive, received ${String(value)}`,
    );
  }
  assertPositiveInteger('textureScale', textureScale);
  const boxSize = geometry.tileBoxSize;
  return {
    canvasPixels: Math.ceil(boxSize * textureScale),
    boxSize,
    fontSize: tileFontSize(value, scale),
    textureScale,
    maxTextWidth: Math.max(
      1,
      boxSize - geometry.tileBorderRadius * 2,
    ),
  };
}

type NumeralCanvas = HTMLCanvasElement | OffscreenCanvas;

type NumeralContext =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;

interface NumeralSurface {
  readonly canvas: NumeralCanvas;
  readonly context: NumeralContext;
}

function createNumeralSurface(pixels: number): NumeralSurface | null {
  let canvas: NumeralCanvas | null = null;

  if (typeof OffscreenCanvas === 'function') {
    try {
      canvas = new OffscreenCanvas(pixels, pixels);
    } catch {
      canvas = null;
    }
  }

  if (canvas === null && typeof document !== 'undefined') {
    try {
      const element = document.createElement('canvas');
      element.width = pixels;
      element.height = pixels;
      canvas = element;
    } catch {
      canvas = null;
    }
  }

  if (canvas === null) {
    return null;
  }

  let context: NumeralContext | null = null;
  try {
    context = canvas.getContext('2d') as NumeralContext | null;
  } catch {
    context = null;
  }

  if (context === null) {
    return null;
  }

  return { canvas, context };
}

function drawNumeral(
  surface: NumeralSurface,
  value: number,
  color: string,
  layout: NumeralLayout,
): boolean {
  const { context } = surface;
  const centre = layout.boxSize / 2;
  const text = String(value);

  context.setTransform(
    layout.textureScale,
    0,
    0,
    layout.textureScale,
    0,
    0,
  );
  context.clearRect(
    0,
    0,
    layout.boxSize,
    layout.boxSize,
  );
  context.fillStyle = color;
  context.textAlign = 'center';
  context.textBaseline = 'middle';

  // `font-weight: bold` at style/main.scss, and the stack of
  // `fontFamily` in src/theme/tokens.ts.
  context.font = `bold ${layout.fontSize}px ${fontFamily}`;

  let condensed = false;
  const measured = context.measureText(text).width;
  if (Number.isFinite(measured) && measured > layout.maxTextWidth) {
    const fitted = Math.max(
      1,
      Math.floor((layout.fontSize * layout.maxTextWidth) / measured),
    );
    context.font = `bold ${fitted}px ${fontFamily}`;
    condensed = true;
  }

  context.fillText(text, centre, centre);
  return condensed;
}

/** A tile block: the shared block geometry dressed in one value's material. */
export type TileMesh = Mesh<ExtrudeGeometry, MeshStandardMaterial>;

/** The meshes one board build produced. */
export interface BoardMeshes {
  readonly boardSize: number;
  readonly geometry: GeometryScale;
  readonly group: Group;
  readonly field: Mesh<ExtrudeGeometry, MeshStandardMaterial>;
  readonly cells: readonly Mesh<ExtrudeGeometry, MeshStandardMaterial>[];
  readonly tileLayer: Group;
}

/** What one factory has done and where it stands. */
export interface TileMeshFactoryStats {
  /** Cells per board row the last build resolved, `null` before the first. */
  readonly boardSize: number | null;
  readonly scale: ScaleName;
  readonly boardsBuilt: number;
  readonly boardResizes: number;
  readonly tileMeshesCreated: number;
  readonly tileMeshesTracked: number;
  readonly pooledTileMeshes: number;
  readonly poolHits: number;
  readonly poolMisses: number;
  readonly poolReleases: number;
  readonly poolRejections: number;
  readonly tileMeshesRecalled: number;
  readonly cachedNumerals: number;
  readonly numeralsCreated: number;

  /** Numerals that could not be drawn for want of a drawing surface. */
  readonly numeralsUnavailable: number;

  /**
   * Numerals refused without a texture being drawn: the value is outside the
   * domain `isDrawableTileValue` accepts, or the cache stood full of entries a
   * block on the board wears.
   */
  readonly numeralsRefused: number;

  /** Cache entries released to hold the cache at its ceiling. */
  readonly numeralsEvicted: number;

  /** Numerals narrowed to fit the width of the tile box. */
  readonly numeralsCondensed: number;
  readonly numeralThemeRebuilds: number;
  readonly geometriesDisposed: number;
  readonly numeralsDisposed: number;
  readonly invalidOptions: number;
  readonly disposed: boolean;
}

/** Construction options for `createTileMeshFactory`. */
export interface TileMeshFactoryOptions {
  readonly config: Pick<RulesConfig, 'boardSize'>;
  readonly materials: TileMaterialCache;
  readonly scale?: ScaleName;
  readonly numeralTextureScale?: number;

  /**
   * Sink this factory reports through. Defaults to `NOOP_RENDER_REPORTER`, and
   * is wrapped so no channel of it can throw into a caller.
   */
  readonly reporter?: RenderReporter;
}

/**
 * The geometry owner: it generates the board, hands out tile blocks, maps
 * cells to world positions, and releases everything it created.
 */
export interface TileMeshFactory {
  /**
   * Generates the board at one size, replacing any board generated before.
   *
   * A build at a size other than the previous one releases every geometry and
   * numeral texture the previous size resolved: all four are functions of
   * `tileSize`, and `tileSize` is a function of the board size. A build at the
   * same size reuses them. Either way the meshes of the previous build are
   * detached, so a board-mutating relic that changes the size gets a board
   * whose every world position is re-derived from the new size.
   *
   * @throws RangeError when the resolved size is not a positive integer.
   * @throws Error when the factory has been disposed.
   */
  buildBoard(boardSize?: number): BoardMeshes;
  readBoard(): BoardMeshes | null;
  cellToWorld(position: Position, target?: Vector3): Vector3;
  acquireTileMesh(value: number): TileMesh;

  /**
   * Returns a block to the pool, detaching it and hiding it.
   *
   * A mesh this factory did not hand out, and a mesh already idle, are refused
   * and reported rather than admitted twice.
   */
  releaseTileMesh(mesh: TileMesh): boolean;

  /**
   * Rebinds every live mesh to the materials the cache holds now, and redraws
   * the numeral textures where the cache has moved to another theme.
   *
   * Called for a caller by the factory's own theme subscription, so a palette
   * switch reaches the field, every cell plate, every block handed out and
   * every numeral without a caller having to notice. A pooled block is left
   * alone: `acquireTileMesh` dresses it before handing it out again.
   *
   * @returns `true` where meshes were rebound, and `false` where no board is
   *   built or the factory is disposed.
   */
  refreshTheme(): boolean;

  /**
   * Releases every geometry and numeral texture this factory created, the
   * materials it created for the numeral planes, and its theme subscription.
   *
   * The materials the injected cache hands out are the cache's and are left
   * alone. Three.js frees no GPU resource on collection, so this is the call a
   * board teardown makes. The factory is not usable afterwards.
   */
  dispose(): void;
  readStats(): TileMeshFactoryStats;
  resetStats(): void;
}

type CacheTheme = ReturnType<TileMaterialCache['getTheme']>;

type NumeralMesh = Mesh<PlaneGeometry, MeshBasicMaterial>;

interface TileMeshRecord {
  readonly numeral: NumeralMesh;
  value: number;
  idle: boolean;
}

interface SizedGeometries {
  readonly tile: ExtrudeGeometry;
  readonly field: ExtrudeGeometry;
  readonly plate: ExtrudeGeometry;
  readonly numeralPlane: PlaneGeometry;
}

const SCALE_NAMES: readonly ScaleName[] = Object.freeze([
  'desktop',
  'mobile',
]);

/**
 * Builds the geometry owner for the WebGL board.
 *
 * Nothing is constructed at call time: the options are validated and the
 * injected collaborators are held, and every geometry is built by the first
 * `buildBoard()` call. The board size is read from `options.config` at each
 * build rather than captured, so a board-mutating relic that changes it is
 * followed by the next build.
 *
 * @returns A frozen factory.
 * @throws TypeError when `config` or `materials` is absent.
 */
export function createTileMeshFactory(
  options: TileMeshFactoryOptions,
): TileMeshFactory {
  const reporter = createGuardedRenderReporter(
    options.reporter ?? NOOP_RENDER_REPORTER,
  );

  if (
    options.config === null ||
    typeof options.config !== 'object' ||
    options.materials === null ||
    typeof options.materials !== 'object'
  ) {
    throw new TypeError(
      'tile-mesh-factory: options.config and options.materials are required',
    );
  }

  const config = options.config;
  const materials = options.materials;

  let invalidOptions = 0;

  const rejectOption = (
    name: string,
    received: unknown,
    applied: string | number,
  ): void => {
    invalidOptions += 1;
    reporter.onCount({
      name: INVALID_OPTION_METRIC,
      value: 1,
      detail: { option: name },
    });
    reporter.onDiagnostic({
      level: 'warning',
      source: MODULE_SOURCE,
      message: `Option ${name} was refused and its default applied`,
      detail: { option: name, received: String(received), applied },
    });
  };

  const scale: ScaleName = SCALE_NAMES.includes(
    options.scale ?? SCALE_NAMES[0],
  )
    ? (options.scale ?? SCALE_NAMES[0])
    : SCALE_NAMES[0];
  if (options.scale !== undefined && scale !== options.scale) {
    rejectOption('scale', options.scale, scale);
  }

  let numeralTextureScale = DEFAULT_NUMERAL_TEXTURE_SCALE;
  if (options.numeralTextureScale !== undefined) {
    const candidate = options.numeralTextureScale;
    if (
      Number.isInteger(candidate) &&
      candidate >= MIN_NUMERAL_TEXTURE_SCALE &&
      candidate <= MAX_NUMERAL_TEXTURE_SCALE
    ) {
      numeralTextureScale = candidate;
    } else {
      rejectOption(
        'numeralTextureScale',
        candidate,
        DEFAULT_NUMERAL_TEXTURE_SCALE,
      );
    }
  }

  /* ---- State ---- */

  let geometries: SizedGeometries | null = null;
  let resolvedGeometry: GeometryScale | null = null;
  let board: BoardMeshes | null = null;
  let disposed = false;

  /**
   * Numeral material per tile value, holding `null` for a drawable value whose
   * own numeral could not be drawn.
   *
   * Only a value `isDrawableTileValue` accepts is ever a key, and the map holds
   * at most `MAX_CACHED_NUMERALS` of them: a write past that releases the least
   * recently used entry no block on the board wears, and where every entry is
   * worn the numeral is refused instead. Iteration order is insertion order and
   * a read reinserts, so the first key is the least recently used one.
   */
  const numeralMaterials = new Map<number, MeshBasicMaterial | null>();

  /**
   * Whether no two-dimensional drawing surface is reachable.
   *
   * Latched by the first probe that finds none, so the platform is probed once
   * rather than once per value and no cache entry stands for it.
   */
  let numeralSurfaceUnavailable = false;

  /** Every block handed out, keyed by the block itself. */
  const tileRecords = new Map<TileMesh, TileMeshRecord>();

  const pool: TileMesh[] = [];

  /** Material a block wears where its value's numeral could not be drawn. */
  let blankNumeralMaterial: MeshBasicMaterial | null = null;

  const scratch = new Vector3();

  let boardsBuilt = 0;
  let boardResizes = 0;
  let tileMeshesCreated = 0;
  let poolHits = 0;
  let poolMisses = 0;
  let poolReleases = 0;
  let poolRejections = 0;
  let tileMeshesRecalled = 0;
  let numeralsCreated = 0;
  let numeralsUnavailable = 0;
  let numeralsRefused = 0;
  let numeralsEvicted = 0;
  let numeralsCondensed = 0;
  let numeralThemeRebuilds = 0;

  /** Refusal diagnostics emitted, held under the reporting bound. */
  let numeralRefusalReports = 0;

  /** Theme the cached numeral textures were drawn against. */
  let numeralTheme: CacheTheme | null = null;

  /** Releases the theme subscription installed at the end of construction. */
  let releaseTheme: (() => void) | null = null;
  let geometriesDisposed = 0;
  let numeralsDisposed = 0;

  const assertLive = (): void => {
    if (disposed) {
      throw new Error('tile-mesh-factory: the factory has been disposed');
    }
  };

  const requireGeometry = (): GeometryScale => {
    assertLive();
    if (resolvedGeometry === null) {
      throw new Error(
        'tile-mesh-factory: buildBoard() must run before this call',
      );
    }
    return resolvedGeometry;
  };

  const requireBlankNumeralMaterial = (): MeshBasicMaterial => {
    blankNumeralMaterial ??= new MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    return blankNumeralMaterial;
  };

  const reconcileNumeralTheme = (): void => {
    let active: CacheTheme | null = null;
    try {
      active = materials.getTheme();
    } catch (error) {
      reporter.onDiagnostic({
        level: 'warning',
        source: MODULE_SOURCE,
        message: 'The material cache reported no theme',
        error: describeRenderError(error),
        thrown: error,
      });
      return;
    }

    if (numeralTheme !== null && numeralTheme !== active) {
      disposeNumerals();
      numeralThemeRebuilds += 1;
      reporter.onCount({
        name: NUMERAL_THEME_REBUILD_METRIC,
        value: 1,
      });
    }
    numeralTheme = active;
  };

  /**
   * Whether a block in use is wearing the numeral cached for one value.
   *
   * A block standing idle in the pool is detached from its parent and made
   * invisible by `releaseTileMesh`, and is dressed afresh on its next
   * acquisition, so only a block in use holds a cache entry in place.
   *
   * @param value Tile value the entry is keyed by.
   * @returns Whether a block in use carries that value.
   */
  const numeralInUse = (value: number): boolean => {
    for (const record of tileRecords.values()) {
      if (!record.idle && record.value === value) {
        return true;
      }
    }
    return false;
  };

  /**
   * Releases the least recently used cache entry no block in use wears.
   *
   * @returns Whether an entry was released.
   */
  const evictLeastRecentNumeral = (): boolean => {
    for (const [value, material] of numeralMaterials) {
      if (numeralInUse(value)) {
        continue;
      }

      numeralMaterials.delete(value);
      if (material !== null) {
        material.map?.dispose();
        material.dispose();
        numeralsDisposed += 1;
        reporter.onCount({
          name: NUMERAL_DISPOSED_METRIC,
          value: 1,
          detail: { tileValue: value, reason: 'evicted' },
        });
      }

      numeralsEvicted += 1;
      reporter.onCount({
        name: NUMERAL_EVICTED_METRIC,
        value: 1,
        detail: { tileValue: value, cached: numeralMaterials.size },
      });
      return true;
    }
    return false;
  };

  /**
   * Makes room for one cache entry, releasing entries until there is room.
   *
   * @returns Whether the cache now holds fewer entries than its ceiling.
   */
  const ensureNumeralCapacity = (): boolean => {
    while (numeralMaterials.size >= MAX_CACHED_NUMERALS) {
      if (!evictLeastRecentNumeral()) {
        return false;
      }
    }
    return true;
  };

  /**
   * Counts one refusal and describes the first `MAX_REPORTED_NUMERAL_REFUSALS`
   * of them.
   *
   * The value is carried as the string it prints as, so a value outside the
   * drawable domain — which a non-finite and a non-integer both are — is
   * reported as itself rather than as the `null` a JSON scalar reduces it to.
   *
   * @param value Tile value the numeral was refused for.
   * @param reason Which bound refused it.
   * @param message What the diagnostic states.
   */
  const refuseNumeral = (
    value: number,
    reason: string,
    message: string,
  ): void => {
    numeralsRefused += 1;
    reporter.onCount({
      name: NUMERAL_REFUSED_METRIC,
      value: 1,
      detail: { reason, cached: numeralMaterials.size },
    });

    if (numeralRefusalReports >= MAX_REPORTED_NUMERAL_REFUSALS) {
      return;
    }
    numeralRefusalReports += 1;
    reporter.onDiagnostic({
      level: 'warning',
      source: MODULE_SOURCE,
      message,
      detail: {
        tileValue: String(value),
        reason,
        cached: numeralMaterials.size,
        maxCached: MAX_CACHED_NUMERALS,
      },
    });
  };

  /**
   * The numeral material for one tile value, drawing its texture on first
   * request.
   *
   * Nothing is allocated or cached for a value outside the domain
   * `isDrawableTileValue` accepts, nor once the cache stands full of entries
   * blocks in use wear; both refuse the numeral, which leaves the block wearing
   * the shared blank material its plane draws nothing from. The numeral colour
   * and the block material of every value above the ramp's last one resolve to
   * the one entry src/render/tile-materials.ts shares between them; the digits
   * differ per value, so the texture drawn here is per value and the cache
   * ceiling is what bounds them.
   *
   * @param value Tile value.
   * @param geometry The lengths in force.
   * @returns The material, or `null` where the numeral could not be drawn.
   */
  const resolveNumeralMaterial = (
    value: number,
    geometry: GeometryScale,
  ): MeshBasicMaterial | null => {
    reconcileNumeralTheme();

    if (!isDrawableTileValue(value)) {
      refuseNumeral(
        value,
        'undrawable-value',
        'A block renders without its numeral: the value is outside the ' +
          'domain a numeral is drawn for',
      );
      return null;
    }

    const cached = numeralMaterials.get(value);
    if (cached !== undefined) {
      // Reinserted so the most recently used entry is last and the first key
      // stays the least recently used one eviction takes.
      numeralMaterials.delete(value);
      numeralMaterials.set(value, cached);
      return cached;
    }

    if (numeralSurfaceUnavailable) {
      numeralsUnavailable += 1;
      reporter.onCount({
        name: NUMERAL_UNAVAILABLE_METRIC,
        value: 1,
        detail: { tileValue: value, reason: 'no-2d-context' },
      });
      return null;
    }

    if (!ensureNumeralCapacity()) {
      refuseNumeral(
        value,
        'cache-full',
        'A block renders without its numeral: every held numeral is worn ' +
          'by a block in use',
      );
      return null;
    }

    const layout = resolveNumeralLayout(
      value,
      geometry,
      scale,
      numeralTextureScale,
    );

    let color: string;
    try {
      color = materials.getNumeralColor(value);
    } catch (error) {
      numeralsUnavailable += 1;
      numeralMaterials.set(value, null);
      reporter.onCount({
        name: NUMERAL_UNAVAILABLE_METRIC,
        value: 1,
        detail: { tileValue: value, reason: 'numeral-color' },
      });
      reporter.onDiagnostic({
        level: 'warning',
        source: MODULE_SOURCE,
        message: 'The material cache resolved no numeral colour',
        detail: { tileValue: value },
        error: describeRenderError(error),
        thrown: error,
      });
      return null;
    }

    const surface = createNumeralSurface(layout.canvasPixels);
    if (surface === null) {
      // Latched rather than cached against the value: the condition is the
      // platform's, so it holds for every value and needs no entry.
      numeralSurfaceUnavailable = true;
      numeralsUnavailable += 1;
      reporter.onCount({
        name: NUMERAL_UNAVAILABLE_METRIC,
        value: 1,
        detail: { tileValue: value, reason: 'no-2d-context' },
      });
      reporter.onDiagnostic({
        level: 'info',
        source: MODULE_SOURCE,
        message:
          'No two-dimensional drawing surface is reachable, so blocks ' +
          'render without their numerals',
        detail: { tileValue: value, canvasPixels: layout.canvasPixels },
      });
      return null;
    }

    let condensed = false;
    try {
      condensed = drawNumeral(surface, value, color, layout);
    } catch (error) {
      numeralsUnavailable += 1;
      numeralMaterials.set(value, null);
      reporter.onCount({
        name: NUMERAL_UNAVAILABLE_METRIC,
        value: 1,
        detail: { tileValue: value, reason: 'draw-failed' },
      });
      reporter.onDiagnostic({
        level: 'warning',
        source: MODULE_SOURCE,
        message: 'Drawing the numeral failed',
        detail: { tileValue: value },
        error: describeRenderError(error),
        thrown: error,
      });
      return null;
    }

    if (condensed) {
      numeralsCondensed += 1;
      reporter.onCount({
        name: NUMERAL_CONDENSED_METRIC,
        value: 1,
        detail: { tileValue: value, maxTextWidth: layout.maxTextWidth },
      });
    }

    const texture = new CanvasTexture<NumeralCanvas>(surface.canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;

    const material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      // The plane is coplanar with the block's top face, so it is biased
      // toward the viewer by a polygon-offset unit rather than by a length.
      polygonOffset: true,
      polygonOffsetFactor: NUMERAL_POLYGON_OFFSET,
      polygonOffsetUnits: NUMERAL_POLYGON_OFFSET,
      toneMapped: false,
    });

    numeralMaterials.set(value, material);
    numeralsCreated += 1;
    reporter.onCount({
      name: NUMERAL_CREATED_METRIC,
      value: 1,
      detail: {
        tileValue: value,
        fontSize: layout.fontSize,
        canvasPixels: layout.canvasPixels,
      },
    });

    return material;
  };

  const disposeNumerals = (): void => {
    let released = 0;
    for (const material of numeralMaterials.values()) {
      if (material === null) {
        continue;
      }
      material.map?.dispose();
      material.dispose();
      released += 1;
    }
    numeralMaterials.clear();
    if (released > 0) {
      numeralsDisposed += released;
      reporter.onCount({
        name: NUMERAL_DISPOSED_METRIC,
        value: released,
      });
    }
  };

  const discardTileMeshes = (): void => {
    for (const mesh of tileRecords.keys()) {
      mesh.removeFromParent();
      mesh.visible = false;
    }
    tileRecords.clear();
    pool.length = 0;
  };

  const recallTileMeshes = (): void => {
    let recalled = 0;
    for (const [mesh, record] of tileRecords) {
      if (record.idle) {
        continue;
      }
      record.idle = true;
      mesh.removeFromParent();
      mesh.visible = false;
      pool.push(mesh);
      recalled += 1;
    }
    if (recalled > 0) {
      tileMeshesRecalled += recalled;
      reporter.onCount({
        name: POOL_RECALLED_METRIC,
        value: recalled,
        detail: { pooled: pool.length },
      });
    }
  };

  const disposeGeometries = (): void => {
    if (geometries === null) {
      return;
    }
    geometries.tile.dispose();
    geometries.field.dispose();
    geometries.plate.dispose();
    geometries.numeralPlane.dispose();
    const released = Object.keys(geometries).length;
    geometries = null;
    geometriesDisposed += released;
    reporter.onCount({
      name: GEOMETRY_DISPOSED_METRIC,
      value: released,
    });
  };

  const discardBoard = (): void => {
    if (board === null) {
      return;
    }
    recallTileMeshes();
    board.tileLayer.clear();
    board.group.clear();
    board.group.removeFromParent();
    board = null;
  };

  const buildBoard = (boardSize?: number): BoardMeshes => {
    assertLive();

    const requested = boardSize ?? config.boardSize;
    assertPositiveInteger('boardSize', requested);

    // `tileSize` falls as the board size rises, and the bevel takes
    // `depthScale.bevel` off each side of the outline, so a size beyond which
    // no outline remains is refused here rather than at the extrusion.
    if (tileOutlineSize(resolveBoardGeometry(requested, scale)) <= 0) {
      throw new RangeError(
        `tile-mesh-factory: boardSize ${requested} leaves no tile outline ` +
          `at the ${scale} scale`,
      );
    }

    const previousSize = resolvedGeometry?.gridRowCells ?? null;
    const resized = previousSize !== null && previousSize !== requested;

    // Every geometry is a function of `tileSize`, and `tileSize` is a function
    // of the board size, so a size change releases all four and the numeral
    // textures drawn at the previous tile box.
    if (resized || geometries === null) {
      if (resized) {
        boardResizes += 1;
        reporter.onCount({
          name: BOARD_RESIZED_METRIC,
          value: 1,
          detail: { from: previousSize, to: requested },
        });
      }
      discardBoard();
      discardTileMeshes();
      disposeNumerals();
      disposeGeometries();
      resolvedGeometry = resolveBoardGeometry(requested, scale);
      geometries = {
        tile: createTileGeometry(resolvedGeometry),
        field: createFieldGeometry(resolvedGeometry),
        plate: createCellPlateGeometry(resolvedGeometry),
        numeralPlane: createNumeralPlaneGeometry(resolvedGeometry),
      };
    } else {
      discardBoard();
      resolvedGeometry ??= resolveBoardGeometry(requested, scale);
    }

    const geometry = resolvedGeometry;
    const sized = geometries;

    const group = new Group();
    group.name = 'board';

    const field = new Mesh(sized.field, materials.getBoardFieldMaterial());
    field.name = 'board-field';
    group.add(field);

    // One plate per cell, x-major, replacing the sixteen static `.grid-cell`
    // elements of index.html and the rule-per-cell loop of
    // style/main.scss.
    const plateMaterial = materials.getEmptyCellMaterial();
    const cells: Mesh<ExtrudeGeometry, MeshStandardMaterial>[] = [];
    for (let x = 0; x < requested; x += 1) {
      for (let y = 0; y < requested; y += 1) {
        const plate = new Mesh(sized.plate, plateMaterial);
        plate.name = `board-cell-${x}-${y}`;
        cellToWorldIn({ x, y }, geometry, scratch);
        plate.position.set(
          scratch.x,
          scratch.y,
          boardLayers.fieldSurface,
        );
        cells.push(plate);
        group.add(plate);
      }
    }

    const tileLayer = new Group();
    tileLayer.name = 'tile-layer';
    group.add(tileLayer);

    board = {
      boardSize: requested,
      geometry,
      group,
      field,
      cells,
      tileLayer,
    };

    boardsBuilt += 1;
    reporter.onCount({
      name: BOARD_BUILT_METRIC,
      value: 1,
      detail: {
        boardSize: requested,
        cells: cells.length,
        tileSize: geometry.tileSize,
        scale,
      },
    });

    return board;
  };

  const acquireTileMesh = (value: number): TileMesh => {
    const geometry = requireGeometry();
    if (geometries === null) {
      throw new Error(
        'tile-mesh-factory: buildBoard() must run before this call',
      );
    }
    assertFiniteNumber('value', value);
    if (value < MIN_TILE_VALUE) {
      throw new RangeError(
        `tile-mesh-factory: value must be at least ${MIN_TILE_VALUE}, ` +
          `received ${String(value)}`,
      );
    }

    // Resolved before the pool is touched, so a cache that refuses the call —
    // a destroyed one — leaves the pool and the records untouched. A value
    // off the ramp is dressed by the cache rather than refused.
    const tileMaterial = materials.getTileMaterial(value);

    const pooled = pool.pop();
    let mesh: TileMesh;
    let record: TileMeshRecord;

    if (pooled === undefined) {
      mesh = new Mesh(geometries.tile, tileMaterial);
      mesh.name = 'tile';
      const numeral: NumeralMesh = new Mesh(
        geometries.numeralPlane,
        requireBlankNumeralMaterial(),
      );
      numeral.name = 'tile-numeral';
      // The block's local z origin is its underside, so its top face — which
      // the plane is coplanar with — is one extrusion depth above it.
      numeral.position.set(
        0,
        0,
        depthScale.tile,
      );
      mesh.add(numeral);
      record = { numeral, value, idle: false };
      tileRecords.set(mesh, record);
      tileMeshesCreated += 1;
      poolMisses += 1;
      reporter.onCount({
        name: POOL_MISS_METRIC,
        value: 1,
        detail: { tileValue: value, tracked: tileRecords.size },
      });
    } else {
      mesh = pooled;
      const pooledRecord = tileRecords.get(mesh);
      if (pooledRecord === undefined) {
        throw new Error(
          'tile-mesh-factory: a pooled block is no longer tracked',
        );
      }
      record = pooledRecord;
      record.idle = false;
      poolHits += 1;
      reporter.onCount({
        name: POOL_HIT_METRIC,
        value: 1,
        detail: { tileValue: value, pooled: pool.length },
      });
    }

    record.value = value;
    mesh.geometry = geometries.tile;
    mesh.material = tileMaterial;
    mesh.position.set(
      0,
      0,
      boardLayers.tileBase,
    );
    mesh.quaternion.identity();
    mesh.scale.setScalar(1);
    mesh.visible = true;

    const numeralMaterial = resolveNumeralMaterial(value, geometry);
    record.numeral.geometry = geometries.numeralPlane;
    record.numeral.material =
      numeralMaterial ?? requireBlankNumeralMaterial();
    record.numeral.visible = numeralMaterial !== null;
    record.numeral.position.set(
      0,
      0,
      depthScale.tile,
    );

    return mesh;
  };

  const releaseTileMesh = (mesh: TileMesh): boolean => {
    const record = disposed ? undefined : tileRecords.get(mesh);
    if (record === undefined || record.idle) {
      const reason = disposed
        ? 'disposed'
        : record === undefined
          ? 'untracked'
          : 'already-idle';
      poolRejections += 1;
      reporter.onCount({
        name: POOL_REJECTED_METRIC,
        value: 1,
        detail: { reason },
      });
      reporter.onDiagnostic({
        level: 'warning',
        source: MODULE_SOURCE,
        message: 'A release was refused and the pool left unchanged',
        detail: { reason, pooled: pool.length },
      });
      return false;
    }

    record.idle = true;
    mesh.removeFromParent();
    mesh.visible = false;
    pool.push(mesh);
    poolReleases += 1;
    reporter.onCount({
      name: POOL_RELEASE_METRIC,
      value: 1,
      detail: { tileValue: record.value, pooled: pool.length },
    });
    return true;
  };

  /** Releases the theme subscription, once. */
  const releaseThemeSubscription = (): void => {
    const release = releaseTheme;

    releaseTheme = null;
    release?.();
  };

  const refreshTheme = (): boolean => {
    if (disposed) {
      reporter.onDiagnostic({
        level: 'warning',
        source: MODULE_SOURCE,
        message: 'A theme refresh reached a disposed factory',
      });
      return false;
    }

    // Redraws the numeral textures where the material cache has moved to
    // another theme, and is a no-op where it has not.
    reconcileNumeralTheme();

    const geometry = resolvedGeometry;
    if (geometry === null || geometries === null) {
      // No board is built, so no mesh carries a material to rebind.
      return false;
    }

    const held = board;
    if (held !== null) {
      // The cache re-dresses its materials in place, so these are already the
      // right instances; they are reassigned so a cache that ever hands back a
      // different instance is followed rather than silently ignored.
      held.field.material = materials.getBoardFieldMaterial();

      const plate = materials.getEmptyCellMaterial();
      for (const cell of held.cells) {
        cell.material = plate;
      }
    }

    let rebound = 0;
    for (const [mesh, record] of tileRecords) {
      if (record.idle) {
        // A pooled block is dressed by `acquireTileMesh` before it is handed
        // out again, so it needs nothing here.
        continue;
      }

      mesh.material = materials.getTileMaterial(record.value);

      const numeral = resolveNumeralMaterial(record.value, geometry);
      record.numeral.material = numeral ?? requireBlankNumeralMaterial();
      record.numeral.visible = numeral !== null;
      rebound += 1;
    }

    reporter.onCount({
      name: THEME_REFRESH_METRIC,
      value: 1,
      detail: { rebound, cells: held?.cells.length ?? 0 },
    });

    return true;
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }
    releaseThemeSubscription();
    discardBoard();
    discardTileMeshes();
    disposeNumerals();
    disposeGeometries();
    blankNumeralMaterial?.dispose();
    blankNumeralMaterial = null;
    numeralTheme = null;
    resolvedGeometry = null;
    disposed = true;
    reporter.onDiagnostic({
      level: 'debug',
      source: MODULE_SOURCE,
      message: 'Every geometry and numeral texture was released',
      detail: {
        geometriesDisposed,
        numeralsDisposed,
      } satisfies RenderDetail,
    });
  };

  const readStats = (): TileMeshFactoryStats => ({
    boardSize: resolvedGeometry?.gridRowCells ?? null,
    scale,
    boardsBuilt,
    boardResizes,
    tileMeshesCreated,
    tileMeshesTracked: tileRecords.size,
    pooledTileMeshes: pool.length,
    poolHits,
    poolMisses,
    poolReleases,
    poolRejections,
    tileMeshesRecalled,
    cachedNumerals: numeralMaterials.size,
    numeralsCreated,
    numeralsUnavailable,
    numeralsRefused,
    numeralsEvicted,
    numeralsCondensed,
    numeralThemeRebuilds,
    geometriesDisposed,
    numeralsDisposed,
    invalidOptions,
    disposed,
  });

  const resetStats = (): void => {
    boardsBuilt = 0;
    boardResizes = 0;
    tileMeshesCreated = 0;
    poolHits = 0;
    poolMisses = 0;
    poolReleases = 0;
    poolRejections = 0;
    tileMeshesRecalled = 0;
    numeralsCreated = 0;
    numeralsUnavailable = 0;
    numeralsRefused = 0;
    numeralsEvicted = 0;
    numeralsCondensed = 0;
    numeralThemeRebuilds = 0;
    geometriesDisposed = 0;
    numeralsDisposed = 0;
    invalidOptions = 0;
  };

  // Follows the theme in force, so a palette switch rebinds every live mesh
  // without a caller having to know it happened. A pinned material cache
  // reports the same theme throughout, and the refresh is then a no-op.
  releaseTheme = subscribeToThemeChange((): void => {
    refreshTheme();
  });

  return Object.freeze({
    buildBoard,
    readBoard: (): BoardMeshes | null => board,
    cellToWorld: (position: Position, target?: Vector3): Vector3 =>
      cellToWorldIn(position, requireGeometry(), target),
    acquireTileMesh,
    releaseTileMesh,
    refreshTheme,
    dispose,
    readStats,
    resetStats,
  });
}
