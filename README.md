# HK Bus Finder

Route finder and live departure boards for **KMB (九巴)**, **Citybus (城巴)** and **Lantau Bus (NLB)** in Hong Kong — one app, three operators, real data.

No backend, no build step, no account, no tracking.

## Install it on your phone

This is a progressive web app, so there is nothing to download from a store.

**iPhone (Safari)** — open the link, tap **Share**, then **Add to Home Screen**.

**Android (Chrome)** — open the link, then **⋮ → Install app**, or tap the install banner.

It launches full screen with no browser chrome, keeps working offline with the last data it loaded, and stays up to date on the next visit.

## What it does

- **Route finder** — search by route number or destination, across all three operators at once
- **Route detail** — the full stop sequence in English and Traditional Chinese, with a live departure panel for the stop you pick
- **Departure board** — every route serving a stop, ordered by the next bus
- **Fares** — the published adult fare for KMB and Citybus routes, and Lantau's own fare
- **Saved** — keep routes and stops for quick access, stored on the device

KMB's daytime and night services are kept as **separate variants** rather than merged, because they genuinely start from different termini — route 968 runs from Yuen Long (West) by day and from Yuen Long Park by night.

A route that runs one way only shows one direction. KMB and Lantau publish a direction for every route they run, so their route list is enough. Citybus publishes one row per route with no direction at all, so its second direction is worked out from the route-stop endpoint — which is why the second direction of a Citybus route appears a moment after the first search for it, and is remembered from then on.

## Live sites

| | |
|---|---|
| GitHub Pages | `https://winglam01.github.io/hk-bus-finder/` |
| MiniMax drive | `https://khdp8zb0cldo7.space.minimax.io` |

## Where the data comes from

All of it is live, free and public open data.

| Operator | Routes | Feed |
|---|---|---|
| KMB / Long Win | ~800 | `data.etabus.gov.hk/v1/transport/kmb` |
| Citybus | ~410 | `rt.data.gov.hk/v1|v2/transport/citybus*` |
| Lantau Bus (NLB) | ~39 | `rt.data.gov.hk/v2/transport/nlb` |
| Fares | ~1,100 | Transport Department, *Routes and fares of public transport* |

The schedule panel always says where its numbers came from — **Live arrival feed** for genuine ETAs, **Timetable estimate** for Lantau, where the operator publishes a schedule rather than a live feed.

## Fares

KMB and Citybus publish no fares in their feeds, so theirs come from the Transport Department's open data set [*Routes and fares of public transport*](https://data.gov.hk/en-data/dataset/hk-td-tis_3-routes-and-fares-of-public-transport). Lantau publishes a fare with every stop in its own feed, including the holiday fare, so it keeps those.

The Transport Department publishes one row per service a route runs. The app shows the **whole-route fare**: the row for the whole route where one exists, otherwise the longest journey the route actually covers. A shorter ride may cost less, and that is not worked out.

Fares are keyed by operator as well as route number, because the same number can cost a different amount on different operators — KMB 12 is $5.6 and Citybus 12 is $6.1.

The fare table is a snapshot of the Transport Department data, not a live feed. **About 90% of KMB and Citybus routes have a published fare**; the rest are the rural, night and special-service routes the Transport Department does not list, and the app shows no fare for those rather than guessing.

The table is built ahead of time, not at runtime, so no database driver ships with the app:

```bash
npm install mdb-reader
node tools/build-fares.mjs <path-to-ROUTE_BUS.mdb>
```

That writes `data/fares.json`, a small flat file the app reads once.

> "Lantau Bus" here means **New Lantao Bus (NLB)**, the Lantau Island operator with an open API. Lantau Bus Company (嶼巴) does not publish one, so its routes are not covered.

## How it works

The page is plain ES modules and inline SVG. There is no bundler, no framework and no third-party code — the browser loads the files as they are. Because all three feeds send `Access-Control-Allow-Origin: *`, the page calls them directly from the browser and there is no server in the middle.

```
index.html          app shell
app.js              hash routing and rendering
styles.css          theme tokens and layout
sw.js               offline shell cache
manifest.json       install metadata
data/upstream.mjs   feed access, caching, normalisation
data/domain.mjs     search, route detail, boards, favourites
data/api.mjs        the API surface the page talks to
data/storage.mjs    persistence with a quota-safe fallback
data/fares.mjs      the fare table lookup
data/fares.json     the built Transport Department fare table
```

A few decisions worth knowing about:

- **Caching is honest.** Static collections live for six hours, arrival times for twenty seconds, and a failed feed is never cached — an empty collection throws rather than being stored.
- **Nothing is fetched until it is wanted.** Citybus publishes no stop list, so one is assembled from the per-route stop lists — well over a thousand requests. That only happens the first time somebody actually searches for a stop, and the page says so while it runs. The large KMB collections are fetched when a route is opened, not on every page load.
- **A flaky upstream is retried, not trusted.** The Transport Department edge answers `403` at random on its large collections, at roughly one request in three. Every feed call retries, and a route list that still fails is re-fetched in the background so the operator comes back on its own.
- **The KMB stop catalogue has a fallback.** When the bulk stop collection is refused, names are resolved one stop at a time instead, so a route page is never hidden by an upstream outage.
- **No build step means no build toolchain to install.**

## Run it locally

Any static file server works. ES modules and service workers need a real `http://` origin, so `file://` will not do.

```bash
node tools/serve-web.mjs 8081 .
```

Then open <http://127.0.0.1:8081/>.

## Check it against the live feeds

```bash
node tools/smoke-hkbus-web.mjs
```

This drives the real data layer against the real upstream APIs and asserts the route counts, the service variants, the departure boards, the fares, search and the favourites round trip. It needs network access and takes about twenty seconds.

`node tools/fare-coverage.mjs` reports how much of the published route index has a published fare, and which routes do not.

The icons are generated, not hand-drawn — `node tools/make-icons.mjs <output-folder>` redraws them from the same bus mark the app header uses.

## Desktop Mini App

The same app also runs as a **Mini App** inside the MiniMax Code desktop app, with a Node service behind it for on-disk caching and favourites. That build is a MiniMax plugin package rather than a static site, so it lives outside this repository.

---

The transport data is © the Transport Department, Citybus and New Lantao Bus. This repository contains no code licence yet — add one if you plan to reuse it.
