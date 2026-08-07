// Contract suite for input dispatch containment, dispatch determinism and
// indexed-action remapping, AAP R9.
//
// Three properties are pinned here, none of them visible to the type checker:
//
//   containment  every modality — keyboard, swipe and on-screen control —
//                publishes through `InputManager.emit`, so one subscriber that
//                throws must neither reach the publisher nor stop the
//                subscribers after it. js/keyboard_input_manager.js L25-L32
//                invoked each callback bare, which is the behaviour being
//                replaced.
//   determinism  `on()` pushes onto the array `emit` walks and the removal
//                handle splices it, so a subscription taken or released from
//                inside a callback would otherwise change the publication that
//                is running: a removal shifts the index of a callback not yet
//                invoked, and an addition is reached by the walk that is
//                already under way.
//   remapping    `selectReward` and `activateRelic` publish a zero-based index
//                naming which offer or relic the press addresses. The index
//                comes off the matched `InputBindingSlot`, never off the text
//                of the key, so a remap onto keys carrying no ordinal at all
//                still addresses the right target.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_KEY_BINDINGS,
  MAX_KEYMAP_SLOTS,
  RELIC_SLOT_COUNT,
  REWARD_SLOT_COUNT,
  createKeymap,
  deserializeKeymap,
  remapAction,
  resolveInput,
  serializeKeymap,
} from '../../../src/input/keymap';
import type { InputReportFields } from '../../../src/input/keymap';
import { createInputManager } from '../../../src/input/input-manager';

/** A keydown carrying only the fields the resolver reads. */
const keyEvent = (key: string, code = ''): KeyboardEvent =>
  new KeyboardEvent('keydown', { key, code });

/** Collects every report a manager emits, for assertions on containment. */
const recordingReporter = (): {
  reporter: {
    log(
      level: string,
      message: string,
      fields?: InputReportFields,
    ): void;
    count(name: string, fields?: InputReportFields): void;
  };
  logs: { level: string; message: string; fields?: InputReportFields }[];
  counts: { name: string; fields?: InputReportFields }[];
} => {
  const logs: {
    level: string;
    message: string;
    fields?: InputReportFields;
  }[] = [];
  const counts: { name: string; fields?: InputReportFields }[] = [];

  return {
    reporter: {
      log: (
        level: string,
        message: string,
        fields?: InputReportFields,
      ): void => {
        logs.push({ level, message, fields });
      },
      count: (name: string, fields?: InputReportFields): void => {
        counts.push({ name, fields });
      },
    },
    logs,
    counts,
  };
};

/* ===== 1. Per-subscriber containment (F-11) ===== */

describe('emit contains each subscriber individually', () => {
  it('does not propagate a throwing subscriber to the publisher', () => {
    const manager = createInputManager({});

    manager.on('restart', () => {
      throw new Error('subscriber failed');
    });

    expect(() => manager.emit('restart', undefined)).not.toThrow();
  });

  it('runs the subscribers after the one that threw', () => {
    const manager = createInputManager({});
    const seen: string[] = [];

    manager.on('move', () => {
      seen.push('first');
    });
    manager.on('move', () => {
      throw new Error('second failed');
    });
    manager.on('move', () => {
      seen.push('third');
    });

    manager.emit('move', 0);

    expect(seen).toEqual(['first', 'third']);
  });

  it('counts every subscriber it invoked, including the thrower', () => {
    const manager = createInputManager({});

    manager.on('move', () => {
      throw new Error('failed');
    });
    manager.on('move', () => {
      // Reached because the throw above was contained.
    });

    expect(manager.emit('move', 1)).toBe(2);
  });

  it('contains each of several throwing subscribers independently', () => {
    const manager = createInputManager({});
    const seen: number[] = [];

    for (let index = 0; index < 4; index += 1) {
      manager.on('move', () => {
        seen.push(index);

        throw new Error(`subscriber ${index} failed`);
      });
    }

    expect(() => manager.emit('move', 2)).not.toThrow();
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it('reports each thrower with its event and position', () => {
    const recorder = recordingReporter();
    const manager = createInputManager({
      reporter: recorder.reporter,
    });

    manager.on('move', () => {
      // Runs cleanly, so the report below names position 1 and not 0.
    });
    manager.on('move', () => {
      throw new Error('boom');
    });

    manager.emit('move', 3);

    const errors = recorder.counts.filter(
      (entry) => entry.name === 'input.listener.error',
    );

    expect(errors.length).toBe(1);
    expect(errors[0]?.fields?.['event']).toBe('move');
    expect(errors[0]?.fields?.['listener']).toBe(1);

    // Filtered by message: constructing a manager in a document with no
    // `.game-container` also reports at `error`, which is the guarded-lookup
    // report and not this one.
    const logged = recorder.logs.filter(
      (entry) =>
        entry.level === 'error' &&
        entry.message.startsWith('An input listener'),
    );

    expect(logged.length).toBe(1);
    expect(logged[0]?.fields?.['event']).toBe('move');
    expect(logged[0]?.fields?.['listener']).toBe(1);

    // This sink implements no `failure` member, so the guarded wrapper of
    // src/input/keymap.ts applies its one documented reduction, which reports
    // the name and the message as separate fields. The manager itself no
    // longer flattens the caught value onto a field of its own (F4).
    expect(logged[0]?.fields?.['errorName']).toBe('Error');
    expect(logged[0]?.fields?.['errorMessage']).toBe('boom');
    expect(logged[0]?.fields?.['error']).toBeUndefined();
  });

  it('hands a sink that implements failure the caught value unconverted ' +
    '(F4)', () => {
    const failures: {
      level: string;
      message: string;
      thrown: unknown;
      fields?: InputReportFields;
    }[] = [];
    const thrown = new Error('boom', { cause: new Error('root cause') });
    const manager = createInputManager({
      reporter: {
        log: (): void => undefined,
        count: (): void => undefined,
        failure: (level, message, caught, fields): void => {
          failures.push({ level, message, thrown: caught, fields });
        },
      },
    });

    manager.on('move', () => {
      throw thrown;
    });
    manager.emit('move', 3);

    const listenerFailures = failures.filter((entry) =>
      entry.message.startsWith('An input listener'),
    );

    expect(listenerFailures).toHaveLength(1);
    expect(listenerFailures[0]?.level).toBe('error');

    // The value itself, so its subclass, its stack and its cause chain are all
    // still reachable by the sink.
    expect(listenerFailures[0]?.thrown).toBe(thrown);
    expect((listenerFailures[0]?.thrown as Error).cause).toBe(thrown.cause);
    expect(listenerFailures[0]?.fields?.['event']).toBe('move');
    expect(listenerFailures[0]?.fields?.['listener']).toBe(0);
  });

  it('hands a sink that implements failure a non-Error throwable whole ' +
    '(F4)', () => {
    const caught: unknown[] = [];
    const thrown = { code: 'not-an-error', detail: { nested: true } };
    const manager = createInputManager({
      reporter: {
        log: (): void => undefined,
        count: (): void => undefined,
        failure: (_level, message, value): void => {
          if (message.startsWith('An input listener')) {
            caught.push(value);
          }
        },
      },
    });

    manager.on('restart', () => {
      throw thrown;
    });
    manager.emit('restart', undefined);

    expect(caught).toEqual([thrown]);
    expect(caught[0]).toBe(thrown);
  });

  it('reports nothing when no subscriber throws', () => {
    const recorder = recordingReporter();
    const manager = createInputManager({
      reporter: recorder.reporter,
    });

    manager.on('move', () => {
      // Nothing.
    });
    manager.emit('move', 0);

    expect(
      recorder.counts.some((entry) => entry.name === 'input.listener.error'),
    ).toBe(false);
  });

  it('contains a reporter that throws while reporting', () => {
    const manager = createInputManager({
      reporter: {
        log: (): void => {
          throw new Error('sink failed');
        },
        count: (): void => {
          throw new Error('sink failed');
        },
      },
    });

    manager.on('move', () => {
      throw new Error('subscriber failed');
    });

    expect(() => manager.emit('move', 0)).not.toThrow();
  });

  it('contains a throwing swipe subscriber, which shares the same path', () => {
    const manager = createInputManager({});
    const seen: string[] = [];

    manager.on('move', () => {
      throw new Error('failed');
    });
    manager.on('move', () => {
      seen.push('reached');
    });

    expect(() => manager.emitMove(1, 'swipe')).not.toThrow();
    expect(seen).toEqual(['reached']);
  });
});

/* ===== 2. Dispatch determinism (F-25) ===== */

describe('emit dispatches to a snapshot of the membership', () => {
  it('does not invoke a subscriber registered during the publication', () => {
    const manager = createInputManager({});
    const seen: string[] = [];

    manager.on('move', () => {
      seen.push('first');
      manager.on('move', () => {
        seen.push('added');
      });
    });

    manager.emit('move', 0);

    expect(seen).toEqual(['first']);

    // Reached by the NEXT publication, which is where the addition belongs.
    manager.emit('move', 0);

    expect(seen).toEqual(['first', 'first', 'added']);
  });

  it('still invokes a subscriber released during the publication', () => {
    const manager = createInputManager({});
    const seen: string[] = [];

    let releaseSecond = (): void => {
      // Replaced below.
    };

    manager.on('move', () => {
      seen.push('first');
      releaseSecond();
    });

    releaseSecond = manager.on('move', () => {
      seen.push('second');
    });

    manager.on('move', () => {
      seen.push('third');
    });

    manager.emit('move', 0);

    // Walking the live array would have spliced 'second' out and skipped
    // 'third' with it.
    expect(seen).toEqual(['first', 'second', 'third']);

    seen.length = 0;
    manager.emit('move', 0);

    expect(seen).toEqual(['first', 'third']);
  });

  it('counts the snapshot it walked', () => {
    const manager = createInputManager({});

    manager.on('move', () => {
      manager.on('move', () => {
        // Not part of this publication.
      });
    });

    expect(manager.emit('move', 0)).toBe(1);
    expect(manager.emit('move', 0)).toBe(2);
  });

  it('invokes subscribers in registration order', () => {
    const manager = createInputManager({});
    const seen: number[] = [];

    for (let index = 0; index < 5; index += 1) {
      manager.on('move', () => {
        seen.push(index);
      });
    }

    manager.emit('move', 0);

    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });
});

/* ===== 3. Indexed actions carry an explicit payload index (F-24) ===== */

describe('indexed actions resolve their payload from the binding', () => {
  it('declares one slot per reward offer', () => {
    const slots = DEFAULT_KEY_BINDINGS.selectReward.slots ?? [];

    expect(slots.length).toBe(REWARD_SLOT_COUNT);
    expect(slots.map((slot) => slot.index)).toEqual([0, 1, 2]);
    expect(slots[0]?.keys).toEqual(['1']);
    expect(slots[2]?.codes).toEqual(['Digit3']);
  });

  it('declares indexed slots for activateRelic, which binds no key', () => {
    const binding = DEFAULT_KEY_BINDINGS.activateRelic;

    expect(binding.keys).toEqual([]);
    expect(binding.codes).toEqual([]);
    expect(binding.slots?.length).toBe(RELIC_SLOT_COUNT);
    expect(binding.slots?.map((slot) => slot.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it('resolves each default digit to its own offer', () => {
    const keymap = createKeymap();

    for (let index = 0; index < REWARD_SLOT_COUNT; index += 1) {
      const digit = String(index + 1);
      const resolved = resolveInput(keyEvent(digit), keymap, 'overlay');

      expect(resolved?.action).toBe('selectReward');
      expect(resolved?.payloadIndex).toBe(index);
    }
  });

  it('resolves by code when the key carries no text', () => {
    const keymap = createKeymap();
    const resolved = resolveInput(keyEvent('', 'Digit2'), keymap, 'overlay');

    expect(resolved?.action).toBe('selectReward');
    expect(resolved?.payloadIndex).toBe(1);
  });

  it('keeps the index after a remap onto keys carrying no digit', () => {
    // The defect: the index was read out of the digit text, so this remap
    // collapsed all three offers onto index 0.
    //
    // X, Y and Z rather than A, B and C: `keepPlaying` is bound to C in
    // `'overlay'` and stands earlier in `INPUT_ACTIONS` than `selectReward`, so
    // C resolves to that action and would make this a conflict test rather than
    // an index test. The conflict itself is asserted separately below.
    const remapped = remapAction(DEFAULT_KEY_BINDINGS, 'selectReward', {
      keys: ['x', 'y', 'z'],
      codes: ['KeyX', 'KeyY', 'KeyZ'],
      slots: [
        { index: 0, keys: ['x'], codes: ['KeyX'] },
        { index: 1, keys: ['y'], codes: ['KeyY'] },
        { index: 2, keys: ['z'], codes: ['KeyZ'] },
      ],
    });

    expect(resolveInput(keyEvent('x'), remapped, 'overlay')?.payloadIndex).toBe(
      0,
    );
    expect(resolveInput(keyEvent('y'), remapped, 'overlay')?.payloadIndex).toBe(
      1,
    );
    expect(resolveInput(keyEvent('z'), remapped, 'overlay')?.payloadIndex).toBe(
      2,
    );
  });

  it('lets the earlier action win where a remap collides with it', () => {
    // `keepPlaying` is bound to C in `'overlay'` and stands earlier in
    // `INPUT_ACTIONS`, so a remap of a later action onto C is shadowed. The
    // resolution order is the contract; the settings surface is what refuses a
    // colliding rebind, so the collision cannot be made from the UI.
    const remapped = remapAction(DEFAULT_KEY_BINDINGS, 'selectReward', {
      keys: ['c'],
      codes: ['KeyC'],
      slots: [{ index: 2, keys: ['c'], codes: ['KeyC'] }],
    });

    expect(resolveInput(keyEvent('c'), remapped, 'overlay')?.action).toBe(
      'keepPlaying',
    );
  });

  it('resolves a function-key remap of the third offer', () => {
    const remapped = remapAction(DEFAULT_KEY_BINDINGS, 'selectReward', {
      keys: ['F1', 'F2', 'F3'],
      codes: ['F1', 'F2', 'F3'],
      slots: [
        { index: 0, keys: ['F1'], codes: ['F1'] },
        { index: 1, keys: ['F2'], codes: ['F2'] },
        { index: 2, keys: ['F3'], codes: ['F3'] },
      ],
    });

    const resolved = resolveInput(keyEvent('F3', 'F3'), remapped, 'overlay');

    expect(resolved?.action).toBe('selectReward');
    expect(resolved?.payloadIndex).toBe(2);
  });

  it('publishes index 0 for an action that declares no slots', () => {
    const keymap = createKeymap();
    const resolved = resolveInput(keyEvent('ArrowUp'), keymap, 'game');

    expect(resolved?.action).toBe('moveUp');
    expect(resolved?.payloadIndex).toBe(0);
  });

  it('publishes index 0 when the binding matched but no slot did', () => {
    const remapped = remapAction(DEFAULT_KEY_BINDINGS, 'selectReward', {
      keys: ['1', '2', '3', 'z'],
    });

    // `z` matches the binding but names no slot, so the safe index is used.
    const resolved = resolveInput(keyEvent('z'), remapped, 'overlay');

    expect(resolved?.action).toBe('selectReward');
    expect(resolved?.payloadIndex).toBe(0);
  });

  it('publishes the resolved index end to end through the manager', () => {
    const manager = createInputManager({});
    const chosen: number[] = [];

    manager.on('selectReward', (index) => {
      chosen.push(index);
    });

    manager.publishAction('selectReward', undefined, 2);
    manager.publishAction('selectReward', undefined, 1);
    manager.publishAction('selectReward');

    expect(chosen).toEqual([2, 1, 0]);
  });

  it('publishes a relic index end to end through the manager', () => {
    const manager = createInputManager({});
    const activated: number[] = [];

    manager.on('activateRelic', (index) => {
      activated.push(index);
    });

    manager.publishAction('activateRelic', undefined, 5);

    expect(activated).toEqual([5]);
  });

  it('round-trips slots through serialisation', () => {
    const serialized = serializeKeymap(DEFAULT_KEY_BINDINGS);

    expect(serialized.selectReward.slots.length).toBe(REWARD_SLOT_COUNT);
    expect(serialized.selectReward.slots[1]?.index).toBe(1);
    expect(serialized.moveUp.slots).toEqual([]);

    const restored = deserializeKeymap(serialized);

    expect(restored.selectReward.slots?.length).toBe(REWARD_SLOT_COUNT);
    expect(
      resolveInput(keyEvent('3'), restored, 'overlay')?.payloadIndex,
    ).toBe(2);
  });

  it('restores a persisted non-digit remap', () => {
    const persisted = {
      ...serializeKeymap(DEFAULT_KEY_BINDINGS),
      selectReward: {
        keys: ['q', 'w', 'e'],
        codes: ['KeyQ', 'KeyW', 'KeyE'],
        contexts: ['overlay'] as const,
        preventDefault: true,
        modifierSuppressed: true,
        slots: [
          { index: 0, keys: ['q'], codes: ['KeyQ'] },
          { index: 1, keys: ['w'], codes: ['KeyW'] },
          { index: 2, keys: ['e'], codes: ['KeyE'] },
        ],
      },
    };

    const restored = deserializeKeymap(persisted);

    expect(
      resolveInput(keyEvent('e'), restored, 'overlay')?.payloadIndex,
    ).toBe(2);
  });

  it('drops a persisted slot with an unusable index', () => {
    const persisted = {
      selectReward: {
        keys: ['1', '2'],
        codes: [],
        contexts: ['overlay'],
        preventDefault: true,
        modifierSuppressed: true,
        slots: [
          { index: 0, keys: ['1'], codes: [] },
          { index: -1, keys: ['2'], codes: [] },
          { index: 1.5, keys: ['2'], codes: [] },
          { index: MAX_KEYMAP_SLOTS, keys: ['2'], codes: [] },
          { index: 1, keys: [], codes: [] },
        ],
      },
    };

    const restored = deserializeKeymap(persisted);

    expect(restored.selectReward.slots?.length).toBe(1);
    expect(
      resolveInput(keyEvent('1'), restored, 'overlay')?.payloadIndex,
    ).toBe(0);
    expect(
      resolveInput(keyEvent('2'), restored, 'overlay')?.payloadIndex,
    ).toBe(0);
  });

  it('drops a persisted duplicate index, not shadowing the first', () => {
    const persisted = {
      selectReward: {
        keys: ['1', '2'],
        codes: [],
        contexts: ['overlay'],
        preventDefault: true,
        modifierSuppressed: true,
        slots: [
          { index: 0, keys: ['1'], codes: [] },
          { index: 0, keys: ['2'], codes: [] },
        ],
      },
    };

    const restored = deserializeKeymap(persisted);

    expect(restored.selectReward.slots?.length).toBe(1);
    expect(restored.selectReward.slots?.[0]?.keys).toEqual(['1']);
  });

  it('rejects the whole payload when a slot list breaks its ceiling', () => {
    const slots = [];

    for (let index = 0; index <= MAX_KEYMAP_SLOTS; index += 1) {
      slots.push({ index, keys: ['1'], codes: [] });
    }

    const restored = deserializeKeymap({
      selectReward: {
        keys: ['1'],
        codes: [],
        contexts: ['overlay'],
        preventDefault: true,
        modifierSuppressed: true,
        slots,
      },
    });

    // Atomic rejection: the defaults are returned whole.
    expect(restored).toBe(DEFAULT_KEY_BINDINGS);
  });

  it('falls back to the default slots when the list is not an array', () => {
    const restored = deserializeKeymap({
      selectReward: {
        keys: ['1', '2', '3'],
        codes: [],
        contexts: ['overlay'],
        preventDefault: true,
        modifierSuppressed: true,
        slots: 'not an array',
      },
    });

    expect(restored.selectReward.slots?.length).toBe(REWARD_SLOT_COUNT);
  });

  it('freezes the slots it publishes', () => {
    const slots = DEFAULT_KEY_BINDINGS.selectReward.slots ?? [];

    expect(Object.isFrozen(slots)).toBe(true);
    expect(Object.isFrozen(slots[0])).toBe(true);
    expect(Object.isFrozen(slots[0]?.keys)).toBe(true);
  });
});
