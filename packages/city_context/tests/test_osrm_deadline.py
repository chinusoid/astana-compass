"""The public router's deadline includes queueing, pacing and active I/O."""

import asyncio
from copy import deepcopy
from types import SimpleNamespace
import time

import pytest

from astana_city_context import osrm
from astana_city_context.common import ProviderError
from astana_city_context.osrm import ENDPOINT, OSRMWalkingRouter
from astana_city_context.routing import _distance


def arguments(offset=0):
    return {
        "origin": {"lon": 71.4305, "lat": 51.1283},
        "destinations": [{"lon": 71.4315 + offset, "lat": 51.1293}],
        "transport": "walking",
        "return_to_origin": False,
        "start_at": "2026-10-20T12:00:00+05:00",
    }


def response(url):
    points = [[float(number) for number in point.split(",")]
              for point in url.removeprefix(ENDPOINT).split(";")]
    distance = _distance(points[0], points[1])
    duration = distance / 1.25
    geometry = {"type": "LineString", "coordinates": points}
    return {
        "code": "Ok",
        "waypoints": [{"location": point, "distance": 0} for point in points],
        "routes": [{
            "geometry": geometry,
            "distance": distance,
            "duration": duration,
            "legs": [{
                "distance": distance,
                "duration": duration,
                "steps": [{"mode": "walking", "geometry": deepcopy(geometry),
                           "distance": distance, "duration": duration}],
            }],
        }],
    }


class HTTP:
    """In-memory provider with optional controlled suspension before response."""

    def __init__(self, before_response=None):
        self.before_response = before_response
        self.calls = []

    async def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if self.before_response is not None:
            await self.before_response(len(self.calls))
        return response(url)


class PacingAsyncio:
    """Advance only the router's pacing clock; preserve real cancellation."""

    def __init__(self, sleep):
        self.sleep = sleep

    def __getattr__(self, name):
        return getattr(asyncio, name)


@pytest.mark.parametrize("budget", [0, -1, float("nan"), float("inf"), True, "6", None])
def test_invalid_total_deadline_is_rejected(budget):
    with pytest.raises(ValueError):
        OSRMWalkingRouter(HTTP(), timeout_seconds=budget)


def test_configured_deadline_cannot_exceed_the_six_second_router_budget():
    assert OSRMWalkingRouter(HTTP(), timeout_seconds=30).timeout_seconds == 6


@pytest.mark.parametrize("allow_approximate", [False, True])
def test_queued_deadline_never_launches_http_and_releases_waiter(allow_approximate):
    async def check():
        http = HTTP()
        router = OSRMWalkingRouter(http, timeout_seconds=.05, allow_approximate=allow_approximate)
        await router._gate.acquire()
        try:
            if allow_approximate:
                route = await router.estimate_route(**arguments())
                assert route["method"] == "approximate" and route["geometry"] is None
            else:
                with pytest.raises(ProviderError) as raised:
                    await router.estimate_route(**arguments())
                assert raised.value.code == "provider_unavailable"
                assert raised.value.retryable and raised.value.reason == "timeout"
            assert not http.calls and not router._request_times
        finally:
            router._gate.release()
        # An expired waiter must neither own the gate nor obstruct a new route.
        healthy = await router.estimate_route(**arguments(.0002))
        assert healthy["method"] == "routed" and len(http.calls) == 1
        assert not router._gate.locked()

    asyncio.run(check())


def test_pacing_wait_counts_toward_deadline_without_spending_provider_call():
    async def check():
        http = HTTP()
        router = OSRMWalkingRouter(http, timeout_seconds=.05, allow_approximate=False)
        router._next_request = time.monotonic() + 1
        with pytest.raises(ProviderError) as raised:
            await router.estimate_route(**arguments())
        assert raised.value.reason == "timeout" and raised.value.retryable
        assert not http.calls and not router._gate.locked()
        assert not router._request_times
        router._next_request = 0
        assert (await router.estimate_route(**arguments()))["method"] == "routed"

    asyncio.run(check())


@pytest.mark.parametrize("allow_approximate", [False, True])
def test_active_http_deadline_cancels_io_and_preserves_truthful_fallback(allow_approximate):
    async def check():
        entered, cancelled = asyncio.Event(), asyncio.Event()

        async def suspended(_):
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                raise

        http = HTTP(suspended)
        router = OSRMWalkingRouter(http, timeout_seconds=.05, allow_approximate=allow_approximate)
        if allow_approximate:
            route = await router.estimate_route(**arguments())
            assert route["method"] == "approximate" and route["geometry"] is None
            assert route["distance_meters"] > 0 and route["duration_seconds"] > 0
        else:
            with pytest.raises(ProviderError) as raised:
                await router.estimate_route(**arguments())
            assert raised.value.code == "provider_unavailable"
            assert raised.value.reason == "timeout" and raised.value.retryable
        assert entered.is_set() and cancelled.is_set()
        assert len(http.calls) == 1 and not router._gate.locked()

    asyncio.run(check())


def test_external_cancellation_of_queue_does_not_become_an_approximate_route():
    async def check():
        http = HTTP()
        router = OSRMWalkingRouter(http, timeout_seconds=1, allow_approximate=True)
        await router._gate.acquire()
        task = asyncio.create_task(router.estimate_route(**arguments()))
        try:
            await asyncio.sleep(0)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert not http.calls
        finally:
            router._gate.release()
        healthy = await router.estimate_route(**arguments())
        assert healthy["method"] == "routed" and len(http.calls) == 1

    asyncio.run(check())


def test_external_cancellation_of_http_releases_resources_and_next_route_is_healthy():
    async def check():
        entered, cancelled = asyncio.Event(), asyncio.Event()

        async def suspend_first(call):
            if call == 1:
                entered.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    cancelled.set()
                    raise

        http = HTTP(suspend_first)
        router = OSRMWalkingRouter(http, timeout_seconds=1, allow_approximate=True)
        task = asyncio.create_task(router.estimate_route(**arguments()))
        await asyncio.wait_for(entered.wait(), timeout=.2)
        assert not router._gate.locked(), "active HTTP must not hold the pacing lock"
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert cancelled.is_set()
        router._next_request = 0
        healthy = await router.estimate_route(**arguments())
        assert healthy["method"] == "routed" and len(http.calls) == 2

    asyncio.run(check())


def test_http_overlaps_while_dispatch_starts_remain_paced(monkeypatch):
    tick = [100.0]

    async def fast_pacing(delay):
        tick[0] += delay
        await asyncio.sleep(0)

    monkeypatch.setattr(osrm, "time", SimpleNamespace(monotonic=lambda: tick[0]))
    monkeypatch.setattr(osrm, "asyncio", PacingAsyncio(fast_pacing))

    async def check():
        starts = []
        all_entered, release = asyncio.Event(), asyncio.Event()

        async def suspended(_):
            starts.append(tick[0])
            if len(starts) == 4:
                all_entered.set()
            await release.wait()

        http = HTTP(suspended)
        router = OSRMWalkingRouter(http, timeout_seconds=1, allow_approximate=False)
        tasks = [asyncio.create_task(router.estimate_route(**arguments(offset)))
                 for offset in (0, .0002, .0004, .0006)]
        try:
            await asyncio.wait_for(all_entered.wait(), timeout=.2)
            assert all(later - earlier >= 1.05 - 1e-9 for earlier, later in zip(starts, starts[1:]))
            assert not router._gate.locked()
            release.set()
            routes = await asyncio.gather(*tasks)
            assert all(route["method"] == "routed" for route in routes)
        finally:
            release.set()
            await asyncio.gather(*tasks, return_exceptions=True)

    asyncio.run(check())


def test_inflight_rate_limit_is_rechecked_after_a_waiters_pacing_sleep(monkeypatch):
    tick = [100.0]
    pacing_started, finish_pacing = None, None

    async def controlled_pacing(delay):
        if delay > 0:
            pacing_started.set()
            await finish_pacing.wait()
            tick[0] += delay
        await asyncio.sleep(0)

    monkeypatch.setattr(osrm, "time", SimpleNamespace(monotonic=lambda: tick[0]))
    monkeypatch.setattr(osrm, "asyncio", PacingAsyncio(controlled_pacing))

    async def check():
        nonlocal pacing_started, finish_pacing
        pacing_started, finish_pacing = asyncio.Event(), asyncio.Event()
        first_entered, reject_first = asyncio.Event(), asyncio.Event()

        async def rate_limit(_):
            first_entered.set()
            await reject_first.wait()
            raise ProviderError("rate_limited", retryable=True, retry_after_seconds=120)

        http = HTTP(rate_limit)
        router = OSRMWalkingRouter(http, timeout_seconds=1, allow_approximate=False)
        first = asyncio.create_task(router.estimate_route(**arguments()))
        second = None
        try:
            await asyncio.wait_for(first_entered.wait(), timeout=.2)
            second = asyncio.create_task(router.estimate_route(**arguments(.0002)))
            await asyncio.wait_for(pacing_started.wait(), timeout=.2)
            reject_first.set()
            with pytest.raises(ProviderError) as raised:
                await first
            assert raised.value.code == "rate_limited"
            cooldown = router._cooldown
            finish_pacing.set()
            with pytest.raises(ProviderError) as raised:
                await second
            assert raised.value.code == "rate_limited"
            assert router._cooldown == cooldown
            assert len(http.calls) == 1 and not router._gate.locked()
        finally:
            reject_first.set()
            finish_pacing.set()
            await asyncio.gather(*(task for task in (first, second) if task is not None),
                                 return_exceptions=True)

    asyncio.run(check())
