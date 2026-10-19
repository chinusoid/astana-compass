"""Bounded source-name matching; no translations, geocoding or generated aliases."""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import re

from .lexicon import ACTIVITIES, ANCHOR_AFTER, STOPWORDS, WORDS, negated, normalize, understand

NAME_KEYS = frozenset({
    *(f"name:{lang}" for lang in ("ru", "kk", "en")),
    *(f"osm:{kind}{suffix}" for kind in ("alt_name", "short_name", "official_name")
      for suffix in ("", ":ru", ":kk", ":en")),
    "osm:int_name",
    *(f"wikidata:{kind}:{lang}" for kind in ("label", "aliases") for lang in ("ru", "kk", "en")),
})
TEXT_KEYS = frozenset({
    "osm:cuisine", "osm:addr:street", "osm:addr:place",
    "osm:description", *(f"osm:description:{lang}" for lang in ("ru", "kk", "en")),
    *(f"wikidata:description:{lang}" for lang in ("ru", "kk", "en")),
})
ANCHOR_START = re.compile(
    r"(?<!\w)(?:near|by|beside|around|next\s+to|close\s+to|у|возле|около|рядом\s+с|недалеко\s+от)\s+", re.I,
)
NEW_GOAL = re.compile(r"\b(?:i\s+(?:want|need|would|am)|we\s+(?:want|need)|find|хочу|хотим|ищу|найди|нужно|нужна|мне)\b", re.I)


def words(text: str) -> tuple[str, ...]:
    return tuple(match.group() for match in WORDS.finditer(normalize(text)) if len(match.group()) <= 64)


def source_names(place: dict) -> list[tuple[str, str | None]]:
    result, seen = [], set()
    values = [(place["name"], None)]
    for fact in place["facts"]:
        if fact["key"] not in NAME_KEYS or fact["status"] != "known":
            continue
        raw = fact["value"]
        if isinstance(raw, str):
            # OSM multivalued aliases use a semicolon; never split human names on commas.
            values.extend((value, fact["key"]) for value in raw.split(";")[:16])
        elif isinstance(raw, list):
            values.extend((value, fact["key"]) for value in raw[:16] if isinstance(value, str))
    for value, key in values:
        value = normalize(value[:500]).strip()
        identity = (value, key)
        if value and identity not in seen:
            result.append((value, key))
            seen.add(identity)
        if len(result) >= 64:
            break
    return result


def source_texts(place: dict) -> list[tuple[str, str | None]]:
    result = [((place.get("description") or "")[:8000], None)]
    result.extend((fact["value"][:2000], fact["key"]) for fact in place["facts"]
                  if fact["key"] in TEXT_KEYS and fact["status"] == "known" and isinstance(fact["value"], str))
    return result[:32]


@lru_cache(maxsize=8192)
def _phrase_pattern(name: str) -> re.Pattern[str] | None:
    tokens = words(name)
    # Generic one-word source names such as "Cafe" must not hijack category queries.
    if not tokens or (len(tokens) == 1 and not understand(name).terms.difference(
        {term for term in understand(name).terms if ":" in term}
    )):
        return None
    suffix = r"(?:ға|ге|қа|ке|да|де|та|те|дан|ден|тан|тен|ның|нің)?" if (
        len(tokens[-1]) >= 5 and all("\u0400" <= char <= "\u052f" for char in tokens[-1])
    ) else ""
    return re.compile(r"(?<!\w)" + r"[\W_]+".join(re.escape(token) for token in tokens) + suffix + r"(?!\w)")


def goal_text(text: str, names: list[list[tuple[str, str | None]]]) -> tuple[str, bool]:
    """Mask anchor wording, preserving a following explicit request. No location inference."""
    normalized = normalize(text)
    masked = list(normalized)
    found = False
    for match in ANCHOR_START.finditer(normalized):
        tail = normalized[match.end():]
        boundary = re.search(r"[,;.!?\n]", tail)
        new_goal = NEW_GOAL.search(tail)
        ends = [item.start() for item in (boundary, new_goal) if item]
        end = match.end() + (min(ends) if ends else len(tail))
        masked[match.start():end] = " " * (end - match.start())
        found = True
    # Kazakh postpositions follow the named anchor; match only source-backed names.
    for aliases in names:
        for name, _ in aliases:
            pattern = _phrase_pattern(name)
            if pattern is None:
                continue
            for match in pattern.finditer(normalized):
                suffix = ANCHOR_AFTER.match(normalized[match.end():])
                if suffix:
                    end = match.end() + suffix.end()
                    masked[match.start():end] = " " * (end - match.start())
                    found = True
    return "".join(masked), found


@dataclass(frozen=True)
class NameMention:
    start: int
    end: int
    key: str | None


def mentions(text: str, aliases: list[tuple[str, str | None]]) -> list[NameMention]:
    result = []
    activities = [match.span() for pattern in ACTIVITIES.values() for match in pattern.finditer(text)]
    for name, key in aliases:
        pattern = _phrase_pattern(name)
        if pattern:
            for match in pattern.finditer(text):
                # A source name such as «Дәмді» must not capture the larger activity
                # «Дәмді ас». An exact full activity/name remains a literal mention.
                if any(start <= match.start() and match.end() <= end and match.span() != (start, end)
                       for start, end in activities):
                    continue
                if not negated(text, match.start(), match.end()):
                    result.append(NameMention(match.start(), match.end(), key))
    return result


def one_edit(left: str, right: str) -> bool:
    """One insertion/deletion/substitution/transposition; never short or cross-script."""
    if min(len(left), len(right)) < 5 or abs(len(left) - len(right)) > 1 or left == right:
        return False
    def script(value):
        return {"cyrillic" if "\u0400" <= char <= "\u052f" else "latin" if "a" <= char <= "z" else "other"
                for char in value if char.isalpha()}
    if script(left) != script(right):
        return False
    if len(left) == len(right):
        positions = [index for index, (a, b) in enumerate(zip(left, right, strict=True)) if a != b]
        return len(positions) == 1 or (
            len(positions) == 2 and positions[1] == positions[0] + 1
            and left[positions[0]] == right[positions[1]] and left[positions[1]] == right[positions[0]]
        )
    shorter, longer = (left, right) if len(left) < len(right) else (right, left)
    position = next((i for i, (a, b) in enumerate(zip(shorter, longer)) if a != b), len(shorter))
    return shorter == longer[:position] + longer[position + 1:]


def typo_expansions(terms: frozenset[str], names: list[list[tuple[str, str | None]]]) -> dict[str, str]:
    vocabulary = {word for aliases in names for name, _ in aliases for word in words(name)
                  if len(word) >= 5 and word not in STOPWORDS and ":" not in word}
    expansions = {}
    for term in sorted(terms):
        if ":" in term or term in vocabulary or len(term) < 5:
            continue
        candidates = [word for word in vocabulary if one_edit(term, word)]
        # Ambiguous corrections are worse than an honest no-match.
        if len(candidates) == 1:
            expansions[term] = candidates[0]
    return expansions
