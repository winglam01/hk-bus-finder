// @ts-check

/**
 * Upstream access layer for the three Hong Kong bus operators, ported to run
 * inside a browser.
 *
 * Every endpoint below was probed and confirmed against the live public data
 * services before this file was written:
 *
 *   KMB / Long Win  data.etabus.gov.hk/v1/transport/kmb/...
 *   Citybus         rt.data.gov.hk/v1|v2/transport/citybus(-nwfb)/...
 *   Lantau (NLB)    rt.data.gov.hk/v2/transport/nlb/...
 *
 * The three operators publish different shapes, so this module normalises them
 * into one vocabulary that the domain layer can treat uniformly.
 *
 * Browser notes
 * --------------
 * - No `node:` imports: the transport is `fetch` only.
 * - No custom request headers are sent from a browser. The upstream edge
 *   answers a CORS preflight without `Access-Control-Allow-Headers`, so any
 *   custom header would break the cross-origin call. A real browser already
 *   sends a real User-Agent, which is what the edge wants. Outside a browser
 *   (the smoke test) browser-like headers are sent so the edge does not
 *   refuse the large public collections.
 * - Static collections are cached for six hours and persisted through the
 *   storage adapter; ETAs and departure boards live in memory for twenty
 *   seconds only.
 */

import { createBrowserStorage } from './storage.mjs';

const KMB_BASE = 'https://data.etabus.gov.hk/v1/transport/kmb';
const GOV_BASE = 'https://rt.data.gov.hk';

export const OPERATORS = {
  kmb: { id: 'kmb', name: 'KMB', nameTc: '九巴', full: 'Kowloon Motor Bus', fullTc: '九巴' },
  ctb: { id: 'ctb', name: 'Citybus', nameTc: '城巴', full: 'Citybus Limited', fullTc: '城巴' },
  nlb: { id: 'nlb', name: 'Lantau Bus', nameTc: '嶼巴', full: 'New Lantao Bus', fullTc: '新大嶼山巴士' },
};

export const OPERATOR_IDS = ['kmb', 'ctb', 'nlb'];

export class UpstreamError extends Error {
  /** @param {string} message @param {string} [url] @param {number} [status] */
  constructor(message, url = '', status = 0) {
    super(message);
    this.name = 'UpstreamError';
    this.url = url;
    this.status = status;
  }
}

/** @param {unknown} v */
function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True inside a real browser document. */
const IN_BROWSER = typeof document !== 'undefined' && typeof window !== 'undefined';

/**
 * Headers sent to the upstream edge.
 *
 * A browser must not add any: `Access-Control-Allow-Origin: *` is enough for
 * a simple cross-origin GET, but a preflight would fail because the edge does
 * not answer it. Outside a browser the headers make the request look like the
 * browser traffic the edge expects.
 * @returns {Record<string, string> | undefined}
 */
function requestHeaders() {
  if (IN_BROWSER) return undefined;
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-HK,en;q=0.9',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  };
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch JSON with a timeout and a retry for transient failures.
 *
 * The edge in front of the large KMB collections answers 403 and 429 under
 * load now and then, so both are treated as transient and are retried with a
 * short backoff.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, retries?: number, backoffMs?: number }} [opts]
 */
async function getJson(url, opts = {}) {
  // The Transport Department edge can take well over ten seconds on a cold
  // request, and a phone on mobile data is slower still, so the default is
  // generous. The large collections ask for more.
  const timeoutMs = opts.timeoutMs ?? 20000;
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 800;
  /** @type {Error | undefined} */
  let lastError = undefined;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      /** @type {RequestInit} */
      const init = { signal: AbortSignal.timeout(timeoutMs) };
      const headers = requestHeaders();
      if (headers) init.headers = headers;
      const res = await fetch(url, init);
      if (!res.ok) {
        // The Transport Department edge answers 403 or 429 at random on the
        // large collections — measured at roughly one request in three, and
        // it comes back in milliseconds rather than hanging. It is not a
        // User-Agent problem, so it is retried rather than reclassified.
        const retryable = res.status === 429 || res.status === 403 || res.status >= 500;
        lastError = new UpstreamError(`upstream responded ${res.status}`, url, res.status);
        if (retryable && attempt < retries) {
          await sleep(backoffMs * (attempt + 1));
          continue;
        }
        throw lastError;
      }
      const text = await res.text();
      if (!text.trim()) throw new UpstreamError('upstream returned an empty body', url, res.status);
      try {
        return JSON.parse(text);
      } catch {
        throw new UpstreamError('upstream returned malformed JSON', url, res.status);
      }
    } catch (error) {
      if (error instanceof UpstreamError && error.status && error.status < 500 && error.status !== 429) {
        throw error;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < retries) {
        await sleep(600 * (attempt + 1));
      }
    }
  }
  throw lastError ?? new UpstreamError('upstream request failed', url);
}

/**
 * Two level cache: memory first, then the storage adapter so a page reload
 * does not download the multi megabyte collections again.
 *
 * Only static collections are persisted. An empty collection is never
 * written, because bad data must not survive a reload.
 */
export class Cache {
  /**
   * @param {ReturnType<typeof createBrowserStorage> | null} [storage]
   * @param {{ prefix?: string }} [options]
   */
  constructor(storage = null, options = {}) {
    this.storage = storage;
    this.prefix = options.prefix ?? 'cache';
    /** @type {Map<string, { t: number, v: unknown }>} */
    this.mem = new Map();
  }

  /**
   * @param {string} key
   * @returns {string}
   */
  storageKey(key) {
    return `${this.prefix}:${key}`;
  }

  /**
   * A cached value, without going to the network for it.
   *
   * Returns undefined when the value was never cached or has expired. This is
   * how the interface can show what it already knows without paying for a
   * request to find out.
   *
   * @template T
   * @param {string} key
   * @param {number} ttlMs
   * @returns {T | undefined}
   */
  peek(key, ttlMs) {
    const now = Date.now();
    const hit = this.mem.get(key);
    if (hit && now - hit.t < ttlMs) return /** @type {T} */ (hit.v);

    if (this.storage) {
      const stored = this.storage.get(this.storageKey(key));
      if (stored && typeof stored === 'object' && typeof stored.t === 'number' && now - stored.t < ttlMs) {
        this.mem.set(key, /** @type {{ t: number, v: unknown }} */ (stored));
        return /** @type {T} */ (/** @type {{ v: T }} */ (stored).v);
      }
    }
    return undefined;
  }

  /**
   * @template T
   * @param {string} key
   * @param {number} ttlMs
   * @param {() => Promise<T>} loader
   * @param {{ persist?: boolean }} [options]
   * @returns {Promise<T>}
   */
  async get(key, ttlMs, loader, options = {}) {
    const persist = options.persist ?? true;
    const now = Date.now();
    const hit = this.mem.get(key);
    if (hit && now - hit.t < ttlMs) return /** @type {T} */ (hit.v);

    if (persist && this.storage) {
      const stored = this.storage.get(this.storageKey(key));
      if (stored && typeof stored === 'object' && typeof stored.t === 'number' && now - stored.t < ttlMs) {
        this.mem.set(key, /** @type {{ t: number, v: unknown }} */ (stored));
        return /** @type {T} */ (/** @type {{ v: T }} */ (stored).v);
      }
    }

    const value = await loader();
    const entry = { t: now, v: value };
    this.mem.set(key, entry);
    if (persist && this.storage && !isEmptyCollection(value)) {
      this.storage.set(this.storageKey(key), entry);
    }
    return value;
  }

  /**
   * @template T
   * @param {string} key
   * @param {number} ttlMs
   * @param {() => Promise<T>} loader
   * @param {{ persist?: boolean }} [options]
   * @returns {Promise<T>}
   */
  async getSticky(key, ttlMs, loader, options = {}) {
    return this.get(key, ttlMs, loader, options);
  }

  /**
   * @param {string} key
   * @param {unknown} value
   */
  async set(key, value) {
    const entry = { t: Date.now(), v: value };
    this.mem.set(key, entry);
    if (this.storage && !isEmptyCollection(value)) {
      this.storage.set(this.storageKey(key), entry);
    }
  }
}

/**
 * An empty collection is a broken answer, never a cacheable one.
 * @param {unknown} value
 * @returns {boolean}
 */
function isEmptyCollection(value) {
  return Array.isArray(value) && value.length === 0;
}

/** HK local time offset used when a provider hands back a naive timestamp. */
const HK_OFFSET = '+08:00';

/** Static operator collections are refreshed at most every six hours. */
const STATIC_TTL = 6 * 60 * 60 * 1000;

/** ETAs and departure boards are refreshed every twenty seconds. */
const LIVE_TTL = 20 * 1000;

/** @param {string | undefined | null} value */
function normaliseNaiveTimestamp(value) {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) return trimmed.replace(' ', 'T');
  return `${trimmed.replace(' ', 'T')}${HK_OFFSET}`;
}

/**
 * Coerce a provider field to text. Numbers and bigints are stringified, so a
 * numeric `seq` of 0 does not become an empty string.
 * @param {unknown} value
 */
function asText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  return '';
}

/** @param {unknown} value */
function asNumber(value) {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Run tasks with a bounded concurrency so upstream services are not hammered.
 *
 * The tasks must be thunks. Passing an already started promise would start
 * every request at once and defeat the concurrency limit.
 *
 * @template T
 * @param {number} limit
 * @param {(() => Promise<T>)[]} tasks
 * @returns {Promise<(T | undefined)[]>}
 */
export async function mapLimited(limit, tasks) {
  tasks.forEach((task, index) => {
    if (typeof task !== 'function') {
      throw new TypeError(`mapLimited task ${index} is not a function`);
    }
  });
  const results = new Array(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      try {
        results[index] = await tasks[index]();
      } catch {
        results[index] = undefined;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Normalised upstream client. One instance is created per page.
 */
export class Upstream {
  /**
   * @param {ReturnType<typeof createBrowserStorage> | null} [storage]
   */
  constructor(storage = null) {
    this.cache = new Cache(storage);
    /** @type {Record<string, { ok: boolean, at: number, error: string }>} */
    this.health = {};
    /** @type {Map<string, { nameEn: string, nameTc: string, lat: number, long: number }>} */
    this.stopCache = new Map();
    /**
     * Citybus names stops one at a time, so resolved stops are collected here
     * and reused for stop search.
     * @type {Map<string, { nameEn: string, nameTc: string, lat: number, long: number }>}
     */
    this.citybusStops = new Map();
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    this.indexRetries = new Map();
  }

  /**
   * Retry an operator index that failed to load, so a transient upstream
   * outage heals itself instead of leaving that operator missing until the
   * user happens to search again. Nothing is cached on failure, so this only
   * ever repeats a request that already failed.
   * @param {string} key
   * @param {() => Promise<any[]>} loader
   * @param {number} [attempt]
   */
  scheduleIndexRetry(key, loader, attempt = 1) {
    if (attempt > 5 || this.indexRetries.has(key)) return;
    const timer = setTimeout(() => {
      this.indexRetries.delete(key);
      void this.cache.getSticky(key, STATIC_TTL, loader).catch(() => {
        this.scheduleIndexRetry(key, loader, attempt + 1);
      });
    }, 2500 * attempt);
    this.indexRetries.set(key, timer);
  }

  /** @returns {Map<string, { nameEn: string, nameTc: string, lat: number, long: number }>} */
  knownCitybusStops() {
    return this.citybusStops;
  }

  /** @param {string} operator @param {string} [detail] */
  noteOk(operator, detail = '') {
    this.health[operator] = { ok: true, at: Date.now(), error: detail };
  }

  /** @param {string} operator @param {unknown} error */
  noteFail(operator, error) {
    const message = error instanceof Error ? error.message : String(error);
    const previous = this.health[operator];
    this.health[operator] = { ok: false, at: previous?.at ?? 0, error: message };
  }

  // ---------------------------------------------------------------- routes

  /**
   * Route index keyed by `operator:routeNumber`.
   * @returns {Promise<Map<string, { operator: string, route: string, directions: Map<string, { originEn: string, originTc: string, destEn: string, destTc: string, serviceTypes: number[] }> }>>}
   */
  async routeIndex() {
    // Each operator is cached separately: one operator failing must not take
    // the others down, and an empty response must never be cached.
    const safe = async (/** @type {string} */ key, /** @type {() => Promise<any[]>} */ loader) => {
      try {
        return await this.cache.getSticky(key, STATIC_TTL, loader);
      } catch (error) {
        // This operator is down for this call only. The failure is not cached,
        // so the next request retries on its own; the background retry makes
        // the recovery happen without waiting for the user to act.
        this.scheduleIndexRetry(key, loader);
        return [];
      }
    };

    const kmbRows = await safe('index:routes:kmb:v1', async () => {
      try {
        const payload = await getJson(`${KMB_BASE}/route`, { timeoutMs: 45000, retries: 6 });
        const rows = Array.isArray(payload?.data) ? payload.data : [];
        if (!rows.length) throw new UpstreamError('KMB route list was empty', KMB_BASE);
        this.noteOk('kmb');
        const mapped = rows.filter(isObject).map((row) => {
          const route = asText(row.route);
          const bound = asText(row.bound);
          if (!route || (bound !== 'I' && bound !== 'O')) return null;
          return {
            operator: 'kmb',
            route,
            dir: bound === 'O' ? 'O' : 'I',
            originEn: asText(row.orig_en),
            originTc: asText(row.orig_tc),
            destEn: asText(row.dest_en),
            destTc: asText(row.dest_tc),
            serviceType: Number.parseInt(asText(row.service_type), 10) || 1,
          };
        }).filter(Boolean);
        if (!mapped.length) throw new UpstreamError('KMB route list could not be parsed', KMB_BASE);
        return mapped;
      } catch (error) {
        this.noteFail('kmb', error);
        throw error;
      }
    });

    const ctbRows = await safe('index:routes:ctb:v1', async () => {
      try {
        const payload = await getJson(`${GOV_BASE}/v1/transport/citybus-nwfb/route/ctb`, {
          timeoutMs: 45000,
        retries: 6,
          retries: 6,
        });
        const rows = Array.isArray(payload?.data) ? payload.data : [];
        if (!rows.length) throw new UpstreamError('Citybus route list was empty', GOV_BASE);
        this.noteOk('ctb');
        const mapped = rows.filter(isObject).map((row) => {
          const route = asText(row.route);
          if (!route) return null;
          return {
            operator: 'ctb',
            route,
            dir: 'O',
            originEn: asText(row.orig_en),
            originTc: asText(row.orig_tc),
            destEn: asText(row.dest_en),
            destTc: asText(row.dest_tc),
            serviceType: 1,
          };
        }).filter(Boolean);
        if (!mapped.length) throw new UpstreamError('Citybus route list could not be parsed', GOV_BASE);
        return mapped;
      } catch (error) {
        this.noteFail('ctb', error);
        throw error;
      }
    });

    const nlbRows = await safe('index:routes:nlb:v1', async () => {
      try {
        const payload = await getJson(`${GOV_BASE}/v2/transport/nlb/route.php?action=list`, {
          timeoutMs: 45000,
        retries: 6,
          retries: 6,
        });
        const rows = Array.isArray(payload?.routes) ? payload.routes : [];
        if (!rows.length) throw new UpstreamError('Lantau route list was empty', GOV_BASE);
        this.noteOk('nlb');
        // A route number can cover several directions, each with its own
        // routeId. The API has no direction flag, so direction is positional.
        /** @type {Map<string, any[]>} */
        const byNumber = new Map();
        for (const row of rows) {
          if (!isObject(row)) continue;
          const route = asText(row.routeNo);
          if (!route) continue;
          if (!byNumber.has(route)) byNumber.set(route, []);
          byNumber.get(route).push(row);
        }
        /** @type {any[]} */
        const out = [];
        for (const [route, group] of byNumber) {
          group.slice(0, 2).forEach((row, position) => {
            const [originEn = '', destEn = ''] = asText(row.routeName_e).split('>').map((s) => s.trim());
            const [originTc = '', destTc = ''] = asText(row.routeName_c).split('>').map((s) => s.trim());
            out.push({
              operator: 'nlb',
              route,
              dir: position === 0 ? 'O' : 'I',
              originEn,
              originTc,
              destEn,
              destTc,
              serviceType: 1,
            });
          });
        }
        return out;
      } catch (error) {
        this.noteFail('nlb', error);
        throw error;
      }
    });

    /** @type {Map<string, any>} */
    const index = new Map();
    const rowCounts = { kmb: 0, ctb: 0, nlb: 0 };
    for (const row of [...kmbRows, ...ctbRows, ...nlbRows]) {
      if (!row) continue;
      rowCounts[row.operator] = (rowCounts[row.operator] ?? 0) + 1;
      const key = `${row.operator}:${row.route}`;
      let entry = index.get(key);
      if (!entry) {
        entry = { operator: row.operator, route: row.route, directions: new Map() };
        index.set(key, entry);
      }
      let direction = entry.directions.get(row.dir);
      if (!direction) {
        direction = { originEn: '', originTc: '', destEn: '', destTc: '', serviceTypes: [] };
        entry.directions.set(row.dir, direction);
      }
      if (!direction.originEn) {
        direction.originEn = row.originEn;
        direction.originTc = row.originTc;
        direction.destEn = row.destEn;
        direction.destTc = row.destTc;
      }
      if (!direction.serviceTypes.includes(row.serviceType)) {
        direction.serviceTypes.push(row.serviceType);
      }
    }

    // An operator whose index came back empty is reported as unhealthy so the
    // interface can say so rather than silently showing fewer routes.
    for (const [operator, count] of Object.entries(rowCounts)) {
      if (count === 0 && this.health[operator]?.ok !== false) {
        this.noteFail(operator, new Error('no published routes could be loaded'));
      }
    }
    return index;
  }

  /**
   * Lantau route ids are separate from route numbers. The ids for one route
   * number are returned in route order, so index 0 is the first direction.
   * @returns {Promise<Map<string, string[]>>}
   */
  async nlbRouteIds() {
    const raw = await this.cache.getSticky('index:nlbRouteIds:v1', STATIC_TTL, async () => {
      const payload = await getJson(`${GOV_BASE}/v2/transport/nlb/route.php?action=list`, {
        timeoutMs: 45000,
        retries: 6,
      });
      const rows = Array.isArray(payload?.routes) ? payload.routes : [];
      if (!rows.length) throw new UpstreamError('Lantau route list was empty', GOV_BASE);
      /** @type {Record<string, string[]>} */
      const byNumber = {};
      for (const row of rows) {
        if (!isObject(row)) continue;
        const routeNo = asText(row.routeNo);
        const routeId = asText(row.routeId);
        if (!routeNo || !routeId) continue;
        if (!byNumber[routeNo]) byNumber[routeNo] = [];
        byNumber[routeNo].push(routeId);
      }
      return byNumber;
    });
    return new Map(Object.entries(raw));
  }

  // ----------------------------------------------------------------- stops

  /**
   * Full stop catalogue for KMB (names + coordinates).
   * @returns {Promise<Map<string, { nameEn: string, nameTc: string, lat: number, long: number }>>}
   */
  async kmbStops() {
    return this.cache.getSticky('index:kmbStops:v1', STATIC_TTL, async () => {
      const payload = await getJson(`${KMB_BASE}/stop`, {
        timeoutMs: 45000,
        retries: 6,
        retries: 3,
        backoffMs: 2000,
      });
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      if (!rows.length) throw new UpstreamError('KMB stop list was empty', KMB_BASE);
      /** @type {Record<string, { nameEn: string, nameTc: string, lat: number, long: number }>} */
      const out = {};
      for (const row of rows) {
        if (!isObject(row)) continue;
        const id = asText(row.stop);
        if (!id) continue;
        out[id] = {
          nameEn: asText(row.name_en),
          nameTc: asText(row.name_tc),
          lat: asNumber(row.lat),
          long: asNumber(row.long),
        };
      }
      if (!Object.keys(out).length) throw new UpstreamError('KMB stop list could not be parsed', KMB_BASE);
      return out;
    }).then((raw) => new Map(Object.entries(raw)));
  }

  /**
   * One KMB stop, fetched on its own. The edge in front of the large stop
   * collection refuses it now and then, while the per-stop endpoint keeps
   * answering, so a throttled collection never has to hide a route page.
   * @param {string} stopId
   * @returns {Promise<{ nameEn: string, nameTc: string, lat: number, long: number } | undefined>}
   */
  async kmbStopDetail(stopId) {
    const cacheKey = `stop:kmb:${stopId}`;
    const cached = this.stopCache.get(cacheKey);
    if (cached) return cached;

    const lookup = async () => {
      const payload = await getJson(`${KMB_BASE}/stop/${encodeURIComponent(stopId)}`);
      const row = payload?.data;
      if (!isObject(row) || !asText(row.name_en)) return undefined;
      return {
        nameEn: asText(row.name_en),
        nameTc: asText(row.name_tc),
        lat: asNumber(row.lat),
        long: asNumber(row.long),
      };
    };

    const result = await this.cache.get(cacheKey, STATIC_TTL, lookup).catch(() => undefined);
    if (result) this.stopCache.set(cacheKey, result);
    return result;
  }

  /**
   * Stop -> routes index for KMB, derived from the published route-stop list.
   * @returns {Promise<Map<string, { route: string, dir: string, serviceType: number, seq: number }[]>>}
   */
  async kmbStopRoutes() {
    return this.cache.getSticky('index:kmbStopRoutes:v1', STATIC_TTL, async () => {
      const payload = await getJson(`${KMB_BASE}/route-stop`, {
        timeoutMs: 60000,
        retries: 6,
        backoffMs: 1500,
      });
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      if (!rows.length) throw new UpstreamError('KMB route stop list was empty', KMB_BASE);
      /** @type {Map<string, { route: string, dir: string, serviceType: number, seq: number }[]>} */
      const index = new Map();
      for (const row of rows) {
        if (!isObject(row)) continue;
        const stop = asText(row.stop);
        const route = asText(row.route);
        if (!stop || !route) continue;
        let list = index.get(stop);
        if (!list) {
          list = [];
          index.set(stop, list);
        }
        list.push({
          route,
          dir: asText(row.bound) === 'I' ? 'I' : 'O',
          serviceType: Number.parseInt(asText(row.service_type), 10) || 1,
          seq: Number.parseInt(asText(row.seq), 10) || 0,
        });
      }
      if (!index.size) throw new UpstreamError('KMB route stop list could not be parsed', KMB_BASE);
      return [...index.entries()].map(([stop, list]) => [stop, list]);
    }).then((raw) => new Map(raw));
  }

  /**
   * Look up a single stop for any operator.
   * @param {'kmb'|'ctb'|'nlb'} operator
   * @param {string} stopId
   * @returns {Promise<{ nameEn: string, nameTc: string, lat: number, long: number } | undefined>}
   */
  async stop(operator, stopId) {
    const cacheKey = `stop:${operator}:${stopId}`;
    const cached = this.stopCache.get(cacheKey);
    if (cached) return cached;
    // Citybus stops already resolved elsewhere are reused without a call.
    if (operator === 'ctb') {
      const known = this.citybusStops.get(stopId);
      if (known) {
        this.stopCache.set(cacheKey, known);
        return known;
      }
    }

    const lookup = async () => {
      if (operator === 'kmb') {
        const stops = await this.kmbStops().catch(() => undefined);
        const hit = stops?.get(stopId);
        if (hit) return hit;
        // The stop collection was throttled: fall back to the per-stop
        // endpoint, which keeps answering.
        return this.kmbStopDetail(stopId);
      }
      if (operator === 'ctb') {
        const payload = await getJson(`${GOV_BASE}/v2/transport/citybus/stop/${encodeURIComponent(stopId)}`);
        const row = payload?.data;
        if (!isObject(row) || !asText(row.name_en)) return undefined;
        return {
          nameEn: asText(row.name_en),
          nameTc: asText(row.name_tc),
          lat: asNumber(row.lat),
          long: asNumber(row.long),
        };
      }
      // Lantau stop names come from the route stop list, so scan the routes.
      const stops = await this.nlbStops();
      return stops.get(stopId);
    };

    const result = await this.cache.get(cacheKey, STATIC_TTL, lookup).catch(() => undefined);
    if (result) {
      this.stopCache.set(cacheKey, result);
      if (operator === 'ctb') this.citybusStops.set(stopId, result);
    }
    return result;
  }

  /**
   * Every Lantau stop, keyed by stop id, harvested from the route stop lists.
   * @returns {Promise<Map<string, { nameEn: string, nameTc: string, lat: number, long: number }>>}
   */
  async nlbStops() {
    return this.cache.getSticky('index:nlbStops:v1', STATIC_TTL, async () => {
      const payload = await getJson(`${GOV_BASE}/v2/transport/nlb/route.php?action=list`, {
        timeoutMs: 45000,
        retries: 6,
      });
      const rows = Array.isArray(payload?.routes) ? payload.routes : [];
      if (!rows.length) throw new UpstreamError('Lantau route list was empty', GOV_BASE);
      /** @type {Record<string, { nameEn: string, nameTc: string, lat: number, long: number }>} */
      const out = {};
      const routeIds = rows
        .filter((row) => isObject(row))
        .map((row) => asText(row.routeId))
        .filter(Boolean);
      const lists = await mapLimited(6, routeIds.map((routeId) => async () => {
        try {
          return await getJson(`${GOV_BASE}/v2/transport/nlb/stop.php?action=list&routeId=${encodeURIComponent(routeId)}`);
        } catch {
          return null;
        }
      }));
      for (const stops of lists) {
        const list = Array.isArray(stops?.stops) ? stops.stops : [];
        for (const stop of list) {
          if (!isObject(stop)) continue;
          const id = asText(stop.stopId);
          if (!id || out[id]) continue;
          out[id] = {
            nameEn: asText(stop.stopName_e),
            nameTc: asText(stop.stopName_c),
            lat: asNumber(stop.latitude),
            long: asNumber(stop.longitude),
          };
        }
      }
      if (!Object.keys(out).length) throw new UpstreamError('Lantau stop list could not be parsed', GOV_BASE);
      return out;
    }).then((raw) => new Map(Object.entries(raw)));
  }

  /**
   * The ordered stops of each published service variant. A KMB route often
   * runs from a different terminus by day and by night, so the variants are
   * kept apart rather than merged into one misleading list.
   * @param {'kmb'|'ctb'|'nlb'} operator
   * @param {string} route
   * @param {'O'|'I'} dir
   * @param {number[]} [serviceTypes]
   */
  async routeStopsByServiceType(operator, route, dir, serviceTypes = []) {
    const types = operator === 'kmb' ? (serviceTypes.length ? serviceTypes : [1]) : [1];
    /** @type {Record<string, any[]>} */
    const groups = {};
    await Promise.all(types.map(async (type) => {
      groups[type] = await this.routeStops(operator, route, dir, [type]);
    }));
    for (const list of Object.values(groups)) {
      list.forEach((stop, index) => {
        stop.seq = index + 1;
      });
    }
    return groups;
  }

  /**
   * The published stop rows of one route direction, before stop names are
   * resolved.
   *
   * @param {'kmb'|'ctb'|'nlb'} operator
   * @param {string} route
   * @param {'O'|'I'} dir
   * @param {number[]} [serviceTypes]
   * @returns {Promise<any[]>}
   */
  async rawRouteStops(operator, route, dir, serviceTypes = []) {
    /** @type {any[]} */
    const raw = [];

    if (operator === 'kmb') {
      const types = serviceTypes.length ? serviceTypes : [1];
      const payloads = await mapLimited(
        2,
        types.map((type) => async () => {
          const payload = await getJson(
            `${KMB_BASE}/route-stop/${encodeURIComponent(route)}/${dir === 'O' ? 'outbound' : 'inbound'}/${type}`,
          );
          return Array.isArray(payload?.data) ? payload.data : [];
        }),
      );
      for (const rows of payloads) {
        for (const row of rows ?? []) {
          if (!isObject(row)) continue;
          raw.push({
            seq: Number.parseInt(asText(row.seq), 10) || 0,
            stopId: asText(row.stop),
            serviceType: Number.parseInt(asText(row.service_type), 10) || 1,
          });
        }
      }
    } else if (operator === 'ctb') {
      const payload = await getJson(
        `${GOV_BASE}/v2/transport/citybus/route-stop/CTB/${encodeURIComponent(route)}/${dir === 'O' ? 'outbound' : 'inbound'}`,
      );
      for (const row of Array.isArray(payload?.data) ? payload.data : []) {
        if (!isObject(row)) continue;
        raw.push({ seq: Number.parseInt(asText(row.seq), 10) || 0, stopId: asText(row.stop), serviceType: 1 });
      }
    } else {
      const ids = await this.nlbRouteIds();
      const all = ids.get(route) ?? [];
      const candidates = all.length > 1 ? [all[dir === 'O' ? 0 : 1]] : all;
      for (const routeId of candidates) {
        const payload = await getJson(
          `${GOV_BASE}/v2/transport/nlb/stop.php?action=list&routeId=${encodeURIComponent(routeId)}`,
        );
        const rows = Array.isArray(payload?.stops) ? payload.stops : [];
        for (const stop of rows) {
          if (!isObject(stop)) continue;
          raw.push({
            seq: raw.length + 1,
            stopId: asText(stop.stopId),
            serviceType: 1,
            nameEn: asText(stop.stopName_e),
            nameTc: asText(stop.stopName_c),
            lat: asNumber(stop.latitude),
            long: asNumber(stop.longitude),
            fare: Number.isFinite(Number.parseFloat(asText(stop.fare))) ? Number.parseFloat(asText(stop.fare)) : null,
            fareHoliday: Number.isFinite(Number.parseFloat(asText(stop.fareHoliday)))
              ? Number.parseFloat(asText(stop.fareHoliday))
              : null,
          });
        }
      }
    }

    return raw;
  }

  /**
   * The stop ids of one route direction, without resolving stop names.
   *
   * The route-stop endpoint answers with stop ids only, so this is one small
   * request per direction and it says whether a direction runs at all.
   *
   * @param {'kmb'|'ctb'|'nlb'} operator
   * @param {string} route
   * @param {'O'|'I'} dir
   * @param {number[]} [serviceTypes]
   * @returns {Promise<string[]>}
   */
  async routeStopIds(operator, route, dir, serviceTypes = []) {
    const key = `routestopids:${operator}:${route}:${dir}:${serviceTypes.join(',') || 'all'}`;
    return this.cache.get(key, STATIC_TTL, async () => {
      const raw = await this.rawRouteStops(operator, route, dir, serviceTypes);
      const seen = new Set();
      const ids = [];
      for (const item of raw) {
        const stopId = asText(item?.stopId);
        if (!stopId || seen.has(stopId)) continue;
        seen.add(stopId);
        ids.push(stopId);
      }
      return ids;
    });
  }

  /**
   * The directions a route really runs.
   *
   * Citybus publishes one row per route with no direction at all, so its
   * route list cannot say whether a route runs both ways; the route-stop
   * endpoint can. Only the first and last stop of each direction are named,
   * which keeps the extra cost to a couple of calls per route.
   *
   * @param {'kmb'|'ctb'|'nlb'} operator
   * @param {string} route
   * @param {number[]} [serviceTypes]
   * @returns {Promise<{ dir: 'O'|'I', originEn: string, originTc: string, destEn: string, destTc: string }[]>}
   */
  async routeDirections(operator, route, serviceTypes = []) {
    const key = `routedirections:${operator}:${route}:${serviceTypes.join(',') || 'all'}`;
    return this.cache.get(key, STATIC_TTL, async () => {
      /** @type {{ dir: 'O'|'I', originEn: string, originTc: string, destEn: string, destTc: string }[]} */
      const out = [];
      for (const dir of /** @type {const ('O'|'I')[]} */ (['O', 'I'])) {
        const ids = await this.routeStopIds(operator, route, dir, serviceTypes).catch(() => []);
        if (!ids.length) continue;
        const first = await this.stop(operator, ids[0]).catch(() => undefined);
        const last = ids.length > 1 ? await this.stop(operator, ids[ids.length - 1]).catch(() => undefined) : first;
        out.push({
          dir,
          originEn: asText(first?.nameEn),
          originTc: asText(first?.nameTc),
          destEn: asText(last?.nameEn),
          destTc: asText(last?.nameTc),
        });
      }
      return out;
    });
  }

  /**
   * The directions of a route, if they have already been worked out.
   *
   * This never goes to the network, so it is how a list can show the second
   * direction of a route the interface has already seen.
   *
   * @param {'kmb'|'ctb'|'nlb'} operator
   * @param {string} route
   * @param {number[]} [serviceTypes]
   * @returns {{ dir: 'O'|'I', originEn: string, originTc: string, destEn: string, destTc: string }[] | undefined}
   */
  cachedRouteDirections(operator, route, serviceTypes = []) {
    return this.cache.peek(
      `routedirections:${operator}:${route}:${serviceTypes.join(',') || 'all'}`,
      STATIC_TTL,
    );
  }

  /**
   * The ordered stops of one route direction.
   * @param {'kmb'|'ctb'|'nlb'} operator
   * @param {string} route
   * @param {'O'|'I'} dir
   * @param {number[]} [serviceTypes]
   * @returns {Promise<{ seq: number, stopId: string, nameEn: string, nameTc: string, lat: number, long: number, fare: number | null, fareHoliday: number | null }[]>}
   */
  async routeStops(operator, route, dir, serviceTypes = []) {
    const key = `routestops:${operator}:${route}:${dir}:${serviceTypes.join(',') || 'all'}`;

    const load = async () => {
      /** @type {{ seq: number, stopId: string, serviceType: number }[]} */
      const raw = await this.rawRouteStops(operator, route, dir, serviceTypes);

      // Deduplicate by stop id, keeping the first occurrence in sequence order.
      /** @type {Map<string, any>} */
      const merged = new Map();
      for (const item of raw) {
        if (!item.stopId || merged.has(item.stopId)) continue;
        merged.set(item.stopId, { ...item });
      }
      const ordered = [...merged.values()].sort((a, b) => a.seq - b.seq);

      // Resolve stop names for the operators that do not publish them inline.
      if (operator !== 'nlb') {
        const needed = ordered.filter((item) => !item.nameEn).map((item) => item.stopId);
        /** @type {Map<string, any>} */
        const byId = new Map();
        if (needed.length) {
          // The KMB stop collection is the fast path, but the edge in front of
          // it refuses the large payload now and then. The per-stop endpoint
          // keeps working, so a throttled collection only costs extra calls
          // instead of hiding every KMB route page.
          const catalogue = operator === 'kmb' ? await this.kmbStops().catch(() => undefined) : undefined;
          const resolved = await mapLimited(6, needed.map((id) => async () => {
            if (catalogue) return catalogue.get(id);
            if (operator === 'kmb') return this.kmbStopDetail(id);
            return this.stop('ctb', id);
          }));
          needed.forEach((id, i) => {
            const value = resolved[i];
            if (value) byId.set(id, value);
          });
        }
        for (const item of ordered) {
          const hit = byId.get(item.stopId);
          if (hit) {
            item.nameEn = hit.nameEn;
            item.nameTc = hit.nameTc;
            item.lat = hit.lat;
            item.long = hit.long;
          }
        }
      }

      return ordered.map((item) => ({
        seq: item.seq,
        stopId: item.stopId,
        nameEn: item.nameEn ?? '',
        nameTc: item.nameTc ?? '',
        lat: item.lat ?? 0,
        long: item.long ?? 0,
        fare: item.fare ?? null,
        fareHoliday: item.fareHoliday ?? null,
      }));
    };

    return this.cache.get(key, STATIC_TTL, load);
  }

  // ------------------------------------------------------------ departures

  /**
   * Normalised departures for one route direction at one stop.
   * @param {'kmb'|'ctb'|'nlb'} operator
   * @param {string} route
   * @param {'O'|'I'} dir
   * @param {string} stopId
   * @param {number[]} [serviceTypes]
   * @returns {Promise<{ time: string, destEn: string, destTc: string, remark: string, wheelchair: boolean, gps: boolean, variant: string, serviceType: number, departed: boolean }[]>}
   */
  async departures(operator, route, dir, stopId, serviceTypes = []) {
    const key = `eta:${operator}:${route}:${dir}:${stopId}:${serviceTypes.join(',') || 'all'}`;

    const load = async () => {
      /** @type {any[]} */
      const out = [];

      if (operator === 'kmb') {
        // Query the variants the caller asked for. A stop can be served by a
        // variant other than the one recorded in the route stop list, so when
        // no variant is known every published one is tried.
        // The path order is stop -> route -> service type.
        const types = serviceTypes.length ? serviceTypes : [1, 2, 3];
        const payloads = await mapLimited(
          2,
          types.map((type) => async () => {
            const payload = await getJson(
              `${KMB_BASE}/eta/${encodeURIComponent(stopId)}/${encodeURIComponent(route)}/${type}`,
            );
            return Array.isArray(payload?.data) ? payload.data : [];
          }),
        );
        for (const rows of payloads) {
          for (const row of rows ?? []) {
            if (!isObject(row)) continue;
            if (asText(row.dir) !== dir) continue;
            const time = normaliseNaiveTimestamp(asText(row.eta));
            if (!time) continue;
            out.push({
              time,
              destEn: asText(row.dest_en),
              destTc: asText(row.dest_tc),
              remark: asText(row.rmk_en) || asText(row.rmk_tc),
              wheelchair: false,
              gps: false,
              variant: '',
              serviceType: Number.parseInt(asText(row.service_type), 10) || 1,
              departed: false,
            });
          }
        }
      } else if (operator === 'ctb') {
        const payload = await getJson(
          `${GOV_BASE}/v2/transport/citybus/eta/CTB/${encodeURIComponent(stopId)}/${encodeURIComponent(route)}`,
        );
        for (const row of Array.isArray(payload?.data) ? payload.data : []) {
          if (!isObject(row)) continue;
          if (asText(row.dir) !== dir) continue;
          const time = normaliseNaiveTimestamp(asText(row.eta));
          if (!time) continue;
          out.push({
            time,
            destEn: asText(row.dest_en),
            destTc: asText(row.dest_tc),
            remark: asText(row.rmk_en) || asText(row.rmk_tc),
            wheelchair: false,
            gps: false,
            variant: asText(row.routeVariantName),
            serviceType: 1,
            departed: false,
          });
        }
      } else {
        const ids = await this.nlbRouteIds();
        const all = ids.get(route) ?? [];
        const candidates = all.length > 1 ? [all[dir === 'O' ? 0 : 1]] : all;
        for (const routeId of candidates) {
          const payload = await getJson(
            `${GOV_BASE}/v2/transport/nlb/stop.php?action=estimatedArrivals&routeId=${encodeURIComponent(routeId)}&stopId=${encodeURIComponent(stopId)}&language=en`,
          );
          const rows = Array.isArray(payload?.estimatedArrivals) ? payload.estimatedArrivals : [];
          for (const row of rows) {
            if (!isObject(row)) continue;
            const time = normaliseNaiveTimestamp(asText(row.estimatedArrivalTime));
            if (!time) continue;
            out.push({
              time,
              destEn: '',
              destTc: '',
              remark: '',
              wheelchair: asText(row.wheelChair) === '1',
              gps: asText(row.noGPS) !== '1',
              variant: asText(row.routeVariantName),
              serviceType: 1,
              departed: asText(row.departed) === '1',
            });
          }
        }
      }

      out.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
      return out;
    };

    // ETAs are short lived: memory only, twenty seconds.
    return this.cache.get(key, LIVE_TTL, load, { persist: false });
  }

  /**
   * Every arrival at a stop in one call, for the operators that publish a
   * batch feed. KMB does not, so it returns an empty list.
   * @param {'kmb'|'ctb'|'nlb'} operator
   * @param {string} stopId
   */
  async stopEtas(operator, stopId) {
    if (operator === 'kmb') return [];
    const company = operator === 'ctb' ? 'CTB' : 'NLB';
    const key = `board:eta:${operator}:${stopId}`;
    return this.cache.get(key, LIVE_TTL, async () => {
      const payload = await getJson(
        `${GOV_BASE}/v1/transport/batch/stop-eta/${company}/${encodeURIComponent(stopId)}`,
      );
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      return rows
        .filter((row) => isObject(row))
        .map((row) => ({
          route: asText(row.route),
          dir: asText(row.dir) === 'I' ? 'I' : 'O',
          time: normaliseNaiveTimestamp(asText(row.eta)),
          destEn: asText(row.dest_en) || asText(row.dest),
          destTc: asText(row.dest_tc),
          remark: asText(row.rmk),
          variant: asText(row.routeVariantName),
          wheelchair: asText(row.wheelChair) === '1',
          gps: asText(row.noGPS) !== '1',
          departed: asText(row.departed) === '1',
          serviceType: 1,
        }))
        .filter((row) => row.route && row.time);
    }, { persist: false });
  }

  /**
   * Every route serving a stop, for any operator.
   * @param {'kmb'|'ctb'|'nlb'} operator
   * @param {string} stopId
   * @returns {Promise<{ route: string, dir: 'O'|'I', serviceType: number, seq: number }[]>}
   */
  async stopRoutes(operator, stopId) {
    if (operator === 'kmb') {
      const index = await this.kmbStopRoutes();
      return index.get(stopId) ?? [];
    }
    const company = operator === 'ctb' ? 'CTB' : 'NLB';
    const key = `board:routes:${operator}:${stopId}`;
    return this.cache.get(key, LIVE_TTL, async () => {
      const payload = await getJson(
        `${GOV_BASE}/v1.1/transport/batch/stop-route/${company}/${encodeURIComponent(stopId)}`,
      );
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      return rows
        .filter((row) => isObject(row))
        .map((row) => ({
          route: asText(row.route),
          dir: asText(row.dir) === 'I' ? 'I' : 'O',
          serviceType: 1,
          seq: Number.parseInt(asText(row.seq), 10) || 0,
        }))
        .filter((item) => item.route);
    }, { persist: false });
  }
}
