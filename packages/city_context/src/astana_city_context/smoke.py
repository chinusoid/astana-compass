"""Explicit live smoke on fixed public landmark-area coordinates, never user data."""
import asyncio
import json
import os

from .common import utc_now
from .provider import create_context


async def _run() -> None:
    if not (os.environ.get("ROUTING_API_KEY") or os.environ.get("ORS_API_KEY")):
        raise SystemExit("Live ORS smoke blocked: configure backend ROUTING_API_KEY (or ORS_API_KEY).")
    # The smoke must fail rather than accidentally demonstrating an approximation.
    original = os.environ.get("ASTANA_ROUTE_ALLOW_APPROXIMATE")
    weather_original = os.environ.get("ASTANA_WEATHER_ENABLED")
    os.environ["ASTANA_ROUTE_ALLOW_APPROXIMATE"] = "false"
    os.environ["ASTANA_WEATHER_ENABLED"] = "false"
    try:
        context = await create_context(config={"mode": "live", "timezone": "Asia/Almaty"})
    finally:
        for name, value in [("ASTANA_ROUTE_ALLOW_APPROXIMATE", original), ("ASTANA_WEATHER_ENABLED", weather_original)]:
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
    try:
        route = await context.estimate_route(
            origin={"lat": 51.1282, "lon": 71.4304},
            destinations=[{"lat": 51.1285, "lon": 71.4350}],
            transport="walking", return_to_origin=True, start_at=utc_now().isoformat(),
        )
        if route["method"] != "routed":
            raise SystemExit("Live walking smoke failed: provider route required.")
        print(json.dumps({key: route[key] for key in ["method", "provider", "distance_meters", "duration_seconds", "includes_return", "generated_at"]} | {
            "vertices": len(route["geometry"]["coordinates"]),
            "retrieved_at": route["evidence"][0]["retrieved_at"],
        }))
    finally:
        await context.aclose()


if __name__ == "__main__":
    asyncio.run(_run())
