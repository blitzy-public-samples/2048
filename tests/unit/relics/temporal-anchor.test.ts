// The `temporal-anchor` relic of the `board-manipulation` family, in
// isolation. AAP R3 and AAP 0.6.3 Group 5 hold every relic to three
// properties: it fires only on its bound hooks, it produces its specified
// effect, and it respects its charge budget including an invocation at zero
// charges.
//
// This suite reads no DOM, no clock and no unseeded randomness, and it runs
// under the `test` script with no server, browser or network.
//
// Decisions: DL-BOARD-01, DL-BOARD-02 (docs/DECISION_LOG.md).

import { beforeEach, describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import { Grid } from '../../../src/engine/grid';
import {
  createHookBus,
  createReadonlyGridView,
} from '../../../src/engine/hook-bus';
import type { HookBus } from '../../../src/engine/hook-bus';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import type {
  AfterMovePayload,
  BeforeMovePayload,
  BoardEffect,
  BoardEffectQueue,
  HookContext,
  HookHandler,
  HookName,
  ReadonlyRngView,
  ReadonlyRulesView,
} from '../../../src/engine/hooks';
import { Tile } from '../../../src/engine/tile';
import {
  DIRECTION_LEFT,
  NOOP_ENGINE_REPORTER,
} from '../../../src/engine/types';
import type {
  CorrelationId,
  Position,
  SerializedGameState,
  SerializedGrid,
} from '../../../src/engine/types';
import {
  RNG_STREAM_NAMES,
  createRngStreams,
} from '../../../src/rng/rng-streams';
import type { RngStreams } from '../../../src/rng/rng-streams';
import { BOARD_MANIPULATION_FAMILY } from
  '../../../src/relics/families/board-manipulation';
import {
  RELIC_CATALOGUE,
  RelicRegistry,
  findRelicById,
} from '../../../src/relics/relic-registry';
import { RARITIES } from '../../../src/relics/relic-types';
import type { Relic } from '../../../src/relics/relic-types';
import {
  createBlockedBoard,
  createMergePairBoard,
  createNearLossBoard,
} from '../../fixtures/boards';

/** Identifier of the relic under test. */
const RELIC_ID = 'temporal-anchor';

/** The one seed every substream in this suite is derived from. */
const SUITE_SEED = 'temporal-anchor-suite';

/**
 * Run correlation identifier every context, bus and registry in this suite
 * carries.
 */
const CORRELATION_ID: CorrelationId = 'run-temporal-anchor-suite';

/** Hooks the relic binds, in the order its handler table declares them. */
const BOUND_HOOKS: readonly HookName[] = ['onAfterMove', 'onBeforeMove'];

/** The four hook names the relic leaves unbound. */
const UNBOUND_HOOKS: readonly HookName[] = [
  'onStageStart',
  'onMerge',
  'onSpawn',
  'onStageEnd',
];

/**
 * Charge-bearing relics of the whole catalogue: five, this one among them,
 * beside `tumbler`, `culling-blade`, `scouring-wind` and `frostbind`.
 */
const CHARGE_BEARING_RELICS = 5;

/** Charge budget the declaration ships with. */
const DECLARED_CHARGES = 3;

/** Score the anchoring move settles at, in the cases that record one. */
const ANCHOR_SCORE = 44;

/** Face value the board is filled to when a case needs a full board. */
const FILLER_VALUE = 4;

/**
 * The relic under test, read out of the family export by identifier.
 *
 * @returns The frozen declaration.
 * @throws {Error} If the family declares no relic under `RELIC_ID`.
 */
function anchorRelic(): Relic {
  const found = BOARD_MANIPULATION_FAMILY.relics.find(
    (relic): boolean => relic.id === RELIC_ID,
  );

  if (found === undefined) {
    throw new Error(
      `The board-manipulation family declares no relic named ${RELIC_ID}.`,
    );
  }

  return found;
}

/**
 * The relic's `onAfterMove` handler.
 *
 * @returns The bound handler.
 * @throws {Error} If the relic binds none.
 */
function recordHandler(): HookHandler<'onAfterMove'> {
  const handler = anchorRelic().hooks.onAfterMove;

  if (handler === undefined) {
    throw new Error(`${RELIC_ID} binds no onAfterMove handler.`);
  }

  return handler;
}

/**
 * The relic's `onBeforeMove` handler.
 *
 * @returns The bound handler.
 * @throws {Error} If the relic binds none.
 */
function holdHandler(): HookHandler<'onBeforeMove'> {
  const handler = anchorRelic().hooks.onBeforeMove;

  if (handler === undefined) {
    throw new Error(`${RELIC_ID} binds no onBeforeMove handler.`);
  }

  return handler;
}

/**
 * Reads every declared member of the relic into one comparable string.
 *
 * @returns The fingerprint.
 */
function declarationFingerprint(): string {
  const relic = anchorRelic();

  return JSON.stringify({
    id: relic.id,
    name: relic.name,
    rarity: relic.rarity,
    description: relic.description,
    charges: relic.charges,
    state: relic.state,
    hooks: Object.keys(relic.hooks),
  });
}

/**
 * The declaration as it shipped, captured once at module load and compared
 * again once every case has run.
 */
const DECLARED_FINGERPRINT: string = declarationFingerprint();

/**
 * @param handler Handler to read.
 * @returns The handler's source, comments replaced by single spaces.
 */
function executableSource(handler: unknown): string {
  return String(handler)
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/\/\/[^\n]*/gu, ' ');
}

/** One bound handler's hook name paired with its executable source. */
interface HandlerSource {
  readonly hook: HookName;
  readonly source: string;
}

/**
 * Both bound handlers, each paired with its hook name.
 *
 * @returns The two sources, in the order the handler table declares them.
 */
function boundHandlerSources(): readonly HandlerSource[] {
  return [
    { hook: 'onAfterMove', source: executableSource(recordHandler()) },
    { hook: 'onBeforeMove', source: executableSource(holdHandler()) },
  ];
}

/** One occupied cell of a live board. */
interface OccupantRecord {
  readonly x: number;
  readonly y: number;
  readonly value: number;
}

/**
 * Every occupied cell of a live board, x-outer and y-inner.
 *
 * @param grid Board to read.
 * @returns The occupants, in the board's own scan order.
 */
function occupants(grid: Grid): OccupantRecord[] {
  const found: OccupantRecord[] = [];

  grid.eachCell((x: number, y: number, tile: Tile | null): void => {
    if (tile !== null) {
      found.push({ x, y, value: tile.value });
    }
  });

  return found;
}

/**
 * Fills every empty cell of a live board through the public lattice API of
 * js/grid.js L89-L91.
 *
 * @param grid Board to fill.
 * @param value Face value each inserted tile carries.
 */
function fillBoard(grid: Grid, value: number = FILLER_VALUE): void {
  for (const cell of grid.availableCells()) {
    grid.insertTile(new Tile(cell, value));
  }
}

/**
 * Rebuilds a board from its own projection and projects it again, which is the
 * round trip js/grid.js L102-L117 and the `Grid` constructor's `state[x][y]`
 * read form together.
 *
 * @param grid Board to round-trip.
 * @returns The re-projection, equal to the projection on a coherent lattice.
 */
function reprojected(grid: Grid): SerializedGrid {
  const projected = grid.serialize();

  return new Grid(projected.size, projected.cells).serialize();
}

/**
 * Relocates one occupant through the public API of js/grid.js L89-L95 and
 * js/tile.js L14-L17, which is the sequence js/game_manager.js L123-L127
 * performed.
 *
 * @param grid Board to write.
 * @param from Cell the tile stands in.
 * @param to Cell it relocates to.
 * @throws {Error} If `from` holds no tile.
 */
function relocate(grid: Grid, from: Position, to: Position): void {
  const tile = grid.cellContent(from);

  if (tile === null) {
    throw new Error(
      `The fixture holds no tile at (${String(from.x)}, ${String(from.y)}).`,
    );
  }

  grid.removeTile(tile);
  tile.updatePosition(to);
  grid.insertTile(tile);
}

/**
 * @param value Candidate value.
 * @returns `true` for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reports whether a value is one serialised cell entry, the shape js/tile.js
 * L19-L27 wrote.
 *
 * @param value Candidate entry.
 * @returns `true` for a `{ position: { x, y }, value }` pair.
 */
function isCellEntry(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const position: unknown = value.position;
  const face: unknown = value.value;

  return (
    isRecord(position) &&
    typeof position.x === 'number' &&
    typeof position.y === 'number' &&
    typeof face === 'number' &&
    face > 0
  );
}

/**
 * Reports whether a value is a board projection in the vocabulary of
 * js/grid.js L102-L117.
 *
 * @param value Candidate projection.
 * @returns `true` for a well-formed projection.
 */
function isSerializedGridShape(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const size: unknown = value.size;
  const cells: unknown = value.cells;

  if (typeof size !== 'number' || !Array.isArray(cells)) {
    return false;
  }

  if (cells.length !== size) {
    return false;
  }

  return cells.every(
    (column: unknown): boolean =>
      Array.isArray(column) &&
      column.length === size &&
      column.every(
        (entry: unknown): boolean => entry === null || isCellEntry(entry),
      ),
  );
}

/**
 * Reports whether a state slot is a well-formed anchor slot: a finite score
 * beside either no board or a board projection.
 *
 * @param value Candidate slot.
 * @returns `true` for a slot the relic could have written.
 */
function isAnchorSlot(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const board: unknown = value.board;
  const score: unknown = value.score;

  return (
    typeof score === 'number' &&
    Number.isFinite(score) &&
    (board === null || isSerializedGridShape(board))
  );
}

/**
 * The board a well-formed anchor slot holds.
 *
 * @param value Slot to read.
 * @returns The projection, or `null` where the slot holds none.
 */
function slotBoard(value: unknown): unknown {
  return isRecord(value) ? value.board : null;
}

/**
 * The score a well-formed anchor slot holds.
 *
 * @param value Slot to read.
 * @returns The score, or `null` where the slot holds none.
 */
function slotScore(value: unknown): unknown {
  return isRecord(value) ? value.score : null;
}

/** Every rule this relic must leave standing. */
interface RulesFingerprint {
  readonly boardSize: number;
  readonly winValue: number;
  readonly startTiles: number;
  readonly values: readonly number[];
  readonly weights: readonly number[];
  readonly canMerge: unknown;
  readonly produce: unknown;
}

/**
 * Reads the rules in force into a comparable record, both merge members by
 * identity.
 *
 * @param config Rules to read.
 * @returns The fingerprint.
 */
function rulesFingerprint(config: RulesConfig): RulesFingerprint {
  return {
    boardSize: config.boardSize,
    winValue: config.winValue,
    startTiles: config.startTiles,
    values: [...config.spawn.values],
    weights: [...config.spawn.weights],
    canMerge: config.merge.canMerge,
    produce: config.merge.produce,
  };
}

/** One recorded whole-board restore. */
type RestoreRequest = Extract<BoardEffect, { kind: 'restoreBoard' }>;

/**
 * The restore commands a handler recorded, in record order.
 *
 * @param recorded Commands the handler recorded.
 * @returns The restores among them.
 */
function restoreRequests(
  recorded: readonly BoardEffect[],
): readonly RestoreRequest[] {
  return recorded.filter(
    (effect): effect is RestoreRequest => effect.kind === 'restoreBoard',
  );
}

/**
 * A board-effect queue that RECORDS and applies nothing, matching the
 * transactional queue src/engine/board-effects.ts opens per handler: a command
 * reaches the lattice only once the handler has returned and its return has
 * been accepted.
 *
 * @param grid Board the five query members read.
 * @param recorded Array each accepted command is appended to.
 * @param acceptRestore Whether `restoreBoard` accepts or refuses.
 * @returns The queue.
 */
function recordingQueue(
  grid: Grid,
  recorded: BoardEffect[],
  acceptRestore: boolean,
): BoardEffectQueue {
  let refusals = 0;

  const refuse = (): boolean => {
    refusals += 1;

    return false;
  };

  return {
    get size(): number {
      return grid.size;
    },

    get length(): number {
      return recorded.length;
    },

    get refused(): number {
      return refusals;
    },

    insertTile: (cell: Position, value: number): boolean => {
      recorded.push({ kind: 'insertTile', cell, value });

      return true;
    },

    removeTile: (cell: Position): boolean => {
      recorded.push({ kind: 'removeTile', cell });

      return true;
    },

    moveTile: (from: Position, to: Position, tween = true): boolean => {
      recorded.push({ kind: 'moveTile', from, to, tween });

      return true;
    },

    restoreBoard: (snapshot: SerializedGrid, score?: number): boolean => {
      if (!acceptRestore) {
        return refuse();
      }

      recorded.push({ kind: 'restoreBoard', snapshot, score });

      return true;
    },

    resizeBoard: (size: number): boolean => {
      recorded.push({ kind: 'resizeBoard', size });

      return true;
    },

    setMergePredicate: refuse,

    setSpawnWeights: refuse,

    request: refuse,

    requested: (): readonly BoardEffect[] => Object.freeze([...recorded]),

    cellValue: (cell: Position): number | null => {
      const tile = grid.cellContent(cell);

      return tile === null ? null : tile.value;
    },

    cellOccupied: (cell: Position): boolean => grid.cellOccupied(cell),

    availableCells: (): Position[] => grid.availableCells(),

    occupiedCells: (): readonly OccupantRecord[] => occupants(grid),

    clear: (): void => {
      recorded.length = 0;
    },
  };
}

/**
 * The ONE state slot both bindings of one subscription share, held behind an
 * object so two context objects can read and write the same value.
 */
interface SlotHolder {
  value: unknown;
}

/** One case's collaborators, all fresh. */
interface AnchorBench {
  /** The rules in force, from `createDefaultRulesConfig` and never frozen. */
  readonly config: RulesConfig;

  /** The run's named substreams, derived from the one suite seed. */
  readonly streams: RngStreams;

  /** The live board. */
  readonly grid: Grid;

  /** The subscription's own state slot, shared by both bindings. */
  readonly slot: SlotHolder;

  /** Commands the handlers recorded, in record order. */
  readonly recorded: BoardEffect[];

  /** Charge amounts the handlers asked for, in request order. */
  readonly chargeRequests: number[];

  /**
   * A context for one hook, reading and writing the bench's single slot.
   *
   * @param hook Hook the context names.
   * @param charges Notional subscription budget; defaults to the declared
   *   one.
   * @returns The context.
   */
  contextFor(hook: HookName, charges?: number): HookContext;
}

/** What one bench may be built differently from the default. */
interface BenchOptions {
  /** Fixture the live board is built from. Defaults to the merge pair. */
  readonly board?: SerializedGameState;

  /** Initial state slot. Defaults to an unwritten slot. */
  readonly state?: unknown;

  /** Whether the queue accepts a restore. Defaults to accepting. */
  readonly acceptRestore?: boolean;

  /** Edge length the rules declare. Defaults to the fixture's own. */
  readonly boardSize?: number;
}

/**
 * @param options What to build differently from the default.
 * @returns The bench.
 */
function createBench(options: BenchOptions = {}): AnchorBench {
  const board = options.board ?? createMergePairBoard();
  const config = createDefaultRulesConfig();

  if (options.boardSize !== undefined) {
    config.boardSize = options.boardSize;
  }

  const streams = createRngStreams(SUITE_SEED);
  const grid = new Grid(board.grid.size, board.grid.cells);
  const recorded: BoardEffect[] = [];
  const chargeRequests: number[] = [];
  const slot: SlotHolder = { value: options.state };
  const rules: ReadonlyRulesView = config;
  const rng: ReadonlyRngView = streams;
  const effects = recordingQueue(
    grid,
    recorded,
    options.acceptRestore ?? true,
  );

  const contextFor = (
    hook: HookName,
    charges: number = DECLARED_CHARGES,
  ): HookContext => ({
    config: rules,
    rng,
    grid: createReadonlyGridView(grid),
    effects,
    correlationId: CORRELATION_ID,
    hook,
    subscriberId: RELIC_ID,
    pickupOrder: 0,
    charges,
    spendCharge: (amount = 1): boolean => {
      chargeRequests.push(amount);

      return true;
    },

    get state(): unknown {
      return slot.value;
    },

    set state(next: unknown) {
      slot.value = next;
    },
  });

  return {
    config,
    streams,
    grid,
    slot,
    recorded,
    chargeRequests,
    contextFor,
  };
}

/**
 * The `onAfterMove` payload, carrying the bench's own board as the capability
 * view src/engine/hook-bus.ts substitutes before the first handler runs.
 *
 * @param bench Bench to read.
 * @param score Score the move settled at.
 * @returns The payload.
 */
function afterMovePayload(
  bench: AnchorBench,
  score: number = ANCHOR_SCORE,
): AfterMovePayload {
  return {
    moved: true,
    board: createReadonlyGridView(bench.grid),
    score,
    over: false,
    won: false,
    terminated: false,
  };
}

/**
 * The `onBeforeMove` payload, with the veto flag as the dispatch sets it.
 *
 * @param bench Bench to read.
 * @param cancelled Whether the move is already withdrawn.
 * @returns The payload.
 */
function beforeMovePayload(
  bench: AnchorBench,
  cancelled = false,
): BeforeMovePayload {
  return {
    direction: DIRECTION_LEFT,
    board: createReadonlyGridView(bench.grid),
    cancelled,
  };
}

/** A production bus with the relic held through a registry. */
interface BusBench {
  readonly config: RulesConfig;
  readonly streams: RngStreams;
  readonly bus: HookBus;
  readonly registry: RelicRegistry;
}

/**
 * Builds a bus bench: a real `HookBus` with the injected reporter, and the
 * relic taken on through `RelicRegistry`, which owns the live budget.
 *
 * @returns The bench.
 * @throws {Error} If the pickup was refused.
 */
function createBusBench(): BusBench {
  const config = createDefaultRulesConfig();
  const streams = createRngStreams(SUITE_SEED);
  const bus = createHookBus({
    correlationId: CORRELATION_ID,
    reporter: NOOP_ENGINE_REPORTER,
  });
  const registry = new RelicRegistry({
    bus,
    reporter: NOOP_ENGINE_REPORTER,
    correlationId: CORRELATION_ID,
  });

  if (registry.pickUp(RELIC_ID) === undefined) {
    throw new Error(`The registry refused to take on ${RELIC_ID}.`);
  }

  return { config, streams, bus, registry };
}

/**
 * Dispatches `onAfterMove` over a live board through the bus.
 *
 * @param bench Bus bench to dispatch on.
 * @param grid Live board the move settled on.
 * @param score Score the move settled at.
 * @returns The dispatch result.
 */
function dispatchAfterMove(bench: BusBench, grid: Grid, score: number) {
  return bench.bus.dispatch(
    'onAfterMove',
    {
      moved: true,
      board: grid,
      score,
      over: false,
      won: false,
      terminated: false,
    },
    { config: bench.config, rng: bench.streams, grid },
  );
}

/**
 * Dispatches `onBeforeMove` over a live board through the bus.
 *
 * @param bench Bus bench to dispatch on.
 * @param grid Live board the move was requested against.
 * @returns The dispatch result.
 */
function dispatchBeforeMove(bench: BusBench, grid: Grid) {
  return bench.bus.dispatch(
    'onBeforeMove',
    { direction: DIRECTION_LEFT, board: grid, cancelled: false },
    { config: bench.config, rng: bench.streams, grid },
  );
}

/**
 * The state slot the bus holds for the relic.
 *
 * @param bench Bus bench to read.
 * @returns The slot as it stands.
 */
function busSlot(bench: BusBench): unknown {
  return bench.bus
    .subscribers()
    .find((subscriber): boolean => subscriber.id === RELIC_ID)?.state;
}

/**
 * The live charge budget the registry holds for the relic.
 *
 * @param bench Bus bench to read.
 * @returns The budget as it stands.
 */
function liveCharges(bench: BusBench): number | undefined {
  return bench.registry.find(RELIC_ID)?.charges;
}

/**
 * The default bench: fresh rules, fresh substreams, a fresh merge-pair board
 * and an unwritten state slot, rebuilt before every case so no case reads
 * another's board, rules or slot.
 */
let bench: AnchorBench;

beforeEach(() => {
  bench = createBench();
});

describe('the temporal-anchor declaration', () => {
  it('is carried by the board-manipulation family under its identifier', () => {
    const relic = anchorRelic();

    expect(relic.id).toBe(RELIC_ID);
    expect(BOARD_MANIPULATION_FAMILY.name).toBe('board-manipulation');
    expect(findRelicById(RELIC_ID)).toBe(relic);
  });

  it('carries the seven declared members and the common rarity tier', () => {
    const relic = anchorRelic();

    expect(relic.name).toBe('Temporal Anchor');
    expect(relic.rarity).toBe(RARITIES[0]);
    expect(relic.description).toBeTypeOf('string');
    expect(relic.description.length).toBeGreaterThan(0);
  });

  it('binds exactly onAfterMove and onBeforeMove, both callable', () => {
    const hooks = anchorRelic().hooks;

    expect(Object.keys(hooks)).toEqual([...BOUND_HOOKS]);
    expect(hooks.onAfterMove).toBeTypeOf('function');
    expect(hooks.onBeforeMove).toBeTypeOf('function');
  });

  it('binds only names HOOK_NAMES declares', () => {
    for (const key of Object.keys(anchorRelic().hooks)) {
      expect(HOOK_NAMES, key).toContain(key);
    }
  });

  it('leaves the four unbound hook names genuinely absent', () => {
    const hooks = anchorRelic().hooks;

    for (const hook of UNBOUND_HOOKS) {
      expect(Object.hasOwn(hooks, hook), hook).toBe(false);
      expect(hooks[hook], hook).toBeUndefined();
    }
  });

  it('is one of the five charge-bearing relics of the catalogue', () => {
    const bearing = RELIC_CATALOGUE.filter(
      (relic): boolean => relic.charges !== undefined,
    ).map((relic): string => relic.id);

    expect(bearing).toHaveLength(CHARGE_BEARING_RELICS);
    expect(bearing).toContain(RELIC_ID);
  });
});

describe('onAfterMove records the position the move settled on', () => {
  it('writes the settled board and score into the relic state slot', () => {
    const settled = bench.grid.serialize();

    recordHandler()(afterMovePayload(bench), bench.contextFor('onAfterMove'));

    expect(isAnchorSlot(bench.slot.value)).toBe(true);
    expect(slotBoard(bench.slot.value)).toEqual(settled);
    expect(slotScore(bench.slot.value)).toBe(ANCHOR_SCORE);
  });

  it('holds a value copy: a later board write leaves the anchor standing',
    () => {
    // A slot holding the live `Grid` or its live `Tile` objects would track
    // every later write.
    const settled = bench.grid.serialize();

    recordHandler()(afterMovePayload(bench), bench.contextFor('onAfterMove'));

    relocate(bench.grid, { x: 0, y: 0 }, { x: 2, y: 2 });
    fillBoard(bench.grid);

    expect(bench.grid.serialize()).not.toEqual(settled);
    expect(slotBoard(bench.slot.value)).toEqual(settled);
  });

  it('holds the board in the { size, cells } vocabulary, empty cells null',
    () => {
    recordHandler()(afterMovePayload(bench), bench.contextFor('onAfterMove'));

    const held = slotBoard(bench.slot.value);

    expect(isSerializedGridShape(held)).toBe(true);
    expect(isRecord(held) ? held.size : null).toBe(bench.grid.size);

    const columns = isRecord(held) ? held.cells : null;

    expect(Array.isArray(columns) ? columns.length : 0).toBe(bench.grid.size);
    expect(Array.isArray(columns) ? columns[2] : null).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it('holds a slot that survives a persistence round trip unchanged', () => {
    recordHandler()(afterMovePayload(bench), bench.contextFor('onAfterMove'));

    const held: unknown = bench.slot.value;
    const encoded = JSON.stringify(held);

    expect(encoded).toBeTypeOf('string');
    expect(JSON.parse(encoded ?? 'null')).toEqual(held);
  });

  it('returns the payload with moved, score, over, won and terminated as they '
    + 'arrived', () => {
    const payload = afterMovePayload(bench);
    const returned = recordHandler()(payload, bench.contextFor('onAfterMove'));

    expect(returned).toBeTypeOf('object');
    expect(returned?.moved).toBe(true);
    expect(returned?.score).toBe(ANCHOR_SCORE);
    expect(returned?.over).toBe(false);
    expect(returned?.won).toBe(false);
    expect(returned?.terminated).toBe(false);
    expect(returned?.board).toBe(payload.board);
  });

  it('changes no cell of the board it is recording', () => {
    const before = occupants(bench.grid);
    const projected = bench.grid.serialize();

    recordHandler()(afterMovePayload(bench), bench.contextFor('onAfterMove'));

    expect(occupants(bench.grid)).toEqual(before);
    expect(bench.grid.serialize()).toEqual(projected);
  });

  it('records no board command and asks for no charge', () => {
    recordHandler()(afterMovePayload(bench), bench.contextFor('onAfterMove'));

    expect(bench.recorded).toEqual([]);
    expect(bench.chargeRequests).toEqual([]);
  });

  it('records nothing while the board holds no empty cell', () => {
    const full = createBench({ board: createNearLossBoard() });

    expect(full.grid.availableCells()).toHaveLength(0);

    recordHandler()(afterMovePayload(full), full.contextFor('onAfterMove'));

    expect(full.slot.value).toBeUndefined();
    expect(full.recorded).toEqual([]);
    expect(full.chargeRequests).toEqual([]);
  });

  it('replaces an anchor already held with the board now settled on', () => {
    recordHandler()(
      afterMovePayload(bench, 8),
      bench.contextFor('onAfterMove'),
    );

    relocate(bench.grid, { x: 1, y: 0 }, { x: 3, y: 3 });

    const moved = bench.grid.serialize();

    recordHandler()(
      afterMovePayload(bench, 16),
      bench.contextFor('onAfterMove'),
    );

    expect(slotBoard(bench.slot.value)).toEqual(moved);
    expect(slotScore(bench.slot.value)).toBe(16);
  });

  it('leaves the rules in force exactly as they arrived', () => {
    const before = rulesFingerprint(bench.config);

    recordHandler()(afterMovePayload(bench), bench.contextFor('onAfterMove'));

    expect(rulesFingerprint(bench.config)).toEqual(before);
  });
});

/**
 * Arms the anchor: records the settled board, then fills every empty cell
 * through the public lattice API so the next move meets a full board.
 *
 * @param target Bench to arm.
 * @param score Score the anchoring move settled at.
 * @returns The projection the anchor now holds.
 */
function armAnchor(
  target: AnchorBench,
  score: number = ANCHOR_SCORE,
): SerializedGrid {
  const settled = target.grid.serialize();

  recordHandler()(
    afterMovePayload(target, score),
    target.contextFor('onAfterMove'),
  );
  fillBoard(target.grid);

  return settled;
}

describe('onBeforeMove rewinds and withdraws the move', () => {
  it('sets the veto flag only when the board holds no empty cell', () => {
    const anchored = armAnchor(bench);
    const payload = beforeMovePayload(bench);

    expect(bench.grid.availableCells()).toHaveLength(0);

    const returned = holdHandler()(payload, bench.contextFor('onBeforeMove'));

    expect(payload.cancelled).toBe(true);
    expect(returned?.cancelled).toBe(true);
    expect(restoreRequests(bench.recorded)).toHaveLength(1);
    expect(restoreRequests(bench.recorded)[0]?.snapshot).toEqual(anchored);
  });

  it('leaves the veto flag unset while the board still holds an empty cell',
    () => {
    // The blocked fixture cannot move LEFT and still holds empty cells, which
    // is the state the anchor must not arm on.
    const open = createBench({ board: createBlockedBoard() });

    recordHandler()(afterMovePayload(open), open.contextFor('onAfterMove'));

    expect(open.grid.availableCells().length).toBeGreaterThan(0);

    const payload = beforeMovePayload(open);
    const returned = holdHandler()(payload, open.contextFor('onBeforeMove'));

    expect(payload.cancelled).toBe(false);
    expect(returned?.cancelled).toBe(false);
    expect(open.recorded).toEqual([]);
    expect(open.chargeRequests).toEqual([]);
  });

  it('records a restore carrying the anchored lattice and the anchored score',
    () => {
    const anchored = armAnchor(bench, 96);

    holdHandler()(beforeMovePayload(bench), bench.contextFor('onBeforeMove'));

    const requests = restoreRequests(bench.recorded);

    expect(bench.recorded).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.snapshot).toEqual(anchored);
    expect(requests[0]?.score).toBe(96);
  });

  it('writes no cell of the live board itself, the command carrying the write',
    () => {
    armAnchor(bench);

    const filled = bench.grid.serialize();

    holdHandler()(beforeMovePayload(bench), bench.contextFor('onBeforeMove'));

    // The queue src/engine/board-effects.ts opens is transactional: a recorded
    // command reaches the lattice once the handler has returned and its return
    // has been accepted.
    expect(bench.grid.serialize()).toEqual(filled);
  });

  it('consumes the anchor it spent, keeping the score it restored', () => {
    armAnchor(bench, 96);

    holdHandler()(beforeMovePayload(bench), bench.contextFor('onBeforeMove'));

    expect(isAnchorSlot(bench.slot.value)).toBe(true);
    expect(slotBoard(bench.slot.value)).toBeNull();
    expect(slotScore(bench.slot.value)).toBe(96);
  });

  it('leaves the move standing with no anchor held, the first turn of a run',
    () => {
    const first = createBench({ board: createNearLossBoard() });
    const payload = beforeMovePayload(first);

    expect(first.slot.value).toBeUndefined();
    expect(first.grid.availableCells()).toHaveLength(0);

    const occupied = occupants(first.grid);

    expect(() =>
      holdHandler()(payload, first.contextFor('onBeforeMove')),
    ).not.toThrow();

    expect(payload.cancelled).toBe(false);
    expect(typeof payload.cancelled).toBe('boolean');
    expect(first.recorded).toEqual([]);
    expect(first.chargeRequests).toEqual([]);
    expect(occupants(first.grid)).toEqual(occupied);
  });

  it('leaves the move standing on a slot the run persisted malformed', () => {
    const corrupted = createBench({
      board: createNearLossBoard(),
      state: { board: 'not-a-board', score: 'not-a-score' },
    });
    const payload = beforeMovePayload(corrupted);

    expect(() =>
      holdHandler()(payload, corrupted.contextFor('onBeforeMove')),
    ).not.toThrow();

    expect(payload.cancelled).toBe(false);
    expect(corrupted.recorded).toEqual([]);
    expect(corrupted.chargeRequests).toEqual([]);
  });

  it('leaves a move another relic already withdrew exactly as it found it',
    () => {
    armAnchor(bench);

    const payload = beforeMovePayload(bench, true);

    holdHandler()(payload, bench.contextFor('onBeforeMove'));

    expect(payload.cancelled).toBe(true);
    expect(bench.recorded).toEqual([]);
    expect(bench.chargeRequests).toEqual([]);
    expect(slotBoard(bench.slot.value)).not.toBeNull();
  });

  it('leaves the move standing when every anchored cell is off the live board',
    () => {
    // The anchor is recorded at the far column of a size-four board and then
    // met by a full size-two board, so no anchored cell is addressable.
    const far = createBench();

    relocate(far.grid, { x: 0, y: 0 }, { x: 3, y: 2 });
    relocate(far.grid, { x: 1, y: 0 }, { x: 3, y: 3 });
    recordHandler()(afterMovePayload(far), far.contextFor('onAfterMove'));

    const shrunk = createBench({
      board: createNearLossBoard(2),
      boardSize: 2,
      state: far.slot.value,
    });
    const payload = beforeMovePayload(shrunk);
    const occupied = occupants(shrunk.grid);

    holdHandler()(payload, shrunk.contextFor('onBeforeMove'));

    expect(payload.cancelled).toBe(false);
    expect(shrunk.recorded).toEqual([]);
    expect(shrunk.chargeRequests).toEqual([]);
    expect(occupants(shrunk.grid)).toEqual(occupied);
    expect(slotBoard(shrunk.slot.value)).not.toBeNull();
  });

  it('withdraws nothing when the recorded restore is refused', () => {
    const refusing = createBench({ acceptRestore: false });

    armAnchor(refusing);

    const payload = beforeMovePayload(refusing);

    holdHandler()(payload, refusing.contextFor('onBeforeMove'));

    expect(payload.cancelled).toBe(false);
    expect(restoreRequests(refusing.recorded)).toEqual([]);
    expect(refusing.chargeRequests).toEqual([]);
    expect(slotBoard(refusing.slot.value)).not.toBeNull();
  });

  it('asks for exactly one charge, and only on the path that rewinds', () => {
    armAnchor(bench);

    expect(bench.chargeRequests).toEqual([]);

    holdHandler()(beforeMovePayload(bench), bench.contextFor('onBeforeMove'));

    expect(bench.chargeRequests).toEqual([1]);
  });

  it('keeps the requested direction and the board it arrived with', () => {
    armAnchor(bench);

    const payload = beforeMovePayload(bench);
    const returned = holdHandler()(payload, bench.contextFor('onBeforeMove'));

    expect(returned?.direction).toBe(DIRECTION_LEFT);
    expect(returned?.board).toBe(payload.board);
    expect(Object.keys(payload).sort()).toEqual([
      'board',
      'cancelled',
      'direction',
    ]);
  });

  it('leaves the rules in force exactly as they arrived', () => {
    armAnchor(bench);

    const before = rulesFingerprint(bench.config);

    holdHandler()(beforeMovePayload(bench), bench.contextFor('onBeforeMove'));

    expect(rulesFingerprint(bench.config)).toEqual(before);
  });
});

describe('the two bindings share the subscription state slot', () => {
  it('carries the run correlation identifier and the subscription identity',
    () => {
    const context = bench.contextFor('onAfterMove');

    expect(context.correlationId).toBe(CORRELATION_ID);
    expect(context.subscriberId).toBe(RELIC_ID);
    expect(context.hook).toBe('onAfterMove');
    expect(context.charges).toBe(DECLARED_CHARGES);
    expect(context.rng.seed).toBe(SUITE_SEED);

    recordHandler()(afterMovePayload(bench), context);

    expect(isAnchorSlot(bench.slot.value)).toBe(true);
  });

  it('reads on onBeforeMove the anchor written on onAfterMove, on one context',
    () => {
    const shared = bench.contextFor('onAfterMove');
    const settled = bench.grid.serialize();

    recordHandler()(afterMovePayload(bench), shared);
    fillBoard(bench.grid);

    const payload = beforeMovePayload(bench);

    holdHandler()(payload, shared);

    expect(payload.cancelled).toBe(true);
    expect(restoreRequests(bench.recorded)[0]?.snapshot).toEqual(settled);
  });

  it('keeps no module-level state: a second run reads its own slot alone',
    () => {
    const first = createBench();
    const firstAnchor = armAnchor(first, 8);

    holdHandler()(beforeMovePayload(first), first.contextFor('onBeforeMove'));

    // A second, independent slot over a full board: the first run's anchor is
    // unreachable, so nothing is withdrawn.
    const second = createBench({ board: createNearLossBoard() });
    const untouched = beforeMovePayload(second);

    holdHandler()(untouched, second.contextFor('onBeforeMove'));

    expect(untouched.cancelled).toBe(false);
    expect(second.recorded).toEqual([]);

    // Run the whole scenario again on a third bench: the outcome matches the
    // first run exactly, so neither run depended on the other.
    const third = createBench();
    const thirdAnchor = armAnchor(third, 8);

    holdHandler()(beforeMovePayload(third), third.contextFor('onBeforeMove'));

    expect(thirdAnchor).toEqual(firstAnchor);
    expect(restoreRequests(third.recorded)).toEqual(
      restoreRequests(first.recorded),
    );
    expect(third.chargeRequests).toEqual(first.chargeRequests);
    expect(third.slot.value).toEqual(first.slot.value);
  });
});

/**
 * Runs one anchor cycle through the production bus: a fresh merge-pair board,
 * the settling dispatch, the fill that closes the board, and the move the
 * anchor withdraws.
 *
 * @param target Bus bench to dispatch on.
 * @param score Score the settling move settled at.
 * @returns The board, the projection the anchor recorded, and both results.
 */
function runAnchorCycle(target: BusBench, score: number = ANCHOR_SCORE) {
  const board = createMergePairBoard();
  const grid = new Grid(board.grid.size, board.grid.cells);
  const settled = dispatchAfterMove(target, grid, score);
  const anchored = grid.serialize();

  fillBoard(grid);

  const requested = dispatchBeforeMove(target, grid);

  return { grid, anchored, settled, requested };
}

describe('the recorded rewind rebuilds the anchored lattice', () => {
  it('restores the exact anchored board, writing it through Grid.insertTile',
    () => {
    const cycle = runAnchorCycle(createBusBench());

    expect(cycle.requested.payload.cancelled).toBe(true);
    expect(cycle.grid.serialize()).toEqual(cycle.anchored);
    expect(cycle.grid.size).toBe(cycle.anchored.size);
  });

  it('leaves a lattice that projects and rebuilds to the same board', () => {
    const cycle = runAnchorCycle(createBusBench());

    expect(reprojected(cycle.grid)).toEqual(cycle.grid.serialize());
    expect(reprojected(cycle.grid)).toEqual(cycle.anchored);
  });

  it('restores every occupant as a Tile whose coordinates agree with its slot',
    () => {
    const cycle = runAnchorCycle(createBusBench());
    const grid = cycle.grid;
    let restored = 0;

    for (let x = 0; x < grid.size; x += 1) {
      for (let y = 0; y < grid.size; y += 1) {
        const occupant = grid.cells[x][y];

        if (occupant === null) {
          continue;
        }

        restored += 1;

        expect(occupant).toBeInstanceOf(Tile);
        expect(occupant.x).toBe(x);
        expect(occupant.y).toBe(y);
        expect(grid.cellContent({ x, y })).toBe(occupant);
      }
    }

    expect(restored).toBe(occupants(grid).length);
    expect(restored).toBeGreaterThan(0);
  });

  it('leaves every restored tile with no previousPosition and no mergedFrom',
    () => {
    // js/tile.js L10-L17 wrote `previousPosition` only through `savePosition`,
    // and js/game_manager.js L113-L120 cleared `mergedFrom` at the head of
    // every move.
    const cycle = runAnchorCycle(createBusBench());

    for (const cell of occupants(cycle.grid)) {
      const occupant = cycle.grid.cellContent(cell);

      expect(occupant?.previousPosition, `${cell.x},${cell.y}`).toBeNull();
      expect(occupant?.mergedFrom, `${cell.x},${cell.y}`).toBeNull();
    }
  });

  it('withdraws the move without spawning a tile or moving a survivor', () => {
    // Figure 4's vetoed branch: the turn ends and no state changes beyond the
    // rewind the anchor asked for.
    const cycle = runAnchorCycle(createBusBench());
    const anchoredCells = cycle.anchored.cells
      .flat()
      .filter((entry): boolean => entry !== null);

    expect(cycle.requested.payload.cancelled).toBe(true);
    expect(occupants(cycle.grid)).toHaveLength(anchoredCells.length);
    expect(cycle.grid.availableCells()).toHaveLength(
      cycle.grid.size * cycle.grid.size - anchoredCells.length,
    );
  });

  it('spends one charge on the rewind and none on the anchoring move', () => {
    const target = createBusBench();

    expect(liveCharges(target)).toBe(DECLARED_CHARGES);

    const cycle = runAnchorCycle(target);

    expect(cycle.settled.invoked).toBe(1);
    expect(cycle.settled.chargesConsumed).toBe(0);
    expect(cycle.requested.invoked).toBe(1);
    expect(cycle.requested.chargesConsumed).toBe(1);
    expect(liveCharges(target)).toBe(DECLARED_CHARGES - 1);
  });

  it('leaves the slot the bus holds a serialisable anchor slot', () => {
    const target = createBusBench();

    runAnchorCycle(target, 96);

    const held: unknown = busSlot(target);

    expect(isAnchorSlot(held)).toBe(true);
    expect(slotBoard(held)).toBeNull();
    expect(slotScore(held)).toBe(96);
  });

  it('names no lattice write of its own in either handler', () => {
    for (const entry of boundHandlerSources()) {
      expect(entry.source, entry.hook).not.toMatch(/insertTile/u);
      expect(entry.source, entry.hook).not.toMatch(/removeTile/u);
      expect(entry.source, entry.hook).not.toMatch(/cells\s*\[/u);
      expect(entry.source, entry.hook).not.toMatch(/savePosition/u);
      expect(entry.source, entry.hook).not.toMatch(/updatePosition/u);
    }
  });
});

describe('the charge budget', () => {
  it('is declared, finite and above zero', () => {
    const declared = anchorRelic().charges;

    expect(declared).toBeTypeOf('number');
    expect(Number.isFinite(declared)).toBe(true);
    expect(declared).toBe(DECLARED_CHARGES);
    expect(declared ?? 0).toBeGreaterThan(0);
  });

  it('is named by neither handler, the guard living in the bus', () => {
    for (const entry of boundHandlerSources()) {
      expect(entry.source, entry.hook).not.toMatch(/\bcharges\b/u);
      expect(entry.source, entry.hook).not.toMatch(/consumeCharge/u);
    }
  });

  it('is asked for through spendCharge alone, with no reporting of its own',
    () => {
    for (const entry of boundHandlerSources()) {
      expect(entry.source, entry.hook).not.toMatch(/console/u);
      expect(entry.source, entry.hook).not.toMatch(/\bcatch\b/u);
    }

    expect(executableSource(holdHandler())).toMatch(/spendCharge/u);
    expect(executableSource(recordHandler())).not.toMatch(/spendCharge/u);
  });

  it('leaves onAfterMove safe when invoked with zero charges remaining', () => {
    const projected = bench.grid.serialize();
    const rules = rulesFingerprint(bench.config);
    const payload = afterMovePayload(bench);

    expect(() =>
      recordHandler()(payload, bench.contextFor('onAfterMove', 0)),
    ).not.toThrow();

    expect(isAnchorSlot(bench.slot.value)).toBe(true);
    expect(() => JSON.stringify(bench.slot.value)).not.toThrow();
    expect(bench.grid.serialize()).toEqual(projected);
    expect(reprojected(bench.grid)).toEqual(projected);
    expect(rulesFingerprint(bench.config)).toEqual(rules);
    expect(payload.score).toBe(ANCHOR_SCORE);
  });

  it('leaves onBeforeMove safe when invoked with zero charges remaining',
    () => {
    armAnchor(bench);

    const rules = rulesFingerprint(bench.config);
    const filled = bench.grid.serialize();
    const payload = beforeMovePayload(bench);

    expect(() =>
      holdHandler()(payload, bench.contextFor('onBeforeMove', 0)),
    ).not.toThrow();

    expect(typeof payload.cancelled).toBe('boolean');
    expect(isAnchorSlot(bench.slot.value)).toBe(true);
    expect(() => JSON.stringify(bench.slot.value)).not.toThrow();
    expect(bench.grid.serialize()).toEqual(filled);
    expect(reprojected(bench.grid)).toEqual(filled);
    expect(rulesFingerprint(bench.config)).toEqual(rules);
  });

  it('leaves a later invocation at a live budget working correctly', () => {
    const settled = bench.grid.serialize();

    recordHandler()(
      afterMovePayload(bench),
      bench.contextFor('onAfterMove', 0),
    );
    fillBoard(bench.grid);

    const payload = beforeMovePayload(bench);

    holdHandler()(payload, bench.contextFor('onBeforeMove', DECLARED_CHARGES));

    expect(payload.cancelled).toBe(true);
    expect(restoreRequests(bench.recorded)[0]?.snapshot).toEqual(settled);
    expect(bench.chargeRequests).toEqual([1]);
  });

  it('leaves the slot fit for the next dispatch after a zero-charge rewind',
    () => {
    armAnchor(bench);
    holdHandler()(
      beforeMovePayload(bench),
      bench.contextFor('onBeforeMove', 0),
    );

    // The slot is empty of a board and the next settling move fills it again.
    expect(slotBoard(bench.slot.value)).toBeNull();

    const reopened = createBench();

    recordHandler()(
      afterMovePayload(reopened, 8),
      reopened.contextFor('onAfterMove', 0),
    );

    expect(slotBoard(reopened.slot.value)).toEqual(
      createMergePairBoard().grid,
    );
    expect(slotScore(reopened.slot.value)).toBe(8);
  });

  it('is as safe at a negative budget as at zero, which restore reaches',
    () => {
    // `RelicRegistry.restore` does not clamp a persisted budget, so a negative
    // one is reachable.
    const anchored = armAnchor(bench);
    const rules = rulesFingerprint(bench.config);
    const payload = beforeMovePayload(bench);

    expect(() =>
      holdHandler()(payload, bench.contextFor('onBeforeMove', -1)),
    ).not.toThrow();

    expect(typeof payload.cancelled).toBe('boolean');
    expect(isAnchorSlot(bench.slot.value)).toBe(true);
    expect(restoreRequests(bench.recorded)[0]?.snapshot).toEqual(anchored);
    expect(rulesFingerprint(bench.config)).toEqual(rules);

    const negativeRecord = createBench();

    expect(() =>
      recordHandler()(
        afterMovePayload(negativeRecord),
        negativeRecord.contextFor('onAfterMove', -1),
      ),
    ).not.toThrow();

    expect(isAnchorSlot(negativeRecord.slot.value)).toBe(true);
  });

  it('stops rewinding once the budget the run holds reaches zero', () => {
    const target = createBusBench();

    for (let spent = 1; spent <= DECLARED_CHARGES; spent += 1) {
      const cycle = runAnchorCycle(target, ANCHOR_SCORE);

      expect(cycle.requested.payload.cancelled, `cycle ${String(spent)}`).toBe(
        true,
      );
      expect(cycle.grid.serialize()).toEqual(cycle.anchored);
      expect(liveCharges(target)).toBe(DECLARED_CHARGES - spent);
    }

    expect(liveCharges(target)).toBe(0);

    // The budget is spent: the board stays as the move found it, no rewind is
    // applied, the move is not withdrawn, and nothing raises.
    const spentSlot = JSON.stringify(busSlot(target));
    const board = createMergePairBoard();
    const grid = new Grid(board.grid.size, board.grid.cells);
    const settled = dispatchAfterMove(target, grid, ANCHOR_SCORE);

    fillBoard(grid);

    const filled = grid.serialize();
    const requested = dispatchBeforeMove(target, grid);

    expect(settled.failed).toBe(0);
    expect(requested.failed).toBe(0);
    expect(requested.payload.cancelled).toBe(false);
    expect(requested.chargesConsumed).toBe(0);
    expect(grid.serialize()).toEqual(filled);
    expect(grid.availableCells()).toHaveLength(0);
    expect(reprojected(grid)).toEqual(filled);

    // One pool across both bindings: the spent budget covers the anchoring
    // binding too, so no new anchor was recorded either.
    expect(JSON.stringify(busSlot(target))).toBe(spentSlot);
    expect(slotBoard(busSlot(target))).toBeNull();
    expect(liveCharges(target)).toBe(0);
  });
});

describe('the anchor is deterministic', () => {
  it('advances no substream cursor across either handler', () => {
    const before = bench.streams.snapshotCursors();

    armAnchor(bench);
    holdHandler()(beforeMovePayload(bench), bench.contextFor('onBeforeMove'));

    const after = bench.streams.snapshotCursors();

    expect(after).toEqual(before);

    for (const name of RNG_STREAM_NAMES) {
      expect(after[name], name).toBe(0);
    }
  });

  it('advances no substream cursor when dispatched through the bus', () => {
    const target = createBusBench();
    const before = target.streams.snapshotCursors();

    runAnchorCycle(target);

    expect(target.streams.snapshotCursors()).toEqual(before);
  });

  it('names no unseeded randomness in either handler', () => {
    for (const entry of boundHandlerSources()) {
      expect(entry.source, entry.hook).not.toMatch(/Math\s*\.\s*random/u);
      expect(entry.source, entry.hook).not.toMatch(/Date\s*\.\s*now/u);
    }
  });
});

describe('the catalogue declaration survives the suite unchanged', () => {
  it('is frozen at the declaration and at its handler table', () => {
    expect(Object.isFrozen(anchorRelic())).toBe(true);
    expect(Object.isFrozen(anchorRelic().hooks)).toBe(true);
  });

  it('still declares every member it shipped with, the budget included', () => {
    expect(anchorRelic().charges).toBe(DECLARED_CHARGES);
    expect(declarationFingerprint()).toBe(DECLARED_FINGERPRINT);
  });
});
