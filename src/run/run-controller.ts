/**
 * The run lifecycle: identity resolution, run-state persistence, the stage and
 * relic slices of every commit, stage advancement and the run summary.
 *
 * WHAT THIS MODULE IS FOR
 *   src/run/run-state.ts declares the nine-member envelope and
 *   src/run/run-state-store.ts reads and writes it, but nothing joined either
 *   to a running game: the runtime persisted the legacy board snapshot alone
 *   and handed the engine the neutral stage and relic contexts. This module is
 *   that join. It resolves the run's identity before anything else exists,
 *   adopts a stored envelope where one is readable, supplies the engine's two
 *   context providers from it, and writes it back on every commit.
 *
 * THE TWO STORAGE KEYS STAY SEPARATE
 *   The board keeps living under `gameState`, written and cleared by the engine
 *   exactly as js/game_manager.js wrote and cleared it, and the best score
 *   keeps living under `bestScore` in its frozen format. The envelope WRAPS a
 *   copy of the board snapshot under its own namespaced key; it never becomes
 *   the board's home. So a save written by the pre-migration game still loads,
 *   and a build that never reaches this module still plays.
 *
 * DETERMINISM
 *   `rngCursor` is what makes a resumed run continue its sequence instead of
 *   restarting it, so the cursor map is snapshotted into the envelope on every
 *   commit and read back out at composition. Cursors only ever move forward:
 *   `createRngStreams` fast-forwards past the draws a map records, and nothing
 *   here rewinds one — a restart within a run continues the sequence rather
 *   than replaying it.
 *
 * SEED ORIGINATION LIVES HERE, AND NOTHING ELSE IS UNSEEDED
 *   `originateRunSeed()` mints the value every substream is derived from. It is
 *   the ONE unseeded randomness source in the product: everything downstream of
 *   a seed is seeded, so this function sits outside the determinism guarantee
 *   and nothing inside it does. src/rng/seeded-rng.ts names this module as the
 *   home of that origination. `globalThis.crypto` is read behind a feature
 *   check, and nothing is ever installed onto `Math.random`.
 *
 * NO CLOCK ON THE PLAY PATH, NO DOM
 *   The time source `originateRunSeed()` falls back to is read only while
 *   minting a seed, never while a turn resolves. Nothing in this module reads
 *   the document.
 *
 * THE CORRELATION IDENTIFIER IS INJECTED, NEVER DERIVED
 *   src/engine/types.ts L66-L81 names `deriveCorrelationId` in
 *   src/observability/logger.ts as its one deriver. This module imports no
 *   observability module, so it receives the identifier and republishes it.
 *
 * Provenance — js/game_manager.js lifecycle constructs ported here:
 *   L1-L14 collaborator wiring        -> `RunControllerOptions`, constructor
 *   L17-L21 `restart()`               -> `startRun()` / `resumeRun()`
 *   L24-L32 `keepPlaying`/terminated  -> `RunOutcome` routing in `finish()`
 *   L35-L59 `setup()`                 -> `begin()` and the fresh envelope
 *   L85-L89 save-or-clear branch      -> `persist()` / `finish()`
 *   L95     read-after-write          -> the board refreshed from `serialize()`
 *
 * Decisions behind this file: DL-RUNCTL-01, originating the seed from
 * `globalThis.crypto` with a time-plus-counter fallback; DL-RUNCTL-02,
 * capturing the substream cursors at the persist call rather than at the
 * draw; DL-RUNCTL-03, delegating goal derivation and evaluation to
 * src/config/stage-config.ts instead of evaluating here; and DL-RUNCTL-04,
 * receiving the correlation identifier by injection. Traceability rows:
 * TR-RUNCTL-01 through TR-RUNCTL-06 for the six provenance rows above.
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
  RelicCommitContext,
  RelicCommitContextProvider,
  RelicCommitEntry,
  SerializedGameState,
  StageCommitContext,
  StageCommitContextProvider,
} from '../engine/types';
import {
  isAcceptableRunSeed,
  MAX_RUN_SEED_LENGTH,
  RNG_STREAM_NAMES,
  type RngCursorMap,
} from '../rng/rng-streams';
import { RUN_STATE_KEY } from '../storage/storage-keys';
import {
  classifyRunStateVersion,
  createFreshRunState,
  MAX_PERSISTED_RELICS,
  NOOP_RUN_REPORTER,
  normalizeRngCursor,
  redactRunSummary,
  summarizeRunState,
  type LegacyBoardSnapshot,
  type PersistedRelic,
  type RunOutcome,
  type RunReporter,
  type RunState,
  type RunSummary,
} from './run-state';
import {
  migrateRunState,
  type RunStateLoadOutcome,
  type RunStatePersistencePort,
  type RunStateStore,
} from './run-state-store';

/* --------------------------------------------------------------------------
 * Seed origination
 * ----------------------------------------------------------------------- */

/** Bytes drawn for an originated token, rendered as that many hex pairs. */
const SEED_BYTES = 16;

/** Radix the fallback renders its two time components in. */
const SEED_RADIX = 36;

/** Hex width of one byte, so every rendered token has a fixed length. */
const HEX_WIDTH = 2;

/** Microsecond resolution for the fallback's monotonic component. */
const MICROSECONDS_PER_MILLISECOND = 1000;

/**
 * Distinguishes two tokens minted inside one clock tick.
 *
 * Module-scoped and monotonic. It is not randomness and is not a substitute for
 * any: it only guarantees that the fallback cannot return one value twice.
 */
let originationCounter = 0;

/**
 * Mints a fresh run seed.
 *
 * THE ONLY UNSEEDED RANDOMNESS IN THE PRODUCT. Everything downstream of the
 * value returned here is seeded, so this call sits outside the determinism
 * guarantee and every draw taken from the substreams built on it sits
 * inside it.
 *
 * `globalThis.crypto` is a platform global under Node and in the browser, not a
 * DOM interface, and it is read behind a feature check rather than assumed.
 * NOTHING IS INSTALLED ONTO `Math.random`, and `Math.random` is not read.
 *
 * Total: returns a usable seed for every environment, including one carrying
 * neither `crypto` nor `performance`. The result always satisfies
 * `isAcceptableRunSeed()`.
 *
 * REPORTS NOTHING, AND NEVER THROWS. This and the four readers below run before
 * any sink exists — the correlation identifier every report carries is derived
 * from the seed this function returns — so each unusable randomness source is
 * stepped over to the next rather than reported. Decision DL-RUNCTL-01.
 *
 * @returns A seed no previous call returned.
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
 * SEPARATE FROM THE SEED, and never derived from it: two runs replaying one
 * seed carry that seed and two different identifiers, which is what the replay
 * guarantee requires of them.
 *
 * @returns An identifier no previous call returned.
 */
export function originateRunId(): string {
  return originateRunSeed();
}

/**
 * Reduces a seed a player typed to one the substreams accept.
 *
 * Trimmed of surrounding whitespace, bounded to `MAX_RUN_SEED_LENGTH`, and
 * otherwise carried through OPAQUELY: a seed is a string, never a number, so
 * digits are not parsed and unicode is not transliterated. Bounding uses code
 * units, which is what `isAcceptableRunSeed()` measures, so a truncation can
 * split a surrogate pair; the result stays a valid seed because a seed is
 * never interpreted.
 *
 * NEVER THROWS. Input that is empty, whitespace-only or not a string falls back
 * to `originateRunSeed()` rather than raising, so the run-start screen's
 * optional seed field needs no error path.
 *
 * @param input Whatever the seed field held.
 * @returns A seed satisfying `isAcceptableRunSeed()`.
 */
export function normalizeEnteredSeed(input: string): string {
  if (typeof input !== 'string') {
    return originateRunSeed();
  }

  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return originateRunSeed();
  }

  const bounded =
    trimmed.length > MAX_RUN_SEED_LENGTH
      ? trimmed.slice(0, MAX_RUN_SEED_LENGTH)
      : trimmed;

  // Defence in depth: the slice above already satisfies the predicate for every
  // reachable bound. A predicate that ever disagreed would yield an originated
  // seed rather than a seed `createRngStreams()` refuses.
  return isAcceptableRunSeed(bounded) ? bounded : originateRunSeed();
}

/** The minimum of Web Crypto this module reads, or `null` when it is absent. */
interface CryptoSource {
  readonly getRandomValues?: (array: Uint8Array) => Uint8Array;
  readonly randomUUID?: () => string;
}

/**
 * Reads `globalThis.crypto` without assuming it exists.
 *
 * Guarded rather than accessed: a non-browser host, a hardened realm and an
 * insecure context can each leave it absent or partial.
 */
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
 * A seed from a high-resolution time source combined with a counter, for a host
 * carrying no usable `crypto`.
 *
 * NOT RANDOM, and documented as such: it is unique per call, not unguessable.
 * `performance` is read behind the same kind of guard as `crypto`, and a host
 * carrying neither still yields a distinct value through the counter.
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

/* --------------------------------------------------------------------------
 * Identity resolution
 * ----------------------------------------------------------------------- */

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
   * The run seed, verbatim, as `createRngStreams()` takes it. Guaranteed to
   * satisfy `isAcceptableRunSeed()`, so building the substreams from it cannot
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

/** Everything `resolveRunIdentity()` reads. */
export interface ResolveRunIdentityOptions {
  /**
   * Where the stored envelope is read from. Only `readJson` is used, and the
   * value it returns is validated before a single member of it is adopted.
   */
  readonly storage: Pick<RunStatePersistencePort, 'readJson'>;

  /**
   * Originates a seed or a run identifier. Called at most twice — first for the
   * seed, then for the run identifier — and not at all when a stored envelope
   * supplies both.
   *
   * Defaults to `originateRunSeed()`, so this function is callable with a port
   * alone. The composition root injects the same factory it uses elsewhere.
   */
  readonly createToken?: () => string;

  /**
   * A caller-supplied seed — the run-start screen's optional seed input.
   * Adopted only when `isAcceptableRunSeed()` accepts it, and adopting one
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
 * on — so it has no sink to report to and cannot acquire one without inverting
 * the dependency. The authoritative load is `RunController.begin()`, which runs
 * once the sink exists and is the read that reports a corrupted payload, a
 * migration or a board-size reconciliation.
 *
 * The two reads agree because both reduce the same stored value through the
 * same validation: an envelope this function adopts is an envelope
 * `RunStateStore.load()` also adopts.
 *
 * @param options Port, token factory and optional caller-supplied seed.
 * @returns The resolved identity. A stored envelope that is absent,
 *   unreadable, of an unknown version or invalid in any member yields an
 *   originated seed and run identifier rather than a refusal.
 */
export function resolveRunIdentity(
  options: ResolveRunIdentityOptions,
): RunIdentity {
  const createToken = options.createToken ?? originateRunSeed;
  const requested = options.seed;

  // The supplied seed is measured as given, NOT normalised. A seed the
  // substreams would refuse falls through to the stored identity below, which
  // is a different outcome from the truncation `normalizeEnteredSeed()`
  // performs; that function is the run-start screen's own reduction, applied
  // before a seed reaches this resolution.
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
 *
 * Every failure mode collapses to `null`: a port that throws, a value that is
 * not an envelope, a version outside the readable history, and a payload whose
 * validation refuses any member. The seed of a validated envelope has already
 * been measured against `isAcceptableRunSeed()` by that validation, so what
 * this returns is safe to build substreams from.
 */
function readStoredIdentity(
  storage: Pick<RunStatePersistencePort, 'readJson'>,
): { readonly seed: string; readonly runId: string } | null {
  try {
    const stored = storage.readJson(RUN_STATE_KEY);
    const restored = migrateRunState(stored, classifyRunStateVersion(stored));

    if (restored === null) {
      return null;
    }

    return { seed: restored.seed, runId: restored.runId };
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------------
 * The engine port
 * ----------------------------------------------------------------------- */

/**
 * The slice of the engine this controller uses.
 *
 * Narrowed to three members so the controller cannot reach anything else:
 * it observes, it reads the board snapshot it persists, and it resolves a
 * stage whose goal has been met. `Engine` in src/engine/engine.ts satisfies
 * this structurally; nothing imports the class.
 */
export interface RunEnginePort {
  /** Subscription surface. The controller never emits. */
  readonly events: EngineEventSource;

  /** The board snapshot to wrap in the envelope. */
  serialize(): SerializedGameState;

  /** Resolves the stage in progress. Called when its goal has been met. */
  endStage(cleared: boolean): void;
}

/**
 * The subscription surface of `EngineEvents`, and nothing else.
 *
 * `on()` APPENDS, so attaching here neither displaces a listener already
 * attached nor reorders the ones after it. `off` and `emit` are deliberately
 * absent: this controller subscribes and never emits or detaches another
 * subscriber.
 */
export type EngineEventSource = Pick<EngineEvents, 'on'>;

/**
 * The slice of the engine a run START drives, beyond the observation surface.
 *
 * `Engine` in src/engine/engine.ts satisfies this structurally; nothing imports
 * the class, so src/engine never imports this folder. Named after the members
 * the engine actually exposes — `continuePlaying()` is the engine's method for
 * play continued past a win, and `setup()` takes the reconciled snapshot the
 * store returned.
 */
export interface EnginePort extends RunEnginePort {
  /** Opens a board, from the reconciled snapshot when one is supplied. */
  setup(previousState?: SerializedGameState | null): void;

  /** Discards the board in progress and opens a fresh one. */
  restart(): void;

  /** Resolves one turn. Reports whether the board changed. */
  move(direction: number): boolean;

  /** Whether the engine refuses further moves. */
  isGameTerminated(): boolean;

  /** Continues play past a win. */
  continuePlaying(): void;
}

/**
 * The slice of a relic registry this controller round-trips through.
 *
 * DECLARED HERE, NOT IMPORTED. src/relics/ is not named by this module, so the
 * persisted wire format stays independent of that folder's internal types and
 * this folder compiles and is exercised without it. Every member is optional,
 * so a controller constructed without a registry persists the relics it
 * already holds and resolves rewards by identifier alone.
 */
export interface RelicRegistryPort {
  /**
   * Projects the relics held, in pickup order, for the envelope to carry.
   * Consulted before each write when present, so charges a handler spent and
   * state a handler advanced reach the envelope.
   */
  readonly snapshotRelics?: () => readonly PersistedRelic[];

  /**
   * Restores the relics a loaded envelope carried, in pickup order. `state` is
   * handed back exactly as it was persisted.
   */
  readonly restoreRelics?: (relics: readonly PersistedRelic[]) => void;

  /**
   * Resolves a drawn identifier to the entry to persist, and yields `null` for
   * an identifier the registry does not know. A registry without this member
   * persists the bare identifier.
   */
  readonly resolveRelic?: (relicId: string) => PersistedRelic | null;
}

/* --------------------------------------------------------------------------
 * The controller
 * ----------------------------------------------------------------------- */

/** Every construction parameter. `store`, `identity`, `config` required. */
export interface RunControllerOptions {
  /** Where the envelope is read and written. */
  readonly store: RunStateStore;

  /** The identity `resolveRunIdentity()` produced. */
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
  readonly correlationId?: CorrelationId;

  /**
   * The relic registry to round-trip charges and state through. Absent by
   * default, in which case the envelope carries the relics this controller was
   * handed and nothing consults a registry.
   */
  readonly relics?: RelicRegistryPort;
}

/** Everything `RunController.startRun()` reads. */
export interface StartRunOptions {
  /**
   * The seed to play. Passed through `normalizeEnteredSeed()`, so a value a
   * player typed is trimmed and bounded rather than refused. Absent means
   * originate one.
   */
  readonly seed?: string;

  /**
   * The board to open on. Absent means open an empty board, which is what a
   * fresh run does.
   */
  readonly board?: SerializedGameState | null;
}

/**
 * Owns the run in progress.
 *
 * LIFECYCLE
 *   `begin()` adopts a stored envelope or assembles a fresh one. `observe()`
 *   attaches to the engine, after which the controller keeps the envelope
 *   current: the stage's goal progress is measured as each move resolves, the
 *   envelope is written on each commit, a stage whose goal is met is resolved
 *   and advanced, and a lost run is summarised and cleared.
 *
 * WRITES ARE BEST-EFFORT AND NEVER THROW
 *   `RunStateStore` reports and returns rather than throwing, for every input
 *   and against any port, so a full quota or a hostile storage implementation
 *   degrades to an unpersisted run rather than an exception on the commit path.
 */
export class RunController {
  readonly identity: RunIdentity;

  private readonly store: RunStateStore;

  private readonly config: RulesConfig;

  private readonly stages: StageConfig;

  private readonly createToken: () => string;

  private readonly reporter: RunReporter;

  private readonly runCorrelationId: CorrelationId;

  private readonly registry: RelicRegistryPort | undefined;

  /**
   * The identifiers most recently offered, for the reward report to carry.
   * Recorded by `recordRewardOffer()`; the offer itself is drawn elsewhere.
   */
  private offeredRelicIds: readonly string[];

  /** The envelope in force. Replaced wholesale; never mutated in place. */
  private current: RunState;

  /**
   * Whether the stage's goal has been met and not yet resolved. Set by the
   * progress measurement and cleared by `advanceStage()`.
   */
  private stageCleared: boolean;

  /**
   * Guards the one re-entrant path: `endStage()` commits, so the commit
   * handler that called it is re-entered before it returns. At most one stage
   * is resolved per commit, and a board that clears several stages at once
   * advances one stage per commit until it does not.
   */
  private resolvingStage: boolean;

  /** Whether the run in force has ended. Set by `finish()`. */
  private ended: boolean;

  /** The last finished run, for a summary screen to read. */
  private finished: RunSummary | null;

  constructor(options: RunControllerOptions) {
    this.store = options.store;
    this.identity = options.identity;
    this.config = options.config;
    this.stages = options.stages ?? DEFAULT_STAGE_CONFIG;
    this.createToken =
      options.createToken ?? ((): string => this.identity.runId);
    this.reporter = options.reporter ?? NOOP_RUN_REPORTER;
    this.runCorrelationId = options.correlationId ?? '';
    this.registry = options.relics;
    this.offeredRelicIds = [];
    this.current = this.freshState(this.identity.runId);
    this.stageCleared = false;
    this.resolvingStage = false;
    this.ended = false;
    this.finished = null;
  }

  /**
   * Performs the authoritative load and adopts its result.
   *
   * THE READ THAT REPORTS. `resolveRunIdentity()` read the same value silently
   * to produce the identity; this read goes through `RunStateStore.load()`, so
   * a corrupted payload, a migrated version and a board-size reconciliation all
   * reach the injected sink here.
   *
   * A stored envelope is adopted only when its seed is the seed the run is
   * being played under. It always is when the identity was resolved from that
   * same envelope; it is not when a caller supplied a seed, and adopting the
   * stored stage and relics in that case would put another run's progress on a
   * board playing a different sequence.
   *
   * @returns The load outcome, for a caller that wants to report or display it.
   */
  begin(): RunStateLoadOutcome {
    const result = this.store.load({
      runId: this.identity.runId,
      seed: this.identity.seed,
      stageGoal: this.goalForStage(FIRST_STAGE_INDEX),
      boardSize: this.config.boardSize,
    });

    const restored = result.state;
    const adopted = restored !== null && restored.seed === this.identity.seed;

    this.current = adopted
      ? (restored as RunState)
      : this.freshState(this.identity.runId);

    this.stageCleared = false;
    this.ended = false;
    this.offeredRelicIds = [];

    // The relics of an adopted envelope are handed back to the registry so the
    // hook bus dispatches to them in the pickup order they were saved in. An
    // envelope that was not adopted hands back the fresh, empty list.
    this.restoreRelics();

    this.reporter.onRunStarted?.({
      correlationId: this.runCorrelationId,
      runId: this.current.runId,
      stageIndex: this.current.stageIndex,

      // Whether a stored run was ADOPTED, which is the question the report
      // asks. Not the identity's own `resumed`, which records only where the
      // seed came from: a caller can supply the seed of the run already stored,
      // and that run is resumed even though its seed was not read from it.
      resumed: adopted,
      seedProvided: this.identity.seedProvided,
    });

    return result.outcome;
  }

  /** The seed the run is played under. Authoritative over the identity's. */
  seed(): string {
    return this.current.seed;
  }

  /** The identifier of the run in force. */
  runId(): string {
    return this.current.runId;
  }

  /**
   * The correlation identifier every report from this controller carries.
   *
   * REPUBLISHED, NOT DERIVED. src/engine/types.ts L66-L81 names
   * `deriveCorrelationId` in src/observability/logger.ts as the one deriver of
   * this value; the empty string is what a controller constructed without one
   * carries. Decision DL-RUNCTL-04.
   */
  correlationId(): CorrelationId {
    return this.runCorrelationId;
  }

  /** The index of the stage in progress. */
  stageIndex(): number {
    return this.current.stageIndex;
  }

  /** The clear condition of the stage in progress. */
  stageGoal(): StageGoal {
    return this.current.stageGoal;
  }

  /**
   * Fraction of the stage goal reached: the `progress` member
   * `evaluateStageGoal()` returned, already clamped by it and stored verbatim.
   */
  goalProgress(): number {
    return this.current.goalProgress;
  }

  /**
   * The relics held, IN PICKUP ORDER, with charges and opaque state.
   *
   * Array order is the pickup order the hook bus dispatches in, so it is
   * returned as held and never sorted, filtered or re-keyed.
   */
  relics(): readonly PersistedRelic[] {
    return this.current.relics;
  }

  /**
   * The draw counts to resume the substreams from.
   *
   * Read once at composition, after `begin()` and before
   * `createRngStreams(seed, cursors)`. A fresh run yields zeros, so the opening
   * spawns are taken rather than skipped.
   */
  cursors(): RngCursorMap {
    return normalizeRngCursor(this.current.rngCursor);
  }

  /** The envelope in force, by reference. Callers read; they do not mutate. */
  state(): RunState {
    return this.current;
  }

  /**
   * The stage slice of a commit.
   *
   * Bound as the engine's `stageContext` provider and therefore called once per
   * commit, so what it returns is read fresh each time rather than captured.
   */
  stageContext(): StageCommitContext {
    return {
      stageIndex: this.current.stageIndex,
      goal: this.current.stageGoal,
      goalProgress: this.current.goalProgress,
    };
  }

  /**
   * The relic slice of a commit, IN PICKUP ORDER.
   *
   * Projected from the envelope's `relics` in array order, which IS the pickup
   * order, so the order the hook bus dispatches in and the order a HUD renders
   * are one order. `state` is not carried: a commit's consumers show a relic
   * and its remaining charges, and its private state is nobody else's.
   */
  relicContext(): RelicCommitContext {
    return this.current.relics.map((relic): RelicCommitEntry =>
      relic.charges === undefined
        ? { id: relic.id }
        : { id: relic.id, charges: relic.charges },
    );
  }

  /**
   * `stageContext()` as the provider the engine takes.
   *
   * THE SANCTIONED ROUTE for stage context to reach a `state:commit` payload:
   * the engine calls a function it was constructed with, so nothing in
   * src/engine imports this folder. The returned closure reads the envelope
   * fresh on every call rather than capturing it.
   */
  stageCommitContextProvider(): StageCommitContextProvider {
    return (): StageCommitContext => this.stageContext();
  }

  /** `relicContext()` as the provider the engine takes, in pickup order. */
  relicCommitContextProvider(): RelicCommitContextProvider {
    return (): RelicCommitContext => this.relicContext();
  }

  /**
   * Attaches to the engine.
   *
   * THREE SUBSCRIPTIONS, each doing what only it can:
   *   - `stage:start` measures the opening progress. It is emitted before the
   *     commit that ends `setup()`, so a restored board that already meets part
   *     of its goal is reported correctly on the very first commit rather than
   *     as zero.
   *   - `move:after` measures progress from the board the move left. It, too,
   *     precedes its commit, so the stage slice a commit carries describes the
   *     board that commit carries.
   *   - `state:commit` writes the envelope, resolves a met goal and finishes a
   *     lost run.
   *   - `stage:end` advances the stage. Advancing HERE rather than after
   *     `endStage()` returns is what makes the commit `endStage()` ends with
   *     report the stage now in force: the payload of that commit is assembled
   *     after this emission completes, so a stage advanced during it is the
   *     stage the commit carries, while `stage:end`'s own payload — assembled
   *     before the emission — still reports the stage that cleared.
   *
   * @param engine The engine to observe.
   * @param cursors Reads the substreams' current draw counts. Called once per
   *   commit; the substreams are constructed after this controller, so the
   *   accessor is injected rather than the streams themselves.
   * @returns Releases all three subscriptions.
   */
  observe(engine: RunEnginePort, cursors: () => RngCursorMap): () => void {
    const stopStageStart = engine.events.on('stage:start', (): void => {
      this.measureSnapshot(engine.serialize());
    });

    const stopMoveAfter = engine.events.on(
      'move:after',
      (event: MoveAfterEvent): void => {
        this.measure(highestOnBoard(event.board), event.score);
      },
    );

    const stopStageEnd = engine.events.on('stage:end', (event): void => {
      if (event.cleared) {
        this.advanceStage();
      }
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
      correlationId: this.runCorrelationId,
      fromStageIndex: from,
      toStageIndex: to,
      goal,
    });

    return goal;
  }

  /* ----------------------------------------------------------------------
   * Reward resolution
   * ------------------------------------------------------------------- */

  /**
   * Records the offer a reward screen is about to present.
   *
   * THE OFFER IS NOT DRAWN HERE. Rarity-weighted sampling without replacement
   * lives in src/relics/relic-draw.ts, which consumes the `relic-draw` and
   * `rarity-weight` substreams this controller persists the cursors of. This
   * method only remembers what was offered so the reward report can carry it.
   *
   * @param relicIds The identifiers offered, in the order presented.
   */
  recordRewardOffer(relicIds: readonly string[]): void {
    this.offeredRelicIds = relicIds.slice();
  }

  /**
   * Records the relic the player chose.
   *
   * APPENDED, NEVER INSERTED OR SORTED. Array order is pickup order, and the
   * hook bus dispatches in that order, so a relic joins at the end of the held
   * list and every relic already held keeps its position.
   *
   * `charges` and `state` are carried exactly as the registry supplied them,
   * and `state` is never inspected or reshaped. A relic already held is not
   * added twice, and a hold at `MAX_PERSISTED_RELICS` accepts no further
   * relic — the envelope would be refused by the store on the next write
   * otherwise.
   *
   * Reports through `onRewardDrawn` whether or not the relic was added, so a
   * refused pick is visible rather than silent.
   *
   * @param relicId Identifier of the chosen relic.
   * @returns Whether the relic joined the held list.
   */
  resolveReward(relicId: string): boolean {
    const added = this.appendRelic(relicId);

    this.reporter.onRewardDrawn?.({
      correlationId: this.runCorrelationId,
      stageIndex: this.current.stageIndex,
      offeredRelicIds: this.offeredRelicIds,
      selectedRelicId: relicId,
    });

    this.offeredRelicIds = [];

    return added;
  }

  /* ----------------------------------------------------------------------
   * Run lifecycle
   * ------------------------------------------------------------------- */

  /**
   * Starts a FRESH run and opens the engine's board on it.
   *
   * Ported from js/game_manager.js L17-L21 `restart()` and L35-L59 `setup()`:
   * the stored envelope is discarded, a fresh one is assembled at stage 0, and
   * the engine opens a board. The seed is `normalizeEnteredSeed()`'s
   * reduction of `options.seed` when one is supplied, and
   * `originateRunSeed()`'s otherwise.
   *
   * The substreams are NOT rebuilt here: they are constructed from `seed()` and
   * `cursors()` by the composition root, which owns them. A caller starting a
   * second run in one page load rebuilds them from the values this call leaves.
   *
   * @param engine The engine to open. Its `setup()` is what emits the first
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
    this.stageCleared = false;
    this.ended = false;

    // A fresh run holds no relics, so the registry is handed the empty list it
    // must dispatch to rather than the previous run's.
    this.restoreRelics();

    this.reporter.onRunStarted?.({
      correlationId: this.runCorrelationId,
      runId: this.current.runId,
      stageIndex: this.current.stageIndex,
      resumed: false,
      seedProvided: options.seed !== undefined,
    });

    engine.setup(options.board ?? null);

    return seed;
  }

  /**
   * Resumes the stored run and opens the engine's board on it.
   *
   * The board handed to `setup()` is the one `RunStateStore.load()` returned,
   * which is ALREADY RECONCILED against the configured board size: a snapshot
   * saved at another edge length has been resolved by the store, and no grid is
   * ever built here from a raw persisted value.
   *
   * Falls back to a fresh run when nothing readable is stored, so the caller
   * needs no branch of its own.
   *
   * @param engine The engine to open.
   * @returns The load outcome, and `'absent'` when a fresh run was started.
   */
  resumeRun(engine: EnginePort): RunStateLoadOutcome {
    const outcome = this.begin();
    const restored = this.store.exists() ? this.current : null;

    // The envelope `begin()` adopted carries the reconciled board. A run that
    // was not adopted opens on an empty board rather than on a stale one.
    engine.setup(restored === null ? null : restored.board);

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
   * NEVER THROWS OUT OF THE COMMIT PATH. `RunStateStore.save()` reports its own
   * failure through `onWriteFailed` — it alone knows the key and the serialised
   * size — and returns `false`; this method surfaces that `false` to its caller
   * rather than discarding it or raising. js/local_storage_manager.js L37's
   * `catch (error) { return false; }` swallowed the error object; nothing here
   * does.
   *
   * @param engine Read for the board snapshot to wrap.
   * @param cursors Reads the substreams' current draw counts.
   * @returns Whether the envelope reached storage.
   */
  persist(engine: RunEnginePort, cursors: () => RngCursorMap): boolean {
    this.refresh(engine, cursors);

    return this.write();
  }

  /** The run in force, as data. Includes the seed, for a screen to display. */
  summary(): RunSummary {
    return summarizeRunState(this.current);
  }

  /**
   * The last finished run, or `null` when none has finished in this page load.
   *
   * Held in memory precisely because the envelope is cleared when a run ends:
   * a summary screen needs the finished run after the storage entry is gone.
   */
  lastSummary(): RunSummary | null {
    return this.finished;
  }

  /**
   * Ends the run in force explicitly, as a run-summary screen's end-run action
   * does, and clears the stored envelope.
   *
   * Idempotent: ending a run that has already ended reports nothing further and
   * returns the same summary.
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

  /* ----------------------------------------------------------------------
   * Internals
   * ------------------------------------------------------------------- */

  /**
   * Handles one commit: records the state that was committed, then decides
   * whether the run or the stage resolved.
   *
   * ORDER MATTERS. The envelope is brought up to date first, so whatever
   * follows — a write, a summary, a clear — describes the state that was
   * actually committed rather than the state before it.
   */
  private onCommit(
    engine: RunEnginePort,
    event: StateCommitEvent,
    cursors: () => RngCursorMap,
  ): void {
    this.refresh(engine, cursors);

    if (event.over) {
      // The engine clears `gameState` on a loss, exactly as
      // js/game_manager.js L84-L86 did. The envelope is cleared with it, so
      // the two keys cannot disagree about whether a run is in progress, and a
      // reload after a loss opens a fresh run rather than a fresh board
      // carrying the lost run's stage and relics.
      this.finish('lost');

      return;
    }

    this.write();

    if (!this.stageCleared || this.resolvingStage) {
      return;
    }

    // `endStage()` emits `stage:end` — where the advance happens — and then
    // commits, so this handler is re-entered before the call returns. That
    // re-entrant commit is what persists the advanced stage; the guard is what
    // stops it from resolving a stage of its own.
    this.resolvingStage = true;

    try {
      engine.endStage(true);
    } finally {
      this.resolvingStage = false;
    }
  }

  /**
   * Brings the envelope up to date with the moment being committed: the
   * substreams' draw counts, the engine's board snapshot, and the relics as the
   * registry holds them.
   *
   * All three are read TOGETHER, immediately before a write, so the counts, the
   * board and the charges stored describe one moment.
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
   * Writes the envelope and surfaces a refused write.
   *
   * `RunStateStore.save()` never throws: it reports through `onWriteFailed` and
   * returns `false`. The report emitted here is the COMMIT PATH's own record of
   * that refusal, at the decision point where the run failed to persist, and it
   * carries no error object it did not receive.
   */
  private write(): boolean {
    if (this.store.save(this.current)) {
      return true;
    }

    this.reporter.onWriteFailed?.({
      correlationId: this.runCorrelationId,
      key: RUN_STATE_KEY,
      byteLength: measureBytes(this.current),
      error: WRITE_REFUSED_ON_COMMIT,
    });

    return false;
  }

  /**
   * The substreams' draw counts, with every named substream present.
   *
   * ALL FOUR are recorded. `normalizeRngCursor()` completes a partial map by
   * walking `RNG_STREAM_NAMES`, so a reader that supplies fewer than four still
   * yields a map carrying one entry per substream. A reader that throws yields
   * the counts already recorded rather than propagating out of the commit path.
   */
  private readCursors(cursors: () => RngCursorMap): RngCursorMap {
    let read: RngCursorMap;

    try {
      read = cursors();
    } catch (error) {
      this.reporter.onWriteFailed?.({
        correlationId: this.runCorrelationId,
        key: RUN_STATE_KEY,
        byteLength: 0,
        error,
      });

      return normalizeRngCursor(this.current.rngCursor);
    }

    const normalized = normalizeRngCursor(read);
    const carried = normalizeRngCursor(this.current.rngCursor);
    const complete: Record<string, number> = {};

    // Walked by name, so the map written carries one entry per NAMED substream
    // rather than per member the reader happened to return. A substream the
    // reader omitted keeps the count already recorded, because a cursor only
    // ever moves forward: writing a zero over a recorded count would replay
    // draws the run has already taken.
    for (const name of RNG_STREAM_NAMES) {
      complete[name] = Math.max(normalized[name], carried[name]);
    }

    return complete as RngCursorMap;
  }

  /**
   * The relics to persist: the registry's projection when one is attached, and
   * the relics already held otherwise.
   *
   * PICKUP ORDER IS CARRIED THROUGH, and `state` is passed along opaquely —
   * never inspected, never reshaped. A registry that throws or yields a
   * non-array leaves the held relics in place.
   */
  private projectRelics(): readonly PersistedRelic[] {
    const project = this.registry?.snapshotRelics;

    if (project === undefined) {
      return this.current.relics;
    }

    try {
      const projected = project();

      return Array.isArray(projected) ? projected : this.current.relics;
    } catch (error) {
      this.reporter.onWriteFailed?.({
        correlationId: this.runCorrelationId,
        key: RUN_STATE_KEY,
        byteLength: 0,
        error,
      });

      return this.current.relics;
    }
  }

  /**
   * Appends one relic to the held list, or reports that it was not appended.
   *
   * Refuses an identifier that is empty, one already held, and any pick beyond
   * `MAX_PERSISTED_RELICS` — an envelope carrying more than that is refused by
   * the store, so accepting one here would lose the whole run's progress on the
   * next write.
   */
  private appendRelic(relicId: string): boolean {
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
      relics: [...held, this.resolveRelicEntry(relicId)],
    };

    return true;
  }

  /**
   * The entry to persist for one drawn identifier.
   *
   * The registry resolves it when it can; a bare identifier is persisted
   * otherwise, which is what a relic carrying neither charges nor state needs.
   * `state` is carried exactly as supplied.
   */
  private resolveRelicEntry(relicId: string): PersistedRelic {
    const resolve = this.registry?.resolveRelic;

    if (resolve === undefined) {
      return { id: relicId };
    }

    try {
      const resolved = resolve(relicId);

      if (resolved === null || typeof resolved !== 'object') {
        return { id: relicId };
      }

      // The identifier the caller chose wins over the one the registry
      // reported, so a registry cannot substitute a different relic.
      return { ...resolved, id: relicId };
    } catch (error) {
      this.reporter.onWriteFailed?.({
        correlationId: this.runCorrelationId,
        key: RUN_STATE_KEY,
        byteLength: 0,
        error,
      });

      return { id: relicId };
    }
  }

  /**
   * Hands the relics a loaded envelope carried back to the registry, in pickup
   * order, with `state` exactly as it was persisted.
   */
  private restoreRelics(): void {
    const restore = this.registry?.restoreRelics;

    if (restore === undefined) {
      return;
    }

    try {
      restore(this.current.relics);
    } catch (error) {
      this.reporter.onWriteFailed?.({
        correlationId: this.runCorrelationId,
        key: RUN_STATE_KEY,
        byteLength: 0,
        error,
      });
    }
  }

  /**
   * Summarises the run, reports it, clears the stored envelope and replaces the
   * envelope in force with a fresh one.
   *
   * The replacement is what keeps a second run played without a reload honest:
   * the next commit persists a run at stage 0 with no relics, rather than
   * carrying the finished run's progress onto a fresh board. It is a new run
   * instance, so it carries a new run identifier.
   */
  private finish(outcome: RunOutcome): RunSummary {
    const summary = this.summary();

    this.finished = summary;
    this.ended = true;
    this.stageCleared = false;

    this.reporter.onRunEnded?.({
      correlationId: this.runCorrelationId,
      outcome,
      summary: redactRunSummary(summary),
    });

    this.store.clear();
    this.current = this.freshState(this.createToken());

    return summary;
  }

  /**
   * Measures the stage's progress and records whether its goal is met.
   *
   * The measurement itself is `evaluateStageGoal()` in
   * src/config/stage-config.ts; this module holds no second evaluator and
   * stores the `progress` it returns verbatim. Decision DL-RUNCTL-03.
   *
   * The two inputs are checked for finiteness before they reach
   * `evaluateStageGoal()`, which throws on a value that is not finite: an
   * `onAfterMove` handler may set the score, so the number reaching here is not
   * guaranteed to be one this module produced. An unusable measurement leaves
   * the last good progress in place rather than replacing it with a guess.
   */
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

  /** Measures from a board snapshot, for the paths that carry no live board. */
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
   * it with the engine's own snapshot — and it is a truthful value rather than
   * a stand-in: a run that has not started holds no tiles.
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

/* --------------------------------------------------------------------------
 * Write reporting
 * ----------------------------------------------------------------------- */

/**
 * The `error` a commit-path write failure carries when the store refused the
 * envelope without raising. Not an exception: the store reports the storage
 * cause, and this names the consequence for the run.
 */
const WRITE_REFUSED_ON_COMMIT = Object.freeze(
  new Error('The run-state store refused the envelope on the commit path.'),
);

/**
 * Serialised size of an envelope, at two bytes per UTF-16 code unit, and `0`
 * when it cannot be measured.
 *
 * Measurement never throws, so a report about a failed write cannot itself
 * fail.
 */
function measureBytes(state: RunState): number {
  try {
    const encoded = JSON.stringify(state);

    return typeof encoded === 'string'
      ? encoded.length * BYTES_PER_CODE_UNIT
      : 0;
  } catch {
    return 0;
  }
}

/** Bytes per UTF-16 code unit, matching the store's own accounting. */
const BYTES_PER_CODE_UNIT = 2;

/* --------------------------------------------------------------------------
 * Board readers
 * ----------------------------------------------------------------------- */

/** The value of a board with no tiles, as `StageProgressInput` defines it. */
const NO_TILES = 0;

/**
 * The minimum a board must expose to be measured: the x-major cell matrix.
 *
 * Declared structurally so this module names no engine class. The
 * `BoardProjection` of src/engine/engine-events.ts satisfies it, which is what
 * `MoveAfterEvent.board` is — an event carries a frozen projection of the board
 * rather than the live lattice, so no measurement can reach engine state.
 */
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

/**
 * The highest tile value in a board snapshot, and 0 for one holding none.
 *
 * Tolerant of a matrix that came out of Web Storage: a row that is not an
 * array, a cell that is not a tile and a value that is not a finite number are
 * skipped rather than measured.
 */
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
 * An empty board snapshot of one edge length, in the frozen persisted shape:
 * `cells` indexed `[x][y]` with every empty cell retained as `null` rather than
 * compacted away.
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
