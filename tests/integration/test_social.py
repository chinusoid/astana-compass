from copy import deepcopy
from datetime import datetime, timedelta, timezone
import base64
import asyncio
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from importlib import import_module

from fastapi.testclient import TestClient
import pytest

from astana_api import create_app
from astana_api.settings import Settings
from astana_api.social import SocialStore, SocialError
from astana_api.composition import Services
from astana_api.fixtures import FixtureContext, FixtureRepository, FixtureRetriever
from astana_contracts import validate_payload
from astana_contracts.validation import load_examples
from astana_recommender import DefaultRecommendationService

# Synthetic 1x1 RGB JPEG, generated without metadata; no image dependency at test time.
PHOTO = "data:image/jpeg;base64," + (
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAFA3PEY8MlBGQUZaVVBfeMiCeG5uePWvuZHI"
    "////////////////////////////////////////////////////2wBDAVVaWnhpeOuCguv"
    "/////////////////////////////////////////////////////////////////////////"
    "wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAP/xAAUEAEAAAAAAAAAAAAA"
    "AAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAL/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIR"
    "AxEAPwCIAh//2Q=="
)


@pytest.fixture
def client():
    with TestClient(create_app(Settings())) as client:
        yield client


def session(client, name):
    response = client.post("/v1/social/session", json={"name": name})
    assert response.status_code == 200, response.text
    data = response.json()
    validate_payload("SocialState", data["state"])
    return {"Authorization": "Bearer " + data["token"]}, data["state"]


def action(client, headers, action, **values):
    return client.post("/v1/social/action", headers=headers, json={"action": action, **values})


def party_pair(client):
    first, a = session(client, "A")
    second, b = session(client, "B")
    assert action(client, first, "friend_request", code=b["friend_code"]).status_code == 200
    assert action(client, second, "friend_accept", profile_id=a["profile"]["id"]).status_code == 200
    room = action(client, first, "party_create", name="Walk").json()["parties"][0]
    assert action(client, first, "party_invite", party_id=room["id"], profile_id=b["profile"]["id"]).status_code == 200
    joined = action(client, second, "party_join", party_id=room["id"])
    assert joined.status_code == 200, joined.text
    return first, second, joined.json()["parties"][0]


def recommendation_request():
    return deepcopy(next(case["instance"] for case in load_examples()["cases"] if case["name"] == "request_valid"))


def test_friend_and_party_require_recipient_acceptance_and_authentication(client):
    first, a = session(client, "Alice")
    second, b = session(client, "Bob")
    assert client.get("/v1/social/state").status_code == 401
    room = action(client, first, "party_create", name="Group").json()["parties"][0]
    assert action(client, first, "party_invite", party_id=room["id"], profile_id=b["profile"]["id"]).status_code == 404
    assert action(client, second, "party_join", party_id=room["id"]).status_code == 404
    action(client, first, "friend_request", code=b["friend_code"])
    pending = client.get("/v1/social/state", headers=second).json()
    assert pending["friends"] == []
    assert pending["friend_requests"] == [a["profile"]]
    action(client, second, "friend_accept", profile_id=a["profile"]["id"])
    action(client, first, "party_invite", party_id=room["id"], profile_id=b["profile"]["id"])
    assert client.get("/v1/social/state", headers=second).json()["parties"] == []
    assert action(client, second, "party_join", party_id=room["id"]).status_code == 200
    outsider, _ = session(client, "Outsider")
    assert action(client, outsider, "message", party_id=room["id"], text="not allowed", photo=None).status_code == 404
    assert client.get("/v1/social/state", headers=outsider).json()["parties"] == []


def test_group_uses_smallest_budget_and_every_members_required_constraints(client):
    first, second, room = party_pair(client)
    changed = action(client, second, "preferences", party_id=room["id"], available_seconds=1800,
                     constraints=[{"key": "wheelchair_accessible", "value": True, "strength": "required"}]).json()
    room = changed["parties"][0]
    request = recommendation_request()
    request["available_seconds"] = 7200
    request["constraints"] = [{"key": "wheelchair_accessible", "value": True, "strength": "preferred"}]
    result = action(client, first, "recommend", party_id=room["id"], revision=room["revision"], request=request)
    assert result.status_code == 200, result.text
    shared = result.json()["parties"][0]
    assert shared["recommendations"]["status"] == "no_match"
    merged = shared["recommendations"]["request"]
    assert merged["available_seconds"] == 1800
    assert merged["constraints"] == [{"key": "wheelchair_accessible", "value": True, "strength": "required"}]
    assert client.get("/v1/social/state", headers=second).json()["parties"][0] == shared
    assert action(client, first, "recommend", party_id=room["id"], revision=room["revision"], request=request).status_code == 409


def test_shared_itinerary_keeps_stop_order_and_invalidates_when_a_member_changes_needs(client):
    first, second, room = party_pair(client)
    request = recommendation_request()
    request["constraints"] = []
    request["available_seconds"] = 7200
    recommended = action(client, first, "recommend", party_id=room["id"], revision=room["revision"], request=request).json()["parties"][0]
    ids = [item["place_id"] for item in recommended["recommendations"]["recommendations"]][:2]
    assert ids
    request["place_ids"] = ids
    response = action(client, second, "itinerary", party_id=room["id"], revision=recommended["revision"], request=request)
    assert response.status_code == 200, response.text
    itinerary = response.json()["parties"][0]["itinerary"]
    validate_payload("ItineraryResponse", itinerary)
    assert [stop["place_id"] for stop in itinerary["stops"]] == ids
    assert client.get("/v1/social/state", headers=first).json()["parties"][0]["itinerary"] == itinerary
    changed = action(client, first, "preferences", party_id=room["id"], available_seconds=60, constraints=[]).json()
    assert changed["parties"][0]["itinerary"] is None
    assert changed["parties"][0]["recommendations"] is None


def test_chat_location_and_departure_are_private_and_deletable(client):
    first, second, room = party_pair(client)
    assert action(client, first, "message", party_id=room["id"], text="Meet near the entrance", photo=None).status_code == 200
    shared = action(client, first, "location", party_id=room["id"], coordinates={"lat": 51.1, "lon": 71.4}).json()["parties"][0]
    assert shared["revision"] == room["revision"]  # Messages never invalidate plans.
    assert len(shared["locations"]) == 1
    assert client.get("/v1/social/state", headers=second).json()["parties"][0]["messages"] == shared["messages"]
    action(client, first, "location", party_id=room["id"], coordinates=None)
    assert client.get("/v1/social/state", headers=second).json()["parties"][0]["locations"] == []
    action(client, first, "party_leave", party_id=room["id"])
    after = client.get("/v1/social/state", headers=second).json()["parties"][0]
    assert after["owner_id"] != room["owner_id"]
    assert after["messages"] == []


def test_photos_reject_active_formats_and_exif(client):
    first, _, room = party_pair(client)
    for photo in ["data:image/svg+xml;base64,PHN2Zz4=", "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xff\xe1GPS\xff\xd9").decode()]:
        assert action(client, first, "message", party_id=room["id"], text="photo", photo=photo).status_code == 422


def test_events_public_with_provenance_expiry_and_author_only_delete(client):
    first, a = session(client, "Author")
    second, _ = session(client, "Other")
    now = datetime.now(timezone.utc)
    event = {"title": "Community art walk", "description": "Meet at the public entrance", "location": {"lat": 51.1, "lon": 71.4},
             "starts_at": now.isoformat(), "ends_at": (now + timedelta(hours=1)).isoformat()}
    assert action(client, first, "event_create", **event).status_code == 200
    public = client.get("/v1/social/events").json()
    validate_payload("CommunityEvents", public)
    posted = public["events"][0]
    assert posted["is_verified"] is False and posted["author"] == a["profile"]
    assert action(client, second, "event_delete", event_id=posted["id"]).status_code == 404
    assert action(client, first, "event_delete", event_id=posted["id"]).status_code == 200
    assert client.get("/v1/social/events").json()["events"] == []
    event["ends_at"] = (now - timedelta(hours=1)).isoformat()
    assert action(client, first, "event_create", **event).status_code == 422


def test_guest_and_location_expiry_and_bounded_capacity():
    now = [0.0]
    store = SocialStore(clock=lambda: now[0], capacity=2)
    before = datetime.now(timezone.utc)
    token, a = store.create("A")
    after = datetime.now(timezone.utc)
    expires_at = store.state(a)["expires_at"]
    assert before + timedelta(days=7) <= datetime.fromisoformat(expires_at) <= after + timedelta(days=7)
    assert store.profiles[a]["deadline"] == 7 * 86400
    _, b = store.create("B")
    with pytest.raises(SocialError):
        store.create("C")
    store.act(a, {"action": "party_create", "name": "Walk"})
    room = store.state(a)["parties"][0]
    store.act(a, {"action": "location", "party_id": room["id"], "coordinates": {"lat": 51, "lon": 71}})
    now[0] = 901
    store.prune()
    assert store.state(a)["parties"][0]["locations"] == []
    now[0] = 86400
    assert store.authenticate(token) == a
    assert store.profiles and store.tokens
    assert store.state(a)["parties"] == []  # Rooms still expire after one day.
    now[0] = 7 * 86400 - 1
    assert store.authenticate(token) == a
    # An action near expiry cannot slide the account's original deadline.
    store.act(a, {"action": "party_create", "name": "Last walk"})
    assert store.state(a)["expires_at"] == expires_at
    now[0] = 7 * 86400
    with pytest.raises(SocialError) as expired:
        store.authenticate(token)
    assert (expired.value.code, expired.value.status) == ("session_required", 401)
    assert not store.profiles and not store.parties and not store.tokens


def test_guest_logout_stays_revoked_through_the_new_week_long_lifetime():
    now = [0.0]
    store = SocialStore(clock=lambda: now[0])
    token, profile_id = store.create("Guest")
    now[0] = 2 * 86400
    assert store.authenticate(token) == profile_id
    store.act(profile_id, {"action": "logout"})
    replacement, replacement_id = store.create("Guest")
    for moment in (now[0], 7 * 86400 - 1):
        now[0] = moment
        with pytest.raises(SocialError) as revoked:
            store.authenticate(token)
        assert (revoked.value.code, revoked.value.status) == ("session_required", 401)
        assert store.authenticate(replacement) == replacement_id
    assert profile_id not in store.profiles


def test_non_ascii_friend_code_is_a_regular_not_found_response(client):
    headers, _ = session(client, "Guest")
    response = action(client, headers, "friend_request", code="Қате код")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "friend_unavailable"


def test_removing_friendship_from_either_side_revokes_pending_party_consent(client):
    first, a = session(client, "A")
    second, b = session(client, "B")
    action(client, first, "friend_request", code=b["friend_code"])
    action(client, second, "friend_accept", profile_id=a["profile"]["id"])
    room = action(client, first, "party_create", name="Walk").json()["parties"][0]
    action(client, first, "party_invite", party_id=room["id"], profile_id=b["profile"]["id"])
    removed = action(client, second, "friend_remove", profile_id=a["profile"]["id"])
    assert removed.status_code == 200
    assert removed.json()["party_invites"] == []
    assert action(client, second, "party_join", party_id=room["id"]).status_code == 404


def test_owner_departure_revokes_invitations_issued_under_previous_owner(client):
    first, second, room = party_pair(client)
    third, c = session(client, "C")
    a = client.get("/v1/social/state", headers=first).json()
    action(client, first, "friend_request", code=c["friend_code"])
    action(client, third, "friend_accept", profile_id=a["profile"]["id"])
    action(client, first, "party_invite", party_id=room["id"], profile_id=c["profile"]["id"])
    action(client, first, "party_leave", party_id=room["id"])
    assert client.get("/v1/social/state", headers=second).json()["parties"][0]["owner_id"] != a["profile"]["id"]
    assert client.get("/v1/social/state", headers=third).json()["party_invites"] == []
    assert action(client, third, "party_join", party_id=room["id"]).status_code == 404


def test_room_expires_after_24_hours_even_when_a_newer_member_remains():
    now = [0.0]
    store = SocialStore(clock=lambda: now[0])
    _, a = store.create("A")
    store.act(a, {"action": "party_create", "name": "Walk"})
    room = store.state(a)["parties"][0]
    now[0] = 1000
    token, b = store.create("B")
    store.act(a, {"action": "friend_request", "code": store.state(b)["friend_code"]})
    store.act(b, {"action": "friend_accept", "profile_id": a})
    store.act(a, {"action": "party_invite", "party_id": room["id"], "profile_id": b})
    store.act(b, {"action": "party_join", "party_id": room["id"]})
    now[0] = 86401
    assert store.authenticate(token) == b
    assert store.state(b)["parties"] == []
    assert store.parties == {}


@pytest.mark.parametrize("revocation", ["logout", "location", "party_leave"])
def test_privacy_revocation_is_not_blocked_by_chat_rate_limit(client, revocation):
    first, second, room = party_pair(client)
    store = client.app.state.social
    identity = client.get("/v1/social/state", headers=first).json()["profile"]["id"]
    action(client, first, "location", party_id=room["id"], coordinates={"lat": 51.1, "lon": 71.4})
    posted = action(client, first, "message", party_id=room["id"], text="Meet here", photo=PHOTO)
    assert posted.status_code == 200
    assert posted.json()["parties"][0]["messages"][0]["photo"] == PHOTO
    store.profiles[identity]["actions"] = [store.clock()] * 40
    values = {"party_id": room["id"]} if revocation != "logout" else {}
    if revocation == "location":
        values["coordinates"] = None
    revoked = action(client, first, revocation, **values)
    assert revoked.status_code == 200
    after = client.get("/v1/social/state", headers=second).json()["parties"][0]
    assert after["locations"] == []
    if revocation != "location":
        assert after["messages"] == []
        assert all(member["profile"]["id"] != identity for member in after["members"])


def test_public_event_deletion_bypasses_rate_limit_but_keeps_authorization(client):
    author, profile = session(client, "Author")
    outsider, other = session(client, "Other")
    now = datetime.now(timezone.utc)
    created = action(client, author, "event_create", title="Meeting", description="Meet at this point",
                     location={"lat": 51.1, "lon": 71.4}, starts_at=now.isoformat(),
                     ends_at=(now + timedelta(hours=1)).isoformat())
    assert created.status_code == 200
    event_id = client.get("/v1/social/events").json()["events"][0]["id"]
    store = client.app.state.social
    for identity in (profile["profile"]["id"], other["profile"]["id"]):
        store.profiles[identity]["actions"] = [store.clock()] * 40
    assert action(client, outsider, "event_delete", event_id=event_id).status_code == 404
    assert len(client.get("/v1/social/events").json()["events"]) == 1
    assert action(client, author, "event_delete", event_id=event_id).status_code == 200
    assert client.get("/v1/social/events").json()["events"] == []


@pytest.fixture
def race_client():
    """Real recommender + deterministic ports; no model or external requests."""
    repository = FixtureRepository()
    recommender = DefaultRecommendationService(repository, FixtureRetriever(repository), FixtureContext())
    with TestClient(create_app(Settings(), Services(repository, recommender))) as client:
        yield client


@pytest.mark.parametrize("change", ["preferences", "party_leave", "logout", "message", "location"])
def test_group_revision_is_checked_after_provider_await_but_chat_and_location_do_not_change_plan(race_client, monkeypatch, change):
    client = race_client
    first, second, room = party_pair(client)
    entered, release = Event(), Event()
    service = client.app.state.services.recommender
    original = service.recommend

    async def delayed(request):
        entered.set()
        while not release.is_set():
            await asyncio.sleep(0.005)
        return await original(request)

    monkeypatch.setattr(service, "recommend", delayed)
    request = recommendation_request()
    request["constraints"] = []
    request["available_seconds"] = 7200
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(action, client, first, "recommend", party_id=room["id"], revision=room["revision"], request=request)
        try:
            assert entered.wait(3), "Provider did not enter its await"
            values = {"party_id": room["id"]} if change != "logout" else {}
            if change == "preferences":
                values.update(available_seconds=600, constraints=[{"key": "wheelchair_accessible", "value": True, "strength": "required"}])
            elif change == "message":
                values.update(text="Keep the plan", photo=None)
            elif change == "location":
                values.update(coordinates={"lat": 52.0, "lon": 72.0})
            assert action(client, second, change, **values).status_code == 200
        finally:
            release.set()
        response = pending.result(timeout=5)
    shared = client.get("/v1/social/state", headers=first).json()["parties"][0]
    if change in {"preferences", "party_leave", "logout"}:
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "revision_conflict"
        assert shared["recommendations"] is None
        assert shared["itinerary"] is None
    else:
        assert response.status_code == 200, response.text
        assert shared["recommendations"]["request"]["origin"] == request["origin"]
        assert shared["revision"] == room["revision"] + 1
        if change == "message":
            assert shared["messages"][0]["text"] == "Keep the plan"
            assert shared["locations"] == []
        else:
            assert shared["locations"][0]["coordinates"] == {"lat": 52.0, "lon": 72.0}


def test_simultaneous_plans_publish_once_for_a_revision(race_client, monkeypatch):
    client = race_client
    first, second, room = party_pair(client)
    both_entered, release = Event(), Event()
    count = 0
    service = client.app.state.services.recommender
    original = service.recommend

    async def delayed(request):
        nonlocal count
        count += 1
        if count == 2:
            both_entered.set()
        while not release.is_set():
            await asyncio.sleep(0.005)
        return await original(request)

    monkeypatch.setattr(service, "recommend", delayed)
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = [pool.submit(action, client, headers, "recommend", party_id=room["id"], revision=room["revision"], request=recommendation_request()) for headers in (first, second)]
        try:
            assert both_entered.wait(3), "Both providers must be pending together"
        finally:
            release.set()
        responses = [future.result(timeout=5) for future in pending]
    assert sorted(response.status_code for response in responses) == [200, 409]
    shared = client.get("/v1/social/state", headers=second).json()["parties"][0]
    assert shared["revision"] == room["revision"] + 1
    assert shared == next(response.json()["parties"][0] for response in responses if response.status_code == 200)


def test_group_maximum_five_members_and_no_implicit_location_sharing(client):
    owner, owner_state = session(client, "Owner")
    room = action(client, owner, "party_create", name="Five").json()["parties"][0]
    for index in range(5):
        member, state = session(client, f"Guest {index}")
        action(client, owner, "friend_request", code=state["friend_code"])
        action(client, member, "friend_accept", profile_id=owner_state["profile"]["id"])
        invite = action(client, owner, "party_invite", party_id=room["id"], profile_id=state["profile"]["id"])
        if index < 4:
            assert invite.status_code == 200
            assert action(client, member, "party_join", party_id=room["id"]).status_code == 200
        else:
            assert invite.status_code == 409
            assert action(client, member, "party_join", party_id=room["id"]).status_code == 404
    shared = client.get("/v1/social/state", headers=owner).json()["parties"][0]
    assert len(shared["members"]) == 5
    assert shared["locations"] == []


@pytest.mark.parametrize("number,boolean", [(1, True), ([1], [True])])
def test_group_does_not_merge_distinct_boolean_and_numeric_required_values(client, number, boolean):
    first, second, room = party_pair(client)
    for headers, value in [(first, number), (second, boolean)]:
        changed = action(client, headers, "preferences", party_id=room["id"], available_seconds=7200,
                         constraints=[{"key": "indoor", "value": value, "strength": "required"}])
        assert changed.status_code == 200
        room = changed.json()["parties"][0]
    request = recommendation_request()
    request["constraints"] = []
    response = action(client, first, "recommend", party_id=room["id"], revision=room["revision"], request=request)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "constraint_conflict"
    shared = client.get("/v1/social/state", headers=second).json()["parties"][0]
    assert shared["recommendations"] is None


def test_logout_while_body_is_awaited_cannot_reuse_the_previous_identity(monkeypatch):
    module = import_module("astana_api.app")
    original = module.read_payload
    entered, release = Event(), Event()

    async def delayed_read(request, definition):
        body = await original(request, definition)
        if definition == "SocialActionRequest" and body["action"] == "message":
            entered.set()
            while not release.is_set():
                await asyncio.sleep(0.005)
        return body

    monkeypatch.setattr(module, "read_payload", delayed_read)
    with TestClient(create_app(Settings())) as client:
        first, second, room = party_pair(client)
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(action, client, first, "message", party_id=room["id"], text="Obsolete identity", photo=None)
            try:
                assert entered.wait(3)
                assert action(client, first, "logout").status_code == 200
            finally:
                release.set()
            response = pending.result(timeout=5)
        assert response.status_code == 401
        shared = client.get("/v1/social/state", headers=second).json()["parties"][0]
        assert shared["messages"] == []


def test_profile_expiry_erases_photos_locations_and_events_from_a_surviving_room():
    now = [0.0]
    store = SocialStore(clock=lambda: now[0])
    _, a = store.create("A")
    now[0] = 1000
    token, b = store.create("B")
    store.act(a, {"action": "friend_request", "code": store.state(b)["friend_code"]})
    store.act(b, {"action": "friend_accept", "profile_id": a})
    # Create the room late enough that its separate one-day TTL survives A.
    now[0] = 7 * 86400 - 1000
    store.act(a, {"action": "party_create", "name": "Walk"})
    room = store.state(a)["parties"][0]
    store.act(a, {"action": "party_invite", "party_id": room["id"], "profile_id": b})
    store.act(b, {"action": "party_join", "party_id": room["id"]})
    store.act(a, {"action": "message", "party_id": room["id"], "text": "", "photo": PHOTO})
    now[0] = 7 * 86400 - 10
    store.act(a, {"action": "location", "party_id": room["id"], "coordinates": {"lat": 51.1, "lon": 71.4}})
    wall = datetime.now(timezone.utc)
    store.act(a, {"action": "event_create", "title": "Temporary", "description": "Synthetic test event", "location": {"lat": 51.1, "lon": 71.4}, "starts_at": wall.isoformat(), "ends_at": (wall + timedelta(hours=1)).isoformat()})
    now[0] = 7 * 86400 + 1
    assert store.authenticate(token) == b
    remaining = store.state(b)["parties"][0]
    assert remaining["owner_id"] == b
    assert remaining["messages"] == []
    assert remaining["locations"] == []
    assert store.events == {}
