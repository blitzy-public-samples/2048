// The audio layer: one synthesised Web Audio voice per sounded moment.
//
// WHAT THIS MODULE OWNS
//   the capability probe for an AudioContext constructor, standard or
//   prefixed;
//   the creation and the resume of the one context it uses, both on a user
//   gesture;
//   the master gain every voice passes through, and the mute state and
//   volume applied to it;
//   one voice per play request, built from a descriptor in
//   src/audio/sound-map.ts and scheduled on the context's own clock;
//   the readable state a diagnostics surface and a settings panel read.
//
// WHAT IT DOES NOT OWN
//   no markup, no DOM query for a control and no key binding: mute and
//   volume are methods, and the surface that drives them lives elsewhere;
//   no persistence: nothing here reads or writes a store;
//   no health probe: getState() is the readable surface;
//   no audio file and no second runtime dependency: every voice is
//   synthesised from an oscillator or from a generated noise buffer.
//
// HOW IT ATTACHES
//   subscribe() calls `on` on the source it is handed and nothing else. A
//   handler returns nothing, mutates no payload and lets nothing escape.
//
// Every duration in a descriptor is in milliseconds and every time handed
// to the Web Audio API is in seconds.
//
// Rationale for the decisions behind this file lives in the project
// decision log, not in these comments.

import type { SoundEffect, SoundEffectName } from './sound-map';
import {
  effectForMerge,
  effectNameForEvent,
  shouldPlayMove,
  shouldPlayStageClear,
  soundMap,
  terminalEffectName,
} from './sound-map';

/* ==========================================================================
 * 1. Reporting and metrics
 * ========================================================================== */

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
  | 'subscribe-failed';

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

/**
 * Sink every report reaches.
 *
 * A structured logger satisfies this through one adapter member: the level,
 * the message, the details and the caught value are all carried on the
 * report. `report` runs synchronously on the calling path, and a `report`
 * that throws is contained — the throw reaches neither the caller of the
 * audio operation being reported nor the sink that raised it, and it is
 * counted on `SoundEngineState.reporterFaults` and described by
 * `SoundEngineState.lastReporterFault`.
 */
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

/* --------------------------------------------------------------------------
 * Containment
 * ----------------------------------------------------------------------- */

/** Counters and descriptions the diagnostics boundary accumulates. */
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
   * Records a contained failure of this module's own work and reports it
   * once for `key`.
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

/**
 * Describes a caught value as text, preserving an `Error`'s own message.
 *
 * @param thrown The caught value.
 * @returns Text describing `thrown`.
 */
function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) {
    return thrown.message.length > 0 ? thrown.message : thrown.name;
  }
  if (typeof thrown === 'string') {
    return thrown.length > 0 ? thrown : 'Empty string thrown.';
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

  return Object.prototype.toString.call(thrown);
}

/**
 * Builds the boundary the reporter and the recorder are called through.
 *
 * A throw from either sink is contained on `totals` — counted on
 * `reporterFaults` and described on `lastReporterFault` — and is not handed
 * back to the sink that raised it.
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

/* ==========================================================================
 * 2. Public surface
 * ========================================================================== */

/**
 * A listener the event source calls with one payload.
 *
 * The payload arrives untyped and is narrowed at the point of use. A
 * listener returns nothing: the value a handler returns is not read back,
 * and the payload it received is not written to.
 *
 * @param payload The event's payload.
 */
export type EngineEventHandler = (payload: unknown) => void;

/**
 * The event source this module attaches to, declared by the one member it
 * calls.
 *
 * `on` is the whole contract: nothing here emits, removes another
 * subscriber's listener, or reads the source's own state. A source whose
 * `on` appends is what lets this module attach alongside every subscriber
 * already attached.
 */
export interface EngineEventSource {
  /**
   * Registers a listener for one event name.
   *
   * @param eventName Event to listen for.
   * @param handler Called with the event's payload.
   */
  on(eventName: string, handler: EngineEventHandler): void;
}

/**
 * A target the gesture listeners are installed on, declared by the two
 * members this module calls. A `Document`, a `Window` and any other
 * `EventTarget` all satisfy it.
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

  /** Whether the engine starts muted. `DEFAULT_MUTED` when omitted. */
  readonly muted?: boolean;

  /**
   * Volume the master gain starts at, `MIN_VOLUME` through `MAX_VOLUME`.
   * `DEFAULT_VOLUME` when omitted or when the value is not finite; a finite
   * value outside the range is brought into it.
   */
  readonly volume?: number;

  /**
   * Targets the gesture listeners are installed on. The document when
   * omitted, and no target at all where there is no document.
   */
  readonly unlockTargets?: readonly UnlockTarget[];

  /**
   * Voices allowed to sound at once. `DEFAULT_MAX_VOICES` when omitted or
   * when the value is not a positive finite number; a larger value is
   * capped at `VOICE_CEILING_LIMIT`.
   */
  readonly maxConcurrentVoices?: number;
}

/**
 * The engine's state, as a diagnostics surface or a settings panel reads
 * it.
 */
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
 * Every member is safe to call at any time, in any order, however many
 * times, and on an engine that found no AudioContext constructor, was never
 * unlocked, or has been disposed. No member throws.
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
   * Nothing sounds while there is no running context, while muted, while
   * the voice ceiling is reached, or after disposal.
   *
   * @param name Effect to sound.
   */
  play(name: SoundEffectName): void;

  /**
   * Creates the context on first call and brings it to `'running'`.
   *
   * Called from a user-gesture handler. Repeated calls create one context,
   * one master gain and one report; a call made while a resume is in flight
   * starts no second resume.
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
   * A finite value outside `MIN_VOLUME` through `MAX_VOLUME` is brought
   * into the range; a value that is not finite leaves the volume unchanged.
   *
   * @param volume Volume to hold.
   */
  setVolume(volume: number): void;

  /** The volume in force. */
  getVolume(): number;

  /** The readable state, as a fresh frozen object. */
  getState(): SoundEngineState;

  /**
   * Removes every listener installed, stops and disconnects every live
   * voice, disconnects the master gain and closes the context.
   *
   * `getState` remains readable and truthful afterwards, and every other
   * member remains safe to call.
   */
  dispose(): void;
}

/* ==========================================================================
 * 3. Bounds and fixed values
 * ========================================================================== */

/** Lowest volume the master gain is held at. */
const MIN_VOLUME = 0;

/** Highest volume the master gain is held at. */
const MAX_VOLUME = 1;

/** Volume in force when the caller supplies none. */
const DEFAULT_VOLUME = 0.6;

/** Mute state in force when the caller supplies none. */
const DEFAULT_MUTED = false;

/** Voices allowed to sound at once when the caller supplies none. */
const DEFAULT_MAX_VOICES = 12;

/** Highest voice ceiling a caller can ask for. */
const VOICE_CEILING_LIMIT = 64;

/** Milliseconds in one second. */
const MS_PER_SECOND = 1000;

/**
 * Gain an envelope starts and ends an exponential ramp at.
 * `exponentialRampToValueAtTime` requires a target strictly above zero.
 */
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


/* ==========================================================================
 * 4. Platform lookups
 * ========================================================================== */

/** The constructor an AudioContext is created through. */
type AudioContextConstructor = new () => AudioContext;

/**
 * The global members this module reads.
 *
 * Every member is optional. A host that carries none of them is read the
 * same way as one that carries all three, and no global declaration is
 * added for the prefixed constructor.
 */
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
 * The targets gesture listeners are installed on when the caller names
 * none.
 *
 * @returns The document in a single-entry list, or an empty list where
 *   there is no document to listen on.
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

/* ==========================================================================
 * 5. Numbers
 * ========================================================================== */

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

/* ==========================================================================
 * 6. Payload reading
 * ========================================================================== */

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

/* ==========================================================================
 * 7. Noise
 * ========================================================================== */

/**
 * Fills a channel with the fixed sequence a noise voice is built from.
 *
 * The sequence is a linear congruence over the sample index, started from
 * `NOISE_SEED`. One buffer of one length is always the same samples.
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


/* ==========================================================================
 * 8. Voice construction
 * ========================================================================== */

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
 * Every exponential ramp targets a value strictly above zero, and the hard
 * zero is set once the ramps are done.
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

/* ==========================================================================
 * 9. The engine
 * ========================================================================== */

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

  let volume = normaliseVolume(options.volume, DEFAULT_VOLUME);
  let muted = options.muted ?? DEFAULT_MUTED;

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

  /** One installed gesture listener, as it is removed by. */
  interface ArmedListener {
    readonly target: UnlockTarget;
    readonly type: string;
    readonly listener: (event: Event) => void;
  }

  const armed: ArmedListener[] = [];

  let stateListener: (() => void) | null = null;

  /* ----------------------------------------------------------------------
   * Node teardown
   * ------------------------------------------------------------------- */

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

  /* ----------------------------------------------------------------------
   * Master gain
   * ------------------------------------------------------------------- */

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


  /* ----------------------------------------------------------------------
   * Gesture listeners
   * ------------------------------------------------------------------- */

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
   * Installs one one-shot gesture listener per type per target, after
   * removing any still installed.
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

  /* ----------------------------------------------------------------------
   * Unlocking
   * ------------------------------------------------------------------- */

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
   * Records that the context is not running and listens for the next
   * gesture.
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


  /* ----------------------------------------------------------------------
   * Sounding
   * ------------------------------------------------------------------- */

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
   * Builds one voice for a descriptor and schedules it on the context's
   * clock.
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

    // A voice is scheduled only while the context is running. A context in
    // any other state holds its clock.
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


  /* ----------------------------------------------------------------------
   * Subscribed handlers
   * ------------------------------------------------------------------- */

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

  /** Sounds the spawn effect. The payload's position is never read. */
  const handleSpawn = contained('tile:spawn', (): void => {
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

  /** Sounds the relic-acquired effect. */
  const handleRelic = contained('relic:acquired', (): void => {
    playForEvent('relic:acquired');
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
    eventName: string,
    handler: EngineEventHandler,
  ): void => {
    try {
      events.on(eventName, handler);
    } catch (thrown) {
      diagnostics.noteFailure(
        `subscribe-failed:${eventName}`,
        'subscribe-failed',
        'A handler could not be registered on the event source.',
        thrown,
        { event: eventName },
      );
    }
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

    register(events, 'tile:merge', handleMerge);
    register(events, 'tile:spawn', handleSpawn);
    register(events, 'move:after', handleMoveAfter);
    register(events, 'stage:end', handleStageEnd);
    register(events, 'state:commit', handleCommit);
    register(events, 'relic:acquired', handleRelic);
  };

  /* ----------------------------------------------------------------------
   * Preferences, state and teardown
   * ------------------------------------------------------------------- */

  /**
   * Holds the master gain at silence, or returns it to the stored volume.
   *
   * @param nextMuted Whether to hold the master gain at silence.
   */
  const setMuted = (nextMuted: boolean): void => {
    muted = nextMuted === true;
    applyMasterGain();
  };

  /**
   * Sets the volume the master gain is held at while not muted.
   *
   * @param nextVolume Volume to hold.
   */
  const setVolume = (nextVolume: number): void => {
    volume = normaliseVolume(nextVolume, volume);
    applyMasterGain();
  };

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
    subscribedSources.clear();

    if (activeContext === null) {
      return;
    }

    closeContext(activeContext);
  };

  /* ----------------------------------------------------------------------
   * Wiring
   * ------------------------------------------------------------------- */

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

