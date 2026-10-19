from copy import deepcopy
from html.parser import HTMLParser
from importlib import import_module

from fastapi.testclient import TestClient
import pytest

from astana_api import create_app
from astana_api.demo_examples import request_examples
from astana_api.settings import Settings
from astana_contracts import validate_payload


class AssetParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.assets = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        assert not any(key.startswith("on") or key == "style" for key in attributes)
        if tag == "script":
            assert attributes.get("src"), "Inline scripts are blocked by the sandbox CSP"
            self.assets.append(attributes["src"])
        if tag == "link" and attributes.get("rel") == "stylesheet":
            self.assets.append(attributes["href"])


def test_packaged_sandbox_and_its_assets():
    with TestClient(create_app(Settings())) as client:
        redirect = client.get("/", follow_redirects=False)
        assert redirect.status_code == 307 and redirect.headers["location"] == "/sandbox"
        response = client.get("/sandbox")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/html")
        assert response.headers["x-astana-data-mode"] == "fixture"
        assert "default-src 'none'" in response.headers["content-security-policy"]
        assert "'unsafe-inline'" not in response.headers["content-security-policy"]
        assert response.headers["referrer-policy"] == "no-referrer"
        parser = AssetParser()
        parser.feed(response.text)
        assert set(parser.assets) == {"/sandbox-assets/sandbox.js", "/sandbox-assets/sandbox.css"}
        for asset in parser.assets:
            result = client.get(asset)
            assert result.status_code == 200 and result.content
            assert result.headers["x-content-type-options"] == "nosniff"
        for forbidden in ["app.py", "sandbox.html", "../app.py", "%2e%2e%2fapp.py"]:
            assert client.get(f"/sandbox-assets/{forbidden}").status_code == 404
        assert "content-security-policy" not in client.get("/docs").headers
        assert "/sandbox" not in client.get("/openapi.json").json()["paths"]


def test_openapi_examples_validate_and_execute():
    with TestClient(create_app(Settings())) as client:
        schema = client.get("/openapi.json").json()
        for path, definition in [("/v1/recommendations", "RecommendationRequest"), ("/v1/itineraries", "ItineraryRequest"), ("/v1/feedback", "FeedbackRequest")]:
            examples = schema["paths"][path]["post"]["requestBody"]["content"]["application/json"]["examples"]
            for name, example in examples.items():
                payload = example["value"]
                validate_payload(definition, payload)
                result = client.post(path, json=payload)
                expected = 422 if name == "unsupported_transport" else 201 if path.endswith("feedback") else 200
                assert result.status_code == expected, (name, result.text)
                if name == "unknown_required":
                    assert result.json()["status"] == "no_match"
                elif name == "short_budget":
                    assert result.json()["status"] == "partial"
                    assert result.json()["recommendations"]
                    assert all(item["total_duration_seconds"] > payload["available_seconds"]
                               for item in result.json()["recommendations"])
                elif name == "indoor":
                    assert len(result.json()["recommendations"]) == 2
                elif name == "two_stops":
                    assert [stop["place_id"] for stop in result.json()["stops"]] == payload["place_ids"]


@pytest.mark.parametrize("change", [
    {"constraints": [{"key": "tags", "value": [0] * 10000, "strength": "preferred"}]},
    {"constraints": [{"key": "indoor", "value": True, "strength": "preferred"}] * 21},
    {"query": "x" * 2001},
    {"constraints": [{"key": "label", "value": "x" * 8193, "strength": "preferred"}]},
])
def test_unbounded_inputs_rejected_before_schema_work(monkeypatch, change):
    payload = deepcopy(request_examples()["RecommendationRequest"]["indoor"]["value"])
    payload.update(change)
    with TestClient(create_app(Settings())) as client:
        def unexpected_validation(*args, **kwargs):
            pytest.fail("An oversized request reached synchronous JSON Schema validation")
        monkeypatch.setattr(import_module("astana_api.app"), "validate_payload", unexpected_validation)
        result = client.post("/v1/recommendations", json=payload)
        assert result.status_code == 422
        assert result.json()["error"]["code"] == "invalid_request"


def test_preflight_accepts_normal_array_predicate():
    payload = request_examples()["RecommendationRequest"]["indoor"]["value"]
    payload["constraints"].append({"key": "tags", "value": ["museum", "art"], "strength": "preferred"})
    with TestClient(create_app(Settings())) as client:
        result = client.post("/v1/recommendations", json=payload)
        assert result.status_code == 200
        validate_payload("RecommendationResponse", result.json())
