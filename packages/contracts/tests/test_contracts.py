"""Behavioral boundary checks: privacy, deterministic policy, packaging resources."""
from __future__ import annotations

from copy import deepcopy
from importlib.resources import files
import json
import math
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from astana_contracts import (
    ContextProvider, ContractValidationError, PlaceRepository,
    RecommendationService, Retriever, load_schema, validate, validate_payload,
)
from astana_contracts.validation import load_examples


class ContractsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.cases = load_examples()["cases"]
        self.valid = deepcopy(next(case["instance"] for case in self.cases if case["name"] == "recommendations_valid"))

    def test_all_canonical_positive_and_negative_fixtures(self) -> None:
        self.assertGreaterEqual(len(self.cases), 25)
        for case in self.cases:
            with self.subTest(case=case["name"]):
                if case["valid"]:
                    self.assertIs(validate_payload(case["definition"], case["instance"]), case["instance"])
                else:
                    with self.assertRaises(ContractValidationError) as caught:
                        validate_payload(case["definition"], case["instance"])
                    self.assertEqual(caught.exception.stage, case["failure_stage"])

    def test_validation_preserves_identity_and_does_not_mutate(self) -> None:
        original = deepcopy(self.valid)
        self.assertIs(validate_payload("RecommendationResponse", self.valid), self.valid)
        self.assertEqual(self.valid, original)
        self.assertIs(validate, validate_payload)

    def test_loaded_schema_cannot_mutate_runtime(self) -> None:
        schema = load_schema()
        schema["$defs"].clear()
        self.assertIn("RecommendationResponse", load_schema()["$defs"])
        validate_payload("RecommendationResponse", self.valid)

    def test_error_never_exposes_private_payload(self) -> None:
        private = "USER_PRIVATE_LOCATION_AND_QUERY_51.091_71.412"
        request = deepcopy(self.valid["request"])
        request["locale"] = private
        with self.assertRaises(ContractValidationError) as caught:
            validate_payload("RecommendationRequest", request)
        error = caught.exception
        self.assertEqual(error.path, ("locale",))
        self.assertEqual(error.code, "contract_schema_violation")
        self.assertNotIn(private, str(error))
        self.assertNotIn(private, repr(error))
        self.assertNotIn(private, json.dumps(error.as_dict()))

    def test_unknown_definition_does_not_echo_user_controlled_name(self) -> None:
        with self.assertRaises(ContractValidationError) as caught:
            validate_payload("secret\nprovider-token", {})
        self.assertEqual(caught.exception.definition, "<unknown>")
        self.assertNotIn("provider-token", json.dumps(caught.exception.as_dict()))

    def test_nonfinite_numbers_and_cycles_are_not_json(self) -> None:
        for value in (math.nan, math.inf, -math.inf):
            with self.subTest(value=value), self.assertRaises(ContractValidationError) as caught:
                validate_payload("Location", {"lat": value, "lon": 71})
            self.assertEqual(caught.exception.code, "invalid_json")
        cyclic = {}
        cyclic["self"] = cyclic
        with self.assertRaises(ContractValidationError):
            validate_payload("Location", cyclic)

    def test_required_unknown_fails_without_mutating_payload(self) -> None:
        fact = self.valid["places"][0]["facts"][0]
        fact.update(status="unknown", value=None, evidence_ids=[])
        evaluation = self.valid["recommendations"][0]["constraint_evaluations"][0]
        evaluation.update(outcome="unknown", evidence_ids=[])
        original = deepcopy(self.valid)
        with self.assertRaises(ContractValidationError) as caught:
            validate_payload("RecommendationResponse", self.valid)
        self.assertEqual(caught.exception.stage, "invariant")
        self.assertEqual(self.valid, original)

    def test_unknown_preference_can_remain_with_honest_evaluation(self) -> None:
        self.valid["request"]["constraints"][0]["strength"] = "preferred"
        self.valid["places"][0]["facts"][0].update(status="unknown", value=None, evidence_ids=[])
        self.valid["recommendations"][0]["constraint_evaluations"][0].update(
            strength="preferred", outcome="unknown", evidence_ids=[]
        )
        self.valid["status"] = "partial"
        validate_payload("RecommendationResponse", self.valid)

    def test_grounded_scenario_may_cover_more_goals_than_the_alternative_limit(self) -> None:
        response = deepcopy(self.valid)
        response["request"].update(query="кофе, музей, парк, книги", limit=1)
        response["journey_plan"] = {
            "provider": "openai", "order": "explicit", "warnings": [], "clarification_questions": [],
            "stages": [{"source_quote": quote, "search_query": quote, "kind": "activity",
                        "named_place": None, "cuisine": None}
                       for quote in ("кофе", "музей", "парк", "книги")],
        }
        place, recommendation = response["places"][0], response["recommendations"][0]
        response["places"], response["recommendations"] = [], []
        for index in range(4):
            copied_place, copied_recommendation = deepcopy(place), deepcopy(recommendation)
            copied_place["id"] = f"synthetic:scenario:{index}"
            copied_recommendation.update(place_id=copied_place["id"], rank=index + 1)
            response["places"].append(copied_place)
            response["recommendations"].append(copied_recommendation)
        validate_payload("RecommendationResponse", response)
        del response["journey_plan"]
        with self.assertRaises(ContractValidationError):
            validate_payload("RecommendationResponse", response)

    def test_scenario_cannot_quote_invented_user_requests(self) -> None:
        response = deepcopy(self.valid)
        response["journey_plan"] = {"provider": "openai", "order": "suggested", "warnings": [],
            "clarification_questions": [], "stages": [{"source_quote": "invented user wish",
                "search_query": "museum", "kind": "activity", "named_place": None, "cuisine": None}]}
        with self.assertRaises(ContractValidationError) as error:
            validate_payload("RecommendationResponse", response)
        self.assertEqual(error.exception.stage, "invariant")

    def test_network_access_not_needed_for_validation(self) -> None:
        with patch("socket.socket", side_effect=AssertionError("network access attempted")):
            validate_payload("RecommendationResponse", self.valid)

    def test_protocol_signatures_are_public_and_async(self) -> None:
        import inspect
        for port, method in ((PlaceRepository, "get"), (PlaceRepository, "list_places"),
                             (PlaceRepository, "nearby"), (PlaceRepository, "data_status"),
                             (Retriever, "retrieve"), (ContextProvider, "enrich_places"),
                             (ContextProvider, "estimate_route"),
                             (RecommendationService, "recommend"),
                             (RecommendationService, "build_itinerary")):
            self.assertTrue(inspect.iscoroutinefunction(getattr(port, method)))

    def test_resources_and_cli_work_from_unrelated_directory(self) -> None:
        self.assertTrue(files("astana_contracts").joinpath("data/contracts.schema.json").is_file())
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [sys.executable, "-m", "astana_contracts.cli"], cwd=directory,
                capture_output=True, text=True, check=False,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"{len(self.cases)} contract fixtures", result.stdout)


if __name__ == "__main__":
    unittest.main()
