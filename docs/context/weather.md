# Internal weather adapter

`astana_city_context.weather.OpenMeteoWeather` is an internal backend adapter.
There is no weather DTO in the current canonical `ContextResult`, and this module
does not serialize readings into it. The coordinated extension is proposed in
[`team-02-weather.md`](../requests/team-02-weather.md).

Official references checked 2026-10-19:

- [Forecast API documentation](https://open-meteo.com/en/docs): `current` is model
  output, not a weather station observation; hourly series represent forecasts.
  Units and Unix timestamps are selectable. `generationtime_ms` is server runtime,
  not an issuance timestamp. Precipitation accumulates over the preceding interval.
  Provider grid coordinates may differ from the requested point.
- [Hosted service terms](https://open-meteo.com/en/terms): free hosted access is
  noncommercial, with limits below 10,000/day, 5,000/hour and 600/minute. Data require
  CC BY 4.0 attribution. Commercial deployment requires a suitable service plan
  or another provider. Provider availability and accuracy are not guaranteed.

## Integration

```python
from astana_city_context.common import JsonHTTP
from astana_city_context.weather import OpenMeteoWeather

http = JsonHTTP(timeout_seconds=6, retries=1)
weather = OpenMeteoWeather(http, enabled=False)
# await weather.get(location={"lat": 51.13, "lon": 71.43}, at=aware_datetime)
# await http.aclose()  # shared owner closes the transport
```

The factory reads backend `ASTANA_WEATHER_ENABLED`. Default false prevents silent
acceptance of noncommercial usage conditions. Enabling the free hosted endpoint
is an operator choice; commercial endpoint/key support needs a separate adapter
configuration and agreement. No key or exact user location is logged here.

`WeatherResult.state` is `fetched`, `cached`, `stale`, or `unavailable`.
`reading` is a normalized immutable dataclass or `None`; `reason` and `retryable`
describe degradation. Transport failures become results, allowing place selection
to continue. Input contract errors remain input errors. No raw provider JSON,
station observation claim, invented zero or forecast-derived place fact is exposed.

Readings distinguish `current_model` and `forecast`. Numeric fields are Celsius,
meters/second and millimeters; missing measurements remain `None`. `valid_at` is
the provider sample instant; `retrieved_at` is local completion time. `issued_at`
is `None` because this endpoint supplies no model issuance time. Precipitation's
backward-looking interval is explicit. Provenance retains provider, documentation
and endpoint URLs, model-selection description and attribution.

## Cache and uncertainty policy

- Query and cache locations round to two decimal degrees (about one kilometer
  in Astana). Source grid coordinates are retained and must be within 25 km.
- The key includes rounded latitude/longitude and UTC target date. Provider,
  variables, units, model selection, timezone and resolution are fixed constants.
  Transport configuration is owned by the adapter instance.
- Each target UTC date is requested separately. Only today's date through 15 days
  ahead is accepted; past days are not silently reconstructed.
- Current model data are selected only for their representative time step.
  Otherwise the containing forecast hour is selected. Temperature/wind are
  samples at `valid_at`, not evidence of constant conditions throughout that hour.
- Freshness compares wall-clock time with `fresh_until`, never future trip time.
  Default TTL is 15 minutes; current data expire at the earlier end of their
  model step. An initially expired provider reading is labelled stale.
- Refresh failure can return a matching cached sample for at most 3 hours after
  retrieval, retaining original times, units and provenance. A sample for another
  hour is never substituted. Expired/no matching data are unavailable.
- The 128-entry LRU cache and conservative per-instance limits (50 logical
  fetches/minute, 1,000/hour, 3,000/day) bound calls. `JsonHTTP` permits at most
  three attempts, including its retries. Deployment must enforce quotas across
  instances/processes sharing an IP and account for other applications.

The forecast is contextual information, not a guarantee that a walk is safe or
that a required time/route constraint is satisfied.

## Verification

Offline synthetic responses cover model-current semantics, forecast trip time,
fresh/stale cache, missing values, wrong units/grid, malformed arrays, timeout and
quota handling. Run `python -m pytest packages/city_context/tests/test_weather.py`.
No live weather request was performed: hosted weather remains disabled until the
operator chooses a usage mode. Synthetic test values are not actual Astana weather.
