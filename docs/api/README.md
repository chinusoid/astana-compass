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

Default imports are `astana_city_data`, `astana_retrieval`, `astana_city_context`. `config` currently contains `mode='live'` and `timezone='Asia/Almaty'`. Adapters read their own documented server-side env. Implement `aclose()` for async resource cleanup (or synchronous `close()`). Factories must release partial resources if initialization fails before returning. The API closes successfully created resources at shutdown. Ports are defined in `astana_contracts`; root schemas remain canonical. The context package is registered in the workspace and API runtime dependencies. Data/search packages still require integration.

## Context configuration

`astana_city_context:create_context` is installed in the workspace and container. It derives opening status for the supplied `start_at` in Asia/Almaty, preserves source facts, and estimates complete ordered walking trips including the requested return. Opening status does not yet establish opening at a later arrival or throughout a visit. Unsupported schedules stay unknown.

Configure the server-only `ROUTING_API_KEY` (or `ORS_API_KEY`) for ORS. Missing or invalid routing responses can produce a clearly marked approximate route with null geometry; `ASTANA_ROUTE_ALLOW_APPROXIMATE=false` rejects that fallback. Weather remains internal, disabled by default and absent from the public v0.1 schema. See [module settings and limits](../../packages/city_context/README.md). These adapters do not make live mode ready without real data and retrieval.

## AI configuration

Set `LLM_PROVIDER=openai` and `LLM_MODEL` plus `OPENAI_API_KEY`, or `LLM_PROVIDER=nvidia` and `LLM_MODEL` plus `NVIDIA_API_KEY`. `LLM_API_KEY` is an alternate server-only key. `none` disables external generation. Values are loaded from environment; copying `.env.example` does not automatically load secrets. Model names have no guessed default. The optional provider gets a reduced grounding payload; it does not get the user's coordinate object. See `packages/ai_providers/README.md` and `docs/ai/TRAINING.md` for its precise privacy and generation boundaries. No live model call or training is implied by passing mocked tests.

## Operational boundaries

- 32 KiB request body cap including chunked requests; 10-second receive deadline.
- 2,000-character query limit and 20 constraints, up to 100 list results, fixed CORS origins.
- Before synchronous schema validation, HTTP JSON is limited to 2,048 value nodes, depth 16, 64 items per array/object, 512-character object keys and 8,192-character string values. These operational caps also apply when a larger body cap is configured; they are not new semantic constraint types.
- Bounded concurrency and request timeout, safe error envelopes, generated request IDs, no input/provider text in error responses.
- `X-Astana-Data-Mode`, `X-Request-ID`, `Cache-Control: no-store`; disable HTTP access logs because list URL queries can carry private text.
- Anonymous feedback is an explicitly submitted, bounded **in-memory** queue. It is lost on restart. No durable analytics/export or automatic training from feedback is implemented.
- The app has no per-user rate limit or public edge protection; shared concurrency limits are local per worker. Configure ingress quotas/body/time limits before a public deployment.
- Real POI ingestion, embeddings, natural-language constraint extraction, frontend and persistent feedback still need integration. Hosted routing/weather availability requires separate credentialed validation; offline tests do not establish it. No endpoint silently infers hard constraints from prose.

Run `uv run pytest tests/integration` for API tests; full workspace checks are in `scripts/check.sh`.
