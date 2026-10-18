# HTTP integration foundation

The API composes shared validated contracts and `DefaultRecommendationService` with independently owned data, retrieval and context adapters. All `/v1` endpoints in `CONTRACTS.md` are implemented. `/docs` provides OpenAPI from the same canonical schema, with runnable, explicitly synthetic request examples.

`/` opens `/sandbox`, a small same-origin developer testing screen packaged with the API. It makes real API calls, exposes the response's data mode, and provides request/response JSON for debugging. No CDN, map tiles, geolocation, key inputs or browser persistence are used. This utility is separate from the Team 03 product frontend. See [testing instructions](../operations/TESTING.md).

## Run

From repository root, `uv sync --locked`, then `uv run uvicorn astana_api.app:create_app --factory --host 127.0.0.1 --port 8000 --no-access-log`. `ASTANA_MODE=fixture` is the default. It serves **three synthetic places only**, distance-based candidate selection (query intent is ignored), and an explicitly approximate route with no geometry. These adapters are integration tooling, not a second implementation of team modules.

`ASTANA_MODE=live` loads the team factories below. Missing imports/configuration result in liveness 200 and readiness/API 503. It never substitutes fixture data. All returned place payloads reject synthetic markers in live mode. In live mode readiness requires a populated source with a successful import (ready or explicitly stale), a positive total count, and a valid non-synthetic sample place. It does not probe the retrieval index. Essential readiness probes repository data status; it does not guarantee every external provider is up. Optional generation failures produce a clearly reported deterministic fallback. This is not a deployed public service.

## Factory contract for teams

Factories may return their resource directly or an awaitable. Composition verifies required callable methods and inspectable signatures before reporting readiness; invalid factory products fail closed and partially created clients are closed. It does not make trial provider calls. Correct wrappers returning awaitables remain supported. Define keyword arguments exactly:

```python
# Team 01
create_repository(*, config: dict) -> PlaceRepository
create_retriever(*, repository: PlaceRepository, config: dict) -> Retriever
# Team 02
create_context(*, config: dict) -> ContextProvider
```

Default imports are `astana_city_data`, `astana_retrieval`, `astana_city_context`. `config` currently contains `mode='live'` and `timezone='Asia/Almaty'`. Adapters read their own documented server-side env. Implement `aclose()` for async resource cleanup (or synchronous `close()`). Factories must release partial resources if initialization fails before returning. The API closes successfully created resources at shutdown. Ports are defined in `astana_contracts`; root schemas remain canonical. Data, retrieval and context packages are registered in the workspace and API runtime dependencies.

## Data and retrieval configuration

Set server-side `ASTANA_POI_PATH` to a valid snapshot, for example the committed `data/samples/astana-osm.json` with 300 real OSM POI. The repository validates the snapshot, loads it once and returns independent records; missing/corrupt data fails closed. A separate bounded Overpass importer creates/replaces the snapshot and manifest. It is never called by a user HTTP request. Restart the API after importing a replacement. Source attribution and ODbL terms are in [the data documentation](../data/README.md).

`ASTANA_POI_STALE_SECONDS` defaults to 604800 (seven days). `data-status` distinguishes ready/stale/unavailable/not_configured and reports import time; no status certifies current opening or accessibility. The sample has 86 opening-hours values and one source description. Unknown required facts cannot pass the recommender's final constraint check.

The retriever uses local BM25 and a versioned RU/KK/EN lexicon, with `score_kind=lexical` and explicit warnings. It makes one bounded nearby call, preserves evidence, and defers unknown/dynamic conditions for final context checks. `ASTANA_RETRIEVAL_POOL_LIMIT` defaults to 500; `ASTANA_RETRIEVAL_TIMEOUT_SECONDS` defaults to 5. There are no embeddings, vector index, network retrieval or paid inference in this adapter. [Ranking and configuration](../../packages/retrieval/README.md), [separate synthetic evaluation and snapshot smoke](../retrieval/QUALITY.md).

## Context configuration

`astana_city_context:create_context` is installed in the workspace and container. It derives opening status for the supplied `start_at` in Asia/Almaty, preserves source facts, and estimates complete ordered walking trips including the requested return. Opening status does not yet establish opening at a later arrival or throughout a visit. Unsupported schedules stay unknown.

Configure the server-only `ROUTING_API_KEY` (or `ORS_API_KEY`) for ORS. Missing or invalid routing responses can produce a clearly marked approximate route with null geometry; `ASTANA_ROUTE_ALLOW_APPROXIMATE=false` rejects that fallback. Weather remains internal, disabled by default and absent from the public v0.1 schema. See [module settings and limits](../../packages/city_context/README.md). These adapters do not make live mode ready without real data and retrieval.

## AI configuration

Set `LLM_PROVIDER=openai` and `LLM_MODEL` plus `OPENAI_API_KEY`, or `LLM_PROVIDER=nvidia` and `LLM_MODEL` plus `NVIDIA_API_KEY`. `LLM_API_KEY` is an alternate server-only key. `none` disables external generation. Values are loaded from environment; copying `.env.example` does not automatically load secrets. Model names have no guessed default. The optional provider gets a reduced grounding payload; it does not get the user's coordinate object. See `packages/ai_providers/README.md` and `docs/ai/TRAINING.md` for its precise privacy and generation boundaries. No live model call or training is implied by passing mocked tests.

## Operational boundaries

- 32 KiB request body cap including chunked requests; 10-second receive deadline.
- 2,000-character query limit and 20 constraints, up to 100 list results, fixed CORS origins.
- Before synchronous schema validation, HTTP JSON is limited to 2,048 value nodes, depth 16, 64 items per array/object, 512-character object keys and 8,192-character string values (24,000 only for SocialActionRequest photo data URLs). These operational caps also apply when a larger body cap is configured; they are not new semantic constraint types.
- Bounded concurrency and request timeout, safe error envelopes, generated request IDs, no input/provider text in error responses.
- `X-Astana-Data-Mode`, `X-Request-ID`, `Cache-Control: no-store`; disable HTTP access logs because list URL queries can carry private text.
- Anonymous feedback is an explicitly submitted, bounded **in-memory** queue. It is lost on restart. No durable analytics/export or automatic training from feedback is implemented.
- Public edge protection is not implemented. Social mutations have bounded per-session limits; traffic has a shared provider quota and cache. Limits and temporary stores are local per worker. Run one API worker for this demo; multiple independent workers do not share sessions. Configure ingress quotas/body/time limits and durable storage before a public deployment.
- A bounded real POI import and lexical retrieval are integrated. Embeddings, PostgreSQL/pgvector application wiring, broader verified source coverage and persistent feedback remain future work. The frontend and natural-language proposal review are integrated. Hosted inference/routing/weather availability requires separate live validation; offline tests do not establish it. No endpoint silently infers hard constraints from prose.

Run `uv run --locked pytest tests/integration` for API tests; use `scripts/check.sh` on POSIX or [scripts/check.ps1](../../scripts/check.ps1) on Windows. Browser E2E and live-provider checks remain separate.


## Intent, traffic and social endpoints

`POST /v1/intent` accepts canonical `IntentRequest` (`query`, `locale`) and returns `IntentResponse`: proposed time, categories, literal quoted evidence for preferred constraints and clarification questions. Only explicit review applies these proposals; required conditions are never inferred or weakened automatically. The selected LLM provider receives raw request text and locale for this endpoint. With `LLM_PROVIDER=none` or invalid/unavailable inference, local rules run with an explicit warning. See [intent behavior and tests](../ai/intent.md).

`POST /v1/traffic` accepts up to six public road points inside Astana. It queries the fixed TomTom flow endpoint using backend-only `TOMTOM_API_KEY`, rounds request points to 3 decimals, caches for 60 seconds and limits provider requests to 12/minute per process. It returns validated geometry/speeds/confidence and timestamp, or `not_configured` / `unavailable`; missing data never means empty roads. No caller's personal location is required. The UI expires flow after 90 seconds and distinguishes symbolic animation from vehicle counts.

Social routes are `POST /v1/social/session`, `GET /v1/social/state`, `POST /v1/social/action`, `GET /v1/social/events`. Session creation returns a random token once to the same-origin Next server; the browser receives only a HttpOnly, SameSite=Strict cookie. Secure is set on HTTPS. Backend stores a hash, not the raw token. State/actions require Bearer authentication; the public event list does not. `SocialActionRequest`, `SocialState`, `PartyState` and `CommunityEvents` are canonical definitions in the root schema. The Next social proxy restricts paths/methods, checks write origins and never returns the raw session token.

Guest profiles and rooms have a 24-hour maximum lifetime, and all data is lost on restart. Rooms contain at most 5 members; accepted friendship and accepted invitations are necessary to join. Planning uses optimistic revisions: membership/preferences changes invalidate pending results. Chat and voluntary shared points do not change the planning revision. Messages are capped at 50, photos at 6 per room; JPEG uploads are bounded and reject EXIF/IPTC metadata. Location is a single explicit point with a 15-minute TTL, removed on stop/leave/logout. Privacy revocations are exempt from ordinary mutation throttling. Community events are public, attributed, time-bounded and always unverified. There is no automatic promotion of community text into trusted recommendation facts.
