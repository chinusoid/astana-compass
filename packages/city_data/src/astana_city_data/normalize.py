"""Conservative OSM mapping. Category membership never proves an amenity."""
from collections import Counter
from astana_contracts import validate_payload
from .common import BBOX, COPYRIGHT, DataError, coordinates, digest, instant

CATEGORIES = {
    "amenity": ("cafe", "restaurant", "library", "theatre", "cinema", "arts_centre"),
    "tourism": ("museum", "gallery", "attraction", "viewpoint", "artwork"),
    "leisure": ("park", "garden", "playground"),
    "shop": ("mall",),
}
UNKNOWN = "Not explicitly established by the imported OSM tags; no field verification."
NORMALIZATION = "osm-tags-v3"
LANGUAGES = ("ru", "kk", "en")
RAW_TAGS = (
    "shop", "building",
    "wheelchair", "indoor", "fee", "access", "opening_hours:signed", "check_date", "check_date:opening_hours",
    "addr:street", "addr:housenumber", "addr:city", "addr:place", "addr:postcode", "addr:country", "addr:floor",
    "website", "contact:website", "website:menu", "wikipedia", "wikidata", "cuisine", "description",
    "internet_access", "internet_access:fee", "toilets", "toilets:wheelchair", "indoor_seating", "outdoor_seating",
    "highchair", "changing_table", "takeaway", "delivery", "diet:vegetarian", "diet:vegan", "diet:halal",
    "alt_name", "short_name", "official_name", "int_name",
    *(f"{key}:{lang}" for key in ("alt_name", "short_name", "official_name", "description") for lang in LANGUAGES),
)


def wifi(tags):
    tokens = {part.strip() for part in (tags.get("internet_access") or "").split(";") if part.strip()}
    if "wlan" in tokens and tokens <= {"wlan", "wired", "terminal", "yes", "service"}:
        return True
    return False if tokens == {"no"} else None


def fact_counts(places):
    return {"categories": dict(sorted(Counter(c for p in places for c in p["categories"]).items())),
            "known_facts": dict(sorted(Counter(f["key"] for p in places for f in p["facts"] if f["status"] == "known").items())),
            "unknown_facts": dict(sorted(Counter(f["key"] for p in places for f in p["facts"] if f["status"] == "unknown").items())),
            "descriptions": sum(p["description"] is not None for p in places)}


def query():
    west, south, east, north = BBOX
    clauses = [f'nwr["name"]["{key}"~"^({"|".join(values)})$"]({south},{west},{north},{east});'
               for key, values in CATEGORIES.items()]
    return "[out:json][timeout:30][maxsize:33554432];(" + "".join(clauses) + ");out body center;"


def text(value, maximum=2048):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        return None
    value.encode("utf-8")
    return value.strip()


def normalize_element(element, retrieved_at):
    if not isinstance(element, dict) or not isinstance(element.get("type"), str) or element["type"] not in {"node", "way", "relation"}:
        return None, "invalid_element"
    if type(element.get("id")) is not int or element["id"] <= 0:
        return None, "invalid_id"
    tags = element.get("tags", {})
    if not isinstance(tags, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in tags.items()):
        return None, "invalid_tags"
    name = text(tags.get("name"), 512)
    if not name:
        return None, "missing_name"
    categories = sorted({value for key, values in CATEGORIES.items() if (value := tags.get(key)) in values})
    if not categories or tags.get("access") in {"private", "no"} or tags.get("disused") == "yes":
        return None, "outside_selection"
    location = {key: element.get(key) for key in ("lat", "lon")} if element["type"] == "node" else element.get("center")
    if not coordinates(location):
        return None, "invalid_coordinates"
    west, south, east, north = BBOX
    if not west <= location["lon"] <= east or not south <= location["lat"] <= north:
        return None, "outside_bbox"
    record = f'{element["type"]}/{element["id"]}'
    place_id = "osm:" + record
    evidence_id = "osm:evidence:" + record
    facts = []

    def fact(key, value, tag):
        facts.append({"key": key, "status": "known" if value is not None else "unknown", "value": value,
                      "evidence_ids": [evidence_id] if value is not None else [],
                      "note": f"OSM tag {tag}; source claim, not a field check. Retrieved_at is download time." if value is not None else UNKNOWN})

    for key, tag in (("wheelchair_accessible", "wheelchair"), ("indoor", "indoor")):
        fact(key, {"yes": True, "no": False}.get(tags.get(tag)), tag)
    fact("free_entry", {"no": True, "yes": False}.get(tags.get("fee")), "fee")
    fact("opening_hours", text(tags.get("opening_hours")), "opening_hours")
    fact("has_wifi", wifi(tags), "internet_access")
    fact("toilets", {"yes": True, "no": False}.get(tags.get("toilets")), "toilets")
    for key in ("child_friendly", "quiet", "has_power_outlets", "open_at_requested_time"):
        fact(key, None, key)
    # Keep source-provided localized names and useful raw values. Never translate them.
    for tag in (*(f"name:{lang}" for lang in LANGUAGES), *RAW_TAGS):
        value = text(tags.get(tag))
        if value:
            fact(tag if tag.startswith("name:") else "osm:" + tag, value, tag)
    description = text(tags.get("description"))
    if description:
        fact("description:source", "osm", "description")
    elif any(text(tags.get(f"description:{lang}")) for lang in LANGUAGES):
        lang = next(lang for lang in LANGUAGES if text(tags.get(f"description:{lang}")))
        description = text(tags[f"description:{lang}"])
        fact("description:source", "osm", f"description:{lang}")
        fact("description:language", lang, f"description:{lang}")
    fact("osm:coordinate_kind", "node" if element["type"] == "node" else "bounding_box_center", "geometry")
    place = {"id": place_id, "name": name, "location": {"lat": location["lat"], "lon": location["lon"]},
             "categories": categories, "description": description, "facts": facts,
             "evidence": [{"id": evidence_id, "source_name": "OpenStreetMap contributors (ODbL 1.0)",
                           "source_type": "osm", "source_url": "https://www.openstreetmap.org/" + record,
                           "source_record_id": record, "retrieved_at": retrieved_at, "is_synthetic": False}],
             "is_synthetic": False}
    return validate_payload("Place", place), None


def normalize_response(payload, retrieved_at):
    instant(retrieved_at)
    if not isinstance(payload, dict) or "remark" in payload or "error" in payload:
        raise DataError("Overpass returned an incomplete or failed response")
    elements = payload.get("elements")
    if not isinstance(elements, list) or len(elements) > 10000:
        raise DataError("Invalid or excessive Overpass element list")
    metadata = payload.get("osm3s")
    if not isinstance(metadata, dict):
        raise DataError("Missing Overpass source timestamp")
    base = metadata.get("timestamp_osm_base")
    instant(base)
    if instant(base) > instant(retrieved_at):
        raise DataError("Source timestamp is ahead of retrieval time")
    seen, places, excluded = {}, [], Counter()
    for element in elements:
        if isinstance(element, dict) and "type" in element and "id" in element:
            identity = (str(element["type"]), str(element["id"]))
            fingerprint = digest(element)
            if identity in seen:
                if seen[identity] != fingerprint:
                    raise DataError("Conflicting duplicate OSM identity")
                excluded["identical_duplicate"] += 1
                continue
            seen[identity] = fingerprint
        try:
            place, reason = normalize_element(element, retrieved_at)
        except (UnicodeError, ValueError):
            place, reason = None, "invalid_record"
        if place is None:
            excluded[reason] += 1
        else:
            places.append(place)
    if not places:
        raise DataError("No valid named places in the completed import")
    places.sort(key=lambda p: p["id"])
    return places, {"received_elements": len(elements), "retained_places": len(places), "excluded": dict(excluded),
                    **fact_counts(places),
                    "raw_tag_counts": dict(sorted(Counter(k for e in elements if isinstance(e, dict)
                                                          and isinstance(e.get("tags", {}), dict) for k in e.get("tags", {})
                                                          if isinstance(k, str)).items())),
                    "attribution": "© OpenStreetMap contributors", "copyright_url": COPYRIGHT}
