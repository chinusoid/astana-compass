"""Public async service ports; boundary JSON must pass the named canonical schema."""
from __future__ import annotations

from typing import Protocol, runtime_checkable
from .validation import JSON


@runtime_checkable
class PlaceRepository(Protocol):
    async def get(self, place_id: str) -> JSON | None:
        """Return Place or None."""
        ...

    async def list_places(
        self, *, bbox: tuple[float, float, float, float] | None = None,
        query: str | None = None, categories: list[str] | None = None,
        cursor: str | None = None, limit: int = 50,
    ) -> JSON:
        """Return PlaceListResponse; bbox is west, south, east, north."""
        ...

    async def nearby(self, *, origin: JSON, radius_meters: float, limit: int = 100) -> list[JSON]:
        """Return Places ordered by distance and then stable ID."""
        ...

    async def data_status(self) -> JSON:
        """Return DataStatusResponse."""
        ...


@runtime_checkable
class Retriever(Protocol):
    async def retrieve(self, request: JSON) -> JSON:
        """RetrievalRequest -> RetrievalResponse. Defer unknown dynamic constraints."""
        ...


@runtime_checkable
class ContextProvider(Protocol):
    async def enrich_places(self, *, places: list[JSON], request: JSON) -> JSON:
        """RecommendationRequest context -> ContextResult, without mutating inputs."""
        ...

    async def estimate_route(
        self, *, origin: JSON, destinations: list[JSON], transport: str,
        return_to_origin: bool, start_at: str,
    ) -> JSON:
        """Ordered Locations -> RouteEstimate. Unsupported transports must fail explicitly."""
        ...


@runtime_checkable
class JourneyPlanner(Protocol):
    async def plan(self, query: str, locale: str) -> JSON:
        """Query and locale only -> JourneyPlan; no coordinates or POI facts."""
        ...


@runtime_checkable
class RecommendationService(Protocol):
    async def recommend(self, request: JSON) -> JSON:
        """RecommendationRequest -> RecommendationResponse."""
        ...

    async def build_itinerary(self, request: JSON) -> JSON:
        """ItineraryRequest -> ItineraryResponse preserving selected place IDs/order."""
        ...
