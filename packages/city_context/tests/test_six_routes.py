"""Extended journeys exercise real HTTP parsing through offline transports."""
import asyncio
from copy import deepcopy
from datetime import datetime, timezone
import json
import math

import httpx
import pytest

from astana_contracts import validate_payload
from astana_city_context.common import JsonHTTP, ProviderError
from astana_city_context.osrm import OSRMWalkingRouter
from astana_city_context.routing import ORSWalkingRouter, _distance
from astana_city_context.tomtom import TomTomWalkingRouter

NOW = datetime(2026, 10, 19, 6, tzinfo=timezone.utc)
POINTS = [[71.4305, 51.1283], [71.4355, 51.1293], [71.4385, 51.1333],
          [71.4425, 51.1383], [71.4445, 51.1303], [71.4385, 51.1273], [71.4335, 51.1323]]
SECRET = "offline-six-stop-key"


def arguments(count=6, returned=False):
    return {"origin": {"lon": POINTS[0][0], "lat": POINTS[0][1]},
            "destinations": [{"lon": lon, "lat": lat} for lon, lat in POINTS[1:count + 1]],
            "transport": "walking", "return_to_origin": returned,
            "start_at": "2026-10-19T11:00:00+05:00"}


def requested(count=6, returned=False):
    points = deepcopy(POINTS[:count + 1])
    return points + [points[0].copy()] if returned else points


def paths(count=6, returned=False):
    points = requested(count, returned)
    return [[a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + .0002], b]
            for a, b in zip(points, points[1:])]


def geometry(provider, count=6, returned=False):
    parts = paths(count, returned)
    return [point for i, part in enumerate(parts)
            for point in (part if provider == "tomtom" or i == 0 else part[1:])]


def response(provider, count=6, returned=False):
    parts = paths(count, returned)
    distances = [sum(_distance(a, b) for a, b in zip(part, part[1:])) for part in parts]
    line = {"type": "LineString", "coordinates": geometry(provider, count, returned)}
    if provider == "ors":
        return {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": line,
                "properties": {"summary": {"distance": sum(distances), "duration": sum(distances) / 1.25},
                               "segments": [{"distance": d, "duration": d / 1.25,
                                             "way_points": [i * 2, i * 2 + 2]} for i, d in enumerate(distances)],
                               "way_points": list(range(0, len(parts) * 2 + 1, 2))}}],
                "metadata": {"timestamp": NOW.timestamp() * 1000,
                             "query": {"profile": "foot-walking", "coordinates": requested(count, returned)}}}
    if provider == "osrm":
        return {"code": "Ok", "waypoints": [{"location": p, "distance": 0} for p in requested(count, returned)],
                "routes": [{"geometry": line, "distance": sum(distances), "duration": sum(distances) / 1.25,
                            "legs": [{"distance": d, "duration": d / 1.25,
                                      "steps": [{"mode": "walking", "distance": d, "duration": d / 1.25,
                                                 "geometry": {"type": "LineString", "coordinates": part}}]}
                                     for d, part in zip(distances, parts)]}]}
    legs = [{"summary": {"lengthInMeters": round(d), "travelTimeInSeconds": round(d / 1.25)},
             "points": [{"longitude": lon, "latitude": lat} for lon, lat in part]}
            for d, part in zip(distances, parts)]
    return {"routes": [{"legs": legs,
                        "summary": {key: sum(leg["summary"][key] for leg in legs)
                                    for key in ("lengthInMeters", "travelTimeInSeconds")},
                        "sections": [{"sectionType": "TRAVEL_MODE", "travelMode": "pedestrian",
                                      "startPointIndex": 0, "endPointIndex": len(line["coordinates"]) - 1}]}]}


def router(provider, client, **kwargs):
    options = {"clock": lambda: NOW, **kwargs}
    if provider == "ors":
        return ORSWalkingRouter(client, api_key=SECRET, **options)
    if provider == "osrm":
        return OSRMWalkingRouter(client, **options)
    return TomTomWalkingRouter(client, api_key=SECRET, **options)


def assert_waypoints(request, count=6, returned=False):
    points = requested(count, returned)
    if request.url.host == "api.openrouteservice.org":
        payload = json.loads(request.content)
        assert request.method == "POST" and request.url.path.endswith("/foot-walking/geojson")
        assert payload["coordinates"] == points and payload["radiuses"] == [100] * len(points)
        assert payload["geometry_simplify"] is False
    elif request.url.host == "routing.openstreetmap.de":
        assert request.url.path == "/routed-foot/route/v1/foot/" + ";".join(f"{lon:.6f},{lat:.6f}" for lon, lat in points)
        assert request.url.params["radiuses"] == ";".join("100" for _ in points)
        assert request.url.params["steps"] == "true"
    else:
        assert request.url.host == "api.tomtom.com"
        assert request.url.path == "/routing/1/calculateRoute/" + ":".join(f"{lat:.7f},{lon:.7f}" for lon, lat in points) + "/json"
        assert request.url.params["computeBestOrder"] == "false"
        assert request.url.params["travelMode"] == "pedestrian"


@pytest.mark.parametrize("provider", ["ors", "osrm", "tomtom"])
@pytest.mark.parametrize("count", [4, 5, 6])
@pytest.mark.parametrize("returned", [False, True])
def test_extended_journey_preserves_every_ordered_waypoint_leg_and_geometry(provider, count, returned):
    async def run():
        calls = []
        data = response(provider, count, returned)

        def handle(request):
            calls.append(request)
            assert_waypoints(request, count, returned)
            return httpx.Response(200, json=data)

        client = JsonHTTP(client=httpx.AsyncClient(transport=httpx.MockTransport(handle)), retries=0)
        try:
            result = await router(provider, client).estimate_route(**arguments(count, returned))
            validate_payload("RouteEstimate", result)
            assert len(calls) == 1 and result["method"] == "routed"
            assert result["includes_return"] is returned
            assert result["geometry"]["coordinates"] == geometry(provider, count, returned)
            if provider == "tomtom":
                summary = data["routes"][0]["summary"]
                distance, duration = summary["lengthInMeters"], summary["travelTimeInSeconds"]
            else:
                distance = sum(_distance(a, b) for a, b in zip(geometry(provider, count, returned), geometry(provider, count, returned)[1:]))
                duration = math.ceil(distance / 1.25)
            assert result["distance_meters"] == pytest.approx(distance)
            assert result["duration_seconds"] == duration
            assert SECRET not in json.dumps(result)
        finally:
            await client.aclose()
    asyncio.run(run())


@pytest.mark.parametrize("provider", ["ors", "osrm", "tomtom"])
@pytest.mark.parametrize("problem", ["missing-return", "late-leg-distance", "reordered", "truncated-geometry"])
def test_six_stop_return_still_rejects_missing_reordered_or_shortened_legs(provider, problem):
    data = response(provider, returned=True)
    if provider == "ors":
        route = data["features"][0]
        if problem == "missing-return":
            route["properties"]["segments"].pop()
        elif problem == "late-leg-distance":
            route["properties"]["segments"][5]["distance"] = 1
        elif problem == "reordered":
            data["metadata"]["query"]["coordinates"][4:6] = reversed(data["metadata"]["query"]["coordinates"][4:6])
        else:
            route["geometry"]["coordinates"].pop()
    else:
        route = data["routes"][0]
        if problem == "missing-return":
            route["legs"].pop()
        elif problem == "late-leg-distance":
            if provider == "osrm":
                route["legs"][5]["distance"] = 1
            else:
                route["legs"][5]["summary"]["lengthInMeters"] = 1
        elif problem == "truncated-geometry":
            if provider == "osrm":
                route["geometry"]["coordinates"].pop()
            else:
                route["legs"][-1]["points"].pop()
        elif provider == "osrm":
            data["waypoints"][4:6] = reversed(data["waypoints"][4:6])
        else:
            route["legs"][4:6] = reversed(route["legs"][4:6])

    async def run():
        calls = []

        def handle(request):
            calls.append(request.url.host)
            return httpx.Response(503) if request.url.host == "routing.openstreetmap.de" and provider == "tomtom" else httpx.Response(200, json=data)

        client = JsonHTTP(client=httpx.AsyncClient(transport=httpx.MockTransport(handle)), retries=0)
        try:
            result = await router(provider, client).estimate_route(**arguments(returned=True))
            assert result["method"] == "approximate" and result["geometry"] is None
            points = requested(returned=True)
            assert result["distance_meters"] == pytest.approx(sum(_distance(a, b) for a, b in zip(points, points[1:])))
        finally:
            await client.aclose()
    asyncio.run(run())


@pytest.mark.parametrize("provider", ["ors", "osrm", "tomtom"])
@pytest.mark.parametrize("returned", [False, True])
def test_six_stop_provider_failure_keeps_all_approximate_legs_without_geometry(provider, returned):
    async def run():
        calls = []

        def handle(request):
            calls.append(request)
            assert_waypoints(request, returned=returned)
            return httpx.Response(503)

        client = JsonHTTP(client=httpx.AsyncClient(transport=httpx.MockTransport(handle)), retries=0)
        try:
            result = await router(provider, client).estimate_route(**arguments(returned=returned))
            assert len(calls) == (2 if provider == "tomtom" else 1)
            assert result["method"] == "approximate" and result["geometry"] is None
            assert result["includes_return"] is returned
            points = requested(returned=returned)
            distance = sum(_distance(a, b) for a, b in zip(points, points[1:]))
            assert result["distance_meters"] == distance
            assert result["duration_seconds"] == math.ceil(distance / 1.25)
        finally:
            await client.aclose()
    asyncio.run(run())


def test_tomtom_fallback_forwards_all_six_stops_and_return_to_osrm():
    async def run():
        calls = []

        def handle(request):
            calls.append(request.url.host)
            assert_waypoints(request, returned=True)
            return httpx.Response(503) if request.url.host == "api.tomtom.com" else httpx.Response(200, json=response("osrm", returned=True))

        client = JsonHTTP(client=httpx.AsyncClient(transport=httpx.MockTransport(handle)), retries=0)
        try:
            result = await router("tomtom", client).estimate_route(**arguments(returned=True))
            assert calls == ["api.tomtom.com", "routing.openstreetmap.de"]
            assert result["method"] == "routed" and result["provider"] == "FOSSGIS OSRM"
            assert result["geometry"]["coordinates"] == geometry("osrm", returned=True)
        finally:
            await client.aclose()
    asyncio.run(run())


@pytest.mark.parametrize("provider", ["ors", "osrm", "tomtom"])
@pytest.mark.parametrize("count", [0, 7])
def test_empty_or_seven_destinations_are_rejected_before_http(provider, count):
    async def run():
        calls = []
        client = JsonHTTP(client=httpx.AsyncClient(transport=httpx.MockTransport(lambda request: calls.append(request))), retries=0)
        args = arguments(0 if count == 0 else 6)
        if count == 7:
            args["destinations"].append({"lon": 71.45, "lat": 51.14})
        try:
            with pytest.raises(ProviderError, match="invalid_request"):
                await router(provider, client).estimate_route(**args)
            assert not calls
        finally:
            await client.aclose()
    asyncio.run(run())


def test_six_stop_return_endpoint_diagnostic_retains_seventh_leg_index(caplog):
    data = response("tomtom", returned=True)
    data["routes"][0]["legs"][-1]["points"][-1]["latitude"] += .01

    async def run():
        client = JsonHTTP(client=httpx.AsyncClient(transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json=data) if request.url.host == "api.tomtom.com" else httpx.Response(503))), retries=0)
        try:
            result = await router("tomtom", client).estimate_route(**arguments(returned=True))
            assert result["method"] == "approximate" and result["geometry"] is None
        finally:
            await client.aclose()
    asyncio.run(run())
    assert "check=endpoint" in caplog.text and "leg_index=6" in caplog.text
    assert SECRET not in caplog.text
