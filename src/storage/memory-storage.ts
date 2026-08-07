// In-memory Web Storage double: no persistence, no DOM reference and no
// imports. Exported as a class; it installs no global.
//
// Ported from js/local_storage_manager.js L1-L19, the `window.fakeStorage`
// object literal that file already shipped: traceability row TR-STORE-09 of
// docs/TRACEABILITY_MATRIX.md. Decision DL-STORE-05, the double exported as a
// class that installs no global where L1 assigned onto `window`, is in
// docs/DECISION_LOG.md.

/**
 * The persistence surface storage consumers type against. Both the browser's
 * `localStorage` and `MemoryStorage` satisfy it structurally, and membership is
 * limited to the four operations the product uses.
 */
export interface StorageLike {
  /**
   * Reads the value stored under `key`. The union spans both implementations:
   * the DOM `Storage.getItem` contract yields `string | null`, while
   * `MemoryStorage` yields `string | undefined`.
   */
  getItem(key: string): string | null | undefined;

  setItem(key: string, value: string): void;

  removeItem(key: string): void;

  clear(): void;
}

/**
 * A `StorageLike` store held entirely in memory. No member throws for the
 * string keys and values `StorageLike` declares.
 */
export class MemoryStorage implements StorageLike {
  /**
   * Backing map. A `Map`, not an object literal: `'__proto__'` is a valid Web
   * Storage key, and assigning it on an object literal reaches
   * `Object.prototype`'s inherited accessor instead of creating an own string
   * entry, so `setItem` then `getItem` would not round-trip that key. Map keys
   * are plain strings with no inherited member of any name, so every key
   * behaves identically.
   */
  private data = new Map<string, string>();

  /**
   * Stores `value` under `key`, overwriting any previous value. The explicit
   * `String()` coercion means an untyped caller passing a number stores that
   * number's string form.
   */
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }

  /**
   * Reads the value stored under `key`, or `undefined` when it is absent —
   * never `null`. The map lookup carries the presence test itself: it yields
   * `undefined` for a key that was never set and can never yield an inherited
   * value, so keys such as `'__proto__'`, `'constructor'` and
   * `'hasOwnProperty'` both write and read without error.
   */
  getItem(key: string): string | undefined {
    return this.data.get(key);
  }

  /** Removes `key`. Removing a key that was never set is a no-op. */
  removeItem(key: string): void {
    this.data.delete(key);
  }

  /**
   * Discards every stored key by replacing the backing store.
   */
  clear(): void {
    this.data = new Map();
  }
}
