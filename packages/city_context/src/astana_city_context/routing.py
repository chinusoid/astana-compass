"""Ordered walking routes with verified ORS geometry and explicit degraded estimates."""
from __future__ import annotations

from collections import OrderedDict, deque
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import math
from typing import Callable

from astana_contracts import validate_payload
from astana_contracts.validation import JSON

from .common import JsonHTTP, ProviderError, parse_instant, utc_now

_ENDPOINT = "https://api.openrouteservice.org/v2/directions/foot-walking/geojson"
_PROFILE = "foot-walking"
_SNAP_METERS = 100
_CACHE_SECONDS = 300
_FALLBACK_CACHE_SECONDS = 30
_CACHE_ENTRIES = 128
_DEFAULT_PACE_MPS = 1.25
_ATTRIBUTION = "© openrouteservice by HeiGIT | Data from OpenStreetMap"
_REQUESTS_PER_MINUTE = 10
_REQUESTS_PER_DAY = 600


def _number(value: object) -> float:
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        raise ValueError("Invalid provider numeric field")
    return float(value)


def _distance(a: list[float], b: list[float]) -> float:
    """Great-circle distance in meters; input is GeoJSON longitude, latitude."""
    lon1, lat1, lon2, lat2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6_371_008.8 * 2 * math.asin(math.sqrt(min(1.0, h)))


def _stamp(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Timezone-aware clock required")
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class ORSWalkingRouter:
    """Implements the canonical route port; destination order is never optimized."""

    def __init__(
        self, http: JsonHTTP, *, api_key: str | None,
        clock: Callable[[], datetime] = utc_now,
        pace_mps: float | None = None, allow_approximate: bool = True,
    ) -> None:
        self.http = http
        self.api_key = api_key
        self.clock = clock
        self.pace_mps = pace_mps
        self.allow_approximate = allow_approximate
        self._cache: OrderedDict[str, tuple[datetime, JSON, int]] = OrderedDict()
        self._request_times: deque[datetime] = deque(maxlen=_REQUESTS_PER_DAY)
        self._validate_pace()

    @property
    def available(self) -> bool:
        """Whether a provider credential is configured; does not claim live availability."""
        return bool(self.api_key)

    @property
    def unavailable_reason(self) -> str | None:
        return None if self.available else "routing_key_not_configured"

    def _validate_pace(self) -> None:
        if self.pace_mps is not None and (
            type(self.pace_mps) not in (int, float)
            or not math.isfinite(self.pace_mps) or self.pace_mps <= 0
        ):
            raise ValueError("pace_mps must be finite and positive")

    def _reserve_request(self, now: datetime) -> None:
        """Reserve before awaiting I/O; rejected calls never reach the provider.

        One logical request can make at most three JsonHTTP attempts. The local
        rolling budget therefore caps attempts at 30/minute and 1800/day.
        """
        while self._request_times and (now - self._request_times[0]).total_seconds() >= 86400:
            self._request_times.popleft()
        minute_count = sum((now - instant).total_seconds() < 60 for instant in self._request_times)
        if len(self._request_times) >= _REQUESTS_PER_DAY or minute_count >= _REQUESTS_PER_MINUTE:
            raise ProviderError("rate_limited", retryable=True)
        self._request_times.append(now)

    async def estimate_route(
        self, *, origin: JSON, destinations: list[JSON], transport: str,
        return_to_origin: bool, start_at: str,
    ) -> JSON:
        if transport != "walking":
            raise ProviderError("unsupported_transport")
        try:
            self._validate_pace()
            validate_payload("Location", origin)
            if type(destinations) is not list or not 1 <= len(destinations) <= 3:
                raise ValueError("One to three destinations required")
            for destination in destinations:
                validate_payload("Location", destination)
            if type(return_to_origin) is not bool or type(start_at) is not str:
                raise ValueError("Invalid route request")
            start = parse_instant(start_at)
            start_stamp = _stamp(start)
        except (ValueError, TypeError, KeyError):
            raise ProviderError("invalid_request") from None
        points = [[location["lon"], location["lat"]] for location in [origin, *destinations]]
        if return_to_origin:
            points.append(points[0].copy())
        now = self.clock()
        generated_at = _stamp(now)
        request_key = json.dumps({
            "points": points, "transport": transport, "return": return_to_origin,
            "start_at": start_stamp, "profile": _PROFILE, "pace_mps": self.pace_mps,
            "allow_approximate": self.allow_approximate, "endpoint": _ENDPOINT,
            "credential": hashlib.sha256((self.api_key or "").encode()).hexdigest(),
            "snapping_meters": _SNAP_METERS,
        }, sort_keys=True, separators=(",", ":"))
        key = hashlib.sha256(request_key.encode()).hexdigest()
        cached = self._cache.get(key)
        if cached is not None:
            cached_at, payload, ttl = cached
            age = (now - cached_at).total_seconds()
            if 0 <= age < ttl:
                self._cache.move_to_end(key)
                return deepcopy(payload)
            del self._cache[key]
        reason = "routing_key_not_configured"
        if self.api_key:
            try:
                self._reserve_request(now)
                response = await self.http.request(
                    "POST", _ENDPOINT,
                    headers={"Authorization": self.api_key, "Accept": "application/geo+json"},
                    json={"coordinates": points, "instructions": False, "geometry": True,
                          "geometry_simplify": False, "elevation": False, "units": "m",
                          "radiuses": [_SNAP_METERS] * len(points)},
                )
                retrieved = self.clock()
                route = self._routed(response, points, return_to_origin, _stamp(retrieved), key)
            except ProviderError as error:
                if not self.allow_approximate:
                    raise
                reason = error.code
            except (ValueError, TypeError, KeyError, IndexError, OverflowError):
                if not self.allow_approximate:
                    raise ProviderError("provider_unavailable") from None
                reason = "invalid_routing_response"
            else:
                return self._remember(key, retrieved, route, _CACHE_SECONDS)
        if not self.allow_approximate:
            raise ProviderError("provider_unavailable")
        now = self.clock()
        generated_at = _stamp(now)
        route = self._approximate(points, return_to_origin, generated_at, key, reason)
        return self._remember(key, now, route, _FALLBACK_CACHE_SECONDS)

    def _remember(self, key: str, now: datetime, route: JSON, ttl: int) -> JSON:
        validate_payload("RouteEstimate", route)
        self._cache[key] = (now, deepcopy(route), ttl)
        self._cache.move_to_end(key)
        while len(self._cache) > _CACHE_ENTRIES:
            self._cache.popitem(last=False)
        return deepcopy(route)

    def _routed(self, response: JSON, points: list[list[float]], includes_return: bool,
                retrieved_at: str, key: str) -> JSON:
        if response["type"] != "FeatureCollection" or len(response["features"]) != 1:
            raise ValueError("Expected exactly one route")
        feature = response["features"][0]
        if feature["type"] != "Feature":
            raise ValueError("Invalid route feature")
        geometry = feature["geometry"]
        validate_payload("RouteGeometry", geometry)
        coordinates = geometry["coordinates"]
        properties = feature["properties"]
        waypoints = properties["way_points"]
        if (type(waypoints) is not list or len(waypoints) != len(points)
                or any(type(index) is not int for index in waypoints)
                or waypoints[0] != 0 or waypoints[-1] != len(coordinates) - 1
                or any(a > b for a, b in zip(waypoints, waypoints[1:]))
                or any(index < 0 or index >= len(coordinates) for index in waypoints)):
            raise ValueError("Missing or unordered route waypoints")
        for point, index in zip(points, waypoints):
            if _distance(point, coordinates[index]) > _SNAP_METERS:
                raise ValueError("Waypoint snapped too far from requested location")
        segments = properties["segments"]
        if type(segments) is not list or len(segments) != len(points) - 1:
            raise ValueError("Missing route leg")
        leg_distances, leg_durations = [], []
        for i, segment in enumerate(segments):
            distance, duration = _number(segment["distance"]), _number(segment["duration"])
            if (distance > 0 and duration <= 0) or (distance <= 0 and duration > 0):
                raise ValueError("Inconsistent leg duration")
            # ORS measures between snapped graph points. Two distinct requested
            # stops can snap to one node, or to nodes much closer together, even
            # when both individual snaps are within the allowed radius. Such a
            # leg does not account for the trip between the requested locations.
            minimum_distance = _distance(points[i], points[i + 1])
            if ((distance == 0 and minimum_distance > 1e-6)
                    or (distance < minimum_distance and not math.isclose(
                        distance, minimum_distance, rel_tol=0.02, abs_tol=10,
                    ))):
                raise ValueError("Snapped route omits travel between requested locations")
            if "way_points" in segment and segment["way_points"] != waypoints[i:i + 2]:
                raise ValueError("Inconsistent segment waypoints")
            path = coordinates[waypoints[i]:waypoints[i + 1] + 1]
            geometry_distance = sum(_distance(a, b) for a, b in zip(path, path[1:]))
            # Coordinates are rounded by ORS; allow 2% / 10m numeric disagreement.
            if not math.isclose(distance, geometry_distance, rel_tol=0.02, abs_tol=10):
                raise ValueError("Geometry does not describe complete leg distance")
            leg_distances.append(distance)
            leg_durations.append(duration)
        distance = _number(properties["summary"]["distance"])
        duration = _number(properties["summary"]["duration"])
        if (not math.isclose(distance, sum(leg_distances), rel_tol=1e-6, abs_tol=0.11 * len(segments))
                or not math.isclose(duration, sum(leg_durations), rel_tol=1e-6, abs_tol=0.11 * len(segments))):
            raise ValueError("Summary excludes a route leg")
        metadata = response["metadata"]
        timestamp = _number(metadata["timestamp"])
        if timestamp <= 0:
            raise ValueError("Missing provider timestamp")
        provider_instant = datetime.fromtimestamp(timestamp / 1000, timezone.utc)
        age_seconds = (parse_instant(retrieved_at) - provider_instant).total_seconds()
        if not -60 <= age_seconds <= 300:
            raise ValueError("Provider timestamp outside freshness window")
        provider_at = _stamp(provider_instant)
        query = metadata["query"]
        if not isinstance(query, dict) or query.get("profile") != _PROFILE:
            raise ValueError("Unexpected routing profile")
        if query.get("coordinates") != points:
            raise ValueError("Provider changed requested route order")
        assumptions = [
            f"Walking profile: {_PROFILE}; all ordered legs included; snapping <= {_SNAP_METERS} m.",
            "Start time does not alter the static walking network; no traffic or live path-closure guarantee.",
            f"Provider generated_at: {provider_at}; graph timestamp is not a verification of current path access.",
            f"In-memory route cache TTL {_CACHE_SECONDS} seconds; cached evidence timestamps are preserved.",
            _ATTRIBUTION,
        ]
        if self.pace_mps is not None:
            duration = distance / self.pace_mps
            assumptions.append(f"Walking time recalculated from routed distance at explicit pace {self.pace_mps:g} m/s.")
        return {
            "method": "routed", "provider": "openrouteservice", "transport": "walking",
            "distance_meters": distance, "duration_seconds": math.ceil(duration),
            "includes_return": includes_return, "geometry": deepcopy(geometry), "assumptions": assumptions,
            "evidence": [{"id": f"ors:{key[:20]}", "source_name": "openrouteservice / OpenStreetMap",
                          "source_type": "provider", "source_url": "https://openrouteservice.org/",
                          "source_record_id": f"foot-walking:{int(timestamp)}:{key[:20]}",
                          "retrieved_at": retrieved_at, "is_synthetic": False}],
            "generated_at": provider_at,
        }

    def _approximate(self, points: list[list[float]], includes_return: bool, generated_at: str,
                     key: str, reason: str) -> JSON:
        pace = self.pace_mps if self.pace_mps is not None else _DEFAULT_PACE_MPS
        distance = sum(_distance(a, b) for a, b in zip(points, points[1:]))
        return {
            "method": "approximate", "provider": "local-haversine", "transport": "walking",
            "distance_meters": distance, "duration_seconds": math.ceil(distance / pace),
            "includes_return": includes_return, "geometry": None,
            "assumptions": [
                f"Routing unavailable: {reason}; this is a local great-circle calculation, not a routed path.",
                "Sum of straight-line distances for every ordered leg; barriers, crossings and detours are unknown.",
                f"Walking pace assumption: {pace:g} m/s; walking time may substantially underestimate the real trip.",
                "Start time does not change this estimate; weather and live path access are not evaluated.",
                f"Degraded estimate cache TTL {_FALLBACK_CACHE_SECONDS} seconds; no route geometry is fabricated.",
            ],
            "evidence": [{"id": f"local:{key[:20]}", "source_name": "Local great-circle calculation",
                          "source_type": "provider",
                          "source_url": "https://github.com/chinusoid/astana-compass/blob/main/docs/context/routing.md",
                          "source_record_id": f"haversine:{key[:20]}", "retrieved_at": generated_at,
                          "is_synthetic": False}],
            "generated_at": generated_at,
        }
