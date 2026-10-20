"""Diagnostic paths and rule identifiers must never reveal provider payloads."""
import logging
from astana_api.contract_diagnostics import diagnostic
from astana_contracts import ContractValidationError
from fastapi.testclient import TestClient
from astana_api import create_app
from astana_api.settings import Settings


def test_contract_diagnostic_preserves_canonical_boundary_without_payload():
    error = ContractValidationError(definition="RecommendationResponse", code="contract_schema_violation",
        message="a provider secret", path=("recommendations", 0, "why", "private-user-key"))
    result = diagnostic(error)
    assert result == {"definition": "RecommendationResponse", "code": "contract_schema_violation",
        "stage": "schema", "path": "recommendations.0.why.other", "rule": "other"}
    assert "secret" not in str(result) and "private" not in str(result)


def test_contract_diagnostic_rejects_adapter_controlled_metadata():
    error = ContractValidationError(definition="private-definition", code="private-code",
        message="private-message", path=("private-field", -1, 99999999), stage="private-stage")
    result = diagnostic(error)
    assert result == {"definition": "other", "code": "other", "stage": "other",
        "path": "other.other.other", "rule": "other"}


def test_dependency_contract_failure_logs_safe_boundary_and_keeps_public_error(caplog):
    class BrokenRecommendations:
        async def recommend(self, request):
            raise ContractValidationError(definition="RecommendationResponse", code="contract_schema_violation",
                message="private-model-output", path=("recommendations", 0, "why", "private-field"))
    with TestClient(create_app(Settings())) as client:
        client.app.state.services.recommender = BrokenRecommendations()
        from importlib.resources import files
        import json
        cases=json.loads(files("astana_contracts").joinpath("data/contracts.examples.json").read_text())["cases"]
        payload=next(case["instance"] for case in cases if case["name"]=="request_valid")
        with caplog.at_level(logging.WARNING, logger="astana_api.app"):
            response=client.post("/v1/recommendations",json=payload)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "provider_unavailable"
    assert response.json()["request_id"] in caplog.text
    assert "path=recommendations.0.why.other" in caplog.text
    assert "private-" not in caplog.text and "private-" not in response.text
