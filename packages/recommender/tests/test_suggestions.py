"""Optional local ideas preserve the completed requested route; no live I/O."""

import asyncio
from copy import deepcopy
from datetime import datetime, timedelta
import json
from pathlib import Path
import unittest

from astana_contracts import validate_payload
from astana_recommender import DefaultRecommendationService
from astana_recommender.suggestions import CATEGORIES, QUERY, safe_query, select_suggestions

from packages.recommender.tests.test_service import (
    Context, Generator, Planner, Repository, constraint, fact, place, planned_stage, request,
)


def venue(index, category, *, facts=None, name=None, latitude=None):
    result = place(index, facts=facts)
    result["categories"] = [category]
    if name is not None:
        result["name"] = name
    if latitude is not None:
        result["location"]["lat"] = latitude
    return result


class LocalRetriever:
    def __init__(self, mapping, extras):
        self.mapping, self.extras = deepcopy(mapping), deepcopy(extras)
        self.requests = []
        self.extra_error = None
        self.extra_delay = 0
        self.extra_transform = None
        self.started = asyncio.Event()
        self.cancelled = False

    async def retrieve(self, payload):
        self.requests.append(deepcopy(payload))
        if payload["query"] == QUERY:
            self.started.set()
            try:
                if self.extra_delay:
                    await asyncio.sleep(self.extra_delay)
            except asyncio.CancelledError:
                self.cancelled = True
                raise
            if self.extra_error:
                raise self.extra_error
            places = deepcopy(self.extras)
        else:
            places = deepcopy(self.mapping.get(payload["query"], []))
        result = {
            "places": places,
            "hits": [{"place_id": item["id"], "score": float(len(places) - index),
                      "score_kind": "deterministic", "matched_fact_keys": []}
                     for index, item in enumerate(places)],
            "strategy": "synthetic_test", "warnings": [],
        }
        return self.extra_transform(result) if payload["query"] == QUERY and self.extra_transform else result


def setup(extras=None, *, core=None, stages=None, **options):
    core = core or [venue(1, "cafe"), venue(2, "park")]
    stages = stages if stages is not None else [planned_stage("coffee", kind="meal", categories=["cafe"]),
                                               planned_stage("park", categories=["park"])]
    mapping = {stage["search_query"]: [item] for stage, item in zip(stages, core)}
    retriever = LocalRetriever(mapping, extras or [])
    context, generator, planner = Context(), Generator(), Planner(stages)
    service = DefaultRecommendationService(Repository(core), retriever, context, generator, planner=planner, **options)
    return service, retriever, context, generator, planner


class SuggestionTests(unittest.IsolatedAsyncioTestCase):
    async def test_source_variety_is_optional_and_never_changes_the_core_route(self):
        extras = [venue(3, "gallery"), venue(4, "artwork"), venue(5, "museum"), venue(6, "theatre")]
        service, retrieval, context, generator, planner = setup(extras)
        baseline, _, baseline_context, baseline_generator, _ = setup()
        actual = await service.recommend(request(query="coffee then park"))
        expected = await baseline.recommend(request(query="coffee then park"))
        self.assertEqual(actual["recommendations"], expected["recommendations"])
        self.assertEqual(actual["journey_plan"], expected["journey_plan"])
        self.assertEqual(actual["status"], expected["status"])
        self.assertEqual([item["place_id"] for item in actual["suggestions"]], [extras[0]["id"], extras[2]["id"]])
        self.assertEqual(actual["places"][:2], expected["places"])
        self.assertEqual(len(context.routes), len(baseline_context.routes))
        self.assertEqual(len(context.context_requests), 1)
        self.assertEqual(generator.calls, baseline_generator.calls)
        self.assertEqual(len(planner.calls), 1)
        self.assertEqual(len(retrieval.requests), 3)
        payload = retrieval.requests[-1]
        self.assertEqual(payload["candidate_limit"], 12)
        self.assertEqual(payload["radius_meters"], 1_000)
        self.assertEqual(payload["categories"], list(CATEGORIES))
        self.assertEqual(payload["origin"], actual["places"][1]["location"])
        self.assertTrue(all("Optional" in item["why"] and "straight line" in item["why"] for item in actual["suggestions"]))
        validate_payload("RecommendationResponse", actual)

    async def test_core_ids_names_close_positions_and_repeated_source_families_are_excluded(self):
        core = [venue(1, "cafe"), venue(2, "park")]
        duplicate_id = deepcopy(core[0])
        duplicate_id["categories"] = ["museum"]
        extras = [duplicate_id, venue(3, "museum", name=core[1]["name"]),
                  venue(4, "attraction", latitude=core[1]["location"]["lat"] + 0.0001),
                  venue(5, "park"), venue(6, "cafe"), venue(7, "gallery"), venue(8, "artwork")]
        service, _, _, _, _ = setup(extras, core=core)
        result = await service.recommend(request(query="coffee then park"))
        self.assertEqual([item["place_id"] for item in result["suggestions"]], [extras[-2]["id"]])

    async def test_required_facts_fail_closed_and_request_time_snapshot_facts_stay_unknown(self):
        for required in ("indoor", "open_at_requested_time", "weather_suitable"):
            with self.subTest(required=required):
                core = [venue(1, "cafe", facts=[fact(required)]), venue(2, "park", facts=[fact(required)])]
                extras = [venue(3, "museum", facts=[fact(required, status="unknown")]),
                          venue(4, "gallery", facts=[fact(required, False)]),
                          venue(5, "theatre", facts=[fact(required, status="conflicting")]),
                          venue(6, "attraction", facts=[fact(required)])]
                service, retrieval, _, _, _ = setup(extras, core=core)
                result = await service.recommend(request(query="coffee then park", constraints=[constraint(required)]))
                self.assertEqual(retrieval.requests[-1]["constraints"], [constraint(required)])
                expected = [extras[-1]["id"]] if required == "indoor" else []
                self.assertEqual([item["place_id"] for item in result["suggestions"]], expected)
                if expected:
                    self.assertEqual(result["suggestions"][0]["constraint_evaluations"][0]["outcome"], "satisfied")

    async def test_preferred_dynamic_fact_does_not_become_current_confirmation(self):
        extra = venue(3, "museum", facts=[fact("open_at_requested_time")])
        core = [venue(1, "cafe", facts=[fact("open_at_requested_time")]),
                venue(2, "park", facts=[fact("open_at_requested_time")])]
        service, _, _, _, _ = setup([extra], core=core)
        result = await service.recommend(request(query="coffee then park", constraints=[constraint("open_at_requested_time", strength="preferred")]))
        suggestion = result["suggestions"][0]
        self.assertEqual(suggestion["constraint_evaluations"][0]["outcome"], "unknown")
        self.assertEqual(result["places"][-1]["facts"][0]["status"], "unknown")
        self.assertEqual(extra["facts"][0]["status"], "known")

    async def test_named_category_food_and_postfix_exclusions_skip_optional_lookup(self):
        for suffix in ("not Botanical Garden", "no parks", "without sushi", "не парки", "без музеев", "won't visit galleries",
                       "Don't visit a gallery", "мұражай керек емес", "Ботаникалық баққа барғым келмейді",
                       "пицца жемеймін", "only those stops"):
            with self.subTest(suffix=suffix):
                service, retrieval, _, _, _ = setup([venue(3, "museum")])
                result = await service.recommend(request(query="coffee then park. " + suffix))
                self.assertEqual(len(result["recommendations"]), 2)
                self.assertEqual(result["suggestions"], [])
                self.assertFalse(any(item["query"] == QUERY for item in retrieval.requests))

    async def test_empty_unresolved_missing_and_overflow_plans_do_not_get_extra_ideas(self):
        cases = [([], []), ([planned_stage("coffee"), planned_stage("impossible", kind="unresolved")], [venue(1, "cafe")]),
                 ([planned_stage("coffee"), planned_stage("unknown")], [venue(1, "cafe")]),
                 ([planned_stage(f"goal{index}") for index in range(8)], [venue(index + 1, "museum") for index in range(8)])]
        for stages, core in cases:
            with self.subTest(stages=stages):
                service, retrieval, _, _, _ = setup([venue(30, "gallery")], stages=stages, core=core or None)
                result = await service.recommend(request(query=" then ".join(stage["source_quote"] for stage in stages) or "an interesting walk"))
                self.assertEqual(result["suggestions"], [])
                self.assertFalse(any(item["query"] == QUERY for item in retrieval.requests))

    async def test_failure_or_malformed_optional_result_cannot_change_core_success(self):
        for mode in ("error", "malformed", "duplicate", "over_limit"):
            with self.subTest(mode=mode):
                service, retrieval, context, _, _ = setup([venue(3, "museum")])
                if mode == "error":
                    retrieval.extra_error = RuntimeError("unsafe provider detail")
                elif mode == "malformed":
                    retrieval.extra_transform = lambda value: {**value, "places": [{}]}
                elif mode == "duplicate":
                    retrieval.extra_transform = lambda value: {**value, "places": value["places"] * 2}
                else:
                    retrieval.extras = [venue(index, "museum") for index in range(3, 16)]
                result = await service.recommend(request(query="coffee then park"))
                self.assertEqual(result["status"], "matched")
                self.assertEqual(len(result["recommendations"]), 2)
                self.assertEqual(result["suggestions"], [])
                self.assertEqual(len(context.routes), 2)
                self.assertNotIn("unsafe", " ".join(result["warnings"]))

    async def test_optional_timeout_keeps_core_success_and_cancels_search(self):
        service, retrieval, context, _, _ = setup([venue(3, "museum")], timeout_seconds=0.08)
        retrieval.extra_delay = 1
        result = await service.recommend(request(query="coffee then park"))
        self.assertEqual(result["status"], "matched")
        self.assertEqual(result["suggestions"], [])
        self.assertTrue(retrieval.cancelled)
        self.assertEqual(len(context.routes), 2)

    async def test_soft_time_and_preference_warnings_do_not_hide_optional_ideas_for_complete_core(self):
        for mode in ("over_budget", "preferred_unknown"):
            with self.subTest(mode=mode):
                service, retrieval, context, _, _ = setup([venue(3, "museum")])
                if mode == "over_budget":
                    context.duration_seconds = 10_000
                constraints = [constraint("quiet", strength="preferred")] if mode == "preferred_unknown" else []
                result = await service.recommend(request(query="coffee then park", constraints=constraints))
                self.assertEqual(result["status"], "partial")
                self.assertEqual(len(result["recommendations"]), 2)
                self.assertEqual([item["place_id"] for item in result["suggestions"]], ["synthetic:place:3"])
                self.assertTrue(any(item["query"] == QUERY for item in retrieval.requests))

    async def test_exhausted_spare_budget_starts_no_extra_lookup(self):
        class Clock:
            value = 0

            def __call__(self):
                return self.value

        clock = Clock()
        service, retrieval, context, _, _ = setup([venue(3, "museum")], request_budget_seconds=1, budget_clock=clock)
        original = context.estimate_route

        async def route(**kwargs):
            result = await original(**kwargs)
            clock.value = 0.6
            return result

        context.estimate_route = route
        result = await service.recommend(request(query="coffee then park"))
        self.assertEqual(result["suggestions"], [])
        self.assertEqual(result["status"], "matched")
        self.assertFalse(any(item["query"] == QUERY for item in retrieval.requests))

    async def test_external_cancellation_is_not_swallowed_by_optional_search(self):
        service, retrieval, _, _, _ = setup([venue(3, "museum")])
        retrieval.extra_delay = 10
        task = asyncio.create_task(service.recommend(request(query="coffee then park")))
        await retrieval.started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(retrieval.cancelled)

    async def test_overlapping_requests_keep_optional_anchors_and_output_isolated(self):
        core = [venue(1, "cafe"), venue(2, "park"), venue(30, "cafe"), venue(31, "park")]
        stages = [planned_stage("coffee", kind="meal", categories=["cafe"]), planned_stage("park", categories=["park"])]
        service, retrieval, _, _, _ = setup([venue(3, "museum"), venue(32, "gallery")], core=core[:2], stages=stages)
        retrieval.mapping.update({"coffee2": [core[2]], "park2": [core[3]]})
        base_retrieve = retrieval.retrieve

        async def retrieve(payload):
            result = await base_retrieve(payload)
            if payload["query"] == "coffee":
                await asyncio.sleep(0.01)
            return result

        retrieval.retrieve = retrieve

        class ConcurrentPlanner:
            async def plan(self, query, locale):
                chosen = stages if "coffee2" not in query else [planned_stage("coffee2", kind="meal", categories=["cafe"]), planned_stage("park2", categories=["park"])]
                return {"provider": "openai", "stages": chosen, "order": "explicit", "clarification_questions": [], "warnings": []}

        service.planner = ConcurrentPlanner()
        left, right = await asyncio.gather(service.recommend(request(query="coffee then park")),
                                           service.recommend(request(query="coffee2 then park2")))
        self.assertEqual([item["place_id"] for item in left["suggestions"]], ["synthetic:place:3"])
        self.assertEqual([item["place_id"] for item in right["suggestions"]], ["synthetic:place:32"])
        self.assertEqual({item["origin"]["lat"] for item in retrieval.requests if item["query"] == QUERY},
                         {core[1]["location"]["lat"], core[3]["location"]["lat"]})

    async def test_total_union_is_six_and_optional_ideas_are_localized(self):
        core = [venue(index, "park") for index in range(1, 6)]
        stages = [planned_stage(f"stop{index}", categories=["park"]) for index in range(1, 6)]
        for locale, word in (("ru", "Необязательная"), ("kk", "Қосымша"), ("en", "Optional")):
            with self.subTest(locale=locale):
                service, _, _, _, _ = setup([venue(7, "museum"), venue(8, "gallery")], core=core, stages=stages)
                result = await service.recommend(request(query=" then ".join(stage["source_quote"] for stage in stages), locale=locale))
                self.assertEqual(len(result["recommendations"]), 5)
                self.assertEqual(len(result["suggestions"]), 1)
                self.assertEqual(len(result["places"]), 6)
                self.assertIn(word, result["suggestions"][0]["why"])


def test_local_filter_checks_radius_output_limit_and_core_category_variety_even_for_bad_adapter():
    core = [venue(1, "museum")]
    candidates = [venue(2, "museum"), venue(3, "gallery", latitude=52), venue(4, "gallery"),
                  venue(5, "theatre"), venue(6, "attraction")]
    ideas, selected = select_suggestions(candidates, core, request(), DefaultRecommendationService._evaluate)
    assert [item["id"] for item in selected] == [candidates[2]["id"], candidates[3]["id"]]
    assert len(ideas) == 2


def test_negation_detection_does_not_match_compound_proper_name_substrings():
    assert safe_query("NoNameCoffee then Northern Park")


def test_actual_catalog_pizza_and_garden_offer_separate_source_backed_ideas_with_soft_time():
    from astana_city_data import SnapshotRepository
    from astana_retrieval import LexicalRetriever

    path = Path(__file__).resolve().parents[3] / "data/samples/astana-osm.json"
    snapshot = json.loads(path.read_text(encoding="utf-8"))
    now = max(datetime.fromisoformat(item["retrieved_at"].replace("Z", "+00:00"))
              for source in snapshot["places"] for item in source["evidence"]) + timedelta(hours=1)

    async def check():
        repository = SnapshotRepository(path, clock=lambda: now)
        garden_id = "osm:way/1196402246"
        garden = await repository.get(garden_id)
        stages = [planned_stage("pizza", kind="meal", cuisine="pizza", categories=["restaurant", "cafe"]),
                  planned_stage("Ботанический сад", kind="named_place", name="Ботанический сад")]
        context = Context()
        service = DefaultRecommendationService(repository, LexicalRetriever(repository, pool_limit=1_000),
                                               context, planner=Planner(stages), clock=lambda: now)
        result = await service.recommend(request(query="pizza then Ботанический сад", origin=garden["location"],
                                                 available_seconds=1))
        core = [item["place_id"] for item in result["recommendations"]]
        ideas = [item["place_id"] for item in result["suggestions"]]
        assert len(core) == 2 and core[-1] == garden_id
        assert len(ideas) == 2 and not set(core).intersection(ideas)
        assert result["status"] == "partial"  # Soft time does not remove stops or ideas.
        assert len(context.routes) == 2 and len(context.context_requests) == 1
        assert all(not source["is_synthetic"] for source in result["places"])
        for idea in result["suggestions"]:
            source = next(source for source in result["places"] if source["id"] == idea["place_id"])
            assert set(source["categories"]).intersection(CATEGORIES)
            assert source["evidence"]
        validate_payload("RecommendationResponse", result)

    asyncio.run(check())
