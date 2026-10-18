"""Canonical context port and composition factory; weather remains internal."""
from __future__ import annotations

from copy import deepcopy
import math
import os
from typing import Protocol
from zoneinfo import ZoneInfo

from astana_contracts import ContextProvider, JSON, validate_payload

from .common import JsonHTTP, ProviderError, parse_instant
from .routing import ORSWalkingRouter
from .schedules import enrich_schedule
from .weather import OpenMeteoWeather


_TEXT = {
    "ru": {
        "routing": "Пеший маршрутизатор не настроен; проверенный маршрут недоступен.",
        "weather": "Погода недоступна или устарела; подбор мест продолжается без погодных выводов.",
        "disabled": "Погодный адаптер отключён; прогноз не проверялся.",
        "pending": "Погодное условие неизвестно: согласованного расчёта этого факта пока нет.",
    },
    "kk": {
        "routing": "Жаяу маршрут қызметі бапталмаған; тексерілген маршрут қолжетімсіз.",
        "weather": "Ауа райы қолжетімсіз немесе ескірген; орындар ауа райы туралы қорытындысыз таңдалады.",
        "disabled": "Ауа райы адаптері өшірулі; болжам тексерілмеді.",
        "pending": "Ауа райы шарты белгісіз: бұл фактіні есептеудің келісілген тәсілі әзірге жоқ.",
    },
    "en": {
        "routing": "Walking routing is not configured; a verified route is unavailable.",
        "weather": "Weather is unavailable or stale; place selection continues without weather conclusions.",
        "disabled": "The weather adapter is disabled; no forecast was checked.",
        "pending": "The weather condition is unknown: no agreed calculation of this fact exists yet.",
    },
}


class _Router(Protocol):
    @property
    def available(self) -> bool: ...

    async def estimate_route(
        self, *, origin: JSON, destinations: list[JSON], transport: str,
        return_to_origin: bool, start_at: str,
    ) -> JSON: ...


class CityContext:
    """Enrich source schedules on copied places; never choose or replace stops.

    Inject alternative routing/weather implementations for testing or operation.
    Only the factory owns the HTTP lifetime. No socket is opened on import.
    """

    def __init__(self, *, router: _Router, weather: OpenMeteoWeather, http: JsonHTTP) -> None:
        self.router = router
        self.weather = weather
        self._http = http
        self._closed = False

    def _check_open(self) -> None:
        if self._closed:
            raise ProviderError("provider_unavailable")

    async def enrich_places(self, *, places: list[JSON], request: JSON) -> JSON:
        self._check_open()
        validate_payload("RecommendationRequest", request)
        # ContextResult validation also rejects duplicate candidate IDs before I/O.
        validate_payload("ContextResult", {"places": places, "warnings": [], "degraded_services": []})
        at = parse_instant(request["start_at"]).astimezone(ZoneInfo("Asia/Almaty"))
        locale = request["locale"]
        text = _TEXT[locale]
        result: JSON = {"places": deepcopy(places), "warnings": [], "degraded_services": []}
        for place in result["places"]:
            fact, warnings = enrich_schedule(place, at=at, locale=locale)
            place["facts"] = [f for f in place["facts"] if f["key"] != "open_at_requested_time"] + [fact]
            # A request-time weather fact from an earlier invocation cannot be reused.
            for existing in place["facts"]:
                if existing["key"] == "weather_suitable":
                    existing.update(status="unknown", value=None, evidence_ids=[], note=text["pending"])
            result["warnings"].extend(warnings)
        if not self.router.available:
            result["degraded_services"].append({
                "service": "routing", "reason": "routing_not_configured", "retryable": False,
            })
            result["warnings"].append(text["routing"])
        # No public weather DTO exists. Only availability is projected through the
        # existing degraded-services port; no provider payload or weather fact leaks.
        if places:
            try:
                weather = await self.weather.get(location=deepcopy(request["origin"]), at=at)
                if weather.state in {"stale", "unavailable"}:
                    result["degraded_services"].append({
                        "service": "weather", "reason": weather.reason or "weather_unavailable",
                        "retryable": weather.retryable,
                    })
                    result["warnings"].append(text["disabled"] if weather.reason == "weather_disabled" else text["weather"])
            except Exception:
                # An optional adapter failure cannot erase source facts/candidates.
                result["degraded_services"].append({
                    "service": "weather", "reason": "weather_unavailable", "retryable": True,
                })
                result["warnings"].append(text["weather"])
        result["warnings"] = list(dict.fromkeys(result["warnings"]))
        return validate_payload("ContextResult", result)

    async def estimate_route(
        self, *, origin: JSON, destinations: list[JSON], transport: str,
        return_to_origin: bool, start_at: str,
    ) -> JSON:
        self._check_open()
        # Caller-owned arrays/dictionaries never reach a mutable adapter directly.
        result = await self.router.estimate_route(
            origin=deepcopy(origin), destinations=deepcopy(destinations), transport=transport,
            return_to_origin=return_to_origin, start_at=start_at,
        )
        return validate_payload("RouteEstimate", result)

    async def aclose(self) -> None:
        self._closed = True
        await self._http.aclose()


def _boolean(name: str, default: bool) -> bool:
    value = os.environ.get(name, str(default)).lower()
    if value not in {"true", "false", "1", "0"}:
        raise ValueError(f"{name} must be true or false")
    return value in {"true", "1"}


async def create_context(*, config: dict) -> ContextProvider:
    """Foundation factory. Backend env only; absent keys never enable fixtures."""
    if config.get("mode") != "live" or config.get("timezone") != "Asia/Almaty":
        raise ValueError("Context factory requires live mode and Asia/Almaty")
    if os.environ.get("ROUTING_PROVIDER", "openrouteservice") not in {"", "openrouteservice"}:
        raise ValueError("Unsupported ROUTING_PROVIDER")
    if os.environ.get("WEATHER_PROVIDER", "open_meteo") not in {"", "open_meteo"}:
        raise ValueError("Unsupported WEATHER_PROVIDER")
    # Validate settings before constructing resources. Defaults stay below the
    # foundation's 8-second per-port deadline; retries share one total deadline.
    timeout = float(os.environ.get("ASTANA_CONTEXT_TIMEOUT_SECONDS", "6"))
    retries = int(os.environ.get("ASTANA_CONTEXT_RETRIES", "1"))
    pace_value = os.environ.get("ASTANA_WALKING_PACE_MPS")
    pace = float(pace_value) if pace_value else None
    if pace is not None and (not math.isfinite(pace) or pace <= 0):
        raise ValueError("ASTANA_WALKING_PACE_MPS must be finite and positive")
    approximate = _boolean("ASTANA_ROUTE_ALLOW_APPROXIMATE", True)
    weather_enabled = _boolean("ASTANA_WEATHER_ENABLED", False)
    http = JsonHTTP(timeout_seconds=timeout, retries=retries)
    try:
        router = ORSWalkingRouter(
            http, api_key=os.environ.get("ROUTING_API_KEY") or os.environ.get("ORS_API_KEY"),
            pace_mps=pace, allow_approximate=approximate,
        )
        weather = OpenMeteoWeather(http, enabled=weather_enabled)
        return CityContext(router=router, weather=weather, http=http)
    except BaseException:
        await http.aclose()
        raise
