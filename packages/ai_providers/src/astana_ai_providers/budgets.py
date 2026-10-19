"""Shared in-process rolling limits for attempted hosted model requests.

No prompts, credentials or user identifiers are retained. These are request
limits, not a currency budget. Counters reset when the process restarts: deploy
one API worker/replica or enforce a shared quota at the gateway as well.
"""
from __future__ import annotations

from collections import deque
import math
import os
from threading import Lock
import time
from typing import Callable


class BudgetExhausted(RuntimeError):
    """The local process must not send another provider request yet."""


class RequestBudget:
    """Reserve before I/O; failed or cancelled attempts are never refunded.

    Explicit injection lets intent and explanation clients share one allowance.
    No module-global state couples independent applications or tests.
    """

    def __init__(
        self, per_minute: int = 10, per_day: int = 100, *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if type(per_minute) is not int or not 0 <= per_minute <= 10_000:
            raise ValueError("LLM requests per minute must be an integer from 0 to 10000")
        if type(per_day) is not int or not 0 <= per_day <= 100_000:
            raise ValueError("LLM requests per day must be an integer from 0 to 100000")
        self.per_minute = per_minute
        self.per_day = per_day
        self._clock = clock
        self._requests: deque[float] = deque()
        self._last_clock: float | None = None
        self._lock = Lock()

    @classmethod
    def from_env(cls) -> RequestBudget:
        def configured(name: str, default: int) -> int:
            try:
                return int(os.environ.get(name, str(default)))
            except ValueError:
                raise ValueError(f"{name} must be an integer") from None

        return cls(
            configured("ASTANA_LLM_REQUESTS_PER_MINUTE", 10),
            configured("ASTANA_LLM_REQUESTS_PER_DAY", 100),
        )

    def reserve(self) -> None:
        """Atomically reserve one attempt without yielding to another coroutine."""
        with self._lock:
            now = self._clock()
            if (not math.isfinite(now)
                    or (self._last_clock is not None and now < self._last_clock)):
                raise BudgetExhausted("local_budget_exhausted")
            self._last_clock = now
            while self._requests and now - self._requests[0] >= 86_400:
                self._requests.popleft()
            if self.per_minute == 0 or len(self._requests) >= self.per_day:
                raise BudgetExhausted("local_budget_exhausted")
            minute_count = 0
            for attempted_at in reversed(self._requests):
                if now - attempted_at >= 60:
                    break
                minute_count += 1
            if minute_count >= self.per_minute:
                raise BudgetExhausted("local_budget_exhausted")
            self._requests.append(now)
