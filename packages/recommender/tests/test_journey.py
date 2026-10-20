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
    ("Сначала музей, далее кофе, в конце парк", ("музей", "кофе", "парк")),
    ("First museum, next coffee, finally park", ("museum", "coffee", "park")),
    ("Алдымен мұражай, одан соң кофе, соңында саябақ", ("мұражай", "кофе", "саябақ")),
])
def test_explicit_sequence_preserves_destination_clauses_and_empty_stages(query, expected):
    assert journey_stages(query) == expected


@pytest.mark.parametrize("query", [
    "Парки, кофе и архитектура", "Coffee and parks", "Парки и набережная",
    "Coffee next to the park", "Then Coffee", "сначала кофе", "Саябақ және кафе",
    "Museum next year", "Coffee next door", "A park next time",
])
def test_no_sequence_is_invented_for_mixed_queries_or_spatial_anchors(query):
    assert journey_stages(query) == ()


def test_clause_count_stays_bounded_for_long_input():
    stages = journey_stages(" then ".join(["coffee"] * 100))
    assert len(stages) == 4


@pytest.mark.parametrize(("query", "expected"), [
    ("хочу в ботанический сад сходить и пицу покушать", ("пицу покушать", "Ботанический сад")),
    ("Ботанический сад и пиццы поесть", ("пиццы поесть", "Ботанический сад")),
    ("Пиццу поесть и ботанический сад", ("Пиццу поесть", "Ботанический сад")),
    ("I want to visit the Botanical Garden and eat pizza", ("eat pizza", "Botanical Garden")),
    ("Pizza and the botanical garden", ("Pizza", "Botanical Garden")),
    ("Ботаникалық баққа барғым келеді және пицца жегім келеді", ("пицца жегім келеді", "Ботаникалық бақ")),
    ("Мен Ботаникалық баққа барғым келеді және пицца жегім келеді", ("пицца жегім келеді", "Ботаникалық бақ")),
    ("Botanical Garden, and pizza", ("pizza", "Botanical Garden")),
    ("Ботанический сад и кофе", ("кофе", "Ботанический сад")),
    ("First Botanical Garden and pizza", ("Botanical Garden", "pizza")),
    ("Сначала ботанический сад, потом пицца", ("ботанический сад", "пицца")),
    ("Алдымен ботаникалық бақ, содан кейін пицца", ("ботаникалық бақ", "пицца")),
])
def test_named_garden_and_food_form_core_stages_while_explicit_order_wins(query, expected):
    assert journey_stages(query) == expected


@pytest.mark.parametrize("query", [
    "ботанический сад", "хочу в ботанический сад", "Botanical Garden", "Ботаникалық баққа барғым келеді",
    "Пицца рядом с ботаническим садом", "Pizza near Botanical Garden", "Ботаникалық бақ жанындағы кафе",
    "Ботанический сад и без пиццы", "Ботанический сад и пицца не нужна", "Botanical Garden and no pizza",
    "Ботаникалық бақ және пицца керек емес", "Ботанический сад и пицца жемеймін",
    "Pizza and near Botanical Garden", "Pizza and not Botanical Garden", "Пицца и не ботанический сад",
    "Мен ботаникалық баққа барғым келмейді және пицца",
    "ботанический сад и парк и кофе", "хочу поесть пиццу в ботаническом саду",
])
def test_single_destinations_negations_and_landmark_searches_do_not_invent_a_journey(query):
    assert journey_stages(query) == ()
