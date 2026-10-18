"""Opt-in guest friendships and shared walks. Volatile, bounded, 24-hour rooms."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import base64
import binascii
import secrets
import time

from fastapi import APIRouter, Request
from starlette.responses import JSONResponse


class SocialError(Exception):
    def __init__(self, code, status=422):
        self.code, self.status = code, status


def same_constraint_value(left, right):
    """Match JSON/recommender equality: booleans are not numeric values."""
    if isinstance(left, bool) != isinstance(right, bool):
        return False
    if isinstance(left, list) or isinstance(right, list):
        return (isinstance(left, list) and isinstance(right, list) and len(left) == len(right)
                and all(same_constraint_value(a, b) for a, b in zip(left, right, strict=True)))
    return left == right


class SocialStore:
    """Single-process demo store; raw bearer tokens and user coordinates are not persisted."""

    def __init__(self, clock=time.monotonic, capacity=512):
        self.clock, self.capacity = clock, capacity
        self.profiles, self.tokens, self.parties, self.events = {}, {}, {}, {}

    def prune(self):
        for profile_id, profile in list(self.profiles.items()):
            if profile["deadline"] <= self.clock():
                self.remove(profile_id)
        now = datetime.now(timezone.utc)
        self.events = {key: event for key, event in self.events.items() if datetime.fromisoformat(event["ends_at"].replace("Z", "+00:00")) > now}
        for party_id, party in list(self.parties.items()):
            # A newer member must not extend an older room's retention period.
            if party["deadline"] <= self.clock():
                del self.parties[party_id]
                continue
            party["locations"] = {key: value for key, value in party["locations"].items() if value["deadline"] > self.clock()}

    def remove(self, profile_id):
        self.profiles.pop(profile_id, None)
        self.tokens = {key: value for key, value in self.tokens.items() if value != profile_id}
        self.events = {key: event for key, event in self.events.items() if event["author"]["id"] != profile_id}
        for p in self.profiles.values():
            p["friends"].discard(profile_id)
            p["requests"].discard(profile_id)
        for party in list(self.parties.values()):
            party["invites"].discard(profile_id)
            if profile_id in party["members"]:
                self.leave(party, profile_id)

    def create(self, name):
        self.prune()
        if len(self.profiles) >= self.capacity:
            raise SocialError("capacity", 429)
        token, profile_id = secrets.token_urlsafe(32), secrets.token_urlsafe(16)
        self.profiles[profile_id] = {
            "profile": {"id": profile_id, "name": name.strip()},
            "code": secrets.token_urlsafe(16), "friends": set(), "requests": set(),
            "deadline": self.clock() + 86400,
            "expires_at": (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat(),
            "actions": [],
        }
        self.tokens[hashlib.sha256(token.encode()).hexdigest()] = profile_id
        return token, profile_id

    def authenticate(self, token):
        self.prune()
        profile_id = self.tokens.get(hashlib.sha256(token.encode()).hexdigest())
        if profile_id not in self.profiles:
            raise SocialError("session_required", 401)
        return profile_id

    def rate_limit(self, profile_id):
        profile = self.profiles[profile_id]
        recent = [stamp for stamp in profile["actions"] if stamp > self.clock() - 60]
        if len(recent) >= 40:
            raise SocialError("rate_limited", 429)
        profile["actions"] = [*recent, self.clock()]

    def member_party(self, profile_id, party_id):
        party = self.parties.get(party_id)
        if not party or profile_id not in party["members"]:
            raise SocialError("party_unavailable", 404)
        return party

    @staticmethod
    def invalidate(party):
        party["revision"] += 1
        party["recommendations"] = party["itinerary"] = None

    def leave(self, party, profile_id):
        party["members"].pop(profile_id, None)
        party["locations"].pop(profile_id, None)
        party["messages"] = [message for message in party["messages"] if message["author"]["id"] != profile_id]
        if not party["members"]:
            del self.parties[party["id"]]
            return
        if party["owner_id"] == profile_id:
            party["owner_id"] = next(iter(party["members"]))
            # Outstanding invitations were issued by the departing owner. The
            # new owner must explicitly invite their own accepted friends.
            party["invites"].clear()
        self.invalidate(party)

    @staticmethod
    def new_member():
        return {"available_seconds": 7200, "constraints": []}

    def state(self, profile_id):
        p = self.profiles[profile_id]
        public = lambda key: deepcopy(self.profiles[key]["profile"])
        parties, invites = [], []
        for party in self.parties.values():
            if profile_id in party["members"]:
                parties.append({
                    key: deepcopy(party[key]) for key in
                    ("id", "name", "owner_id", "revision", "recommendations", "itinerary", "messages")
                } | {"members": [{"profile": public(key), **deepcopy(value)} for key, value in party["members"].items()],
                     "locations": [{"profile": public(key), "coordinates": deepcopy(value["coordinates"]), "expires_at": value["expires_at"]} for key, value in party["locations"].items()]})
            elif profile_id in party["invites"]:
                invites.append({"id": party["id"], "name": party["name"], "owner": public(party["owner_id"])})
        return {"profile": public(profile_id), "friend_code": p["code"],
                "friends": [public(key) for key in sorted(p["friends"])],
                "friend_requests": [public(key) for key in sorted(p["requests"])],
                "party_invites": invites, "parties": parties, "expires_at": p["expires_at"]}

    def act(self, profile_id, payload):
        p, action = self.profiles[profile_id], payload["action"]
        revocation = action in {"logout", "party_leave", "friend_remove", "event_delete"} or (
            action == "location" and payload["coordinates"] is None
        )
        if not revocation:
            self.rate_limit(profile_id)
        if action == "friend_request":
            if not payload["code"].isascii():
                raise SocialError("friend_unavailable", 404)
            target = next((v for v in self.profiles.values() if secrets.compare_digest(v["code"], payload["code"])), None)
            if not target or target is p:
                raise SocialError("friend_unavailable", 404)
            if len(target["requests"]) >= 50 or len(p["friends"]) >= 50:
                raise SocialError("capacity", 409)
            if profile_id not in target["friends"]:
                target["requests"].add(profile_id)
        elif action == "friend_accept":
            other = payload["profile_id"]
            if other not in p["requests"] or other not in self.profiles:
                raise SocialError("friend_unavailable", 404)
            if max(len(p["friends"]), len(self.profiles[other]["friends"])) >= 50:
                raise SocialError("capacity", 409)
            p["requests"].discard(other)
            self.profiles[other]["requests"].discard(profile_id)
            p["friends"].add(other)
            self.profiles[other]["friends"].add(profile_id)
        elif action == "friend_remove":
            other = payload["profile_id"]
            p["friends"].discard(other)
            p["requests"].discard(other)
            if other in self.profiles:
                self.profiles[other]["friends"].discard(profile_id)
                self.profiles[other]["requests"].discard(profile_id)
            for party in self.parties.values():
                if party["owner_id"] == profile_id:
                    party["invites"].discard(other)
                elif party["owner_id"] == other:
                    party["invites"].discard(profile_id)
        elif action == "party_create":
            if not payload["name"].strip():
                raise SocialError("invalid_request")
            if len(self.parties) >= 256 or sum(profile_id in room["members"] for room in self.parties.values()) >= 20:
                raise SocialError("capacity", 409)
            party_id = secrets.token_urlsafe(16)
            self.parties[party_id] = {"id": party_id, "name": payload["name"].strip(), "owner_id": profile_id,
                "members": {profile_id: self.new_member()}, "invites": set(), "revision": 1,
                "recommendations": None, "itinerary": None, "messages": [], "locations": {},
                "deadline": self.clock() + 86400}
        elif action == "party_join":
            party = self.parties.get(payload["party_id"])
            if not party or profile_id not in party["invites"] or party["owner_id"] not in p["friends"]:
                raise SocialError("party_unavailable", 404)
            if len(party["members"]) >= 5 or sum(profile_id in room["members"] for room in self.parties.values()) >= 20:
                raise SocialError("capacity", 409)
            party["invites"].discard(profile_id)
            party["members"][profile_id] = self.new_member()
            self.invalidate(party)
        elif action in {"party_leave", "party_invite", "preferences"}:
            party = self.member_party(profile_id, payload["party_id"])
            if action == "party_leave":
                self.leave(party, profile_id)
            elif action == "party_invite":
                other = payload["profile_id"]
                if party["owner_id"] != profile_id or other not in p["friends"]:
                    raise SocialError("friend_unavailable", 404)
                if len(party["members"]) + len(party["invites"]) >= 5:
                    raise SocialError("capacity", 409)
                if other not in party["members"]:
                    if sum(other in room["invites"] for room in self.parties.values()) >= 20:
                        raise SocialError("capacity", 409)
                    party["invites"].add(other)
            else:
                if len({c["key"] for c in payload["constraints"]}) != len(payload["constraints"]):
                    raise SocialError("invalid_request")
                party["members"][profile_id] = {key: deepcopy(payload[key]) for key in ("available_seconds", "constraints")}
                self.invalidate(party)
        elif action == "message":
            party = self.member_party(profile_id, payload["party_id"])
            text, photo = payload["text"].strip(), payload["photo"]
            if not text and not photo:
                raise SocialError("invalid_request")
            if photo:
                try:
                    decoded = base64.b64decode(photo.split(",", 1)[1], validate=True)
                except (ValueError, IndexError, binascii.Error):
                    raise SocialError("invalid_photo") from None
                # Accept only bounded, client-reencoded JPEG thumbnails without EXIF/IPTC.
                if len(decoded) > 18000 or not decoded.startswith(b"\xff\xd8\xff") or not decoded.endswith(b"\xff\xd9") or b"\xff\xe1" in decoded or b"\xff\xed" in decoded:
                    raise SocialError("invalid_photo")
                # Bound image memory independently of text-history capacity.
                photos = [message for message in party["messages"] if message["photo"]]
                if len(photos) >= 6:
                    party["messages"].remove(photos[0])
            party["messages"] = [*party["messages"], {"id": secrets.token_urlsafe(16), "author": deepcopy(p["profile"]), "text": text, "photo": photo, "created_at": datetime.now(timezone.utc).isoformat()}][-50:]
        elif action == "location":
            party = self.member_party(profile_id, payload["party_id"])
            if payload["coordinates"] is None:
                party["locations"].pop(profile_id, None)
            else:
                party["locations"][profile_id] = {"coordinates": deepcopy(payload["coordinates"]), "deadline": self.clock() + 900, "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat()}
        elif action == "event_create":
            now = datetime.now(timezone.utc)
            start, end = (datetime.fromisoformat(payload[key].replace("Z", "+00:00")) for key in ("starts_at", "ends_at"))
            if not payload["title"].strip() or not payload["description"].strip() or not now < end <= now + timedelta(days=7) or not timedelta(0) < end - start <= timedelta(days=1):
                raise SocialError("invalid_event")
            if len(self.events) >= 200 or sum(event["author"]["id"] == profile_id for event in self.events.values()) >= 5:
                raise SocialError("capacity", 409)
            event_id = secrets.token_urlsafe(16)
            self.events[event_id] = {key: deepcopy(payload[key]) for key in ("title", "description", "location", "starts_at", "ends_at")} | {"id": event_id, "author": deepcopy(p["profile"]), "is_verified": False, "created_at": now.isoformat()}
        elif action == "event_delete":
            event = self.events.get(payload["event_id"])
            if not event or event["author"]["id"] != profile_id:
                raise SocialError("event_unavailable", 404)
            del self.events[payload["event_id"]]
        elif action == "logout":
            self.remove(profile_id)
        else:
            raise SocialError("invalid_request")

    def group_request(self, profile_id, payload):
        party = self.member_party(profile_id, payload["party_id"])
        if payload["revision"] != party["revision"]:
            raise SocialError("revision_conflict", 409)
        request = deepcopy(payload["request"])
        request["available_seconds"] = min(request["available_seconds"], *(m["available_seconds"] for m in party["members"].values()))
        combined = {}
        for constraint in [*request["constraints"], *(c for m in party["members"].values() for c in m["constraints"])]:
            existing = combined.get(constraint["key"])
            if existing and not same_constraint_value(existing["value"], constraint["value"]):
                raise SocialError("constraint_conflict", 409)
            if not existing or constraint["strength"] == "required":
                combined[constraint["key"]] = deepcopy(constraint)
        request["constraints"] = list(combined.values())
        if len(request["constraints"]) > 20:
            raise SocialError("constraint_conflict", 409)
        return request, party["revision"]


def social_router(store, read_payload, call, checked, settings):
    router = APIRouter(prefix="/v1/social", tags=["shared walks"])

    def actor(request):
        header = request.headers.get("authorization", "")
        return store.authenticate(header[7:] if header.startswith("Bearer ") else "")

    def response(profile_id):
        return checked("SocialState", store.state(profile_id), settings)

    @router.post("/session")
    async def session(request: Request):
        body = await read_payload(request, "SocialSessionRequest")
        if not body["name"].strip():
            raise SocialError("invalid_request")
        # Replacing one's own session does not leave an orphaned identity behind.
        try:
            old = actor(request)
        except SocialError:
            old = None
        if old:
            store.remove(old)
        token, profile_id = store.create(body["name"])
        return {"token": token, "state": response(profile_id)}

    @router.get("/state")
    async def state(request: Request):
        return response(actor(request))

    @router.get("/events")
    async def events():
        store.prune()
        return checked("CommunityEvents", {"events": deepcopy(list(store.events.values()))}, settings)

    @router.post("/action")
    async def action(request: Request):
        payload = await read_payload(request, "SocialActionRequest")
        # Authenticate after the last body-read await: logout/expiry during a
        # suspended upload must not leave us operating on an obsolete identity.
        profile_id = actor(request)
        if payload["action"] in {"recommend", "itinerary"}:
            store.rate_limit(profile_id)
            combined, revision = store.group_request(profile_id, payload)
            operation = payload["action"]
            result = await call(request, lambda services: services.recommender.recommend(combined) if operation == "recommend" else services.recommender.build_itinerary(combined))
            result = deepcopy(result)
            result["request_id"] = request.state.request_id
            checked("RecommendationResponse" if operation == "recommend" else "ItineraryResponse", result, settings)
            # A member may change needs/leave while the provider awaits. Never publish an obsolete plan.
            store.prune()
            party = store.member_party(profile_id, payload["party_id"])
            if party["revision"] != revision:
                raise SocialError("revision_conflict", 409)
            party["revision"] += 1
            if operation == "recommend":
                party["recommendations"], party["itinerary"] = result, None
            else:
                party["itinerary"] = result
        else:
            store.act(profile_id, payload)
        return {"signed_out": True} if payload["action"] == "logout" else response(profile_id)

    return router


async def social_error_handler(_request, exc):
    return JSONResponse({"error": {"code": exc.code}}, status_code=exc.status,
                        headers={"Cache-Control": "no-store"})
