"""Optional offline enrichment: exact OSM QIDs, one bounded Wikidata API batch."""
import argparse
import asyncio
from copy import deepcopy
from datetime import timedelta
from email.utils import parsedate_to_datetime
import json
from pathlib import Path
import re
import zlib

import httpx
from astana_contracts import validate_payload

from .common import DataError, atomic_json, digest, instant, load_json, utcnow
from .normalize import LANGUAGES, text

ENDPOINT = "https://www.wikidata.org/w/api.php"
LICENSE = "https://creativecommons.org/publicdomain/zero/1.0/"
SOURCE = "Wikidata (CC0 1.0)"
MAX_BYTES = 2 * 1024 * 1024
MAX_IDS = 50
QID = re.compile(r"Q[1-9][0-9]{0,11}\Z")
NOTE = "Linked by an explicit OSM Wikidata QID; not independently field checked. Download time is not fact verification time."
SUBJECTIVE = re.compile(r"(?<!\w)(?:достойн\w*|лучш\w*|прекрасн\w*|замечательн\w*|best|wonderful|amazing|excellent|ең\s+үздік)(?!\w)", re.I)


def linked_ids(places):
    return sorted({f["value"] for p in places for f in p["facts"]
                   if f["key"] == "osm:wikidata" and f["status"] == "known"
                   and isinstance(f["value"], str) and QID.fullmatch(f["value"])})


def parameters(ids):
    if not 1 <= len(ids) <= MAX_IDS or ids != sorted(set(ids)) or any(not QID.fullmatch(i) for i in ids):
        raise DataError("Wikidata enrichment requires 1 to 50 unique exact QIDs")
    return {"action": "wbgetentities", "ids": "|".join(ids), "props": "info|labels|descriptions|aliases",
            "languages": "|".join(LANGUAGES), "format": "json", "maxlag": "5"}


def validate_cache(cache):
    if (not isinstance(cache, dict) or cache.get("format") != "astana-wikidata-cache-v1"
            or cache.get("endpoint") != ENDPOINT or cache.get("license") != "CC0-1.0"
            or cache.get("license_url") != LICENSE):
        raise DataError("Invalid Wikidata cache provenance")
    ids = cache["ids"]
    if cache["request_sha256"] != digest(parameters(ids)) or cache["raw_sha256"] != digest(cache["payload"]):
        raise DataError("Wikidata cache checksum mismatch")
    retrieved = instant(cache["retrieved_at"])
    payload = cache["payload"]
    if (not isinstance(payload, dict) or any(k in payload for k in ("error", "warnings", "redirects"))
            or type(payload.get("success")) is not int or payload["success"] != 1):
        raise DataError("Wikidata response is incomplete or failed")
    entities = payload.get("entities")
    if not isinstance(entities, dict) or set(entities) != set(ids):
        raise DataError("Wikidata response does not match requested identities")
    for qid, entity in entities.items():
        if (not isinstance(entity, dict) or entity.get("id") != qid or entity.get("type") != "item"
                or "missing" in entity or "redirects" in entity or type(entity.get("lastrevid")) is not int
                or entity["lastrevid"] <= 0 or instant(entity["modified"]) > retrieved):
            raise DataError("Invalid Wikidata entity identity or revision")
        for key in ("labels", "descriptions", "aliases"):
            if not isinstance(entity.get(key), dict):
                raise DataError("Invalid Wikidata text fields")
            for language, value in entity[key].items():
                if language not in LANGUAGES:
                    raise DataError("Unexpected Wikidata language")
                values = value if key == "aliases" else [value]
                if not isinstance(values, list) or len(values) > 100:
                    raise DataError("Invalid Wikidata aliases")
                if any(not isinstance(v, dict) or v.get("language") != language or not text(v.get("value"), 2048) for v in values):
                    raise DataError("Invalid Wikidata source text")
    return entities


async def fetch_entities(ids, *, transport=None):
    params = parameters(ids)
    # Wikimedia requests compression. Limit both the wire and decoded body before JSON parsing.
    async with asyncio.timeout(45):
        async with httpx.AsyncClient(timeout=httpx.Timeout(30, connect=10), follow_redirects=False,
                                     trust_env=False, transport=transport) as client:
            async with client.stream("GET", ENDPOINT, params=params, headers={
                "User-Agent": "AstanaCompass-OfflineEnrichment/0.1 (https://github.com/chinusoid/astana-compass)",
                "Accept": "application/json", "Accept-Encoding": "gzip, deflate",
            }) as response:
                response.raise_for_status()
                encoding = response.headers.get("content-encoding", "identity").strip().lower()
                if encoding not in {"identity", "", "gzip", "deflate"}:
                    raise DataError("Unsupported Wikidata response encoding")
                body, wire_size = bytearray(), 0
                decoder = zlib.decompressobj(31 if encoding == "gzip" else 15) if encoding in {"gzip", "deflate"} else None
                if response.is_stream_consumed:  # In-memory transports can supply an already-decoded body.
                    body.extend(response.content)
                else:
                    async for chunk in response.aiter_raw(chunk_size=16384):
                        wire_size += len(chunk)
                        if wire_size > MAX_BYTES:
                            raise DataError("Wikidata wire response exceeds size limit")
                        decoded = decoder.decompress(chunk, MAX_BYTES - len(body) + 1) if decoder else chunk
                        body.extend(decoded)
                        if len(body) > MAX_BYTES or (decoder and decoder.unconsumed_tail):
                            raise DataError("Wikidata decoded response exceeds size limit")
                    if decoder and (not decoder.eof or decoder.unused_data):
                        raise DataError("Invalid compressed Wikidata response")
                if len(body) > MAX_BYTES:
                    raise DataError("Wikidata response exceeds size limit")
    try:
        return json.loads(body)
    except (ValueError, UnicodeError, RecursionError):
        raise DataError("Invalid Wikidata JSON") from None


async def collect_cache(places, path, *, transport=None, now=None):
    from .importer import import_lock
    ids, path = linked_ids(places), Path(path)
    params = parameters(ids)
    fixed_now, now = now, now or utcnow()
    with import_lock(path):
        if path.exists():
            cached = load_json(path, MAX_BYTES + 65536)
            validate_cache(cached)
            if cached["ids"] == ids and timedelta(0) <= now - instant(cached["retrieved_at"]) < timedelta(days=1):
                return cached
        attempt = Path(str(path) + ".attempt.json")
        if attempt.exists():
            previous = load_json(attempt)
            if (now - instant(previous["attempted_at"]) < timedelta(minutes=1)
                    or (previous.get("not_before") and now < instant(previous["not_before"]))):
                raise DataError("Wikidata cooldown active; no request sent")
        atomic_json(attempt, {"attempted_at": now.isoformat()})
        try:
            payload = await fetch_entities(ids, transport=transport)
        except httpx.HTTPStatusError as error:
            # A manual rerun must also respect a server's Retry-After instruction.
            retry_at = now + timedelta(minutes=1)
            raw_retry = error.response.headers.get("retry-after", "")
            try:
                server_retry = (now + timedelta(seconds=int(raw_retry)) if raw_retry.isdigit()
                                else parsedate_to_datetime(raw_retry))
                retry_at = max(retry_at, server_retry)
            except (ValueError, TypeError, OverflowError):
                pass
            atomic_json(attempt, {"attempted_at": now.isoformat(), "not_before": retry_at.isoformat()})
            raise DataError("Wikidata unavailable; Retry-After/cooldown recorded, no automatic retry") from None
        except (httpx.HTTPError, TimeoutError, zlib.error):
            raise DataError("Wikidata unavailable; no cache replaced and no automatic retry") from None
        cached = {"format": "astana-wikidata-cache-v1", "endpoint": ENDPOINT, "license": "CC0-1.0",
                  "license_url": LICENSE, "ids": ids, "request_sha256": digest(params),
                  "retrieved_at": (fixed_now or utcnow()).isoformat(), "raw_sha256": digest(payload), "payload": payload}
        validate_cache(cached)
        atomic_json(path, cached)
        return cached


def enrich(places, cache):
    entities = validate_cache(cache)
    needed = linked_ids(places)
    if not set(needed).issubset(entities):
        raise DataError("Wikidata cache does not cover selected exact identities")
    enriched, used, omitted = [], {}, []
    for source_place in places:
        place = deepcopy(source_place)
        qids = linked_ids([place])
        if not qids:
            enriched.append(place)
            continue
        qid = qids[0]
        entity = entities[qid]
        revision = entity["lastrevid"]
        evidence = {"id": f"wikidata:{qid}/{revision}", "source_name": SOURCE, "source_type": "provider",
                    "source_url": f"https://www.wikidata.org/w/index.php?title={qid}&oldid={revision}",
                    "source_record_id": qid, "retrieved_at": cache["retrieved_at"], "is_synthetic": False}
        new_facts = []
        def fact(key, value):
            new_facts.append({"key": key, "status": "known", "value": value, "evidence_ids": [evidence["id"]], "note": NOTE})
        for language in LANGUAGES:
            for field, key in (("labels", "label"), ("descriptions", "description")):
                if language in entity[field]:
                    value = entity[field][language]["value"]
                    if field == "descriptions" and SUBJECTIVE.search(value):
                        omitted.append({"qid": qid, "language": language, "reason": "subjective_wording"})
                        continue
                    fact(f"wikidata:{key}:{language}", value)
            aliases = [a["value"] for a in entity["aliases"].get(language, [])]
            if aliases:
                fact(f"wikidata:aliases:{language}", sorted(set(aliases)))
        if not place["description"]:
            for language in LANGUAGES:
                if language in entity["descriptions"] and not SUBJECTIVE.search(entity["descriptions"][language]["value"]):
                    place["description"] = entity["descriptions"][language]["value"]
                    fact("description:source", "wikidata")
                    fact("description:language", language)
                    break
        if new_facts:
            place["facts"].extend(new_facts)
            place["evidence"].append(evidence)
            used[qid] = {"revision": revision, "modified_at": entity["modified"]}
        enriched.append(validate_payload("Place", place))
    return enriched, {"source": SOURCE, "endpoint": ENDPOINT, "license": "CC0-1.0", "license_url": LICENSE,
                      "retrieved_at": cache["retrieved_at"], "raw_sha256": cache["raw_sha256"],
                      "request_sha256": cache["request_sha256"], "entities": used,
                      "place_count": sum(any(e["source_type"] == "provider" for e in p["evidence"]) for p in enriched),
                      "identity_policy": "exact-osm-wikidata-qid-v1", "omitted_descriptions": omitted,
                      "limitations": [NOTE, "No amenities inferred from descriptions.",
                                      "A limited subjective-wording filter is not independent factual verification."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True, type=Path, help="Existing valid OSM snapshot defining exact QIDs")
    parser.add_argument("--cache", required=True, type=Path)
    args = parser.parse_args()
    try:
        from .repository import SnapshotRepository
        if args.snapshot.resolve() == args.cache.resolve():
            raise DataError("Snapshot and Wikidata cache paths must differ")
        repo = SnapshotRepository(args.snapshot)
        if repo._status != "ready":
            raise DataError("Input snapshot is invalid")
        places = [json.loads(raw) for raw in repo._records.values()]
        cached = asyncio.run(collect_cache(places, args.cache))
    except (DataError, OSError, KeyError, TypeError, ValueError):
        parser.exit(1, "Wikidata import failed; existing cache and snapshot were preserved.\n")
    print(f'Cached {len(cached["ids"])} exact Wikidata identities; CC0-1.0; use importer --wikidata-cache to apply offline.')


if __name__ == "__main__":
    main()
