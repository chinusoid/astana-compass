"""Offline port/factory acceptance; all places are explicitly synthetic."""
import asyncio
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from astana_contracts import ContextProvider, ContractValidationError, validate_payload
from astana_contracts.validation import load_examples
from astana_city_context import create_context
from astana_city_context.common import JsonHTTP, ProviderError
from astana_city_context.provider import CityContext
from astana_city_context.routing import ORSWalkingRouter
from astana_city_context.weather import OpenMeteoWeather


def fixture(definition):
    return deepcopy(next(example["instance"] for example in load_examples()["cases"] if example["definition"] == definition and example["valid"]))


def inputs(schedule="Mo 09:00-18:00"):
    request = fixture("RecommendationRequest")
    request["start_at"] = "2026-10-19T07:00:00Z"  # Monday noon in Astana.
    request["constraints"] = [{"key": "open_at_requested_time", "value": True, "strength": "required"}]
    place = fixture("Place")
    place["facts"] = [{"key": "open_at_requested_time", "status": "unknown", "value": None, "evidence_ids": []}]
    if schedule is not None:
        place["facts"].append({"key": "opening_hours", "status": "known", "value": schedule, "evidence_ids": [place["evidence"][0]["id"]]})
    return place, request


def context(weather=None, available=False):
    http = JsonHTTP()
    router = ORSWalkingRouter(http, api_key=None)
    if available:
        router.api_key = "synthetic-test-key"
    return CityContext(router=router, weather=weather or OpenMeteoWeather(http), http=http)


@pytest.mark.parametrize("locale", ["ru", "kk", "en"])
def test_enrichment_unknown_required_becomes_known_without_mutation(locale):
    async def run():
        place, request = inputs()
        request["locale"] = locale
        originals = deepcopy((place, request))
        provider = context()
        try:
            assert isinstance(provider, ContextProvider)
            result = await provider.enrich_places(places=[place], request=request)
            assert validate_payload("ContextResult", result)
            assert (place, request) == originals
            assert result["places"][0] is not place
            assert result["places"][0]["id"] == place["id"]
            facts = {fact["key"]: fact for fact in result["places"][0]["facts"]}
            assert facts["open_at_requested_time"]["status"] == "known"
            assert facts["open_at_requested_time"]["value"] is True
            assert facts["open_at_requested_time"]["evidence_ids"] == facts["opening_hours"]["evidence_ids"]
            assert facts["open_at_requested_time"]["note"]
            assert set(result) == {"places", "warnings", "degraded_services"}
            assert any(s["service"] == "routing" and not s["retryable"] for s in result["degraded_services"])
        finally:
            await provider.aclose()
    asyncio.run(run())


@pytest.mark.parametrize("schedule", [None, "Mo sunrise-sunset", "Mo 09:00-18:00; PH off"])
def test_unknown_required_remains_unknown_with_reason(schedule):
    async def run():
        place, request = inputs(schedule)
        provider = context()
        try:
            result = await provider.enrich_places(places=[place], request=request)
            derived = next(f for f in result["places"][0]["facts"] if f["key"] == "open_at_requested_time")
            assert derived["status"] == "unknown" and derived["value"] is None and derived["evidence_ids"] == []
            assert derived["note"] and result["warnings"]
        finally:
            await provider.aclose()
    asyncio.run(run())


@pytest.mark.parametrize("timestamp", ["invalid", "2026-10-19T12:00:00", "2026-99-19T12:00:00Z"])
def test_invalid_timestamp_rejected_before_weather(timestamp):
    async def run():
        weather = SimpleNamespace(get=AsyncMock())
        provider = context(weather)
        place, request = inputs()
        request["start_at"] = timestamp
        try:
            with pytest.raises(ContractValidationError):
                await provider.enrich_places(places=[place], request=request)
            weather.get.assert_not_awaited()
        finally:
            await provider.aclose()
    asyncio.run(run())


def test_timeout_weather_degraded_without_losing_places_or_leaking_error():
    async def run():
        provider = context(SimpleNamespace(get=AsyncMock(side_effect=TimeoutError("secret"))))
        place, request = inputs()
        try:
            result = await provider.enrich_places(places=[place], request=request)
            assert result["places"][0]["id"] == place["id"]
            weather = next(s for s in result["degraded_services"] if s["service"] == "weather")
            assert weather == {"service": "weather", "reason": "weather_unavailable", "retryable": True}
            assert "secret" not in str(result) and "weather" not in result
        finally:
            await provider.aclose()
    asyncio.run(run())


def test_stale_weather_is_reported_without_exporting_reading():
    async def run():
        weather = SimpleNamespace(get=AsyncMock(return_value=SimpleNamespace(state="stale", reason="weather_stale", retryable=True, reading={"opaque": "not exported"})))
        provider = context(weather)
        place, request = inputs()
        try:
            result = await provider.enrich_places(places=[place], request=request)
            assert any(s["reason"] == "weather_stale" for s in result["degraded_services"])
            assert "opaque" not in str(result)
        finally:
            await provider.aclose()
    asyncio.run(run())


def test_stale_dynamic_facts_recomputed():
    async def run():
        place, request = inputs(None)
        source = place["evidence"][0]["id"]
        place["facts"] = [{"key": key, "status": "known", "value": True, "evidence_ids": [source]} for key in ["open_at_requested_time", "weather_suitable"]]
        provider = context()
        try:
            result = await provider.enrich_places(places=[place], request=request)
            assert all(f["status"] == "unknown" for f in result["places"][0]["facts"])
        finally:
            await provider.aclose()
    asyncio.run(run())


def test_factory_missing_key_is_live_approximate_not_fixture(monkeypatch):
    async def run():
        monkeypatch.delenv("ROUTING_API_KEY", raising=False)
        monkeypatch.delenv("ORS_API_KEY", raising=False)
        monkeypatch.setenv("ASTANA_WEATHER_ENABLED", "false")
        provider = await create_context(config={"mode": "live", "timezone": "Asia/Almaty"})
        try:
            route = await provider.estimate_route(origin={"lat": 51.12, "lon": 71.42}, destinations=[{"lat": 51.13, "lon": 71.43}], transport="walking", return_to_origin=True, start_at="2026-10-19T12:00:00+05:00")
            assert route["method"] == "approximate" and route["geometry"] is None
            assert all(not e["is_synthetic"] for e in route["evidence"])
        finally:
            await provider.aclose()
            await provider.aclose()
        with pytest.raises(ProviderError):
            await provider.enrich_places(places=[], request=inputs()[1])
    asyncio.run(run())


def test_factory_closes_partial_resource_on_failure(monkeypatch):
    async def run():
        import astana_city_context.provider as module
        http = SimpleNamespace(aclose=AsyncMock())
        monkeypatch.setattr(module, "JsonHTTP", lambda **_: http)
        def fail(*args, **kwargs):
            raise RuntimeError("initialization failed")
        monkeypatch.setattr(module, "OpenMeteoWeather", fail)
        with pytest.raises(RuntimeError):
            await create_context(config={"mode": "live", "timezone": "Asia/Almaty"})
        http.aclose.assert_awaited_once()
    asyncio.run(run())


@pytest.mark.parametrize("name,value", [("ASTANA_CONTEXT_TIMEOUT_SECONDS", "nan"), ("ASTANA_CONTEXT_RETRIES", "3"), ("ASTANA_WALKING_PACE_MPS", "0"), ("ASTANA_WEATHER_ENABLED", "perhaps"), ("ROUTING_PROVIDER", "car_only")])
def test_factory_rejects_invalid_configuration(monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError):
        asyncio.run(create_context(config={"mode": "live", "timezone": "Asia/Almaty"}))
