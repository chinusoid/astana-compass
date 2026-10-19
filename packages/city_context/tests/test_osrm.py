import asyncio
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from astana_city_context.osrm import OSRMWalkingRouter
from astana_city_context.routing import _distance
from astana_city_context.common import ProviderError
from astana_city_context import osrm

POINTS = [[71.4305, 51.1283], [71.431, 51.1283], [71.4315, 51.1293]]


def response():
    distance = sum(_distance(a, b) for a, b in zip(POINTS, POINTS[1:]))
    geometry = {"type": "LineString", "coordinates": deepcopy(POINTS)}
    return {"code": "Ok", "waypoints": [{"location": p, "distance": 0} for p in [POINTS[0], POINTS[-1]]],
            "routes": [{"geometry": geometry, "distance": distance, "duration": distance / 1.25,
                        "legs": [{"distance": distance, "duration": distance / 1.25,
                                  "steps": [{"mode": "walking", "geometry": deepcopy(geometry),
                                             "distance": distance, "duration": distance / 1.25}]}]}]}


class HTTP:
    def __init__(self, data=None, error=None):
        self.data = data or response()
        self.calls = []
        self.error = error

    async def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if self.error:
            raise self.error
        return deepcopy(self.data)


def arguments():
    return {"origin": {"lon": POINTS[0][0], "lat": POINTS[0][1]},
            "destinations": [{"lon": POINTS[-1][0], "lat": POINTS[-1][1]}], "transport": "walking",
            "return_to_origin": False, "start_at": "2026-10-19T12:00:00+05:00"}


def test_foot_endpoint_verified_geometry_and_cache_retain_retrieval_time():
    async def check():
        http = HTTP()
        router = OSRMWalkingRouter(http)
        first = await router.estimate_route(**arguments())
        second = await router.estimate_route(**{**arguments(), "start_at": "2026-10-20T12:00:00+05:00"})
        assert first == second
        assert first["method"] == "routed"
        assert first["geometry"]["coordinates"] == POINTS
        assert len(http.calls) == 1
        assert http.calls[0][1].startswith("https://routing.openstreetmap.de/routed-foot/route/v1/foot/")
        assert http.calls[0][2]["params"]["steps"] == "true"
        second["geometry"]["coordinates"][0][0] = 0
        assert first["geometry"]["coordinates"][0][0] != 0
    asyncio.run(check())


@pytest.mark.parametrize("problem", ["driving", "snap", "disconnected", "summary", "overview", "missing-leg"])
def test_rejects_wrong_or_incomplete_routes(problem):
    data = response()
    if problem == "driving":
        data["routes"][0]["legs"][0]["steps"][0]["mode"] = "driving"
    elif problem == "snap":
        data["waypoints"][0]["distance"] = 101
    elif problem == "disconnected":
        data["routes"][0]["legs"][0]["steps"][0]["geometry"]["coordinates"][0] = [71.5, 51.2]
    elif problem == "summary":
        data["routes"][0]["distance"] = 1
    elif problem == "overview":
        data["routes"][0]["geometry"]["coordinates"] = [POINTS[0], POINTS[-1]]
    else:
        data["routes"][0]["legs"] = []
    result = asyncio.run(OSRMWalkingRouter(HTTP(data)).estimate_route(**arguments()))
    assert result["method"] == "approximate" and result["geometry"] is None


def test_rate_limit_cooldown_prevents_more_provider_requests():
    async def check():
        http = HTTP(error=ProviderError("rate_limited", retryable=True, retry_after_seconds=120))
        router = OSRMWalkingRouter(http, allow_approximate=False, clock=lambda: datetime.now(timezone.utc))
        for _ in range(2):
            with pytest.raises(ProviderError, match="rate_limited"):
                await router.estimate_route(**arguments())
        assert len(http.calls) == 1
    asyncio.run(check())


def test_distinct_requested_points_cannot_collapse_to_a_zero_route():
    data = response()
    point = POINTS[0]
    requested = {**arguments(), "destinations": [{"lon": point[0] + .0005, "lat": point[1]}]}
    collapsed = {"type": "LineString", "coordinates": [point, point]}
    data["waypoints"] = [{"location": point, "distance": 0}, {"location": point, "distance": 35}]
    data["routes"] = [{"geometry": collapsed, "distance": 0, "duration": 0,
                       "legs": [{"distance": 0, "duration": 0, "steps": [
                           {"mode": "walking", "geometry": collapsed, "distance": 0, "duration": 0}]}]}]
    route = asyncio.run(OSRMWalkingRouter(HTTP(data)).estimate_route(**requested))
    assert route["method"] == "approximate" and route["geometry"] is None
    assert route["distance_meters"] > 0 and route["duration_seconds"] > 0
    with pytest.raises(ProviderError, match="provider_unavailable"):
        asyncio.run(OSRMWalkingRouter(HTTP(data), allow_approximate=False).estimate_route(**requested))


def test_repeated_local_rejection_does_not_extend_provider_retry_after(monkeypatch):
    tick = [100.0]
    monkeypatch.setattr(osrm, "time", SimpleNamespace(monotonic=lambda: tick[0]))

    async def check():
        http = HTTP(error=ProviderError("rate_limited", retryable=True, retry_after_seconds=120))
        router = OSRMWalkingRouter(http, allow_approximate=False)
        with pytest.raises(ProviderError, match="rate_limited"):
            await router.estimate_route(**arguments())
        deadline = router._cooldown
        assert deadline == 220
        for tick[0] in (130, 180, 219):
            with pytest.raises(ProviderError, match="rate_limited"):
                await router.estimate_route(**arguments())
            assert router._cooldown == deadline
        assert len(http.calls) == 1
        tick[0] = 221
        http.error = None
        route = await router.estimate_route(**arguments())
        assert route["method"] == "routed" and len(http.calls) == 2

    asyncio.run(check())
