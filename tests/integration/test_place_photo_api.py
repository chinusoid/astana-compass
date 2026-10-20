"""Photo HTTP boundary: server catalogue identity, offline fixtures and canonical OpenAPI."""
import asyncio
from copy import deepcopy
import json
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from astana_api import create_app
from astana_api.composition import Services
from astana_api.place_photos import WikimediaPlacePhotos
from astana_api.settings import Settings
from astana_city_context.common import ProviderError
from astana_contracts import ContractValidationError, load_schema, validate_payload

ROOT = Path(__file__).parents[2]
CATALOGUE = json.loads((ROOT / "data/samples/astana-osm.json").read_text(encoding="utf8"))["places"]
BOTANICAL = next(place for place in CATALOGUE if place["id"] == "osm:way/1196402246")
UNAVAILABLE = {"status": "unavailable", "photo": None}
PHOTO = {
    "status": "available", "photo": {
        "url": "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/1d/A_view_of_Nur-Sultan%27s_Botanical_Garden.jpg/960px-A_view_of_Nur-Sultan%27s_Botanical_Garden.jpg",
        "source_url": "https://commons.wikimedia.org/wiki/File:A_view_of_Nur-Sultan%27s_Botanical_Garden.jpg",
        "author": "Demir Berisha", "license": "CC BY-SA 4.0",
        "license_url": "https://creativecommons.org/licenses/by-sa/4.0",
        "alt": "Фотография: Ботаникалық бақ",
    },
}


class Repository:
    def __init__(self, place):
        self.place, self.calls = deepcopy(place), []

    async def get(self, place_id):
        self.calls.append(place_id)
        return deepcopy(self.place) if place_id == self.place["id"] else None


class Photos:
    def __init__(self, result=None, error=None):
        self.result, self.error = result if result is not None else PHOTO, error
        self.calls = []

    async def photo(self, place, locale):
        self.calls.append((deepcopy(place), locale))
        if self.error:
            raise self.error
        return deepcopy(self.result)


class NoNetwork:
    async def request(self, *_args, **_kwargs):
        raise AssertionError("A fixture/unknown photo must never query Wikimedia")


@pytest.fixture
def client():
    repository = Repository(BOTANICAL)
    with TestClient(create_app(Settings(mode="live"), Services(repository, None))) as value:
        value.app.state.photo_test_repository = repository
        yield value


def test_photo_uses_catalogue_record_and_keeps_saved_facts_unchanged(client):
    provider = Photos()
    client.app.state.place_photos = provider
    before = client.get(f"/v1/places/{BOTANICAL['id']}").json()
    response = client.post("/v1/place-photo", json={"place_id": BOTANICAL["id"], "locale": "kk"})
    assert response.status_code == 200, response.text
    validate_payload("PlacePhotoResponse", response.json())
    assert response.json() == PHOTO
    assert provider.calls == [(before, "kk")]
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-astana-data-mode"] == "live"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert client.get(f"/v1/places/{BOTANICAL['id']}").json() == before
    assert all("photo" not in fact["key"] for fact in before["facts"])


@pytest.mark.parametrize("extra", [
    {"location": {"lat": 51.1, "lon": 71.4}}, {"query": "find a photo by this name"},
    {"url": "https://private.example/image.jpg"}, {"wikidata_id": "Q42"},
    {"key": "SYNTHETIC_SECRET_DO_NOT_ECHO"}, {"provider_url": "https://example.invalid"},
])
def test_photo_rejects_caller_coordinates_urls_and_credentials_before_lookup(client, extra):
    provider = Photos()
    client.app.state.place_photos = provider
    response = client.post("/v1/place-photo", json={"place_id": BOTANICAL["id"], "locale": "ru", **extra})
    assert response.status_code == 422
    validate_payload("ErrorResponse", response.json())
    assert response.json()["error"]["code"] == "invalid_request"
    assert provider.calls == []
    assert client.app.state.photo_test_repository.calls == []
    assert "SYNTHETIC_SECRET_DO_NOT_ECHO" not in response.text


@pytest.mark.parametrize("body", [
    {}, {"place_id": "", "locale": "ru"}, {"place_id": "x" * 513, "locale": "ru"},
    {"place_id": BOTANICAL["id"], "locale": "de"},
    {"place_id": BOTANICAL["id"], "locale": "ru", "unexpected": True},
])
def test_photo_invalid_requests_are_canonical_errors_without_provider_calls(client, body):
    provider = Photos()
    client.app.state.place_photos = provider
    response = client.post("/v1/place-photo", json=body)
    assert response.status_code == 422
    validate_payload("ErrorResponse", response.json())
    assert provider.calls == []


def test_photo_unknown_catalogue_id_returns_404_without_provider_spend(client):
    provider = Photos()
    client.app.state.place_photos = provider
    response = client.post("/v1/place-photo", json={"place_id": "osm:way/999999999", "locale": "ru"})
    assert response.status_code == 404
    validate_payload("ErrorResponse", response.json())
    assert response.json()["error"]["code"] == "not_found"
    assert response.headers["cache-control"] == "no-store"
    assert provider.calls == []


@pytest.mark.parametrize("error", [TimeoutError(), ProviderError("rate_limited"), ProviderError("invalid_provider_response")])
def test_photo_provider_failure_returns_usable_unavailable_response_and_releases_gate(client, error):
    provider = Photos(error=error)
    client.app.state.place_photos = provider
    request = {"place_id": BOTANICAL["id"], "locale": "ru"}
    response = client.post("/v1/place-photo", json=request)
    assert response.status_code == 200
    validate_payload("PlacePhotoResponse", response.json())
    assert response.json() == UNAVAILABLE
    provider.error = None
    assert client.post("/v1/place-photo", json=request).json() == PHOTO


def test_photo_deadline_cancels_slow_provider_and_releases_single_slot():
    class SlowPhotos(Photos):
        cancelled = False

        async def photo(self, place, locale):
            try:
                await asyncio.sleep(30)
            finally:
                self.cancelled = True

    repository = Repository(BOTANICAL)
    with TestClient(create_app(Settings(mode="live", request_timeout_seconds=1, max_concurrent_requests=1),
                               Services(repository, None))) as value:
        provider = SlowPhotos()
        value.app.state.place_photos = provider
        request = {"place_id": BOTANICAL["id"], "locale": "ru"}
        response = value.post("/v1/place-photo", json=request)
        assert response.status_code == 200
        assert response.json() == UNAVAILABLE
        assert provider.cancelled
        value.app.state.place_photos = Photos()
        assert value.post("/v1/place-photo", json=request).status_code == 200


def test_photo_fixture_and_real_unknown_identity_never_make_wikimedia_requests():
    with TestClient(create_app(Settings())) as value:
        value.app.state.place_photos = WikimediaPlacePhotos(http=NoNetwork())
        response = value.post("/v1/place-photo", json={"place_id": "synthetic:place:one", "locale": "ru"})
        assert response.status_code == 200
        assert response.json() == UNAVAILABLE
        assert response.headers["x-astana-data-mode"] == "fixture"
    unlinked = next(place for place in CATALOGUE if not any(fact["key"] == "osm:wikidata" for fact in place["facts"]))
    with TestClient(create_app(Settings(mode="live"), Services(Repository(unlinked), None))) as value:
        value.app.state.place_photos = WikimediaPlacePhotos(http=NoNetwork())
        response = value.post("/v1/place-photo", json={"place_id": unlinked["id"], "locale": "en"})
        assert response.status_code == 200
        assert response.json() == UNAVAILABLE


def test_photo_rejects_malformed_provider_output_without_returning_it(client):
    client.app.state.place_photos = Photos(result={"status": "available", "photo": {"private": "MUST_NOT_ECHO"}})
    response = client.post("/v1/place-photo", json={"place_id": BOTANICAL["id"], "locale": "ru"})
    assert response.status_code == 503
    validate_payload("ErrorResponse", response.json())
    assert "MUST_NOT_ECHO" not in response.text


def test_photo_openapi_projects_canonical_request_response_and_404(client):
    schema = client.get("/openapi.json").json()
    operation = schema["paths"]["/v1/place-photo"]["post"]
    assert operation["requestBody"]["required"] is True
    assert operation["requestBody"]["content"]["application/json"]["schema"]["$ref"] == "#/components/schemas/PlacePhotoRequest"
    for status, definition in [("200", "PlacePhotoResponse"), ("404", "ErrorResponse"), ("422", "ErrorResponse")]:
        assert operation["responses"][status]["content"]["application/json"]["schema"]["$ref"] == f"#/components/schemas/{definition}"
    canonical = load_schema()["$defs"]
    for definition in ["PlacePhotoRequest", "PlacePhotoResponse"]:
        projected = json.loads(json.dumps(canonical[definition]).replace("#/$defs/", "#/components/schemas/"))
        assert schema["components"]["schemas"][definition] == projected


@pytest.mark.parametrize("case", [
    case for case in json.loads((ROOT / "contracts.examples.json").read_text(encoding="utf8"))["cases"]
    if case["definition"] in {"PlacePhotoRequest", "PlacePhotoResponse"}
], ids=lambda case: case["name"])
def test_photo_shared_contract_examples_cover_success_fallback_and_rejected_inputs(case):
    if case["valid"]:
        validate_payload(case["definition"], case["instance"])
    else:
        with pytest.raises(ContractValidationError) as caught:
            validate_payload(case["definition"], case["instance"])
        assert caught.value.stage == case["failure_stage"]
