/**
 * Sound effect descriptors and the pure resolvers that select them.
 *
 * PROVENANCE
 *   This module has no ancestor under js/: the vanilla game emits no
 *   sound at all. The effect set is declared here for the first time.
 *
 *   Every duration and offset below is transposed from the stylesheet
 *   timing it accompanies and is cited entry by entry. Each voice spans
 *   the same period as that animation. The merge pitch ramp reproduces
 *   the exponent shape of the tile colour ramp at style/main.scss
 *   L374-L396.
 *
 *   The eight event names resolved in section 4 are the engine event
 *   names. The terminal precedence in section 5 is transposed from
 *   js/html_actuator.js L27-L33, where `over` is tested ahead of `won`
 *   and both sit behind `terminated`.
 *
 * CONTENTS
 *   Declarations and pure functions only. This module reads no platform
 *   state, holds no mutable state, and does no work on load beyond
 *   freezing the two tables below.
 */

/* ==========================================================================
 * 1. Descriptor vocabulary
 * ========================================================================== */

/**
 * Wave shape a voice is built from.
 *
 * The four standard periodic shapes.
 */
export type SoundWaveform = 'sine' | 'triangle' | 'square' | 'sawtooth';

/**
 * The seven sounded moments.
 *
 * `move`, `merge` and `spawn` fire inside a turn. `stageClear` and
 * `relicAcquired` fire at a stage boundary. `win` and `lose` are the two
 * terminal outcomes and stay separate names.
 */
export type SoundEffectName =
  | 'move'
  | 'merge'
  | 'spawn'
  | 'stageClear'
  | 'relicAcquired'
  | 'win'
  | 'lose';

/**
 * One synthesised voice, described as plain numbers and shape names.
 *
 * Durations are ms and frequencies are Hz. `attackMs`, `holdMs` and
 * `releaseMs` sum to the sounding time of the effect. `startOffsetMs` is
 * scheduling delay ahead of that sum and is not part of it.
 */
export interface SoundEffect {
  /** Wave shape of the voice. Not read when `noise` is true. */
  readonly waveform: SoundWaveform;

  /**
   * Starting pitch, in Hz. Read instead as the centre of the noise band
   * when `noise` is true.
   */
  readonly frequencyHz: number;

  /**
   * Pitch the voice glides to across its sounding time, in Hz. Absent
   * for a level voice, and not read when `noise` is true.
   */
  readonly rampToHz?: number;

  /** Gain rise from silence to `peakGain`, in ms. */
  readonly attackMs: number;

  /** Time held at `peakGain`, in ms. */
  readonly holdMs: number;

  /** Gain fall from `peakGain` back to silence, in ms. */
  readonly releaseMs: number;

  /** Envelope peak, 0 through 1, applied ahead of the master gain. */
  readonly peakGain: number;

  /**
   * Delay between the request and the voice starting, in ms. Matches the
   * delay on the animation the effect accompanies.
   */
  readonly startOffsetMs?: number;

  /**
   * Pitch offset in cents, positive or negative. Absent for no offset,
   * and not read when `noise` is true.
   */
  readonly detuneCents?: number;

  /** Selects a filtered noise source in place of a periodic wave. */
  readonly noise?: boolean;
}

/* ==========================================================================
 * 2. Effect table
 * ========================================================================== */

/**
 * Freezes one descriptor.
 *
 * Applied to every entry of `soundMap` so a shared descriptor cannot be
 * altered at run time. Each member is already `readonly`, so the frozen
 * value keeps the same type.
 */
function frozenEffect(effect: SoundEffect): SoundEffect {
  return Object.freeze(effect);
}

/**
 * The descriptor for each sounded moment, frozen entry by entry.
 *
 * `Record<SoundEffectName, SoundEffect>` is exhaustive: a missing effect
 * is a compile error.
 *
 * Sounding times, shortest first: move 100, merge 200, spawn 200,
 * relicAcquired 400, stageClear 600, win 800, lose 800. `move` is both
 * the shortest and the quietest entry and fires on every changed turn.
 */
export const soundMap: Readonly<Record<SoundEffectName, SoundEffect>> =
  Object.freeze({
    // Low soft blip. 4 + 26 + 70 = 100ms and no delay, matching the tile
    // transition at style/main.scss L368.
    move: frozenEffect({
      waveform: 'sine',
      frequencyHz: 220,
      attackMs: 4,
      holdMs: 26,
      releaseMs: 70,
      peakGain: 0.05,
      startOffsetMs: 0,
    }),

    // Rising blip, once per merge. 6 + 74 + 120 = 200ms after a 100ms
    // delay, matching `pop 200ms ease $transition-speed` at
    // style/main.scss L489. `effectForMerge` replaces both pitches.
    merge: frozenEffect({
      waveform: 'triangle',
      frequencyHz: 440,
      rampToHz: 660,
      attackMs: 6,
      holdMs: 74,
      releaseMs: 120,
      peakGain: 0.12,
      startOffsetMs: 100,
    }),

    // Short noise tick. 4 + 46 + 150 = 200ms after a 100ms delay,
    // matching `appear 200ms ease $transition-speed` at
    // style/main.scss L469.
    spawn: frozenEffect({
      waveform: 'sine',
      frequencyHz: 1200,
      attackMs: 4,
      holdMs: 46,
      releaseMs: 150,
      peakGain: 0.06,
      startOffsetMs: 100,
      noise: true,
    }),

    // Rising lift across one octave. 12 + 288 + 300 = 600ms, the bound
    // set by `move-up 600ms ease-in` at style/main.scss L104, after the
    // 100ms base unit at style/main.scss L22.
    stageClear: frozenEffect({
      waveform: 'triangle',
      frequencyHz: 523.25,
      rampToHz: 1046.5,
      attackMs: 12,
      holdMs: 288,
      releaseMs: 300,
      peakGain: 0.22,
      startOffsetMs: 100,
    }),

    // Bright pickup chirp. 8 + 192 + 200 = 400ms after the 100ms base
    // unit at style/main.scss L22.
    relicAcquired: frozenEffect({
      waveform: 'square',
      frequencyHz: 587.33,
      rampToHz: 880,
      attackMs: 8,
      holdMs: 192,
      releaseMs: 200,
      peakGain: 0.18,
      startOffsetMs: 100,
      detuneCents: 7,
    }),

    // Rising octave. 14 + 386 + 400 = 800ms after a 1200ms delay, both
    // taken from `fade-in 800ms ease $transition-speed * 12` at
    // style/main.scss L270.
    win: frozenEffect({
      waveform: 'triangle',
      frequencyHz: 659.25,
      rampToHz: 1318.5,
      attackMs: 14,
      holdMs: 386,
      releaseMs: 400,
      peakGain: 0.26,
      startOffsetMs: 1200,
      detuneCents: 8,
    }),

    // Falling tone. 16 + 384 + 400 = 800ms after a 1200ms delay, both
    // taken from `fade-in 800ms ease $transition-speed * 12` at
    // style/main.scss L270.
    lose: frozenEffect({
      waveform: 'sawtooth',
      frequencyHz: 330,
      rampToHz: 110,
      attackMs: 16,
      holdMs: 384,
      releaseMs: 400,
      peakGain: 0.2,
      startOffsetMs: 1200,
      detuneCents: -10,
    }),
  });

/* ==========================================================================
 * 3. Merge pitch derivation
 * ========================================================================== */

/** Lowest value on the tile colour ramp. style/main.scss L374. */
const rampFloorValue = 2;

/** Highest value on the tile colour ramp. style/main.scss L375. */
const rampCeilingValue = 2048;

/** Base-2 exponent of `rampFloorValue`. `$exponent: 1` at L374. */
const rampFloorExponent = 1;

/** Base-2 exponent of `rampCeilingValue`. `$limit: 11` at L375. */
const rampCeilingExponent = 11;

/** Octaves the merge pitch spans across the whole ramp. */
const mergePitchOctaves = 2;

/** Ratio from a merge voice's starting pitch to its ramp target. */
const mergeRampRatio = 1.5;

/**
 * Rounds a frequency to two decimal places.
 *
 * Holds a derived pitch stable, so two derivations from one value are
 * equal field by field.
 */
function roundHz(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Position of a merge result on the tile colour ramp, 0 through 1.
 *
 * Reproduces `($exponent - 1) / ($limit - 1)` from style/main.scss L396
 * by taking the base-2 exponent of the value.
 *
 * Total over the whole number line. A result at or above
 * `rampCeilingValue`, positive infinity included, saturates at 1 and so
 * shares the top pitch, matching the `tile-super` band at
 * style/main.scss L444. A result at or below `rampFloorValue`, zero,
 * negatives and negative infinity included, clamps to 0. A result that
 * is not a number clamps to 0. A result between two powers of two lands
 * between their two positions.
 */
function mergeRampProgress(resultValue: number): number {
  if (Number.isNaN(resultValue)) {
    return 0;
  }
  if (resultValue >= rampCeilingValue) {
    return 1;
  }
  if (resultValue <= rampFloorValue) {
    return 0;
  }

  const span = rampCeilingExponent - rampFloorExponent;
  const position = (Math.log2(resultValue) - rampFloorExponent) / span;

  return Math.min(Math.max(position, 0), 1);
}

/**
 * The merge descriptor pitched for one merge result.
 *
 * Reads `soundMap.merge` for every field other than the two pitches,
 * derives those from the ramp position of `resultValue`, and returns a
 * new frozen descriptor. `soundMap.merge` is left as it stands.
 *
 * The starting pitch rises across `mergePitchOctaves` octaves from the
 * base entry's pitch at position 0 to the top of the ramp at position 1;
 * the ramp target stays `mergeRampRatio` above it. Both are finite for
 * every input, zero, negatives, non-powers of two and non-finite values
 * included.
 *
 * One merge produces one descriptor. js/game_manager.js L156-L170 runs
 * the merge branch once per traversal step, so a turn holding two merges
 * calls this twice and sounds two voices.
 *
 * @param resultValue Value of the tile the merge produced.
 */
export function effectForMerge(resultValue: number): SoundEffect {
  const base = soundMap.merge;
  const position = mergeRampProgress(resultValue);
  const frequencyHz = roundHz(
    base.frequencyHz * Math.pow(2, position * mergePitchOctaves),
  );

  return frozenEffect({
    ...base,
    frequencyHz,
    rampToHz: roundHz(frequencyHz * mergeRampRatio),
  });
}

/* ==========================================================================
 * 4. Event resolution
 * ========================================================================== */

/**
 * The engine event names this module resolves.
 *
 * Module-private. `effectNameForEvent` takes a plain string, so it
 * answers an unrecognised name at run time.
 */
type EngineEventName =
  | 'stage:start'
  | 'move:before'
  | 'tile:merge'
  | 'tile:spawn'
  | 'move:after'
  | 'stage:end'
  | 'state:commit'
  | 'relic:acquired';

/**
 * The candidate effect for each recognised event name.
 *
 * `null` marks an event that never sounds: `stage:start`, and
 * `move:before`, whose move can still be vetoed.
 *
 * Three entries are candidates that the section 5 gates resolve against
 * the payload — `move:after`, `stage:end` and `state:commit`.
 * `state:commit` carries `lose`, matching the branch order at
 * js/html_actuator.js L28-L31 where `over` is tested ahead of `won`.
 */
const eventEffectTable: Readonly<
  Record<EngineEventName, SoundEffectName | null>
> = Object.freeze({
  'stage:start': null,
  'move:before': null,
  'tile:merge': 'merge',
  'tile:spawn': 'spawn',
  'move:after': 'move',
  'stage:end': 'stageClear',
  'state:commit': 'lose',
  'relic:acquired': 'relicAcquired',
});

/** Reports whether a name is an own key of `eventEffectTable`. */
function isMappedEventName(name: string): name is EngineEventName {
  return Object.prototype.hasOwnProperty.call(eventEffectTable, name);
}

/**
 * The candidate effect name for an engine event name.
 *
 * Returns `null` for `stage:start`, for `move:before`, for an empty
 * string and for every unrecognised name. Never throws, whatever string
 * it is given.
 *
 * For `move:after`, `stage:end` and `state:commit` the name returned is
 * a candidate only: pair it with the matching section 5 gate, which
 * reads the payload, before sounding it.
 *
 * @param eventName Engine event name, as emitted.
 */
export function effectNameForEvent(
  eventName: string,
): SoundEffectName | null {
  if (!isMappedEventName(eventName)) {
    return null;
  }

  return eventEffectTable[eventName];
}

/* ==========================================================================
 * 5. Payload gates
 * ========================================================================== */

/** Narrows a value to one whose named fields can be read. */
function isReadableRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads one field of a payload and reports whether it holds exactly
 * `true`.
 *
 * A payload that is not an object, an absent field, and a field holding
 * a value other than `true` each report `false`.
 */
function readBooleanField(payload: unknown, field: string): boolean {
  if (!isReadableRecord(payload)) {
    return false;
  }

  return payload[field] === true;
}

/**
 * Reports whether a `move:after` payload sounds `move`.
 *
 * True only when `moved` holds `true`. js/game_manager.js L175-L190
 * makes `positionsEqual` the one change detector and gates both the
 * spawn and the commit on it, so a turn that changed no position stays
 * silent.
 *
 * `terminated` is not read, so the closing move of a run still sounds
 * `move`; its terminal voice comes from `terminalEffectName`.
 *
 * @param payload The `move:after` payload.
 */
export function shouldPlayMove(payload: unknown): boolean {
  return readBooleanField(payload, 'moved');
}

/**
 * Reports whether a `stage:end` payload sounds `stageClear`.
 *
 * True only when `cleared` holds `true`, so a stage left unfinished
 * stays silent.
 *
 * @param payload The `stage:end` payload.
 */
export function shouldPlayStageClear(payload: unknown): boolean {
  return readBooleanField(payload, 'cleared');
}

/**
 * The terminal effect for a `state:commit` payload, or `null`.
 *
 * Transposed from js/html_actuator.js L27-L33: `terminated` gates the
 * pair, `over` yields `lose`, and `won` yields `win` only where `over`
 * is unset. A won run that keeps playing leaves `terminated` unset and
 * so yields `null`, which holds `win` apart from continued play. A
 * commit in mid-run yields `null`.
 *
 * @param payload The `state:commit` payload.
 */
export function terminalEffectName(
  payload: unknown,
): SoundEffectName | null {
  if (!readBooleanField(payload, 'terminated')) {
    return null;
  }
  if (readBooleanField(payload, 'over')) {
    return 'lose';
  }
  if (readBooleanField(payload, 'won')) {
    return 'win';
  }

  return null;
}
