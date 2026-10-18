# Team 02 contract request: explicit weather context, proposed v0.2

Status: proposal only. Do not add `weather` to current `ContextResult` or expose
provider JSON. Coordinator owns the canonical schema, generated SDKs and API.

Reason: consumers need normalized units, temporal meaning, freshness and source
attribution before they can display weather. Internal implementation is available
at `astana_city_context.weather`; it is not an alternative public contract.

Consumers: context orchestration, recommendation explanations, API SDK and web UI.
Weather cannot establish a place fact, required constraint, route duration or safe
walking conditions. A weather provider outage must allow the existing selection
flow to continue with a localized degradation warning.

## Exact proposed schema changes

For an agreed v0.2 release add OPTIONAL `weather: {$ref: "#/$defs/WeatherContext"}`
to `ContextResult.properties`; leave current required fields unchanged. The new
definitions below use JSON Schema Draft 2020-12. `Location` is the existing named
definition. All date-time fields also require the shared timezone-aware RFC3339
runtime check; the sample must refer to the requested walk time as described below.

```json
{
  "WeatherProvenance": {
    "type": "object", "additionalProperties": false,
    "required": ["provider", "source_url", "endpoint", "attribution", "licence_url", "model_selection"],
    "properties": {
      "provider": {"type": "string", "minLength": 1},
      "source_url": {"type": "string", "format": "uri"},
      "endpoint": {"type": "string", "format": "uri"},
      "attribution": {"type": "string", "minLength": 1},
      "licence_url": {"type": "string", "format": "uri"},
      "model_selection": {"type": "string", "minLength": 1}
    }
  },
  "WeatherReading": {
    "type": "object", "additionalProperties": false,
    "required": ["kind", "valid_at", "precipitation_interval_seconds", "retrieved_at", "fresh_until", "issued_at", "grid_location", "temperature_celsius", "wind_meters_per_second", "precipitation_millimeters", "provenance"],
    "properties": {
      "kind": {"enum": ["current_model", "forecast", "station_observation"]},
      "valid_at": {"type": "string", "format": "date-time"},
      "precipitation_interval_seconds": {"type": "integer", "minimum": 1},
      "retrieved_at": {"type": "string", "format": "date-time"},
      "fresh_until": {"type": "string", "format": "date-time"},
      "issued_at": {"type": ["string", "null"], "format": "date-time"},
      "grid_location": {"$ref": "#/$defs/Location"},
      "temperature_celsius": {"type": ["number", "null"]},
      "wind_meters_per_second": {"type": ["number", "null"], "minimum": 0},
      "precipitation_millimeters": {"type": ["number", "null"], "minimum": 0},
      "provenance": {"$ref": "#/$defs/WeatherProvenance"}
    },
    "anyOf": [
      {"properties": {"temperature_celsius": {"type": "number"}}},
      {"properties": {"wind_meters_per_second": {"type": "number"}}},
      {"properties": {"precipitation_millimeters": {"type": "number"}}}
    ]
  },
  "WeatherContext": {
    "type": "object", "additionalProperties": false,
    "required": ["state", "requested_at", "reading", "reason", "retryable"],
    "properties": {
      "state": {"enum": ["fetched", "cached", "stale", "unavailable"]},
      "requested_at": {"type": "string", "format": "date-time"},
      "reading": {"oneOf": [{"type": "null"}, {"$ref": "#/$defs/WeatherReading"}]},
      "reason": {"type": ["string", "null"], "enum": [null, "weather_disabled", "outside_forecast_horizon", "weather_no_data", "invalid_weather_response", "invalid_provider_response", "provider_unavailable", "rate_limited", "weather_stale"]},
      "retryable": {"type": "boolean"}
    },
    "allOf": [
      {
        "if": {"properties": {"state": {"const": "unavailable"}}},
        "then": {"properties": {"reading": {"type": "null"}, "reason": {"type": "string"}}},
        "else": {"properties": {"reading": {"$ref": "#/$defs/WeatherReading"}}}
      },
      {
        "if": {"properties": {"state": {"enum": ["fetched", "cached"]}}},
        "then": {"properties": {"reason": {"type": "null"}, "retryable": {"const": false}}}
      },
      {
        "if": {"properties": {"state": {"const": "stale"}}},
        "then": {"properties": {"reason": {"type": "string"}}}
      }
    ]
  }
}
```

Unit-bearing names deliberately remove ambiguity. The adapter's latitude/longitude
map to `grid_location`; its queried rounded coordinate is not the provider grid.
`station_observation` is reserved for a future adapter with actual station evidence;
Open-Meteo current data MUST use `current_model`. Additional provider-specific fields
remain prohibited. The same provider result can have missing individual measurements
without inventing zero; all-null readings must be unavailable.

`requested_at` is the walk instant, not retrieval time. `valid_at` is the sample
instant. `precipitation_interval_seconds` describes the period ending at that
instant, rather than an interval of constant temperature or wind. `issued_at` is
nullable and cannot be synthesized from runtime or retrieval. `fresh_until` follows
the adapter TTL policy and is checked against the time the API prepares a response,
independently of `requested_at`. A forecast for tomorrow retrieved now can be fresh;
an old forecast for tomorrow can be stale. Transport fallback retains original
retrieval time and provenance. Revalidate cache state at serialization time.

## Compatible transition and acceptance

Existing v0.1 strict validators reject unexpected fields. Therefore an optional new
property alone is not sufficient wire compatibility: first merge canonical v0.2
definitions and regenerate/check Python and TypeScript resources together, then
upgrade API, orchestration and frontend. Gate emission with a coordinated negotiated
v0.2 capability or new endpoint version until all consumers accept it. When disabled,
the response remains the exact v0.1 shape. Do not add a query or request flag outside
the same reviewed contract update.

Coordinator adds positive fixtures for forecast, cached-current, stale and unavailable,
plus negative fixtures for units, naive dates, missing provenance, current-as-station,
state/reading inconsistency and all-null measurements. Add integration tests proving
weather failure preserves place results and localized warnings; no weather field in
v0.1; future trip freshness uses current clock; schema generation has no drift.
The weather module's offline tests already exercise normalization and stale handling.
