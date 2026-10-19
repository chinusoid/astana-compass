"""Small, versioned RU/KK/EN lexicon; these are search expansions, never facts."""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
import re
import unicodedata

LEXICON_VERSION = "ru-kk-en-3"
CATEGORIES = {
    "cafe": r"кафе(?:ге|де|ден|ні|нің|лер(?:ге|де|ден|і|ін)?)?|кофе\w{0,12}|coffee|caf[eé]s?|cappuccino|капучино|латте",
    "restaurant": r"рестора\w{0,12}|поесть|обед\w{0,12}|ужин\w{0,12}|еда|restaurants?|dining|lunch|dinner|eat|тамақ\w{0,12}|мейрамхана\w{0,12}",
    "museum": r"музе\w{0,12}|museums?|мұражай\w{0,12}",
    "park": r"парк\w{0,12}|сквер\w{0,12}|parks?|саябақ\w{0,12}",
    "garden": r"сад|сада|саду|ботаническ\w{0,12}|gardens?|botanical|бақ|баққа|ботаникалық",
    "playground": r"детск\w{0,12}\s+площад\w{0,12}|playgrounds?|ойын\s+алаң\w{0,12}",
    "library": r"библиотек\w{0,12}|librar(?:y|ies)|кітапхана\w{0,12}",
    "theatre": r"театр\w{0,12}|theat(?:re|er)s?|спектакл\w{0,12}",
    "cinema": r"кино\w{0,12}|cinemas?|movies?|film|фильм\w{0,12}",
    "art": r"галере\w{0,12}|искусств\w{0,12}|выстав\w{0,12}|art|galler(?:y|ies)|exhibition\w{0,12}|өнер|көрме\w{0,12}",
    "viewpoint": r"смотров\w{0,12}|панорам\w{0,12}|viewpoints?|observation\s+deck|panoram\w{0,12}",
    "attraction": r"достопримечательност\w{0,12}|attractions?|sightseeing|көрікті\s+жер\w{0,12}",
}
CATEGORY_GROUPS = {
    **{key: frozenset({key}) for key in CATEGORIES},
    "art": frozenset({"art", "gallery", "arts_centre", "artwork"}),
    "park": frozenset({"park", "garden"}),
    "paintings": frozenset({"gallery", "museum"}),
    # Discovery categories, never an assertion of beauty or proximity to water.
    "scenic": frozenset({"park", "garden", "viewpoint"}),
}
FEATURES = {
    "quiet": r"тих\w{0,12}|тишин\w{0,12}|спокойн\w{0,12}|quiet|peaceful|тыныш\w{0,12}|без\s+шума|not\s+noisy",
    "has_power_outlets": r"розет\w{0,12}|заряд\w{0,12}|sockets?|power\s+(?:outlets?|sockets?)|charging|қуатта\w{0,12}",
    "has_wifi": r"wi[ -]?fi|вайфай|интернет|internet",
    "indoor": r"помещени\w{0,12}|внутри|indoors?|inside|ғимарат\s+іш\w{0,12}|үй-жай\w{0,12}",
    "child_friendly": r"реб[её]н\w{0,12}|детьми|детей|kids?|children|child|баламен|балалар\w{0,12}",
    "wheelchair_accessible": r"безбарьер\w{0,12}|инвалид\w{0,12}\s+коляс\w{0,12}|wheelchair\w{0,12}|step.free|кедергісіз|мүгедек\w{0,12}\s+арб\w{0,12}",
    "free_entry": r"бесплат\w{0,12}|free\s+(?:entry|admission)|no\s+(?:entry\s+)?fee|тегін",
}
PATTERNS = {
    key: re.compile(r"(?<!\w)(?:" + pattern + r")(?!\w)", re.I)
    for key, pattern in {**CATEGORIES, **FEATURES}.items()
}
CLAUSE = re.compile(r"[,;.!?\n]|\b(?:но|but|instead|однако|а|бірақ)\b", re.I)
WALK = re.compile(r"(?<!\w)(?:погулять|гулять|прогул\w{0,12}|walk\w{0,8}|серуен\w{0,12})(?!\w)", re.I)
ACTIVITIES = {
    "library": re.compile(r"(?<!\w)(?:study|studying|read\s+books?|позаниматься|почитать|оқуға|кітап\s+оқу)(?!\w)", re.I),
    "restaurant": re.compile(r"(?<!\w)дәмді\s+ас(?!\w)", re.I),
    "paintings": re.compile(r"(?<!\w)(?:paintings?|картины|картиналар)(?!\w)", re.I),
    "scenic": re.compile(
        r"(?<!\w)(?:живописн\w{0,12}|красив\w{0,12}|scenic|picturesque|beautiful|көркем|әдемі)"
        r"(?:\s+(?:мест[ао]|places?|spots?|орын(?:дар)?))?(?!\w)", re.I,
    ),
}
ANCHOR_BEFORE = re.compile(
    r"(?<!\w)(?:near|by|beside|around|next\s+to|close\s+to|у|возле|около|от|рядом\s+с|недалеко\s+от)"
    r"\s+(?:(?:a|an|the)\s+)?$", re.I,
)
ANCHOR_AFTER = re.compile(r"^\s+(?:жанында(?:ғы)?|маңында(?:ғы)?|қасында(?:ғы)?)(?!\w)", re.I)
NEG_BEFORE = re.compile(r"(?<!\w)(?:не|без|not|no|without|avoid|don['’]?t|doesn['’]?t)(?!\w)", re.I)
# Scope a prefix to its following phrase. Arbitrary earlier nouns/distance
# phrases must not negate a later goal: "no stairs museum", "без сахара кофе".
NEG_BRIDGE = re.compile(
    r"\s*(?:(?:нуж\w{0,8}|хочу|хотим|надо|мне|нам|с|очень|тих\w{0,8}|спокойн\w{0,8}|"
    r"need|want|like|a|an|the|any|to|for|very|quiet|peaceful|indoor|outdoor)\s+){0,6}", re.I,
)
NEG_AFTER = re.compile(
    r"^\s*(?:(?:мне|нам|is|are)\s+)?(?:не\s+(?:нуж\w{0,12}|важ\w{0,12}|обязател\w{0,12}|хочу)|"
    r"(?:not|(?:isn|aren)['’]t)\s+(?:needed|required|important)|optional|doesn['’]t\s+matter|"
    r"(?:керек|қажет|маңызды)\s+емес|емес)", re.I,
)
WORDS = re.compile(r"[^\W_]+(?:['’][^\W_]+)*", re.UNICODE)
STOPWORDS = frozenset("""
я мы мне нам меня нас хочу хотим нужно нужна нужны нужен найти найди ищу есть где рядом около возле выпить сходить
место места куда можно пожалуйста для чтобы и или на в во у с со к от до за по это тут там сейчас
а но не без час часа часов минут минуты минуту мин сегодня завтра вечером утром аст whereto
i we me my our want would like find please need needs needed a an the to at in on near nearby with
and or for of by is are it this somewhere place places go have has can now today tomorrow not no without
minutes minute hours hour mins min hr h astana астана астане астаны
мен маған біз бізге керек қажет бар қайда жақын жанында үшін және немесе бір екі сағат минут барғым келеді жаяу
бойынша осы жер орын қаласы қалада қазір емес
""".split())


def normalize(text: str) -> str:
    return unicodedata.normalize("NFKC", text).casefold().replace("ё", "е")


def negated(clause: str, start: int, end: int) -> bool:
    if NEG_AFTER.search(clause[end:]):
        return True
    if re.fullmatch(r"без\s+шума|not\s+noisy|no\s+(?:entry\s+)?fee", clause[start:end], re.I):
        return False
    prefixes = list(NEG_BEFORE.finditer(clause[:start]))
    return bool(prefixes and NEG_BRIDGE.fullmatch(clause[prefixes[-1].end():start]))


@dataclass(frozen=True)
class Query:
    terms: frozenset[str]
    categories: frozenset[str]
    excluded_categories: frozenset[str]
    features: frozenset[str]
    has_unresolved_anchor: bool


def understand(text: str, *, named_goal: bool = False) -> Query:
    terms, positive, negative, features, negative_features = set(), set(), set(), set(), set()
    walk_requested, has_anchor, activities = False, False, set()
    for clause in CLAUSE.split(normalize(text)):
        covered: set[int] = set()
        for match in WALK.finditer(clause):
            covered.update(range(match.start(), match.end()))
            walk_requested |= not negated(clause, match.start(), match.end())
        for category, pattern in ACTIVITIES.items():
            for match in pattern.finditer(clause):
                covered.update(range(match.start(), match.end()))
                if not negated(clause, match.start(), match.end()):
                    activities.add(category)
        for key, pattern in PATTERNS.items():
            for match in pattern.finditer(clause):
                covered.update(range(match.start(), match.end()))
                is_negative = negated(clause, match.start(), match.end())
                if key in CATEGORIES:
                    is_anchor = ANCHOR_BEFORE.search(clause[:match.start()]) or ANCHOR_AFTER.search(clause[match.end():])
                    if is_anchor:
                        has_anchor = True
                    else:
                        (negative if is_negative else positive).add(key)
                else:
                    (negative_features if is_negative else features).add(key)
        for match in WORDS.finditer(clause):
            token = match.group()
            if (
                match.start() not in covered and 2 <= len(token) <= 64 and not token.isdecimal()
                and token not in STOPWORDS and not negated(clause, match.start(), match.end())
            ):
                terms.add(token)
    positive -= negative
    features -= negative_features
    if not positive and not named_goal:
        positive.update(activities - negative)
    # A walk is an activity, not a competing park destination when the user
    # explicitly asks to walk to a cafe/museum. Spatial anchors are not goals.
    if walk_requested and not positive and "park" not in negative and not named_goal:
        positive.add("park")
    terms.update("category:" + key for key in positive)
    terms.update("feature:" + key for key in features)
    return Query(
        frozenset(terms), frozenset().union(*(CATEGORY_GROUPS[k] for k in positive)),
        frozenset().union(*(CATEGORY_GROUPS[k] for k in negative)), frozenset(features), has_anchor,
    )


def document_terms(place: dict) -> Counter[str]:
    """Source wording and known true facts are searchable, not equally authoritative."""
    from .names import source_names, source_texts, words

    terms: Counter[str] = Counter()
    for name, _ in source_names(place):
        # Literal names are source data, never parsed as negation or category commands.
        for term in words(name):
            terms[term] = 3
    for text, _ in source_texts(place):
        parsed = understand(text)
        # A lexical feature token from wording is not a matched_fact_keys claim.
        for term in parsed.terms:
            terms[term] = max(terms[term], 1)
    for key, categories in CATEGORY_GROUPS.items():
        if categories.intersection(place["categories"]):
            terms["category:" + key] += 3
    for fact in place["facts"]:
        if fact["key"] in FEATURES and fact["status"] == "known" and fact["value"] is True:
            terms["feature:" + fact["key"]] += 2
    return terms
