// Contract suite for the audio layer's subscription ownership, preference
// ownership and event integration, AAP A5 and R9.
//
// Three properties are pinned here, none of them visible to the type checker:
//
//   detachment   `EngineEventSource.on` was typed `void`, so every release
//                handle the emitter returned was discarded. A disposed engine
//                therefore stayed registered on the emitter for the emitter's
//                whole life and went on receiving every event.
//   ownership    the accessibility surface's default volume was 1 and the
//                engine's was 0.6, and each held its own mute and volume, so
//                what a listener heard depended on which had last written the
//                master gain.
//   integration  the engine subscribed to `relic:acquired`, which no emitter
//                produces: `EngineEventPayloadMap` of
//                src/engine/engine-events.ts declares seven names and that
//                is not one of them.
//
// jsdom implements no Web Audio API, so the engine reports itself unavailable
// and synthesises nothing. That is the documented degradation and it leaves
// exactly the surface under test — subscription bookkeeping, preference
// ownership and the event-name table — fully exercisable.

import { describe, expect, it } from 'vitest';

// Vite's `?raw` query hands a module's own text to the suite. Read this way
// rather than through a Node builtin: this suite runs in the jsdom project,
// where `import.meta.url` is a served URL and not a file path, and the
// browser-context tsconfig types `*?raw` through vite/client while declaring
// no Node types at all.
import a11ySettingsSource from '../../../src/ui/a11y/settings.ts?raw';

import { createEngineEvents } from '../../../src/engine/engine-events';
import type {
  EngineEventName,
  EngineEventListener,
  EngineEventSubscription,
} from '../../../src/engine/engine-events';
import type {
  EngineEventSource,
  SoundPreferenceSource,
} from '../../../src/audio/sound-engine';
import { createSoundEngine } from '../../../src/audio/sound-engine';
import {
  DEFAULT_MUTED,
  DEFAULT_VOLUME,
  MAX_VOLUME,
  MIN_VOLUME,
  effectNameForEvent,
} from '../../../src/audio/sound-map';
import {
  DEFAULT_MUTED as CONFIG_DEFAULT_MUTED,
  DEFAULT_VOLUME as CONFIG_DEFAULT_VOLUME,
  MAX_VOLUME as CONFIG_MAX_VOLUME,
  MIN_VOLUME as CONFIG_MIN_VOLUME,
} from '../../../src/config/audio-bounds';
import {
  DEFAULT_MUTED as SETTINGS_DEFAULT_MUTED,
  DEFAULT_VOLUME as SETTINGS_DEFAULT_VOLUME,
  MAX_VOLUME as SETTINGS_MAX_VOLUME,
  MIN_VOLUME as SETTINGS_MIN_VOLUME,
  createPreferenceStore,
} from '../../../src/ui/a11y/settings';

/**
 * A listener stored by a fake emitter, whatever event it was registered for.
 *
 * `EngineEventListener<K>` for every `K` is assignable to this, so one set
 * holds listeners of every event without widening the fake's own `on` away
 * from the engine's generic signature — which is the mismatch the previous
 * broad fakes hid.
 */
type StoredListener = (payload: never) => void;

/** An emitter that records what is registered and what is released. */
const recordingSource = (): {
  source: EngineEventSource;
  registered(): readonly string[];
  live(): number;
} => {
  const names: string[] = [];
  const held = new Set<StoredListener>();

  return {
    source: {
      on: <K extends EngineEventName>(
        eventName: K,
        handler: EngineEventListener<K>,
      ): EngineEventSubscription => {
        names.push(eventName);
        held.add(handler);

        return (): void => {
          held.delete(handler);
        };
      },
    },
    registered: (): readonly string[] => names,
    live: (): number => held.size,
  };
};

/** An emitter that returns nothing from `on` but implements `off`. */
const offOnlySource = (): {
  source: EngineEventSource;
  live(): number;
  emit(eventName: EngineEventName): void;
} => {
  const held = new Map<string, Set<StoredListener>>();

  return {
    source: {
      // Returns nothing, which is why this fake carries `off`. Cast at the
      // return alone: the release handle is what this source deliberately
      // withholds, and every parameter still matches the engine's signature.
      on: (<K extends EngineEventName>(
        eventName: K,
        handler: EngineEventListener<K>,
      ): void => {
        const set = held.get(eventName) ?? new Set<StoredListener>();

        set.add(handler);
        held.set(eventName, set);
      }) as unknown as EngineEventSource['on'],
      off: <K extends EngineEventName>(
        eventName: K,
        handler: EngineEventListener<K>,
      ): void => {
        held.get(eventName)?.delete(handler);
      },
    },
    live: (): number => {
      let total = 0;

      for (const set of held.values()) {
        total += set.size;
      }

      return total;
    },
    emit: (eventName: EngineEventName): void => {
      for (const handler of held.get(eventName) ?? []) {
        (handler as (payload: unknown) => void)(undefined);
      }
    },
  };
};

/** A preference source with settable values and a real subscription. */
const preferenceSource = (
  initial: { muted: boolean; volume: number },
): {
  source: SoundPreferenceSource;
  set(next: { muted?: boolean; volume?: number }): void;
  subscribers(): number;
} => {
  let muted = initial.muted;
  let volume = initial.volume;

  const listeners = new Set<() => void>();

  return {
    source: {
      isMuted: (): boolean => muted,
      getVolume: (): number => volume,
      subscribe: (listener): (() => void) => {
        listeners.add(listener);

        return (): void => {
          listeners.delete(listener);
        };
      },
    },
    set: (next): void => {
      muted = next.muted ?? muted;
      volume = next.volume ?? volume;

      for (const listener of listeners) {
        listener();
      }
    },
    subscribers: (): number => listeners.size,
  };
};

/* ===== 1. Disposal detaches every handler (F-05) ===== */

describe('a disposed sound engine is detached from its sources', () => {
  it('releases every handle the source returned', () => {
    const emitter = recordingSource();
    const engine = createSoundEngine({});

    engine.subscribe(emitter.source);

    expect(emitter.live()).toBeGreaterThan(0);

    engine.dispose();

    // The defect: the handles were discarded, so this stayed at its peak for
    // the emitter's whole life.
    expect(emitter.live()).toBe(0);
  });

  it('releases through off where the source returns no handle', () => {
    const emitter = offOnlySource();
    const engine = createSoundEngine({});

    engine.subscribe(emitter.source);

    expect(emitter.live()).toBeGreaterThan(0);

    engine.dispose();

    expect(emitter.live()).toBe(0);
  });

  it('receives no event after disposal', () => {
    const emitter = offOnlySource();
    const engine = createSoundEngine({});

    engine.subscribe(emitter.source);
    engine.dispose();

    // Nothing is registered, so nothing is reached; the handler would otherwise
    // have run against a disposed engine.
    expect(() => {
      emitter.emit('state:commit');
      emitter.emit('tile:merge');
    }).not.toThrow();
    expect(emitter.live()).toBe(0);
  });

  it('detaches from several sources', () => {
    const first = recordingSource();
    const second = recordingSource();
    const engine = createSoundEngine({});

    engine.subscribe(first.source);
    engine.subscribe(second.source);
    engine.dispose();

    expect(first.live()).toBe(0);
    expect(second.live()).toBe(0);
  });

  it('is safe to dispose more than once', () => {
    const emitter = recordingSource();
    const engine = createSoundEngine({});

    engine.subscribe(emitter.source);
    engine.dispose();

    expect(() => {
      engine.dispose();
    }).not.toThrow();
    expect(emitter.live()).toBe(0);
  });

  it('registers nothing twice for the same source', () => {
    const emitter = recordingSource();
    const engine = createSoundEngine({});

    engine.subscribe(emitter.source);

    const first = emitter.registered().length;

    engine.subscribe(emitter.source);

    expect(emitter.registered().length).toBe(first);

    engine.dispose();
  });

  it('undoes a partial subscription rather than keeping half of it', () => {
    let calls = 0;

    const held = new Set<StoredListener>();
    const source: EngineEventSource = {
      on: <K extends EngineEventName>(
        _eventName: K,
        handler: EngineEventListener<K>,
      ): EngineEventSubscription => {
        calls += 1;

        // The third registration fails, after two have succeeded.
        if (calls === 3) {
          throw new Error('registration refused');
        }

        held.add(handler);

        return (): void => {
          held.delete(handler);
        };
      },
    };

    const engine = createSoundEngine({});

    engine.subscribe(source);

    // Half a set of handlers would sound some effects and not others.
    expect(held.size).toBe(0);

    engine.dispose();
  });

  it('accepts a fresh subscription after a partial failure', () => {
    let refuse = true;

    const held = new Set<StoredListener>();
    const source: EngineEventSource = {
      on: <K extends EngineEventName>(
        _eventName: K,
        handler: EngineEventListener<K>,
      ): EngineEventSubscription => {
        if (refuse) {
          throw new Error('registration refused');
        }

        held.add(handler);

        return (): void => {
          held.delete(handler);
        };
      },
    };

    const engine = createSoundEngine({});

    engine.subscribe(source);
    expect(held.size).toBe(0);

    // The source was removed from the registered set, so it can be retried.
    refuse = false;
    engine.subscribe(source);

    expect(held.size).toBeGreaterThan(0);

    engine.dispose();
    expect(held.size).toBe(0);
  });

  it('registers nothing once disposed', () => {
    const emitter = recordingSource();
    const engine = createSoundEngine({});

    engine.dispose();
    engine.subscribe(emitter.source);

    expect(emitter.registered()).toEqual([]);
  });
});

/* ===== 2. One owner for mute and volume (F-27) ===== */

describe('the mute and volume defaults have exactly one owner', () => {
  it('publishes the same four values from all three modules', () => {
    // One declaration, in src/config/audio-bounds.ts, re-exported by the audio
    // module and by the accessibility surface: these are the same bindings and
    // cannot drift. Two independent declarations came before, and they DISAGREED
    // on the starting volume, so the volume a player heard depended on which
    // owner had last written the master gain.
    expect(SETTINGS_MIN_VOLUME).toBe(MIN_VOLUME);
    expect(SETTINGS_MAX_VOLUME).toBe(MAX_VOLUME);
    expect(SETTINGS_DEFAULT_VOLUME).toBe(DEFAULT_VOLUME);
    expect(SETTINGS_DEFAULT_MUTED).toBe(DEFAULT_MUTED);

    expect(MIN_VOLUME).toBe(CONFIG_MIN_VOLUME);
    expect(MAX_VOLUME).toBe(CONFIG_MAX_VOLUME);
    expect(DEFAULT_VOLUME).toBe(CONFIG_DEFAULT_VOLUME);
    expect(DEFAULT_MUTED).toBe(CONFIG_DEFAULT_MUTED);
  });

  it('leaves the accessibility leaf with no edge into the audio layer', () => {
    const source = a11ySettingsSource;

    // A DIRECTION, not a preference. src/ui/a11y/settings.ts is the leaf of the
    // src/ui/ import graph, and a volume bound is something a PREFERENCE has to
    // validate whether or not this build ever plays a sound — so the leaf must
    // not reach into the audio subsystem for it. The panel is where preferences
    // are adapted into audio, and the panel is not the leaf.
    expect(source).not.toMatch(/from\s+'\.\.\/\.\.\/audio\//);
    expect(source).toMatch(/from\s+'\.\.\/\.\.\/config\/audio-bounds'/);
  });

  it('defaults to unattenuated and unmuted', () => {
    expect(DEFAULT_VOLUME).toBe(MAX_VOLUME);
    expect(DEFAULT_MUTED).toBe(false);
    expect(MIN_VOLUME).toBe(0);
    expect(MAX_VOLUME).toBe(1);
  });

  it('agrees with the preference store the engine now reads', () => {
    const store = createPreferenceStore({});
    const engine = createSoundEngine({ preferences: store });

    expect(engine.getVolume()).toBe(store.getPreferences().volume);
    expect(engine.isMuted()).toBe(store.getPreferences().muted);

    engine.dispose();
    store.destroy();
  });

  it('takes its starting values from the store, not from its options', () => {
    const source = preferenceSource({ muted: true, volume: 0.25 });
    const engine = createSoundEngine({
      preferences: source.source,
      // Ignored entirely: the store is the single source.
      muted: false,
      volume: 1,
    });

    expect(engine.isMuted()).toBe(true);
    expect(engine.getVolume()).toBe(0.25);

    engine.dispose();
  });

  it('follows a later change on the store', () => {
    const source = preferenceSource({ muted: false, volume: 1 });
    const engine = createSoundEngine({ preferences: source.source });

    source.set({ muted: true, volume: 0.5 });

    expect(engine.isMuted()).toBe(true);
    expect(engine.getVolume()).toBe(0.5);

    engine.dispose();
  });

  it('refuses its own setters while a store owns the values', () => {
    const source = preferenceSource({ muted: false, volume: 1 });
    const engine = createSoundEngine({ preferences: source.source });

    engine.setMuted(true);
    engine.setVolume(0.1);

    // Refused, so the two owners cannot diverge; the caller sets the store.
    expect(engine.isMuted()).toBe(false);
    expect(engine.getVolume()).toBe(1);

    engine.dispose();
  });

  it('releases the store observation on disposal', () => {
    const source = preferenceSource({ muted: false, volume: 1 });
    const engine = createSoundEngine({ preferences: source.source });

    expect(source.subscribers()).toBe(1);

    engine.dispose();

    expect(source.subscribers()).toBe(0);
  });

  it('ignores a store change after disposal', () => {
    const source = preferenceSource({ muted: false, volume: 1 });
    const engine = createSoundEngine({ preferences: source.source });

    engine.dispose();
    source.set({ muted: true, volume: 0 });

    expect(engine.isMuted()).toBe(false);
  });

  it('holds its own state when no store is supplied', () => {
    const engine = createSoundEngine({ muted: true, volume: 0.4 });

    expect(engine.isMuted()).toBe(true);
    expect(engine.getVolume()).toBe(0.4);

    engine.setMuted(false);
    engine.setVolume(0.9);

    expect(engine.isMuted()).toBe(false);
    expect(engine.getVolume()).toBe(0.9);

    engine.dispose();
  });

  it('falls back to the defaults for a store that throws', () => {
    const hostile: SoundPreferenceSource = {
      isMuted: (): boolean => {
        throw new Error('unreadable');
      },
      getVolume: (): number => {
        throw new Error('unreadable');
      },
      subscribe: (): (() => void) => (): void => {
        // Nothing to release.
      },
    };

    const engine = createSoundEngine({ preferences: hostile });

    expect(engine.getVolume()).toBe(DEFAULT_VOLUME);
    expect(engine.isMuted()).toBe(DEFAULT_MUTED);

    engine.dispose();
  });

  it('survives a store whose subscribe throws', () => {
    const hostile: SoundPreferenceSource = {
      isMuted: (): boolean => false,
      getVolume: (): number => 1,
      subscribe: (): (() => void) => {
        throw new Error('cannot observe');
      },
    };

    expect(() => {
      const engine = createSoundEngine({ preferences: hostile });

      engine.dispose();
    }).not.toThrow();
  });
});

/* ===== 3. Only emitted events are mapped (F-28) ===== */

describe('the event table names only events an emitter produces', () => {
  it('maps each of the seven contract names', () => {
    // Exactly the names EngineEventPayloadMap declares.
    expect(effectNameForEvent('tile:merge')).toBe('merge');
    expect(effectNameForEvent('tile:spawn')).toBe('spawn');
    expect(effectNameForEvent('move:after')).toBe('move');
    expect(effectNameForEvent('stage:end')).toBe('stageClear');
    expect(effectNameForEvent('state:commit')).toBe('lose');
    expect(effectNameForEvent('stage:start')).toBe(null);
    expect(effectNameForEvent('move:before')).toBe(null);
  });

  it('does not map an event no emitter produces', () => {
    // `relic:acquired` is absent from EngineEventPayloadMap, so a mapping
    // for it could never resolve. It was removed rather than added to the
    // frozen contract.
    expect(effectNameForEvent('relic:acquired')).toBe(null);
  });

  it('registers only contract names on a source', () => {
    const emitter = recordingSource();
    const engine = createSoundEngine({});

    engine.subscribe(emitter.source);

    const contract = [
      'stage:start',
      'move:before',
      'tile:merge',
      'tile:spawn',
      'move:after',
      'stage:end',
      'state:commit',
    ];

    for (const name of emitter.registered()) {
      expect(contract).toContain(name);
    }

    expect(emitter.registered()).not.toContain('relic:acquired');

    engine.dispose();
  });

  it('registers for the five names it sounds', () => {
    const emitter = recordingSource();
    const engine = createSoundEngine({});

    engine.subscribe(emitter.source);

    // `move:before` and `stage:start` are deliberately not registered for.
    expect([...emitter.registered()].sort()).toEqual([
      'move:after',
      'stage:end',
      'state:commit',
      'tile:merge',
      'tile:spawn',
    ]);

    engine.dispose();
  });

  it('ignores an unmapped name handed to the resolver', () => {
    expect(effectNameForEvent('not:an:event')).toBe(null);
  });

  it('is unaffected by a commit payload for an event it still maps', () => {
    const emitter = offOnlySource();
    const engine = createSoundEngine({});

    engine.subscribe(emitter.source);

    expect(() => {
      emitter.emit('state:commit');
    }).not.toThrow();

    engine.dispose();
  });
});

/* ===== 4. The preference store satisfies the audio contract ===== */

describe('the store satisfies the audio preference contract', () => {
  it('is assignable without an adapter', () => {
    const store = createPreferenceStore({});

    // Compile-time: `PreferenceStore` structurally satisfies
    // `SoundPreferenceSource`, so the audio layer needs no import from the
    // accessibility layer.
    const source: SoundPreferenceSource = store;

    expect(typeof source.isMuted()).toBe('boolean');
    expect(typeof source.getVolume()).toBe('number');

    const release = source.subscribe((): void => {
      // Nothing.
    });

    expect(typeof release).toBe('function');

    release();
    store.destroy();
  });

  it('drives the engine end to end through the store', () => {
    const store = createPreferenceStore({});
    const engine = createSoundEngine({ preferences: store });

    store.setMuted(true);
    store.setVolume(0.3);

    expect(engine.isMuted()).toBe(true);
    expect(engine.getVolume()).toBeCloseTo(0.3, 5);

    engine.dispose();
    store.destroy();
  });
});

describe('the audio port is the engine event contract, not a paraphrase', () => {
  it('accepts the real emitter of src/engine/engine-events.ts', () => {
    // A COMPILE-TIME assertion first: the assignment below is the check, and it
    // is what the previous broad fakes stopped the suite from making. It is
    // exercised at runtime too, so the engine's `on` really is called.
    const events = createEngineEvents();
    const source: EngineEventSource = events;
    const engine = createSoundEngine({});

    engine.subscribe(source);

    // Every one of the five names it registers for is emitted by the same
    // emitter, so an event renamed on one side no longer compiles on the other.
    expect(() => {
      events.emit('tile:spawn', {
        turn: 1,
        position: { x: 0, y: 0 },
        value: 2,
      });
    }).not.toThrow();

    engine.dispose();
  });

  it('sounds a spawn that inserted a tile and stays silent for one that did not', () => {
    const events = createEngineEvents();
    const counted: string[] = [];
    const engine = createSoundEngine({
      // `audio.play.requested` is raised by the one path an effect reaches the
      // context through, so counting it distinguishes a sounded spawn from a
      // silent one with no AudioContext present at all.
      metrics: {
        increment: (name: string): void => {
          counted.push(name);
        },
      },
    });

    engine.subscribe(events);

    // A spawn with no position means NO TILE WAS INSERTED: the engine emits the
    // event either way, and announcing the second case announced a tile the
    // player never saw appear.
    events.emit('tile:spawn', { turn: 1, value: 2 });

    const afterSuppressed = counted.filter(
      (name) => name === 'audio.play.requested',
    ).length;

    events.emit('tile:spawn', { turn: 1, position: { x: 1, y: 2 }, value: 4 });

    const afterRealSpawn = counted.filter(
      (name) => name === 'audio.play.requested',
    ).length;

    expect(afterSuppressed).toBe(0);
    expect(afterRealSpawn).toBe(1);

    engine.dispose();
  });
});
