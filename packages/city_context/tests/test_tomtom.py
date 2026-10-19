"""Offline protocol tests: every HTTP call is intercepted by MockTransport."""
import asyncio
from copy import deepcopy
import json
import math
from types import SimpleNamespace

import httpx
import pytest

from astana_city_context.common import JsonHTTP, ProviderError
from astana_city_context import tomtom
from astana_city_context.provider import create_context
from astana_city_context.routing import _distance
from astana_city_context.tomtom import TomTomWalkingRouter

SECRET = "test-private-tomtom-key"
POINTS = [[71.4305, 51.1283], [71.4355, 51.1293], [71.4385, 51.1333], [71.4425, 51.1383]]


def arguments(*, count=1, returned=False):
    return {"origin": {"lon": POINTS[0][0], "lat": POINTS[0][1]},
            "destinations": [{"lon": p[0], "lat": p[1]} for p in POINTS[1:count + 1]],
            "transport": "walking", "return_to_origin": returned, "start_at": "2026-10-19T12:00:00+05:00"}


def paths(*, count=1, returned=False):
    stops = deepcopy(POINTS[:count + 1])
    if returned:
        stops.append(stops[0])
    return [[a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + .0005], b] for a, b in zip(stops, stops[1:])]


def response(*, count=1, returned=False):
    legs = []
    for part in paths(count=count, returned=returned):
        distance = round(sum(_distance(a, b) for a, b in zip(part, part[1:])))
        legs.append({"summary": {"lengthInMeters": distance, "travelTimeInSeconds": round(distance / 1.25)},
                     "points": [{"longitude": p[0], "latitude": p[1]} for p in part]})
    return {"routes": [{"summary": {key: sum(leg["summary"][key] for leg in legs)
                                     for key in ("lengthInMeters", "travelTimeInSeconds")},
                        "legs": legs, "sections": [{"sectionType": "TRAVEL_MODE", "travelMode": "pedestrian",
                                                    "startPointIndex": 0, "endPointIndex": len(legs) * 3 - 1}]}]}


def osrm_response():
    part = paths()[0]
    distance = sum(_distance(a, b) for a, b in zip(part, part[1:]))
    geometry = {"type": "LineString", "coordinates": part}
    return {"code": "Ok", "waypoints": [{"location": point, "distance": 0} for point in (part[0], part[-1])],
            "routes": [{"distance": distance, "duration": distance / 1.25, "geometry": geometry,
                        "legs": [{"distance": distance, "duration": distance / 1.25,
                                  "steps": [{"mode": "walking", "geometry": geometry,
                                             "distance": distance, "duration": distance / 1.25}]}]}]}


def http(handler):
    return JsonHTTP(client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), retries=0, timeout_seconds=10)


def test_ordered_three_stops_return_full_geometry_and_private_credential():
    async def run():
        calls = []
        def handle(request):
            calls.append(request)
            assert request.url.host == "api.tomtom.com"
            assert request.url.params["travelMode"] == "pedestrian"
            assert request.url.params["key"] == SECRET
            assert request.url.params["traffic"] == "false"
            assert request.url.params["computeBestOrder"] == "false"
            assert request.url.params["sectionType"] == "travelMode"
            assert request.url.params["coordinatePrecision"] == "full"
            assert request.url.params["departAt"] == "2026-10-19T07:00:00Z"
            expected = ":".join(f"{lat:.7f},{lon:.7f}" for lon, lat in [*POINTS, POINTS[0]])
            assert request.url.path == "/routing/1/calculateRoute/" + expected + "/json"
            return httpx.Response(200, json=response(count=3, returned=True))
        client = http(handle)
        try:
            router = TomTomWalkingRouter(client, api_key=SECRET)
            result = await router.estimate_route(**arguments(count=3, returned=True))
            assert result["method"] == "routed" and result["provider"] == "TomTom Maps"
            assert result["includes_return"] is True
            assert result["geometry"]["coordinates"] == [point for part in paths(count=3, returned=True) for point in part]
            assert result["distance_meters"] == response(count=3, returned=True)["routes"][0]["summary"]["lengthInMeters"]
            assert result["duration_seconds"] == response(count=3, returned=True)["routes"][0]["summary"]["travelTimeInSeconds"]
            assert result["evidence"][0]["source_url"] == tomtom.SOURCE_URL
            assert "© TomTom" in str(result["assumptions"])
            assert SECRET not in json.dumps(result)
            # A TomTom no-cache response is never silently reused, even if the
            # caller mutates the previous route or changes only departure time.
            result["geometry"]["coordinates"][0][0] = 0
            again = await router.estimate_route(**arguments(count=3, returned=True))
            assert len(calls) == 2 and again["geometry"]["coordinates"][0] == POINTS[0]
            assert not router._cache
        finally:
            await client.aclose()
    asyncio.run(run())


def test_explicit_pace_changes_only_routed_duration():
    async def run():
        client = http(lambda _: httpx.Response(200, json=response()))
        try:
            result = await TomTomWalkingRouter(client, api_key=SECRET, pace_mps=1).estimate_route(**arguments())
            assert result["duration_seconds"] == math.ceil(result["distance_meters"])
            assert result["geometry"]["coordinates"] == paths()[0]
            assert any("1 m/s" in note for note in result["assumptions"])
        finally:
            await client.aclose()
    asyncio.run(run())


@pytest.mark.parametrize("problem", ["driving", "other", "missing-section", "section-gap", "section-overflow",
                                      "missing-leg", "snap", "summary", "distance", "duration", "coordinate", "empty"])
def test_invalid_tomtom_route_falls_back_to_verified_osrm(problem, caplog):
    data = response()
    route = data["routes"][0]
    if problem in {"driving", "other"}:
        route["sections"][0]["travelMode"] = problem
    elif problem == "missing-section":
        route["sections"] = []
    elif problem == "section-gap":
        route["sections"][0]["startPointIndex"] = 1
    elif problem == "section-overflow":
        route["sections"][0]["endPointIndex"] = 3
    elif problem == "missing-leg":
        route["legs"] = []
    elif problem == "snap":
        route["legs"][0]["points"][0]["latitude"] += .02
    elif problem == "summary":
        route["summary"]["lengthInMeters"] = 1
    elif problem == "distance":
        route["legs"][0]["summary"]["lengthInMeters"] = 1
    elif problem == "duration":
        route["legs"][0]["summary"]["travelTimeInSeconds"] = -1
    elif problem == "coordinate":
        route["legs"][0]["points"][0]["longitude"] = True
    else:
        data = {"detailedError": {"message": SECRET}}
    async def run():
        calls = []
        def handle(request):
            calls.append(request.url.host)
            return httpx.Response(200, json=data if request.url.host == "api.tomtom.com" else osrm_response())
        client = http(handle)
        try:
            result = await TomTomWalkingRouter(client, api_key=SECRET).estimate_route(**arguments())
            assert calls == ["api.tomtom.com", "routing.openstreetmap.de"]
            assert result["method"] == "routed" and result["provider"] == "FOSSGIS OSRM"
            assert result["geometry"]["coordinates"] == paths()[0]
            assert any("OSRM foot route used" in note for note in result["assumptions"])
            assert SECRET not in json.dumps(result)
        finally:
            await client.aclose()
    asyncio.run(run())
    assert "service=routing reason=invalid_schema" in caplog.text
    assert SECRET not in caplog.text and "https://" not in caplog.text


@pytest.mark.parametrize("problem", ["reordered", "disconnected", "collapsed", "shortened", "missing-return"])
def test_rejects_false_stop_or_return_coverage(problem):
    data = response(count=2, returned=True)
    route = data["routes"][0]
    args = arguments(count=2, returned=True)
    if problem == "reordered":
        route["legs"].reverse()
    elif problem == "disconnected":
        route["legs"][1]["points"][0]["latitude"] += .00001
    elif problem == "missing-return":
        route["legs"].pop()
    else:
        # Distinct inputs within snapping tolerance must not collapse to zero.
        args = arguments()
        args["destinations"] = [{"lon": POINTS[0][0] + .001, "lat": POINTS[0][1]}]
        data = response()
        route = data["routes"][0]
        route["legs"][0]["points"] = [route["legs"][0]["points"][0]] * 3
        route["summary"] = route["legs"][0]["summary"] = {"lengthInMeters": 0, "travelTimeInSeconds": 0}
        if problem == "shortened":
            route["legs"][0]["points"] = deepcopy(route["legs"][0]["points"])
            route["legs"][0]["points"][-1]["longitude"] += .00001
            route["summary"] = route["legs"][0]["summary"] = {"lengthInMeters": 1, "travelTimeInSeconds": 1}
    async def run():
        client = http(lambda request: httpx.Response(200, json=data) if request.url.host == "api.tomtom.com" else httpx.Response(503))
        try:
            result = await TomTomWalkingRouter(client, api_key=SECRET).estimate_route(**args)
            assert result["method"] == "approximate" and result["geometry"] is None
        finally:
            await client.aclose()
    asyncio.run(run())


def test_missing_key_uses_osrm_without_sending_an_empty_key():
    async def run():
        calls = []
        def handle(request):
            calls.append(request)
            assert request.url.host == "routing.openstreetmap.de" and "key" not in request.url.params
            return httpx.Response(200, json=osrm_response())
        client = http(handle)
        try:
            router = TomTomWalkingRouter(client, api_key=None)
            result = await router.estimate_route(**arguments())
            assert router.available and len(calls) == 1 and result["provider"] == "FOSSGIS OSRM"
        finally:
            await client.aclose()
    asyncio.run(run())


@pytest.mark.parametrize("status", [401, 403, 429, 500])
def test_provider_errors_and_strict_policy_do_not_leak_secrets(status, caplog):
    async def run():
        client = http(lambda _: httpx.Response(status, json={"message": SECRET}))
        try:
            router = TomTomWalkingRouter(client, api_key=SECRET, allow_approximate=False)
            with pytest.raises(ProviderError, match="^provider_unavailable$"):
                await router.estimate_route(**arguments())
        finally:
            await client.aclose()
    asyncio.run(run())
    assert f"upstream_status={status}" in caplog.text
    assert "service=routing reason=http_error" in caplog.text
    assert SECRET not in caplog.text and "https://" not in caplog.text and "51.1283" not in caplog.text


def test_primary_timeout_leaves_time_for_osrm_and_cancellation_propagates(caplog):
    async def run():
        calls, cancelled = [], []
        async def handle(request):
            calls.append(request.url.host)
            if request.url.host == "api.tomtom.com":
                try:
                    await asyncio.sleep(10)
                except asyncio.CancelledError:
                    cancelled.append(True)
                    raise
            return httpx.Response(200, json=osrm_response())
        client = http(handle)
        try:
            router = TomTomWalkingRouter(client, api_key=SECRET, timeout_seconds=.1)
            result = await asyncio.wait_for(router.estimate_route(**arguments()), .5)
            assert result["provider"] == "FOSSGIS OSRM" and len(calls) == 2 and cancelled == [True]
            task = asyncio.create_task(router.estimate_route(**arguments()))
            await asyncio.sleep(.005)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert cancelled == [True, True]
        finally:
            await client.aclose()
    asyncio.run(run())
    assert "service=routing reason=timeout" in caplog.text
    assert SECRET not in caplog.text


def test_total_deadline_bounds_both_slow_providers():
    async def run():
        calls = []
        async def handle(request):
            calls.append(request.url.host)
            await asyncio.sleep(10)
            raise AssertionError("deadline did not cancel request")
        client = http(handle)
        try:
            router = TomTomWalkingRouter(client, api_key=SECRET, timeout_seconds=.1)
            result = await asyncio.wait_for(router.estimate_route(**arguments()), .5)
            assert len(calls) == 2 and result["method"] == "approximate" and result["geometry"] is None
            assert not router._cache
        finally:
            await client.aclose()
    asyncio.run(run())


def test_retry_after_cooldown_and_local_quota_do_not_make_extra_calls(monkeypatch):
    async def run():
        clock = [100.0]
        monkeypatch.setattr(tomtom, "time", SimpleNamespace(monotonic=lambda: clock[0]))
        calls = []
        def handle(request):
            calls.append(request.url.host)
            if request.url.host == "api.tomtom.com":
                return httpx.Response(429, headers={"Retry-After": "120"})
            return httpx.Response(200, json=osrm_response())
        client = http(handle)
        try:
            router = TomTomWalkingRouter(client, api_key=SECRET)
            await router.estimate_route(**arguments())
            assert router._cooldown == 220
            clock[0] = 200
            await router.estimate_route(**arguments())
            assert router._cooldown == 220
            assert calls.count("api.tomtom.com") == 1
            # Once cooldown expires, the separate local budget may still reject;
            # this neither sends another request nor pushes Retry-After forward.
            router._request_times.extend([router.clock()] * 10)
            clock[0] = 221
            await router.estimate_route(**arguments())
            assert calls.count("api.tomtom.com") == 1 and router._cooldown == 220
        finally:
            await client.aclose()
    asyncio.run(run())


@pytest.mark.parametrize("change", [{"transport": "driving"}, {"destinations": []}, {"return_to_origin": "true"},
                                   {"start_at": "no-time"}, {"origin": {"lat": True, "lon": 71.4}}])
def test_invalid_inputs_never_reach_either_provider(change):
    async def run():
        def handle(_):
            raise AssertionError("invalid input reached network")
        client = http(handle)
        try:
            with pytest.raises(ProviderError):
                await TomTomWalkingRouter(client, api_key=SECRET).estimate_route(**{**arguments(), **change})
        finally:
            await client.aclose()
    asyncio.run(run())


def test_factory_explicit_opt_in_uses_one_owned_http_and_caps_deadline(monkeypatch):
    import astana_city_context.provider as module
    async def run():
        client = http(lambda _: httpx.Response(200, json=response()))
        configs = []
        def make_http(**config):
            configs.append(config)
            return client
        monkeypatch.setattr(module, "JsonHTTP", make_http)
        monkeypatch.setenv("ROUTING_PROVIDER", "tomtom")
        monkeypatch.setenv("TOMTOM_API_KEY", SECRET)
        monkeypatch.setenv("ASTANA_CONTEXT_TIMEOUT_SECONDS", "10")
        monkeypatch.setenv("ASTANA_CONTEXT_RETRIES", "2")
        context = await create_context(config={"mode": "live", "timezone": "Asia/Almaty"})
        try:
            assert isinstance(context.router, TomTomWalkingRouter)
            assert context.router.timeout_seconds == 6.5
            assert configs == [{"timeout_seconds": 10, "retries": 0}]
            assert context.router.http is context.router.fallback.http is context._http
            assert (await context.estimate_route(**arguments()))["provider"] == "TomTom Maps"
        finally:
            await context.aclose()
        assert client._closed and client._client.is_closed
    asyncio.run(run())
