/* HK Bus Finder — client application.
   Single page app, hash routing, no build step and no third-party code.

   The phone build has no backend: the data layer runs in the browser and
   talks to the Transport Department, Citybus and New Lantao Bus open feeds
   directly, so `api` resolves the same paths against local modules. */

import { api } from './data/api.mjs';

const OPERATORS = [
  { id: 'kmb', name: 'KMB', nameTc: '九巴' },
  { id: 'ctb', name: 'Citybus', nameTc: '城巴' },
  { id: 'nlb', name: 'Lantau Bus', nameTc: '嶼巴' },
];

const OPERATOR_NAME = { kmb: 'KMB', ctb: 'Citybus', nlb: 'Lantau Bus' };

const state = {
  bootstrap: null,
  view: { name: 'finder' },
  finder: { mode: 'routes', q: '', operator: '', results: [], stopResults: [], loading: false, error: '' },
  route: { data: null, dir: 'O', stopId: '', serviceType: '', departures: null, loading: false, error: '', departLoading: false, departError: '' },
  board: { operator: '', stopOperator: 'kmb', stopId: '', q: '', results: [], data: null, loading: false, error: '' },
  saved: { items: [] },
};

const root = document.getElementById('main');
const toast = document.getElementById('toast');

/* ------------------------------------------------------------- helpers */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
}

function operatorBadge(operator) {
  const id = OPERATORS.some((item) => item.id === operator) ? operator : 'kmb';
  return `<span class="badge badge--${id}">${esc(OPERATOR_NAME[id])}</span>`;
}

/**
 * The published fare for a route. KMB and Citybus fares come from the
 * Transport Department fare table, Lantau from its own feed.
 */
function fareBadge(fare, label = '') {
  if (fare === null || fare === undefined) return '';
  const value = Number(fare);
  if (!Number.isFinite(value)) return '';
  const text = `HK$${value.toFixed(1)}`;
  return `<span class="badge badge--fare" title="Full adult fare for the whole route">${esc(text)}${label ? ` ${esc(label)}` : ''}</span>`;
}

function timeOf(iso) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  return new Date(at).toLocaleTimeString('en-HK', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function countdownLabel(minutes) {
  if (minutes === null || minutes === undefined) return '—';
  if (minutes <= 0) return 'due';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`;
}

function serviceLabel(serviceTypes) {
  if (!serviceTypes || !serviceTypes.length) return 'Daytime';
  if (serviceTypes.includes(2) && !serviceTypes.includes(1)) return 'Night';
  if (serviceTypes.includes(1) && serviceTypes.includes(2)) return 'Daytime + night';
  return 'Daytime';
}

/** Human label for a KMB service variant. */
function serviceTypeLabel(type) {
  if (type === '1') return 'Daytime';
  if (type === '2') return 'Night';
  return `Service ${type}`;
}

/** One stop inside a route's ordered stop list. */
function renderRouteStop(stop) {
  const selected = stop.stopId === state.route.stopId;
  return `
  <button class="stop ${selected ? 'is-selected' : ''}" type="button" data-action="select-stop" data-stop="${esc(stop.stopId)}" aria-current="${selected}">
    <span class="stop__seq">${esc(stop.seq)}</span>
    <span class="stop__body">
      <span class="stop__name">${esc(stop.nameEn || stop.stopId)}</span>
      <span class="stop__name-tc">${esc(stop.nameTc || '')}</span>
    </span>
    <span class="stop__eta">${selected ? '<strong>Selected</strong>' : ''}</span>
  </button>`;
}

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}

/* --------------------------------------------------------------- theme */

const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: 'Auto theme', light: 'Light theme', dark: 'Dark theme' };

function applyTheme(theme) {
  if (theme === 'auto') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
  localStorage.setItem('hkbus-theme', theme);
  const label = document.querySelector('[data-theme-label]');
  if (label) label.textContent = THEME_LABEL[theme];
}

function cycleTheme() {
  const current = localStorage.getItem('hkbus-theme') || 'auto';
  const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
  applyTheme(next);
  showToast(THEME_LABEL[next]);
}

/* -------------------------------------------------------------- router */

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length) return { name: 'finder' };
  if (parts[0] === 'route' && parts[1] && parts[2]) {
    return { name: 'route', operator: parts[1], route: parts[2], dir: parts[3] || 'O', stopId: parts[4] || '' };
  }
  if (parts[0] === 'board') {
    return { name: 'board', operator: parts[1] || 'kmb', stopId: parts[2] || '' };
  }
  if (parts[0] === 'saved') return { name: 'saved' };
  return { name: 'finder' };
}

async function applyRoute() {
  const view = parseHash();
  state.view = view;

  document.querySelectorAll('[data-nav]').forEach((node) => {
    node.classList.toggle('is-active', node.dataset.nav === view.name);
  });

  try {
    if (view.name === 'route') {
      await loadRoute(view);
    } else if (view.name === 'board') {
      await loadBoard(view);
    } else if (view.name === 'saved') {
      state.saved.items = (await api('/api/favourites')).items || [];
    }
  } catch (error) {
    if (view.name === 'route') {
      state.route.error = error.message;
      state.route.data = null;
    } else if (view.name === 'board') {
      state.board.error = error.message;
    }
  }

  render();
}

/* ------------------------------------------------------------ loaders */

async function loadRoute(view) {
  state.route.loading = true;
  state.route.error = '';
  render();
  try {
    const data = await api(`/api/routes/${view.operator}/${encodeURIComponent(view.route)}?dir=${view.dir}`);
    state.route.data = data;
    state.route.dir = data.dir;
    state.route.serviceType = '';
    const wanted = view.stopId && data.stops.some((stop) => stop.stopId === view.stopId)
      ? view.stopId
      : data.stops[0]?.stopId ?? '';
    state.route.stopId = wanted;
    // Always refetch: the direction may have changed even when the stop id
    // stayed the same.
    state.route.departures = null;
    await loadDepartures();
  } finally {
    state.route.loading = false;
  }
}

async function loadDepartures() {
  const { data, dir, stopId } = state.route;
  if (!data || !stopId) return;
  state.route.departLoading = true;
  state.route.departError = '';
  render();
  try {
    state.route.departures = await api(
      `/api/departures?operator=${data.operator}&route=${encodeURIComponent(data.route)}&dir=${dir}&stop=${encodeURIComponent(stopId)}`,
    );
  } catch (error) {
    state.route.departError = error.message;
    state.route.departures = null;
  } finally {
    state.route.departLoading = false;
    render();
  }
}

async function loadBoard(view) {
  // The search filter spans every operator; the loaded board always belongs
  // to the operator that owns the selected stop.
  state.board.stopOperator = view.operator || 'kmb';
  state.board.stopId = view.stopId || '';
  state.board.error = '';
  if (!state.board.stopId) {
    state.board.data = null;
    return;
  }
  state.board.loading = true;
  render();
  try {
    state.board.data = await api(`/api/board/${state.board.stopOperator}/${encodeURIComponent(state.board.stopId)}`);
  } catch (error) {
    state.board.error = error.message;
    state.board.data = null;
  } finally {
    state.board.loading = false;
    render();
  }
}

/* ------------------------------------------------------------- search */

let searchTimer = null;

function scheduleFinderSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    void runFinderSearch();
  }, 220);
}

async function runFinderSearch() {
  const { mode, q, operator } = state.finder;
  if (!q.trim()) {
    state.finder.results = [];
    state.finder.stopResults = [];
    state.finder.error = '';
    render();
    return;
  }
  state.finder.loading = true;
  state.finder.error = '';
  render();
  try {
    const operatorParam = operator ? `&operator=${operator}` : '';
    if (mode === 'routes') {
      const payload = await api(`/api/search/routes?q=${encodeURIComponent(q)}${operatorParam}`);
      state.finder.results = payload.results || [];
      state.finder.stopResults = [];
      noteDirections(payload.directions);
    } else {
      const payload = await api(`/api/search/stops?q=${encodeURIComponent(q)}${operatorParam}`);
      state.finder.stopResults = payload.results || [];
      state.finder.results = [];
      noteCatalogue(payload.catalogue);
    }
  } catch (error) {
    state.finder.error = error.message;
  } finally {
    state.finder.loading = false;
    render();
  }
}

let boardSearchTimer = null;

/**
 * Citybus publishes no stop list, so the names are assembled on demand. While
 * that is happening the results are refreshed so the stops appear as they are
 * resolved rather than only on the next search.
 */
let catalogueTimer = null;

function noteCatalogue(catalogue) {
  if (!catalogue) return;
  if (state.bootstrap) state.bootstrap.catalogue = catalogue;
  clearTimeout(catalogueTimer);
  if (catalogue.status !== 'running') return;
  catalogueTimer = setTimeout(() => {
    if (state.view.name === 'finder' && state.finder.mode === 'stops') void runFinderSearch();
    if (state.view.name === 'board' && state.board.q.trim()) void runBoardSearch();
  }, 4000);
}

/**
 * Citybus publishes no direction in its route list, so the direction of a
 * Citybus route is worked out from its route-stop endpoint while the result
 * list is on screen. The results are refreshed so the second direction shows
 * up as soon as it is known rather than only on the next search.
 */
let directionTimer = null;

function noteDirections(directions) {
  if (!directions) return;
  clearTimeout(directionTimer);
  if (directions.status !== 'running') return;
  directionTimer = setTimeout(() => {
    if (state.view.name === 'finder' && state.finder.mode === 'routes') void runFinderSearch();
  }, 2500);
}

function scheduleBoardSearch() {
  clearTimeout(boardSearchTimer);
  boardSearchTimer = setTimeout(() => {
    void runBoardSearch();
  }, 220);
}

async function runBoardSearch() {
  const q = state.board.q.trim();
  if (!q) {
    state.board.results = [];
    render();
    return;
  }
  try {
    const payload = await api(`/api/search/stops?q=${encodeURIComponent(q)}&operator=${state.board.operator}`);
    state.board.results = payload.results || [];
    noteCatalogue(payload.catalogue);
  } catch (error) {
    state.board.error = error.message;
  }
  render();
}

/* ----------------------------------------------------------- rendering */

function render() {
  const view = state.view.name;
  let html = '';

  if (view === 'route') html = renderRoute();
  else if (view === 'board') html = renderBoard();
  else if (view === 'saved') html = renderSaved();
  else html = renderFinder();

  root.innerHTML = html;
  restoreFocus();
}

/** Keep the caret in the search box after a re-render. */
let lastFocusId = null;
let lastCaret = null;

function restoreFocus() {
  if (!lastFocusId) return;
  const input = document.getElementById(lastFocusId);
  if (!input) return;
  input.focus();
  if (lastCaret !== null) {
    const max = input.value.length;
    input.setSelectionRange(Math.min(lastCaret, max), Math.min(lastCaret, max));
  }
}

/** Shown when an operator's live feed is unreachable. */
function healthNotice() {
  const health = state.bootstrap?.health ?? {};
  const failed = Object.entries(health).filter(([, value]) => value && value.ok === false);
  if (!failed.length) return '';
  const names = failed.map(([id]) => OPERATOR_NAME[id] ?? id);
  const plural = names.length > 1 ? 'are' : 'is';
  return `
    <div class="notice" role="status">
      <strong>${esc(names.join(' and '))} ${plural} temporarily unavailable.</strong>
      The rest of the app still works; the affected operator will return on the next refresh.
    </div>`;
}

function renderFinder() {
  const { mode, q, operator, results, stopResults, loading, error } = state.finder;
  const bootstrap = state.bootstrap;

  const operatorChips = [
    `<button class="chip" type="button" data-action="operator" data-operator="" aria-pressed="${operator === ''}">All</button>`,
    ...OPERATORS.map(
      (item) =>
        `<button class="chip" type="button" data-action="operator" data-operator="${item.id}" aria-pressed="${operator === item.id}">${esc(item.name)}</button>`,
    ),
  ].join('');

  let body = '';

  if (error) {
    body = `<div class="card empty"><strong>Search failed</strong>${esc(error)}</div>`;
  } else if (loading) {
    body = `<div class="card">${'<div class="skeleton"><div class="skeleton__line"></div><div class="skeleton__line"></div></div>'.repeat(4)}</div>`;
  } else if (!q.trim()) {
    body = renderFeatured();
  } else if (mode === 'routes') {
    body = results.length
      ? `<div class="card list">${results.map(renderRouteRow).join('')}</div>`
      : `<div class="card empty"><strong>No routes matched “${esc(q)}”</strong>Try a route number such as 968, or a destination such as Central.</div>`;
  } else {
    body = stopResults.length
      ? `<div class="card list">${stopResults.map(renderStopRow).join('')}</div>`
      : `<div class="card empty"><strong>No stops matched “${esc(q)}”</strong>Stop names are matched in English and Chinese.</div>`;
  }

  const counts = bootstrap?.counts ?? {};
  const catalogue = bootstrap?.catalogue;

  return `
    <section class="page-head">
      <div>
        <h1>Route finder</h1>
        <p>One search across ${esc(counts.kmb ?? '—')} KMB, ${esc(counts.ctb ?? '—')} Citybus and ${esc(counts.nlb ?? '—')} Lantau Bus routes.</p>
      </div>
      <div class="page-head__actions">
        <button class="btn" type="button" data-action="go-board">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10" /></svg>
          Departure board
        </button>
      </div>
    </section>

    ${healthNotice()}

    <div class="toolbar">
      <div class="search">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input id="finder-input" type="search" autocomplete="off" spellcheck="false"
          placeholder="${mode === 'routes' ? 'Route number or destination, e.g. 968, Central, 中環' : 'Stop name, e.g. Central, 中環, Tai O'}"
          value="${esc(q)}" aria-label="${mode === 'routes' ? 'Search routes' : 'Search stops'}" />
      </div>
      <div class="segmented" role="group" aria-label="Search type">
        <button type="button" data-action="mode" data-mode="routes" aria-pressed="${mode === 'routes'}">Routes</button>
        <button type="button" data-action="mode" data-mode="stops" aria-pressed="${mode === 'stops'}">Stops</button>
      </div>
    </div>

    <div class="chips" role="group" aria-label="Filter by operator" style="margin-bottom:16px">
      ${operatorChips}
    </div>

    <section class="section">
      <div class="section__head">
        <h2>${mode === 'routes' ? 'Routes' : 'Stops'}</h2>
        <p>${catalogue && catalogue.status === 'running' ? 'Citybus stop index building…' : ''}</p>
      </div>
      ${body}
    </section>
  `;
}

function renderFeatured() {
  const featured = state.bootstrap?.featured ?? [];
  if (!featured.length) return '<div class="card empty"><strong>Loading route index</strong>Fetching published routes from the operators.</div>';
  return `
    <div class="card list">
      ${featured
        .map(
          (item) => `
        <button class="row" type="button" data-action="open-route" data-operator="${esc(item.operator)}" data-route="${esc(item.route)}" data-dir="O">
          <span class="route-number">${esc(item.route)}</span>
          <span class="row__main">
            <span class="row__title">${esc(item.originEn || '—')} → ${esc(item.destEn || '—')}</span>
            <span class="row__sub">${esc(item.originTc || '')}</span>
          </span>
          <span class="row__meta">
            ${operatorBadge(item.operator)}
            ${fareBadge(item.fare)}
          </span>
        </button>`,
        )
        .join('')}
    </div>
  `;
}

function renderRouteRow(item) {
  return `
    <button class="row" type="button" data-action="open-route" data-operator="${esc(item.operator)}" data-route="${esc(item.route)}" data-dir="${esc(item.dir)}">
      <span class="route-number">${esc(item.route)}</span>
      <span class="row__main">
        <span class="row__title">${esc(item.originEn || '—')} → ${esc(item.destEn || '—')}</span>
        <span class="row__sub">${esc(item.originTc || '')}${item.destTc ? ` → ${esc(item.destTc)}` : ''}</span>
      </span>
      <span class="row__meta">
        ${operatorBadge(item.operator)}
        ${fareBadge(item.fare)}
        <div style="margin-top:4px">${item.dir === 'O' ? 'Outbound' : 'Inbound'}</div>
      </span>
    </button>
  `;
}

function renderStopRow(item) {
  return `
    <button class="row" type="button" data-action="open-stop" data-operator="${esc(item.operator)}" data-stop="${esc(item.stopId ?? item.id ?? '')}">
      <span class="row__main">
        <span class="row__title">${esc(item.nameEn || item.name || '—')}</span>
        <span class="row__sub">${esc(item.nameTc || '')}</span>
      </span>
      <span class="row__meta">${operatorBadge(item.operator)}</span>
    </button>
  `;
}

function renderRoute() {
  const { data, dir, stopId, loading, error } = state.route;

  if (loading && !data) {
    return `<div class="card"><div class="skeleton"><div class="skeleton__line"></div><div class="skeleton__line"></div></div></div>`;
  }

  if (error || !data) {
    return `
      <section class="page-head"><div><h1>Route unavailable</h1><p>${esc(error || 'That route could not be loaded.')}</p></div></section>
      <div class="toolbar">
        <button class="btn" type="button" data-action="nav" data-href="#/finder">Back to finder</button>
        <button class="btn btn--primary" type="button" data-action="reload">Try again</button>
      </div>`;
  }

  const directionTabs = data.directions
    .map(
      (item) =>
        `<button class="chip" type="button" data-action="direction" data-dir="${esc(item.dir)}" aria-pressed="${item.dir === dir}">${item.dir === 'O' ? 'Outbound' : 'Inbound'}</button>`,
    )
    .join('');

  const direction = data.directions.find((item) => item.dir === dir) ?? data.directions[0];

  const groupKeys = Object.keys(data.stopGroups ?? {});
  const activeType = groupKeys.includes(state.route.serviceType)
    ? state.route.serviceType
    : (data.defaultServiceType ?? groupKeys[0]);
  const stops = data.stopGroups?.[activeType] ?? data.stops ?? [];

  const serviceChips = groupKeys.length > 1
    ? `<div class="chips" role="group" aria-label="Service variant" style="margin-bottom:12px">${groupKeys
        .map(
          (key) =>
            `<button class="chip" type="button" data-action="service-type" data-type="${esc(key)}" aria-pressed="${key === activeType}">${esc(serviceTypeLabel(key))}</button>`,
        )
        .join('')}</div>`
    : '';

  const savedKey = `route:${data.operator}:${data.route}`;
  const isSaved = state.saved.items.some((item) => item.id === savedKey);

  return `
    <section class="page-head">
      <div>
        <h1>Route ${esc(data.route)}</h1>
        <p>${esc(OPERATOR_NAME[data.operator])} service &middot; ${esc(String(stops.length))} stops</p>
      </div>
      <div class="page-head__actions">
        <button class="btn" type="button" data-action="nav" data-href="#/finder">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m14 6-6 6 6 6" /></svg>
          Finder
        </button>
        <button class="btn ${isSaved ? '' : 'btn--primary'}" type="button" data-action="save-route"
          data-operator="${esc(data.operator)}" data-route="${esc(data.route)}"
          data-label="Route ${esc(data.route)}" data-subtitle="${esc(data.originEn || '')} → ${esc(data.destEn || '')}">
          ${isSaved ? 'Saved' : 'Save route'}
        </button>
      </div>
    </section>

    ${healthNotice()}

    <div class="route-head">
      <div class="route-head__number">${esc(data.route)}</div>
      <div class="route-head__body">
        <p class="route-head__path">${esc(data.originEn || '—')} <span>→</span> ${esc(data.destEn || '—')}</p>
        <p class="route-head__path small muted">${esc(data.originTc || '')} ${esc(data.destTc ? `→ ${data.destTc}` : '')}</p>
        <div class="route-head__meta">
          ${operatorBadge(data.operator)}
          <span class="badge badge--muted">${esc(serviceLabel(data.serviceTypes))}</span>
          ${fareBadge(data.fare)}
          ${fareBadge(data.fareHoliday, 'holiday')}
        </div>
      </div>
    </div>

    <div class="chips" role="group" aria-label="Direction" style="margin-bottom:16px">${directionTabs}</div>

    <div class="route-grid">
      <section class="panel">
        <div class="panel__head">
          <h2>Stops</h2>
          <span class="small muted">${esc(stops[0]?.nameEn || direction?.originEn || '')} → ${esc(stops[stops.length - 1]?.nameEn || direction?.destEn || '')}</span>
        </div>
        ${serviceChips}
        <div class="stop-list">${stops.map(renderRouteStop).join('') || '<p class="empty">No stop data published for this direction.</p>'}</div>
      </section>

      <section class="panel">
        <div class="panel__head">
          <h2>Schedule</h2>
          <span class="small muted">${esc(stops.find((s) => s.stopId === stopId)?.nameEn || '')}</span>
        </div>
        <div class="panel__body">${renderSchedule()}</div>
      </section>
    </div>
  `;
}

function renderSchedule() {
  const { departures, departLoading, departError } = state.route;

  if (departLoading) {
    return `<div class="skeleton"><div class="skeleton__line"></div><div class="skeleton__line"></div></div>`;
  }
  if (departError) {
    return `<div class="empty"><strong>Could not load departures</strong>${esc(departError)}</div>`;
  }
  if (!departures) {
    return '<p class="muted small">Select a stop to see the next departures.</p>';
  }
  if (!departures.departures.length) {
    return `<div class="empty"><strong>No buses due within 3 hours</strong>This service may not be running at the moment, or the timetable has not been published for this stop.</div>`;
  }

  const rows = departures.departures
    .map(
      (item) => `
      <div class="eta-row">
        <span class="eta-row__time">${esc(timeOf(item.time))}</span>
        <span class="eta-row__meta">
          <span class="eta-row__dest">${esc(item.destEn || item.variant || 'Departing')}</span>
          <span class="eta-row__note">${esc(item.variant && item.destEn ? item.variant : item.remark || '')}${item.wheelchair ? ' &middot; wheelchair accessible' : ''}</span>
        </span>
        <span class="countdown ${item.minutes <= 0 ? 'is-due' : ''}">${esc(countdownLabel(item.minutes))}</span>
      </div>`,
    )
    .join('');

  const stats = `
    <div class="stat-row">
      <div class="stat">
        <div class="stat__label">Service</div>
        <div class="stat__value">${esc(serviceLabel(departures.serviceTypes))}</div>
      </div>
      <div class="stat">
        <div class="stat__label">Headway</div>
        <div class="stat__value">${departures.headwayMinutes ? `about ${esc(departures.headwayMinutes)} min` : 'not enough data'}</div>
      </div>
      <div class="stat">
        <div class="stat__label">Source</div>
        <div class="stat__value">${departures.source === 'timetable' ? 'Timetable estimate' : 'Live arrival feed'}</div>
      </div>
    </div>`;

  return `${rows}${stats}`;
}

function renderBoard() {
  const { operator, stopId, q, results, data, loading, error } = state.board;

  const operatorChips = [
    `<button class="chip" type="button" data-action="board-operator" data-operator="" aria-pressed="${operator === ''}">All</button>`,
    ...OPERATORS.map(
      (item) =>
        `<button class="chip" type="button" data-action="board-operator" data-operator="${item.id}" aria-pressed="${operator === item.id}">${esc(item.name)}</button>`,
    ),
  ].join('');

  let content = '';

  if (error) {
    content = `<div class="card empty"><strong>Could not load the board</strong>${esc(error)}</div>`;
  } else if (loading) {
    content = `<div class="card">${'<div class="skeleton"><div class="skeleton__line"></div><div class="skeleton__line"></div></div>'.repeat(5)}</div>`;
  } else if (data) {
    const rows = data.routes.length
      ? data.routes
          .map(
            (item) => `
        <button class="row" type="button" data-action="open-route" data-operator="${esc(data.operator)}" data-route="${esc(item.route)}" data-dir="${esc(item.dir)}">
          <span class="route-number">${esc(item.route)}</span>
          <span class="row__main">
            <span class="row__title">${esc(item.departures[0]?.destEn || (item.dir === 'O' ? 'Outbound' : 'Inbound'))}</span>
            <span class="row__sub">${esc(item.departures[0]?.variant || item.departures[0]?.remark || `${item.dir === 'O' ? 'Outbound' : 'Inbound'} service`)}</span>
          </span>
          <span class="row__meta">
            ${item.next !== null ? `<strong style="font-size:14px;color:var(--mcode-text)">${esc(countdownLabel(item.next))}</strong>` : '<span>no service due</span>'}
            <div style="margin-top:4px">${esc(timeOf(item.departures[0]?.time || ''))}</div>
            <div style="margin-top:4px">${fareBadge(item.fare)}</div>
          </span>
        </button>`,
          )
          .join('')
      : '<div class="empty"><strong>No routes serve this stop</strong>The operator has no published services for this stop right now.</div>';
    content = `<div class="card list">${rows}</div>`;
  } else if (q.trim() && results.length) {
    content = `<div class="card list">${results.map(renderStopRow).join('')}</div>`;
  } else if (q.trim()) {
    content = `<div class="card empty"><strong>No stops matched “${esc(q)}”</strong>Try the English or Chinese name of the stop.</div>`;
  } else {
    content = '<div class="card empty"><strong>Choose a stop</strong>Search for a bus stop above to see every route serving it.</div>';
  }

  const stopTitle = data?.stopNameEn ? `${data.stopNameEn}` : q.trim() ? `Results for “${q.trim()}”` : 'Choose a stop';

  return `
    <section class="page-head">
      <div>
        <h1>Departure board</h1>
        <p>Every route serving a stop, ordered by the next bus.</p>
      </div>
      <div class="page-head__actions">
        <button class="btn" type="button" data-action="reload">Refresh</button>
      </div>
    </section>

    ${healthNotice()}

    <div class="toolbar">
      <div class="search">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input id="board-input" type="search" autocomplete="off" spellcheck="false"
          placeholder="Stop name, e.g. Central, 中環, Tai O" value="${esc(q)}" aria-label="Search stops" />
      </div>
    </div>

    <div class="chips" role="group" aria-label="Operator" style="margin-bottom:16px">${operatorChips}</div>

    <section class="section">
      <div class="section__head">
        <h2>${esc(stopTitle)}</h2>
        <p>${data ? `${esc(OPERATOR_NAME[data.operator])} &middot; ${data.routes.length} routes` : ''}</p>
      </div>
      ${content}
    </section>
  `;
}

function renderSaved() {
  const items = state.saved.items || [];
  if (!items.length) {
    return `
      <section class="page-head"><div><h1>Saved</h1><p>Routes and stops you keep for quick access.</p></div></section>
      <div class="card empty"><strong>Nothing saved yet</strong>Open a route and press “Save route”, or open a departure board to keep a stop.</div>`;
  }

  const rows = items
    .map(
      (item) => `
    <div class="row" style="cursor: default">
      <span class="row__main">
        <span class="row__title">${esc(item.label)} ${operatorBadge(item.operator)}</span>
        <span class="row__sub">${esc(item.subtitle || '')}</span>
      </span>
      <span class="row__meta">
        <button class="btn btn--ghost" type="button" data-action="open-saved" data-type="${esc(item.type)}" data-operator="${esc(item.operator)}" data-key="${esc(item.key)}">Open</button>
        <button class="btn btn--danger" type="button" data-action="remove-favourite" data-id="${esc(item.id)}" aria-label="Remove ${esc(item.label)}">Remove</button>
      </span>
    </div>`,
    )
    .join('');

  return `
    <section class="page-head"><div><h1>Saved</h1><p>${items.length} saved ${items.length === 1 ? 'entry' : 'entries'}.</p></div></section>
    <div class="card list">${rows}</div>`;
}

/* --------------------------------------------------------------- events */

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;

  if (action === 'toggle-theme') {
    cycleTheme();
    return;
  }

  if (action === 'nav') {
    location.hash = target.dataset.href || '#/finder';
    return;
  }

  if (action === 'go-board') {
    location.hash = '#/board';
    return;
  }

  if (action === 'reload') {
    await applyRoute();
    return;
  }

  if (action === 'mode') {
    state.finder.mode = target.dataset.mode === 'stops' ? 'stops' : 'routes';
    state.finder.results = [];
    state.finder.stopResults = [];
    render();
    if (state.finder.q.trim()) void runFinderSearch();
    return;
  }

  if (action === 'operator') {
    state.finder.operator = target.dataset.operator || '';
    render();
    if (state.finder.q.trim()) void runFinderSearch();
    return;
  }

  if (action === 'open-route') {
    const { operator, route, dir } = target.dataset;
    location.hash = `#/route/${operator}/${encodeURIComponent(route)}/${dir || 'O'}`;
    return;
  }

  if (action === 'open-stop') {
    const { operator, stop } = target.dataset;
    location.hash = `#/board/${operator}/${encodeURIComponent(stop)}`;
    return;
  }

  if (action === 'select-stop') {
    state.route.stopId = target.dataset.stop;
    state.route.departures = null;
    render();
    await loadDepartures();
    return;
  }

  if (action === 'service-type') {
    const type = target.dataset.type;
    state.route.serviceType = type;
    const group = state.route.data?.stopGroups?.[type] ?? [];
    if (!group.some((stop) => stop.stopId === state.route.stopId)) {
      state.route.stopId = group[0]?.stopId ?? '';
      state.route.departures = null;
    }
    render();
    if (!state.route.departures) await loadDepartures();
    return;
  }

  if (action === 'direction') {
    const dir = target.dataset.dir || 'O';
    const { data } = state.route;
    if (!data) return;
    location.hash = `#/route/${data.operator}/${encodeURIComponent(data.route)}/${dir}`;
    return;
  }

  if (action === 'board-operator') {
    state.board.operator = target.dataset.operator || '';
    render();
    if (state.board.q.trim()) void runBoardSearch();
    return;
  }

  if (action === 'save-route') {
    const { operator, route, label, subtitle } = target.dataset;
    try {
      const payload = await api('/api/favourites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'route', operator, key: route, label, subtitle }),
      });
      state.saved.items = payload.items || [];
      showToast(`${label} saved`);
      render();
    } catch (error) {
      showToast(`Could not save: ${error.message}`);
    }
    return;
  }

  if (action === 'remove-favourite') {
    try {
      const payload = await api(`/api/favourites/${encodeURIComponent(target.dataset.id)}`, { method: 'DELETE' });
      state.saved.items = payload.items || [];
      showToast('Removed');
      render();
    } catch (error) {
      showToast(`Could not remove: ${error.message}`);
    }
    return;
  }

  if (action === 'open-saved') {
    const { type, operator, key } = target.dataset;
    if (type === 'route') {
      location.hash = `#/route/${operator}/${encodeURIComponent(key)}/O`;
    } else {
      location.hash = `#/board/${operator}/${encodeURIComponent(key)}`;
    }
  }
});

document.addEventListener('input', (event) => {
  const input = /** @type {HTMLInputElement} */ (event.target);
  if (input.id === 'finder-input') {
    state.finder.q = input.value;
    lastFocusId = 'finder-input';
    lastCaret = input.selectionStart;
    scheduleFinderSearch();
  } else if (input.id === 'board-input') {
    state.board.q = input.value;
    lastFocusId = 'board-input';
    lastCaret = input.selectionStart;
    scheduleBoardSearch();
  }
});

window.addEventListener('hashchange', () => {
  void applyRoute();
});

/* Keep the live boards fresh without a manual refresh. */
setInterval(() => {
  if (state.view.name === 'route' && state.route.data) void loadDepartures();
  else if (state.view.name === 'board' && state.board.stopId) void loadBoard(state.view);
}, 45000);

/* ----------------------------------------------------------------- boot */

/** Back-off used when an operator feed was unreachable during the first fetch. */
const HEALTH_RETRY_DELAYS = [4000, 10000, 25000];

/**
 * A feed that was down when the app started is re-checked in the background,
 * so the operator reappears on its own instead of waiting for a reload.
 * @param {number} [attempt]
 */
function scheduleHealthCheck(attempt = 0) {
  const health = state.bootstrap?.health ?? {};
  const degraded = Object.values(health).some((value) => value && value.ok === false);
  if (!degraded || attempt >= HEALTH_RETRY_DELAYS.length) return;
  setTimeout(() => {
    void api('/api/bootstrap')
      .then((fresh) => {
        state.bootstrap = fresh;
        state.saved.items = fresh.favourites || [];
        render();
        scheduleHealthCheck(attempt + 1);
      })
      .catch(() => scheduleHealthCheck(attempt + 1));
  }, HEALTH_RETRY_DELAYS[attempt]);
}

async function boot() {
  applyTheme(localStorage.getItem('hkbus-theme') || 'auto');
  try {
    state.bootstrap = await api('/api/bootstrap');
    state.saved.items = state.bootstrap.favourites || [];
    const sources = document.querySelector('[data-sources]');
    if (sources && Array.isArray(state.bootstrap.sources)) {
      sources.textContent = `Live open data: ${state.bootstrap.sources.map((item) => item.label).join(', ')}.`;
    }
  } catch (error) {
    showToast(`Could not reach the data service: ${error.message}`);
  }
  await applyRoute();
  scheduleHealthCheck();
}

/* Keep the shell available offline so the app opens instantly on the phone
   and still shows its last state when the network is gone. */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}

void boot();
