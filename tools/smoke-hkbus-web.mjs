// @ts-check

/**
 * Smoke test for the browser build of the HK Bus Finder.
 *
 * Run it with plain Node, no server and no network mocking:
 *
 *   node tools\smoke-hkbus-web.mjs
 *
 * It exercises the real upstream services through the browser modules:
 *
 *   web/hkbus/data/storage.mjs   persistence adapter and its quota fallback
 *   web/hkbus/data/upstream.mjs  upstream data layer
 *   web/hkbus/data/domain.mjs    domain layer
 *   web/hkbus/data/api.mjs       in-browser API surface
 *
 * The browser globals are shimmed before the modules are imported: the
 * storage adapter reads `localStorage` when it is called, not when it is
 * imported, so a shim installed before the dynamic import is enough.
 */

/* ------------------------------------------------------- browser globals */

/** A minimal, working `localStorage` implementation. */
class MemoryStorage {
  constructor() {
    /** @type {Map<string, string>} */
    this.map = new Map();
  }

  get length() {
    return this.map.size;
  }

  /** @param {number} index */
  key(index) {
    return [...this.map.keys()][index] ?? null;
  }

  /** @param {string} key */
  getItem(key) {
    const name = String(key);
    return this.map.has(name) ? /** @type {string} */ (this.map.get(name)) : null;
  }

  /** @param {string} key @param {string} value */
  setItem(key, value) {
    this.map.set(String(key), String(value));
  }

  /** @param {string} key */
  removeItem(key) {
    this.map.delete(String(key));
  }

  clear() {
    this.map.clear();
  }
}

globalThis.localStorage = /** @type {any} */ (new MemoryStorage());

/**
 * The browser build reads the fare table with `fetch`, which Node cannot do
 * for a `file:` URL. The shim answers those requests from disk so the real
 * browser code path is exercised.
 */
const nativeFetch = globalThis.fetch;
globalThis.fetch = /** @type {any} */ (async (input, init) => {
  const url = typeof input === 'string' ? input : /** @type {any} */ (input)?.url ?? String(input);
  if (url.startsWith('file:')) {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const body = await readFile(fileURLToPath(url), 'utf8');
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return nativeFetch(input, init);
});

/* --------------------------------------------------------------- harness */

/** @type {string[]} */
const failures = [];
/** @type {string[]} */
const notes = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

/**
 * A reported value that is interesting but must not fail the run.
 * @param {string} name
 * @param {string} detail
 */
function note(name, detail) {
  console.log(`  note ${name} — ${detail}`);
  notes.push(`${name} — ${detail}`);
}

/** @param {string} name */
function section(name) {
  console.log(`\n${name}`);
}

/** Values the live open data is expected to produce. */
const EXPECTED = {
  counts: { kmb: 799, ctb: 409, nlb: 39 },
  countFloors: { kmb: 700, ctb: 300, nlb: 30 },
  kmbStops: 20,
  ctbStops: 27,
  nlbStops: 56,
  nlbFare: 12.7,
  kmbStopNameEn: 'YUEN LONG (WEST) BUS TERMINUS (YL941)',
  kmbStopNameTc: '元朗（西）總站 (YL941)',
};

const started = Date.now();
const watchdog = setTimeout(() => {
  console.error('\nFAIL smoke test timed out after 300s');
  process.exit(1);
}, 300000);
watchdog.unref?.();

/* --------------------------------------------------------------- modules */

/** The app folder, whether this runs from the workspace or from the repo. */
const APP_DIR = await (async () => {
  const { existsSync } = await import('node:fs');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', 'data'), // repository layout: the app is the repo root
    resolve(here, '..', 'web', 'hkbus', 'data'), // workspace layout
  ];
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'api.mjs'))) return pathToFileURL(candidate).href;
  }
  throw new Error(`could not locate the app data folder from ${here}`);
})();

const { createBrowserStorage } = await import(`${APP_DIR}/storage.mjs`);
const { createDomain } = await import(`${APP_DIR}/domain.mjs`);
const apiModule = await import(`${APP_DIR}/api.mjs`);

const storage = createBrowserStorage();
// The background warm-up is switched off so the smoke test does not start a
// thousand Citybus stop lookups in the background.
const domain = createDomain({ storage, background: false });
apiModule.setDomain(domain);

/* ------------------------------------------------------ storage adapter */

section('storage adapter');
{
  storage.set('probe', { hello: 'world' });
  const read = storage.get('probe');
  check('round trip through localStorage', read && read.hello === 'world', JSON.stringify(read));
  storage.remove('probe');
  check('remove clears the entry', storage.get('probe') === undefined);

  // A quota error must not break the app: the value stays available.
  const original = globalThis.localStorage;
  globalThis.localStorage = /** @type {any} */ ({
    getItem() {
      return null;
    },
    setItem() {
      const error = new Error('quota');
      error.name = 'QuotaExceededError';
      throw error;
    },
    removeItem() {},
  });
  try {
    storage.set('big', { data: 'x'.repeat(64) });
    check('quota error falls back to memory', JSON.stringify(storage.get('big')) === JSON.stringify({ data: 'x'.repeat(64) }));
  } finally {
    globalThis.localStorage = original;
  }
}

/* -------------------------------------------------------------- bootstrap */

section('bootstrap');
const boot = await domain.bootstrap();
console.log(
  `  counts: kmb=${boot.counts.kmb} ctb=${boot.counts.ctb} nlb=${boot.counts.nlb}`,
);
console.log(`  health: ${JSON.stringify(boot.health)}`);
check(
  'route counts are within range',
  boot.counts.kmb >= EXPECTED.countFloors.kmb &&
    boot.counts.ctb >= EXPECTED.countFloors.ctb &&
    boot.counts.nlb >= EXPECTED.countFloors.nlb,
  `kmb=${boot.counts.kmb} ctb=${boot.counts.ctb} nlb=${boot.counts.nlb}`,
);
check(
  'route counts match the expected values',
  Math.abs(boot.counts.kmb - EXPECTED.counts.kmb) <= 10 &&
    Math.abs(boot.counts.ctb - EXPECTED.counts.ctb) <= 10 &&
    Math.abs(boot.counts.nlb - EXPECTED.counts.nlb) <= 5,
  `expected kmb=${EXPECTED.counts.kmb} ctb=${EXPECTED.counts.ctb} nlb=${EXPECTED.counts.nlb}`,
);
check(
  'all three operators are healthy',
  ['kmb', 'ctb', 'nlb'].every((operator) => boot.health[operator]?.ok === true),
  JSON.stringify(boot.health),
);

/* ----------------------------------------------------------- route detail */

section('route detail');
const kmbRoute = await domain.routeDetail('kmb', '968', 'O');
const kmbGroups = Object.keys(kmbRoute.stopGroups);
console.log(`  kmb 968 stop groups: ${kmbGroups.join(', ')} (default ${kmbRoute.defaultServiceType})`);
check('kmb 968 keeps the day and night variants apart', kmbGroups.includes('1') && kmbGroups.includes('2'), kmbGroups.join(','));
const kmbDefault = kmbRoute.stopGroups[kmbRoute.defaultServiceType] ?? [];
console.log(`  kmb 968 default group stops: ${kmbDefault.length}`);
check('kmb 968 default group has at least 20 stops', kmbDefault.length >= EXPECTED.kmbStops, `${kmbDefault.length}`);
const kmbFirst = kmbDefault[0];
check(
  'kmb 968 stop 1 has both English and Chinese names',
  Boolean(kmbFirst?.nameEn) && Boolean(kmbFirst?.nameTc),
  `${kmbFirst?.nameEn} / ${kmbFirst?.nameTc}`,
);
if (kmbFirst?.nameEn === EXPECTED.kmbStopNameEn && kmbFirst?.nameTc === EXPECTED.kmbStopNameTc) {
  console.log('  ok   kmb 968 stop 1 names match the expected values');
} else {
  note(
    'kmb 968 stop 1 names differ from the expected values',
    `got ${kmbFirst?.nameEn} / ${kmbFirst?.nameTc}`,
  );
}
check(
  'kmb 968 night variant is not merged into the day variant',
  (kmbRoute.stopGroups['1']?.length ?? 0) !== (kmbRoute.stopGroups['2']?.length ?? 0) ||
    kmbRoute.stopGroups['1']?.length !== kmbDefault.length,
  `type1=${kmbRoute.stopGroups['1']?.length} type2=${kmbRoute.stopGroups['2']?.length}`,
);

const ctbRoute = await domain.routeDetail('ctb', '12', 'O');
console.log(`  ctb 12 stops: ${ctbRoute.stops.length}`);
check('ctb 12 has at least 27 stops', ctbRoute.stops.length >= EXPECTED.ctbStops, `${ctbRoute.stops.length}`);
check(
  'ctb 12 stop names are resolved',
  Boolean(ctbRoute.stops[0]?.nameEn) && Boolean(ctbRoute.stops[0]?.nameTc),
  `${ctbRoute.stops[0]?.nameEn} / ${ctbRoute.stops[0]?.nameTc}`,
);

const nlbRoute = await domain.routeDetail('nlb', '1', 'O');
console.log(`  nlb 1 stops: ${nlbRoute.stops.length}, fare: ${nlbRoute.fare}`);
check('nlb 1 has a stop list', nlbRoute.stops.length >= 40, `${nlbRoute.stops.length}`);
check('nlb 1 exposes a numeric fare', typeof nlbRoute.fare === 'number', `${nlbRoute.fare}`);
if (nlbRoute.stops.length !== EXPECTED.nlbStops) {
  note('nlb 1 stop count differs from the expected value', `got ${nlbRoute.stops.length}, expected ${EXPECTED.nlbStops}`);
}
if (nlbRoute.fare !== EXPECTED.nlbFare) {
  note('nlb 1 fare differs from the expected value', `got ${nlbRoute.fare}, expected ${EXPECTED.nlbFare}`);
}

/* ----------------------------------------------------------------- fares */

section('fares');
const fareTable = await domain.fareTable();
console.log(`  fare table: ${fareTable.count} entries, generated ${fareTable.generated}`);
check('the fare table was read', fareTable.count > 500, `${fareTable.count} entries`);
check(
  'the fare table names its source',
  fareTable.source.includes('Transport Department'),
  fareTable.source,
);
check('kmb 968 carries the published fare', kmbRoute.fare === 27, `${kmbRoute.fare}`);
check('kmb 968 fare comes from the fare table', kmbRoute.fareSource === 'table', `${kmbRoute.fareSource}`);
check('ctb 12 carries the published fare', ctbRoute.fare === 6.1, `${ctbRoute.fare}`);
check('ctb 12 fare comes from the fare table', ctbRoute.fareSource === 'table', `${ctbRoute.fareSource}`);
check('nlb 1 keeps the fare from its own feed', nlbRoute.fareSource === 'operator', `${nlbRoute.fareSource}`);
check('nlb 1 keeps the holiday fare', typeof nlbRoute.fareHoliday === 'number', `${nlbRoute.fareHoliday}`);

// The same route number can have a different fare for a different operator.
const kmb12 = await domain.routeDetail('kmb', '12', 'O').catch(() => null);
const ctb12 = await domain.routeDetail('ctb', '12', 'O').catch(() => null);
if (kmb12 && ctb12) {
  check(
    'the same route number can have a different fare per operator',
    kmb12.fare !== ctb12.fare,
    `kmb ${kmb12.fare} vs ctb ${ctb12.fare}`,
  );
}

const fareSearch = await domain.searchRoutes('968', 'kmb');
check(
  'route search results carry the fare',
  fareSearch[0]?.fare === 27,
  `${fareSearch[0]?.fare}`,
);

/* ------------------------------------------------------------ directions */

section('directions');
// Citybus publishes one row per route with no direction, so the app has to
// work the directions out from the route-stop endpoints.
const ctbBoth = await domain.routeDetail('ctb', '6', 'O');
check(
  'a Citybus route that runs both ways shows both directions',
  ctbBoth.directions.length === 2,
  ctbBoth.directions.map((item) => item.dir).join(','),
);
check(
  'the Citybus inbound direction names its termini',
  ctbBoth.directions.some((item) => item.dir === 'I' && item.originEn && item.destEn),
  JSON.stringify(ctbBoth.directions.find((item) => item.dir === 'I') ?? {}),
);

const ctbOneWay = await domain.routeDetail('ctb', 'H1', 'O');
check(
  'a Citybus route that only runs one way shows one direction',
  ctbOneWay.directions.length === 1,
  ctbOneWay.directions.map((item) => item.dir).join(','),
);

const ctbInbound = await domain.routeDetail('ctb', '6', 'I');
check(
  'the inbound direction can be asked for directly',
  ctbInbound.dir === 'I' && ctbInbound.stops.length > 0,
  `${ctbInbound.dir}, ${ctbInbound.stops.length} stops`,
);

const kmbBoth = await domain.routeDetail('kmb', '968', 'O');
check(
  'a KMB route that runs both ways keeps both directions',
  kmbBoth.directions.length === 2,
  kmbBoth.directions.map((item) => item.dir).join(','),
);

const kmbOneWay = await domain.routeDetail('kmb', '10', 'O');
check(
  'a KMB route that only runs one way shows one direction',
  kmbOneWay.directions.length === 1,
  kmbOneWay.directions.map((item) => item.dir).join(','),
);

/* ------------------------------------------------------------- departures */

section('departures');
let departureStop = '';
let departureCount = 0;
for (const stop of kmbDefault.slice(0, 6)) {
  const payload = await domain.departures('kmb', '968', 'O', stop.stopId);
  if (payload.departures.length) {
    departureStop = stop.stopId;
    departureCount = payload.departures.length;
    break;
  }
}
console.log(`  kmb 968 departures at ${departureStop}: ${departureCount}`);
check('kmb 968 returns departures at a published stop', departureCount > 0, `${departureCount} at ${departureStop}`);
check(
  'the departures payload reports the live source',
  (await domain.departures('kmb', '968', 'O', departureStop)).source === 'live',
);

/* ------------------------------------------------------------------ board */

section('departure boards');
const ctbBoard = await domain.board('ctb', '001032');
console.log(`  ctb board 001032: ${ctbBoard.routes.length} routes`);
check('ctb board 001032 is not empty', ctbBoard.routes.length > 0, `${ctbBoard.routes.length}`);
check('ctb board knows the stop name', Boolean(ctbBoard.stopNameEn), ctbBoard.stopNameEn);

const kmbBoard = await domain.board('kmb', '25D811895B82ABCA');
console.log(`  kmb board 25D811895B82ABCA: ${kmbBoard.routes.length} routes`);
check('kmb board 25D811895B82ABCA is not empty', kmbBoard.routes.length > 0, `${kmbBoard.routes.length}`);

const nlbBoard = await domain.board('nlb', '55');
console.log(`  nlb board 55: ${nlbBoard.routes.length} routes`);
check('nlb board 55 is not empty', nlbBoard.routes.length > 0, `${nlbBoard.routes.length}`);

const ctbFareRows = ctbBoard.routes.filter((row) => typeof row.fare === 'number');
check(
  'departure board rows carry the fare',
  ctbFareRows.length > 0,
  `${ctbFareRows.length} of ${ctbBoard.routes.length} rows`,
);

/* ----------------------------------------------------------------- search */

section('search');
const stopResults = await domain.searchStops('Tai O', 'nlb');
console.log(`  searchStops('Tai O','nlb'): ${stopResults.length} results`);
check('searchStops finds Tai O', stopResults.length >= 1, `${stopResults.length}`);
check(
  'the found stop carries a name',
  Boolean(stopResults[0]?.nameEn) && Boolean(stopResults[0]?.nameTc),
  `${stopResults[0]?.nameEn} / ${stopResults[0]?.nameTc}`,
);

const routeResults = await domain.searchRoutes('968', '');
console.log(`  searchRoutes('968'): ${routeResults.length} results`);
check('searchRoutes finds 968', routeResults.length >= 1, `${routeResults.length}`);
check(
  'the found route is ranked first',
  routeResults[0]?.route === '968' && routeResults[0]?.score === 100,
  `${routeResults[0]?.operator} ${routeResults[0]?.route} score ${routeResults[0]?.score}`,
);

/* ------------------------------------------------------------- favourites */

section('favourites');
const before = await domain.listFavourites();
const added = await domain.addFavourite({
  type: 'route',
  operator: 'kmb',
  key: '968',
  label: 'KMB 968',
  subtitle: 'Yuen Long to Tin Hau',
});
const addedId = added[0]?.id;
console.log(`  added favourite: ${addedId}`);
check('the favourite id uses the type:operator:key format', addedId === 'route:kmb:968', `${addedId}`);
check('the favourite is stored', added.length === before.length + 1, `${before.length} -> ${added.length}`);
const listed = await domain.listFavourites();
check('listFavourites returns the favourite', listed.some((item) => item.id === addedId), `${listed.length} items`);
const removed = await domain.removeFavourite(/** @type {string} */ (addedId));
check('removeFavourite takes the favourite out', !removed.some((item) => item.id === addedId), `${removed.length} items`);
check(
  'the favourite list is back to its original length',
  (await domain.listFavourites()).length === before.length,
);

/* ------------------------------------------------------------------- api */

section('api surface');
const apiBootstrap = await apiModule.api('/api/bootstrap');
console.log(
  `  api('/api/bootstrap') counts: kmb=${apiBootstrap.counts.kmb} ctb=${apiBootstrap.counts.ctb} nlb=${apiBootstrap.counts.nlb}`,
);
check(
  'api bootstrap returns the same counts',
  apiBootstrap.counts.kmb === boot.counts.kmb &&
    apiBootstrap.counts.ctb === boot.counts.ctb &&
    apiBootstrap.counts.nlb === boot.counts.nlb,
);
const apiRoute = await apiModule.api('/api/routes/kmb/968?dir=O');
check(
  'api route detail returns the route payload',
  apiRoute?.route === '968' && apiRoute?.stopGroups !== null && typeof apiRoute?.stopGroups === 'object',
  `route ${apiRoute?.route}`,
);
check('api route detail keeps the service variants apart', Object.keys(apiRoute.stopGroups ?? {}).length >= 2, Object.keys(apiRoute.stopGroups ?? {}).join(','));
const apiSearch = await apiModule.api('/api/search/routes?q=968');
check('api search returns results and a timestamp', Array.isArray(apiSearch.results) && typeof apiSearch.now === 'string', `${apiSearch.results?.length} results`);
const apiStops = await apiModule.api('/api/search/stops?q=Tai%20O&operator=nlb');
check('api stop search returns results and a timestamp', Array.isArray(apiStops.results) && typeof apiStops.now === 'string', `${apiStops.results?.length} results`);
const apiDepartures = await apiModule.api(
  `/api/departures?operator=kmb&route=968&dir=O&stop=${encodeURIComponent(departureStop)}`,
);
check('api departures returns a departure list', Array.isArray(apiDepartures.departures), `${apiDepartures.departures?.length} departures`);
const apiBoard = await apiModule.api('/api/board/ctb/001032');
check('api board returns routes', Array.isArray(apiBoard.routes) && apiBoard.routes.length > 0, `${apiBoard.routes?.length} routes`);

const apiFavourites = await apiModule.api('/api/favourites');
check('api favourites returns an item list', Array.isArray(apiFavourites.items));
const posted = await apiModule.api('/api/favourites', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'route', operator: 'kmb', key: '968', label: 'KMB 968' }),
});
check('api favourites post returns the item list', posted.items?.some((item) => item.id === 'route:kmb:968'), `${posted.items?.length} items`);
const deleted = await apiModule.api(`/api/favourites/${encodeURIComponent('route:kmb:968')}`, { method: 'DELETE' });
check('api favourites delete removes the item', !deleted.items?.some((item) => item.id === 'route:kmb:968'), `${deleted.items?.length} items`);

try {
  await apiModule.api('/api/routes/kmb/NOTAPUBLISHEDROUTE');
  check('a missing route fails with a 404', false, 'no error was thrown');
} catch (error) {
  const status = /** @type {any} */ (error).status;
  const message = /** @type {Error} */ (error).message;
  check('a missing route fails with a 404', status === 404 && message.includes('not published'), `status ${status}: ${message}`);
}

try {
  await apiModule.api('/api/departures?operator=kmb&route=968&dir=O');
  check('a missing stop fails with a 400', false, 'no error was thrown');
} catch (error) {
  const status = /** @type {any} */ (error).status;
  const message = /** @type {Error} */ (error).message;
  check('a missing stop fails with a 400', status === 400 && message.length > 0, `status ${status}: ${message}`);
}

try {
  await apiModule.api('/api/nothing-here');
  check('an unknown route fails with a 404', false, 'no error was thrown');
} catch (error) {
  const status = /** @type {any} */ (error).status;
  const message = /** @type {Error} */ (error).message;
  check('an unknown route fails with a 404', status === 404 && message === 'Request failed (404)', `status ${status}: ${message}`);
}

/* ----------------------------------------------------------------- report */

clearTimeout(watchdog);
const seconds = Math.round((Date.now() - started) / 1000);
console.log(`\n${failures.length ? `FAILED (${failures.length})` : 'passed'} in ${seconds}s`);
if (notes.length) {
  console.log('notes:');
  for (const line of notes) console.log(`  - ${line}`);
}
if (failures.length) {
  console.log('\nfailures:');
  for (const line of failures) console.log(`  - ${line}`);
  process.exit(1);
}
console.log('\nALL OK');
process.exit(0);
