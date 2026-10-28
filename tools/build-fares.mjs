/* Builds the bus fare table used by the app.
 *
 * The Transport Department publishes "Routes and fares of public transport"
 * as an Access database (ROUTE_BUS.mdb). Its ROUTE table carries the full
 * fare for every bus route, together with the operator, the service mode and
 * the journey the fare applies to.
 *
 * A route appears once per service it runs. Most routes publish one row for
 * the whole route (SERVICE_MODE = R, SPECIAL_TYPE = 0) and one row per
 * additional specific service, such as a short working that starts or ends
 * somewhere else. The app shows one fare per route: the whole-route fare.
 * So the row to keep is the whole-route row, or, when a route publishes only
 * specific services, the row with the longest journey time, which is the
 * fare for the longest distance the route actually covers.
 *
 * Part-fare pricing for a shorter ride is deliberately not computed: the
 * table's rows describe a journey between two named places, and the app
 * shows the fare for the whole route.
 *
 * The database is read once, here, and the result is written as a small JSON
 * file that ships with the app. Doing the MDB parsing at build time keeps the
 * runtime free of a database driver, and it is the same file for the desktop
 * Mini App and the browser build.
 *
 * Usage:
 *   npm install mdb-reader
 *   node tools/build-fares.mjs <path-to-ROUTE_BUS.mdb> [output-file]
 *
 * The operator feeds (KMB, Citybus) do not publish fares themselves, so this
 * is the only official source for them. Lantau is left out on purpose: the
 * Lantau feed publishes both the ordinary and the holiday fare per stop, and
 * the Transport Department table stores the holiday figure for those routes.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const mdbPath = process.argv[2];
const outPath = process.argv[3] ?? new URL('../web/hkbus/data/fares.json', import.meta.url);

if (!mdbPath) {
  console.error('usage: node tools/build-fares.mjs <ROUTE_BUS.mdb> [output.json]');
  process.exit(1);
}

const MDBReader = await (async () => {
  // A normal `npm install mdb-reader` is the normal path. MDB_READER lets a
  // one-off install elsewhere be used without touching this project.
  const explicit = process.env.MDB_READER;
  if (explicit) {
    const mod = await import(pathToFileURL(explicit).href);
    return mod.default;
  }
  try {
    return await import('mdb-reader');
  } catch {
    console.error('mdb-reader is not installed. Run: npm install mdb-reader');
    process.exit(1);
  }
})();

/**
 * The operator groups the app uses, and the company codes that feed them.
 * A company code can list several operators for a jointly operated route,
 * for example KMB+CTB, and that route is then published by both.
 */
const COMPANY_OPERATORS = new Map([
  ['KMB', ['kmb']],
  ['LWB', ['kmb']],
  ['CTB', ['ctb']],
]);

const rows = new MDBReader(readFileSync(mdbPath)).getTable('ROUTE').getData();

/**
 * @typedef {{
 *   fare: number,
 *   journeyTime: number,
 *   wholeRoute: boolean,
 *   from: string,
 *   to: string,
 * }} RouteRow
 */

/** @type {Map<string, RouteRow[]>} */
const table = new Map();
let skipped = 0;

for (const row of rows) {
  const name = String(row.ROUTE_NAMEE ?? '').trim();
  const fare = Number.parseFloat(String(row.FULL_FARE ?? ''));
  if (!name || !Number.isFinite(fare)) {
    skipped += 1;
    continue;
  }

  const company = String(row.COMPANY_CODE ?? '').trim();
  const operators = new Set();
  for (const part of company.split('+')) {
    for (const operator of COMPANY_OPERATORS.get(part.trim()) ?? []) operators.add(operator);
  }
  if (!operators.size) {
    skipped += 1;
    continue;
  }

  const serviceMode = String(row.SERVICE_MODE ?? '').trim();
  const specialType = Number.parseInt(String(row.SPECIAL_TYPE ?? ''), 10);
  const journeyTime = Number.parseInt(String(row.JOURNEY_TIME ?? ''), 10);
  const entry = {
    fare,
    journeyTime: Number.isFinite(journeyTime) ? journeyTime : 0,
    wholeRoute: serviceMode === 'R' && (specialType === 0 || !Number.isFinite(specialType)),
    from: String(row.LOC_START_NAMEE ?? ''),
    to: String(row.LOC_END_NAMEE ?? ''),
  };

  for (const operator of operators) {
    const key = `${operator}|${name}`;
    const list = table.get(key);
    if (list) list.push(entry);
    else table.set(key, [entry]);
  }
}

/**
 * The fare shown for a route: the whole-route row when the route publishes
 * one, otherwise the longest journey the route runs.
 *
 * @param {RouteRow[]} list
 */
function wholeRouteFare(list) {
  const whole = list.filter((row) => row.wholeRoute);
  if (whole.length) {
    // A route can publish more than one whole-route row when the fare is
    // the same for both of its directions. They agree, so take the first.
    return whole[0];
  }
  let best = list[0];
  for (const row of list) if (row.journeyTime > best.journeyTime) best = row;
  return best;
}

/** @type {Record<string, number>} */
const fares = {};
let multiFare = 0;
let noWholeRoute = 0;

for (const [key, list] of table) {
  const chosen = wholeRouteFare(list);
  fares[key] = chosen.fare;
  if (list.length > 1) multiFare += 1;
  if (!list.some((row) => row.wholeRoute)) noWholeRoute += 1;
}

const payload = {
  source: 'Transport Department — Routes and fares of public transport (ROUTE_BUS)',
  sourceUrl: 'https://data.gov.hk/en-data/dataset/hk-td-tis_3-routes-and-fares-of-public-transport',
  note: 'Full adult fare for the whole route, in Hong Kong dollars. A shorter ride may cost less.',
  generated: new Date().toISOString(),
  fares,
};

writeFileSync(outPath, `${JSON.stringify(payload)}\n`);

const bytes = Buffer.byteLength(JSON.stringify(payload));
console.log(`routes in source : ${rows.length}`);
console.log(`written          : ${Object.keys(fares).length} fare entries (${bytes / 1024} KB)`);
console.log(`multi-fare routes: ${multiFare} (${noWholeRoute} without a whole-route row)`);
console.log(`skipped          : ${skipped} rows (other operators)`);
console.log(`output           : ${outPath}`);
for (const operator of ['kmb', 'ctb']) {
  const count = Object.keys(fares).filter((key) => key.startsWith(`${operator}|`)).length;
  console.log(`  ${operator.padEnd(4)} : ${count} routes`);
}
console.log('samples:', JSON.stringify({
  'kmb|968': fares['kmb|968'],
  'kmb|960': fares['kmb|960'],
  'kmb|12': fares['kmb|12'],
  'ctb|12': fares['ctb|12'],
  'ctb|970': fares['ctb|970'],
  'ctb|101': fares['ctb|101'],
  'ctb|116': fares['ctb|116'],
}));
