"""Bounded, opt-in OpenStreetMap inspection for an explicitly clicked map point."""
from collections import OrderedDict, deque
from copy import deepcopy
from datetime import datetime, timezone
import asyncio
import math
import os
import time
from urllib.parse import urlsplit

from astana_city_context.common import JsonHTTP, ProviderError
from astana_contracts import validate_payload

ENDPOINT = "https://overpass-api.de/api/interpreter"
NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/reverse"
ATTRIBUTION = "© OpenStreetMap contributors · ODbL"
LABELS = {
    "building": ("Здание", "Ғимарат", "Building"), "amenity": ("Назначение", "Мақсаты", "Amenity"),
    "shop": ("Магазин", "Дүкен", "Shop"), "tourism": ("Достопримечательность", "Көрікті жер", "Tourism"),
    "leisure": ("Отдых", "Демалыс", "Leisure"), "historic": ("История", "Тарих", "Historic"),
    "building:levels": ("Этажей по OSM", "OSM бойынша қабат саны", "Floors in OSM"),
    "height": ("Высота по OSM", "OSM бойынша биіктік", "Height in OSM"),
    "opening_hours": ("Часы работы по OSM", "OSM бойынша жұмыс уақыты", "Opening hours in OSM"),
    "cuisine": ("Кухня", "Ас түрі", "Cuisine"), "wheelchair": ("Доступность коляски по OSM", "OSM бойынша арбаға қолжетімділік", "Wheelchair access in OSM"),
    "internet_access": ("Интернет по OSM", "OSM бойынша интернет", "Internet access in OSM"),
    "toilets": ("Туалет по OSM", "OSM бойынша дәретхана", "Toilets in OSM"),
    "architect": ("Архитектор", "Сәулетші", "Architect"), "start_date": ("Дата открытия по OSM", "OSM бойынша ашылған күні", "Opening date in OSM"),
}
BUILDINGS = {
    "apartments": ("Жилой дом", "Тұрғын үй", "Apartment building"),
    "office": ("Офисное здание", "Кеңсе ғимараты", "Office building"),
    "commercial": ("Коммерческое здание", "Коммерциялық ғимарат", "Commercial building"),
    "retail": ("Торговое здание", "Сауда ғимараты", "Retail building"),
    "house": ("Жилой дом", "Тұрғын үй", "House"),
}


def clean(value, limit=500):
    if not isinstance(value, str):
        return None
    return " ".join(value.encode("utf-8", errors="replace").decode().split())[:limit] or None


def coordinate(value, limit):
    return type(value) in (float, int) and -limit <= value <= limit and math.isfinite(value)


def xy(point, origin):
    return ((point[0] - origin[0]) * 111195 * math.cos(math.radians(origin[1])),
            (point[1] - origin[1]) * 111195)


def segment_distance(a, b, point):
    ax, ay = xy(a, point)
    bx, by = xy(b, point)
    dx, dy = bx - ax, by - ay
    norm = dx * dx + dy * dy
    t = max(0, min(1, -(ax * dx + ay * dy) / norm)) if norm else 0
    return math.hypot(ax + t * dx, ay + t * dy)


def contains(ring, point):
    if len(ring) < 4 or ring[0] != ring[-1]:
        return False
    x, y = point
    inside = False
    for (ax, ay), (bx, by) in zip(ring, ring[1:]):
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            inside = not inside
    return inside


def normalize(data, location, locale, retrieved_at):
    if not isinstance(data, dict):
        raise ProviderError("provider_unavailable")
    elements = data.get("elements")
    if not isinstance(elements, list) or len(elements) > 800 or data.get("remark"):
        raise ProviderError("provider_unavailable")
    language = {"ru": 0, "kk": 1, "en": 2}[locale]
    point = [location["lon"], location["lat"]]
    results = []
    seen = set()
    for element in elements:
        if not isinstance(element, dict) or not isinstance(element.get("type"), str) or element["type"] not in {"node", "way", "relation"}:
            continue
        if type(element.get("id")) is not int or element["id"] <= 0:
            continue
        identity = f"osm:{element['type']}:{element['id']}"
        tags = element.get("tags", {})
        if not isinstance(tags, dict) or identity in seen:
            continue
        seen.add(identity)
        category = next((key for key in ("amenity", "shop", "tourism", "historic", "leisure", "building") if clean(tags.get(key))), None)
        if not category:
            continue
        raw_geometry = element.get("geometry", [])
        if not isinstance(raw_geometry, list) or len(raw_geometry) > 4000:
            continue
        rings = [raw_geometry] if raw_geometry else []
        # Relations are nearby candidates only; do not infer containment from
        # incomplete multi-polygons or ignore their holes.
        if element["type"] == "relation":
            members = element.get("members", [])
            if not isinstance(members, list) or len(members) > 200:
                continue
            rings = [m.get("geometry", []) for m in members if isinstance(m, dict)]
        coordinates = []
        for ring in rings:
            if isinstance(ring, list) and len(ring) <= 4000:
                coordinates.extend([[p.get("lon"), p.get("lat")] for p in ring if isinstance(p, dict)])
        if element["type"] == "node":
            coordinates = [[element.get("lon"), element.get("lat")]]
        if not coordinates or len(coordinates) > 8000 or any(
            not coordinate(lon, 180) or not coordinate(lat, 90)
            for lon, lat in coordinates
        ):
            continue
        enclosed = element["type"] == "way" and contains(coordinates, point)
        # Never join disconnected relation members to compute distance.
        distance = min(math.hypot(*xy(p, point)) for p in coordinates)
        if element["type"] == "way":
            distance = min([distance, *[segment_distance(a, b, point) for a, b in zip(coordinates, coordinates[1:])]])
        if not enclosed and distance > (160 if category == "building" else 60):
            continue
        center = [sum(p[i] for p in coordinates) / len(coordinates) for i in (0, 1)]
        kind = (BUILDINGS.get(clean(tags.get("building")), LABELS["building"])[language]
                if category == "building" else LABELS[category][language])
        name = clean(tags.get(f"name:{locale}"), 300) or clean(tags.get("name"), 300) or kind
        description = clean(tags.get(f"description:{locale}"), 2000) or clean(tags.get("description"), 2000)
        address = ", ".join(filter(None, (clean(tags.get("addr:street"), 250), clean(tags.get("addr:housenumber"), 100)))) or None
        attributes = [{"label": labels[language], "value": clean(tags[key])} for key, labels in LABELS.items() if clean(tags.get(key))]
        results.append({"id": identity, "name": name, "kind": kind, "description": description,
                        "address": address, "location": {"lon": center[0], "lat": center[1]},
                        "match": "contains" if enclosed else "nearby", "distance_meters": 0 if enclosed else round(distance, 1),
                        "attributes": attributes, "source_url": f"https://www.openstreetmap.org/{element['type']}/{element['id']}",
                        "source_label": "OpenStreetMap"})
    results.sort(key=lambda feature: (feature["match"] != "contains", feature["distance_meters"], feature["id"]))
    return validate_payload("MapFeatureResponse", {"status": "ok" if results else "empty", "features": results[:12],
                                                   "retrieved_at": retrieved_at, "attribution": ATTRIBUTION})


def normalize_nominatim(data, location, locale, retrieved_at):
    if not isinstance(data, dict):
        raise ProviderError("provider_unavailable")
    if data.get("error"):
        if data.get("error") == "Unable to geocode":
            return normalize({"elements": []}, location, locale, retrieved_at)
        raise ProviderError("provider_unavailable")
    kind, identity = data.get("osm_type"), data.get("osm_id")
    if not isinstance(kind, str) or kind not in {"node", "way", "relation"} or type(identity) is not int or identity <= 0:
        raise ProviderError("provider_unavailable")
    if any(type(data.get(key)) not in (str, int, float) for key in ("lon", "lat")):
        raise ProviderError("provider_unavailable")
    try:
        lon, lat = float(data["lon"]), float(data["lat"])
    except (ValueError, TypeError, OverflowError):
        raise ProviderError("provider_unavailable") from None
    if not coordinate(lon, 180) or not coordinate(lat, 90):
        raise ProviderError("provider_unavailable")
    names = data.get("namedetails") if data.get("namedetails") is not None else {}
    extras = data.get("extratags") if data.get("extratags") is not None else {}
    address = data.get("address") if data.get("address") is not None else {}
    if any(not isinstance(item, dict) for item in (names, extras, address)):
        raise ProviderError("provider_unavailable")
    language = {"ru": 0, "kk": 1, "en": 2}[locale]
    category = clean(data.get("category")) or "building"
    label = LABELS.get(category, ("Объект карты", "Карта нысаны", "Map feature"))[language]
    name = clean(names.get(f"name:{locale}"), 300) or clean(data.get("name"), 300) or label
    point = [location["lon"], location["lat"]]
    distance = math.hypot(*xy([lon, lat], point))
    enclosed = False
    geometry = data.get("geojson") if data.get("geojson") is not None else {}
    if not isinstance(geometry, dict):
        raise ProviderError("provider_unavailable")
    if geometry.get("type") == "Polygon":
        rings = geometry.get("coordinates")
        if not isinstance(rings, list) or not 1 <= len(rings) <= 100:
            raise ProviderError("provider_unavailable")
        for ring in rings:
            if not isinstance(ring, list) or not 4 <= len(ring) <= 8000 or any(
                not isinstance(p, list) or len(p) != 2 or not coordinate(p[0], 180) or not coordinate(p[1], 90) for p in ring
            ):
                raise ProviderError("provider_unavailable")
            if ring[0] != ring[-1] or len({tuple(p) for p in ring[:-1]}) < 3:
                raise ProviderError("provider_unavailable")
        if sum(len(ring) for ring in rings) > 8000:
            raise ProviderError("provider_unavailable")
        enclosed = contains(rings[0], point) and not any(contains(hole, point) for hole in rings[1:])
        # A label point/centroid may fall in a courtyard or outside a concave
        # polygon. Distance to a polygon is measured from its actual boundary.
        distance = min(segment_distance(a, b, point) for ring in rings for a, b in zip(ring, ring[1:]))
    if not enclosed and distance > 160:
        return normalize({"elements": []}, location, locale, retrieved_at)
    attrs = [{"label": labels[language], "value": clean(extras[key])} for key, labels in LABELS.items() if clean(extras.get(key))]
    if clean(data.get("type")):
        attrs.insert(0, {"label": ("Тип по OSM", "OSM бойынша түрі", "OSM type")[language], "value": clean(data["type"])})
    feature = {"id": f"osm:{kind}:{identity}", "name": name, "kind": label,
               "description": clean(extras.get(f"description:{locale}"), 2000) or clean(extras.get("description"), 2000),
               "address": ", ".join(filter(None, (clean(address.get("road"), 250), clean(address.get("house_number"), 100)))) or None,
               "location": {"lon": lon, "lat": lat}, "match": "contains" if enclosed else "nearby",
               "distance_meters": 0 if enclosed else round(distance, 1), "attributes": attrs,
               "source_url": f"https://www.openstreetmap.org/{kind}/{identity}", "source_label": "OpenStreetMap / Nominatim"}
    return validate_payload("MapFeatureResponse", {"status": "ok", "features": [feature], "retrieved_at": retrieved_at,
                                                   "attribution": ATTRIBUTION})


class MapFeatureService:
    def __init__(self, *, enabled=False, http=None, provider=None):
        self.enabled = enabled
        self.provider = provider or os.getenv("ASTANA_MAP_LOOKUP_PROVIDER", "nominatim")
        if self.provider not in {"nominatim", "overpass"}:
            raise ValueError("Unsupported map lookup provider")
        # Server configuration can switch to a self-hosted/contracted Nominatim
        # instance without a client release. This URL never comes from requests.
        self.endpoint = os.getenv("ASTANA_MAP_LOOKUP_URL") or (NOMINATIM_ENDPOINT if self.provider == "nominatim" else ENDPOINT)
        target = urlsplit(self.endpoint)
        if target.scheme != "https" or not target.hostname or target.username or target.password or target.query or target.fragment:
            raise ValueError("Map lookup URL must be a credential-free HTTPS endpoint")
        self.normalize = normalize_nominatim if self.provider == "nominatim" else normalize
        self.http = http or JsonHTTP(timeout_seconds=12, retries=0, max_bytes=1_000_000)
        self.cache = OrderedDict()
        self.requests = deque()
        self.bytes = deque()
        self.gate = asyncio.Lock()
        self.cooldown = 0.0

    async def aclose(self):
        await self.http.aclose()

    async def inspect(self, location, locale):
        if not self.enabled:
            raise ProviderError("provider_unavailable")
        validate_payload("MapFeatureRequest", {"location": location, "locale": locale})
        if not (50.8 <= location["lat"] <= 51.4 and 71 <= location["lon"] <= 71.8):
            raise ProviderError("invalid_request")
        # A small area cache retains raw public OSM evidence, then computes the
        # clicked geometry match again for each exact point and requested locale.
        key = (round(location["lat"], 4), round(location["lon"], 4))
        async with self.gate:
            now = time.monotonic()
            cached = self.cache.get(key)
            if cached and now - cached[0] < 86400:
                self.cache.move_to_end(key)
                return self.normalize(deepcopy(cached[1]), location, locale, cached[2])
            while self.requests and now - self.requests[0] >= 86400:
                self.requests.popleft()
            while self.bytes and now - self.bytes[0][0] >= 86400:
                self.bytes.popleft()
            if (now < self.cooldown or len(self.requests) >= 60 or sum(size for _, size in self.bytes) >= 9_000_000
                    or (self.requests and now - self.requests[-1] < 5)):
                raise ProviderError("rate_limited", retryable=True)
            self.requests.append(now)
            lat, lon = key
            around = f"{lat:.4f},{lon:.4f}"
            query = (f"[out:json][timeout:6][maxsize:16000000];(way(around:170,{around})[building];"
                     f"relation(around:170,{around})[building];"
                     + "".join(f"nwr(around:65,{around})[{tag}];" for tag in ("amenity", "shop", "tourism", "historic", "leisure"))
                     + ");out tags geom;")
            try:
                params = ({"lat": lat, "lon": lon, "format": "jsonv2", "zoom": 18, "addressdetails": 1,
                           "extratags": 1, "namedetails": 1, "polygon_geojson": 1}
                          if self.provider == "nominatim" else {"data": query})
                data = await self.http.request("GET", self.endpoint, params=params,
                    headers={"User-Agent": "AstanaCompass/0.1 (+https://github.com/chinusoid/astana-compass)"})
                fetched = datetime.now(timezone.utc).isoformat()
                result = self.normalize(data, location, locale, fetched)
            except ProviderError as error:
                self.cooldown = time.monotonic() + max(30, getattr(error, "retry_after_seconds", 0))
                raise
            except (ValueError, TypeError, KeyError, IndexError, OverflowError):
                self.cooldown = time.monotonic() + 30
                raise ProviderError("provider_unavailable") from None
            import json
            self.bytes.append((now, len(json.dumps(data).encode())))
            self.cache[key] = (now, data, fetched)
            self.cache.move_to_end(key)
            while len(self.cache) > 128:
                self.cache.popitem(last=False)
            return result
