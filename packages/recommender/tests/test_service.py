"""Behavior tests with explicit synthetic ports; no network or model credentials."""

from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import datetime, timezone
import json
import math
import time
import unittest
from unittest.mock import patch

from astana_contracts import ContractValidationError, validate_payload
from astana_recommender import (
    DefaultRecommendationService,
    GroundedExplanation,
    GroundedReason,
    RecommenderError,
)


STAMP = "2026-10-18T12:00:00+05:00"


def evidence(suffix="base"):
    return {
        "id": f"synthetic:evidence:{suffix}",
        "source_name": "SYNTHETIC test source, not a real venue",
        "source_type": "synthetic",
        "source_url": "https://example.invalid/synthetic",
        "source_record_id": f"synthetic:record:{suffix}",
        "retrieved_at": STAMP,
        "is_synthetic": True,
    }


def place(index=1, *, facts=None):
    e = evidence()
    return {
        "id": f"synthetic:place:{index}",
        "name": f"SYNTHETIC place {index}",
        "location": {"lat": 51.09 + index * 0.001, "lon": 71.42},
        "categories": ["test_fixture"],
        "description": "Synthetic fixture. No claims about real venues.",
        "facts": [] if facts is None else deepcopy(facts),
        "evidence": [e, evidence("second")],
        "is_synthetic": True,
    }


def fact(key="indoor", value=True, status="known"):
    ids = [] if status == "unknown" else [evidence()["id"]]
    if status == "conflicting":
        ids.append(evidence("second")["id"])
    return {
        "key": key, "status": status,
        "value": value if status == "known" else None,
        "evidence_ids": ids,
    }


def request(*, constraints=None, **changes):
    result = {
        "query": "A quiet place nearby",
        "locale": "en",
        "origin": {"lat": 51.09, "lon": 71.42},
        "start_at": STAMP,
        "timezone": "Asia/Almaty",
        "available_seconds": 3_600,
        "transport": "walking",
        "return_to_origin": True,
        "constraints": [] if constraints is None else deepcopy(constraints),
        "limit": 3,
    }
    result.update(changes)
    return result


def constraint(key="indoor", value=True, strength="required"):
    return {"key": key, "value": value, "strength": strength}


class Repository:
    def __init__(self, places):
        self.places = {p["id"]: deepcopy(p) for p in places}
        self.error = None

    async def get(self, place_id):
        if self.error:
            raise self.error
        return deepcopy(self.places.get(place_id))

    async def nearby(self, **kwargs):
        if self.error:
            raise self.error
        return deepcopy(list(self.places.values())[:kwargs["limit"]])


class Retriever:
    def __init__(self, places):
        self.places = deepcopy(places)
        self.error = None
        self.delay = 0
        self.requests = []
        self.transform = None

    async def retrieve(self, request):
        self.requests.append(deepcopy(request))
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error:
            raise self.error
        result = {
            "places": deepcopy(self.places),
            "hits": [
                {"place_id": p["id"], "score": float(len(self.places) - i),
                 "score_kind": "deterministic", "matched_fact_keys": []}
                for i, p in enumerate(self.places)
            ],
            "strategy": "synthetic_test", "warnings": [],
        }
        return self.transform(result) if self.transform else result


class Context:
    def __init__(self):
        self.enrich_error = None
        self.route_error = None
        self.route_delay = 0
        self.transform = None
        self.route_transform = None
        self.routes = []
        self.context_requests = []
        self.duration_seconds = 600
        self.method = "routed"
        self.active_routes = 0
        self.max_routes = 0

    async def enrich_places(self, *, places, request):
        self.context_requests.append(deepcopy(request))
        if self.enrich_error:
            raise self.enrich_error
        result = {"places": deepcopy(places), "warnings": [], "degraded_services": []}
        return self.transform(result) if self.transform else result

    async def estimate_route(self, **kwargs):
        self.routes.append(deepcopy(kwargs))
        if self.route_error:
            raise self.route_error
        self.active_routes += 1
        self.max_routes = max(self.max_routes, self.active_routes)
        try:
            if self.route_delay:
                await asyncio.sleep(self.route_delay)
            points = [kwargs["origin"], *kwargs["destinations"]]
            if kwargs["return_to_origin"]:
                points.append(kwargs["origin"])
            result = {
                "method": self.method,
                "provider": "synthetic_test",
                "transport": kwargs["transport"],
                "distance_meters": 600,
                "duration_seconds": self.duration_seconds,
                "includes_return": kwargs["return_to_origin"],
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[p["lon"], p["lat"]] for p in points],
                } if self.method == "routed" else None,
                "assumptions": ["SYNTHETIC test route, never a live provider result."],
                "evidence": [evidence("route")],
                "generated_at": STAMP,
            }
            return self.route_transform(result) if self.route_transform else result
        finally:
            self.active_routes -= 1


class Generator:
    def __init__(self, value=None, *, error=None, delay=0):
        self.value = value or GroundedExplanation((), "observe")
        self.error = error
        self.delay = delay
        self.calls = []

    async def generate(self, **kwargs):
        self.calls.append(deepcopy(kwargs))
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error:
            raise self.error
        return self.value


class PendingGenerator:
    """Manually resolve concurrent calls without relying on network timing."""

    def __init__(self):
        self.pending = {}
        self.started = asyncio.Event()
        self.finished = []
        self.cancelled = []
        self.max_active = 0

    async def generate(self, **kwargs):
        place_id = kwargs["place"]["id"]
        future = asyncio.get_running_loop().create_future()
        self.pending[place_id] = future
        self.max_active = max(self.max_active, sum(not item.done() for item in self.pending.values()))
        if len(self.pending) == 3:
            self.started.set()
        try:
            result = await future
            self.finished.append(place_id)
            return result
        except asyncio.CancelledError:
            self.cancelled.append(place_id)
            raise


class ServiceSetupMixin:
    def setup_service(self, places=None, **kwargs):
        places = [place(facts=[fact()])] if places is None else places
        self.repo = Repository(places)
        self.retriever = Retriever(places)
        self.context = Context()
        self.service = DefaultRecommendationService(
            self.repo, self.retriever, self.context,
            clock=lambda: datetime(2026, 10, 18, 7, tzinfo=timezone.utc),
            **kwargs,
        )
        return self.service


class RecommendationTests(ServiceSetupMixin, unittest.IsolatedAsyncioTestCase):
    async def test_success_has_verified_constraints_return_budget_and_synthetic_label(self):
        self.setup_service()
        value = await self.service.recommend(request(constraints=[constraint()]))
        validate_payload("RecommendationResponse", value)
        self.assertEqual(value["status"], "matched")
        item = value["recommendations"][0]
        self.assertEqual(item["total_duration_seconds"], 1800)
        self.assertTrue(item["route"]["includes_return"])
        self.assertEqual(item["constraint_evaluations"][0]["evidence_ids"], [evidence()["id"]])
        self.assertIn("No language model", " ".join(value["warnings"]))
        self.assertIn("Synthetic", " ".join(value["warnings"]))
        self.assertEqual(value["generated_at"], "2026-10-18T07:00:00+00:00")

    async def test_ordered_stages_choose_distinct_places_and_keep_order_after_parallel_routes(self):
        self.setup_service([place(1), place(2), place(3)])
        value = await self.service.recommend(request(query="First coffee then park then museum"))
        self.assertEqual([item["place_id"] for item in value["recommendations"]],
                         [place(1)["id"], place(2)["id"], place(3)["id"]])
        self.assertEqual([item["query"] for item in self.retriever.requests], ["coffee", "park", "museum"])
        self.assertEqual(sum(item["candidate_limit"] for item in self.retriever.requests), 24)
        self.assertEqual(len(self.context.routes), 3)
        self.assertEqual(len(self.context.context_requests), 1)

    async def test_two_stages_do_not_fill_the_trip_with_a_third_unrequested_stop(self):
        self.setup_service([place(1), place(2), place(3)])
        value = await self.service.recommend(request(query="Coffee then park"))
        self.assertEqual(len(value["recommendations"]), 2)
        self.assertEqual([item["rank"] for item in value["recommendations"]], [1, 2])

    async def test_ordered_stage_search_failure_never_uses_unrelated_nearest_fallback(self):
        self.setup_service([place(1), place(2)])
        self.retriever.error = RuntimeError("sensitive provider failure")
        value = await self.service.recommend(request(query="First coffee then park"))
        self.assertEqual(value["status"], "needs_clarification")
        self.assertEqual(value["places"], [])
        self.assertEqual(len(value["clarification_questions"]), 2)
        self.assertFalse(self.context.routes)
        self.assertNotIn("sensitive", json.dumps(value))

    async def test_empty_stage_is_reported_as_incomplete_without_fake_destination(self):
        self.setup_service([place(1)])
        value = await self.service.recommend(request(query="First coffee then"))
        self.assertEqual(value["status"], "partial")
        self.assertEqual(len(value["recommendations"]), 1)
        self.assertEqual([item["query"] for item in self.retriever.requests], ["coffee"])
        self.assertIn("stage 2", " ".join(value["warnings"]))

    async def test_missing_middle_stage_retains_original_stage_numbers_in_explanations(self):
        self.setup_service([place(1), place(2)])
        value = await self.service.recommend(request(query="First coffee then then park"))
        self.assertEqual(len(value["recommendations"]), 2)
        self.assertTrue(value["recommendations"][0]["why"].startswith("Stage 1"))
        self.assertTrue(value["recommendations"][1]["why"].startswith("Stage 3"))
        self.assertIn("stage 2", " ".join(value["warnings"]))

    async def test_ordered_stages_preserve_required_constraints_and_soft_time(self):
        self.setup_service([place(1), place(2, facts=[fact()]), place(3, facts=[fact()])])
        value = await self.service.recommend(request(
            query="First coffee then park", available_seconds=60, constraints=[constraint()],
        ))
        self.assertEqual([item["place_id"] for item in value["recommendations"]], [place(2)["id"], place(3)["id"]])
        self.assertEqual(value["status"], "partial")
        self.assertTrue(all(item["total_duration_seconds"] > 60 for item in value["recommendations"]))
        self.assertTrue(all(item["constraints"] == [constraint()] for item in self.retriever.requests))

    async def test_stage_route_failure_can_use_next_relevant_candidate_without_reordering(self):
        self.setup_service([place(1), place(2), place(3)])
        original = self.context.estimate_route

        async def route(**kwargs):
            if kwargs["destinations"][0] == place(1)["location"]:
                raise RuntimeError("unroutable")
            return await original(**kwargs)

        self.context.estimate_route = route
        value = await self.service.recommend(request(query="First coffee then park"))
        self.assertEqual([item["place_id"] for item in value["recommendations"]], [place(3)["id"], place(2)["id"]])
        self.assertEqual(value["status"], "partial")

    async def test_sequence_respects_explicit_result_limit_and_reports_omitted_stages(self):
        self.setup_service([place(1), place(2), place(3)])
        for limit in (1, 2, 3):
            with self.subTest(limit=limit):
                value = await self.service.recommend(request(
                    query="First coffee then park then museum then gallery", limit=limit,
                ))
                self.assertEqual(len(value["recommendations"]), limit)
                self.assertEqual(value["status"], "partial")
                self.assertIn(f"first {limit} stages", " ".join(value["warnings"]))

    async def test_unknown_conflicting_false_and_absent_required_all_exclude(self):
        variants = [
            [fact(value=False)], [fact(status="unknown")],
            [fact(status="conflicting")], [],
        ]
        for facts in variants:
            with self.subTest(facts=facts):
                self.setup_service([place(facts=facts)])
                value = await self.service.recommend(request(constraints=[constraint()]))
                self.assertEqual(value["status"], "no_match")
                self.assertEqual(value["places"], [])
                self.assertEqual(self.context.routes, [])

    async def test_booleans_are_not_numbers_in_scalar_or_array_predicates(self):
        for actual, expected in [(True, 1), (False, 0), ([True], [1]), ([1, False], [1, 0])]:
            with self.subTest(actual=actual, expected=expected):
                self.setup_service([place(facts=[fact(value=actual)])])
                value = await self.service.recommend(
                    request(constraints=[constraint(value=expected)])
                )
                self.assertEqual(value["status"], "no_match")

    async def test_numeric_json_equality_and_false_constraints_are_supported(self):
        for actual, expected in [(1, 1.0), (False, False), ([2, False], [2.0, False])]:
            with self.subTest(actual=actual, expected=expected):
                self.setup_service([place(facts=[fact(value=actual)])])
                value = await self.service.recommend(
                    request(constraints=[constraint(value=expected)])
                )
                self.assertEqual(len(value["recommendations"]), 1)

    async def test_preferred_unsatisfied_and_unknown_produce_partial_not_exclusion(self):
        self.setup_service([place(facts=[fact(value=False)])])
        value = await self.service.recommend(request(constraints=[
            constraint(strength="preferred"),
            constraint("free_entry", True, "preferred"),
        ]))
        self.assertEqual(value["status"], "partial")
        self.assertEqual(
            [e["outcome"] for e in value["recommendations"][0]["constraint_evaluations"]],
            ["unsatisfied", "unknown"],
        )

    async def test_preferred_matches_do_not_override_retrieval_relevance(self):
        places = [place(1, facts=[fact(value=False)]), place(2, facts=[fact()]), place(3, facts=[fact()])]
        self.setup_service(places)
        value = await self.service.recommend(
            request(constraints=[constraint(strength="preferred")], limit=2)
        )
        self.assertEqual([p["id"] for p in value["places"]], [places[0]["id"], places[1]["id"]])
        self.assertEqual(value["recommendations"][0]["constraint_evaluations"][0]["outcome"], "unsatisfied")
        self.assertEqual(value["status"], "partial")

    async def test_dynamic_constraint_is_evaluated_after_enrichment(self):
        self.setup_service()

        def add_open(result):
            result["places"][0]["facts"].append(fact("open_at_requested_time"))
            return result

        self.context.transform = add_open
        value = await self.service.recommend(
            request(constraints=[constraint("open_at_requested_time")])
        )
        self.assertEqual(len(value["recommendations"]), 1)

    async def test_context_error_invalidates_preexisting_dynamic_fact(self):
        self.setup_service([place(facts=[fact("open_at_requested_time")])])
        self.context.enrich_error = RuntimeError("SECRET_TOKEN")
        value = await self.service.recommend(
            request(constraints=[constraint("open_at_requested_time")])
        )
        self.assertEqual(value["status"], "no_match")
        self.assertNotIn("SECRET_TOKEN", json.dumps(value))

    async def test_context_failure_can_preserve_static_verified_facts(self):
        self.setup_service()
        self.context.enrich_error = RuntimeError("SECRET_TOKEN")
        value = await self.service.recommend(request(constraints=[constraint()]))
        self.assertEqual(value["status"], "partial")
        self.assertEqual(len(value["recommendations"]), 1)

    async def test_context_cannot_inject_a_different_place(self):
        self.setup_service()

        def inject(result):
            result["places"] = [place(999, facts=[fact()])]
            return result

        self.context.transform = inject
        value = await self.service.recommend(request(constraints=[constraint()]))
        self.assertEqual(value["places"][0]["id"], "synthetic:place:1")
        self.assertEqual(value["status"], "partial")

    async def test_context_cannot_change_stable_location(self):
        self.setup_service()
        original = deepcopy(self.retriever.places[0]["location"])

        def mutate(result):
            result["places"][0]["location"]["lat"] = 0
            return result

        self.context.transform = mutate
        value = await self.service.recommend(request())
        self.assertEqual(value["places"][0]["location"], original)

    async def test_context_cannot_turn_static_violation_into_satisfaction(self):
        self.setup_service([place(facts=[fact(value=False)])])

        def rewrite(result):
            result["places"][0]["facts"][0]["value"] = True
            return result

        self.context.transform = rewrite
        value = await self.service.recommend(request(constraints=[constraint()]))
        self.assertEqual(value["status"], "no_match")
        self.assertEqual(self.context.routes, [])

    async def test_context_cannot_replace_existing_source_under_same_evidence_id(self):
        self.setup_service()

        def rewrite_source(result):
            result["places"][0]["evidence"][0]["source_url"] = "https://example.invalid/replaced"
            return result

        self.context.transform = rewrite_source
        value = await self.service.recommend(request(constraints=[constraint()]))
        self.assertEqual(value["status"], "partial")
        self.assertEqual(value["places"][0]["evidence"][0]["source_url"], evidence()["source_url"])

    async def test_retrieval_failure_uses_explicit_catalog_fallback(self):
        self.setup_service()
        self.retriever.error = RuntimeError("SECRET_TOKEN")
        value = await self.service.recommend(request())
        self.assertEqual(value["status"], "partial")
        self.assertIn("nearby-catalog", " ".join(value["warnings"]))
        self.assertNotIn("SECRET_TOKEN", json.dumps(value))

    async def test_invalid_retrieval_response_is_not_trusted(self):
        self.setup_service()

        def fabricate(result):
            result["hits"][0]["place_id"] = "synthetic:missing"
            return result

        self.retriever.transform = fabricate
        value = await self.service.recommend(request())
        self.assertEqual(value["status"], "partial")
        self.assertEqual(value["places"][0]["id"], "synthetic:place:1")

    async def test_retrieval_and_catalog_failure_return_valid_no_match(self):
        self.setup_service()
        self.retriever.error = RuntimeError("SECRET_TOKEN")
        self.repo.error = RuntimeError("SECRET_TOKEN")
        value = await self.service.recommend(request())
        self.assertEqual(value["status"], "no_match")
        validate_payload("RecommendationResponse", value)
        self.assertNotIn("SECRET_TOKEN", json.dumps(value))

    async def test_empty_retrieval_stays_empty_without_silent_relaxation(self):
        self.setup_service([])
        self.repo.places = {"synthetic:place:8": place(8)}
        value = await self.service.recommend(request())
        self.assertEqual(value["status"], "no_match")
        self.assertEqual(self.context.routes, [])

    async def test_provider_timeouts_do_not_leak_or_hang(self):
        self.setup_service(timeout_seconds=0.01)
        self.retriever.delay = 0.1
        self.context.route_delay = 0.1
        value = await asyncio.wait_for(self.service.recommend(request()), timeout=1)
        self.assertEqual(value["status"], "no_match")

    async def test_invalid_routes_are_excluded(self):
        changes = [
            {"transport": "driving"}, {"includes_return": False},
            {"duration_seconds": 0}, {"geometry": None},
        ]
        for change in changes:
            with self.subTest(change=change):
                self.setup_service()
                self.context.route_transform = lambda route: {**route, **change}
                value = await self.service.recommend(request())
                self.assertEqual(value["status"], "no_match")

    async def test_approximate_routes_are_marked_without_geometry(self):
        self.setup_service()
        self.context.method = "approximate"
        value = await self.service.recommend(request())
        self.assertEqual(value["status"], "partial")
        self.assertIsNone(value["recommendations"][0]["route"]["geometry"])
        self.assertIn("approximate", " ".join(value["warnings"]))

    async def test_selected_time_is_a_preference_without_shrinking_travel_or_visit(self):
        self.setup_service()
        exact = await self.service.recommend(request(available_seconds=1800))
        too_small = await self.service.recommend(request(available_seconds=1799))
        self.assertEqual(len(exact["recommendations"]), 1)
        self.assertEqual(exact["status"], "matched")
        self.assertFalse(any("longer than" in warning for warning in exact["warnings"]))
        self.assertEqual(too_small["status"], "partial")
        self.assertEqual(too_small["recommendations"][0]["total_duration_seconds"], 1800)
        self.assertEqual(too_small["recommendations"][0]["visit_duration_seconds"], 1200)
        self.assertEqual(too_small["recommendations"][0]["route"]["duration_seconds"], 600)
        self.assertTrue(too_small["recommendations"][0]["route"]["includes_return"])
        self.assertIn("30 min; 1 min longer", " ".join(too_small["warnings"]))

    async def test_100_minutes_can_return_200_and_300_minute_alternatives_in_all_locales(self):
        for locale, phrase in (("ru", "больше выбранного"), ("kk", "таңдалған уақыттан"), ("en", "longer than")):
            for minutes in (200, 300):
                with self.subTest(locale=locale, minutes=minutes):
                    self.setup_service()
                    self.context.duration_seconds = minutes * 60 - 1200
                    value = await self.service.recommend(request(locale=locale, available_seconds=6000))
                    validate_payload("RecommendationResponse", value)
                    self.assertEqual(value["status"], "partial")
                    item = value["recommendations"][0]
                    self.assertEqual(item["total_duration_seconds"], minutes * 60)
                    self.assertEqual(value["request"]["available_seconds"], 6000)
                    warning = next(text for text in item["warnings"] if phrase in text)
                    self.assertIn(str(minutes), warning)
                    self.assertIn(str(minutes - 100), warning)
                    self.assertIn(warning, value["warnings"])

    async def test_long_alternatives_keep_required_constraints_strict(self):
        places = [place(1, facts=[fact()]), place(2, facts=[fact(status="unknown")]), place(3, facts=[fact(value=False)])]
        self.setup_service(places)
        self.context.duration_seconds = 10800
        value = await self.service.recommend(request(available_seconds=6000, constraints=[constraint()]))
        self.assertEqual([p["id"] for p in value["places"]], [places[0]["id"]])
        self.assertEqual(value["recommendations"][0]["total_duration_seconds"], 12000)
        self.assertEqual(len(self.context.routes), 1)

    async def test_long_alternatives_do_not_route_or_explain_the_unused_candidate_pool(self):
        generator = Generator()
        self.setup_service([place(i) for i in range(24)], generator=generator)
        self.context.duration_seconds = 10800
        value = await self.service.recommend(request(available_seconds=6000, limit=3))
        self.assertEqual(len(value["recommendations"]), 3)
        self.assertEqual(len(self.context.routes), 3)
        self.assertEqual(len(generator.calls), 3)
        self.assertEqual([entry["place"]["id"] for entry in generator.calls], [p["id"] for p in value["places"]])

    async def test_source_visit_duration_is_used_but_boolean_is_not_a_number(self):
        for duration, expected in [(300, 900), (True, 1800)]:
            with self.subTest(duration=duration):
                self.setup_service([place(facts=[fact("visit_duration_seconds", duration)])])
                value = await self.service.recommend(request())
                self.assertEqual(value["recommendations"][0]["total_duration_seconds"], expected)

    async def test_candidate_count_and_parallelism_are_bounded(self):
        self.setup_service([place(i) for i in range(10)], candidate_limit=5, route_concurrency=2)
        self.context.route_delay = 0.005
        value = await self.service.recommend(request(limit=3))
        self.assertEqual(len(value["recommendations"]), 3)
        self.assertEqual(self.retriever.requests[0]["candidate_limit"], 5)
        self.assertLessEqual(self.context.max_routes, 2)
        self.assertLessEqual(len(self.context.routes), 5)

    async def test_each_alternative_has_its_own_budget(self):
        self.setup_service([place(1), place(2), place(3)])
        value = await self.service.recommend(request(available_seconds=1800))
        self.assertEqual(len(value["recommendations"]), 3)
        self.assertTrue(all(r["total_duration_seconds"] == 1800 for r in value["recommendations"]))

    async def test_request_and_dependency_data_are_not_mutated(self):
        self.setup_service()
        query = request(constraints=[constraint()])
        saved = deepcopy(query)
        originals = deepcopy(self.retriever.places)
        await self.service.recommend(query)
        self.assertEqual(query, saved)
        self.assertEqual(self.retriever.places, originals)

    async def test_all_three_locales_have_deterministic_explanations(self):
        for locale, expected in [("ru", "Расчётное время"), ("kk", "есептік уақыты"), ("en", "Estimated travel")]:
            with self.subTest(locale=locale):
                self.setup_service()
                value = await self.service.recommend(request(locale=locale))
                self.assertIn(expected, value["recommendations"][0]["why"])

    async def test_bad_request_and_unsupported_transport_fail_before_provider_calls(self):
        self.setup_service()
        invalid = request()
        del invalid["origin"]
        with self.assertRaises(ContractValidationError):
            await self.service.recommend(invalid)
        with self.assertRaises(RecommenderError) as error:
            await self.service.recommend(request(transport="cycling"))
        self.assertEqual(error.exception.code, "unsupported_transport")
        self.assertEqual(self.retriever.requests, [])

    async def test_cancellation_is_propagated(self):
        self.setup_service()
        self.retriever.error = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await self.service.recommend(request())

    async def test_generator_has_no_origin_and_can_only_select_grounded_reasons(self):
        generated = GroundedExplanation((GroundedReason("indoor", (evidence()["id"],)),), "explore")
        generator = Generator(generated)
        self.setup_service(generator=generator)
        value = await self.service.recommend(request(constraints=[constraint()]))
        self.assertIn("Indoors: yes", value["recommendations"][0]["why"])
        self.assertNotIn("origin", generator.calls[0])
        self.assertNotIn("request", generator.calls[0])
        self.assertNotIn("No language model", " ".join(value["warnings"]))

    async def test_bad_generator_output_falls_back_without_fabricated_claim(self):
        invalid = [
            GroundedExplanation((GroundedReason("missing", (evidence()["id"],)),)),
            GroundedExplanation((GroundedReason("indoor", ("synthetic:missing",)),)),
            GroundedExplanation((), "SECRET invented indoor trampoline"),
            {"why": "SECRET fabricated fact", "suggested_activity": "observe"},
        ]
        for generated in invalid:
            with self.subTest(generated=generated):
                self.setup_service(generator=Generator(generated))
                value = await self.service.recommend(request(constraints=[constraint()]))
                self.assertEqual(value["status"], "partial")
                self.assertIn("Indoors: yes", value["recommendations"][0]["why"])
                self.assertNotIn("SECRET", json.dumps(value))

    async def test_generator_failure_or_timeout_falls_back(self):
        for generator in [Generator(error=RuntimeError("SECRET_TOKEN")), Generator(delay=0.1)]:
            self.setup_service(generator=generator, timeout_seconds=0.01)
            value = await self.service.recommend(request())
            self.assertEqual(value["status"], "partial")
            self.assertNotIn("SECRET_TOKEN", json.dumps(value))


class VisitPurposeTests(ServiceSetupMixin, unittest.IsolatedAsyncioTestCase):
    async def test_source_category_explains_coffee_and_green_stops_in_all_locales(self):
        expected = {
            "ru": {"cafe": ("как кафе", "кофе"), "park": ("как парк", "парку"), "garden": ("как сад", "саду")},
            "kk": {"cafe": ("кафе ретінде", "Кофе"), "park": ("саябақ ретінде", "Саябақта"), "garden": ("бақ ретінде", "Бақта")},
            "en": {"cafe": ("as a cafe", "coffee"), "park": ("as a park", "park"), "garden": ("as a garden", "garden")},
        }
        for locale, variants in expected.items():
            for category, (reason, activity) in variants.items():
                for operation in ("recommend", "build_itinerary"):
                    with self.subTest(locale=locale, category=category, operation=operation):
                        venue = place(1)
                        venue["categories"] = [category]
                        self.setup_service([venue])
                        body = request(locale=locale, **({"place_ids": [venue["id"]]} if operation == "build_itinerary" else {}))
                        result = await getattr(self.service, operation)(body)
                        key = "recommendations" if operation == "recommend" else "stops"
                        item = result[key][0]
                        self.assertIn(activity, item["suggested_activity"])
                        self.assertTrue(item["activity_is_ai_suggestion"])
                        self.assertTrue(item["visit_duration_is_estimate"])
                        self.assertEqual(item["visit_duration_seconds"], 1200)
                        if operation == "recommend":
                            self.assertIn(reason, item["why"])
                            self.assertIn(venue["name"], item["why"])
                            self.assertEqual(item["total_duration_seconds"], 1800)
                        self.assertEqual(result["places"][0]["facts"], [])
                        self.assertEqual(result["places"][0]["evidence"], venue["evidence"])

    async def test_cafe_purpose_precedes_incidental_generated_amenities_without_inventing_services(self):
        venue = place(1, facts=[fact("toilets", True), fact("has_wifi", status="unknown")])
        venue["categories"] = ["coffee_shop"]
        generator = Generator(GroundedExplanation((GroundedReason("toilets", (evidence()["id"],)),), "explore"))
        self.setup_service([venue], generator=generator)
        value = await self.service.recommend(request(query="Coffee", constraints=[constraint("has_wifi", strength="preferred")]))
        item = value["recommendations"][0]
        self.assertLess(item["why"].index("coffee stop"), item["why"].index("Toilets: yes"))
        self.assertEqual(item["suggested_activity"], "Make a stop for coffee.")
        self.assertEqual(item["constraint_evaluations"][0]["outcome"], "unknown")
        self.assertEqual(value["status"], "partial")
        self.assertEqual(value["places"][0]["facts"], venue["facts"])
        self.assertEqual(len(generator.calls), 1)
        self.assertNotIn("menu", item["why"].lower())

    async def test_names_and_description_do_not_turn_another_category_into_a_cafe_or_park(self):
        venue = place(1)
        venue.update(name="SYNTHETIC Coffee Park", description="Coffee and park in a source description.", categories=["museum"])
        self.setup_service([venue], generator=Generator(GroundedExplanation((), "explore")))
        result = await self.service.recommend(request(query="not a cafe, a museum"))
        item = result["recommendations"][0]
        self.assertIn("museum topic", item["suggested_activity"])
        self.assertNotIn("as a cafe", item["why"])
        self.assertNotIn("as a park", item["why"])

    async def test_model_failure_still_gives_the_same_grounded_park_activity(self):
        venue = place(1)
        venue["categories"] = ["park"]
        self.setup_service([venue], generator=Generator(error=RuntimeError("private provider response")))
        result = await self.service.recommend(request(query="not coffee, a park"))
        item = result["recommendations"][0]
        self.assertIn("as a park", item["why"])
        self.assertEqual(item["suggested_activity"], "Walk through the park at your own pace.")
        self.assertNotIn("coffee", item["suggested_activity"])
        self.assertNotIn("private provider", json.dumps(result))
        self.assertEqual(result["status"], "partial")


class ParallelExplanationTests(ServiceSetupMixin, unittest.IsolatedAsyncioTestCase):
    async def test_only_selected_places_share_one_generation_phase_and_keep_order(self):
        from astana_recommender.text import TEXT

        for operation in ("recommend", "build_itinerary"):
            with self.subTest(operation=operation):
                generator = PendingGenerator()
                places = [place(i) for i in (1, 2, 3, 4)]
                self.setup_service(places, generator=generator)
                if operation == "recommend":
                    # A failed first route must be replaced before generation;
                    # it must not consume a model call or split the phase.
                    self.context.route_transform = lambda route: {
                        **route,
                        "duration_seconds": -1,
                    } if route["geometry"]["coordinates"][1][1] == places[0]["location"]["lat"] else route
                    expected_ids = [p["id"] for p in places[1:]]
                    body = request()
                    result_key = "recommendations"
                    order_key = "rank"
                else:
                    expected_ids = [places[i]["id"] for i in (2, 0, 1)]
                    body = request(place_ids=expected_ids)
                    result_key = "stops"
                    order_key = "order"
                task = asyncio.create_task(getattr(self.service, operation)(body))
                try:
                    await asyncio.wait_for(generator.started.wait(), timeout=2)
                    self.assertEqual(list(generator.pending), expected_ids)
                    activities = ["observe", "explore", "take_break"]
                    for place_id, activity in reversed(list(zip(expected_ids, activities, strict=True))):
                        generator.pending[place_id].set_result(GroundedExplanation((), activity))
                    result = await asyncio.wait_for(task, timeout=2)
                    self.assertEqual(generator.finished, list(reversed(expected_ids)))
                    self.assertEqual([item["place_id"] for item in result[result_key]], expected_ids)
                    self.assertEqual([item[order_key] for item in result[result_key]], [1, 2, 3])
                    self.assertEqual(
                        [item["suggested_activity"] for item in result[result_key]],
                        [TEXT["en"][activity] for activity in activities],
                    )
                finally:
                    if not task.done():
                        task.cancel()
                    await asyncio.gather(task, return_exceptions=True)

    async def test_cancellation_stops_every_pending_explanation(self):
        for operation in ("recommend", "build_itinerary"):
            with self.subTest(operation=operation):
                generator = PendingGenerator()
                places = [place(i) for i in (1, 2, 3)]
                self.setup_service(places, generator=generator)
                body = request(**({"place_ids": [p["id"] for p in places]} if operation == "build_itinerary" else {}))
                task = asyncio.create_task(getattr(self.service, operation)(body))
                try:
                    await asyncio.wait_for(generator.started.wait(), timeout=2)
                finally:
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                self.assertCountEqual(generator.cancelled, [p["id"] for p in places])
                self.assertTrue(all(future.cancelled() for future in generator.pending.values()))

    async def test_three_slow_explanations_fall_back_together_without_dropping_the_route(self):
        from astana_recommender.text import TEXT

        for operation in ("recommend", "build_itinerary"):
            with self.subTest(operation=operation):
                generator = PendingGenerator()
                places = [place(i) for i in (1, 2, 3)]
                self.setup_service(places, generator=generator, timeout_seconds=0.05)
                body = request(**({"place_ids": [p["id"] for p in places]} if operation == "build_itinerary" else {}))
                result = await asyncio.wait_for(getattr(self.service, operation)(body), timeout=2)
                # All calls start before any timeout; serial execution would
                # only add the next call after its predecessor was cancelled.
                self.assertTrue(generator.started.is_set())
                self.assertEqual(generator.max_active, 3)
                self.assertCountEqual(generator.cancelled, [p["id"] for p in places])
                self.assertEqual(result["status"], "partial")
                self.assertEqual(len(result["places"]), 3)
                self.assertIn(TEXT["en"]["generation_failed"], result["warnings"])
                self.assertIsNotNone(result["route"] if operation == "build_itinerary" else result["recommendations"][0]["route"])


class ItineraryTests(ServiceSetupMixin, unittest.IsolatedAsyncioTestCase):
    async def test_itinerary_preserves_all_ids_order_and_total(self):
        places = [place(1), place(2), place(3)]
        self.setup_service(places)
        selected = [places[2]["id"], places[0]["id"]]
        value = await self.service.build_itinerary(request(place_ids=selected))
        validate_payload("ItineraryResponse", value)
        self.assertEqual([s["place_id"] for s in value["stops"]], selected)
        self.assertEqual(value["total_duration_seconds"], 3000)
        self.assertEqual(self.context.routes[0]["destinations"], [places[2]["location"], places[0]["location"]])
        self.assertNotIn("place_ids", self.context.context_requests[0])
        self.assertEqual(self.retriever.requests, [])

    async def test_itinerary_missing_selected_place_is_not_substituted(self):
        self.setup_service()
        value = await self.service.build_itinerary(request(place_ids=["synthetic:missing"]))
        self.assertEqual(value["status"], "no_match")
        self.assertEqual(value["places"], [])
        self.assertIsNone(value["route"])
        self.assertEqual(value["total_duration_seconds"], 0)

    async def test_long_itinerary_keeps_all_three_stops_and_complete_return_route(self):
        for locale, phrase in (("ru", "больше выбранного"), ("kk", "таңдалған уақыттан"), ("en", "longer than")):
            with self.subTest(locale=locale):
                places = [place(1), place(2), place(3)]
                self.setup_service(places)
                self.context.duration_seconds = 14400
                selected = [places[2]["id"], places[0]["id"], places[1]["id"]]
                value = await self.service.build_itinerary(
                    request(place_ids=selected, locale=locale, available_seconds=6000)
                )
                validate_payload("ItineraryResponse", value)
                self.assertEqual(value["status"], "partial")
                self.assertEqual([stop["place_id"] for stop in value["stops"]], selected)
                self.assertEqual([stop["order"] for stop in value["stops"]], [1, 2, 3])
                self.assertEqual(value["total_duration_seconds"], 18000)
                self.assertTrue(value["route"]["includes_return"])
                self.assertEqual(sum(stop["visit_duration_seconds"] for stop in value["stops"]), 3600)
                self.assertEqual(self.context.routes[0]["destinations"], [places[2]["location"], places[0]["location"], places[1]["location"]])
                self.assertEqual(len(self.context.routes), 1)
                warning = next(text for text in value["warnings"] if phrase in text)
                self.assertIn("300", warning)
                self.assertIn("200", warning)

    async def test_itinerary_required_unknown_in_any_stop_rejects_whole_trip(self):
        places = [place(1, facts=[fact()]), place(2)]
        self.setup_service(places)
        value = await self.service.build_itinerary(
            request(place_ids=[p["id"] for p in places], constraints=[constraint()])
        )
        self.assertEqual(value["status"], "no_match")
        self.assertEqual(self.context.routes, [])

    async def test_itinerary_route_failure_returns_empty_canonical_result(self):
        self.setup_service()
        self.context.route_error = RuntimeError("SECRET_TOKEN")
        value = await self.service.build_itinerary(request(place_ids=["synthetic:place:1"]))
        self.assertEqual(value["status"], "no_match")
        self.assertNotIn("SECRET_TOKEN", json.dumps(value))
        validate_payload("ItineraryResponse", value)

    async def test_itinerary_duplicate_or_too_many_selected_ids_are_invalid(self):
        self.setup_service()
        for selected, limit in [
            (["synthetic:place:1", "synthetic:place:1"], 3),
            (["synthetic:place:1", "synthetic:place:2"], 1),
        ]:
            with self.subTest(selected=selected):
                with self.assertRaises(ContractValidationError):
                    await self.service.build_itinerary(request(place_ids=selected, limit=limit))


class PaceAndCategoryTests(ServiceSetupMixin, unittest.IsolatedAsyncioTestCase):
    async def test_shorter_ordered_coffee_park_keeps_stage_order_and_uses_previous_stop(self):
        coffee_far, coffee_near, park_near_origin, park_near_coffee = [place(index) for index in (9, 4, 1, 3)]
        for venue in (coffee_far, coffee_near):
            venue["categories"] = ["cafe"]
        for venue in (park_near_origin, park_near_coffee):
            venue["categories"] = ["park"]
        venues = [coffee_far, coffee_near, park_near_origin, park_near_coffee]
        self.setup_service(venues)

        class StageRetriever(Retriever):
            async def retrieve(self, payload):
                result = await super().retrieve(payload)
                category = "cafe" if "coffee" in payload["query"] else "park"
                result["places"] = [venue for venue in result["places"] if category in venue["categories"]]
                allowed = {venue["id"] for venue in result["places"]}
                result["hits"] = [hit for hit in result["hits"] if hit["place_id"] in allowed]
                return result

        self.service.retriever = StageRetriever(venues)
        original = self.context.estimate_route

        async def measured(**kwargs):
            result = await original(**kwargs)
            points = [kwargs["origin"], *kwargs["destinations"]]
            if kwargs["return_to_origin"]:
                points.append(kwargs["origin"])
            # Synthetic routed measurements deliberately differ by leg. The
            # recommender must use the returned values without inventing paths.
            result["distance_meters"] = round(sum(
                abs(second["lat"] - first["lat"]) * 100_000
                for first, second in zip(points, points[1:])
            ))
            result["duration_seconds"] = result["distance_meters"]
            return result

        self.context.estimate_route = measured
        baseline = await self.service.recommend(request(query="First coffee then park"))
        baseline_ids = [item["place_id"] for item in baseline["recommendations"]]
        self.assertEqual(baseline_ids, [coffee_far["id"], park_near_origin["id"]])
        baseline_trip = await self.service.build_itinerary(request(query="First coffee then park", place_ids=baseline_ids))
        self.assertEqual(len(self.context.routes), 3)  # two selected alternatives and one complete itinerary
        self.context.routes.clear()

        query = "First coffee then park. I would like less walking and short transfers between stops."
        refined = await self.service.recommend(request(query=query))
        refined_ids = [item["place_id"] for item in refined["recommendations"]]
        self.assertEqual(refined_ids, [coffee_near["id"], park_near_coffee["id"]])
        self.assertEqual([item["rank"] for item in refined["recommendations"]], [1, 2])
        self.assertTrue(refined["recommendations"][0]["why"].startswith("Stage 1"))
        self.assertTrue(refined["recommendations"][1]["why"].startswith("Stage 2"))
        self.assertEqual([item["route"]["distance_meters"] for item in refined["recommendations"]], [800, 600])
        refined_trip = await self.service.build_itinerary(request(query=query, place_ids=refined_ids))
        self.assertEqual(len(self.context.routes), 3)
        self.assertLess(refined_trip["route"]["distance_meters"], baseline_trip["route"]["distance_meters"])
        self.assertEqual([stop["place_id"] for stop in refined_trip["stops"]], refined_ids)

    async def test_enriched_green_themes_do_not_crowd_out_comparable_discovery_categories(self):
        parks = [place(index) for index in (1, 2, 3)]
        for park, description in zip(parks, (
            "A green space.", "A park along the waterfront.", "A park with architectural details.",
        ), strict=True):
            park.update(categories=["park"], description=description)
        theatre = place(4)
        theatre.update(categories=["theatre"], description="An architectural landmark.")
        for query, locale in (("серуен", "kk"), ("хочу погулять", "ru"), ("a walk", "en")):
            with self.subTest(locale=locale):
                self.setup_service([*parks, theatre])

                def comparable(result):
                    for hit in result["hits"]:
                        hit.update(score=1.0, score_kind="lexical")
                    return result

                self.retriever.transform = comparable
                result = await self.service.recommend(request(query=query, locale=locale))
                self.assertEqual(result["places"][0]["id"], parks[0]["id"])
                self.assertIn(theatre["id"], [p["id"] for p in result["places"]])
                self.assertTrue(any("park" in p["categories"] for p in result["places"]))
                self.assertEqual(len(self.context.routes), 3)

    async def test_category_variety_does_not_promote_weak_literal_matches(self):
        parks = [place(index) for index in (1, 2, 3)]
        for park in parks:
            park.update(categories=["park"], description="Historic fortress grounds.")
        theatre = place(4)
        theatre.update(categories=["theatre"], description="An architectural landmark.")
        self.setup_service([*parks, theatre])

        def unequal(result):
            for hit in result["hits"]:
                hit.update(score=10.0 if hit["place_id"] != theatre["id"] else 1.0, score_kind="lexical")
            return result

        self.retriever.transform = unequal
        result = await self.service.recommend(request(query="historic scenic walk"))
        self.assertEqual([p["id"] for p in result["places"]], [p["id"] for p in parks])
        self.assertEqual(len(self.context.routes), 3)

    async def test_short_walk_uses_only_normal_route_calls_then_measured_distance(self):
        places = [place(index) for index in range(12, 0, -1)]
        self.setup_service(places)
        distances = {4: 900, 5: 200, 6: 500}
        original = self.context.estimate_route

        async def measured(**kwargs):
            result = await original(**kwargs)
            index = round((kwargs["destinations"][0]["lat"] - 51.09) * 1000)
            result["distance_meters"] = distances[index]
            return result

        self.context.estimate_route = measured
        result = await self.service.recommend(request(query="I would like less walking", available_seconds=60))
        self.assertEqual([item["place_id"] for item in result["recommendations"]],
                         ["synthetic:place:5", "synthetic:place:6", "synthetic:place:4"])
        self.assertEqual(len(self.context.routes), 3)
        self.assertEqual([item["route"]["distance_meters"] for item in result["recommendations"]], [200, 500, 900])
        self.assertIn("200 m", result["recommendations"][0]["why"])
        self.assertEqual(len(result["recommendations"]), 3)  # a short budget does not silently remove options

    async def test_long_walk_uses_distant_relevant_shortlist_and_measured_distance(self):
        places = [place(index) for index in range(1, 13)]
        self.setup_service(places)
        distances = {7: 1200, 8: 700, 9: 950}
        original = self.context.estimate_route

        async def measured(**kwargs):
            result = await original(**kwargs)
            index = round((kwargs["destinations"][0]["lat"] - 51.09) * 1000)
            result["distance_meters"] = distances[index]
            return result

        self.context.estimate_route = measured
        result = await self.service.recommend(request(query="A long walk please"))
        self.assertEqual([item["place_id"] for item in result["recommendations"]],
                         ["synthetic:place:7", "synthetic:place:9", "synthetic:place:8"])
        self.assertEqual(len(self.context.routes), 3)
        self.assertIn("longer walk", result["recommendations"][0]["why"])

    async def test_ordinary_and_conflicting_pace_preserve_query_relevance(self):
        places = [place(8), place(1), place(5), place(2)]
        for query in ("Museums and coffee", "Not a short walk", "A short walk or a long walk"):
            with self.subTest(query=query):
                self.setup_service(places)
                result = await self.service.recommend(request(query=query))
                self.assertEqual([item["place_id"] for item in result["recommendations"]], [p["id"] for p in places[:3]])
                self.assertEqual(len(self.context.routes), 3)

    async def test_source_category_makes_museum_art_architecture_history_and_views_distinct(self):
        for category, activity, reason in (
            ("museum", "museum topic", "listed as a museum"),
            ("gallery", "available works", "art category"),
            ("architecture", "facades", "architecture category"),
            ("historic", "information signs", "historic or memorial"),
            ("viewpoint", "panorama", "listed as a viewpoint"),
        ):
            with self.subTest(category=category):
                venue = place()
                venue["categories"] = [category]
                self.setup_service([venue])
                result = await self.service.recommend(request(query="Show me something interesting"))
                self.assertIn(activity, result["recommendations"][0]["suggested_activity"])
                self.assertIn(reason, result["recommendations"][0]["why"])


class Planner:
    """The planner knows the user's words, never locations or catalog POIs."""

    def __init__(self, stages, *, order="explicit", error=None):
        self.value = {"provider": "openai", "stages": stages, "order": order,
                      "clarification_questions": [], "warnings": []}
        self.calls = []
        self.error = error

    async def plan(self, query, locale):
        self.calls.append((query, locale))
        if self.error:
            raise self.error
        return deepcopy(self.value)


def planned_stage(quote, *, search=None, kind="activity", name=None, cuisine=None, categories=None):
    stage = {"source_quote": quote, "search_query": search or quote, "kind": kind,
             "named_place": name, "cuisine": cuisine}
    if categories is not None:
        stage["categories"] = categories
    return stage


class PlannedRetriever(Retriever):
    def __init__(self, mapping):
        super().__init__([])
        self.mapping = mapping

    async def retrieve(self, payload):
        self.places = self.mapping.get(payload["query"], [])
        return await super().retrieve(payload)


class PlannedJourneyTests(ServiceSetupMixin, unittest.IsolatedAsyncioTestCase):
    def setup_planned(self, stages, mapping, **kwargs):
        planner = Planner(stages)
        venues = {venue["id"]: venue for group in mapping.values() for venue in group}
        self.setup_service(list(venues.values()), planner=planner, **kwargs)
        self.service.retriever = self.retriever = PlannedRetriever(mapping)
        return planner

    async def test_four_distinct_source_categories_are_forwarded_and_preserved(self):
        stages = [
            planned_stage("The Sphere", kind="named_place", name="The Sphere", categories=["attraction"]),
            planned_stage("read somewhere", search="library", categories=["library"]),
            planned_stage("sushi", kind="meal", cuisine="sushi", categories=["restaurant", "cafe"]),
            planned_stage("watch a film", search="cinema", categories=["cinema"]),
        ]
        venues = [place(index) for index in range(1, 5)]
        for venue, category in zip(venues, ("attraction", "library", "restaurant", "cinema"), strict=True):
            venue["categories"] = [category]
        venues[0]["name"] = "The Sphere"
        venues[2]["facts"] = [fact("osm:cuisine", "sushi")]
        planner = self.setup_planned(stages, {stage["search_query"]: [venue]
                                           for stage, venue in zip(stages, venues, strict=True)})
        query = "The Sphere then read somewhere then sushi then watch a film"
        value = await self.service.recommend(request(query=query))
        self.assertEqual([item["place_id"] for item in value["recommendations"]], [venue["id"] for venue in venues])
        self.assertEqual([payload["categories"] for payload in self.retriever.requests[:len(stages)]],
                         [stage["categories"] for stage in stages])
        self.assertEqual(value["journey_plan"], planner.value)
        self.assertEqual(len(self.context.routes), 4)

    async def test_wrong_source_category_cannot_satisfy_activity_from_incidental_prose(self):
        restaurant = place(1)
        restaurant.update(categories=["restaurant"], description="Near the postcard shop and swimming pool.")
        stages = [planned_stage("postcard shop", categories=["shop"]),
                  planned_stage("swimming pool", categories=["swimming_pool"])]
        self.setup_planned(stages, {stage["search_query"]: [restaurant] for stage in stages})
        value = await self.service.recommend(request(query="postcard shop then swimming pool"))
        self.assertEqual(value["status"], "no_match")
        self.assertEqual(value["places"], [])
        self.assertEqual(value["clarification_questions"], [])
        self.assertFalse(self.context.routes)
        self.assertFalse(self.context.context_requests)
        self.assertIn("stage 1", " ".join(value["warnings"]))
        self.assertIn("stage 2", " ".join(value["warnings"]))

    async def test_semantic_six_goal_plan_named_food_culture_coffee_shop_and_park(self):
        stages = [
            planned_stage("The Sphere", kind="named_place", name="The Sphere"),
            planned_stage("a sushi lunch", search="sushi", kind="meal", cuisine="sushi"),
            planned_stage("a little culture", search="museum"),
            planned_stage("a caffeine break", search="coffee"),
            planned_stage("buy a book", search="bookshop"),
            planned_stage("some greenery", search="park"),
        ]
        venues = [place(index) for index in range(1, 7)]
        for venue, category in zip(venues, ("attraction", "restaurant", "museum", "cafe", "shop", "park"), strict=True):
            venue["categories"] = [category]
        venues[0]["name"] = "The Sphere"
        venues[1]["facts"] = [fact("osm:cuisine", "sushi")]
        mapping = {stage["search_query"]: [venue] for stage, venue in zip(stages, venues, strict=True)}
        planner = self.setup_planned(stages, mapping, generator=Generator())
        query = "First " + " then ".join(stage["source_quote"] for stage in stages)
        value = await self.service.recommend(request(query=query, limit=3))
        self.assertEqual([item["place_id"] for item in value["recommendations"]], [venue["id"] for venue in venues])
        self.assertEqual(planner.calls, [(query, "en")])
        self.assertEqual(value["journey_plan"], planner.value)
        self.assertEqual(value["request"]["limit"], 3)
        self.assertEqual(len(self.context.routes), 6)
        self.assertLessEqual(self.context.max_routes, 4)
        self.assertEqual(len(self.service.generator.calls), 0)
        self.assertEqual([payload["query"] for payload in self.retriever.requests], list(mapping))
        self.assertEqual(self.retriever.requests[0]["named_place"], "The Sphere")
        self.assertEqual(self.retriever.requests[1]["cuisine"], "sushi")
        self.assertEqual(sum(payload["candidate_limit"] for payload in self.retriever.requests), 24)
        self.assertIn("sushi", value["recommendations"][1]["why"])
        self.assertIn("meal stop", value["recommendations"][1]["suggested_activity"])

    async def test_single_concrete_goal_returns_one_stop_and_empty_plan_keeps_discovery(self):
        stages = [planned_stage("a museum", search="museum")]
        self.setup_planned(stages, {"museum": [place(1), place(2), place(3)]})
        value = await self.service.recommend(request(query="I want a museum", limit=3))
        self.assertEqual(len(value["recommendations"]), 1)
        self.setup_service([place(1), place(2), place(3)], planner=Planner([]))
        with patch("astana_recommender.service.stage_matches", side_effect=AssertionError("legacy matcher called")):
            value = await self.service.recommend(request(query="Suggest an interesting walk"))
        self.assertEqual(len(value["recommendations"]), 3)
        self.assertEqual(value["journey_plan"]["stages"], [])

    async def test_model_order_handles_after_relation_instead_of_textual_order(self):
        stages = [planned_stage("sushi", kind="meal", cuisine="sushi"), planned_stage("museum")]
        self.setup_planned(stages, {"sushi": [place(2)], "museum": [place(1)]})
        value = await self.service.recommend(request(query="Visit a museum after sushi"))
        self.assertEqual([item["place_id"] for item in value["recommendations"]], [place(2)["id"], place(1)["id"]])
        self.assertEqual(value["journey_plan"]["order"], "explicit")

    async def test_unresolved_and_unmatched_goals_remain_visible_without_substitutes(self):
        stages = [planned_stage("coffee"), planned_stage("something impossible", kind="unresolved"),
                  planned_stage("Unknown Palace", kind="named_place", name="Unknown Palace"), planned_stage("bookshop")]
        self.setup_planned(stages, {"coffee": [place(1)], "bookshop": [place(4)]})
        value = await self.service.recommend(request(query="coffee, something impossible, Unknown Palace, bookshop"))
        self.assertEqual([item["place_id"] for item in value["recommendations"]], [place(1)["id"], place(4)["id"]])
        self.assertTrue(value["recommendations"][0]["why"].startswith("Stage 1"))
        self.assertTrue(value["recommendations"][1]["why"].startswith("Stage 4"))
        self.assertEqual(len(value["journey_plan"]["stages"]), 4)
        self.assertIn("stage 2", " ".join(value["warnings"]))
        self.assertIn("stage 3", " ".join(value["warnings"]))
        self.assertEqual(value["status"], "partial")
        self.assertEqual(len(self.retriever.requests), 3)

    async def test_eight_extracted_goals_keep_coverage_and_warn_about_six_stop_bound(self):
        stages = [planned_stage(f"goal {index}") for index in range(1, 9)]
        self.setup_planned(stages, {stage["search_query"]: [place(index)]
                                  for index, stage in enumerate(stages, start=1)})
        value = await self.service.recommend(request(query=" then ".join(stage["source_quote"] for stage in stages), limit=1))
        self.assertEqual(len(value["recommendations"]), 6)
        self.assertEqual(len(value["journey_plan"]["stages"]), 8)
        self.assertEqual(value["request"]["limit"], 1)
        self.assertIn("6 requested stops", " ".join(value["warnings"]))
        self.assertEqual(len(self.context.routes), 6)
        self.assertEqual(value["status"], "partial")

    async def test_unresolved_goals_do_not_consume_the_six_concrete_stop_slots(self):
        stages = [planned_stage("unclear first", kind="unresolved")]
        stages.extend(planned_stage(f"goal {index}") for index in range(1, 7))
        stages.insert(3, planned_stage("unclear middle", kind="unresolved"))
        self.setup_planned(stages, {stage["search_query"]: [place(index)]
                                  for index, stage in enumerate(stages, start=1) if stage["kind"] != "unresolved"})
        value = await self.service.recommend(request(query=" then ".join(stage["source_quote"] for stage in stages)))
        self.assertEqual(len(value["recommendations"]), 6)
        self.assertEqual(len(self.context.routes), 6)
        self.assertTrue(value["recommendations"][0]["why"].startswith("Stage 2"))
        self.assertTrue(value["recommendations"][-1]["why"].startswith("Stage 8"))
        self.assertIn("stage 1", " ".join(value["warnings"]))
        self.assertIn("stage 4", " ".join(value["warnings"]))
        self.assertNotIn("6 requested stops", " ".join(value["warnings"]))

    async def test_planned_required_constraints_and_soft_time_never_drop_valid_goals(self):
        stages = [planned_stage("museum"), planned_stage("coffee"), planned_stage("shop"), planned_stage("park")]
        rejected = place(9)
        accepted = [place(index, facts=[fact()]) for index in range(1, 5)]
        self.setup_planned(stages, {stage["search_query"]: [rejected, venue]
                                  for stage, venue in zip(stages, accepted, strict=True)})
        value = await self.service.recommend(request(query="museum coffee shop park", available_seconds=60,
                                                     constraints=[constraint()]))
        self.assertEqual([item["place_id"] for item in value["recommendations"]], [venue["id"] for venue in accepted])
        self.assertTrue(all(item["total_duration_seconds"] > 60 for item in value["recommendations"]))
        self.assertTrue(all(payload["constraints"] == [constraint()] for payload in self.retriever.requests))
        self.assertEqual(value["status"], "partial")

    async def test_route_failures_are_bounded_at_six_attempts(self):
        stages = [planned_stage("museum")]
        self.setup_planned(stages, {"museum": [place(index) for index in range(1, 101)]}, candidate_limit=100)
        self.context.route_error = RuntimeError("private provider failure")
        value = await self.service.recommend(request(query="museum"))
        self.assertEqual(len(self.context.routes), 6)
        self.assertEqual(value["status"], "no_match")
        self.assertEqual(value["places"], [])
        self.assertNotIn("private provider failure", json.dumps(value))

    async def test_understood_goal_with_unknown_required_fact_is_no_match_not_ambiguity(self):
        stage = planned_stage("Drinkit", kind="named_place", name="Drinkit", categories=["cafe"])
        venue = place(1)
        venue.update(name="Drinkit", categories=["cafe"])
        self.setup_planned([stage], {"Drinkit": [venue]})
        value = await self.service.recommend(request(query="Drinkit", constraints=[constraint("has_wifi")]))
        self.assertEqual(value["status"], "no_match")
        self.assertEqual(value["places"], [])
        self.assertEqual(value["clarification_questions"], [])
        self.assertIn("stage 1", " ".join(value["warnings"]))
        self.assertFalse(self.context.routes)

    async def test_understood_unavailable_activity_is_no_match_with_coverage_warning(self):
        stage = planned_stage("underwater chess", categories=["chess_club"])
        self.setup_planned([stage], {})
        value = await self.service.recommend(request(query="underwater chess"))
        self.assertEqual(value["status"], "no_match")
        self.assertEqual(value["places"], [])
        self.assertEqual(value["clarification_questions"], [])
        self.assertIn("stage 1", " ".join(value["warnings"]))

    async def test_planner_questions_still_require_clarification_when_no_results(self):
        planner = self.setup_planned([planned_stage("museum")], {})
        planner.value["clarification_questions"] = ["Which museum did you mean?"]
        value = await self.service.recommend(request(query="museum"))
        self.assertEqual(value["status"], "needs_clarification")
        self.assertEqual(value["clarification_questions"], ["Which museum did you mean?"])

    async def test_discovery_route_failures_are_also_bounded(self):
        self.setup_service([place(index) for index in range(1, 101)], planner=Planner([]), candidate_limit=100)
        self.context.route_error = RuntimeError("private provider failure")
        value = await self.service.recommend(request(query="Suggest an interesting walk"))
        self.assertEqual(len(self.context.routes), 6)
        self.assertEqual(value["status"], "no_match")
        self.assertEqual(value["places"], [])

    async def test_early_route_failure_does_not_use_later_goals_first_attempts(self):
        stages = [planned_stage(f"goal {index}") for index in range(1, 7)]
        self.setup_planned(stages, {stage["search_query"]: [place(index), place(index + 10)]
                                  for index, stage in enumerate(stages, start=1)})
        original = self.context.estimate_route

        async def route(**kwargs):
            if kwargs["destinations"][0] == place(1)["location"]:
                self.context.routes.append(deepcopy(kwargs))
                raise RuntimeError("unroutable")
            return await original(**kwargs)

        self.context.estimate_route = route
        value = await self.service.recommend(request(query=" then ".join(stage["source_quote"] for stage in stages)))
        self.assertEqual(len(self.context.routes), 6)
        self.assertEqual([item["place_id"] for item in value["recommendations"]],
                         [place(index)["id"] for index in range(2, 7)])
        self.assertIn("stage 1", " ".join(value["warnings"]))
        self.assertTrue(value["recommendations"][-1]["why"].startswith("Stage 6"))

    async def test_bad_or_unavailable_planner_retains_unresolved_goal_without_legacy_inference(self):
        invalid_plans = [
            Planner([], error=RuntimeError("SECRET provider token")),
            Planner([planned_stage("Invented destination")]),
            Planner([planned_stage("coffee", kind="named_place", name="Another name")]),
        ]
        for planner in invalid_plans:
            with self.subTest(planner=planner):
                self.setup_service([place(1)], planner=planner)
                value = await self.service.recommend(request(query="coffee and Botanical Garden"))
                self.assertEqual(value["status"], "needs_clarification")
                self.assertEqual(value["journey_plan"]["stages"][0]["kind"], "unresolved")
                self.assertEqual(value["places"], [])
                self.assertFalse(self.retriever.requests)
                self.assertFalse(self.context.routes)
                self.assertNotIn("SECRET", json.dumps(value))

    async def test_six_selected_stops_get_one_complete_route_and_context_limit_adapter(self):
        venues = [place(index) for index in range(1, 7)]
        self.setup_service(venues)
        payload = request(query="A six stop outing", place_ids=[venue["id"] for venue in venues], limit=6)
        value = await self.service.build_itinerary(payload)
        self.assertEqual([stop["place_id"] for stop in value["stops"]], payload["place_ids"])
        self.assertEqual(value["request"], payload)
        self.assertEqual(self.context.context_requests[0]["limit"], 3)
        self.assertEqual(len(self.context.routes), 1)
        self.assertEqual(self.context.routes[0]["destinations"], [venue["location"] for venue in venues])
        self.assertEqual(value["total_duration_seconds"], 6 * 1200 + 600)


class BudgetClock:
    def __init__(self):
        self.value = 0.0

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


class RequestBudgetTests(ServiceSetupMixin, unittest.IsolatedAsyncioTestCase):
    async def test_more_thoughtful_planner_gets_its_own_limit_inside_shared_budget(self):
        planner = Planner([])
        original = planner.plan

        async def thoughtful_plan(query, locale):
            await asyncio.sleep(0.06)
            return await original(query, locale)

        planner.plan = thoughtful_plan
        self.setup_service([place(1)], planner=planner, timeout_seconds=0.02,
                           planner_timeout_seconds=0.5, request_budget_seconds=1)
        result = await self.service.recommend(request())
        self.assertEqual(result["journey_plan"], planner.value)
        self.assertEqual(len(result["recommendations"]), 1)

    async def test_planner_limit_rejects_nonpositive_or_nonfinite_values(self):
        for value in (0, -1, True, math.inf, math.nan):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.setup_service(planner_timeout_seconds=value)

    async def test_fast_clock_bounds_retry_waves_and_keeps_completed_stage(self):
        clock = BudgetClock()
        stages = [planned_stage("coffee"), planned_stage("museum")]
        self.setup_service([place(index) for index in range(1, 9)], planner=Planner(stages),
                           request_budget_seconds=1, budget_clock=clock, route_concurrency=1)
        self.service.retriever = PlannedRetriever({"coffee": [place(1)], "museum": [place(i) for i in range(2, 9)]})
        original = self.context.estimate_route
        attempts = []

        async def route(**kwargs):
            attempts.append(kwargs["destinations"][0])
            if kwargs["destinations"][0] != place(1)["location"]:
                clock.advance(0.5)
                raise RuntimeError("unroutable")
            return await original(**kwargs)

        self.context.estimate_route = route
        body = request(query="coffee then museum")
        value = await self.service.recommend(body)
        self.assertEqual(value["request"], body)
        self.assertEqual([item["place_id"] for item in value["recommendations"]], [place(1)["id"]])
        self.assertEqual(len(attempts), 3)
        self.assertEqual(clock.value, 1)
        self.assertEqual(value["status"], "partial")
        self.assertIn("stage 2", " ".join(value["warnings"]))
        self.assertIn("processing time budget", " ".join(value["warnings"]))

    async def test_planner_retrieval_and_enrichment_share_one_budget(self):
        clock = BudgetClock()
        planner = Planner([planned_stage("museum")])
        self.setup_service([place(1)], planner=planner, request_budget_seconds=1, budget_clock=clock)
        original_plan, original_retrieve, original_enrich = planner.plan, self.retriever.retrieve, self.context.enrich_places

        async def plan(*args):
            clock.advance(0.25)
            return await original_plan(*args)

        async def retrieve(payload):
            clock.advance(0.25)
            return await original_retrieve(payload)

        async def enrich(**kwargs):
            clock.advance(0.5)
            return await original_enrich(**kwargs)

        planner.plan, self.retriever.retrieve, self.context.enrich_places = plan, retrieve, enrich
        value = await self.service.recommend(request(query="museum"))
        self.assertEqual(value["status"], "no_match")
        self.assertFalse(self.context.routes)
        self.assertIn("processing time budget", " ".join(value["warnings"]))

    async def test_provider_timeout_does_not_prematurely_expire_remaining_request_budget(self):
        self.setup_service([place(1), place(2)], planner=Planner([planned_stage("museum")]),
                           request_budget_seconds=1, budget_clock=BudgetClock())
        original = self.context.estimate_route

        async def route(**kwargs):
            if kwargs["destinations"][0] == place(1)["location"]:
                raise TimeoutError("provider timeout")
            return await original(**kwargs)

        self.context.estimate_route = route
        value = await self.service.recommend(request(query="museum"))
        self.assertEqual([item["place_id"] for item in value["recommendations"]], [place(2)["id"]])
        self.assertNotIn("processing time budget", " ".join(value["warnings"]))

    async def test_short_real_deadline_salvages_fast_route_from_slow_batch(self):
        stages = [planned_stage("coffee"), planned_stage("museum")]
        self.setup_service([place(1), place(2)], planner=Planner(stages), request_budget_seconds=0.08,
                           timeout_seconds=1)
        self.service.retriever = PlannedRetriever({"coffee": [place(1)], "museum": [place(2)]})
        original = self.context.estimate_route
        started, cancelled = [], []

        async def route(**kwargs):
            location = kwargs["destinations"][0]
            started.append(location)
            if location == place(2)["location"]:
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.append(True)
            return await original(**kwargs)

        self.context.estimate_route = route
        start = time.monotonic()
        value = await asyncio.wait_for(self.service.recommend(request(query="coffee then museum")), timeout=0.5)
        self.assertLess(time.monotonic() - start, 0.3)
        self.assertEqual(len(started), 2)
        self.assertEqual(cancelled, [True])
        self.assertEqual([item["place_id"] for item in value["recommendations"]], [place(1)["id"]])
        self.assertEqual(value["status"], "partial")
        self.assertIn("processing time budget", " ".join(value["warnings"]))

    async def test_expired_enrichment_keeps_required_dynamic_fact_fail_closed(self):
        self.setup_service([place(1, facts=[fact("open_at_requested_time")])], planner=Planner([]),
                           request_budget_seconds=0.05)

        async def enrich(**kwargs):
            await asyncio.Event().wait()

        self.context.enrich_places = enrich
        value = await asyncio.wait_for(self.service.recommend(request(
            constraints=[constraint("open_at_requested_time")],
        )), timeout=0.5)
        self.assertEqual(value["status"], "no_match")
        self.assertEqual(value["places"], [])
        self.assertFalse(self.context.routes)
        self.assertIn("processing time budget", " ".join(value["warnings"]))

    async def test_itinerary_fetch_deadline_never_drops_selected_stop_and_next_request_gets_fresh_budget(self):
        self.setup_service([place(1), place(2)], request_budget_seconds=0.05)
        original = self.repo.get
        cancelled = []

        async def fetch(place_id):
            if place_id == place(2)["id"]:
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.append(True)
            return await original(place_id)

        self.repo.get = fetch
        body = request(place_ids=[place(1)["id"], place(2)["id"]])
        value = await asyncio.wait_for(self.service.build_itinerary(body), timeout=0.5)
        self.assertEqual(value["request"], body)
        self.assertEqual(value["status"], "no_match")
        self.assertEqual(value["stops"], [])
        self.assertIsNone(value["route"])
        self.assertEqual(cancelled, [True])
        self.assertFalse(self.context.routes)
        self.repo.get = original
        fresh = await self.service.build_itinerary(body)
        self.assertEqual(fresh["status"], "matched")
        self.assertEqual(len(fresh["stops"]), 2)
        self.assertNotIn("processing time budget", " ".join(fresh["warnings"]))

    async def test_legacy_explanations_fall_back_with_verified_stops_before_shared_deadline(self):
        generator = Generator()
        self.setup_service([place(1), place(2), place(3)], generator=generator, request_budget_seconds=0.06)
        cancelled = []

        async def generate(**kwargs):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.append(True)

        generator.generate = generate
        value = await asyncio.wait_for(self.service.recommend(request()), timeout=0.5)
        self.assertEqual(len(value["recommendations"]), 3)
        self.assertEqual(len(cancelled), 3)
        self.assertEqual(value["status"], "partial")
        self.assertIn("processing time budget", " ".join(value["warnings"]))

    async def test_itinerary_route_deadline_returns_no_match_without_inventing_complete_route(self):
        self.setup_service([place(1), place(2)], request_budget_seconds=0.05)
        cancelled = []

        async def route(**kwargs):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.append(True)

        self.context.estimate_route = route
        body = request(place_ids=[place(1)["id"], place(2)["id"]])
        value = await asyncio.wait_for(self.service.build_itinerary(body), timeout=0.5)
        self.assertEqual(value["request"], body)
        self.assertEqual(value["status"], "no_match")
        self.assertEqual(value["stops"], [])
        self.assertIsNone(value["route"])
        self.assertEqual(value["total_duration_seconds"], 0)
        self.assertEqual(cancelled, [True])
        self.assertIn("processing time budget", " ".join(value["warnings"]))

    async def test_concurrent_requests_have_independent_deadlines(self):
        self.setup_service([place(1)], planner=Planner([]), request_budget_seconds=0.3)
        original = self.context.estimate_route
        first_started, second_started, release_second = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def route(**kwargs):
            if kwargs["origin"]["lat"] == 51.09:
                first_started.set()
                await asyncio.Event().wait()
            else:
                second_started.set()
                await release_second.wait()
            return await original(**kwargs)

        self.context.estimate_route = route
        first = asyncio.create_task(self.service.recommend(request()))
        await asyncio.wait_for(first_started.wait(), timeout=0.5)
        await asyncio.sleep(0.1)
        second = asyncio.create_task(self.service.recommend(request(origin={"lat": 51.091, "lon": 71.42})))
        await asyncio.wait_for(second_started.wait(), timeout=0.5)
        expired = await asyncio.wait_for(first, timeout=0.5)
        release_second.set()
        fresh = await asyncio.wait_for(second, timeout=0.5)
        self.assertEqual(expired["status"], "no_match")
        self.assertIn("processing time budget", " ".join(expired["warnings"]))
        self.assertEqual(fresh["status"], "matched")
        self.assertEqual(len(fresh["recommendations"]), 1)
        self.assertNotIn("processing time budget", " ".join(fresh["warnings"]))

    async def test_external_cancellation_propagates_and_cancels_provider(self):
        self.setup_service([place(1)], planner=Planner([]))
        started, cancelled = asyncio.Event(), asyncio.Event()

        async def route(**kwargs):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        self.context.estimate_route = route
        task = asyncio.create_task(self.service.recommend(request()))
        await asyncio.wait_for(started.wait(), timeout=0.5)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(cancelled.is_set())

    async def test_request_budget_rejects_nonpositive_or_nonfinite_values(self):
        for value in (0, -1, True, math.inf, math.nan):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.setup_service(request_budget_seconds=value)


if __name__ == "__main__":
    unittest.main()
