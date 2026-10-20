import type { SocialState } from "@astana/api-client";

/** Offline guest/group fixture shared by the social component tests. */
export const socialStateFixture = (): SocialState => ({
  profile: { id: "guest", name: "Synthetic guest" },
  friend_code: "offline-code",
  friends: [],
  friend_requests: [],
  party_invites: [],
  expires_at: "2026-10-20T12:00:00+05:00",
  parties: [{
    id: "party",
    name: "Offline test",
    owner_id: "guest",
    revision: 1,
    members: [{
      profile: { id: "guest", name: "Synthetic guest" },
      available_seconds: 3600,
      constraints: [],
    }],
    recommendations: null,
    itinerary: null,
    messages: [],
    locations: [],
  }],
});
