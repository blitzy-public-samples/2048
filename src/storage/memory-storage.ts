// In-memory Web Storage double.
//
// Ported from js/local_storage_manager.js L1-L19, where this same double
// shipped as the global singleton `window.fakeStorage` (L1) and was picked as
// the storage strategy at L26 whenever the localStorage writability probe
// failed. The port exports a class; it installs no global. Provenance for
// every construct it owns: `_data` L2, `setItem` L4-L6, `getItem` L8-L10,
// `removeItem` L12-L14, `clear` L16-L18.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

/**
 * The persistence surface storage consumers type against.
 *
 * Both the browser's `localStorage` and `MemoryStorage` below satisfy it
 * structurally. Membership is limited to the four operations the product
 * uses; `length`, `key(index)` and an index signature are absent.
 */
export interface StorageLike {
  /**
   * Reads the value stored under `key`.
   *
   * The union spans both implementations: the DOM `Storage.getItem` contract
   * yields `string | null`, while `MemoryStorage.getItem` yields
   * `string | undefined` per L9.
   */
  getItem(key: string): string | null | undefined;

  /** Stores `value` under `key`. */
  setItem(key: string, value: string): void;

  /** Removes `key`, if present. */
  removeItem(key: string): void;

  /** Discards every stored key. */
  clear(): void;
}

/**
 * A `StorageLike` store held entirely in memory: no persistence, no DOM
 * reference, no imports. Faithful port of the `window.fakeStorage` object
 * literal at js/local_storage_manager.js L1-L19. No member throws, for any
 * key or value.
 *
 * @example
 * const storage: StorageLike = new MemoryStorage();
 * storage.setItem('bestScore', '13892');
 * storage.getItem('bestScore'); // '13892'
 */
export class MemoryStorage implements StorageLike {
  /** Backing map. Ported from L2 `_data`; the underscore prefix is dropped. */
  private data: Record<string, string> = {};

  /**
   * Stores `value` under `key`, overwriting any previous value.
   *
   * Ported from L4-L6, keeping L5's explicit `String(val)` coercion: an
   * untyped caller passing a number stores that number's string form.
   */
  setItem(key: string, value: string): void {
    this.data[key] = String(value);
  }

  /**
   * Reads the value stored under `key`, or `undefined` when it is absent.
   *
   * Ported from L8-L10: returns `undefined`, never `null`, exactly as L9
   * does. L9's `this._data.hasOwnProperty(id)` is written here in the
   * `Object.prototype.hasOwnProperty.call` form. Keys such as `'__proto__'`,
   * `'constructor'` and `'hasOwnProperty'` read without error.
   */
  getItem(key: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(this.data, key)
      ? this.data[key]
      : undefined;
  }

  /**
   * Removes `key`. Removing a key that was never set is a no-op.
   *
   * Ported from L12-L14; the port drops the boolean that L13's `delete`
   * expression returns, matching `StorageLike.removeItem`.
   */
  removeItem(key: string): void {
    delete this.data[key];
  }

  /**
   * Discards every stored key.
   *
   * Ported from L16-L18: replaces the backing object, as L17 does.
   */
  clear(): void {
    this.data = {};
  }
}
