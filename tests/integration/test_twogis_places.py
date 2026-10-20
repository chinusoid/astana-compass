"""Synthetic 2GIS wire fixtures only: no key, live network or provider data saved."""
import asyncio
from copy import deepcopy
from datetime import date
import json

import httpx
import pytest

from astana_api.twogis_places import (
    ENDPOINT, FIELDS, TwoGisPlacesService, normalize_places, plain, schedule_attributes,
)
from astana_city_context.common import JsonHTTP, ProviderError
from astana_contracts import validate_payload

PLACE = {"id": "test:coffee", "name": "Sample Coffee", "location": {"lat": 51.1283, "lon": 71.4305}}
STAMP = "2026-10-20T10:00:00Z"


def response():
    return {"meta": {"code": 200}, "result": {"items": [{
        "id": "12345", "type": "branch", "name": "Sample Coffee, кафе",
        "name_ex": {"primary": "Sample Coffee", "extension": "кофейня", "description": "Склад"},
        "point": {"lat": 51.1283, "lon": 71.4305}, "address_name": "Example street, 1",
        "rubrics": [{"name": "Кофейни"}], "description": "<p>Описание <b>из источника</b>.</p>",
        "schedule": {"Mon": {"working_hours": [{"from": "09:00", "to": "18:00"}]}},
        "schedule_special": [{"date": "2026-12-31", "working_hours": [{"from": "10:00", "to": "16:00"}]}],
    }]}}


def test_candidates_keep_provider_identity_provenance_and_scoped_hours():
    result = normalize_places(response(), PLACE, "ru", STAMP)
    validate_payload("MapFeatureResponse", result)
    item = result["features"][0]
    assert item["id"] == "twogis:branch:12345" and item["match"] == "nearby"
    assert item["source_url"] == "https://2gis.kz/astana/firm/12345"
    assert item["description"] == "Описание из источника ." and "Склад" not in item["description"]
    assert item["attributes"] == [
        {"label": "Обычные часы, 2ГИС · Пн", "value": "09:00–18:00"},
        {"label": "Особые часы · 2026-12-31", "value": "10:00–16:00"},
    ]
    assert result["retrieved_at"] == STAMP and "https://dev.2gis.ru" in result["attribution"]
    assert not any(word in json.dumps(result).lower() for word in ("wifi", "toilet", "wheelchair", "open_now"))


@pytest.mark.parametrize("problem", ["distant", "wrong-name", "unsafe-id", "boolean-coordinate", "nan", "not-branch", "empty-name"])
def test_wrong_branches_and_malformed_candidates_are_never_matched(problem):
    data = response()
    item = data["result"]["items"][0]
    if problem == "distant":
        item["point"]["lat"] += .01
        item["context"] = {"distance": 0}
    elif problem == "wrong-name":
        item["name"] = "Different Coffee"
        item["name_ex"]["primary"] = "Different Coffee"
    elif problem == "unsafe-id":
        item["id"] = "123?key=private"
    elif problem == "boolean-coordinate":
        item["point"]["lat"] = True
    elif problem == "nan":
        item["point"]["lat"] = float("nan")
    elif problem == "not-branch":
        item["type"] = "building"
    else:
        item["name"] = []
    assert normalize_places(data, PLACE, "en", STAMP)["status"] == "empty"


def test_nearby_same_brand_is_not_claimed_an_exact_match_and_input_is_unchanged():
    data = response()
    data["result"]["items"][0]["point"]["lat"] += .001
    original, original_place = deepcopy(data), deepcopy(PLACE)
    item = normalize_places(data, PLACE, "en", STAMP)["features"][0]
    assert 100 < item["distance_meters"] < 120 and item["match"] == "nearby"
    assert data == original and PLACE == original_place


@pytest.mark.parametrize("hours", [None, {}, [], {"Mon": {}}, {"Mon": {"working_hours": []}},
                                  {"Mon": {"working_hours": [{"from": None, "to": None}]}}])
def test_unknown_hours_never_mean_open_or_closed(hours):
    assert schedule_attributes(hours, None, "en") == []


def test_overnight_weekdays_special_dates_and_multiple_intervals_are_preserved():
    result = schedule_attributes({
        "Fri": {"working_hours": [{"from": "09:00", "to": "12:00"}, {"from": "22:30", "to": "02:00"}]},
        "date_from": "2026-10-01", "date_to": "2027-03-01", "comment": "Зимнее расписание",
    }, [{"date": "2026-12-31", "working_hours": [{"from": "23:00", "to": "03:00"}]},
        {"date": "2026-12-30", "working_hours": []}], "en")
    assert result[0] == {"label": "Regular hours, 2GIS · Fri", "value": "09:00–12:00; 22:30–02:00 (next day)"}
    assert {"label": "Schedule valid from", "value": "2026-10-01"} in result
    assert result[-2] == {"label": "Special hours · 2026-12-30", "value": "Hours not stated"}
    assert result[-1] == {"label": "Special hours · 2026-12-31", "value": "23:00–03:00 (next day)"}
    assert "closed" not in str(result).lower()


@pytest.mark.parametrize("start,end", [("24:00", "02:00"), ("10:60", "12:00"), (True, "12:00"),
                                       ("9:00", "18:00"), ("00:00", "00:00"), ("09:00", None)])
def test_invalid_or_ambiguous_intervals_are_not_presented(start, end):
    assert schedule_attributes({"Mon": {"working_hours": [{"from": start, "to": end}]}}, None, "ru") == []


def test_explicit_24x7_midnight_end_and_holiday_exception_have_separate_scope():
    result = schedule_attributes({"is_24x7": True, "Mon": {"working_hours": [{"from": "00:00", "to": "24:00"}]}},
                                 [{"date": "2026-12-31", "working_hours": []}], "ru")
    assert result[0]["value"] == "Обычное расписание: 24/7"
    assert result[1]["value"] == "00:00–24:00"
    assert result[2]["value"] == "Время не указано"


def test_invalid_special_dates_are_ignored_and_attributes_are_bounded():
    result = schedule_attributes({"comment": "x" * 1000, "date_from": "2026-02-31"}, [
        {"date": "2026-02-31", "working_hours": []}, {"date": "not a date", "working_hours": []},
        *[{"date": f"2026-12-{day:02}", "working_hours": []} for day in range(1, 29)],
    ], "kk")
    assert len(result) == 10 and len(result[0]["value"]) == 500
    assert all("2026-02-31" not in entry["label"] for entry in result)


def test_upcoming_special_date_is_not_displaced_by_old_holidays_and_partial_list_is_labeled():
    result = schedule_attributes(None, [
        *[{"date": f"2026-01-{day:02}", "working_hours": []} for day in range(1, 12)],
        {"date": "2026-12-31", "working_hours": [{"from": "09:00", "to": "12:00"}]},
    ], "en", reference_day=date(2026, 10, 20))
    assert result[0] == {"label": "Special hours · 2026-12-31", "value": "09:00–12:00"}
    assert result[1]["label"] == "Special hours · 2026-01-11"
    assert result[-1]["value"] == "Some special dates are shown; see 2GIS for the full schedule"


def test_markup_active_bodies_controls_and_lengths_are_bounded_plain_text():
    assert plain('<p>Hello</p><script>private-script()</script><style>private-style</style><svg>bad</svg>world') == "Hello world"
    assert plain('<a href="javascript:bad()" onclick="bad()">Safe &amp; clear</a>') == "Safe & clear"
    assert plain("a\u202eb\x00c\ud800") == "a b c?"
    assert len(plain("x" * 100_000, 2000)) == 2000
    data = response()
    item = data["result"]["items"][0]
    item.update(description="<p>" + "x" * 20_000, address_name="x" * 800, name="Sample Coffee " + "x" * 500)
    item["rubrics"] = [{"name": "x" * 200}]
    item = normalize_places(data, PLACE, "ru", STAMP)["features"][0]
    assert len(item["description"]) == 2000 and len(item["name"]) == 300
    assert len(item["kind"]) == 100 and len(item["address"]) == 500


def test_unique_output_cap_and_no_description_fabricated_from_name_parts():
    data = response()
    item = data["result"]["items"][0]
    item.pop("description")
    data["result"]["items"] = [{**deepcopy(item), "id": str(index)} for index in range(8)]
    data["result"]["items"].append(deepcopy(item))
    result = normalize_places(data, PLACE, "ru", STAMP)
    assert len(result["features"]) == 5 and len({entry["id"] for entry in result["features"]}) == 5
    assert all(entry["description"] is None for entry in result["features"])


@pytest.mark.parametrize("locale,wire_locale", [("ru", "ru_KZ"), ("kk", "kk_KZ"), ("en", "ru_KZ")])
def test_one_server_only_request_uses_name_strict_point_radius_and_minimal_fields(locale, wire_locale):
    seen = []

    def handler(request):
        seen.append(request)
        assert str(request.url).split("?")[0] == ENDPOINT and request.method == "GET"
        assert dict(request.url.params) == {
            "key": "fake-private-key", "q": "Sample Coffee", "type": "branch", "page_size": "5",
            "point": "71.4305,51.1283", "radius": "300", "locale": wire_locale,
            "search_is_query_text_complete": "true", "fields": FIELDS,
        }
        return httpx.Response(200, json=response())

    async def check():
        http = JsonHTTP(client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), retries=0, max_bytes=256_000)
        service = TwoGisPlacesService(enabled=True, api_key="fake-private-key", http=http)
        try:
            result = await service.search(PLACE, locale)
            assert result["status"] == "ok" and "fake-private-key" not in json.dumps(result)
        finally:
            await service.aclose()
    asyncio.run(check())
    assert len(seen) == 1


@pytest.mark.parametrize("code,expected", [(403, "provider_unavailable"), (429, "rate_limited"),
                                         (500, "provider_unavailable"), (504, "provider_unavailable")])
def test_http_200_embedded_meta_failure_is_not_success_and_is_logged_safely(code, expected, caplog):
    async def check():
        data = {"meta": {"code": code, "error": {"message": "private-provider-body"}}, "result": {"items": []}}
        http = JsonHTTP(client=httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=data))),
                        retries=0, max_bytes=256_000)
        service = TwoGisPlacesService(enabled=True, api_key="private-key", http=http)
        try:
            with pytest.raises(ProviderError, match=expected):
                await service.search(PLACE, "ru")
        finally:
            await service.aclose()
    asyncio.run(check())
    assert f"upstream_status={code}" in caplog.text and "reason=http_error" in caplog.text
    assert not any(secret in caplog.text for secret in ("private-provider-body", "private-key", "51.1283", ENDPOINT, "Sample Coffee"))


def test_meta_not_found_is_empty_not_failure_and_malformed_envelopes_are_rejected():
    assert normalize_places({"meta": {"code": 404}}, PLACE, "en", STAMP)["status"] == "empty"
    for data in ({}, {"meta": {"code": True}}, {"meta": {"code": "200"}},
                 {"meta": {"code": 200}, "result": {"items": "private"}},
                 {"meta": {"code": 200}, "result": {"items": [{}] * 51}}):
        with pytest.raises(ProviderError, match="invalid_provider_response"):
            normalize_places(data, PLACE, "en", STAMP)


def test_disabled_missing_key_invalid_locale_and_off_city_never_call_provider():
    class HTTP:
        async def request(self, *args, **kwargs):
            pytest.fail("must not call provider")
    for enabled, key, place, locale in [(False, "fake", PLACE, "en"), (True, "", PLACE, "en"),
                                       (True, "fake", {**PLACE, "location": {"lat": 0, "lon": 0}}, "en"),
                                       (True, "fake", PLACE, "invalid"),
                                       (True, "fake", {**PLACE, "name": ""}, "en")]:
        service = TwoGisPlacesService(enabled=enabled, api_key=key, http=HTTP())
        with pytest.raises(ProviderError):
            asyncio.run(service.search(place, locale))


@pytest.mark.parametrize("stamps", [[70, 75, 80, 85, 90, 95], list(range(-1000, -900)), [99]])
def test_global_minute_day_and_spacing_budgets_reject_before_network(stamps):
    class HTTP:
        async def request(self, *args, **kwargs):
            pytest.fail("budget must reject first")
    service = TwoGisPlacesService(enabled=True, api_key="fake", http=HTTP(), clock=lambda: 100)
    service.calls.extend(stamps)
    with pytest.raises(ProviderError, match="rate_limited"):
        asyncio.run(service.search(PLACE, "en"))


def test_failed_attempts_are_counted_429_has_cooldown_and_success_is_not_cached():
    now, calls = [100.0], []

    def handler(request):
        calls.append(request)
        data = {"meta": {"code": 429}} if len(calls) == 1 else response()
        return httpx.Response(200, json=data)

    async def check():
        http = JsonHTTP(client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), retries=0, max_bytes=256_000)
        service = TwoGisPlacesService(enabled=True, api_key="fake", http=http, clock=lambda: now[0])
        try:
            for stamp in (100, 106, 159):
                now[0] = stamp
                with pytest.raises(ProviderError, match="rate_limited"):
                    await service.search(PLACE, "ru")
            assert len(calls) == 1 and len(service.calls) == 1
            for stamp in (160, 166):
                now[0] = stamp
                assert (await service.search(PLACE, "ru"))["status"] == "ok"
            assert len(calls) == 3 and len(service.calls) == 3
        finally:
            await service.aclose()
    asyncio.run(check())


def test_timeout_includes_queue_cancels_provider_and_does_not_retry(monkeypatch, caplog):
    import astana_api.twogis_places as module
    monkeypatch.setattr(module, "_TIMEOUT_SECONDS", .01)

    class HTTP:
        calls, cancelled = 0, False

        async def request(self, *args, **kwargs):
            self.calls += 1
            try:
                await asyncio.sleep(60)
            finally:
                self.cancelled = True

    async def check():
        http = HTTP()
        service = TwoGisPlacesService(enabled=True, api_key="private-key", http=http)
        with pytest.raises(ProviderError, match="provider_unavailable"):
            await service.search(PLACE, "ru")
        assert http.calls == 1 and http.cancelled
        await service.gate.acquire()
        try:
            with pytest.raises(ProviderError, match="provider_unavailable"):
                await service.search(PLACE, "ru")
        finally:
            service.gate.release()
        assert http.calls == 1
    asyncio.run(check())
    assert "reason=timeout" in caplog.text and "private-key" not in caplog.text


def test_parent_cancellation_propagates_without_conversion_or_retry():
    cancelled = []

    class HTTP:
        async def request(self, *args, **kwargs):
            try:
                await asyncio.sleep(60)
            finally:
                cancelled.append(True)

    async def check():
        service = TwoGisPlacesService(enabled=True, api_key="fake", http=HTTP())
        task = asyncio.create_task(service.search(PLACE, "en"))
        await asyncio.sleep(.001)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    asyncio.run(check())
    assert cancelled == [True]


def test_oversized_provider_response_and_http_error_never_echo_provider_body(caplog):
    async def check(status, data):
        http = JsonHTTP(client=httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(status, json=data))),
                        retries=0, max_bytes=256_000)
        service = TwoGisPlacesService(enabled=True, api_key="private-key", http=http)
        try:
            with pytest.raises(ProviderError):
                await service.search(PLACE, "en")
        finally:
            await service.aclose()
    asyncio.run(check(200, {"private-provider-body": "x" * 256_000}))
    asyncio.run(check(403, {"error": "private-provider-body"}))
    assert "reason=response_too_large" in caplog.text and "upstream_status=403" in caplog.text
    assert "private-provider-body" not in caplog.text and "private-key" not in caplog.text


def test_default_transport_is_five_seconds_256k_zero_retries_and_missing_key_log_is_safe(caplog):
    async def check():
        service = TwoGisPlacesService(enabled=True, api_key="")
        try:
            assert service.http.timeout_seconds == 5 and service.http.retries == 0 and service.http.max_bytes == 256_000
        finally:
            await service.aclose()
    asyncio.run(check())
    assert "reason=key_not_configured" in caplog.text
    class HTTP:
        retries = 1
    with pytest.raises(ValueError, match="zero HTTP retries"):
        TwoGisPlacesService(enabled=True, api_key="fake", http=HTTP())
    class OversizedHTTP:
        max_bytes = 256_001
    with pytest.raises(ValueError, match="256000 bytes"):
        TwoGisPlacesService(enabled=True, api_key="fake", http=OversizedHTTP())
