import asyncio
from copy import deepcopy

import pytest
from fastapi.testclient import TestClient
from astana_api import create_app
from astana_api.map_features import MapFeatureService, normalize, normalize_nominatim
from astana_city_context.common import ProviderError

LOCATION = {"lat": 51.1283, "lon": 71.4305}
STAMP = "2026-10-19T10:00:00Z"


def source():
    return {"elements": [
        {"type": "way", "id": 123, "tags": {"building": "office", "name": "Office", "name:ru": "Здание", "building:levels": "7"},
         "geometry": [{"lon": lon, "lat": lat} for lon, lat in [(71.430, 51.128), (71.431, 51.128), (71.431, 51.129), (71.430, 51.129), (71.430, 51.128)]]},
        {"type": "node", "id": 456, "lat": 51.12831, "lon": 71.43051, "tags": {"amenity": "cafe", "name": "<img src=x onerror=alert(1)>"}},
    ]}


def test_containing_building_is_distinct_from_nearby_cafe_and_missing_facts_remain_missing():
    result = normalize(source(), LOCATION, "ru", STAMP)
    building, cafe = result["features"]
    assert building["match"] == "contains" and cafe["match"] == "nearby"
    assert building["name"] == "Здание"
    assert building["description"] is None and building["address"] is None
    assert building["source_url"] == "https://www.openstreetmap.org/way/123"
    assert building["attributes"][1]["value"] == "7"
    assert cafe["name"].startswith("<img")  # data only; browser renders text, never HTML


class HTTP:
    def __init__(self):
        self.calls = 0

    async def request(self, *args, **kwargs):
        self.calls += 1
        return deepcopy(source())


def test_cached_area_recomputes_exact_match_and_locale_without_network():
    async def check():
        http = HTTP()
        service = MapFeatureService(enabled=True, http=http, provider="overpass")
        ru = await service.inspect(LOCATION, "ru")
        en = await service.inspect(LOCATION, "en")
        assert http.calls == 1
        assert ru["retrieved_at"] == en["retrieved_at"]
        assert en["features"][0]["name"] == "Office"
        with pytest.raises(ProviderError, match="rate_limited"):
            await service.inspect({"lat": 51.13, "lon": 71.44}, "ru")
        assert http.calls == 1
    asyncio.run(check())


def test_off_city_rejected_before_network():
    http = HTTP()
    service = MapFeatureService(enabled=True, http=http)
    with pytest.raises(ProviderError, match="invalid_request"):
        asyncio.run(service.inspect({"lat": 0, "lon": 0}, "en"))
    assert http.calls == 0


def test_partial_overpass_result_not_misrepresented_as_complete_empty():
    with pytest.raises(ProviderError):
        normalize({"elements": [], "remark": "timeout"}, LOCATION, "en", STAMP)


def test_map_endpoint_contract_and_opt_in_default():
    with TestClient(create_app()) as client:
        request = {"location": LOCATION, "locale": "ru"}
        assert client.post("/v1/map-features", json=request).status_code == 503
        assert client.post("/v1/map-features", json={**request, "query": "arbitrary Overpass"}).status_code == 422
        schema = client.get("/openapi.json").json()
        assert "/v1/map-features" in schema["paths"]


def nominatim_source():
    lon, lat = LOCATION["lon"], LOCATION["lat"]

    def square(delta):
        return [[lon - delta, lat - delta], [lon + delta, lat - delta],
                [lon + delta, lat + delta], [lon - delta, lat + delta], [lon - delta, lat - delta]]

    return {"osm_type": "way", "osm_id": 123, "lon": str(lon), "lat": str(lat),
            "category": "building", "type": "office", "name": "Courtyard office",
            "namedetails": {"name:ru": "Офис с двором"},
            "extratags": {"building:levels": "4", "description:ru": "Описание из источника"},
            "address": {"road": "Test street", "house_number": "12"},
            "geojson": {"type": "Polygon", "coordinates": [square(.002), square(.0002)]}}


def test_nominatim_courtyard_hole_is_nearby_with_distance_to_actual_building():
    result = normalize_nominatim(nominatim_source(), LOCATION, "ru", STAMP)
    feature = result["features"][0]
    assert feature["match"] == "nearby"
    assert 10 < feature["distance_meters"] < 20
    assert feature["name"] == "Офис с двором"
    assert feature["description"] == "Описание из источника"
    assert feature["source_url"] == "https://www.openstreetmap.org/way/123"
    assert result["retrieved_at"] == STAMP


def test_nominatim_polygon_body_contains_point_but_nearby_polygon_does_not():
    data = nominatim_source()
    interior = {**LOCATION, "lon": LOCATION["lon"] + .001}
    inside = normalize_nominatim(data, interior, "en", STAMP)["features"][0]
    assert inside["match"] == "contains" and inside["distance_meters"] == 0
    outside = {**LOCATION, "lon": LOCATION["lon"] + .0025}
    nearby = normalize_nominatim(data, outside, "en", STAMP)["features"][0]
    assert nearby["match"] == "nearby" and 30 < nearby["distance_meters"] < 40
    distant = {**LOCATION, "lon": LOCATION["lon"] + .01}
    assert normalize_nominatim(data, distant, "en", STAMP)["status"] == "empty"


@pytest.mark.parametrize("problem", ["empty-outer", "open-outer", "empty-hole", "open-hole", "degenerate",
                                     "invalid-coordinate", "invalid-location", "names-list", "geometry-list"])
def test_malformed_nominatim_geometry_and_metadata_are_not_plausible_places(problem):
    data = nominatim_source()
    rings = data["geojson"]["coordinates"]
    if problem == "empty-outer":
        rings[0] = []
    elif problem == "open-outer":
        rings[0].pop()
    elif problem == "empty-hole":
        rings[1] = []
    elif problem == "open-hole":
        rings[1].pop()
    elif problem == "degenerate":
        rings[0] = [rings[0][0]] * 4
    elif problem == "invalid-coordinate":
        rings[0][1] = [True, LOCATION["lat"]]
    elif problem == "invalid-location":
        data["lat"] = True
    elif problem == "names-list":
        data["namedetails"] = []
    else:
        data["geojson"] = []
    with pytest.raises(ProviderError, match="provider_unavailable"):
        normalize_nominatim(data, LOCATION, "en", STAMP)


@pytest.mark.parametrize("provider", ["nominatim", "overpass"])
@pytest.mark.parametrize("payload", [None, [], "unexpected JSON", True])
def test_malformed_top_level_provider_json_becomes_controlled_failure(provider, payload):
    class MalformedHTTP:
        async def request(self, *args, **kwargs):
            return payload

    service = MapFeatureService(enabled=True, http=MalformedHTTP(), provider=provider)
    with pytest.raises(ProviderError, match="provider_unavailable"):
        asyncio.run(service.inspect(LOCATION, "en"))


def test_nominatim_no_result_is_empty_but_other_provider_errors_are_failures():
    assert normalize_nominatim({"error": "Unable to geocode"}, LOCATION, "en", STAMP)["status"] == "empty"
    with pytest.raises(ProviderError, match="provider_unavailable"):
        normalize_nominatim({"error": "Query timed out"}, LOCATION, "en", STAMP)
