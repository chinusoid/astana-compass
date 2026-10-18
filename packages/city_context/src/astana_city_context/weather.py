"""Internal, opt-in model weather adapter; no public weather wire DTO exists yet."""
from __future__ import annotations

import math
from collections import OrderedDict, deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable, Literal

from astana_contracts import JSON, validate_payload

from .common import JsonHTTP, ProviderError, parse_instant, utc_now

_ENDPOINT = "https://api.open-meteo.com/v1/forecast"
_VARIABLES = "temperature_2m,wind_speed_10m,precipitation"


@dataclass(frozen=True)
class WeatherProvenance:
    provider: str = "Open-Meteo"
    source_url: str = "https://open-meteo.com/en/docs"
    endpoint: str = _ENDPOINT
    attribution: str = "Weather data by Open-Meteo (CC BY 4.0)"
    licence_url: str = "https://creativecommons.org/licenses/by/4.0/"
    model_selection: str = "best_match; underlying model run not supplied"


@dataclass(frozen=True)
class WeatherReading:
    kind: Literal["current_model", "forecast"]
    valid_at: datetime
    # Precipitation is an accumulation over the period ENDING at valid_at.
    precipitation_interval_seconds: int
    retrieved_at: datetime
    fresh_until: datetime
    latitude: float
    longitude: float
    temperature_celsius: float | None
    wind_meters_per_second: float | None
    precipitation_millimeters: float | None
    provenance: WeatherProvenance = WeatherProvenance()
    # Forecast API does not supply model run/issuance time. Never derive it
    # from generationtime_ms, which measures server computation duration.
    issued_at: datetime | None = None


@dataclass(frozen=True)
class WeatherResult:
    state: Literal["fetched", "cached", "stale", "unavailable"]
    reading: WeatherReading | None = None
    reason: str | None = None
    retryable: bool = False


@dataclass(frozen=True)
class _Snapshot:
    readings: tuple[WeatherReading, ...]
    retrieved_at: datetime


def _instant(value: datetime) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("weather time must include a timezone")
    return parse_instant(value.isoformat())


def _number(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("invalid weather number")
    return float(value)


def _timestamp(value: object) -> datetime:
    return datetime.fromtimestamp(_number(value), tz=timezone.utc)


class OpenMeteoWeather:
    """Free hosted endpoint, enabled only after operator confirms noncommercial use.

    HTTP timeout, bounded retries and normalized errors belong to JsonHTTP.
    Cache freshness uses the wall clock, independently of the requested trip time.
    """

    def __init__(
        self, http: JsonHTTP, *, clock: Callable[[], datetime] = utc_now,
        enabled: bool = False, ttl_seconds: int = 900,
        max_stale_seconds: int = 10800, cache_size: int = 128,
    ):
        if (any(type(value) is not int for value in (ttl_seconds, max_stale_seconds, cache_size))
                or ttl_seconds <= 0 or max_stale_seconds < ttl_seconds or cache_size <= 0):
            raise ValueError("invalid weather cache policy")
        self.http = http
        self.clock = clock
        self.enabled = enabled
        self.ttl_seconds = ttl_seconds
        self.max_stale_seconds = max_stale_seconds
        self.cache_size = cache_size
        self._cache: OrderedDict[tuple[float, float, str], _Snapshot] = OrderedDict()
        self._requests: deque[datetime] = deque()

    async def get(self, *, location: JSON, at: datetime) -> WeatherResult:
        at = _instant(at)
        now = _instant(self.clock())
        validate_payload("Location", location)
        latitude, longitude = round(location["lat"], 2), round(location["lon"], 2)
        if not self.enabled:
            return WeatherResult("unavailable", reason="weather_disabled")
        # Forecast endpoint only; no historic reconstruction or station observation.
        if at.date() < now.date() or at.date() > (now + timedelta(days=15)).date():
            return WeatherResult("unavailable", reason="outside_forecast_horizon")
        key = (latitude, longitude, at.date().isoformat())
        cached = self._cache.get(key)
        if cached:
            self._cache.move_to_end(key)
            reading = self._select(cached, at)
            if reading and cached.retrieved_at <= now < reading.fresh_until:
                return WeatherResult("cached", reading)
        if not self._permit_request(now):
            return self._fallback(cached, at, now, "rate_limited", True)
        try:
            payload = await self.http.request("GET", _ENDPOINT, params={
                "latitude": latitude, "longitude": longitude,
                "current": _VARIABLES, "hourly": _VARIABLES,
                "temperature_unit": "celsius", "wind_speed_unit": "ms",
                "precipitation_unit": "mm", "timezone": "UTC", "timeformat": "unixtime",
                "models": "best_match", "start_date": key[2], "end_date": key[2],
            })
            # Time captured AFTER network completion, never request start time.
            retrieved_at = _instant(self.clock())
            snapshot = self._parse(payload, retrieved_at, latitude, longitude)
            reading = self._select(snapshot, at)
            if reading is None:
                raise ProviderError("weather_no_data", retryable=False)
            self._cache[key] = snapshot
            self._cache.move_to_end(key)
            while len(self._cache) > self.cache_size:
                self._cache.popitem(last=False)
            if reading.fresh_until <= retrieved_at:
                return WeatherResult("stale", reading, "weather_stale")
            return WeatherResult("fetched", reading)
        except ProviderError as error:
            return self._fallback(cached, at, _instant(self.clock()), error.code, error.retryable)
        except (ValueError, TypeError, KeyError, IndexError, OverflowError):
            return self._fallback(cached, at, _instant(self.clock()), "invalid_weather_response", False)

    def _fallback(
        self, cached: _Snapshot | None, at: datetime, now: datetime, reason: str, retryable: bool,
    ) -> WeatherResult:
        if cached and timedelta(0) <= now - cached.retrieved_at <= timedelta(seconds=self.max_stale_seconds):
            reading = self._select(cached, at)
            if reading:
                return WeatherResult("stale", reading, reason, retryable)
        return WeatherResult("unavailable", reason=reason, retryable=retryable)

    def _permit_request(self, now: datetime) -> bool:
        # Each logical fetch may make up to 3 HTTP attempts. Leave headroom below
        # hosted quotas, and require deployment-wide limits for shared IPs.
        while self._requests and now - self._requests[0] >= timedelta(days=1):
            self._requests.popleft()
        for window, maximum in ((60, 50), (3600, 1000), (86400, 3000)):
            if sum(now - time < timedelta(seconds=window) for time in self._requests) >= maximum:
                return False
        self._requests.append(now)
        return True

    @staticmethod
    def _select(snapshot: _Snapshot, at: datetime) -> WeatherReading | None:
        # Prefer model-current only for its own 15-minute representative step.
        # Hourly forecast uses the containing hour; temperature/wind are samples
        # at valid_at, not continuous observations for the following hour.
        for reading in snapshot.readings:
            span = reading.precipitation_interval_seconds if reading.kind == "current_model" else 3600
            if reading.valid_at <= at < reading.valid_at + timedelta(seconds=span):
                return reading
        return None

    def _parse(self, payload: JSON, retrieved_at: datetime, requested_lat: float, requested_lon: float) -> _Snapshot:
        if payload.get("error"):
            raise ValueError("provider error payload")
        latitude = _number(payload["latitude"])
        longitude = _number(payload["longitude"])
        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
            raise ValueError("invalid weather grid coordinates")
        radians = math.radians
        a = (math.sin(radians(latitude - requested_lat) / 2) ** 2
             + math.cos(radians(latitude)) * math.cos(radians(requested_lat))
             * math.sin(radians(longitude - requested_lon) / 2) ** 2)
        if 2 * 6_371_000 * math.asin(math.sqrt(min(1, a))) > 25_000:
            raise ValueError("weather grid is too far from request")
        if payload.get("utc_offset_seconds") != 0:
            raise ValueError("expected UTC weather timestamps")
        readings: list[WeatherReading] = []

        def reading(data: JSON, units: JSON, kind: Literal["current_model", "forecast"], interval: int) -> None:
            valid_at = _timestamp(data["time"])
            if kind == "current_model" and valid_at > retrieved_at + timedelta(minutes=1):
                raise ValueError("current model sample is in the future")
            values = []
            for field, expected_unit in (
                ("temperature_2m", "°C"), ("wind_speed_10m", "m/s"), ("precipitation", "mm"),
            ):
                value = data.get(field)
                if value is not None:
                    if units.get(field) != expected_unit:
                        raise ValueError("unexpected weather units")
                    value = _number(value)
                    if field != "temperature_2m" and value < 0:
                        raise ValueError("negative wind/precipitation")
                values.append(value)
            if all(value is None for value in values):
                return
            fresh_until = retrieved_at + timedelta(seconds=self.ttl_seconds)
            if kind == "current_model":
                fresh_until = min(fresh_until, valid_at + timedelta(seconds=interval))
            readings.append(WeatherReading(
                kind, valid_at, interval, retrieved_at, fresh_until, latitude, longitude, *values,
            ))

        current = payload.get("current")
        if current:
            if not isinstance(current, dict) or not isinstance(payload.get("current_units", {}), dict):
                raise ValueError("invalid current weather object")
            interval = current.get("interval")
            if isinstance(interval, bool) or not isinstance(interval, int) or not 0 < interval <= 3600:
                raise ValueError("invalid current interval")
            reading(current, payload.get("current_units", {}), "current_model", interval)
        hourly = payload.get("hourly", {})
        if not isinstance(hourly, dict) or not isinstance(payload.get("hourly_units", {}), dict):
            raise ValueError("invalid hourly weather object")
        times = hourly.get("time", [])
        if not isinstance(times, list):
            raise ValueError("invalid hourly timestamps")
        fields = _VARIABLES.split(",")
        for field in fields:
            values = hourly.get(field, [None] * len(times))
            if not isinstance(values, list) or len(values) != len(times):
                raise ValueError("invalid hourly data length")
        previous = None
        for index, time in enumerate(times):
            instant = _timestamp(time)
            if previous is not None and instant - previous != timedelta(hours=1):
                raise ValueError("hourly data must be ordered without duplicate or missing hours")
            previous = instant
            values = {field: hourly[field][index] for field in fields if field in hourly}
            reading({"time": time, **values}, payload.get("hourly_units", {}), "forecast", 3600)
        return _Snapshot(tuple(readings), retrieved_at)
