"""Content caching must preserve canonical validation at untrusted adapter boundaries."""
from copy import deepcopy
import math

from jsonschema import Draft202012Validator
import pytest

from astana_contracts import ContractValidationError, validate_payload
from astana_contracts import validation


@pytest.fixture(autouse=True)
def isolated_cache(monkeypatch):
    monkeypatch.setattr(validation, "_place_cache", validation._PlaceValidationCache())
    yield
    validation._validator.cache_clear()


@pytest.fixture
def place():
    cases = validation.load_examples()["cases"]
    return deepcopy(next(case["instance"]["places"][0] for case in cases if case["name"] == "recommendations_valid"))


@pytest.fixture
def validations(monkeypatch):
    calls = []
    original = Draft202012Validator.iter_errors

    def counted(self, instance, *args, **kwargs):
        if self.schema.get("$ref") == "#/$defs/Place":
            calls.append(True)
        yield from original(self, instance, *args, **kwargs)

    monkeypatch.setattr(Draft202012Validator, "iter_errors", counted)
    return calls


def reordered(value):
    if isinstance(value, dict):
        return {key: reordered(child) for key, child in reversed(list(value.items()))}
    if isinstance(value, list):
        return [reordered(child) for child in value]
    return value


def test_equal_content_with_different_key_order_reuses_validation(place, validations):
    before = deepcopy(place)
    assert validate_payload("Place", place) is place
    equivalent = reordered(deepcopy(place))
    assert validate_payload("Place", equivalent) is equivalent
    assert place == before and equivalent == before
    assert len(validations) == 1


@pytest.mark.parametrize("failure", ["schema", "invariant"])
def test_mutated_content_is_revalidated_and_failures_are_not_cached(place, validations, failure):
    validate_payload("Place", place)
    if failure == "schema":
        place["name"] = 123
    else:
        place["facts"][0]["evidence_ids"] = ["missing-evidence"]
    for _ in range(2):
        with pytest.raises(ContractValidationError) as caught:
            validate_payload("Place", place)
        assert caught.value.stage == failure
    assert len(validations) == 3
    assert len(validation._place_cache._entries) == 1


@pytest.mark.parametrize("bad", ["tuple", "integer_key", "nan", "infinity", "cycle"])
def test_python_only_values_are_rejected_before_building_a_cache_key(place, monkeypatch, bad):
    validate_payload("Place", place)
    if bad == "tuple":
        place["categories"] = tuple(place["categories"])
    elif bad == "integer_key":
        place[1] = "value"
    elif bad == "cycle":
        place["extra"] = place
    else:
        place["location"]["lat"] = math.nan if bad == "nan" else math.inf

    def unexpected_key(_):
        raise AssertionError("Non-JSON input reached the cache key")

    monkeypatch.setattr(validation, "_place_key", unexpected_key)
    with pytest.raises(ContractValidationError) as caught:
        validate_payload("Place", place)
    assert caught.value.code == "invalid_json"


def test_schema_change_invalidates_success_and_compiled_validator(place, monkeypatch, validations):
    validate_payload("Place", place)
    changed_schema = deepcopy(validation._canonical_schema())
    changed_schema["$defs"]["Place"]["properties"]["name"] = {"const": "different-required-name"}
    monkeypatch.setattr(validation, "_canonical_schema", lambda: changed_schema)
    with pytest.raises(ContractValidationError):
        validate_payload("Place", place)
    assert len(validations) == 2
    assert not validation._place_cache._entries


def test_lru_entry_limit_evicts_old_content(place, monkeypatch, validations):
    monkeypatch.setattr(validation, "_place_cache", validation._PlaceValidationCache(max_entries=2))
    variants = [{**deepcopy(place), "name": name} for name in ("A", "B", "C")]
    for index in (0, 1, 0, 2, 1):
        validate_payload("Place", variants[index])
    assert len(validations) == 4  # A was reused; B was evicted after C arrived.
    assert len(validation._place_cache._entries) == 2


def test_total_byte_limit_evicts_even_before_entry_limit(place, monkeypatch, validations):
    first, second = {**place, "name": "A"}, {**place, "name": "B"}
    size = len(validation._place_key(first))
    cache = validation._PlaceValidationCache(max_entries=100, max_bytes=size * 2 - 1)
    monkeypatch.setattr(validation, "_place_cache", cache)
    for item in (first, second, first):
        validate_payload("Place", item)
        assert cache._bytes <= cache.max_bytes
    assert len(validations) == 3
    assert len(cache._entries) == 1


def test_large_successes_are_validated_but_not_retained(place, monkeypatch, validations):
    cache = validation._PlaceValidationCache(max_entry_bytes=1)
    monkeypatch.setattr(validation, "_place_cache", cache)
    for _ in range(2):
        assert validate_payload("Place", place) is place
    assert len(validations) == 2
    assert not cache._entries and cache._bytes == 0


def test_caller_mutation_during_validation_cannot_poison_content_cache(place, monkeypatch):
    place["name"] = 123
    original = Draft202012Validator.iter_errors

    def mutate_caller(self, instance, *args, **kwargs):
        if self.schema.get("$ref") == "#/$defs/Place":
            place["name"] = "Now valid"
        yield from original(self, instance, *args, **kwargs)

    monkeypatch.setattr(Draft202012Validator, "iter_errors", mutate_caller)
    with pytest.raises(ContractValidationError):
        validate_payload("Place", place)
    assert not validation._place_cache._entries


def test_other_contract_boundaries_still_validate_nested_places(place):
    validate_payload("Place", place)
    invalid = {"places": [deepcopy(place)], "next_cursor": None}
    invalid["places"][0]["name"] = 123
    with pytest.raises(ContractValidationError):
        validate_payload("PlaceListResponse", invalid)
