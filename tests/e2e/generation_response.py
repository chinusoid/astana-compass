"""Test-only replay adapters: real generator + recommender, mocked provider I/O.

Read an actual synthetic foundation response on stdin. Never call external
inference, load credentials, or provide a backend for the product frontend.
"""

import asyncio
from copy import deepcopy
import json
import sys

import httpx
from astana_ai_providers import create_generator
from astana_contracts import validate_payload
from astana_recommender import DefaultRecommendationService


async def run(failure, original):
    validate_payload("RecommendationResponse", original)
    places = original["places"]
    if not places or not all(place["is_synthetic"] for place in places):
        raise ValueError("Only explicitly synthetic replay data is accepted")

    class Repository:
        async def get(self, place_id):
            return deepcopy(next((p for p in places if p["id"] == place_id), None))

        async def nearby(self, **kwargs):
            return deepcopy(places)

    class Retriever:
        async def retrieve(self, request):
            return {
                "places": deepcopy(places),
                "hits": [{"place_id": p["id"], "score": float(len(places) - i),
                          "score_kind": "deterministic", "matched_fact_keys": []}
                         for i, p in enumerate(places)],
                "strategy": "synthetic_e2e_replay",
                "warnings": ["SYNTHETIC: replay of the foundation fixture response."],
            }

    class Context:
        async def enrich_places(self, *, places, request):
            return {"places": deepcopy(places), "warnings": [], "degraded_services": []}

        async def estimate_route(self, *, destinations, **kwargs):
            place = next(p for p in places if p["location"] == destinations[0])
            item = next(r for r in original["recommendations"] if r["place_id"] == place["id"])
            return deepcopy(item["route"])

    def provider_response(request):
        if failure == "model unavailable":
            return httpx.Response(503, json={"error": "Synthetic service failure"})
        if failure == "provider refusal":
            content = [{"type": "refusal", "refusal": "Synthetic test refusal"}]
        elif failure == "malformed model output":
            content = [{"type": "output_text", "text": "not valid JSON"}]
        else:
            raise ValueError("Unknown fault scenario")
        return httpx.Response(200, json={"status": "completed", "output": [{
            "type": "message", "role": "assistant", "status": "completed", "content": content,
        }]})

    async with create_generator(
        "openai", "synthetic/e2e-model", "synthetic-not-a-real-credential",
        transport=httpx.MockTransport(provider_response),
    ) as generator:
        service = DefaultRecommendationService(Repository(), Retriever(), Context(), generator=generator)
        result = await service.recommend(original["request"])
        return validate_payload("RecommendationResponse", result)


if __name__ == "__main__":
    print(json.dumps(asyncio.run(run(sys.argv[1], json.load(sys.stdin))), ensure_ascii=False))
