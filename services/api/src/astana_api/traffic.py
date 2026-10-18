"""Small, opt-in TomTom road samples. This is not a citywide vehicle count feed."""
import asyncio
from copy import deepcopy
from datetime import datetime, timezone
import math
import json
import time

import httpx
from astana_contracts import validate_payload


class TrafficService:
    def __init__(self, api_key="", *, transport=None, clock=time.monotonic):
        self.api_key, self.clock = api_key, clock
        self.client = httpx.AsyncClient(timeout=5, follow_redirects=False, trust_env=False, transport=transport, headers={"Accept-Encoding": "identity"})
        self.cache, self.calls = {}, []
        self.lock = asyncio.Lock()

    async def aclose(self):
        await self.client.aclose()

    @staticmethod
    def response(status, segments=()):
        return {"status": status, "provider": "TomTom", "segments": list(segments), "attribution": "© TomTom"}

    async def sample(self, points):
        if not self.api_key:
            return self.response("not_configured")
        if any(not (50.8 <= point["lat"] <= 51.4 and 71.0 <= point["lon"] <= 71.8) for point in points):
            return self.response("unavailable")
        segments, missing = [], False
        # A single gate prevents quota storms; callers use one explicit refresh.
        async with self.lock:
            for point in points[:6]:
                key = (round(point["lat"], 3), round(point["lon"], 3))
                cached = self.cache.get(key)
                if cached and self.clock() - cached[0] < 60:
                    if cached[1] is not None:
                        segments.append(deepcopy(cached[1]))
                    else:
                        missing = True
                    continue
                self.calls = [stamp for stamp in self.calls if self.clock() - stamp < 60]
                if len(self.calls) >= 12:
                    missing = True
                    continue
                self.calls.append(self.clock())
                segment = None
                try:
                    async with self.client.stream("GET", "https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/16/json", params={"key": self.api_key, "point": f"{key[0]},{key[1]}", "unit": "KMPH"}) as response:
                        response.raise_for_status()
                        if response.headers.get("content-encoding", "identity").strip().lower() not in {"", "identity"}:
                            raise ValueError("unsupported traffic encoding")
                        body = response.content if response.is_stream_consumed else bytearray()
                        if len(body) > 131072:
                            raise ValueError("traffic response too large")
                        if not response.is_stream_consumed:
                            async for chunk in response.aiter_raw(chunk_size=4096):
                                if len(body) + len(chunk) > 131072:
                                    raise ValueError("traffic response too large")
                                body.extend(chunk)
                        data = json.loads(body)["flowSegmentData"]
                    coordinates = [[point["longitude"], point["latitude"]] for point in data["coordinates"]["coordinate"]]
                    if not 2 <= len(coordinates) <= 512 or any(not all(type(v) in (int, float) and math.isfinite(v) for v in point) for point in coordinates):
                        raise ValueError("invalid traffic geometry")
                    segment = {"geometry": {"type": "LineString", "coordinates": coordinates}, "current_speed_kmh": data["currentSpeed"], "free_flow_speed_kmh": data["freeFlowSpeed"], "confidence": data["confidence"], "road_closed": data["roadClosure"], "fetched_at": datetime.now(timezone.utc).isoformat()}
                    validate_payload("TrafficSegment", segment)
                except (httpx.HTTPError, ValueError, KeyError, TypeError, RecursionError):
                    segment = None  # Do not echo URLs containing the provider key.
                if len(self.cache) >= 128:
                    self.cache.pop(next(iter(self.cache)))
                self.cache[key] = (self.clock(), deepcopy(segment))
                if segment is not None:
                    segments.append(segment)
                else:
                    missing = True
        unique = {str(segment["geometry"]["coordinates"]): segment for segment in segments}
        return self.response("partial" if unique and missing else "live" if unique else "unavailable", unique.values())
