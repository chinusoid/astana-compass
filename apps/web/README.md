# Astana Compass web · Team 03

Next.js App Router / TypeScript / Tailwind / MapLibre frontend for the existing
foundation API. No registration, browser provider keys, generated city facts, or
replacement backend. Public types are imported from `@astana/api-client` and
network JSON is checked against the canonical root `contracts.schema.json`.

## Reproduce

Use Node >=22.12 and pnpm 11.25.0. Exact versions and the **module-local** lock
are in this directory; the repository's Python workspace and root lock are unchanged.

Start the foundation from the repository root:

```sh
uv sync --locked
ASTANA_MODE=fixture LLM_PROVIDER=none uv run uvicorn astana_api.app:create_app --factory --host 127.0.0.1 --port 8000 --no-access-log
```

In another terminal:

```sh
cd apps/web
pnpm install --frozen-lockfile
ASTANA_ALLOW_FIXTURES=true pnpm dev
```

Open http://127.0.0.1:3000. Explicit synthetic demo: query `Прогулка без спешки`,
latitude `51.090`, longitude `71.420`, 90 minutes, return enabled. These are the
foundation's **synthetic** places; they do not prove real venue data or live routing.
Choose two alternatives, then calculate the complete itinerary. Required wheelchair
access demonstrates `no_match` because the fixture does not verify that property.

For production compilation and local preview:

```sh
pnpm build
ASTANA_ALLOW_FIXTURES=true pnpm start
```

`build` and `dev` use the supported Webpack compiler because Turbopack's helper
process cannot bind its local port in the evaluation environment. MapLibre 6's
worker **and its shared module** are copied from the pinned package before
dev/build/start, served from this app, and excluded from Git. Deploy `public/`
alongside `.next/` and the normal Next runtime. No executable CDN dependency.

## Runtime configuration

| Server environment variable | Default | Purpose |
| --- | --- | --- |
| `ASTANA_API_URL` | `http://127.0.0.1:8000` | Backend origin only, no userinfo, path, query, or API key |
| `ASTANA_ALLOW_FIXTURES` | `false` | Explicitly permit synthetic API payloads and show the demo banner |
| `ASTANA_MAP_PROVIDER` | `osm` | `osm` offers raster tiles after the user opens the map; `none` sends no external tile requests |

These are server configuration values, not `NEXT_PUBLIC_*` secrets. The browser
uses same-origin `/api/v1/*`; a limited Next route forwards to the configured
foundation. Only the six supported resource paths are forwarded. No credentials,
cookies or client-provided upstream URL are forwarded. The body cap is 32 KiB;
upstream timeout 32 seconds; browser timeout 35 seconds; no automatic retry of
POSTs. API responses are not cached. Favorites store only name, ID and synthetic
marker; delete-one/delete-all are available. Query and origin are kept in memory.

Live use: start the backend with `ASTANA_MODE=live`, install/configure the three
documented team factories, keep `ASTANA_ALLOW_FIXTURES=false`, and set
`ASTANA_API_URL` to that backend. A missing live implementation produces an explicit
unavailable state. The frontend never substitutes a synthetic catalog.

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

With the actual foundation fixture API running at port 8000:

```sh
pnpm exec playwright install chromium
pnpm test:e2e
```

Alternatively set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an installed Chromium path.
Set `ASTANA_E2E_PYTHON` to the Python executable of the root uv environment
(normally `../../.venv/bin/python` when running from `apps/web`). It is used only
by model-failure tests: real public generator/recommender code consumes a mocked
provider response and synthetic replay adapters; no paid model call is made.
Browser tests start disposable frontend servers at 43103 (fixtures permitted) and
43104 (fixtures forbidden); existing servers are never reused or stopped.
`ASTANA_API_URL` overrides the fixture backend origin. On this machine Chromium
must run outside the restricted command sandbox, with a disposable profile, as
documented by the parent AGENTS.md.

Set `ASTANA_SCREENSHOT_DIR` to an artifact directory to capture real RU/KK/EN
desktop and mobile screenshots. Failure screenshots/traces and HTML reports stay
in ignored `test-results/` and `playwright-report/`. Do not commit binary sets.

Live smoke is a separate opt-in command:

```sh
ASTANA_LIVE_WEB_URL=http://127.0.0.1:3105 pnpm test:live
```

Without that environment variable it is explicitly skipped. A successful synthetic
suite says nothing about live POI truth, external routes or inference credentials.

## Behavior and limits

- Manual coordinates always work. Location permission is requested only on click;
  a late geolocation result cannot overwrite a newer manual selection.
- Constraints are explicit true-valued predicates. Required is never weakened;
  preferred violations/unknowns retain explanations. Free text is not advertised
  as automatic hard-constraint extraction.
- Recommendation alternatives are separate trips. Only the selected ordered IDs
  are sent to the itinerary endpoint; 1–3 stops. Failed/no-match/reordered responses
  never replace that selection or produce a truncated success.
- Editing time, origin, locale or constraints cancels stale requests and clears the
  previous result/route. Selection remains editable. Reordering is an explicit action.
- API seconds remain integers. Display includes remaining seconds; city date/time
  uses `Asia/Almaty` independently of the browser timezone.
- A line is drawn only for `method=routed` with non-null geometry. Approximate or
  absent geometry shows points and a limitation, never a straight-line walking path.
- Sources, retrieval dates, unknown/conflicting facts and AI activity suggestions
  remain distinct. Model fallback warnings are preserved. The current API only has
  human-readable warnings, so a small known-message recognizer adds a friendly
  fallback label without hiding the original message.
- Weather, training claims, model selectors, unsupported transport controls and
  account features are absent because the accepted API does not support them.
- Local favorites are implemented; durable saved plans and feedback storage are
  not claimed. The foundation's feedback queue is in memory and lost on restart.

See `docs/ux/TEAM-03-UX.md`, `docs/ux/TEAM-03-VERIFICATION.md`,
`docs/pitch/TEAM-03-DEFENSE.md` and `docs/requests/team-03-frontend-integration.md`.
