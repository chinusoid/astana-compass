"""Shopping centres are selected from explicit OSM mall records, never names alone."""

import asyncio
from pathlib import Path

import pytest

from astana_city_data import SnapshotRepository
from astana_retrieval import LexicalRetriever


SNAPSHOT = Path(__file__).parents[3] / "data/samples/astana-osm.json"
ORIGIN = {"lat": 51.1061652, "lon": 71.4165705}
MEGA = "osm:way/499328514"
PLAZA = "osm:way/762780007"
MEGA_CAFE = "osm:node/1198118007"


def search(query, locale="en", **overrides):
    async def run():
        repository = SnapshotRepository(SNAPSHOT)
        return await LexicalRetriever(repository).retrieve({
            "query": query, "locale": locale, "origin": ORIGIN,
            "radius_meters": 30000, "candidate_limit": 100, "constraints": [], **overrides,
        })

    return asyncio.run(run())


@pytest.mark.parametrize("query,locale", [
    ("Красивый торговый центр", "ru"), ("shopping mall", "en"), ("сауда орталығы", "kk"),
])
def test_real_mall_candidates_are_source_typed_and_include_requested_examples(query, locale):
    result = search(query, locale)
    places = {place["id"]: place for place in result["places"]}
    assert {MEGA, PLAZA} <= places.keys()
    assert MEGA_CAFE not in places
    assert all("mall" in place["categories"] for place in places.values())
    for place in places.values():
        fact = next(fact for fact in place["facts"] if fact["key"] == "osm:shop")
        assert fact["status"] == "known" and fact["value"] == "mall"
        evidence = {item["id"]: item for item in place["evidence"]}
        assert fact["evidence_ids"] and all(evidence[item]["source_type"] == "osm"
                                            and not evidence[item]["is_synthetic"]
                                            for item in fact["evidence_ids"])


@pytest.mark.parametrize("name,identifier", [("Mega Silk Way", MEGA), ("Abu Dhabi Plaza", PLAZA)])
def test_named_mall_uses_its_actual_source_identity(name, identifier):
    result = search(name, named_place=name, categories=["mall"])
    assert identifier in {hit["place_id"] for hit in result["hits"]}
    assert all("mall" in place["categories"] for place in result["places"])


def test_generic_mall_type_does_not_become_a_name_alias_for_every_mall():
    assert not search("shopping mall", named_place="shopping mall", categories=["mall"])["hits"]
