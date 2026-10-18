"""Internal snapshot format; public Places always use astana_contracts."""
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import tempfile
import os

FORMAT = "astana-osm-snapshot-v1"
ENDPOINT = "https://overpass-api.de/api/interpreter"
SOURCE = "OpenStreetMap contributors (offline snapshot)"
COPYRIGHT = "https://www.openstreetmap.org/copyright"
LICENSE = "https://opendatacommons.org/licenses/odbl/1-0/"
# west, south, east, north; bounded city study area, not the administrative boundary.
BBOX = (71.20, 50.95, 71.65, 51.30)
MAX_BYTES = 8 * 1024 * 1024
MAX_PLACES = 10000


class DataError(ValueError):
    """Fixed, safe diagnostic; never interpolate untrusted source text."""


def instant(value):
    if not isinstance(value, str):
        raise DataError("Invalid timestamp")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise DataError("Invalid timestamp") from None
    if result.tzinfo is None or result.utcoffset() is None:
        raise DataError("Timestamp needs a timezone")
    return result.astimezone(timezone.utc)


def utcnow():
    return datetime.now(timezone.utc)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def load_json(path, max_bytes=MAX_BYTES):
    with Path(path).open("rb") as stream:
        raw = stream.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise DataError("Input exceeds the size limit")
    try:
        return json.loads(raw)
    except (UnicodeError, ValueError, RecursionError):
        raise DataError("Invalid JSON input") from None


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = canonical(value) + b"\n"
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + ".", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def coordinates(value):
    return (isinstance(value, dict) and type(value.get("lat")) in (int, float)
            and type(value.get("lon")) in (int, float)
            and math.isfinite(value["lat"]) and math.isfinite(value["lon"])
            and -90 <= value["lat"] <= 90 and -180 <= value["lon"] <= 180)


def distance(a, b):
    lat1, lat2 = math.radians(a["lat"]), math.radians(b["lat"])
    dlat, dlon = lat2 - lat1, math.radians(b["lon"] - a["lon"])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371000 * 2 * math.asin(min(1, math.sqrt(h)))
