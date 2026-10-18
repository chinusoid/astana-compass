"""Offline synthetic provider responses; these do not assert live weather facts."""
import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from astana_city_context.common import JsonHTTP, ProviderError
from astana_city_context.weather import OpenMeteoWeather


NOW = datetime(2026, 10, 19, 6, 5, tzinfo=timezone.utc)
LOCATION = {"lat": 51.12824, "lon": 71.43027}
UNITS = {"temperature_2m": "°C", "wind_speed_10m": "m/s", "precipitation": "mm"}


def payload():
    return {
        "latitude": 51.125, "longitude": 71.4375, "utc_offset_seconds": 0,
        "generationtime_ms": 4.125,
        "current_units": deepcopy(UNITS),
        "current": {"time": int(NOW.replace(minute=0).timestamp()), "interval": 900,
                    "temperature_2m": -1.5, "wind_speed_10m": 5.25, "precipitation": 0.1},
        "hourly_units": deepcopy(UNITS),
        "hourly": {"time": [int(NOW.replace(minute=0).timestamp()) + 3600 * n for n in range(8)],
                   "temperature_2m": [-2.0] * 8, "wind_speed_10m": [4.5] * 8,
                   "precipitation": [0.2] * 8},
    }


class Clock:
    def __init__(self):
        self.now = NOW

    def __call__(self):
        return self.now


class HTTP:
    def __init__(self):
        self.payload = payload()
        self.calls = []
        self.error = None

    async def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if self.error:
            raise self.error
        return deepcopy(self.payload)


def get(weather, *, at=NOW, location=LOCATION):
    return asyncio.run(weather.get(location=location, at=at))


def test_opt_in_required_and_naive_time_rejected():
    http = HTTP()
    result = get(OpenMeteoWeather(http))
    assert result.state == "unavailable" and result.reason == "weather_disabled"
    assert http.calls == []
    with pytest.raises(ValueError):
        get(OpenMeteoWeather(http), at=NOW.replace(tzinfo=None))


def test_current_is_model_not_station_and_units_provenance_and_time_are_explicit():
    http = HTTP()
    result = get(OpenMeteoWeather(http, enabled=True, clock=Clock()))
    reading = result.reading
    assert result.state == "fetched" and reading.kind == "current_model"
    assert reading.temperature_celsius == -1.5
    assert reading.wind_meters_per_second == 5.25
    assert reading.precipitation_millimeters == 0.1
    assert reading.precipitation_interval_seconds == 900
    assert reading.valid_at == NOW.replace(minute=0)
    assert reading.retrieved_at == NOW and reading.issued_at is None
    assert reading.fresh_until == NOW.replace(minute=15)
    assert reading.provenance.provider == "Open-Meteo"
    assert reading.provenance.licence_url.endswith("/by/4.0/")
    assert reading.latitude == 51.125  # actual model grid, not exact user location
    params = http.calls[0][2]["params"]
    assert params["wind_speed_unit"] == "ms" and params["timeformat"] == "unixtime"
    assert params["latitude"] == 51.13 and params["longitude"] == 71.43


def test_forecast_at_walk_time_is_fresh_against_now_not_future_target():
    clock, http = Clock(), HTTP()
    weather = OpenMeteoWeather(http, enabled=True, clock=clock)
    target = NOW + timedelta(hours=4)
    result = get(weather, at=target)
    assert result.state == "fetched" and result.reading.kind == "forecast"
    assert result.reading.valid_at == target.replace(minute=0)
    assert result.reading.precipitation_interval_seconds == 3600
    clock.now += timedelta(minutes=2)
    cached = get(weather, at=target)
    assert cached.state == "cached" and len(http.calls) == 1
    assert cached.reading.retrieved_at == NOW
    assert cached.reading.fresh_until == NOW + timedelta(minutes=15)


def test_expired_forecast_refresh_failure_is_stale_with_original_provenance():
    clock, http = Clock(), HTTP()
    weather = OpenMeteoWeather(http, enabled=True, clock=clock)
    target = NOW + timedelta(hours=4)
    first = get(weather, at=target)
    clock.now += timedelta(minutes=16)
    http.error = ProviderError("provider_unavailable", retryable=True)
    stale = get(weather, at=target)
    assert stale.state == "stale" and stale.reading == first.reading
    assert stale.reason == "provider_unavailable" and stale.retryable is True
    clock.now += timedelta(hours=3)
    expired = get(weather, at=target)
    assert expired.state == "unavailable" and expired.reading is None


def test_stale_fallback_never_substitutes_other_requested_hour():
    clock, http = Clock(), HTTP()
    weather = OpenMeteoWeather(http, enabled=True, clock=clock)
    get(weather, at=NOW + timedelta(hours=2))
    clock.now += timedelta(minutes=16)
    http.error = ProviderError("provider_unavailable", retryable=True)
    result = get(weather, at=NOW + timedelta(hours=12))
    assert result.state == "unavailable" and result.reading is None


def test_absent_readings_do_not_become_zero_or_clear_weather():
    http = HTTP()
    http.payload.pop("current")
    for field in UNITS:
        http.payload["hourly"][field] = [None] * 8
    result = get(OpenMeteoWeather(http, enabled=True, clock=Clock()))
    assert result.state == "unavailable" and result.reason == "weather_no_data"


def test_partial_null_measurement_remains_unknown():
    http = HTTP()
    http.payload["current"]["precipitation"] = None
    result = get(OpenMeteoWeather(http, enabled=True, clock=Clock()))
    assert result.reading.precipitation_millimeters is None
    assert result.reading.temperature_celsius == -1.5


@pytest.mark.parametrize("change", [
    lambda p: p["current_units"].update(wind_speed_10m="km/h"),
    lambda p: p["current"].update(precipitation=-1),
    lambda p: p["current"].update(temperature_2m=True),
    lambda p: p["current"].update(wind_speed_10m=float("nan")),
    lambda p: p["current"].update(interval=0),
    lambda p: p.update(current=[1, 2]),
    lambda p: p.update(hourly=[]),
    lambda p: p["hourly"]["time"].reverse(),
    lambda p: p["hourly"]["precipitation"].pop(),
    lambda p: p.update(utc_offset_seconds=18000),
    lambda p: p.update(latitude=52.52, longitude=13.41),
    lambda p: p["current"].update(time=int((NOW + timedelta(hours=2)).timestamp())),
])
def test_malformed_provider_response_is_unavailable(change):
    http = HTTP()
    change(http.payload)
    result = get(OpenMeteoWeather(http, enabled=True, clock=Clock()))
    assert result.state == "unavailable" and result.reason == "invalid_weather_response"


def test_horizon_and_location_are_in_cache_key_and_source_objects_are_immutable():
    clock, http = Clock(), HTTP()
    weather = OpenMeteoWeather(http, enabled=True, clock=clock, cache_size=1)
    original = deepcopy(LOCATION)
    get(weather)
    get(weather, location={"lat": 51.25, "lon": 71.5})
    get(weather)
    assert len(http.calls) == 3 and LOCATION == original
    assert get(weather, at=NOW + timedelta(days=16)).reason == "outside_forecast_horizon"
    assert len(http.calls) == 3


def test_http_timeout_is_normalized_and_does_not_escape_weather_adapter():
    async def scenario():
        async def handler(request):
            raise httpx.ReadTimeout("synthetic timeout")
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        http = JsonHTTP(client=client, timeout_seconds=0.5, retries=0)
        try:
            result = await OpenMeteoWeather(http, enabled=True, clock=Clock()).get(location=LOCATION, at=NOW)
            assert result.state == "unavailable"
            assert result.reason == "provider_unavailable" and result.retryable is True
        finally:
            await http.aclose()
    asyncio.run(scenario())


def test_old_current_payload_is_stale_even_when_just_fetched():
    clock, http = Clock(), HTTP()
    clock.now += timedelta(minutes=30)
    weather = OpenMeteoWeather(http, enabled=True, clock=clock)
    result = get(weather, at=NOW)
    assert result.state == "stale" and result.reason == "weather_stale"
    assert result.reading.fresh_until < result.reading.retrieved_at


def test_conservative_quota_does_not_send_more_fetches_or_silently_invent_data():
    http = HTTP()
    http.error = ProviderError("provider_unavailable", retryable=True)
    weather = OpenMeteoWeather(http, enabled=True, clock=Clock())
    for _ in range(50):
        get(weather)
    result = get(weather)
    assert len(http.calls) == 50
    assert result.state == "unavailable" and result.reason == "rate_limited" and result.retryable
