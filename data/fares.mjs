// @ts-check

/**
 * The bus fare table.
 *
 * The operator feeds publish no fares for KMB or Citybus, so the fares come
 * from the Transport Department open data set "Routes and fares of public
 * transport". That database is parsed once at build time by
 * tools/build-fares.mjs and ships as a small JSON file next to this module,
 * so no database driver is needed at runtime.
 *
 * The table holds the whole-route adult fare for every route the Transport
 * Department publishes. A shorter ride may cost less; that is not worked out
 * here.
 *
 * Lantau keeps the fares published by its own feed, which also carries the
 * holiday fare, so it is not looked up here.
 */

/**
 * @typedef {{
 *   source: string,
 *   sourceUrl: string,
 *   note: string,
 *   generated: string,
 *   count: number,
 *   fare: (operator: string, route: string) => number | null,
 * }} FareTable
 */

/**
 * Read and parse the fare table.
 *
 * @param {() => Promise<string>} readText reads the raw JSON
 * @returns {Promise<FareTable>}
 */
export async function loadFareTable(readText) {
  const parsed = JSON.parse(await readText());
  const fares = parsed?.fares && typeof parsed.fares === 'object' ? parsed.fares : {};

  return {
    source: String(parsed?.source ?? ''),
    sourceUrl: String(parsed?.sourceUrl ?? ''),
    note: String(parsed?.note ?? ''),
    generated: String(parsed?.generated ?? ''),
    count: Object.keys(fares).length,
    /**
     * The whole-route adult fare in Hong Kong dollars, or null when the
     * operator publishes no fare for that route.
     *
     * @param {string} operator
     * @param {string} route
     */
    fare(operator, route) {
      const key = `${operator}|${String(route ?? '').trim().toUpperCase()}`;
      const value = /** @type {any} */ (fares)[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    },
  };
}

/**
 * A fare table that never has a fare. Used when the table cannot be read, so
 * the app keeps working and simply shows no fares.
 *
 * @returns {FareTable}
 */
export function emptyFareTable() {
  return {
    source: '',
    sourceUrl: '',
    note: '',
    generated: '',
    count: 0,
    fare: () => null,
  };
}
