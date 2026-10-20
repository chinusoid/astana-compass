"""Source-based optional ideas; these never become requested route stops."""

from __future__ import annotations

from collections.abc import Callable
from copy import deepcopy
import math
import re
import unicodedata

from astana_contracts import JSON


CATEGORIES = ("museum", "gallery", "artwork", "arts_centre", "attraction", "theatre")
QUERY = "Optional nearby places"
_NEGATION = re.compile(
    r"(?<!\w)(?:не|нет|без|никак\w*|ничего|кроме|исключ\w*|только|лишь|not|no|never|nothing|"
    r"without|avoid|except|only|\w+n['’]t|cannot|do\s+not|"
    r"емес|жоқ|келм\w*|(?:же|іш)\w*(?:май|мей)\w*|тек)(?!\w)", re.I,
)
_BLOCKED = frozenset({"park", "garden", "cafe", "coffee_shop", "restaurant", "fast_food", "food_court"})
_DYNAMIC_FACTS = frozenset({"open_at_requested_time", "weather_suitable"})
_LABELS = {
    "ru": {"museum": "музей", "art": "место, связанное с искусством", "theatre": "театр", "attraction": "достопримечательность"},
    "kk": {"museum": "мұражай", "art": "өнерге қатысты орын", "theatre": "театр", "attraction": "көрікті жер"},
    "en": {"museum": "museum", "art": "art place", "theatre": "theatre", "attraction": "point of interest"},
}
_WHY = {
    "ru": "Необязательная идея для разнообразия: {category} рядом с вашей остановкой. До неё не больше 1 км по прямой; пеший путь пока не рассчитан.",
    "kk": "Қосымша ұсыныс: серуенді түрлендіру үшін аялдамаңызға жақын «{category}» орнына баруға болады. Түзу сызықпен 1 км-ден аспайды; жаяу жолы әлі есептелмеген.",
    "en": "Optional idea for a change of pace: a {category} near one of your stops. It is within 1 km in a straight line; the walking route has not been calculated yet.",
}
_ACTIVITY = {
    "ru": {
        "museum": "Можно заглянуть в музей. Часы работы и доступные экспозиции лучше уточнить заранее.",
        "art": "Можно рассмотреть художественные детали и выбрать то, что хочется изучить ближе. Доступ к месту уточните заранее.",
        "theatre": "Если захочется театра, посмотрите афишу и условия посещения.",
        "attraction": "Можно осмотреться и рассмотреть интересные детали этого места. Условия доступа уточните заранее.",
    },
    "kk": {
        "museum": "Қызық болса, мұражайға баруды қарастырыңыз; жұмыс уақытын және қолжетімді экспозицияларды бөлек нақтылаңыз.",
        "art": "Қызық болса, орынды және көркемдік бөлшектерін қарастырыңыз; кіру шарттарын бөлек нақтылаңыз.",
        "theatre": "Қызық болса, театрға баруды қарастырыңыз; афиша, билет және кіру шарттарын бөлек нақтылаңыз.",
        "attraction": "Қызық болса, осы көрікті жерді қарастырыңыз; кіру шарттарын бөлек нақтылаңыз.",
    },
    "en": {
        "museum": "If it interests you, consider a museum visit; check opening hours and available exhibitions separately.",
        "art": "If it interests you, look at the place and its artistic details; check access separately.",
        "theatre": "If it interests you, consider a theatre visit; check the programme, tickets and access separately.",
        "attraction": "If it interests you, take a closer look at this point of interest; check access separately.",
    },
}


def distance_meters(left: JSON, right: JSON) -> float:
    """Straight-line distance only; never a routed distance or walking claim."""
    latitude = math.radians(right["lat"] - left["lat"])
    longitude = math.radians(right["lon"] - left["lon"])
    square = (math.sin(latitude / 2) ** 2 + math.cos(math.radians(left["lat"]))
              * math.cos(math.radians(right["lat"])) * math.sin(longitude / 2) ** 2)
    return 6_371_000 * 2 * math.asin(min(1, math.sqrt(square)))


def safe_query(query: str) -> bool:
    # Exclusions are interpreted by the main stage searches. This optional
    # lookup has no extraction contract for arbitrary exclusions, so omission
    # is safer than broadening a negative wish into an extra visit.
    return _NEGATION.search(query) is None


def retrieval_request(request: JSON, core: list[JSON]) -> JSON:
    return {
        "query": QUERY, "locale": request["locale"],
        "origin": deepcopy(core[-1]["location"]), "radius_meters": 1_000,
        "constraints": deepcopy(request["constraints"]), "candidate_limit": 12,
        "named_place": None, "cuisine": None, "categories": list(CATEGORIES),
    }


def _name(place: JSON) -> str:
    return " ".join(re.findall(r"\w+", unicodedata.normalize("NFKC", place["name"]).casefold()))


def _family(place: JSON) -> str | None:
    categories = set(place["categories"])
    if categories.intersection(_BLOCKED):
        return None
    for family, values in (
        ("museum", {"museum"}), ("art", {"gallery", "artwork", "arts_centre"}),
        ("theatre", {"theatre"}), ("attraction", {"attraction"}),
    ):
        if categories.intersection(values):
            return family
    return None


def select_suggestions(
    candidates: list[JSON], core: list[JSON], request: JSON,
    evaluate: Callable[[JSON, JSON], list[JSON]],
) -> tuple[list[JSON], list[JSON]]:
    """Choose at most two distinct source types without changing core input."""
    limit = min(2, 6 - len(core))
    if limit <= 0:
        return [], []
    used_ids = {place["id"] for place in core}
    used_names = {_name(place) for place in core}
    used_families = {_family(place) for place in core}
    ranked = sorted(candidates, key=lambda place: (
        min(distance_meters(place["location"], stop["location"]) for stop in core), place["id"],
    ))
    suggestions, places = [], []
    for original in ranked:
        family = _family(original)
        if original["id"] in used_ids or _name(original) in used_names or family is None or family in used_families:
            continue
        nearby = [distance_meters(original["location"], stop["location"]) for stop in [*core, *places]]
        if min(nearby[:len(core)]) > 1_000 or min(nearby) < 60:
            continue
        place = deepcopy(original)
        # No context calls are made for optional ideas. Snapshot request-time
        # facts cannot be promoted to current opening/weather confirmation.
        for fact in place["facts"]:
            if fact["key"] in _DYNAMIC_FACTS:
                fact.update(status="unknown", value=None, evidence_ids=[])
                fact.pop("note", None)
        evaluations = evaluate(place, request)
        if any(item["strength"] == "required" and item["outcome"] != "satisfied" for item in evaluations):
            continue
        locale = request["locale"]
        suggestions.append({
            "place_id": place["id"], "why": _WHY[locale].format(category=_LABELS[locale][family]),
            "suggested_activity": _ACTIVITY[locale][family], "constraint_evaluations": evaluations,
        })
        places.append(place)
        used_ids.add(place["id"])
        used_names.add(_name(place))
        used_families.add(family)
        if len(suggestions) == limit:
            break
    return suggestions, places
