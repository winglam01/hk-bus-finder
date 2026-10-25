// @ts-check

/**
 * Persistence adapter for the browser build of the HK Bus Finder.
 *
 * `localStorage` is the only durable store a phone browser offers, but it is
 * not dependable: Safari in private mode refuses writes, and the large KMB
 * stop collection is around a megabyte of JSON which can blow the origin
 * quota. The adapter therefore never throws out of `set()`. When the browser
 * store refuses a write the value is kept in an in-memory map instead, so the
 * app keeps working with the data it has just downloaded instead of losing
 * the whole collection.
 *
 * The store is looked up at call time, not at import time, so a test harness
 * can install a polyfill after this module has been loaded.
 */

const ENVELOPE_VERSION = 1;
const DEFAULT_NAMESPACE = 'hkbus';

/**
 * @param {{ namespace?: string }} [options]
 */
export function createBrowserStorage(options = {}) {
  const namespace =
    typeof options.namespace === 'string' && options.namespace.trim()
      ? options.namespace.trim()
      : DEFAULT_NAMESPACE;
  const prefix = `${namespace}:`;

  /** @type {Map<string, unknown>} */
  const memory = new Map();
  let quotaExceeded = false;

  /**
   * The browser store, or null when it cannot be used at all.
   * @returns {Storage | null}
   */
  function backing() {
    try {
      const store = globalThis.localStorage;
      if (
        !store ||
        typeof store.getItem !== 'function' ||
        typeof store.setItem !== 'function' ||
        typeof store.removeItem !== 'function'
      ) {
        return null;
      }
      return store;
    } catch {
      // Reading `localStorage` throws in sandboxed frames and in some
      // privacy modes; the in-memory map takes over.
      return null;
    }
  }

  /**
   * @param {string} name
   * @returns {string}
   */
  function fullKey(name) {
    return `${prefix}${name}`;
  }

  return {
    /**
     * Read one entry. Returns `undefined` when the key is unknown.
     * @param {string} name
     * @returns {unknown}
     */
    get(name) {
      const key = fullKey(name);
      const store = backing();
      if (store) {
        try {
          const raw = store.getItem(key);
          if (raw !== null && raw !== undefined) {
            try {
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === 'object' && parsed.v === ENVELOPE_VERSION) {
                return parsed.d;
              }
            } catch {
              // A corrupted entry is dropped instead of breaking the app.
            }
            try {
              store.removeItem(key);
            } catch {
              /* ignore */
            }
          }
        } catch {
          // Fall through to the in-memory copy.
        }
      }
      return memory.get(key);
    },

    /**
     * Write one entry. Never throws.
     * @param {string} name
     * @param {unknown} value
     * @returns {boolean} true when the value reached the browser store
     */
    set(name, value) {
      const key = fullKey(name);
      const store = backing();
      if (store) {
        let serialised = null;
        try {
          serialised = JSON.stringify({ v: ENVELOPE_VERSION, t: Date.now(), d: value });
        } catch {
          serialised = null;
        }
        if (serialised !== null) {
          try {
            store.setItem(key, serialised);
            memory.delete(key);
            return true;
          } catch {
            // QuotaExceededError: the origin is full. The value is kept in
            // memory so the app still works with it.
            quotaExceeded = true;
          }
        }
      }
      try {
        memory.set(key, value);
      } catch {
        /* nothing else can be done */
      }
      return false;
    },

    /**
     * Drop one entry. Never throws.
     * @param {string} name
     */
    remove(name) {
      const key = fullKey(name);
      memory.delete(key);
      const store = backing();
      if (!store) return;
      try {
        store.removeItem(key);
      } catch {
        /* ignore */
      }
    },

    /** Diagnostics: which store is currently carrying the data. */
    get mode() {
      if (!backing()) return 'memory';
      return quotaExceeded ? 'localStorage+memory' : 'localStorage';
    },

    /** True once a write has been refused for quota reasons. */
    get quotaExceeded() {
      return quotaExceeded;
    },
  };
}

export default createBrowserStorage;
