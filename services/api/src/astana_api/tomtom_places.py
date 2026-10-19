"""Bounded TomTom Maps Nearby Search on explicit map clicks.

Nearby results stay separate from OSM buildings and catalog Place facts.
"""
import asyncio
from collections import deque
from datetime import date, datetime, timezone
import math
import os
import re
import time

from astana_city_context.common import JsonHTTP, ProviderError, log_tomtom_failure
from astana_contracts import validate_payload
from .map_features import MapFeatureService, clean, coordinate, xy

ENDPOINT = "https://api.tomtom.com/search/2/nearbySearch/.json"
SOURCE = "https://docs.tomtom.com/search-api/documentation/search-service/nearby-search"
_TIMEOUT_SECONDS = 4


def _local_time(value):
    if not isinstance(value, dict) or not isinstance(value.get("date"), str):
        return None
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value["date"]):
        return None
    hour, minute = value.get("hour"), value.get("minute")
    if type(hour) is not int or not 0 <= hour <= 23 or type(minute) is not int or not 0 <= minute <= 59:
        return None
    try:
        day = date.fromisoformat(value["date"])
        return datetime(day.year, day.month, day.day, hour, minute)
    except ValueError:
        return None


def normalize_places(data, location, locale, retrieved_at):
    if not isinstance(data, dict) or not isinstance(data.get("results"), list) or len(data["results"]) > 100:
        raise ProviderError("invalid_provider_response", reason="invalid_schema")
    language = {"ru": 0, "kk": 1, "en": 2}[locale]
    labels = {
        "hours": ("Часы на указанные даты (местное время, TomTom)", "Көрсетілген күндердегі уақыт (жергілікті уақыт, TomTom)",
                  "Hours on stated dates (local time, TomTom)"),
        "phone": ("Телефон", "Телефон", "Phone"),
        "website": ("Сайт", "Сайт", "Website"),
    }
    features, seen = [], set()
    for item in data["results"]:
        if not isinstance(item, dict) or item.get("type") != "POI" or not isinstance(item.get("poi"), dict):
            continue
        poi = item["poi"]
        identity, name = item.get("id"), clean(poi.get("name"), 300)
        if not isinstance(identity, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", identity) or identity in seen or not name:
            continue
        point = item.get("position")
        if not isinstance(point, dict) or not coordinate(point.get("lon"), 180) or not coordinate(point.get("lat"), 90):
            continue
        lon, lat = point["lon"], point["lat"]
        distance = math.hypot(*xy([lon, lat], [location["lon"], location["lat"]]))
        if distance > 250:
            continue
        address = item.get("address") or {}
        if not isinstance(address, dict) or address.get("countryCode") not in (None, "KZ"):
            continue
        seen.add(identity)
        kind = None
        kinds = poi.get("classifications")
        if isinstance(kinds, list):
            for entry in kinds[:3]:
                names = entry.get("names") if isinstance(entry, dict) else None
                if isinstance(names, list):
                    kind = next((clean(value.get("name"), 100) for value in names[:3]
                                 if isinstance(value, dict) and clean(value.get("name"))), None)
                if kind:
                    break
        attrs = []
        for field, label in (("phone", "phone"), ("url", "website")):
            value = clean(poi.get(field))
            if value:
                attrs.append({"label": labels[label][language], "value": value})
        hours = poi.get("openingHours")
        ranges = hours.get("timeRanges") if isinstance(hours, dict) and hours.get("mode") == "nextSevenDays" else None
        if isinstance(ranges, list):
            for interval in ranges[:14]:
                if not isinstance(interval, dict):
                    continue
                start, end = _local_time(interval.get("startTime")), _local_time(interval.get("endTime"))
                if start is None or end is None or not 0 < (end - start).total_seconds() <= 8 * 86400:
                    continue
                # Both dates are explicit, including overnight intervals. Empty
                # ranges do not prove closure; local times do not imply UTC.
                attrs.append({"label": labels["hours"][language],
                              "value": f"{start:%Y-%m-%d %H:%M} – {end:%Y-%m-%d %H:%M}"})
        features.append({
            "id": f"tomtom:poi:{identity}", "name": name,
            "kind": kind or ("Место", "Орын", "Place")[language], "description": None,
            "address": clean(address.get("freeformAddress")) or clean(", ".join(filter(None, [
                clean(address.get(key)) for key in ("streetName", "streetNumber", "municipality")]))),
            "location": {"lon": lon, "lat": lat}, "match": "nearby", "distance_meters": round(distance, 1),
            "attributes": attrs[:20], "source_url": SOURCE, "source_label": "TomTom Maps Nearby Search",
        })
    features.sort(key=lambda entry: (entry["distance_meters"], entry["id"]))
    return validate_payload("MapFeatureResponse", {
        "status": "ok" if features else "empty", "features": features[:8],
        "retrieved_at": retrieved_at, "attribution": "© TomTom · TomTom Maps",
    })


class TomTomPlacesService:
    def __init__(self, *, enabled=False, api_key=None, http=None, clock=time.monotonic):
        self.enabled = enabled
        self._api_key = os.getenv("TOMTOM_API_KEY", "") if api_key is None else api_key
        self.http = http or JsonHTTP(timeout_seconds=_TIMEOUT_SECONDS, retries=0, max_bytes=256_000)
        if getattr(self.http, "retries", 0) != 0:
            raise ValueError("TomTom nearby search requires zero HTTP retries")
        self.clock, self.calls = clock, deque()
        self.gate, self.cooldown = asyncio.Lock(), 0.0
        if self.enabled and not self._api_key:
            log_tomtom_failure("places", ProviderError("provider_unavailable"), reason="key_not_configured")

    async def aclose(self):
        await self.http.aclose()

    async def inspect(self, location, locale):
        validate_payload("MapFeatureRequest", {"location": location, "locale": locale})
        if not self.enabled or not self._api_key:
            raise ProviderError("provider_unavailable")
        if not (50.8 <= location["lat"] <= 51.4 and 71 <= location["lon"] <= 71.8):
            raise ProviderError("invalid_request")
        try:
            # Includes our concurrency gate, not only socket time. There is no
            # retry or second TomTom request on failure.
            async with asyncio.timeout(_TIMEOUT_SECONDS):
                return await self._inspect(location, locale)
        except TimeoutError:
            error = ProviderError("provider_unavailable", reason="timeout")
            log_tomtom_failure("places", error)
            raise error from None

    async def _inspect(self, location, locale):
        async with self.gate:
            now = self.clock()
            while self.calls and now - self.calls[0] >= 86400:
                self.calls.popleft()
            if (now < self.cooldown or len(self.calls) >= 100
                    or sum(now - stamp < 60 for stamp in self.calls) >= 6
                    or self.calls and now - self.calls[-1] < 5):
                raise ProviderError("rate_limited")
            self.calls.append(now)
            try:
                # This supported query-free endpoint has Maps POI IDs/data,
                # not Orbis Discover IDs. The key never enters a client DTO.
                data = await self.http.request("GET", ENDPOINT, params={
                    "key": self._api_key, "lat": location["lat"], "lon": location["lon"],
                    "radius": 250, "limit": 8, "countrySet": "KZ",
                    "language": {"ru": "ru-RU", "kk": "kk-KZ", "en": "en-GB"}[locale],
                    "openingHours": "nextSevenDays",
                })
                # No persistent database, response cache, or provider payload logs.
                return normalize_places(data, location, locale, datetime.now(timezone.utc).isoformat())
            except ProviderError as error:
                log_tomtom_failure("places", error)
                if error.code == "rate_limited":
                    self.cooldown = self.clock() + max(60, error.retry_after_seconds)
                raise
            except (ValueError, TypeError, KeyError, IndexError, OverflowError):
                log_tomtom_failure("places", ProviderError("invalid_provider_response"), reason="invalid_schema")
                raise ProviderError("invalid_provider_response") from None


class MultiSourceMapService:
    def __init__(self, *services, source_timeout_seconds=12):
        self.services = services
        self.source_timeout_seconds = source_timeout_seconds

    async def aclose(self):
        await asyncio.gather(*(service.aclose() for service in self.services))

    async def inspect(self, location, locale):
        async def bounded(service):
            # Includes the source's own queue. A slow source cannot consume the
            # API's 15s deadline and erase another provider's successful result.
            async with asyncio.timeout(self.source_timeout_seconds):
                return await service.inspect(location, locale)
        results = await asyncio.gather(*(bounded(service) for service in self.services), return_exceptions=True)
        successes = []
        for result in results:
            if isinstance(result, asyncio.CancelledError):
                raise result
            if isinstance(result, dict):
                successes.append(result)
        if not successes:
            raise ProviderError("rate_limited" if all(isinstance(r, ProviderError) and r.code == "rate_limited" for r in results) else "provider_unavailable")
        features = [feature for result in successes for feature in result["features"]]
        if not features and len(successes) != len(results):
            raise ProviderError("provider_unavailable")  # incomplete lookup is not a confirmed empty result
        features.sort(key=lambda feature: (feature["match"] != "contains", feature["distance_meters"], feature["id"]))
        # Separate provider entries retain their identity and attribution; never
        # transfer a nearby shop's opening hours onto an OSM building.
        return validate_payload("MapFeatureResponse", {
            "status": "ok" if features else "empty", "features": features[:12],
            "retrieved_at": min(result["retrieved_at"] for result in successes),
            "attribution": " · ".join(dict.fromkeys(result["attribution"] for result in successes)),
        })


def create_map_service(*, enabled):
    provider = os.getenv("ASTANA_MAP_LOOKUP_PROVIDER", "nominatim")
    if provider == "tomtom":
        return TomTomPlacesService(enabled=enabled)
    if provider == "tomtom_osm":
        return MultiSourceMapService(MapFeatureService(enabled=enabled, provider="nominatim"), TomTomPlacesService(enabled=enabled))
    return MapFeatureService(enabled=enabled, provider=provider)
