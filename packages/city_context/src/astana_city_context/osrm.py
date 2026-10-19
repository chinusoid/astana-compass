"""Opt-in, low-volume FOSSGIS walking routes. Never substitute a driving profile."""
from __future__ import annotations

import asyncio
from copy import deepcopy
import hashlib
import json
import math
import time

from astana_contracts import validate_payload

from .common import ProviderError, parse_instant
from .routing import ORSWalkingRouter, _distance, _number, _stamp

ENDPOINT = "https://routing.openstreetmap.de/routed-foot/route/v1/foot/"
ATTRIBUTION = "Routing: OSRM / FOSSGIS · © OpenStreetMap contributors (ODbL)"


class OSRMWalkingRouter(ORSWalkingRouter):
    """Public testing service, at most one request/second, with bounded TTL cache."""

    def __init__(self, http, **kwargs):
        super().__init__(http, api_key=None, **kwargs)
        self._gate = asyncio.Lock()
        self._next_request = 0.0
        self._cooldown = 0.0

    @property
    def available(self):
        return True

    @property
    def unavailable_reason(self):
        return None

    async def estimate_route(self, *, origin, destinations, transport, return_to_origin, start_at):
        if transport != "walking":
            raise ProviderError("unsupported_transport")
        validate_payload("Location", origin)
        if not isinstance(destinations, list) or not 1 <= len(destinations) <= 3:
            raise ProviderError("invalid_request")
        for destination in destinations:
            validate_payload("Location", destination)
        if type(return_to_origin) is not bool:
            raise ProviderError("invalid_request")
        parse_instant(start_at)
        self._validate_pace()
        points = [[p["lon"], p["lat"]] for p in [origin, *destinations]]
        if return_to_origin:
            points.append(points[0].copy())
        # Static foot network: identical coordinates can share a route when only
        # departure time changes. The original retrieval timestamp is retained.
        key = hashlib.sha256(json.dumps([points, return_to_origin, self.pace_mps]).encode()).hexdigest()
        async with self._gate:
            now = self.clock()
            cached = self._cache.get(key)
            if cached and 0 <= (now - cached[0]).total_seconds() < cached[2]:
                self._cache.move_to_end(key)
                return deepcopy(cached[1])
            local_cooldown = time.monotonic() < self._cooldown
            try:
                if local_cooldown:
                    raise ProviderError("rate_limited", retryable=True)
                self._reserve_request(now)
                await asyncio.sleep(max(0, self._next_request - time.monotonic()))
                self._next_request = time.monotonic() + 1.05
                coordinate_text = ";".join(f"{lon:.6f},{lat:.6f}" for lon, lat in points)
                response = await self.http.request(
                    "GET", ENDPOINT + coordinate_text,
                    headers={"User-Agent": "AstanaCompass/0.1 (+https://github.com/chinusoid/astana-compass)"},
                    params={"overview": "full", "geometries": "geojson", "steps": "true",
                            "alternatives": "false", "generate_hints": "false",
                            "radiuses": ";".join("100" for _ in points)},
                )
                route = self._parse(response, points, return_to_origin, key)
                return self._remember(key, self.clock(), route, 300)
            except ProviderError as error:
                if error.code == "rate_limited" and not local_cooldown:
                    self._cooldown = time.monotonic() + max(60, getattr(error, "retry_after_seconds", 0))
                if not self.allow_approximate:
                    raise
                reason = error.code
            except (ValueError, TypeError, KeyError, IndexError, OverflowError):
                if not self.allow_approximate:
                    raise ProviderError("provider_unavailable") from None
                reason = "invalid_routing_response"
            now = self.clock()
            return self._remember(key, now, self._approximate(points, return_to_origin, _stamp(now), key, reason), 30)

    def _parse(self, response, points, returned, key):
        if response["code"] != "Ok" or len(response["routes"]) != 1:
            raise ValueError("No unique route")
        route = response["routes"][0]
        geometry = route["geometry"]
        validate_payload("RouteGeometry", geometry)
        coords = geometry["coordinates"]
        waypoints, legs = response["waypoints"], route["legs"]
        if len(waypoints) != len(points) or len(legs) != len(points) - 1:
            raise ValueError("Missing ordered waypoint or leg")
        stitched = []
        total_distance = total_duration = 0.0
        for i, waypoint in enumerate(waypoints):
            snapped = waypoint["location"]
            validate_payload("Location", {"lon": snapped[0], "lat": snapped[1]})
            if _number(waypoint["distance"]) > 100 or _distance(points[i], snapped) > 101:
                raise ValueError("Waypoint is too far from requested location")
        for i, leg in enumerate(legs):
            distance, duration = _number(leg["distance"]), _number(leg["duration"])
            requested_distance = _distance(points[i], points[i + 1])
            if (requested_distance > 1 and (distance <= 0 or duration <= 0)
                    or (distance == 0) != (duration == 0)):
                raise ValueError("Snapping erased travel between distinct requested locations")
            steps = leg["steps"]
            if not isinstance(steps, list) or not 1 <= len(steps) <= 2000:
                raise ValueError("Missing walking steps")
            leg_coords = []
            step_distance = step_duration = 0.0
            for step in steps:
                if step["mode"] != "walking":
                    raise ValueError("A non-walking segment was returned")
                validate_payload("RouteGeometry", step["geometry"])
                part = step["geometry"]["coordinates"]
                if leg_coords and _distance(leg_coords[-1], part[0]) > 2:
                    raise ValueError("Disconnected walking steps")
                leg_coords.extend(part[1:] if leg_coords else part)
                step_distance += _number(step["distance"])
                step_duration += _number(step["duration"])
            if (_distance(leg_coords[0], waypoints[i]["location"]) > 2
                    or _distance(leg_coords[-1], waypoints[i + 1]["location"]) > 2):
                raise ValueError("Leg does not match ordered destinations")
            measured = sum(_distance(a, b) for a, b in zip(leg_coords, leg_coords[1:]))
            if (not math.isclose(distance, measured, rel_tol=.03, abs_tol=10)
                    or not math.isclose(distance, step_distance, abs_tol=max(1, len(steps) * .11))
                    or not math.isclose(duration, step_duration, abs_tol=max(1, len(steps) * .11))):
                raise ValueError("Leg metrics do not match its full geometry")
            if stitched and _distance(stitched[-1], leg_coords[0]) > 2:
                raise ValueError("Disconnected legs")
            stitched.extend(leg_coords[1:] if stitched else leg_coords)
            total_distance += distance
            total_duration += duration
        # Full overview must represent the same path, not just connect its ends.
        compact = lambda line: [p for i, p in enumerate(line) if i == 0 or p != line[i - 1]]
        if compact(coords) != compact(stitched):
            raise ValueError("Overview differs from walking steps")
        if (not math.isclose(_number(route["distance"]), total_distance, abs_tol=.5)
                or not math.isclose(_number(route["duration"]), total_duration, abs_tol=.5)):
            raise ValueError("Route summary omits a leg")
        generated = _stamp(self.clock())
        assumptions = [
            "FOSSGIS OSRM foot profile; all stops in requested order; network snapping within 100 m.",
            "Static OpenStreetMap pedestrian network. Current access, entrances and closures are not verified.",
            "Generated time is retrieval time; the provider does not publish a graph timestamp in every response.",
            ATTRIBUTION,
        ]
        if self.pace_mps is not None:
            total_duration = total_distance / self.pace_mps
            assumptions.append(f"Walking time recalculated from routed distance at {self.pace_mps:g} m/s.")
        return {"method": "routed", "provider": "FOSSGIS OSRM", "transport": "walking",
                "distance_meters": total_distance, "duration_seconds": math.ceil(total_duration),
                "includes_return": returned, "geometry": deepcopy(geometry), "assumptions": assumptions,
                "evidence": [{"id": f"osrm:{key[:20]}", "source_name": "FOSSGIS OSRM / OpenStreetMap",
                              "source_type": "provider", "source_url": "https://routing.openstreetmap.de/about.html",
                              "source_record_id": f"foot:{key[:20]}", "retrieved_at": generated,
                              "is_synthetic": False}], "generated_at": generated}
