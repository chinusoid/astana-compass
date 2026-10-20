"""Semantic planning boundary: every hosted call uses an offline transport."""

import asyncio
from copy import deepcopy
import json

import httpx
import pytest

from astana_ai_providers import create_generator, create_journey_planner
from astana_ai_providers.budgets import RequestBudget
from astana_ai_providers.journeys import rules_journey_plan
from astana_contracts import ContractValidationError, validate_payload


SECRET = "offline-private-test-key"


def stage(quote, search=None, *, kind="activity", named=None, cuisine=None):
    return {"source_quote": quote, "search_query": search or quote, "kind": kind,
            "named_place": named, "cuisine": cuisine}


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
            assert payload["reasoning"] == {"effort": "none"}
            assert payload["max_output_tokens"] == 3072
            assert payload["text"]["format"]["strict"] is True
            schema = payload["text"]["format"]["schema"]
            assert schema["properties"]["stages"]["maxItems"] == 8
            assert schema["properties"]["stages"]["items"]["properties"]["kind"]["type"] == "string"
            data = json.loads(payload["input"][0]["content"])
        else:
            assert str(request.url) == "https://integrate.api.nvidia.com/v1/chat/completions"
            assert payload["max_tokens"] == 3072 and payload["stream"] is False
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
