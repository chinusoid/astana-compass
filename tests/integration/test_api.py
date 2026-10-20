from copy import deepcopy
from importlib.resources import files
import json

from fastapi.testclient import TestClient
import pytest
from astana_api import create_app
from astana_api.settings import Settings
from astana_api.composition import Services
from astana_api.fixtures import FixtureRepository, FixtureRetriever, FixtureContext
from astana_contracts import validate_payload
from astana_recommender import DefaultRecommendationService


@pytest.fixture
def payload():
    cases = json.loads(files("astana_contracts").joinpath("data/contracts.examples.json").read_text())["cases"]
    return deepcopy(next(c["instance"] for c in cases if c["name"] == "request_valid"))


@pytest.fixture
def client():
    with TestClient(create_app(Settings())) as client:
        yield client


def test_full_recommendation_and_selected_itinerary(client, payload):
    response = client.post("/v1/recommendations", json=payload)
    assert response.status_code == 200, response.text
    result = response.json()
    validate_payload("RecommendationResponse", result)
    assert result["recommendations"]
    assert result["request_id"] == response.headers["x-request-id"]
    assert response.headers["x-astana-data-mode"] == "fixture"
    assert all(p["is_synthetic"] for p in result["places"])
    assert any("synthetic" in w.lower() for w in result["warnings"])
    ids = [r["place_id"] for r in result["recommendations"]][::-1]
    payload.update(place_ids=ids, available_seconds=10000)
    itinerary = client.post("/v1/itineraries", json=payload)
    assert itinerary.status_code == 200, itinerary.text
    data = itinerary.json()
    validate_payload("ItineraryResponse", data)
    assert [s["place_id"] for s in data["stops"]] == ids
    assert data["route"]["includes_return"] is True
    assert data["route"]["geometry"] is None
    assert data["total_duration_seconds"] <= payload["available_seconds"]


@pytest.mark.parametrize("change", [
    {"origin": {"lat": 91, "lon": 71}}, {"timezone": "UTC"}, {"start_at": "2026-10-18T12:00:00"},
    {"limit": 4}, {"query": "x" * 2001}, {"available_seconds": -1}, {"unexpected": True},
])
def test_invalid_requests(client, payload, change):
    payload.update(change)
    response = client.post("/v1/recommendations", json=payload)
    assert response.status_code == 422
    validate_payload("ErrorResponse", response.json())
    assert response.json()["error"]["code"] == "invalid_request"


def test_unknown_required_never_satisfied(client, payload):
    payload["constraints"] = [{"key": "wheelchair_accessible", "value": True, "strength": "required"}]
    result = client.post("/v1/recommendations", json=payload).json()
    assert result["status"] == "no_match"
    assert result["places"] == result["recommendations"] == []


def test_unsupported_transport(client, payload):
    payload["transport"] = "cycling"
    response = client.post("/v1/recommendations", json=payload)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "unsupported_transport"


def test_missing_live_adapters_fail_readiness():
    with TestClient(create_app(Settings(mode="live", repository_factory="missing_astana_module:create_repository"))) as client:
        assert client.get("/v1/health/live").status_code == 200
        ready = client.get("/v1/health/ready")
        assert ready.status_code == 503
        validate_payload("HealthResponse", ready.json())
        response = client.get("/v1/places")
        assert response.status_code == 503
        assert "missing_astana" not in response.text


def test_live_mode_rejects_synthetic_adapter():
    repo = FixtureRepository()
    service = DefaultRecommendationService(repo, FixtureRetriever(repo), FixtureContext())
    with TestClient(create_app(Settings(mode="live"), Services(repo, service))) as client:
        assert client.get("/v1/places").status_code == 503
        assert client.get("/v1/places/synthetic:place:one").status_code == 503


def test_provider_error_does_not_leak_secrets():
    class BrokenRepository:
        async def list_places(self, **kwargs):
            raise RuntimeError("secret-api-key / private user query")
    with TestClient(create_app(Settings(), Services(BrokenRepository(), None))) as client:
        response = client.get("/v1/places")
        assert response.status_code == 503
        assert "secret" not in response.text and "private" not in response.text
        validate_payload("ErrorResponse", response.json())


@pytest.mark.parametrize("failure,reason", [
    (RuntimeError, "dependency_error"), (TimeoutError, "deadline"),
])
def test_support_number_correlates_safe_unavailability_logs(caplog, failure, reason):
    secret = "private-user-query exact-location secret-api-key"

    class BrokenRepository:
        async def list_places(self, **kwargs):
            raise failure(secret)

    with caplog.at_level("WARNING", logger="astana_api.app"):
        with TestClient(create_app(Settings(), Services(BrokenRepository(), None))) as client:
            response = client.get("/v1/places", params={"query": secret})
    assert response.status_code == 503
    request_id = response.json()["request_id"]
    assert f"request_id={request_id} route=/v1/places reason={reason} elapsed_ms=" in caplog.text
    assert secret not in caplog.text
    assert failure.__name__ not in caplog.text
    assert secret not in response.text


def test_pagination_search_bbox_and_lookup(client):
    first = client.get("/v1/places?limit=1").json()
    second = client.get("/v1/places", params={"limit": 1, "cursor": first["next_cursor"]}).json()
    assert first["places"][0]["id"] != second["places"][0]["id"]
    assert client.get("/v1/places", params={"query": "outdoor"}).json()["places"][0]["id"] == "synthetic:place:two"
    assert client.get("/v1/places?bbox=0,0,1,1").json()["places"] == []
    assert client.get("/v1/places?bbox=nan,0,1,1").status_code == 422
    assert client.get("/v1/places?bbox=0,1,2").status_code == 422
    assert client.get("/v1/places?cursor=-1").status_code == 422
    assert client.get("/v1/places/missing").status_code == 404


def test_bounded_body_and_malformed_json(client):
    for body in [b"{", b"[1,2]", b"x" * 40000]:
        response = client.post("/v1/recommendations", content=body, headers={"Content-Type": "application/json"})
        assert response.status_code == 422
        validate_payload("ErrorResponse", response.json())
    response = client.post("/v1/recommendations", content=b"{}", headers={"Content-Type": "text/plain"})
    assert response.status_code == 422


def test_nonfinite_coordinates_rejected(client, payload):
    body = json.dumps(payload).replace('51.089', 'NaN')
    assert client.post("/v1/recommendations", content=body, headers={"Content-Type": "application/json"}).status_code == 422


def test_feedback_is_bounded_and_explicitly_volatile():
    app = create_app(Settings(feedback_capacity=2))
    with TestClient(app) as client:
        for index in range(3):
            response = client.post("/v1/feedback", json={"request_id": f"req:{index}", "rating": "helpful", "comment": None})
            assert response.status_code == 201
            validate_payload("FeedbackResponse", response.json())
        assert len(app.state.feedback) == 2
        assert app.state.feedback[0]["request_id"] == "req:1"


def test_cors_and_openapi_match_canonical_contract(client):
    response = client.options("/v1/recommendations", headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST"})
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"
    denied = client.options("/v1/recommendations", headers={"Origin": "https://untrusted.invalid", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in denied.headers
    schema = client.get("/openapi.json").json()
    request = schema["paths"]["/v1/recommendations"]["post"]["requestBody"]
    assert request["content"]["application/json"]["schema"]["$ref"].endswith("/RecommendationRequest")
    assert "ContextResult" in schema["components"]["schemas"]


def test_capacity_returns_retryable_error(client):
    # Exhaust permits in this deterministic test; calls don't enter a provider.
    client.app.state.gate = __import__("asyncio").Semaphore(0)
    response = client.get("/v1/places")
    assert response.status_code == 429
    assert response.headers["retry-after"] == "2"
    assert response.json()["error"]["retryable"] is True


def test_settings_never_render_secret():
    settings = Settings(llm_provider="openai", llm_model="configured-model", llm_api_key="secret-api-key")
    assert "secret-api-key" not in repr(settings)
    with pytest.raises(ValueError):
        Settings(llm_provider="nvidia")


def test_live_readiness_requires_usable_data():
    class EmptyRepository:
        async def data_status(self):
            return {"sources": [{"source_name": "Configured but empty", "source_url": "https://example.org/source", "status": "unavailable", "last_success_at": None, "place_count": 0, "warnings": []}], "total_places": 0, "checked_at": "2026-10-18T12:00:00+05:00"}
    with TestClient(create_app(Settings(mode="live"), Services(EmptyRepository(), None))) as client:
        assert client.get("/v1/health/ready").status_code == 503


def test_live_output_rejects_synthetic_route_evidence():
    from astana_api.app import checked, APIError
    cases = json.loads(files("astana_contracts").joinpath("data/contracts.examples.json").read_text())["cases"]
    result = deepcopy(next(c["instance"] for c in cases if c["name"] == "recommendations_valid"))
    # Schema-valid real-marked places alongside an explicitly synthetic route.
    place = result["places"][0]
    place["id"] = "osm:node:one"
    place["is_synthetic"] = False
    evidence = place["evidence"][0]
    evidence.update(id="osm:evidence:one", source_type="official", source_url="https://example.org/source", source_record_id="record:one", is_synthetic=False)
    place["facts"][0]["evidence_ids"] = [evidence["id"]]
    item = result["recommendations"][0]
    item["place_id"] = place["id"]
    item["constraint_evaluations"][0]["evidence_ids"] = [evidence["id"]]
    validate_payload("RecommendationResponse", result)
    with pytest.raises(APIError):
        checked("RecommendationResponse", result, Settings(mode="live"))
