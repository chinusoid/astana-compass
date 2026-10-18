# Team 02: coordinator workspace integration request

Status: proposed; no shared files changed. Target package version `astana-city-context==0.1.0`.

Please add `packages/city_context` to root `[tool.uv.workspace].members`,
`astana-city-context` to root project dependencies (or the API's dependencies,
according to deployment packaging), and
`astana-city-context = { workspace = true }` to `[tool.uv.sources]`. Include
`packages/city_context/tests` in root pytest discovery and regenerate the shared
uv lock with the existing supported Python version. No API factory config changes
are needed: `astana_city_context:create_context` already matches foundation.

The module-specific manifest declares `astana-contracts>=0.1.0,<0.2`,
`httpx>=0.28,<1`, and `tzdata>=2025.2`; pytest is an optional test dependency.
`httpx` is a runtime dependency here, needed for bounded async provider requests;
`tzdata` ensures Asia/Almaty conversion works on minimal container images. These
versions are compatible with the foundation ranges. No global lockfile or root
manifest was edited by Team 02. Proposed consumers are API composition and its
injected recommender; the frontend sees unchanged canonical JSON.

Run `uv sync --locked --all-packages`, context unit tests, existing API/recommender
tests, schema verification and generated-copy drift checks after integration.
Fixture mode must still use explicitly synthetic fixture adapters. In live mode,
missing data/search modules must keep readiness 503; installing context must not
enable synthetic POI. Missing ORS key yields an explicit approximate estimate
unless `ASTANA_ROUTE_ALLOW_APPROXIMATE=false`; it never enables fixture mode.

Add the env names from `packages/city_context/README.md` to the backend example
when accepting this request; never add values or frontend secrets. Default weather
is disabled pending operator confirmation of permitted free-hosted use. Weather
wire extension and per-arrival orchestration are separate requests, not implied
by this workspace change.
