"""Conservative journey intent and source-backed checks for requested stops."""

from __future__ import annotations

import re


_NEXT = re.compile(
    r"(?<!\w)(?:(?:а|и)\s+)?(?:потом|затем|далее|после\s+этого|в\s+конце|под\s+конец)(?!\w)|"
    r"(?<!\w)(?:and\s+)?(?:then|after\s+that|finally|lastly|"
    r"next(?!\s+(?:to|door|week|month|year|summer|winter|spring|autumn|fall|time)\b))(?!\w)|"
    r"(?<!\w)(?:(?:содан|одан)\s+кейін|одан\s+соң|сосын|соңында)(?!\w)",
    re.IGNORECASE,
)
_FIRST = re.compile(r"(?<!\w)(?:сначала|сперва|first|алдымен|әуелі)(?!\w)\s*", re.IGNORECASE)
_JOIN = re.compile(
    r"\s*[,;]\s*(?:(?:и|and|және|әрі)\s+)?|(?<!\w)(?:и|and|және|әрі)(?!\w)|(?<=\S)\s+мен\s+",
    re.IGNORECASE,
)
_BOTANICAL = re.compile(
    r"(?<!\w)(?:ботаническ(?:ий|ого|ому|им|ом)\s+сад(?:а|у|ом|е)?|ботсад(?:а|у|ом|е)?|"
    r"botanic(?:al)?\s+gardens?|ботаникалық\s+бақ(?:қа|та|ты|тан|тың)?)(?!\w)", re.IGNORECASE,
)
_PIZZA = re.compile(
    r"(?<!\w)(?:pizzas?|пиц{1,2}(?:а|у|ы|е|ой|ей|ам|ами|ах|аны|анық|аға|ада|адан))(?!\w)",
    re.IGNORECASE,
)
_COFFEE = re.compile(r"(?<!\w)(?:кофе|кафе|coffee|caf[eé]s?|кофе\s+іш\w*|кафеге)(?!\w)", re.IGNORECASE)
_MEAL = re.compile(
    r"(?<!\w)(?:поесть|покушать|перекусить|пообедать|поужинать|еда|еды|еду|обед|ужин|"
    r"eat|eating|food|meal|lunch|dinner|тамақ\w*|түскі\s+ас|кешкі\s+ас)(?!\w)", re.IGNORECASE,
)
_NEGATIVE = re.compile(r"(?<!\w)(?:не|без|not|no|without|avoid|don['’]?t|емес)(?!\w)", re.IGNORECASE)
_NEGATIVE_AFTER = re.compile(
    r"^\s*(?:не\s+(?:хочу|нуж\w*)|(?:is\s+)?not\s+(?:wanted|needed)|(?:керек\s+)?емес|"
    r"(?:же|іш)\w*(?:май|мей)\w*|бар\w*\s+келм\w*)", re.IGNORECASE,
)
_SPATIAL_BEFORE = re.compile(
    r"(?<!\w)(?:near|by|beside|around|next\s+to|close\s+to|у|возле|около|рядом\s+с|недалеко\s+от)\s*$",
    re.IGNORECASE,
)
_SPATIAL_AFTER = re.compile(r"^\s*(?:маң\w*|жан\w*|қас\w*|жақын\w*)", re.IGNORECASE)


def _positive_match(pattern: re.Pattern[str], text: str) -> re.Match[str] | None:
    for match in pattern.finditer(text):
        # Limit negation to the current punctuation/conjunction clause.
        prefix = _JOIN.split(text[:match.start()])[-1]
        if not _NEGATIVE.search(prefix) and not _NEGATIVE_AFTER.search(text[match.end():]):
            return match
    return None


def botanical_destination(query: str) -> str | None:
    """A requested named garden, excluding food searches near that landmark."""
    match = _positive_match(_BOTANICAL, query)
    if match is None or _SPATIAL_BEFORE.search(query[:match.start()]) or _SPATIAL_AFTER.match(query[match.end():]):
        return None
    # Inflection is query syntax, not a new source alias or place identity.
    value = match.group().casefold()
    if value.startswith("botanic"):
        return "Botanical Garden"
    if value.startswith("ботаникалық"):
        return "Ботаникалық бақ"
    return "Ботанический сад"


def food_intent(query: str) -> str | None:
    if _positive_match(_PIZZA, query):
        return "pizza"
    if _positive_match(_COFFEE, query):
        return "coffee"
    if _positive_match(_MEAL, query):
        return "meal"
    return None


def pizza_fact(place: dict) -> dict | None:
    """A venue name/description cannot establish that pizza is served."""
    if not {"restaurant", "cafe"}.intersection(place["categories"]):
        return None
    evidence = {item["id"] for item in place["evidence"]}
    for fact in place["facts"]:
        if (fact["key"] not in {"osm:cuisine", "cuisine"} or fact["status"] != "known"
                or not fact["evidence_ids"] or not set(fact["evidence_ids"]).issubset(evidence)):
            continue
        values = fact["value"] if isinstance(fact["value"], list) else [fact["value"]]
        cuisines = {part.strip().casefold() for value in values if isinstance(value, str)
                    for part in re.split(r"[;,]", value)}
        if cuisines.intersection({"pizza", "italian_pizza"}):
            return fact
    return None


def stage_matches(place: dict, query: str) -> bool:
    """Fail closed on the specific named destination and pizza cuisine intent."""
    if food_intent(query) == "pizza" and pizza_fact(place) is None:
        return False
    if botanical_destination(query):
        if not {"park", "garden"}.intersection(place["categories"]):
            return False
        names = [place["name"]]
        for fact in place["facts"]:
            if (fact["status"] == "known" and (fact["key"].startswith("name:")
                    or ":aliases:" in fact["key"] or fact["key"].startswith("wikidata:label:")
                    or fact["key"] in {"osm:alt_name", "osm:short_name", "osm:official_name", "osm:int_name"}
                    or fact["key"].startswith(("osm:alt_name:", "osm:short_name:", "osm:official_name:")))):
                names.extend(fact["value"] if isinstance(fact["value"], list) else [fact["value"]])
        if not any(isinstance(name, str) and _BOTANICAL.search(name) for name in names):
            return False
    return True


def journey_stages(query: str) -> tuple[str, ...]:
    """Return explicit stages, or a narrow named-garden plus food journey.

    Empty clauses remain empty, so a missing destination is not silently lost.
    Four entries are enough to detect the public three-stop limit. No parsing
    result is interpreted as a venue, fact, tool instruction, or new constraint.
    """
    parts = _NEXT.split(query, maxsplit=3)
    if len(parts) > 1:
        if not parts[0].strip(" ,;:.!?\n\t"):
            return ()
        parts[0] = _FIRST.sub("", parts[0], count=1)
        return tuple(part.strip(" ,;:.!?\n\t") for part in parts)
    clauses = [part.strip(" ,;:.!?\n\t") for part in _JOIN.split(query)]
    if len(clauses) != 2:
        return ()
    gardens = [(index, botanical_destination(clause)) for index, clause in enumerate(clauses)]
    gardens = [(index, name) for index, name in gardens if name]
    if len(gardens) != 1:
        return ()
    garden_index, garden = gardens[0]
    food = clauses[1 - garden_index]
    if not food_intent(food) or _BOTANICAL.search(food):
        return ()
    # Explicit first markers retain textual order. With an unordered compound
    # wish the meal comes before the walk; this never affects explicit stages.
    food = _FIRST.sub("", food, count=1)
    if _FIRST.search(clauses[garden_index]):
        return (garden, food)
    return (food, garden)
