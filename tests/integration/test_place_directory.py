"""Directory HTTP boundary uses catalog identities, never caller credentials."""
from copy import deepcopy

from fastapi.testclient import TestClient
import pytest

from astana_api import create_app
from astana_api.settings import Settings
from astana_city_context.common import ProviderError
from astana_contracts import validate_payload
from astana_contracts.validation import load_examples


class Directory:
    def __init__(self, error=None):
        self.calls = []
        self.error = error

    async def search(self, place, locale):
        self.calls.append((deepcopy(place), locale))
        if self.error:
            raise self.error
        return deepcopy(next(case["instance"] for case in load_examples()["cases"]
                             if case["name"] == "twogis_map_feature_valid"))


@pytest.fixture
def client():
    with TestClient(create_app(Settings())) as value:
        yield value


def test_directory_gets_public_catalog_place_and_does_not_change_saved_facts(client):
    directory = Directory()
    client.app.state.place_directory = directory
    before = client.get("/v1/places/synthetic:place:one").json()
    response = client.post("/v1/place-directory", json={"place_id": before["id"], "locale": "kk"})
    assert response.status_code == 200
    validate_payload("MapFeatureResponse", response.json())
    assert directory.calls == [(before, "kk")]
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-astana-data-mode"] == "fixture"
    assert client.get("/v1/places/synthetic:place:one").json() == before
    assert "twogis" not in str(before).lower()


@pytest.mark.parametrize("extra", [
    {"location": {"lat": 51.1, "lon": 71.4}},
    {"query": "arbitrary provider query"},
    {"key": "SYNTHETIC_CREDENTIAL"},
    {"provider_url": "https://example.invalid"},
])
def test_directory_rejects_caller_search_fields_without_calling_provider(client, extra):
    directory = Directory()
    client.app.state.place_directory = directory
    response = client.post("/v1/place-directory", json={"place_id": "synthetic:place:one", "locale": "ru", **extra})
    assert response.status_code == 422
    assert directory.calls == []
    assert "SYNTHETIC_CREDENTIAL" not in response.text


def test_directory_missing_place_does_not_spend_provider_quota(client):
    directory = Directory()
    client.app.state.place_directory = directory
    response = client.post("/v1/place-directory", json={"place_id": "not-in-catalog", "locale": "ru"})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert directory.calls == []


@pytest.mark.parametrize("error,status", [(ProviderError("rate_limited"), 429), (ProviderError("invalid_provider_response"), 503)])
def test_directory_safe_failure_and_retry_status(client, error, status):
    client.app.state.place_directory = Directory(error)
    response = client.post("/v1/place-directory", json={"place_id": "synthetic:place:one", "locale": "ru"})
    assert response.status_code == status
    assert response.headers["cache-control"] == "no-store"
    validate_payload("ErrorResponse", response.json())


def test_directory_is_offline_in_fixture_mode_even_if_key_exists(monkeypatch):
    monkeypatch.setenv("TWOGIS_API_KEY", "SYNTHETIC_NEVER_SENT")
    with TestClient(create_app(Settings())) as value:
        response = value.post("/v1/place-directory", json={"place_id": "synthetic:place:one", "locale": "ru"})
        assert response.status_code == 503
        assert "SYNTHETIC_NEVER_SENT" not in response.text
        schema = value.get("/openapi.json").json()
        operation = schema["paths"]["/v1/place-directory"]["post"]
        assert operation["requestBody"]["content"]["application/json"]["schema"]["$ref"].endswith("/PlaceDirectoryRequest")

