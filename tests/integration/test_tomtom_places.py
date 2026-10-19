"""TomTom's documented Discover envelope; no API key or network required."""
import asyncio
from copy import deepcopy
import json

import httpx
import pytest

from astana_api.tomtom_places import (
    ATTRIBUTES, ENDPOINT, MultiSourceMapService, SOURCE, TomTomPlacesService,
    create_map_service, normalize_places,
)
from astana_city_context.common import JsonHTTP, ProviderError
from astana_contracts import validate_payload

LOCATION = {"lat": 51.1283, "lon": 71.4305}
STAMP = "2026-10-19T10:00:00Z"


def response():
    return {"results": [{
        "id": "sample-123", "type": "poi", "title": "Test cafe",
        "position": {"type": "Point", "coordinates": [71.4305, 51.1283]},
        "poiTypes": [{"name": "Cafe"}],
        "address": {"street": "Test street", "houseNumber": "12", "countryCodeIso2": "KZ"},
        "contacts": [{"phones": ["+7 example"], "websites": ["https://example.org"]}],
        "openingHours": [{"date": "2026-10-19", "timeRanges": [{"start": "09:00", "end": "18:00", "utcOffsetSeconds": 18000}]}],
    }]}


def test_provider_facts_are_separate_nearby_pois_with_dated_hours_not_invented_amenities():
    result = normalize_places(response(), LOCATION, "ru", STAMP)
    feature = result["features"][0]
    assert feature["id"] == "tomtom:poi:sample-123"
    assert feature["match"] == "nearby"  # coincident point does not prove containment
    assert feature["source_url"] == SOURCE and result["retrieved_at"] == STAMP
    assert feature["description"] is None
    assert feature["attributes"][-1]["value"] == "2026-10-19: 09:00–18:00 (UTC+05:00)"
    assert "wifi" not in json.dumps(result).lower() and "toilet" not in json.dumps(result).lower()


@pytest.mark.parametrize("problem", ["distant", "foreign", "boolean-coordinate", "unsafe-id", "no-name", "action"])
def test_unrelated_or_invalid_results_are_not_shown(problem):
    data = response()
    item = data["results"][0]
    if problem == "distant":
        item["position"]["coordinates"][0] += .1
    elif problem == "foreign":
        item["address"]["countryCodeIso2"] = "DE"
    elif problem == "boolean-coordinate":
        item["position"]["coordinates"][0] = True
    elif problem == "unsafe-id":
        item["id"] = "../key?secret=bad"
    elif problem == "no-name":
        item["title"] = []
    else:
        item["type"] = "discoverAction"
    assert normalize_places(data, LOCATION, "en", STAMP)["status"] == "empty"


@pytest.mark.parametrize("hours", [None, [], [{"date": "not-a-date", "timeRanges": []}],
                                   [{"date": "2026-10-19", "timeRanges": []}],
                                   [{"date": "2026-10-19", "timeRanges": [{"start": "99:99", "end": "18:00", "utcOffsetSeconds": True}]}]])
def test_missing_malformed_or_empty_hours_do_not_prove_open_or_closed(hours):
    data = response()
    data["results"][0]["openingHours"] = hours
    feature = normalize_places(data, LOCATION, "en", STAMP)["features"][0]
    assert all("Hours" not in attr["label"] for attr in feature["attributes"])


def test_wire_request_is_bounded_server_authenticated_and_locale_aware():
    seen = []

    def handler(request):
        seen.append(request)
        assert str(request.url) == ENDPOINT and "fake-key" not in str(request.url)
        assert request.headers["TomTom-Api-Key"] == "fake-key"
        assert request.headers["TomTom-Api-Version"] == "3"
        assert request.headers["Attributes"] == ATTRIBUTES
        assert request.headers["Accept-Language"].startswith("kk-KZ")
        body = json.loads(request.content)
        assert body["maxResults"] == 8 and body["query"] == ""
        assert body["origin"]["coordinates"] == [71.4305, 51.1283]
        assert body["filters"]["types"] == ["poi"] and body["filters"]["countryCodesIso2"] == ["KZ"]
        assert body["filters"]["geometry"]["type"] == "rectangle"
        return httpx.Response(200, json=response())

    async def check():
        http = JsonHTTP(client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), retries=0)
        service = TomTomPlacesService(enabled=True, api_key="fake-key", http=http)
        try:
            assert (await service.inspect(LOCATION, "kk"))["features"]
            with pytest.raises(ProviderError, match="rate_limited"):
                await service.inspect(LOCATION, "kk")
        finally:
            await service.aclose()
    asyncio.run(check())
    assert len(seen) == 1


def test_disabled_missing_key_and_off_city_never_call_provider():
    class HTTP:
        async def request(self, *args, **kwargs):
            pytest.fail("unexpected external request")
    for enabled, key, location in [(False, "fake", LOCATION), (True, "", LOCATION), (True, "fake", {"lat": 0, "lon": 0})]:
        service = TomTomPlacesService(enabled=enabled, api_key=key, http=HTTP())
        with pytest.raises(ProviderError):
            asyncio.run(service.inspect(location, "en"))


def test_rate_limit_attempts_are_counted_and_retry_after_is_obeyed():
    clock = [100.0]

    class HTTP:
        calls = 0

        async def request(self, *args, **kwargs):
            self.calls += 1
            raise ProviderError("rate_limited", retry_after_seconds=300)
    http = HTTP()
    service = TomTomPlacesService(enabled=True, api_key="fake", http=http, clock=lambda: clock[0])
    for stamp in (100, 106, 399, 400):
        clock[0] = stamp
        with pytest.raises(ProviderError, match="rate_limited"):
            asyncio.run(service.inspect(LOCATION, "en"))
    assert http.calls == 2 and len(service.calls) == 2


class Stub:
    def __init__(self, result):
        self.result = result

    async def inspect(self, *_):
        if isinstance(self.result, BaseException):
            raise self.result
        return deepcopy(self.result)


def test_multisource_keeps_osm_building_and_tomtom_shop_separate_and_falls_back():
    tomtom = normalize_places(response(), LOCATION, "en", STAMP)
    osm = deepcopy(tomtom)
    feature = osm["features"][0]
    feature.update(id="osm:way:123", match="contains", attributes=[], source_url="https://www.openstreetmap.org/way/123", source_label="OpenStreetMap")
    osm["attribution"] = "© OpenStreetMap contributors · ODbL"
    combined = asyncio.run(MultiSourceMapService(Stub(osm), Stub(tomtom)).inspect(LOCATION, "en"))
    assert len(combined["features"]) == 2 and combined["features"][0]["attributes"] == []
    assert "TomTom" in combined["attribution"] and "OpenStreetMap" in combined["attribution"]
    validate_payload("MapFeatureResponse", combined)
    fallback = asyncio.run(MultiSourceMapService(Stub(osm), Stub(ProviderError("provider_unavailable"))).inspect(LOCATION, "en"))
    assert fallback == osm
    with pytest.raises(ProviderError):
        asyncio.run(MultiSourceMapService(Stub(ProviderError("provider_unavailable"))).inspect(LOCATION, "en"))


def test_factory_is_opt_in_and_uses_shared_key(monkeypatch):
    monkeypatch.setenv("ASTANA_MAP_LOOKUP_PROVIDER", "tomtom_osm")
    monkeypatch.setenv("TOMTOM_API_KEY", "fake")
    service = create_map_service(enabled=False)
    assert isinstance(service, MultiSourceMapService)
    asyncio.run(service.aclose())


def test_slow_source_cannot_erase_ready_result_and_parent_cancellation_propagates():
    cancelled = []

    class Stalled:
        async def inspect(self, *_):
            try:
                await asyncio.sleep(60)
            finally:
                cancelled.append(True)

    async def check():
        ready = normalize_places(response(), LOCATION, "en", STAMP)
        service = MultiSourceMapService(Stub(ready), Stalled(), source_timeout_seconds=.01)
        assert await service.inspect(LOCATION, "en") == ready
        assert cancelled == [True]
        task = asyncio.create_task(MultiSourceMapService(Stalled()).inspect(LOCATION, "en"))
        await asyncio.sleep(.001)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert cancelled == [True, True]
    asyncio.run(check())


def test_empty_source_plus_unavailable_source_is_not_reported_as_complete_empty():
    empty = normalize_places({"results": []}, LOCATION, "en", STAMP)
    with pytest.raises(ProviderError, match="provider_unavailable"):
        asyncio.run(MultiSourceMapService(Stub(empty), Stub(ProviderError("provider_unavailable"))).inspect(LOCATION, "en"))


@pytest.mark.parametrize("status,data,reason", [(403, {"message": "private-provider-body"}, "http_error"),
                                              (200, {"results": "private-provider-body"}, "invalid_schema")])
def test_failed_lookup_logs_only_fixed_reason_and_status(status, data, reason, caplog):
    async def check():
        http = JsonHTTP(client=httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(status, json=data))), retries=0)
        service = TomTomPlacesService(enabled=True, api_key="private-tomtom-key", http=http)
        try:
            with pytest.raises(ProviderError):
                await service.inspect(LOCATION, "ru")
        finally:
            await service.aclose()
    asyncio.run(check())
    assert f"service=places reason={reason}" in caplog.text
    if status == 403:
        assert "upstream_status=403" in caplog.text
    assert not any(secret in caplog.text for secret in ("private-provider-body", "private-tomtom-key", "51.1283", ENDPOINT))


def test_normalization_exception_text_is_not_logged(monkeypatch, caplog):
    import astana_api.tomtom_places as module
    def fail(*args):
        raise ValueError("secret-token and private raw provider data")
    monkeypatch.setattr(module, "normalize_places", fail)
    async def check():
        http = JsonHTTP(client=httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=response()))), retries=0)
        service = TomTomPlacesService(enabled=True, api_key="private-tomtom-key", http=http)
        try:
            with pytest.raises(ProviderError, match="^invalid_provider_response$"):
                await service.inspect(LOCATION, "en")
        finally:
            await service.aclose()
    asyncio.run(check())
    assert "service=places reason=invalid_schema" in caplog.text
    assert "secret-token" not in caplog.text and "private" not in caplog.text
