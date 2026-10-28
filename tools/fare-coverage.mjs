/* Measures how much of the published route index has a published fare.
 *
 * The Transport Department fare table is a snapshot and the operator feeds
 * are live, so a few routes have no fare: a route can be newer than the fare
 * table, or the two can spell a route number differently. This reports the
 * gap so it is a known number rather than a surprise.
 *
 * Usage: node tools/fare-coverage.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The app folder, whether this runs from the workspace or from the repo. */
const APP_DIR = await (async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', 'data'), // repository layout: the app is the repo root
    resolve(here, '..', 'web', 'hkbus', 'data'), // workspace layout
  ];
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'api.mjs'))) return candidate;
  }
  throw new Error(`could not locate the app data folder from ${here}`);
})();

const { createDomain } = await import(pathToFileURL(resolve(APP_DIR, 'domain.mjs')).href);
const fares = JSON.parse(readFileSync(resolve(APP_DIR, 'fares.json'), 'utf8'));
const domain = createDomain({ background: false });
const index = await domain.upstream.routeIndex();

/** @type {{ operator: string, route: string }[]} */
const missing = [];
const totals = { kmb: 0, ctb: 0, nlb: 0 };
const covered = { kmb: 0, ctb: 0, nlb: 0 };
/** @type {Map<string, string[]>} */
const extra = new Map();

for (const entry of index.values()) {
  totals[entry.operator] = (totals[entry.operator] ?? 0) + 1;
  const hasFare = entry.operator === 'nlb' ? true : Boolean(fares.fares[`${entry.operator}|${entry.route}`]);
  if (hasFare) covered[entry.operator] = (covered[entry.operator] ?? 0) + 1;
  else missing.push({ operator: entry.operator, route: entry.route });
}

// Fares in the table that no published route matches.
for (const key of Object.keys(fares.fares)) {
  const [operator, route] = key.split('|');
  if (!index.get(`${operator}:${route}`)) {
    const list = extra.get(operator) ?? [];
    list.push(route);
    extra.set(operator, list);
  }
}

console.log('operator   routes   with fare   without');
for (const operator of ['kmb', 'ctb', 'nlb']) {
  console.log(
    `${operator.padEnd(10)} ${String(totals[operator]).padStart(6)} ${String(covered[operator]).padStart(10)} ${String(totals[operator] - covered[operator]).padStart(8)}`,
  );
}

const kmbTotal = totals.kmb + totals.ctb;
const kmbCovered = covered.kmb + covered.ctb;
console.log(
  `\nKMB and Citybus: ${kmbCovered}/${kmbTotal} routes have a published fare (${((kmbCovered / kmbTotal) * 100).toFixed(1)}%)`,
);

if (missing.length) {
  console.log(`\n${missing.length} routes without a fare:`);
  for (const item of missing.slice(0, 60)) console.log(`  ${item.operator} ${item.route}`);
  if (missing.length > 60) console.log(`  ... and ${missing.length - 60} more`);
}

for (const [operator, routes] of extra) {
  console.log(`\n${routes.length} ${operator} fares in the table match no published route:`);
  console.log(`  ${routes.slice(0, 40).join(', ')}${routes.length > 40 ? ` ... and ${routes.length - 40} more` : ''}`);
}
