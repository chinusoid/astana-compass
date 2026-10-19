"""Behavior tests with explicit synthetic ports; no network or model credentials."""

from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import datetime, timezone
import json
import unittest

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


if __name__ == "__main__":
    unittest.main()
