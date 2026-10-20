"""Semantic planning boundary: every hosted call uses an offline transport."""

import asyncio
from copy import deepcopy
from datetime import datetime, timedelta
import json
from pathlib import Path

import httpx
import pytest

from astana_ai_providers import create_generator, create_journey_planner
from astana_ai_providers.budgets import RequestBudget
from astana_ai_providers.journeys import rules_journey_plan
from astana_contracts import ContractValidationError, validate_payload


SECRET = "offline-private-test-key"


def stage(quote, search=None, *, kind="activity", named=None, cuisine=None, categories=None):
    return {"source_quote": quote, "search_query": search or quote, "kind": kind,
            "named_place": named, "cuisine": cuisine, "categories": categories or []}


def plan(stages, *, provider="openai", order="suggested", questions=None, warnings=None):
    return {"provider": provider, "stages": stages, "order": order,
            "clarification_questions": questions or [], "warnings": warnings or []}


def envelope(value, provider="openai"):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    if provider == "nvidia":
        return {"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": text}}]}
    return {"status": "completed", "output": [{"type": "message", "role": "assistant", "content": [
        {"type": "output_text", "text": text},
    ]}]}


def hosted(query, answer, *, locale="ru", provider="openai", handler=None, **configuration):
    async def execute():
        async with create_journey_planner(
            provider, "gpt-6-luna", SECRET,
            transport=httpx.MockTransport(handler or (lambda _: httpx.Response(200, json=envelope(answer, provider)))),
            **configuration,
        ) as planner:
            return await planner.plan(query, locale)
    return asyncio.run(execute())


@pytest.mark.parametrize("locale,query,stages", [
    ("ru", "Хочу размять пальцы на скалодроме и расписать керамическую кружку", [
        stage("размять пальцы на скалодроме", "скалодром боулдеринг"),
        stage("расписать керамическую кружку", "мастерская роспись керамики"),
    ]),
    ("en", "Browse secondhand books and send a postcard", [
        stage("Browse secondhand books", "secondhand bookshop"),
        stage("send a postcard", "post office postcards"),
    ]),
    ("kk", "Домбыра үйренгім келеді және балмұздақ жегім келеді", [
        stage("Домбыра үйренгім келеді", "домбыра сабағы"),
        stage("балмұздақ жегім келеді", "балмұздақ", kind="meal", cuisine="ice_cream"),
    ]),
])
def test_arbitrary_semantic_paraphrases_are_not_vetoed_by_an_activity_dictionary(locale, query, stages):
    result = hosted(query, plan(stages), locale=locale)
    assert result["provider"] == "openai"
    assert result["stages"] == stages
    validate_payload("JourneyPlan", result)


@pytest.mark.parametrize("provider", ["openai", "nvidia"])
def test_query_only_payload_reuses_bounded_private_transport(provider):
    query = "Хочу кофе и музей"
    answer = plan([stage("кофе", kind="meal"), stage("музей")], provider=provider)
    requests = []

    def handle(request):
        requests.append(request)
        payload = json.loads(request.content)
        assert request.headers["accept-encoding"] == "identity"
        assert payload["model"] == "gpt-6-luna"
        assert "tools" not in payload
        assert not {"temperature", "top_p", "max_completion_tokens", "reasoning_effort"} & payload.keys()
        if provider == "openai":
            assert str(request.url) == "https://api.openai.com/v1/responses"
            assert payload["store"] is False
            assert payload["reasoning"] == {"effort": "low"}
            assert payload["max_output_tokens"] == 4096
            assert payload["text"]["format"]["strict"] is True
            schema = payload["text"]["format"]["schema"]
            assert schema["properties"]["stages"]["maxItems"] == 8
            assert schema["properties"]["stages"]["items"]["properties"]["kind"]["type"] == "string"
            stage_schema = schema["properties"]["stages"]["items"]
            assert set(stage_schema["required"]) == set(stage_schema["properties"])
            assert "categories" in stage_schema["required"]
            data = json.loads(payload["input"][0]["content"])
        else:
            assert str(request.url) == "https://integrate.api.nvidia.com/v1/chat/completions"
            assert payload["max_tokens"] == 3072 and payload["stream"] is False
            assert "reasoning" not in payload
            data = json.loads(payload["messages"][1]["content"])
        assert data == {"query": query, "locale": "ru"}
        assert SECRET not in request.content.decode()
        return httpx.Response(200, json=envelope(answer, provider))

    assert hosted(query, answer, provider=provider, handler=handle)["provider"] == provider
    assert len(requests) == 1


def test_unordered_wishes_allow_logical_meal_first_without_changing_source_quotes():
    query = "Хочу Ботанический сад и пиццу"
    stages = [stage("пиццу", "пицца", kind="meal", cuisine="pizza"),
              stage("Ботанический сад", kind="named_place", named="Ботанический сад")]
    result = hosted(query, plan(stages))
    assert result["provider"] == "openai" and result["order"] == "suggested"
    assert result["stages"] == stages


@pytest.mark.parametrize("query,stages", [
    ("Сначала парк, потом поесть", [stage("парк"), stage("поесть", kind="meal")]),
    ("First a museum then coffee", [stage("museum"), stage("coffee", kind="meal")]),
    ("Алдымен мұражай, сосын кофе", [stage("мұражай"), stage("кофе", kind="meal")]),
])
def test_explicit_order_is_preserved(query, stages):
    assert hosted(query, plan(stages, order="explicit"))["stages"] == stages
    assert hosted(query, plan(list(reversed(stages)), order="explicit"))["provider"] == "rules"
    assert hosted(query, plan(stages))["provider"] == "rules"


def test_before_after_can_have_logical_order_different_from_sentence_order():
    query = "Перед музеем хочу кофе"
    stages = [stage("кофе", kind="meal"), stage("музеем", "музей")]
    result = hosted(query, plan(stages, order="explicit"))
    assert result["provider"] == "openai" and result["stages"] == stages


@pytest.mark.parametrize("query,locale", [
    ("Посоветуй интересную прогулку", "ru"), ("Just an interesting walk", "en"),
    ("Қызықты серуен ұсын", "kk"),
])
def test_broad_discovery_can_keep_diverse_recommendations(query, locale):
    assert hosted(query, plan([]), locale=locale)["stages"] == []
    assert rules_journey_plan(query, locale)["stages"] == []


@pytest.mark.parametrize("query", ["кофе", "музей", "Ботанический сад", "магазин музыкальных инструментов"])
def test_one_concrete_goal_remains_one_stage(query):
    result = hosted(query, plan([stage(query)]))
    assert result["provider"] == "openai" and len(result["stages"]) == 1
    assert len(rules_journey_plan(query, "ru")["stages"]) == 1
    assert hosted(query, plan([]))["provider"] == "rules"


def test_unsupported_goal_is_retained_and_requires_a_question():
    query = "Посетить библиотеку и попробовать телепортацию"
    stages = [stage("Посетить библиотеку"), stage("попробовать телепортацию", kind="unresolved")]
    result = hosted(query, plan(stages, questions=["Какую доступную активность вы имеете в виду вместо телепортации?"]))
    assert result["provider"] == "openai" and result["stages"][1]["kind"] == "unresolved"
    assert hosted(query, plan(stages))["provider"] == "rules"


@pytest.mark.parametrize("answer", [
    plan([stage("кофе", kind="meal")]),
    plan([stage("музей")]),
    plan([stage("Хочу кофе", kind="meal")]),
])
def test_omitted_independent_goal_is_rejected(answer):
    result = hosted("Хочу кофе и хочу музей", answer)
    assert result["provider"] == "rules"
    assert len(result["stages"]) == 2


def test_modifiers_and_negation_are_retained_in_source_context():
    query = "Хочу кафе без громкой музыки и музей"
    valid = plan([stage("кафе без громкой музыки", "кафе без громкой музыки", kind="meal"), stage("музей")])
    assert hosted(query, valid)["provider"] == "openai"
    cropped = deepcopy(valid)
    cropped["stages"][0]["source_quote"] = "кафе"
    assert hosted(query, cropped)["provider"] == "rules"
    negated = "Не хочу кафе, хочу музей"
    assert hosted(negated, plan([stage("музей")]))["provider"] == "openai"
    assert hosted(negated, plan([stage("кафе", kind="meal"), stage("музей")]))["provider"] == "rules"
    assert hosted("Не шумное кафе", plan([stage("Не шумное кафе", kind="meal")]))["provider"] == "openai"


@pytest.mark.parametrize("mutation", [
    lambda value: value.update(place_ids=["invented"]),
    lambda value: value.update(provider="rules"),
    lambda value: value["stages"][0].update(source_quote="invented quote"),
    lambda value: value["stages"][0].update(place_id="model-place"),
    lambda value: value["stages"][0].update(named_place="Invented Museum"),
    lambda value: value["stages"][0].update(kind="named_place"),
    lambda value: value["stages"][0].update(cuisine="pizza"),
    lambda value: value["stages"][0].update(search_query="https://unsafe.test"),
    lambda value: value.update(warnings=[SECRET + " https://unsafe.test"]),
    lambda value: value["stages"].append(deepcopy(value["stages"][0])),
])
def test_malformed_or_ungrounded_result_falls_back_without_provider_content(mutation):
    answer = plan([stage("музей")])
    mutation(answer)
    result = hosted("музей", answer)
    assert result["provider"] == "rules"
    assert SECRET not in json.dumps(result) and "unsafe.test" not in json.dumps(result)


@pytest.mark.parametrize("kind", ["refusal", "tools", "incomplete", "duplicate_json", "oversized", "encoded"])
def test_transport_refusal_and_untrusted_output_are_not_used(kind):
    def handler(_):
        value = envelope(plan([stage("музей")]))
        if kind == "refusal":
            value["output"][0]["content"] = [{"type": "refusal", "refusal": SECRET}]
        elif kind == "tools":
            value["output"].append({"type": "function_call", "name": "exfiltrate"})
        elif kind == "incomplete":
            value["status"] = "incomplete"
        elif kind == "duplicate_json":
            value = envelope('{"provider":"openai","provider":"openai"}')
        elif kind == "oversized":
            return httpx.Response(200, content=b"x" * 70_000)
        elif kind == "encoded":
            return httpx.Response(200, headers={"content-encoding": "unsupported"}, content=b"private")
        return httpx.Response(200, json=value)
    assert hosted("музей", None, handler=handler)["provider"] == "rules"


@pytest.mark.parametrize("status", [401, 429, 500])
def test_http_failure_keeps_private_provider_body_out_of_result(status):
    result = hosted("музей", None, handler=lambda _: httpx.Response(status, text=SECRET))
    assert result["provider"] == "rules" and SECRET not in json.dumps(result)


def test_shared_budget_covers_planning_and_explanations():
    async def execute():
        requests = []
        budget = RequestBudget(1, 10)

        def handler(request):
            requests.append(request)
            return httpx.Response(200, json=envelope(plan([stage("музей")])))

        async with create_journey_planner("openai", "gpt-6-luna", SECRET, budget=budget,
                                          transport=httpx.MockTransport(handler)) as planner:
            assert (await planner.plan("музей", "ru"))["provider"] == "openai"
            assert (await planner.plan("музей", "ru"))["provider"] == "rules"
        async with create_generator("openai", "gpt-6-luna", SECRET, budget=budget,
                                    transport=httpx.MockTransport(handler)) as generator:
            from astana_ai_providers import ProviderError
            with pytest.raises(ProviderError, match="local_budget_exhausted"):
                await generator.generate(locale="ru", query="private", constraint_evaluations=[], place={
                    "facts": [{"key": "quiet", "status": "known", "value": True, "evidence_ids": ["e1"]}],
                    "evidence": [{"id": "e1"}],
                })
        assert len(requests) == 1
    asyncio.run(execute())


def test_timeout_falls_back_but_cancellation_propagates():
    async def slow(_):
        await asyncio.sleep(0.1)
        raise AssertionError("deadline did not cancel")
    assert hosted("музей", None, handler=slow, timeout_seconds=0.01)["provider"] == "rules"

    async def cancelled(_):
        raise asyncio.CancelledError
    with pytest.raises(asyncio.CancelledError):
        hosted("музей", None, handler=cancelled)


def test_missing_configuration_and_closed_planner_never_send():
    def forbidden(_):
        raise AssertionError("must not send")

    async def execute():
        for provider in ("rules", "openai", "nvidia"):
            async with create_journey_planner(provider, model="gpt-6-luna", transport=httpx.MockTransport(forbidden)) as planner:
                assert (await planner.plan("музей", "ru"))["provider"] == "rules"
        planner = create_journey_planner("openai", "gpt-6-luna", SECRET, transport=httpx.MockTransport(forbidden))
        await planner.aclose()
        await planner.aclose()
        assert (await planner.plan("музей", "ru"))["provider"] == "rules"
    asyncio.run(execute())


@pytest.mark.parametrize("query,locale", [("", "ru"), ("x" * 2001, "en"), (None, "ru"), ("private", "de")])
def test_invalid_input_is_rejected_before_network(query, locale):
    with pytest.raises(ContractValidationError):
        hosted(query, None, locale=locale)


def test_rules_fallback_has_no_special_destination_or_food_case():
    result = rules_journey_plan("Сначала книжный магазин, потом суши и мастерская керамики", "ru")
    assert result["provider"] == "rules" and result["order"] == "explicit"
    assert len(result["stages"]) == 3
    assert all(item["named_place"] is None and item["cuisine"] is None for item in result["stages"])
    assert all(item["source_quote"] in "Сначала книжный магазин, потом суши и мастерская керамики" for item in result["stages"])
    assert len(rules_journey_plan("Не кафе, а музей", "ru")["stages"]) == 1
    assert rules_journey_plan("Кофе после музея", "ru")["stages"][0]["kind"] == "unresolved"


def test_bounded_rules_fallback_does_not_claim_overflow_coverage():
    result = rules_journey_plan(" и ".join(f"занятие{index}" for index in range(12)), "ru")
    assert len(result["stages"]) == 8 and result["clarification_questions"]
    assert any("восьми" in warning for warning in result["warnings"])
    result = rules_journey_plan("длинно" * 250, "ru")
    assert len(result["stages"]) == 3
    assert all(stage["kind"] == "unresolved" for stage in result["stages"])
    validate_payload("JourneyPlan", result)


@pytest.mark.parametrize("query,only", [
    ("Visit a library and visit a swimming pool", "Visit a library"),
    ("Try zorbflinging and try starweaving", "Try zorbflinging"),
    ("Хочу посетить библиотеку и хочу посетить бассейн", "Хочу посетить библиотеку"),
])
def test_shared_generic_verbs_cannot_cover_a_different_source_clause(query, only):
    result = hosted(query, plan([stage(only)]))
    assert result["provider"] == "rules"
    assert len(result["stages"]) == 2


@pytest.mark.parametrize("query,kind,named", [
    ("I want coffee and a museum", "meal", None),
    ("Visit Library And Visit Swimming Pool", "named_place", "Visit Library And Visit Swimming Pool"),
])
def test_whole_query_quote_cannot_hide_merged_independent_goals(query, kind, named):
    result = hosted(query, plan([stage(query, "coffee", kind=kind, named=named)]))
    assert result["provider"] == "rules"
    assert len(result["stages"]) == 2


@pytest.mark.parametrize("query,name", [
    ("Visit Museum of Science and Technology", "Museum of Science and Technology"),
    ('Visit "science and technology museum"', "science and technology museum"),
])
def test_grounded_proper_name_conjunction_does_not_invent_a_second_goal(query, name):
    answer = plan([stage(name, kind="named_place", named=name)])
    assert hosted(query, answer)["provider"] == "openai"


def test_relative_clock_reference_never_waives_explicit_first_then_order():
    query = "First a museum, then coffee after 5pm"
    good = [stage("museum"), stage("coffee", kind="meal")]
    assert hosted(query, plan(good, order="explicit"))["provider"] == "openai"
    assert hosted(query, plan(list(reversed(good)), order="explicit"))["provider"] == "rules"
    assert hosted(query, plan(good, order="suggested"))["provider"] == "rules"


@pytest.mark.parametrize("query,first,second", [
    ("Coffee after the museum", "museum", "Coffee"),
    ("Coffee before the museum", "Coffee", "museum"),
    ("Before the museum, coffee", "coffee", "museum"),
    ("After the museum, coffee", "museum", "coffee"),
    ("Перед музеем хочу кофе", "кофе", "музеем"),
    ("После музея хочу кофе", "музея", "кофе"),
    ("Мұражайдан кейін кофе", "Мұражайдан", "кофе"),
])
def test_unambiguous_relative_activity_order_is_explicit_and_source_validated(query, first, second):
    correct = [stage(first), stage(second)]
    assert hosted(query, plan(correct, order="explicit"))["provider"] == "openai"
    assert hosted(query, plan(correct, order="suggested"))["provider"] == "rules"
    assert hosted(query, plan(list(reversed(correct)), order="explicit"))["provider"] == "rules"


def test_ambiguous_relative_chain_requires_clarification_in_the_affected_clause():
    query = "Coffee after the museum before dinner and teleportation"
    unchecked = [stage("museum"), stage("Coffee"), stage("dinner"),
                 stage("teleportation", kind="unresolved")]
    assert hosted(query, plan(unchecked, order="explicit", questions=["What does teleportation mean?"]))["provider"] == "rules"
    safe = [stage("Coffee after the museum before dinner", kind="unresolved"),
            stage("teleportation", kind="unresolved")]
    result = hosted(query, plan(safe, questions=["Which activity should come before dinner?"]))
    assert result["provider"] == "openai"
    assert all(item["kind"] == "unresolved" for item in result["stages"])


@pytest.mark.parametrize("query,negative,positive", [
    ("Do not visit a museum and visit a cafe", "museum", "visit a cafe"),
    ("Don't go to a museum and visit a cafe", "museum", "visit a cafe"),
    ("Don't try zorbflinging and try starweaving", "zorbflinging", "try starweaving"),
    ("coffee and without pizza", "pizza", "coffee"),
])
def test_generic_negated_verbs_and_separate_exclusions_never_become_stops(query, negative, positive):
    result = rules_journey_plan(query, "en")
    assert len(result["stages"]) == 1
    assert positive in result["stages"][0]["source_quote"]
    assert hosted(query, plan([stage(positive)]))["provider"] == "openai"
    assert hosted(query, plan([stage(negative), stage(positive)]))["provider"] == "rules"


def test_nonnegative_brand_and_beverage_source_are_not_misinterpreted():
    assert hosted("NoNameCoffee", plan([stage("NoNameCoffee", kind="named_place", named="NoNameCoffee")]))["provider"] == "openai"
    for quote in ("coffee", "Хочу кофе", "шай"):
        wrong = plan([stage(quote, "sushi", kind="meal", cuisine="sushi")])
        assert hosted(quote, wrong)["provider"] == "rules"
    # The contradiction check is deliberately narrow; semantic food aliases
    # remain open ended and factual cuisine validation belongs to retrieval.
    assert hosted("кофе с суши", plan([stage("кофе с суши", kind="meal", cuisine="sushi")]))["provider"] == "openai"


def test_semantic_category_filters_preserve_arbitrary_user_purposes():
    query = "Read a novel and buy a book and swim laps and watch a movie"
    stages = [stage("Read a novel", "library reading", categories=["library"]),
              stage("buy a book", "bookshop", categories=["bookshop"]),
              stage("swim laps", "swimming pool", categories=["swimming_pool"]),
              stage("watch a movie", "cinema", categories=["cinema"])]
    result = hosted(query, plan(stages))
    assert result["provider"] == "openai"
    assert [item["categories"] for item in result["stages"]] == [["library"], ["bookshop"], ["swimming_pool"], ["cinema"]]


def test_rules_generic_meal_suggestion_respects_explicit_multilingual_sequences():
    unordered = rules_journey_plan("библиотека и покушать", "ru")
    assert [item["kind"] for item in unordered["stages"]] == ["meal", "activity"]
    assert unordered["stages"][0]["source_quote"] == "покушать"
    assert unordered["order"] == "suggested"
    ordered = rules_journey_plan("Сначала библиотека, потом покушать", "ru")
    assert [item["kind"] for item in ordered["stages"]] == ["activity", "meal"]
    kazakh = rules_journey_plan("Алдымен кофе, содан кейін саябақ", "kk")
    assert kazakh["order"] == "explicit" and len(kazakh["stages"]) == 2
    assert all(item["kind"] != "unresolved" for item in kazakh["stages"])


@pytest.mark.parametrize("query,locale,quotes", [
    ("Хочу кофе и музей. У меня два часа", "ru", ["кофе", "музей"]),
    ("Coffee and museum. I have two hours", "en", ["Coffee", "museum"]),
    ("Кофе және мұражай. Менде екі сағат бар", "kk", ["Кофе", "мұражай"]),
    ("Coffee and museum. With children. No car", "en", ["Coffee", "museum"]),
    ("Кофе и музей. С детьми. Нет машины", "ru", ["Кофе", "музей"]),
])
def test_spelled_durations_companions_and_mobility_are_context_not_stops(query, locale, quotes):
    answer = plan([stage(quote) for quote in quotes])
    result = hosted(query, answer, locale=locale)
    assert result["provider"] == "openai"
    assert len(result["stages"]) == 2
    fallback = rules_journey_plan(query, locale)
    assert len(fallback["stages"]) == 2
    assert all("No car" not in item["search_query"] and "Нет машины" not in item["search_query"]
               for item in fallback["stages"])


def test_context_detection_does_not_hide_an_actual_goal_with_a_duration():
    query = "Visit a museum for two hours and visit a swimming pool"
    assert len(rules_journey_plan(query, "en")["stages"]) == 2
    assert hosted(query, plan([stage("museum")]))["provider"] == "rules"
    query = "Coffee and museum and a trampoline"
    assert len(hosted(query, plan([stage("Coffee"), stage("museum")]))["stages"]) == 3


@pytest.mark.parametrize("query,quotes,exclusions", [
    ("a walk, not Botanical Garden", ["a walk"], ["not Botanical Garden"]),
    ("Coffee and museum. No pizza. Don't visit a theatre", ["Coffee", "museum"], ["No pizza", "Don't visit a theatre"]),
    ("Don't go to a museum and visit a cafe", ["visit a cafe"], ["Don't go to a museum"]),
    ("кофе и музей, без суши", ["кофе", "музей"], ["без суши"]),
    ("Кофе және саябақ. Мұражай керек емес", ["Кофе", "саябақ"], ["Мұражай керек емес"]),
])
def test_global_named_food_and_verbal_exclusions_reach_every_retrieval_stage(query, quotes, exclusions):
    hosted_result = hosted(query, plan([stage(quote) for quote in quotes]))
    assert hosted_result["provider"] == "openai"
    for result in (hosted_result, rules_journey_plan(query, "en")):
        assert len(result["stages"]) == len(quotes)
        for item in result["stages"]:
            assert item["kind"] != "unresolved"
            assert all(exclusion in item["search_query"] for exclusion in exclusions)
            assert item["source_quote"] in query
            assert len(item["search_query"]) <= 300


def test_global_exclusion_append_is_idempotent():
    query = "coffee, no pizza"
    result = hosted(query, plan([stage("coffee", "coffee; no pizza", kind="meal")]))
    assert result["provider"] == "openai"
    assert result["stages"][0]["search_query"] == "coffee; no pizza"


def test_unrepresentable_exclusion_marks_stage_unresolved_instead_of_executing_without_it():
    positive = "x" * 280
    query = positive + ", not Some Specific Excluded Destination"
    hosted_result = hosted(query, plan([stage(positive)]), locale="en")
    assert hosted_result["provider"] == "openai"
    for result in (hosted_result, rules_journey_plan(query, "en")):
        assert result["stages"][0]["kind"] == "unresolved"
        assert result["stages"][0]["source_quote"] == positive
        assert len(result["stages"][0]["search_query"]) <= 300
        assert result["clarification_questions"]
        assert any("exclusions" in warning for warning in result["warnings"])
        validate_payload("JourneyPlan", result)


def test_stronger_luna_settings_are_scoped_to_journey_planning():
    from astana_ai_providers.intents import create_intent_analyzer

    async def check():
        async with create_journey_planner("openai", "gpt-6-luna", SECRET) as planner:
            assert planner._hosted.timeout_seconds == 10
            assert planner._hosted.max_output_tokens == 4096
        async with create_journey_planner("nvidia", "gpt-6-luna", SECRET) as planner:
            assert planner._hosted.timeout_seconds == 7
            assert planner._hosted.max_output_tokens == 3072
        async with create_generator("openai", "gpt-6-luna", SECRET) as generator:
            assert generator._openai_model_options() == {"reasoning": {"effort": "none"}}
        async with create_intent_analyzer("openai", "gpt-6-luna", SECRET) as analyzer:
            assert analyzer._hosted._openai_model_options() == {"reasoning": {"effort": "none"}}
    asyncio.run(check())


@pytest.mark.parametrize("generic,category,kind", [
    ("shopping mall", "mall", "activity"), ("торговый центр", "mall", "activity"),
    ("сауда орталығы", "mall", "activity"), ("museum", "museum", "activity"),
    ("музея", "museum", "activity"), ("кітапхана", "library", "activity"),
    ("библиотека", "library", "activity"), ("кинотеатр", "cinema", "activity"),
    ("театр", "theatre", "activity"), ("park", "park", "activity"),
    ("gallery", "gallery", "activity"), ("coffee shop", "cafe", "meal"),
])
def test_generic_place_types_are_search_categories_not_invented_proper_names(generic, category, kind):
    answer = plan([stage(generic, kind="named_place", named=generic, categories=["park"])])
    result = hosted(generic, answer)
    assert result["provider"] == "openai"
    assert result["stages"][0]["named_place"] is None
    assert result["stages"][0]["kind"] == kind
    assert result["stages"][0]["categories"] == [category]


@pytest.mark.parametrize("name", ["Mall of Astana", "Museum of Science and Technology", "Ботанический сад", "Central Park", "On the Way Cafe"])
def test_compound_proper_names_survive_type_and_intermediate_marker_normalization(name):
    result = hosted("Visit " + name, plan([stage(name, kind="named_place", named=name)]))
    assert result["provider"] == "openai"
    assert result["stages"][0]["named_place"] == name


def test_shopping_mall_alias_is_canonicalized_without_vetoing_other_categories():
    result = hosted("go shopping", plan([stage("shopping", categories=["shopping_mall", "future_place_type"])]))
    assert result["provider"] == "openai"
    assert result["stages"][0]["categories"] == ["mall", "future_place_type"]


@pytest.mark.parametrize("alias,categories", [
    ("botanical_garden", ["park", "garden"]), ("art_gallery", ["gallery"]),
    ("arts_center", ["arts_centre"]), ("movie_theater", ["cinema"]), ("movie_theatre", ["cinema"]),
])
def test_common_semantic_type_aliases_expand_only_to_existing_source_groups(alias, categories):
    result = hosted("visit a place", plan([stage("place", categories=[alias, "future_place_type"])]))
    assert result["provider"] == "openai"
    assert result["stages"][0]["categories"] == [*categories, "future_place_type"]


def test_botanical_source_group_deduplicates_without_silently_truncating_unknown_types():
    result = hosted("garden visit", plan([stage("garden", categories=["botanical_garden", "park", "garden"])]))
    assert result["provider"] == "openai" and result["stages"][0]["categories"] == ["park", "garden"]
    result = hosted("garden visit", plan([stage("garden", categories=["botanical_garden", "one", "two", "three", "four", "five"])]))
    assert result["provider"] == "rules" and result["warnings"]


@pytest.mark.parametrize("query,quote,name,categories,expected", [
    ("Visit Museum of Science", "Visit Museum of Science", "Museum of Science", ["museum"], []),
    ("в Ботанический сад сходить", "в Ботанический сад сходить", "Ботанический сад", ["garden"], []),
    ("Visit cafe Museum of Science", "Visit cafe Museum of Science", "Museum of Science", ["cafe"], ["cafe"]),
    ("watch a movie at MEGA Silk Way", "watch a movie at MEGA Silk Way", "MEGA Silk Way", ["cinema"], ["cinema"]),
    ("кафе Mega", "кафе Mega", "Mega", ["cafe"], ["cafe"]),
])
def test_true_named_destination_category_hints_do_not_override_identity_or_independent_type(query, quote, name, categories, expected):
    result = hosted(query, plan([stage(quote, kind="named_place", named=name, categories=categories)]))
    assert result["provider"] == "openai" and result["stages"][0]["named_place"] == name
    assert result["stages"][0]["categories"] == expected


def test_actual_hosted_botanical_alias_plan_retrieves_the_exact_source_garden():
    from astana_city_data import SnapshotRepository
    from astana_recommender import DefaultRecommendationService
    from astana_retrieval import LexicalRetriever
    from packages.recommender.tests.test_service import Context, request

    path = Path(__file__).resolve().parents[3] / "data/samples/astana-osm.json"
    snapshot = json.loads(path.read_text(encoding="utf-8"))
    now = max(datetime.fromisoformat(item["retrieved_at"].replace("Z", "+00:00"))
              for source in snapshot["places"] for item in source["evidence"]) + timedelta(hours=1)
    query = "Хочу поесть пиццу и в ботанический сад сходить"
    answer = plan([stage("поесть пиццу", kind="meal", cuisine="pizza", categories=["restaurant"]),
                   stage("в ботанический сад сходить", "посетить ботанический сад", categories=["botanical_garden"])])

    async def check():
        repository = SnapshotRepository(path, clock=lambda: now)
        garden_id = "osm:way/1196402246"
        garden = await repository.get(garden_id)
        calls = []

        def handler(payload):
            calls.append(json.loads(payload.content))
            return httpx.Response(200, json=envelope(answer))

        context = Context()
        async with create_journey_planner("openai", "gpt-6-luna", SECRET, transport=httpx.MockTransport(handler)) as planner:
            service = DefaultRecommendationService(repository, LexicalRetriever(repository, pool_limit=1_000),
                                                   context, planner=planner, clock=lambda: now)
            result = await service.recommend(request(query=query, origin=garden["location"]))
        assert result["journey_plan"]["provider"] == "openai"
        assert result["journey_plan"]["stages"][1]["categories"] == ["park", "garden"]
        assert result["journey_plan"]["stages"][1]["named_place"] is None
        assert len(result["recommendations"]) == 2
        assert result["recommendations"][1]["place_id"] == garden_id
        assert len(calls) == 1 and len(context.routes) == 2
        assert all(not source["is_synthetic"] for source in result["places"])
        validate_payload("RecommendationResponse", result)

    asyncio.run(check())


def test_independent_cafe_type_outside_museum_name_is_not_weakened_by_name_hint_cleanup():
    from astana_recommender import DefaultRecommendationService
    from astana_retrieval import LexicalRetriever
    from packages.recommender.tests.test_service import Context, Repository, place, request

    source = place(1)
    source.update(name="Museum of Science", categories=["museum"])
    query = "Visit cafe Museum of Science"
    answer = plan([stage(query, kind="named_place", named=source["name"], categories=["cafe"])])

    async def check():
        repository, context = Repository([source]), Context()
        async with create_journey_planner(
            "openai", "gpt-6-luna", SECRET,
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json=envelope(answer))),
        ) as planner:
            result = await DefaultRecommendationService(repository, LexicalRetriever(repository), context, planner=planner).recommend(request(query=query))
        assert result["journey_plan"]["stages"][0]["categories"] == ["cafe"]
        assert result["status"] == "no_match" and result["recommendations"] == []
        assert not context.routes

    asyncio.run(check())


@pytest.mark.parametrize("query,locale,categories", [
    ("сходить в какое-нибудь место культурного искусства", "ru", ["museum", "gallery", "arts_centre", "theatre"]),
    ("Visit some cultural art place", "en", ["museum", "gallery", "arts_centre", "theatre"]),
    ("бір өнер орынға барғым келеді", "kk", ["museum", "gallery", "arts_centre", "theatre"]),
    ("Хочу зайти в какой-нибудь торговый центр", "ru", ["mall"]),
    ("go shopping somewhere", "en", ["mall", "shop"]),
    ("Хочу куда-нибудь за покупками", "ru", ["mall", "shop"]),
    ("Хочу где-нибудь почитать книги", "ru", ["library"]),
    ("somewhere to read books", "en", ["library"]),
    ("кітап оқу", "kk", ["library"]),
])
def test_clear_broad_category_goal_is_actionable_even_when_hosted_labels_it_unresolved(query, locale, categories):
    answer = plan([stage(query, kind="unresolved")], questions=["Please clarify the subtype."])
    result = hosted(query, answer, locale=locale)
    assert result["provider"] == "openai"
    assert result["stages"][0] == stage(query, kind="activity", categories=categories)
    assert result["clarification_questions"] == answer["clarification_questions"]


@pytest.mark.parametrize("query,named", [
    ("Visit the Library of Quantum Oracles", None),
    ("Хочу в музей неизвестного назначения", None),
    ("Visit the shopping mall named Mystery", None),
    ('Visit "Art"', None),
    ("Visit 'Art'", None),
    ("Visit Art Mystery", "Art Mystery"),
    ("understand quantum harmony", None),
    ("art or something completely different", None),
    ("before the museum", None),
])
def test_normalization_cannot_resolve_unknown_names_purposes_or_relations(query, named):
    answer = plan([stage(query, kind="unresolved", named=named)], questions=["Which activity or destination?"])
    result = hosted(query, answer)
    assert result["stages"][0]["kind"] == "unresolved"
    assert result["clarification_questions"]


def test_broad_goal_recovery_does_not_fill_an_unknown_independent_goal():
    query = "Visit a library and understand quantum harmony"
    answer = plan([stage("Visit a library", kind="unresolved"), stage("understand quantum harmony", kind="unresolved")],
                  questions=["What is the second activity?"])
    result = hosted(query, answer)
    assert result["provider"] == "openai"
    assert [item["kind"] for item in result["stages"]] == ["activity", "unresolved"]
    assert result["stages"][0]["categories"] == ["library"]
    assert result["stages"][1]["categories"] == []


@pytest.mark.parametrize("query", [
    "Visit only a library", "Хочу только музей", "Visit art without a museum",
    "not a museum", "не хочу музей", "кроме музея",
])
def test_broad_goal_recovery_never_drops_negation_or_exclusivity(query):
    answer = plan([stage(query, kind="unresolved")], questions=["Please clarify."])
    result = hosted(query, answer)
    assert not any(item["kind"] != "unresolved" for item in result["stages"])


def test_original_three_goal_query_recovers_source_backed_cultural_goal_without_extra_model_calls():
    from datetime import datetime, timedelta
    from pathlib import Path
    from astana_city_data import SnapshotRepository
    from astana_recommender import DefaultRecommendationService
    from astana_retrieval import LexicalRetriever
    from packages.recommender.tests.test_service import Context, request

    path = Path(__file__).resolve().parents[3] / "data/samples/astana-osm.json"
    snapshot = json.loads(path.read_text(encoding="utf-8"))
    now = max(datetime.fromisoformat(item["retrieved_at"].replace("Z", "+00:00"))
              for source in snapshot["places"] for item in source["evidence"]) + timedelta(hours=1)
    query = "Хочу сходить покушать пиццу а потом в ботанический сад. А потом сходить в какое-нибудь место культурного искусства"
    answer = plan([
        stage("покушать пиццу", "пицца", kind="meal", cuisine="pizza", categories=["restaurant", "cafe"]),
        stage("в ботанический сад", "ботанический сад", categories=["botanical_garden"]),
        stage("сходить в какое-нибудь место культурного искусства", kind="unresolved"),
    ], order="explicit", questions=["Какой вид искусства интересен?"])

    async def check():
        repository, context, calls = SnapshotRepository(path, clock=lambda: now), Context(), []
        def handler(payload):
            calls.append(True)
            return httpx.Response(200, json=envelope(answer))
        async with create_journey_planner("openai", "gpt-6-luna", SECRET, transport=httpx.MockTransport(handler)) as planner:
            service = DefaultRecommendationService(repository, LexicalRetriever(repository), context,
                                                   planner=planner, clock=lambda: now)
            result = await service.recommend(request(query=query, locale="ru", available_seconds=60))
        validate_payload("RecommendationResponse", result)
        assert result["journey_plan"]["provider"] == "openai"
        assert all(item["kind"] != "unresolved" for item in result["journey_plan"]["stages"])
        core = {place["id"]: place for place in result["places"]}
        ids = [item["place_id"] for item in result["recommendations"]]
        assert len(ids) == 3 and len(set(ids)) == 3
        assert ids[1] == "osm:way/1196402246"
        assert {"museum", "gallery", "arts_centre", "theatre"}.intersection(core[ids[2]]["categories"])
        assert len(calls) == 1 and len(context.routes) == 3
        assert result["journey_plan"]["clarification_questions"] == answer["clarification_questions"]
        assert all(not place["is_synthetic"] for place in result["places"])
    asyncio.run(check())


@pytest.mark.parametrize("query,first,second", [
    ("Хочу в музей а по пути зайти в библиотеку", "библиотеку", "музей"),
    ("По пути в музей, зайти в библиотеку", "библиотеку", "музей"),
    ("Go to the museum and on the way visit a library", "library", "museum"),
    ("Visit a library on the way to the museum", "library", "museum"),
    ("En route to the museum, visit a library", "library", "museum"),
    ("Go to the museum, en route visit a library", "library", "museum"),
    ("Мұражайға барамын, жолай кітапханаға кіремін", "кітапханаға", "Мұражайға"),
    ("Кітапханаға жолай кіріп, мұражайға барамын", "Кітапханаға", "мұражайға"),
])
def test_intermediate_stop_precedes_final_destination_even_when_mentioned_after_it(query, first, second):
    correct = [stage(first), stage(second)]
    assert hosted(query, plan(correct, order="explicit"))["provider"] == "openai"
    assert hosted(query, plan(list(reversed(correct)), order="explicit"))["provider"] == "rules"
    assert hosted(query, plan(correct, order="suggested"))["provider"] == "rules"


def test_exact_mall_scenario_has_generic_mall_before_the_named_destination():
    query = "Хочу в ботанический сад а по пути зайти в торговый центр красивый"
    stages = [stage("торговый центр", kind="named_place", named="торговый центр", categories=["shopping_mall"]),
              stage("ботанический сад", kind="named_place", named="ботанический сад")]
    result = hosted(query, plan(stages, order="explicit"))
    assert result["provider"] == "openai"
    assert result["stages"][0]["named_place"] is None
    assert result["stages"][0]["categories"] == ["mall"]
    assert result["stages"][1]["named_place"] == "ботанический сад"
    fallback = rules_journey_plan(query, "ru")
    assert fallback["order"] == "explicit" and len(fallback["stages"]) == 2
    assert "торговый центр" in fallback["stages"][0]["source_quote"]
    assert "ботанический сад" in fallback["stages"][1]["source_quote"]


@pytest.mark.parametrize("query", [
    "First a museum, then on the way visit a library",
    "Хочу в музей а по пути в библиотеку и кафе",
    "Visit a museum, on the way a library, en route a cafe",
])
def test_conflicting_or_ambiguous_intermediate_chains_need_clarification(query):
    result = rules_journey_plan(query, "en")
    assert result["stages"] and all(item["kind"] == "unresolved" for item in result["stages"])
    assert result["clarification_questions"]


def test_marker_inside_a_quoted_proper_name_does_not_reorder_another_goal():
    query = 'Visit "on the way" and a museum'
    stages = [stage("on the way", kind="named_place", named="on the way"), stage("museum")]
    result = hosted(query, plan(stages))
    assert result["provider"] == "openai" and result["order"] == "suggested"
    assert [item["source_quote"] for item in result["stages"]] == ["on the way", "museum"]


@pytest.mark.parametrize("query,quotes", [
    ("Go to the museum and stop at a library on the way to it", ["museum", "library"]),
    ("Хочу в музей и в библиотеку по пути к нему", ["музей", "библиотеку"]),
    ("Хочу в музей а по пути в библиотеку", ["музей", "библиотеку"]),
])
def test_unverified_pronouns_and_elliptical_destination_attachments_require_clarification(query, quotes):
    for ordered in (quotes, list(reversed(quotes))):
        result = hosted(query, plan([stage(quote) for quote in ordered], order="explicit"))
        assert result["provider"] == "rules"
        assert result["stages"] and all(item["kind"] == "unresolved" for item in result["stages"])
        assert result["clarification_questions"]


def test_first_then_conflict_cannot_be_overridden_by_a_hosted_intermediate_order():
    query = "First a museum, then on the way visit a library"
    for quotes in (["museum", "library"], ["library", "museum"]):
        result = hosted(query, plan([stage(quote) for quote in quotes], order="explicit"))
        assert result["provider"] == "rules"
        assert all(item["kind"] == "unresolved" for item in result["stages"])
        assert result["clarification_questions"]


@pytest.mark.parametrize("status", [401, 429, 503])
def test_hosted_http_diagnostic_logs_only_fixed_code_and_status(status, caplog):
    query = "PRIVATE_QUERY_COORDINATES_51_71 museum"
    result = hosted(query, None, handler=lambda _: httpx.Response(status, text=SECRET))
    assert result["provider"] == "rules"
    records = [record for record in caplog.records if record.name == "astana_ai_providers.journeys"]
    assert len(records) == 1
    assert f"reason=http_status http_status={status}" in records[0].getMessage()
    assert "provider=openai" in records[0].getMessage() and "elapsed_ms=" in records[0].getMessage()
    assert records[0].exc_info is None and records[0].stack_info is None
    assert query not in caplog.text and SECRET not in caplog.text


@pytest.mark.parametrize("kind,expected", [
    ("quota", "quota"), ("schema", "schema"), ("grounding", "grounding"),
    ("json", "invalid_json"), ("incomplete", "incomplete_or_failed"),
])
def test_hosted_failure_diagnostics_separate_private_failure_boundaries(kind, expected, caplog):
    query = "museum"
    answer = plan([stage(query)])
    options = {}
    if kind == "quota":
        options["budget"] = RequestBudget(0, 0)
    elif kind == "schema":
        answer["unexpected_private_key"] = SECRET
    elif kind == "grounding":
        answer["stages"][0]["source_quote"] = SECRET
    elif kind == "json":
        answer = SECRET

    def handler(_):
        value = envelope(answer)
        if kind == "incomplete":
            value.update(status="incomplete", incomplete_details={"private": SECRET})
        return httpx.Response(200, json=value)

    assert hosted(query, answer, handler=handler, **options)["provider"] == "rules"
    assert f"reason={expected} http_status=0" in caplog.text
    assert SECRET not in caplog.text


def test_timeout_has_fixed_diagnostic_and_cancellation_is_not_logged(caplog):
    async def slow(_):
        await asyncio.sleep(0.05)
        return httpx.Response(200, json=envelope(plan([stage("museum")])))

    assert hosted("museum", None, handler=slow, timeout_seconds=0.005)["provider"] == "rules"
    assert "reason=timeout http_status=0" in caplog.text
    caplog.clear()

    async def cancelled(_):
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        hosted("museum", None, handler=cancelled)
    assert not caplog.records


def test_unknown_provider_error_code_cannot_inject_log_text_or_status(caplog):
    from astana_ai_providers import ProviderError

    async def check():
        async with create_journey_planner("openai", "gpt-6-luna", SECRET) as planner:
            async def rejected(_):
                raise ProviderError("openai", SECRET, status_code=SECRET)
            planner._hosted._request = rejected
            return await planner.plan("museum", "en")

    assert asyncio.run(check())["provider"] == "rules"
    assert "reason=provider_error http_status=0" in caplog.text
    assert SECRET not in caplog.text


def test_success_and_deliberate_rules_do_not_emit_hosted_failure_logs(caplog):
    assert hosted("museum", plan([stage("museum")]))["provider"] == "openai"
    assert rules_journey_plan("museum", "en")["provider"] == "rules"
    assert not caplog.records
