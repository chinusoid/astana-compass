"""Sequence syntax is explicit; unrelated mixed wishes stay on normal retrieval."""

import pytest

from astana_recommender.journey import journey_stages


@pytest.mark.parametrize(("query", "expected"), [
    ("Сначала кофе, а потом парк", ("кофе", "парк")),
    ("Сперва кофе, затем музей, после этого парк", ("кофе", "музей", "парк")),
    ("Coffee and then park", ("Coffee", "park")),
    ("First coffee; after that a park", ("coffee", "a park")),
    ("Алдымен кофе, содан кейін саябақ", ("кофе", "саябақ")),
    ("Әуелі мұражай, сосын саябақ", ("мұражай", "саябақ")),
    ("First coffee then", ("coffee", "")),
    ("First coffee then then park", ("coffee", "", "park")),
])
def test_explicit_sequence_preserves_destination_clauses_and_empty_stages(query, expected):
    assert journey_stages(query) == expected


@pytest.mark.parametrize("query", [
    "Парки, кофе и архитектура", "Coffee and parks", "Парки и набережная",
    "Coffee next to the park", "Then Coffee", "сначала кофе", "Саябақ және кафе",
])
def test_no_sequence_is_invented_for_mixed_queries_or_spatial_anchors(query):
    assert journey_stages(query) == ()


def test_clause_count_stays_bounded_for_long_input():
    stages = journey_stages(" then ".join(["coffee"] * 100))
    assert len(stages) == 4
