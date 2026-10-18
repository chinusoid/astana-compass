"""CI smoke for the installed API and explicit, read-only real snapshot mount.

Run the container with --network none. The script itself sends only in-process
ASGI requests; no TestClient or development dependencies are required.
"""
import argparse
import asyncio
from datetime import datetime, timezone
import importlib
import os
from pathlib import Path
import sys

import httpx
from astana_api import create_app
from astana_api.settings import Settings
from astana_contracts import validate_payload


def installed_packages():
    for name in ("astana_api", "astana_city_data", "astana_retrieval", "astana_city_context", "astana_contracts"):
        module = importlib.import_module(name)
        assert Path(module.__file__).resolve().is_relative_to(Path(sys.prefix).resolve()), name
    assert not Path("/app/packages").exists(), "Runtime must use installed wheels, not source imports"
    assert not Path("/app/data").exists(), "Live data must be an explicit external input"


async def check(snapshot):
    # Scope these settings to this smoke process, never access live provider keys.
    for name in ("ASTANA_POI_PATH", "ROUTING_API_KEY", "ORS_API_KEY", "OPENAI_API_KEY", "NVIDIA_API_KEY", "LLM_API_KEY", "TOMTOM_API_KEY"):
        os.environ.pop(name, None)
    os.environ["ASTANA_WEATHER_ENABLED"] = "false"
    os.environ["ASTANA_ROUTE_ALLOW_APPROXIMATE"] = "true"
    os.environ["ASTANA_RETRIEVAL_POOL_LIMIT"] = "500"

    # Missing and invalid configuration must not silently select bundled data.
    for path in (None, "/definitely-missing/astana-snapshot.json"):
        if path is not None:
            os.environ["ASTANA_POI_PATH"] = path
        app = create_app(Settings(mode="live", llm_provider="none"))
        async with app.router.lifespan_context(app):
            assert app.state.services is None
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://smoke") as client:
                assert (await client.get("/v1/health/live")).status_code == 200
                assert (await client.get("/v1/health/ready")).status_code == 503
                assert (await client.get("/v1/places")).status_code == 503

    os.environ["ASTANA_POI_PATH"] = str(snapshot.resolve())
    app = create_app(Settings(mode="live", llm_provider="none"))
    async with app.router.lifespan_context(app):
        assert app.state.services is not None, "Installed live factories failed to compose"
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://smoke") as client:
            assert (await client.get("/v1/health/ready")).status_code == 200
            status = await client.get("/v1/data-status")
            assert status.status_code == 200
            validate_payload("DataStatusResponse", status.json())
            assert status.json()["total_places"] > 0
            assert all(source["status"] in {"ready", "stale"} for source in status.json()["sources"])
            response = await client.get("/v1/places", params={"categories": "museum", "limit": 3})
            assert response.status_code == 200 and response.headers["X-Astana-Data-Mode"] == "live"
            catalogue = response.json()
            validate_payload("PlaceListResponse", catalogue)
            assert catalogue["places"]
            assert all(not place["is_synthetic"] and place["id"].startswith("osm:") for place in catalogue["places"])
            request = {"query": "museum", "locale": "en", "origin": {"lat": 51.128, "lon": 71.43},
                       "start_at": datetime.now(timezone.utc).isoformat(), "timezone": "Asia/Almaty",
                       "available_seconds": 10800, "transport": "walking", "return_to_origin": False,
                       "constraints": [], "limit": 3}
            response = await client.post("/v1/recommendations", json=request)
            assert response.status_code == 200
            recommendations = response.json()
            validate_payload("RecommendationResponse", recommendations)
            assert recommendations["recommendations"], "Real snapshot retrieval returned no museum candidates"
            assert all(not place["is_synthetic"] for place in recommendations["places"])
            assert all(item["route"]["method"] == "approximate" and item["route"]["geometry"] is None
                       for item in recommendations["recommendations"]), "No routing provider was configured"
    print("Live smoke passed: factory composition, explicit real snapshot, missing-source failure, no provider calls.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True, type=Path)
    parser.add_argument("--installed", action="store_true", help="Also reject imports from source checkouts")
    args = parser.parse_args()
    if args.installed:
        installed_packages()
    asyncio.run(check(args.snapshot))


if __name__ == "__main__":
    main()
