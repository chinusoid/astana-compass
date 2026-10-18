"""Explicitly synthetic, reproducible retrieval evaluation; no network/provider calls.

Run with the package on PYTHONPATH. Real-dataset evaluation needs separate human
judgments; these metrics must never be presented as real-city search quality.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from astana_retrieval import LexicalRetriever
from astana_retrieval.retriever import distance_meters


class SyntheticRepository:
    def __init__(self, places):
        if not all(place["is_synthetic"] and place["id"].startswith("synthetic:") for place in places):
            raise ValueError("this evaluator accepts only clearly synthetic fixtures")
        self.places = places

    async def nearby(self, *, origin, radius_meters, limit=100):
        found = [(distance_meters(origin, place["location"]), place["id"], place) for place in self.places]
        return [place for distance, _, place in sorted(found) if distance <= radius_meters][:limit]


async def evaluate():
    fixture_dir = Path(__file__).parent / "tests" / "fixtures"
    places = json.loads((fixture_dir / "synthetic-corpus.json").read_text(encoding="utf-8"))
    cases = json.loads((fixture_dir / "quality-cases.json").read_text(encoding="utf-8"))
    retriever = LexicalRetriever(SyntheticRepository(places))
    scored, negative, details = [], [], []
    try:
        for case in cases:
            result = await retriever.retrieve({
                "query": case["query"], "locale": case["locale"], "origin": {"lat": 51.1, "lon": 71.4},
                "radius_meters": 5000, "candidate_limit": 3, "constraints": case.get("constraints", []),
            })
            actual = [hit["place_id"] for hit in result["hits"]]
            expected = set(case["relevant"])
            if expected:
                recall = len(expected.intersection(actual)) / len(expected)
                reciprocal = next((1 / (index + 1) for index, item in enumerate(actual) if item in expected), 0)
                scored.append((recall, reciprocal))
                details.append({"id": case["id"], "recall_at_3": recall, "reciprocal_rank": reciprocal, "actual": actual})
            else:
                negative.append(not actual)
                details.append({"id": case["id"], "correct_no_match": not actual, "actual": actual})
    finally:
        await retriever.aclose()
    return {
        "dataset": "independent-synthetic-v1", "seed": "fixed-no-randomness", "real_city_quality": False,
        "query_count": len(cases), "positive_query_count": len(scored), "no_match_query_count": len(negative),
        "mean_recall_at_3": sum(row[0] for row in scored) / len(scored),
        "mrr_at_3": sum(row[1] for row in scored) / len(scored),
        "no_match_accuracy": sum(negative) / len(negative), "cases": details,
    }


if __name__ == "__main__":
    print(json.dumps(asyncio.run(evaluate()), ensure_ascii=False, indent=2))
