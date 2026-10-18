"""Independent synthetic places. No examples imply real facilities or live providers."""
import asyncio
from copy import deepcopy

import pytest

from astana_contracts import ContractValidationError, Retriever, validate_payload
from astana_retrieval import LexicalRetriever, create_retriever
from astana_retrieval.retriever import distance_meters

ORIGIN = {"lat": 51.1, "lon": 71.4}


def place(name, category="cafe", *, lat=51.101, facts=None, description="Synthetic evaluation fixture only."):
    evidence_id = "synthetic:evidence:" + name
    return {
        "id": "synthetic:" + name, "name": "SYNTHETIC " + name,
        "location": {"lat": lat, "lon": 71.4}, "categories": [category], "description": description,
        "facts": [
            {"key": key, "value": value, "status": "unknown" if value is None else "known",
             "evidence_ids": [] if value is None else [evidence_id]}
            for key, value in (facts or {}).items()
        ],
        "evidence": [{"id": evidence_id, "source_name": "Synthetic evaluation source",
                      "source_type": "synthetic", "source_url": "https://example.invalid/retrieval/" + name,
                      "source_record_id": "synthetic:record:" + name,
                      "retrieved_at": "2026-10-19T00:00:00+05:00", "is_synthetic": True}],
        "is_synthetic": True,
    }


class Repository:
    """Intentionally ignores geography, letting tests verify retriever enforcement."""
    def __init__(self, places):
        self.places = places
        self.calls = []

    async def nearby(self, **kwargs):
        self.calls.append(kwargs)
        return self.places


def request(query="coffee", locale="en", **overrides):
    return {"query": query, "locale": locale, "origin": deepcopy(ORIGIN), "radius_meters": 5000,
            "candidate_limit": 10, "constraints": [], **overrides}


def search(places, query="coffee", locale="en", **overrides):
    return asyncio.run(LexicalRetriever(Repository(places)).retrieve(request(query, locale, **overrides)))


def ids(result):
    return [hit["place_id"] for hit in result["hits"]]


@pytest.mark.parametrize("query,locale", [
    ("Хочу выпить кофе", "ru"), ("Coffee nearby please", "en"), ("Маған жақын кафе керек", "kk"),
])
def test_multilingual_coffee_category_excludes_unrelated_nearer_places(query, locale):
    result = search([place("NearPark", "park", lat=51.1), place("Cafe", lat=51.11)], query, locale)
    assert ids(result) == ["synthetic:Cafe"]
    assert result["hits"][0]["score_kind"] == "lexical"
    assert result["hits"][0]["matched_fact_keys"] == []
    assert result["warnings"]
    validate_payload("RetrievalResponse", result)


@pytest.mark.parametrize("query,locale,category", [
    ("музей", "ru", "museum"), ("мұражайға барғым келеді", "kk", "museum"),
    ("a museum", "en", "museum"), ("кітапхана", "kk", "library"),
    ("галерея", "ru", "gallery"), ("art exhibition", "en", "arts_centre"),
    ("серуен", "kk", "park"), ("ботанический сад", "ru", "garden"),
    ("children playground", "en", "playground"),
])
def test_supported_categories_across_languages(query, locale, category):
    assert ids(search([place("Target", category), place("Other", "cinema")], query, locale)) == ["synthetic:Target"]


@pytest.mark.parametrize("query,locale", [
    ("Не кафе, а музей", "ru"), ("not a cafe but a museum", "en"),
    ("кафе емес, мұражай керек", "kk"), ("Кафе не нужно, хочу музей", "ru"),
])
def test_negated_category_never_becomes_positive_match(query, locale):
    result = search([place("Cafe"), place("Museum", "museum")], query, locale)
    assert ids(result) == ["synthetic:Museum"]


@pytest.mark.parametrize("query", ["coffee, a socket isn't needed", "кофе, розетка не нужна", "кафе, розетка керек емес"])
def test_negated_feature_never_becomes_matched_fact(query):
    result = search([place("Cafe", facts={"has_power_outlets": True})], query)
    assert ids(result) == ["synthetic:Cafe"]
    assert result["hits"][0]["matched_fact_keys"] == []


def test_aliases_are_source_names_and_cannot_be_invented_translations():
    named = place("Original", "attraction", facts={"name:kk": "Алтын сәуле", "name:en": "Golden Ray"})
    assert ids(search([named], "Golden Ray")) == ["synthetic:Original"]
    assert ids(search([named], "Алтын сәуле", "kk")) == ["synthetic:Original"]
    assert not ids(search([named], "несуществующий перевод", "ru"))


def test_query_feature_matches_only_evidence_backed_keys_and_boosts_preference():
    result = search([place("Unknown"), place("Powered", facts={"has_power_outlets": True})], "coffee with a power socket")
    assert ids(result)[0] == "synthetic:Powered"
    assert result["hits"][0]["matched_fact_keys"] == ["has_power_outlets"]
    assert result["hits"][1]["matched_fact_keys"] == []


def test_description_is_searchable_but_never_fact_evidence():
    result = search([place("QuietText", description="Synthetic: quiet reading room.")], "тышина тихое", "ru")
    assert ids(result) == ["synthetic:QuietText"]
    assert result["hits"][0]["matched_fact_keys"] == []


def test_missing_optional_description_is_supported_by_the_canonical_place():
    result = search([place("Cafe", description=None)])
    assert ids(result) == ["synthetic:Cafe"]


def test_conflicting_feature_mentions_do_not_claim_a_preference():
    result = search([place("Cafe", facts={"quiet": True})], "quiet coffee, quiet isn't important")
    assert ids(result) == ["synthetic:Cafe"]
    assert result["hits"][0]["matched_fact_keys"] == []


@pytest.mark.parametrize("actual,expected", [(True, 1), (1, True), ([True], [1]), ([1], [True]), (False, True)])
def test_known_static_required_uses_exact_json_equality(actual, expected):
    result = search([place("Wrong", facts={"test": actual})], constraints=[{"key": "test", "value": expected, "strength": "required"}])
    assert ids(result) == []


@pytest.mark.parametrize("actual", [None, False, True])
def test_dynamic_required_is_always_deferred_even_if_snapshot_says_false(actual):
    result = search([place("Cafe", facts={"open_at_requested_time": actual})], constraints=[
        {"key": "open_at_requested_time", "value": True, "strength": "required"},
    ])
    assert ids(result) == ["synthetic:Cafe"]
    assert result["hits"][0]["matched_fact_keys"] == []
    assert any("deferred" in warning for warning in result["warnings"])


def test_unknown_required_kept_for_final_checks_but_not_matched():
    result = search([place("Cafe")], constraints=[{"key": "indoor", "value": True, "strength": "required"}])
    assert ids(result) == ["synthetic:Cafe"]
    assert result["hits"][0]["matched_fact_keys"] == []
    assert any("deferred" in warning for warning in result["warnings"])


def test_conflicting_required_deferred_with_evidence_intact():
    target = place("Conflict", facts={"indoor": True})
    other = deepcopy(target["evidence"][0])
    other["id"] += ":other"
    target["evidence"].append(other)
    target["facts"][0].update(status="conflicting", value=None, evidence_ids=[x["id"] for x in target["evidence"]])
    result = search([target], constraints=[{"key": "indoor", "value": True, "strength": "required"}])
    assert ids(result) == ["synthetic:Conflict"]
    assert result["places"][0]["facts"][0]["status"] == "conflicting"


def test_unrelated_text_does_not_turn_every_nearby_place_into_a_match():
    result = search([place("Cafe", facts={"indoor": True})], "quantum teleportation", constraints=[
        {"key": "indoor", "value": True, "strength": "preferred"},
    ])
    assert result["hits"] == result["places"] == []
    assert any("No lexical match" in warning for warning in result["warnings"])


def test_constraint_only_generic_request_requires_known_match():
    result = search([place("Known", facts={"indoor": True}), place("Unknown")], "find a place", constraints=[
        {"key": "indoor", "value": True, "strength": "preferred"},
    ])
    assert ids(result) == ["synthetic:Known"]


def test_deterministic_ties_sort_by_distance_then_id_and_obey_candidate_limit():
    places = [place("C", lat=51.102), place("B"), place("A")]
    first = search(places, candidate_limit=2)
    assert ids(first) == ["synthetic:A", "synthetic:B"]
    assert search(list(reversed(places)), candidate_limit=2) == first


def test_strict_radius_applies_even_if_repository_returns_outside_place():
    target = place("Boundary")
    radius = distance_meters(ORIGIN, target["location"])
    assert ids(search([target], radius_meters=radius)) == ["synthetic:Boundary"]
    assert ids(search([target], radius_meters=radius - 0.000001)) == []


def test_pool_is_bounded_single_call_and_reports_possible_truncation():
    repository = Repository([place(f"Cafe{i}") for i in range(100)])
    result = asyncio.run(LexicalRetriever(repository, pool_limit=100).retrieve(request(candidate_limit=3)))
    assert len(result["places"]) == len(result["hits"]) == 3
    assert len(repository.calls) == 1 and repository.calls[0]["limit"] == 100
    assert any("bounded nearest-place pool" in warning for warning in result["warnings"])


def test_oversized_or_duplicate_repository_results_fail_closed():
    for places in ([place(str(i)) for i in range(101)], [place("Dup"), place("Dup")]):
        with pytest.raises(ValueError):
            asyncio.run(LexicalRetriever(Repository(places), pool_limit=100).retrieve(request()))


def test_request_and_source_are_immutable_and_response_is_an_independent_copy():
    source, payload = [place("Cafe", facts={"indoor": True})], request()
    before = deepcopy((source, payload))
    result = asyncio.run(LexicalRetriever(Repository(source)).retrieve(payload))
    result["places"][0]["facts"][0]["value"] = False
    assert (source, payload) == before


def test_canonical_factory_signature_and_close_does_not_close_borrowed_repository(monkeypatch):
    monkeypatch.setenv("ASTANA_RETRIEVAL_POOL_LIMIT", "100")
    retriever = create_retriever(repository=Repository([]), config={"mode": "live", "timezone": "Asia/Almaty"})
    assert isinstance(retriever, Retriever) and retriever.pool_limit == 100
    asyncio.run(retriever.aclose())
    asyncio.run(retriever.aclose())
    with pytest.raises(RuntimeError, match="closed"):
        asyncio.run(retriever.retrieve(request()))


@pytest.mark.parametrize("pool", [True, 99, 1001, 1.5, "500"])
def test_invalid_pool_configuration(pool):
    with pytest.raises(ValueError):
        LexicalRetriever(Repository([]), pool_limit=pool)


def test_invalid_input_is_rejected_before_repository_io():
    repository = Repository([])
    with pytest.raises(ContractValidationError):
        asyncio.run(LexicalRetriever(repository).retrieve(request(candidate_limit=101)))
    assert repository.calls == []


def test_timeout_and_cancellation_propagate_without_logging_raw_query():
    class SlowRepository:
        async def nearby(self, **kwargs):
            await asyncio.sleep(1)
    with pytest.raises(TimeoutError):
        asyncio.run(LexicalRetriever(SlowRepository(), timeout_seconds=0.001).retrieve(request()))
    class CancelledRepository:
        async def nearby(self, **kwargs):
            raise asyncio.CancelledError
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(LexicalRetriever(CancelledRepository()).retrieve(request()))
