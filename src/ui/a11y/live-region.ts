// The announcement queue behind the `aria-live` region declared at
// index.html L105. Announcements are enqueued, coalesced into the smallest
// correct set of utterances, and written to that region one utterance per
// task.
//
// Origin, one row per construct group. Nothing here ports a construct from
// js/: no module under js/ announces anything, and a search of the retired
// markup for `aria-`, `role=`, `lang=` and `tabindex` returns no match, so
// every row is target-only in docs/TRACEABILITY_MATRIX.md.
//
// | Construct group                     | Origin                          |
// |-------------------------------------|---------------------------------|
// | Queue, coalescing, write sequence   | R9, validation gate V7          |
// | `DIRECTION_LABELS`                  | src/engine/types.ts L42-L51     |
// | `TERMINAL_VERDICT_LABELS`           | js/html_actuator.js L129        |
// | `KEEP_PLAYING_LABEL`                | index.html L51                  |
// | `HUMAN_INDEX_OFFSET`                | js/html_actuator.js L97-L99     |
// | Host selector, region semantics     | index.html L105                 |
// | `VISUALLY_HIDDEN_CLASS`             | style/_a11y.scss L157-L170      |
// | Report sink, guarded host lookup    | Rule 3, I12                     |
// | `observePreferences`                | src/ui/a11y/settings.ts L1104-8 |
//
// index.html L105 declares ONE region — `#live-region`, carrying
// `role="status"`, `aria-live="polite"` and `aria-atomic="true"` — so both
// polarities are written to it and its `aria-live` attribute is never
// mutated after construction. A markup that declares a polite and an
// assertive region instead is served by the two assertive options below.
//
// Imports are limited to ./settings. This module names no module under
// src/engine/, src/render/, src/relics/, src/observability/, src/theme/ or
// any sibling directory of src/ui/, and it reads no storage.
//
// It declares no visual value. The region's visually-hidden treatment is the
// `.visually-hidden` class of style/_a11y.scss L168, which clips the paint
// region and keeps the box. Nothing here assigns a style property, and no
// hiding mechanism that would take the region out of the accessibility tree
// is used anywhere in this module.
//
// `AnnouncedDirection` restates `Direction` of src/engine/types.ts L39 and
// of src/input/keymap.ts L27 rather than importing either, which is how
// those two modules already relate to one another.
//
// No exported function throws. A missing region, an environment with no task
// scheduler, an unrecognised announcement, a non-finite number, an absent
// spawn position, a refused subscription, a throwing listener and a failed
// DOM write are each reported through the injected sink and the call
// continues.
//
// Rationale for the decisions behind this file — the coalescing rules, the
// clear-then-write sequence, the polite default, the queue bound, and the
// parallel-DOM-plus-live-region approach itself — is in
// docs/DECISION_LOG.md.

import type {
  MountRoot,
  PreferenceKey,
  UiPreferences,
  UiReporter,
} from './settings';
import {
  NOOP_UI_REPORTER,
  createSafeUiReporter,
  resolveMount,
} from './settings';

/* ==========================================================================
 * 1. Report names
 * ========================================================================== */

/** Counter raised once per region this module resolved and prepared. */
const MOUNTED_METRIC = 'ui.liveRegion.mounted';

/** Counter raised where a region is not available. */
const HOST_MISSING_METRIC = 'ui.liveRegion.host.missing';

/** Counter raised once per attribute or class the markup left off. */
const REMEDIATED_METRIC = 'ui.liveRegion.host.remediated';

/** Counter raised where preparing a region throws. */
const PREPARE_FAILED_METRIC = 'ui.liveRegion.host.prepareFailed';

/** Counter raised once per accepted announcement. */
const ANNOUNCED_METRIC = 'ui.liveRegion.announced';

/** Counter raised where an announcement is not one this module models. */
const REJECTED_METRIC = 'ui.liveRegion.rejected';

/** Counter raised where a number that is not finite is replaced. */
const NUMBER_REPLACED_METRIC = 'ui.liveRegion.number.replaced';

/** Counter raised with the number of announcements the bound discarded. */
const DROPPED_METRIC = 'ui.liveRegion.dropped';

/** Counter raised with the number of items a verdict superseded. */
const SUPERSEDED_METRIC = 'ui.liveRegion.superseded';

/** Counter raised with the number of repeated utterances collapsed. */
const COLLAPSED_METRIC = 'ui.liveRegion.collapsed';

/** Counter raised where a move that changed nothing is not composed. */
const UNCHANGED_MOVE_METRIC = 'ui.liveRegion.move.unchanged';

/** Counter raised once per utterance written to a region. */
const UTTERED_METRIC = 'ui.liveRegion.uttered';

/** Counter raised where writing to a region throws. */
const WRITE_FAILED_METRIC = 'ui.liveRegion.write.failed';

/** Counter raised where an utterance had no region to be written to. */
const DISABLED_METRIC = 'ui.liveRegion.disabled';

/** Counter raised where a requested queue bound is rejected. */
const CAPACITY_REJECTED_METRIC = 'ui.liveRegion.capacity.rejected';

/** Counter raised where the environment supplies no task scheduler. */
const SCHEDULER_ABSENT_METRIC = 'ui.liveRegion.scheduler.absent';

/** Counter raised where a preference subscription cannot be established. */
const SUBSCRIBE_REFUSED_METRIC = 'ui.liveRegion.preferences.refused';

/** Counter raised where a preference notification throws. */
const OBSERVE_FAILED_METRIC = 'ui.liveRegion.preferences.failed';

/** Counter raised once per destroyed announcer. */
const DESTROYED_METRIC = 'ui.liveRegion.destroyed';

/** Counter raised where a method is called after `destroy()`. */
const AFTER_DESTROY_METRIC = 'ui.liveRegion.afterDestroy';

/** Label carried into every report where the caller supplies none. */
const DEFAULT_CONTEXT = 'ui.liveRegion';

/* ==========================================================================
 * 2. Direction, polarity and verdict vocabulary
 * ========================================================================== */

/**
 * The four move directions, restating `Direction` of src/engine/types.ts L39
 * and of src/input/keymap.ts L27 so this module imports neither.
 *
 * `0` is up, `1` right, `2` down and `3` left, the order
 * src/engine/types.ts L42-L51 declares.
 */
export type AnnouncedDirection = 0 | 1 | 2 | 3;

/** Urgency an utterance is written with. */
export type AnnouncementPolarity = 'polite' | 'assertive';

/** The polarity every announcement carries unless it states another. */
export const DEFAULT_POLARITY: AnnouncementPolarity = 'polite';

/**
 * The polarity a run verdict is written with, and the one a forced
 * number-only fallback notice is written with. No other announcement uses it.
 */
export const ASSERTIVE_POLARITY: AnnouncementPolarity = 'assertive';

/** How a run ended, or that a won run continues. */
export type TerminalVerdict = 'win' | 'continued-win' | 'loss';

/** Every verdict, in the order they are declared. */
export const TERMINAL_VERDICTS: readonly TerminalVerdict[] = Object.freeze([
  'win',
  'continued-win',
  'loss',
] as const satisfies readonly TerminalVerdict[]);

/** A board coordinate as the engine states it: zero-based column and row. */
export interface AnnouncedPosition {
  /** Zero-based column index. */
  readonly x: number;

  /** Zero-based row index. */
  readonly y: number;
}

/** Spoken name of each direction. */
export const DIRECTION_LABELS = Object.freeze({
  0: 'Up',
  1: 'Right',
  2: 'Down',
  3: 'Left',
} as const satisfies Readonly<Record<AnnouncedDirection, string>>);

/**
 * Continuation phrase. It is the `.keep-playing-button` label of
 * index.html L51, the copy the vanilla actuator left to that control when it
 * cleared the overlay at js/html_actuator.js L135-L139.
 */
const KEEP_PLAYING_LABEL = 'Keep going';

/**
 * Spoken verdicts. `win` and `loss` are verbatim the two strings
 * js/html_actuator.js L129 wrote into the overlay paragraph.
 */
export const TERMINAL_VERDICT_LABELS = Object.freeze({
  win: 'You win!',
  'continued-win': `You win! ${KEEP_PLAYING_LABEL}.`,
  loss: 'Game over!',
} as const satisfies Readonly<Record<TerminalVerdict, string>>);

/** Prefix of a relic-acquisition utterance. */
const RELIC_ACQUIRED_LABEL = 'Relic acquired';

/** Prefix of the score clause of a verdict utterance. */
const FINAL_SCORE_LABEL = 'Final score';

/** Prefix of the score clause of a gameplay utterance. */
const SCORE_LABEL = 'Score';

/**
 * Added to a zero-based index to produce the number an utterance states.
 *
 * It is the `+ 1` of `normalizePosition` at js/html_actuator.js L97-L99,
 * applied to the zero-based column and row of the engine's `Position` and to
 * the zero-based `stageIndex` of src/config/stage-config.ts L264-L265.
 */
const HUMAN_INDEX_OFFSET = 1;

/* ==========================================================================
 * 3. The announcement vocabulary
 * ========================================================================== */

/** Discriminant of every announcement this module models. */
export type AnnouncementKind =
  | 'move'
  | 'merge'
  | 'spawn'
  | 'stageClear'
  | 'relicAcquired'
  | 'terminal'
  | 'text';

/** Every kind. */
export const ANNOUNCEMENT_KINDS: readonly AnnouncementKind[] = Object.freeze([
  'move',
  'merge',
  'spawn',
  'stageClear',
  'relicAcquired',
  'terminal',
  'text',
] as const satisfies readonly AnnouncementKind[]);

/**
 * The kinds a verdict supersedes within one flush, and the kinds the queue
 * bound discards first. `relicAcquired`, `terminal` and `text` are absent
 * from this list and are never discarded by the bound.
 */
export const GAMEPLAY_ANNOUNCEMENT_KINDS: readonly AnnouncementKind[] =
  Object.freeze([
    'move',
    'merge',
    'spawn',
    'stageClear',
  ] as const satisfies readonly AnnouncementKind[]);

/**
 * One resolved move.
 *
 * `changed` is the engine's own `moved` flag. A move that changed no
 * position spawns no tile. Such a move is composed into nothing.
 */
export interface MoveAnnouncement {
  /** Discriminant. */
  readonly kind: 'move';

  /** Direction the move resolved in. */
  readonly direction: AnnouncedDirection;

  /** Whether any tile position changed. */
  readonly changed: boolean;

  /** Score after the move. */
  readonly score: number;
}

/**
 * One merge. The engine emits `tile:merge` once per merge, so a single move
 * can produce more than one of these.
 */
export interface MergeAnnouncement {
  /** Discriminant. */
  readonly kind: 'merge';

  /** Value of the tile the merge produced. */
  readonly resultValue: number;

  /** Points the merge added. */
  readonly scoreDelta: number;
}

/**
 * One spawned tile.
 *
 * `position` is absent where the board supplied no cell, mirroring the
 * optional `position` of the engine's spawn payload and the `undefined` the
 * vanilla `randomAvailableCell` returned on a full board. No coordinate is
 * stated in that case.
 */
export interface SpawnAnnouncement {
  /** Discriminant. */
  readonly kind: 'spawn';

  /** Value of the spawned tile. */
  readonly value: number;

  /** Cell the tile occupies, where the board supplied one. */
  readonly position?: AnnouncedPosition | undefined;
}

/** The end of a stage. `stageIndex` is zero-based; the text is 1-based. */
export interface StageClearAnnouncement {
  /** Discriminant. */
  readonly kind: 'stageClear';

  /** Zero-based index of the stage that ended. */
  readonly stageIndex: number;

  /** Whether the stage goal was met. */
  readonly cleared: boolean;
}

/**
 * A relic taken. Primitives only: the caller reduces a relic to these three
 * fields, so this module names no type of src/relics/.
 */
export interface RelicAcquiredAnnouncement {
  /** Discriminant. */
  readonly kind: 'relicAcquired';

  /** Relic name as it is displayed. */
  readonly name: string;

  /** Rarity as a word. */
  readonly rarity: string;

  /** Charges the relic starts with, where it is charge-based. */
  readonly charges?: number | undefined;
}

/** A run verdict. Written with `ASSERTIVE_POLARITY`. */
export interface TerminalAnnouncement {
  /** Discriminant. */
  readonly kind: 'terminal';

  /** Which verdict. */
  readonly verdict: TerminalVerdict;

  /** Score to state alongside the verdict. */
  readonly score?: number | undefined;
}

/** Free text: screen transitions, preference changes, fallback notices. */
export interface TextAnnouncement {
  /** Discriminant. */
  readonly kind: 'text';

  /** Text to speak. Trimmed; an empty result is rejected. */
  readonly text: string;

  /** Urgency. Defaults to `DEFAULT_POLARITY`. */
  readonly polarity?: AnnouncementPolarity | undefined;
}

/** Everything `announce` accepts. */
export type Announcement =
  | MoveAnnouncement
  | MergeAnnouncement
  | SpawnAnnouncement
  | StageClearAnnouncement
  | RelicAcquiredAnnouncement
  | TerminalAnnouncement
  | TextAnnouncement;

/** One composed line, and the urgency it is written with. */
export interface Utterance {
  /** Text written to a region. */
  readonly text: string;

  /** Region the text is written to. */
  readonly polarity: AnnouncementPolarity;
}

/**
 * Compile-time exhaustiveness check.
 *
 * Its parameter is `never`, so a member added to a union without a matching
 * case fails the type gate at the call site. It performs nothing, returns
 * nothing and throws nothing.
 *
 * @param value The unreachable value.
 */
function unhandledKind(value: never): void {
  void value;
}

/* ==========================================================================
 * 4. Narrowing and sanitising
 * ========================================================================== */

/** Value stated in place of a number that is not finite. */
const REPLACED_NUMBER = 0;

/** Result of a search that found nothing. */
const NOT_FOUND = -1;

/**
 * Every field any announcement variant reads, each as `unknown`.
 *
 * The shape a candidate is viewed through before it is narrowed, so a value
 * arriving from an untyped caller is inspected without an `any` and without a
 * cast.
 */
interface AnnouncementRecord {
  readonly kind?: unknown;
  readonly direction?: unknown;
  readonly changed?: unknown;
  readonly score?: unknown;
  readonly resultValue?: unknown;
  readonly scoreDelta?: unknown;
  readonly value?: unknown;
  readonly position?: unknown;
  readonly stageIndex?: unknown;
  readonly cleared?: unknown;
  readonly name?: unknown;
  readonly rarity?: unknown;
  readonly charges?: unknown;
  readonly verdict?: unknown;
  readonly text?: unknown;
  readonly polarity?: unknown;
}

/**
 * Whether a value is one of the modelled kinds.
 *
 * @param value Candidate discriminant.
 * @returns Whether `value` is an `AnnouncementKind`.
 */
export function isAnnouncementKind(
  value: unknown,
): value is AnnouncementKind {
  if (typeof value !== 'string') {
    return false;
  }

  for (const kind of ANNOUNCEMENT_KINDS) {
    if (kind === value) {
      return true;
    }
  }

  return false;
}

/**
 * Whether a kind is one a verdict supersedes and the bound discards first.
 *
 * @param kind Kind to test.
 * @returns Whether `kind` is a gameplay kind.
 */
export function isGameplayAnnouncementKind(kind: AnnouncementKind): boolean {
  for (const gameplay of GAMEPLAY_ANNOUNCEMENT_KINDS) {
    if (gameplay === kind) {
      return true;
    }
  }

  return false;
}

/**
 * Narrows a value to a polarity.
 *
 * @param value Candidate polarity.
 * @returns The polarity, or `undefined` where the value is not one.
 */
function toPolarity(value: unknown): AnnouncementPolarity | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  switch (value) {
    case 'polite':
      return 'polite';
    case 'assertive':
      return 'assertive';
    default:
      return undefined;
  }
}

/**
 * Narrows a value to a direction.
 *
 * @param value Candidate direction.
 * @returns The direction, or `null` where the value is not one.
 */
function toDirection(value: unknown): AnnouncedDirection | null {
  if (typeof value !== 'number') {
    return null;
  }

  switch (value) {
    case 0:
      return 0;
    case 1:
      return 1;
    case 2:
      return 2;
    case 3:
      return 3;
    default:
      return null;
  }
}

/**
 * Narrows a value to a verdict.
 *
 * @param value Candidate verdict.
 * @returns The verdict, or `null` where the value is not one.
 */
function toVerdict(value: unknown): TerminalVerdict | null {
  if (typeof value !== 'string') {
    return null;
  }

  switch (value) {
    case 'win':
      return 'win';
    case 'continued-win':
      return 'continued-win';
    case 'loss':
      return 'loss';
    default:
      return null;
  }
}

/**
 * Narrows a value to a board coordinate.
 *
 * An absent, malformed or non-finite coordinate resolves to `undefined`. A
 * spawn on a full board therefore states no coordinate.
 *
 * @param value Candidate position.
 * @returns The position, or `undefined`.
 */
function toPosition(value: unknown): AnnouncedPosition | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }

  const candidate: { readonly x?: unknown; readonly y?: unknown } = value;
  const x: unknown = candidate.x;
  const y: unknown = candidate.y;

  if (typeof x !== 'number' || !Number.isFinite(x)) {
    return undefined;
  }

  if (typeof y !== 'number' || !Number.isFinite(y)) {
    return undefined;
  }

  return Object.freeze({ x, y });
}

/**
 * Narrows a value to a charge count.
 *
 * @param value Candidate count.
 * @returns A non-negative integer, or `undefined`.
 */
function toCharges(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return undefined;
  }

  return value < 0 ? undefined : value;
}

/**
 * Narrows a value to a finite number.
 *
 * @param value Candidate number.
 * @returns The number, or `undefined`.
 */
function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return value;
}

/**
 * Trims a value to a string.
 *
 * @param value Candidate text.
 * @returns The trimmed text, or an empty string where the value is not one,
 *   so neither `null` nor `undefined` is ever spoken.
 */
function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Reads a number, reporting and replacing one that is not finite.
 *
 * @param value Candidate number.
 * @param field Field the number came from, carried into the report.
 * @param reporter Contained sink.
 * @param context Label naming the caller.
 * @returns The number, or `REPLACED_NUMBER`.
 */
function toReportedNumber(
  value: unknown,
  field: string,
  reporter: UiReporter,
  context: string,
): number {
  const resolved = toOptionalNumber(value);

  if (resolved !== undefined) {
    return resolved;
  }

  reporter.log('warn', 'live region replaced a number', {
    field,
    replacement: REPLACED_NUMBER,
    context,
  });
  reporter.count(NUMBER_REPLACED_METRIC, { field, context });

  return REPLACED_NUMBER;
}

/**
 * Reads a zero-based index, reporting and replacing one that is not usable.
 *
 * @param value Candidate index.
 * @param field Field the index came from, carried into the report.
 * @param reporter Contained sink.
 * @param context Label naming the caller.
 * @returns A non-negative integer.
 */
function toReportedIndex(
  value: unknown,
  field: string,
  reporter: UiReporter,
  context: string,
): number {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0
  ) {
    return value;
  }

  reporter.log('warn', 'live region replaced an index', {
    field,
    replacement: REPLACED_NUMBER,
    context,
  });
  reporter.count(NUMBER_REPLACED_METRIC, { field, context });

  return REPLACED_NUMBER;
}

/**
 * Records a rejected announcement.
 *
 * @param reason Short machine-readable reason.
 * @param reporter Contained sink.
 * @param context Label naming the caller.
 */
function reportRejection(
  reason: string,
  reporter: UiReporter,
  context: string,
): void {
  reporter.log('warn', 'live region rejected an announcement', {
    reason,
    context,
  });
  reporter.count(REJECTED_METRIC, { reason, context });
}

/**
 * Validates a candidate and returns the frozen announcement to enqueue.
 *
 * Every field is narrowed here rather than at composition, so no composed
 * utterance can contain `NaN`, `null` or `undefined`. A candidate whose
 * direction, verdict or text cannot be used is rejected outright and
 * reported; a numeric field that cannot be used is reported and replaced.
 *
 * @param input Candidate announcement, from a typed or an untyped caller.
 * @param reporter Contained sink.
 * @param context Label naming the caller.
 * @returns The announcement to enqueue, or `null` where it was rejected.
 */
export function normalizeAnnouncement(
  input: unknown,
  sink: UiReporter = NOOP_UI_REPORTER,
  context: string = DEFAULT_CONTEXT,
): Announcement | null {
  const reporter = createSafeUiReporter(sink);

  if (input === null || typeof input !== 'object') {
    reportRejection('not-an-object', reporter, context);

    return null;
  }

  const record: AnnouncementRecord = input;
  const kind: unknown = record.kind;

  if (!isAnnouncementKind(kind)) {
    reportRejection('unknown-kind', reporter, context);

    return null;
  }

  switch (kind) {
    case 'move': {
      const direction = toDirection(record.direction);

      if (direction === null) {
        reportRejection('move.direction', reporter, context);

        return null;
      }

      return Object.freeze({
        kind: 'move',
        direction,
        changed: record.changed === true,
        score: toReportedNumber(record.score, 'move.score', reporter, context),
      } as const);
    }

    case 'merge':
      return Object.freeze({
        kind: 'merge',
        resultValue: toReportedNumber(
          record.resultValue,
          'merge.resultValue',
          reporter,
          context,
        ),
        scoreDelta: toReportedNumber(
          record.scoreDelta,
          'merge.scoreDelta',
          reporter,
          context,
        ),
      } as const);

    case 'spawn':
      return Object.freeze({
        kind: 'spawn',
        value: toReportedNumber(
          record.value,
          'spawn.value',
          reporter,
          context,
        ),
        position: toPosition(record.position),
      } as const);

    case 'stageClear':
      return Object.freeze({
        kind: 'stageClear',
        stageIndex: toReportedIndex(
          record.stageIndex,
          'stageClear.stageIndex',
          reporter,
          context,
        ),
        cleared: record.cleared === true,
      } as const);

    case 'relicAcquired':
      return Object.freeze({
        kind: 'relicAcquired',
        name: toText(record.name),
        rarity: toText(record.rarity),
        charges: toCharges(record.charges),
      } as const);

    case 'terminal': {
      const verdict = toVerdict(record.verdict);

      if (verdict === null) {
        reportRejection('terminal.verdict', reporter, context);

        return null;
      }

      return Object.freeze({
        kind: 'terminal',
        verdict,
        score: toOptionalNumber(record.score),
      } as const);
    }

    case 'text': {
      const text = toText(record.text);

      if (text === '') {
        reportRejection('text.empty', reporter, context);

        return null;
      }

      return Object.freeze({
        kind: 'text',
        text,
        polarity: toPolarity(record.polarity),
      } as const);
    }

    default: {
      unhandledKind(kind);
      reportRejection('unhandled-kind', reporter, context);

      return null;
    }
  }
}

/* ==========================================================================
 * 5. Composition
 * ========================================================================== */

/** Separator between the clauses of one utterance. */
const CLAUSE_SEPARATOR = ' ';

/** Separator between the merged values one utterance lists. */
const VALUE_SEPARATOR = ', ';

/** Quantity a singular noun describes. */
const SINGULAR_COUNT = 1;

/** Multiplier that renders a 0-to-1 volume as a whole-number percentage. */
const PERCENT_SCALE = 100;

/** Separator a theme id is split on to read it as prose. */
const THEME_ID_SEPARATOR = '-';

/** What one composition produced, and what it discarded producing it. */
export interface Composition {
  /** The lines to write, in the order they are to be written. */
  readonly utterances: readonly Utterance[];

  /** Gameplay items a verdict superseded. */
  readonly superseded: number;

  /** Repeated consecutive utterances collapsed into their predecessor. */
  readonly collapsed: number;

  /** Moves that changed nothing and were therefore composed into nothing. */
  readonly unchangedMoves: number;
}

/**
 * Chooses between a singular and a plural noun.
 *
 * @param count Quantity the noun describes.
 * @param singular Noun for one.
 * @param plural Noun for any other quantity.
 * @returns The noun to use.
 */
function pluralize(count: number, singular: string, plural: string): string {
  return count === SINGULAR_COUNT ? singular : plural;
}

/**
 * Joins the non-empty clauses of one utterance.
 *
 * @param clauses Clauses in the order they are spoken.
 * @returns One line, or an empty string where every clause was empty.
 */
function joinClauses(clauses: readonly string[]): string {
  const present: string[] = [];

  for (const clause of clauses) {
    if (clause !== '') {
      present.push(clause);
    }
  }

  return present.join(CLAUSE_SEPARATOR);
}

/**
 * Composes the move clause.
 *
 * Only moves that changed the board reach here. Several of them in one flush
 * are stated as a count plus the last direction rather than as one clause
 * each.
 *
 * @param moves Changed moves in the order they were announced.
 * @returns The clause, or an empty string where there were none.
 */
function describeMoves(moves: readonly MoveAnnouncement[]): string {
  if (moves.length === 0) {
    return '';
  }

  const label = DIRECTION_LABELS[moves[moves.length - 1].direction];

  if (moves.length === 1) {
    return `${label}.`;
  }

  return `${moves.length} moves, last ${label.toLowerCase()}.`;
}

/**
 * Composes the merge clause.
 *
 * Every merge of one flush collapses into this single clause, which names the
 * count, each resulting value and the points they added together.
 *
 * @param merges Merges in the order they were announced.
 * @returns The clause, or an empty string where there were none.
 */
function describeMerges(merges: readonly MergeAnnouncement[]): string {
  if (merges.length === 0) {
    return '';
  }

  const values: string[] = [];
  let total = 0;

  for (const merge of merges) {
    values.push(String(merge.resultValue));
    total += merge.scoreDelta;
  }

  const head =
    merges.length === 1
      ? `Merged into ${values[0]}.`
      : `${merges.length} merges: ${values.join(VALUE_SEPARATOR)}.`;

  if (total <= 0) {
    return head;
  }

  const unit = pluralize(total, 'point', 'points');

  return `${head} Plus ${total} ${unit}.`;
}

/**
 * Composes the spawn clause, in 1-based coordinates.
 *
 * @param spawns Spawns in the order they were announced.
 * @returns The clause, or an empty string where there were none.
 */
function describeSpawns(spawns: readonly SpawnAnnouncement[]): string {
  if (spawns.length === 0) {
    return '';
  }

  if (spawns.length > 1) {
    const unit = pluralize(spawns.length, 'tile', 'tiles');

    return `${spawns.length} new ${unit}.`;
  }

  const spawn = spawns[0];
  const position = spawn.position;

  if (position === undefined) {
    return `New ${spawn.value}.`;
  }

  const column = position.x + HUMAN_INDEX_OFFSET;
  const row = position.y + HUMAN_INDEX_OFFSET;

  return `New ${spawn.value} at column ${column}, row ${row}.`;
}

/**
 * Composes the stage clause, in 1-based stage numbers.
 *
 * @param stages Stage ends in the order they were announced.
 * @returns The clause, or an empty string where there were none.
 */
function describeStages(stages: readonly StageClearAnnouncement[]): string {
  if (stages.length === 0) {
    return '';
  }

  const stage = stages[stages.length - 1];
  const number = stage.stageIndex + HUMAN_INDEX_OFFSET;

  return stage.cleared ? `Stage ${number} cleared.` : `Stage ${number} ended.`;
}

/**
 * Composes the score clause from the last changed move of a flush.
 *
 * @param moves Changed moves in the order they were announced.
 * @returns The clause, or an empty string where there were none.
 */
function describeScore(moves: readonly MoveAnnouncement[]): string {
  if (moves.length === 0) {
    return '';
  }

  return `${SCORE_LABEL} ${moves[moves.length - 1].score}.`;
}

/**
 * Composes a relic-acquisition utterance.
 *
 * A blank name or a blank rarity is omitted from the line.
 *
 * @param item The relic taken.
 * @returns One line.
 */
function describeRelic(item: RelicAcquiredAnnouncement): string {
  const name = item.name;
  const rarity = item.rarity;
  let head = RELIC_ACQUIRED_LABEL;

  if (name !== '' && rarity !== '') {
    head = `${RELIC_ACQUIRED_LABEL}: ${name}, ${rarity}`;
  } else if (name !== '') {
    head = `${RELIC_ACQUIRED_LABEL}: ${name}`;
  } else if (rarity !== '') {
    head = `${RELIC_ACQUIRED_LABEL}: ${rarity}`;
  }

  const charges = item.charges;

  if (charges === undefined) {
    return `${head}.`;
  }

  const unit = pluralize(charges, 'charge', 'charges');

  return `${head}. ${charges} ${unit}.`;
}

/**
 * Composes a verdict utterance.
 *
 * @param item The verdict.
 * @returns One line, opening with the js/html_actuator.js L129 wording.
 */
function describeTerminal(item: TerminalAnnouncement): string {
  const verdict = TERMINAL_VERDICT_LABELS[item.verdict];
  const score = item.score;

  if (score === undefined) {
    return verdict;
  }

  return `${verdict} ${FINAL_SCORE_LABEL} ${score}.`;
}

/**
 * Drops each utterance identical to the one before it.
 *
 * @param utterances Utterances in composition order.
 * @returns The retained utterances and the number dropped.
 */
function collapseRepeats(utterances: readonly Utterance[]): {
  readonly kept: readonly Utterance[];
  readonly collapsed: number;
} {
  const kept: Utterance[] = [];
  let collapsed = 0;

  for (const utterance of utterances) {
    if (kept.length > 0) {
      const previous = kept[kept.length - 1];

      if (
        previous.text === utterance.text &&
        previous.polarity === utterance.polarity
      ) {
        collapsed += 1;

        continue;
      }
    }

    kept.push(utterance);
  }

  return { kept: Object.freeze(kept), collapsed };
}

/**
 * Coalesces a batch of announcements into the smallest correct set of lines.
 *
 * Pure: it reads nothing, writes nothing and reports nothing, so a caller and
 * a test both compose the same batch to the same result. An argument that is
 * not an array composes to nothing, and each item is passed through
 * `normalizeAnnouncement` first, so no clause below can read a field as
 * `undefined` and no line can contain `NaN`, `null` or `undefined`.
 *
 * The rules it applies, in order:
 *
 * 1. A move that changed nothing contributes nothing and is counted.
 * 2. A verdict supersedes every gameplay kind of the batch, which are
 *    counted; `relicAcquired` and `text` items survive it.
 * 3. The surviving gameplay items become ONE line whose clauses are the move,
 *    the merges, the spawn, the stage and the score, in that order.
 * 4. `relicAcquired` and `text` items each become one line, in the order they
 *    were announced.
 * 5. The verdict becomes the last line, written with `ASSERTIVE_POLARITY`.
 * 6. A line identical to the one before it is dropped and counted.
 *
 * @param items Normalised announcements in the order they were announced.
 * @returns The lines to write and the three coalescing counts.
 */
export function composeAnnouncements(
  items: readonly Announcement[],
): Composition {
  const source: readonly Announcement[] = Array.isArray(items) ? items : [];
  const moves: MoveAnnouncement[] = [];
  const merges: MergeAnnouncement[] = [];
  const spawns: SpawnAnnouncement[] = [];
  const stages: StageClearAnnouncement[] = [];
  const others: (RelicAcquiredAnnouncement | TextAnnouncement)[] = [];
  let terminal: TerminalAnnouncement | null = null;
  let unchangedMoves = 0;

  for (const candidate of source) {
    // Normalisation is idempotent, so an item that already came through
    // `announce` is unchanged, and one that did not can hold no field a
    // clause below would read as `undefined`.
    const item = normalizeAnnouncement(candidate);

    if (item === null) {
      continue;
    }

    switch (item.kind) {
      case 'move':
        if (item.changed) {
          moves.push(item);
        } else {
          unchangedMoves += 1;
        }
        break;
      case 'merge':
        merges.push(item);
        break;
      case 'spawn':
        spawns.push(item);
        break;
      case 'stageClear':
        stages.push(item);
        break;
      case 'relicAcquired':
        others.push(item);
        break;
      case 'text':
        others.push(item);
        break;
      case 'terminal':
        terminal = item;
        break;
      default:
        unhandledKind(item);
        break;
    }
  }

  const composed: Utterance[] = [];
  let superseded = 0;

  if (terminal === null) {
    const gameplay = joinClauses([
      describeMoves(moves),
      describeMerges(merges),
      describeSpawns(spawns),
      describeStages(stages),
      describeScore(moves),
    ]);

    if (gameplay !== '') {
      composed.push({ text: gameplay, polarity: DEFAULT_POLARITY });
    }
  } else {
    superseded =
      moves.length + merges.length + spawns.length + stages.length;
  }

  for (const item of others) {
    if (item.kind === 'relicAcquired') {
      composed.push({
        text: describeRelic(item),
        polarity: DEFAULT_POLARITY,
      });
    } else {
      composed.push({
        text: item.text,
        polarity: item.polarity ?? DEFAULT_POLARITY,
      });
    }
  }

  if (terminal !== null) {
    composed.push({
      text: describeTerminal(terminal),
      polarity: ASSERTIVE_POLARITY,
    });
  }

  const { kept, collapsed } = collapseRepeats(composed);

  return Object.freeze({
    utterances: kept,
    superseded,
    collapsed,
    unchangedMoves,
  });
}

/* ==========================================================================
 * 6. Task scheduling
 * ========================================================================== */

/** A scheduled task that has not run, and the means to prevent it running. */
export interface ScheduledAnnouncerTask {
  /** Prevents the callback running. Calling it more than once is harmless. */
  cancel(): void;
}

/** Schedules `callback` on a later task of the same event loop. */
export type AnnouncerScheduler = (
  callback: () => void,
) => ScheduledAnnouncerTask;

/** Delay a deferred task is scheduled with. */
const ZERO_DELAY = 0;

/** A token whose callback has already run or cannot be cancelled. */
const NOOP_TASK: ScheduledAnnouncerTask = Object.freeze({
  cancel(): void {
    return;
  },
});

/** Returned in place of a real unsubscribe where a subscription failed. */
const NOOP_UNSUBSCRIBE = (): void => {
  return;
};

/**
 * The scheduler used where the caller supplies none.
 *
 * A zero-delay task where the environment supplies `setTimeout`, a microtask
 * where it supplies only `queueMicrotask`, and the caller's own stack where it
 * supplies neither. A frame callback is never used: src/render/render-loop.ts
 * owns the frame loop and this module does not reach into it.
 *
 * @param reporter Sink the absence of a scheduler is reported through.
 * @returns A scheduler that throws for nothing.
 */
export function createDefaultScheduler(
  reporter: UiReporter = NOOP_UI_REPORTER,
): AnnouncerScheduler {
  const sink = createSafeUiReporter(reporter);

  return (callback: () => void): ScheduledAnnouncerTask => {
    if (typeof setTimeout === 'function') {
      const handle = setTimeout(callback, ZERO_DELAY);

      return {
        cancel(): void {
          clearTimeout(handle);
        },
      };
    }

    if (typeof queueMicrotask === 'function') {
      let cancelled = false;

      queueMicrotask((): void => {
        if (!cancelled) {
          callback();
        }
      });

      return {
        cancel(): void {
          cancelled = true;
        },
      };
    }

    sink.log('warn', 'live region has no task scheduler', {
      fallback: 'inline',
    });
    sink.count(SCHEDULER_ABSENT_METRIC);
    callback();

    return NOOP_TASK;
  };
}

/* ==========================================================================
 * 7. Options and the public surface
 * ========================================================================== */

/** Selector of the announcer region index.html L105 declares. */
export const DEFAULT_LIVE_REGION_SELECTOR = '#live-region';

/** Class style/_a11y.scss L157-L170 hides the region with. */
export const VISUALLY_HIDDEN_CLASS = 'visually-hidden';

/** Announcements held before the queue bound starts discarding. */
export const DEFAULT_MAX_QUEUED_ANNOUNCEMENTS = 32;

/** `aria-atomic` value index.html L105 declares. */
const ARIA_TRUE = 'true';

/** Role each polarity is given where the markup declares no live semantics. */
const REGION_ROLES = Object.freeze({
  polite: 'status',
  assertive: 'alert',
} as const satisfies Readonly<Record<AnnouncementPolarity, string>>);

/** Stated where a forced number-only mode arrives with no reason. */
const UNSTATED_REASON = 'Reason not stated';

/** A source of preference changes. `PreferenceStore` satisfies it. */
export interface PreferenceAnnouncementSource {
  /**
   * Registers a listener and returns its unsubscribe function.
   *
   * @param listener Callback invoked after a preference changes.
   * @returns Function that removes `listener`.
   */
  subscribe(
    listener: (
      preferences: UiPreferences,
      changed: readonly PreferenceKey[],
    ) => void,
  ): () => void;
}

/** What `createLiveRegionAnnouncer` accepts. Every field has a default. */
export interface LiveRegionAnnouncerOptions {
  /**
   * The region itself, where the caller resolved it already. This is the form
   * src/ui/screen-router.ts uses, having resolved its whole mount set once at
   * boot. `null` states that there is none and disables the announcer.
   */
  readonly region?: Element | null;

  /**
   * Selector the region is resolved from where no element is supplied.
   * Defaults to `DEFAULT_LIVE_REGION_SELECTOR`.
   */
  readonly selector?: string;

  /**
   * A second region assertive utterances are written to. Supply it only where
   * the markup declares a polite and an assertive region; index.html L105
   * declares one region, so this is absent by default and both polarities are
   * written to `region`.
   */
  readonly assertiveRegion?: Element | null;

  /**
   * Selector the assertive region is resolved from. Absent by default, and no
   * miss is reported for a region nobody configured.
   */
  readonly assertiveSelector?: string;

  /** Node the selectors are resolved against. Defaults to the document. */
  readonly root?: MountRoot | null;

  /** Sink every report is made through. Defaults to `NOOP_UI_REPORTER`. */
  readonly reporter?: UiReporter;

  /** Label carried into every report. Defaults to `ui.liveRegion`. */
  readonly context?: string;

  /**
   * Announcements the queue holds before it discards the oldest gameplay
   * items. Defaults to `DEFAULT_MAX_QUEUED_ANNOUNCEMENTS`. A value that is
   * not a positive integer is reported and the default is used.
   */
  readonly maxQueued?: number;

  /**
   * Scheduler the deferred flush and the write sequence run on. Defaults to
   * `createDefaultScheduler`.
   */
  readonly schedule?: AnnouncerScheduler;

  /**
   * Whether a queue the caller has not flushed flushes itself on a later
   * task. Defaults to `true`.
   */
  readonly autoFlush?: boolean;

  /**
   * Renders a theme id as the prose name a preference change is announced
   * with. Defaults to reading the id with its hyphens as spaces. src/main.ts
   * supplies the `name` of the src/theme/themes.ts catalogue entry, the
   * module this one does not import.
   */
  readonly describeTheme?: (theme: string) => string;
}

/**
 * The announcer src/ui/screen-router.ts receives through
 * `ScreenRouterOptions` and drives.
 *
 * No member throws, and every member is a safe no-op once the region is
 * unavailable or `destroy()` has been called.
 */
export interface LiveRegionAnnouncer {
  /**
   * Enqueues one announcement. It writes nothing: composition and the DOM
   * write happen at the next `flush()`, or on a later task where auto-flush
   * is on.
   *
   * @param input The announcement.
   */
  announce(input: Announcement): void;

  /**
   * Enqueues free text, for a screen transition, a preference change or a
   * fallback notice.
   *
   * @param text Text to speak. Trimmed; an empty result is rejected.
   * @param polarity Urgency. Defaults to `DEFAULT_POLARITY`.
   */
  announceText(text: string, polarity?: AnnouncementPolarity): void;

  /**
   * Composes everything queued and starts writing it. The caller calls this
   * at the `state:commit` turn boundary.
   */
  flush(): void;

  /** Empties the queue, the pending lines and the region text. */
  clear(): void;

  /**
   * Announcements queued plus lines composed and not yet written.
   *
   * @returns The pending depth.
   */
  pending(): number;

  /**
   * Whether a region is available and `destroy()` has not been called.
   *
   * @returns Whether announcements reach a region.
   */
  isEnabled(): boolean;

  /**
   * Announces a preference change for as long as the returned function is
   * uncalled. The subscription src/ui/a11y/settings.ts L1104-L1108 names.
   *
   * @param source Preference store to observe.
   * @returns Function that stops the announcements.
   */
  observePreferences(source: PreferenceAnnouncementSource): () => void;

  /**
   * Cancels every scheduled task, empties the queue and the pending lines,
   * and releases the region references. Every member is a no-op afterwards,
   * and calling it more than once is harmless.
   */
  destroy(): void;
}

/* ==========================================================================
 * 8. Region resolution, queue bound and preference copy
 * ========================================================================== */

/** Where the write sequence is: idle, about to clear, or about to write. */
type WritePhase = 'idle' | 'clear' | 'write';

/** One region a resolution was asked for. */
interface RegionRequest {
  /** Element the caller resolved already, if any. */
  readonly supplied: Element | null | undefined;

  /** Selector to resolve where no element was supplied. */
  readonly selector: string | undefined;

  /** Logical name of the region, carried into every report. */
  readonly name: string;

  /** Node the selector is resolved against. */
  readonly root: MountRoot | null | undefined;

  /** Whether the absence of this region is worth reporting. */
  readonly required: boolean;
}

/**
 * Resolves one region without asserting and without throwing.
 *
 * @param request The region asked for.
 * @param reporter Contained sink.
 * @param context Label naming the caller.
 * @returns The region, or `null`.
 */
function resolveRegion(
  request: RegionRequest,
  reporter: UiReporter,
  context: string,
): Element | null {
  if (request.supplied !== undefined) {
    if (request.supplied === null && request.required) {
      reporter.log('warn', 'live region supplied as absent', {
        region: request.name,
        context,
      });
      reporter.count(HOST_MISSING_METRIC, {
        region: request.name,
        reason: 'supplied-null',
        context,
      });
    }

    return request.supplied;
  }

  const selector = request.selector;

  if (selector === undefined || selector === '') {
    if (request.required) {
      reporter.log('warn', 'live region has no selector', {
        region: request.name,
        context,
      });
      reporter.count(HOST_MISSING_METRIC, {
        region: request.name,
        reason: 'no-selector',
        context,
      });
    }

    return null;
  }

  const found = resolveMount<HTMLElement>(selector, {
    root: request.root,
    reporter,
    context,
    name: request.name,
  });

  if (found === null) {
    reporter.log('warn', 'live region not found', {
      region: request.name,
      selector,
      context,
    });
    reporter.count(HOST_MISSING_METRIC, {
      region: request.name,
      selector,
      reason: 'no-match',
      context,
    });
  }

  return found;
}

/**
 * Records one attribute or class the markup left off and this module added.
 *
 * @param region Logical name of the region.
 * @param attribute What was added.
 * @param reporter Contained sink.
 * @param context Label naming the caller.
 */
function reportRemediation(
  region: string,
  attribute: string,
  reporter: UiReporter,
  context: string,
): void {
  reporter.log('info', 'live region semantics completed', {
    region,
    attribute,
    context,
  });
  reporter.count(REMEDIATED_METRIC, { region, attribute, context });
}

/**
 * Completes a region's semantics once, at construction.
 *
 * index.html L105 already declares `class`, `role`, `aria-live` and
 * `aria-atomic`, so on that markup this function changes nothing and reports
 * nothing. Where an attribute is absent it is added and the addition is
 * reported; where `aria-live` is already present it is left exactly as
 * declared, and it is never written again after this call.
 *
 * A `hidden` attribute is removed: an element carrying it is not in the
 * accessibility tree. No style property is assigned; the visually-hidden
 * treatment is `VISUALLY_HIDDEN_CLASS`, defined at style/_a11y.scss L168.
 *
 * @param region The region.
 * @param polarity Polarity the region serves.
 * @param name Logical name of the region.
 * @param reporter Contained sink.
 * @param context Label naming the caller.
 */
function prepareRegion(
  region: Element,
  polarity: AnnouncementPolarity,
  name: string,
  reporter: UiReporter,
  context: string,
): void {
  try {
    const hadAriaLive = region.hasAttribute('aria-live');
    const hadRole = region.hasAttribute('role');

    if (!region.classList.contains(VISUALLY_HIDDEN_CLASS)) {
      region.classList.add(VISUALLY_HIDDEN_CLASS);
      reportRemediation(name, 'class', reporter, context);
    }

    if (region.hasAttribute('hidden')) {
      region.removeAttribute('hidden');
      reportRemediation(name, 'hidden', reporter, context);
    }

    if (!hadAriaLive) {
      region.setAttribute('aria-live', polarity);
      reportRemediation(name, 'aria-live', reporter, context);
    }

    if (!hadAriaLive && !hadRole) {
      region.setAttribute('role', REGION_ROLES[polarity]);
      reportRemediation(name, 'role', reporter, context);
    }

    if (!region.hasAttribute('aria-atomic')) {
      region.setAttribute('aria-atomic', ARIA_TRUE);
      reportRemediation(name, 'aria-atomic', reporter, context);
    }

    reporter.count(MOUNTED_METRIC, { region: name, polarity, context });
  } catch (error: unknown) {
    reporter.error('live region could not be prepared', error, {
      region: name,
      context,
    });
    reporter.count(PREPARE_FAILED_METRIC, { region: name, context });
  }
}

/**
 * Resolves the queue bound, reporting a value that cannot be used.
 *
 * @param requested Bound the caller asked for, if any.
 * @param reporter Contained sink.
 * @param context Label naming the caller.
 * @returns A positive integer.
 */
function resolveCapacity(
  requested: number | undefined,
  reporter: UiReporter,
  context: string,
): number {
  if (requested === undefined) {
    return DEFAULT_MAX_QUEUED_ANNOUNCEMENTS;
  }

  if (Number.isInteger(requested) && requested > 0) {
    return requested;
  }

  reporter.log('warn', 'live region queue bound rejected', {
    requested: String(requested),
    fallback: DEFAULT_MAX_QUEUED_ANNOUNCEMENTS,
    context,
  });
  reporter.count(CAPACITY_REJECTED_METRIC, { context });

  return DEFAULT_MAX_QUEUED_ANNOUNCEMENTS;
}

/**
 * Index of the oldest announcement the queue bound may discard.
 *
 * Gameplay kinds first, then free text. A `relicAcquired` and a `terminal`
 * are never returned, so neither is ever discarded by the bound.
 *
 * @param items The queue.
 * @returns The index, or `NOT_FOUND` where nothing may be discarded.
 */
function indexOfDroppable(items: readonly Announcement[]): number {
  for (let index = 0; index < items.length; index += 1) {
    if (isGameplayAnnouncementKind(items[index].kind)) {
      return index;
    }
  }

  for (let index = 0; index < items.length; index += 1) {
    if (items[index].kind === 'text') {
      return index;
    }
  }

  return NOT_FOUND;
}

/**
 * Reads a theme id as prose.
 *
 * @param theme The id.
 * @returns The id with each hyphen read as a space.
 */
function humanizeThemeId(theme: string): string {
  return theme.split(THEME_ID_SEPARATOR).join(CLAUSE_SEPARATOR);
}

/**
 * Renders a 0-to-1 volume as a whole-number percentage.
 *
 * @param volume The volume.
 * @returns A percentage.
 */
function describeVolume(volume: number): number {
  if (!Number.isFinite(volume)) {
    return 0;
  }

  return Math.round(volume * PERCENT_SCALE);
}

/**
 * Builds a polite free-text announcement.
 *
 * @param text The text.
 * @returns The announcement.
 */
function politeText(text: string): TextAnnouncement {
  return Object.freeze({
    kind: 'text',
    text,
    polarity: DEFAULT_POLARITY,
  } as const);
}

/**
 * Composes the announcement for one changed preference.
 *
 * A forced number-only mode is the one preference written with
 * `ASSERTIVE_POLARITY`; every other change is polite.
 *
 * @param key Preference that changed.
 * @param preferences Snapshot that now holds.
 * @param describeTheme Renders a theme id as prose.
 * @returns The announcement, or `null` where the key is not modelled.
 */
function describePreferenceChange(
  key: PreferenceKey,
  preferences: UiPreferences,
  describeTheme: (theme: string) => string,
): TextAnnouncement | null {
  switch (key) {
    case 'reducedMotion':
      return politeText(
        preferences.reducedMotion
          ? 'Reduced motion on.'
          : 'Reduced motion off.',
      );

    case 'theme':
      return politeText(`Theme: ${describeTheme(preferences.theme)}.`);

    case 'numberOnlyMode': {
      if (!preferences.numberOnlyMode) {
        return politeText('Number-only mode off.');
      }

      const force = preferences.numberOnlyForce;

      if (!force.forced) {
        return politeText('Number-only mode on.');
      }

      const reason =
        force.reason === null || force.reason === ''
          ? UNSTATED_REASON
          : force.reason;

      return Object.freeze({
        kind: 'text',
        text: `Number-only mode on. ${reason}.`,
        polarity: ASSERTIVE_POLARITY,
      } as const);
    }

    case 'muted':
      return politeText(preferences.muted ? 'Sound muted.' : 'Sound on.');

    case 'volume':
      return politeText(
        `Volume ${describeVolume(preferences.volume)} percent.`,
      );

    default:
      unhandledKind(key);

      return null;
  }
}

/* ==========================================================================
 * 9. The announcer
 * ========================================================================== */

/**
 * Builds the announcer.
 *
 * The region is resolved once here and held. Where it cannot be resolved the
 * miss is reported with the selector that produced it and every member of the
 * returned announcer becomes a safe no-op.
 *
 * @param options Region, sink, queue bound, scheduler and copy hooks.
 * @returns An announcer no member of which throws.
 */
export function createLiveRegionAnnouncer(
  options: LiveRegionAnnouncerOptions = {},
): LiveRegionAnnouncer {
  const raw: unknown = options;
  const settings: LiveRegionAnnouncerOptions =
    raw === null || typeof raw !== 'object' ? {} : options;
  const reporter = createSafeUiReporter(settings.reporter ?? NOOP_UI_REPORTER);
  const context = settings.context ?? DEFAULT_CONTEXT;
  const schedule = settings.schedule ?? createDefaultScheduler(reporter);
  const autoFlush = settings.autoFlush !== false;
  const capacity = resolveCapacity(settings.maxQueued, reporter, context);
  const describeTheme = settings.describeTheme ?? humanizeThemeId;
  const politeSelector = settings.selector ?? DEFAULT_LIVE_REGION_SELECTOR;

  let politeRegion: Element | null = resolveRegion(
    {
      supplied: settings.region,
      selector: politeSelector,
      name: 'polite',
      root: settings.root,
      required: true,
    },
    reporter,
    context,
  );
  let assertiveRegion: Element | null = resolveRegion(
    {
      supplied: settings.assertiveRegion,
      selector: settings.assertiveSelector,
      name: 'assertive',
      root: settings.root,
      required: false,
    },
    reporter,
    context,
  );

  if (politeRegion !== null) {
    prepareRegion(politeRegion, 'polite', 'polite', reporter, context);
  }

  if (assertiveRegion !== null) {
    prepareRegion(assertiveRegion, 'assertive', 'assertive', reporter, context);
  }

  const queue: Announcement[] = [];
  const outbox: Utterance[] = [];
  let destroyed = false;
  let phase: WritePhase = 'idle';
  let flushPending = false;
  let flushTask: ScheduledAnnouncerTask | null = null;
  let writePending = false;
  let writeTask: ScheduledAnnouncerTask | null = null;

  /**
   * Whether announcements can reach a region at all.
   *
   * @returns Whether the announcer is a no-op.
   */
  function disabled(): boolean {
    return destroyed || (politeRegion === null && assertiveRegion === null);
  }

  /**
   * The region a polarity is written to.
   *
   * Where the markup declares one region, as index.html L105 does, both
   * polarities resolve to it and its `aria-live` attribute is left alone.
   *
   * @param polarity Polarity to route.
   * @returns The region, or `null`.
   */
  function regionFor(polarity: AnnouncementPolarity): Element | null {
    if (polarity === 'assertive' && assertiveRegion !== null) {
      return assertiveRegion;
    }

    return politeRegion ?? assertiveRegion;
  }

  /**
   * Writes one string to the region a polarity routes to.
   *
   * @param polarity Polarity to route.
   * @param text Text to write. An empty string is the clear half of the
   *   clear-then-write sequence.
   * @returns Whether the write landed.
   */
  function writeText(polarity: AnnouncementPolarity, text: string): boolean {
    const region = regionFor(polarity);

    if (region === null) {
      reporter.count(DISABLED_METRIC, { polarity, reason: 'no-region' });

      return false;
    }

    try {
      region.textContent = text;

      return true;
    } catch (error: unknown) {
      reporter.error('live region write failed', error, {
        polarity,
        context,
      });
      reporter.count(WRITE_FAILED_METRIC, { polarity, context });

      return false;
    }
  }

  /**
   * Schedules a callback, running it inline where the scheduler refuses.
   *
   * @param callback Work to defer.
   * @returns The task token.
   */
  function deferTask(callback: () => void): ScheduledAnnouncerTask {
    try {
      return schedule(callback);
    } catch (error: unknown) {
      reporter.error('live region could not schedule a task', error, {
        context,
      });
      reporter.count(SCHEDULER_ABSENT_METRIC, { context });
      callback();

      return NOOP_TASK;
    }
  }

  /** Cancels a scheduled flush, if there is one. */
  function cancelFlush(): void {
    const task = flushTask;

    flushTask = null;
    flushPending = false;

    if (task === null) {
      return;
    }

    try {
      task.cancel();
    } catch (error: unknown) {
      reporter.error('live region flush task would not cancel', error, {
        context,
      });
    }
  }

  /** Cancels a scheduled write step, if there is one. */
  function cancelWrite(): void {
    const task = writeTask;

    writeTask = null;
    writePending = false;

    if (task === null) {
      return;
    }

    try {
      task.cancel();
    } catch (error: unknown) {
      reporter.error('live region write task would not cancel', error, {
        context,
      });
    }
  }

  /** Schedules the next step of the write sequence. */
  function scheduleWriteStep(): void {
    if (writePending) {
      return;
    }

    writePending = true;

    const task = deferTask((): void => {
      writePending = false;
      writeTask = null;
      runWriteStep();
    });

    // False where `deferTask` ran the callback inline, in which case the
    // token is spent and holding it would block the next step.
    if (writePending) {
      writeTask = task;
    }
  }

  /**
   * Runs one step of the write sequence: a clear, or one utterance.
   *
   * The clear and the write occupy separate tasks: the region is emptied in
   * one task and the utterance is written in the next.
   */
  function runWriteStep(): void {
    if (destroyed || outbox.length === 0) {
      phase = 'idle';

      return;
    }

    if (phase === 'clear') {
      writeText(outbox[0].polarity, '');
      phase = 'write';
      scheduleWriteStep();

      return;
    }

    if (phase === 'write') {
      const utterance = outbox[0];

      outbox.splice(0, 1);

      if (writeText(utterance.polarity, utterance.text)) {
        reporter.count(UTTERED_METRIC, {
          polarity: utterance.polarity,
          length: utterance.text.length,
        });
      }

      if (outbox.length > 0) {
        phase = 'clear';
        scheduleWriteStep();

        return;
      }
    }

    phase = 'idle';
  }

  /** Starts the write sequence where it is not already running. */
  function driveWrites(): void {
    if (phase !== 'idle' || outbox.length === 0) {
      return;
    }

    phase = 'clear';
    runWriteStep();
  }

  /** Schedules a flush of an unflushed queue. */
  function scheduleFlush(): void {
    if (!autoFlush || flushPending || queue.length === 0) {
      return;
    }

    flushPending = true;

    const task = deferTask((): void => {
      flushPending = false;
      flushTask = null;
      flush();
    });

    if (flushPending) {
      flushTask = task;
    }
  }

  /** Brings the queue back within its bound, reporting what it discarded. */
  function enforceCapacity(): void {
    if (queue.length <= capacity) {
      return;
    }

    let dropped = 0;

    while (queue.length > capacity) {
      const index = indexOfDroppable(queue);

      if (index === NOT_FOUND) {
        break;
      }

      queue.splice(index, 1);
      dropped += 1;
    }

    if (dropped > 0) {
      reporter.log('warn', 'live region discarded queued announcements', {
        dropped,
        capacity,
        context,
      });
      reporter.count(DROPPED_METRIC, { dropped, capacity, context });
    }
  }

  /**
   * Enqueues one announcement.
   *
   * @param input The announcement.
   */
  function announce(input: Announcement): void {
    if (destroyed) {
      reporter.count(AFTER_DESTROY_METRIC, { method: 'announce' });

      return;
    }

    if (disabled()) {
      reporter.count(DISABLED_METRIC, { method: 'announce' });

      return;
    }

    const normalized = normalizeAnnouncement(input, reporter, context);

    if (normalized === null) {
      return;
    }

    queue.push(normalized);
    reporter.count(ANNOUNCED_METRIC, { kind: normalized.kind });
    enforceCapacity();
    scheduleFlush();
  }

  /**
   * Enqueues free text.
   *
   * @param text Text to speak.
   * @param polarity Urgency. Defaults to `DEFAULT_POLARITY`.
   */
  function announceText(
    text: string,
    polarity?: AnnouncementPolarity,
  ): void {
    announce({ kind: 'text', text, polarity });
  }

  /** Composes everything queued and starts writing it. */
  function flush(): void {
    cancelFlush();

    if (destroyed) {
      reporter.count(AFTER_DESTROY_METRIC, { method: 'flush' });

      return;
    }

    if (queue.length === 0) {
      driveWrites();

      return;
    }

    const composition = composeAnnouncements(
      queue.splice(0, queue.length),
    );

    if (composition.superseded > 0) {
      reporter.count(SUPERSEDED_METRIC, {
        superseded: composition.superseded,
      });
    }

    if (composition.collapsed > 0) {
      reporter.count(COLLAPSED_METRIC, { collapsed: composition.collapsed });
    }

    if (composition.unchangedMoves > 0) {
      reporter.count(UNCHANGED_MOVE_METRIC, {
        unchanged: composition.unchangedMoves,
      });
    }

    for (const utterance of composition.utterances) {
      outbox.push(utterance);
    }

    driveWrites();
  }

  /** Empties the queue, the pending lines and the region text. */
  function clear(): void {
    cancelFlush();
    cancelWrite();
    phase = 'idle';
    queue.length = 0;
    outbox.length = 0;

    if (politeRegion !== null) {
      writeText('polite', '');
    }

    if (assertiveRegion !== null) {
      writeText('assertive', '');
    }
  }

  /**
   * The pending depth.
   *
   * @returns Announcements queued plus lines composed and not yet written.
   */
  function pending(): number {
    return queue.length + outbox.length;
  }

  /**
   * Whether announcements reach a region.
   *
   * @returns Whether the announcer is live.
   */
  function isEnabled(): boolean {
    return !disabled();
  }

  /**
   * Announces one preference snapshot's changed keys.
   *
   * @param preferences Snapshot that now holds.
   * @param changed Keys that changed.
   */
  function announcePreferences(
    preferences: UiPreferences,
    changed: readonly PreferenceKey[],
  ): void {
    try {
      for (const key of changed) {
        const item = describePreferenceChange(
          key,
          preferences,
          describeTheme,
        );

        if (item !== null) {
          announce(item);
        }
      }
    } catch (error: unknown) {
      reporter.error('live region could not announce a preference', error, {
        context,
      });
      reporter.count(OBSERVE_FAILED_METRIC, { context });
    }
  }

  /**
   * Announces preference changes until the returned function is called.
   *
   * @param source Preference store to observe.
   * @returns Function that stops the announcements.
   */
  function observePreferences(
    source: PreferenceAnnouncementSource,
  ): () => void {
    if (destroyed) {
      reporter.count(AFTER_DESTROY_METRIC, { method: 'observePreferences' });

      return NOOP_UNSUBSCRIBE;
    }

    const raw: unknown = source;

    if (raw === null || typeof raw !== 'object') {
      reporter.log('warn', 'live region refused a preference source', {
        reason: 'not-an-object',
        context,
      });
      reporter.count(SUBSCRIBE_REFUSED_METRIC, { reason: 'not-an-object' });

      return NOOP_UNSUBSCRIBE;
    }

    const candidate: { readonly subscribe?: unknown } = raw;

    if (typeof candidate.subscribe !== 'function') {
      reporter.log('warn', 'live region refused a preference source', {
        reason: 'no-subscribe',
        context,
      });
      reporter.count(SUBSCRIBE_REFUSED_METRIC, { reason: 'no-subscribe' });

      return NOOP_UNSUBSCRIBE;
    }

    let unsubscribe: (() => void) | null = null;

    try {
      unsubscribe = source.subscribe(announcePreferences);
    } catch (error: unknown) {
      reporter.error('live region could not observe preferences', error, {
        context,
      });
      reporter.count(SUBSCRIBE_REFUSED_METRIC, { reason: 'threw' });

      return NOOP_UNSUBSCRIBE;
    }

    if (typeof unsubscribe !== 'function') {
      reporter.log('warn', 'live region received no unsubscribe', { context });
      reporter.count(SUBSCRIBE_REFUSED_METRIC, {
        reason: 'no-unsubscribe',
      });

      return NOOP_UNSUBSCRIBE;
    }

    const release = unsubscribe;

    return (): void => {
      try {
        release();
      } catch (error: unknown) {
        reporter.error('live region would not stop observing', error, {
          context,
        });
      }
    };
  }

  /** Cancels every task, empties every buffer and releases the regions. */
  function destroy(): void {
    if (destroyed) {
      return;
    }

    destroyed = true;
    cancelFlush();
    cancelWrite();
    phase = 'idle';
    queue.length = 0;
    outbox.length = 0;
    politeRegion = null;
    assertiveRegion = null;
    reporter.count(DESTROYED_METRIC, { context });
  }

  if (disabled()) {
    reporter.log('warn', 'live region announcer degraded to a no-op', {
      selector: politeSelector,
      context,
    });
  }

  return Object.freeze({
    announce,
    announceText,
    flush,
    clear,
    pending,
    isEnabled,
    observePreferences,
    destroy,
  });
}
