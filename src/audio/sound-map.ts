/**
 * Sound effect descriptors and the pure resolvers that select them.
 *
 * Each descriptor is plain numbers and shape names, with every duration and
 * offset in ms. `move`, `merge` and `spawn` span their tile animations, while
 * `stageClear` and `relicAcquired` accompany no single animation. The merge
 * pitch ramp follows the exponent shape of the tile colour ramp.
 *
 * Declarations and pure functions only: this module reads no platform state,
 * holds no mutable state, and does no work on load beyond freezing its two
 * tables. Nothing here is ported: js/ plays no sound, so every row below is
 * target-only.
 *
 * One traceability row of docs/TRACEABILITY_MATRIX.md apiece:
 *   TR-AUDIO-05  the descriptor table and its per-event entries
 *   TR-AUDIO-06  the pure resolvers that select a descriptor
 *   TR-AUDIO-07  the audio bounds `MIN_VOLUME`, `MAX_VOLUME`,
 *                `DEFAULT_VOLUME` and `DEFAULT_MUTED`
 *
 * Decisions behind this file, argued in docs/DECISION_LOG.md and named here
 * only so the construct can be found from the log:
 *   DL-AUDIO-01  the descriptor timings spanning the tile animations, with the
 *                merge pitch ramp following the exponent shape of the tile
 *                colour ramp
 */

/* ==========================================================================
 * 0. Audio bounds
 * ========================================================================== */

// Re-exported, not redeclared: src/config/audio-bounds.ts holds the one
// declaration of these four values, and both this layer and the accessibility
// surface read it from there. This module keeps publishing them under the same
// names, so every caller is unaffected.
//
// WHY NOT HERE. The accessibility surface needs the same four values to validate
// a preference, and it is the leaf of the src/ui/ import graph: declaring them
// in the audio domain made that leaf depend on src/audio/, which its own
// contract forbids. Declaring them twice is what came before, and the two
// declarations disagreed on the starting volume — so the volume a player heard
// depended on which owner had last written the master gain. src/config/ is
// neutral to both and imports neither.
export {
  DEFAULT_MUTED,
  DEFAULT_VOLUME,
  MAX_VOLUME,
  MIN_VOLUME,
} from '../config/audio-bounds';

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

function frozenEffect(effect: SoundEffect): SoundEffect {
  return Object.freeze(effect);
}

/** The descriptor for each sounded moment, frozen entry by entry. */
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

const rampFloorValue = 2;

const rampCeilingValue = 2048;

const rampFloorExponent = 1;

const rampCeilingExponent = 11;

const mergePitchOctaves = 2;

const mergeRampRatio = 1.5;

function roundHz(value: number): number {
  return Math.round(value * 100) / 100;
}

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

/** The merge descriptor pitched for one merge result. */
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
 * Exactly the seven names `EngineEventPayloadMap` of
 * src/engine/engine-events.ts
 * declares, and no others: a name absent from that contract is emitted by
 * nothing, so a mapping for it can never resolve. Declared locally rather
 * than imported, so this module names no engine module.
 */
type AudioEventName =
  | 'stage:start'
  | 'move:before'
  | 'tile:merge'
  | 'tile:spawn'
  | 'move:after'
  | 'stage:end'
  | 'state:commit';

const eventEffectTable: Readonly<
  Record<AudioEventName, SoundEffectName | null>
> = Object.freeze({
  'stage:start': null,
  'move:before': null,
  'tile:merge': 'merge',
  'tile:spawn': 'spawn',
  'move:after': 'move',
  'stage:end': 'stageClear',
  'state:commit': 'lose',
});

function isMappedEventName(name: string): name is AudioEventName {
  return Object.prototype.hasOwnProperty.call(eventEffectTable, name);
}

/** The candidate effect name for one `AudioEventName`. */
export function effectNameForEvent(
  eventName: string,
): SoundEffectName | null {
  if (!isMappedEventName(eventName)) {
    return null;
  }

  return eventEffectTable[eventName];
}

function isReadableRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads one field of a payload and reports whether it holds EXACTLY `true`, so
 * a merely truthy value opens no gate below.
 */
function readBooleanField(payload: unknown, field: string): boolean {
  if (!isReadableRecord(payload)) {
    return false;
  }

  return payload[field] === true;
}

/** Reports whether a `move:after` payload sounds `move`. */
export function shouldPlayMove(payload: unknown): boolean {
  return readBooleanField(payload, 'moved');
}

/** Reports whether a `stage:end` payload sounds `stageClear`. */
export function shouldPlayStageClear(payload: unknown): boolean {
  return readBooleanField(payload, 'cleared');
}

/**
 * The terminal effect for a `state:commit` payload, or `null`. Nothing sounds
 * until `terminated` is set, and `over` is tested before `won`.
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
