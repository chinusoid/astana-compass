#!/usr/bin/env python3
"""Exercise the running fixture API using synthetic inputs and standard-library HTTP."""
from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import math
import sys
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_RESPONSE_BYTES = 2 * 1024 * 1024


class SmokeFailure(Exception):
    """Fixed safe diagnostics only: never include response bodies or provider errors."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


def reject_nonfinite(_value: str) -> None:
    raise ValueError("Nonfinite JSON number")


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def normalized_base_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        valid = (parsed.scheme in {"http", "https"} and parsed.hostname
                 and parsed.username is None and parsed.password is None
                 and not parsed.query and not parsed.fragment and parsed.port != 0)
        if not valid:
            raise ValueError
    except ValueError:
        raise argparse.ArgumentTypeError("Use an HTTP(S) base URL without credentials, query or fragment.") from None
    return value.rstrip("/")


def timeout_seconds(value: str) -> float:
    try:
        number = float(value)
        if not math.isfinite(number) or not 0 < number <= 120:
            raise ValueError
        return number
    except ValueError:
        raise argparse.ArgumentTypeError("Timeout must be a finite number between 0 and 120 seconds.") from None


def optional_validator() -> Callable | None:
    if importlib.util.find_spec("astana_contracts") is None:
        return None
    try:
        from astana_contracts import validate_payload
        return validate_payload
    except Exception:
        raise SmokeFailure("Installed contract validator could not be loaded.") from None


class Client:
    def __init__(self, base_url: str, timeout: float = 10, validator: Callable | None = None):
        self.base_url, self.timeout, self.validator = base_url, timeout, validator
        self.opener = build_opener(NoRedirects())

    def request(self, path: str, *, payload: dict | None = None,
                status: int = 200, definition: str | None = None) -> dict:
        data = None if payload is None else json.dumps(payload, allow_nan=False).encode("utf-8")
        headers = {"Accept": "application/json"}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        request = Request(self.base_url + path, data=data, headers=headers,
                          method="GET" if payload is None else "POST")
        try:
            try:
                response = self.opener.open(request, timeout=self.timeout)
            except HTTPError as error:
                response = error
            with response:
                actual_status = response.code
                require(actual_status == status, f"Expected HTTP {status}, received HTTP {actual_status}.")
                require(response.headers.get("X-Astana-Data-Mode") == "fixture",
                        "Fixture mode required; start the API with ASTANA_MODE=fixture.")
                body = response.read(MAX_RESPONSE_BYTES + 1)
        except SmokeFailure:
            raise
        except (URLError, OSError, TimeoutError, ValueError):
            raise SmokeFailure("HTTP connection failed or timed out.") from None
        require(len(body) <= MAX_RESPONSE_BYTES, "Response exceeds the smoke-test size limit.")
        try:
            result = json.loads(body, parse_constant=reject_nonfinite)
        except (ValueError, UnicodeError, RecursionError):
            raise SmokeFailure("Response is not valid finite JSON.") from None
        require(isinstance(result, dict), "Response must be a JSON object.")
        if self.validator is not None and definition is not None:
            try:
                self.validator(definition, result)
            except Exception:
                raise SmokeFailure(f"Response violates the {definition} contract.") from None
        return result


def request_template() -> dict:
    return {
        "query": "SYNTHETIC smoke: помещение для тестовой прогулки; это не реальный запрос.",
        "locale": "ru", "origin": {"lat": 51.089, "lon": 71.419},
        "start_at": datetime.now(timezone(timedelta(hours=5))).isoformat(timespec="seconds"),
        "timezone": "Asia/Almaty", "available_seconds": 7200,
        "transport": "walking", "return_to_origin": True,
        "constraints": [{"key": "indoor", "value": True, "strength": "required"}], "limit": 3,
    }


def known_indoor(place: dict) -> bool:
    return any(fact.get("key") == "indoor" and fact.get("status") == "known"
               and fact.get("value") is True for fact in place.get("facts", []))


def checked_route(route: dict, request: dict) -> None:
    require(route.get("transport") == "walking", "Route changed the requested transport.")
    require(route.get("includes_return") is request["return_to_origin"], "Return leg is not accounted for.")
    require(route.get("method") == "approximate" and route.get("geometry") is None,
            "Fixture route must be explicitly approximate and have no invented geometry.")
    require(bool(route.get("assumptions")), "Approximate route must explain its assumptions.")
    require(type(route.get("duration_seconds")) is int and route["duration_seconds"] >= 0,
            "Travel duration must be nonnegative integer seconds.")
    require(bool(route.get("evidence")) and all(item.get("is_synthetic") is True for item in route["evidence"]),
            "Fixture route must retain synthetic evidence markers.")


def check_selected_itinerary(result: dict, request: dict) -> None:
    require(result.get("status") in {"matched", "partial"}, "Selected fixture itinerary was not built.")
    require(result.get("request") == request, "Itinerary response changed the submitted request.")
    stops = result.get("stops", [])
    require([stop.get("place_id") for stop in stops] == request["place_ids"],
            "Itinerary changed the selected places or their order.")
    require([stop.get("order") for stop in stops] == list(range(1, len(stops) + 1)),
            "Itinerary stop numbers are not contiguous.")
    checked_route(result.get("route", {}), request)
    require(all(type(stop.get("visit_duration_seconds")) is int and stop["visit_duration_seconds"] > 0 for stop in stops),
            "Visit durations must be positive integer seconds.")
    expected = result["route"]["duration_seconds"] + sum(stop["visit_duration_seconds"] for stop in stops)
    require(result.get("total_duration_seconds") == expected,
            "Itinerary omitted travel/visits.")
    require({p.get("id") for p in result.get("places", [])} == set(request["place_ids"]),
            "Itinerary place references do not resolve to selected places.")


def run_smoke(client: Client) -> int:
    request = request_template()
    catalog: list[dict] = []

    def health(path: str) -> None:
        result = client.request(path, definition="HealthResponse")
        require(result.get("status") == "ok", "Health endpoint did not report ready/ok.")

    def check_catalog() -> None:
        result = client.request("/v1/places", definition="PlaceListResponse")
        places = result.get("places", [])
        require(len(places) == 3 and result.get("next_cursor") is None,
                "Expected the complete three-place fixture catalog.")
        require(len({p.get("id") for p in places}) == 3, "Catalog place IDs are not unique.")
        require(all(p.get("is_synthetic") is True and str(p.get("id", "")).startswith("synthetic:") for p in places),
                "Catalog contains an unmarked or nonsynthetic place.")
        require(sum(known_indoor(p) for p in places) == 2, "Expected two verified indoor fixtures.")
        catalog.extend(places)

    def indoor_recommendations() -> None:
        result = client.request("/v1/recommendations", payload=request, definition="RecommendationResponse")
        require(result.get("status") in {"matched", "partial"}, "Indoor request returned no usable recommendations.")
        require(result.get("request") == request, "Recommendation response changed the submitted request.")
        recommendations = result.get("recommendations", [])
        require(1 <= len(recommendations) <= request["limit"], "Recommendation count is outside the requested limit.")
        places = {p["id"]: p for p in result.get("places", [])}
        for recommendation in recommendations:
            place = places.get(recommendation.get("place_id"), {})
            require(known_indoor(place), "An indoor-required result lacks a known true indoor fact.")
            evaluations = recommendation.get("constraint_evaluations", [])
            require(any(e.get("key") == "indoor" and e.get("strength") == "required"
                        and e.get("outcome") == "satisfied" for e in evaluations),
                    "Required indoor constraint is not explicitly satisfied.")
            checked_route(recommendation.get("route", {}), request)
            visit = recommendation.get("visit_duration_seconds")
            require(type(visit) is int and visit > 0, "Visit duration must be positive integer seconds.")
            total = visit + recommendation["route"]["duration_seconds"]
            require(recommendation.get("total_duration_seconds") == total,
                    "Recommendation omitted travel/visit time.")

    def unknown_required() -> None:
        payload = deepcopy(request)
        payload["constraints"] = [{"key": "wheelchair_accessible", "value": True, "strength": "required"}]
        result = client.request("/v1/recommendations", payload=payload, definition="RecommendationResponse")
        require(result.get("status") == "no_match" and result.get("places") == []
                and result.get("recommendations") == [], "Unknown required fact was incorrectly treated as satisfied.")
        require(bool(result.get("warnings")), "No-match response must explain the limitation.")

    def expected_error(payload: dict, error_code: str) -> None:
        result = client.request("/v1/recommendations", payload=payload, status=422, definition="ErrorResponse")
        require(result.get("error", {}).get("code") == error_code, "Unexpected structured API error code.")
        require(result.get("error", {}).get("retryable") is False, "Invalid/unsupported input must not be retryable.")

    def cycling() -> None:
        payload = deepcopy(request)
        payload["transport"] = "cycling"
        expected_error(payload, "unsupported_transport")

    def invalid_coordinates() -> None:
        payload = deepcopy(request)
        payload["origin"]["lat"] = 91
        expected_error(payload, "invalid_request")

    def selected_itinerary() -> None:
        payload = deepcopy(request)
        # Deliberately reverse catalog order, so a silently re-sorted trip fails.
        payload["place_ids"] = [p["id"] for p in reversed(catalog) if known_indoor(p)]
        require(len(payload["place_ids"]) == 2, "Two indoor fixture selections are required for this check.")
        result = client.request("/v1/itineraries", payload=payload, definition="ItineraryResponse")
        check_selected_itinerary(result, payload)

    checks = [
        ("liveness", lambda: health("/v1/health/live")),
        ("readiness", lambda: health("/v1/health/ready")),
        ("three synthetic places", check_catalog),
        ("indoor recommendations + budget", indoor_recommendations),
        ("unknown required fact -> no_match", unknown_required),
        ("cycling -> HTTP 422", cycling),
        ("invalid coordinates -> HTTP 422", invalid_coordinates),
        ("selected itinerary: order + return + budget", selected_itinerary),
    ]
    for index, (name, check) in enumerate(checks):
        try:
            check()
        except SmokeFailure as error:
            print(f"FAIL {name}: {error}")
            print(f"FAIL smoke ({index}/{len(checks)} checks passed)")
            return 1
        except Exception:
            print(f"FAIL {name}: unexpected response structure or local validation failure.")
            print(f"FAIL smoke ({index}/{len(checks)} checks passed)")
            return 1
        print(f"PASS {name}")
    print(f"PASS smoke ({len(checks)}/{len(checks)} checks; synthetic fixtures only)")
    return 0


def self_test() -> int:
    """Test HTTP failure handling with a short-lived, in-process local server."""
    from contextlib import redirect_stdout
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from io import StringIO
    import threading
    import unittest
    from unittest.mock import patch

    private = "SYNTHETIC_SECRET_MUST_NOT_APPEAR_IN_DIAGNOSTICS"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            status = 422 if self.path == "/error" else 503 if self.path == "/v1/health/live" else 200
            body = b"invalid JSON" if self.path == "/malformed" else json.dumps({"error": {"code": "invalid_request", "message": private}}).encode()
            self.send_response(status)
            self.send_header("X-Astana-Data-Mode", "live" if self.path == "/live-mode" else "fixture")
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        client = Client(base, timeout=2)

        class Checks(unittest.TestCase):
            def test_expected_422_is_read_as_json(self):
                self.assertEqual(client.request("/error", status=422)["error"]["code"], "invalid_request")

            def test_unexpected_status_does_not_leak_body(self):
                with self.assertRaises(SmokeFailure) as caught:
                    client.request("/error")
                self.assertNotIn(private, str(caught.exception))
                self.assertIn("422", str(caught.exception))

            def test_malformed_json_fails(self):
                with self.assertRaises(SmokeFailure):
                    client.request("/malformed")

            def test_live_mode_is_not_mistaken_for_fixture(self):
                with self.assertRaises(SmokeFailure):
                    client.request("/live-mode")

            def test_connection_failure_is_safe(self):
                with patch.object(client.opener, "open", side_effect=URLError(private)):
                    with self.assertRaises(SmokeFailure) as caught:
                        client.request("/error")
                self.assertNotIn(private, str(caught.exception))

            def test_cli_failure_exits_one_without_traceback(self):
                output = StringIO()
                with redirect_stdout(output):
                    code = main(["--base-url", base])
                self.assertEqual(code, 1)
                self.assertIn("FAIL", output.getvalue())
                self.assertNotIn("Traceback", output.getvalue())
                self.assertNotIn(private, output.getvalue())

        try:
            result = unittest.TestResult()
            unittest.defaultTestLoader.loadTestsFromTestCase(Checks).run(result)
        finally:
            server.shutdown()
            thread.join(timeout=3)
    success = result.wasSuccessful()
    print(f"{'PASS' if success else 'FAIL'} self-test ({result.testsRun} local HTTP cases)")
    return 0 if success else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", type=normalized_base_url, default="http://127.0.0.1:8000")
    parser.add_argument("--timeout", type=timeout_seconds, default=10.0, help="HTTP timeout in seconds (default: 10)")
    parser.add_argument("--self-test", action="store_true", help="Check the CLI against temporary local HTTP stubs")
    args = parser.parse_args(argv)
    try:
        if args.self_test:
            return self_test()
        validator = optional_validator()
        print("INFO canonical schema + invariant validation enabled" if validator
              else "INFO astana_contracts unavailable; independent behavior checks still run")
        return run_smoke(Client(args.base_url, args.timeout, validator))
    except SmokeFailure as error:
        print(f"FAIL smoke: {error}")
        return 1
    except KeyboardInterrupt:
        print("FAIL smoke: interrupted")
        return 1
    except Exception:
        print("FAIL smoke: local test setup failed; no response or exception details were printed.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
