"""Composition validates adapter structure without probing providers."""

import asyncio
from contextlib import AsyncExitStack
from dataclasses import replace
from importlib.resources import files
import json
from types import ModuleType

from fastapi.testclient import TestClient
import pytest

from astana_api import create_app
from astana_api.composition import build_services, validate_port
from astana_api.fixtures import FixtureContext, FixtureRepository, FixtureRetriever
from astana_api.settings import Settings
from astana_contracts import ContextProvider, PlaceRepository, validate_payload


def factories(monkeypatch, *, repository=None, retriever=None, context=None):
    module = ModuleType("astana_test_composition_factories")
    module.repository = repository or (lambda *, config: FixtureRepository())
    module.retriever = retriever or (
        lambda *, repository, config: FixtureRetriever(repository)
    )
    module.context = context or (lambda *, config: FixtureContext())
    monkeypatch.setitem(__import__("sys").modules, module.__name__, module)
    return Settings(
        mode="live",
        repository_factory=f"{module.__name__}:repository",
        retriever_factory=f"{module.__name__}:retriever",
        context_factory=f"{module.__name__}:context",
    )


def valid_request():
    examples = json.loads(
        files("astana_contracts").joinpath("data/contracts.examples.json").read_text()
    )
    return next(case["instance"] for case in examples["cases"] if case["name"] == "request_valid")


def test_none_context_factory_fails_startup_and_recommendations_closed(monkeypatch):
    settings = factories(monkeypatch, context=lambda *, config: None)
    with TestClient(create_app(settings)) as client:
        assert client.app.state.services is None
        assert client.get("/v1/health/live").status_code == 200
        readiness = client.get("/v1/health/ready")
        assert readiness.status_code == 503
        validate_payload("HealthResponse", readiness.json())
        response = client.post("/v1/recommendations", json=valid_request())
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "provider_unavailable"
        validate_payload("ErrorResponse", response.json())


@pytest.mark.parametrize("stage", ["repository", "retriever", "context", "generator", "intent"])
def test_startup_diagnostics_do_not_log_exception_secrets(monkeypatch, caplog, stage):
    secret = "private-startup-api-key-and-provider-payload"

    class SecretStartupError(RuntimeError):
        def __str__(self):
            raise AssertionError("Startup diagnostics must not stringify provider exceptions")

    def fail(**kwargs):
        raise SecretStartupError(secret)

    if stage in {"repository", "retriever", "context"}:
        settings = factories(monkeypatch, **{stage: fail})
    else:
        settings = factories(monkeypatch)
        if stage == "generator":
            settings = replace(settings, llm_provider="openai", llm_model="test-model", llm_api_key=secret)
            monkeypatch.setattr("astana_ai_providers.create_generator", fail)
        else:
            monkeypatch.setattr("astana_ai_providers.intents.create_intent_analyzer", fail)

    with caplog.at_level("ERROR", logger="astana_api.app"):
        with TestClient(create_app(settings)) as client:
            assert client.app.state.services is None
            live = client.get("/v1/health/live")
            ready = client.get("/v1/health/ready")
            assert live.status_code == 200
            assert ready.status_code == 503
            validate_payload("HealthResponse", live.json())
            validate_payload("HealthResponse", ready.json())
            response = client.get("/v1/places")
            assert response.status_code == 503
            validate_payload("ErrorResponse", response.json())
            assert secret not in live.text + ready.text + response.text

    records = [record for record in caplog.records if record.name == "astana_api.app"]
    assert len(records) == 1
    record = records[0]
    assert record.getMessage() == f"Service initialization failed: stage={stage} exception=SecretStartupError"
    assert record.args == (stage, "SecretStartupError")
    assert not record.exc_info and record.exc_text is None and record.stack_info is None
    assert secret not in caplog.text


@pytest.mark.parametrize("role", ["repository", "retriever", "context"])
def test_none_factory_products_are_rejected_before_service_creation(monkeypatch, role):
    settings = factories(monkeypatch, **{role: lambda **kwargs: None})

    async def check():
        async with AsyncExitStack() as stack:
            with pytest.raises(ValueError, match="async port"):
                await build_services(settings, stack)

    asyncio.run(check())


@pytest.mark.parametrize("method", ["enrich_places", "estimate_route"])
def test_noncallable_context_methods_are_rejected_without_probing(monkeypatch, method):
    context = FixtureContext()
    setattr(context, method, "not callable")
    settings = factories(monkeypatch, context=lambda *, config: context)

    async def check():
        async with AsyncExitStack() as stack:
            with pytest.raises(ValueError, match=f"ContextProvider.{method}"):
                await build_services(settings, stack)

    asyncio.run(check())


def test_keyword_incompatible_async_context_is_rejected(monkeypatch):
    class WrongContext(FixtureContext):
        async def enrich_places(self, unrelated):
            raise AssertionError("Validation must not invoke this method.")

    settings = factories(monkeypatch, context=lambda *, config: WrongContext())

    async def check():
        async with AsyncExitStack() as stack:
            with pytest.raises(ValueError, match="ContextProvider.enrich_places"):
                await build_services(settings, stack)

    asyncio.run(check())


def test_repository_cannot_require_an_optional_contract_argument():
    class WrongRepository(FixtureRepository):
        async def list_places(self, *, bbox, query=None, categories=None, cursor=None, limit=50):
            raise AssertionError("Validation must not invoke this method.")

    with pytest.raises(ValueError, match="PlaceRepository.list_places"):
        validate_port(WrongRepository(), PlaceRepository)


def test_async_generator_is_not_an_awaitable_port():
    class WrongContext(FixtureContext):
        async def enrich_places(self, *, places, request):
            yield {"places": places, "warnings": [], "degraded_services": []}

    with pytest.raises(ValueError, match="ContextProvider.enrich_places"):
        validate_port(WrongContext(), ContextProvider)


def test_wrapper_functions_returning_awaitables_and_async_factories_remain_supported(monkeypatch):
    calls = []

    class WrappedContext(FixtureContext):
        def enrich_places(self, *args, **kwargs):
            calls.append("enrich")
            return super().enrich_places(*args, **kwargs)

        def estimate_route(self, *args, **kwargs):
            calls.append("route")
            return super().estimate_route(*args, **kwargs)

    async def context_factory(*, config):
        return WrappedContext()

    async def repository_factory(*, config):
        return FixtureRepository()

    settings = factories(monkeypatch, context=context_factory, repository=repository_factory)

    async def check():
        async with AsyncExitStack() as stack:
            services = await build_services(settings, stack)
            assert calls == []  # Composition must not make trial provider calls.
            result = await services.recommender.recommend(valid_request())
            validate_payload("RecommendationResponse", result)
            assert result["recommendations"]
            assert "enrich" in calls and "route" in calls

    asyncio.run(check())


def test_callable_objects_implementing_async_ports_are_supported():
    class AsyncCallable:
        async def __call__(self, *args, **kwargs):
            raise AssertionError("Validation must not invoke this method.")

    class Context:
        enrich_places = AsyncCallable()
        estimate_route = AsyncCallable()

    validate_port(Context(), ContextProvider)


def test_failed_validation_closes_created_resources_before_outer_stack_exits(monkeypatch):
    closed = []

    class Repository(FixtureRepository):
        async def aclose(self):
            closed.append("repository")

    class Retriever(FixtureRetriever):
        def close(self):
            closed.append("retriever")

    settings = factories(
        monkeypatch,
        repository=lambda *, config: Repository(),
        retriever=lambda *, repository, config: Retriever(repository),
        context=lambda *, config: None,
    )

    async def check():
        async with AsyncExitStack() as stack:
            with pytest.raises(ValueError, match="ContextProvider"):
                await build_services(settings, stack)
            assert closed == ["retriever", "repository"]
        assert closed == ["retriever", "repository"]

    asyncio.run(check())


def test_success_transfers_ownership_until_outer_stack_closes(monkeypatch):
    closed = []

    class Repository(FixtureRepository):
        async def aclose(self):
            closed.append("repository")

    class Context(FixtureContext):
        async def aclose(self):
            closed.append("context")

    settings = factories(
        monkeypatch,
        repository=lambda *, config: Repository(),
        context=lambda *, config: Context(),
    )

    async def check():
        async with AsyncExitStack() as stack:
            services = await build_services(settings, stack)
            assert services.repository is not None
            assert closed == []
        assert closed == ["context", "repository"]

    asyncio.run(check())


def test_invalid_optional_generator_is_rejected_and_closed(monkeypatch):
    closed = []

    class BadGenerator:
        generate = None

        async def aclose(self):
            closed.append("generator")

    monkeypatch.setattr("astana_ai_providers.create_generator", lambda **kwargs: BadGenerator())
    settings = Settings(
        llm_provider="openai", llm_model="test-model", llm_api_key="test-key"
    )

    async def check():
        async with AsyncExitStack() as stack:
            with pytest.raises(ValueError, match="ExplanationGenerator.generate"):
                await build_services(settings, stack)
            assert closed == ["generator"]

    asyncio.run(check())


def test_port_property_error_never_echoes_adapter_details():
    class BrokenContext:
        @property
        def enrich_places(self):
            raise RuntimeError("private-provider-token")

    with pytest.raises(ValueError) as caught:
        validate_port(BrokenContext(), ContextProvider)
    assert "private-provider-token" not in str(caught.value)


def test_valid_fixture_composition_is_unchanged():
    async def check():
        async with AsyncExitStack() as stack:
            services = await build_services(Settings(), stack)
            result = await services.recommender.recommend(valid_request())
            validate_payload("RecommendationResponse", result)
            assert result["recommendations"]
            assert all(place["is_synthetic"] for place in result["places"])

    asyncio.run(check())


@pytest.mark.parametrize("outer,budget", [(1, 0.1), (4, 2), (30, 26), (120, 26)])
def test_recommendation_work_leaves_headroom_inside_http_deadline(outer, budget):
    async def check():
        async with AsyncExitStack() as stack:
            services = await build_services(Settings(request_timeout_seconds=outer), stack)
            assert services.recommender.request_budget_seconds == budget
            assert services.recommender.planner_timeout_seconds == 10
            assert budget < outer
    asyncio.run(check())
