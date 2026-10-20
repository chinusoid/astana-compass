"""HTTP boundary for canonical contracts, with explicit offline/live operation."""
from collections import deque
from contextlib import AsyncExitStack, asynccontextmanager
from copy import deepcopy
from datetime import datetime, timezone
import asyncio
import json
import logging
import math
import os
import time
import uuid

from fastapi import FastAPI, Request, Query
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from astana_contracts import ContractValidationError, load_schema, validate_payload
from astana_recommender import RecommenderError
from .composition import StartupProgress, build_services
from .demo_examples import request_examples
from .sandbox import sandbox_router
from .settings import Settings
from .social import SocialError, SocialStore, social_error_handler, social_router
from .traffic import TrafficService
from .tomtom_places import create_map_service
from .twogis_places import TwoGisPlacesService
from .place_photos import WikimediaPlacePhotos
from astana_city_context.common import ProviderError


logger = logging.getLogger(__name__)


MESSAGES = {
    "invalid_request": "Request does not satisfy the API contract.",
    "unsupported_transport": "This transport is not implemented.",
    "provider_unavailable": "A required service is unavailable. Please try again.",
    "rate_limited": "The service is busy. Please try again shortly.",
    "internal_error": "The request could not be completed.",
    "not_found": "The requested resource was not found.",
}
STATUS = {"invalid_request": 422, "unsupported_transport": 422, "provider_unavailable": 503, "rate_limited": 429, "internal_error": 500, "not_found": 404}


class APIError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(MESSAGES[code])


def error_response(request_id, code):
    return JSONResponse({"request_id": request_id, "error": {
        "code": code, "message": MESSAGES[code],
        "retryable": code in {"provider_unavailable", "rate_limited"}, "details": [],
    }}, status_code=STATUS[code], headers={"Retry-After": "2"} if code == "rate_limited" else {})


class BoundaryMiddleware:
    """Limit streamed bodies, generate IDs, avoid retaining/logging user inputs."""
    def __init__(self, app, settings):
        self.app, self.settings = app, settings

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        request_id = str(uuid.uuid4())
        scope.setdefault("state", {})["request_id"] = request_id
        scope["state"]["started_at"] = time.monotonic()
        chunks, size = [], 0
        # Read with a deadline: Content-Length alone does not bound chunked bodies.
        try:
            async with asyncio.timeout(10):
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    chunk = message.get("body", b"")
                    size += len(chunk)
                    if size > self.settings.max_body_bytes:
                        return await error_response(request_id, "invalid_request")(scope, receive, send)
                    chunks.append(chunk)
                    if not message.get("more_body", False):
                        break
        except TimeoutError:
            return await error_response(request_id, "invalid_request")(scope, receive, send)
        body = b"".join(chunks)
        delivered = False

        async def bounded_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        async def header_send(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers += [(b"x-request-id", request_id.encode()), (b"x-astana-data-mode", self.settings.mode.encode()), (b"cache-control", b"no-store"), (b"x-content-type-options", b"nosniff")]
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, bounded_receive, header_send)


def utcnow():
    return datetime.now(timezone.utc).isoformat()


def check_payload_bounds(value, max_string_length=8192):
    """Bound synchronous schema work before entering the provider concurrency gate."""
    pending, count = [(value, 0)], 0
    while pending:
        item, depth = pending.pop()
        count += 1
        if count > 2048 or depth > 16:
            raise APIError("invalid_request")
        if isinstance(item, float) and not math.isfinite(item):
            raise APIError("invalid_request")
        if isinstance(item, str):
            if len(item) > max_string_length:
                raise APIError("invalid_request")
            # JSON escapes can carry lone UTF-16 surrogates. Reject them before
            # names/intent quotes are echoed through a UTF-8 JSON response.
            item.encode("utf-8")
        if isinstance(item, dict):
            if len(item) > 64 or any(len(key) > 512 for key in item):
                raise APIError("invalid_request")
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            if len(item) > 64:
                raise APIError("invalid_request")
            pending.extend((child, depth + 1) for child in item)
    if isinstance(value, dict):
        query, constraints = value.get("query"), value.get("constraints")
        if isinstance(query, str) and len(query) > 2000:
            raise APIError("invalid_request")
        if isinstance(constraints, list) and len(constraints) > 20:
            raise APIError("invalid_request")


async def read_payload(request, definition):
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
        raise APIError("invalid_request")
    try:
        payload = await request.json()
        check_payload_bounds(payload, 24000 if definition == "SocialActionRequest" else 8192)
        validate_payload(definition, payload)
    except (ValueError, UnicodeError, RecursionError, ContractValidationError):
        raise APIError("invalid_request") from None
    if payload.get("transport", "walking") != "walking":
        raise APIError("unsupported_transport")
    return payload


def has_synthetic(value):
    if isinstance(value, dict):
        if value.get("is_synthetic") is True or value.get("source_type") == "synthetic":
            return True
        if isinstance(value.get("id"), str) and value["id"].startswith("synthetic:"):
            return True
        return any(has_synthetic(child) for child in value.values())
    if isinstance(value, list):
        return any(has_synthetic(child) for child in value)
    return False


def checked(definition, payload, settings):
    try:
        validate_payload(definition, payload)
        if settings.mode == "live" and has_synthetic(payload):
            raise ValueError("Synthetic payload in live mode")
        return payload
    except (ContractValidationError, ValueError, KeyError, TypeError):
        raise APIError("provider_unavailable") from None


def create_app(settings=None, services=None):
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app):
        async with AsyncExitStack() as stack:
            progress = StartupProgress()
            progress.enter("traffic")
            app.state.traffic = TrafficService(os.getenv("TOMTOM_API_KEY", ""))
            stack.push_async_callback(app.state.traffic.aclose)
            progress.enter("map")
            app.state.map_features = create_map_service(enabled=settings.mode == "live" and os.getenv("ASTANA_MAP_LOOKUP_ENABLED", "false").lower() == "true")
            stack.push_async_callback(app.state.map_features.aclose)
            app.state.place_directory = TwoGisPlacesService(enabled=settings.mode == "live")
            stack.push_async_callback(app.state.place_directory.aclose)
            app.state.place_photos = WikimediaPlacePhotos()
            stack.push_async_callback(app.state.place_photos.aclose)
            app.state.services = services
            if app.state.services is None:
                try:
                    async with asyncio.timeout(settings.request_timeout_seconds):
                        app.state.services = await build_services(settings, stack, progress=progress)
                except Exception as error:
                    # Keep liveness available, readiness fails closed; never emit provider text.
                    # Do not pass the exception object, traceback, settings or raw env to logging.
                    logger.error(
                        "Service initialization failed: stage=%s exception=%s",
                        progress.stage, type(error).__name__, exc_info=False, stack_info=False,
                    )
                    app.state.services = None
            app.state.gate = asyncio.Semaphore(settings.max_concurrent_requests)
            app.state.feedback = deque(maxlen=settings.feedback_capacity)
            progress.enter("ready" if app.state.services is not None else "unavailable")
            yield

    app = FastAPI(title="Astana Compass API", version="0.1.0", lifespan=lifespan,
                  description="RAG walking assistant integration API. Fixture mode uses synthetic data only.")
    app.add_middleware(BoundaryMiddleware, settings=settings)
    app.add_middleware(CORSMiddleware, allow_origins=list(settings.cors_origins), allow_methods=["GET", "POST"],
                       allow_headers=["Content-Type"], expose_headers=["X-Request-ID", "X-Astana-Data-Mode"], allow_credentials=False)
    app.include_router(sandbox_router())
    app.add_exception_handler(SocialError, social_error_handler)

    @app.exception_handler(APIError)
    async def api_error(request, exc):
        if exc.code == "provider_unavailable":
            # The support number must identify the failure without logging the
            # wish, exact location, credentials or exception/provider contents.
            logger.warning(
                "API unavailable: request_id=%s route=%s reason=%s elapsed_ms=%d",
                request.state.request_id,
                getattr(request.scope.get("route"), "path", "unknown"),
                getattr(request.state, "failure_reason", "unavailable"),
                max(0, round((time.monotonic() - request.state.started_at) * 1000)),
            )
        return error_response(request.state.request_id, exc.code)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        return error_response(request.state.request_id, "invalid_request")

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        return error_response(request.state.request_id, "not_found" if exc.status_code == 404 else "invalid_request")

    @app.exception_handler(Exception)
    async def unexpected_error(request, exc):
        return error_response(getattr(request.state, "request_id", str(uuid.uuid4())), "internal_error")

    async def acquire_gate():
        try:
            async with asyncio.timeout(0.1):
                await app.state.gate.acquire()
        except TimeoutError:
            raise APIError("rate_limited") from None

    async def call(request, operation):
        if app.state.services is None:
            request.state.failure_reason = "not_ready"
            raise APIError("provider_unavailable")
        await acquire_gate()
        try:
            async with asyncio.timeout(settings.request_timeout_seconds):
                return await operation(app.state.services)
        except RecommenderError as exc:
            request.state.failure_reason = "recommender_error"
            raise APIError(exc.code if exc.code in STATUS else "provider_unavailable") from None
        except APIError:
            raise
        except TimeoutError:
            request.state.failure_reason = "deadline"
            raise APIError("provider_unavailable") from None
        except ContractValidationError:
            request.state.failure_reason = "invalid_dependency_response"
            raise APIError("provider_unavailable") from None
        except Exception:
            request.state.failure_reason = "dependency_error"
            raise APIError("provider_unavailable") from None
        finally:
            app.state.gate.release()

    app.state.social = SocialStore()
    app.include_router(social_router(app.state.social, read_payload, call, checked, settings))

    def health(ok):
        return {"status": "ok" if ok else "unavailable", "service": "astana-api", "version": "0.1.0", "checked_at": utcnow()}

    @app.get("/v1/health/live")
    async def live():
        return health(True)

    @app.get("/v1/health/ready")
    async def ready(request: Request):
        try:
            payload = await call(request, lambda s: s.repository.data_status())
            checked("DataStatusResponse", payload, settings)
            if settings.mode == "live":
                usable_sources = [source for source in payload["sources"] if source["status"] in {"ready", "stale"} and source["place_count"] > 0 and source["last_success_at"] is not None]
                if payload["total_places"] < 1 or not usable_sources:
                    raise APIError("provider_unavailable")
                sample = await call(request, lambda s: s.repository.list_places(limit=1))
                checked("PlaceListResponse", sample, settings)
                if not sample["places"]:
                    raise APIError("provider_unavailable")
            ok = True
        except APIError:
            ok = False
        return JSONResponse(health(ok), status_code=200 if ok else 503)

    @app.get("/v1/places")
    async def places(request: Request, bbox: str | None = Query(None, max_length=100),
                     query: str | None = Query(None, max_length=2000), categories: str | None = Query(None, max_length=500),
                     cursor: str | None = Query(None, max_length=512), limit: int = Query(50, ge=1, le=100)):
        parsed_bbox = None
        if bbox is not None:
            try:
                coordinates = tuple(float(x) for x in bbox.split(","))
                w, s, e, n = coordinates
                if not all(math.isfinite(v) for v in coordinates) or not (-180 <= w <= e <= 180 and -90 <= s <= n <= 90):
                    raise ValueError("Invalid bbox")
                parsed_bbox = coordinates
            except ValueError:
                raise APIError("invalid_request") from None
        parsed_categories = [x.strip() for x in categories.split(",") if x.strip()] if categories else None
        if parsed_categories and len(parsed_categories) > 20:
            raise APIError("invalid_request")
        if settings.mode == "fixture" and cursor is not None and (not cursor.isascii() or not cursor.isdecimal() or len(cursor) > 8):
            raise APIError("invalid_request")
        result = await call(request, lambda s: s.repository.list_places(bbox=parsed_bbox, query=query, categories=parsed_categories, cursor=cursor, limit=limit))
        return checked("PlaceListResponse", result, settings)

    @app.get("/v1/places/{place_id:path}")
    async def place(request: Request, place_id: str):
        if len(place_id) > 512:
            raise APIError("invalid_request")
        result = await call(request, lambda s: s.repository.get(place_id))
        if result is None:
            raise APIError("not_found")
        return checked("Place", result, settings)

    @app.post("/v1/recommendations")
    async def recommendations(request: Request):
        payload = await read_payload(request, "RecommendationRequest")
        result = await call(request, lambda s: s.recommender.recommend(payload))
        result = deepcopy(result)
        result["request_id"] = request.state.request_id
        return checked("RecommendationResponse", result, settings)

    @app.post("/v1/intent")
    async def intent(request: Request):
        payload = await read_payload(request, "IntentRequest")
        result = await call(request, lambda services: services.intent.analyze(payload["query"], payload["locale"]))
        return checked("IntentResponse", result, settings)

    @app.post("/v1/traffic")
    async def traffic(request: Request):
        payload = await read_payload(request, "TrafficRequest")
        await acquire_gate()
        try:
            async with asyncio.timeout(min(30, settings.request_timeout_seconds)):
                result = await app.state.traffic.sample(payload["points"])
        except TimeoutError:
            result = TrafficService.response("unavailable")
        finally:
            app.state.gate.release()
        return checked("TrafficResponse", result, settings)

    @app.post("/v1/itineraries")
    async def itineraries(request: Request):
        payload = await read_payload(request, "ItineraryRequest")
        result = await call(request, lambda s: s.recommender.build_itinerary(payload))
        result = deepcopy(result)
        result["request_id"] = request.state.request_id
        return checked("ItineraryResponse", result, settings)

    @app.post("/v1/map-features")
    async def map_features(request: Request):
        payload = await read_payload(request, "MapFeatureRequest")
        await acquire_gate()
        try:
            async with asyncio.timeout(min(15, settings.request_timeout_seconds)):
                result = await app.state.map_features.inspect(payload["location"], payload["locale"])
        except TimeoutError:
            raise APIError("provider_unavailable") from None
        except ProviderError as error:
            raise APIError(error.code if error.code in STATUS else "provider_unavailable") from None
        finally:
            app.state.gate.release()
        return checked("MapFeatureResponse", result, settings)

    @app.post("/v1/feedback", status_code=201)
    async def feedback(request: Request):
        payload = await read_payload(request, "FeedbackRequest")
        feedback_id = str(uuid.uuid4())
        # Bounded, volatile queue. No automatic training collection or persistent identity.
        app.state.feedback.append({"feedback_id": feedback_id, "request_id": payload["request_id"], "rating": payload["rating"], "comment": payload["comment"], "created_at": utcnow()})
        return {"feedback_id": feedback_id, "accepted": True}

    @app.post("/v1/place-directory")
    async def place_directory(request: Request):
        payload = await read_payload(request, "PlaceDirectoryRequest")
        # Only the canonical public catalog provides the search name/location.
        # The browser cannot submit credentials, arbitrary queries or coordinates.
        place = await call(request, lambda s: s.repository.get(payload["place_id"]))
        if place is None:
            raise APIError("not_found")
        place = checked("Place", place, settings)
        await acquire_gate()
        try:
            async with asyncio.timeout(min(8, settings.request_timeout_seconds)):
                result = await app.state.place_directory.search(place, payload["locale"])
        except TimeoutError:
            raise APIError("provider_unavailable") from None
        except ProviderError as error:
            raise APIError(error.code if error.code in STATUS else "provider_unavailable") from None
        finally:
            app.state.gate.release()
        # Directory data is returned for this view only. It never changes Place
        # facts, recommendations, stored groups, or model grounding.
        return checked("MapFeatureResponse", result, settings)

    @app.post("/v1/place-photo")
    async def place_photo(request: Request):
        payload = await read_payload(request, "PlacePhotoRequest")
        place = await call(request, lambda s: s.repository.get(payload["place_id"]))
        if place is None:
            raise APIError("not_found")
        place = checked("Place", place, settings)
        await acquire_gate()
        try:
            async with asyncio.timeout(min(8, settings.request_timeout_seconds)):
                result = await app.state.place_photos.photo(place, payload["locale"])
        except (TimeoutError, ProviderError):
            result = {"status": "unavailable", "photo": None}
        finally:
            app.state.gate.release()
        return checked("PlacePhotoResponse", result, settings)

    @app.get("/v1/data-status")
    async def data_status(request: Request):
        return checked("DataStatusResponse", await call(request, lambda s: s.repository.data_status()), settings)

    def openapi():
        if app.openapi_schema:
            return app.openapi_schema
        schema = get_openapi(title=app.title, version=app.version, description=app.description, routes=app.routes)
        # Project the canonical schema without maintaining parallel HTTP DTOs.
        definitions = json.loads(json.dumps(load_schema()["$defs"]).replace("#/$defs/", "#/components/schemas/"))
        schema.setdefault("components", {}).setdefault("schemas", {}).update(definitions)
        examples = request_examples()
        endpoints = {
            "/v1/health/live": ("get", None, "HealthResponse", "200"),
            "/v1/health/ready": ("get", None, "HealthResponse", "200"),
            "/v1/places": ("get", None, "PlaceListResponse", "200"),
            "/v1/places/{place_id}": ("get", None, "Place", "200"),
            "/v1/recommendations": ("post", "RecommendationRequest", "RecommendationResponse", "200"),
            "/v1/intent": ("post", "IntentRequest", "IntentResponse", "200"),
            "/v1/traffic": ("post", "TrafficRequest", "TrafficResponse", "200"),
            "/v1/map-features": ("post", "MapFeatureRequest", "MapFeatureResponse", "200"),
            "/v1/place-directory": ("post", "PlaceDirectoryRequest", "MapFeatureResponse", "200"),
            "/v1/place-photo": ("post", "PlacePhotoRequest", "PlacePhotoResponse", "200"),
            "/v1/social/session": ("post", "SocialSessionRequest", "SocialSessionResponse", "200"),
            "/v1/social/state": ("get", None, "SocialState", "200"),
            "/v1/social/events": ("get", None, "CommunityEvents", "200"),
            "/v1/social/action": ("post", "SocialActionRequest", "SocialActionResponse", "200"),
            "/v1/itineraries": ("post", "ItineraryRequest", "ItineraryResponse", "200"),
            "/v1/feedback": ("post", "FeedbackRequest", "FeedbackResponse", "201"),
            "/v1/data-status": ("get", None, "DataStatusResponse", "200"),
        }
        for path, (method, input_type, output_type, status) in endpoints.items():
            operation = schema["paths"][path][method]
            operation["responses"][status] = {"description": "Success", "content": {"application/json": {"schema": {"$ref": f"#/components/schemas/{output_type}"}}}}
            for code in [422, 429, 500, 503]:
                operation["responses"][str(code)] = {"description": "Error", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/ErrorResponse"}}}}
            if path.startswith("/v1/social/"):
                # Social domain errors intentionally contain only a safe code;
                # middleware/validation errors use the common request envelope.
                social_error = {"type": "object", "additionalProperties": False,
                                "properties": {"error": {"type": "object", "additionalProperties": False,
                                "properties": {"code": {"type": "string"}}, "required": ["code"]}}, "required": ["error"]}
                for code in [401, 403, 404, 409, 422, 429, 500, 503]:
                    operation["responses"][str(code)] = {"description": "Error", "content": {"application/json": {"schema": {"anyOf": [social_error, {"$ref": "#/components/schemas/ErrorResponse"}]}}}}
                if path not in {"/v1/social/session", "/v1/social/events"}:
                    operation["security"] = [{"GuestBearer": []}]
            if input_type:
                operation["requestBody"] = {"required": True, "content": {"application/json": {"schema": {"$ref": f"#/components/schemas/{input_type}"}, "examples": examples.get(input_type, {})}}}
        schema["paths"]["/v1/health/ready"]["get"]["responses"]["503"] = {"description": "Unavailable", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/HealthResponse"}}}}
        schema["paths"]["/v1/places/{place_id}"]["get"]["responses"]["404"] = {"description": "Not found", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/ErrorResponse"}}}}
        schema["paths"]["/v1/place-directory"]["post"]["responses"]["404"] = {"description": "Catalog place not found", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/ErrorResponse"}}}}
        schema["components"].setdefault("securitySchemes", {})["GuestBearer"] = {"type": "http", "scheme": "bearer", "description": "Temporary guest session token. The web proxy keeps it in an HttpOnly cookie."}
        schema["paths"]["/v1/place-photo"]["post"]["responses"]["404"] = {"description": "Catalog place not found", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/ErrorResponse"}}}}
        app.openapi_schema = schema
        return schema

    app.openapi = openapi
    return app
