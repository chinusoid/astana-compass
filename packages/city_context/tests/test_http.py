"""Offline I/O boundary tests, with no requests to hosted providers."""
import asyncio
from datetime import timezone
import gzip

import httpx
import pytest

from astana_city_context.common import JsonHTTP, ProviderError, log_tomtom_failure, parse_instant


@pytest.mark.parametrize("value", ["2026-10-19", "2026-10-19T12:00:00", "tomorrow", "2026-02-30T12:00:00Z", "2026-10-19T25:00:00Z", "2026-10-19 12:00:00Z", "2026-10-19T12:00:00+05:99", "2026-10-19T12:00:00+00:60", "2026-10-19T12:00:00-24:00"])
def test_invalid_instant(value):
    with pytest.raises(ProviderError, match="invalid_request"):
        parse_instant(value)


def test_instant_is_converted_not_relabelled():
    value = parse_instant("2026-10-19T12:00:00+05:00")
    assert value.hour == 7 and value.tzinfo == timezone.utc


@pytest.mark.parametrize("status,expected,calls", [(500, "provider_unavailable", 2), (503, "provider_unavailable", 2), (429, "rate_limited", 1), (401, "provider_unavailable", 1), (302, "provider_unavailable", 1)])
def test_provider_failure_sanitized_bounded_and_no_redirect(status, expected, calls):
    async def run():
        seen = []

        def respond(request):
            seen.append(request)
            return httpx.Response(status, text="secret provider body", headers={"Location": "https://other.invalid/"})

        client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        http = JsonHTTP(client=client)
        try:
            with pytest.raises(ProviderError) as failure:
                await http.request("GET", "https://weather.invalid/", headers={"Authorization": "backend-secret"})
            assert str(failure.value) == expected
            assert failure.value.upstream_status == status and failure.value.reason == "http_error"
            assert "secret" not in str(failure.value)
            assert len(seen) == calls
        finally:
            await http.aclose()
            assert client.is_closed
    asyncio.run(run())


def test_diagnostic_allowlist_never_formats_exception_or_untrusted_category(caplog):
    secret = "private-key-and-provider-body"
    error = ProviderError(secret, upstream_status=secret, reason=secret)
    log_tomtom_failure(secret, error, reason=secret)
    assert secret not in caplog.text
    assert "service=unknown reason=unclassified code=provider_error upstream_status=None" in caplog.text


@pytest.mark.parametrize("problem,reason", [("encoding", "rejected_encoding"), ("json", "invalid_json"),
                                           ("shape", "invalid_shape"), ("size", "response_too_large")])
def test_response_rejection_diagnostics_keep_status_without_body(problem, reason):
    async def run():
        def respond(_):
            if problem == "encoding":
                return httpx.Response(200, content=gzip.compress(b'{"secret":"provider-body"}'), headers={"Content-Encoding": "gzip"})
            if problem == "shape":
                return httpx.Response(200, json=["secret-provider-body"])
            return httpx.Response(200, content=b"secret-provider-body")
        http = JsonHTTP(client=httpx.AsyncClient(transport=httpx.MockTransport(respond)), retries=0,
                        max_bytes=5 if problem == "size" else 1000)
        try:
            with pytest.raises(ProviderError) as failure:
                await http.request("GET", "https://example.invalid/?key=private-key")
            assert failure.value.upstream_status == 200 and failure.value.reason == reason
            assert str(failure.value) == "invalid_provider_response"
        finally:
            await http.aclose()
    asyncio.run(run())


def test_retry_transient_failure_and_decode_valid_json():
    async def run():
        count = 0

        def respond(request):
            nonlocal count
            count += 1
            if count == 1:
                raise httpx.ReadTimeout("private coordinates and token", request=request)
            return httpx.Response(200, json={"ok": True})

        http = JsonHTTP(client=httpx.AsyncClient(transport=httpx.MockTransport(respond)))
        try:
            assert await http.request("POST", "https://routing.invalid/", json={"coordinates": []}) == {"ok": True}
            assert count == 2
        finally:
            await http.aclose()
    asyncio.run(run())


@pytest.mark.parametrize("body", [b"[]", b"null", b"bad json", b'{"x":NaN}', b'{"x":Infinity}', b'{"huge": "' + b"x" * 1024 + b'"}'])
def test_invalid_or_oversized_payload(body):
    async def run():
        http = JsonHTTP(max_bytes=100, client=httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, content=body))))
        try:
            with pytest.raises(ProviderError, match="invalid_provider_response"):
                await http.request("GET", "https://provider.invalid/")
        finally:
            await http.aclose()
    asyncio.run(run())


@pytest.mark.parametrize("encoding", ["gzip", "deflate", "br", "gzip, identity"])
def test_compressed_response_rejected_before_body_read_or_decompression(encoding):
    async def run():
        # The original bug inflated this ~8 KiB wire body to 8 MiB before
        # checking a 1 KiB limit. The fixed boundary must not read it at all.
        compressed = gzip.compress(b'{"value":"' + b"x" * (8 * 1024 * 1024) + b'"}')

        class EncodedBody(httpx.AsyncByteStream):
            read_started = False
            closed = False

            async def __aiter__(self):
                self.read_started = True
                yield compressed

            async def aclose(self):
                self.closed = True

        stream = EncodedBody()
        calls = []
        caller_headers = {"accept-encoding": "gzip", "Authorization": "synthetic-test-key"}

        def respond(request):
            calls.append(request)
            assert request.headers["accept-encoding"] == "identity"
            assert request.headers["authorization"] == "synthetic-test-key"
            return httpx.Response(200, headers={"Content-Encoding": encoding}, stream=stream)

        client = httpx.AsyncClient(transport=httpx.MockTransport(respond),
                                   headers={"Accept-Encoding": "gzip, deflate"})
        http = JsonHTTP(client=client, max_bytes=1024, retries=2)
        try:
            with pytest.raises(ProviderError, match="invalid_provider_response") as failure:
                await http.request("GET", "https://provider.invalid/", headers=caller_headers)
            assert not failure.value.retryable
            assert len(calls) == 1
            assert not stream.read_started and stream.closed
            assert caller_headers["accept-encoding"] == "gzip"
        finally:
            await http.aclose()
    asyncio.run(run())


@pytest.mark.parametrize("encoding", [None, "identity", " Identity "])
def test_raw_identity_stream_succeeds_at_exact_size_limit(encoding):
    async def run():
        payload = b'{"ok":true}'

        class RawBody(httpx.AsyncByteStream):
            closed = False

            async def __aiter__(self):
                yield payload[:4]
                yield payload[4:]

            async def aclose(self):
                self.closed = True

        stream = RawBody()
        headers = {} if encoding is None else {"Content-Encoding": encoding}
        client = httpx.AsyncClient(transport=httpx.MockTransport(
            lambda _: httpx.Response(200, headers=headers, stream=stream)))
        http = JsonHTTP(client=client, max_bytes=len(payload))
        try:
            assert await http.request("GET", "https://provider.invalid/") == {"ok": True}
            assert stream.closed
        finally:
            await http.aclose()
    asyncio.run(run())


def test_oversized_raw_stream_stops_reading_and_closes_without_retry():
    async def run():
        class RawBody(httpx.AsyncByteStream):
            chunks_read = 0
            closed = False

            async def __aiter__(self):
                for _ in range(10):
                    self.chunks_read += 1
                    yield b"x" * 1024

            async def aclose(self):
                self.closed = True

        stream = RawBody()
        calls = []

        def respond(request):
            calls.append(request)
            return httpx.Response(200, stream=stream)

        http = JsonHTTP(client=httpx.AsyncClient(transport=httpx.MockTransport(respond)),
                        max_bytes=1024, retries=2)
        try:
            with pytest.raises(ProviderError, match="invalid_provider_response"):
                await http.request("GET", "https://provider.invalid/")
            assert stream.closed and stream.chunks_read < 10
            assert len(calls) == 1
        finally:
            await http.aclose()
    asyncio.run(run())


def test_cancelling_close_keeps_transport_shutdown_alive_and_reawaitable():
    async def run():
        started, release = asyncio.Event(), asyncio.Event()

        class Transport(httpx.AsyncBaseTransport):
            finished = False
            close_calls = 0

            async def aclose(self):
                self.close_calls += 1
                started.set()
                await release.wait()
                self.finished = True

        transport = Transport()
        http = JsonHTTP(client=httpx.AsyncClient(transport=transport))
        closing = asyncio.create_task(http.aclose())
        await started.wait()
        closing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await closing
        release.set()
        await http.aclose()
        assert transport.finished and transport.close_calls == 1
    asyncio.run(run())


def test_total_timeout_includes_provider_wait_and_cancellation_propagates():
    async def run():
        async def respond(_):
            await asyncio.sleep(1)
            return httpx.Response(200, json={})

        http = JsonHTTP(timeout_seconds=0.02, client=httpx.AsyncClient(transport=httpx.MockTransport(respond)))
        try:
            with pytest.raises(ProviderError) as failure:
                await http.request("GET", "https://provider.invalid/")
            assert failure.value.retryable
            task = asyncio.create_task(http.request("GET", "https://provider.invalid/"))
            await asyncio.sleep(0)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        finally:
            await http.aclose()
    asyncio.run(run())


def test_close_is_idempotent_and_requests_after_close_fail():
    async def run():
        http = JsonHTTP()
        await http.aclose()
        await http.aclose()
        with pytest.raises(ProviderError, match="provider_unavailable"):
            await http.request("GET", "https://provider.invalid/")
    asyncio.run(run())


@pytest.mark.parametrize("url,body,expected", [
    ("https://api.tomtom.com/maps/orbis/places/discover", '{"detailedError":{"target":"Attributes","message":"Invalid openingHours; private-secret-value"}}', ("Attributes", "openingHours")),
    ("https://other.invalid/", "Attributes private-secret-value", ()),
    ("https://api.tomtom.com/maps/orbis/places/discover", "Attributes " + "x" * 20_000, ()),
])
def test_tomtom_bad_request_diagnostics_only_emit_constant_field_names(url, body, expected, caplog):
    from astana_city_context.common import log_tomtom_failure

    async def run():
        http = JsonHTTP(client=httpx.AsyncClient(transport=httpx.MockTransport(
            lambda _: httpx.Response(400, text=body))))
        try:
            with pytest.raises(ProviderError) as failure:
                await http.request("POST", url, json={})
            assert failure.value.upstream_status == 400
            assert failure.value.field_hints == expected
            log_tomtom_failure("places", failure.value)
        finally:
            await http.aclose()
    asyncio.run(run())
    assert "private-secret-value" not in caplog.text
    assert url not in caplog.text
