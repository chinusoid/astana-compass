"""Deterministic cross-reference and recommendation policy invariants."""
from __future__ import annotations

from typing import Any

def unique(items: list[Any], label: str) -> None:
    if len(items) != len(set(items)):
        raise ValueError(f"duplicate {label}")


def same_value(left: Any, right: Any) -> bool:
    # Python treats True == 1; JSON booleans are not numeric constraints.
    if isinstance(left, bool) != isinstance(right, bool):
        return False
    if isinstance(left, list) or isinstance(right, list):
        return (isinstance(left, list) and isinstance(right, list)
                and len(left) == len(right)
                and all(same_value(a, b) for a, b in zip(left, right)))
    return left == right


def validate_place(place: dict[str, Any]) -> None:
    evidence = {item["id"]: item for item in place["evidence"]}
    unique([item["id"] for item in place["evidence"]], "evidence id")
    unique([fact["key"] for fact in place["facts"]], "fact key")
    for fact in place["facts"]:
        if not set(fact["evidence_ids"]).issubset(evidence):
            raise ValueError("fact references missing place evidence")
    if place["is_synthetic"] != any(e["is_synthetic"] for e in evidence.values()):
        raise ValueError("place synthetic marker does not match its evidence")
    if not place["is_synthetic"] and place["id"].startswith("synthetic:"):
        raise ValueError("synthetic place id must be marked synthetic")


def check_route(route: dict[str, Any], request: dict[str, Any]) -> None:
    if route["transport"] != request["transport"]:
        raise ValueError("route transport does not match request")
    if route["includes_return"] != request["return_to_origin"]:
        raise ValueError("route return flag does not match request")
    unique([e["id"] for e in route["evidence"]], "route evidence id")
    if route["distance_meters"] > 0 and route["duration_seconds"] == 0:
        raise ValueError("nonzero travel distance requires nonzero travel duration")


def check_constraints(
    evaluations: list[dict[str, Any]], request: dict[str, Any], place: dict[str, Any]
) -> None:
    unique([e["key"] for e in evaluations], "constraint evaluation key")
    by_key = {e["key"]: e for e in evaluations}
    constraints = {c["key"]: c for c in request["constraints"]}
    if by_key.keys() != constraints.keys():
        raise ValueError("every requested constraint must have exactly one evaluation")
    facts = {f["key"]: f for f in place["facts"]}
    evidence = {e["id"] for e in place["evidence"]}
    for key, constraint in constraints.items():
        evaluation = by_key[key]
        if evaluation["strength"] != constraint["strength"]:
            raise ValueError("constraint strength changed")
        if not set(evaluation["evidence_ids"]).issubset(evidence):
            raise ValueError("constraint references missing place evidence")
        fact = facts.get(key)
        if fact is None or fact["status"] != "known":
            expected = "unknown"
        else:
            expected = "satisfied" if same_value(fact["value"], constraint["value"]) else "unsatisfied"
        if evaluation["outcome"] != expected:
            raise ValueError("constraint outcome does not match known place fact")
        if expected != "unknown" and not set(fact["evidence_ids"]).issubset(evaluation["evidence_ids"]):
            raise ValueError("known constraint evaluation must cite supporting fact evidence")
        if constraint["strength"] == "required" and expected != "satisfied":
            raise ValueError("required constraint is not verified satisfied")


def validate_invariants(definition: str, instance: dict[str, Any]) -> None:
    if definition in {"RecommendationRequest", "ItineraryRequest", "RetrievalRequest"}:
        unique([c["key"] for c in instance["constraints"]], "constraint key")
        if definition == "ItineraryRequest" and len(instance["place_ids"]) > instance["limit"]:
            raise ValueError("selected place count exceeds request limit")
        return
    if definition == "Place":
        validate_place(instance)
        return
    if definition not in {"RecommendationResponse", "ItineraryResponse", "RetrievalResponse", "ContextResult", "PlaceListResponse"}:
        return
    places = {p["id"]: p for p in instance["places"]}
    unique([p["id"] for p in instance["places"]], "place id")
    for place in places.values():
        validate_place(place)
    if definition in {"ContextResult", "PlaceListResponse"}:
        return
    if definition == "RetrievalResponse":
        unique([h["place_id"] for h in instance["hits"]], "retrieval hit")
        if {h["place_id"] for h in instance["hits"]} != places.keys():
            raise ValueError("retrieval hits and returned places must resolve exactly")
        for hit in instance["hits"]:
            if not set(hit["matched_fact_keys"]).issubset({f["key"] for f in places[hit["place_id"]]["facts"]}):
                raise ValueError("retrieval hit references missing fact")
        return
    request = instance["request"]
    validate_invariants("ItineraryRequest" if definition == "ItineraryResponse" else "RecommendationRequest", request)
    key = "recommendations" if definition == "RecommendationResponse" else "stops"
    items = instance[key]
    plan = instance.get("journey_plan") if definition == "RecommendationResponse" else None
    if plan is not None:
        for stage in plan["stages"]:
            if stage["source_quote"] not in request["query"]:
                raise ValueError("journey stage must cite the original query")
            if stage["named_place"] is not None and stage["named_place"] not in stage["source_quote"]:
                raise ValueError("named journey destination must be quoted by the user")
    concrete_stages = sum(stage["kind"] != "unresolved" for stage in plan["stages"]) if plan else 0
    limit = min(6, concrete_stages) if concrete_stages else request["limit"]
    if len(items) > limit:
        raise ValueError("response exceeds requested limit")
    if request["transport"] != "walking":
        raise ValueError("initial release must return unsupported_transport ErrorResponse")
    unique([item["place_id"] for item in items], "recommended place")
    if {item["place_id"] for item in items} != places.keys():
        raise ValueError("recommended place references and returned places must resolve exactly")
    rank_key = "rank" if key == "recommendations" else "order"
    if [item[rank_key] for item in items] != list(range(1, len(items) + 1)):
        raise ValueError("recommendations/stops must have contiguous ordered ranks")
    for item in items:
        check_constraints(item["constraint_evaluations"], request, places[item["place_id"]])
        if key == "recommendations":
            check_route(item["route"], request)
            if item["total_duration_seconds"] != item["visit_duration_seconds"] + item["route"]["duration_seconds"]:
                raise ValueError("recommendation total must include visit and all travel")
    if key == "stops" and items:
        if [item["place_id"] for item in items] != request["place_ids"]:
            raise ValueError("itinerary must preserve all selected place IDs in requested order")
        check_route(instance["route"], request)
        expected = instance["route"]["duration_seconds"] + sum(s["visit_duration_seconds"] for s in items)
        if instance["total_duration_seconds"] != expected:
            raise ValueError("itinerary total must include every visit and complete route")

