/**
 * Sound effect descriptors and the pure resolvers that select them.
 *
 * Each descriptor is plain numbers and shape names, with every duration and
 * offset in ms. The timings are design choices sized against the interface's own
 * animation cadence rather than one-to-one transpositions of it: `move`, `merge`
 * and `spawn` span their tile animations, while `stageClear` and
 * `relicAcquired` are sized to the same rhythm without accompanying one
 * animation each. The merge pitch ramp follows the exponent shape of the tile
 * colour ramp.
 *
 * Declarations and pure functions only: this module reads no platform state,
 * holds no mutable state, and does no work on load beyond freezing its two
 * tables.
 */

/* ==========================================================================
 * 1. Descriptor vocabulary
 * ========================================================================== */

/** Wave shape a voice is built from. */
export type SoundWaveform = 'sine' | 'triangle' | 'square' | 'sawtooth';

/** The seven sounded moments. */
export type SoundEffectName =
  | 'move'
  | 'merge'
  | 'spawn'
  | 'stageClear'
  | 'relicAcquired'
  | 'win'
  | 'lose';

/** One synthesised voice, described as plain numbers and shape names. */
export interface SoundEffect {
  /** Wave shape of the voice. Not read when `noise` is true. */
  readonly waveform: SoundWaveform;

  /**
   * Starting pitch, in Hz. Read instead as the centre of the noise band when
   * `noise` is true.
   */
  readonly frequencyHz: number;

  /**
   * Pitch the voice glides to across its sounding time, in Hz. Absent for a
   * level voice, and not read when `noise` is true.
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
   * Delay between the request and the voice starting, in ms. Matches the delay
   * on the animation the effect accompanies.
   */
  readonly startOffsetMs?: number;

  /**
   * Pitch offset in cents, positive or negative. Absent for no offset, and not
   * read when `noise` is true.
   */
  readonly detuneCents?: number;

  /** Selects a filtered noise source in place of a periodic wave. */
  readonly noise?: boolean;
}

/* ==========================================================================
 * 2. Effect table
 * ========================================================================== */

/** Freezes one descriptor. */
function frozenEffect(effect: SoundEffect): SoundEffect {
  return Object.freeze(effect);
}

/**
 * The descriptor for each sounded moment, frozen entry by entry. The waveform,
 * pitch, envelope and gain of every entry are decision DL-AUDIO-01.
 */
export const soundMap: Readonly<Record<SoundEffectName, SoundEffect>> =
  Object.freeze({
    move: frozenEffect({
      waveform: 'sine',
      frequencyHz: 220,
      attackMs: 4,
      holdMs: 26,
      releaseMs: 70,
      peakGain: 0.05,
      startOffsetMs: 0,
    }),

    // `effectForMerge` replaces both pitches.
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

const rampFloorValue = 2;

const rampCeilingValue = 2048;

/** Base-2 exponent of `rampFloorValue`. */
const rampFloorExponent = 1;

/** Base-2 exponent of `rampCeilingValue`. */
const rampCeilingExponent = 11;

/** Octaves the merge pitch spans across the whole ramp. Decision DL-AUDIO-01. */
const mergePitchOctaves = 2;

/**
 * Ratio from a merge voice's starting pitch to its ramp target. Decision
 * DL-AUDIO-01.
 */
const mergeRampRatio = 1.5;

/** Rounds a frequency to two decimal places. */
function roundHz(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Position of a merge result on the tile colour ramp, 0 through 1. */
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

/** The engine event names this module resolves. */
type EngineEventName =
  | 'stage:start'
  | 'move:before'
  | 'tile:merge'
  | 'tile:spawn'
  | 'move:after'
  | 'stage:end'
  | 'state:commit'
  | 'relic:acquired';

/** The candidate effect for each recognised event name. */
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
 * Reads one field of a payload and reports whether it holds exactly `true`.
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
 * @param payload The `move:after` payload.
 */
export function shouldPlayMove(payload: unknown): boolean {
  return readBooleanField(payload, 'moved');
}

/**
 * Reports whether a `stage:end` payload sounds `stageClear`.
 *
 * @param payload The `stage:end` payload.
 */
export function shouldPlayStageClear(payload: unknown): boolean {
  return readBooleanField(payload, 'cleared');
}

/**
 * The terminal effect for a `state:commit` payload, or `null`.
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
