"""Optional fact selection and source-bounded personalized visit advice."""

from dataclasses import dataclass
from typing import Literal, Protocol

from astana_contracts import JSON


@dataclass(frozen=True)
class GroundedReason:
    """Reference an existing known fact and its exact supporting evidence IDs."""

    fact_key: str
    evidence_ids: tuple[str, ...]


@dataclass(frozen=True)
class GroundedExplanation:
    """The service renders these references in the user's language.

    Restricting generated reasons to existing facts prevents a true citation from
    being attached to a fabricated claim. Activities are generic suggestions, not
    assertions that an amenity, service or event exists.
    """

    why: tuple[GroundedReason, ...]
    suggested_activity: Literal["observe", "explore", "take_break"] = "observe"


class ExplanationGenerator(Protocol):
    async def generate(
        self,
        *,
        locale: str,
        query: str,
        place: JSON,
        constraint_evaluations: list[JSON],
    ) -> GroundedExplanation:
        """Select grounded reasons; receives no private origin or raw request."""
        ...


@dataclass(frozen=True)
class RouteExplanation:
    """Model-written advice, distinct from the canonical verified venue facts.

    The adapter validates supporting references against that stop's supplied
    public sources. References establish provenance, not semantic entailment;
    generated prose remains advice and must never update a PlaceFact.
    """

    why: str
    suggested_activity: str


class RouteExplanationGenerator(Protocol):
    async def generate_route_explanations(
        self, *, locale: str, query: str, stops: list[JSON],
    ) -> dict[str, RouteExplanation]:
        """Explain at most six {place, purpose?} stops in one bounded request.

        Unlike the legacy fact selector, this explicitly authorized feature
        shares the applied wish and bounded public venue context with the model.
        Origins, coordinates, profiles, chats and source URLs are excluded.
        """
        ...
