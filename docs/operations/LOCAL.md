# Local development and checks

The API defaults to `fixture`: synthetic places and approximate synthetic routes, clearly marked in responses. Explicit live mode uses the bundled 300-place OSM snapshot and local multilingual lexical retrieval. Neither mode requires PostgreSQL; the optional database profile prepares a future PostgreSQL/pgvector backend. For PowerShell launch/check commands, see [Windows instructions](WINDOWS.md).

## Start the API

Use Python 3.12–3.14 and [uv](https://docs.astral.sh/uv/getting-started/installation/) on PATH. CI and container tooling pin uv 0.13.1; the container uses Python 3.12. Run from the checkout root:

```sh
bash scripts/dev.sh
```

The helper runs `uv sync --locked --all-packages` and then the factory `astana_api.app:create_app`. It listens on `127.0.0.1:8000`, disables HTTP access logs, and defaults to `ASTANA_MODE=fixture` and `LLM_PROVIDER=none`. It uses the committed lockfile; an absent or stale lock is an error for the coordinator to resolve, not an instruction to silently regenerate it.

Additional uvicorn arguments are forwarded explicitly, for example:

```sh
bash scripts/dev.sh --reload
```

Keep the default loopback host for local work. Overriding `--host` is an explicit operator choice. No script deploys or publishes the service.

Check readiness and browse the synthetic dataset:

```sh
curl --fail http://127.0.0.1:8000/v1/health/ready
curl --fail http://127.0.0.1:8000/v1/data-status
curl --fail http://127.0.0.1:8000/v1/places
```

`/v1/health/live` is process liveness; `/v1/health/ready` is readiness for the configured local services. It does not promise live uptime of every remote provider.

## Run the checks

Install Node.js 24.19.0 with npm for the shared TypeScript check, then run:

```sh
bash scripts/check.sh
```

The helper installs the complete locked Python workspace, including `city_data`, `retrieval`, `ai_providers` and `city_context`, and runs pytest, all canonical contract fixtures, generated-artifact synchronization, Ruff `E9,F` checks and the shared TypeScript compiler. The compiler is pinned separately in `.github/typescript/package-lock.json`; it does not modify the application or root JavaScript lockfiles. `npm ci --ignore-scripts` installs only that isolated compiler environment. The Windows `scripts/check.ps1` also runs frontend types, lint, unit tests and production build, with pinned `pnpm dlx npm@11.6.2` fallback if npm is unavailable.

GitHub Actions runs these checks on pull requests and pushes to `main`, testing Python 3.12 and 3.14. A separate job builds the locked container and waits for readiness. The workflow has read-only repository permissions, uses no deployment credentials and never uses `pull_request_target`.

## Run with Docker Compose

Use Docker with access to its daemon and a recent Compose plugin:

```sh
docker compose -f infra/compose.yaml config --quiet
docker compose -f infra/compose.yaml up --build --detach --wait api
curl --fail http://127.0.0.1:8000/v1/health/ready
docker compose -f infra/compose.yaml down
```

The container listens on its internal network, while Compose publishes it only at `127.0.0.1:8000`. It runs as UID/GID 10001 with a read-only filesystem and writable temporary directory. The image builds non-editable installed workspace packages from `uv.lock`; the runtime does not need the checkout, a root-user process or a provider key. Docker-specific context exclusions omit environment files, credentials, local databases and dependency caches.

If `docker info` reports permission denied for the daemon socket, Compose configuration can still be validated, but image build/run remains unverified on that machine. Use a correctly configured Docker environment; do not infer container success from a YAML check.

## Optional PostgreSQL/pgvector

Create the local password file once. Its directory ignores every file except its own `.gitignore`:

```sh
mkdir -p infra/secrets
(umask 077; openssl rand -hex 32 > infra/secrets/postgres_password)
docker compose -f infra/compose.yaml --profile database up --detach --wait postgres
docker compose -f infra/compose.yaml exec postgres psql -U astana -d astana -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

Do not regenerate the file after initializing an existing database volume without deliberately rotating the database password too. PostgreSQL initializes its password only for a new data directory. The profile uses database/user `astana`, a Compose file secret, and a persistent named volume. Its port is bound to `127.0.0.1:5432`. `docker compose down` retains the volume.

The image supplies pgvector. Application schema migrations and PostgreSQL repository/index wiring remain future work. The current live repository reads an immutable JSON snapshot and the retriever uses BM25 plus a RU/KK/EN lexicon; starting this profile alone neither changes that backend nor enables embeddings.

## Configure real adapters and optional LLMs

Data, retrieval and context modules are installed and locked. The repository needs an explicit snapshot path; the committed OSM sample contains 300 real records with source attribution and a reproducible import manifest. From the repository root:

```sh
export ASTANA_MODE=live
export ASTANA_POI_PATH="$PWD/data/samples/astana-osm.json"
export ASTANA_REPOSITORY_FACTORY=astana_city_data:create_repository
export ASTANA_RETRIEVER_FACTORY=astana_retrieval:create_retriever
export ASTANA_CONTEXT_FACTORY=astana_city_context:create_context
bash scripts/dev.sh
```

Live factories must match these `module:function` boundaries or be explicitly configured. Missing live adapters fail startup; the API must not silently substitute synthetic data. Each provider adapter documents its required server-side environment separately. The helper reads the process environment and does not automatically load `.env`.

The sample was downloaded on 2026-10-18 at 22:30:43 UTC. It is a bounded named-category selection, not complete city coverage. Only one place has a source description and 86 have opening hours; unknown amenities remain unknown. [Import/provenance and coverage](../data/README.md), [OSM data license](../../data/samples/README.md), [update command](../../packages/city_data/README.md). Import runs separately from API requests; restart the API to load a replaced snapshot. The freshness warning is based on import/OSM replica time and does not certify facts on the ground.

Live retrieval is local BM25 with a small RU/KK/EN lexicon and a bounded nearest-place pool. No semantic embeddings or paid inference are used by that retriever. [Synthetic evaluation and real snapshot smoke](../retrieval/QUALITY.md) are distinct; neither establishes complete coverage or independent end-to-end recommendation quality.

Context uses `ROUTING_PROVIDER=openrouteservice` and backend `ROUTING_API_KEY` (or `ORS_API_KEY`). Without a key, `ASTANA_ROUTE_ALLOW_APPROXIMATE=true` permits explicitly approximate null-geometry estimates; set it to `false` to require routing. `ASTANA_CONTEXT_TIMEOUT_SECONDS=6` and `ASTANA_CONTEXT_RETRIES=1` bound provider I/O. Weather is internal and disabled by default (`ASTANA_WEATHER_ENABLED=false`); enabling it requires reviewing the provider terms. See [context configuration](../../packages/city_context/README.md). Fixture mode continues using its synthetic adapters.

The default `LLM_PROVIDER=none` uses deterministic explanations. Optional provider configuration uses `LLM_PROVIDER=openai` or `nvidia`, an explicitly selected `LLM_MODEL`, and the server-only `OPENAI_API_KEY` or `NVIDIA_API_KEY` (`LLM_API_KEY` is the shared fallback). Provider keys are never Docker build arguments or frontend configuration. They are supplied to the server process at runtime. Do not put them in `NEXT_PUBLIC_*` variables or commit a populated environment file.

Set `CORS_ORIGINS` to explicit comma-separated frontend origins, for example `http://localhost:3000,http://127.0.0.1:3000`. Wildcards are rejected by the settings layer. Access logging stays disabled by default to avoid persisting precise query locations in request URLs.
