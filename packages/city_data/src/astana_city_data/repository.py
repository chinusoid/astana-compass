"""Immutable, in-process JSON snapshot adapter; no network or alternate database."""
import base64
import json
import math
import os
from datetime import timedelta
from pathlib import Path

from astana_contracts import validate_payload
from .common import (COPYRIGHT, FORMAT, LICENSE, MAX_PLACES, SOURCE, DataError, canonical, coordinates,
                     digest, distance, instant, load_json, utcnow)


class SnapshotRepository:
    def __init__(self, path=None, *, clock=utcnow, stale_after_seconds=604800):
        if type(stale_after_seconds) is not int or not 60 <= stale_after_seconds <= 2592000:
            raise DataError("Invalid snapshot freshness interval")
        self._clock, self._stale_after = clock, stale_after_seconds
        self._records, self._manifest = {}, None
        self._status = "not_configured" if not path else "unavailable"
        if not path:
            return
        try:
            snapshot = load_json(Path(path), 16 * 1024 * 1024)
            self._load(snapshot)
        except (OSError, ValueError, TypeError, KeyError, RecursionError):
            # Remain explicitly unavailable; never silently load a bundled fallback.
            self._records, self._manifest = {}, None
            self._status = "unavailable"

    def _load(self, snapshot):
        if not isinstance(snapshot, dict) or snapshot.get("format") != FORMAT:
            raise DataError("Unsupported snapshot")
        manifest, places = snapshot["manifest"], snapshot["places"]
        if (not isinstance(manifest, dict) or manifest.get("format") != FORMAT
                or manifest.get("license") != "ODbL-1.0" or manifest.get("license_url") != LICENSE
                or manifest.get("complete_query_response") is not True
                or not isinstance(places, list) or not 1 <= len(places) <= MAX_PLACES
                or manifest.get("place_count") != len(places) or manifest.get("places_sha256") != digest(places)):
            raise DataError("Incomplete or corrupt snapshot")
        imported, source_time = instant(manifest["imported_at"]), instant(manifest["source_data_at"])
        if source_time > imported or imported > self._clock() + timedelta(minutes=5):
            raise DataError("Invalid snapshot chronology")
        records = {}
        for place in places:
            validate_payload("Place", place)
            if (place["is_synthetic"] or not place["id"].startswith("osm:") or place["id"] in records
                    or any(e["source_type"] != "osm" or e["is_synthetic"] for e in place["evidence"])):
                raise DataError("Invalid snapshot place provenance")
            records[place["id"]] = canonical(place)
        # Encoded JSON is immutable; every public read returns fresh dictionaries.
        self._records = dict(sorted(records.items()))
        self._manifest = json.loads(canonical(manifest))
        self._status = "ready"

    async def aclose(self):
        pass

    async def get(self, place_id):
        raw = self._records.get(place_id)
        return json.loads(raw) if raw is not None else None

    async def list_places(self, *, bbox=None, query=None, categories=None, cursor=None, limit=50):
        if type(limit) is not int or not 1 <= limit <= 100:
            raise DataError("List limit must be between 1 and 100")
        if bbox is not None:
            if (not isinstance(bbox, (list, tuple)) or len(bbox) != 4
                    or any(type(v) not in (int, float) or not math.isfinite(v) for v in bbox)
                    or not -180 <= bbox[0] <= bbox[2] <= 180 or not -90 <= bbox[1] <= bbox[3] <= 90):
                raise DataError("Invalid bounding box")
        if query is not None and (not isinstance(query, str) or len(query) > 2000):
            raise DataError("Invalid query")
        if categories is not None and (not isinstance(categories, list) or len(categories) > 100
                                       or any(not isinstance(c, str) or not c or len(c) > 100 for c in categories)):
            raise DataError("Invalid categories")
        filters = {"bbox": list(bbox) if bbox is not None else None, "query": (query or "").strip().casefold(),
                   "categories": sorted(set(categories or [])), "limit": limit,
                   "snapshot": self._manifest["places_sha256"] if self._manifest else None}
        signature, after = digest(filters), ""
        if cursor is not None:
            try:
                if not isinstance(cursor, str) or len(cursor) > 512:
                    raise ValueError
                decoded = json.loads(base64.b64decode(cursor, altchars=b"-_", validate=True))
                if (set(decoded) != {"v", "after", "filter"} or decoded["v"] != 1
                        or decoded["filter"] != signature or decoded["after"] not in self._records):
                    raise ValueError
                after = decoded["after"]
            except (ValueError, TypeError, KeyError):
                raise DataError("Invalid or obsolete cursor") from None
        matches = []
        for place_id, raw in self._records.items():
            if place_id <= after:
                continue
            place = json.loads(raw)
            point = place["location"]
            if bbox is not None and not (bbox[0] <= point["lon"] <= bbox[2] and bbox[1] <= point["lat"] <= bbox[3]):
                continue
            if categories and not set(categories).intersection(place["categories"]):
                continue
            searchable = " ".join([place["name"], place["description"] or "", *place["categories"],
                                   *(f["value"] for f in place["facts"] if f["status"] == "known"
                                     and isinstance(f["value"], str) and f["key"].startswith(("name:", "osm:alt_name")))])
            if filters["query"] and filters["query"] not in searchable.casefold():
                continue
            matches.append(place)
            if len(matches) > limit:
                break
        following = (base64.urlsafe_b64encode(canonical({"v": 1, "after": matches[limit - 1]["id"],
                                                       "filter": signature})).decode() if len(matches) > limit else None)
        return validate_payload("PlaceListResponse", {"places": matches[:limit], "next_cursor": following})

    async def nearby(self, *, origin, radius_meters, limit=100):
        if (not coordinates(origin) or type(radius_meters) not in (int, float) or not math.isfinite(radius_meters)
                or not 0 < radius_meters <= 100000 or type(limit) is not int or not 1 <= limit <= 1000):
            raise DataError("Invalid nearby query")
        matches = []
        for raw in self._records.values():
            place = json.loads(raw)
            meters = distance(origin, place["location"])
            if meters <= radius_meters:
                matches.append((meters, place["id"], place))
        return [entry[2] for entry in sorted(matches, key=lambda item: (item[0], item[1]))[:limit]]

    async def data_status(self):
        now, status = self._clock(), self._status
        warnings = ["© OpenStreetMap contributors · ODbL 1.0: " + LICENSE,
                    "Named category sample; unknown facts remain unknown. Import time is not verification time."]
        if self._manifest:
            oldest = min(instant(self._manifest["imported_at"]), instant(self._manifest["source_data_at"]))
            if now - oldest > timedelta(seconds=self._stale_after):
                status = "stale"
                warnings.append("Snapshot exceeds its freshness interval; run the separate importer.")
        else:
            warnings.append("ASTANA_POI_PATH is missing." if status == "not_configured" else "Configured snapshot is missing or invalid.")
        return validate_payload("DataStatusResponse", {"sources": [{"source_name": SOURCE, "source_url": COPYRIGHT,
            "status": status, "last_success_at": self._manifest["imported_at"] if self._manifest else None,
            "place_count": len(self._records), "warnings": warnings}], "total_places": len(self._records),
            "checked_at": now.isoformat()})


def create_repository(*, config):
    if config.get("mode") != "live" or config.get("timezone", "Asia/Almaty") != "Asia/Almaty":
        raise DataError("Snapshot repository requires live mode and Asia/Almaty")
    repository = SnapshotRepository(os.getenv("ASTANA_POI_PATH"),
                                    stale_after_seconds=int(os.getenv("ASTANA_POI_STALE_SECONDS", "604800")))
    if repository._status != "ready":
        raise DataError("ASTANA_POI_PATH must identify a valid, populated OSM snapshot")
    return repository
