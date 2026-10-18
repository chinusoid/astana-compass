"""Conservative, offline evaluation of the documented opening_hours subset.

Input/output dictionaries use the canonical contracts. This helper returns one
derived fact; the ContextProvider owns copying, replacement and validation.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
import re
from zoneinfo import ZoneInfo

from astana_contracts import JSON


_ZONE = ZoneInfo("Asia/Almaty")
_DAYS = {name: index for index, name in enumerate("Mo Tu We Th Fr Sa Su".split())}
_MONTHS = {name: index for index, name in enumerate(
    "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(), start=1
)}
_DAY_SELECTOR = r"(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:,(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*"
_CLOCK = r"\d{2}:\d{2}"
_TIMES = re.compile(rf"{_CLOCK}-{_CLOCK}(?:\s*,\s*{_CLOCK}-{_CLOCK})*")
_DATE_SELECTOR = re.compile(r"(?:(\d{4}) )?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2})(?=\s|:|$)")
_TEXT = {
    "en": {
        "missing": "Published opening hours are missing or unknown.",
        "conflict": "Published opening hours conflict; no opening status can be confirmed.",
        "unsupported": "The published opening-hours format is unsupported or invalid.",
        "holiday": "Public/school holiday rules require an authoritative local holiday calendar.",
        "evidence": "Opening hours have no valid supporting source evidence.",
        "known": "According to published opening hours: {state} at {at} (Asia/Almaty). This does not confirm actual operation; source retrieval time is not schedule verification time.",
        "open": "open", "closed": "closed",
    },
    "ru": {
        "missing": "Опубликованное расписание отсутствует или неизвестно.",
        "conflict": "Источники расписания противоречат друг другу; подтвердить часы работы нельзя.",
        "unsupported": "Формат опубликованного расписания не поддерживается или некорректен.",
        "holiday": "Правила государственных и школьных праздников требуют достоверного местного календаря.",
        "evidence": "У расписания нет корректных подтверждающих свидетельств источника.",
        "known": "По опубликованному расписанию: {state} на {at} (Asia/Almaty). Фактическая работа не подтверждена; время загрузки источника не является временем проверки расписания.",
        "open": "открыто", "closed": "закрыто",
    },
    "kk": {
        "missing": "Жарияланған жұмыс кестесі жоқ немесе белгісіз.",
        "conflict": "Жұмыс кестесінің дереккөздері бір-біріне қайшы; жұмыс уақытын растау мүмкін емес.",
        "unsupported": "Жарияланған жұмыс кестесінің пішімі қолдау таппайды немесе қате.",
        "holiday": "Мемлекеттік және мектеп мерекелеріне қатысты ережелерге сенімді жергілікті күнтізбе қажет.",
        "evidence": "Жұмыс кестесін растайтын жарамды дереккөз дәлелі жоқ.",
        "known": "Жарияланған кесте бойынша: {state}, уақыт {at} (Asia/Almaty). Нақты жұмыс істеуі расталмаған; дереккөзді жүктеу уақыты кестені тексеру уақыты емес.",
        "open": "ашық", "closed": "жабық",
    },
}


class _Unsupported(ValueError):
    pass


@dataclass(frozen=True)
class _Rule:
    weekdays: frozenset[int]
    # (year or None, month, day); None means every date.
    calendar_date: tuple[int | None, int, int] | None
    intervals: tuple[tuple[int, int], ...]
    closed: bool

    def applies(self, day: date) -> bool:
        if day.weekday() not in self.weekdays:
            return False
        if self.calendar_date is None:
            return True
        year, month, monthday = self.calendar_date
        return (year is None or day.year == year) and (day.month, day.day) == (month, monthday)


def _minutes(clock: str, *, end: bool) -> int:
    hour, minute = map(int, clock.split(":"))
    if minute > 59 or hour > 24 or (hour == 24 and (minute or not end)):
        raise _Unsupported("invalid clock")
    return hour * 60 + minute


def _after_selector(body: str) -> str:
    remaining = body.lstrip()
    if remaining.startswith(":"):
        remaining = remaining[1:].lstrip()
    return remaining


def _parse(value: str) -> list[_Rule]:
    if not value.strip() or len(value) > 8192:
        raise _Unsupported("empty or excessive schedule")
    parts = value.strip().split(";")
    if len(parts) > 128:
        raise _Unsupported("too many rules")
    rules = []
    for part in parts:
        body = part.strip()
        days = frozenset(range(7))
        calendar_date = None
        selected_weekdays = False
        match = _DATE_SELECTOR.match(body)
        if match:
            year = int(match[1]) if match[1] else None
            month, monthday = _MONTHS[match[2]], int(match[3])
            try:
                # Leap-year validation permits annual Feb 29.
                date(year if year is not None else 2000, month, monthday)
            except ValueError as exc:
                raise _Unsupported("invalid calendar date") from exc
            calendar_date = year, month, monthday
            body = _after_selector(body[match.end():])
        match = re.match(rf"({_DAY_SELECTOR})(?=\s|:|$)", body)
        if match:
            selected_weekdays = True
            selected = set()
            for item in match[1].split(","):
                endpoints = item.split("-")
                first = _DAYS[endpoints[0]]
                last = _DAYS[endpoints[-1]]
                selected.update((first + offset) % 7 for offset in range((last - first) % 7 + 1))
            days = frozenset(selected)
            body = _after_selector(body[match.end():])
        closed = body in {"off", "closed"}
        if body == "24/7" and (calendar_date is not None or selected_weekdays):
            # 24/7 is a standalone selector in the OSM grammar.
            raise _Unsupported("24/7 cannot have selectors")
        if body in {"24/7", "open", "off", "closed"}:
            intervals = [(0, 1440)]
        else:
            modifier = re.search(r"\s+(open|off|closed)$", body)
            if modifier:
                closed = modifier[1] in {"off", "closed"}
                body = body[:modifier.start()]
            if not _TIMES.fullmatch(body):
                raise _Unsupported("unsupported rule")
            intervals = []
            for span in body.split(","):
                start_s, end_s = span.strip().split("-")
                start, end = _minutes(start_s, end=False), _minutes(end_s, end=True)
                if end == start:
                    raise _Unsupported("ambiguous zero-duration interval")
                if end < start:
                    end += 1440
                intervals.append((start, end))
        rules.append(_Rule(days, calendar_date, tuple(intervals), closed))
    return rules


def _evaluate(rules: list[_Rule], at: datetime) -> bool:
    today = at.date()
    yesterday = today - timedelta(days=1)
    minute = at.hour * 60 + at.minute + at.second / 60 + at.microsecond / 60_000_000
    # Keep the source day of an opening interval. Replacing yesterday's normal
    # hours must also replace their spillover, without erasing unrelated hours
    # selected explicitly for today.
    opened_today = False
    opened_yesterday = False
    for rule in rules:
        current = rule.applies(today)
        previous = rule.applies(yesterday)
        current_active = current and any(start <= minute < end for start, end in rule.intervals)
        previous_active = previous and any(start <= minute + 1440 < end for start, end in rule.intervals)
        if rule.closed:
            # OSM closed rules only cut the times they match.
            if current_active or previous_active:
                opened_today = opened_yesterday = False
        else:
            if current:
                # Today's normal rule also replaces an earlier incoming spill.
                opened_today = current_active
                opened_yesterday = False
            if previous:
                # This assignment is required even when the replacement has no
                # overnight interval: the old overnight hours no longer apply.
                # When the same rule selects both days, retain its own spill.
                opened_yesterday = previous_active
    return opened_today or opened_yesterday


def enrich_schedule(place: JSON, *, at: datetime, locale: str) -> tuple[JSON, list[str]]:
    """Derive ``open_at_requested_time`` without mutating input or inventing evidence.

    ``at`` must be timezone-aware; its instant is converted into Asia/Almaty.
    Unsupported source syntax yields unknown, never an optimistic open result.
    """
    if locale not in _TEXT:
        raise ValueError("locale must be ru, kk or en")
    if not isinstance(at, datetime) or at.tzinfo is None or at.utcoffset() is None:
        raise ValueError("at must be a timezone-aware datetime")
    local_at = at.astimezone(_ZONE)
    text = _TEXT[locale]

    def unresolved(reason: str, *, conflict_ids: list[str] | None = None) -> tuple[JSON, list[str]]:
        note = text[reason]
        return {
            "key": "open_at_requested_time", "status": "conflicting" if conflict_ids else "unknown",
            "value": None, "evidence_ids": list(conflict_ids or []), "note": note,
        }, [note]

    facts = [fact for fact in place.get("facts", []) if fact.get("key") == "opening_hours"]
    if not facts:
        return unresolved("missing")
    # Duplicate keys are invalid at the public boundary; remain conservative if
    # the helper is used before validation.
    if len(facts) != 1:
        return unresolved("unsupported")
    fact = facts[0]
    available_ids = {item["id"] for item in place.get("evidence", [])}
    evidence_ids = list(dict.fromkeys(fact.get("evidence_ids", [])))
    valid_evidence = bool(evidence_ids) and all(item in available_ids for item in evidence_ids)
    if fact.get("status") == "conflicting":
        if valid_evidence and len(evidence_ids) >= 2:
            return unresolved("conflict", conflict_ids=evidence_ids)
        return unresolved("evidence")
    if fact.get("status") != "known":
        return unresolved("missing")
    if not valid_evidence:
        return unresolved("evidence")
    value = fact.get("value")
    if not isinstance(value, str):
        return unresolved("unsupported")
    if re.search(r"\b(?:PH|SH)\b", value):
        return unresolved("holiday")
    try:
        opened = _evaluate(_parse(value), local_at)
    except (ValueError, OverflowError):
        return unresolved("unsupported")
    note = text["known"].format(
        state=text["open" if opened else "closed"], at=local_at.isoformat(timespec="seconds")
    )
    return {
        "key": "open_at_requested_time", "status": "known", "value": opened,
        "evidence_ids": evidence_ids, "note": note,
    }, []
