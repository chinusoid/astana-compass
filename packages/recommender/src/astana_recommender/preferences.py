"""Closed, locally derived context; neither queries nor source prose leave here."""

from __future__ import annotations

import re


SOURCE_CATEGORIES = frozenset({
    "cafe", "coffee_shop", "restaurant", "park", "garden", "museum", "gallery",
    "art", "arts_centre", "artwork", "architecture", "historic", "monument",
    "memorial", "viewpoint", "attraction", "waterfront", "library", "theatre",
    "cinema", "playground",
})
_INTERESTS = {
    "nature": r"природ\w{0,12}|парк\w{0,12}|сад|сада|саду|nature|parks?|gardens?|табиғат\w{0,12}|саябақ\w{0,12}",
    "architecture": r"архитектур\w{0,12}|architectur\w{0,12}|сәулет\w{0,12}",
    "history": r"истори\w{0,12}|historic\w{0,12}|history|тарих\w{0,12}",
    "coffee": r"кофе\w{0,12}|кафе|coffee|caf[eé]s?",
    "river": r"набережн\w{0,12}|река|реки|реке|реки|рекой|rivers?|riverfront|waterfront|өзен\w{0,12}|жағалау\w{0,12}",
    "photos": r"фото\w{0,12}|снимк\w{0,12}|photograph\w{0,12}|photos?|pictures?|суретке\s+түсу",
    "short_walk": r"поменьше\s+ходить|меньше\s+(?:ходить|идти)|коротк\w{0,12}\s+(?:переход\w{0,12}|прогул\w{0,12})|устал\w{0,12}|short\s+walk\w{0,6}|less\s+walking|tired|аз\s+(?:жүру|жүріп)|қысқа\s+(?:серуен|жол)|шарша\w{0,12}",
    "long_walk": r"долг\w{0,12}\s+прогул\w{0,12}|больше\s+(?:пройти|ходить)|длинн\w{0,12}\s+(?:маршрут\w{0,12}|прогул\w{0,12})|long\s+walk\w{0,6}|more\s+walking|walk\s+further|ұзақ\s+серуен|көбірек\s+жүру",
}
_PATTERNS = {key: re.compile(r"(?<!\w)(?:" + pattern + r")(?!\w)", re.I) for key, pattern in _INTERESTS.items()}
_CLAUSES = re.compile(r"[,;.!?\n]|\b(?:но|а|but|instead|бірақ|алайда)\b", re.I)
_NEGATIVE = re.compile(r"(?<!\w)(?:не|без|not|no|without|avoid|don['’]?t)(?!\w)", re.I)
_NEG_AFTER = re.compile(r"^\s*(?:не\s+(?:нуж\w{0,12}|хочу)|(?:is\s+)?not\s+(?:needed|wanted)|(?:керек\s+)?емес)", re.I)


def source_categories(categories: object) -> tuple[str, ...]:
    """Keep only exact closed taxonomy values, never arbitrary source strings."""
    if not isinstance(categories, list):
        return ()
    return tuple(sorted({value for value in categories if isinstance(value, str) and value in SOURCE_CATEGORIES}))


def query_interests(query: str) -> tuple[str, ...]:
    """Derive bounded hints; they are preferences and never venue facts."""
    if not isinstance(query, str) or len(query) > 2000:
        return ()
    positive, negative = set(), set()
    for clause in _CLAUSES.split(query):
        for key, pattern in _PATTERNS.items():
            for match in pattern.finditer(clause):
                negated = _NEGATIVE.search(clause[:match.start()]) or _NEG_AFTER.search(clause[match.end():])
                (negative if negated else positive).add(key)
    positive -= negative
    # Conflicting pace wishes remain on normal relevance ranking.
    if {"short_walk", "long_walk"}.issubset(positive):
        positive -= {"short_walk", "long_walk"}
    return tuple(sorted(positive))


def walking_preference(query: str) -> str | None:
    return next((key for key in query_interests(query) if key in {"short_walk", "long_walk"}), None)
