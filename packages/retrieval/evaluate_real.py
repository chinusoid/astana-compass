"""Source-informed regression evaluation on one pinned real snapshot, not user quality.

Queries are authored examples, never logged user input. Judgments come from source
names/categories, not retriever output. Run the same script with another checkout's
retrieval/src first on PYTHONPATH to compare implementations on identical data.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from pathlib import Path
import statistics
import sys
import time

from astana_city_data import SnapshotRepository
from astana_retrieval import LexicalRetriever
from astana_retrieval.retriever import STRATEGY, distance_meters, same_value

CASES = Path(__file__).parent / "tests" / "fixtures" / "real-snapshot-cases.json"


def static_violations(place, constraints):
    facts = {fact["key"]: fact for fact in place["facts"]}
    return sum(
        constraint["strength"] == "required" and constraint["key"] in facts
        and facts[constraint["key"]]["status"] == "known"
        and constraint["key"] not in {"open_at_requested_time", "weather_suitable"}
        and not same_value(facts[constraint["key"]]["value"], constraint["value"])
        for constraint in constraints
    )


def load_cases(snapshot: Path, cases_path: Path = CASES):
    specification = json.loads(cases_path.read_text(encoding="utf-8"))
    raw = snapshot.read_bytes()
    if hashlib.sha256(raw).hexdigest() != specification["snapshot_sha256"]:
        raise ValueError("evaluation snapshot hash mismatch; judgments must be reviewed before rebinding")
    places = json.loads(raw)["places"]
    lookup = {place["id"]: place for place in places}
    if len(places) != specification["snapshot_places"] or any(place["is_synthetic"] for place in places):
        raise ValueError("evaluation requires the pinned real snapshot")
    for case in specification["cases"]:
        if not set(case["relevant_ids"]).issubset(lookup):
            raise ValueError("evaluation has missing judged IDs")
        if case["kind"] == "category":
            expected = {place_id for place_id, place in lookup.items()
                        if set(case["categories"]).intersection(place["categories"])
                        and not static_violations(place, case.get("constraints", []))
                        and distance_meters(specification["origin"], place["location"]) <= specification["radius_meters"]}
            if expected != set(case["relevant_ids"]):
                raise ValueError("category judgment no longer matches its declared source criterion")
    return specification, lookup


async def evaluate(snapshot: Path, cases_path: Path = CASES):
    specification, lookup = load_cases(snapshot, cases_path)
    repository = SnapshotRepository(snapshot)
    retriever = LexicalRetriever(repository, pool_limit=specification["pool_limit"])
    details = []
    try:
        for case in specification["cases"]:
            request = {
                "query": case["query"], "locale": case["locale"], "origin": specification["origin"],
                "radius_meters": specification["radius_meters"], "candidate_limit": specification["k"],
                "constraints": case.get("constraints", []),
            }
            started = time.perf_counter()
            result = await retriever.retrieve(request)
            elapsed_ms = 1000 * (time.perf_counter() - started)
            actual = [hit["place_id"] for hit in result["hits"]]
            relevant = set(case["relevant_ids"])
            reciprocal = next((1 / (index + 1) for index, value in enumerate(actual) if value in relevant), 0)
            violations, unsupported_evidence = 0, 0
            for place in result["places"]:
                if distance_meters(request["origin"], place["location"]) > request["radius_meters"]:
                    violations += 1
                facts = {fact["key"]: fact for fact in place["facts"]}
                violations += static_violations(place, request["constraints"])
                hit = next(hit for hit in result["hits"] if hit["place_id"] == place["id"])
                unsupported_evidence += sum(key not in facts or facts[key]["status"] != "known"
                                            for key in hit["matched_fact_keys"])
            correct = (
                not actual if case["kind"] == "no_match" else
                bool(actual) and set(actual).issubset(relevant) if case["kind"] == "category" else bool(reciprocal)
            )
            if case.get("requires_anchor_warning"):
                # Locale-specific wording may change; the explicit anchor copy is the extra warning.
                correct = correct and len(result["warnings"]) > 1
            details.append({
                "id": case["id"], "locale": case["locale"], "kind": case["kind"], "passed": correct,
                "reciprocal_rank_at_k": reciprocal if relevant else None,
                "actual": actual, "names": [lookup[value]["name"] for value in actual],
                "known_required_or_radius_violations": violations,
                "unsupported_matched_fact_keys": unsupported_evidence,
                "elapsed_ms": round(elapsed_ms, 2),
            })
    finally:
        await retriever.aclose()
        await repository.aclose()
    timings = sorted(item["elapsed_ms"] for item in details)
    named = [item for item in details if item["kind"] == "named"]
    return {
        "dataset": specification["dataset"], "judgment_kind": specification["judgment_kind"],
        "independent_human_quality": False, "snapshot_sha256": specification["snapshot_sha256"],
        "snapshot_places": len(lookup), "strategy": STRATEGY,
        "pool_limit": specification["pool_limit"], "k": specification["k"],
        "passed": sum(item["passed"] for item in details), "total": len(details),
        "named_mrr_at_k": sum(item["reciprocal_rank_at_k"] for item in named) / len(named),
        "by_locale": {locale: {"passed": sum(item["passed"] for item in details if item["locale"] == locale),
                               "total": sum(item["locale"] == locale for item in details)} for locale in ("ru", "kk", "en")},
        "by_kind": {kind: {"passed": sum(item["passed"] for item in details if item["kind"] == kind),
                           "total": sum(item["kind"] == kind for item in details)} for kind in ("named", "category", "no_match")},
        "known_required_or_radius_violations": sum(item["known_required_or_radius_violations"] for item in details),
        "queries_with_required_constraints": sum(any(c["strength"] == "required" for c in case.get("constraints", []))
                                                 for case in specification["cases"]),
        "unsupported_matched_fact_keys": sum(item["unsupported_matched_fact_keys"] for item in details),
        "single_run_latency_ms": {"median": statistics.median(timings), "p95": timings[int(0.95 * (len(timings) - 1))]},
        "cases": details,
    }


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = asyncio.run(evaluate(args.snapshot))
    encoded = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)
