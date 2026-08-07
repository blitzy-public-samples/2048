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
// is what replaced the sixteen static `.grid-cell` elements of index.html
// L43-L68 and the empty `.tile-container` of index.html L70-L72. The size is
// read from the `RulesConfig` of src/config/rules-config.ts on every build;
// `gridRowCells` of src/theme/tokens.ts is the stylesheet's presentation of the
// same dimension and is not read here.
//
// Source construct to implementation, one row per rule:
//
// | Source                    | Rule                       | Implemented by |
// |---------------------------|----------------------------|----------------|
// | main.scss L492-L493       | the position step          | section 4      |
// | main.scss L494            | translate(x, y)            | section 4      |
// | html_actuator.js L97-L104 | the +1 class normalisation | section 4      |
// | main.scss L489-L497       | one rule per cell          | section 7      |
// | index.html L43-L68        | the sixteen static cells   | section 7      |
// | index.html L70-L72        | the tile layer             | section 7      |
// | main.scss L345            | field padding              | section 4      |
// | main.scss L358            | field fill                 | section 7      |
// | main.scss L359            | field corner radius        | section 5      |
// | main.scss L360-L361       | field width and height     | section 5      |
// | main.scss L460-L461       | plate width and height     | section 5      |
// | main.scss L465            | plate corner radius        | section 5      |
// | main.scss L467            | plate fill                 | section 7      |
// | main.scss L482-L484       | the ceil()ed tile box      | section 6      |
// | html_actuator.js L58      | one material per value     | section 8      |
// | html_actuator.js L65      | the tile numeral           | section 6      |
//
// The three extrusion depths are `depthScale` of src/theme/tokens.ts, each an
// arithmetic expression on `gridSpacing`; no length in this module is stated as
// a literal. `bevelSize` of `ExtrudeGeometry` grows the footprint outward and
// `bevelThickness` grows the z-extent at both ends, so the outline is built at
// `tileSize - 2 * depthScale.bevel` and extruded `depthScale.tile -
// 2 * depthScale.bevel`, which resolves the block's bounding box to exactly
// `tileSize` square by `depthScale.tile` deep.
//
// The mobile scale is the `smaller($mobile-threshold)` block of style/main.scss
// L743, which re-invokes `game-field` at L801-L808 with the mobile lengths.
// Both scales resolve through `geometryScales` of src/theme/tokens.ts, and the
// scale is selected once per factory.
//
// Invariants of this module: it holds no scene, camera, renderer or engine
// reference; it reads no clock, consumes no randomness and performs no I/O; it
// imports nothing from src/engine or src/observability and no stylesheet. Its
// only contact with the document is the canvas a numeral texture is drawn on,
// which is created, drawn and handed to a texture without ever being appended;
// `OffscreenCanvas` is used where the platform provides it. Reporting is
// injected and defaults to the no-op sink. One geometry is shared by every
// mesh of a given shape, one numeral texture is shared by every mesh carrying a
// given value, and every geometry, texture and material this module creates is
// released by `dispose()`.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

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
import type {
  RenderDetail,
  RenderErrorInfo,
  RenderReporter,
} from './webgl-support';
import {
  NOOP_RENDER_REPORTER,
  createGuardedRenderReporter,
} from './webgl-support';

/* ==========================================================================
 * 1. Module identity and the metrics it reports
 * ========================================================================== */

/** `source` every diagnostic from this module carries. */
const MODULE_SOURCE = 'render.tile-mesh-factory';

/** A board was generated. */
const BOARD_BUILT_METRIC = 'render.board.built';

/** A board was generated at a size other than the previous one. */
const BOARD_RESIZED_METRIC = 'render.board.resized';

/** A tile mesh was served from the pool. */
const POOL_HIT_METRIC = 'render.tile.pool.hit';

/** A tile mesh had to be constructed: the pool held none. */
const POOL_MISS_METRIC = 'render.tile.pool.miss';

/** A tile mesh was returned to the pool. */
const POOL_RELEASE_METRIC = 'render.tile.pool.release';

/** A release named a mesh this factory does not hold, or already holds idle. */
const POOL_REJECTED_METRIC = 'render.tile.pool.rejected';

/** Blocks a board replacement returned to the pool. */
const POOL_RECALLED_METRIC = 'render.tile.pool.recalled';

/** A geometry was released. */
const GEOMETRY_DISPOSED_METRIC = 'render.geometry.disposed';

/** A numeral texture was constructed. */
const NUMERAL_CREATED_METRIC = 'render.numeral.created';

/** A numeral texture was released. */
const NUMERAL_DISPOSED_METRIC = 'render.numeral.disposed';

/** A numeral could not be drawn: no 2D drawing surface was reachable. */
const NUMERAL_UNAVAILABLE_METRIC = 'render.numeral.unavailable';

/** A numeral was narrowed to fit the width of the tile box. */
const NUMERAL_CONDENSED_METRIC = 'render.numeral.condensed';

/** The numeral textures were redrawn against a new theme. */
const NUMERAL_THEME_REBUILD_METRIC = 'render.numeral.theme.rebuild';

/** A construction option was replaced by its default. */
const INVALID_OPTION_METRIC = 'render.mesh.option.invalid';

/* ==========================================================================
 * 2. Tessellation and texel-density counts
 * ========================================================================== */

/**
 * Points `ExtrudeGeometry` places along each rounded corner.
 *
 * A subdivision count, not a length: it selects how finely the corner arcs the
 * outline carries are sampled and resolves to no dimension of the board.
 */
const CORNER_SEGMENTS = 6;

/**
 * Layers `ExtrudeGeometry` places across the bevel.
 *
 * A subdivision count, not a length. The bevel's extent is `depthScale.bevel`.
 */
const BEVEL_SEGMENTS = 2;

/**
 * Texels drawn per unit of the tile box, as a multiplier on `tileBoxSize`.
 *
 * A texel-density multiplier, not a length: the length it multiplies is
 * `tileBoxSize` of the resolved `GeometryScale`, which is `math.ceil($tile-
 * size)` of style/main.scss L482-L484.
 */
const DEFAULT_NUMERAL_TEXTURE_SCALE = 2;

/** Lowest texel-density multiplier accepted. */
const MIN_NUMERAL_TEXTURE_SCALE = 1;

/** Highest texel-density multiplier accepted. */
const MAX_NUMERAL_TEXTURE_SCALE = 8;

/**
 * Depth-buffer bias applied to the numeral plane, which is coplanar with the
 * block's top face.
 *
 * A polygon-offset unit count, not a length; it resolves to no dimension of the
 * board.
 */
const NUMERAL_POLYGON_OFFSET = -1;

/** Lowest tile value the ramp resolves, and the lowest this module accepts. */
const MIN_TILE_VALUE = 2;

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

/**
 * Rejects an argument that is not a finite number.
 *
 * @param name Parameter name, for the thrown message.
 * @param value Candidate value.
 * @throws RangeError when `value` is not finite.
 */
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
 * `gridSpacing` and `tileBorderRadius` are the scale's own, so both the default
 * scale of style/main.scss L501 and the `smaller($mobile-threshold)` scale of
 * L801-L808 resolve through this one call.
 *
 * @param boardSize Cells per board row, from `RulesConfig.boardSize`.
 * @param scale Which of the two scales to resolve at. Defaults to `'desktop'`,
 *   the scale style/main.scss declares outside its breakpoint block.
 * @returns The resolved lengths, in px.
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
 * `bevelSize` grows the extruded outline outward by `depthScale.bevel` on every
 * side, so the outline is built this much narrower than the footprint and the
 * top face resolves to the same length.
 *
 * @param geometry Resolved lengths for one board size and scale.
 * @returns Edge length of the top face, in px.
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
  /** Underside of the board field. */
  fieldBase: -depthScale.board,

  /** Top surface of the board field, which the plates lie on. */
  fieldSurface: 0,

  /** Top surface of an empty-cell plate, which a tile block stands on. */
  cellPlateSurface: depthScale.bevel,

  /** Underside of a tile block, and the z `cellToWorld` reports. */
  tileBase: depthScale.bevel,

  /** Top face of a tile block, which the numeral plane is coplanar with. */
  tileSurface: depthScale.bevel + depthScale.tile,
});

/* ==========================================================================
 * 4. Cell coordinate to world position
 * ========================================================================== */

/**
 * Offset of a cell's centre from the board field's leading edge along one axis,
 * in px.
 *
 * An integer coordinate resolves through `tilePositionStep` of
 * src/theme/tokens.ts, the port of `math.floor(($tile-size + $grid-spacing) *
 * ($x - 1))` at style/main.scss L492-L493, and then adds the field padding of
 * L345 and half a tile. A fractional coordinate, which the `MoveTweenValue` of
 * src/render/animations.ts carries between two cells, resolves through the same
 * expression without its `Math.floor`.
 *
 * @param coordinate Zero-based cell coordinate along one axis; may be
 *   fractional.
 * @param geometry Resolved lengths for the board size and scale in force.
 * @returns Distance from the field's leading edge to the cell's centre, in px.
 */
function cellAxisOffset(coordinate: number, geometry: GeometryScale): number {
  const step =
    Number.isInteger(coordinate) && coordinate >= 0
      ? tilePositionStep(coordinate, geometry)
      : (geometry.tileSize + geometry.gridSpacing) * coordinate;
  return geometry.gridSpacing + step + geometry.tileSize / 2;
}

/**
 * World position of the tile that occupies one cell.
 *
 * Cell `{x, y}` maps to world `x` rightward and world `-y` downward, and z to
 * `boardLayers.tileBase`; the board is centred on the origin by subtracting
 * half the field width along both axes. Coordinates are the engine's zero-based
 * ones — the `+1` normalisation of js/html_actuator.js L97-L104 built CSS class
 * names and has no counterpart here.
 *
 * @param position Zero-based cell coordinate. Either member may be fractional,
 *   which is the state a move tween carries between two cells.
 * @param boardSize Cells per board row, from `RulesConfig.boardSize`.
 * @param scale Which of the two scales to resolve at. Defaults to `'desktop'`.
 * @param target Vector to write into. A new one is allocated when omitted, so a
 *   caller on a frame path supplies one and this call allocates nothing.
 * @returns `target`, or the newly allocated vector.
 * @throws RangeError when `boardSize` is not a positive integer, or when either
 *   coordinate is not finite.
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
 * @param position Zero-based cell coordinate; either member may be fractional.
 * @param geometry Resolved lengths for the board size and scale in force.
 * @param target Vector to write into. A new one is allocated when omitted.
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
 * The array is x-major, matching the `CellMatrix` of src/engine/types.ts, whose
 * backing store is indexed `cells[x][y]`.
 *
 * @param position Zero-based cell coordinate.
 * @param boardSize Cells per board row.
 * @returns Index into the flat array.
 * @throws RangeError when `boardSize` is not a positive integer, or when either
 *   coordinate is outside the lattice.
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

/* ==========================================================================
 * 5. Outlines and the four geometries
 * ========================================================================== */

/** Quarter turn, in radians; the angle each corner arc subtends. */
const QUARTER_TURN = Math.PI / 2;

/**
 * A square outline with rounded corners, centred on its own origin.
 *
 * The one outline shape behind all four geometries: a tile block at
 * `tileBorderRadius`, a board field at `boardBorderRadius`, an empty-cell plate
 * at `tileBorderRadius`, and the corner radius is clamped to half the edge,
 * so an outline narrower than twice its radius stays a closed contour.
 *
 * @param edge Edge length of the square, in px.
 * @param radius Corner radius, in px.
 * @returns The closed outline.
 * @throws RangeError when `edge` is not a positive finite number, or when
 *   `radius` is not a finite number of at least zero.
 */
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

/**
 * The tile block: a rounded square of `tileSize` extruded `depthScale.tile`,
 * with its underside on the local z origin.
 *
 * `bevelSize` grows the outline outward by `depthScale.bevel` on every side and
 * `bevelThickness` grows the extrusion by the same amount at both ends, so the
 * outline is narrowed and the extrusion shortened by exactly those amounts and
 * the resulting bounding box is `tileSize` square by `depthScale.tile` deep.
 * The translation moves the extrusion, which `ExtrudeGeometry` centres on the
 * outline plane, onto the local z origin.
 *
 * @param geometry Resolved lengths for the board size and scale in force.
 * @returns The block geometry, owned by the caller.
 */
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

/**
 * The board field: a rounded square of `fieldWidth` at `boardBorderRadius`,
 * from style/main.scss L359-L361, extruded `depthScale.board` so its top
 * surface sits on the local z origin.
 *
 * @param geometry Resolved lengths for the board size and scale in force.
 * @returns The field geometry, owned by the caller.
 */
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

/**
 * An empty-cell plate: a rounded square of `tileSize` at `tileBorderRadius`,
 * from style/main.scss L460-L465, extruded `depthScale.bevel` so it stands on
 * the field's top surface.
 *
 * @param geometry Resolved lengths for the board size and scale in force.
 * @returns The plate geometry, owned by the caller and shared by every plate.
 */
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

/**
 * The numeral plane: a `tileSize` square carrying the numeral texture, placed
 * on the block's top face.
 *
 * Sized to the footprint rather than to the top face, so the texture drawn on a
 * `tileBoxSize` canvas maps onto the same length style/main.scss L482-L484 lays
 * the tile box out at.
 *
 * @param geometry Resolved lengths for the board size and scale in force.
 * @returns The plane geometry, owned by the caller and shared by every tile.
 */
function createNumeralPlaneGeometry(geometry: GeometryScale): PlaneGeometry {
  return new PlaneGeometry(geometry.tileSize, geometry.tileSize);
}

/* ==========================================================================
 * 6. Numeral layout and its texture
 * ========================================================================== */

/** How a numeral is laid out on its texture, in px. */
export interface NumeralLayout {
  /** Edge length of the square canvas the numeral is drawn on, in device px. */
  readonly canvasPixels: number;

  /**
   * Edge length of the tile box the canvas represents, in px. `math.ceil($tile-
   * size)` of style/main.scss L482-L484.
   */
  readonly boxSize: number;

  /**
   * Numeral size before any narrowing, in px. The digit-count step
   * style/main.scss declares for this value, resolved by `tileFontSize` of
   * src/theme/tokens.ts.
   */
  readonly fontSize: number;

  /** Texels drawn per unit of the tile box. */
  readonly textureScale: number;

  /** Widest the numeral may draw, in px: the box less a radius a side. */
  readonly maxTextWidth: number;
}

/**
 * Resolves how one tile value's numeral is laid out.
 *
 * The canvas is the tile box of style/main.scss L482-L484 multiplied by the
 * texel-density multiplier, and the numeral takes the digit-count step
 * style/main.scss declares at L530, L586, L593 and L609, which `tileFontSize`
 * of src/theme/tokens.ts resolves. The drawable width insets the box by one
 * `tileBorderRadius` a side.
 *
 * @param value Tile value; a positive number.
 * @param geometry Resolved lengths for the board size and scale in force.
 * @param scale Which of the two scales the numeral size is taken at.
 * @param textureScale Texels drawn per unit of the tile box.
 * @returns The layout, in px.
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

/** A drawing surface the numeral is rendered on. */
type NumeralCanvas = HTMLCanvasElement | OffscreenCanvas;

/** The two-dimensional drawing contexts a `NumeralCanvas` can yield. */
type NumeralContext =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;

/** A canvas paired with the context drawn on it. */
interface NumeralSurface {
  readonly canvas: NumeralCanvas;
  readonly context: NumeralContext;
}

/**
 * Creates the drawing surface for one numeral texture.
 *
 * `OffscreenCanvas` is preferred where the platform provides it, so no element
 * is created at all; otherwise an element is created, drawn on, and handed to a
 * texture without ever being appended to the document. Both paths are guarded:
 * a platform with neither, and a platform whose canvas yields no
 * two-dimensional context, both resolve to `null`.
 *
 * @param pixels Edge length of the square surface, in device px.
 * @returns The surface, or `null` where none is reachable.
 */
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

/**
 * Draws one tile value onto a surface, centred on both axes.
 *
 * The surface is scaled so one drawing unit is one unit of the tile box, which
 * makes the numeral size the px value `tileFontSize` reports and the vertical
 * centre the half-box `line-height: math.ceil($tile-size)` of style/main.scss
 * L484 centres on. A numeral wider than the drawable width is narrowed to fit,
 * which is reported.
 *
 * @param surface Canvas and context to draw on.
 * @param value Tile value drawn as its decimal digits.
 * @param color Numeral colour, from `getNumeralColor` of the material cache.
 * @param layout Resolved numeral layout.
 * @returns `true` where the numeral was narrowed to fit.
 */
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

  // `font-weight: bold` at style/main.scss L527, and the stack of
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

/* ==========================================================================
 * 7. What one build produces
 * ========================================================================== */

/** A tile block: the shared block geometry dressed in one value's material. */
export type TileMesh = Mesh<ExtrudeGeometry, MeshStandardMaterial>;

/** The meshes one board build produced. */
export interface BoardMeshes {
  /** Cells per board row the build resolved. */
  readonly boardSize: number;

  /** Lengths this build resolved for that size and the factory's scale. */
  readonly geometry: GeometryScale;

  /** Root of the board. A caller adds this to its scene. */
  readonly group: Group;

  /** The board field, which style/main.scss L358 fills. */
  readonly field: Mesh<ExtrudeGeometry, MeshStandardMaterial>;

  /**
   * The empty-cell plates, one per cell, x-major: the plate for cell `{x, y}`
   * is at `cellArrayIndex({x, y}, boardSize)`. These replace the sixteen static
   * `.grid-cell` elements of index.html L43-L68.
   */
  readonly cells: readonly Mesh<ExtrudeGeometry, MeshStandardMaterial>[];

  /**
   * Where tile blocks are added. The counterpart of the empty
   * `.tile-container` of index.html L70-L72, which style/main.scss L474-L477
   * layers above the cells.
   */
  readonly tileLayer: Group;
}

/** What one factory has done and where it stands. */
export interface TileMeshFactoryStats {
  /** Cells per board row the last build resolved, `null` before the first. */
  readonly boardSize: number | null;

  /** Which of the stylesheet's two scales the geometry is built at. */
  readonly scale: ScaleName;

  /** Boards generated over this factory's life. */
  readonly boardsBuilt: number;

  /** Builds that resolved a size other than the previous one. */
  readonly boardResizes: number;

  /** Tile blocks constructed over this factory's life. */
  readonly tileMeshesCreated: number;

  /** Tile blocks held right now, idle and in use together. */
  readonly tileMeshesTracked: number;

  /** Tile blocks standing idle in the pool. */
  readonly pooledTileMeshes: number;

  /** Acquisitions served from the pool. */
  readonly poolHits: number;

  /** Acquisitions that had to construct a block. */
  readonly poolMisses: number;

  /** Releases accepted back into the pool. */
  readonly poolReleases: number;

  /** Releases refused: an untracked mesh, or one already idle. */
  readonly poolRejections: number;

  /** Blocks a board replacement returned to the pool. */
  readonly tileMeshesRecalled: number;

  /** Numeral textures held right now. */
  readonly cachedNumerals: number;

  /** Numeral textures constructed over this factory's life. */
  readonly numeralsCreated: number;

  /** Numerals that could not be drawn for want of a drawing surface. */
  readonly numeralsUnavailable: number;

  /** Numerals narrowed to fit the width of the tile box. */
  readonly numeralsCondensed: number;

  /** Redraws of the numeral textures triggered by a theme change. */
  readonly numeralThemeRebuilds: number;

  /** Geometries released, by `dispose()` and by a rebuild at a new size. */
  readonly geometriesDisposed: number;

  /** Numeral textures released. */
  readonly numeralsDisposed: number;

  /** Construction options replaced by their default. */
  readonly invalidOptions: number;

  /** Whether `dispose()` has released this factory's resources. */
  readonly disposed: boolean;
}

/** Construction options for `createTileMeshFactory`. */
export interface TileMeshFactoryOptions {
  /**
   * The run's rules. `boardSize` is read afresh on every build rather than
   * captured: it is reconciled against a persisted board size and any active
   * board-mutating relic, and so changes during a run.
   */
  readonly config: Pick<RulesConfig, 'boardSize'>;

  /**
   * Materials for the blocks, the field and the plates. The cache owns every
   * material it hands out, so `dispose()` here releases none of them.
   */
  readonly materials: TileMaterialCache;

  /**
   * Which of the stylesheet's two scales the geometry is built at. Defaults to
   * `'desktop'`, the scale style/main.scss declares outside its breakpoint
   * block.
   */
  readonly scale?: ScaleName;

  /**
   * Texels drawn per unit of the tile box, an integer from 1 to 8. Defaults to
   * `DEFAULT_NUMERAL_TEXTURE_SCALE`.
   */
  readonly numeralTextureScale?: number;

  /**
   * Sink this factory reports through. Defaults to `NOOP_RENDER_REPORTER`, and
   * is wrapped so no channel of it can throw into a caller.
   */
  readonly reporter?: RenderReporter;
}

/**
 * The geometry owner: it generates the board, hands out tile blocks, maps cells
 * to world positions, and releases everything it created.
 */
export interface TileMeshFactory {
  /**
   * Generates the board at one size, replacing any board generated before.
   *
   * A build at a size other than the previous one releases every geometry and
   * numeral texture the previous size resolved: all four are functions of
   * `tileSize`, and `tileSize` is a function of the board size. A
   * build at the same size reuses them. Either way the meshes of the previous
   * build are detached, so a board-mutating relic that changes the size gets a
   * board whose every world position is re-derived from the new size.
   *
   * @param boardSize Cells per board row. Defaults to `config.boardSize`, read
   *   at the moment of the call.
   * @returns The meshes this build produced.
   * @throws RangeError when the resolved size is not a positive integer.
   * @throws Error when the factory has been disposed.
   */
  buildBoard(boardSize?: number): BoardMeshes;

  /** @returns The board in force, or `null` before the first build. */
  readBoard(): BoardMeshes | null;

  /**
   * World position of the tile that occupies one cell, at the board size and
   * scale in force.
   *
   * @param position Zero-based cell coordinate; either member may be
   *   fractional.
   * @param target Vector to write into. A new one is allocated when omitted.
   * @returns `target`, or the newly allocated vector.
   * @throws RangeError when either coordinate is not finite.
   * @throws Error when no board has been built, or the factory is disposed.
   */
  cellToWorld(position: Position, target?: Vector3): Vector3;

  /**
   * A tile block dressed for one value, taken from the pool where one is idle
   * and constructed where none is.
   *
   * The block is returned detached, at the identity transform, with its numeral
   * applied and its material taken from the cache. A caller positions it and
   * adds it to `BoardMeshes.tileLayer`.
   *
   * @param value Tile value; a number of at least two.
   * @returns The block, tracked by this factory until `dispose()`.
   * @throws RangeError when `value` is not a finite number of at least two.
   * @throws Error when no board has been built, or the factory is disposed.
   */
  acquireTileMesh(value: number): TileMesh;

  /**
   * Returns a block to the pool, detaching it and hiding it.
   *
   * A mesh this factory did not hand out, and a mesh already idle, are refused
   * and reported rather than admitted twice.
   *
   * @param mesh The block to return.
   * @returns `true` where the block was admitted.
   */
  releaseTileMesh(mesh: TileMesh): boolean;

  /**
   * Releases every geometry and numeral texture this factory created, and the
   * materials it created for the numeral planes.
   *
   * The materials the injected cache hands out are the cache's and are left
   * alone. Three.js frees no GPU resource on collection, so this is the call a
   * board teardown makes. The factory is not usable afterwards.
   */
  dispose(): void;

  /** @returns What this factory has done and where it stands. */
  readStats(): TileMeshFactoryStats;

  /** Clears every count `readStats()` reports. Present for suites. */
  resetStats(): void;
}

/* ==========================================================================
 * 8. The factory
 * ========================================================================== */

/**
 * The theme as the material cache reports it, derived from that cache's own
 * contract so this module names no theme module.
 */
type CacheTheme = ReturnType<TileMaterialCache['getTheme']>;

/** The numeral plane carried by every tile block. */
type NumeralMesh = Mesh<PlaneGeometry, MeshBasicMaterial>;

/** What the factory holds about one tile block it handed out. */
interface TileMeshRecord {
  /** The numeral plane parented to the block. */
  readonly numeral: NumeralMesh;

  /** Tile value the block is dressed for. */
  value: number;

  /** Whether the block is standing idle in the pool. */
  idle: boolean;
}

/** The geometries one board size resolves, held so all four release. */
interface SizedGeometries {
  readonly tile: ExtrudeGeometry;
  readonly field: ExtrudeGeometry;
  readonly plate: ExtrudeGeometry;
  readonly numeralPlane: PlaneGeometry;
}

/** The scales `TileMeshFactoryOptions.scale` accepts. */
const SCALE_NAMES: readonly ScaleName[] = Object.freeze([
  'desktop',
  'mobile',
]);

/**
 * Reduces a caught value to the two serialisable fields a report carries.
 *
 * @param error The caught value.
 * @returns Its name and message, both printable.
 */
function describeError(error: unknown): RenderErrorInfo {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: 'RenderError', message: String(error) };
}

/**
 * Builds the geometry owner for the WebGL board.
 *
 * Nothing is constructed at call time: the options are validated and the
 * injected collaborators are held, and every geometry is built by the first
 * `buildBoard()` call. The board size is read from `options.config` at each
 * build rather than captured, so a board-mutating relic that changes it is
 * followed by the next build.
 *
 * @param options Construction options. `config` and `materials` are required;
 *   an option that is rejected is replaced by its default, counted and
 *   reported.
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

  /**
   * Records that an option was refused and reports it.
   *
   * @param name Option name.
   * @param received The refused value, printed.
   * @param applied The default put in its place, printed.
   */
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
   * Numeral material per tile value, holding `null` for a value whose numeral
   * could not be drawn, so an unreachable drawing surface is probed once.
   */
  const numeralMaterials = new Map<number, MeshBasicMaterial | null>();

  /** Every block handed out, keyed by the block itself. */
  const tileRecords = new Map<TileMesh, TileMeshRecord>();

  /** Blocks standing idle, most recently released last. */
  const pool: TileMesh[] = [];

  /** Material a block wears where its value's numeral could not be drawn. */
  let blankNumeralMaterial: MeshBasicMaterial | null = null;

  /** Scratch vector for the plate positions, so a build allocates one. */
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
  let numeralsCondensed = 0;
  let numeralThemeRebuilds = 0;

  /** Theme the cached numeral textures were drawn against. */
  let numeralTheme: CacheTheme | null = null;
  let geometriesDisposed = 0;
  let numeralsDisposed = 0;

  /**
   * Rejects use of a factory that has been disposed.
   *
   * @throws Error when `dispose()` has run.
   */
  const assertLive = (): void => {
    if (disposed) {
      throw new Error('tile-mesh-factory: the factory has been disposed');
    }
  };

  /**
   * The lengths in force.
   *
   * @returns The resolved lengths of the board in force.
   * @throws Error when no board has been built.
   */
  const requireGeometry = (): GeometryScale => {
    assertLive();
    if (resolvedGeometry === null) {
      throw new Error(
        'tile-mesh-factory: buildBoard() must run before this call',
      );
    }
    return resolvedGeometry;
  };

  /**
   * The material every numeral plane falls back to.
   *
   * Fully transparent and written to no depth, so a plane wearing it draws
   * nothing even where a caller makes it visible.
   *
   * @returns The shared fallback material.
   */
  const requireBlankNumeralMaterial = (): MeshBasicMaterial => {
    blankNumeralMaterial ??= new MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    return blankNumeralMaterial;
  };

  /**
   * Releases the cached numeral textures where the material cache has adopted a
   * theme other than the one they were drawn against.
   *
   * The cache follows the theme in force and releases its own materials on a
   * change, and the numeral colour of style/main.scss L572-L574 is per theme,
   * so the textures that carry it are redrawn on the same change.
   */
  const reconcileNumeralTheme = (): void => {
    let active: CacheTheme | null = null;
    try {
      active = materials.getTheme();
    } catch (error) {
      reporter.onDiagnostic({
        level: 'warning',
        source: MODULE_SOURCE,
        message: 'The material cache reported no theme',
        error: describeError(error),
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
   * The numeral material for one tile value, drawing its texture on first
   * request.
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

    const cached = numeralMaterials.get(value);
    if (cached !== undefined) {
      return cached;
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
        error: describeError(error),
      });
      return null;
    }

    const surface = createNumeralSurface(layout.canvasPixels);
    if (surface === null) {
      numeralsUnavailable += 1;
      numeralMaterials.set(value, null);
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
        error: describeError(error),
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

  /** Releases every numeral texture and material this factory created. */
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

  /**
   * Detaches every block handed out and empties the pool.
   *
   * Called where the geometry the blocks carry is about to be released, which
   * is every build at a size other than the previous one.
   */
  const discardTileMeshes = (): void => {
    for (const mesh of tileRecords.keys()) {
      mesh.removeFromParent();
      mesh.visible = false;
    }
    tileRecords.clear();
    pool.length = 0;
  };

  /**
   * Returns every block in use to the pool, detaching and hiding it.
   *
   * Called where the board that held them is being replaced, so a rebuild at
   * the same size reuses the blocks the previous board carried instead of
   * leaving them tracked, detached and unreachable.
   */
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

  /** Releases the four geometries one board size resolved. */
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

  /** Detaches the board in force and empties its groups. */
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
    // elements of index.html L43-L68 and the rule-per-cell loop of
    // style/main.scss L489-L497.
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

    // Resolved before the pool is touched, so a value the ramp does not carry
    // throws with the pool and the records untouched.
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

  const dispose = (): void => {
    if (disposed) {
      return;
    }
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
    numeralsCondensed = 0;
    numeralThemeRebuilds = 0;
    geometriesDisposed = 0;
    numeralsDisposed = 0;
    invalidOptions = 0;
  };

  return Object.freeze({
    buildBoard,
    readBoard: (): BoardMeshes | null => board,
    cellToWorld: (position: Position, target?: Vector3): Vector3 =>
      cellToWorldIn(position, requireGeometry(), target),
    acquireTileMesh,
    releaseTileMesh,
    dispose,
    readStats,
    resetStats,
  });
}
