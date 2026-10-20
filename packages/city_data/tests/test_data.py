import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from astana_contracts import validate_payload
from astana_city_context.schedules import enrich_schedule

from astana_city_data import SnapshotRepository, create_repository
from astana_city_data.common import DataError, atomic_json, digest, load_json
from astana_city_data.importer import fetch_response, import_snapshot, select_sample
from astana_city_data.normalize import normalize_response, query

NOW = datetime(2026, 10, 18, 12, tzinfo=timezone.utc)


def run(coro):
    return asyncio.run(coro)


def node(identifier=1, **tags):
    return {"type": "node", "id": identifier, "lat": 51.12, "lon": 71.42,
            "tags": {"name": "Test source cafe", "name:ru": "Кофейня", "name:kk": "Кофехана",
                     "name:en": "Coffee", "amenity": "cafe", **tags}}


def response(*elements):
    return {"version": 0.6, "generator": "test Overpass", "osm3s": {"timestamp_osm_base": "2026-10-18T11:59:00Z"},
            "elements": list(elements or [node()])}


def import_to(tmp_path, payload=None, **kwargs):
    return run(import_snapshot(output=tmp_path / "snapshot.json", cache=tmp_path / "cache.json", now=NOW,
                               transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload or response())), **kwargs))


def test_normalized_claims_unknowns_names_and_context_compatibility():
    places, report = normalize_response(response(node(wheelchair="limited", indoor="yes", fee="no", opening_hours="24/7")), NOW.isoformat())
    place = places[0]
    validate_payload("Place", place)
    assert place["id"] == "osm:node/1" and place["is_synthetic"] is False
    facts = {f["key"]: f for f in place["facts"]}
    assert facts["wheelchair_accessible"]["status"] == "unknown"
    assert facts["osm:wheelchair"]["value"] == "limited"
    assert facts["indoor"]["value"] is True and facts["free_entry"]["value"] is True
    assert facts["name:kk"]["value"] == "Кофехана"
    assert facts["child_friendly"]["value"] is None
    assert facts["open_at_requested_time"]["status"] == "unknown"
    assert place["description"] is None
    derived, warnings = enrich_schedule(place, at=NOW, locale="ru")
    assert derived["status"] == "known" and derived["value"] is True and not warnings
    assert derived["evidence_ids"] == facts["opening_hours"]["evidence_ids"]
    assert report["retained_places"] == 1


def test_no_properties_inferred_from_categories_and_negative_tags_preserved():
    places, _ = normalize_response(response(node(), node(2, wheelchair="no", indoor="no", fee="yes")), NOW.isoformat())
    first = {f["key"]: f for f in places[0]["facts"]}
    second = {f["key"]: f for f in places[1]["facts"]}
    for key in ("indoor", "free_entry", "opening_hours", "wheelchair_accessible"):
        assert first[key]["status"] == "unknown" and first[key]["value"] is None and not first[key]["evidence_ids"]
    assert all(second[key]["value"] is False for key in ("indoor", "free_entry", "wheelchair_accessible"))


def test_mall_import_requires_explicit_shop_type_and_preserves_its_source_tag():
    places, report = normalize_response(response(
        node(1, amenity="", shop="mall", building="retail", name="Source shopping centre"),
        node(2, name="Mega", description="A cafe next to a shopping mall"),
        node(3, amenity="", building="retail", name="Retail building without a mall tag"),
    ), NOW.isoformat())
    mall, cafe = places
    assert mall["categories"] == ["mall"] and cafe["categories"] == ["cafe"]
    facts = {fact["key"]: fact for fact in mall["facts"]}
    assert facts["osm:shop"]["value"] == "mall"
    assert facts["osm:shop"]["evidence_ids"] == [mall["evidence"][0]["id"]]
    assert facts["indoor"]["status"] == "unknown"
    assert report["excluded"] == {"outside_selection": 1}
    assert '["shop"~"^(mall)$"]' in query()


def test_duplicates_stable_ids_and_centers_are_not_merged_by_name():
    way = {"type": "way", "id": 1, "center": {"lat": 51.12, "lon": 71.42}, "tags": node()["tags"]}
    places, report = normalize_response(response(node(), node(), way), NOW.isoformat())
    assert [p["id"] for p in places] == ["osm:node/1", "osm:way/1"]
    assert report["excluded"] == {"identical_duplicate": 1}
    assert next(f for f in places[1]["facts"] if f["key"] == "osm:coordinate_kind")["value"] == "bounding_box_center"
    with pytest.raises(DataError, match="Conflicting duplicate"):
        normalize_response(response(node(), node(name="Changed same id")), NOW.isoformat())


@pytest.mark.parametrize("bad", [
    {"type": "node", "id": 2, "lat": 99, "lon": 71.4, "tags": {"name": "Bad", "amenity": "cafe"}},
    {"type": "node", "id": 2, "lat": True, "lon": 71.4, "tags": {"name": "Bad", "amenity": "cafe"}},
    {"type": "node", "id": 2, "lat": 50, "lon": 70, "tags": {"name": "Elsewhere", "amenity": "cafe"}},
    node(2, name=""), node(2, access="private"), {"type": []},
])
def test_invalid_or_outside_records_are_reported(bad):
    places, report = normalize_response(response(node(), bad), NOW.isoformat())
    assert len(places) == 1 and sum(report["excluded"].values()) == 1


@pytest.mark.parametrize("bad", [
    {"remark": "runtime error: Query timed out", "elements": [node()]},
    {"error": "out of memory", "elements": [node()]},
    {"elements": []}, {"elements": [node()], "osm3s": []},
    response({"type": "node", "id": 1}),
])
def test_incomplete_and_empty_responses_never_publish(bad, tmp_path):
    output = tmp_path / "snapshot.json"
    output.write_text("previous successful snapshot", encoding="utf-8")
    with pytest.raises(DataError):
        import_to(tmp_path, bad)
    assert output.read_text(encoding="utf-8") == "previous successful snapshot"
    assert not (tmp_path / "cache.json").exists()


def test_single_request_cache_idempotence_and_changed_deleted_records(tmp_path):
    calls = []
    def handler(request):
        calls.append(request)
        assert request.url.host == "overpass-api.de" and request.method == "POST"
        assert b"timeout%3A30" in request.content and b"maxsize%3A33554432" in request.content
        return httpx.Response(200, json=response(node(), node(2)))
    kwargs = {"output": tmp_path / "snapshot.json", "cache": tmp_path / "cache.json", "now": NOW,
              "transport": httpx.MockTransport(handler)}
    run(import_snapshot(**kwargs))
    first = (tmp_path / "snapshot.json").read_bytes()
    run(import_snapshot(**kwargs))
    assert (tmp_path / "snapshot.json").read_bytes() == first and len(calls) == 1
    later = NOW + timedelta(days=2)
    kwargs.update(now=later, transport=httpx.MockTransport(lambda _: httpx.Response(200, json=response(node(2, name="Changed")))))
    run(import_snapshot(**kwargs))
    repo = SnapshotRepository(tmp_path / "snapshot.json", clock=lambda: later)
    assert run(repo.get("osm:node/1")) is None
    assert run(repo.get("osm:node/2"))["name"] == "Changed"


def test_failures_observe_cooldown_and_keep_good_snapshot(tmp_path):
    import_to(tmp_path)
    before = (tmp_path / "snapshot.json").read_bytes()
    calls = []
    def failed(request):
        calls.append(request)
        return httpx.Response(429, headers={"Retry-After": "60"})
    kwargs = {"output": tmp_path / "snapshot.json", "cache": tmp_path / "cache.json", "now": NOW + timedelta(days=2),
              "transport": httpx.MockTransport(failed)}
    with pytest.raises(DataError, match="Overpass unavailable"):
        run(import_snapshot(**kwargs))
    with pytest.raises(DataError, match="cooldown"):
        run(import_snapshot(**kwargs))
    assert len(calls) == 1 and (tmp_path / "snapshot.json").read_bytes() == before


def test_compressed_response_rejected_without_reading():
    class NeverRead(httpx.AsyncByteStream):
        async def __aiter__(self):
            raise AssertionError("compressed body must not be consumed")
            yield b""
    with pytest.raises(DataError, match="Encoded"):
        run(fetch_response(transport=httpx.MockTransport(lambda _: httpx.Response(200, headers={"content-encoding": "gzip"}, stream=NeverRead()))))


def test_streaming_response_cap_and_redirect_not_followed(monkeypatch):
    import astana_city_data.importer as importer
    monkeypatch.setattr(importer, "MAX_BYTES", 32)
    class Stream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"x" * 64
    with pytest.raises(DataError, match="size limit"):
        run(fetch_response(transport=httpx.MockTransport(lambda _: httpx.Response(200, stream=Stream()))))
    with pytest.raises(httpx.HTTPStatusError):
        run(fetch_response(transport=httpx.MockTransport(lambda _: httpx.Response(302, headers={"location": "https://example.invalid"})) ))


def test_sample_is_bounded_deterministic_and_category_diverse():
    places, _ = normalize_response(response(*[node(i) for i in range(1, 20)], node(20, amenity="library")), NOW.isoformat())
    selected = select_sample(places, 3)
    assert len(selected) == 3 and any("library" in p["categories"] for p in selected)
    assert selected == select_sample(places, 3)


def test_repository_copy_isolation_filters_pagination_and_nearby(tmp_path):
    import_to(tmp_path, response(node(1), node(2), node(3, amenity="library", name="Library")))
    repo = SnapshotRepository(tmp_path / "snapshot.json", clock=lambda: NOW)
    result = run(repo.get("osm:node/1"))
    result["facts"][0]["value"] = "MUTATED"
    assert run(repo.get("osm:node/1"))["facts"][0]["value"] is None
    first = run(repo.list_places(limit=1))
    second = run(repo.list_places(limit=1, cursor=first["next_cursor"]))
    assert first["places"][0]["id"] != second["places"][0]["id"]
    with pytest.raises(DataError, match="cursor"):
        run(repo.list_places(limit=2, cursor=first["next_cursor"]))
    with pytest.raises(DataError, match="cursor"):
        run(repo.list_places(cursor="garbage"))
    assert len(run(repo.list_places(categories=["cafe"]))["places"]) == 2
    assert len(run(repo.list_places(query="кофехана"))["places"]) == 3
    assert run(repo.list_places(bbox=(71.5, 51.2, 71.6, 51.3)))["places"] == []
    assert [p["id"] for p in run(repo.nearby(origin={"lat": 51.12, "lon": 71.42}, radius_meters=100, limit=1000))] == ["osm:node/1", "osm:node/2", "osm:node/3"]
    for bad in (0, 1001, True):
        with pytest.raises(DataError):
            run(repo.nearby(origin={"lat": 51.12, "lon": 71.42}, radius_meters=100, limit=bad))


def test_status_factory_missing_corrupt_stale_and_valid(tmp_path, monkeypatch):
    monkeypatch.delenv("ASTANA_POI_PATH", raising=False)
    missing = SnapshotRepository(clock=lambda: NOW)
    assert run(missing.data_status())["sources"][0]["status"] == "not_configured"
    assert run(missing.list_places())["places"] == []
    monkeypatch.setenv("ASTANA_POI_PATH", str(tmp_path / "missing.json"))
    with pytest.raises(DataError, match="ASTANA_POI_PATH"):
        create_repository(config={"mode": "live"})
    import_to(tmp_path)
    path = tmp_path / "snapshot.json"
    good = SnapshotRepository(path, clock=lambda: NOW)
    assert run(good.data_status())["sources"][0]["status"] == "ready"
    stale = SnapshotRepository(path, clock=lambda: NOW + timedelta(days=8))
    assert run(stale.data_status())["sources"][0]["status"] == "stale"
    snapshot = load_json(path)
    snapshot["places"][0]["name"] = "Corrupted"
    atomic_json(path, snapshot)
    invalid = SnapshotRepository(path, clock=lambda: NOW)
    assert run(invalid.data_status())["sources"][0]["status"] == "unavailable"
    assert run(invalid.get("osm:node/1")) is None
    # A complete replacement requires a new repository; reads never reload a partial file.
    assert run(good.get("osm:node/1"))["name"] == "Test source cafe"


def test_factory_fails_closed_without_valid_snapshot(tmp_path, monkeypatch):
    monkeypatch.delenv("ASTANA_POI_PATH", raising=False)
    with pytest.raises(DataError, match="ASTANA_POI_PATH"):
        create_repository(config={"mode": "live"})
    path = tmp_path / "snapshot.json"
    path.write_text("incomplete", encoding="utf-8")
    monkeypatch.setenv("ASTANA_POI_PATH", str(path))
    with pytest.raises(DataError, match="ASTANA_POI_PATH"):
        create_repository(config={"mode": "live"})
    import_to(tmp_path)
    assert isinstance(create_repository(config={"mode": "live"}), SnapshotRepository)


def test_failed_snapshot_and_synthetic_data_are_rejected(tmp_path):
    import_to(tmp_path)
    path = tmp_path / "snapshot.json"
    original = load_json(path)
    for mutate in (lambda s: s["manifest"].update(complete_query_response=False),
                   lambda s: s["places"][0].update(is_synthetic=True)):
        snapshot = deepcopy(original)
        mutate(snapshot)
        snapshot["manifest"]["places_sha256"] = digest(snapshot["places"])
        atomic_json(path, snapshot)
        assert run(SnapshotRepository(path, clock=lambda: NOW).data_status())["total_places"] == 0


def test_query_is_city_bounded_and_no_runtime_provider_access(tmp_path, monkeypatch):
    assert "[timeout:30]" in query() and "[maxsize:33554432]" in query()
    assert "50.95,71.2,51.3,71.65" in query()
    import_to(tmp_path)
    def forbidden(*args, **kwargs):
        raise AssertionError("HTTP forbidden in repository")
    monkeypatch.setattr(httpx, "AsyncClient", forbidden)
    repo = SnapshotRepository(tmp_path / "snapshot.json", clock=lambda: NOW)
    assert run(repo.get("osm:node/1")) and run(repo.data_status())["total_places"] == 1


def test_committed_real_sample_replays_from_raw_cache_without_network():
    root = Path(__file__).resolve().parents[3]
    cache = load_json(root / "data/samples/astana-overpass-cache.json")
    snapshot = load_json(root / "data/samples/astana-osm.json")
    manifest = load_json(root / "data/manifests/astana-osm.json")
    assert manifest == snapshot["manifest"]
    assert digest(cache["payload"]) == cache["raw_sha256"] == manifest["raw_sha256"]
    places, report = normalize_response(cache["payload"], cache["retrieved_at"])
    assert report == manifest["report"]
    from astana_city_data.wikidata import enrich
    enriched, enrichment = enrich(select_sample(places, manifest["sample_limit"]),
                                 load_json(root / "data/samples/astana-wikidata-cache.json"))
    assert enrichment == manifest["wikidata_enrichment"]
    from astana_city_data.official import enrich as enrich_official
    enriched, official = enrich_official(enriched, load_json(root / "data/samples/astana-official-supplement.json"))
    assert official == manifest["official_enrichment"]
    assert enriched == snapshot["places"]
    assert manifest["places_sha256"] == digest(snapshot["places"])
    assert len(snapshot["places"]) == manifest["place_count"] > 0
    assert all(not place["is_synthetic"] for place in snapshot["places"])
