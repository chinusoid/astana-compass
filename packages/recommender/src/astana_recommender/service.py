"""Bounded recommendation orchestration with deterministic final policy checks."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
import time
from typing import Any, TypeVar
from uuid import uuid4

from astana_contracts import (
    JSON,
    ContextProvider,
    JourneyPlanner,
    PlaceRepository,
    Retriever,
    validate_payload,
)

from .explanations import ExplanationGenerator, GroundedExplanation, GroundedReason
from .journey import botanical_destination, cuisine_fact, food_intent, journey_stages, pizza_fact, stage_matches
from .preferences import walking_preference
from .text import TEXT, label


DYNAMIC_FACT_KEYS = frozenset({"open_at_requested_time", "weather_suitable"})
_Result = TypeVar("_Result")


@dataclass
class _WorkBudget:
    deadline: float
    clock: Callable[[], float]
    exhausted: bool = False

    def remaining(self) -> float:
        return 0.0 if self.exhausted else max(0.0, self.deadline - self.clock())


# Each request task and its children inherit their own deadline and expiry flag. A
# shared service can handle overlapping requests without overwriting budgets.
_WORK_BUDGET: ContextVar[_WorkBudget | None] = ContextVar("recommender_work_budget", default=None)


class RecommenderError(ValueError):
    """Safe public service failure for the HTTP adapter to map."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


def _same_value(left: Any, right: Any) -> bool:
    """JSON equality, preserving the distinction between booleans and numbers."""
    if isinstance(left, bool) != isinstance(right, bool):
        return False
    if isinstance(left, list) or isinstance(right, list):
        return (
            isinstance(left, list)
            and isinstance(right, list)
            and len(left) == len(right)
            and all(_same_value(a, b) for a, b in zip(left, right, strict=True))
        )
    return left == right


def _dedupe(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))


def _category_family(place: JSON) -> str:
    """Use stable source categories, not richer prose, for broad variety."""
    categories = set(place["categories"])
    for family, values in (
        ("green", {"park", "garden"}), ("cafe", {"cafe", "coffee_shop"}),
        ("art", {"art", "gallery", "arts_centre", "artwork"}),
    ):
        if categories.intersection(values):
            return family
    return min(categories)


def _diverse_lexical_hits(hits: list[JSON], places: dict[str, JSON]) -> list[JSON]:
    """Preserve broad variety within comparable lexical relevance.

    A park described as architecture and another described as waterfront are
    still green spaces. Source enrichment must not crowd other equally relevant
    kinds of places out of the small set of returned alternatives.
    """
    if not hits or any(hit["score_kind"] != "lexical" for hit in hits):
        return hits
    selected: list[JSON] = []
    used: set[str] = set()
    remaining = list(hits)
    while remaining:
        index = 0
        if selected:
            best_score = max(hit["score"] for hit in remaining)
            index = next((index for index, hit in enumerate(remaining)
                          if hit["score"] >= 0.75 * best_score
                          and _category_family(places[hit["place_id"]]) not in used), 0)
        hit = remaining.pop(index)
        selected.append(hit)
        used.add(_category_family(places[hit["place_id"]]))
    return selected


class DefaultRecommendationService:
    """Implement the canonical async RecommendationService port.

    No network clients are constructed here. Dependencies own provider I/O.
    Every dependency call is bounded; cancellation is allowed to propagate.
    Source documents and query text are never executed or logged.
    """

    def __init__(
        self,
        repository: PlaceRepository,
        retriever: Retriever,
        context: ContextProvider,
        generator: ExplanationGenerator | None = None,
        *,
        planner: JourneyPlanner | None = None,
        candidate_limit: int = 24,
        radius_meters: float = 10_000,
        timeout_seconds: float = 8,
        planner_timeout_seconds: float | None = None,
        request_budget_seconds: float = 26,
        default_visit_seconds: int = 1_200,
        route_concurrency: int = 4,
        clock: Callable[[], datetime] | None = None,
        budget_clock: Callable[[], float] | None = None,
    ) -> None:
        if type(candidate_limit) is not int or not 1 <= candidate_limit <= 100:
            raise ValueError("candidate_limit must be an integer from 1 to 100")
        if type(default_visit_seconds) is not int or default_visit_seconds < 1:
            raise ValueError("default_visit_seconds must be a positive integer")
        if type(route_concurrency) is not int or not 1 <= route_concurrency <= 16:
            raise ValueError("route_concurrency must be an integer from 1 to 16")
        if (
            isinstance(radius_meters, bool)
            or not math.isfinite(radius_meters)
            or radius_meters <= 0
            or isinstance(timeout_seconds, bool)
            or not math.isfinite(timeout_seconds)
            or timeout_seconds <= 0
            or (planner_timeout_seconds is not None and (
                isinstance(planner_timeout_seconds, bool)
                or not math.isfinite(planner_timeout_seconds)
                or planner_timeout_seconds <= 0
            ))
            or isinstance(request_budget_seconds, bool)
            or not math.isfinite(request_budget_seconds)
            or request_budget_seconds <= 0
        ):
            raise ValueError("radius, timeout and work budget must be positive finite numbers")
        self.repository = repository
        self.retriever = retriever
        self.context = context
        self.generator = generator
        self.planner = planner
        self.candidate_limit = candidate_limit
        self.radius_meters = radius_meters
        self.timeout_seconds = timeout_seconds
        self.planner_timeout_seconds = planner_timeout_seconds if planner_timeout_seconds is not None else timeout_seconds
        self.request_budget_seconds = request_budget_seconds
        self.default_visit_seconds = default_visit_seconds
        self.route_concurrency = route_concurrency
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.budget_clock = budget_clock or time.monotonic

    async def _with_budget(self, operation: Callable[[], Awaitable[JSON]]) -> JSON:
        budget = _WorkBudget(self.budget_clock() + self.request_budget_seconds, self.budget_clock)
        token = _WORK_BUDGET.set(budget)
        try:
            return await operation()
        finally:
            _WORK_BUDGET.reset(token)

    @staticmethod
    def _has_budget() -> bool:
        budget = _WORK_BUDGET.get()
        return budget is None or budget.remaining() > 0

    async def _await(self, operation: Callable[[], Awaitable[_Result]], *, timeout_seconds: float | None = None) -> _Result:
        timeout = self.timeout_seconds if timeout_seconds is None else timeout_seconds
        budget = _WORK_BUDGET.get()
        request_limited = False
        if budget is not None:
            remaining = budget.remaining()
            request_limited = remaining <= timeout
            timeout = min(timeout, remaining)
        if timeout <= 0:
            # Do not construct a coroutine or enter a provider after expiry.
            raise TimeoutError
        scope = asyncio.timeout(timeout)
        try:
            async with scope:
                return await operation()
        except TimeoutError:
            # Event-loop clocks may fire a timer slightly before the injected
            # monotonic clock reaches its deadline. Remember an actual request
            # timer expiry, but do not mistake a provider's own TimeoutError for
            # exhaustion of the request budget.
            if request_limited and scope.expired() and budget is not None:
                budget.exhausted = True
            raise

    def _request(self, definition: str, request: JSON) -> JSON:
        validate_payload(definition, request)
        value = deepcopy(request)
        if value["transport"] != "walking":
            raise RecommenderError("unsupported_transport", TEXT[value["locale"]]["unsupported"])
        return value

    def _base(self, request: JSON, *, itinerary: bool = False) -> JSON:
        now = self.clock()
        if now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("clock must return a timezone-aware datetime")
        base: JSON = {
            "request_id": f"req:{uuid4()}",
            "status": "no_match",
            "request": deepcopy(request),
            "places": [],
            "clarification_questions": [],
            "warnings": [] if self.generator else [TEXT[request["locale"]]["no_model"]],
            "generated_at": now.astimezone(timezone.utc).isoformat(),
        }
        if itinerary:
            base.update(stops=[], route=None, total_duration_seconds=0)
        else:
            base["recommendations"] = []
        return base

    @staticmethod
    def _finish(response: JSON, *, itinerary: bool = False) -> JSON:
        budget = _WORK_BUDGET.get()
        if budget is not None and budget.remaining() <= 0:
            response["warnings"].append(TEXT[response["request"]["locale"]]["work_deadline"])
            if response["status"] == "matched":
                response["status"] = "partial"
        response["warnings"] = _dedupe(response["warnings"])
        return validate_payload(
            "ItineraryResponse" if itinerary else "RecommendationResponse", response
        )

    async def _retrieve(
        self, request: JSON, *, candidate_limit: int | None = None, allow_fallback: bool = True,
        stage: JSON | None = None, apply_legacy_matching: bool = True,
    ) -> tuple[list[JSON], list[str], bool]:
        locale = request["locale"]
        limit = self.candidate_limit if candidate_limit is None else candidate_limit
        payload = {
            "query": request["query"],
            "locale": locale,
            "origin": deepcopy(request["origin"]),
            "radius_meters": self.radius_meters,
            "constraints": deepcopy(request["constraints"]),
            "candidate_limit": limit,
        }
        if stage is not None:
            # These are grounded extraction filters, never model-generated POI
            # identities. The retriever verifies them against catalog sources.
            payload.update(named_place=stage["named_place"], cuisine=stage["cuisine"],
                           categories=deepcopy(stage.get("categories", [])))
        validate_payload("RetrievalRequest", payload)
        try:
            result = await self._await(lambda: self.retriever.retrieve(payload))
            validate_payload("RetrievalResponse", result)
            places = {p["id"]: p for p in result["places"]}
            requested_categories = set(stage.get("categories", [])) if stage is not None else set()
            candidates = [
                deepcopy(places[h["place_id"]])
                for h in _diverse_lexical_hits(result["hits"][:limit], places)
                if (not requested_categories or requested_categories.intersection(places[h["place_id"]]["categories"]))
                and (stage is not None or not apply_legacy_matching or stage_matches(places[h["place_id"]], request["query"]))
            ]
            return candidates, list(result["warnings"]), False
        except Exception:
            # Never echo provider exceptions: they may contain tokens or raw input.
            if not allow_fallback:
                return [], [TEXT[locale]["stage_search_failed"]], True
            warnings = [TEXT[locale]["retrieval_failed"]]
        try:
            nearby = await self._await(
                lambda: self.repository.nearby(
                    origin=deepcopy(request["origin"]),
                    radius_meters=self.radius_meters,
                    limit=limit,
                ),
            )
            if type(nearby) is not list:
                raise ValueError("invalid repository result")
            candidates = []
            seen = set()
            for place in nearby[:limit]:
                validate_payload("Place", place)
                if place["id"] not in seen and stage_matches(place, request["query"]):
                    candidates.append(deepcopy(place))
                    seen.add(place["id"])
            return candidates, warnings, True
        except Exception:
            return [], warnings + [TEXT[locale]["data_failed"]], True

    async def _enrich(
        self, candidates: list[JSON], request: JSON
    ) -> tuple[list[JSON], list[str], bool]:
        if not candidates:
            return [], [], False
        # ItineraryRequest has place_ids; the context port takes RecommendationRequest.
        context_request = {k: deepcopy(v) for k, v in request.items() if k != "place_ids"}
        context_request["limit"] = min(context_request["limit"], 3)
        validate_payload("RecommendationRequest", context_request)
        originals = {p["id"]: p for p in candidates}
        try:
            result = await self._await(
                lambda: self.context.enrich_places(
                    places=deepcopy(candidates), request=context_request
                ),
            )
            validate_payload("ContextResult", result)
            enriched = {p["id"]: p for p in result["places"]}
            if enriched.keys() != originals.keys():
                raise ValueError("context changed candidate identities")
            for place_id, place in enriched.items():
                original = originals[place_id]
                for key in ("name", "location", "categories"):
                    if place[key] != original[key]:
                        raise ValueError("context changed stable place data")
                facts = {fact["key"]: fact for fact in place["facts"]}
                for fact in original["facts"]:
                    if fact["key"] not in DYNAMIC_FACT_KEYS and facts.get(fact["key"]) != fact:
                        raise ValueError("context rewrote a static source fact")
                evidence = {item["id"]: item for item in place["evidence"]}
                for item in original["evidence"]:
                    if evidence.get(item["id"]) != item:
                        raise ValueError("context rewrote source evidence")
            warnings = list(result["warnings"])
            degraded = bool(result["degraded_services"])
            if degraded:
                warnings.append(TEXT[request["locale"]]["context_failed"])
            return [deepcopy(enriched[p["id"]]) for p in candidates], warnings, degraded
        except Exception:
            # Never reuse request-time facts from a previous request on context failure.
            fallback = deepcopy(candidates)
            for place in fallback:
                for fact in place["facts"]:
                    if fact["key"] in DYNAMIC_FACT_KEYS:
                        fact.update(status="unknown", value=None, evidence_ids=[])
                        fact.pop("note", None)
            return fallback, [TEXT[request["locale"]]["context_failed"]], True

    @staticmethod
    def _evaluate(place: JSON, request: JSON) -> list[JSON]:
        facts = {fact["key"]: fact for fact in place["facts"]}
        text = TEXT[request["locale"]]
        results = []
        for constraint in request["constraints"]:
            fact = facts.get(constraint["key"])
            if fact is None or fact["status"] != "known":
                outcome = "unknown"
                evidence = list(fact["evidence_ids"]) if fact else []
            else:
                outcome = "satisfied" if _same_value(fact["value"], constraint["value"]) else "unsatisfied"
                evidence = list(fact["evidence_ids"])
            results.append({
                "key": constraint["key"],
                "strength": constraint["strength"],
                "outcome": outcome,
                "evidence_ids": evidence,
                "explanation": text[outcome],
            })
        return results

    @staticmethod
    def _required_ok(evaluations: list[JSON]) -> bool:
        return all(
            e["strength"] != "required" or e["outcome"] == "satisfied"
            for e in evaluations
        )

    @staticmethod
    def _preferences_ok(evaluations: list[JSON]) -> bool:
        return all(
            e["strength"] != "preferred" or e["outcome"] == "satisfied"
            for e in evaluations
        )

    def _visit_seconds(self, place: JSON) -> int:
        for fact in place["facts"]:
            if (
                fact["key"] == "visit_duration_seconds"
                and fact["status"] == "known"
                and type(fact["value"]) is int
                and fact["value"] > 0
            ):
                return fact["value"]
        return self.default_visit_seconds

    @staticmethod
    def _time_warning(total: int, request: JSON) -> str | None:
        extra = total - request["available_seconds"]
        if extra <= 0:
            return None
        return TEXT[request["locale"]]["time_exceeded"].format(
            minutes=math.ceil(total / 60), over_minutes=math.ceil(extra / 60),
        )

    async def _route(self, places: list[JSON], request: JSON) -> JSON | None:
        try:
            route = await self._await(
                lambda: self.context.estimate_route(
                    origin=deepcopy(request["origin"]),
                    destinations=[deepcopy(p["location"]) for p in places],
                    transport=request["transport"],
                    return_to_origin=request["return_to_origin"],
                    start_at=request["start_at"],
                ),
            )
            validate_payload("RouteEstimate", route)
            if route["transport"] != request["transport"]:
                return None
            if route["includes_return"] != request["return_to_origin"]:
                return None
            if route["distance_meters"] > 0 and route["duration_seconds"] == 0:
                return None
            ids = [e["id"] for e in route["evidence"]]
            if len(ids) != len(set(ids)):
                return None
            return deepcopy(route)
        except Exception:
            return None

    @staticmethod
    def _render_reason(place: JSON, reason: GroundedReason, locale: str) -> str:
        fact = next(f for f in place["facts"] if f["key"] == reason.fact_key)
        text = TEXT[locale]
        value = fact["value"]
        rendered = (
            text["yes"] if value is True else text["no"] if value is False
            else json.dumps(value, ensure_ascii=False)
        )
        return (
            f"{label(reason.fact_key, locale)}: {rendered} "
            f"({text['source']}: {', '.join(reason.evidence_ids)})."
        )

    @staticmethod
    def _validate_explanation(result: GroundedExplanation, place: JSON) -> None:
        if not isinstance(result, GroundedExplanation) or type(result.why) is not tuple:
            raise ValueError("invalid generated explanation")
        if result.suggested_activity not in {"observe", "explore", "take_break"}:
            raise ValueError("unverified generated activity")
        if len(result.why) > 8:
            raise ValueError("too many generated reasons")
        facts = {f["key"]: f for f in place["facts"]}
        seen = set()
        for reason in result.why:
            if not isinstance(reason, GroundedReason):
                raise ValueError("invalid generated reason")
            fact = facts.get(reason.fact_key)
            if fact is None or fact["status"] != "known" or reason.fact_key in seen:
                raise ValueError("unverified generated fact")
            if (
                type(reason.evidence_ids) is not tuple
                or len(reason.evidence_ids) != len(set(reason.evidence_ids))
                or set(reason.evidence_ids) != set(fact["evidence_ids"])
            ):
                raise ValueError("unverified generated citation")
            seen.add(reason.fact_key)

    async def _explain(
        self, place: JSON, evaluations: list[JSON], request: JSON, total: int,
        stage: JSON | None = None,
    ) -> tuple[str, str, list[str]]:
        locale = request["locale"]
        text = TEXT[locale]
        reasons = tuple(
            GroundedReason(e["key"], tuple(e["evidence_ids"]))
            for e in evaluations if e["outcome"] == "satisfied"
        )
        result = GroundedExplanation(reasons[:8])
        warnings = []
        # The planner interprets the complete scenario once. Per-stop reasons
        # stay source-grounded without spending another model call for every
        # recommendation and every subsequent itinerary recalculation.
        if self.generator and self.planner is None:
            try:
                generated = await self._await(
                    lambda: self.generator.generate(
                        locale=locale,
                        query=stage["search_query"] if stage is not None else request["query"],
                        place=deepcopy(place),
                        constraint_evaluations=deepcopy(evaluations),
                    ),
                )
                self._validate_explanation(generated, place)
                result = generated
            except Exception:
                warnings.append(text["generation_failed"])
        why = " ".join(
            self._render_reason(place, reason, locale) for reason in result.why
        )
        # The source category is a grounded reason for the intended visit;
        # do not let incidental amenities become the only explanation for a cafe
        # or park. Names/descriptions cannot invent a category or an amenity.
        categories = set(place["categories"])
        purpose = next((key for key, values in (
            ("cafe", {"cafe", "coffee_shop"}), ("park", {"park"}), ("garden", {"garden"}),
            ("museum", {"museum"}), ("art", {"art", "gallery", "arts_centre", "artwork"}),
            ("architecture", {"architecture"}), ("history", {"historic", "monument", "memorial"}),
            ("viewpoint", {"viewpoint"}),
        ) if categories.intersection(values)), None)
        cuisine = pizza_fact(place) if stage is None and food_intent(request["query"]) == "pizza" else None
        if cuisine:
            purpose = "pizza"
            why = " ".join(filter(None, [why, self._render_reason(
                place, GroundedReason(cuisine["key"], tuple(cuisine["evidence_ids"])), locale,
            )]))
        activity = text[result.suggested_activity]
        if purpose:
            why = " ".join(filter(None, [text[f"{purpose}_reason"].format(name=place["name"]), why]))
            activity = text[f"{purpose}_activity"]
        if stage is not None and stage["cuisine"]:
            source_cuisine = cuisine_fact(place, stage["cuisine"])
            if source_cuisine is not None:
                why = " ".join(filter(None, [text["cuisine_reason"].format(
                    name=place["name"], cuisine=stage["cuisine"],
                ), self._render_reason(place, GroundedReason(
                    source_cuisine["key"], tuple(source_cuisine["evidence_ids"]),
                ), locale), why]))
                activity = text["meal_activity"]
        why = why or text["found"]
        why += " " + text["time"].format(minutes=math.ceil(total / 60))
        return why, activity, warnings

    @staticmethod
    def _route_warnings(places: list[JSON], route: JSON, locale: str) -> list[str]:
        warnings = [TEXT[locale]["visit"]]
        if route["method"] == "approximate":
            warnings.append(TEXT[locale]["approximate"])
        if any(p["is_synthetic"] for p in places) or any(
            e["is_synthetic"] for e in route["evidence"]
        ):
            warnings.append(TEXT[locale]["synthetic"])
        return warnings

    async def recommend(self, request: JSON) -> JSON:
        return await self._with_budget(lambda: self._recommend(request))

    async def _recommend(self, request: JSON) -> JSON:
        request = self._request("RecommendationRequest", request)
        response = self._base(request)
        text = TEXT[request["locale"]]
        plan = None
        planned_degraded = False
        if self.planner is not None:
            try:
                plan = await self._await(
                    lambda: self.planner.plan(request["query"], request["locale"]),
                    timeout_seconds=self.planner_timeout_seconds,
                )
                validate_payload("JourneyPlan", plan)
                if any(stage["source_quote"] not in request["query"] or (
                    stage["named_place"] is not None and stage["named_place"] not in stage["source_quote"]
                ) for stage in plan["stages"]):
                    raise ValueError("ungrounded journey plan")
                plan = deepcopy(plan)
            except Exception:
                # Fail closed on unknown wishes. This general fallback retains
                # the user's request as unresolved; it cannot invent a venue or
                # fall through into the old scenario-specific parser.
                plan = {
                    "provider": "rules", "order": "suggested", "stages": [{
                        "source_quote": request["query"][:500],
                        "search_query": request["query"][:300],
                        "kind": "unresolved", "named_place": None, "cuisine": None,
                    }], "clarification_questions": [text["plan_question"]],
                    "warnings": [text["plan_failed"]],
                }
                planned_degraded = True
            response["journey_plan"] = plan
            response["warnings"].extend(plan["warnings"])
            response["clarification_questions"].extend(plan["clarification_questions"])
            # An empty stage list is deliberate broad discovery. Every concrete
            # goal, including a lone meal/name/activity, gets one distinct stop.
            stages = tuple(stage["search_query"] if stage["kind"] != "unresolved" else ""
                           for stage in plan["stages"])
            planned_degraded |= bool(plan["clarification_questions"])
        else:
            stages = journey_stages(request["query"])
        stage_ids: list[list[str]] = []
        missing_stages: list[int] = []
        if stages:
            # Reuse lexical/name retrieval independently for each destination,
            # while keeping the total candidate and provider work bounded.
            stage_limit = 6 if plan is not None else request["limit"]
            if plan is not None:
                concrete = 0
                active_stages = []
                for stage, query in zip(plan["stages"], stages, strict=True):
                    concrete += stage["kind"] != "unresolved"
                    active_stages.append(query if concrete <= stage_limit else "")
                # Unresolved goals retain their original numbers but do not
                # consume a concrete stop slot or provider candidate allowance.
                executable = min(concrete, stage_limit)
                overflow = concrete > stage_limit
            else:
                active_stages = stages[:stage_limit]
                executable = len(active_stages)
                overflow = len(stages) > len(active_stages)
            limit = max(1, self.candidate_limit // max(1, executable))

            async def retrieve_stage(index: int, query: str) -> tuple[list[JSON], list[str], bool]:
                if not query:
                    return [], [], False
                return await self._retrieve(
                    {**request, "query": query}, candidate_limit=limit, allow_fallback=False,
                    stage=plan["stages"][index] if plan is not None else None,
                )

            results = await asyncio.gather(*(retrieve_stage(index, stage)
                                            for index, stage in enumerate(active_stages)))
            unique = {}
            degraded = planned_degraded
            for places, warnings, failed in results:
                stage_ids.append([place["id"] for place in places])
                unique.update((place["id"], place) for place in places)
                response["warnings"].extend(warnings)
                degraded |= failed
            candidates = list(unique.values())
            if overflow:
                response["warnings"].append(text["plan_limit" if plan is not None else "stage_limit"].format(limit=stage_limit))
                degraded = True
        else:
            candidates, warnings, degraded = await self._retrieve(
                request, allow_fallback=plan is None, apply_legacy_matching=plan is None,
            )
            degraded |= planned_degraded
            response["warnings"].extend(warnings)
        candidates, warnings, context_degraded = await self._enrich(candidates, request)
        response["warnings"].extend(warnings)
        degraded |= context_degraded

        eligible = []
        for place in candidates:
            evaluations = self._evaluate(place, request)
            if self._required_ok(evaluations):
                eligible.append((place, evaluations))
        # Preserve the retriever's query relevance and diversity. Preferences
        # remain visible, but cannot replace the user's destination intent.
        route_failed = False
        offset = 0
        selected = []
        selected_stage_orders: list[int] = []
        route_attempts = 0
        pace = walking_preference(request["query"])
        origin = request["origin"]

        def proximity(item: tuple[JSON, list[JSON]], anchor: JSON = origin) -> float:
            location = item[0]["location"]
            return math.hypot(
                location["lat"] - anchor["lat"],
                (location["lon"] - anchor["lon"]) * math.cos(math.radians(anchor["lat"])),
            )

        if pace:
            # Use a geographic heuristic only to choose the small shortlist;
            # it is never presented as a route. Keep normal provider call
            # counts, then rank the returned options by measured route length.
            if not stages:
                eligible = sorted(eligible[:9], key=proximity, reverse=pace == "long_walk")
        if stages:
            by_id = {place["id"]: (place, evaluations) for place, evaluations in eligible}
            groups = [[by_id[place_id] for place_id in ids if place_id in by_id] for ids in stage_ids]
            if plan is None and len(groups) == 2:
                # Select the food stop as part of this journey, rather than an
                # isolated highly ranked cafe across town. Coordinates only
                # choose the bounded shortlist; only the context provider may
                # claim a walking route. Explicit stage order stays unchanged.
                garden_index = next((index for index, stage in enumerate(active_stages)
                                     if botanical_destination(stage)), None)
                if garden_index is not None and groups[garden_index]:
                    food_index = 1 - garden_index
                    if food_intent(active_stages[food_index]):
                        anchors = [groups[garden_index][0][0]["location"]]
                        if food_index == 0 or request["return_to_origin"]:
                            anchors.append(origin)
                        groups[food_index].sort(key=lambda item: sum(proximity(item, anchor) for anchor in anchors))
            if pace:
                groups = [group[:9] for group in groups]
            offsets = [0] * len(groups)
            completed = {}
            used: set[str] = set()
            attempted_stages: set[int] = set()
            while self._has_budget():
                batch = []
                reserved = set(used)
                anchor = request["origin"]
                indices = range(len(groups))
                if plan is not None:
                    # Give every concrete goal its first route attempt before
                    # spending the bounded allowance on an earlier retry.
                    indices = sorted(indices, key=lambda index: index in attempted_stages)
                prospective = {index: value[0]["location"] for index, value in completed.items()}
                for index in indices:
                    group = groups[index]
                    if plan is not None:
                        anchor = next((prospective[previous] for previous in range(index - 1, -1, -1)
                                       if previous in prospective), origin)
                    if index in completed:
                        anchor = completed[index][0]["location"]
                        continue
                    if pace or plan is not None:
                        # Prefer shorter/longer transfers within this stage,
                        # anchored to the preceding chosen stop. This only
                        # selects candidates; measured routes remain explicit
                        # and the requested stage order is never changed.
                        following = next((later[0][0]["location"] for later in groups[index + 1:] if later), None)
                        group[offsets[index]:] = sorted(
                            group[offsets[index]:], key=lambda item: proximity(item, anchor) + (
                                proximity(item, following) if plan is not None and following is not None else 0
                            ),
                            reverse=pace == "long_walk",
                        )
                    while offsets[index] < len(group) and group[offsets[index]][0]["id"] in reserved:
                        offsets[index] += 1
                    if (offsets[index] < len(group) and len(batch) < self.route_concurrency
                            and (plan is None or route_attempts + len(batch) < 6)):
                        item = group[offsets[index]]
                        offsets[index] += 1
                        batch.append((index, item))
                        attempted_stages.add(index)
                        reserved.add(item[0]["id"])
                        anchor = item[0]["location"]
                        prospective[index] = anchor
                if not batch:
                    break
                route_attempts += len(batch)
                routes = await asyncio.gather(*(self._route([item[0]], request) for _, item in batch))
                for (index, (place, evaluations)), route in zip(batch, routes, strict=True):
                    if route is None:
                        route_failed = True
                        continue
                    visit = self._visit_seconds(place)
                    completed[index] = (place, evaluations, route, visit, route["duration_seconds"] + visit)
                    used.add(place["id"])
            for index in range(len(groups)):
                if index in completed:
                    selected.append(completed[index])
                    selected_stage_orders.append(index + 1)
                else:
                    missing_stages.append(index + 1)
            if missing_stages:
                degraded = True
                response["warnings"].extend(text["stage_missing"].format(order=index) for index in missing_stages)
        while (not stages and offset < len(eligible) and len(selected) < request["limit"]
               and (plan is None or route_attempts < 6) and self._has_budget()):
            # Route only as many candidates as can still be returned. A longer
            # outing is a visible alternative, not a reason to scan the pool.
            needed = request["limit"] - len(selected)
            remaining_attempts = 6 - route_attempts if plan is not None else self.route_concurrency
            batch = eligible[offset : offset + min(self.route_concurrency, needed, remaining_attempts)]
            offset += len(batch)
            route_attempts += len(batch)
            routes = await asyncio.gather(*(self._route([item[0]], request) for item in batch))
            for (place, evaluations), route in zip(batch, routes, strict=True):
                if route is None:
                    route_failed = True
                    continue
                visit = self._visit_seconds(place)
                total = route["duration_seconds"] + visit
                selected.append((place, evaluations, route, visit, total))
        if pace and not stages:
            selected.sort(key=lambda item: item[2]["distance_meters"], reverse=pace == "long_walk")
        # Only returned alternatives/stops get generated text. Run their
        # bounded calls together so slow providers use one timeout
        # window, and keep gather's stable input/result ordering.
        explanations = await asyncio.gather(*(
            self._explain(place, evaluations, request, total,
                          plan["stages"][selected_stage_orders[index] - 1]
                          if plan is not None and stages else None)
            for index, (place, evaluations, _, _, total) in enumerate(selected)
        ))
        for (place, evaluations, route, visit, total), explanation in zip(
            selected, explanations, strict=True
        ):
            why, activity, generator_warnings = explanation
            if pace:
                why += " " + text[f"{pace}_reason"].format(meters=round(route["distance_meters"]))
                activity += " " + text[f"{pace}_activity"]
            if stages:
                why = text["stage_found"].format(order=selected_stage_orders[len(response["recommendations"])]) + " " + why
            item_warnings = self._route_warnings([place], route, request["locale"])
            item_warnings.extend(generator_warnings)
            time_warning = self._time_warning(total, request)
            if time_warning:
                item_warnings.append(time_warning)
                degraded = True
            if not self._preferences_ok(evaluations):
                item_warnings.append(text["preferences"])
                degraded = True
            if route["method"] == "approximate" or generator_warnings:
                degraded = True
            recommendation = {
                "place_id": place["id"],
                "rank": len(response["recommendations"]) + 1,
                "why": why,
                "suggested_activity": activity,
                "activity_is_ai_suggestion": True,
                "visit_duration_seconds": visit,
                "visit_duration_is_estimate": True,
                "route": route,
                "total_duration_seconds": total,
                "constraint_evaluations": evaluations,
                "warnings": _dedupe(item_warnings),
            }
            response["places"].append(place)
            response["recommendations"].append(recommendation)
            response["warnings"].extend(item_warnings)
        if route_failed:
            response["warnings"].append(text["route_failed"])
            degraded = True
        if response["recommendations"]:
            response["status"] = "partial" if degraded else "matched"
        else:
            response["warnings"].append(text["no_match"])
            clarification_stages = missing_stages if plan is None else [
                index for index in missing_stages if plan["stages"][index - 1]["kind"] == "unresolved"
            ]
            if clarification_stages or response["clarification_questions"]:
                response["status"] = "needs_clarification"
                response["clarification_questions"] = _dedupe([
                    *response["clarification_questions"],
                    *(text["stage_missing"].format(order=index) for index in clarification_stages),
                ])[:5]
        return self._finish(response)

    async def build_itinerary(self, request: JSON) -> JSON:
        return await self._with_budget(lambda: self._build_itinerary(request))

    async def _build_itinerary(self, request: JSON) -> JSON:
        request = self._request("ItineraryRequest", request)
        response = self._base(request, itinerary=True)
        text = TEXT[request["locale"]]

        async def fetch(place_id: str) -> JSON | None:
            try:
                place = await self._await(lambda: self.repository.get(place_id))
                if place is None:
                    return None
                validate_payload("Place", place)
                return deepcopy(place) if place["id"] == place_id else None
            except Exception:
                return None

        values = await asyncio.gather(*(fetch(place_id) for place_id in request["place_ids"]))
        if any(place is None for place in values):
            response["warnings"].append(text["selected_missing"])
            return self._finish(response, itinerary=True)
        places = [place for place in values if place is not None]
        places, warnings, degraded = await self._enrich(places, request)
        response["warnings"].extend(warnings)
        evaluations = [self._evaluate(place, request) for place in places]
        if not all(self._required_ok(value) for value in evaluations):
            response["warnings"].append(text["selected_constraint"])
            return self._finish(response, itinerary=True)
        route = await self._route(places, request)
        if route is None:
            response["warnings"].append(text["route_failed"])
            return self._finish(response, itinerary=True)
        visits = [self._visit_seconds(place) for place in places]
        total = sum(visits) + route["duration_seconds"]
        time_warning = self._time_warning(total, request)
        if time_warning:
            response["warnings"].append(time_warning)
            degraded = True
        response["warnings"].extend(self._route_warnings(places, route, request["locale"]))
        if route["method"] == "approximate":
            degraded = True
        explanations = await asyncio.gather(*(
            self._explain(place, evaluation, request, total)
            for place, evaluation in zip(places, evaluations, strict=True)
        ))
        for index, (place, evaluation, visit, explanation) in enumerate(
            zip(places, evaluations, visits, explanations, strict=True), start=1
        ):
            _, activity, generator_warnings = explanation
            response["warnings"].extend(generator_warnings)
            if generator_warnings:
                degraded = True
            if not self._preferences_ok(evaluation):
                response["warnings"].append(text["preferences"])
                degraded = True
            response["stops"].append({
                "place_id": place["id"],
                "order": index,
                "visit_duration_seconds": visit,
                "visit_duration_is_estimate": True,
                "suggested_activity": activity,
                "activity_is_ai_suggestion": True,
                "constraint_evaluations": evaluation,
            })
        response.update(
            status="partial" if degraded else "matched",
            places=places,
            route=route,
            total_duration_seconds=total,
        )
        return self._finish(response, itinerary=True)
