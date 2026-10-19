"""Bounded provider I/O. No user/provider payloads or credentials are logged."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import json as jsonlib
import logging
import math
import re
from typing import Any

import httpx

_DIAGNOSTIC_REASONS = frozenset({
    "http_error", "timeout", "transport_error", "rejected_encoding", "response_too_large",
    "invalid_json", "invalid_shape", "invalid_schema", "key_not_configured", "unclassified",
})
_TOMTOM_FIELDS = (
    "Attributes", "query", "origin", "preferences", "geometry", "coordinates", "maxResults",
    "filters", "types", "countryCodesIso2", "position", "poiTypes", "address", "contacts",
    "phones", "websites", "openingHours", "timeRanges", "utcOffsetSeconds", "Accept-Language",
    "TomTom-Api-Version", "Content-Type",
)


class ProviderError(ValueError):
    """Safe error with API-compatible code; original provider text is never copied."""

    def __init__(self, code: str, retryable: bool = False, retry_after_seconds: float = 0, *,
                 upstream_status: int | None = None, reason: str | None = None,
                 field_hints: tuple[str, ...] = ()) -> None:
        self.code = code
        self.retryable = retryable
        self.retry_after_seconds = retry_after_seconds
        self.upstream_status = upstream_status if type(upstream_status) is int and 100 <= upstream_status <= 599 else None
        self.reason = reason if type(reason) is str and reason in _DIAGNOSTIC_REASONS else None
        self.field_hints = tuple(field for field in _TOMTOM_FIELDS if field in field_hints)
        super().__init__(code)


def log_tomtom_failure(service: str, error: BaseException, *, reason: str = "unclassified") -> None:
    """Fixed categories only: never format an exception, URL, payload or secret."""
    service = service if type(service) is str and service in {"routing", "places"} else "unknown"
    code = getattr(error, "code", None)
    if type(code) is not str or code not in {"rate_limited", "provider_unavailable", "invalid_provider_response", "invalid_request"}:
        code = "provider_error"
    category = getattr(error, "reason", None) or reason
    if type(category) is not str or category not in _DIAGNOSTIC_REASONS:
        category = "unclassified"
    status = getattr(error, "upstream_status", None)
    if type(status) is not int or not 100 <= status <= 599:
        status = None
    logging.getLogger("uvicorn.error").warning(
        "TomTom request failed: service=%s reason=%s code=%s upstream_status=%s fields=%s",
        service, category, code, status,
        ",".join(field for field in _TOMTOM_FIELDS if field in getattr(error, "field_hints", ())) or "none",
    )


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_instant(value: str) -> datetime:
    """Parse an RFC3339 instant, never interpreting a naive timestamp as local time."""
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)", value
    ):
        raise ProviderError("invalid_request")
    try:
        return datetime.fromisoformat(value.upper().replace("Z", "+00:00")).astimezone(timezone.utc)
    except (ValueError, OverflowError):
        raise ProviderError("invalid_request") from None


class JsonHTTP:
    """Only for safe GETs and idempotent route-calculation POSTs.

    Total deadline includes retries, response streaming and the local concurrency
    gate. No redirects, no environment proxy credentials, no exception text leaks.
    429 is not retried: caller must respect the provider quota before trying again.
    """

    def __init__(
        self, *, timeout_seconds: float = 6.0, retries: int = 1,
        client: httpx.AsyncClient | None = None, max_bytes: int = 2_000_000,
    ) -> None:
        if (isinstance(timeout_seconds, bool) or not math.isfinite(timeout_seconds)
                or not 0 < timeout_seconds <= 30):
            raise ValueError("timeout_seconds must be finite and between 0 and 30")
        if type(retries) is not int or not 0 <= retries <= 2:
            raise ValueError("retries must be an integer from 0 to 2")
        if type(max_bytes) is not int or not 1 <= max_bytes <= 10_000_000:
            raise ValueError("invalid response size limit")
        self.timeout_seconds = timeout_seconds
        self.retries = retries
        self.max_bytes = max_bytes
        self._gate = asyncio.Semaphore(4)
        self._client = client or httpx.AsyncClient(
            timeout=timeout_seconds, follow_redirects=False, trust_env=False,
            headers={"User-Agent": "AstanaCompass-Context/0.1", "Accept": "application/json",
                     "Accept-Encoding": "identity"},
        )
        self._closed = False
        self._close_task: asyncio.Task | None = None

    async def request(
        self, method: str, url: str, *, headers: dict | None = None,
        json: Any = None, params: dict | None = None,
    ) -> dict:
        if self._closed:
            raise ProviderError("provider_unavailable")
        if method not in {"GET", "POST"} or not url.startswith("https://"):
            raise ProviderError("invalid_request")
        # Enforce the same policy for injected clients and caller-provided
        # headers without mutating the caller's dictionary or authentication.
        request_headers = httpx.Headers(headers)
        request_headers["Accept-Encoding"] = "identity"
        try:
            async with asyncio.timeout(self.timeout_seconds):
                async with self._gate:
                    for attempt in range(self.retries + 1):
                        try:
                            async with self._client.stream(
                                method, url, headers=request_headers, json=json, params=params,
                                timeout=self.timeout_seconds, follow_redirects=False,
                            ) as response:
                                if response.status_code == 429:
                                    retry_after = response.headers.get("retry-after", "60")
                                    try:
                                        delay = float(retry_after) if retry_after.isdigit() else (parsedate_to_datetime(retry_after) - utc_now()).total_seconds()
                                    except (ValueError, TypeError, OverflowError):
                                        delay = 60
                                    raise ProviderError("rate_limited", retryable=True, retry_after_seconds=max(60, delay),
                                                        upstream_status=429, reason="http_error")
                                if response.status_code in {408, 500, 502, 503, 504}:
                                    raise ProviderError("provider_unavailable", retryable=True,
                                                        upstream_status=response.status_code, reason="http_error")
                                if not 200 <= response.status_code < 300:
                                    hints = ()
                                    if response.status_code == 400 and url.startswith("https://api.tomtom.com/"):
                                        # Only constant parameter names can reach a log. Never retain
                                        # the provider's message, target, request echo or credentials.
                                        raw = bytearray()
                                        if response.headers.get("content-encoding", "identity").strip().lower() in {"", "identity"}:
                                            if response.is_stream_consumed:
                                                raw.extend(response.content if len(response.content) <= 16_384 else b"")
                                            else:
                                                async for chunk in response.aiter_raw(chunk_size=1024):
                                                    raw.extend(chunk)
                                                    if len(raw) > 16_384:
                                                        raw.clear()
                                                        break
                                            text = raw.decode("utf-8", errors="replace")
                                            hints = tuple(field for field in _TOMTOM_FIELDS if re.search(r"(?<!\w)" + re.escape(field) + r"(?!\w)", text, re.IGNORECASE))
                                    raise ProviderError("provider_unavailable", upstream_status=response.status_code,
                                                        reason="http_error", field_hints=hints)
                                encoding = response.headers.get("content-encoding", "identity").strip().lower()
                                if encoding not in {"", "identity"}:
                                    # Reject before HTTPX can decompress a small
                                    # encoded body into an unbounded allocation.
                                    raise ProviderError("invalid_provider_response", upstream_status=response.status_code,
                                                        reason="rejected_encoding")
                                if response.is_stream_consumed:
                                    # Custom in-memory transports may preload a
                                    # response. Real network responses stream raw.
                                    body = response.content
                                    if len(body) > self.max_bytes:
                                        raise ProviderError("invalid_provider_response", upstream_status=response.status_code,
                                                            reason="response_too_large")
                                else:
                                    body = bytearray()
                                    chunk_size = min(4096, self.max_bytes + 1)
                                    async for chunk in response.aiter_raw(chunk_size=chunk_size):
                                        if len(body) + len(chunk) > self.max_bytes:
                                            raise ProviderError("invalid_provider_response", upstream_status=response.status_code,
                                                                reason="response_too_large")
                                        body.extend(chunk)
                                try:
                                    def reject_constant(_):
                                        raise ValueError("Nonfinite JSON constant")
                                    result = jsonlib.loads(body, parse_constant=reject_constant)
                                except (ValueError, UnicodeError, RecursionError):
                                    raise ProviderError("invalid_provider_response", upstream_status=response.status_code,
                                                        reason="invalid_json") from None
                                if not isinstance(result, dict):
                                    raise ProviderError("invalid_provider_response", upstream_status=response.status_code,
                                                        reason="invalid_shape")
                                return result
                        except httpx.TimeoutException:
                            failure = ProviderError("provider_unavailable", retryable=True, reason="timeout")
                        except httpx.TransportError:
                            failure = ProviderError("provider_unavailable", retryable=True, reason="transport_error")
                        except httpx.HTTPError:
                            raise ProviderError("invalid_provider_response", reason="transport_error") from None
                        except ProviderError as error:
                            if not error.retryable or error.code == "rate_limited":
                                raise
                            failure = error
                        if attempt == self.retries:
                            raise failure from None
                        await asyncio.sleep(0.2 * (2 ** attempt))
        except TimeoutError:
            raise ProviderError("provider_unavailable", retryable=True, reason="timeout") from None
        raise ProviderError("provider_unavailable", retryable=True)

    async def aclose(self) -> None:
        if self._close_task is None:
            self._closed = True
            self._close_task = asyncio.create_task(self._client.aclose())
        # HTTPX itself marks the client closed before finishing transport shutdown.
        # Protect that single shutdown task and retain it for subsequent awaiters.
        await asyncio.shield(self._close_task)
