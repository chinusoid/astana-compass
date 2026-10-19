import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import gzip

import httpx
import pytest

from astana_city_data import SnapshotRepository
from astana_city_data.common import DataError, atomic_json, canonical, digest, load_json
from astana_city_data.importer import import_snapshot
from astana_city_data.normalize import normalize_response, query
from astana_city_data.wikidata import (ENDPOINT, LICENSE, collect_cache, enrich, fetch_entities, linked_ids,
                                      parameters, validate_cache)

NOW = datetime(2026, 10, 18, 12, tzinfo=timezone.utc)


def run(coro):
    return asyncio.run(coro)


def source(**tags):
    return {"osm3s": {"timestamp_osm_base": "2026-10-18T11:59:00Z"}, "elements": [
        {"type": "node", "id": 1, "lat": 51.12, "lon": 71.42,
         "tags": {"name": "Source name", "amenity": "cafe", "wikidata": "Q123", **tags}}]}


def places(**tags):
    return normalize_response(source(**tags), NOW.isoformat())[0]


def wiki_payload():
    return {"success": 1, "entities": {"Q123": {
        "id": "Q123", "type": "item", "lastrevid": 42, "modified": "2026-10-18T11:00:00Z",
        "labels": {"en": {"language": "en", "value": "Source label"}},
        "descriptions": {"ru": {"language": "ru", "value": "Исходное описание"},
                         "en": {"language": "en", "value": "Source description"}},
        "aliases": {"kk": [{"language": "kk", "value": "Қазақша балама атау"}]},
    }}}


def wiki_cache(payload=None):
    payload = payload or wiki_payload()
    return {"format": "astana-wikidata-cache-v1", "endpoint": ENDPOINT, "license": "CC0-1.0",
            "license_url": LICENSE, "ids": ["Q123"], "request_sha256": digest(parameters(["Q123"])),
            "retrieved_at": NOW.isoformat(), "payload": payload, "raw_sha256": digest(payload)}


@pytest.mark.parametrize(("raw", "expected"), [
    ("wlan", True), ("wired;wlan", True), ("no", False), ("yes", None), ("wired", None),
    ("terminal", None), ("no;wlan", None), ("no ; wlan", None), ("wlan;private", None),
    ("wlan;restricted", None), ("unknown", None), ("", None),
])
def test_wifi_requires_explicit_wireless_tag_not_just_internet(raw, expected):
    fact = next(f for f in places(internet_access=raw)[0]["facts"] if f["key"] == "has_wifi")
    assert fact["value"] is expected
    assert fact["status"] == ("unknown" if expected is None else "known")
    assert bool(fact["evidence_ids"]) is (expected is not None)


def test_specific_amenities_never_prove_broader_claims():
    result = places(**{"toilets": "yes", "toilets:wheelchair": "yes", "indoor": "room",
                       "highchair": "yes", "changing_table": "yes", "indoor_seating": "yes",
                       "cuisine": "coffee_shop;italian", "description:kk": "Дереккөз сипаттамасы"})[0]
    facts = {f["key"]: f for f in result["facts"]}
    assert facts["toilets"]["value"] is True
    for key in ("wheelchair_accessible", "indoor", "child_friendly", "quiet", "has_power_outlets"):
        assert facts[key]["status"] == "unknown" and facts[key]["evidence_ids"] == []
    assert facts["osm:indoor_seating"]["value"] == "yes"
    assert facts["osm:cuisine"]["value"] == "coffee_shop;italian"
    assert result["description"] == "Дереккөз сипаттамасы"
    assert facts["description:source"]["value"] == "osm" and facts["description:language"]["value"] == "kk"
    for tag, expected in (("no", False), ("customers", None), ("", None)):
        assert next(f for f in places(toilets=tag)[0]["facts"] if f["key"] == "toilets")["value"] is expected


def test_exact_qid_only_not_brand_nearby_or_name_match():
    assert linked_ids(places()) == ["Q123"]
    assert linked_ids(places(**{"wikidata": "Q123;Q456", "brand:wikidata": "Q123"})) == []
    assert linked_ids(places(**{"wikidata": "https://www.wikidata.org/wiki/Q123"})) == []
    with pytest.raises(DataError):
        parameters([f"Q{i}" for i in range(1, 52)])


def test_source_text_evidence_names_and_amenities_preserved():
    original = places()
    enriched, report = enrich(original, wiki_cache())
    result = enriched[0]
    facts = {f["key"]: f for f in result["facts"]}
    assert original[0]["description"] is None  # No mutation of the OSM source records.
    assert result["name"] == original[0]["name"]
    assert result["description"] == "Исходное описание"
    assert facts["description:source"]["value"] == "wikidata"
    assert facts["wikidata:aliases:kk"]["value"] == ["Қазақша балама атау"]
    assert result["evidence"][-1]["source_url"] == "https://www.wikidata.org/w/index.php?title=Q123&oldid=42"
    assert facts["has_wifi"]["status"] == "unknown" and facts["indoor"]["status"] == "unknown"
    assert report["entities"] == {"Q123": {"revision": 42, "modified_at": "2026-10-18T11:00:00Z"}}
    result, _ = enrich(places(description="Original OSM text"), wiki_cache())
    assert result[0]["description"] == "Original OSM text"


def test_subjective_wikidata_description_is_not_presented_as_neutral_place_text():
    payload = wiki_payload()
    payload["entities"]["Q123"]["descriptions"]["ru"]["value"] = "Достойный парк в Астане"
    cached = wiki_cache(payload)
    result, report = enrich(places(), cached)
    assert result[0]["description"] == "Source description"
    facts = {fact["key"]: fact for fact in result[0]["facts"]}
    assert facts["description:language"]["value"] == "en"
    assert "wikidata:description:ru" not in facts
    assert report["omitted_descriptions"] == [{"qid": "Q123", "language": "ru", "reason": "subjective_wording"}]
    assert cached["payload"]["entities"]["Q123"]["descriptions"]["ru"]["value"] == "Достойный парк в Астане"


@pytest.mark.parametrize("mutate", [
    lambda p: p.update(error={"code": "maxlag"}), lambda p: p.update(warnings={"partial": True}),
    lambda p: p["entities"]["Q123"].update(id="Q456"), lambda p: p["entities"]["Q123"].update(missing=""),
    lambda p: p["entities"]["Q123"].update(lastrevid=True),
    lambda p: p["entities"]["Q123"].update(modified="2027-01-01T00:00:00Z"),
    lambda p: p["entities"]["Q123"]["descriptions"].update(en={"language": "ru", "value": "wrong language"}),
])
def test_failed_partial_redirected_or_invalid_entities_rejected(mutate):
    payload = wiki_payload()
    mutate(payload)
    with pytest.raises(DataError):
        validate_cache(wiki_cache(payload))


def test_one_bounded_request_cache_idempotence_cooldown_and_last_good(tmp_path):
    path, calls = tmp_path / "wiki.json", []
    def handler(request):
        calls.append(request)
        assert request.method == "GET" and request.url.host == "www.wikidata.org"
        assert request.url.params["ids"] == "Q123" and request.url.params["maxlag"] == "5"
        assert "claims" not in request.url.params["props"]
        assert request.headers["Accept-Encoding"] == "gzip, deflate"
        return httpx.Response(200, json=wiki_payload())
    first = run(collect_cache(places(), path, transport=httpx.MockTransport(handler), now=NOW))
    assert run(collect_cache(places(), path, transport=httpx.MockTransport(handler), now=NOW)) == first
    assert len(calls) == 1
    def failed(request):
        calls.append(request)
        return httpx.Response(429, headers={"Retry-After": "3600"})
    for later in (NOW + timedelta(days=2), NOW + timedelta(days=2, minutes=10)):
        with pytest.raises(DataError):
            run(collect_cache(places(), path, transport=httpx.MockTransport(failed), now=later))
    assert len(calls) == 2 and load_json(path) == first


def test_compression_bomb_and_redirect_do_not_escape_bounds(monkeypatch):
    import astana_city_data.wikidata as wiki
    monkeypatch.setattr(wiki, "MAX_BYTES", 256)
    class Stream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield gzip.compress(b"x" * 100_000)
    with pytest.raises(DataError, match="size limit"):
        run(fetch_entities(["Q123"], transport=httpx.MockTransport(lambda _: httpx.Response(
            200, headers={"content-encoding": "gzip"}, stream=Stream()))))
    with pytest.raises(httpx.HTTPStatusError):
        run(fetch_entities(["Q123"], transport=httpx.MockTransport(lambda _: httpx.Response(
            302, headers={"location": "https://other.invalid"}))))


def test_normal_gzip_stream_is_decoded_without_extra_request():
    class Stream(httpx.AsyncByteStream):
        async def __aiter__(self):
            body = gzip.compress(canonical(wiki_payload()))
            for i in range(0, len(body), 11):
                yield body[i:i + 11]
    assert run(fetch_entities(["Q123"], transport=httpx.MockTransport(lambda _: httpx.Response(
        200, headers={"content-encoding": "gzip"}, stream=Stream())))) == wiki_payload()


def build_offline(tmp_path, **kwargs):
    raw, wiki, output = tmp_path / "raw.json", tmp_path / "wiki.json", tmp_path / "snapshot.json"
    atomic_json(raw, {"query_sha256": digest(query()), "raw_sha256": digest(source()), "payload": source(),
                      "retrieved_at": NOW.isoformat()})
    atomic_json(wiki, wiki_cache())
    run(import_snapshot(output=output, cache=raw, wikidata_cache=wiki, offline=True,
                        now=NOW + timedelta(days=10), **kwargs))
    return raw, wiki, output


def test_offline_replay_preserves_each_source_time_and_supports_alias_lookup(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Offline imports and repository must not create HTTP clients")
    monkeypatch.setattr(httpx, "AsyncClient", forbidden)
    raw, wiki, output = build_offline(tmp_path)
    repo = SnapshotRepository(output, clock=lambda: NOW + timedelta(days=10))
    status = run(repo.data_status())
    assert status["total_places"] == 1 and len(status["sources"]) == 2
    assert all(s["status"] == "stale" and s["last_success_at"] == NOW.isoformat() for s in status["sources"])
    assert run(repo.list_places(query="Қазақша балама"))["places"][0]["id"] == "osm:node/1"
    before = output.read_bytes()
    run(import_snapshot(output=output, cache=raw, wikidata_cache=wiki, offline=True, now=NOW + timedelta(days=10)))
    assert output.read_bytes() == before
    cached = load_json(raw)
    cached["query_sha256"] = "wrong"
    atomic_json(raw, cached)
    with pytest.raises(DataError, match="Offline"):
        run(import_snapshot(output=output, cache=raw, offline=True, now=NOW + timedelta(days=10)))
    assert output.read_bytes() == before


@pytest.mark.parametrize("mutate", [
    lambda s: s["places"][0]["evidence"][1].update(source_url="https://evil.invalid/Q123"),
    lambda s: s["places"][0]["evidence"][1].update(source_record_id="Q456"),
    lambda s: s["places"][0]["evidence"][1].update(source_type="official"),
    lambda s: s["places"][0]["evidence"][1].update(retrieved_at="2026-10-18T12:01:00Z"),
    lambda s: s["manifest"].pop("wikidata_enrichment"),
    lambda s: s["manifest"]["wikidata_enrichment"].update(license="ODbL-1.0"),
    lambda s: s["manifest"]["wikidata_enrichment"].update(place_count=2),
    lambda s: next(f for f in s["places"][0]["facts"] if f["key"] == "has_wifi").update(
        status="known", value=True, evidence_ids=["wikidata:Q123/42"]),
])
def test_repository_fails_closed_for_unapproved_provider_provenance(tmp_path, mutate):
    _, _, output = build_offline(tmp_path)
    snapshot = deepcopy(load_json(output))
    mutate(snapshot)
    snapshot["manifest"]["places_sha256"] = digest(snapshot["places"])
    atomic_json(output, snapshot)
    assert run(SnapshotRepository(output, clock=lambda: NOW + timedelta(days=10)).data_status())["total_places"] == 0
