"""Bounded snapshot retrieval. No embeddings, external calls or invented evidence."""
from __future__ import annotations

import asyncio
from collections import Counter
from copy import deepcopy
import math
import os
from typing import Any

from astana_contracts import JSON, PlaceRepository, validate_payload

from .lexicon import LEXICON_VERSION, document_terms, understand

DYNAMIC_KEYS = frozenset({"open_at_requested_time", "weather_suitable"})
STRATEGY = f"snapshot-bm25-{LEXICON_VERSION}"
COPY = {
    "lexical": (
        "Поиск по названиям, категориям и словам из описаний. Сложные пожелания могут потребовать уточнения.",
        "Іздеу атаулар, санаттар және сипаттама сөздері бойынша жүреді. Күрделі қалауларды нақтылау қажет болуы мүмкін.",
        "Search uses names, categories and description words. Complex requests may need clarification.",
    ),
    "pool": (
        "Проверено ограниченное число ближайших мест; релевантные места за пределами этой выборки могли не попасть в поиск.",
        "Жақын орындардың шектеулі саны тексерілді; таңдаудан тыс сәйкес орындар іздеуге түспеуі мүмкін.",
        "A bounded nearest-place pool was searched; relevant places beyond this pool may be missed.",
    ),
    "no_match": (
        "В проверенной выборке нет лексически подходящих мест. Уточните название или категорию; отсутствие результата не доказывает отсутствие места в городе.",
        "Тексерілген таңдауда мәтінге сәйкес орын жоқ. Атауын не санатын нақтылаңыз; бұл қалада ондай орын жоқ дегенді білдірмейді.",
        "No lexical match in the searched pool. Try a name or category; this does not establish that no such place exists in the city.",
    ),
    "deferred": (
        "Неизвестные и динамические обязательные условия переданы на окончательную проверку; попадание в кандидаты не подтверждает их выполнение.",
        "Белгісіз және өзгермелі міндетті шарттар соңғы тексеруге жіберілді; кандидат болуы шарттың орындалғанын растамайды.",
        "Unknown and dynamic required conditions are deferred for final checks; candidate inclusion does not establish satisfaction.",
    ),
    "anchor": (
        "Поиск идёт вокруг выбранной точки на карте. Близость к упомянутому ориентиру пока не проверена.",
        "Мәтіндегі бағдар картада анықталмады; іздеу таңдалған нүктенің айналасында жүреді, бағдарға жақындығы тексерілмеді.",
        "Search uses your selected map point; proximity to the place you mentioned has not been checked.",
    ),
}


def _text(key: str, locale: str) -> str:
    return COPY[key][("ru", "kk", "en").index(locale)]


def distance_meters(origin: JSON, location: JSON) -> float:
    """Spherical great-circle radius, never a routed walking distance."""
    first, second = math.radians(origin["lat"]), math.radians(location["lat"])
    delta_lat = second - first
    delta_lon = math.radians(location["lon"] - origin["lon"])
    value = math.sin(delta_lat / 2) ** 2 + math.cos(first) * math.cos(second) * math.sin(delta_lon / 2) ** 2
    return 6_371_008.8 * 2 * math.asin(math.sqrt(max(0, min(1, value))))


def same_value(left: Any, right: Any) -> bool:
    if isinstance(left, bool) != isinstance(right, bool):
        return False
    if isinstance(left, list) or isinstance(right, list):
        return (
            isinstance(left, list) and isinstance(right, list) and len(left) == len(right)
            and all(same_value(a, b) for a, b in zip(left, right, strict=True))
        )
    return left == right


class LexicalRetriever:
    """Repository is borrowed, not owned. Each retrieval makes one bounded nearby call."""

    def __init__(self, repository: PlaceRepository, *, pool_limit: int = 500, timeout_seconds: float = 5):
        if type(pool_limit) is not int or not 100 <= pool_limit <= 1000:
            raise ValueError("retrieval pool_limit must be an integer from 100 to 1000")
        if (
            type(timeout_seconds) not in (int, float) or not math.isfinite(timeout_seconds)
            or not 0 < timeout_seconds <= 30
        ):
            raise ValueError("retrieval timeout must be between 0 and 30 seconds")
        self.repository = repository
        self.pool_limit = pool_limit
        self.timeout_seconds = timeout_seconds
        self._closed = False

    async def aclose(self) -> None:
        self._closed = True

    async def retrieve(self, request: JSON) -> JSON:
        validate_payload("RetrievalRequest", request)
        if len(request["query"]) > 2000 or len(request["constraints"]) > 20:
            raise ValueError("retrieval request exceeds operational limits")
        if self._closed:
            raise RuntimeError("retriever is closed")
        query = understand(request["query"])
        locale = request["locale"]
        warnings = [_text("lexical", locale)]
        if query.has_unresolved_anchor:
            warnings.append(_text("anchor", locale))
        async with asyncio.timeout(self.timeout_seconds):
            source = await self.repository.nearby(
                origin=deepcopy(request["origin"]), radius_meters=request["radius_meters"], limit=self.pool_limit,
            )
        if not isinstance(source, list) or len(source) > self.pool_limit:
            raise ValueError("repository exceeded retrieval pool contract")
        if len(source) == self.pool_limit:
            warnings.append(_text("pool", locale))
        corpus, seen = [], set()
        for place in source:
            validate_payload("Place", place)
            if place["id"] in seen:
                raise ValueError("repository returned duplicate places")
            seen.add(place["id"])
            distance = distance_meters(request["origin"], place["location"])
            if distance > request["radius_meters"]:
                continue
            facts = {fact["key"]: fact for fact in place["facts"]}
            violated, deferred, matched = False, False, set()
            for constraint in request["constraints"]:
                key = constraint["key"]
                fact = facts.get(key)
                if key in DYNAMIC_KEYS or fact is None or fact["status"] != "known":
                    deferred |= constraint["strength"] == "required"
                elif same_value(fact["value"], constraint["value"]):
                    matched.add(key)
                elif constraint["strength"] == "required":
                    violated = True
            if violated or query.excluded_categories.intersection(place["categories"]):
                continue
            if query.categories and not query.categories.intersection(place["categories"]):
                continue
            for key in query.features:
                fact = facts.get(key)
                if fact and fact["status"] == "known" and fact["value"] is True:
                    matched.add(key)
            corpus.append((place, document_terms(place), distance, matched, deferred))
        # BM25 statistics describe the bounded, filtered corpus, not the whole city.
        frequencies = Counter(term for _, terms, *_ in corpus for term in terms)
        mean_length = sum(sum(terms.values()) for _, terms, *_ in corpus) / max(1, len(corpus))
        ranked = []
        for place, terms, distance, matched, deferred in corpus:
            score = 0.0
            for term in sorted(query.terms):
                frequency = terms.get(term, 0)
                if not frequency:
                    continue
                inverse = math.log1p((len(corpus) - frequencies[term] + 0.5) / (frequencies[term] + 0.5))
                length = sum(terms.values())
                score += inverse * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * length / mean_length))
            # Explicit constraints may define intent, but must have known matching evidence.
            if score <= 0 and (query.terms or not matched):
                continue
            score += 0.2 * len(matched)
            ranked.append((score, distance, place["id"], place, sorted(matched), deferred))
        ranked.sort(key=lambda item: (-item[0], item[1], item[2]))
        selected = ranked[:request["candidate_limit"]]
        if any(item[5] for item in selected):
            warnings.append(_text("deferred", locale))
        if not selected:
            warnings.append(_text("no_match", locale))
        response = {
            "places": [deepcopy(item[3]) for item in selected],
            "hits": [
                {"place_id": item[2], "score": item[0], "score_kind": "lexical", "matched_fact_keys": item[4]}
                for item in selected
            ],
            "strategy": STRATEGY,
            "warnings": warnings,
        }
        return validate_payload("RetrievalResponse", response)


def create_retriever(*, repository: PlaceRepository, config: dict) -> LexicalRetriever:
    """Canonical synchronous factory; no file access, credentials or network on creation."""
    del config  # Shared mode/timezone do not change lexical ranking or invent a vector backend.
    try:
        pool = int(os.getenv("ASTANA_RETRIEVAL_POOL_LIMIT", "500"))
        timeout = float(os.getenv("ASTANA_RETRIEVAL_TIMEOUT_SECONDS", "5"))
    except ValueError:
        raise ValueError("invalid retrieval configuration") from None
    return LexicalRetriever(repository, pool_limit=pool, timeout_seconds=timeout)
