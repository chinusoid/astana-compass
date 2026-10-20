import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from astana_city_data.common import DataError, atomic_json, canonical, digest, load_json
from astana_city_data.importer import import_snapshot
from astana_city_data.normalize import normalize_response, query
from astana_city_data.official import FORMAT, POLICY, PAGES, USAGE, enrich, expected_records, validate_bundle
from astana_city_data.repository import SnapshotRepository

NOW = datetime(2026, 10, 20, 16, tzinfo=timezone.utc)


def raw(**tags):
    return {"osm3s": {"timestamp_osm_base": "2026-10-19T15:00:00Z"}, "elements": [
        {"type": "node", "id": 1, "lat": 51.12, "lon": 71.42,
         "tags": {"name": "Source park", "leisure": "park", **tags}}]}


def original(**tags):
    return normalize_response(raw(**tags), NOW.isoformat())[0]


def bundle(claims=None):
    source_name, source_url = PAGES["visit-central"]
    return {"format": FORMAT, "identity_policy": POLICY, "sources": {"visit-central": {
        "source_name": source_name, "source_url": source_url, "retrieved_at": NOW.isoformat(),
        "access_method": "reviewed-web-index", "usage": USAGE, "review_note": "Reviewed factual notes; no crawling."}},
        "places": [{"place_id": "osm:node/1", "osm_name": "Source park", "location": {"lat": 51.12, "lon": 71.42},
                    "identity_note": "Exact reviewed identity, not fuzzy proximity matching.", "facts": claims or [
                        claim("official:description:ru", "Парк с прогулочными аллеями."),
                        claim("official:aliases:ru", ["Центральный парк"]),
                        claim("official:walking_paths", True)]}]}


def claim(key, value):
    return {"key": key, "value": value, "sources": ["visit-central"], "note": "Explicit source assertion."}


def facts(place):
    return {fact["key"]: fact for fact in place["facts"]}


def test_official_notes_keep_names_sources_and_unsupported_amenities():
    before = original(description="OSM original description")
    after, report = enrich(before, bundle(), clock=lambda: NOW)
    result = after[0]
    assert result["name"] == before[0]["name"]
    assert result["location"] == before[0]["location"]
    assert result["description"] == "Парк с прогулочными аллеями."
    assert facts(result)["osm:description"]["value"] == "OSM original description"
    assert facts(result)["description:source"]["value"] == "official"
    assert facts(result)["official:aliases:ru"]["evidence_ids"] == ["official:visit-central"]
    assert result["evidence"][-1]["source_url"] == PAGES["visit-central"][1]
    for key in ("has_wifi", "toilets", "free_entry", "wheelchair_accessible", "child_friendly", "open_at_requested_time"):
        assert facts(result)[key]["status"] == "unknown"
    assert before == original(description="OSM original description")
    assert expected_records(report, clock=lambda: NOW) == {result["id"]: canonical(result)}


def test_conflicting_claims_preserve_individual_values_instead_of_overwriting_osm():
    after, report = enrich(original(fee="yes"), bundle([claim("free_entry", True)]), clock=lambda: NOW)
    result = facts(after[0])
    assert result["free_entry"]["status"] == "conflicting" and result["free_entry"]["value"] is None
    assert set(result["free_entry"]["evidence_ids"]) == {"osm:evidence:node/1", "official:visit-central"}
    assert result["source:prior:free_entry"]["value"] is False
    assert any(f["key"].startswith("official:claim:") and f["value"] is True for f in after[0]["facts"])
    assert report["base_places"][0] == original(fee="yes")[0]


def test_matching_claim_combines_evidence_without_duplicate_effective_fact():
    result, _ = enrich(original(fee="no"), bundle([claim("free_entry", True)]), clock=lambda: NOW)
    fact = facts(result[0])["free_entry"]
    assert fact["status"] == "known" and fact["value"] is True and len(fact["evidence_ids"]) == 2
    assert len([f for f in result[0]["facts"] if f["key"] == "free_entry"]) == 1


@pytest.mark.parametrize("mutate", [
    lambda b: b["sources"]["visit-central"].update(source_url="https://unreviewed.example/park"),
    lambda b: b["sources"]["visit-central"].update(source_name="Unreviewed operator"),
    lambda b: b["sources"]["visit-central"].update(retrieved_at="2027-01-01T00:00:00Z"),
    lambda b: b["sources"]["visit-central"].update(usage="All source HTML is freely reusable"),
    lambda b: b["places"][0]["facts"][0].update(sources=[]),
    lambda b: b["places"][0]["facts"][0].update(sources=["unreviewed"]),
    lambda b: b["places"][0]["facts"][0].update(key="open_at_requested_time", value=True),
    lambda b: b["places"][0]["facts"][0].update(key="free_entry", value="yes"),
    lambda b: b["places"][0]["facts"].append(deepcopy(b["places"][0]["facts"][0])),
    lambda b: b["places"].append(deepcopy(b["places"][0])),
    lambda b: b.update(places=b["places"] * 21),
])
def test_unreviewed_or_malformed_bundle_rejected(mutate):
    data = bundle()
    mutate(data)
    with pytest.raises(DataError):
        validate_bundle(data, clock=lambda: NOW)


@pytest.mark.parametrize("field,value", [("place_id", "osm:node/2"), ("osm_name", "Another park"),
                                          ("location", {"lat": 51.13, "lon": 71.42})])
def test_no_name_or_nearby_guess_when_osm_identity_changes(field, value):
    data = bundle()
    data["places"][0][field] = value
    with pytest.raises(DataError):
        enrich(original(), data, clock=lambda: NOW)


def imported(tmp_path):
    cache, supplement, output = (tmp_path / name for name in ("raw.json", "official.json", "snapshot.json"))
    payload = raw()
    atomic_json(cache, {"query_sha256": digest(query()), "raw_sha256": digest(payload),
                        "retrieved_at": NOW.isoformat(), "payload": payload})
    atomic_json(supplement, bundle())
    asyncio.run(import_snapshot(output=output, cache=cache, official_supplement=supplement, offline=True, now=NOW))
    return output


def test_offline_import_and_independent_source_status(tmp_path, monkeypatch):
    import astana_city_data.importer as importer
    async def forbidden(**kwargs):
        raise AssertionError("offline supplement must not fetch anything")
    monkeypatch.setattr(importer, "fetch_response", forbidden)
    path = imported(tmp_path)
    repo = SnapshotRepository(path, clock=lambda: NOW)
    assert repo._status == "ready"
    result = asyncio.run(repo.list_places(query="Центральный парк"))
    assert [p["id"] for p in result["places"]] == ["osm:node/1"]
    status = asyncio.run(repo.data_status())
    assert status["total_places"] == 1 and len(status["sources"]) == 2
    source = status["sources"][1]
    assert source["source_url"] == PAGES["visit-central"][1] and source["place_count"] == 1
    stale = SnapshotRepository(path, clock=lambda: NOW + timedelta(days=8))
    assert asyncio.run(stale.data_status())["sources"][1]["status"] == "stale"


@pytest.mark.parametrize("mutate", [
    lambda s: s["places"][0].update(description="An invented claim"),
    lambda s: s["places"][0]["evidence"][-1].update(source_url="https://unreviewed.example/"),
    lambda s: facts(s["places"][0])["official:walking_paths"].update(value=False),
    lambda s: facts(s["places"][0])["has_wifi"].update(status="known", value=True, evidence_ids=["official:visit-central"]),
    lambda s: s["manifest"]["official_enrichment"].update(bundle_sha256="0" * 64),
    lambda s: s["manifest"].pop("official_enrichment"),
])
def test_repository_replays_reviewed_claims_and_rejects_tampering(tmp_path, mutate):
    path = imported(tmp_path)
    snapshot = load_json(path)
    mutate(snapshot)
    snapshot["manifest"]["places_sha256"] = digest(snapshot["places"])
    atomic_json(path, snapshot)
    assert SnapshotRepository(path, clock=lambda: NOW)._status == "unavailable"


def test_real_supplement_covers_priority_places_without_promising_unsupported_amenities():
    root = Path(__file__).resolve().parents[3]
    supplement = load_json(root / "data/samples/astana-official-supplement.json")
    snapshot = load_json(root / "data/samples/astana-osm.json")
    validate_bundle(supplement, clock=lambda: NOW)
    assert len(supplement["places"]) == 11 and len(supplement["sources"]) == 16
    assert len(snapshot["places"]) == 682
    malls = [place for place in snapshot["places"] if "mall" in place["categories"]]
    assert len(malls) == 54
    assert len(snapshot["places"]) - len(malls) == 628
    assert all(facts(place)["osm:shop"]["value"] == "mall" for place in malls)
    lookup = {p["id"]: p for p in snapshot["places"]}
    for entry in supplement["places"]:
        result = lookup[entry["place_id"]]
        assert facts(result)["official:description:ru"]["status"] == "known"
        assert len(result["description"]) > 250
        for key in ("free_entry", "has_wifi", "toilets", "open_at_requested_time"):
            assert facts(result)[key]["status"] == "unknown"
    garden = facts(lookup["osm:way/1196402246"])
    assert garden["official:greenhouse_hours"]["status"] == "known"
    assert garden["opening_hours"]["status"] == "unknown"
    central = lookup["osm:relation/15957444"]
    assert central["name"] == "Астана саябағы" and facts(central)["name:ru"]["value"] == "Парк Астана"
    assert "Центральный парк" in facts(central)["official:aliases:ru"]["value"]
    bridge = lookup["osm:way/1239177393"]
    assert facts(bridge)["official:waterfront"]["value"] == "Есиль"
    assert not any("atyrauskiy-most" in e["source_url"] for e in bridge["evidence"])


def test_operator_links_require_exact_reviewed_venue_source_and_phone_is_public_format():
    data = bundle([claim("official:website", "https://www.astanabotsad.kz/")])
    with pytest.raises(DataError):
        validate_bundle(data, clock=lambda: NOW)
    # Even an otherwise reviewed tourist publication must not claim to be the operator.
    for url in (PAGES["visit-central"][1], "javascript:alert(1)", "https://nmrk.kz@unreviewed.example/",
                "https://nmrk.kz/?redirect=https://unreviewed.example"):
        data["places"][0]["facts"][0]["value"] = url
        with pytest.raises(DataError):
            validate_bundle(data, clock=lambda: NOW)
    for phone in ("Касса: +7 (7172) 709600", "tel:+77172709600", "+7", "+1234567890123456"):
        with pytest.raises(DataError):
            validate_bundle(bundle([claim("official:phone", phone)]), clock=lambda: NOW)
    validate_bundle(bundle([claim("official:phone", "+7 (7172) 709-600")]), clock=lambda: NOW)


def test_real_practical_details_keep_operator_contact_and_hours_scopes():
    root = Path(__file__).resolve().parents[3]
    snapshot = load_json(root / "data/samples/astana-osm.json")
    lookup = {p["id"]: p for p in snapshot["places"]}
    garden = facts(lookup["osm:way/1196402246"])
    assert garden["official:website"]["value"] == "https://www.astanabotsad.kz/"
    assert "10:00–19:00" in garden["official:greenhouse_hours"]["value"]
    assert "18:30" in garden["official:greenhouse_entry_hours"]["value"]
    assert "19:00" in garden["official:greenhouse_entry_hours"]["value"]
    assert garden["opening_hours"]["status"] == "unknown"
    museum = facts(lookup["osm:node/4894937300"])
    assert "10:00–17:00" in museum["official:ticket_office_hours"]["value"]
    assert "Последний вторник" in museum["official:ticket_office_hours"]["value"]
    assert museum["official:phone"]["evidence_ids"] == ["official:museum-contacts"]
    opera = facts(lookup["osm:way/917478479"])
    assert "кассы" in opera["official:visitor_note"]["value"]
    assert opera["opening_hours"]["status"] == "unknown"
    for pid in ("osm:way/1296051287", "osm:way/1363058986", "osm:relation/16002498"):
        f = facts(lookup[pid])
        assert f["official:highlights"]["status"] == "known"
        assert f["quiet"]["status"] == "unknown"
        assert f["child_friendly"]["status"] == "unknown"
        assert f["open_at_requested_time"]["status"] == "unknown"
    triathlon = facts(lookup["osm:way/1363058986"])
    assert triathlon["official:waterfront"]["value"] == "Есиль"
    assert triathlon["opening_hours"]["status"] == "unknown"
    assert "2023" in facts(lookup["osm:way/1460700597"])["official:visitor_note"]["value"]
