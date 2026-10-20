"""Named destinations and evidence-backed dishes, entirely in process."""
import asyncio
from copy import deepcopy
import hashlib
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
    identifier = hashlib.sha256(name.encode("utf-8")).hexdigest()[:20]
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


@pytest.mark.parametrize("cuisine", ["sushi", "burger", "lagman", "korean", "ice_cream"])
def test_semantic_stage_cuisine_filters_any_explicit_source_tag(cuisine):
    confirmed = fixture("Confirmed", cuisine=cuisine)
    description_only = fixture("Description", description=f"Best {cuisine}")
    other = fixture("Other", cuisine="italian;japanese")
    result = search(Repository([description_only, other, confirmed]), "restaurant", cuisine=cuisine)
    assert ids(result) == [confirmed["id"]]
    assert "osm:cuisine" in result["hits"][0]["matched_fact_keys"]


def test_semantic_stage_named_destination_is_not_replaced_by_same_category():
    requested = fixture("Старая типография", category="museum")
    other = fixture("Другой музей", category="museum")
    result = search(Repository([requested, other]), "музей", named_place="Старая типография")
    assert ids(result) == [requested["id"]]
    assert not search(Repository([other]), "музей", named_place="Старая типография")["hits"]


def test_semantic_stage_named_venue_and_cuisine_are_both_required():
    named_without_dish = fixture("Моя кухня", cuisine="japanese")
    different_with_dish = fixture("Другая кухня", cuisine="sushi")
    result = search(Repository([named_without_dish, different_with_dish]), "restaurant",
                    named_place="Моя кухня", cuisine="sushi")
    assert not result["hits"]


def test_structured_name_is_case_normalized_complete_and_independent_of_paraphrase():
    requested = fixture("Villa Roma")
    suffix_only = fixture("Roma")
    result = search(Repository([suffix_only, requested]), "somewhere delightful", named_place="Villa Roma")
    assert ids(result) == [requested["id"]]
    assert result["hits"][0]["score"] >= 100


def test_complete_positive_source_name_does_not_admit_a_contained_shorter_destination():
    requested = fixture("Harbor Lantern Centre", category="mall")
    contained = fixture("Lantern", category="cafe")
    prefix = fixture("Harbor Lantern", category="restaurant")
    repository = Repository([contained, prefix, requested])
    result = search(repository, "First visit Harbor Lantern Centre", "en")
    assert ids(result) == [requested["id"]]
    assert not search(repository, "Harbor Lantern Centre", "en", named_place="Lantern")["hits"]


@pytest.mark.parametrize("query", [
    "First visit Harbor Lantern Centre, then Lantern",
    "First Lantern, then visit Harbor Lantern Centre",
])
def test_independent_shorter_positive_source_name_is_preserved(query):
    long = fixture("Harbor Lantern Centre", category="mall")
    short = fixture("Lantern", category="cafe")
    assert set(ids(search(Repository([short, long]), query, "en"))) == {long["id"], short["id"]}


@pytest.mark.parametrize("query,expected", [
    ("not Harbor Lantern Centre but Lantern", "short"),
    ("Harbor Lantern Centre, not Lantern", "long"),
])
def test_nested_source_names_keep_positive_and_negative_occurrences_separate(query, expected):
    long = fixture("Harbor Lantern Centre", category="mall")
    short = fixture("Lantern", category="cafe")
    assert ids(search(Repository([short, long]), query, "en")) == [{"long": long, "short": short}[expected]["id"]]


def test_equal_source_name_spans_preserve_distinct_source_records_and_alias_evidence():
    from astana_retrieval.names import NameMention, maximal_source_mentions

    found = {"long": [NameMention(0, 20, None), NameMention(0, 20, "name:en")],
             "same_name_branch": [NameMention(0, 20, None)],
             "short": [NameMention(0, 8, None), NameMention(25, 33, None)]}
    before = deepcopy(found)
    result = maximal_source_mentions(found)
    assert result["long"] == found["long"]
    assert result["same_name_branch"] == found["same_name_branch"]
    assert result["short"] == [NameMention(25, 33, None)]
    assert found == before


def test_source_name_priority_keeps_independently_requested_food_and_types_strict():
    garden = fixture("Botanical Garden", category="park")
    cafe = fixture("Garden", category="cafe", cuisine="sushi")
    repository = Repository([cafe, garden])
    assert ids(search(repository, "visit Botanical Garden", "en", categories=["park", "garden"])) == [garden["id"]]
    assert not search(repository, "Botanical Garden", "en", named_place="Botanical Garden", categories=["restaurant"])["hits"]
    assert not search(repository, "Botanical Garden", "en", named_place="Botanical Garden", cuisine="sushi")["hits"]
    assert ids(search(repository, "Botanical Garden and sushi", "en", categories=["cafe"], cuisine="sushi")) == [cafe["id"]]


def test_semantic_place_type_cannot_match_incidental_description_word():
    cafe = fixture("Coffee", category="cafe", description="Next to a postcard shop and swimming pool")
    assert not search(Repository([cafe]), "postcard shop", categories=["gift_shop"])["hits"]
    assert not search(Repository([cafe]), "swimming pool", categories=["swimming_pool"])["hits"]


def test_any_source_category_establishes_relevance_without_a_lexicon_entry():
    pool = fixture("Aquatics Centre", category="swimming_pool")
    result = search(Repository([pool]), "go swimming", categories=["swimming_pool"])
    assert ids(result) == [pool["id"]]
    assert result["hits"][0]["score"] > 0


def test_structured_named_destination_accepts_case_endings_without_shorter_alias_substitution():
    requested = fixture("Астана Опера", category="theatre")
    unrelated = fixture("Опера", category="theatre")
    result = search(Repository([unrelated, requested]), "театр", named_place="Астана Оперы")
    assert ids(result) == [requested["id"]]


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
    references = [target["evidence"][0]["id"], other["id"]] if evidence else []
    target["facts"][0].update(status=status, value=value, evidence_ids=references)
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
