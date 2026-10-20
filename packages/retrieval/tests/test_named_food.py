"""Named destinations and evidence-backed dishes, entirely in process."""
import asyncio
from copy import deepcopy
from pathlib import Path

import pytest

from astana_city_data import SnapshotRepository
from astana_contracts import ContractValidationError
from astana_retrieval import LexicalRetriever


GARDEN = "osm:way/1196402246"
GARDEN_ORIGIN = {"lat": 51.1061652, "lon": 71.4165705}
SNAPSHOT = Path(__file__).parents[3] / "data" / "samples" / "astana-osm.json"


class Repository:
    def __init__(self, places):
        self.places = places

    async def nearby(self, **kwargs):
        return deepcopy(self.places)


def fixture(name, category="restaurant", cuisine=None, description=None):
    identifier = name.replace(" ", "-")
    evidence = {"id": "synthetic:evidence:" + identifier, "source_name": "Synthetic food regression",
                "source_type": "synthetic", "source_url": "https://example.invalid/food",
                "source_record_id": "synthetic:record:" + identifier,
                "retrieved_at": "2026-10-20T00:00:00+05:00", "is_synthetic": True}
    return {"id": "synthetic:" + identifier, "name": name, "categories": [category], "location": GARDEN_ORIGIN,
            "description": description, "facts": [] if cuisine is None else [
                {"key": "osm:cuisine", "status": "known", "value": cuisine, "evidence_ids": [evidence["id"]]},
            ], "evidence": [evidence], "is_synthetic": True}


def search(repository, query, locale="ru", **overrides):
    return asyncio.run(LexicalRetriever(repository).retrieve({
        "query": query, "locale": locale, "origin": GARDEN_ORIGIN, "radius_meters": 30000,
        "candidate_limit": 100, "constraints": [], **overrides,
    }))


def ids(result):
    return [hit["place_id"] for hit in result["hits"]]


@pytest.mark.parametrize("query,locale", [
    ("хочу в ботанический сад сходить", "ru"),
    ("хочу погулять в ботаническом саду", "ru"),
    ("ботанического сада", "ru"),
    ("Ботаникалық бақ", "kk"),
    ("Ботаникалық баққа барғым келеді", "kk"),
    ("I want to visit Botanical Garden", "en"),
])
def test_actual_snapshot_botanical_alias_is_one_named_destination(query, locale):
    result = search(SnapshotRepository(SNAPSHOT), query, locale)
    assert ids(result) == [GARDEN]
    assert result["places"][0]["name"] == "Ботаникалық бақ"
    assert result["places"][0]["categories"] == ["park"]
    assert result["hits"][0]["score"] >= 100
    assert any(key.startswith("name:") for key in result["hits"][0]["matched_fact_keys"])


@pytest.mark.parametrize("query,locale", [
    ("пицца", "ru"), ("хочу пицу покушать", "ru"), ("пицы", "ru"), ("пиццу", "ru"),
    ("пиццаны жегім келеді", "kk"), ("pizza", "en"), ("eat pizza", "en"),
    ("пиццерию", "ru"), ("пиццерии", "ru"), ("пиццерией", "ru"), ("pizzeria", "en"),
])
def test_actual_snapshot_pizza_requires_explicit_source_cuisine(query, locale):
    result = search(SnapshotRepository(SNAPSHOT), query, locale)
    assert len(result["places"]) == 12
    assert "osm:node/5857276421" in ids(result)  # Астана Кузин, near the botanical garden.
    assert "osm:node/4713010890" in ids(result)  # Only italian_pizza, not plain pizza.
    assert "osm:node/3215326163" in ids(result)  # Comma-separated cuisine tags.
    for place, hit in zip(result["places"], result["hits"], strict=True):
        assert set(place["categories"]).intersection({"cafe", "restaurant"})
        cuisine = next(fact for fact in place["facts"] if fact["key"] == "osm:cuisine")
        assert cuisine["status"] == "known" and cuisine["evidence_ids"]
        assert "osm:cuisine" in hit["matched_fact_keys"]


def test_original_compound_preserves_named_botanical_destination_and_only_confirmed_food():
    result = search(SnapshotRepository(SNAPSHOT), "хочу в ботанический сад сходить и пицу покушать")
    assert ids(result)[0] == GARDEN
    assert len(result["places"]) == 13
    assert all(place["id"] == GARDEN or set(place["categories"]).intersection({"cafe", "restaurant"})
               for place in result["places"])
    assert all("osm:cuisine" in hit["matched_fact_keys"] for hit in result["hits"][1:])


@pytest.mark.parametrize("query,locale", [
    ("хочу в ботанический сад и в пиццерию", "ru"),
    ("сначала пиццерия, затем ботанический сад", "ru"),
    ("Botanical Garden and a pizzeria", "en"),
])
def test_actual_snapshot_named_garden_and_pizzeria_keep_confirmed_food(query, locale):
    result = search(SnapshotRepository(SNAPSHOT), query, locale)
    assert ids(result)[0] == GARDEN
    assert len(result["places"]) == 13
    assert all("osm:cuisine" in hit["matched_fact_keys"] for hit in result["hits"][1:])


@pytest.mark.parametrize("verb", ["перекусить", "пообедать", "поужинать"])
def test_actual_snapshot_meal_verbs_select_food_and_keep_named_garden(verb):
    result = search(SnapshotRepository(SNAPSHOT), verb)
    assert result["places"]
    assert all("restaurant" in place["categories"] for place in result["places"])
    compound = search(SnapshotRepository(SNAPSHOT), "ботанический сад и " + verb)
    assert ids(compound)[0] == GARDEN
    assert len(compound["places"]) > 1
    assert all(place["id"] == GARDEN or "restaurant" in place["categories"] for place in compound["places"])


def test_generic_green_destination_and_dish_keep_both_intents_without_arbitrary_cafes():
    garden, pizza, unknown = fixture("Green", "garden"), fixture("Known", "cafe", "pizza"), fixture("Unknown", "cafe")
    assert set(ids(search(Repository([garden, pizza, unknown]), "garden and eat pizza", "en"))) == {
        garden["id"], pizza["id"],
    }


@pytest.mark.parametrize("cuisine", [
    "pizza", "italian_pizza", "pasta; pizza ;sushi", "regional,pizza,asian", ["italian", "pizza"], ["italian_pizza"],
])
def test_only_exact_explicit_cuisine_tokens_establish_pizza(cuisine):
    target = fixture("Known", "cafe", cuisine)
    decoys = [fixture("Pizza"), fixture("Pizza Palace", description="We offer pizza."),
              fixture("Italian", cuisine="italian"), fixture("Almost", cuisine="not_pizza;pizzas")]
    assert ids(search(Repository([*decoys, target]), "pizza", "en")) == [target["id"]]


@pytest.mark.parametrize("status,value,evidence", [
    ("unknown", None, []),
    ("conflicting", None, ["synthetic:evidence:Unconfirmed", "synthetic:evidence:Other"]),
])
def test_unconfirmed_cuisine_is_never_a_pizza_hit(status, value, evidence):
    target = fixture("Unconfirmed", cuisine="pizza")
    other = deepcopy(target["evidence"][0])
    other["id"] = "synthetic:evidence:Other"
    target["evidence"].append(other)
    target["facts"][0].update(status=status, value=value, evidence_ids=evidence)
    assert ids(search(Repository([target]), "pizza", "en")) == []


def test_unevidenced_known_cuisine_is_rejected_before_candidate_selection():
    target = fixture("Unconfirmed", cuisine="pizza")
    target["facts"][0]["evidence_ids"] = []
    with pytest.raises(ContractValidationError):
        search(Repository([target]), "pizza", "en")


def test_named_pizzeria_remains_literal_without_inventing_its_menu():
    target = fixture("Pizza Palace")
    assert ids(search(Repository([target]), "Pizza Palace", "en")) == [target["id"]]
    assert ids(search(Repository([target]), "Pizza Palace with pizza", "en")) == []


@pytest.mark.parametrize("query,locale", [
    ("хочу в ботанический сад, но пиццу не хочу", "ru"),
    ("Botanical Garden, no pizza", "en"),
    ("Ботаникалық бақ, пицца керек емес", "kk"),
])
def test_negated_dish_does_not_broaden_a_named_destination(query, locale):
    assert ids(search(SnapshotRepository(SNAPSHOT), query, locale)) == [GARDEN]


@pytest.mark.parametrize("query,locale", [
    ("хочу погулять, не хочу в ботанический сад", "ru"),
    ("a walk, not Botanical Garden", "en"),
    ("серуен, Ботаникалық баққа барғым келмейді", "kk"),
])
def test_negated_botanical_name_excludes_exact_destination_even_when_category_is_park(query, locale):
    result = search(SnapshotRepository(SNAPSHOT), query, locale)
    assert result["places"]
    assert GARDEN not in ids(result)


def test_negated_pizza_excludes_confirmed_cuisine_but_does_not_guess_from_names():
    pizza, unknown = fixture("Known", "cafe", "pizza"), fixture("Pizza Palace", "cafe")
    assert ids(search(Repository([pizza, unknown]), "coffee, not pizza", "en")) == [unknown["id"]]


def test_botanical_looking_description_never_becomes_a_named_alias():
    decoy = fixture("Unrelated", "garden", description="Botanical garden collection")
    target = fixture("Botanical Garden", "park")
    assert ids(search(Repository([decoy, target]), "visit Botanical Garden", "en")) == [target["id"]]


def test_named_botanical_destination_still_obeys_required_constraints():
    result = search(SnapshotRepository(SNAPSHOT), "ботанический сад", constraints=[
        {"key": "name:ru", "value": "Other destination", "strength": "required"},
    ])
    assert ids(result) == []
