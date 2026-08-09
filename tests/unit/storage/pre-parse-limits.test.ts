// Contract suite for the pre-parse size boundary, AAP I5 and I13.
//
// WHAT WAS WRONG
//   `readJson()` handed any non-empty owned value straight to `JSON.parse`. Web
//   Storage is synchronous and shared by the whole origin, so a near-quota value
//   written by anything on this host — or a value corrupted in place — was parsed
//   on the startup path, blocking the main thread and materialising the whole
//   graph BEFORE any schema guard could look at it. A bound applied to the RESULT
//   cannot prevent that: by then the parse has already run.
//
//   The keymap layer had already declared its own bound,
//   `MAX_KEYMAP_PAYLOAD_BYTES`, and documented that persistence applies it before
//   parsing. `isKeymapPayloadWithinLimit()` had no caller anywhere, so the
//   documented boundary was not active.
//
//   And the run-state blob was parsed three separate times on one boot: the
//   identity resolution, the relic pre-read that breaks the board-size cycle, and
//   the authoritative load each read and parsed it for themselves.
//
// WHAT THIS SUITE PINS
//   Under-limit, exact-limit and over-limit text for each owned key; that an
//   oversized value is refused with nothing parsed and is reported once through
//   the ordinary failure channel; that the refusal carries a description this
//   module authored and no excerpt of the value; that one stored text is parsed
//   once; and that the run-state consumers share that single parse.
//
// This suite is the designated evidence for three decisions in
// docs/DECISION_LOG.md: `DL-STORE-07`, the per-key pre-parse ceilings, the
// caller predicate and the parse memo; `DL-RUNSTORE-06`, the single bounded
// run-state snapshot the three consumers share; and `DL-MAIN-17`, which gives
// `MAX_KEYMAP_PAYLOAD_BYTES` its first caller.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isKeymapPayloadWithinLimit,
  MAX_KEYMAP_PAYLOAD_BYTES,
} from '../../../src/input/keymap';
import {
  MAX_RUN_STATE_PAYLOAD_BYTES,
  RunStateStore,
  readRunStateSnapshot,
} from '../../../src/run/run-state-store';
import {
  DEFAULT_MAX_STORED_JSON_BYTES,
  LocalStorageManager,
  MAX_STORED_JSON_BYTES,
  maxStoredJsonBytes,
} from '../../../src/storage/local-storage-manager';
import type { StorageFailure } from '../../../src/storage/local-storage-manager';
import { MemoryStorage } from '../../../src/storage/memory-storage';
import {
  GAME_STATE_KEY,
  KEYMAP_KEY,
  RUN_STATE_KEY,
  namespacedKey,
} from '../../../src/storage/storage-keys';
import type { OwnedStorageKey } from '../../../src/storage/storage-keys';
import { clearOwnedStorage } from '../../fixtures/storage';

/** Two bytes per UTF-16 code unit, the way Web Storage charges for a value. */
const BYTES_PER_UNIT = 2;

/** A key minted after the three the ceiling table names. */
const UNNAMED_KEY: OwnedStorageKey = namespacedKey('scratch');

/** A manager over its own in-memory store, with every failure recorded. */
const createSubject = (): {
  readonly manager: LocalStorageManager;
  readonly store: MemoryStorage;
  readonly failures: StorageFailure[];
} => {
  const store = new MemoryStorage();
  const failures: StorageFailure[] = [];
  const manager = new LocalStorageManager({
    storage: store,
    reporter: {
      onFailure: (failure): void => {
        failures.push(failure);
      },
    },
  });

  return { manager, store, failures };
};

/**
 * JSON text of exactly `bytes` bytes: a string literal padded to length.
 *
 * `"` + n characters + `"` is n + 2 code units, so the padding is two short of
 * the requested unit count.
 */
const jsonOfBytes = (bytes: number): string => {
  const units = bytes / BYTES_PER_UNIT;

  return `"${'p'.repeat(units - 2)}"`;
};

beforeEach(() => {
  clearOwnedStorage();
});

afterEach(() => {
  clearOwnedStorage();
});

/* ==========================================================================
 * 1. The ceilings are declared, and every owned key has one
 * ========================================================================== */

describe('the declared ceilings', () => {
  it('names the three durable keys and defaults the rest', () => {
    expect(MAX_STORED_JSON_BYTES[GAME_STATE_KEY]).toBe(65_536);
    expect(MAX_STORED_JSON_BYTES[RUN_STATE_KEY]).toBe(131_072);
    expect(MAX_STORED_JSON_BYTES[KEYMAP_KEY]).toBe(32_768);

    // A key minted after this table was written is bounded on the day it is
    // minted rather than on the day someone remembers to add it here.
    expect(maxStoredJsonBytes(UNNAMED_KEY)).toBe(DEFAULT_MAX_STORED_JSON_BYTES);
    expect(maxStoredJsonBytes(GAME_STATE_KEY)).toBe(65_536);
  });

  it('leaves room for the real payloads by two orders of magnitude', () => {
    // The measured payloads: a couple of hundred bytes for a fresh board, under
    // a thousand for a full one, a few thousand for a fully remapped keymap. A
    // ceiling that a legitimate value could reach would be a bug, not a bound.
    expect(maxStoredJsonBytes(RUN_STATE_KEY)).toBeGreaterThan(100 * 1024);
    expect(MAX_KEYMAP_PAYLOAD_BYTES).toBeLessThan(
      maxStoredJsonBytes(KEYMAP_KEY),
    );
  });

  it('bounds the envelope in the run layer as well as in the adapter', () => {
    // Both apply and the tighter governs. The store's own ceiling is what a bare
    // port — one with no adapter behind it — is defended by.
    expect(MAX_RUN_STATE_PAYLOAD_BYTES).toBe(131_072);
    expect(MAX_RUN_STATE_PAYLOAD_BYTES).toBeLessThanOrEqual(
      maxStoredJsonBytes(RUN_STATE_KEY),
    );
  });
});

/* ==========================================================================
 * 2. Under, exactly at, and over the limit
 * ========================================================================== */

describe('a stored value measured against its key ceiling', () => {
  it('parses text one byte under the limit', () => {
    const { manager, store, failures } = createSubject();
    const limit = maxStoredJsonBytes(GAME_STATE_KEY);

    store.setItem(GAME_STATE_KEY, jsonOfBytes(limit - BYTES_PER_UNIT));

    expect(typeof manager.readJson(GAME_STATE_KEY)).toBe('string');
    expect(failures).toEqual([]);
  });

  it('parses text at exactly the limit', () => {
    const { manager, store, failures } = createSubject();
    const limit = maxStoredJsonBytes(GAME_STATE_KEY);
    const text = jsonOfBytes(limit);

    expect(text.length * BYTES_PER_UNIT).toBe(limit);

    store.setItem(GAME_STATE_KEY, text);

    // The bound is inclusive: at the limit is within it.
    expect(typeof manager.readJson(GAME_STATE_KEY)).toBe('string');
    expect(failures).toEqual([]);
  });

  it('refuses text one byte over the limit, with nothing parsed', () => {
    const { manager, store, failures } = createSubject();
    const limit = maxStoredJsonBytes(GAME_STATE_KEY);

    store.setItem(GAME_STATE_KEY, jsonOfBytes(limit + BYTES_PER_UNIT));

    expect(manager.readJson(GAME_STATE_KEY)).toBeNull();
    expect(manager.getGameState()).toBeNull();
    expect(failures).toHaveLength(2);
  });

  it('reports the refusal on the ordinary failure channel', () => {
    const { manager, store, failures } = createSubject();
    const secret = 'a-value-no-report-may-carry';

    store.setItem(
      RUN_STATE_KEY,
      `{"seed":"${secret}","padding":"${'p'.repeat(200_000)}"}`,
    );

    expect(manager.readJson(RUN_STATE_KEY)).toBeNull();
    expect(failures).toHaveLength(1);

    const failure = failures[0];

    expect(failure?.operation).toBe('read');
    expect(failure?.key).toBe(RUN_STATE_KEY);
    expect(failure?.error.name).toBe('StorageSizeError');
    expect(failure?.error.quota).toBe(false);

    // A refusal touches no store beyond the read that measured the value, so
    // nothing was thrown and nothing is carried.
    expect(failure?.thrown).toBeUndefined();

    // The description is this module's own: it carries the two measurements and
    // no key, and no excerpt of the value.
    expect(failure?.error.message).toContain('ceiling');
    expect(failure?.error.message).not.toContain(secret);
    expect(failure?.error.message).not.toContain(RUN_STATE_KEY);
  });

  it('still reads the raw text it refused to parse', () => {
    // `readRaw` is unbounded on purpose: measuring a value requires reading it,
    // and a caller that wants the string rather than the graph — the presence
    // check does — pays no parse.
    const { manager, store } = createSubject();
    const text = jsonOfBytes(maxStoredJsonBytes(UNNAMED_KEY) * 2);

    store.setItem(UNNAMED_KEY, text);

    expect(manager.readRaw(UNNAMED_KEY)).toBe(text);
    expect(manager.readJson(UNNAMED_KEY)).toBeNull();
  });
});

/* ==========================================================================
 * 3. The caller's own bound, applied to the raw text
 * ========================================================================== */

describe('the keymap payload limit', () => {
  it('measures the stored text the way storage charges for it', () => {
    const units = MAX_KEYMAP_PAYLOAD_BYTES / BYTES_PER_UNIT;

    expect(isKeymapPayloadWithinLimit('p'.repeat(units - 1))).toBe(true);
    expect(isKeymapPayloadWithinLimit('p'.repeat(units))).toBe(true);
    expect(isKeymapPayloadWithinLimit('p'.repeat(units + 1))).toBe(false);
  });

  it('is applied to the raw text, so an oversized keymap is never parsed', () => {
    const { manager, store, failures } = createSubject();

    store.setItem(KEYMAP_KEY, jsonOfBytes(MAX_KEYMAP_PAYLOAD_BYTES));

    // Within the caller's bound, and within the key's own, so it parses.
    expect(typeof manager.readJson(KEYMAP_KEY, isKeymapPayloadWithinLimit))
      .toBe('string');
    expect(failures).toEqual([]);

    store.setItem(
      KEYMAP_KEY,
      jsonOfBytes(MAX_KEYMAP_PAYLOAD_BYTES + BYTES_PER_UNIT),
    );

    // Over the caller's bound and still under the key's, which is the case the
    // predicate exists for: the tighter of the two governs.
    expect(manager.readJson(KEYMAP_KEY, isKeymapPayloadWithinLimit)).toBeNull();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error.name).toBe('StorageSizeError');
    expect(failures[0]?.error.message).toContain('reading module');

    // And without the predicate the same text is inside the key's own ceiling,
    // which is what proves the refusal came from the caller's bound.
    expect(typeof manager.readJson(KEYMAP_KEY)).toBe('string');
  });
});

/* ==========================================================================
 * 4. One stored text, one parse
 * ========================================================================== */

describe('the parse of one stored text', () => {
  it('happens once, and the result is shared', () => {
    const { manager, store } = createSubject();

    store.setItem(RUN_STATE_KEY, '{"seed":"shared","relics":[]}');

    const first = manager.readJson(RUN_STATE_KEY);
    const second = manager.readJson(RUN_STATE_KEY);

    // The same object, not merely an equal one: a second `JSON.parse` would have
    // produced a different graph.
    expect(second).toBe(first);
  });

  it('happens again once the stored text changes', () => {
    const { manager, store } = createSubject();

    store.setItem(RUN_STATE_KEY, '{"seed":"first"}');

    const first = manager.readJson(RUN_STATE_KEY);

    store.setItem(RUN_STATE_KEY, '{"seed":"second"}');

    const second = manager.readJson(RUN_STATE_KEY);

    // The raw string is re-read on every call, so a value another tab replaced
    // is never served from the memo.
    expect(second).not.toBe(first);
    expect(second).toEqual({ seed: 'second' });
  });

  it('hands back a graph no consumer can mutate', () => {
    const { manager, store } = createSubject();

    store.setItem(RUN_STATE_KEY, '{"relics":[{"id":"tumbler"}]}');

    const shared = manager.readJson(RUN_STATE_KEY) as {
      relics: { id: string }[];
    };

    // Sharing one parse between several consumers is only safe if none of them
    // can influence another through it. Modules are strict, so a write raises
    // rather than being silently dropped.
    expect(Object.isFrozen(shared)).toBe(true);
    expect(Object.isFrozen(shared.relics)).toBe(true);
    expect(Object.isFrozen(shared.relics[0])).toBe(true);
    expect(() => {
      shared.relics.push({ id: 'injected' });
    }).toThrow();
  });

  it('serves the three run-state consumers from one parse', () => {
    const { manager, store } = createSubject();

    store.setItem(
      RUN_STATE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        runId: 'shared-run',
        seed: 'shared-seed',
        rngCursor: {
          'spawn-value': 0,
          'spawn-position': 0,
          'relic-draw': 0,
          'rarity-weight': 0,
        },
        stageIndex: 0,
        stageGoal: { kind: 'highest-tile', target: 16 },
        goalProgress: 0,
        relics: [{ id: 'tumbler' }],
        board: {
          grid: {
            size: 4,
            cells: [
              [{ position: { x: 0, y: 0 }, value: 2 }, null, null, null],
              [null, null, null, null],
              [null, null, null, null],
              [null, null, null, null],
            ],
          },
          score: 0,
          over: false,
          won: false,
          keepPlaying: false,
        },
      }),
    );

    const subject = new RunStateStore({ storage: manager });

    // The relic pre-read, the identity read and the authoritative load, in the
    // order a boot performs them.
    expect(subject.peekRelics().map((relic): string => relic.id)).toEqual([
      'tumbler',
    ]);
    expect(readRunStateSnapshot(manager).parsed).toBe(
      manager.readJson(RUN_STATE_KEY),
    );
    expect(subject.load().state?.seed).toBe('shared-seed');

    // All three resolved to the one memoised graph.
    expect(readRunStateSnapshot(manager).parsed).toBe(
      manager.readJson(RUN_STATE_KEY),
    );
  });
});

/* ==========================================================================
 * 5. The envelope's own ceiling, against a bare port
 * ========================================================================== */

describe('the run-state ceiling in the run layer', () => {
  /** A port with no adapter behind it, so only the store's ceiling applies. */
  const barePort = (text: string): {
    readRaw: () => string | null;
    readJson: () => unknown;
    writeJson: () => boolean;
    removeRaw: () => boolean;
  } => ({
    readRaw: (): string | null => text,
    readJson: (): unknown => JSON.parse(text) as unknown,
    writeJson: (): boolean => true,
    removeRaw: (): boolean => true,
  });

  it('measures an under-limit envelope and parses it', () => {
    const snapshot = readRunStateSnapshot(barePort('{"seed":"small"}'));

    expect(snapshot.present).toBe(true);
    expect(snapshot.oversize).toBe(false);
    expect(snapshot.bytes).toBe('{"seed":"small"}'.length * BYTES_PER_UNIT);
    expect(snapshot.parsed).toEqual({ seed: 'small' });
  });

  it('refuses an over-limit envelope without parsing it', () => {
    const oversized = jsonOfBytes(
      MAX_RUN_STATE_PAYLOAD_BYTES + BYTES_PER_UNIT,
    );
    let parses = 0;
    const snapshot = readRunStateSnapshot({
      readRaw: (): string | null => oversized,
      readJson: (): unknown => {
        parses += 1;

        return JSON.parse(oversized) as unknown;
      },
    });

    expect(snapshot.present).toBe(true);
    expect(snapshot.oversize).toBe(true);
    expect(snapshot.parsed).toBeNull();
    expect(parses).toBe(0);
  });

  it('falls the run back to fresh, and reports the refusal', () => {
    const reports: { verdict: string; problems: readonly string[] }[] = [];
    const subject = new RunStateStore({
      storage: barePort(jsonOfBytes(MAX_RUN_STATE_PAYLOAD_BYTES * 2)),
      reporter: {
        onLoadCorrupted: (report): void => {
          reports.push({
            verdict: report.verdict,
            problems: report.problems,
          });
        },
      },
    });

    const result = subject.load();

    expect(result.state).toBeNull();
    expect(result.outcome).toBe('fresh-fallback');
    expect(result.verdict).toBe('malformed');
    expect(reports).toHaveLength(1);
    expect(reports[0]?.problems.join(' ')).toContain('ceiling');

    // A peek of the same refused envelope yields nothing rather than reaching
    // inside a payload the load would not read.
    expect(subject.peekRelics()).toEqual([]);
  });

  it('leaves a port that raises to its caller, so the throw is reported', () => {
    // The read must not swallow: the caught value is what reaches the corruption
    // channel, and the pre-migration loader discarding it is the defect that
    // channel exists to close.
    expect(() =>
      readRunStateSnapshot({
        readRaw: (): string | null => {
          throw new Error('the persistence port failed');
        },
        readJson: (): unknown => null,
      }),
    ).toThrow('the persistence port failed');
  });
});
