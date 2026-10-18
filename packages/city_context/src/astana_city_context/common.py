"""Bounded provider I/O. No user/provider payloads or credentials are logged."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json as jsonlib
import math
import re
from typing import Any

import httpx


class ProviderError(ValueError):
    """Safe error with API-compatible code; original provider text is never copied."""

    def __init__(self, code: str, retryable: bool = False) -> None:
        self.code = code
        self.retryable = retryable
        super().__init__(code)


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
                                    raise ProviderError("rate_limited", retryable=True)
                                if response.status_code in {408, 500, 502, 503, 504}:
                                    raise ProviderError("provider_unavailable", retryable=True)
                                if not 200 <= response.status_code < 300:
                                    raise ProviderError("provider_unavailable")
                                encoding = response.headers.get("content-encoding", "identity").strip().lower()
                                if encoding not in {"", "identity"}:
                                    # Reject before HTTPX can decompress a small
                                    # encoded body into an unbounded allocation.
                                    raise ProviderError("invalid_provider_response")
                                if response.is_stream_consumed:
                                    # Custom in-memory transports may preload a
                                    # response. Real network responses stream raw.
                                    body = response.content
                                    if len(body) > self.max_bytes:
                                        raise ProviderError("invalid_provider_response")
                                else:
                                    body = bytearray()
                                    chunk_size = min(4096, self.max_bytes + 1)
                                    async for chunk in response.aiter_raw(chunk_size=chunk_size):
                                        if len(body) + len(chunk) > self.max_bytes:
                                            raise ProviderError("invalid_provider_response")
                                        body.extend(chunk)
                                try:
                                    def reject_constant(_):
                                        raise ValueError("Nonfinite JSON constant")
                                    result = jsonlib.loads(body, parse_constant=reject_constant)
                                except (ValueError, UnicodeError, RecursionError):
                                    raise ProviderError("invalid_provider_response") from None
                                if not isinstance(result, dict):
                                    raise ProviderError("invalid_provider_response")
                                return result
                        except httpx.TransportError:
                            failure = ProviderError("provider_unavailable", retryable=True)
                        except httpx.HTTPError:
                            raise ProviderError("invalid_provider_response") from None
                        except ProviderError as error:
                            if not error.retryable or error.code == "rate_limited":
                                raise
                            failure = error
                        if attempt == self.retries:
                            raise failure from None
                        await asyncio.sleep(0.2 * (2 ** attempt))
        except TimeoutError:
            raise ProviderError("provider_unavailable", retryable=True) from None
        raise ProviderError("provider_unavailable", retryable=True)

    async def aclose(self) -> None:
        if self._close_task is None:
            self._closed = True
            self._close_task = asyncio.create_task(self._client.aclose())
        # HTTPX itself marks the client closed before finishing transport shutdown.
        # Protect that single shutdown task and retain it for subsequent awaiters.
        await asyncio.shield(self._close_task)
