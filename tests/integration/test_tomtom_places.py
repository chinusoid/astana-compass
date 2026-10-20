"""TomTom Maps Nearby Search envelope; no real key or network required."""
import asyncio
from copy import deepcopy
import json

import httpx
import pytest

from astana_api.tomtom_places import (
    ENDPOINT, MultiSourceMapService, SOURCE, TomTomPlacesService,
    create_map_service, normalize_places,
)
from astana_city_context.common import JsonHTTP, ProviderError
from astana_contracts import ContractValidationError, validate_payload

LOCATION = {"lat": 51.1283, "lon": 71.4305}
STAMP = "2026-10-19T10:00:00Z"


def response():
    return {"results": [{
        "id": "sample-123", "type": "POI",
        "position": {"lon": 71.4305, "lat": 51.1283},
        "poi": {
            "name": "Test cafe", "phone": "+7 example", "url": "https://example.org",
            "classifications": [{"names": [{"nameLocale": "en-US", "name": "Cafe"}]}],
            "openingHours": {"mode": "nextSevenDays", "timeRanges": [
                {"startTime": {"date": "2026-10-19", "hour": 9, "minute": 0},
                 "endTime": {"date": "2026-10-19", "hour": 18, "minute": 0}}]},
        },
        "address": {"streetName": "Test street", "streetNumber": "12", "countryCode": "KZ"},
    }]}


def test_provider_facts_are_separate_nearby_pois_with_dated_hours_not_invented_amenities():
    result = normalize_places(response(), LOCATION, "ru", STAMP)
    feature = result["features"][0]
    assert feature["id"] == "tomtom:poi:sample-123"
    assert feature["match"] == "nearby"  # coincident point does not prove containment
    assert feature["source_url"] == SOURCE and result["retrieved_at"] == STAMP
    assert feature["description"] is None
    assert feature["attributes"][-1]["value"] == "2026-10-19 09:00 – 2026-10-19 18:00"
    assert "wifi" not in json.dumps(result).lower() and "toilet" not in json.dumps(result).lower()


@pytest.mark.parametrize("problem", ["distant", "foreign", "boolean-coordinate", "unsafe-id", "no-name", "action"])
def test_unrelated_or_invalid_results_are_not_shown(problem):
    data = response()
    item = data["results"][0]
    if problem == "distant":
        item["position"]["lon"] += .1
    elif problem == "foreign":
        item["address"]["countryCode"] = "DE"
    elif problem == "boolean-coordinate":
        item["position"]["lon"] = True
    elif problem == "unsafe-id":
        item["id"] = "../key?secret=bad"
    elif problem == "no-name":
        item["poi"]["name"] = []
    else:
        item["type"] = "discoverAction"
    assert normalize_places(data, LOCATION, "en", STAMP)["status"] == "empty"


@pytest.mark.parametrize("hours", [None, {}, [], {"mode": "nextSevenDays", "timeRanges": []},
                                   {"mode": "other", "timeRanges": []},
                                   {"mode": "nextSevenDays", "timeRanges": [{"startTime": None}]}])
def test_missing_malformed_or_empty_hours_do_not_prove_open_or_closed(hours):
    data = response()
    data["results"][0]["poi"]["openingHours"] = hours
    feature = normalize_places(data, LOCATION, "en", STAMP)["features"][0]
    assert all("Hours" not in attr["label"] for attr in feature["attributes"])


@pytest.mark.parametrize("locale,language", [("ru", "ru-RU"), ("kk", "kk-KZ"), ("en", "en-GB")])
def test_wire_request_is_query_free_bounded_server_authenticated_and_locale_aware(locale, language):
    seen = []

    def handler(request):
        seen.append(request)
        assert request.method == "GET" and str(request.url).split("?")[0] == ENDPOINT
        assert request.content == b""
        assert not any(name in request.headers for name in ("Attributes", "TomTom-Api-Version", "TomTom-Api-Key"))
        assert dict(request.url.params) == {
            "key": "fake-key", "lat": "51.1283", "lon": "71.4305", "radius": "250", "limit": "8",
            "countrySet": "KZ", "language": language, "openingHours": "nextSevenDays",
        }
        assert request.headers["Accept-Encoding"] == "identity"
        return httpx.Response(200, json=response())

    async def check():
        http = JsonHTTP(client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), retries=0)
        service = TomTomPlacesService(enabled=True, api_key="fake-key", http=http)
        try:
            assert (await service.inspect(LOCATION, locale))["features"]
            with pytest.raises(ProviderError, match="rate_limited"):
                await service.inspect(LOCATION, locale)
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


def test_overnight_hours_keep_both_dates_and_do_not_invent_utc_offset():
    data = response()
    data["results"][0]["poi"]["openingHours"]["timeRanges"] = [{
        "startTime": {"date": "2026-10-19", "hour": 22, "minute": 30},
        "endTime": {"date": "2026-10-20", "hour": 2, "minute": 0},
    }]
    feature = normalize_places(data, LOCATION, "en", STAMP)["features"][0]
    assert feature["attributes"][-1] == {
        "label": "Hours on stated dates (local time, TomTom)",
        "value": "2026-10-19 22:30 – 2026-10-20 02:00",
    }


@pytest.mark.parametrize("field,value", [("hour", True), ("hour", 24), ("minute", 60),
                                        ("date", "2026-02-31"), ("date", "20261019")])
def test_invalid_local_hours_are_not_displayed(field, value):
    data = response()
    data["results"][0]["poi"]["openingHours"]["timeRanges"][0]["startTime"][field] = value
    feature = normalize_places(data, LOCATION, "en", STAMP)["features"][0]
    assert all("Hours" not in attr["label"] for attr in feature["attributes"])


def test_invalid_reverse_hours_and_oversized_range_are_not_displayed():
    for end in ({"date": "2026-10-19", "hour": 8, "minute": 0},
                {"date": "2026-11-19", "hour": 18, "minute": 0}):
        data = response()
        data["results"][0]["poi"]["openingHours"]["timeRanges"][0]["endTime"] = end
        feature = normalize_places(data, LOCATION, "en", STAMP)["features"][0]
        assert len(feature["attributes"]) == 2


def test_only_eight_unique_nearby_pois_are_kept_and_provider_distance_is_not_trusted():
    data = response()
    template = data["results"][0]
    data["results"] = [{**deepcopy(template), "id": f"place-{index}", "dist": 1}
                       for index in range(10)]
    far = deepcopy(template)
    far["id"] = "lying-distance"
    far["dist"] = 0
    far["position"]["lat"] += .01
    data["results"].extend([deepcopy(data["results"][0]), far])
    result = normalize_places(data, LOCATION, "en", STAMP)
    assert len(result["features"]) == 8
    assert len({item["id"] for item in result["features"]}) == 8
    assert all(item["distance_meters"] <= 250 for item in result["features"])
    assert "lying-distance" not in str(result)
    assert "Orbis" not in result["attribution"] and "Maps" in result["attribution"]


def test_timeout_cancels_one_call_without_retry_and_includes_queue_wait(monkeypatch, caplog):
    import astana_api.tomtom_places as module
    monkeypatch.setattr(module, "_TIMEOUT_SECONDS", .01)

    class StalledHTTP:
        calls = 0
        cancelled = False

        async def request(self, *args, **kwargs):
            self.calls += 1
            try:
                await asyncio.sleep(60)
            finally:
                self.cancelled = True

    async def check():
        http = StalledHTTP()
        service = TomTomPlacesService(enabled=True, api_key="private-secret", http=http)
        with pytest.raises(ProviderError, match="provider_unavailable"):
            await service.inspect(LOCATION, "en")
        assert http.calls == 1 and http.cancelled
        queued = TomTomPlacesService(enabled=True, api_key="private-secret", http=http)
        await queued.gate.acquire()
        try:
            with pytest.raises(ProviderError, match="provider_unavailable"):
                await queued.inspect(LOCATION, "en")
        finally:
            queued.gate.release()
        assert http.calls == 1 and not queued.calls
    asyncio.run(check())
    assert "reason=timeout" in caplog.text and "private-secret" not in caplog.text


def test_no_second_tomtom_request_on_bad_request_and_no_cache_after_success():
    calls = []
    clock = [100.0]

    def handler(request):
        calls.append(request)
        return httpx.Response(400, json={"detailedError": {"target": "query"}}) if len(calls) == 1 else httpx.Response(200, json=response())

    async def check():
        http = JsonHTTP(client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), retries=0)
        service = TomTomPlacesService(enabled=True, api_key="fake-key", http=http, clock=lambda: clock[0])
        try:
            with pytest.raises(ProviderError):
                await service.inspect(LOCATION, "ru")
            assert len(calls) == 1
            for moment in (106, 112):
                clock[0] = moment
                assert (await service.inspect(LOCATION, "ru"))["features"]
            assert len(calls) == 3
        finally:
            await service.aclose()
    asyncio.run(check())


@pytest.mark.parametrize("stamps", [[70, 75, 80, 85, 90, 95], list(range(-1000, -900))])
def test_minute_and_daily_budgets_reject_before_request(stamps):
    class HTTP:
        async def request(self, *args, **kwargs):
            pytest.fail("budget must reject before provider")
    service = TomTomPlacesService(enabled=True, api_key="fake", http=HTTP(), clock=lambda: 100.0)
    service.calls.extend(stamps)
    with pytest.raises(ProviderError, match="rate_limited"):
        asyncio.run(service.inspect(LOCATION, "en"))


def test_default_transport_has_four_second_timeout_and_no_retries():
    async def check():
        service = TomTomPlacesService(enabled=False, api_key="")
        try:
            assert service.http.timeout_seconds == 4 and service.http.retries == 0
        finally:
            await service.aclose()
    asyncio.run(check())
    class RetryingHTTP:
        retries = 1
    with pytest.raises(ValueError, match="zero HTTP retries"):
        TomTomPlacesService(enabled=True, api_key="fake", http=RetryingHTTP())


def test_source_whitelist_keeps_discover_compatibility_and_rejects_credential_urls():
    result = normalize_places(response(), LOCATION, "en", STAMP)
    feature = result["features"][0]
    feature["source_url"] = "https://docs.tomtom.com/places-search-api/documentation/places-search/discover"
    validate_payload("MapFeatureResponse", result)
    for url in (SOURCE + "?key=private", "https://docs.tomtom.com/other", "https://evil.example/nearby-search"):
        feature["source_url"] = url
        with pytest.raises(ContractValidationError):
            validate_payload("MapFeatureResponse", result)
