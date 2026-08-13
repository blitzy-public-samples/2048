// The announcement queue behind the `aria-live` region declared in index.html:
// announcements are enqueued, coalesced into the smallest correct set of
// utterances, and written to that region one utterance per task.
//
// The region's visually-hidden treatment is the `.visually-hidden` class of
// style/_a11y.scss, which clips the paint region and keeps the box. Nothing
// here assigns a style property, and no hiding mechanism that would take the
// region out of the accessibility tree is used anywhere in this module.
//
// No exported function throws. A missing region, an environment with no task
// scheduler, an unrecognised announcement, a non-finite number, an absent
// spawn position, a refused subscription, a throwing listener and a failed DOM
// write are each reported through the injected sink and the call continues.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated, all target-only because the retired sources
// announced nothing:
//   TR-LIVE-01  `createLiveRegionAnnouncer` and the single `#live-region` host
//   TR-LIVE-02  the announcement queue and its bound
//   TR-LIVE-03  `composeAnnouncements` and the coalescing rules
//   TR-LIVE-04  the clear-then-write sequence, one utterance per task
//   TR-LIVE-05  the polite default and the two assertive options
//   TR-LIVE-06  the move, merge and spawn announcement vocabulary
//   TR-LIVE-07  the stage and score announcement vocabulary
//   TR-LIVE-08  `TerminalVerdict` and its labels
//   TR-LIVE-09  the injected report sink and the per-listener error isolation
//
// Decisions: DL-LIVE-01, DL-LIVE-02, DL-LIVE-03, DL-LIVE-04, DL-LIVE-07
// (docs/DECISION_LOG.md).

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

const MOUNTED_METRIC = 'ui.liveRegion.mounted';

const HOST_MISSING_METRIC = 'ui.liveRegion.host.missing';

const REMEDIATED_METRIC = 'ui.liveRegion.host.remediated';

const PREPARE_FAILED_METRIC = 'ui.liveRegion.host.prepareFailed';

const ANNOUNCED_METRIC = 'ui.liveRegion.announced';

const REJECTED_METRIC = 'ui.liveRegion.rejected';

const NUMBER_REPLACED_METRIC = 'ui.liveRegion.number.replaced';

/**
 * Counter raised with the number of announcements the bound discarded, and
 * with how many of those were a `relicAcquired` or a `terminal`.
 */
const DROPPED_METRIC = 'ui.liveRegion.dropped';

/**
 * Counter raised with the number of PROTECTED announcements the bound
 * discarded, which is its last resort.
 */
const DROPPED_PROTECTED_METRIC = 'ui.liveRegion.dropped.protected';

/**
 * Counter raised with the number of pending utterances the bound discarded.
 */
const OUTBOX_DROPPED_METRIC = 'ui.liveRegion.outbox.dropped';

/** Counter raised where an assertive request is served politely instead. */
const ASSERTIVE_DOWNGRADE_METRIC = 'ui.liveRegion.assertive.downgraded';

/** Counter raised where an assertive region is created by this module. */
const ASSERTIVE_CREATED_METRIC = 'ui.liveRegion.assertive.created';

/**
 * Counter raised per `clearAssertive` call, carrying the queued announcements
 * and the pending utterances the clear discarded and whether the write sequence
 * had to be restarted. DL-LIVE-07.
 */
const ASSERTIVE_CLEARED_METRIC = 'ui.liveRegion.assertive.cleared';

/** Counter raised with the number of items a verdict superseded. */
const SUPERSEDED_METRIC = 'ui.liveRegion.superseded';

const COLLAPSED_METRIC = 'ui.liveRegion.collapsed';

const UNCHANGED_MOVE_METRIC = 'ui.liveRegion.move.unchanged';

const UTTERED_METRIC = 'ui.liveRegion.uttered';

const WRITE_FAILED_METRIC = 'ui.liveRegion.write.failed';

const DISABLED_METRIC = 'ui.liveRegion.disabled';

const CAPACITY_REJECTED_METRIC = 'ui.liveRegion.capacity.rejected';

const SCHEDULER_ABSENT_METRIC = 'ui.liveRegion.scheduler.absent';

const SUBSCRIBE_REFUSED_METRIC = 'ui.liveRegion.preferences.refused';

const OBSERVE_FAILED_METRIC = 'ui.liveRegion.preferences.failed';

const DESTROYED_METRIC = 'ui.liveRegion.destroyed';

const AFTER_DESTROY_METRIC = 'ui.liveRegion.afterDestroy';

const DEFAULT_CONTEXT = 'ui.liveRegion';

/**
 * The four move directions, restating `Direction` of src/engine/types.ts and
 * the `DIRECTION_*` constants of src/input/keymap.ts so this module imports
 * neither.
 *
 * `0` is up, `1` right, `2` down and `3` left, the order `Direction` and its
 * `DIRECTION_*` constants declare.
 */
export type AnnouncedDirection = 0 | 1 | 2 | 3;

/** Urgency an utterance is written with. */
export type AnnouncementPolarity = 'polite' | 'assertive';

/** The polarity every announcement carries unless it states another. */
export const DEFAULT_POLARITY: AnnouncementPolarity = 'polite';

/**
 * The polarity a run verdict is written with, and the one a forced number-only
 * fallback notice is written with. No other announcement uses it.
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

const RELIC_ACQUIRED_LABEL = 'Relic acquired';

const FINAL_SCORE_LABEL = 'Final score';

const SCORE_LABEL = 'Score';

const HUMAN_INDEX_OFFSET = 1;

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
 * bound discards first. `text` is discarded after these, and `relicAcquired`
 * and `terminal` only once nothing else remains — the bound is a hard one, so
 * no kind is exempt from it.
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
 * `changed` is the engine's own `moved` flag. A move that changed no position
 * spawns no tile. Such a move is composed into nothing.
 */
export interface MoveAnnouncement {
  readonly kind: 'move';
  readonly direction: AnnouncedDirection;
  readonly changed: boolean;

  /** Score after the move. */
  readonly score: number;
}

/**
 * One merge. The engine emits `tile:merge` once per merge, so a single move
 * can produce more than one of these.
 */
export interface MergeAnnouncement {
  readonly kind: 'merge';
  readonly resultValue: number;
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
  readonly kind: 'spawn';
  readonly value: number;
  readonly position?: AnnouncedPosition | undefined;
}

/** The end of a stage. `stageIndex` is zero-based; the text is 1-based. */
export interface StageClearAnnouncement {
  readonly kind: 'stageClear';

  /** Zero-based index of the stage that ended. */
  readonly stageIndex: number;
  readonly cleared: boolean;
}

/**
 * A relic taken. Primitives only: the caller reduces a relic to these three
 * fields, so this module names no type of src/relics/.
 */
export interface RelicAcquiredAnnouncement {
  readonly kind: 'relicAcquired';
  readonly name: string;
  readonly rarity: string;
  readonly charges?: number | undefined;
}

/** A run verdict. Written with `ASSERTIVE_POLARITY`. */
export interface TerminalAnnouncement {
  readonly kind: 'terminal';
  readonly verdict: TerminalVerdict;
  readonly score?: number | undefined;
}

/** Free text: screen transitions, preference changes, fallback notices. */
export interface TextAnnouncement {
  readonly kind: 'text';
  readonly text: string;
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
  readonly text: string;
  readonly polarity: AnnouncementPolarity;
}

function unhandledKind(value: never): void {
  void value;
}

const REPLACED_NUMBER = 0;

const NOT_FOUND = -1;

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

/** Whether a value is one of the modelled kinds. */
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
 * Whether a kind the bound discards only as a last resort.
 *
 * The complement of the two kinds `indexOfEvictable` prefers: everything that
 * is neither a gameplay kind nor free text.
 *
 * @param kind Kind to test.
 * @returns Whether `kind` is protected from ordinary discarding.
 */
export function isProtectedAnnouncementKind(kind: AnnouncementKind): boolean {
  return !isGameplayAnnouncementKind(kind) && kind !== 'text';
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

function toCharges(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return undefined;
  }

  return value < 0 ? undefined : value;
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return value;
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

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
 * Every field is narrowed here, so no composed utterance can carry `NaN`,
 * `null` or `undefined`: a candidate whose kind, direction, verdict or text
 * cannot be used is rejected outright and reported, while a numeric field that
 * cannot be used is reported and replaced.
 *
 * @param input Candidate announcement, of any type. A value that is not an
 *   object, or whose `kind` is not one of the declared kinds, is rejected.
 * @param sink Report sink, contained at entry. Defaults to
 *   `NOOP_UI_REPORTER`.
 * @param context Label every rejection and every count is reported under.
 *   Defaults to `DEFAULT_CONTEXT`.
 * @returns The frozen announcement to enqueue, or `null` where it was
 *   rejected. Nothing throws for any input.
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

const CLAUSE_SEPARATOR = ' ';

const VALUE_SEPARATOR = ', ';

const SINGULAR_COUNT = 1;

const PERCENT_SCALE = 100;

const THEME_ID_SEPARATOR = '-';

/** What one composition produced, and what it discarded producing it. */
export interface Composition {
  /** The lines to write, in the order they are to be written. */
  readonly utterances: readonly Utterance[];
  readonly superseded: number;
  readonly collapsed: number;
  readonly unchangedMoves: number;
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === SINGULAR_COUNT ? singular : plural;
}

function joinClauses(clauses: readonly string[]): string {
  const present: string[] = [];

  for (const clause of clauses) {
    if (clause !== '') {
      present.push(clause);
    }
  }

  return present.join(CLAUSE_SEPARATOR);
}

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

function describeStages(stages: readonly StageClearAnnouncement[]): string {
  if (stages.length === 0) {
    return '';
  }

  const stage = stages[stages.length - 1];
  const number = stage.stageIndex + HUMAN_INDEX_OFFSET;

  return stage.cleared ? `Stage ${number} cleared.` : `Stage ${number} ended.`;
}

function describeScore(moves: readonly MoveAnnouncement[]): string {
  if (moves.length === 0) {
    return '';
  }

  return `${SCORE_LABEL} ${moves[moves.length - 1].score}.`;
}

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

function describeTerminal(item: TerminalAnnouncement): string {
  const verdict = TERMINAL_VERDICT_LABELS[item.verdict];
  const score = item.score;

  if (score === undefined) {
    return verdict;
  }

  return `${verdict} ${FINAL_SCORE_LABEL} ${score}.`;
}

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
 * The rules it applies, in order.
 */
export function composeAnnouncements(
  items: readonly Announcement[],
): Composition {
  const source: readonly Announcement[] = Array.isArray(items) ? items : [];
  const moves: MoveAnnouncement[] = [];
  const merges: MergeAnnouncement[] = [];
  const spawns: SpawnAnnouncement[] = [];
  const stages: StageClearAnnouncement[] = [];
  // SPLIT, where one `others` list held both in arrival order: a
  // `relicAcquired` is composed AFTER free text, so it is the line the region
  // is left holding. `GAMEPLAY_ANNOUNCEMENT_KINDS` above already records
  // `relicAcquired` as outranking `text` when the queue bound discards, and
  // each utterance is written on its own tick — so composing a pickup before a
  // text line left the pickup on the region for one tick and then replaced it.
  // DL-LIVE-05.
  const texts: TextAnnouncement[] = [];
  const relics: RelicAcquiredAnnouncement[] = [];
  let terminal: TerminalAnnouncement | null = null;
  let unchangedMoves = 0;

  for (const candidate of source) {
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
        relics.push(item);
        break;
      case 'text':
        texts.push(item);
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

  for (const item of texts) {
    composed.push({
      text: item.text,
      polarity: item.polarity ?? DEFAULT_POLARITY,
    });
  }

  // After the free text, so a pickup outlives it on the region. DL-LIVE-05.
  for (const item of relics) {
    composed.push({
      text: describeRelic(item),
      polarity: DEFAULT_POLARITY,
    });
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

/** A scheduled task that has not run, and the means to prevent it running. */
export interface ScheduledAnnouncerTask {
  cancel(): void;
}

/** Schedules `callback` on a later task of the same event loop. */
export type AnnouncerScheduler = (
  callback: () => void,
) => ScheduledAnnouncerTask;

const ZERO_DELAY = 0;

const NOOP_TASK: ScheduledAnnouncerTask = Object.freeze({
  cancel(): void {
    return;
  },
});

const NOOP_UNSUBSCRIBE = (): void => {
  return;
};

/**
 * The scheduler used where the caller supplies none.
 *
 * A zero-delay task where the environment supplies `setTimeout`, a microtask
 * where it supplies only `queueMicrotask`, and the caller's own stack where it
 * supplies neither, in which case the absence is reported. A frame callback is
 * never used: this module does not reach into the frame loop.
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

/** Selector of the announcer region index.html declares. */
export const DEFAULT_LIVE_REGION_SELECTOR = '#live-region';

/** Class style/_a11y.scss hides the region with. */
export const VISUALLY_HIDDEN_CLASS = 'visually-hidden';

/** Announcements held before the queue bound starts discarding. */
export const DEFAULT_MAX_QUEUED_ANNOUNCEMENTS = 32;

/**
 * How many times the queue bound the outbox may hold.
 *
 * One announcement can compose into more than one utterance, so the outbox
 * needs headroom above the queue bound; it does not need an independent
 * option.
 */
export const OUTBOX_CAPACITY_MULTIPLE = 2;

/** `aria-atomic` value index.html L105 declares. */
const ARIA_TRUE = 'true';

const REGION_ROLES = Object.freeze({
  polite: 'status',
  assertive: 'alert',
} as const satisfies Readonly<Record<AnnouncementPolarity, string>>);

const UNSTATED_REASON = 'Reason not stated';

/** A source of preference changes. `PreferenceStore` satisfies it. */
export interface PreferenceAnnouncementSource {
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
   * The region itself, where the caller resolved it already. `null` states
   * that there is none and disables the announcer.
   */
  readonly region?: Element | null;
  readonly selector?: string;

  /**
   * A second region assertive utterances are written to. Supply it only where
   * the markup declares a polite and an assertive region; index.html declares
   * one region, so this is absent by default and both polarities are written
   * to `region`.
   */
  readonly assertiveRegion?: Element | null;

  /**
   * Selector the assertive region is resolved from. Absent by default, and no
   * miss is reported for a region nobody configured.
   */
  readonly assertiveSelector?: string;
  readonly root?: MountRoot | null;
  readonly reporter?: UiReporter;
  readonly context?: string;

  /**
   * Announcements the queue holds. Reaching it discards the oldest gameplay
   * item, then the oldest free text, then a superseded verdict, and only then
   * the oldest `relicAcquired` or `terminal`; the queue never holds more than
   * this many, whatever kinds they are.
   */
  readonly maxQueued?: number;
  readonly schedule?: AnnouncerScheduler;

  /**
   * Whether a queue the caller has not flushed flushes itself on a later task.
   * Defaults to `true`.
   */
  readonly autoFlush?: boolean;

  /**
   * Renders a theme id as the prose name a preference change is announced
   * with. Defaults to reading the id with its hyphens as spaces.
   */
  readonly describeTheme?: (theme: string) => string;
}

/**
 * The announcer a caller holds and drives.
 *
 * No member throws, and every member is a safe no-op once the region is
 * unavailable or `destroy` has been called.
 */
export interface LiveRegionAnnouncer {
  announce(input: Announcement): void;
  announceText(text: string, polarity?: AnnouncementPolarity): void;
  flush(): void;
  clear(): void;

  /**
   * Withdraws every assertive line this announcer holds: the region's text, the
   * queued announcements that would be written assertively, and the pending
   * utterances already composed for that region. The polite region, the polite
   * queue entries and the polite utterances behind them are untouched, and a
   * polite batch interrupted by the withdrawal is resumed.
   *
   * For the caller navigating away from the state that raised an assertive
   * line: an `alert` region holds its text until something replaces it, and
   * only an assertive line is ever written there, so a run verdict stayed
   * readable on a screen that had nothing to do with it. `clear()` is too broad
   * for that — it would also discard a polite batch mid-flight. DL-LIVE-06.
   *
   * CHANGED: the two QUEUE STAGES are drained as well, and a write step
   * scheduled over an assertive utterance is cancelled and restarted. Blanking
   * the node alone left the verdict queued behind the clear, so the deferred
   * scheduler wrote it back into the region a task later and the line the caller
   * had just withdrawn was readable again. DL-LIVE-07.
   */
  clearAssertive(): void;

  /** Announcements queued plus lines composed and not yet written. */
  pending(): number;

  /** Whether a region is available and `destroy` has not been called. */
  isEnabled(): boolean;
  observePreferences(source: PreferenceAnnouncementSource): () => void;

  /**
   * Cancels every scheduled task, empties the queue and the pending lines, and
   * releases the region references. Every member is a no-op afterwards, and
   * calling it more than once is harmless.
   */
  destroy(): void;
}

type WritePhase = 'idle' | 'clear' | 'write';

interface RegionRequest {
  readonly supplied: Element | null | undefined;
  readonly selector: string | undefined;
  readonly name: string;
  readonly root: MountRoot | null | undefined;
  readonly required: boolean;
}

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
 * Index of the oldest announcement the queue bound discards next.
 *
 * @param items The queue.
 * @returns The index, or `NOT_FOUND` for an empty queue.
 */
function indexOfEvictable(items: readonly Announcement[]): number {
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

  const lastVerdict = lastIndexOfKind(items, 'terminal');

  for (let index = 0; index < lastVerdict; index += 1) {
    if (items[index].kind === 'terminal') {
      return index;
    }
  }

  return items.length > 0 ? 0 : NOT_FOUND;
}

/**
 * Whether a queued announcement would be written to the assertive region.
 *
 * The two producers, read off `composeAnnouncements`: a `terminal` verdict,
 * which is composed with `ASSERTIVE_POLARITY` unconditionally, and a `text`
 * line whose caller asked for that polarity. Every other kind composes into the
 * gameplay line, which carries `DEFAULT_POLARITY`. DL-LIVE-07.
 *
 * @param item The queued announcement.
 * @returns Whether composing it would produce an assertive utterance.
 */
function isAssertiveAnnouncement(item: Announcement): boolean {
  if (item.kind === 'terminal') {
    return true;
  }

  return item.kind === 'text' && item.polarity === ASSERTIVE_POLARITY;
}

/**
 * Removes every entry a predicate selects, in place.
 *
 * Used by `clearAssertive` on both queue stages: the arrays are the live state
 * a scheduled write reads, so they are spliced rather than replaced.
 *
 * @param items Array to drain.
 * @param selects Whether one entry is to be removed.
 * @returns How many entries were removed.
 */
function drainWhere<Entry>(
  items: Entry[],
  selects: (entry: Entry) => boolean,
): number {
  let removed = 0;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const entry = items[index];

    if (entry !== undefined && selects(entry)) {
      items.splice(index, 1);
      removed += 1;
    }
  }

  return removed;
}

/**
 * Index of the last announcement of one kind.
 *
 * @param items The queue.
 * @param kind Kind to look for.
 * @returns The index, or `NOT_FOUND` where the queue holds none.
 */
function lastIndexOfKind(
  items: readonly Announcement[],
  kind: AnnouncementKind,
): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].kind === kind) {
      return index;
    }
  }

  return NOT_FOUND;
}

function humanizeThemeId(theme: string): string {
  return theme.split(THEME_ID_SEPARATOR).join(CLAUSE_SEPARATOR);
}

function describeVolume(volume: number): number {
  if (!Number.isFinite(volume)) {
    return 0;
  }

  return Math.round(volume * PERCENT_SCALE);
}

function politeText(text: string): TextAnnouncement {
  return Object.freeze({
    kind: 'text',
    text,
    polarity: DEFAULT_POLARITY,
  } as const);
}

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

/**
 * Builds the announcer.
 *
 * The region is resolved once here and held. Where it cannot be resolved the
 * miss is reported with the selector that produced it and every member of the
 * returned announcer becomes a safe no-op.
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

  const outboxCapacity = capacity * OUTBOX_CAPACITY_MULTIPLE;
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

  /**
   * Whether THIS module created `assertiveRegion`, and must therefore remove
   * it again on destruction. An assertive region the markup declares is left
   * in place, exactly as the polite one is.
   */
  let ownsAssertiveRegion = false;

  /** Whether the downgrade below was reported, so it is said exactly once. */
  let reportedAssertiveDowngrade = false;

  const queue: Announcement[] = [];
  const outbox: Utterance[] = [];
  let destroyed = false;
  let phase: WritePhase = 'idle';
  let flushPending = false;
  let flushTask: ScheduledAnnouncerTask | null = null;
  let writePending = false;
  let writeTask: ScheduledAnnouncerTask | null = null;

  function disabled(): boolean {
    return destroyed || (politeRegion === null && assertiveRegion === null);
  }

  /**
   * The region a polarity is written to.
   *
   * Where the markup declares one region, as index.html does, both polarities
   * resolve to it and its `aria-live` attribute is left alone.
   *
   * @returns The region, or `null`.
   */
  function regionFor(polarity: AnnouncementPolarity): Element | null {
    if (polarity !== 'assertive') {
      return politeRegion ?? assertiveRegion;
    }

    if (assertiveRegion !== null) {
      return assertiveRegion;
    }

    if (createAssertiveRegion()) {
      return assertiveRegion;
    }

    reportAssertiveDowngrade();

    return politeRegion;
  }

  /**
   * Creates an owned assertive region beside the polite one.
   *
   * @returns Whether an assertive region is now in place.
   */
  function createAssertiveRegion(): boolean {
    const sibling = politeRegion;

    if (sibling === null) {
      return false;
    }

    const doc = sibling.ownerDocument;
    const parent = sibling.parentNode;

    if (doc === null || parent === null) {
      return false;
    }

    try {
      const created = doc.createElement('div');

      created.className = VISUALLY_HIDDEN_CLASS;
      created.setAttribute('role', REGION_ROLES.assertive);
      created.setAttribute('aria-live', 'assertive');
      created.setAttribute('aria-atomic', ARIA_TRUE);

      // Beside the polite region, so both live regions sit in the same place
      // in the document and neither is nested inside the other.
      parent.insertBefore(created, sibling.nextSibling);

      assertiveRegion = created;
      ownsAssertiveRegion = true;

      reporter.count(ASSERTIVE_CREATED_METRIC, { context });
      reporter.log('debug', 'live region created an assertive region', {
        context,
      });

      return true;
    } catch (error: unknown) {
      reporter.error(
        'live region could not create an assertive region',
        error,
        { context },
      );

      return false;
    }
  }

  /** Reports, once, that an assertive request is being served politely. */
  function reportAssertiveDowngrade(): void {
    reporter.count(ASSERTIVE_DOWNGRADE_METRIC, { context });

    if (reportedAssertiveDowngrade) {
      return;
    }

    reportedAssertiveDowngrade = true;

    reporter.log(
      'warn',
      'an assertive announcement is being made politely, because no ' +
        'assertive region is available and one could not be created',
      { context },
    );
  }

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

    // False where `deferTask` ran the callback inline, in which case the token
    // is spent and holding it would block the next step.
    if (writePending) {
      writeTask = task;
    }
  }

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
    let droppedProtected = 0;

    while (queue.length > capacity) {
      const index = indexOfEvictable(queue);

      if (index === NOT_FOUND) {
        break;
      }

      const discarded = queue[index];

      if (
        discarded !== undefined &&
        isProtectedAnnouncementKind(discarded.kind)
      ) {
        droppedProtected += 1;
      }

      queue.splice(index, 1);
      dropped += 1;
    }

    if (dropped > 0) {
      reporter.log('warn', 'live region discarded queued announcements', {
        dropped,
        protected: droppedProtected,
        capacity,
        context,
      });
      reporter.count(DROPPED_METRIC, {
        dropped,
        protected: droppedProtected,
        capacity,
        context,
      });
    }

    // Counted separately: discarding a terminal state or a relic pickup is the
    // bound's last resort, worth distinguishing from ordinary pressure.
    if (droppedProtected > 0) {
      reporter.count(DROPPED_PROTECTED_METRIC, {
        droppedProtected,
        capacity,
        context,
      });
    }
  }

  /** Brings the outbox back within its bound. */
  function enforceOutboxCapacity(): void {
    if (outbox.length <= outboxCapacity) {
      return;
    }

    const dropped = outbox.length - outboxCapacity;

    outbox.splice(0, dropped);

    reporter.log('warn', 'live region discarded pending utterances', {
      dropped,
      capacity: outboxCapacity,
      context,
    });
    reporter.count(OUTBOX_DROPPED_METRIC, {
      dropped,
      capacity: outboxCapacity,
      context,
    });
  }

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

  function announceText(
    text: string,
    polarity?: AnnouncementPolarity,
  ): void {
    announce({ kind: 'text', text, polarity });
  }

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

    enforceOutboxCapacity();
    driveWrites();
  }

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

  function clearAssertive(): void {
    // ADDED, matching `flush`: `destroy` has already emptied both stages and
    // released the regions, so there is nothing to withdraw and a `cleared`
    // count here would describe work that did not happen.
    if (destroyed) {
      reporter.count(AFTER_DESTROY_METRIC, { method: 'clearAssertive' });

      return;
    }

    // CHANGED: the queue and the outbox are drained of assertive work before the
    // region is blanked, so nothing writes the withdrawn line back. Blanking the
    // node alone left a queued verdict — and one already composed into a pending
    // utterance — to be written by the deferred scheduler a task later.
    // DL-LIVE-07.
    const queued = drainWhere(queue, isAssertiveAnnouncement);
    const pendingUtterances = drainWhere(
      outbox,
      (utterance): boolean => utterance.polarity === ASSERTIVE_POLARITY,
    );

    // THE WRITE CURSOR IS `outbox[0]`, so a step scheduled over an utterance
    // this call has just removed would write whatever slid into its place
    // without the clear half of the clear-then-write cycle. Cancelling and
    // restarting rebuilds that cycle around the head that survives; a polite
    // batch queued behind the withdrawn alert therefore still speaks.
    const restarted = pendingUtterances > 0 && phase !== 'idle';

    if (restarted) {
      cancelWrite();
      phase = 'idle';
    }

    if (assertiveRegion !== null) {
      writeText('assertive', '');
    }

    if (restarted) {
      driveWrites();
    }

    reporter.count(ASSERTIVE_CLEARED_METRIC, {
      queued,
      pending: pendingUtterances,
      restarted,
      context,
    });
  }

  function pending(): number {
    return queue.length + outbox.length;
  }

  function isEnabled(): boolean {
    return !disabled();
  }

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

    // Removed only where this module created it: a region the markup declares
    // outlives the announcer, exactly as the polite one does.
    if (ownsAssertiveRegion && assertiveRegion !== null) {
      assertiveRegion.remove();
    }

    ownsAssertiveRegion = false;
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
    clearAssertive,
    pending,
    isEnabled,
    observePreferences,
    destroy,
  });
}
