// The audio layer: one synthesised Web Audio voice per sounded moment.
//
// How it attaches subscribe calls `on` on the source it is handed and nothing
// else. A handler returns nothing, mutates no payload and lets nothing escape.
//
// Every duration in a descriptor is in milliseconds and every time handed to
// the Web Audio API is in seconds.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated, all target-only because js/ plays no sound:
//   TR-AUDIO-01  `createSoundEngine()` and the audio context created and
//                resumed on a user gesture
//   TR-AUDIO-02  the oscillator and noise-buffer voices
//   TR-AUDIO-03  `subscribe()` and the per-event voice selection
//   TR-AUDIO-04  the mute and volume surface, and `getState()`
//
// Decisions: DL-AUDIO-01, DL-AUDIO-02, DL-AUDIO-03, DL-AUDIO-04
// (docs/DECISION_LOG.md).

import {
  DEFAULT_MUTED,
  DEFAULT_VOLUME,
  MAX_VOLUME,
  MIN_VOLUME,
} from './sound-map';
import type { SoundEffect, SoundEffectName } from './sound-map';
import type {
  EngineEventName,
  EngineEvents,
} from '../engine/engine-events';
import {
  effectForMerge,
  effectNameForEvent,
  shouldPlayMove,
  shouldPlayStageClear,
  soundMap,
  terminalEffectName,
} from './sound-map';

/** Severity a report carries. */
export type SoundReportLevel = 'debug' | 'info' | 'warn' | 'error';

/** Machine-readable identifier of what a report describes. */
export type SoundReportCode =
  | 'audio-unavailable'
  | 'context-construct-failed'
  | 'context-resume-failed'
  | 'context-close-failed'
  | 'context-state-changed'
  | 'context-unlocked'
  | 'effect-unknown'
  | 'listener-failed'
  | 'handler-failed'
  | 'graph-failed'
  | 'voice-failed'
  | 'voice-dropped'
  | 'payload-unreadable'
  | 'subscribe-failed'
  | 'release-unavailable'
  | 'release-failed'
  | 'preference-owned';

/** Fields a report may carry alongside its message. */
export interface SoundReportDetails {
  readonly [field: string]: string | number | boolean | null | undefined;
}

/**
 * One report handed to the injected reporter.
 *
 * `error` carries the caught value exactly as it was caught, unconverted.
 */
export interface SoundReport {
  readonly level: SoundReportLevel;

  readonly code: SoundReportCode;

  readonly message: string;

  /** The caught value. Absent when the report describes no throw. */
  readonly error?: unknown;

  readonly details?: SoundReportDetails;
}

/** Sink every report reaches. */
export interface SoundReporter {
  /**
   * Receives one report.
   *
   * @param report What is being reported.
   */
  report(report: SoundReport): void;
}

/** Reporter that accepts a report and returns without doing anything. */
export const NOOP_SOUND_REPORTER: SoundReporter = Object.freeze({
  report: (): void => {},
});

/**
 * Sink counter increments reach.
 *
 * `increment` runs synchronously on the calling path and a throw from it is
 * contained on the same counters as a reporter throw.
 */
export interface SoundMetricsRecorder {
  /**
   * Adds to one counter.
   *
   * @param name Counter to add to.
   * @param value Amount to add. `1` when omitted.
   */
  increment(name: string, value?: number): void;
}

/** Recorder that accepts an increment and returns without doing anything. */
export const NOOP_SOUND_METRICS: SoundMetricsRecorder = Object.freeze({
  increment: (): void => {},
});

/** Counter incremented once per play request, before any gate. */
const METRIC_PLAY_REQUESTED = 'audio.play.requested';

/** Counter incremented once per voice that reached the graph. */
const METRIC_PLAY_STARTED = 'audio.play.started';

/** Counter incremented once per play request that produced no voice. */
const METRIC_PLAY_DROPPED = 'audio.play.dropped';

/** Counter incremented once per play request made with no context. */
const METRIC_PLAY_UNAVAILABLE = 'audio.play.unavailable';

/** Counter incremented once per play request made while not running. */
const METRIC_PLAY_SUSPENDED = 'audio.play.suspended';

/** Counter incremented once per play request made while muted. */
const METRIC_PLAY_MUTED = 'audio.play.muted';

/** Counter incremented once per unlock attempt. */
const METRIC_UNLOCK_ATTEMPTED = 'audio.unlock.attempted';

/** Counter incremented once when the context first reaches `'running'`. */
const METRIC_UNLOCK_SUCCEEDED = 'audio.unlock.succeeded';

/** Counter incremented once per unlock attempt that did not resume. */
const METRIC_UNLOCK_FAILED = 'audio.unlock.failed';

/** Counter incremented once per voice released from the graph. */
const METRIC_VOICE_RELEASED = 'audio.voice.released';

/** Counter incremented once per contained failure. */
const METRIC_FAILURE = 'audio.failure';

/** Counter incremented once per state change of the context. */
const METRIC_STATE_CHANGED = 'audio.context.statechange';

/** Counters and descriptions the module's report boundary accumulates. */
interface DiagnosticsTotals {
  /** Contained failures of this module's own work. */
  failures: number;

  /** Description of the most recent contained failure. */
  lastFailure: string | null;

  /** Invocations of the reporter or the recorder that threw. */
  reporterFaults: number;

  /** Description of the most recent reporter or recorder throw. */
  lastReporterFault: string | null;
}

/** The reporting and counting boundary every internal path goes through. */
interface Diagnostics {
  /** The accumulated counters, read by `getState`. */
  readonly totals: DiagnosticsTotals;

  /**
   * Reports once for a key, and does nothing for a key already reported.
   *
   * @param key Identifier this report is deduplicated by.
   * @param report What is being reported.
   */
  reportOnce(key: string, report: SoundReport): void;

  /**
   * Records a contained failure of this module's own work and reports it once
   * for `key`.
   *
   * @param key Identifier this report is deduplicated by.
   * @param code Machine-readable identifier of the failure.
   * @param message What failed.
   * @param thrown The caught value, carried onto the report unconverted.
   * @param details Fields carried onto the report.
   */
  noteFailure(
    key: string,
    code: SoundReportCode,
    message: string,
    thrown: unknown,
    details?: SoundReportDetails,
  ): void;

  /**
   * Adds to one counter.
   *
   * @param name Counter to add to.
   * @param value Amount to add. `1` when omitted.
   */
  count(name: string, value?: number): void;
}

/** Characters a described caught value keeps. */
const MAX_DESCRIPTION_LENGTH = 200;

/** Text describing a caught value that offered nothing readable. */
const UNREADABLE_THROWN = 'An unreadable value was thrown.';

/**
 * Reads one string property off a caught value without trusting the value.
 *
 * @param source Value to read from.
 * @param field Property name to read.
 * @returns The value, capped, or `undefined` where it is absent, unreadable,
 *   not a string or empty.
 */
function readThrownText(source: object, field: string): string | undefined {
  let candidate: unknown;

  try {
    if (!(field in source)) {
      return undefined;
    }
    candidate = Reflect.get(source, field);
  } catch {
    return undefined;
  }

  return typeof candidate === 'string' && candidate.length > 0
    ? candidate.slice(0, MAX_DESCRIPTION_LENGTH)
    : undefined;
}

/**
 * Describes a caught value as text, preserving an `Error`'s own message.
 *
 * @param thrown The caught value.
 * @returns Text describing `thrown`, capped at `MAX_DESCRIPTION_LENGTH`.
 */
function describeThrown(thrown: unknown): string {
  if (typeof thrown === 'object' && thrown !== null) {
    return (
      readThrownText(thrown, 'message') ??
      readThrownText(thrown, 'name') ??
      UNREADABLE_THROWN
    );
  }
  if (typeof thrown === 'string') {
    return thrown.length > 0
      ? thrown.slice(0, MAX_DESCRIPTION_LENGTH)
      : 'Empty string thrown.';
  }
  if (typeof thrown === 'number' || typeof thrown === 'boolean') {
    return String(thrown);
  }
  if (thrown === null) {
    return 'null thrown.';
  }
  if (thrown === undefined) {
    return 'undefined thrown.';
  }
  if (typeof thrown === 'bigint') {
    try {
      return `${thrown.toString()}n`.slice(0, MAX_DESCRIPTION_LENGTH);
    } catch {
      return UNREADABLE_THROWN;
    }
  }
  if (typeof thrown === 'symbol') {
    return 'A symbol was thrown.';
  }

  return UNREADABLE_THROWN;
}

/**
 * Builds the boundary the reporter and the recorder are called through.
 *
 * @param reporter Sink reports are delivered to.
 * @param metrics Sink counter increments are delivered to.
 * @returns The boundary, with its counters readable on `totals`.
 */
function createDiagnostics(
  reporter: SoundReporter,
  metrics: SoundMetricsRecorder,
): Diagnostics {
  const totals: DiagnosticsTotals = {
    failures: 0,
    lastFailure: null,
    reporterFaults: 0,
    lastReporterFault: null,
  };

  const reportedKeys = new Set<string>();

  /** Delivers one report, containing a throw from the sink. */
  const deliver = (report: SoundReport): void => {
    try {
      reporter.report(report);
    } catch (thrown) {
      totals.reporterFaults += 1;
      totals.lastReporterFault = describeThrown(thrown);
    }
  };

  /** Delivers one increment, containing a throw from the recorder. */
  const add = (name: string, value: number): void => {
    try {
      metrics.increment(name, value);
    } catch (thrown) {
      totals.reporterFaults += 1;
      totals.lastReporterFault = describeThrown(thrown);
    }
  };

  return {
    totals,

    reportOnce(key: string, report: SoundReport): void {
      if (reportedKeys.has(key)) {
        return;
      }
      reportedKeys.add(key);
      deliver(report);
    },

    noteFailure(
      key: string,
      code: SoundReportCode,
      message: string,
      thrown: unknown,
      details?: SoundReportDetails,
    ): void {
      totals.failures += 1;
      totals.lastFailure = describeThrown(thrown);
      add(METRIC_FAILURE, 1);

      if (reportedKeys.has(key)) {
        return;
      }
      reportedKeys.add(key);
      deliver({
        level: 'error',
        code,
        message,
        error: thrown,
        details,
      });
    },

    count(name: string, value?: number): void {
      add(name, value ?? 1);
    },
  };
}

/**
 * A listener the event source calls with one payload.
 *
 * The payload arrives untyped and is narrowed at the point of use. A listener
 * returns nothing: the value a handler returns is not read back, and the
 * payload it received is not written to.
 *
 * @param payload The event's payload.
 */
export type EngineEventHandler = (payload: unknown) => void;

/**
 * The event source this module attaches to: the engine's own `on`, with its
 * `off` optional.
 */
export type EngineEventSource = Pick<EngineEvents, 'on'> &
  Partial<Pick<EngineEvents, 'off'>>;

/**
 * The mute and volume preferences, as this module reads them.
 *
 * Declared structurally, by the three members this module calls, so the audio
 * layer needs no import from the accessibility layer: `PreferenceStore` of
 * src/ui/a11y/settings.ts satisfies it as written.
 */
export interface SoundPreferenceSource {
  /** Whether audio is muted. */
  isMuted(): boolean;

  /** The volume in force, `MIN_VOLUME` through `MAX_VOLUME`. */
  getVolume(): number;

  /**
   * Observes later changes.
   *
   * @param listener Called after any preference changes.
   * @returns A function that stops the observation.
   */
  subscribe(listener: () => void): () => void;
}

/**
 * A target the gesture listeners are installed on, declared by the two members
 * this module calls. A `Document`, a `Window` and any other `EventTarget` all
 * satisfy it.
 */
export interface UnlockTarget {
  /**
   * Installs one listener.
   *
   * @param type Event type to listen for.
   * @param listener Called when the event fires.
   * @param options Listener options.
   */
  addEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: { once?: boolean; passive?: boolean },
  ): void;

  /**
   * Removes one listener.
   *
   * @param type Event type the listener was installed for.
   * @param listener The exact function that was installed.
   */
  removeEventListener(
    type: string,
    listener: (event: Event) => void,
  ): void;
}

/** Collaborators and initial preferences a sound engine accepts. */
export interface SoundEngineOptions {
  /** Sink reports are delivered to. A no-op sink when omitted. */
  readonly reporter?: SoundReporter;

  /** Sink counter increments are delivered to. A no-op sink when omitted. */
  readonly metrics?: SoundMetricsRecorder;

  /** The preference store this engine reads mute and volume from. */
  readonly preferences?: SoundPreferenceSource;

  /**
   * Whether the engine starts muted. `DEFAULT_MUTED` when omitted, and ignored
   * entirely when `preferences` is supplied.
   */
  readonly muted?: boolean;

  /**
   * Volume the master gain starts at, `MIN_VOLUME` through `MAX_VOLUME`.
   * `DEFAULT_VOLUME` when omitted or when the value is not finite; a finite
   * value outside the range is brought into it.
   */
  readonly volume?: number;

  /**
   * Targets the gesture listeners are installed on. The document when omitted,
   * and no target at all where there is no document.
   */
  readonly unlockTargets?: readonly UnlockTarget[];

  /**
   * Voices allowed to sound at once. `DEFAULT_MAX_VOICES` when omitted or when
   * the value is not a positive finite number; a larger value is capped at
   * `VOICE_CEILING_LIMIT`.
   */
  readonly maxConcurrentVoices?: number;
}

/** The engine's state, as `getState` reports it. */
export interface SoundEngineState {
  /** Whether an AudioContext constructor was found. */
  readonly available: boolean;

  /** Whether a user gesture has brought the context to `'running'`. */
  readonly unlocked: boolean;

  /** The context's own state, or `null` while there is no context. */
  readonly contextState: string | null;

  /** Whether the master gain is held at silence. */
  readonly muted: boolean;

  /** Volume the master gain is held at while not muted. */
  readonly volume: number;

  /** Voices currently in the graph. */
  readonly liveVoices: number;

  /** Voices allowed to sound at once. */
  readonly maxConcurrentVoices: number;

  /** Play requests received, before any gate. */
  readonly playsRequested: number;

  /** Play requests that reached the graph as a voice. */
  readonly playsStarted: number;

  /** Play requests that produced no voice. */
  readonly playsDropped: number;

  /** Contained failures of the engine's own work. */
  readonly failures: number;

  /** Description of the most recent contained failure. */
  readonly lastFailure: string | null;

  /** Invocations of the injected reporter or recorder that threw. */
  readonly reporterFaults: number;

  /** Description of the most recent reporter or recorder throw. */
  readonly lastReporterFault: string | null;

  /** Whether `dispose` has run. */
  readonly disposed: boolean;
}

/**
 * The audio layer.
 *
 * Every member is safe to call at any time, in any order, however many times,
 * and on an engine that found no AudioContext constructor, was never unlocked,
 * or has been disposed. No member throws.
 */
export interface SoundEngine {
  /**
   * Registers this engine's listeners on an event source.
   *
   * Registering the same source twice installs one set of listeners.
   *
   * @param events Source to listen to.
   */
  subscribe(events: EngineEventSource): void;

  /**
   * Sounds one effect.
   *
   * Nothing sounds while there is no running context, while muted, while the
   * voice ceiling is reached, or after disposal.
   *
   * @param name Effect to sound.
   */
  play(name: SoundEffectName): void;

  /**
   * Creates the context on first call and brings it to `'running'`.
   *
   * Called from a user-gesture handler. Repeated calls create one context, one
   * master gain and one report; a call made while a resume is in flight starts
   * no second resume.
   */
  unlock(): void;

  /**
   * Holds the master gain at silence, or returns it to the stored volume.
   *
   * The stored volume is unchanged by either direction: unmuting restores
   * exactly the volume that was in force.
   *
   * @param muted Whether to hold the master gain at silence.
   */
  setMuted(muted: boolean): void;

  /** Whether the master gain is held at silence. */
  isMuted(): boolean;

  /**
   * Sets the volume the master gain is held at while not muted.
   *
   * A finite value outside `MIN_VOLUME` through `MAX_VOLUME` is brought into
   * the range; a value that is not finite leaves the volume unchanged.
   *
   * @param volume Volume to hold.
   */
  setVolume(volume: number): void;

  /** The volume in force. */
  getVolume(): number;

  /** The readable state, as a fresh frozen object. */
  getState(): SoundEngineState;

  /**
   * Removes every listener installed, stops and disconnects every live voice,
   * disconnects the master gain and closes the context.
   *
   * `getState` remains readable and truthful afterwards, and every other
   * member remains safe to call.
   */
  dispose(): void;
}

/** Voices allowed to sound at once when the caller supplies none. */
const DEFAULT_MAX_VOICES = 12;

/** Highest voice ceiling a caller can ask for. */
const VOICE_CEILING_LIMIT = 64;

/** Milliseconds in one second. */
const MS_PER_SECOND = 1000;

/** Gain an envelope starts and ends an exponential ramp at. */
const GAIN_EPSILON = 0.0001;

/** Seconds a mute or volume change is ramped over. */
const GAIN_RAMP_SECONDS = 0.02;

/** Shortest sounding time a voice is scheduled for, in seconds. */
const MIN_VOICE_SECONDS = 0.001;

/** Pitch a voice falls back to where a descriptor carries no usable one. */
const FALLBACK_FREQUENCY_HZ = 440;

/** Highest pitch a voice is scheduled at. */
const MAX_FREQUENCY_HZ = 20000;

/** Resonance of the band-pass a noise voice is filtered through. */
const NOISE_FILTER_Q = 1.4;

/** Seconds of noise the shared buffer holds. */
const NOISE_BUFFER_SECONDS = 1;

/** Sample rate the noise buffer falls back to. */
const FALLBACK_SAMPLE_RATE = 44100;

/** Multiplier of the noise generator's linear congruence. */
const NOISE_MULTIPLIER = 1664525;

/** Increment of the noise generator's linear congruence. */
const NOISE_INCREMENT = 1013904223;

/** Modulus of the noise generator's linear congruence. */
const NOISE_MODULUS = 4294967296;

/** Fixed starting state of the noise generator. */
const NOISE_SEED = 2654435769;

/** Gesture types an unlock listener is installed for. */
const UNLOCK_EVENT_TYPES: readonly string[] = Object.freeze([
  'pointerdown',
  'keydown',
  'touchend',
]);

/** Context state a resumed context reports. */
const RUNNING_STATE = 'running';

/** Context state a closed context reports. */
const CLOSED_STATE = 'closed';


/** The constructor an AudioContext is created through. */
type AudioContextConstructor = new () => AudioContext;

/** The global members this module reads. */
interface AudioCapableGlobal {
  readonly AudioContext?: AudioContextConstructor;

  readonly webkitAudioContext?: AudioContextConstructor;

  readonly document?: Document;
}

/** The global scope, as the members above. */
function audioGlobal(): AudioCapableGlobal {
  return globalThis;
}

/**
 * Finds an AudioContext constructor, preferring the unprefixed one.
 *
 * @returns The constructor, or `null` where the host carries neither.
 */
function resolveAudioContextConstructor(): AudioContextConstructor | null {
  const scope = audioGlobal();

  const standard = scope.AudioContext;
  if (typeof standard === 'function') {
    return standard;
  }

  const prefixed = scope.webkitAudioContext;
  if (typeof prefixed === 'function') {
    return prefixed;
  }

  return null;
}

/**
 * The targets gesture listeners are installed on when the caller names none.
 *
 * @returns The document in a single-entry list, or an empty list where there
 *   is no document to listen on.
 */
function resolveDefaultUnlockTargets(): readonly UnlockTarget[] {
  const doc = audioGlobal().document;

  if (doc === undefined || doc === null) {
    return [];
  }
  if (
    typeof doc.addEventListener !== 'function' ||
    typeof doc.removeEventListener !== 'function'
  ) {
    return [];
  }

  return [doc];
}

/**
 * Keeps only the entries that carry both listener members.
 *
 * @param targets Targets the caller supplied, or `undefined`.
 * @returns The usable targets, or the default targets where the caller
 *   supplied none.
 */
function normaliseUnlockTargets(
  targets: readonly UnlockTarget[] | undefined,
): readonly UnlockTarget[] {
  if (targets === undefined) {
    return resolveDefaultUnlockTargets();
  }

  return targets.filter(
    (target: UnlockTarget): boolean =>
      typeof target.addEventListener === 'function' &&
      typeof target.removeEventListener === 'function',
  );
}

/**
 * Reports whether a value can be waited on.
 *
 * @param value Value returned by a context member.
 * @returns Whether `value` carries a callable `then`.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return 'then' in value && typeof value.then === 'function';
}

/**
 * Converts a duration to seconds, treating a value that is not finite or is
 * negative as zero.
 *
 * @param milliseconds Duration in milliseconds.
 * @returns The duration in seconds, never negative.
 */
function msToSeconds(milliseconds: number | undefined): number {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) {
    return 0;
  }

  return Math.max(milliseconds, 0) / MS_PER_SECOND;
}

/**
 * Reads a volume off a preference source without trusting it.
 *
 * @param source Source to read.
 * @returns The volume, or a non-finite value the caller normalises.
 */
function readPreferredVolume(source: SoundPreferenceSource): number {
  try {
    return source.getVolume();
  } catch {
    // A throwing store is not allowed to fail construction; the caller
    // normalises the result to the default.
    return Number.NaN;
  }
}

/**
 * Reads the mute state off a preference source without trusting it.
 *
 * @param source Source to read.
 * @param fallback Value used where the source throws.
 * @returns The mute state.
 */
function readPreferredMuted(
  source: SoundPreferenceSource,
  fallback: boolean,
): boolean {
  try {
    return source.isMuted() === true;
  } catch {
    return fallback;
  }
}

/**
 * Brings a volume into range.
 *
 * @param value Candidate volume.
 * @param fallback Volume returned where `value` is not finite.
 * @returns `value` bounded by `MIN_VOLUME` and `MAX_VOLUME`, or `fallback`.
 */
function normaliseVolume(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, value));
}

/**
 * Brings a voice ceiling into range.
 *
 * @param value Candidate ceiling.
 * @returns A whole number of voices, at least one and at most
 *   `VOICE_CEILING_LIMIT`, or `DEFAULT_MAX_VOICES` where `value` is not a
 *   usable number.
 */
function normaliseVoiceCeiling(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return DEFAULT_MAX_VOICES;
  }

  return Math.min(VOICE_CEILING_LIMIT, Math.floor(value));
}

/**
 * Brings an envelope peak into the range an exponential ramp accepts.
 *
 * @param value Peak a descriptor carries.
 * @returns A gain strictly above zero and at most `MAX_VOLUME`.
 */
function clampGain(value: number): number {
  if (!Number.isFinite(value)) {
    return GAIN_EPSILON;
  }

  return Math.min(MAX_VOLUME, Math.max(GAIN_EPSILON, value));
}

/**
 * Brings a pitch into the range an oscillator and a filter accept.
 *
 * @param value Pitch a descriptor carries, in Hz.
 * @returns A pitch strictly above zero and at most `MAX_FREQUENCY_HZ`, or
 *   `FALLBACK_FREQUENCY_HZ` where `value` is unusable.
 */
function clampFrequency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return FALLBACK_FREQUENCY_HZ;
  }

  return Math.min(MAX_FREQUENCY_HZ, value);
}

/**
 * Brings a detune offset into a finite range.
 *
 * @param value Offset a descriptor carries, in cents.
 * @returns The offset, or `0` where `value` is unusable.
 */
function clampDetune(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 0;
  }

  return value;
}

/** Narrows a value to one whose named fields can be read. */
function isReadableRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads one field of a payload as a finite number.
 *
 * @param payload The payload, as the event source delivered it.
 * @param field Field to read.
 * @returns The value, or `null` where the payload or the field cannot be
 *   read as a finite number.
 */
function readFiniteNumber(payload: unknown, field: string): number | null {
  if (!isReadableRecord(payload)) {
    return null;
  }

  const value = payload[field];

  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Reports whether a `tile:spawn` payload names a cell a tile was inserted at.
 *
 * @param payload The event's payload.
 * @returns `true` when the payload carries a position with two finite
 *   coordinates.
 */
function hasSpawnPosition(payload: unknown): boolean {
  if (!isReadableRecord(payload)) {
    return false;
  }

  const position = payload.position;

  if (!isReadableRecord(position)) {
    return false;
  }

  return (
    typeof position.x === 'number' &&
    Number.isFinite(position.x) &&
    typeof position.y === 'number' &&
    Number.isFinite(position.y)
  );
}

/**
 * Fills a channel with the fixed sequence a noise voice is built from.
 *
 * @param channel Channel data to fill, in place.
 */
function fillNoiseChannel(channel: Float32Array): void {
  let state = NOISE_SEED;

  for (let index = 0; index < channel.length; index += 1) {
    state = (state * NOISE_MULTIPLIER + NOISE_INCREMENT) % NOISE_MODULUS;
    channel[index] = (state / NOISE_MODULUS) * 2 - 1;
  }
}


/** One sounding voice, as the engine holds it until it ends. */
interface Voice {
  /** The oscillator or buffer source the voice is built on. */
  readonly source: AudioScheduledSourceNode;

  /** The gain carrying the voice's envelope. */
  readonly gain: GainNode;

  /** The band-pass a noise voice is filtered through, else `null`. */
  readonly filter: BiquadFilterNode | null;
}

/** The four times one voice's envelope is scheduled at, in seconds. */
interface VoiceSchedule {
  /** When the voice starts. */
  readonly startAt: number;

  /** When the gain reaches the descriptor's peak. */
  readonly attackEndsAt: number;

  /** When the gain leaves the descriptor's peak. */
  readonly holdEndsAt: number;

  /** When the gain reaches silence and the source stops. */
  readonly endsAt: number;
}

/**
 * Reads a context's clock.
 *
 * @param context Context to read.
 * @returns The current time in seconds, or `0` where the clock reads as a
 *   value that is not finite.
 */
function readClock(context: AudioContext): number {
  const now = context.currentTime;

  return Number.isFinite(now) ? now : 0;
}

/**
 * Lays one descriptor out on a context's clock.
 *
 * @param context Context whose clock the times are measured from.
 * @param effect Descriptor being sounded.
 * @returns The four times the envelope is scheduled at.
 */
function scheduleFor(
  context: AudioContext,
  effect: SoundEffect,
): VoiceSchedule {
  const startAt = readClock(context) + msToSeconds(effect.startOffsetMs);
  const attackEndsAt = startAt + msToSeconds(effect.attackMs);
  const holdEndsAt = attackEndsAt + msToSeconds(effect.holdMs);
  const endsAt = Math.max(
    holdEndsAt + msToSeconds(effect.releaseMs),
    startAt + MIN_VOICE_SECONDS,
  );

  return { startAt, attackEndsAt, holdEndsAt, endsAt };
}

/**
 * Schedules a voice's gain: up to the descriptor's peak, held, then down to
 * silence.
 *
 * @param gain Per-voice gain the envelope is written to.
 * @param effect Descriptor supplying the peak.
 * @param schedule Times the envelope is laid out on.
 */
function applyEnvelope(
  gain: GainNode,
  effect: SoundEffect,
  schedule: VoiceSchedule,
): void {
  const peak = clampGain(effect.peakGain);
  const param = gain.gain;

  param.setValueAtTime(GAIN_EPSILON, schedule.startAt);

  if (schedule.attackEndsAt > schedule.startAt) {
    param.exponentialRampToValueAtTime(peak, schedule.attackEndsAt);
  } else {
    param.setValueAtTime(peak, schedule.startAt);
  }

  if (schedule.holdEndsAt > schedule.attackEndsAt) {
    param.setValueAtTime(peak, schedule.holdEndsAt);
  }

  const releaseFrom = Math.max(schedule.holdEndsAt, schedule.attackEndsAt);
  if (schedule.endsAt > releaseFrom) {
    param.exponentialRampToValueAtTime(GAIN_EPSILON, schedule.endsAt);
  }

  param.setValueAtTime(0, schedule.endsAt);
}

/**
 * Schedules an oscillator's pitch, its glide and its detune offset.
 *
 * @param oscillator Oscillator being scheduled.
 * @param effect Descriptor supplying the pitches and the offset.
 * @param schedule Times the pitch is laid out on.
 */
function applyPitch(
  oscillator: OscillatorNode,
  effect: SoundEffect,
  schedule: VoiceSchedule,
): void {
  const from = clampFrequency(effect.frequencyHz);
  oscillator.frequency.setValueAtTime(from, schedule.startAt);

  const detune = clampDetune(effect.detuneCents);
  if (detune !== 0) {
    oscillator.detune.setValueAtTime(detune, schedule.startAt);
  }

  if (effect.rampToHz === undefined) {
    return;
  }

  const to = clampFrequency(effect.rampToHz);
  if (to === from || schedule.endsAt <= schedule.startAt) {
    return;
  }

  oscillator.frequency.exponentialRampToValueAtTime(to, schedule.endsAt);
}

/**
 * Builds the audio layer.
 *
 * Creates no context and installs no gesture listener beyond the ones the
 * unlock path needs, performs no I/O and reads no store. The returned object
 * is frozen and every member of it is safe to call at once.
 *
 * @param options Collaborators and initial preferences. Every field is
 *   optional.
 * @returns The engine.
 */
export function createSoundEngine(
  options: SoundEngineOptions = {},
): SoundEngine {
  const diagnostics = createDiagnostics(
    options.reporter ?? NOOP_SOUND_REPORTER,
    options.metrics ?? NOOP_SOUND_METRICS,
  );

  const contextConstructor = resolveAudioContextConstructor();
  const available = contextConstructor !== null;
  const unlockTargets = normaliseUnlockTargets(options.unlockTargets);
  const voiceCeiling = normaliseVoiceCeiling(options.maxConcurrentVoices);

  const preferences = options.preferences ?? null;

  // With a store supplied it is the only source: the `volume` and `muted`
  // options are not consulted at all, so the two cannot start out disagreeing.
  let volume =
    preferences === null
      ? normaliseVolume(options.volume, DEFAULT_VOLUME)
      : normaliseVolume(readPreferredVolume(preferences), DEFAULT_VOLUME);
  let muted =
    preferences === null
      ? (options.muted ?? DEFAULT_MUTED)
      : readPreferredMuted(preferences, DEFAULT_MUTED);

  let context: AudioContext | null = null;
  let masterGain: GainNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;
  let unlocked = false;
  let resumePending = false;
  let disposed = false;

  let playsRequested = 0;
  let playsStarted = 0;
  let playsDropped = 0;

  /** The terminal effect most recently sounded, reset when state leaves it. */
  let lastTerminal: SoundEffectName | null = null;

  const voices = new Set<Voice>();
  const subscribedSources = new Set<EngineEventSource>();

  /** One release handle per registered handler, across every source. */
  const releases: (() => void)[] = [];

  /** One installed gesture listener, as it is removed by. */
  interface ArmedListener {
    readonly target: UnlockTarget;
    readonly type: string;
    readonly listener: (event: Event) => void;
  }

  const armed: ArmedListener[] = [];

  let stateListener: (() => void) | null = null;

  /**
   * Disconnects one node.
   *
   * @param node Node to disconnect, or `null` for nothing to do.
   */
  const disconnectNode = (node: AudioNode | null): void => {
    if (node === null) {
      return;
    }

    try {
      node.disconnect();
    } catch (thrown) {
      diagnostics.noteFailure(
        'disconnect-failed',
        'graph-failed',
        'A node could not be disconnected.',
        thrown,
      );
    }
  };

  /**
   * Takes one voice out of the graph.
   *
   * Doing this twice for one voice disconnects once.
   *
   * @param voice Voice to release.
   */
  const releaseVoice = (voice: Voice): void => {
    if (!voices.delete(voice)) {
      return;
    }

    disconnectNode(voice.source);
    disconnectNode(voice.filter);
    disconnectNode(voice.gain);
    diagnostics.count(METRIC_VOICE_RELEASED);
  };

  /** Stops and releases every voice in the graph. */
  const stopAllVoices = (): void => {
    for (const voice of Array.from(voices)) {
      try {
        voice.source.stop();
      } catch (thrown) {
        diagnostics.noteFailure(
          'voice-stop-failed',
          'voice-failed',
          'A voice could not be stopped.',
          thrown,
        );
      }

      releaseVoice(voice);
    }
  };

  /** Ramps the master gain to the volume the mute state selects. */
  const applyMasterGain = (): void => {
    const activeContext = context;
    const master = masterGain;

    if (activeContext === null || master === null) {
      return;
    }

    const target = muted ? MIN_VOLUME : volume;

    try {
      const param = master.gain;
      const now = readClock(activeContext);
      const current = Number.isFinite(param.value) ? param.value : target;

      param.cancelScheduledValues(now);
      param.setValueAtTime(current, now);
      param.linearRampToValueAtTime(target, now + GAIN_RAMP_SECONDS);
    } catch (thrown) {
      diagnostics.noteFailure(
        'master-gain-ramp-failed',
        'graph-failed',
        'The master gain could not be ramped.',
        thrown,
      );
    }
  };

  /**
   * Creates the master gain and connects it to the context's destination.
   *
   * @returns Whether the master gain is in place.
   */
  const createMasterGain = (): boolean => {
    const activeContext = context;

    if (activeContext === null) {
      return false;
    }

    try {
      const gain = activeContext.createGain();

      gain.gain.setValueAtTime(
        muted ? MIN_VOLUME : volume,
        readClock(activeContext),
      );
      gain.connect(activeContext.destination);
      masterGain = gain;

      return true;
    } catch (thrown) {
      diagnostics.noteFailure(
        'master-gain-create-failed',
        'graph-failed',
        'The master gain could not be created.',
        thrown,
      );

      return false;
    }
  };


  /** Removes every gesture listener currently installed. */
  const disarmUnlockListeners = (): void => {
    while (armed.length > 0) {
      const entry = armed.pop();

      if (entry === undefined) {
        return;
      }

      try {
        entry.target.removeEventListener(entry.type, entry.listener);
      } catch (thrown) {
        diagnostics.noteFailure(
          'unlock-unlisten-failed',
          'listener-failed',
          'A gesture listener could not be removed.',
          thrown,
          { type: entry.type },
        );
      }
    }
  };

  /**
   * Installs one one-shot gesture listener per type per target, after removing
   * any still installed.
   *
   * Does nothing once the context is running, once disposed, or where no
   * constructor was found.
   */
  const armUnlockListeners = (): void => {
    disarmUnlockListeners();

    if (!available || disposed || unlocked) {
      return;
    }

    for (const target of unlockTargets) {
      for (const type of UNLOCK_EVENT_TYPES) {
        try {
          target.addEventListener(type, gestureListener, {
            once: true,
            passive: true,
          });
          armed.push({ target, type, listener: gestureListener });
        } catch (thrown) {
          diagnostics.noteFailure(
            'unlock-listen-failed',
            'listener-failed',
            'A gesture listener could not be installed.',
            thrown,
            { type },
          );
        }
      }
    }
  };

  /** Records that the context is running and stops listening for gestures. */
  const markUnlocked = (): void => {
    const first = !unlocked;

    unlocked = true;
    disarmUnlockListeners();

    if (!first) {
      return;
    }

    diagnostics.count(METRIC_UNLOCK_SUCCEEDED);
    diagnostics.reportOnce('context-unlocked', {
      level: 'info',
      code: 'context-unlocked',
      message: 'The audio context is running.',
      details: { volume, muted },
    });
  };

  /**
   * Records that the context is not running and listens for the next gesture.
   */
  const markLocked = (): void => {
    unlocked = false;
    diagnostics.count(METRIC_UNLOCK_FAILED);
    armUnlockListeners();
  };

  /** Reads the context's state without letting the read throw. */
  const readContextState = (target: AudioContext): string | null => {
    try {
      const state: string = target.state;

      return state;
    } catch (thrown) {
      diagnostics.noteFailure(
        'context-state-unreadable',
        'context-state-changed',
        'The audio context state could not be read.',
        thrown,
      );

      return null;
    }
  };

  /** Resumes the context, at most one resume in flight at a time. */
  const requestResume = (): void => {
    const activeContext = context;

    if (activeContext === null || resumePending || disposed) {
      return;
    }

    resumePending = true;

    let pending: unknown = null;

    try {
      pending = activeContext.resume();
    } catch (thrown) {
      resumePending = false;
      diagnostics.noteFailure(
        'context-resume-failed',
        'context-resume-failed',
        'The audio context could not be resumed.',
        thrown,
      );
      markLocked();

      return;
    }

    if (!isThenable(pending)) {
      resumePending = false;
      settleResume();

      return;
    }

    pending.then(
      (): void => {
        resumePending = false;
        settleResume();
      },
      (reason: unknown): void => {
        resumePending = false;
        diagnostics.noteFailure(
          'context-resume-rejected',
          'context-resume-failed',
          'The audio context rejected the resume.',
          reason,
        );
        markLocked();
      },
    );
  };

  /** Records the outcome of a resume from the context's own state. */
  const settleResume = (): void => {
    const activeContext = context;

    if (activeContext === null || disposed) {
      return;
    }

    if (readContextState(activeContext) === RUNNING_STATE) {
      markUnlocked();

      return;
    }

    markLocked();
  };

  /** Brings an existing context to running, resuming it where it is not. */
  const finishUnlock = (): void => {
    const activeContext = context;

    if (activeContext === null) {
      return;
    }

    if (readContextState(activeContext) === RUNNING_STATE) {
      markUnlocked();

      return;
    }

    requestResume();
  };

  /** Handles a state change of the context. */
  const handleStateChange = (): void => {
    const activeContext = context;

    if (activeContext === null || disposed) {
      return;
    }

    diagnostics.count(METRIC_STATE_CHANGED);

    const state = readContextState(activeContext);

    if (state === RUNNING_STATE) {
      markUnlocked();

      return;
    }

    unlocked = false;

    if (state === CLOSED_STATE) {
      return;
    }

    diagnostics.reportOnce('context-state-changed', {
      level: 'info',
      code: 'context-state-changed',
      message: 'The audio context left the running state.',
      details: { state },
    });
    armUnlockListeners();
  };

  /** Installs the state-change listener on the context. */
  const attachStateChange = (): void => {
    const activeContext = context;

    if (activeContext === null) {
      return;
    }

    const listener = (): void => {
      handleStateChange();
    };

    try {
      activeContext.addEventListener('statechange', listener);
      stateListener = listener;
    } catch (thrown) {
      diagnostics.noteFailure(
        'statechange-listen-failed',
        'listener-failed',
        'The state-change listener could not be installed.',
        thrown,
      );
    }
  };

  /** Removes the state-change listener from the context. */
  const detachStateChange = (): void => {
    const activeContext = context;
    const listener = stateListener;

    stateListener = null;

    if (activeContext === null || listener === null) {
      return;
    }

    try {
      activeContext.removeEventListener('statechange', listener);
    } catch (thrown) {
      diagnostics.noteFailure(
        'statechange-unlisten-failed',
        'listener-failed',
        'The state-change listener could not be removed.',
        thrown,
      );
    }
  };

  /**
   * Creates the one context this engine uses and its master gain.
   *
   * @returns Whether a context now exists.
   */
  const createContext = (): boolean => {
    if (contextConstructor === null) {
      return false;
    }

    let created: AudioContext;

    try {
      created = new contextConstructor();
    } catch (thrown) {
      diagnostics.noteFailure(
        'context-construct-failed',
        'context-construct-failed',
        'The audio context could not be created.',
        thrown,
      );

      return false;
    }

    context = created;
    attachStateChange();
    createMasterGain();

    return true;
  };

  /**
   * Creates the context on the first call and brings it to running.
   *
   * @returns Nothing. A second call while a resume is in flight adds no
   *   context, no master gain and no resume.
   */
  const unlock = (): void => {
    if (disposed || !available) {
      return;
    }

    diagnostics.count(METRIC_UNLOCK_ATTEMPTED);

    if (context === null && !createContext()) {
      markLocked();

      return;
    }

    finishUnlock();
  };

  /** The one function every gesture listener is installed with. */
  const gestureListener = (): void => {
    unlock();
  };


  /**
   * The noise buffer every noise voice reads, created on first use.
   *
   * @param activeContext Context the buffer belongs to.
   * @returns The buffer, or `null` where it could not be created.
   */
  const ensureNoiseBuffer = (
    activeContext: AudioContext,
  ): AudioBuffer | null => {
    if (noiseBuffer !== null) {
      return noiseBuffer;
    }

    try {
      const rate = Number.isFinite(activeContext.sampleRate)
        ? activeContext.sampleRate
        : FALLBACK_SAMPLE_RATE;
      const frames = Math.max(1, Math.floor(rate * NOISE_BUFFER_SECONDS));
      const buffer = activeContext.createBuffer(1, frames, rate);

      fillNoiseChannel(buffer.getChannelData(0));
      noiseBuffer = buffer;

      return buffer;
    } catch (thrown) {
      diagnostics.noteFailure(
        'noise-buffer-failed',
        'voice-failed',
        'The noise buffer could not be created.',
        thrown,
      );

      return null;
    }
  };

  /**
   * Counts one play request that produced no voice.
   *
   * @param reason Counter naming the reason, or `null` for no further
   *   counter.
   */
  const dropPlay = (reason: string | null): void => {
    playsDropped += 1;
    diagnostics.count(METRIC_PLAY_DROPPED);

    if (reason !== null) {
      diagnostics.count(reason);
    }
  };

  /**
   * Builds one voice for a descriptor and schedules it on the context's clock.
   *
   * @param effect Descriptor being sounded.
   * @returns Whether a voice reached the graph.
   */
  const startVoice = (effect: SoundEffect): boolean => {
    const activeContext = context;
    const master = masterGain;

    if (activeContext === null || master === null) {
      return false;
    }

    let source: AudioScheduledSourceNode | null = null;
    let filter: BiquadFilterNode | null = null;
    let gain: GainNode | null = null;
    let pending: Voice | null = null;

    try {
      const schedule = scheduleFor(activeContext, effect);

      gain = activeContext.createGain();
      applyEnvelope(gain, effect, schedule);

      if (effect.noise === true) {
        const buffer = ensureNoiseBuffer(activeContext);

        if (buffer === null) {
          disconnectNode(gain);

          return false;
        }

        const bufferSource = activeContext.createBufferSource();

        bufferSource.buffer = buffer;
        bufferSource.loop = true;

        filter = activeContext.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(
          clampFrequency(effect.frequencyHz),
          schedule.startAt,
        );
        filter.Q.setValueAtTime(NOISE_FILTER_Q, schedule.startAt);

        bufferSource.connect(filter);
        filter.connect(gain);
        source = bufferSource;
      } else {
        const oscillator = activeContext.createOscillator();

        oscillator.type = effect.waveform;
        applyPitch(oscillator, effect, schedule);
        oscillator.connect(gain);
        source = oscillator;
      }

      gain.connect(master);

      const voice: Voice = { source, gain, filter };

      source.addEventListener('ended', (): void => {
        releaseVoice(voice);
      });
      voices.add(voice);
      pending = voice;

      source.start(schedule.startAt);
      source.stop(schedule.endsAt);

      return true;
    } catch (thrown) {
      diagnostics.noteFailure(
        'voice-build-failed',
        'voice-failed',
        'A voice could not be built.',
        thrown,
        { waveform: effect.waveform, noise: effect.noise ?? false },
      );

      if (pending !== null) {
        releaseVoice(pending);
      } else {
        disconnectNode(source);
        disconnectNode(filter);
        disconnectNode(gain);
      }

      return false;
    }
  };

  /**
   * Sounds one descriptor, or counts the request as dropped.
   *
   * @param effect Descriptor to sound.
   */
  const playEffect = (effect: SoundEffect): void => {
    playsRequested += 1;
    diagnostics.count(METRIC_PLAY_REQUESTED);

    if (disposed) {
      dropPlay(null);

      return;
    }

    if (!available) {
      dropPlay(METRIC_PLAY_UNAVAILABLE);

      return;
    }

    if (muted) {
      dropPlay(METRIC_PLAY_MUTED);

      return;
    }

    const activeContext = context;

    if (activeContext === null || masterGain === null) {
      dropPlay(METRIC_PLAY_UNAVAILABLE);

      return;
    }

    // A voice is scheduled only while the context is running.
    if (readContextState(activeContext) !== RUNNING_STATE) {
      dropPlay(METRIC_PLAY_SUSPENDED);

      return;
    }

    if (voices.size >= voiceCeiling) {
      dropPlay(null);
      diagnostics.reportOnce('voice-dropped', {
        level: 'info',
        code: 'voice-dropped',
        message: 'A voice was dropped at the concurrency ceiling.',
        details: { ceiling: voiceCeiling },
      });

      return;
    }

    if (!startVoice(effect)) {
      dropPlay(null);

      return;
    }

    playsStarted += 1;
    diagnostics.count(METRIC_PLAY_STARTED);
  };

  /**
   * Sounds the effect one name selects.
   *
   * @param name Effect to sound.
   */
  const play = (name: SoundEffectName): void => {
    if (!Object.prototype.hasOwnProperty.call(soundMap, name)) {
      playsRequested += 1;
      diagnostics.count(METRIC_PLAY_REQUESTED);
      dropPlay(null);
      diagnostics.reportOnce('effect-unknown', {
        level: 'warn',
        code: 'effect-unknown',
        message: 'An effect that is not in the sound map was requested.',
        details: { name: String(name) },
      });

      return;
    }

    playEffect(soundMap[name]);
  };

  /**
   * Sounds the effect one event name selects.
   *
   * @param eventName Event the effect is selected for.
   */
  const playForEvent = (eventName: string): void => {
    const name = effectNameForEvent(eventName);

    if (name === null) {
      diagnostics.reportOnce(`effect-unknown:${eventName}`, {
        level: 'warn',
        code: 'effect-unknown',
        message: 'An event that selects no effect was handled.',
        details: { event: eventName },
      });

      return;
    }

    play(name);
  };


  /**
   * Wraps one handler body. Nothing thrown inside it escapes.
   *
   * @param eventName Event the handler is registered for.
   * @param body What the handler does with the payload.
   * @returns The handler, which returns nothing for every input.
   */
  const contained = (
    eventName: string,
    body: (payload: unknown) => void,
  ): EngineEventHandler => {
    return (payload: unknown): void => {
      try {
        body(payload);
      } catch (thrown) {
        diagnostics.noteFailure(
          `handler-failed:${eventName}`,
          'handler-failed',
          'A subscribed handler failed and was contained.',
          thrown,
          { event: eventName },
        );
      }
    };
  };

  /** Sounds the merge effect, pitched by the value the merge produced. */
  const handleMerge = contained('tile:merge', (payload: unknown): void => {
    const resultValue = readFiniteNumber(payload, 'resultValue');

    if (resultValue === null) {
      diagnostics.reportOnce('payload-unreadable:tile:merge', {
        level: 'warn',
        code: 'payload-unreadable',
        message: 'A tile:merge payload carried no readable resultValue.',
        details: { event: 'tile:merge' },
      });

      return;
    }

    playEffect(effectForMerge(resultValue));
  });

  /** Sounds the spawn effect, for an actual spawn alone. */
  const handleSpawn = contained('tile:spawn', (payload: unknown): void => {
    if (!hasSpawnPosition(payload)) {
      return;
    }

    playForEvent('tile:spawn');
  });

  /** Sounds the move effect for a move that changed the board. */
  const handleMoveAfter = contained('move:after', (payload: unknown): void => {
    if (!shouldPlayMove(payload)) {
      return;
    }

    playForEvent('move:after');
  });

  /** Sounds the stage-clear effect for a stage that was cleared. */
  const handleStageEnd = contained('stage:end', (payload: unknown): void => {
    if (!shouldPlayStageClear(payload)) {
      return;
    }

    playForEvent('stage:end');
  });

  /**
   * Sounds the win or the lose effect once per terminal state.
   *
   * A commit that carries no terminal state clears the record; the next
   * terminal state sounds again.
   */
  const handleCommit = contained('state:commit', (payload: unknown): void => {
    const terminal = terminalEffectName(payload);

    if (terminal === null) {
      lastTerminal = null;

      return;
    }

    if (terminal === lastTerminal) {
      return;
    }

    lastTerminal = terminal;
    play(terminal);
  });


  /**
   * Registers one handler on one source.
   *
   * @param events Source to register on.
   * @param eventName Event to register for.
   * @param handler Handler to register.
   */
  const register = (
    events: EngineEventSource,
    eventName: EngineEventName,
    handler: EngineEventHandler,
  ): (() => void) | null => {
    let result: unknown;

    try {
      result = events.on(eventName, handler);
    } catch (thrown) {
      diagnostics.noteFailure(
        `subscribe-failed:${eventName}`,
        'subscribe-failed',
        'A handler could not be registered on the event source.',
        thrown,
        { event: eventName },
      );

      return null;
    }

    // Normalised to one shape, so disposal has a single thing to call however
    // the source expressed removal.
    if (typeof result === 'function') {
      const release = result as () => unknown;

      return (): void => {
        release();
      };
    }

    const off = events.off;

    if (typeof off === 'function') {
      return (): void => {
        off.call(events, eventName, handler);
      };
    }

    diagnostics.reportOnce(`release-unavailable:${eventName}`, {
      level: 'warn',
      code: 'release-unavailable',
      message:
        'An event source returned no release handle and carries no off, so ' +
        'this handler cannot be removed on disposal.',
      details: { event: eventName },
    });

    return null;
  };

  /**
   * Releases every handler this engine registered, on every source.
   *
   * Each release is contained, so one source that throws while removing a
   * listener cannot leave the remaining sources subscribed.
   */
  const releaseSubscriptions = (): void => {
    const held = releases.splice(0, releases.length);

    for (const release of held) {
      try {
        release();
      } catch (thrown) {
        diagnostics.noteFailure(
          'release-failed',
          'release-failed',
          'A handler could not be removed from the event source.',
          thrown,
        );
      }
    }

    subscribedSources.clear();
  };

  /**
   * Registers every handler on one source.
   *
   * Registers nothing for a source already registered on, for a source
   * carrying no callable `on`, or once disposed. `move:before` and
   * `stage:start` are deliberately not registered for.
   *
   * @param events Source to listen to.
   */
  const subscribe = (events: EngineEventSource): void => {
    if (disposed) {
      return;
    }

    if (
      typeof events !== 'object' ||
      events === null ||
      typeof events.on !== 'function'
    ) {
      diagnostics.reportOnce('subscribe-failed:source', {
        level: 'warn',
        code: 'subscribe-failed',
        message: 'An event source carrying no callable on was supplied.',
      });

      return;
    }

    if (subscribedSources.has(events)) {
      return;
    }

    subscribedSources.add(events);

    // Every name registered for is one the engine's own contract declares and
    // emits.
    const names: readonly [EngineEventName, EngineEventHandler][] = [
      ['tile:merge', handleMerge],
      ['tile:spawn', handleSpawn],
      ['move:after', handleMoveAfter],
      ['stage:end', handleStageEnd],
      ['state:commit', handleCommit],
    ];

    const taken: (() => void)[] = [];

    let failed = false;

    for (const [eventName, handler] of names) {
      const release = register(events, eventName, handler);

      if (release === null) {
        failed = true;

        continue;
      }

      taken.push(release);
    }

    if (failed) {
      for (const release of taken) {
        try {
          release();
        } catch (thrown) {
          diagnostics.noteFailure(
            'release-failed',
            'release-failed',
            'A handler could not be removed from the event source.',
            thrown,
          );
        }
      }

      subscribedSources.delete(events);

      return;
    }

    releases.push(...taken);
  };

  /**
   * Holds the master gain at silence, or returns it to the stored volume.
   *
   * @param nextMuted Whether to hold the master gain at silence.
   */
  const setMuted = (nextMuted: boolean): void => {
    if (preferences !== null) {
      // The store owns the value, so writing it here would create the second
      // owner this option exists to remove.
      diagnostics.reportOnce('preference-owned:muted', {
        level: 'warn',
        code: 'preference-owned',
        message:
          'setMuted was refused because a preference store owns the mute ' +
          'state; set it on the store instead.',
      });

      return;
    }

    muted = nextMuted === true;
    applyMasterGain();
  };

  /**
   * Sets the volume the master gain is held at while not muted.
   *
   * @param nextVolume Volume to hold.
   */
  const setVolume = (nextVolume: number): void => {
    if (preferences !== null) {
      diagnostics.reportOnce('preference-owned:volume', {
        level: 'warn',
        code: 'preference-owned',
        message:
          'setVolume was refused because a preference store owns the volume; ' +
          'set it on the store instead.',
      });

      return;
    }

    volume = normaliseVolume(nextVolume, volume);
    applyMasterGain();
  };

  /** Takes the store's current mute and volume and applies them. */
  const adoptPreferences = (): void => {
    if (preferences === null || disposed) {
      return;
    }

    volume = normaliseVolume(readPreferredVolume(preferences), volume);
    muted = readPreferredMuted(preferences, muted);
    applyMasterGain();
  };

  /** Released by `dispose`; `null` where no store is followed. */
  const releasePreferences: (() => void) | null = ((): (() => void) | null => {
    if (preferences === null) {
      return null;
    }

    try {
      const release = preferences.subscribe((): void => {
        adoptPreferences();
      });

      return typeof release === 'function' ? release : null;
    } catch (thrown) {
      diagnostics.noteFailure(
        'subscribe-failed:preferences',
        'subscribe-failed',
        'The preference store could not be observed.',
        thrown,
      );

      return null;
    }
  })();

  /** The readable state, as a fresh frozen object. */
  const getState = (): SoundEngineState => {
    const activeContext = context;

    return Object.freeze({
      available,
      unlocked,
      contextState:
        activeContext === null ? null : readContextState(activeContext),
      muted,
      volume,
      liveVoices: voices.size,
      maxConcurrentVoices: voiceCeiling,
      playsRequested,
      playsStarted,
      playsDropped,
      failures: diagnostics.totals.failures,
      lastFailure: diagnostics.totals.lastFailure,
      reporterFaults: diagnostics.totals.reporterFaults,
      lastReporterFault: diagnostics.totals.lastReporterFault,
      disposed,
    });
  };

  /**
   * Closes one context.
   *
   * @param target Context to close.
   */
  const closeContext = (target: AudioContext): void => {
    let pending: unknown = null;

    try {
      pending = target.close();
    } catch (thrown) {
      diagnostics.noteFailure(
        'context-close-failed',
        'context-close-failed',
        'The audio context could not be closed.',
        thrown,
      );

      return;
    }

    if (!isThenable(pending)) {
      return;
    }

    pending.then(
      (): void => {},
      (reason: unknown): void => {
        diagnostics.noteFailure(
          'context-close-rejected',
          'context-close-failed',
          'The audio context rejected the close.',
          reason,
        );
      },
    );
  };

  /** Releases everything this engine installed, created or connected. */
  const dispose = (): void => {
    if (disposed) {
      return;
    }

    disposed = true;
    disarmUnlockListeners();
    detachStateChange();
    stopAllVoices();

    const master = masterGain;

    masterGain = null;
    disconnectNode(master);

    const activeContext = context;

    context = null;
    noiseBuffer = null;
    unlocked = false;
    resumePending = false;
    lastTerminal = null;
    releaseSubscriptions();

    if (releasePreferences !== null) {
      try {
        releasePreferences();
      } catch (thrown) {
        diagnostics.noteFailure(
          'release-failed',
          'release-failed',
          'The preference store observation could not be released.',
          thrown,
        );
      }
    }

    if (activeContext === null) {
      return;
    }

    closeContext(activeContext);
  };

  if (!available) {
    diagnostics.reportOnce('audio-unavailable', {
      level: 'warn',
      code: 'audio-unavailable',
      message:
        'No AudioContext constructor is available; the audio layer is ' +
        'silent.',
    });
  }

  armUnlockListeners();

  return Object.freeze({
    subscribe,
    play,
    unlock,
    setMuted,
    isMuted: (): boolean => muted,
    setVolume,
    getVolume: (): number => volume,
    getState,
    dispose,
  });
}
