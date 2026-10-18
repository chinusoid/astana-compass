"""Provider boundary tests: deterministic mocked ORS responses, never live fixtures."""
import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import math

import pytest
from astana_contracts import validate_payload

from astana_city_context.common import ProviderError
from astana_city_context.routing import ORSWalkingRouter, _distance

NOW = datetime(2026, 10, 19, 6, tzinfo=timezone.utc)
ORIGIN = {"lat": 51.128, "lon": 71.430}
STOPS = [{"lat": 51.135, "lon": 71.440}, {"lat": 51.142, "lon": 71.450},
         {"lat": 51.149, "lon": 71.460}]


def run(router, count=1, returned=False, **changes):
    args = {"origin": deepcopy(ORIGIN), "destinations": deepcopy(STOPS[:count]),
            "transport": "walking", "return_to_origin": returned, "start_at": "2026-10-19T11:00:00+05:00"}
    args.update(changes)
    return asyncio.run(router.estimate_route(**args))


def response(count=1, returned=False):
    points = [[p["lon"], p["lat"]] for p in [ORIGIN, *STOPS[:count]]]
    if returned:
        points.append(points[0].copy())
    distances = [_distance(a, b) for a, b in zip(points, points[1:])]
    return {
        "type": "FeatureCollection", "features": [{"type": "Feature",
            "geometry": {"type": "LineString", "coordinates": points},
            "properties": {"summary": {"distance": sum(distances), "duration": sum(distances) / 1.4},
                           "segments": [{"distance": d, "duration": d / 1.4} for d in distances],
                           "way_points": list(range(len(points)))}}],
        "metadata": {"timestamp": NOW.timestamp() * 1000,
                     "query": {"profile": "foot-walking", "coordinates": deepcopy(points)}},
    }


class FakeHTTP:
    def __init__(self, data=None, error=None):
        self.data = response() if data is None else data
        self.error = error
        self.calls = []

    async def request(self, method, url, **kwargs):
        self.calls.append((method, url, deepcopy(kwargs)))
        if self.error:
            raise self.error
        return deepcopy(self.data)


def router(http=None, **kwargs):
    return ORSWalkingRouter(http or FakeHTTP(), api_key="mock-test-key", clock=lambda: NOW, **kwargs)


@pytest.mark.parametrize("count", [1, 2, 3])
@pytest.mark.parametrize("returned", [False, True])
def test_real_route_preserves_every_ordered_leg_and_return(count, returned):
    http = FakeHTTP(response(count, returned))
    result = run(router(http), count, returned)
    validate_payload("RouteEstimate", result)
    assert result["method"] == "routed"
    assert result["includes_return"] is returned
    coords = [[p["lon"], p["lat"]] for p in [ORIGIN, *STOPS[:count]]]
    if returned:
        coords.append(coords[0])
    assert result["geometry"]["coordinates"] == coords
    assert result["distance_meters"] == sum(_distance(a, b) for a, b in zip(coords, coords[1:]))
    method, url, args = http.calls[0]
    assert method == "POST"
    assert url.endswith("/foot-walking/geojson")
    assert "driving" not in url
    assert args["json"]["coordinates"] == coords
    assert args["json"]["radiuses"] == [100] * len(coords)
    assert args["json"]["geometry_simplify"] is False
    assert result["generated_at"] == "2026-10-19T06:00:00Z"
    assert result["evidence"][0]["is_synthetic"] is False
    assert "mock-test-key" not in str(result)


@pytest.mark.parametrize("count", [1, 2, 3])
@pytest.mark.parametrize("returned", [False, True])
def test_no_key_honest_estimate_without_fabricated_geometry(count, returned):
    http = FakeHTTP()
    provider = ORSWalkingRouter(http, api_key=None, clock=lambda: NOW)
    result = run(provider, count, returned)
    assert result["method"] == "approximate"
    assert result["geometry"] is None
    assert result["provider"] == "local-haversine"
    assert "1.25 m/s" in " ".join(result["assumptions"])
    assert "routing_key_not_configured" in " ".join(result["assumptions"])
    assert result["includes_return"] is returned
    points = [[p["lon"], p["lat"]] for p in [ORIGIN, *STOPS[:count]]]
    if returned:
        points.append(points[0])
    assert result["distance_meters"] == sum(_distance(a, b) for a, b in zip(points, points[1:]))
    assert http.calls == []


def test_absent_key_strict_policy_errors():
    provider = ORSWalkingRouter(FakeHTTP(), api_key=None, allow_approximate=False, clock=lambda: NOW)
    with pytest.raises(ProviderError, match="provider_unavailable"):
        run(provider)


@pytest.mark.parametrize("transport", ["driving", "cycling", "flying", None])
def test_never_substitutes_transport(transport):
    http = FakeHTTP()
    with pytest.raises(ProviderError, match="unsupported_transport"):
        run(router(http), transport=transport)
    assert not http.calls


@pytest.mark.parametrize("mutation", [
    lambda r: r["features"][0].pop("geometry"),
    lambda r: r["features"][0]["geometry"].update(type="MultiLineString"),
    lambda r: r["features"][0]["geometry"].update(coordinates=[[51.128, 71.43], [51.135, 71.44]]),
    lambda r: r["features"][0]["geometry"]["coordinates"][1].__setitem__(0, 72),
    lambda r: r["features"][0]["geometry"]["coordinates"][0].__setitem__(0, float("nan")),
    lambda r: r["features"][0]["properties"].update(way_points=[1, 0]),
    lambda r: r["features"][0]["properties"].update(way_points=[0, True]),
    lambda r: r["features"][0]["properties"].update(way_points=[0]),
    lambda r: r["features"][0]["properties"].update(segments=[]),
    lambda r: r["features"][0]["properties"]["summary"].update(distance=0),
    lambda r: r["features"][0]["properties"]["segments"][0].update(duration=-1),
    lambda r: r["features"][0]["properties"]["segments"][0].update(distance=float("inf")),
    lambda r: r["metadata"].pop("timestamp"),
    lambda r: r["metadata"]["query"].update(profile="driving-car"),
    lambda r: r["metadata"]["query"]["coordinates"].reverse(),
    lambda r: r["features"].append(deepcopy(r["features"][0])),
])
def test_malformed_provider_never_returns_routed(mutation):
    data = response()
    mutation(data)
    assert run(router(FakeHTTP(data)))["method"] == "approximate"
    with pytest.raises(ProviderError, match="provider_unavailable"):
        run(router(FakeHTTP(data), allow_approximate=False))


def test_missing_middle_stop_and_truncated_return_are_rejected():
    data = response(3, True)
    properties = data["features"][0]["properties"]
    properties["way_points"] = [0, 1, 1, 3, 4]
    assert run(router(FakeHTTP(data)), 3, True)["method"] == "approximate"
    data = response(3, True)
    data["features"][0]["geometry"]["coordinates"].pop()
    assert run(router(FakeHTTP(data)), 3, True)["method"] == "approximate"


def test_impossible_geometry_leg_distance_is_rejected():
    data = response()
    data["features"][0]["properties"]["segments"][0]["distance"] = 100000
    data["features"][0]["properties"]["summary"]["distance"] = 100000
    assert run(router(FakeHTTP(data)))["method"] == "approximate"


def snapped_response(destinations, returned, coordinates):
    """Consistent graph geometry/totals with independently requested waypoints."""
    data = response(len(destinations), returned)
    points = [[p["lon"], p["lat"]] for p in [ORIGIN, *destinations]]
    if returned:
        points.append(points[0].copy())
    data["metadata"]["query"]["coordinates"] = points
    feature = data["features"][0]
    feature["geometry"]["coordinates"] = deepcopy(coordinates)
    distances = [_distance(a, b) for a, b in zip(coordinates, coordinates[1:])]
    feature["properties"] = {
        "way_points": list(range(len(coordinates))),
        "segments": [{"distance": d, "duration": d / 1.4} for d in distances],
        "summary": {"distance": sum(distances), "duration": sum(distances) / 1.4},
    }
    return data


@pytest.mark.parametrize("count", [1, 2, 3])
@pytest.mark.parametrize("returned", [False, True])
def test_distinct_requested_stops_cannot_collapse_to_zero_trip(count, returned):
    destinations = [{"lat": ORIGIN["lat"] + (i + 1) * 0.0005, "lon": ORIGIN["lon"]}
                    for i in range(count)]
    midpoint = [ORIGIN["lon"], (ORIGIN["lat"] + destinations[-1]["lat"]) / 2]
    coordinates = [midpoint.copy() for _ in range(1 + count + int(returned))]
    data = snapped_response(destinations, returned, coordinates)
    points = data["metadata"]["query"]["coordinates"]
    assert all(_distance(point, midpoint) < 100 for point in points)
    result = run(router(FakeHTTP(data)), count, returned, destinations=destinations)
    assert result["method"] == "approximate" and result["geometry"] is None
    assert result["duration_seconds"] > 0
    assert result["distance_meters"] == sum(_distance(a, b) for a, b in zip(points, points[1:]))
    with pytest.raises(ProviderError, match="provider_unavailable"):
        run(router(FakeHTTP(data), allow_approximate=False), count, returned,
            destinations=destinations)


@pytest.mark.parametrize("leg_index", [0, 1, 2, 3])
def test_each_selected_leg_and_return_are_checked_even_when_total_hides_collapse(leg_index):
    destinations = [{"lat": ORIGIN["lat"] + (i + 1) * 0.0002, "lon": ORIGIN["lon"]}
                    for i in range(3)]
    points = [[p["lon"], p["lat"]] for p in [ORIGIN, *destinations, ORIGIN]]
    coordinates = deepcopy(points)
    coordinates[leg_index + 1] = coordinates[leg_index].copy()
    data = snapped_response(destinations, True, coordinates)
    # Snapping a middle stop backward makes the next leg longer: validating
    # only the trip total would miss that the requested stop was skipped.
    if leg_index < 2:
        assert math.isclose(data["features"][0]["properties"]["summary"]["distance"],
                            sum(_distance(a, b) for a, b in zip(points, points[1:])))
    assert run(router(FakeHTTP(data)), 3, True, destinations=destinations)["method"] == "approximate"


def test_nonzero_snapped_shortcut_cannot_understate_requested_leg():
    destinations = [{"lat": ORIGIN["lat"] + 0.0012, "lon": ORIGIN["lon"]}]
    coordinates = [[ORIGIN["lon"], ORIGIN["lat"] + offset] for offset in [0.0005, 0.0007]]
    data = snapped_response(destinations, False, coordinates)
    assert data["features"][0]["properties"]["summary"]["distance"] > 0
    assert run(router(FakeHTTP(data)), destinations=destinations)["method"] == "approximate"


def test_zero_leg_cannot_use_rounding_tolerance_to_skip_a_distinct_nearby_stop():
    destinations = [{"lat": ORIGIN["lat"] + 0.000001, "lon": ORIGIN["lon"]}]
    coordinates = [[ORIGIN["lon"], ORIGIN["lat"]]] * 2
    data = snapped_response(destinations, False, coordinates)
    assert run(router(FakeHTTP(data)), destinations=destinations)["method"] == "approximate"


@pytest.mark.parametrize("returned", [False, True])
def test_zero_trip_remains_valid_for_coincident_requested_locations(returned):
    destinations = [deepcopy(ORIGIN)]
    coordinates = [[ORIGIN["lon"], ORIGIN["lat"]]] * (2 + int(returned))
    data = snapped_response(destinations, returned, coordinates)
    result = run(router(FakeHTTP(data), allow_approximate=False), 1, returned,
                 destinations=destinations)
    assert result["method"] == "routed" and result["duration_seconds"] == 0


def test_small_nonzero_snap_keeps_existing_distance_rounding_tolerance():
    destinations = [{"lat": ORIGIN["lat"] + 0.001, "lon": ORIGIN["lon"]}]
    coordinates = [[ORIGIN["lon"], ORIGIN["lat"] + 0.00004],
                   [destinations[0]["lon"], destinations[0]["lat"]]]
    data = snapped_response(destinations, False, coordinates)
    result = run(router(FakeHTTP(data), allow_approximate=False), destinations=destinations)
    assert result["method"] == "routed"


@pytest.mark.parametrize("error", [ProviderError("provider_unavailable", retryable=True),
                                  ProviderError("rate_limited", retryable=True)])
def test_timeout_and_quota_honest_fallback_or_strict_error(error):
    result = run(router(FakeHTTP(error=error)))
    assert result["method"] == "approximate"
    assert error.code in " ".join(result["assumptions"])
    with pytest.raises(ProviderError) as exc:
        run(router(FakeHTTP(error=error), allow_approximate=False))
    assert exc.value is error


def test_cache_copies_expiry_and_all_behavior_parameters():
    current = [NOW]
    http = FakeHTTP()
    provider = ORSWalkingRouter(http, api_key="key-a", clock=lambda: current[0])
    first = run(provider)
    first["geometry"]["coordinates"][0][0] = 0
    second = run(provider)
    assert second["geometry"]["coordinates"][0][0] == ORIGIN["lon"]
    assert len(http.calls) == 1
    run(provider, start_at="2026-10-19T11:01:00+05:00")
    assert len(http.calls) == 2
    provider.pace_mps = 1.0
    paced = run(provider)
    assert paced["duration_seconds"] == math.ceil(paced["distance_meters"])
    assert len(http.calls) == 3
    provider.api_key = "key-b"
    run(provider)
    assert len(http.calls) == 4
    current[0] += timedelta(seconds=301)
    run(provider)
    assert len(http.calls) == 5


def test_cache_bounded_and_no_key_change_does_not_reuse_fallback():
    http = FakeHTTP()
    provider = ORSWalkingRouter(http, api_key=None, clock=lambda: NOW)
    assert run(provider)["method"] == "approximate"
    provider.api_key = "configured"
    assert run(provider)["method"] == "routed"
    for second in range(140):
        run(provider, start_at=(NOW + timedelta(seconds=second)).isoformat())
    assert len(provider._cache) <= 128


@pytest.mark.parametrize("changes", [
    {"destinations": []}, {"destinations": STOPS + [ORIGIN]},
    {"origin": {"lat": 500, "lon": 71}}, {"origin": {"lat": True, "lon": 71}},
    {"return_to_origin": 1}, {"start_at": "2026-10-19T11:00:00"},
])
def test_invalid_requests_never_reach_provider(changes):
    http = FakeHTTP()
    with pytest.raises(ProviderError, match="invalid_request"):
        run(router(http), **changes)
    assert not http.calls


@pytest.mark.parametrize("pace", [0, -1, float("nan"), float("inf"), True])
def test_invalid_pace_is_rejected(pace):
    with pytest.raises(ValueError):
        router(pace_mps=pace)


def test_evidence_retrieved_after_http_not_request_start():
    current = [NOW]

    class DelayedHTTP(FakeHTTP):
        async def request(self, method, url, **kwargs):
            result = await super().request(method, url, **kwargs)
            current[0] += timedelta(seconds=4)
            return result

    provider = ORSWalkingRouter(DelayedHTTP(), api_key="mock", clock=lambda: current[0])
    result = run(provider)
    assert result["generated_at"] == "2026-10-19T06:00:00Z"
    assert result["evidence"][0]["retrieved_at"] == "2026-10-19T06:00:04Z"
    assert run(provider)["evidence"][0]["retrieved_at"] == "2026-10-19T06:00:04Z"


@pytest.mark.parametrize("offset", [-301, -86400, 61, 86400])
def test_stale_or_future_provider_timestamp_rejected(offset):
    data = response()
    data["metadata"]["timestamp"] = (NOW + timedelta(seconds=offset)).timestamp() * 1000
    assert run(router(FakeHTTP(data)))["method"] == "approximate"
    with pytest.raises(ProviderError, match="provider_unavailable"):
        run(router(FakeHTTP(data), allow_approximate=False))


def test_rolling_minute_budget_resets_and_cache_hits_do_not_consume_budget():
    current = [NOW]
    http = FakeHTTP()
    provider = ORSWalkingRouter(http, api_key="mock", clock=lambda: current[0])
    run(provider)
    for _ in range(20):
        run(provider)
    assert len(http.calls) == 1
    for second in range(1, 10):
        assert run(provider, start_at=(NOW + timedelta(seconds=second)).isoformat())["method"] == "routed"
    limited = run(provider, start_at=(NOW + timedelta(seconds=10)).isoformat())
    assert limited["method"] == "approximate"
    assert "rate_limited" in " ".join(limited["assumptions"])
    assert len(http.calls) == 10
    current[0] += timedelta(seconds=60)
    assert run(provider, start_at=(NOW + timedelta(seconds=11)).isoformat())["method"] == "routed"
    assert len(http.calls) == 11


def test_rolling_daily_budget_bounds_history_and_counts_failed_requests():
    current = [NOW]
    http = FakeHTTP(error=ProviderError("provider_unavailable", retryable=True))
    provider = ORSWalkingRouter(http, api_key="mock", clock=lambda: current[0], allow_approximate=False)
    for minute in range(60):
        current[0] = NOW + timedelta(minutes=minute)
        for second in range(10):
            with pytest.raises(ProviderError, match="provider_unavailable"):
                run(provider, start_at=(current[0] + timedelta(seconds=second)).isoformat())
    assert len(http.calls) == 600
    assert len(provider._request_times) == 600
    current[0] = NOW + timedelta(hours=2)
    with pytest.raises(ProviderError, match="rate_limited") as exc:
        run(provider, start_at=current[0].isoformat())
    assert exc.value.retryable is True
    assert len(http.calls) == 600
    current[0] = NOW + timedelta(days=1)
    with pytest.raises(ProviderError, match="provider_unavailable"):
        run(provider, start_at=current[0].isoformat())
    assert len(http.calls) == 601
    assert len(provider._request_times) <= 600
