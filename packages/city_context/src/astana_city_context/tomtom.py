"""Optional TomTom Maps pedestrian routing, with bounded OSRM fallback."""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import time

from astana_contracts import validate_payload

from .common import ProviderError, parse_instant
from .osrm import OSRMWalkingRouter
from .routing import ORSWalkingRouter, _distance, _number, _stamp

ENDPOINT = "https://api.tomtom.com/routing/1/calculateRoute/"
SOURCE_URL = "https://docs.tomtom.com/routing-api/documentation/tomtom-maps/v1/calculate-route"
_TOTAL_SECONDS = 6.5
_PRIMARY_SECONDS = 2.5
_MAX_POINTS = 5000


class TomTomWalkingRouter(ORSWalkingRouter):
    """Use the supported v1 pedestrian profile; Orbis v3 is car/taxi only.

    No successful TomTom response is cached: the v1 response policy is no-cache.
    OSRM keeps its own bounded cache and pacing. Both attempts share one deadline
    below the core's seven-second route limit, including the HTTP concurrency gate.
    """

    def __init__(self, http, *, timeout_seconds=6, **kwargs):
        super().__init__(http, **kwargs)
        if (type(timeout_seconds) not in (int, float) or not math.isfinite(timeout_seconds)
                or timeout_seconds <= 0):
            raise ValueError("timeout_seconds must be finite and positive")
        if http.retries != 0:
            raise ValueError("TomTom routing requires zero HTTP retries")
        self.timeout_seconds = min(timeout_seconds, _TOTAL_SECONDS)
        self._cooldown = 0.0
        self.fallback = OSRMWalkingRouter(
            http, clock=self.clock, pace_mps=self.pace_mps, allow_approximate=False,
        )

    @property
    def available(self):
        # The public foot router remains configured even without a private key.
        return True

    @property
    def unavailable_reason(self):
        return None

    async def estimate_route(self, *, origin, destinations, transport, return_to_origin, start_at):
        if transport != "walking":
            raise ProviderError("unsupported_transport")
        try:
            self._validate_pace()
            validate_payload("Location", origin)
            if type(destinations) is not list or not 1 <= len(destinations) <= 3:
                raise ValueError("One to three destinations required")
            for destination in destinations:
                validate_payload("Location", destination)
            if type(return_to_origin) is not bool:
                raise ValueError("Invalid return flag")
            start = _stamp(parse_instant(start_at))
        except (ValueError, TypeError, KeyError):
            raise ProviderError("invalid_request") from None
        points = [[p["lon"], p["lat"]] for p in [origin, *destinations]]
        if return_to_origin:
            points.append(points[0].copy())
        key = hashlib.sha256(json.dumps([points, start, self.pace_mps]).encode()).hexdigest()
        deadline = time.monotonic() + self.timeout_seconds
        if self.api_key and time.monotonic() >= self._cooldown:
            try:
                # Reserve before I/O; local quota rejection must not extend a
                # provider's Retry-After or make another billable request.
                self._reserve_request(self.clock())
            except ProviderError:
                pass
            else:
                try:
                    async with asyncio.timeout(min(_PRIMARY_SECONDS, self.timeout_seconds / 2)):
                        coordinate_text = ":".join(f"{lat:.7f},{lon:.7f}" for lon, lat in points)
                        response = await self.http.request(
                            "GET", ENDPOINT + coordinate_text + "/json",
                            params={"key": self.api_key, "travelMode": "pedestrian",
                                    "traffic": "false", "computeBestOrder": "false",
                                    "maxAlternatives": "0", "routeRepresentation": "polyline",
                                    "coordinatePrecision": "full", "sectionType": "travelMode",
                                    "departAt": start},
                        )
                        route = self._parse(response, points, return_to_origin, key)
                        return validate_payload("RouteEstimate", route)
                except ProviderError as error:
                    if error.code == "rate_limited":
                        self._cooldown = time.monotonic() + max(60, error.retry_after_seconds)
                except (TimeoutError, ValueError, TypeError, KeyError, IndexError, OverflowError):
                    pass
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            async with asyncio.timeout(remaining):
                route = await self.fallback.estimate_route(
                    origin=origin, destinations=destinations, transport=transport,
                    return_to_origin=return_to_origin, start_at=start_at,
                )
            route["assumptions"].append("TomTom pedestrian routing unavailable; verified OSRM foot route used.")
            return validate_payload("RouteEstimate", route)
        except (TimeoutError, ProviderError, ValueError, TypeError, KeyError, IndexError, OverflowError):
            if not self.allow_approximate:
                raise ProviderError("provider_unavailable", retryable=True) from None
        route = self._approximate(points, return_to_origin, _stamp(self.clock()), key, "walking_providers_unavailable")
        route["assumptions"][-1] = "This degraded estimate is not cached; no route geometry is fabricated."
        return validate_payload("RouteEstimate", route)

    def _parse(self, response, points, returned, key):
        routes = response["routes"]
        if type(routes) is not list or len(routes) != 1:
            raise ValueError("Expected exactly one route")
        route = routes[0]
        legs = route["legs"]
        if type(legs) is not list or len(legs) != len(points) - 1:
            raise ValueError("Missing ordered leg")
        coordinates = []
        distance = duration = 0.0
        for index, leg in enumerate(legs):
            raw = leg["points"]
            if type(raw) is not list or not 2 <= len(raw) <= _MAX_POINTS - len(coordinates):
                raise ValueError("Missing or excessive geometry")
            part = [[point["longitude"], point["latitude"]] for point in raw]
            validate_payload("RouteGeometry", {"type": "LineString", "coordinates": part})
            if (_distance(points[index], part[0]) > 100
                    or _distance(points[index + 1], part[-1]) > 100):
                raise ValueError("Leg omits ordered destination")
            if coordinates and coordinates[-1] != part[0]:
                raise ValueError("Disconnected legs")
            # Preserve the provider's point indices, including repeated junctions.
            # No straight connector or entrance segment is added to its geometry.
            coordinates.extend(part)
            leg_distance = _number(leg["summary"]["lengthInMeters"])
            leg_duration = _number(leg["summary"]["travelTimeInSeconds"])
            requested = _distance(points[index], points[index + 1])
            measured = sum(_distance(a, b) for a, b in zip(part, part[1:]))
            if ((requested > 1 and (leg_distance <= 0 or leg_duration <= 0))
                    or (leg_distance == 0) != (leg_duration == 0)
                    or (leg_distance < requested and not math.isclose(
                        leg_distance, requested, rel_tol=.02, abs_tol=10,
                    ))
                    or not math.isclose(leg_distance, measured, rel_tol=.03, abs_tol=10)):
                raise ValueError("Leg metrics do not match full geometry")
            distance += leg_distance
            duration += leg_duration
        if (not math.isclose(_number(route["summary"]["lengthInMeters"]), distance, abs_tol=len(legs))
                or not math.isclose(_number(route["summary"]["travelTimeInSeconds"]), duration, abs_tol=len(legs))):
            raise ValueError("Summary omits a leg")
        sections = route["sections"]
        if type(sections) is not list or not 1 <= len(sections) <= _MAX_POINTS:
            raise ValueError("Missing travel-mode verification")
        covered = 0
        for section in sections:
            if section["sectionType"] != "TRAVEL_MODE":
                continue
            start, end = section["startPointIndex"], section["endPointIndex"]
            if (section["travelMode"] != "pedestrian" or type(start) is not int or type(end) is not int
                    or start != covered or not start < end < len(coordinates)):
                raise ValueError("Unverified walking segment")
            covered = end
        if covered != len(coordinates) - 1:
            raise ValueError("Travel modes do not cover complete route")
        generated = _stamp(self.clock())
        assumptions = [
            "TomTom Maps pedestrian profile; every ordered leg included; network snapping within 100 m.",
            "Current path access, exact entrances, closures and wheelchair accessibility are not verified.",
            "Departure time sent to provider; generated_at records retrieval, not a map survey date.",
            "TomTom route responses are not cached or persisted by this service.",
            "Routing: © TomTom",
        ]
        if self.pace_mps is not None:
            duration = distance / self.pace_mps
            assumptions.append(f"Walking time recalculated from routed distance at {self.pace_mps:g} m/s.")
        return {"method": "routed", "provider": "TomTom Maps", "transport": "walking",
                "distance_meters": distance, "duration_seconds": math.ceil(duration),
                "includes_return": returned, "geometry": {"type": "LineString", "coordinates": coordinates},
                "assumptions": assumptions, "generated_at": generated,
                "evidence": [{"id": f"tomtom:{key[:20]}", "source_name": "TomTom Maps",
                              "source_type": "provider", "source_url": SOURCE_URL,
                              "source_record_id": f"pedestrian:{key[:20]}", "retrieved_at": generated,
                              "is_synthetic": False}]}
