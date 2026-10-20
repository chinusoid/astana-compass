"""Named garden and food journeys with local sources and synthetic routing only."""

from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

import pytest

from astana_city_data import SnapshotRepository
from astana_contracts import validate_payload
from astana_recommender import DefaultRecommendationService
from astana_recommender.journey import journey_stages
from astana_retrieval import LexicalRetriever

from packages.recommender.tests.test_service import Context, Repository, constraint, fact, place, request


ROOT = Path(__file__).resolve().parents[3]
BOTANICAL_ID = "osm:way/1196402246"
ACTUAL_QUERY = "хочу в ботанический сад сходить и пицу покушать"
NOW = datetime(2026, 10, 20, 7, tzinfo=timezone.utc)


class RecordingRetriever:
    def __init__(self, repository):
        self.inner = LexicalRetriever(repository, pool_limit=1000)
        self.requests = []

    async def retrieve(self, payload):
        self.requests.append(deepcopy(payload))
        return await self.inner.retrieve(payload)


def setup_service(repository):
    context = Context()
    retriever = RecordingRetriever(repository)
    service = DefaultRecommendationService(repository, retriever, context, clock=lambda: NOW)
    return service, retriever, context


@pytest.fixture(scope="module")
def catalog():
    repository = SnapshotRepository(ROOT / "data" / "samples" / "astana-osm.json", clock=lambda: NOW)
    garden = asyncio.run(repository.get(BOTANICAL_ID))
    assert garden is not None, "The checked-in botanical garden source record must load."
    return repository


def is_source_pizza(venue):
    if not {"cafe", "restaurant"}.intersection(venue["categories"]):
        return False
    evidence_ids = {item["id"] for item in venue["evidence"]}
    for item in venue["facts"]:
        if (item["key"] not in {"osm:cuisine", "cuisine"} or item["status"] != "known"
                or not item["evidence_ids"] or not set(item["evidence_ids"]).issubset(evidence_ids)):
            continue
        values = item["value"] if isinstance(item["value"], list) else [item["value"]]
        cuisines = {part.strip().casefold() for value in values if isinstance(value, str)
                    for part in value.replace(",", ";").split(";")}
        if cuisines.intersection({"pizza", "italian_pizza"}):
            return True
    return False


def ordered_places(response):
    lookup = {venue["id"]: venue for venue in response["places"]}
    return [lookup[item["place_id"]] for item in response["recommendations"]]


@pytest.mark.parametrize(("query", "locale"), [
    (ACTUAL_QUERY, "ru"),
    ("Хочу поесть пиццу и сходить в ботанический сад", "ru"),
    ("Botanical Garden and pizza", "en"),
    ("Pizza and Botanical Garden", "en"),
    ("Botanical Garden, pizza", "en"),
    ("Ботаникалық бақ және пицца", "kk"),
    ("Пицца және Ботаникалық бақ", "kk"),
])
def test_local_catalog_compound_pizza_keeps_both_stops_in_food_then_garden_order(catalog, query, locale):
    async def scenario():
        service, retriever, context = setup_service(catalog)
        response = await service.recommend(request(query=query, locale=locale))
        validate_payload("RecommendationResponse", response)
        selected = ordered_places(response)
        assert len(selected) == 2
        assert is_source_pizza(selected[0])
        assert selected[1]["id"] == BOTANICAL_ID
        assert len({venue["id"] for venue in selected}) == 2
        assert [item["rank"] for item in response["recommendations"]] == [1, 2]
        assert len(retriever.requests) == 2
        assert len(context.routes) == 2

    asyncio.run(scenario())


@pytest.mark.parametrize(("query", "locale"), [
    ("Ботанический сад и поесть", "ru"),
    ("Botanical Garden and coffee", "en"),
    ("Ботаникалық бақ және тамақ", "kk"),
])
def test_other_positive_food_wishes_keep_named_garden_as_second_stop(catalog, query, locale):
    async def scenario():
        service, _, _ = setup_service(catalog)
        selected = ordered_places(await service.recommend(request(query=query, locale=locale)))
        assert len(selected) == 2
        assert {"cafe", "restaurant", "coffee_shop"}.intersection(selected[0]["categories"])
        assert selected[1]["id"] == BOTANICAL_ID

    asyncio.run(scenario())


@pytest.mark.parametrize(("query", "locale"), [
    ("Сначала Ботанический сад, потом пицца", "ru"),
    ("First Botanical Garden then pizza", "en"),
    ("Алдымен Ботаникалық бақ, сосын пицца", "kk"),
])
def test_explicit_reverse_order_remains_garden_then_pizza(catalog, query, locale):
    async def scenario():
        service, _, _ = setup_service(catalog)
        selected = ordered_places(await service.recommend(request(query=query, locale=locale)))
        assert len(selected) == 2
        assert selected[0]["id"] == BOTANICAL_ID
        assert is_source_pizza(selected[1])

    asyncio.run(scenario())


@pytest.mark.parametrize(("query", "locale"), [
    ("Ботанический сад", "ru"),
    ("Botanical Garden", "en"),
    ("Ботаникалық бақ", "kk"),
])
def test_exact_single_named_garden_does_not_add_food_or_another_park(catalog, query, locale):
    async def scenario():
        service, retriever, context = setup_service(catalog)
        response = await service.recommend(request(query=query, locale=locale))
        assert [item["place_id"] for item in response["recommendations"]] == [BOTANICAL_ID]
        assert len(retriever.requests) == 1
        assert len(context.routes) == 1

    asyncio.run(scenario())


@pytest.mark.parametrize("query", [
    "Парки и кофе", "Coffee and parks", "Саябақ және кафе",
    "coffee near Botanical Garden", "кафе рядом с Ботаническим садом",
    "Ботаникалық бақ жанындағы кафе", "Ботанический сад и без кафе",
    "Botanical Garden and no food", "Ботаникалық бақ және тамақ емес",
])
def test_generic_mixed_spatial_and_negated_food_queries_do_not_invent_a_journey(query):
    assert journey_stages(query) == ()


@pytest.mark.parametrize("return_to_origin", [False, True])
def test_selected_two_stops_build_one_connected_route_with_optional_return(catalog, return_to_origin):
    async def scenario():
        service, _, context = setup_service(catalog)
        body = request(query=ACTUAL_QUERY, return_to_origin=return_to_origin)
        recommendations = await service.recommend(body)
        selected = ordered_places(recommendations)
        assert len(selected) == 2
        trip = await service.build_itinerary({**body, "place_ids": [venue["id"] for venue in selected]})
        validate_payload("ItineraryResponse", trip)
        assert [stop["place_id"] for stop in trip["stops"]] == [venue["id"] for venue in selected]
        assert trip["route"]["includes_return"] is return_to_origin
        assert context.routes[-1]["destinations"] == [venue["location"] for venue in selected]
        points = [body["origin"], *(venue["location"] for venue in selected)]
        if return_to_origin:
            points.append(body["origin"])
        assert trip["route"]["geometry"]["coordinates"] == [[point["lon"], point["lat"]] for point in points]
        assert trip["total_duration_seconds"] == (
            trip["route"]["duration_seconds"] + sum(stop["visit_duration_seconds"] for stop in trip["stops"])
        )
        assert len(context.routes) <= 3

    asyncio.run(scenario())


def synthetic_garden():
    garden = place(7, facts=[fact("name:en", "Botanical Garden"), fact("name:kk", "Ботаникалық бақ")])
    garden["name"] = "Ботанический сад"
    garden["categories"] = ["park"]
    return garden


def synthetic_food(index=1, *, cuisine="pizza", status="known", category="restaurant"):
    venue = place(index, facts=[] if cuisine is None else [fact("osm:cuisine", cuisine, status)])
    venue["name"] = "SYNTHETIC Pizza venue"
    venue["categories"] = [category]
    venue["description"] = "Synthetic fixture mentions pizza; text alone does not establish cuisine."
    return venue


@pytest.mark.parametrize("missing", ["pizza", "garden"])
def test_missing_source_destination_is_reported_without_unrelated_substitution(missing):
    async def scenario():
        garden, pizza, unrelated_park = synthetic_garden(), synthetic_food(), place(9)
        unrelated_park["categories"] = ["park"]
        unsupported_food = synthetic_food(2, cuisine=None)
        venues = [garden, unsupported_food, unrelated_park] if missing == "pizza" else [pizza, unrelated_park]
        service, _, context = setup_service(Repository(venues))
        response = await service.recommend(request(query="Botanical Garden and pizza"))
        expected = garden if missing == "pizza" else pizza
        assert [item["place_id"] for item in response["recommendations"]] == [expected["id"]]
        assert response["status"] == "partial"
        assert f"stage {1 if missing == 'pizza' else 2}" in " ".join(response["warnings"]).lower()
        assert len(context.routes) == 1

    asyncio.run(scenario())


@pytest.mark.parametrize(("cuisine", "status", "category"), [
    (None, "known", "restaurant"),
    ("burger", "known", "restaurant"),
    ("pizza", "unknown", "restaurant"),
    ("pizza", "known", "park"),
])
def test_pizza_name_or_unverified_cuisine_cannot_fill_the_food_stage(cuisine, status, category):
    async def scenario():
        garden, unsupported = synthetic_garden(), synthetic_food(cuisine=cuisine, status=status, category=category)
        unsupported["name"] = "Dodo Pizza"
        service, _, _ = setup_service(Repository([unsupported, garden]))
        response = await service.recommend(request(query="Botanical Garden and pizza"))
        assert [item["place_id"] for item in response["recommendations"]] == [garden["id"]]
        assert response["status"] == "partial"

    asyncio.run(scenario())


@pytest.mark.parametrize("cuisine", ["pizza", "italian_pizza", "italian;pizza", ["italian", "pizza"]])
def test_supported_string_and_list_cuisine_values_can_fill_the_pizza_stage(cuisine):
    async def scenario():
        garden, pizza = synthetic_garden(), synthetic_food(cuisine=cuisine)
        service, _, _ = setup_service(Repository([pizza, garden]))
        response = await service.recommend(request(query="Botanical Garden and pizza"))
        assert [item["place_id"] for item in response["recommendations"]] == [pizza["id"], garden["id"]]

    asyncio.run(scenario())


@pytest.mark.parametrize("alias_key", ["osm:alt_name", "osm:official_name:en", "wikidata:aliases:en"])
def test_known_source_alias_can_establish_the_named_garden_destination(alias_key):
    async def scenario():
        garden, pizza = synthetic_garden(), synthetic_food()
        garden["name"] = "SYNTHETIC source garden"
        garden["facts"] = [fact(alias_key, "Botanical Garden")]
        service, _, _ = setup_service(Repository([pizza, garden]))
        response = await service.recommend(request(query="Botanical Garden and pizza"))
        assert [item["place_id"] for item in response["recommendations"]] == [pizza["id"], garden["id"]]

    asyncio.run(scenario())


def test_unknown_source_alias_does_not_establish_the_named_garden_destination():
    async def scenario():
        garden, pizza = synthetic_garden(), synthetic_food()
        garden["name"] = "SYNTHETIC generic park"
        garden["facts"] = [fact("osm:alt_name", "Botanical Garden", "unknown")]
        garden["description"] = "Synthetic description mentioning Botanical Garden is not a source name."
        service, _, _ = setup_service(Repository([pizza, garden]))
        response = await service.recommend(request(query="Botanical Garden and pizza"))
        assert [item["place_id"] for item in response["recommendations"]] == [pizza["id"]]
        assert response["status"] == "partial"

    asyncio.run(scenario())


def test_food_choice_accounts_for_the_onward_named_destination():
    async def scenario():
        garden, near_start, on_way_to_garden = synthetic_garden(), synthetic_food(), synthetic_food(2)
        garden["location"] = {"lat": 51.12, "lon": 71.42}
        near_start["name"] = "SYNTHETIC Western Pizza"
        near_start["location"] = {"lat": 51.0905, "lon": 71.45}
        on_way_to_garden["name"] = "SYNTHETIC Northern Pizza"
        on_way_to_garden["location"] = {"lat": 51.11, "lon": 71.42}
        service, _, context = setup_service(Repository([near_start, on_way_to_garden, garden]))
        response = await service.recommend(request(query="Botanical Garden and pizza"))
        assert [item["place_id"] for item in response["recommendations"]] == [on_way_to_garden["id"], garden["id"]]
        assert len(context.routes) == 2

    asyncio.run(scenario())


def test_required_accessibility_and_short_time_budget_survive_compound_stage_requests():
    async def scenario():
        garden, pizza, inaccessible = synthetic_garden(), synthetic_food(), synthetic_food(2)
        for venue in (garden, pizza):
            venue["facts"].append(fact("wheelchair_accessible", True))
        inaccessible["facts"].append(fact("wheelchair_accessible", False))
        service, retriever, context = setup_service(Repository([inaccessible, pizza, garden]))
        required = constraint("wheelchair_accessible", True)
        body = request(query="Botanical Garden and pizza", constraints=[required], available_seconds=60)
        response = await service.recommend(body)
        assert [item["place_id"] for item in response["recommendations"]] == [pizza["id"], garden["id"]]
        assert response["status"] == "partial"
        assert all(payload["constraints"] == [required] for payload in retriever.requests)
        assert all(payload["available_seconds"] == 60 for payload in context.context_requests)
        assert all(item["total_duration_seconds"] > 60 for item in response["recommendations"])
        assert all(item["constraint_evaluations"][0]["outcome"] == "satisfied"
                   for item in response["recommendations"])
        trip = await service.build_itinerary({**body, "place_ids": [pizza["id"], garden["id"]]})
        assert trip["status"] == "partial"
        assert trip["request"]["available_seconds"] == 60
        assert trip["total_duration_seconds"] > 60
        assert all(stop["constraint_evaluations"][0]["outcome"] == "satisfied" for stop in trip["stops"])

    asyncio.run(scenario())
