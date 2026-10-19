"""Real collected POI through installed factories; all external I/O is forbidden."""
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from astana_api import create_app
from astana_api.settings import Settings
from astana_contracts import validate_payload


SNAPSHOT = Path(__file__).resolve().parents[2] / "data/samples/astana-osm.json"


@pytest.fixture
def offline_live(monkeypatch):
    for name in ("ROUTING_API_KEY", "ORS_API_KEY", "OPENAI_API_KEY", "NVIDIA_API_KEY", "LLM_API_KEY", "TOMTOM_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ASTANA_POI_PATH", str(SNAPSHOT))
    monkeypatch.setenv("ASTANA_ROUTE_ALLOW_APPROXIMATE", "true")
    monkeypatch.setenv("ASTANA_WEATHER_ENABLED", "false")
    monkeypatch.setenv("ROUTING_PROVIDER", "openrouteservice")
    monkeypatch.setenv("WEATHER_PROVIDER", "open_meteo")
    calls = []

    async def reject_external_call(*args, **kwargs):
        calls.append(True)
        raise AssertionError("Snapshot integration tests must not call external providers")

    # Both request() and stream() reach send(); context adapters use streaming I/O.
    monkeypatch.setattr(httpx.AsyncClient, "send", reject_external_call)
    with TestClient(create_app(Settings(mode="live", llm_provider="none"))) as client:
        yield client
    assert not calls, "A real-data, no-key request attempted external I/O"


def request(query="кофе", locale="ru", constraints=None):
    return {"query": query, "locale": locale, "origin": {"lat": 51.127, "lon": 71.430},
            "start_at": datetime.now(timezone.utc).isoformat(), "timezone": "Asia/Almaty",
            "available_seconds": 14400, "transport": "walking", "return_to_origin": True,
            "constraints": constraints or [], "limit": 3}


def test_live_snapshot_is_ready_and_attributes_its_real_catalogue(offline_live):
    assert offline_live.get("/v1/health/ready").status_code == 200
    status = offline_live.get("/v1/data-status").json()
    validate_payload("DataStatusResponse", status)
    assert status["total_places"] == 628
    assert len(status["sources"]) == 11
    assert status["sources"][0]["status"] in {"ready", "stale"}
    assert status["sources"][0]["source_url"] == "https://www.openstreetmap.org/copyright"
    assert "ODbL" in " ".join(status["sources"][0]["warnings"])
    response = offline_live.get("/v1/places", params={"categories": "museum", "limit": 3})
    assert response.status_code == 200
    validate_payload("PlaceListResponse", response.json())
    assert response.headers["x-astana-data-mode"] == "live"
    for place in response.json()["places"]:
        assert not place["is_synthetic"]
        assert place["id"].startswith("osm:")
        assert "museum" in place["categories"]
        assert any(evidence["source_type"] == "osm" for evidence in place["evidence"])
        assert all(evidence["source_type"] in {"osm", "provider", "official"} for evidence in place["evidence"])


def test_real_official_description_retains_separate_pinned_wikidata_provenance(offline_live):
    response = offline_live.get("/v1/places/osm:node/4894937300")
    assert response.status_code == 200
    place = response.json()
    description = next(fact for fact in place["facts"] if fact["key"] == "wikidata:description:ru")
    assert description["status"] == "known" and description["value"] == "музей в Астане, Казахстан"
    evidence = [item for item in place["evidence"] if item["id"] in description["evidence_ids"]]
    assert len(evidence) == 1
    assert evidence[0]["source_type"] == "provider"
    assert "CC0" in evidence[0]["source_name"]
    assert "oldid=" in evidence[0]["source_url"]
    assert any(item["source_type"] == "osm" for item in place["evidence"])
    facts = {fact["key"]: fact for fact in place["facts"]}
    official = facts["official:description:ru"]
    assert official["status"] == "known" and place["description"] == official["value"]
    assert len(official["value"]) > len(description["value"])
    assert facts["description:source"]["value"] == "official"
    assert facts["description:language"]["value"] == "ru"
    assert facts["description:source"]["evidence_ids"] == official["evidence_ids"]
    official_evidence = [item for item in place["evidence"] if item["id"] in official["evidence_ids"]]
    assert len(official_evidence) == 1
    assert official_evidence[0]["source_type"] == "official"
    assert official_evidence[0]["source_name"] == "Visit Astana"
    assert official_evidence[0]["source_url"] == (
        "https://www.visitastana.kz/ru/about-city/what-to-see/natsionalnyy-muzey-respubliki-kazakhstan/"
    )
    assert facts["opening_hours"]["evidence_ids"] == official["evidence_ids"]
    assert all(facts[key]["status"] == "unknown" for key in ("has_wifi", "toilets", "free_entry"))


def test_confirmed_real_wifi_and_toilets_satisfy_required_conditions(offline_live):
    place = offline_live.get("/v1/places/osm:way/1395465867").json()
    payload = request("Estet Coffee", constraints=[
        {"key": "has_wifi", "value": True, "strength": "required"},
        {"key": "toilets", "value": True, "strength": "required"},
    ])
    payload["origin"] = place["location"]
    response = offline_live.post("/v1/recommendations", json=payload)
    assert response.status_code == 200, response.text
    result = response.json()
    assert [item["place_id"] for item in result["recommendations"]] == [place["id"]]
    checks = {item["key"]: item for item in result["recommendations"][0]["constraint_evaluations"]}
    assert checks["has_wifi"]["outcome"] == checks["toilets"]["outcome"] == "satisfied"


def test_unspecified_real_internet_never_satisfies_required_wifi(offline_live):
    place = offline_live.get("/v1/places/osm:node/11783576043").json()
    facts = {fact["key"]: fact for fact in place["facts"]}
    assert facts["osm:internet_access"]["value"] == "yes"
    assert facts["has_wifi"]["status"] == "unknown"
    payload = request("Drinkit", constraints=[
        {"key": "has_wifi", "value": True, "strength": "required"},
    ])
    payload["origin"] = place["location"]
    response = offline_live.post("/v1/recommendations", json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "no_match"
    assert response.json()["recommendations"] == []


@pytest.mark.parametrize(("query", "locale", "categories"), [
    ("кофе", "ru", {"cafe"}), ("мұражай", "kk", {"museum"}),
    ("library", "en", {"library"}), ("серуен", "kk", {"park", "garden"}),
])
def test_real_recommendations_and_itinerary_without_keys(offline_live, query, locale, categories):
    payload = request(query, locale)
    response = offline_live.post("/v1/recommendations", json=payload)
    assert response.status_code == 200, response.text
    result = response.json()
    validate_payload("RecommendationResponse", result)
    assert 1 <= len(result["recommendations"]) <= 3
    assert all(categories.intersection(place["categories"]) and not place["is_synthetic"] for place in result["places"])
    assert result["warnings"]  # Local search and unavailable model remain disclosed.
    for item in result["recommendations"]:
        assert item["route"]["method"] == "approximate"
        assert item["route"]["geometry"] is None
        assert item["visit_duration_is_estimate"]
    payload["place_ids"] = [result["recommendations"][0]["place_id"]]
    response = offline_live.post("/v1/itineraries", json=payload)
    assert response.status_code == 200, response.text
    itinerary = response.json()
    validate_payload("ItineraryResponse", itinerary)
    assert [stop["place_id"] for stop in itinerary["stops"]] == payload["place_ids"]
    assert itinerary["route"]["method"] == "approximate"
    assert itinerary["route"]["includes_return"]


def test_real_unknown_required_never_becomes_a_recommendation(offline_live):
    response = offline_live.post("/v1/recommendations", json=request(constraints=[
        {"key": "quiet", "value": True, "strength": "required"},
    ]))
    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "no_match"
    assert result["recommendations"] == result["places"] == []


def test_unrelated_query_is_not_filled_with_nearest_real_places(offline_live):
    response = offline_live.post("/v1/recommendations", json=request("quantum teleportation", "en"))
    assert response.status_code == 200
    assert response.json()["status"] == "no_match"
    assert response.json()["recommendations"] == []


@pytest.mark.parametrize("path", [None, "missing-snapshot.json"])
def test_real_factory_does_not_fall_back_when_snapshot_is_unconfigured(monkeypatch, path):
    if path is None:
        monkeypatch.delenv("ASTANA_POI_PATH", raising=False)
    else:
        monkeypatch.setenv("ASTANA_POI_PATH", str(SNAPSHOT.parent / path))
    with TestClient(create_app(Settings(mode="live", llm_provider="none"))) as client:
        assert client.get("/v1/health/live").status_code == 200
        assert client.get("/v1/health/ready").status_code == 503
        assert client.get("/v1/places").status_code == 503
        assert client.post("/v1/recommendations", json=request()).status_code == 503
