"""Intent proposals, grounding and transport checks. All HTTP is MockTransport."""

import asyncio
from copy import deepcopy
import json

import httpx
import pytest

from astana_ai_providers.intents import create_intent_analyzer
from astana_contracts import ContractValidationError, validate_payload

SECRET = "local-test-private-key"
QUERY = "Хочу тихое кафе с розеткой у MEGA на 45 минут"


def rules(query, locale="ru"):
    return asyncio.run(create_intent_analyzer().analyze(query, locale))


def keys(result):
    return {entry["constraint"]["key"] for entry in result["constraints"]}


def extracted():
    return {
        "categories": [{"category": "cafe", "source_quote": "кафе"}],
        "constraints": [
            {"key": "quiet", "source_quote": "тихое"},
            {"key": "has_power_outlets", "source_quote": "розеткой"},
        ],
        "available_seconds": 2700,
        "time_evidence": "45 минут",
        "anchor_text": "MEGA",
        "clarifications": ["anchor_question"],
    }


def envelope(provider, text):
    if provider == "openai":
        return {
            "status": "completed",
            "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}],
        }
    return {"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": text}}]}


def hosted(provider, handler, query=QUERY, *, model="configured/model", **config):
    async def execute():
        async with create_intent_analyzer(
            provider, model, SECRET, transport=httpx.MockTransport(handler), **config
        ) as analyzer:
            return await analyzer.analyze(query, "ru")

    return asyncio.run(execute())


@pytest.mark.parametrize(
    "locale,query,seconds,anchor",
    [
        ("ru", "Я возле MEGA Silk Way, есть 30–60 минут", 1800, "MEGA Silk Way"),
        ("en", "Near MEGA, I have 30 to 60 minutes", 1800, "MEGA"),
        ("kk", "MEGA жанында 30–60 минут бар", 1800, "MEGA"),
    ],
)
def test_mega_time_range_is_conservative_exact_and_reviewable(locale, query, seconds, anchor):
    result = rules(query, locale)
    assert result["available_seconds"] == seconds
    assert result["anchor_text"] == anchor
    assert result["time_evidence"] in query
    assert result["provider"] == "rules" and result["locale"] == locale
    assert len(result["warnings"]) >= 3
    validate_payload("IntentResponse", result)


@pytest.mark.parametrize(
    "locale,query",
    [
        ("ru", "Нужно тихое кафе с розеткой на 45 минут"),
        ("en", "A quiet coffee shop with a power socket for 45 minutes"),
        ("kk", "Тыныш кафе және қуаттауға орын, 45 минут"),
    ],
)
def test_coffee_and_socket_are_preferences_not_venue_facts(locale, query):
    result = rules(query, locale)
    assert result["categories"] == ["cafe"]
    assert keys(result) == {"quiet", "has_power_outlets"}
    assert result["available_seconds"] == 2700
    for entry in result["constraints"]:
        assert entry["source_quote"] in query
        assert entry["constraint"]["value"] is True
        assert entry["constraint"]["strength"] == "preferred"


@pytest.mark.parametrize("locale,query", [("ru", "Я с ребёнком"), ("en", "With my child"), ("kk", "Баламен серуен")])
def test_child_does_not_invent_stroller_access_or_playground(locale, query):
    result = rules(query, locale)
    assert keys(result) == {"child_friendly"}
    assert result["categories"] == []
    assert len(result["clarification_questions"]) >= 2


@pytest.mark.parametrize("locale,query", [
    ("ru", "Кафе с Wi-Fi и туалетом"),
    ("en", "Cafe with wifi and a restroom"),
    ("kk", "Wi-Fi және дәретханасы бар кафе"),
])
def test_source_amenities_are_reviewable_preferences(locale, query):
    result = rules(query, locale)
    assert keys(result) == {"has_wifi", "toilets"}
    for item in result["constraints"]:
        assert item["source_quote"] in query
        assert item["constraint"] == {"key": item["constraint"]["key"], "value": True, "strength": "preferred"}


@pytest.mark.parametrize("locale,query", [
    ("ru", "Wi-Fi не нужен, туалет не обязателен"),
    ("en", "Wifi is not required, toilets are not important"),
    ("kk", "Wi-Fi керек емес, дәретхана маңызды емес"),
])
def test_unwanted_amenities_do_not_become_positive_constraints(locale, query):
    assert not {"has_wifi", "toilets"}.intersection(keys(rules(query, locale)))


def test_generic_internet_does_not_assert_a_wireless_requirement():
    assert "has_wifi" not in keys(rules("Кафе с интернетом"))


@pytest.mark.parametrize(
    "locale,query",
    [
        ("ru", "Я турист, до вылета 2 часа"),
        ("en", "Tourist with two hours before my flight"),
        ("kk", "Туристпін, ұшуға дейін екі сағат бар"),
    ],
)
def test_flight_deadline_is_never_the_walking_budget(locale, query):
    result = rules(query, locale)
    assert result["available_seconds"] is None and result["time_evidence"] is None
    assert result["clarification_questions"] and len(result["warnings"]) >= 3


@pytest.mark.parametrize(
    "locale,query",
    [
        ("ru", "Хочу ночную активность"),
        ("en", "Night activities tonight"),
        ("kk", "Түнгі демалыс керек"),
    ],
)
def test_night_has_uncertainty_no_assumed_opening_hours(locale, query):
    result = rules(query, locale)
    assert result["categories"] == ["nightlife"]
    assert "open_at_requested_time" not in keys(result)
    assert len(result["warnings"]) >= 3


@pytest.mark.parametrize(
    "query,excluded",
    [
        ("Розетка не нужна, хочу тихое кафе", "has_power_outlets"),
        ("Не нужна розетка, но хочу тихое кафе", "has_power_outlets"),
        ("A socket is not required, quiet coffee please", "has_power_outlets"),
        ("A socket isn't needed, quiet coffee please", "has_power_outlets"),
        ("A socket isn’t required, quiet coffee please", "has_power_outlets"),
        ("Sockets aren't important, quiet coffee please", "has_power_outlets"),
        ("Sockets aren’t needed, quiet coffee please", "has_power_outlets"),
        ("I don't need a socket but want quiet coffee", "has_power_outlets"),
        ("Розетка керек емес, тыныш кафе керек", "has_power_outlets"),
        ("Не с ребёнком, нужно тихое кафе", "child_friendly"),
        ("Без детей, хочу тихое кафе", "child_friendly"),
        ("Тишина не обязательна", "quiet"),
        ("Бесплатно не важно", "free_entry"),
    ],
)
def test_negation_omits_condition_without_requiring_false(query, excluded):
    result = rules(query)
    assert excluded not in keys(result)
    assert all(entry["constraint"]["value"] is True for entry in result["constraints"])


def test_postfix_negation_does_not_negate_previous_attribute():
    result = rules("Нужно тихое кафе розетка не нужна")
    assert keys(result) == {"quiet"}


def test_negated_category_and_conflicting_condition_require_review():
    result = rules("Не хочу кафе, хочу музей. Нужна розетка, розетка не нужна")
    assert result["categories"] == ["museum"]
    assert "has_power_outlets" not in keys(result)
    assert any("противоречив" in item for item in result["warnings"])


@pytest.mark.parametrize(
    "query",
    [
        "5 часов", "0 минут", "1 час 30 минут", "не 45 минут", "60–30 минут",
        "0.001 hours", "0.060 minutes", "0,060 минут", ".001 hours", ",060 minutes",
    ],
)
def test_ambiguous_or_out_of_bounds_duration_is_not_clamped(query):
    result = rules(query)
    assert result["available_seconds"] is None and result["time_evidence"] is None
    assert result["clarification_questions"]


@pytest.mark.parametrize(
    "query,seconds",
    [("two hours", 7200), ("екі сағат", 7200), ("один час", 3600), ("half hour", 1800), ("1.5 hours", 5400)],
)
def test_word_and_fraction_time_units(query, seconds):
    assert rules(query)["available_seconds"] == seconds


@pytest.mark.parametrize("query", ["Дай мне 30 минут", "В Астане 30 минут", "У меня вполне 30 минут"])
def test_duration_negation_does_not_match_a_word_suffix(query):
    result = rules(query)
    assert result["available_seconds"] == 1800
    assert result["time_evidence"] == "30 минут"


@pytest.mark.parametrize("provider", ["openai", "nvidia"])
def test_hosted_payload_and_grounded_response(provider):
    captured = []

    def handle(request):
        captured.append(request)
        assert request.headers["accept-encoding"] == "identity"
        payload = json.loads(request.content)
        assert "tools" not in payload
        assert payload["model"] == "configured/model"
        if provider == "openai":
            assert str(request.url) == "https://api.openai.com/v1/responses"
            assert payload["store"] is False
            assert payload["text"]["format"]["strict"] is True
            data = json.loads(payload["input"][0]["content"])
        else:
            assert str(request.url) == "https://integrate.api.nvidia.com/v1/chat/completions"
            assert payload["stream"] is False
            assert "guided_json" not in payload and "response_format" not in payload
            data = json.loads(payload["messages"][1]["content"])
        assert data["query"] == QUERY and data["locale"] == "ru"
        assert SECRET not in request.content.decode()
        assert set(data) == {"query", "locale", "rule_candidates"}
        return httpx.Response(200, json=envelope(provider, json.dumps(extracted())))

    result = hosted(provider, handle)
    assert len(captured) == 1 and result["provider"] == provider
    assert result["available_seconds"] == 2700
    assert keys(result) == {"quiet", "has_power_outlets"}
    assert result["constraints"][0]["source_quote"] == "тихое"
    validate_payload("IntentResponse", result)


@pytest.mark.parametrize("provider,model,reasoning", [
    ("openai", "gpt-6-luna", {"effort": "none"}),
    ("openai", "configured/model", None),
    ("nvidia", "gpt-6-luna", None),
])
def test_luna_intent_uses_same_scoped_responses_options(provider, model, reasoning):
    def handle(request):
        payload = json.loads(request.content)
        assert payload["model"] == model
        assert payload.get("reasoning") == reasoning
        assert not {"temperature", "top_p", "max_completion_tokens", "reasoning_effort"} & payload.keys()
        if provider == "openai":
            assert str(request.url) == "https://api.openai.com/v1/responses"
            assert "max_tokens" not in payload
            assert payload["max_output_tokens"] == 1536
            assert payload["store"] is False
            assert payload["text"]["format"]["strict"] is True
        else:
            assert str(request.url) == "https://integrate.api.nvidia.com/v1/chat/completions"
            assert payload["max_tokens"] == 1536
            assert "max_output_tokens" not in payload
        return httpx.Response(200, json=envelope(provider, json.dumps(extracted())))

    result = hosted(provider, handle, model=model)
    assert result["provider"] == provider
    assert result["available_seconds"] == 2700
    assert keys(result) == {"quiet", "has_power_outlets"}
    validate_payload("IntentResponse", result)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: value.update(extra="do not return"),
        lambda value: value.update(available_seconds=True),
        lambda value: value.update(available_seconds=7200),
        lambda value: value.update(time_evidence="not in query"),
        lambda value: value.update(anchor_text="invented address"),
        lambda value: value.update(clarifications=["http://untrusted.test"]),
        lambda value: value.update(categories=[{"category": "unknown", "source_quote": "кафе"}]),
        lambda value: value.update(constraints=[{"key": "quiet", "source_quote": "кафе"}]),
        lambda value: value.update(constraints=[{"key": "quiet", "source_quote": "тихое", "value": False}]),
        lambda value: value["constraints"].append(deepcopy(value["constraints"][0])),
    ],
)
@pytest.mark.parametrize("provider", ["openai", "nvidia"])
def test_malformed_or_ungrounded_hosted_result_falls_back_without_raw_content(provider, mutation):
    answer = extracted()
    mutation(answer)
    result = hosted(provider, lambda _: httpx.Response(200, json=envelope(provider, json.dumps(answer))))
    assert result["provider"] == "rules"
    assert keys(result) == {"quiet", "has_power_outlets"}
    serialized = json.dumps(result)
    assert SECRET not in serialized and "untrusted.test" not in serialized
    assert any("не прошёл проверку" in warning for warning in result["warnings"])


@pytest.mark.parametrize("provider", ["openai", "nvidia"])
def test_hosted_flight_prompt_requests_a_supported_clarification(provider):
    query = "Мой рейс через 2 часа, хочу погулять"

    def handle(request):
        payload = json.loads(request.content)
        if provider == "openai":
            instructions = payload["instructions"]
            schema = payload["text"]["format"]["schema"]
        else:
            instructions, serialized_schema = payload["messages"][0]["content"].split(" JSON schema: ", 1)
            schema = json.loads(serialized_schema)
        requested_code = instructions.split("time fields and ask ", 1)[1].split(".", 1)[0]
        assert requested_code in schema["properties"]["clarifications"]["items"]["enum"]
        answer = {
            "categories": [],
            "constraints": [],
            "available_seconds": None,
            "time_evidence": None,
            "anchor_text": None,
            "clarifications": [requested_code],
        }
        return httpx.Response(200, json=envelope(provider, json.dumps(answer)))

    result = hosted(provider, handle, query=query)
    assert result["provider"] == provider
    assert result["available_seconds"] is None and result["time_evidence"] is None
    assert result["clarification_questions"] == rules(query)["clarification_questions"]
    assert not any("не прошёл проверку" in warning for warning in result["warnings"])


@pytest.mark.parametrize("provider", ["openai", "nvidia"])
def test_model_cannot_crop_away_negation(provider):
    answer = {
        "categories": [],
        "constraints": [{"key": "has_power_outlets", "source_quote": "розетка"}],
        "available_seconds": None,
        "time_evidence": None,
        "anchor_text": None,
        "clarifications": [],
    }
    result = hosted(
        provider,
        lambda _: httpx.Response(200, json=envelope(provider, json.dumps(answer))),
        query="Мне розетка не нужна",
    )
    assert result["provider"] == "rules" and result["constraints"] == []


@pytest.mark.parametrize("provider", ["openai", "nvidia"])
@pytest.mark.parametrize("status", [401, 429, 500])
def test_http_failures_do_not_expose_provider_body_or_key(provider, status):
    result = hosted(provider, lambda _: httpx.Response(status, text=SECRET + " provider private details"))
    assert result["provider"] == "rules"
    assert SECRET not in json.dumps(result)


@pytest.mark.parametrize("provider", ["openai", "nvidia"])
def test_total_timeout_falls_back(provider):
    async def slow(_):
        await asyncio.sleep(0.1)
        raise AssertionError("deadline must cancel the handler")

    result = hosted(provider, slow, timeout_seconds=0.01)
    assert result["provider"] == "rules"


@pytest.mark.parametrize("provider", ["openai", "nvidia"])
def test_encoded_stream_is_rejected_before_read(provider):
    class NeverRead(httpx.AsyncByteStream):
        async def __aiter__(self):
            raise AssertionError("encoded response must not be read or decompressed")
            yield b""

    result = hosted(provider, lambda _: httpx.Response(200, headers={"content-encoding": "gzip"}, stream=NeverRead()))
    assert result["provider"] == "rules"


@pytest.mark.parametrize("provider", ["openai", "nvidia"])
def test_oversized_output_and_duplicate_json_are_rejected(provider):
    for text in ("x" * 70000, '{"categories":[],"categories":[]}'):
        result = hosted(provider, lambda _: httpx.Response(200, json=envelope(provider, text)))
        assert result["provider"] == "rules"


@pytest.mark.parametrize("provider", ["openai", "nvidia"])
def test_tool_calls_and_refusal_do_not_become_intents(provider):
    value = envelope(provider, json.dumps(extracted()))
    if provider == "openai":
        value["output"].append({"type": "function_call", "name": "exfiltrate"})
    else:
        value["choices"][0]["message"]["tool_calls"] = [{"name": "exfiltrate"}]
    assert hosted(provider, lambda _: httpx.Response(200, json=value))["provider"] == "rules"


def test_missing_configuration_is_network_free_and_explicit():
    def forbidden(_):
        raise AssertionError("no key means no network")

    async def execute():
        for provider in ("rules", "openai", "nvidia"):
            async with create_intent_analyzer(
                provider, model="configured/model", transport=httpx.MockTransport(forbidden)
            ) as analyzer:
                result = await analyzer.analyze(QUERY, "ru")
                assert result["provider"] == "rules"
                assert any("не использована" in warning for warning in result["warnings"])

    asyncio.run(execute())


@pytest.mark.parametrize(
    "query,locale", [("", "ru"), ("x" * 2001, "ru"), ("private", "de"), (None, "ru"), (True, "ru")]
)
def test_invalid_input_is_safe_and_rejected_before_network(query, locale):
    with pytest.raises(ContractValidationError) as caught:
        rules(query, locale)
    assert "private" not in str(caught.value)


def test_cancellation_is_not_swallowed():
    async def cancelled(_):
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        hosted("openai", cancelled)


@pytest.mark.parametrize("query", ["тих" + "о" * 1900, "Байтерек" + "а" * 1900, "30 минут" + "а" * 1900])
def test_valid_bounded_input_with_long_words_cannot_overflow_source_quotes(query):
    result = rules(query)
    validate_payload("IntentResponse", result)
    assert all(len(item["source_quote"]) <= 300 for item in result["constraints"])


def test_repeated_close_is_safe_and_closed_analyzer_never_calls_provider():
    def forbidden(_):
        raise AssertionError("closed adapter must not send")

    async def execute():
        analyzer = create_intent_analyzer(
            "openai", "configured/model", SECRET, transport=httpx.MockTransport(forbidden)
        )
        await analyzer.aclose()
        await analyzer.aclose()
        assert (await analyzer.analyze(QUERY, "ru"))["provider"] == "rules"

    asyncio.run(execute())


@pytest.mark.parametrize(
    "locale,query",
    [
        ("ru", "Мой рейс через 2 часа, хочу погулять"),
        ("en", "My flight leaves in two hours, I want a walk"),
        ("kk", "Рейсім екі сағаттан кейін, серуендегім келеді"),
        ("kk", "Ұшағым екі сағаттан кейін ұшады"),
    ],
)
def test_flight_deadline_word_order_never_creates_available_walk_time(locale, query):
    result = rules(query, locale)
    assert result["available_seconds"] is None and result["time_evidence"] is None
    assert result["clarification_questions"]


@pytest.mark.parametrize(
    "locale,query",
    [
        ("ru", "-30 минут"),
        ("en", "-30 minutes"),
        ("kk", "-30 минут"),
        ("ru", "−2 часа"),
        ("en", "−two hours"),
        ("kk", "−екі сағат"),
    ],
)
def test_unary_negative_time_is_not_reinterpreted_as_positive(locale, query):
    result = rules(query, locale)
    assert result["available_seconds"] is None and result["time_evidence"] is None
    assert result["clarification_questions"]
