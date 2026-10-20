# Separate live evaluation image. The existing infra/Dockerfile stays fixture-only.
# Reuse the repository's verified immutable upstream pins.
FROM ghcr.io/astral-sh/uv:0.13.1@sha256:4a1f3666816dafadd20ceb71eac9a7d56d7ef30279f7d64048519ab901ada336 AS uv
FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258 AS builder
COPY --from=uv /uv /uvx /usr/local/bin/
ENV UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY packages ./packages
COPY services ./services
RUN uv sync --locked --all-packages --no-dev --no-editable
COPY data/samples/astana-osm.json /snapshot/astana-osm.json
# Validate the exact public snapshot without querying any external provider.
RUN /opt/venv/bin/python -c "import asyncio,hashlib; from pathlib import Path; from astana_city_data.repository import SnapshotRepository; p=Path('/snapshot/astana-osm.json'); assert hashlib.sha256(p.read_bytes()).hexdigest() == '35e2ac72f0a10b00870ed323f4d8f313c9933c67b5115de5803e5e517211fdc2'; assert asyncio.run(SnapshotRepository(p).data_status())['total_places'] == 682"
RUN /opt/venv/bin/python -c "from astana_api import create_app; from astana_retrieval import create_retriever; from astana_city_context import create_context"

FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258 AS runtime
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=10000 \
    ASTANA_MODE=live \
    ASTANA_POI_PATH=/app/data/astana-osm.json \
    ASTANA_RETRIEVAL_POOL_LIMIT=1000 \
    LLM_PROVIDER=none
RUN groupadd --gid 10001 astana && useradd --uid 10001 --gid 10001 --no-create-home astana
RUN mkdir -p /app/data && chmod 0755 /app /app/data
WORKDIR /app
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /snapshot/astana-osm.json /app/data/astana-osm.json
# Keep parent directories traversable regardless of COPY implementation.
RUN chmod 0755 /app /app/data && chmod 0444 /app/data/astana-osm.json
# No ARG or build-time expansion of provider credentials. Runtime env only.
USER 10001:10001
# Verify final-stage access as the exact runtime UID, with no provider calls.
RUN python -c "import asyncio,hashlib,os,stat; from pathlib import Path; from astana_contracts import load_schema; from astana_city_data.repository import SnapshotRepository; p=Path('/app/data/astana-osm.json'); print('Runtime file access:', {'uid': os.getuid(), 'gid': os.getgid(), 'paths': [(str(q), q.exists(), oct(stat.S_IMODE(q.stat().st_mode)) if q.exists() else None, os.access(q, os.R_OK), os.access(q, os.X_OK)) for q in (Path('/app'), p.parent, p)]}, flush=True); assert os.getuid() == 10001 and os.getgid() == 10001, 'runtime UID/GID'; assert all(stat.S_IMODE(Path(d).stat().st_mode) & 0o777 == 0o755 and os.access(d, os.R_OK | os.X_OK) and not os.access(d, os.W_OK) for d in ('/app','/app/data')), 'catalog directory permissions'; assert stat.S_IMODE(p.stat().st_mode) == 0o444, 'catalog file permissions'; assert hashlib.sha256(p.read_bytes()).hexdigest() == '35e2ac72f0a10b00870ed323f4d8f313c9933c67b5115de5803e5e517211fdc2', 'catalog hash'; print('Runtime UID, directory permissions and catalog hash verified', flush=True); load_schema(); print('Installed canonical schema is readable', flush=True); assert asyncio.run(SnapshotRepository(p).data_status())['total_places'] == 682, 'snapshot validation'"
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["python", "-c", "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT','10000') + '/v1/health/ready', timeout=3).close()"]
# Exactly one worker: local quotas and guest rooms are process-local. Shell exec
# forwards Render's SIGTERM to uvicorn rather than leaving an intermediate shell.
CMD ["sh", "-c", "exec uvicorn astana_api.app:create_app --factory --host 0.0.0.0 --port \"${PORT:-10000}\" --workers 1 --no-access-log"]
