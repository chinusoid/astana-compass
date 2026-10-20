"""Offline request-budget behavior; all hosted responses use MockTransport."""
import asyncio
import json

import httpx
import pytest

from astana_ai_providers import ProviderError, create_generator
from astana_ai_providers.budgets import BudgetExhausted, RequestBudget
from astana_ai_providers.intents import create_intent_analyzer


PLACE = {
    "facts": [{"key": "quiet", "status": "known", "value": True, "evidence_ids": ["e:1"]}],
    "evidence": [{"id": "e:1"}],
}


def envelope(value):
    return {"status": "completed", "output": [{
        "type": "message", "role": "assistant",
        "content": [{"type": "output_text", "text": json.dumps(value)}],
    }]}


def explanation_response():
    return httpx.Response(200, json=envelope({"why": [], "suggested_activity": "observe"}))


async def generate(generator, place=PLACE):
    return await generator.generate(locale="en", query="private", place=place, constraint_evaluations=[])


def test_rolling_minute_and_day_windows_expire_independently():
    instant = [0.0]
    budget = RequestBudget(2, 3, clock=lambda: instant[0])
    budget.reserve()
    budget.reserve()
    instant[0] = 59.999
    with pytest.raises(BudgetExhausted):
        budget.reserve()
    instant[0] = 60
    budget.reserve()
    instant[0] = 120
    with pytest.raises(BudgetExhausted):
        budget.reserve()
    instant[0] = 86_400
    budget.reserve()
    budget.reserve()
    with pytest.raises(BudgetExhausted):
        budget.reserve()


def test_environment_limits_zero_kill_switch_and_invalid_config(monkeypatch):
    monkeypatch.setenv("ASTANA_LLM_REQUESTS_PER_MINUTE", "2")
    monkeypatch.setenv("ASTANA_LLM_REQUESTS_PER_DAY", "0")
    with pytest.raises(BudgetExhausted):
        RequestBudget.from_env().reserve()
    monkeypatch.setenv("ASTANA_LLM_REQUESTS_PER_DAY", "10")
    assert RequestBudget.from_env().per_minute == 2
    for name in ["ASTANA_LLM_REQUESTS_PER_MINUTE", "ASTANA_LLM_REQUESTS_PER_DAY"]:
        with monkeypatch.context() as context:
            context.setenv(name, "untrusted-value")
            with pytest.raises(ValueError, match=name) as captured:
                RequestBudget.from_env()
            assert "untrusted-value" not in str(captured.value)
    for minute, day in [(True, 1), (1, False), (-1, 1), (1, -1), (10_001, 1), (1, 100_001)]:
        with pytest.raises(ValueError):
            RequestBudget(minute, day)


def test_explanations_and_intent_share_one_budget_and_fall_back_without_http():
    async def execute():
        captured = []

        def handler(request):
            captured.append(request)
            payload = json.loads(request.content)
            if payload["text"]["format"]["name"] == "city_intent":
                return httpx.Response(200, json=envelope({
                    "categories": [], "constraints": [], "available_seconds": None,
                    "time_evidence": None, "anchor_text": None, "clarifications": [],
                }))
            return explanation_response()

        budget = RequestBudget(2, 2)
        async with create_generator("openai", "model", "private-key", budget=budget,
                                    transport=httpx.MockTransport(handler)) as generator:
            async with create_intent_analyzer("openai", "model", "private-key", budget=budget,
                                              transport=httpx.MockTransport(handler)) as analyzer:
                await generate(generator)
                first = await analyzer.analyze("hello", "en")
                assert first["provider"] == "openai"
                fallback = await analyzer.analyze("hello", "en")
                assert fallback["provider"] == "rules" and fallback["warnings"]
                with pytest.raises(ProviderError) as captured_error:
                    await generate(generator)
                assert captured_error.value.code == "local_budget_exhausted"
                assert captured_error.value.retryable
                assert "private-key" not in str(captured_error.value)
        assert len(captured) == 2

    asyncio.run(execute())


def test_concurrent_requests_cannot_exceed_budget_even_with_injected_transport():
    async def execute():
        calls = 0

        async def handler(_):
            nonlocal calls
            calls += 1
            await asyncio.sleep(0)
            return explanation_response()

        async with create_generator("openai", "model", "key", budget=RequestBudget(3, 3),
                                    transport=httpx.MockTransport(handler)) as generator:
            results = await asyncio.gather(*(generate(generator) for _ in range(20)), return_exceptions=True)
        failures = [result for result in results if isinstance(result, ProviderError)]
        assert calls == 3 and len(failures) == 17
        assert all(error.code == "local_budget_exhausted" for error in failures)

    asyncio.run(execute())


def test_failed_provider_attempts_stay_counted_and_default_instances_are_isolated(monkeypatch):
    monkeypatch.setenv("ASTANA_LLM_REQUESTS_PER_MINUTE", "1")
    monkeypatch.setenv("ASTANA_LLM_REQUESTS_PER_DAY", "1")

    async def execute():
        calls = []

        def handler(request):
            calls.append(request)
            return httpx.Response(503, text="private-provider-error")

        for _ in range(2):
            async with create_generator("openai", "model", "key", transport=httpx.MockTransport(handler)) as generator:
                with pytest.raises(ProviderError, match="http_error"):
                    await generate(generator)
                with pytest.raises(ProviderError, match="local_budget_exhausted"):
                    await generate(generator)
        assert len(calls) == 2

    asyncio.run(execute())


def test_rules_and_no_grounded_facts_do_not_consume_hosted_budget():
    async def execute():
        budget = RequestBudget(1, 1)
        async with create_intent_analyzer(budget=budget) as analyzer:
            assert (await analyzer.analyze("hello", "en"))["provider"] == "rules"
        calls = []

        def handler(request):
            calls.append(request)
            return explanation_response()

        async with create_generator("openai", "model", "key", budget=budget,
                                    transport=httpx.MockTransport(handler)) as generator:
            await generate(generator, {"facts": [], "evidence": []})
            await generate(generator)
        assert len(calls) == 1

    asyncio.run(execute())
