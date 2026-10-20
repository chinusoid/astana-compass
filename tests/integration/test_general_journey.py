"""Semantic model output through the installed API, with a real local catalog."""
from datetime import datetime, timezone
import json
from pathlib import Path

from fastapi.testclient import TestClient
import httpx
import pytest

from astana_api import create_app
from astana_api.settings import Settings
from astana_ai_providers.journeys import create_journey_planner
from astana_contracts import validate_payload


QUERY = "Сначала хочу почитать книги в библиотеке, затем поесть суши, после этого посмотреть кино, а закончить у Астана Опера"


def stage(quote, search, kind="activity", *, named=None, cuisine=None, categories=None):
    return {"source_quote": quote, "search_query": search, "kind": kind,
            "named_place": named, "cuisine": cuisine, "categories": categories or []}


@pytest.mark.parametrize("missing_shop", [False, True])
def test_full_semantic_scenario_covers_real_stops_and_reports_missing_goal(monkeypatch, missing_shop):
    query = QUERY + (", потом купить открытки" if missing_shop else "")
    stages = [stage("почитать книги в библиотеке", "библиотека", categories=["library"]),
              stage("поесть суши", "restaurant sushi", "meal", cuisine="sushi", categories=["restaurant", "cafe"]),
              stage("посмотреть кино", "кино", categories=["cinema"]),
              stage("закончить у Астана Опера", "Астана Опера", "named_place", named="Астана Опера")]
    if missing_shop:
        stages.append(stage("купить открытки", "магазин открыток", categories=["gift_shop"]))
    plan = {"provider": "openai", "stages": stages, "order": "explicit",
            "warnings": [], "clarification_questions": []}
    requests, unexpected = [], []

    def model(request):
        body = json.loads(request.content)
        # Planning receives the wish and locale; the routing origin remains local.
        assert json.loads(body["input"][0]["content"]) == {"query": query, "locale": "ru"}
        assert "51.1283" not in request.content.decode()
        requests.append(True)
        return httpx.Response(200, json={"status": "completed", "output": [{"type": "message",
            "role": "assistant", "content": [{"type": "output_text", "text": json.dumps(plan)}]}]})

    def planner(**kwargs):
        return create_journey_planner("openai", "gpt-6-luna", "synthetic-private-key",
                                      transport=httpx.MockTransport(model))

    original_send = httpx.AsyncClient.send

    async def local_only(client, request, **kwargs):
        if not isinstance(client._transport, httpx.MockTransport):
            unexpected.append(True)
            raise AssertionError("No external providers in this regression")
        return await original_send(client, request, **kwargs)

    for key in ("ROUTING_API_KEY", "ORS_API_KEY", "OPENAI_API_KEY", "NVIDIA_API_KEY", "LLM_API_KEY", "TOMTOM_API_KEY", "TWOGIS_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("ASTANA_POI_PATH", str(Path(__file__).parents[2] / "data/samples/astana-osm.json"))
    monkeypatch.setenv("ASTANA_ROUTE_ALLOW_APPROXIMATE", "true")
    monkeypatch.setenv("ASTANA_WEATHER_ENABLED", "false")
    monkeypatch.setenv("ROUTING_PROVIDER", "openrouteservice")
    monkeypatch.setattr("astana_ai_providers.create_journey_planner", planner)
    monkeypatch.setattr(httpx.AsyncClient, "send", local_only)
    payload = {"query": query, "locale": "ru", "origin": {"lat": 51.1283, "lon": 71.4305},
        "start_at": datetime.now(timezone.utc).isoformat(), "timezone": "Asia/Almaty",
        "available_seconds": 60, "transport": "walking", "return_to_origin": False,
        "constraints": [], "limit": 3}
    with TestClient(create_app(Settings(mode="live", llm_provider="none"))) as client:
        response = client.post("/v1/recommendations", json=payload)
        assert response.status_code == 200, response.text
        result = response.json()
        validate_payload("RecommendationResponse", result)
        assert result["journey_plan"] == plan
        assert len(result["recommendations"]) == 4
        places = {place["id"]: place for place in result["places"]}
        ids = [item["place_id"] for item in result["recommendations"]]
        assert "library" in places[ids[0]]["categories"]
        sushi = next(fact for fact in places[ids[1]]["facts"] if fact["key"] == "osm:cuisine")
        assert sushi["status"] == "known" and "sushi" in sushi["value"].split(";")
        assert "cinema" in places[ids[2]]["categories"]
        assert places[ids[3]]["name"] == "Астана Опера"
        assert all(not place["is_synthetic"] for place in places.values())
        if missing_shop:
            assert any("5" in warning for warning in result["warnings"])
        itinerary = client.post("/v1/itineraries", json={**payload, "limit": len(ids), "place_ids": ids})
        assert itinerary.status_code == 200, itinerary.text
        built = itinerary.json()
        validate_payload("ItineraryResponse", built)
        assert [stop["place_id"] for stop in built["stops"]] == ids
        assert built["total_duration_seconds"] > payload["available_seconds"]
    assert len(requests) == 1
    assert not unexpected
