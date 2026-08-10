/**
 * The run lifecycle: identity resolution, run-state persistence, the stage and
 * relic slices of every commit, stage advancement and the run summary.
 *
 * RESPONSIBILITIES
 *   src/run/run-state.ts declares the nine-member envelope and
 *   src/run/run-state-store.ts reads and writes it. This module joins both to a
 *   running game: it resolves the run's identity before anything else exists,
 *   adopts a stored envelope where one is readable, supplies the engine's two
 *   context providers from it, and writes it back on every commit.
 *
 * STORAGE KEYS
 *   The board lives under `gameState`, written and cleared by the engine as
 *   js/game_manager.js wrote and cleared it; the best score lives under
 *   `bestScore` in its frozen format. The envelope WRAPS a copy of the board
 *   snapshot under its own namespaced key and never becomes the board's home,
 *   so a save written by the pre-migration game still loads and a build that
 *   never reaches this module still plays.
 *
 * DETERMINISM
 *   The `rngCursor` map is snapshotted into the envelope on every commit and
 *   read back out at composition, which is what continues a resumed run's
 *   sequence. Cursors only move forward: `createRngStreams` fast-forwards past
 *   the draws a map records and nothing here rewinds one, so a restart within a
 *   run continues the sequence rather than replaying it.
 *
 * SEED ORIGINATION
 *   `originateRunSeed()` mints the value every substream is derived from, and
 *   is the one unseeded randomness source in the product; src/rng/seeded-rng.ts
 *   names this module as the home of that origination. `globalThis.crypto` is
 *   read behind a feature check, and nothing is ever installed onto
 *   `Math.random`.
 *
 * ONE AUTHORITY OVER A REWARD
 *   `recordRewardOffer()` admits the offer and `resolveReward()` is the single
 *   transition from that offer to a live, persisted relic: it validates the
 *   selection against the offer standing and the registry's catalogue, has the
 *   registry take the relic on LIVE through `pickUpRelic` so its handlers reach
 *   the hook bus, appends exactly the entry the registry returned, and reports
 *   success only where the live registry agrees.
 *
 * ONE REGISTRATION STEP, AND ONE ROUND CLOSURE
 *   `selectReward()`, the method a reward screen presses, takes the relic on
 *   through that SAME `takeRelicOn()` step, and both it and `resolveReward()`
 *   finish through `closeRewardRound()`, which clears the offer and performs
 *   the one stage advance a cleared stage is owed. Neither path can keep a
 *   relic without advancing the run, nor advance the run without keeping the
 *   relic.
 *
 * THE TERMINAL WIN OUTRANKS THE STAGE PAYOUT
 *   A commit carrying `won` with play blocked leaves the cleared stage
 *   UNRESOLVED: no offer is drawn and no stage advances until the win is
 *   resolved, and the commit that a continued win produces resolves the stage
 *   that was waiting.
 *
 * NO CLOCK ON THE PLAY PATH, NO DOM
 *   The time source `originateRunSeed()` falls back to is read only while
 *   minting a seed, never while a turn resolves. Nothing here reads the
 *   document. The correlation identifier is received by injection and
 *   republished: src/engine/types.ts L66-L81 names `deriveCorrelationId` in
 *   src/observability/logger.ts as its one deriver, and this module imports no
 *   observability module.
 *
 * One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
 * this module's area enumerated:
 *   TR-RUNCTL-01  js/game_manager.js L1-L14   collaborator wiring, ported as
 *                                             `RunControllerOptions` and the
 *                                             constructor
 *   TR-RUNCTL-02  js/game_manager.js L17-L21  `restart()`, ported as
 *                                             `startRun()` and `resumeRun()`
 *   TR-RUNCTL-03  js/game_manager.js L24-L32  the `keepPlaying` and terminated
 *                                             branches, ported as the
 *                                             `RunOutcome` routing of
 *                                             `finish()`
 *   TR-RUNCTL-04  js/game_manager.js L35-L59  `setup()`, ported as `begin()`
 *                                             and the fresh envelope
 *   TR-RUNCTL-05  js/game_manager.js L85-L89  the save-or-clear branch, ported
 *                                             as `persist()` and `finish()`
 *   TR-RUNCTL-06  js/game_manager.js L95      the read-after-write, ported as
 *                                             the board refreshed from
 *                                             `serialize()`
 *   TR-RUNCTL-07  target-only row             `originateRunSeed()`, the one
 *                                             unseeded randomness source
 *   TR-RUNCTL-08  target-only row             the stage and relic commit
 *                                             context providers the engine
 *                                             reads
 *   TR-RUNCTL-09  target-only row             `measureCommittedBoard()`, the
 *                                             progress measurement taken while
 *                                             a commit is assembled
 *   TR-RUNCTL-10  target-only row             `projectRelic()`, the contained
 *                                             per-relic copy every projection
 *                                             of a held relic passes through
 *
 * Decisions behind this file, argued in docs/DECISION_LOG.md and named here
 * only so the construct can be found from the log:
 *   DL-RUNCTL-01  originating the seed from `globalThis.crypto` with a
 *                 time-plus-counter fallback
 *   DL-RUNCTL-02  capturing the substream cursors at the persist call
 *   DL-RUNCTL-03  goal derivation and evaluation delegated to
 *                 src/config/stage-config.ts
 *   DL-RUNCTL-04  the correlation identifier received by injection
 *   DL-RUNCTL-05  both commit slices resolved at the PROVIDER CALL: the stage
 *                 slice measured from the board the commit carries and the
 *                 relic slice projected from the live registry, rather than
 *                 from the envelope the commit listener refreshes afterwards
 *   DL-RUNCTL-06  every projection that leaves this controller cloned and
 *                 frozen, the stage goal and the board included, so no caller
 *                 holds a reference the envelope's writer also writes
 *   DL-RUNCTL-07  one writer of `onRewardDrawn`, the private `reportReward`,
 *                 taking the offer's own stage and requiring `accepted`
 *   DL-RUNCTL-08  opening the next stage idempotent per stage, tracked from
 *                 the engine's own `stage:start`
 *   DL-RUNCTL-09  alias pairs on the relic-registry port for projection,
 *                 hydration and activation
 *   DL-RUNCTL-10  one transaction closing a reward round, with exactly one
 *                 stage advance
 *   DL-RUNCTL-11  `normalizeEnteredSeed()` bounding the raw value before the
 *                 presence test and the trim
 *   DL-RUNCTL-12  the stage payout deferred while a terminal win stands
 *                 unresolved, rather than drawn over it
 *   DL-RUNCTL-13  `summary()` describing the run in force, with the finished
 *                 run read from `endRun()`'s return or `lastSummary()`
 *   DL-RUNCTL-14  `begin()` restoring a standing reward round before setup, by
 *                 projection from the catalogue rather than by drawing
 *   DL-RUNCTL-15  the persistence write inside the reward transaction, with a
 *                 refused write rolling the whole round back
 *   DL-RUNCTL-16  `completeReward()` starting no stage for a refused selection
 *   DL-RUNCTL-17  the controller subscribing to the engine through
 *                 `observe(engine, cursors)` and never being called by it
 *   DL-RUNCTL-18  no charge-spending member at all, a tray press being an
 *                 inspection that spends nothing
 */

import type { RulesConfig } from '../config/rules-config';
import {
  DEFAULT_STAGE_CONFIG,
  evaluateStageGoal,
  stageGoalForIndex,
  type StageConfig,
  type StageGoal,
} from '../config/stage-config';
import type {
  EngineEvents,
  MoveAfterEvent,
  StateCommitEvent,
} from '../engine/engine-events';
import type {
  CorrelationId,
  CorrelationSource,
  RelicCommitContext,
  RelicCommitContextProvider,
  RelicCommitEntry,
  SerializedGameState,
  StageCommitContext,
  StageCommitContextProvider,
} from '../engine/types';
import { correlationReader } from '../engine/types';
import {
  isAcceptableRunSeed,
  MAX_RUN_SEED_LENGTH,
  RNG_STREAM_NAMES,
  type RngCursorMap,
} from '../rng/rng-streams';
import { RUN_STATE_KEY } from '../storage/storage-keys';
import {
  classifyRunStateVersion,
  cloneBoardSnapshot,
  cloneRelic,
  cloneRunState,
  cloneStageGoal,
  createFreshRunState,
  MAX_PERSISTED_RELICS,
  NOOP_RUN_REPORTER,
  normalizeRngCursor,
  redactRunSummary,
  summarizeRunState,
  type LegacyBoardSnapshot,
  type RunPersistence,
  type PendingRewardRound,
  type PersistedRelic,
  type RunOutcome,
  type RunReporter,
  type RunState,
  type RunSummary,
} from './run-state';
import {
  migrateRunState,
  readRunStateSnapshot,
  type RunStateLoadOutcome,
  type RunStatePersistencePort,
  type RunStateStore,
} from './run-state-store';

/** Bytes drawn for an originated token, rendered as that many hex pairs. */
const SEED_BYTES = 16;

/** Radix the fallback renders its two time components in. */
const SEED_RADIX = 36;

/** Hex width of one byte, so every rendered token has a fixed length. */
const HEX_WIDTH = 2;

/** Microsecond resolution for the fallback's monotonic component. */
const MICROSECONDS_PER_MILLISECOND = 1000;

/** Distinguishes two tokens minted inside one clock tick. */
let originationCounter = 0;

/**
 * Mints a fresh run seed.
 *
 * Total: returns a usable seed for every environment, including one carrying
 * neither `crypto` nor `performance`. The result always satisfies
 * `isAcceptableRunSeed`.
 *
 * REPORTS NOTHING, AND NEVER THROWS. This and the four readers below run
 * before any sink exists — the correlation identifier every report carries is
 * derived from the seed this function returns — so each unusable randomness
 * source is stepped over to the next rather than reported. Decision
 * DL-RUNCTL-01.
 *
 * @returns A freshly originated seed.
 */
export function originateRunSeed(): string {
  const source = readCryptoSource();

  if (source !== null) {
    const bytes = drawRandomBytes(source);

    if (bytes !== null) {
      return bytes;
    }

    const uuid = drawRandomUuid(source);

    if (uuid !== null) {
      return uuid;
    }
  }

  return originateFallbackSeed();
}

/**
 * Mints an identifier for one run instance.
 *
 * @returns A freshly originated identifier, unique under the same
 *   probabilistic bound as `originateRunSeed`.
 */
export function originateRunId(): string {
  return originateRunSeed();
}

/**
 * Largest raw seed text this module will read before reducing it.
 *
 * `MAX_RUN_SEED_LENGTH` is the domain the substreams accept, and this is the
 * ceiling on the text a reduction is allowed to WALK to get there. The two
 * differ because the reduction trims surrounding whitespace, so the raw text may
 * legitimately be longer than the seed it yields; four times the seed domain
 * leaves three times `MAX_RUN_SEED_LENGTH` in slack for that, which no realistic
 * entry approaches. Both are derived, never literals: `MAX_RUN_SEED_LENGTH` is
 * itself the generator's ceiling less the longest substream suffix.
 *
 * WHY A CEILING BEFORE THE WALK. `trim()` and a presence regex are both
 * whole-string operations, so a programmatic caller or a very large paste made
 * the cost of reducing a seed proportional to whatever it handed in, before
 * `MAX_RUN_SEED_LENGTH` was ever applied. Slicing first makes every step after
 * it bounded. Decision DL-RUNCTL-11.
 */
export const MAX_ENTERED_SEED_LENGTH = MAX_RUN_SEED_LENGTH * 4;

/**
 * Reduces a seed a player typed to one the substreams accept.
 *
 * Bounded to `MAX_ENTERED_SEED_LENGTH` FIRST, then trimmed of surrounding
 * whitespace, then bounded to `MAX_RUN_SEED_LENGTH`, and otherwise carried
 * through OPAQUELY: a seed is a string, never a number, so digits are not parsed
 * and unicode is not transliterated. Bounding uses code units, which is what
 * `isAcceptableRunSeed()` measures, so a truncation can split a surrogate pair;
 * the result stays a valid seed because a seed is never interpreted.
 *
 * NEVER THROWS. Input that is empty, whitespace-only or not a string falls back
 * to `originateRunSeed()` rather than raising, so the run-start screen's
 * optional seed field needs no error path.
 *
 * @param input Whatever the seed field held.
 * @returns A seed satisfying `isAcceptableRunSeed`.
 */
export function normalizeEnteredSeed(input: string): string {
  if (typeof input !== 'string') {
    return originateRunSeed();
  }

  // The raw ceiling, applied before any whole-string work. A slice is O(bound)
  // rather than O(input), so nothing after this line reads more than
  // `MAX_ENTERED_SEED_LENGTH` code units. DL-RUNCTL-11.
  const raw =
    input.length > MAX_ENTERED_SEED_LENGTH
      ? input.slice(0, MAX_ENTERED_SEED_LENGTH)
      : input;

  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return originateRunSeed();
  }

  const bounded =
    trimmed.length > MAX_RUN_SEED_LENGTH
      ? trimmed.slice(0, MAX_RUN_SEED_LENGTH)
      : trimmed;

  // Defence in depth: the slice above already satisfies the predicate for
  // every reachable bound.
  return isAcceptableRunSeed(bounded) ? bounded : originateRunSeed();
}

/**
 * The minimum of Web Crypto this module reads, or `null` when it is absent.
 */
interface CryptoSource {
  readonly getRandomValues?: (array: Uint8Array) => Uint8Array;
  readonly randomUUID?: () => string;
}

/** Reads `globalThis.crypto` without assuming it exists. */
function readCryptoSource(): CryptoSource | null {
  try {
    const candidate: unknown = (globalThis as { crypto?: unknown }).crypto;

    if (typeof candidate !== 'object' || candidate === null) {
      return null;
    }

    return candidate as CryptoSource;
  } catch {
    // A host whose global throws on property access is treated as one that
    // carries no crypto, which the fallback below covers.
    return null;
  }
}

/** `getRandomValues` as lowercase hex, or `null` when it is unusable. */
function drawRandomBytes(source: CryptoSource): string | null {
  const draw = source.getRandomValues;

  if (typeof draw !== 'function') {
    return null;
  }

  try {
    const bytes = new Uint8Array(SEED_BYTES);

    draw.call(source, bytes);

    return Array.from(bytes, (byte: number) =>
      byte.toString(16).padStart(HEX_WIDTH, '0'),
    ).join('');
  } catch {
    return null;
  }
}

/** `randomUUID`, or `null` when it is unusable or yields no string. */
function drawRandomUuid(source: CryptoSource): string | null {
  const draw = source.randomUUID;

  if (typeof draw !== 'function') {
    return null;
  }

  try {
    const uuid = draw.call(source);

    return typeof uuid === 'string' && uuid.length > 0 ? uuid : null;
  } catch {
    return null;
  }
}

/**
 * A seed from a high-resolution time source combined with a counter, for a
 * host carrying no usable `crypto`.
 */
function originateFallbackSeed(): string {
  originationCounter += 1;

  const wallClock = Date.now().toString(SEED_RADIX);
  const monotonic = readMonotonicComponent();
  const counter = originationCounter.toString(SEED_RADIX);

  return `${wallClock}-${monotonic}-${counter}`;
}

/** The monotonic clock in `SEED_RADIX`, and `'0'` when none is available. */
function readMonotonicComponent(): string {
  try {
    const candidate: unknown = (globalThis as { performance?: unknown })
      .performance;

    if (typeof candidate !== 'object' || candidate === null) {
      return '0';
    }

    const now = (candidate as { now?: unknown }).now;

    if (typeof now !== 'function') {
      return '0';
    }

    const reading: unknown = now.call(candidate);

    if (typeof reading !== 'number' || !Number.isFinite(reading)) {
      return '0';
    }

    return Math.trunc(reading * MICROSECONDS_PER_MILLISECOND).toString(
      SEED_RADIX,
    );
  } catch {
    return '0';
  }
}

/** Identifiers one reward offer may carry. */
export const MAX_REWARD_OFFERS = 8;

/**
 * Why a reward offer or a reward selection was refused.
 *
 * One vocabulary. `'not-offered'` and `'refused'` are the spellings
 * `RewardSelectionOutcome` already used for these two reasons, so the outcome
 * a selection returns and the refusal a report carries name a refusal the same
 * way.
 */
export type RewardRefusal =
  | 'offer'
  | 'not-offered'
  | 'unknown'
  | 'held'
  | 'full'
  | 'refused'
  | 'unconfirmed';

/** The stage index every run opens on. */
const FIRST_STAGE_INDEX = 0;

/**
 * The identity one run plays under.
 *
 * Resolved BEFORE the logger, the metrics registry, the substreams, the store
 * or the engine exist, because every one of those is constructed with a value
 * derived from it: the correlation identifier comes from `seed` and `runId`
 * together, and the substreams come from `seed`.
 */
export interface RunIdentity {
  /**
   * The run seed, verbatim, as `createRngStreams` takes it. Guaranteed to
   * satisfy `isAcceptableRunSeed`, so building the substreams from it cannot
   * throw.
   */
  readonly seed: string;

  /** Identifier of this run instance. A resumed run keeps the stored one. */
  readonly runId: string;

  /** Whether a readable stored envelope supplied `seed` and `runId`. */
  readonly resumed: boolean;

  /** Whether `seed` came from the caller rather than being originated. */
  readonly seedProvided: boolean;
}

/** Everything `resolveRunIdentity` reads. */
export interface ResolveRunIdentityOptions {
  /**
   * Where the stored envelope is read from. Only `readJson` is used, and the
   * value it returns is validated before a single member of it is adopted.
   */
  readonly storage: Pick<RunStatePersistencePort, 'readJson'>;

  /**
   * Originates a seed or a run identifier. Called at most twice — first for
   * the seed, then for the run identifier — and not at all when a stored
   * envelope supplies both.
   *
   * Defaults to `originateRunSeed`, so this function is callable with a port
   * alone. The composition root injects the same factory it uses elsewhere.
   */
  readonly createToken?: () => string;

  /**
   * A caller-supplied seed — the run-start screen's optional seed input.
   * Adopted only when `isAcceptableRunSeed` accepts it, and adopting one
   * starts a FRESH run: a seed the player chose cannot continue a run that was
   * played under a different one.
   */
  readonly seed?: string;
}

/**
 * Resolves the identity of the run about to be composed.
 *
 * REPORTS NOTHING, AND NEVER THROWS. This runs before the observability layer
 * exists — it is what supplies the correlation identifier that layer is keyed
 * on — so it has no sink to report to and cannot acquire one without
 * inverting the dependency. The authoritative load is
 * `RunController.begin()`, which runs once the sink exists and is the read
 * that reports a corrupted payload, a migration or a board-size
 * reconciliation.
 *
 * The two reads agree because both reduce the same stored value through the
 * same validation: an envelope this function adopts is an envelope
 * `RunStateStore.load()` also adopts.
 *
 * @param options Port, token factory and optional caller-supplied seed.
 * @returns The resolved identity.
 */
export function resolveRunIdentity(
  options: ResolveRunIdentityOptions,
): RunIdentity {
  const createToken = options.createToken ?? originateRunSeed;
  const requested = options.seed;

  // The supplied seed is measured as given, NOT normalised.
  if (
    typeof requested === 'string' &&
    requested.length > 0 &&
    isAcceptableRunSeed(requested)
  ) {
    return {
      seed: requested,
      runId: createToken(),
      resumed: false,
      seedProvided: true,
    };
  }

  const restored = readStoredIdentity(options.storage);

  if (restored !== null) {
    return { ...restored, resumed: true, seedProvided: false };
  }

  return {
    seed: createToken(),
    runId: createToken(),
    resumed: false,
    seedProvided: false,
  };
}

/**
 * Reads `seed` and `runId` out of the stored envelope, or reports that none is
 * usable.
 */
function readStoredIdentity(
  storage: Pick<RunStatePersistencePort, 'readJson'>,
): { readonly seed: string; readonly runId: string } | null {
  try {
    // The SAME bounded read `RunStateStore.load()` and `peekRelics()` perform,
    // rather than a third independent one: `readRunStateSnapshot()` applies the
    // envelope's raw-size ceiling before anything parses, and the storage
    // adapter memoises a parse per key on the exact stored text, so the three
    // startup consumers share one parse of one bounded blob. An oversized value
    // yields no identity and the run originates a fresh one, which is the same
    // answer the authoritative load reaches. DL-RUNSTORE-06, DL-RUNCTL-01.
    const snapshot = readRunStateSnapshot(storage);

    if (!snapshot.present || snapshot.oversize) {
      return null;
    }

    const stored = snapshot.parsed;
    const restored = migrateRunState(stored, classifyRunStateVersion(stored));

    if (restored === null) {
      return null;
    }

    return { seed: restored.seed, runId: restored.runId };
  } catch {
    return null;
  }
}

/**
 * The slice of the engine this controller uses.
 *
 * Narrowed to three members so the controller cannot reach anything else: it
 * observes, it reads the board snapshot it persists, and it resolves a stage
 * whose goal has been met. `Engine` in src/engine/engine.ts satisfies this
 * structurally; nothing imports the class.
 */
export interface RunEnginePort {
  /** Subscription surface. The controller never emits. */
  readonly events: EngineEventSource;

  /** The board snapshot to wrap in the envelope. */
  serialize(): SerializedGameState;

  /** Resolves the stage in progress. Called when its goal has been met. */
  endStage(cleared: boolean): void;

  /**
   * Begins the stage the controller has just advanced to.
   *
   * THE COUNTERPART OF `endStage()`, and the second half of a stage transition:
   * `endStage()` resolves the stage that finished, this controller advances its
   * own index and goal, and this begins the stage that follows. The engine
   * reads the index from the provider this controller supplies, so the advance
   * must precede the call.
   *
   * Called with NO argument, which carries the board already in play into the
   * new stage. The optional parameter is the engine's own — a snapshot reopens
   * the stage on that board instead — and is declared here so an engine
   * satisfies the port either way.
   *
   * Called with NO argument, which carries the board already in play into the
   * new stage. The optional parameter is the engine's own — a snapshot
   * reopens the stage on that board instead — and is declared here so an
   * engine satisfies the port either way.
   *
   * Optional so a test double that only observes still satisfies the port.
   * Where it is absent the stage index advances and no stage is begun, which is
   * the behaviour of an engine that does not implement stage transitions.
   */
  startStage?(board?: SerializedGameState | null): void;
}

/**
 * The subscription surface of `EngineEvents`, and nothing else.
 *
 * `on` APPENDS, so attaching here neither displaces a listener already
 * attached nor reorders the ones after it. `off` and `emit` are deliberately
 * absent: this controller subscribes and never emits or detaches another
 * subscriber.
 */
export type EngineEventSource = Pick<EngineEvents, 'on'>;

/**
 * The four move directions, as `EnginePort.move` accepts them.
 *
 * DECLARED HERE, NOT IMPORTED, for the same reason every other member of
 * these ports is: this folder names src/engine's types structurally.
 * Identical to `Direction` of src/engine/types.ts — 0 up, 1 right, 2 down, 3
 * left — so an engine satisfies the port and a caller cannot reach the engine
 * with a fifth value through this declaration.
 */
export type MoveDirection = 0 | 1 | 2 | 3;

/**
 * The slice of the engine a run START drives, beyond the observation surface.
 *
 * `Engine` in src/engine/engine.ts satisfies this structurally; nothing
 * imports the class, so src/engine never imports this folder. Named after the
 * members the engine actually exposes — `continuePlaying()` is the engine's
 * method for play continued past a win, and `setup()` takes the reconciled
 * snapshot the store returned.
 */
export interface EnginePort extends RunEnginePort {
  /** Opens a board, from the reconciled snapshot when one is supplied. */
  setup(previousState?: SerializedGameState | null): void;

  /** Discards the board in progress and opens a fresh one. */
  restart(): void;

  /**
   * Resolves one turn. Reports whether the board changed.
   *
   * NARROWED TO THE FOUR DIRECTIONS, not `number`: a port widening the engine's
   * own parameter type made an out-of-contract direction reachable through this
   * declaration without a type error, and the engine assumed the narrowed
   * union. `MoveDirection` restates `Direction` of src/engine/types.ts rather
   * than importing a value from it, keeping this folder's ports structural.
   */
  move(direction: MoveDirection): boolean;

  /** Whether the engine refuses further moves. */
  isGameTerminated(): boolean;

  /** Continues play past a win. */
  continuePlaying(): void;
}

/** The slice of a relic registry this controller round-trips through. */
export interface RelicRegistryPort {
  /**
   * Projects the relics held, in pickup order, for the envelope to carry.
   * Consulted before each write when present, so charges a handler spent and
   * state a handler advanced reach the envelope.
   *
   * Satisfied by `RelicRegistry.serialize`.
   */
  readonly serialize?: () => readonly PersistedRelic[];

  /**
   * Takes one relic on for the rest of the run: appends it at the next pickup
   * position, seeds its budget and its state slot, and binds its handlers so
   * the hook bus dispatches to it from the next dispatch onwards.
   *
   * THE ACTIVATION STEP, under the second of the two names it may be published
   * as. `resolveRelic` only reads; this is what makes a chosen relic actually
   * fire. `takeRelicOn()` reads `pickUpRelic` first and this next, so a
   * registry publishing either has its relics registered — and a registry
   * publishing neither can record a reward but cannot make it take effect.
   *
   * @param relicId Identifier of the relic to take on.
   * @returns The entry to persist, or `null` where the identifier is
   *   unknown, already held, or the bus refused the registration.
   */
  readonly activateRelic?: (relicId: string) => PersistedRelic | null;

  /**
   * Identifiers of the relics held, in pickup order. Read when an offer is
   * drawn so a relic the run already holds is never offered again.
   */
  readonly ownedRelicIds?: () => readonly string[];

  /**
   * Restores the relics a loaded envelope carried, in pickup order. `state` is
   * handed back exactly as it was persisted.
   *
   * Satisfied by `RelicRegistry.restore`.
   */
  readonly restore?: (relics: readonly PersistedRelic[]) => void;

  /**
   * The same projection as `serialize`, under the name this port first
   * declared it. A registry supplying either is read through whichever it
   * supplies.
   *
   * Satisfied by `RelicRegistry.snapshotRelics`.
   */
  readonly snapshotRelics?: () => readonly PersistedRelic[];

  /**
   * The same hydration as `restore`, under the name this port first declared
   * it.
   *
   * Satisfied by `RelicRegistry.restoreRelics`.
   */
  readonly restoreRelics?: (relics: readonly PersistedRelic[]) => void;

  /**
   * Resolves a HELD identifier to the entry to persist, and yields `null` for
   * one the registry does not hold. A registry without this member persists
   * the bare identifier.
   *
   * Satisfied by `RelicRegistry.persistedEntry`.
   */
  readonly resolveRelic?: (relicId: string) => PersistedRelic | null;

  /**
   * Reports the board edge length a set of PERSISTED entries implies, and
   * `undefined` where they imply none.
   *
   * A registry without this member loads with no relic-implied size, which is
   * the behaviour of a run holding no board-mutating relic.
   */
  readonly relicBoardSize?: (
    relics: readonly PersistedRelic[],
  ) => number | undefined;

  readonly persistedEntry?: (relicId: string) => PersistedRelic | null;

  /**
   * Reports whether the registry's catalogue carries an identifier at all,
   * whether or not it is held. A reward selection is refused when this yields
   * `false`, so an identifier no catalogue carries can never be picked up.
   *
   * Satisfied by `RelicRegistry.knows`.
   */
  readonly knows?: (relicId: string) => boolean;

  /**
   * Takes one relic on for the rest of the run, registering it with the hook
   * bus in pickup order. Yields a falsy value where the pickup was refused —
   * an unknown identifier, a relic already held, or a registration the bus
   * declined.
   *
   * Satisfied by `RelicRegistry.pickUp`, whose `ActiveRelic | undefined`
   * return is read only for presence.
   */
  readonly pickUp?: (relicId: string) => unknown;

  // NO CHARGE-SPENDING MEMBER. `RelicRegistry.activate()` exists and is the
  // registry's own charge ledger, but it is reached by the hook bus on the
  // dispatch that ran a relic's handler — never from here. Naming it on this
  // port would re-open the path where a press debits a budget while producing
  // no board effect. DL-RUNCTL-18.

  /** Reports whether the registry's catalogue carries an identifier. */
  readonly knowsRelic?: (relicId: string) => boolean;

  /**
   * Takes one relic on LIVE — registering its handlers so they fire on the
   * next hook — and yields the entry to persist for exactly the relic the
   * registry accepted.
   *
   * The step `resolveReward()` is built around: without it a chosen reward is
   * appended to this controller's list alone, fires on no hook, and is erased
   * by the next commit's projection.
   *
   * @returns The accepted entry, and `null` for an identifier the registry
   *   refused.
   */
  readonly pickUpRelic?: (relicId: string) => PersistedRelic | null;

  /**
   * Reports whether the registry holds the relic live.
   *
   * Read after a pickup, so success is reported only where the live registry
   * and the persisted envelope agree that the relic was taken on.
   */
  readonly holdsRelic?: (relicId: string) => boolean;
}

/** One relic as a reward screen presents it: plain data, no handler. */
export interface RewardOffer {
  readonly id: string;
  readonly name: string;
  readonly rarity: string;
  readonly description: string;

  /** Names of the hooks the relic binds, for the card's hook badges. */
  readonly hooks: readonly string[];

  /** Charge budget the relic starts with, where it carries one. */
  readonly charges?: number;
}

/** The seeded draw an offer is taken from. */
export interface RewardDrawPort {
  /**
   * Draws distinct offers, excluding the relics the run already holds.
   *
   * @param input How many offers to draw and which identifiers to exclude.
   * @returns The offers, in presentation order.
   */
  draw(input: {
    readonly count: number;
    readonly ownedIds: readonly string[];
  }): readonly RewardOffer[];

  /**
   * Projects offers a stored round named, WITHOUT drawing.
   *
   * The counterpart of `draw` on the load path: a round that survived a reload
   * is restored by resolving its identifiers against the relic catalogue, so the
   * player is shown the same three cards rather than a fresh draw, and no
   * substream cursor moves. An identifier the catalogue no longer declares is
   * dropped rather than raised on, so a round that named one still restores the
   * rest.
   *
   * Optional: a composition supplying no projector restores no round, and the
   * run resolves the stage it resumed on as if the offer had not been drawn.
   *
   * @param relicIds Identifiers to resolve, in presentation order.
   * @returns The offers, in the order the identifiers were given.
   */
  project?(relicIds: readonly string[]): readonly RewardOffer[];
}

/** Why a reward selection was refused, or that it was accepted. */
export type RewardSelectionOutcome =
  | 'accepted'
  | 'no-offer'
  | 'not-offered'
  | 'already-resolved'
  | 'unknown-relic'
  | 'refused';

/**
 * What the `refusal` member of a `RewardDrawnReport` carries.
 *
 * The two vocabularies of this module, unioned and with `'accepted'` removed:
 * `resolveReward()` and `recordRewardOffer()` name the STEP that refused, and
 * `selectReward()` names the OUTCOME code it returned. A report carries
 * whichever its writer speaks, and never a decorated identifier.
 */
export type RewardReportRefusal =
  | RewardRefusal
  | Exclude<RewardSelectionOutcome, 'accepted'>;

/** What one reward selection did. */
export interface RewardSelection {
  readonly outcome: RewardSelectionOutcome;

  /** Identifier that was selected, exactly as supplied. */
  readonly relicId: string;

  /** Stage index the run stands on after the transaction. */
  readonly stageIndex: number;
}

/** How many relics a reward screen offers (AAP R8: choose 1 of 3). */
export const REWARD_OFFER_COUNT = 3;

/** The frozen empty offer every no-reward state resolves to. */
const NO_OFFER: readonly RewardOffer[] = Object.freeze([]);

/** The stage index recorded while no offer stands. */
const NO_OFFER_STAGE = -1;

/** The stage index recorded while the engine has reported starting none. */
const NO_STARTED_STAGE = -1;

/**
 * Copies one persisted relic entry, detaching its state slot by structural
 * copy.
 *
 * The registry's projection is the registry's own object. Copying it here keeps
 * a later write from carrying a reference the registry still mutates, which is
 * the same discipline `cloneRunState` applies to everything else in the
 * envelope. A state slot that cannot be structurally copied is omitted rather
 * than shared, exactly as `JSON.stringify` would omit it.
 */
function cloneRelicEntry(relic: PersistedRelic): PersistedRelic {
  const copy: { id: string; charges?: number; state?: unknown } = {
    id: relic.id,
  };

  if (relic.charges !== undefined) {
    copy.charges = relic.charges;
  }

  if (relic.state !== undefined) {
    try {
      copy.state = JSON.parse(JSON.stringify(relic.state)) as unknown;
    } catch {
      // A slot holding a cycle or a value JSON cannot express is dropped,
      // which is what the store would do with it on the next write anyway.
    }
  }

  return copy;
}

/** Whether two persisted relic lists differ in identifier, order or budget. */
function relicsDiffer(
  before: readonly PersistedRelic[],
  after: readonly PersistedRelic[],
): boolean {
  if (before.length !== after.length) {
    return true;
  }

  for (let index = 0; index < before.length; index += 1) {
    const left = before[index];
    const right = after[index];

    if (
      left === undefined ||
      right === undefined ||
      left.id !== right.id ||
      left.charges !== right.charges
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Everything one reward round consists of, recorded so a refused persistence
 * write can put all of it back.
 *
 * Internal to the controller's reward transaction and not part of its published
 * surface: it is exported only so the two private members that produce and
 * consume it can name one type.
 */
export interface RewardRoundSnapshot {
  readonly offer: readonly RewardOffer[];
  readonly offeredRelicIds: readonly string[];
  readonly offerStageIndex: number;
  readonly resolvedRelicId: string | null;
  readonly stageIndex: number;
  readonly stageGoal: StageGoal;
  readonly goalProgress: number;
  readonly pendingReward: PendingRewardRound | undefined;
}

/** What `RunController.resolveReward` reports. */
export interface RewardResolution {
  /** Whether the relic joined the held list. */
  readonly accepted: boolean;

  /**
   * Why a selection was refused, and `null` where it was accepted.
   *
   * Carries `RewardRefusal`, whose members `recordRewardOffer` and this method
   * share, so the offer's own refusal and a selection's are reported in one
   * vocabulary.
   */
  readonly refusal: RewardRefusal | null;
}

/** Every construction parameter. `store`, `identity`, `config` required. */
export interface RunControllerOptions {
  /** Where the envelope is read and written. */
  readonly store: RunStateStore;

  /** The identity `resolveRunIdentity` produced. */
  readonly identity: RunIdentity;

  /**
   * The live rules configuration, read for `boardSize` alone: the edge length
   * a fresh envelope's empty board records, and the size the store reconciles
   * a stored board against.
   */
  readonly config: RulesConfig;

  /** The progression curve. Defaults to `DEFAULT_STAGE_CONFIG`. */
  readonly stages?: StageConfig;

  /**
   * Originates the run identifier of a run started after one ended in the same
   * page load. Defaults to reusing the injected identity's, which is correct
   * for the common case of a page load that plays one run.
   */
  readonly createToken?: () => string;

  /** Lifecycle sink. Defaults to `NOOP_RUN_REPORTER`. */
  readonly reporter?: RunReporter;

  /**
   * Correlation identifier every report from this controller carries.
   * Injected, never derived here.
   */
  readonly correlationId?: CorrelationSource;

  /**
   * The relic registry to round-trip charges and state through. Absent by
   * default, in which case the envelope carries the relics this controller was
   * handed and nothing consults a registry.
   */
  readonly relics?: RelicRegistryPort;

  /**
   * The seeded draw a reward offer is taken from. Absent on a controller that
   * offers no reward, in which case a cleared stage advances immediately —
   * the behaviour of a run played without the relic system.
   */
  readonly rewards?: RewardDrawPort;

  /** How many relics a reward offers. Defaults to `REWARD_OFFER_COUNT`. */
  readonly offerCount?: number;

  /**
   * Called whenever the run's identity changes, BEFORE the engine opens a board
   * on it, so the composition root can rebuild everything scoped to the run.
   *
   * THE RUN-SCOPED CONSTRUCTS LIVE OUTSIDE THIS CONTROLLER: the substreams are
   * built from `seed()` and `cursors()` by the composition root, and the
   * correlation context is derived by src/observability/logger.ts. A new run
   * mints a new seed and a new run identifier, and every construct scoped to
   * the run is replaced together with them. Decision DL-RUNCTL-04.
   *
   * Called before `engine.setup()`, so the opening spawns are drawn from the
   * NEW substreams rather than the ones the previous run left mid-sequence.
   *
   * A raise is contained and reported: a root that fails to rebuild must not
   * leave the run half-started.
   */
  readonly onRunScope?: (scope: RunScope) => void;
}

/**
 * The run-scoped identity a composition root rebuilds against.
 *
 * Everything a new run invalidates, in one object: the seed the substreams are
 * built from, the identifier the correlation context is derived from, and the
 * draw counts the substreams resume at — zeros for a fresh run.
 */
export interface RunScope {
  /** Identifier of the run now in force. */
  readonly runId: string;

  /** Seed the run is played under. */
  readonly seed: string;

  /** Draw counts to build the substreams at. */
  readonly cursors: RngCursorMap;

  /** Whether the seed was supplied by a caller rather than originated. */
  readonly seedProvided: boolean;
}

/** Everything `RunController.startRun` reads. */
export interface StartRunOptions {
  /** The seed to play. Absent means originate one. */
  readonly seed?: string;

  /**
   * The board to open on. Absent means open an empty board, which is what a
   * fresh run does.
   */
  readonly board?: SerializedGameState | null;
}

/** Owns the run in progress. */
export class RunController {
  readonly identity: RunIdentity;

  private readonly store: RunStateStore;

  private readonly config: RulesConfig;

  private readonly stages: StageConfig;

  private readonly createToken: () => string;

  private readonly reporter: RunReporter;

  /**
   * Reads the correlation identifier every report from this controller
   * carries.
   */
  private readonly readRunCorrelationId: () => CorrelationId;

  private readonly registry: RelicRegistryPort | undefined;

  /** Rebuilds the composition root's run-scoped constructs. */
  private readonly onRunScope:
    | ((scope: RunScope) => void)
    | undefined;

  /**
   * The board `begin()` adopted, and `null` where it adopted none.
   *
   * The RECONCILED board: `RunStateStore.load()` has already resolved a
   * snapshot saved at another edge length, so this is safe to open a grid on.
   * `null` is meaningful rather than merely absent — it is what the engine
   * must be passed for it to insert start tiles.
   */
  private openingSnapshot: LegacyBoardSnapshot | null;

  /** Whether the last load READ an envelope, whatever became of it. */
  private storedEnvelopeRead: boolean;

  /**
   * The offer standing: the identifiers `recordRewardOffer()` admitted, and the
   * ONLY identifiers `resolveReward()` will take on. Empty while no offer
   * stands, which is the state a refused offer and a resolved reward both
   * leave. The offer itself is drawn elsewhere.
   */
  private offeredRelicIds: readonly string[];

  /** The seeded draw an offer is taken from, where one was injected. */
  private readonly rewards: RewardDrawPort | undefined;

  /** How many relics one offer presents. */
  private readonly offerCount: number;

  /** The offer a reward screen is presenting, frozen. */
  private offer: readonly RewardOffer[];

  /**
   * Stage index in force when the standing offer was drawn, or `-1` while none
   * stands.
   */
  private offerStageIndex: number;

  /**
   * The relic the reward round in force was resolved with, and `null` while no
   * round has been resolved.
   *
   * WHAT SEPARATES A RESOLVED ROUND FROM NO ROUND AT ALL. An accepted selection
   * clears the offer and the offered identifiers together, so neither of those
   * can answer "was this round already resolved?" afterwards: reading them
   * reported `'no-offer'` for a double-clicked card and `'already-resolved'`
   * for an offer that had been recorded and never drawn. Cleared whenever a new
   * round opens — a fresh draw, a recorded offer, a begun or started run, a
   * finished one.
   */
  private resolvedRelicId: string | null;

  /**
   * The stage index the resolved reward round was OFFERED at, and
   * `NO_OFFER_STAGE` while no round has been resolved.
   *
   * Held because `closeRewardRound()` clears `offerStageIndex`, so a selection
   * refused as `'already-resolved'` afterwards had nothing left to attribute
   * itself to and reported the stage the run had moved on to. Written and
   * cleared wherever `resolvedRelicId` is. DL-RUNCTL-07.
   */
  private resolvedStageIndex: number;

  /**
   * The stage index the ENGINE last reported starting, and `-1` while it has
   * reported none.
   *
   * WHAT MAKES A STAGE OPEN IDEMPOTENT. Two collaborators can open the stage a
   * cleared one advanced to — the commit handler, and `completeReward()`
   * closing the reward that gated it — and both opening it dispatched
   * `onStageStart` twice for one stage, so every per-stage relic effect applied
   * twice. Recorded from the engine's own `stage:start`, so it names the stage
   * the engine actually began rather than the one this controller intended to
   * begin.
   */
  private startedStageIndex: number;

  /** The envelope in force. Replaced wholesale; never mutated in place. */
  private current: RunState;

  /**
   * Whether the stage's goal has been met and not yet resolved. Set by the
   * progress measurement and cleared by `advanceStage`.
   */
  private stageCleared: boolean;

  /**
   * Guards the one re-entrant path: `endStage` commits, so the commit handler
   * that called it is re-entered before it returns.
   */
  private resolvingStage: boolean;

  /** Whether the run in force has ended. Set by `finish`. */
  private ended: boolean;

  /**
   * Whether the run in force is reaching storage, as the last write left it.
   *
   * `'persistent'` until a write is refused. A run starts optimistic rather
   * than unknown: nothing has failed, and the first write settles it either
   * way.
   */
  private persistence: RunPersistence = 'persistent';

  /**
   * Writes refused since the run last persisted. Reset by a write that
   * succeeds, so it measures the current outage and not the run.
   */
  private refusedWrites = 0;

  /** The last finished run, for a summary screen to read. */
  private finished: RunSummary | null;

  /**
   * The board this run opens on, as `board` reports it. Three states, and the
   * distinction between the last two is what keeps a legacy save loadable; see
   * `board`.
   */
  private adoptedBoard: SerializedGameState | null | undefined;

  /**
   * Reads the board of the engine being observed, or `null` before one is.
   *
   * Attached by `observe` and released with it. `stageContext` measures
   * through it, so a commit reached without a `move:after` — a withdrawn move
   * that reseated the board, a stage end that adopted a handler's score —
   * still carries a stage slice measured from the board it commits.
   */
  private boardReader: (() => SerializedGameState) | null;

  constructor(options: RunControllerOptions) {
    this.store = options.store;
    this.identity = options.identity;
    this.config = options.config;
    this.stages = options.stages ?? DEFAULT_STAGE_CONFIG;
    this.createToken =
      options.createToken ?? ((): string => this.identity.runId);
    this.reporter = options.reporter ?? NOOP_RUN_REPORTER;
    this.readRunCorrelationId = correlationReader(options.correlationId);
    this.registry = options.relics;
    this.rewards = options.rewards;
    this.offerCount =
      options.offerCount === undefined ||
      !Number.isInteger(options.offerCount) ||
      options.offerCount < 0
        ? REWARD_OFFER_COUNT
        : options.offerCount;
    this.onRunScope = options.onRunScope;
    this.openingSnapshot = null;
    this.storedEnvelopeRead = false;
    this.offeredRelicIds = [];
    this.offer = NO_OFFER;
    this.offerStageIndex = NO_OFFER_STAGE;
    this.resolvedRelicId = null;
    this.resolvedStageIndex = NO_OFFER_STAGE;
    this.startedStageIndex = NO_STARTED_STAGE;
    this.current = this.freshState(this.identity.runId);
    this.stageCleared = false;
    this.resolvingStage = false;
    this.ended = false;
    this.finished = null;
    this.adoptedBoard = undefined;
    this.boardReader = null;
  }

  /**
   * The board the engine should OPEN ON, as the one board-load authority.
   *
   * EXACTLY ONE LOAD DECIDES. `Engine.setup()` called with no argument reads
   * the legacy `gameState` key through its own storage port, and that read
   * alongside a run load is two loads of two different values — the
   * reconciled board the run produced, whose edge length was weighed against
   * the configured size and against any board-shrinking relic, against
   * whatever the legacy snapshot carries. This reports which of the two
   * decides.
   *
   * THREE STATES, EACH WITH A DIFFERENT MEANING, and each mapping onto a
   * distinct `Engine.setup()` argument:
   *
   *   a `SerializedGameState` — an envelope was adopted, and this is its
   *   RECONCILED board. Authoritative: the engine opens on it and reads no
   *   storage.
   *
   *   `null` — this controller STARTED a fresh run. The engine opens an empty
   *   board and reads no storage, because a new game must not inherit a stored
   *   one.
   *
   *   `undefined` — no envelope was adopted and no fresh run was started, so
   *   there is no run-level board at all. The engine falls back to its own port
   *   read, which is what keeps a LEGACY SAVE — a `gameState` written by the
   *   vanilla game, before any run envelope existed — loadable across the
   *   upgrade, as AAP 0.4.1.3 requires.
   *
   * @returns The adopted board, `null`, or `undefined`.
   */
  board(): SerializedGameState | null | undefined {
    return this.adoptedBoard;
  }

  /**
   * Performs the authoritative load and adopts its result.
   *
   * @returns The load outcome, for a caller that wants to report or display
   *   it.
   */
  begin(): RunStateLoadOutcome {
    const result = this.store.load({
      runId: this.identity.runId,
      seed: this.identity.seed,
      stageGoal: this.goalForStage(FIRST_STAGE_INDEX),
      boardSize: this.config.boardSize,

      relicBoardSize: this.readRelicBoardSize(),
    });

    const restored = result.state;
    const adopted = restored !== null && restored.seed === this.identity.seed;

    this.current = adopted
      ? (restored as RunState)
      : this.freshState(this.identity.runId);

    // The authoritative board to open on, recorded here at the one place the
    // adoption decision is made so no later caller has to re-derive it —
    // re-deriving it from `store.exists` reported success for a payload that
    // was present and unreadable.
    //
    // `board()` reports the reconciled board of an ADOPTED envelope and
    // nothing else, and reports `undefined` rather than `null` where none was
    // adopted: there is then no run-level board, and the engine's own port
    // read of the legacy `gameState` key is the remaining authority — which
    // is what keeps a save written by the vanilla game loadable across the
    // upgrade.
    //
    // `openingBoard()` reports the same adopted board but resolves the
    // no-envelope case to `null`, which is what makes the engine insert start
    // tiles rather than opening on an empty board it then leaves empty.
    // `hadStoredEnvelope()` is what separates the two cases for a caller.
    this.adoptedBoard = adopted ? this.current.board : undefined;
    this.openingSnapshot = adopted ? this.current.board : null;
    this.storedEnvelopeRead = restored !== null;

    this.stageCleared = false;
    this.ended = false;
    this.offeredRelicIds = [];
    this.offer = NO_OFFER;
    this.offerStageIndex = NO_OFFER_STAGE;

    // No round of THIS run has been resolved and no stage of it has been
    // opened yet, whichever run the instance was reporting on before.
    this.resolvedRelicId = null;
    this.resolvedStageIndex = NO_OFFER_STAGE;
    this.startedStageIndex = NO_STARTED_STAGE;

    // THE UNRESOLVED ROUND, PUT BACK. Restored from the adopted envelope and
    // projected from the catalogue rather than redrawn, so the resumed run shows
    // the same three cards, moves no cursor, and — because a standing round is
    // what `onCommit` reads to know the stage END is already resolved — does not
    // dispatch `stage:end` for that stage a second time. Ordered before
    // `restoreRelics()` so the offer stands before any relic can act.
    // DL-RUN-06, DL-RUNCTL-14.
    this.restorePendingReward();

    // The relics of an adopted envelope are handed back to the registry so the
    // hook bus dispatches to them in the pickup order they were saved in.
    this.restoreRelics();

    // The seed and the cursors the run will actually be played under are known
    // only now, after the adoption decision: an adopted envelope resumes its
    // own substreams mid-sequence, a fresh one starts them at zero.
    this.publishRunScope(this.identity.seedProvided);

    this.reporter.onRunStarted?.({
      correlationId: this.readRunCorrelationId(),
      runId: this.current.runId,
      stageIndex: this.current.stageIndex,

      // Whether a stored run was ADOPTED, which is the question the report
      // asks.
      resumed: adopted,
      seedProvided: this.identity.seedProvided,
    });

    return result.outcome;
  }

  /**
   * Hands the relics held to the registry again.
   *
   * A CONSTRUCTION-ORDER CONTRACT. `begin()` restores the adopted envelope's
   * relics already, but the registry is constructed over the ENGINE'S hook bus
   * and the engine is constructed after this controller, which reads this
   * controller's context providers. A composition root therefore binds the
   * registry after `begin()` has run, and this carries the relics of a resumed
   * run into a registry that did not exist when they were loaded.
   *
   * Idempotent and total: the registry's own `restore` drops whatever it held
   * first, so calling this twice leaves the same set held, and a registry that
   * raises is reported rather than left to raise out of composition.
   *
   * THE ENVELOPE IS THE AUTHORITY, so this — and the `begin()` that precedes
   * it — makes the live registry agree with the envelope and DISCARDS
   * anything the registry held that the envelope does not carry. A relic must
   * therefore be taken on through the reward transaction (`selectReward()` /
   * `resolveReward()`), which records it in the envelope as it registers it,
   * or be restored from an envelope by this call after `begin()`; one picked
   * up on the registry directly before `begin()` belongs to no run and does
   * not survive it.
   */
  restoreHeldRelics(): void {
    this.restoreRelics();
  }

  /**
   * The board the engine must open on, as `begin` resolved it.
   *
   * @returns The reconciled board, or `null` to open fresh.
   */
  openingBoard(): LegacyBoardSnapshot | null {
    return this.openingSnapshot;
  }

  /**
   * Whether the last load read a stored envelope at all.
   *
   * Read alongside `openingBoard` to tell the two no-board cases apart. See
   * `openEngineBoard`, which applies the distinction.
   *
   * @returns `true` when an envelope was read, adopted or not.
   */
  hadStoredEnvelope(): boolean {
    return this.storedEnvelopeRead;
  }

  /**
   * Opens the engine's board on whatever the load resolved.
   *
   * @param engine The engine to open.
   */
  openEngineBoard(engine: EnginePort): void {
    const board = this.openingBoard();

    if (board !== null) {
      engine.setup(board);

      return;
    }

    if (this.storedEnvelopeRead) {
      engine.setup(null);

      return;
    }

    engine.setup();
  }

  /**
   * Hands the run's identity to the composition root so it can rebuild every
   * run-scoped construct.
   *
   * @param seedProvided Whether the seed came from a caller.
   */
  private publishRunScope(seedProvided: boolean): void {
    const rebuild = this.onRunScope;

    if (rebuild === undefined) {
      return;
    }

    try {
      rebuild(
        Object.freeze({
          runId: this.current.runId,
          seed: this.current.seed,
          cursors: this.cursors(),
          seedProvided,
        }),
      );
    } catch (error) {
      this.reportRegistryFault(error);
    }
  }

  /** The seed the run is played under. Authoritative over the identity's. */
  seed(): string {
    return this.current.seed;
  }

  /** The identifier of the run in force. */
  runId(): string {
    return this.current.runId;
  }

  /** The correlation identifier every report from this controller carries. */
  correlationId(): CorrelationId {
    return this.readRunCorrelationId();
  }

  /** The index of the stage in progress. */
  stageIndex(): number {
    return this.current.stageIndex;
  }

  /**
   * The clear condition of the stage in progress.
   *
   * A fresh frozen copy. The envelope's own goal is the value every commit's
   * stage slice and every write read, so handing it out by reference let a
   * caller rewrite the target the run is measured against.
   */
  stageGoal(): StageGoal {
    return Object.freeze(cloneStageGoal(this.current.stageGoal));
  }

  /**
   * Fraction of the stage goal reached: the `progress` member
   * `evaluateStageGoal` returned, already clamped by it and stored verbatim.
   */
  goalProgress(): number {
    return this.current.goalProgress;
  }

  /**
   * The relics held, in pickup order, with charges and opaque state.
   *
   * Array order is the pickup order the hook bus dispatches in, so it is
   * returned as held and never sorted, filtered or re-keyed.
   *
   * TOTAL, PER RELIC. `cloneRelic()` reads the opaque `state` slot, which a
   * registry supplies, so reading it can raise — an accessor that throws, a
   * proxy that refuses. A relic whose state cannot be copied is reported and
   * carried with its identifier and its remaining charges alone, which is what
   * every consumer of this projection reads. This projection is also the one
   * `state()` falls back on. Decision DL-RUNCTL-06.
   */
  relics(): readonly PersistedRelic[] {
    return Object.freeze(
      this.current.relics.map((relic): PersistedRelic =>
        Object.freeze(this.projectRelic(relic)),
      ),
    );
  }

  /**
   * Copies one held relic, dropping a state slot that cannot be read.
   *
   * @param relic Relic to copy.
   * @returns A fresh copy, without `state` where copying it raised.
   */
  private projectRelic(relic: PersistedRelic): PersistedRelic {
    try {
      return cloneRelic(relic);
    } catch (error) {
      this.reportRegistryFault(error);

      return relic.charges === undefined
        ? { id: relic.id }
        : { id: relic.id, charges: relic.charges };
    }
  }

  /** The draw counts to resume the substreams from. */
  cursors(): RngCursorMap {
    return normalizeRngCursor(this.current.rngCursor);
  }

  /**
   * The envelope in force, as a fresh frozen copy.
   *
   * Deep on `cloneRunState`'s terms: every relic, every relic state subtree,
   * every cell and the cursor map are rebuilt, so a caller shares no object
   * with the envelope this controller writes and a later mutation of either is
   * invisible to the other.
   *
   * `cloneRunState()` raises `RangeError` on a relic state nested deeper than
   * it can copy without sharing. A query must not raise, so that case yields a
   * frozen shallow projection instead — which still shares no member a caller
   * can reach the envelope through, because every member it copies is either a
   * primitive or replaced below. `board` is COPIED there too: freezing the
   * envelope's own snapshot would freeze the object this controller's next
   * `refresh()` replaces, and handing it out unfrozen let a caller write into
   * the board the writer reads.
   */
  state(): RunState {
    try {
      return Object.freeze(cloneRunState(this.current));
    } catch (error) {
      this.reportRegistryFault(error);

      return Object.freeze({
        ...this.current,
        rngCursor: this.cursors(),
        stageGoal: Object.freeze(cloneStageGoal(this.current.stageGoal)),
        relics: this.relics(),
        board: cloneBoardSnapshot(this.current.board),
      });
    }
  }

  /**
   * The stage slice of a commit.
   *
   * Bound as the engine's `stageContext` provider and therefore called once per
   * commit, so what it returns is read fresh each time rather than captured.
   *
   * IT MEASURES THE BOARD IT IS ABOUT TO DESCRIBE. The `move:after`
   * subscription measures every turn that resolves, but a commit can also be
   * reached by a turn that emits no `move:after` — a withdrawn move whose
   * `onBeforeMove` handler reseated the board is one, and a stage end that
   * adopted a handler's score is another — and the slice those commits
   * carried then described an earlier board. The measurement is taken here,
   * while the payload is being assembled and before any consumer or the write
   * sees it, so every commit's stage slice describes the board that commit
   * carries. `measureCommittedBoard()` is inert until a `stage:start` has
   * attached the board reader, so a projection read before a run has opened a
   * board still reports the progress the envelope recorded.
   *
   * The goal is COPIED AND FROZEN. It is the object this controller keeps in
   * the envelope, and `readonly` in `StageCommitContext` binds the reference
   * rather than the object, so a listener could otherwise retarget the goal the
   * run is measured against and the goal that reaches storage.
   */
  stageContext(): StageCommitContext {
    this.measureCommittedBoard();

    return {
      stageIndex: this.current.stageIndex,
      goal: Object.freeze(cloneStageGoal(this.current.stageGoal)),
      goalProgress: this.current.goalProgress,
    };
  }

  /**
   * The relic slice of a commit, in pickup order.
   *
   * Projected in array order, which IS the pickup order, so the order the hook
   * bus dispatches in and the order a HUD renders are one order. `state` is not
   * carried: a commit's consumers show a relic and its remaining charges, and
   * its private state is nobody else's.
   *
   * PROJECTED FROM THE REGISTRY, not from the envelope. The engine calls
   * this provider while it assembles the commit payload, and the envelope's
   * own relics are refreshed by the commit LISTENER — after that assembly —
   * so a charge a relic handler spent during the turn reached the payload
   * one commit late: the HUD showed the previous count and a reload restored
   * the budget the envelope had. `projectRelics()` reads the registry when
   * one is attached and falls back to the relics held otherwise, so a
   * controller composed without a registry projects exactly what it did
   * before.
   */
  relicContext(): RelicCommitContext {
    return this.projectRelics().map((relic): RelicCommitEntry =>
      relic.charges === undefined
        ? { id: relic.id }
        : { id: relic.id, charges: relic.charges },
    );
  }

  /** `stageContext` as the provider the engine takes. */
  stageCommitContextProvider(): StageCommitContextProvider {
    return (): StageCommitContext => this.stageContext();
  }

  /** `relicContext` as the provider the engine takes, in pickup order. */
  relicCommitContextProvider(): RelicCommitContextProvider {
    return (): RelicCommitContext => this.relicContext();
  }

  /**
   * Attaches to the engine.
   *
   * @param engine The engine to observe.
   * @param cursors Reads the substreams' current draw counts.
   * @returns Releases all three subscriptions.
   */
  observe(engine: RunEnginePort, cursors: () => RngCursorMap): () => void {
    const stopStageStart = engine.events.on('stage:start', (event): void => {
      // WHICH STAGE THE ENGINE HAS OPEN, recorded from the engine's own
      // emission so a second opener can tell that this stage is already begun.
      // Two collaborators can open the stage a cleared one advanced to, and
      // both opening it dispatched `onStageStart` twice for one stage.
      this.startedStageIndex = event.stageIndex;

      // THE BOARD READER IS ATTACHED HERE, not at subscription. A stage start
      // is the first moment the engine holds a board of this run — it is
      // emitted before the commit `setup()` ends with — and until then the
      // engine's lattice is the empty one it was constructed with, which is not
      // a board this run's progress may be measured against.
      this.boardReader = (): SerializedGameState => engine.serialize();

      // THE EVENT'S goal is adopted before the measurement is taken.
      this.adoptStageGoal(event.stageIndex, event.goal);
      this.measureSnapshot(engine.serialize());
    });

    const stopMoveAfter = engine.events.on(
      'move:after',
      (event: MoveAfterEvent): void => {
        this.measure(highestOnBoard(event.board), event.score);
      },
    );

    const stopStageEnd = engine.events.on('stage:end', (event): void => {
      if (!event.cleared) {
        return;
      }

      // WHERE A REWARD GATES THE TRANSITION THE SELECTION ADVANCES, NOT THIS.
      // Advancing here as well would move the run two stages for one clear,
      // and it would also have the HUD report the next stage while the player
      // is still being asked to choose a relic for the one that just cleared.
      // Where no draw port was injected there is no choice to wait for, so
      // the advance stays here and the commit `endStage()` ends with reports
      // the stage now in force — which is the behaviour every run composed
      // without the relic system keeps.
      if (this.rewards !== undefined) {
        return;
      }

      this.advanceStage();
    });

    const stopCommit = engine.events.on(
      'state:commit',
      (event: StateCommitEvent): void => {
        this.onCommit(engine, event, cursors);
      },
    );

    return (): void => {
      stopStageStart();
      stopMoveAfter();
      stopStageEnd();
      stopCommit();
      this.boardReader = null;
    };
  }

  /**
   * Measures the stage's progress from the board the engine holds right now.
   *
   * Called by `stageContext()`, which the engine calls while it assembles a
   * commit, so the progress a commit reports is measured from the board that
   * commit carries. Inert until a `stage:start` has attached the reader and
   * again once the subscriptions are released, which leaves the progress last
   * measured — a resumed envelope's own recorded progress, before any stage
   * has started — in place.
   *
   * TOTAL. `serialize()` is another module's call, so a raise is reported
   * through the contained fault path and the last good progress stands rather
   * than a commit failing to assemble.
   */
  private measureCommittedBoard(): void {
    const read = this.boardReader;

    if (read === null) {
      return;
    }

    try {
      this.measureSnapshot(read());
    } catch (error) {
      this.reportRegistryFault(error);
    }
  }

  /**
   * Adopts the stage index and goal a `stage:start` carried.
   *
   * @param stageIndex Index the stage started at.
   * @param goal Goal the stage is being measured against.
   */
  private adoptStageGoal(stageIndex: number, goal: StageGoal): void {
    const index = Number.isSafeInteger(stageIndex) && stageIndex >= 0
      ? stageIndex
      : this.current.stageIndex;

    this.current = {
      ...this.current,
      stageIndex: index,
      stageGoal: cloneStageGoal(goal),
    };
  }

  /**
   * Advances to the next stage: the next index, that index's goal, and progress
   * back to zero.
   *
   * The relics are carried forward untouched — they are held for the run, not
   * for the stage — and so is the board snapshot, because a stage transition is
   * not a restart.
   *
   * @returns The goal of the stage now in force.
   */
  advanceStage(): StageGoal {
    const from = this.current.stageIndex;
    const to = from + 1;
    const goal = this.goalForStage(to);

    this.current = {
      ...this.current,
      stageIndex: to,
      stageGoal: goal,
      goalProgress: 0,
    };
    this.stageCleared = false;

    this.reporter.onStageAdvanced?.({
      correlationId: this.readRunCorrelationId(),
      fromStageIndex: from,
      toStageIndex: to,
      goal,
    });

    return goal;
  }

  /**
   * Draws the offer a reward screen presents, and records it as the ACTIVE
   * OFFER.
   *
   * The whole draw goes through the injected `RewardDrawPort`, which consumes
   * the run's `relic-draw` and `rarity-weight` substreams: one seed plus one
   * move list therefore yields one offer sequence, which is the second half of
   * AAP V2. Relics the run already holds are excluded, so no relic is offered
   * twice across a run and no offer can contain a duplicate.
   *
   * Idempotent while an offer stands: calling it again returns the offer
   * already drawn rather than drawing a second one, so a screen that re-renders
   * does not move the substreams and does not change what the player is being
   * shown.
   *
   * @returns The offer, frozen. Empty where no draw port was injected, where
   *   the pool is exhausted, or where the run has ended.
   */
  offerReward(): readonly RewardOffer[] {
    if (this.offer.length > 0) {
      return this.offer;
    }

    const rewards = this.rewards;

    if (rewards === undefined || this.ended) {
      return NO_OFFER;
    }

    let drawn: readonly RewardOffer[] = NO_OFFER;

    try {
      drawn = rewards.draw({
        count: this.offerCount,
        ownedIds: this.ownedIds(),
      });
    } catch (error) {
      this.reporter.onWriteFailed?.({
        correlationId: this.readRunCorrelationId(),
        key: RUN_STATE_KEY,
        byteLength: 0,
        error,
      });

      return NO_OFFER;
    }

    if (!Array.isArray(drawn) || drawn.length === 0) {
      return NO_OFFER;
    }

    this.offer = Object.freeze(
      drawn.map((relic) => Object.freeze({ ...relic })),
    );
    this.offeredRelicIds = Object.freeze(
      this.offer.map((relic): string => relic.id),
    );

    // Recorded AFTER the draw succeeded, so a draw that yielded nothing leaves
    // this at `NO_OFFER_STAGE` and no selection can be attributed to it.
    this.offerStageIndex = this.current.stageIndex;

    this.resolvedRelicId = null;
    this.resolvedStageIndex = NO_OFFER_STAGE;

    // WRITTEN INTO THE ENVELOPE, so the round survives a reload. It is also the
    // marker that this stage's END has already been resolved: the goal is still
    // met on every later commit, and without a standing round a resumed run
    // dispatches `stage:end` again — paying every `onStageEnd` bounty a second
    // time and drawing a second offer off advanced cursors. `write()` is the
    // caller's; this only brings the envelope up to date. DL-RUN-06.
    this.current = {
      ...this.current,
      pendingReward: {
        stageIndex: this.offerStageIndex,
        offeredRelicIds: [...this.offeredRelicIds],
      },
    };

    // THE OFFER ITSELF IS REPORTABLE, not only the selection made from it: an
    // offer drawn and never taken is exactly the case a bare selection counter
    // cannot see, and it is the one that says a reward screen was reached.
    this.reporter.onRewardOffered?.({
      correlationId: this.readRunCorrelationId(),
      stageIndex: this.offerStageIndex,
      offeredRelicIds: this.offeredRelicIds,
    });

    return this.offer;
  }

  /**
   * The offer standing, frozen and empty while no reward is pending.
   *
   * @returns The active offer.
   */
  currentOffer(): readonly RewardOffer[] {
    return this.offer;
  }

  /** Whether a reward is waiting to be chosen. */
  isRewardPending(): boolean {
    return this.offer.length > 0;
  }

  /**
   * Resolves the reward: validates the choice, takes the relic on LIVE,
   * persists it, and opens the next stage.
   *
   * ONE TRANSACTION, and the only path a relic enters a run by. Every step is
   * ordered so a refusal at any point leaves the run exactly as it was:
   *
   *   1  an offer must be standing, or the selection is `'no-offer'` — or
   *      `'already-resolved'` where this round has already been resolved;
   *   2  the identifier must be one of the offered ones, or `'not-offered'` —
   *      which is what stops a corrupted store or a caller reaching past the
   *      screen from activating a relic that was never offered;
   *   3  the registry must take the relic on, or `'unknown-relic'`;
   *   4  the envelope must accept the relic, or `'refused'`;
   *   5  the live registry must agree that it holds it, or `'refused'` with the
   *      append withdrawn;
   *   6  only then is the offer cleared, the stage advanced, the next stage
   *      opened on the engine, and the envelope written.
   *
   * THE RELIC IS TAKEN ON THROUGH `takeRelicOn()`, the same registration step
   * `resolveReward()` uses, so the entry persisted is the one the registry
   * produced by REGISTERING the relic with the hook bus, so the persisted entry
   * and the live registration cannot disagree about what the run holds.
   *
   * SINGLE-USE. The offer is cleared by the accepted selection and the round is
   * recorded as resolved, so a second call reports `'already-resolved'` and
   * changes nothing — a double-clicked card cannot take two relics or advance
   * two stages.
   *
   * @param relicId Identifier the player chose.
   * @param engine Engine to open the next stage on. Omit it to advance the
   *   run's stage without reopening a board, which is what a caller driving
   *   the engine itself wants.
   * @returns What the selection did.
   */
  selectReward(relicId: string, engine?: RunEnginePort): RewardSelection {
    if (this.offer.length === 0) {
      // What was resolved, not what was offered.
      return this.refuseSelection(
        relicId,
        this.resolvedRelicId === null ? 'no-offer' : 'already-resolved',
      );
    }

    if (
      typeof relicId !== 'string' ||
      !this.offer.some((relic): boolean => relic.id === relicId)
    ) {
      return this.refuseSelection(relicId, 'not-offered');
    }

    // LIVE FIRST, exactly as `resolveReward()` does it: the entry appended
    // below is the one the registry produced by taking the relic on, so the
    // persisted record is a consequence of the registration rather than
    // bookkeeping beside it.
    const activated = this.takeRelicOn(relicId);

    if (activated === null) {
      return this.refuseSelection(relicId, 'unknown-relic');
    }

    const held = this.current.relics;

    if (!this.appendRelic(relicId, activated)) {
      return this.refuseSelection(relicId, 'refused');
    }

    // The live registry is asked whether it agrees, and one that does not has
    // its append WITHDRAWN, so the persisted list and the live registrations
    // can never disagree about which relics a run holds.
    if (!this.registryHolds(relicId)) {
      this.current = { ...this.current, relics: held };

      return this.refuseSelection(relicId, 'refused');
    }

    const offered = this.offeredRelicIds;

    // BOTH PRESERVED BEFORE THE ROUND CLOSES. `closeRewardRound()` clears the
    // offered identifiers and advances the stage, so the offer's own context has
    // to be read while it still stands.
    const offerStage = this.rewardStageIndex();

    // THE WRITE IS PART OF THE TRANSACTION, and it comes before the stage is
    // opened and before the outcome is reported. The envelope is brought fully up
    // to date — the relic appended, the round closed, the stage advanced — and
    // then written; a refused write rolls every one of those back and the
    // selection is refused, so a player is never told a relic was taken that no
    // reload will find. Previously the write's answer was discarded, and a run
    // whose storage was full advanced a stage and announced an acquisition that
    // the next load knew nothing about. DL-RUNCTL-15.
    const rollback = this.snapshotRewardRound();

    // Clears the offer and performs the one advance the cleared stage is owed.
    this.closeRewardRound(relicId);

    if (!this.write()) {
      this.restoreRewardRound(rollback);
      this.withdrawRelic(held);

      return this.refuseSelection(relicId, 'refused');
    }

    // OPENED ONLY ONCE THE WRITE COMMITTED. Opening the next stage emits
    // `stage:start`, which every subscriber acts on, so it must not happen for a
    // selection that is about to be refused.
    if (engine !== undefined) {
      this.openNextStage(engine);
    }

    // Through the one writer, so this outcome carries `accepted` and the offer's
    // own stage exactly as `resolveReward()`'s does. The write itself happened
    // inside the transaction above. DL-RUNCTL-07, DL-RUNCTL-15.
    this.reportReward(offerStage, relicId, true, null, offered);

    return Object.freeze({
      outcome: 'accepted' as const,
      relicId,
      stageIndex: this.current.stageIndex,
    });
  }

  /**
   * Records the offer a reward screen is about to present.
   *
   * THE OFFER IS NOT DRAWN HERE. Rarity-weighted sampling without replacement
   * lives in src/relics/relic-draw.ts, which consumes the `relic-draw` and
   * `rarity-weight` substreams this controller persists the cursors of. What
   * this method does is decide which offers `resolveReward()` will admit.
   *
   * ADMITTED AS A WHOLE OR NOT AT ALL. An offer is recorded only where it is
   * an array of at most `MAX_REWARD_OFFERS` distinct non-empty identifiers the
   * registry's catalogue carries — the shape the seeded draw produces. Any
   * other list leaves NO offer standing, so a screen that presented something
   * else can have no selection admitted rather than a subset of one.
   *
   * Consumes no randomness and moves no cursor.
   *
   * @param relicIds The identifiers offered, in the order presented.
   * @returns Whether the offer was recorded.
   */
  recordRewardOffer(relicIds: readonly string[]): boolean {
    const admitted = this.admitOffer(relicIds);

    this.offeredRelicIds = admitted ?? [];

    this.resolvedRelicId = null;
    this.resolvedStageIndex = NO_OFFER_STAGE;

    if (admitted === null) {
      this.reportReward(this.rewardStageIndex(), undefined, false, 'offer');
    }

    return admitted !== null;
  }

  /**
   * Records the relic the player chose, having validated the choice and taken
   * the relic on through the registry.
   *
   * FOUR GATES, in order. A selection must be one the player was actually
   * OFFERED, must name a relic the registry's catalogue KNOWS, must not
   * already be HELD, and must fit inside `MAX_PERSISTED_RELICS` — an envelope
   * carrying more than that is refused by the store, so accepting one here
   * would lose the whole run's progress on the next write. Validating against
   * the recorded offer is what stops a caller picking any relic in the
   * catalogue at will; validating against the catalogue is what stops an
   * identifier no offer could have produced reaching the envelope.
   *
   * THE RELIC IS PICKED UP BEFORE IT IS RECORDED. `RelicRegistryPort.pickUp`
   * registers it with the hook bus in pickup order, and only a pickup the
   * registry accepted is appended. Without this the relic reached the envelope
   * and never reached the bus, so it was displayed and never fired.
   *
   * APPENDED, NEVER INSERTED OR SORTED. Array order is pickup order, and the
   * hook bus dispatches in that order, so a relic joins at the end of the held
   * list and every relic already held keeps its position. `charges` and `state`
   * are carried exactly as the registry supplied them, and `state` is never
   * inspected or reshaped.
   *
   * THE OFFER IS RETAINED ON FAILURE. It is cleared only for a selection that
   * was accepted, so a refused pick leaves the same three cards standing and
   * the player can choose again; clearing it either way stranded the screen
   * with nothing left to offer.
   *
   * Reports through `onRewardDrawn` whether or not the relic was taken on, and
   * names the step that refused it, so a refused pick is visible rather than
   * silent.
   *
   * @param relicId Identifier of the chosen relic.
   * @returns Whether the relic joined the held list, and why it did not.
   */
  resolveReward(relicId: string): RewardResolution {
    // READ ONCE, AT THE TOP. Every report below names the stage the offer being
    // resolved was made at, and the accepted branch closes the round — which
    // advances the stage — before it reports. DL-RUNCTL-07.
    const offerStage = this.rewardStageIndex();
    const refusal = this.refuseReward(relicId);

    if (refusal !== null) {
      this.reportReward(offerStage, relicId, false, refusal);

      return Object.freeze({ accepted: false, refusal });
    }

    // LIVE FIRST. The entry appended below is the one the registry produced
    // by taking the relic on, so the persisted record is a CONSEQUENCE of the
    // registration rather than a parallel piece of bookkeeping — which is
    // what it was when a chosen relic reached the envelope, fired on no hook,
    // and was erased by the next commit's projection of the registry.
    const entry = this.takeRelicOn(relicId);

    if (entry === null) {
      this.reportReward(offerStage, relicId, false, 'refused');

      return Object.freeze({ accepted: false, refusal: 'refused' as const });
    }

    const held = this.current.relics;

    if (!this.appendRelic(relicId, entry)) {
      this.reportReward(offerStage, relicId, false, 'refused');

      return Object.freeze({ accepted: false, refusal: 'refused' as const });
    }

    // The live registry is asked whether it agrees.
    if (!this.registryHolds(relicId)) {
      this.current = { ...this.current, relics: held };
      this.reportReward(offerStage, relicId, false, 'unconfirmed');

      return Object.freeze({
        accepted: false,
        refusal: 'unconfirmed' as const,
      });
    }

    // PRESERVED BEFORE THE ROUND CLOSES, for the same reason `offerStage` is
    // read at the top: `closeRewardRound()` clears the offered identifiers.
    const offered = this.offeredRelicIds;

    // CLEARED ONLY ON SUCCESS, so a refused pick leaves the same three cards
    // standing and the player can choose again. A DRAWN offer is closed with the
    // one advance its cleared stage is owed: without that advance this path kept
    // the relic and left the run on the stage it had already cleared, with a
    // reward still reported as pending, so it could never reach the next stage.
    const rollback = this.snapshotRewardRound();

    this.closeRewardRound(relicId);

    // THE PICKUP IS PERSISTED BY THE TRANSACTION THAT MADE IT, AND THE WRITE'S
    // ANSWER DECIDES THE OUTCOME. Previously the write that carried a chosen
    // relic to storage was the commit of the stage start that followed, so a
    // reward resolved without a stage start after it — which is every reward
    // whose stage was already open — was held live and never persisted, and a
    // reload dropped it. Now a refused write rolls the round, the stage and the
    // relic all back and the selection is refused, so the live state and the
    // persisted state cannot diverge. DL-RUNCTL-15.
    if (!this.write()) {
      this.restoreRewardRound(rollback);
      this.withdrawRelic(held);
      this.reportReward(offerStage, relicId, false, 'refused', offered);

      return Object.freeze({ accepted: false, refusal: 'refused' as const });
    }

    // Through the one writer, which carries the offer's own stage and the three
    // identifiers it was drawn from. DL-RUNCTL-07.
    this.reportReward(offerStage, relicId, true, null, offered);

    return Object.freeze({ accepted: true, refusal: null });
  }

  /**
   * Closes the reward round one accepted selection resolved.
   *
   * @param relicId Identifier the accepted selection took on.
   */
  private closeRewardRound(relicId: string): void {
    const drawnOffer = this.offer.length > 0;
    const pendingAdvance =
      drawnOffer && this.current.stageIndex === this.offerStageIndex;

    this.resolvedRelicId = relicId;

    // Recorded BEFORE `offerStageIndex` is cleared: this is the round a later
    // `'already-resolved'` refusal reports against.
    this.resolvedStageIndex = this.rewardStageIndex();

    this.offer = NO_OFFER;
    this.offerStageIndex = NO_OFFER_STAGE;
    this.offeredRelicIds = [];

    // The round leaves the envelope with the live offer, so a reload after an
    // accepted selection resumes on the stage the selection advanced to rather
    // than being offered the same three cards again. Removed rather than
    // emptied, which is the absent state every reader already handles.
    this.clearPersistedReward();

    if (pendingAdvance) {
      this.advanceStage();
    }
  }

  /**
   * Records everything a reward round consists of, so a refused write can put it
   * all back.
   *
   * The live offer, the admitted identifiers, the stage the round belongs to, the
   * round last resolved, the stage index and goal slice of the envelope, and the
   * persisted round itself. Every array is copied, so a later write cannot reach
   * the record.
   *
   * @returns The record `restoreRewardRound()` takes.
   */
  private snapshotRewardRound(): RewardRoundSnapshot {
    return {
      offer: this.offer,
      offeredRelicIds: this.offeredRelicIds,
      offerStageIndex: this.offerStageIndex,
      resolvedRelicId: this.resolvedRelicId,
      stageIndex: this.current.stageIndex,
      stageGoal: this.current.stageGoal,
      goalProgress: this.current.goalProgress,
      pendingReward: this.current.pendingReward,
    };
  }

  /**
   * Puts a recorded reward round back in force, envelope included.
   *
   * The inverse of everything `closeRewardRound()` does: the offer stands again,
   * the round is unresolved again, and the stage the advance moved past is
   * restored along with its goal and its measured progress. Nothing is written —
   * the caller is rolling back BECAUSE a write was refused.
   *
   * @param snapshot Record `snapshotRewardRound()` produced.
   */
  private restoreRewardRound(snapshot: RewardRoundSnapshot): void {
    this.offer = snapshot.offer;
    this.offeredRelicIds = snapshot.offeredRelicIds;
    this.offerStageIndex = snapshot.offerStageIndex;
    this.resolvedRelicId = snapshot.resolvedRelicId;

    const restored: RunState = {
      ...this.current,
      stageIndex: snapshot.stageIndex,
      stageGoal: snapshot.stageGoal,
      goalProgress: snapshot.goalProgress,
    };

    if (snapshot.pendingReward === undefined) {
      const { pendingReward: _dropped, ...rest } = restored;

      this.current = rest;

      return;
    }

    this.current = { ...restored, pendingReward: snapshot.pendingReward };
  }

  /**
   * Takes a relic back off, live and in the envelope, after a step following the
   * pickup refused.
   *
   * THE LIVE SET IS RESTORED FROM THE LIST, not released by identifier: the
   * registry publishes no single-relic release, and re-restoring the exact list
   * held before the pickup is stronger than one — it puts back the pickup order,
   * every charge budget and every state slot as they stood, and it is idempotent.
   * A registry that raises is reported and the envelope is restored anyway, since
   * the envelope is the authority for what a run holds and the next load hands the
   * registry exactly what it carries.
   *
   * @param held The relic list to restore, as the envelope carried it before the
   *   pickup.
   */
  private withdrawRelic(held: readonly PersistedRelic[]): void {
    this.current = { ...this.current, relics: held };

    const registry = this.registry;
    const restore = registry?.restoreRelics ?? registry?.restore;

    if (restore === undefined) {
      return;
    }

    try {
      // Called through its owner; see `projectRelics()`.
      restore.call(registry, held);
    } catch (error) {
      this.reportRegistryFault(error);
    }
  }

  /**
   * Removes the standing reward round from the envelope, leaving the member
   * absent rather than present and empty.
   *
   * Idempotent: an envelope carrying no round is left as the same object, so a
   * caller cannot make a write necessary by asking twice.
   */
  private clearPersistedReward(): void {
    if (this.current.pendingReward === undefined) {
      return;
    }

    const { pendingReward: _dropped, ...rest } = this.current;

    this.current = rest;
  }

  /**
   * Measures a selection against the four gates `resolveReward()` applies.
   *
   * @param relicId Identifier the player chose.
   * @returns The reason to refuse, or `null` for a selection that passes.
   */
  private refuseReward(relicId: string): RewardResolution['refusal'] {
    if (typeof relicId !== 'string' || relicId.length === 0) {
      return 'not-offered';
    }

    if (!this.offeredRelicIds.includes(relicId)) {
      return 'not-offered';
    }

    if (!this.catalogueCarries(relicId)) {
      return 'unknown';
    }

    const held = this.current.relics;

    if (held.some((relic: PersistedRelic) => relic.id === relicId)) {
      return 'held';
    }

    if (held.length >= MAX_PERSISTED_RELICS) {
      return 'full';
    }

    return null;
  }

  /**
   * Reports a raise that came out of the injected registry.
   *
   * @param error Whatever was thrown.
   */
  private reportRegistryFault(error: unknown): void {
    this.reporter.onWriteFailed?.({
      correlationId: this.readRunCorrelationId(),
      key: RUN_STATE_KEY,
      byteLength: 0,
      error,
    });
  }

  /**
   * Resolves a reward and starts the stage that follows it, as ONE
   * transaction.
   *
   * THE SECOND HALF OF A STAGE TRANSITION. `endStage()` resolved the stage that
   * cleared; between that and the next stage the reward screen stands. This
   * closes it: the selection is validated and taken on, `resolveReward()`
   * advances the index and derives the next goal, and then the engine begins
   * the stage the advance moved to. Nothing else starts that stage, which is
   * why a run that only advanced its index never dispatched `onStageStart`
   * again.
   *
   * THE RELIC IS PERSISTED BY `resolveReward()` ITSELF, so the pickup and the
   * stage it was won in reach storage together whether or not a stage start
   * follows. Where one does, the commit `startStage()` ends with writes the
   * same envelope again from the board that stage opened on.
   *
   * A REFUSED SELECTION STARTS NOTHING AND ADVANCES NOTHING. `resolveReward()`
   * leaves the index, the goal and the offer exactly as they were, so this
   * returns the refusal and the run is still standing on the same stage with
   * the same three cards owed a choice. DL-RUNCTL-16.
   *
   * @param engine The engine to begin the next stage on.
   * @param relicId Identifier of the chosen relic.
   * @returns Whether the relic joined the held list, and why it did not.
   */
  completeReward(engine: RunEnginePort, relicId: string): RewardResolution {
    const resolution = this.resolveReward(relicId);

    // A REFUSED SELECTION STARTS NOTHING. `resolveReward()` leaves the offer
    // standing for a refusal — an identifier that was never offered, one the
    // catalogue does not know, one already held, one the registry would not seat —
    // so the run is still owed a choice and the stage it is on is still the stage
    // it was on. Starting a stage here regardless advanced past the very offer the
    // player still has to answer: the screen came back up over a board that had
    // already moved on. DL-RUNCTL-16.
    if (!resolution.accepted) {
      return resolution;
    }

    // ONE START PER STAGE. Where nothing gated the transition the commit that
    // resolved the stage has already opened the stage that follows, and
    // starting it again dispatched `onStageStart` twice for one stage — which
    // applied every per-stage relic effect twice. The engine's own
    // `stage:start` records which stage is open, and a stage already open is
    // not reopened.
    //
    // The port declares `startStage` optional, so an engine that does not
    // implement stage transitions leaves the index advanced and begins nothing
    // — which is what a double that only observes does.
    if (this.startedStageIndex !== this.current.stageIndex) {
      engine.startStage?.();
    }

    return resolution;
  }

  // NO `activateRelic` MEMBER, AND DELIBERATELY SO. Every relic in this
  // catalogue is automatic: it fires on the hooks it binds when its own trigger
  // condition holds and asks src/engine/hook-bus.ts for its charge on that one
  // path. There is therefore no effect a player can request out of turn, and a
  // method that deducted a charge on request took a budget away and applied
  // nothing — a charge spent with no effect, which is worse for a run than no
  // control at all. The tray control in src/main.ts reads a slot out instead and
  // spends nothing. `RelicRegistry.activate` remains the registry's own
  // published member and is reached only by a caller that has an effect to pair
  // with it. DL-RUNCTL-18.

  /**
   * Reports a refused selection and leaves the run untouched.
   *
   * Reported through the one writer, so the refusal travels in `refusal` and
   * `accepted: false` rather than being appended to the identifier: this path
   * previously reported `selectedRelicId` as `` `${relicId} (${outcome})` ``,
   * which is not an identifier any consumer could match. A non-string
   * identifier — the `'not-offered'` case admits one — is reported as the empty
   * string rather than coerced, so the field is always a string.
   * DL-RUNCTL-07.
   *
   * @param relicId Identifier that was refused.
   * @param outcome Why it was refused. `'accepted'` is excluded, because an
   *   accepted selection is not a refusal and does not travel this path.
   * @returns The refusal.
   */
  private refuseSelection(
    relicId: string,
    outcome: Exclude<RewardSelectionOutcome, 'accepted'>,
  ): RewardSelection {
    this.reportReward(
      this.rewardStageIndex(),
      typeof relicId === 'string' ? relicId : '',
      false,
      outcome,
    );

    return Object.freeze({
      outcome,
      relicId,
      stageIndex: this.current.stageIndex,
    });
  }

  /**
   * Identifiers of the relics held, from the registry where it reports them
   * and from the envelope otherwise.
   *
   * @returns The identifiers, in pickup order.
   */
  private ownedIds(): readonly string[] {
    const owned = this.registry?.ownedRelicIds;

    if (owned !== undefined) {
      try {
        const ids = owned();

        if (Array.isArray(ids)) {
          return ids;
        }
      } catch (error) {
        this.reporter.onWriteFailed?.({
          correlationId: this.readRunCorrelationId(),
          key: RUN_STATE_KEY,
          byteLength: 0,
          error,
        });
      }
    }

    return this.current.relics.map((relic): string => relic.id);
  }

  /**
   * Starts a FRESH run and opens the engine's board on it.
   *
   * The substreams are NOT rebuilt here: they are constructed from `seed` and
   * `cursors` by the composition root, which owns them. A caller starting a
   * second run in one page load rebuilds them from the values this call
   * leaves.
   *
   * @param engine The engine to open. Its `setup` is what emits the first
   *   commit, and that commit is what persists the fresh envelope.
   * @param options Seed origin and the board to open on.
   * @returns The seed the run is played under.
   */
  startRun(engine: EnginePort, options: StartRunOptions = {}): string {
    const seed =
      options.seed === undefined
        ? originateRunSeed()
        : normalizeEnteredSeed(options.seed);

    this.store.clear();

    this.current = createFreshRunState({
      runId: this.createToken(),
      seed,
      rngCursor: {},
      stageIndex: FIRST_STAGE_INDEX,
      stageGoal: this.goalForStage(FIRST_STAGE_INDEX),
      board: emptyBoardSnapshot(this.config.boardSize),
    });

    this.offeredRelicIds = [];
    this.offer = NO_OFFER;
    this.offerStageIndex = NO_OFFER_STAGE;
    this.stageCleared = false;
    this.ended = false;

    // A started run has resolved no reward round and has had no stage opened
    // yet: the `setup` this call drives is what opens its first one.
    this.resolvedRelicId = null;
    this.resolvedStageIndex = NO_OFFER_STAGE;
    this.startedStageIndex = NO_STARTED_STAGE;

    // The board this run opens on, which `board` and `openingBoard` both
    // report so a caller that composed the engine separately opens the same
    // board this call does.
    this.adoptedBoard = options.board ?? null;
    this.openingSnapshot = options.board ?? null;

    // A started run discards whatever was stored, so there is no envelope left
    // to have been read and no legacy board to fall back to.
    this.storedEnvelopeRead = true;

    this.restoreRelics();

    // BEFORE THE FIRST REPORT OF THE NEW RUN, and before the board opens, NOT
    // AFTER. The substreams and the correlation scope are rebuilt against the
    // new seed here, so the opening spawns come from the new sequence rather
    // than from wherever the previous run's substreams had reached, AND every
    // report below — this controller's own included — is attributed to the
    // run that emitted it rather than to the ended run.
    this.publishRunScope(options.seed !== undefined);

    this.reporter.onRunStarted?.({
      correlationId: this.readRunCorrelationId(),
      runId: this.current.runId,
      stageIndex: this.current.stageIndex,
      resumed: false,
      seedProvided: options.seed !== undefined,
    });

    this.openEngineBoard(engine);

    return seed;
  }

  /**
   * Resumes the stored run and opens the engine's board on it.
   *
   * The board handed to `setup` is the one `RunStateStore.load` returned,
   * which is ALREADY RECONCILED against the configured board size: a snapshot
   * saved at another edge length has been resolved by the store, and no grid
   * is ever built here from a raw persisted value.
   *
   * Falls back to a fresh run when nothing readable is stored, so the caller
   * needs no branch of its own.
   *
   * @param engine The engine to open.
   * @returns The load outcome, and `'absent'` when a fresh run was started.
   */
  resumeRun(engine: EnginePort): RunStateLoadOutcome {
    const outcome = this.begin();

    // THE ADOPTION RESULT, NOT `store.exists()`. A key that is present but
    // unreadable makes `exists()` report success, and the run then opened on
    // the envelope's own empty board — which suppressed the start tiles,
    // because a supplied snapshot tells the engine the board was restored.
    // `openEngineBoard()` is the one board-load authority: it reads the
    // adoption result and tells an envelope that was read and refused apart
    // from no envelope at all, the last of which falls back to the engine's own
    // port read of the legacy snapshot.
    this.openEngineBoard(engine);

    return outcome;
  }

  /**
   * Writes the envelope in force.
   *
   * THE ONE WRITE PATH. Cursors are snapshotted and the board is refreshed from
   * `serialize()` immediately before the write, so the counts and the board
   * stored describe the same moment — a snapshot taken at any other point can
   * differ from the board being stored by a draw. Decision DL-RUNCTL-02.
   *
   * NEVER THROWS OUT OF THE COMMIT PATH. `RunStateStore.save()` reports its
   * own failure through `onWriteFailed` — it alone knows the key and the
   * serialised size — and returns `false`; this method surfaces that `false`
   * to its caller rather than discarding it or raising.
   * js/local_storage_manager.js L37's `catch (error) { return false; }`
   * swallowed the error object; nothing here does.
   *
   * @param engine Read for the board snapshot to wrap.
   * @param cursors Reads the substreams' current draw counts.
   * @returns Whether the envelope reached storage.
   */
  persist(engine: RunEnginePort, cursors: () => RngCursorMap): boolean {
    this.refresh(engine, cursors);

    return this.write();
  }

  /**
   * The run IN FORCE, as data. Includes the seed, for a screen to display.
   *
   * NOT THE FINISHED RUN. `finish()` replaces the run in force with a fresh
   * one, so after a run ends this describes the replacement — stage 0, no
   * relics, a new seed. A caller showing the run that ENDED reads `endRun()`'s
   * own return value, or `lastSummary()`. Decision DL-RUNCTL-13.
   *
   * @returns The run in force.
   */
  summary(): RunSummary {
    return summarizeRunState(this.current);
  }

  /**
   * The last finished run, or `null` when none has finished in this page load.
   */
  lastSummary(): RunSummary | null {
    return this.finished;
  }

  /**
   * Ends the run in force explicitly, as a run-summary screen's end-run action
   * does, and clears the stored envelope.
   *
   * Idempotent: ending a run that has already ended reports nothing further
   * and returns the same summary.
   *
   * @param outcome How the run ended.
   * @returns The finished run, including its seed.
   */
  endRun(outcome: RunOutcome): RunSummary {
    if (this.ended) {
      return this.finished ?? this.summary();
    }

    return this.finish(outcome);
  }

  /** Removes the stored envelope and nothing else. */
  clear(): boolean {
    return this.store.clear();
  }

  /**
   * Handles one commit: records the state that was committed, then decides
   * whether the run or the stage resolved.
   */
  private onCommit(
    engine: RunEnginePort,
    event: StateCommitEvent,
    cursors: () => RngCursorMap,
  ): void {
    this.refresh(engine, cursors);

    if (event.over) {
      // The engine clears `gameState` on a loss, exactly as js/game_manager.js
      // L84-L86 did.
      this.finish('lost');

      return;
    }

    // THE RESULT IS CONSUMED, not discarded: `write()` resolves the run's
    // persistence status from it and reports a change once per transition, and
    // `persistenceStatus()` is what src/main.ts projects into the HUD. A
    // refused write does not abandon the turn — the board is played from memory
    // whether or not it was stored — so an exhausted quota degrades the run
    // instead of ending it, and the stage below still pays out. DL-RUNCTL-20.
    this.write();

    if (!this.stageCleared || this.resolvingStage) {
      return;
    }

    // THE TERMINAL WIN OUTRANKS THE STAGE PAYOUT. `terminated` with `won` set
    // is the unresolved 2048 win of js/game_manager.js L30-L32: play is
    // blocked until the player takes Keep Going or ends the run. The payout is
    // DEFERRED, not discarded — `stageCleared` stands, so the commit a
    // continued win produces resolves it. Decision DL-RUNCTL-12.
    if (event.won && event.terminated) {
      return;
    }

    // A standing offer means this stage has already been resolved and is
    // waiting on the player. The goal is still met on every later commit, so
    // without this the resolution would be attempted again on every move of the
    // wait.
    if (this.isRewardPending()) {
      return;
    }

    // `endStage` emits `stage:end` — where the advance happens — and then
    // commits, so this handler is re-entered before the call returns.
    this.resolvingStage = true;

    try {
      engine.endStage(true);

      // THE REWARD GATES THE NEXT STAGE. Where a draw port was injected the
      // cleared stage draws an offer and stops there: `selectReward()` is what
      // advances the run and opens the next board, so the player chooses a
      // relic between stages rather than being carried past the choice. Where
      // none was injected — a run played without the relic system, and every
      // unit case that composes the controller alone — the stage advances at
      // once, which is the behaviour that keeps the game playable either way.
      if (this.rewards !== undefined) {
        this.offerReward();

        if (this.isRewardPending()) {
          // REFRESHED AGAIN BEFORE THE PENDING ROUND IS WRITTEN. The draw ran
          // AFTER the refresh at the top of this handler, so the counts carried
          // by the envelope at this point are the pre-draw ones: writing them
          // stored a round whose cards had already been drawn beside cursors
          // that said they had not, and a reload of that envelope rebuilt the
          // substreams behind their real position and spent the same draws a
          // second time. The refresh puts the counts, the board and the relics
          // back on one moment — the moment being written — which is the one
          // write path's own rule. DL-RUNCTL-02, DL-RUNCTL-19.
          this.refresh(engine, cursors);
          this.write();

          return;
        }
      }

      this.openNextStage(engine);
    } finally {
      this.resolvingStage = false;
    }
  }

  /**
   * Opens the stage the run has just advanced to.
   *
   * THE OTHER HALF OF A STAGE TRANSITION. `endStage()` resolves the stage
   * that ended and the engine then refuses to end it again, so without this
   * call the run would sit on a stage index it never opened a board for and
   * no further stage could ever be reached. Called after `endStage()` has
   * RETURNED rather than from inside the `stage:end` emission: `endStage()`
   * releases the adopted stage goal and commits after that emission.
   *
   * The board is CARRIED, not reset: a stage transition is not a restart, so
   * the snapshot the engine holds is handed straight back to it and the tiles
   * in play survive into the new stage.
   *
   * IDEMPOTENT PER STAGE. A stage the engine has already reported starting is
   * not reopened, so a caller that reaches this after the commit path has
   * already opened the stage — or after `completeReward()` has — cannot
   * dispatch `onStageStart` a second time for one stage and double-apply every
   * per-stage relic effect.
   *
   * @param engine The engine to open the stage on.
   * @returns Whether a stage was opened.
   */
  private openNextStage(engine: RunEnginePort): boolean {
    const start = engine.startStage;

    if (start === undefined) {
      return false;
    }

    if (this.startedStageIndex === this.current.stageIndex) {
      return false;
    }

    try {
      start.call(engine, engine.serialize());

      return true;
    } catch (error) {
      this.reporter.onWriteFailed?.({
        correlationId: this.readRunCorrelationId(),
        key: RUN_STATE_KEY,
        byteLength: 0,
        error,
      });

      return false;
    }
  }

  /**
   * Brings the envelope up to date with the moment being committed: the
   * substreams' draw counts, the engine's board snapshot, and the relics as
   * the registry holds them.
   *
   * All three are read TOGETHER, immediately before a write, so the counts,
   * the board and the charges stored describe one moment.
   */
  private refresh(engine: RunEnginePort, cursors: () => RngCursorMap): void {
    this.current = {
      ...this.current,
      rngCursor: this.readCursors(cursors),
      board: engine.serialize(),
      relics: this.projectRelics(),
    };
  }

  /**
   * Writes the envelope and resolves the run's persistence status from the
   * outcome.
   *
   * ONE ATTEMPT, ONE AUTHORITATIVE FAILURE RECORD. `RunStateStore.save` never
   * throws: it reports the refusal through `onWriteFailed` — it alone holds the
   * key, the serialised size and the error — and returns `false`. This method
   * therefore emits NO second `onWriteFailed` of its own; it did, so one
   * exhausted quota produced a record from the storage adapter, a record from
   * the store and a third from here, three descriptions of one event.
   *
   * What this method adds instead is the PLAYER-FACING consequence: the run is
   * no longer being saved, reported once per transition through
   * `onPersistenceStatusChanged` rather than once per refused write.
   *
   * @returns Whether the envelope reached storage.
   */
  private write(): boolean {
    if (this.store.save(this.current)) {
      this.markPersistence('persistent');

      return true;
    }

    this.markPersistence('ephemeral');

    return false;
  }

  /**
   * Records the run's persistence status and reports a CHANGE of it.
   *
   * @param status The status the last write established.
   */
  private markPersistence(status: RunPersistence): void {
    if (status === 'ephemeral') {
      this.refusedWrites += 1;
    }

    if (status === this.persistence) {
      return;
    }

    const previous = this.persistence;

    this.persistence = status;

    if (status === 'persistent') {
      this.refusedWrites = 0;
    }

    this.reporter.onPersistenceStatusChanged?.({
      correlationId: this.readRunCorrelationId(),
      status,
      previous,
      refusedWrites: this.refusedWrites,
    });
  }

  /**
   * Whether the run in force is reaching storage, as the last write left it.
   *
   * A caller projecting the status into the interface reads this rather than
   * inferring it from a report it may have been composed too late to receive.
   *
   * @returns The status now in force.
   */
  persistenceStatus(): RunPersistence {
    return this.persistence;
  }

  /** The substreams' draw counts, with every named substream present. */
  private readCursors(cursors: () => RngCursorMap): RngCursorMap {
    let read: RngCursorMap;

    try {
      read = cursors();
    } catch (error) {
      this.reporter.onWriteFailed?.({
        correlationId: this.readRunCorrelationId(),
        key: RUN_STATE_KEY,
        byteLength: 0,
        error,
      });

      return normalizeRngCursor(this.current.rngCursor);
    }

    const normalized = normalizeRngCursor(read);
    const carried = normalizeRngCursor(this.current.rngCursor);
    const complete: Record<string, number> = {};

    for (const name of RNG_STREAM_NAMES) {
      complete[name] = Math.max(normalized[name], carried[name]);
    }

    return complete as RngCursorMap;
  }

  /**
   * The relics to persist: the registry's projection when one is attached, and
   * the relics already held otherwise.
   */
  private projectRelics(): readonly PersistedRelic[] {
    const registry = this.registry;

    const project = registry?.serialize ?? registry?.snapshotRelics;

    if (project === undefined) {
      return this.current.relics;
    }

    try {
      // Called through its owner, never through a member read off it into a
      // local and then invoked bare.
      const projected = project.call(registry);

      return Array.isArray(projected) ? projected : this.current.relics;
    } catch (error) {
      this.reporter.onWriteFailed?.({
        correlationId: this.readRunCorrelationId(),
        key: RUN_STATE_KEY,
        byteLength: 0,
        error,
      });

      return this.current.relics;
    }
  }

  /**
   * Admits one offer, or refuses it whole.
   *
   * An offer is admitted only as the seeded draw produces one: an array of at
   * most `MAX_REWARD_OFFERS` entries, each a non-empty string, no identifier
   * repeated, and every identifier one the registry's catalogue carries. One
   * unusable entry refuses the whole offer rather than a subset of it, because
   * a subset would admit selections from a set the player was never shown.
   *
   * TOTAL. The walk is contained, so a list that raises while it is read — a
   * hostile iterator, a raising element — refuses the offer rather than
   * raising out of `recordRewardOffer()`, and the refusal is reported like any
   * other.
   *
   * @param relicIds Identifiers offered.
   * @returns A fresh copy of the offer, or `null` where it was refused.
   */
  private admitOffer(relicIds: readonly string[]): readonly string[] | null {
    try {
      return this.readOffer(relicIds);
    } catch {
      return null;
    }
  }

  /**
   * Reads one offer under the admission rule `admitOffer` contains.
   *
   * @param relicIds Identifiers offered.
   * @returns A fresh copy of the offer, or `null` where it was refused.
   */
  private readOffer(relicIds: readonly string[]): readonly string[] | null {
    if (!Array.isArray(relicIds) || relicIds.length > MAX_REWARD_OFFERS) {
      return null;
    }

    const admitted: string[] = [];

    for (const relicId of relicIds) {
      if (
        typeof relicId !== 'string' ||
        relicId.length === 0 ||
        admitted.includes(relicId) ||
        !this.catalogueCarries(relicId)
      ) {
        return null;
      }

      admitted.push(relicId);
    }

    return admitted;
  }

  /**
   * Appends one validated entry to the held list, or refuses it.
   *
   * APPENDED, NEVER INSERTED OR SORTED. Array order is pickup order and the
   * hook bus dispatches in that order, so a relic joins at the END of the held
   * list and every relic already held keeps its position. `charges` and `state`
   * are carried exactly as the registry supplied them, and `state` is never
   * inspected or reshaped.
   *
   * The two ceilings are re-measured here rather than trusted from the caller,
   * because `selectReward()` reaches this by its own path: an envelope carrying
   * more than `MAX_PERSISTED_RELICS` is refused by the store, so accepting one
   * would lose the whole run's progress on the next write.
   *
   * @param relicId Identifier being taken on.
   * @param entry The entry the registry produced, where there is one.
   *   Without one the entry is resolved from the registry, which is what a
   *   caller holding only an identifier reaches.
   * @returns Whether the relic joined the held list.
   */
  private appendRelic(relicId: string, entry?: PersistedRelic): boolean {
    if (typeof relicId !== 'string' || relicId.length === 0) {
      return false;
    }

    const held = this.current.relics;

    if (held.length >= MAX_PERSISTED_RELICS) {
      return false;
    }

    if (held.some((relic: PersistedRelic) => relic.id === relicId)) {
      return false;
    }

    this.current = {
      ...this.current,
      relics: [...held, entry ?? this.resolveRelicEntry(relicId)],
    };

    return true;
  }

  /**
   * Reports one reward outcome, accepted or refused.
   *
   * THE ONE WRITER OF `onRewardDrawn`. Both public selection methods and the
   * offer recorder reach the sink through here, so an accepted outcome and a
   * refused one cannot carry differently-shaped payloads: `accepted` is always
   * present, `refusal` is present exactly when something was refused, and
   * `selectedRelicId` carries the identifier VERBATIM. `selectReward()` and
   * `refuseSelection()` previously assembled payloads of their own, which
   * omitted `accepted` and encoded the outcome into the identifier.
   *
   * @param relicId Identifier chosen, absent where the OFFER itself was
   *   refused.
   * @param accepted Whether the relic joined the held list.
   * @param refusal Why it did not, and `null` where it did.
   * @param offeredRelicIds The offer being reported against. Defaults to the
   *   offer standing, which is what every caller reporting before the round
   *   closes wants; a caller reporting afterwards passes the list it preserved.
   */
  private reportReward(
    stageIndex: number,
    relicId: string | undefined,
    accepted: boolean,
    refusal: RewardReportRefusal | null,
    offeredRelicIds?: readonly string[],
  ): void {
    const report: {
      correlationId: CorrelationId;
      stageIndex: number;
      offeredRelicIds: readonly string[];
      selectedRelicId?: string;
      accepted: boolean;
      refusal?: RewardReportRefusal;
    } = {
      correlationId: this.readRunCorrelationId(),
      stageIndex,
      offeredRelicIds: offeredRelicIds ?? this.offeredRelicIds,
      accepted,
    };

    if (relicId !== undefined) {
      report.selectedRelicId = relicId;
    }

    if (refusal !== null) {
      report.refusal = refusal;
    }

    this.reporter.onRewardDrawn?.(report);
  }

  /**
   * The stage index a reward outcome is attributed to.
   *
   * The stage the standing offer was drawn at where one was drawn, and the
   * stage in force otherwise — which is the case for an offer recorded through
   * `recordRewardOffer()`, whose round is not attributed to a draw, and for a
   * selection made with no offer standing at all.
   *
   * @returns The stage index to report.
   */
  private rewardStageIndex(): number {
    if (this.offerStageIndex !== NO_OFFER_STAGE) {
      return this.offerStageIndex;
    }

    if (this.resolvedStageIndex !== NO_OFFER_STAGE) {
      return this.resolvedStageIndex;
    }

    return this.current.stageIndex;
  }

  /**
   * Whether the registry's catalogue carries one identifier.
   *
   * A registry that cannot be asked — one attached without `knowsRelic`, or
   * none at all — admits the identifier on its shape alone, which is what
   * keeps this controller usable without src/relics. A registry whose accessor
   * throws refuses it, because an unanswerable membership question is not a
   * yes.
   *
   * @param relicId Identifier to test.
   * @returns Whether the identifier may be offered and chosen.
   */
  private catalogueCarries(relicId: string): boolean {
    const registry = this.registry;

    // Either spelling, one reader. `knowsRelic` is the run port's name for
    // this and `knows` is the registry's own; a controller composed with
    // either is asked, and only one composed with neither admits on shape
    // alone.
    const knows = registry?.knowsRelic ?? registry?.knows;

    if (knows === undefined) {
      return true;
    }

    try {
      // Called through its owner; see `projectRelics`.
      return (
        (registry?.knowsRelic === undefined
          ? registry?.knows?.(relicId)
          : registry.knowsRelic(relicId)) === true
      );
    } catch (error) {
      this.reportRegistryFault(error);

      return false;
    }
  }

  /**
   * Takes one relic on live and yields the entry to persist for it.
   *
   * The identifier the caller chose always wins over the one the registry
   * reported, so a registry cannot substitute a different relic.
   *
   * @param relicId Identifier chosen.
   * @returns The entry to append, or `null` where the registry refused.
   */
  private takeRelicOn(relicId: string): PersistedRelic | null {
    const registry = this.registry;

    const takeAndRead = registry?.pickUpRelic ?? registry?.activateRelic;

    if (takeAndRead !== undefined) {
      try {
        // Called through its owner; see `projectRelics`.
        const accepted = takeAndRead(relicId);

        if (accepted === null || typeof accepted !== 'object') {
          return null;
        }

        // The identifier the caller chose always wins over the one the
        // registry reported, so a registry cannot substitute a different
        // relic.
        return { ...accepted, id: relicId };
      } catch (error) {
        this.reportRegistryFault(error);

        return null;
      }
    }

    if (registry?.pickUp !== undefined) {
      try {
        // A falsy return is a pickup the registry refused, and nothing is
        // appended for one.
        if (registry.pickUp(relicId) === undefined) {
          return null;
        }
      } catch (error) {
        this.reportRegistryFault(error);

        return null;
      }
    }

    return this.resolveRelicEntry(relicId);
  }

  /**
   * Whether the live registry reports holding one relic.
   *
   * A registry that cannot be asked is taken at the word of the pickup it
   * already accepted; one whose accessor throws is not.
   *
   * @param relicId Identifier to confirm.
   * @returns Whether the live registry and the envelope agree.
   */
  private registryHolds(relicId: string): boolean {
    const holds = this.registry?.holdsRelic;

    if (holds === undefined) {
      return true;
    }

    try {
      return holds(relicId) === true;
    } catch (error) {
      this.reportRegistryFault(error);

      return false;
    }
  }

  /**
   * The entry to persist for one identifier a registry could not take on live.
   *
   * @param relicId Identifier chosen.
   * @returns The entry to append.
   */
  private resolveRelicEntry(relicId: string): PersistedRelic {
    const registry = this.registry;

    // Either spelling: `persistedEntry` is the registry's own member name and
    // `resolveRelic` the name this port first declared it under, and a
    // registry supplying either is read through it.
    const resolve = registry?.persistedEntry ?? registry?.resolveRelic;

    if (resolve === undefined) {
      return { id: relicId };
    }

    try {
      // Called through its owner; see `projectRelics`.
      const resolved = resolve.call(registry, relicId);

      if (resolved === null || typeof resolved !== 'object') {
        return { id: relicId };
      }

      // The identifier the caller chose wins over the one the registry
      // reported, so a registry cannot substitute a different relic.
      return { ...resolved, id: relicId };
    } catch (error) {
      this.reportRegistryFault(error);

      return { id: relicId };
    }
  }

  /**
   * The board edge length the STORED relic entries imply, read before the
   * envelope is loaded.
   *
   * @returns The implied edge length, or `undefined`.
   */
  private readRelicBoardSize(): number | undefined {
    const registry = this.registry;

    if (registry?.relicBoardSize === undefined) {
      return undefined;
    }

    try {
      const stored = this.store.peekRelics();

      // Called through its owner; see `projectRelics`.
      return Array.isArray(stored)
        ? registry.relicBoardSize(stored)
        : undefined;
    } catch (error) {
      this.reporter.onWriteFailed?.({
        correlationId: this.readRunCorrelationId(),
        key: RUN_STATE_KEY,
        byteLength: 0,
        error,
      });

      return undefined;
    }
  }

  /**
   * Puts the adopted envelope's unresolved reward round back in force.
   *
   * PROJECTED, NEVER REDRAWN. `RewardDrawPort.project` resolves the stored
   * identifiers against the relic catalogue and takes no draw, so the resumed run
   * presents the same offer it was interrupted on and every substream cursor
   * stays exactly where the envelope left it. Redrawing would produce a different
   * offer from advanced cursors and break the same-seed-same-offers guarantee of
   * AAP V2.
   *
   * FIVE REASONS TO RESTORE NOTHING, each leaving the run to resolve its stage as
   * if the offer had never been drawn: no round was stored; the run has ended; no
   * projector was supplied; the round names a stage the envelope has since moved
   * past — a stale marker, which is dropped rather than trusted; or the projection
   * yielded nothing usable. The envelope is brought into line in each case, so a
   * round that could not be restored does not sit in storage suppressing stage
   * resolution for the rest of the run.
   *
   * NEVER THROWS. A projector that raises is reported and treated as one that
   * yielded nothing.
   */
  private restorePendingReward(): void {
    const stored = this.current.pendingReward;

    if (stored === undefined) {
      return;
    }

    if (this.ended || stored.stageIndex !== this.current.stageIndex) {
      this.clearPersistedReward();

      return;
    }

    const project = this.rewards?.project;

    if (project === undefined) {
      this.clearPersistedReward();

      return;
    }

    let projected: readonly RewardOffer[];

    try {
      // Called through its owner; see `projectRelics()`.
      projected = project.call(this.rewards, stored.offeredRelicIds);
    } catch (error) {
      this.reportRegistryFault(error);
      this.clearPersistedReward();

      return;
    }

    if (!Array.isArray(projected) || projected.length === 0) {
      this.clearPersistedReward();

      return;
    }

    // Through the SAME admission gate a live draw passes, so a stored round can
    // no more name a relic outside the catalogue, a duplicate, or a relic the run
    // already holds than a drawn one can.
    const admitted = this.admitOffer(
      projected.map((relic): string => relic.id),
    );

    if (admitted === null) {
      this.clearPersistedReward();

      return;
    }

    // `admitOffer` admits the list as a whole or not at all, so reaching here
    // means every projected offer is one a live draw could have made.
    this.offer = Object.freeze(
      projected.map((relic) => Object.freeze({ ...relic })),
    );
    this.offeredRelicIds = Object.freeze([...admitted]);
    this.offerStageIndex = stored.stageIndex;

    // A RESTORED ROUND IS AN OPEN ROUND: nothing has been resolved against it,
    // so a selection made now reports against this round rather than against
    // whatever the instance last resolved.
    this.resolvedRelicId = null;

    // Re-recorded from what was actually admitted, so the envelope and the live
    // offer cannot disagree about which three cards are standing.
    this.current = {
      ...this.current,
      pendingReward: {
        stageIndex: stored.stageIndex,
        offeredRelicIds: [...this.offeredRelicIds],
      },
    };

    this.reporter.onRewardOffered?.({
      correlationId: this.readRunCorrelationId(),
      stageIndex: this.offerStageIndex,
      offeredRelicIds: this.offeredRelicIds,
    });
  }

  /**
   * Hands the relics a loaded envelope carried back to the registry, in pickup
   * order, with `state` exactly as it was persisted, and ADOPTS what the
   * registry made of them.
   *
   * VALIDATED HYDRATION. The registry resolves every identifier against the
   * authoritative catalogue, so an identifier the catalogue does not know, a
   * duplicate, and a malformed entry are all refused there — and a refused
   * entry can never fire, because there is no handler to bind. Reading the
   * result back is what keeps the envelope honest about that: without it the
   * run would go on reporting a relic that is not held, the HUD would draw a
   * tray entry for it, and the reward draw would keep excluding an identifier
   * that is doing nothing.
   *
   * The read-back is `snapshotRelics`, which is the registry's own projection,
   * so pickup order, the charge budget in force and every nested state slot
   * come from the registry rather than from the envelope that was loaded. The
   * next write persists the normalised set.
   */
  private restoreRelics(): void {
    const registry = this.registry;

    if (registry?.restoreRelics === undefined) {
      return;
    }

    const requested = this.current.relics;

    try {
      // Called through the port object, so a class-based registry keeps its
      // receiver.
      registry.restoreRelics(this.current.relics);
    } catch (error) {
      this.reporter.onWriteFailed?.({
        correlationId: this.readRunCorrelationId(),
        key: RUN_STATE_KEY,
        byteLength: 0,
        error,
      });

      return;
    }

    const snapshot = registry?.serialize ?? registry?.snapshotRelics;

    if (snapshot === undefined) {
      return;
    }

    let restored: readonly PersistedRelic[];

    try {
      restored = snapshot.call(registry);
    } catch (error) {
      this.reporter.onWriteFailed?.({
        correlationId: this.readRunCorrelationId(),
        key: RUN_STATE_KEY,
        byteLength: 0,
        error,
      });

      return;
    }

    // Adopted only when the registry actually made something different of
    // them, so a clean load neither rewrites the envelope nor reports a
    // refusal.
    if (!relicsDiffer(requested, restored)) {
      return;
    }

    this.current = Object.freeze({
      ...this.current,
      relics: Object.freeze(restored.map(cloneRelicEntry)),
    });

    this.reporter.onRelicsNormalized?.({
      correlationId: this.readRunCorrelationId(),
      requested: requested.length,
      restored: restored.length,
      refused: Object.freeze(
        requested
          .map((relic): string => relic.id)
          .filter(
            (id) => !restored.some((entry): boolean => entry.id === id),
          ),
      ),
    });
  }

  /**
   * Summarises the run, reports it, clears the stored envelope and replaces
   * the envelope in force with a fresh one.
   */
  private finish(outcome: RunOutcome): RunSummary {
    const summary = this.summary();

    this.finished = summary;
    this.ended = true;
    this.stageCleared = false;

    // A finished run holds no pending reward: the offer it was showing belonged
    // to the run that has just ended, as did any round it resolved and any
    // stage it had open.
    this.offer = NO_OFFER;
    this.offerStageIndex = NO_OFFER_STAGE;
    this.offeredRelicIds = [];
    this.resolvedRelicId = null;
    this.resolvedStageIndex = NO_OFFER_STAGE;
    this.startedStageIndex = NO_STARTED_STAGE;

    this.reporter.onRunEnded?.({
      correlationId: this.readRunCorrelationId(),
      outcome,
      summary: redactRunSummary(summary),
    });

    this.store.clear();
    this.current = this.freshState(this.createToken());

    return summary;
  }

  /** Measures the stage's progress and records whether its goal is met. */
  private measure(highestTileValue: number, score: number): void {
    if (!Number.isFinite(score) || !Number.isFinite(highestTileValue)) {
      return;
    }

    const progress = evaluateStageGoal(this.current.stageGoal, {
      score,
      highestTileValue,
    });

    this.current = { ...this.current, goalProgress: progress.progress };
    this.stageCleared = progress.cleared;
  }

  /**
   * Measures from a board snapshot, for the paths that carry no live board.
   */
  private measureSnapshot(state: SerializedGameState): void {
    this.measure(highestInSnapshot(state), state.score);
  }

  /** The goal of one stage, freshly derived from the progression curve. */
  private goalForStage(stageIndex: number): StageGoal {
    return stageGoalForIndex(stageIndex, this.stages);
  }

  /**
   * Assembles a fresh envelope: stage 0, its goal, no progress, no relics and
   * an empty board of the configured size.
   *
   * The empty board stands for exactly one moment — the first commit replaces
   * it with the engine's own snapshot — and it is a truthful value rather
   * than a stand-in: a run that has not started holds no tiles.
   */
  private freshState(runId: string): RunState {
    return createFreshRunState({
      runId,
      seed: this.identity.seed,
      rngCursor: {},
      stageIndex: FIRST_STAGE_INDEX,
      stageGoal: this.goalForStage(FIRST_STAGE_INDEX),
      board: emptyBoardSnapshot(this.config.boardSize),
    });
  }
}

// The commit path measures no serialised size and mints no error of its own:
// src/run/run-state-store.ts holds the key, the byte length and the error of a
// refused write and reports them once, and this module reports the run's
// persistence STATUS instead.

/** The value of a board with no tiles, as `StageProgressInput` defines it. */
const NO_TILES = 0;

/** The minimum a board must expose to be measured: the x-major cell matrix. */
interface WalkableBoard {
  readonly cells: readonly (readonly ({ readonly value: number } | null)[])[];
}

/** The highest tile value on a board, and 0 for a board holding none. */
function highestOnBoard(board: WalkableBoard): number {
  let highest = NO_TILES;

  for (const column of board.cells) {
    for (const tile of column) {
      if (
        tile !== null &&
        Number.isFinite(tile.value) &&
        tile.value > highest
      ) {
        highest = tile.value;
      }
    }
  }

  return highest;
}

/** The highest tile value in a board snapshot, and 0 for one holding none. */
function highestInSnapshot(state: SerializedGameState): number {
  let highest = NO_TILES;

  const columns = state.grid.cells;

  if (!Array.isArray(columns)) {
    return highest;
  }

  for (const column of columns) {
    if (!Array.isArray(column)) {
      continue;
    }

    for (const cell of column) {
      if (
        cell !== null &&
        typeof cell === 'object' &&
        Number.isFinite(cell.value) &&
        cell.value > highest
      ) {
        highest = cell.value;
      }
    }
  }

  return highest;
}

/**
 * An empty board snapshot of one edge length, in the frozen persisted shape.
 */
function emptyBoardSnapshot(size: number): LegacyBoardSnapshot {
  const cells: (null)[][] = [];

  for (let x = 0; x < size; x += 1) {
    const column: null[] = [];

    for (let y = 0; y < size; y += 1) {
      column.push(null);
    }

    cells.push(column);
  }

  return {
    grid: { size, cells },
    score: 0,
    over: false,
    won: false,
    keepPlaying: false,
  };
}
