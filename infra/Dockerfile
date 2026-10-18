# Immutable upstream manifest digests verified against official registries.
FROM ghcr.io/astral-sh/uv:0.13.1@sha256:4a1f3666816dafadd20ceb71eac9a7d56d7ef30279f7d64048519ab901ada336 AS uv
FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258 AS builder
COPY --from=uv /uv /uvx /usr/local/bin/
ENV UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1
WORKDIR /app
COPY pyproject.toml uv.lock ./
# Copy the complete registered workspace, including city_data and retrieval.
COPY packages ./packages
COPY services ./services
RUN uv sync --locked --all-packages --no-dev --no-editable
# Detect omitted workspace/dependency registration before producing an image.
RUN /opt/venv/bin/python -c "from astana_city_data import create_repository; from astana_retrieval import create_retriever; from astana_city_context import create_context"

FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258 AS runtime
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    ASTANA_MODE=fixture \
    LLM_PROVIDER=none
RUN groupadd --gid 10001 astana && useradd --uid 10001 --gid 10001 --no-create-home astana
WORKDIR /app
COPY --from=builder /opt/venv /opt/venv
# No source snapshot is baked into the runtime. Live deployments must explicitly
# mount a validated file and set ASTANA_POI_PATH; fixture remains an explicit mode.
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=4 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/v1/health/ready', timeout=3).close()"]
CMD ["uvicorn", "astana_api.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
