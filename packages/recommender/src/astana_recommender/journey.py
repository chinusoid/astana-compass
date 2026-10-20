"""Conservative sequence boundaries; destination matching belongs to retrieval."""

from __future__ import annotations

import re


_NEXT = re.compile(
    r"(?<!\w)(?:(?:а|и)\s+)?(?:потом|затем|далее|после\s+этого|в\s+конце|под\s+конец)(?!\w)|"
    r"(?<!\w)(?:and\s+)?(?:then|after\s+that|finally|lastly|"
    r"next(?!\s+(?:to|door|week|month|year|summer|winter|spring|autumn|fall|time)\b))(?!\w)|"
    r"(?<!\w)(?:(?:содан|одан)\s+кейін|одан\s+соң|сосын|соңында)(?!\w)",
    re.IGNORECASE,
)
_FIRST = re.compile(r"(?<!\w)(?:сначала|сперва|first|алдымен|әуелі)(?!\w)\s*", re.IGNORECASE)


def journey_stages(query: str) -> tuple[str, ...]:
    """Return explicit ordered clauses, or no plan for ordinary mixed wishes.

    Empty clauses remain empty, so a missing destination is not silently lost.
    Four entries are enough to detect the public three-stop limit. No parsing
    result is interpreted as a venue, fact, tool instruction, or new constraint.
    """
    parts = _NEXT.split(query, maxsplit=3)
    if len(parts) == 1 or not parts[0].strip(" ,;:.!?\n\t"):
        return ()
    parts[0] = _FIRST.sub("", parts[0], count=1)
    return tuple(part.strip(" ,;:.!?\n\t") for part in parts)
