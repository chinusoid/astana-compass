"""Separate, single-request OSM import CLI. Never used from the HTTP repository."""
import argparse
import asyncio
from contextlib import contextmanager
from datetime import timedelta
from pathlib import Path

import httpx

from .common import (BBOX, ENDPOINT, FORMAT, LICENSE, MAX_BYTES, DataError, atomic_json, canonical,
                     digest, instant, load_json, utcnow)
from .normalize import NORMALIZATION, fact_counts, normalize_response, query

CACHE_SECONDS = 86400
COOLDOWN_SECONDS = 60


@contextmanager
def import_lock(cache):
    path = Path(str(cache) + ".lock")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        stream = path.open("x", encoding="utf-8")
    except FileExistsError:
        raise DataError("Another import is running; inspect a stale lock manually") from None
    try:
        with stream:
            stream.write(utcnow().isoformat())
        yield
    finally:
        path.unlink(missing_ok=True)


async def fetch_response(*, transport=None):
    # Exactly one request; no redirects or automatic retries, fixed trusted endpoint.
    async with asyncio.timeout(60):
        async with httpx.AsyncClient(timeout=httpx.Timeout(45, connect=10), follow_redirects=False,
                                     trust_env=False, transport=transport) as client:
            async with client.stream("POST", ENDPOINT, data={"data": query()}, headers={
                "User-Agent": "AstanaCompass-OfflineImport/0.1 (https://github.com/chinusoid/astana-compass)",
                "Accept": "application/json", "Accept-Encoding": "identity",
            }) as response:
                response.raise_for_status()
                if response.headers.get("content-encoding", "identity").strip().lower() not in {"", "identity"}:
                    raise DataError("Encoded Overpass response rejected")
                body = bytearray(response.content) if response.is_stream_consumed else bytearray()
                if not response.is_stream_consumed:
                    async for chunk in response.aiter_raw(chunk_size=16384):
                        if len(body) + len(chunk) > MAX_BYTES:
                            raise DataError("Overpass response exceeds size limit")
                        body.extend(chunk)
                if len(body) > MAX_BYTES:
                    raise DataError("Overpass response exceeds size limit")
    import json
    try:
        return json.loads(body)
    except (ValueError, UnicodeError, RecursionError):
        raise DataError("Invalid Overpass JSON response") from None


def select_sample(places, limit):
    """Deterministic round-robin across category and ~5 km grid cells."""
    buckets = {}
    for place in places:
        point = place["location"]
        key = (place["categories"][0], int(point["lat"] * 20), int(point["lon"] * 20))
        buckets.setdefault(key, []).append(place)
    selected, depth = [], 0
    while len(selected) < min(limit, len(places)):
        for key in sorted(buckets):
            if depth < len(buckets[key]):
                selected.append(buckets[key][depth])
                if len(selected) == limit:
                    break
        depth += 1
    return sorted(selected, key=lambda place: place["id"])


async def import_snapshot(*, output, cache, manifest_path=None, limit=1000, transport=None, now=None,
                          offline=False, wikidata_cache=None, official_supplement=None):
    if type(limit) is not int or not 1 <= limit <= 1000:
        raise DataError("Sample limit must be between 1 and 1000")
    fixed_now = now
    now = now or utcnow()
    instant(now.isoformat())
    cache, output = Path(cache), Path(output)
    paths = [cache.resolve(), output.resolve(), *([Path(manifest_path).resolve()] if manifest_path else []),
             *([Path(wikidata_cache).resolve()] if wikidata_cache else [])]
    if len(paths) != len(set(paths)):
        raise DataError("Cache, snapshot and manifest require distinct paths")
    with import_lock(cache):
        cached = load_json(cache, MAX_BYTES + 65536) if cache.exists() else None
        valid = (isinstance(cached, dict) and cached.get("query_sha256") == digest(query())
                 and cached.get("raw_sha256") == digest(cached.get("payload"))
                 and instant(cached["retrieved_at"]) <= now)
        usable = valid and (offline or now - instant(cached["retrieved_at"]) < timedelta(seconds=CACHE_SECONDS))
        if offline and not usable:
            raise DataError("Offline import requires a valid, checksum-matching completed cache")
        if usable:
            payload, retrieved_at = cached["payload"], cached["retrieved_at"]
        else:
            attempt_path = Path(str(cache) + ".attempt.json")
            if attempt_path.exists():
                attempted = instant(load_json(attempt_path)["attempted_at"])
                if now - attempted < timedelta(seconds=COOLDOWN_SECONDS):
                    raise DataError("Import cooldown active; no request was sent")
            atomic_json(attempt_path, {"attempted_at": now.isoformat()})
            try:
                payload = await fetch_response(transport=transport)
            except (httpx.HTTPError, TimeoutError):
                raise DataError("Overpass unavailable; no snapshot replaced and no automatic retry") from None
            retrieved_at = (fixed_now or utcnow()).isoformat()
            # Check completeness before replacing the good cache or published snapshot.
            normalize_response(payload, retrieved_at)
            cached = {"query_sha256": digest(query()), "retrieved_at": retrieved_at,
                      "raw_sha256": digest(payload), "payload": payload}
            atomic_json(cache, cached)
        places, report = normalize_response(payload, retrieved_at)
        selected = select_sample(places, limit)
        enrichment = None
        if wikidata_cache:
            from .wikidata import enrich
            selected, enrichment = enrich(selected, load_json(wikidata_cache))
            if instant(enrichment["retrieved_at"]) > now:
                raise DataError("Wikidata cache timestamp is in the future")
        official = None
        if official_supplement:
            from .official import MAX_BYTES as OFFICIAL_MAX_BYTES, enrich as enrich_official
            selected, official = enrich_official(selected, load_json(official_supplement, OFFICIAL_MAX_BYTES),
                                                 clock=lambda: now)
        manifest = {
            "format": FORMAT, "source": "OpenStreetMap contributors", "endpoint": ENDPOINT,
            "license": "ODbL-1.0", "license_url": LICENSE,
            "attribution": "© OpenStreetMap contributors", "imported_at": retrieved_at,
            "source_data_at": payload["osm3s"]["timestamp_osm_base"], "bbox_wsen": list(BBOX),
            "query": query(), "query_sha256": digest(query()), "raw_sha256": digest(payload),
            "places_sha256": digest(selected), "complete_query_response": True,
            "sample_policy": "category-grid-round-robin-v1", "sample_limit": limit,
            "place_count": len(selected), "omitted_by_sample_limit": len(places) - len(selected),
            "normalization": NORMALIZATION, "report": report,
            "sample_report": fact_counts(selected),
            "limitations": ["A named, category-filtered city sample; not exhaustive city coverage.",
                            "Download time and OSM replica time are not fact verification times.",
                            "Way/relation locations are bounding-box centers, not verified entrances.",
                            "OSM tags are community source claims; opening and accessibility require confirmation."]}
        if enrichment is not None:
            manifest["wikidata_enrichment"] = enrichment
        if official is not None:
            manifest["official_enrichment"] = official
            manifest["limitations"].append("Official-page editorial notes are source claims, not field verification; page access time is not a fact verification date.")
        snapshot = {"format": FORMAT, "manifest": manifest, "places": selected}
        if len(canonical(snapshot)) > 16 * 1024 * 1024:
            raise DataError("Normalized snapshot exceeds size limit")
        atomic_json(output, snapshot)
        if manifest_path:
            atomic_json(manifest_path, manifest)
        return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--cache", required=True, type=Path, help="Successful raw response cache, reused for 24 hours")
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--offline", action="store_true", help="Replay verified raw cache without network, preserving original source times")
    parser.add_argument("--wikidata-cache", type=Path, help="Optional verified local cache; this option never fetches Wikidata")
    parser.add_argument("--official-supplement", type=Path, help="Optional reviewed official-page notes; offline only, no crawling")
    args = parser.parse_args()
    try:
        manifest = asyncio.run(import_snapshot(output=args.output, cache=args.cache,
                                              manifest_path=args.manifest, limit=args.limit,
                                              offline=args.offline, wikidata_cache=args.wikidata_cache,
                                              official_supplement=args.official_supplement))
    except DataError as error:
        parser.exit(1, f"Import failed: {error}.\n")
    except (OSError, KeyError, TypeError, ValueError):
        parser.exit(1, "Import failed: cache or output unavailable/invalid.\n")
    print(f'Imported {manifest["place_count"]} OSM places; source retrieved at {manifest["imported_at"]}; ODbL-1.0.')


if __name__ == "__main__":
    main()
