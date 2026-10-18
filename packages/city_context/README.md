# Astana city context

Installable Python package implementing the agreed `astana_contracts.ContextProvider`.
The only integration export is `astana_city_context:create_context`:

```python
from astana_city_context import create_context

context = await create_context(config={"mode": "live", "timezone": "Asia/Almaty"})
try:
    result = await context.enrich_places(places=places, request=request)
    route = await context.estimate_route(
        origin=request["origin"], destinations=[p["location"] for p in places],
        transport=request["transport"], return_to_origin=request["return_to_origin"],
        start_at=request["start_at"],
    )
finally:
    await context.aclose()
```

`enrich_places` returns validated `ContextResult`, preserving every candidate and
source fact/evidence on independent copies. Source fact `opening_hours` supplies
the documented conservative OSM-style string subset. `open_at_requested_time` is
always recalculated for the requested instant in Asia/Almaty. Missing, unsupported
and holiday-dependent schedules stay unknown; source conflicts stay conflicting.
Published hours do not establish that a venue actually operates today.

Routing uses the real ORS `foot-walking` GeoJSON endpoint, checking the complete
ordered trip, every leg and waypoint. Cycling and driving raise the safe
`unsupported_transport` error. Missing credentials or upstream failure produce
an explicit local great-circle approximation with **null geometry**, or a safe
error under the strict policy. No fixture mode is selected by this package.
Walking does not imply wheelchair accessibility.

Open-Meteo weather is opt-in and internal. Its normalized reading never appears
as an unvalidated field in `ContextResult`; only failure/disabled/stale status is
reported through existing warnings and `degraded_services`. No weather safety or
`weather_suitable` claim is generated. Existing request-time weather facts are
reset to unknown so an earlier request cannot supply current evidence.

## Reproducible isolated install and checks

Run from the repository root with Python 3.12 and uv. This does not change the
coordinator's root workspace or lockfile:

```sh
uv venv --python 3.12 /tmp/astana-context-venv
uv pip install --python /tmp/astana-context-venv/bin/python \
  -e packages/contracts -e 'packages/city_context[test]' 'ruff>=0.11,<1'
/tmp/astana-context-venv/bin/python -m pytest packages/city_context/tests
/tmp/astana-context-venv/bin/ruff check packages/city_context
/tmp/astana-context-venv/bin/python verify_contracts.py
/tmp/astana-context-venv/bin/python scripts/generate_contracts.py --check
```

The optional synthetic foundation tests use the existing API and recommender:

```sh
uv pip install --python /tmp/astana-context-venv/bin/python \
  -e packages/recommender -e packages/ai_providers -e services/api
/tmp/astana-context-venv/bin/python -m pytest packages/city_context/tests tests/integration
```

No unit test calls a hosted provider. Explicit synthetic fixtures and injected
ports verify integration behavior; they do not demonstrate real POI ingestion,
external route availability or weather accuracy. See [verification](../../docs/context/verification.md)
for actual check results and live limitations. Coordinator workspace wiring is
requested in [team-02-integration](../../docs/requests/team-02-integration.md).

## Backend environment

| Variable | Default / meaning |
|---|---|
| `ROUTING_PROVIDER` | `openrouteservice`; other providers rejected |
| `ROUTING_API_KEY` | Private ORS key; `ORS_API_KEY` is an alias, canonical name wins |
| `ASTANA_ROUTE_ALLOW_APPROXIMATE` | `true`; `false` fails if a full routed trip cannot be verified |
| `ASTANA_WALKING_PACE_MPS` | Optional positive speed in m/s; default provider duration for routed trips, 1.25 m/s for local estimates |
| `ASTANA_CONTEXT_TIMEOUT_SECONDS` | `6`; total per-provider deadline including retries, range (0,30] seconds; keep below orchestration deadline |
| `ASTANA_CONTEXT_RETRIES` | `1`; integer 0–2; transient failures only, never immediate 429 retries |
| `WEATHER_PROVIDER` | `open_meteo`; other providers rejected |
| `ASTANA_WEATHER_ENABLED` | `false`; opt in only for permitted noncommercial use of the free endpoint |

Boolean values accept `true`, `false`, `1`, `0` (case-insensitive). Keys are never
read from frontend configuration. Import/factory initialization performs no
network request. Shared HTTP resources are closed both on partial initialization
failure and normal shutdown. Provider error text, raw requests, credentials and
precise coordinates are not logged by the module.

`CityContext` permits dependency injection of routers and weather adapters for
offline tests and alternative implementations. It does not import another team's
private modules. HTTP retries are limited to safe weather GET and idempotent
route-calculation POST; response bodies are size-bounded, redirects disabled.
Caches are memory-only, bounded and expire explicitly; their source timestamps
are preserved. Provider quotas apply across processes/accounts: deployment must
coordinate the provider's actual shared allowances.

## Optional live walking smoke

Set a backend ORS key privately, then run from the isolated environment:

```sh
python -m astana_city_context.smoke
```

This sends a fixed public Astana landmark-area route to ORS (not the user's
location), requires `method=routed`, and prints only method/provider, full-trip
metrics, vertex count and timestamps. It never prints the key, exact locations
or raw response. Missing key exits explicitly; no approximation counts as a
successful live smoke. `ASTANA_WEATHER_ENABLED` stays false for this command.

## Detailed policies and pending coordination

- [Supported schedules and uncertainty](../../docs/context/schedules.md)
- [Routing validation, provenance, cache and provider terms](../../docs/context/routing.md)
- [Internal weather, units, provenance and terms](../../docs/context/weather.md)
- [Weather wire contract proposal](../../docs/requests/team-02-weather.md)
- [Arrival-time orchestration and route-leg proposal](../../docs/requests/team-02-arrivals.md)

The current API enriches at the trip's `start_at`, not each stop's arrival. A
successful start-time schedule check cannot establish that the venue stays open
until arrival or through a visit. Root owns that orchestration and final budget /
required-constraint checks. This package adds no hidden arrival fields and does
not claim that pending integration has been completed.
