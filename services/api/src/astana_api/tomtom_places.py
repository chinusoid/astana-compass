"""Optional nearby POI inspection from TomTom Orbis Places, never a scraped catalog.

Only explicit map clicks cause requests. Results remain separate from OSM facts;
no spatial proximity is treated as identity, containment, or verified amenities.
"""
import asyncio
from collections import deque
from datetime import date, datetime, timezone
import math
import os
import re
import time

from astana_city_context.common import JsonHTTP, ProviderError
from astana_contracts import validate_payload
from .map_features import MapFeatureService, clean, coordinate, xy

ENDPOINT = "https://api.tomtom.com/maps/orbis/places/discover"
SOURCE = "https://docs.tomtom.com/places-search-api/documentation/places-search/discover"
# Leaf selection prevents newly added, possibly billable fields being requested.
ATTRIBUTES = ("results(id,type,title,position(type,coordinates),poiTypes(name),"
              "address(street,houseNumber,municipality,countryCodeIso2),"
              "contacts(phones,websites),openingHours(date,timeRanges(start,end,utcOffsetSeconds)))")


def normalize_places(data, location, locale, retrieved_at):
    if not isinstance(data, dict) or not isinstance(data.get("results"), list) or len(data["results"]) > 100:
        raise ProviderError("invalid_provider_response")
    language = {"ru": 0, "kk": 1, "en": 2}[locale]
    labels = {
        "hours": ("Часы на указанную дату (TomTom)", "Көрсетілген күндегі уақыт (TomTom)", "Hours for the stated date (TomTom)"),
        "phone": ("Телефон", "Телефон", "Phone"),
        "website": ("Сайт", "Сайт", "Website"),
    }
    features, seen = [], set()
    for item in data["results"]:
        if not isinstance(item, dict) or item.get("type") != "poi":
            continue
        identity, name = item.get("id"), clean(item.get("title"), 300)
        if not isinstance(identity, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", identity) or identity in seen or not name:
            continue
        point = item.get("position")
        if not isinstance(point, dict) or point.get("type") != "Point":
            continue
        coordinates = point.get("coordinates")
        if (not isinstance(coordinates, list) or len(coordinates) != 2
                or not coordinate(coordinates[0], 180) or not coordinate(coordinates[1], 90)):
            continue
        lon, lat = coordinates
        distance = math.hypot(*xy(coordinates, [location["lon"], location["lat"]]))
        if distance > 250:
            continue
        address = item.get("address") or {}
        if not isinstance(address, dict) or address.get("countryCodeIso2") not in (None, "KZ"):
            continue
        seen.add(identity)
        kinds = item.get("poiTypes")
        kind = next((clean(entry.get("name"), 100) for entry in kinds if isinstance(entry, dict) and clean(entry.get("name"))), None) if isinstance(kinds, list) else None
        attrs = []
        contacts = item.get("contacts")
        if isinstance(contacts, list):
            for contact in contacts[:3]:
                if not isinstance(contact, dict):
                    continue
                for field, label in (("phones", "phone"), ("websites", "website")):
                    values = contact.get(field)
                    if isinstance(values, list):
                        for value in values[:2]:
                            value = clean(value)
                            if value:
                                attrs.append({"label": labels[label][language], "value": value})
        hours = item.get("openingHours")
        if isinstance(hours, list):
            for day in hours[:7]:
                if not isinstance(day, dict) or not isinstance(day.get("date"), str):
                    continue
                try:
                    date.fromisoformat(day["date"])
                except ValueError:
                    continue
                ranges = day.get("timeRanges")
                if not isinstance(ranges, list):
                    continue
                rendered = []
                for interval in ranges[:6]:
                    if not isinstance(interval, dict):
                        continue
                    start, end, offset = interval.get("start"), interval.get("end"), interval.get("utcOffsetSeconds")
                    if (not all(isinstance(v, str) and re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", v) for v in (start, end))
                            or type(offset) is not int or abs(offset) > 50400 or offset % 60):
                        continue
                    sign = "+" if offset >= 0 else "-"
                    hours_offset, minutes_offset = divmod(abs(offset) // 60, 60)
                    rendered.append(f"{start}–{end} (UTC{sign}{hours_offset:02d}:{minutes_offset:02d})")
                # Empty or absent intervals do not prove closure or 24/7 access.
                if rendered:
                    attrs.append({"label": labels["hours"][language], "value": clean(f"{day['date']}: {', '.join(rendered)}")})
        features.append({
            "id": f"tomtom:poi:{identity}", "name": name,
            "kind": kind or ("Место", "Орын", "Place")[language],
            "description": None,
            "address": clean(", ".join(filter(None, [clean(address.get(key)) for key in ("street", "houseNumber", "municipality")]))),
            "location": {"lon": lon, "lat": lat}, "match": "nearby", "distance_meters": round(distance, 1),
            "attributes": attrs[:20], "source_url": SOURCE, "source_label": "TomTom Places API",
        })
    features.sort(key=lambda entry: (entry["distance_meters"], entry["id"]))
    return validate_payload("MapFeatureResponse", {
        "status": "ok" if features else "empty", "features": features[:8],
        "retrieved_at": retrieved_at, "attribution": "© TomTom · TomTom Orbis Maps",
    })


class TomTomPlacesService:
    def __init__(self, *, enabled=False, api_key=None, http=None, clock=time.monotonic):
        self.enabled = enabled
        self._api_key = os.getenv("TOMTOM_API_KEY", "") if api_key is None else api_key
        self.http = http or JsonHTTP(timeout_seconds=5, retries=0, max_bytes=256_000)
        self.clock, self.calls = clock, deque()
        self.gate, self.cooldown = asyncio.Lock(), 0.0

    async def aclose(self):
        await self.http.aclose()

    async def inspect(self, location, locale):
        validate_payload("MapFeatureRequest", {"location": location, "locale": locale})
        if not self.enabled or not self._api_key:
            raise ProviderError("provider_unavailable")
        if not (50.8 <= location["lat"] <= 51.4 and 71 <= location["lon"] <= 71.8):
            raise ProviderError("invalid_request")
        async with self.gate:
            now = self.clock()
            while self.calls and now - self.calls[0] >= 86400:
                self.calls.popleft()
            if (now < self.cooldown or len(self.calls) >= 100
                    or sum(now - stamp < 60 for stamp in self.calls) >= 6
                    or self.calls and now - self.calls[-1] < 5):
                raise ProviderError("rate_limited")
            self.calls.append(now)
            point = {"type": "point", "coordinates": [location["lon"], location["lat"]]}
            lat_delta = 250 / 111195
            lon_delta = lat_delta / math.cos(math.radians(location["lat"]))
            bounds = [location["lon"] - lon_delta, location["lat"] - lat_delta,
                      location["lon"] + lon_delta, location["lat"] + lat_delta]
            try:
                data = await self.http.request("POST", ENDPOINT, headers={
                    "TomTom-Api-Key": self._api_key, "TomTom-Api-Version": "3", "Attributes": ATTRIBUTES,
                    "Accept-Language": {"ru": "ru-RU", "kk": "kk-KZ,ru-RU;q=0.8", "en": "en-GB"}[locale],
                }, json={"query": "", "origin": point, "preferences": {"geometry": point}, "maxResults": 8,
                         "filters": {"types": ["poi"], "countryCodesIso2": ["KZ"],
                                     "geometry": {"type": "rectangle", "coordinates": bounds}}})
                # No persistent database, response cache, or provider payload logs.
                return normalize_places(data, location, locale, datetime.now(timezone.utc).isoformat())
            except ProviderError as error:
                if error.code == "rate_limited":
                    self.cooldown = self.clock() + max(60, error.retry_after_seconds)
                raise


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
