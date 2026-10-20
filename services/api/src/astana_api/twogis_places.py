"""Opt-in live 2GIS branch candidates; never merged into catalog facts or stored."""
import asyncio
from collections import deque
from datetime import date, datetime, timezone
from html.parser import HTMLParser
import logging
import math
import os
import re
import time
import unicodedata
from zoneinfo import ZoneInfo

from astana_city_context.common import JsonHTTP, ProviderError
from astana_contracts import validate_payload
from .map_features import coordinate, xy

ENDPOINT = "https://catalog.api.2gis.com/3.0/items"
FIELDS = "items.point,items.rubrics,items.schedule,items.schedule_special,items.description,items.name_ex"
_TIMEOUT_SECONDS = 5
_DAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
_DAY_LABELS = {
    "ru": ("Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"),
    "kk": ("Дс", "Сс", "Ср", "Бс", "Жм", "Сб", "Жс"),
    "en": ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"),
}
_LABELS = {
    "hours": ("Обычные часы, 2ГИС", "Әдеттегі уақыт, 2ГИС", "Regular hours, 2GIS"),
    "special": ("Особые часы", "Арнайы уақыт", "Special hours"),
    "overnight": ("следующий день", "келесі күн", "next day"),
    "unknown": ("Время не указано", "Уақыт көрсетілмеген", "Hours not stated"),
    "all_day": ("Обычное расписание: 24/7", "Әдеттегі кесте: 24/7", "Regular schedule: 24/7"),
    "valid_from": ("Расписание действует с", "Кесте басталады", "Schedule valid from"),
    "valid_to": ("Расписание действует до", "Кесте аяқталады", "Schedule valid until"),
    "comment": ("Примечание к часам, 2ГИС", "Кесте ескертпесі, 2ГИС", "Schedule note, 2GIS"),
    "partial": ("Показана часть особых дат; полное расписание — в 2ГИС", "Арнайы күндердің бір бөлігі көрсетілген; толық кесте — 2ГИС-те",
                "Some special dates are shown; see 2GIS for the full schedule"),
    "kind": ("Организация", "Ұйым", "Organization"),
}
_GENERIC_NAME_WORDS = frozenset({
    "coffee", "cafe", "café", "кофе", "кофейня", "кафе", "кофеханасы", "кофехана",
    "парк", "park", "саябақ", "саябағы", "ресторан", "restaurant", "the", "ооо", "ип",
})


class _PlainText(HTMLParser):
    """Drop markup and active-content bodies; the result is always plain text."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.blocked = [], []

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "svg", "iframe", "object", "template"}:
            self.blocked.append(tag)
        elif not self.blocked:
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in self.blocked:
            del self.blocked[self.blocked.index(tag):]
        elif not self.blocked:
            self.parts.append(" ")

    def handle_data(self, data):
        if not self.blocked:
            self.parts.append(data)


def plain(value, limit=500):
    if not isinstance(value, str):
        return None
    parser = _PlainText()
    parser.feed(value[:16_000])
    parser.close()
    text = "".join(parser.parts).encode("utf-8", errors="replace").decode()
    text = "".join(char if char.isspace() or not unicodedata.category(char).startswith("C") else " "
                   for char in text)
    return " ".join(text.split())[:limit] or None


def _name_tokens(value):
    return set(re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", value).casefold()))


def _name_matches(wanted, actual):
    wanted_tokens, actual_tokens = _name_tokens(wanted), _name_tokens(actual)
    wanted_distinct = wanted_tokens - _GENERIC_NAME_WORDS
    actual_distinct = actual_tokens - _GENERIC_NAME_WORDS
    if not wanted_distinct:
        return bool(wanted_tokens) and wanted_tokens <= actual_tokens
    # Require a distinctive name component, not just the same cafe/park category.
    if wanted_distinct & actual_distinct:
        return len(wanted_distinct & actual_distinct) / len(wanted_distinct) >= .5
    wanted_joined, actual_joined = "".join(sorted(wanted_distinct)), "".join(sorted(actual_distinct))
    return min(len(wanted_joined), len(actual_joined)) >= 4 and (
        wanted_joined in actual_joined or actual_joined in wanted_joined)


def _day(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        return None


def _minutes(value, *, end=False):
    if not isinstance(value, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
        return 1440 if end and value == "24:00" else None
    hour, minute = map(int, value.split(":"))
    return hour * 60 + minute


def _intervals(hours, locale):
    if not isinstance(hours, list) or len(hours) > 8:
        return None
    index = {"ru": 0, "kk": 1, "en": 2}[locale]
    intervals = []
    for interval in hours:
        if not isinstance(interval, dict):
            continue
        start, end = _minutes(interval.get("from")), _minutes(interval.get("to"), end=True)
        if start is None or end is None or start == end:
            continue
        suffix = f" ({_LABELS['overnight'][index]})" if end < start else ""
        rendered = f"{interval['from']}–{interval['to']}{suffix}"
        if rendered not in intervals:
            intervals.append(rendered)
    return "; ".join(intervals)[:500] or None


def schedule_attributes(schedule, specials, locale, *, reference_day=None):
    """Preserve weekday/date scope and overnight intervals; never infer open now."""
    index = {"ru": 0, "kk": 1, "en": 2}[locale]
    attrs = []
    if isinstance(schedule, dict):
        if schedule.get("is_24x7") is True:
            attrs.append({"label": _LABELS["hours"][index], "value": _LABELS["all_day"][index]})
        for day, label in zip(_DAYS, _DAY_LABELS[locale]):
            entry = schedule.get(day)
            hours = _intervals(entry.get("working_hours"), locale) if isinstance(entry, dict) else None
            if hours:
                attrs.append({"label": f"{_LABELS['hours'][index]} · {label}", "value": hours})
        for source, key in (("date_from", "valid_from"), ("date_to", "valid_to")):
            value = _day(schedule.get(source))
            if value:
                attrs.append({"label": _LABELS[key][index], "value": value})
        for key in ("comment", "description"):
            value = plain(schedule.get(key))
            if value:
                attrs.append({"label": _LABELS["comment"][index], "value": value})
    truncated = False
    if isinstance(specials, list) and len(specials) <= 100:
        today = reference_day or datetime.now(ZoneInfo("Asia/Almaty")).date()
        dates = sorted((entry for entry in specials if isinstance(entry, dict) and _day(entry.get("date"))),
                       # Nearest upcoming exceptions first, then recent past dates.
                       key=lambda entry: (date.fromisoformat(entry["date"]) < today,
                                          date.fromisoformat(entry["date"]).toordinal()
                                          if date.fromisoformat(entry["date"]) >= today
                                          else -date.fromisoformat(entry["date"]).toordinal()))
        for entry in dates[:8]:
            # Empty or missing hours are displayed as unspecified, not closed.
            attrs.append({"label": f"{_LABELS['special'][index]} · {entry['date']}",
                          "value": _intervals(entry.get("working_hours"), locale) or _LABELS["unknown"][index]})
        truncated = len(dates) > 8
    elif isinstance(specials, list):
        truncated = True
    if truncated or len(attrs) > 20:
        return attrs[:19] + [{"label": _LABELS["comment"][index], "value": _LABELS["partial"][index]}]
    return attrs[:20]


def _meta(data):
    meta = data.get("meta") if isinstance(data, dict) else None
    code = meta.get("code") if isinstance(meta, dict) else None
    if type(code) is not int or not 100 <= code <= 599:
        raise ProviderError("invalid_provider_response", reason="invalid_schema")
    if code == 429:
        raise ProviderError("rate_limited", retry_after_seconds=60, upstream_status=code, reason="http_error")
    if code not in {200, 404}:
        raise ProviderError("provider_unavailable", upstream_status=code, reason="http_error")
    return code


def normalize_places(data, place, locale, retrieved_at):
    if _meta(data) == 404:
        items = []
    else:
        result = data.get("result")
        items = result.get("items") if isinstance(result, dict) else None
        if not isinstance(items, list) or len(items) > 50:
            raise ProviderError("invalid_provider_response", reason="invalid_schema")
    location, wanted = place["location"], plain(place["name"], 300)
    features, seen = [], set()
    index = {"ru": 0, "kk": 1, "en": 2}[locale]
    for item in items[:50]:
        if not isinstance(item, dict) or item.get("type") != "branch":
            continue
        identity, name = item.get("id"), plain(item.get("name"), 300)
        if not isinstance(identity, str) or not re.fullmatch(r"[0-9]{1,30}", identity) or identity in seen or not name:
            continue
        name_ex = item.get("name_ex") if isinstance(item.get("name_ex"), dict) else {}
        primary = plain(name_ex.get("primary"), 300)
        if not wanted or not any(_name_matches(wanted, candidate) for candidate in (primary, name) if candidate):
            continue
        point = item.get("point")
        if not isinstance(point, dict) or not coordinate(point.get("lon"), 180) or not coordinate(point.get("lat"), 90):
            continue
        distance = math.hypot(*xy([point["lon"], point["lat"]], [location["lon"], location["lat"]]))
        if distance > 300:
            continue
        seen.add(identity)
        rubrics = item.get("rubrics")
        kind = next((plain(entry.get("name"), 100) for entry in rubrics[:5]
                     if isinstance(entry, dict) and plain(entry.get("name"), 100)), None) if isinstance(rubrics, list) else None
        features.append({
            "id": f"twogis:branch:{identity}", "name": name,
            "kind": kind or plain(name_ex.get("extension"), 100) or _LABELS["kind"][index],
            # name_ex.description is a name component (e.g. warehouse), not an overview.
            "description": plain(item.get("description"), 2000),
            "address": plain(item.get("address_name")),
            "location": {"lon": point["lon"], "lat": point["lat"]},
            "match": "nearby", "distance_meters": round(distance, 1),
            "attributes": schedule_attributes(item.get("schedule"), item.get("schedule_special"), locale,
                                              reference_day=datetime.fromisoformat(retrieved_at.replace("Z", "+00:00"))
                                              .astimezone(ZoneInfo("Asia/Almaty")).date()),
            "source_url": f"https://2gis.kz/astana/firm/{identity}", "source_label": "2ГИС · Places API",
        })
    features.sort(key=lambda feature: (feature["distance_meters"], feature["id"]))
    return validate_payload("MapFeatureResponse", {
        "status": "ok" if features else "empty", "features": features[:5],
        "retrieved_at": retrieved_at, "attribution": "© 2ГИС · https://dev.2gis.ru",
    })


def _log_failure(error):
    code = error.code if error.code in {"rate_limited", "provider_unavailable", "invalid_provider_response"} else "provider_error"
    reason = error.reason if error.reason in {
        "http_error", "timeout", "transport_error", "rejected_encoding", "response_too_large",
        "invalid_json", "invalid_shape", "invalid_schema", "key_not_configured",
    } else "unclassified"
    logging.getLogger("uvicorn.error").warning(
        "2GIS request failed: reason=%s code=%s upstream_status=%s", reason, code, error.upstream_status)


class TwoGisPlacesService:
    def __init__(self, *, enabled=False, api_key=None, http=None, clock=time.monotonic):
        self.enabled = enabled
        self._api_key = os.getenv("TWOGIS_API_KEY", "") if api_key is None else api_key
        self.http = http or JsonHTTP(timeout_seconds=_TIMEOUT_SECONDS, retries=0, max_bytes=256_000)
        if getattr(self.http, "retries", 0) != 0:
            raise ValueError("2GIS Places requires zero HTTP retries")
        if getattr(self.http, "max_bytes", 256_000) > 256_000:
            raise ValueError("2GIS Places response limit must not exceed 256000 bytes")
        self.clock, self.calls = clock, deque()
        self.gate, self.cooldown = asyncio.Lock(), 0.0
        if self.enabled and not self._api_key:
            _log_failure(ProviderError("provider_unavailable", reason="key_not_configured"))

    async def aclose(self):
        await self.http.aclose()

    async def search(self, place, locale):
        if not self.enabled or not self._api_key:
            raise ProviderError("provider_unavailable")
        location = place.get("location") if isinstance(place, dict) else None
        name = plain(place.get("name"), 300) if isinstance(place, dict) else None
        if (locale not in {"ru", "kk", "en"} or not name or not isinstance(location, dict)
                or not coordinate(location.get("lon"), 180) or not coordinate(location.get("lat"), 90)
                or not 50.8 <= location["lat"] <= 51.4 or not 71 <= location["lon"] <= 71.8):
            raise ProviderError("invalid_request")
        try:
            # Includes our concurrency gate, provider stream and normalization.
            async with asyncio.timeout(_TIMEOUT_SECONDS):
                return await self._search(place, name, locale)
        except TimeoutError:
            error = ProviderError("provider_unavailable", reason="timeout")
            _log_failure(error)
            raise error from None

    async def _search(self, place, name, locale):
        async with self.gate:
            now = self.clock()
            while self.calls and now - self.calls[0] >= 86400:
                self.calls.popleft()
            if (now < self.cooldown or len(self.calls) >= 100
                    or sum(now - stamp < 60 for stamp in self.calls) >= 6
                    or self.calls and now - self.calls[-1] < 5):
                raise ProviderError("rate_limited")
            self.calls.append(now)
            try:
                location = place["location"]
                data = await self.http.request("GET", ENDPOINT, params={
                    "key": self._api_key, "q": name, "type": "branch", "page_size": 5,
                    "point": f"{location['lon']},{location['lat']}", "radius": 300,
                    "locale": "kk_KZ" if locale == "kk" else "ru_KZ",
                    "search_is_query_text_complete": "true", "fields": FIELDS,
                })
                # No response cache, catalog writes, LLM transfer or payload logs.
                return normalize_places(data, place, locale, datetime.now(timezone.utc).isoformat())
            except ProviderError as error:
                _log_failure(error)
                if error.code == "rate_limited":
                    self.cooldown = self.clock() + max(60, error.retry_after_seconds)
                raise
            except (ValueError, TypeError, KeyError, IndexError, OverflowError, RecursionError):
                error = ProviderError("invalid_provider_response", reason="invalid_schema")
                _log_failure(error)
                raise error from None
