import asyncio
import json

import httpx
from astana_api.traffic import TrafficService
from astana_contracts import validate_payload


def run(coro):
    return asyncio.run(coro)


def sample_data(**changes):
    return {"flowSegmentData": {"currentSpeed": 15, "freeFlowSpeed": 50, "confidence": 0.9, "roadClosure": False,
            "coordinates": {"coordinate": [{"latitude": 51.128, "longitude": 71.431}, {"latitude": 51.129, "longitude": 71.432}]}, **changes}}


def test_no_key_does_not_call_provider_or_claim_traffic():
    async def check():
        def denied(_request):
            raise AssertionError("Unexpected network request")
        service = TrafficService(transport=httpx.MockTransport(denied))
        try:
            result = await service.sample([{"lat": 51.1, "lon": 71.4}])
            validate_payload("TrafficResponse", result)
            assert result["status"] == "not_configured" and not result["segments"]
        finally:
            await service.aclose()
    run(check())


def test_live_samples_are_validated_cached_and_do_not_include_key():
    async def check():
        calls = []
        def handler(request):
            calls.append(request)
            assert request.url.host == "api.tomtom.com"
            assert request.url.params["point"] == "51.128,71.431"
            return httpx.Response(200, json=sample_data())
        service = TrafficService("test-secret", transport=httpx.MockTransport(handler))
        try:
            points = [{"lat": 51.12831, "lon": 71.43055}]
            first = await service.sample(points)
            assert first["status"] == "live"
            validate_payload("TrafficResponse", first)
            assert first == await service.sample(points)
            assert len(calls) == 1
            assert "test-secret" not in json.dumps(first)
            assert first["segments"][0]["geometry"]["coordinates"][0] == [71.431, 51.128]
        finally:
            await service.aclose()
    run(check())


def test_malformed_expired_or_failed_feed_never_becomes_zero_congestion():
    async def check():
        now = [0.0]
        calls = [0]
        def handler(_request):
            calls[0] += 1
            return httpx.Response(200, json=sample_data() if calls[0] == 1 else sample_data(currentSpeed=-3))
        service = TrafficService("secret", transport=httpx.MockTransport(handler), clock=lambda: now[0])
        try:
            points = [{"lat": 51.128, "lon": 71.431}]
            assert (await service.sample(points))["status"] == "live"
            now[0] = 61
            failed = await service.sample(points)
            assert failed["status"] == "unavailable" and failed["segments"] == []
            assert (await service.sample([{"lat": 10, "lon": 10}]))["status"] == "unavailable"
            assert calls[0] == 2
        finally:
            await service.aclose()
    run(check())


def test_compressed_response_is_rejected_before_reading_or_decompressing():
    class NeverRead(httpx.AsyncByteStream):
        async def __aiter__(self):
            raise AssertionError("Must reject before reading compressed body")
            yield b""

    async def check():
        def handler(request):
            assert request.headers["accept-encoding"] == "identity"
            return httpx.Response(200, headers={"content-encoding": "gzip"}, stream=NeverRead())
        service = TrafficService("secret", transport=httpx.MockTransport(handler))
        try:
            response = await service.sample([{"lat": 51.128, "lon": 71.431}])
            assert response["status"] == "unavailable" and response["segments"] == []
        finally:
            await service.aclose()
    run(check())


def test_deeply_nested_provider_json_is_unavailable_and_does_not_echo_key():
    async def check():
        body = b'{"flowSegmentData":' + b'[' * 2000 + b'0' + b']' * 2000 + b'}'
        service = TrafficService("private-key", transport=httpx.MockTransport(lambda _: httpx.Response(200, content=body)))
        try:
            result = await service.sample([{"lat":51.128, "lon":71.431}])
            assert result["status"] == "unavailable"
            assert result["segments"] == []
            assert "private-key" not in json.dumps(result)
        finally:
            await service.aclose()
    run(check())


def test_traffic_http_uses_concurrency_gate_before_provider_call():
    from fastapi.testclient import TestClient
    from astana_api import create_app
    from astana_api.settings import Settings

    with TestClient(create_app(Settings())) as client:
        async def forbidden(_):
            raise AssertionError("provider must not be called without capacity")
        client.app.state.traffic.sample = forbidden
        client.app.state.gate = asyncio.Semaphore(0)
        response = client.post("/v1/traffic", json={"points":[{"lat":51.128, "lon":71.431}]})
        assert response.status_code == 429
        assert response.headers["Retry-After"] == "2"
        validate_payload("ErrorResponse", response.json())


def test_traffic_http_deadline_uses_settings_and_releases_capacity():
    from fastapi.testclient import TestClient
    from astana_api import create_app
    from astana_api.settings import Settings

    with TestClient(create_app(Settings(request_timeout_seconds=1, max_concurrent_requests=1))) as client:
        cancelled = []
        async def slow(_):
            try:
                await asyncio.sleep(5)
            finally:
                cancelled.append(True)
        client.app.state.traffic.sample = slow
        response = client.post("/v1/traffic", json={"points":[{"lat":51.128, "lon":71.431}]})
        assert response.status_code == 200
        assert response.json()["status"] == "unavailable"
        assert client.app.state.gate._value == 1 and cancelled == [True]
        validate_payload("TrafficResponse", response.json())
