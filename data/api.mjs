// @ts-check

/**
 * In-browser replacement for the Mini App HTTP API.
 *
 * The routes, the response shapes and the error contract are the ones the
 * Node server exposes, so the existing client works unchanged: the same
 * paths are answered, the same JSON is returned, and a failure produces an
 * `Error` whose `message` is the server's `payload.message` and whose
 * `status` is the HTTP status the server would have used.
 *
 *   GET    /api/bootstrap
 *   GET    /api/search/routes?q=&operator=
 *   GET    /api/search/stops?q=&operator=
 *   GET    /api/routes/{operator}/{route}?dir=O|I
 *   GET    /api/departures?operator=&route=&dir=&stop=
 *   GET    /api/board/{operator}/{stopId}
 *   GET    /api/favourites
 *   POST   /api/favourites
 *   DELETE /api/favourites/{id}
 */

import { createDomain, NotFoundError, ValidationError } from './domain.mjs';

/** @type {ReturnType<typeof createDomain> | null} */
let currentDomain = null;

/** The shared domain instance. Created on first use. */
export function getDomain() {
  if (!currentDomain) currentDomain = createDomain();
  return currentDomain;
}

/**
 * Replace the shared domain instance. Used by the smoke test so the browser
 * modules can be exercised without the background warm-up.
 * @param {ReturnType<typeof createDomain> | null} domain
 */
export function setDomain(domain) {
  currentDomain = domain;
  return currentDomain;
}

/**
 * Read and parse a request body the way the Node server did.
 * @param {{ body?: unknown }} [options]
 */
function readBody(options = {}) {
  const raw = options.body;
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'string') {
    if (raw.length > 64 * 1024) throw new ValidationError('request body is too large');
    try {
      return JSON.parse(raw);
    } catch {
      throw new ValidationError('request body is not valid JSON');
    }
  }
  if (typeof raw === 'object') return raw;
  throw new ValidationError('request body is not valid JSON');
}

/**
 * @param {string} value
 * @returns {string}
 */
function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Route one request and return the response the Node server would have sent.
 *
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 * @returns {Promise<{ status: number, payload: any }>}
 */
export async function handleApi(path, options = {}) {
  const url = new URL(path, 'http://api.local');
  const { pathname } = url;
  const method = String(options.method ?? 'GET').toUpperCase();

  try {
    if (method === 'GET' && pathname === '/api/bootstrap') {
      return { status: 200, payload: await getDomain().bootstrap() };
    }

    if (method === 'GET' && pathname === '/api/search/routes') {
      const results = await getDomain().searchRoutes(
        url.searchParams.get('q') ?? '',
        url.searchParams.get('operator') ?? '',
      );
      return { status: 200, payload: { results, now: new Date().toISOString() } };
    }

    if (method === 'GET' && pathname === '/api/search/stops') {
      const results = await getDomain().searchStops(
        url.searchParams.get('q') ?? '',
        url.searchParams.get('operator') ?? '',
      );
      // The stop catalogue is built on demand, so its progress travels with
      // the results and the page can refresh them as names arrive.
      return {
        status: 200,
        payload: {
          results,
          now: new Date().toISOString(),
          catalogue: { ...getDomain().catalogue },
        },
      };
    }

    const routeMatch = pathname.match(/^\/api\/routes\/([a-z]{3})\/([^/]+)$/);
    if (method === 'GET' && routeMatch) {
      const [, operator, route] = routeMatch;
      const dir = url.searchParams.get('dir') ?? 'O';
      return { status: 200, payload: await getDomain().routeDetail(operator, decodeSegment(route), dir) };
    }

    if (method === 'GET' && pathname === '/api/departures') {
      const payload = await getDomain().departures(
        url.searchParams.get('operator') ?? '',
        url.searchParams.get('route') ?? '',
        url.searchParams.get('dir') ?? 'O',
        url.searchParams.get('stop') ?? '',
      );
      return { status: 200, payload };
    }

    const boardMatch = pathname.match(/^\/api\/board\/([a-z]{3})\/([^/]+)$/);
    if (method === 'GET' && boardMatch) {
      const [, operator, stopId] = boardMatch;
      return { status: 200, payload: await getDomain().board(operator, decodeSegment(stopId)) };
    }

    if (method === 'GET' && pathname === '/api/favourites') {
      return { status: 200, payload: { items: await getDomain().listFavourites() } };
    }

    if (method === 'POST' && pathname === '/api/favourites') {
      const body = readBody(options);
      const items = await getDomain().addFavourite(
        typeof body === 'object' && body ? /** @type {any} */ (body) : {},
      );
      return { status: 200, payload: { items } };
    }

    // The favourite id is `type:operator:key`, so it carries colons. The
    // client percent-encodes it, hence the decoded segment.
    const favouriteMatch = pathname.match(/^\/api\/favourites\/([^/]+)$/);
    if (method === 'DELETE' && favouriteMatch) {
      const items = await getDomain().removeFavourite(decodeSegment(favouriteMatch[1]));
      return { status: 200, payload: { items } };
    }

    return { status: 404, payload: { error: 'not_found' } };
  } catch (error) {
    if (error instanceof ValidationError) {
      return { status: 400, payload: { error: 'invalid_request', message: error.message } };
    }
    if (error instanceof NotFoundError) {
      return { status: 404, payload: { error: 'not_found', message: error.message } };
    }
    const message = error instanceof Error ? error.message : 'unexpected error';
    return { status: 502, payload: { error: 'upstream_unavailable', message } };
  }
}

/**
 * Call the API. Resolves with the parsed payload, or rejects with an `Error`
 * carrying the HTTP `status` and the server's `message`.
 *
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 * @returns {Promise<any>}
 */
export async function api(path, options = {}) {
  const { status, payload } = await handleApi(path, options);
  if (status >= 400) {
    const error = new Error(payload?.message || `Request failed (${status})`);
    error.status = status;
    throw error;
  }
  return payload;
}

export default api;
