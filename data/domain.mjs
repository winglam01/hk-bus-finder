// @ts-check

/**
 * Domain service for the browser build of the HK Bus Finder.
 *
 * Every read goes through this service so the upstream shapes stay in one
 * place and durable state (the favourites and the static upstream
 * collections) lives in the browser storage adapter.
 *
 * The public method names and the returned shapes are identical to the Node
 * build, so the existing client can be reused without change.
 */

import { OPERATORS, Upstream, mapLimited } from './upstream.mjs';
import { createBrowserStorage } from './storage.mjs';

const FAVOURITES_KEY = 'favourites';
const MAX_RESULTS = 80;

/** Routes highlighted on the landing screen when they exist for an operator. */
const FEATURED_NUMBERS = ['968', '960', '970', '1', '73', '307', '11', '23', '507', '701', 'X11R'];

export class NotFoundError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

export class ValidationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

/** @param {unknown} value @param {number} max */
function clampText(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

/** @param {unknown} value */
function normaliseQuery(value) {
  return clampText(value, 120).toLowerCase();
}

/**
 * Minutes from now until an ISO timestamp, or null when it cannot be read.
 * @param {string} time
 * @param {number} now
 */
function minutesUntil(time, now) {
  const at = Date.parse(time);
  return Number.isFinite(at) ? Math.round((at - now) / 60000) : null;
}

/**
 * @typedef {ReturnType<typeof createBrowserStorage>} BrowserStorage
 * @typedef {{ storage?: BrowserStorage | null, background?: boolean }} DomainContext
 */

/**
 * Build the domain service.
 *
 * @param {DomainContext} [context]
 */
export function createDomain(context = {}) {
  const storage = context.storage ?? createBrowserStorage();
  // The background warm-up is on by default so the first departure board is
  // fast. A test harness can switch it off.
  const background = context.background !== false;

  const upstream = new Upstream(storage);

  /** @type {any[]} */
  let favourites = [];
  /** @type {Promise<void>} */
  const favouritesReady = loadFavourites();

  async function loadFavourites() {
    try {
      const parsed = storage.get(FAVOURITES_KEY);
      favourites = Array.isArray(parsed?.items) ? parsed.items : [];
    } catch {
      favourites = [];
    }
  }

  async function persistFavourites() {
    try {
      storage.set(FAVOURITES_KEY, { version: 1, items: favourites });
    } catch {
      // Storage must never break the app.
    }
  }

  // ------------------------------------------------------------ catalogue

  /**
   * Citybus publishes no usable stop list, so one is assembled in the
   * background from the per-route stop lists. It is resumable and reports
   * progress so the UI can say how complete the search index is.
   */
  const catalogue = {
    status: 'idle',
    total: 0,
    resolved: 0,
    startedAt: 0,
    error: '',
  };

  /** @type {Promise<void> | null} */
  let catalogueTask = null;
  const CATALOGUE_BUDGET_MS = 4 * 60 * 1000;

  async function buildCatalogue() {
    if (catalogueTask) return catalogueTask;
    catalogueTask = (async () => {
      catalogue.status = 'running';
      catalogue.startedAt = Date.now();
      catalogue.error = '';
      try {
        const index = await upstream.routeIndex();
        const routes = [...index.values()].filter((entry) => entry.operator === 'ctb');
        const stopIds = new Set();
        const deadline = Date.now() + CATALOGUE_BUDGET_MS;

        for (let offset = 0; offset < routes.length; offset += 40) {
          if (Date.now() > deadline) break;
          const batch = routes.slice(offset, offset + 40);
          const collected = await mapLimited(6, batch.map((entry) => async () => {
            try {
              return await upstream.routeStops('ctb', entry.route, 'O', []);
            } catch {
              // A single failing route must not abort the whole catalogue.
              return [];
            }
          }));
          for (const stops of collected) {
            for (const stop of stops ?? []) stopIds.add(stop.stopId);
          }
        }

        catalogue.total = stopIds.size;
        catalogue.resolved = 0;
        const ids = [...stopIds];
        const window = ids.slice(0, 1200);
        const resolved = await mapLimited(6, window.map((id) => async () => {
          const stop = await upstream.stop('ctb', id);
          return stop ? { id, stop } : undefined;
        }));
        for (const item of resolved) {
          if (item) catalogue.resolved += 1;
        }
        catalogue.status = catalogue.resolved >= catalogue.total ? 'complete' : 'partial';
      } catch (error) {
        catalogue.status = 'failed';
        catalogue.error = error instanceof Error ? error.message : String(error);
      } finally {
        catalogueTask = null;
      }
    })();
    return catalogueTask;
  }

  // --------------------------------------------------------------- search

  /**
   * Search routes by number or by origin/destination.
   * @param {string} query
   * @param {string} operator
   */
  async function searchRoutes(query, operator) {
    const q = normaliseQuery(query);
    const index = await upstream.routeIndex();
    const only = OPERATORS[operator] ? operator : '';

    /** @type {any[]} */
    const results = [];
    for (const entry of index.values()) {
      if (only && entry.operator !== only) continue;
      for (const [dir, direction] of entry.directions) {
        const routeLc = entry.route.toLowerCase();
        let score = -1;
        if (!q) score = 0;
        else if (routeLc === q) score = 100;
        else if (routeLc.startsWith(q)) score = 80;
        else if (routeLc.includes(q)) score = 60;
        else {
          const haystack = [
            direction.originEn,
            direction.originTc,
            direction.destEn,
            direction.destTc,
          ]
            .join(' ')
            .toLowerCase();
          if (haystack.includes(q)) score = 40;
        }
        if (score < 0) continue;
        results.push({
          score,
          operator: entry.operator,
          route: entry.route,
          dir,
          originEn: direction.originEn,
          originTc: direction.originTc,
          destEn: direction.destEn,
          destTc: direction.destTc,
          serviceTypes: direction.serviceTypes,
        });
      }
    }

    results.sort((a, b) => b.score - a.score || a.operator.localeCompare(b.operator) || a.route.localeCompare(b.route));
    return results.slice(0, MAX_RESULTS);
  }

  /**
   * Search stops by name across every operator that has a name available.
   * @param {string} query
   * @param {string} operator
   */
  async function searchStops(query, operator) {
    const q = normaliseQuery(query);
    if (!q) return [];
    const only = OPERATORS[operator] ? operator : '';

    // Citybus publishes no stop list, so its names only exist once the
    // catalogue has been built. Nothing is harvested until a stop is actually
    // searched for: on a phone that is the difference between one request and
    // sixteen hundred.
    if (!only || only === 'ctb') {
      if (catalogue.status === 'idle') void buildCatalogue();
    }

    /** @type {Map<string, [string, { nameEn: string, nameTc: string, lat: number, long: number }][]>} */
    const catalogues = new Map();
    catalogues.set('kmb', [...(await upstream.kmbStops().catch(() => new Map())).entries()]);
    catalogues.set('nlb', [...(await upstream.nlbStops().catch(() => new Map())).entries()]);
    catalogues.set('ctb', [...upstream.knownCitybusStops().entries()]);

    /** @type {any[]} */
    const results = [];
    for (const [op, stops] of catalogues) {
      if (only && op !== only) continue;
      for (const [stopId, stop] of stops) {
        const haystack = `${stop.nameEn} ${stop.nameTc}`.toLowerCase();
        if (!haystack.includes(q)) continue;
        results.push({ operator: op, stopId, ...stop });
      }
    }
    results.sort((a, b) => a.nameEn.localeCompare(b.nameEn));
    return results.slice(0, 50);
  }

  // ---------------------------------------------------------- route detail

  /**
   * @param {string} operator
   * @param {string} route
   * @param {string} dir
   */
  async function routeDetail(operator, route, dir) {
    if (!OPERATORS[operator]) throw new ValidationError('unknown operator');
    const routeNo = clampText(route, 16).toUpperCase();
    if (!routeNo) throw new ValidationError('route number is required');

    const index = await upstream.routeIndex();
    const entry = index.get(`${operator}:${routeNo}`);
    if (!entry) throw new NotFoundError(`route ${routeNo} is not published by ${OPERATORS[operator].name}`);

    const directions = [...entry.directions.entries()].map(([key, value]) => ({
      dir: key,
      originEn: value.originEn,
      originTc: value.originTc,
      destEn: value.destEn,
      destTc: value.destTc,
      serviceTypes: value.serviceTypes.length ? value.serviceTypes : [1],
    }));

    const wanted = directions.some((item) => item.dir === dir) ? dir : directions[0].dir;
    const direction = directions.find((item) => item.dir === wanted) ?? directions[0];

    const groups = await upstream.routeStopsByServiceType(operator, routeNo, wanted, direction.serviceTypes);

    /** @type {Record<string, any[]>} */
    const stopGroups = {};
    for (const [type, list] of Object.entries(groups)) {
      stopGroups[type] = list;
    }
    const groupKeys = Object.keys(stopGroups).sort((a, b) => Number(a) - Number(b));
    // Prefer the lowest published variant: type 1 is the daytime service,
    // which is the one running for most of the day.
    const defaultType = groupKeys.find((key) => stopGroups[key].length > 0) ?? groupKeys[0];

    const stops = stopGroups[defaultType] ?? [];
    const first = stops[0];
    const last = stops[stops.length - 1];

    return {
      operator,
      operatorName: OPERATORS[operator].name,
      operatorNameTc: OPERATORS[operator].nameTc,
      route: routeNo,
      dir: wanted,
      directions,
      serviceTypes: direction.serviceTypes,
      stopGroups,
      defaultServiceType: defaultType,
      stops,
      originEn: first?.nameEn || direction.originEn,
      originTc: first?.nameTc || direction.originTc,
      destEn: last?.nameEn || direction.destEn,
      destTc: last?.nameTc || direction.destTc,
      fare: first?.fare ?? null,
      fareHoliday: first?.fareHoliday ?? null,
      stopCount: stops.length,
      generatedAt: new Date().toISOString(),
    };
  }

  // ------------------------------------------------------------ departures

  /**
   * Next departures for one route direction at one stop, plus a short
   * service summary derived from the live feed.
   * @param {string} operator
   * @param {string} route
   * @param {string} dir
   * @param {string} stopId
   */
  async function departures(operator, route, dir, stopId) {
    if (!OPERATORS[operator]) throw new ValidationError('unknown operator');
    const routeNo = clampText(route, 16).toUpperCase();
    const stop = clampText(stopId, 32);
    if (!routeNo || !stop) throw new ValidationError('route and stop are required');

    const index = await upstream.routeIndex();
    const entry = index.get(`${operator}:${routeNo}`);
    const direction = entry?.directions.get(dir);
    const serviceTypes = direction?.serviceTypes?.length ? direction.serviceTypes : [1];

    const rows = await upstream.departures(operator, routeNo, dir === 'I' ? 'I' : 'O', stop, serviceTypes);
    const now = Date.now();
    const items = rows
      .map((row) => {
        const at = Date.parse(row.time);
        return {
          ...row,
          minutes: Number.isFinite(at) ? Math.round((at - now) / 60000) : null,
          departed: row.departed || (Number.isFinite(at) && at < now - 5 * 60000),
        };
      })
      .filter((row) => row.minutes !== null && row.minutes >= -2 && row.minutes <= 180);

    // Median gap between consecutive departures describes the service pattern.
    const gaps = [];
    for (let i = 1; i < items.length; i += 1) {
      const gap = items[i].minutes - items[i - 1].minutes;
      if (gap > 0 && gap < 120) gaps.push(gap);
    }
    gaps.sort((a, b) => a - b);
    const headway = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;

    return {
      operator,
      route: routeNo,
      dir: dir === 'I' ? 'I' : 'O',
      stopId: stop,
      serviceTypes,
      headwayMinutes: headway,
      departures: items,
      now: new Date().toISOString(),
      source: operator === 'nlb' ? 'timetable' : 'live',
    };
  }

  /**
   * Every route serving a stop, with the next departures for each.
   * @param {string} operator
   * @param {string} stopId
   */
  async function board(operator, stopId) {
    if (!OPERATORS[operator]) throw new ValidationError('unknown operator');
    const stop = clampText(stopId, 32);
    if (!stop) throw new ValidationError('stop id is required');

    const stopInfo = await upstream.stop(operator, stop);
    const routes = await upstream.stopRoutes(operator, stop);

    /** @type {Map<string, { route: string, dir: 'O'|'I', serviceTypes: number[] }>} */
    const groups = new Map();
    for (const item of routes) {
      const key = `${item.route}:${item.dir}`;
      const existing = groups.get(key);
      if (existing) {
        if (!existing.serviceTypes.includes(item.serviceType)) existing.serviceTypes.push(item.serviceType);
      } else {
        groups.set(key, { route: item.route, dir: item.dir, serviceTypes: [item.serviceType] });
      }
    }

    const now = Date.now();

    /** @type {any[]} */
    let rows = [];

    if (operator === 'kmb') {
      // KMB publishes no batch arrival feed, so each route is queried.
      const list = [...groups.values()].slice(0, 24);
      rows = await mapLimited(6, list.map((group) => async () => {
        try {
          const departures = await upstream.departures(operator, group.route, group.dir, stop, group.serviceTypes);
          return { ...group, departures: departures.map((row) => ({ ...row, minutes: minutesUntil(row.time, now) })) };
        } catch {
          return { ...group, departures: [], failed: true };
        }
      }));
      rows = rows.filter(Boolean);
    } else {
      // One batch call covers every route serving the stop.
      const batch = await upstream.stopEtas(operator, stop);
      /** @type {Map<string, any>} */
      const byKey = new Map();
      for (const group of groups.values()) {
        byKey.set(`${group.route}:${group.dir}`, { ...group, departures: [] });
      }
      for (const row of batch) {
        const key = operator === 'nlb'
          ? `${row.route}:${row.variant}`
          : `${row.route}:${row.dir}`;
        let entry = byKey.get(key);
        if (!entry) {
          entry = { route: row.route, dir: row.dir, serviceTypes: [row.serviceType], departures: [] };
          byKey.set(key, entry);
        }
        entry.departures.push({ ...row, minutes: minutesUntil(row.time, now) });
      }
      rows = [...byKey.values()];
      for (const row of rows) {
        row.departures = row.departures
          .filter((row) => row.minutes !== null && row.minutes >= -2 && row.minutes <= 180)
          .sort((a, b) => a.minutes - b.minutes);
      }
    }

    const result = rows
      .filter((row) => row && Array.isArray(row.departures))
      .map((row) => ({
        operator,
        route: row.route,
        dir: row.dir,
        serviceTypes: row.serviceTypes,
        departures: row.departures,
        next: row.departures[0]?.minutes ?? null,
      }))
      .sort((a, b) => {
        if (a.next === null) return 1;
        if (b.next === null) return -1;
        return a.next - b.next;
      });

    return {
      operator,
      operatorName: OPERATORS[operator].name,
      stopId: stop,
      stopNameEn: stopInfo?.nameEn ?? '',
      stopNameTc: stopInfo?.nameTc ?? '',
      lat: stopInfo?.lat ?? 0,
      long: stopInfo?.long ?? 0,
      routes: result,
      now: new Date().toISOString(),
    };
  }

  // --------------------------------------------------------------- extras

  async function featured() {
    const index = await upstream.routeIndex();
    /** @type {any[]} */
    const picks = [];
    for (const operator of ['kmb', 'ctb', 'nlb']) {
      const entries = [...index.values()].filter((entry) => entry.operator === operator);
      for (const number of FEATURED_NUMBERS) {
        const entry = entries.find((item) => item.route === number);
        if (!entry) continue;
        const direction = entry.directions.get('O') ?? [...entry.directions.values()][0];
        picks.push({
          operator,
          route: entry.route,
          dir: 'O',
          originEn: direction.originEn,
          originTc: direction.originTc,
          destEn: direction.destEn,
          destTc: direction.destTc,
        });
        if (picks.filter((pick) => pick.operator === operator).length >= 4) break;
      }
    }
    return picks;
  }

  async function bootstrap() {
    await favouritesReady;
    const index = await upstream.routeIndex();
    const counts = { kmb: 0, ctb: 0, nlb: 0 };
    for (const entry of index.values()) counts[entry.operator] = (counts[entry.operator] ?? 0) + 1;

    if (background) {
      // Nothing is warmed up here. The large collections cost megabytes and
      // the Citybus stop catalogue costs well over a thousand requests, so on
      // a phone they are fetched when something actually needs them rather
      // than on every page load.
    }

    return {
      operators: Object.values(OPERATORS).map((operator) => ({
        id: operator.id,
        name: operator.name,
        nameTc: operator.nameTc,
        full: operator.full,
      })),
      counts,
      featured: await featured(),
      health: upstream.health,
      catalogue: { ...catalogue },
      favourites: favourites.slice(),
      now: new Date().toISOString(),
      sources: [
        { label: 'KMB / Long Win', url: 'https://data.etabus.gov.hk/' },
        { label: 'Citybus', url: 'https://data.gov.hk/en-data/dataset/ctb-eta-transport-realtime-eta' },
        { label: 'Lantau Bus', url: 'https://www.nlb.com.hk/datagovhk/BusServiceOpenAPIDocumentation2.0.pdf' },
      ],
    };
  }

  // ----------------------------------------------------------- favourites

  async function listFavourites() {
    await favouritesReady;
    return favourites.slice();
  }

  /**
   * @param {{ type?: string, operator?: string, key?: string, label?: string, subtitle?: string }} body
   */
  async function addFavourite(body) {
    await favouritesReady;
    const type = body.type === 'stop' ? 'stop' : 'route';
    const operator = OPERATORS[body.operator ?? ''] ? body.operator : '';
    const key = clampText(body.key, 64);
    const label = clampText(body.label, 120);
    if (!operator || !key || !label) throw new ValidationError('operator, key and label are required');

    const id = `${type}:${operator}:${key}`;
    if (!favourites.some((item) => item.id === id)) {
      favourites = [
        { id, type, operator, key, label, subtitle: clampText(body.subtitle, 160), createdAt: new Date().toISOString() },
        ...favourites,
      ];
      await persistFavourites();
    }
    return favourites;
  }

  /** @param {string} id */
  async function removeFavourite(id) {
    await favouritesReady;
    const target = clampText(id, 120);
    favourites = favourites.filter((item) => item.id !== target);
    await persistFavourites();
    return favourites;
  }

  return {
    upstream,
    bootstrap,
    searchRoutes,
    searchStops,
    routeDetail,
    departures,
    board,
    listFavourites,
    addFavourite,
    removeFavourite,
    catalogue,
    buildCatalogue,
  };
}

export default createDomain;
