"""Small independent judgments; regression floor, never a production-quality claim."""
import asyncio
from pathlib import Path
import runpy


def test_fixed_synthetic_quality_suite_and_negative_queries():
    evaluate = runpy.run_path(str(Path(__file__).parents[1] / "evaluate.py"))["evaluate"]
    report = asyncio.run(evaluate())
    assert report["real_city_quality"] is False
    assert report["query_count"] == 27
    assert report["mean_recall_at_3"] >= 0.90
    assert report["mrr_at_3"] >= 0.90
    assert report["no_match_accuracy"] == 1
