"""Opt-in category smoke against a real local snapshot, not a relevance benchmark.

Requires the independently owned astana_city_data package and ASTANA_POI_PATH.
Calls only canonical repository/retriever ports; does not run import or a network API.
"""
import asyncio
import json
import time

from astana_city_data import create_repository
from astana_retrieval import create_retriever


async def main():
    repository = create_repository(config={"mode": "live", "timezone": "Asia/Almaty"})
    retriever = create_retriever(repository=repository, config={"mode": "live"})
    cases = [
        ("coffee-ru", "кофе", "ru", {"cafe"}),
        ("museum-kk", "мұражай", "kk", {"museum"}),
        ("library-en", "library", "en", {"library"}),
        ("walk-kk", "серуен", "kk", {"park", "garden"}),
        ("negation-ru", "Не кафе, а музей", "ru", {"museum"}),
        ("amenities-unknown-en", "quiet cafe with a power socket", "en", {"cafe"}),
        ("no-match-en", "quantum teleportation", "en", set()),
    ]
    report = []
    try:
        for case_id, query, locale, categories in cases:
            started = time.perf_counter()
            result = await retriever.retrieve({
                "query": query, "locale": locale, "origin": {"lat": 51.127, "lon": 71.430},
                "radius_meters": 10000, "candidate_limit": 3, "constraints": [],
            })
            if any(place["is_synthetic"] for place in result["places"]):
                raise AssertionError("real snapshot smoke received synthetic data")
            category_ok = (
                bool(result["places"]) and all(categories.intersection(place["categories"]) for place in result["places"])
                if categories else not result["places"]
            )
            report.append({
                "case_id": case_id, "category_check_passed": category_ok,
                "elapsed_ms": round(1000 * (time.perf_counter() - started)),
                "places": [{"id": place["id"], "name": place["name"]} for place in result["places"]],
                "matched_fact_keys": [hit["matched_fact_keys"] for hit in result["hits"]],
            })
        print(json.dumps({"kind": "real-snapshot-integration-smoke", "relevance_benchmark": False,
                          "passed": all(case["category_check_passed"] for case in report), "cases": report},
                         ensure_ascii=False, indent=2))
        if not all(case["category_check_passed"] for case in report):
            raise SystemExit(1)
    finally:
        await retriever.aclose()
        await repository.aclose()


if __name__ == "__main__":
    asyncio.run(main())
