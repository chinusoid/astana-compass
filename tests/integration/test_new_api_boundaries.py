"""Regression coverage for UTF-8 input, social schemas and managed AI cleanup."""
import asyncio
from contextlib import AsyncExitStack
import json

from fastapi.testclient import TestClient
import pytest

from astana_api import create_app
from astana_api.composition import build_services
from astana_api.settings import Settings
from astana_contracts import validate_payload


@pytest.mark.parametrize("path,payload", [
    ("/v1/intent", {"query":"тихо\ud800", "locale":"ru"}),
    ("/v1/social/session", {"name":"Guest\udfff"}),
])
def test_lone_surrogate_cannot_reach_utf8_response_serialization(path,payload):
    with TestClient(create_app(Settings())) as client:
        response = client.post(path, content=json.dumps(payload), headers={"Content-Type":"application/json"})
        assert response.status_code == 422
        validate_payload("ErrorResponse", response.json())


def test_valid_unicode_name_still_roundtrips():
    with TestClient(create_app(Settings())) as client:
        response = client.post("/v1/social/session", json={"name":"Қонақ 🌇"})
        assert response.status_code == 200
        validate_payload("SocialSessionResponse", response.json())
        assert response.json()["state"]["profile"]["name"] == "Қонақ 🌇"


def test_openapi_projects_social_inputs_outputs_and_actual_error_shapes():
    with TestClient(create_app(Settings())) as client:
        schema = client.get("/openapi.json").json()
        expected = [
            ("session","post","SocialSessionRequest","SocialSessionResponse"),
            ("state","get",None,"SocialState"),
            ("events","get",None,"CommunityEvents"),
            ("action","post","SocialActionRequest","SocialActionResponse"),
        ]
        for path,method,request,response in expected:
            operation = schema["paths"][f"/v1/social/{path}"][method]
            assert operation["responses"]["200"]["content"]["application/json"]["schema"] == {"$ref":f"#/components/schemas/{response}"}
            if request:
                assert operation["requestBody"]["content"]["application/json"]["schema"] == {"$ref":f"#/components/schemas/{request}"}
            assert "anyOf" in operation["responses"]["422"]["content"]["application/json"]["schema"]
        assert schema["paths"]["/v1/social/state"]["get"]["security"] == [{"GuestBearer":[]}]
        assert schema["components"]["securitySchemes"]["GuestBearer"]["scheme"] == "bearer"
        session = client.post("/v1/social/session",json={"name":"Guest"}).json()
        validate_payload("SocialSessionResponse",session)
        logged_out = client.post("/v1/social/action",json={"action":"logout"},headers={"Authorization":f'Bearer {session["token"]}'})
        validate_payload("SocialActionResponse",logged_out.json())
        assert logged_out.json() == {"signed_out":True}


def test_composition_closes_intent_on_lifespan_exit_without_calling_provider(monkeypatch):
    from astana_ai_providers import intents
    closed = []
    class Analyzer:
        async def analyze(self, query, locale):
            raise AssertionError("composition must not probe provider")
        async def aclose(self):
            closed.append(True)
    monkeypatch.setattr(intents,"create_intent_analyzer",lambda **_:Analyzer())
    async def check():
        async with AsyncExitStack() as stack:
            services = await build_services(Settings(),stack)
            assert isinstance(services.intent,Analyzer) and closed == []
        assert closed == [True]
    asyncio.run(check())
