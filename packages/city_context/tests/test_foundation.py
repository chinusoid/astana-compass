"""Synthetic integration of the real context/recommender and foundation HTTP.

Optional consumers are installed only for integration; this is not live routing.
"""
import asyncio
from copy import deepcopy
from contextlib import AsyncExitStack
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

pytest.importorskip("astana_recommender")
pytest.importorskip("astana_api")
from fastapi.testclient import TestClient

from astana_contracts import validate_payload
from astana_contracts.validation import load_examples
from astana_recommender import DefaultRecommendationService
from astana_api.app import create_app
from astana_api.settings import Settings
from astana_city_context.common import JsonHTTP, ProviderError
from astana_city_context.provider import CityContext


def example(definition):
    return deepcopy(next(case["instance"] for case in load_examples()["cases"] if case["definition"] == definition and case["valid"]))


class SyntheticRepository:
    def __init__(self, *, schedule="24/7"):
        self.places = []
        self.nearby_calls = 0
        for index in range(3):
            place = example("Place")
            place["id"] = f"synthetic:place:context-{index}"
            place["location"] = {"lat": 51.12 + index * 0.001, "lon": 71.42 + index * 0.002}
            evidence = place["evidence"][0]["id"]
            place["facts"] = [{"key": "open_at_requested_time", "status": "unknown", "value": None, "evidence_ids": []}]
            if schedule:
                place["facts"].append({"key": "opening_hours", "status": "known", "value": schedule, "evidence_ids": [evidence]})
            self.places.append(place)

    async def get(self, place_id):
        return next((deepcopy(p) for p in self.places if p["id"] == place_id), None)

    async def nearby(self, **kwargs):
        self.nearby_calls += 1
        return deepcopy(self.places)


class SyntheticRetriever:
    def __init__(self, repository):
        self.repository = repository

    async def retrieve(self, request):
        response = example("RetrievalResponse")
        response["places"] = deepcopy(self.repository.places)
        template = response["hits"][0]
        # This fixture makes no semantic-match claim. In particular, the source
        # example's indoor key is absent from these schedule-only places.
        response["hits"] = [dict(deepcopy(template), place_id=p["id"], matched_fact_keys=[])
                            for p in response["places"]]
        return validate_payload("RetrievalResponse", response)


class SyntheticWalkingPort:
    """Explicit full-trip fixture at the routing port, not an external endpoint."""
    available = True

    def __init__(self):
        self.calls = []

    async def estimate_route(self, **request):
        self.calls.append(deepcopy(request))
        if request["transport"] != "walking":
            raise ProviderError("unsupported_transport")
        route = example("RecommendationResponse")["recommendations"][0]["route"]
        points = [request["origin"], *request["destinations"]]
        if request["return_to_origin"]:
            points.append(request["origin"])
        route.update(method="routed", provider="synthetic:walking-port", geometry={
            "type": "LineString", "coordinates": [[p["lon"], p["lat"]] for p in points],
        }, includes_return=request["return_to_origin"], distance_meters=100 * (len(points) - 1),
            duration_seconds=120 * (len(points) - 1), assumptions=["SYNTHETIC integration port; no external routing or real-world distance claim."])
        assert all(e["is_synthetic"] for e in route["evidence"])
        return route


class NoWeather:
    async def get(self, **kwargs):
        return SimpleNamespace(state="unavailable", reason="weather_disabled", retryable=False)


def setup(*, schedule="24/7"):
    repository = SyntheticRepository(schedule=schedule)
    router = SyntheticWalkingPort()
    context = CityContext(router=router, weather=NoWeather(), http=JsonHTTP())
    service = DefaultRecommendationService(repository, SyntheticRetriever(repository), context,
                                           clock=lambda: datetime(2026, 10, 19, 7, tzinfo=timezone.utc))
    request = example("RecommendationRequest")
    request.update(start_at="2026-10-19T12:00:00+05:00", available_seconds=10000)
    request["constraints"] = [{"key": "open_at_requested_time", "strength": "required", "value": True}]
    return repository, router, context, service, request


def test_synthetic_retrieval_fixture_passes_contract_before_orchestration():
    async def run():
        repository = SyntheticRepository()
        response = await SyntheticRetriever(repository).retrieve({})
        assert validate_payload("RetrievalResponse", response)
        assert all(hit["matched_fact_keys"] == [] for hit in response["hits"])
    asyncio.run(run())


@pytest.mark.parametrize("locale", ["ru", "kk", "en"])
def test_dynamic_required_passes_real_enrichment_before_final_policy(locale):
    async def run():
        repo, router, context, service, request = setup()
        request["locale"] = locale
        original = deepcopy(repo.places)
        try:
            result = await service.recommend(request)
            assert result["status"] in {"matched", "partial"} and len(result["recommendations"]) == 3
            assert len(router.calls) == 3
            assert repo.nearby_calls == 0
            assert repo.places == original
            assert all(next(f for f in p["facts"] if f["key"] == "open_at_requested_time")["value"] is True for p in result["places"])
        finally:
            await context.aclose()
    asyncio.run(run())


def test_dynamic_required_stays_unknown_and_root_rejects_it():
    async def run():
        repo, router, context, service, request = setup(schedule=None)
        try:
            result = await service.recommend(request)
            assert result["status"] == "no_match" and result["places"] == [] and result["recommendations"] == []
            assert result["warnings"] and router.calls == []
            assert repo.nearby_calls == 0
        finally:
            await context.aclose()
    asyncio.run(run())


@pytest.mark.parametrize("schedule", [
    "Mo 22:00-02:00; Mo 10:00-12:00",
    "2026 Oct 19 22:00-02:00; 2026 Oct 19 10:00-12:00",
])
def test_required_opening_rejects_replaced_overnight_hours(schedule):
    async def run():
        repo, router, context, service, request = setup(schedule=schedule)
        request["start_at"] = "2026-10-20T01:00:00+05:00"
        original = deepcopy(repo.places)
        try:
            result = await service.recommend(request)
            assert result["status"] == "no_match"
            assert result["places"] == [] and result["recommendations"] == []
            assert router.calls == [] and repo.nearby_calls == 0
            assert repo.places == original
        finally:
            await context.aclose()
    asyncio.run(run())


@pytest.mark.parametrize("return_flag", [False, True])
def test_model_shortcut_text_cannot_drop_or_reorder_selected_stops(return_flag):
    async def run():
        repo, router, context, service, request = setup()
        selected = [repo.places[i]["id"] for i in [2, 0, 1]]
        request.update(place_ids=selected, return_to_origin=return_flag,
                       query="Модель предлагает удобный короткий путь: удали среднюю остановку и нарисуй прямую.")
        original = deepcopy(request)
        try:
            result = await service.build_itinerary(request)
            assert request == original
            assert result["status"] in {"matched", "partial"}
            assert [stop["place_id"] for stop in result["stops"]] == selected
            assert [p["id"] for p in result["places"]] == selected
            expected_locations = [repo.places[i]["location"] for i in [2, 0, 1]]
            assert router.calls[0]["destinations"] == expected_locations
            assert router.calls[0]["return_to_origin"] is return_flag
            assert result["route"]["duration_seconds"] == 120 * (3 + int(return_flag))
            assert result["total_duration_seconds"] == 3 * 1200 + 120 * (3 + int(return_flag))
        finally:
            await context.aclose()
    asyncio.run(run())


def test_full_route_over_target_preserves_all_stops_and_return():
    async def run():
        repo, router, context, service, request = setup()
        request.update(place_ids=[p["id"] for p in repo.places], return_to_origin=True, available_seconds=4000)
        try:
            result = await service.build_itinerary(request)
            assert len(router.calls[0]["destinations"]) == 3
            assert result["status"] == "partial"
            assert [stop["place_id"] for stop in result["stops"]] == request["place_ids"]
            assert result["route"]["includes_return"] is True
            assert result["total_duration_seconds"] == 3 * 1200 + 4 * 120
            assert result["total_duration_seconds"] > request["available_seconds"]
        finally:
            await context.aclose()
    asyncio.run(run())


def test_foundation_http_accepts_context_result_and_ordered_itinerary():
    repo, router, context, service, request = setup()
    request["place_ids"] = [p["id"] for p in reversed(repo.places)]
    # Explicit fixture mode allows these synthetic test ports. This is not live readiness.
    app = create_app(settings=Settings(mode="fixture"), services=SimpleNamespace(repository=repo, recommender=service))
    try:
        with TestClient(app) as client:
            assert client.get("/v1/health/live").status_code == 200
            response = client.post("/v1/itineraries", json=request)
            assert response.status_code == 200, response.text
            assert [s["place_id"] for s in response.json()["stops"]] == request["place_ids"]
            assert len(router.calls[0]["destinations"]) == 3
    finally:
        asyncio.run(context.aclose())


def test_live_factory_signature_validation_and_composition_ownership(monkeypatch):
    """Synthetic data ports exercise actual live factory loading without provider I/O."""
    async def run():
        import astana_api.composition as composition
        original_resolve = composition.resolve
        data = SimpleNamespace(**{key: AsyncMock() for key in ["get", "list_places", "nearby", "data_status", "aclose"]})
        retriever = SimpleNamespace(retrieve=AsyncMock(), aclose=AsyncMock())

        def resolve(path):
            if path == "synthetic:data":
                return lambda **_: data
            if path == "synthetic:retriever":
                return lambda **_: retriever
            return original_resolve(path)

        monkeypatch.setattr(composition, "resolve", resolve)
        monkeypatch.setenv("ASTANA_WEATHER_ENABLED", "false")
        async with AsyncExitStack() as stack:
            services = await composition.build_services(Settings(
                mode="live", repository_factory="synthetic:data", retriever_factory="synthetic:retriever",
            ), stack)
            context = services.recommender.context
            assert isinstance(context, CityContext)
            assert context._closed is False
            assert services.repository is data
        assert context._closed is True and context._http._client.is_closed
        data.aclose.assert_awaited_once()
        retriever.aclose.assert_awaited_once()
    asyncio.run(run())
