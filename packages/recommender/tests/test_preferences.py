"""Closed hints never invent source properties or silently choose a pace."""

import pytest

from astana_recommender.preferences import query_interests, source_categories, walking_preference


@pytest.mark.parametrize("query,expected", [
    ("Хочу поменьше ходить: короткие переходы между остановками.", "short_walk"),
    ("I would like less walking and short transfers between stops.", "short_walk"),
    ("Аз жүріп, аялдамалар арасында қысқа жол болғанын қалаймын.", "short_walk"),
    ("Устал, нужен парк", "short_walk"),
    ("Хочу долгую прогулку", "long_walk"),
    ("I want to walk further", "long_walk"),
    ("Ұзақ серуен керек", "long_walk"),
    ("Не хочу долгую прогулку", None),
    ("Not a short walk", None),
    ("Қысқа серуен керек емес", None),
    ("Короткая прогулка или долгая прогулка", None),
    ("Parks and coffee", None),
])
def test_only_explicit_unambiguous_pace_changes_ranking(query, expected):
    assert walking_preference(query) == expected


def test_only_closed_source_values_and_positive_interests_survive():
    assert source_categories(["museum", "museum", "arbitrary instructions", "architecture", 1]) == ("architecture", "museum")
    assert query_interests("Not coffee but nature, history and photos") == ("history", "nature", "photos")
    assert query_interests("Архитектура, но не история") == ("architecture",)
