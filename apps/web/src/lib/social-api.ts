import type { SocialActionRequest, SocialState } from "@astana/api-client";
import {
  itineraryIntegrity,
  recommendationIntegrity,
  valid,
} from "./contracts";

export type SocialFailure =
  | "session_required"
  | "conflict"
  | "constraint_conflict"
  | "unavailable"
  | "rate_limited"
  | "invalid"
  | "fixture_disabled"
  | "photo_type"
  | "photo_size";
export class SocialApiError extends Error {
  constructor(public readonly code: SocialFailure) {
    super(code);
  }
}

function synthetic(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(synthetic);
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  return (
    object.is_synthetic === true ||
    object.source_type === "synthetic" ||
    ["id", "source_record_id"].some(
      (key) =>
        typeof object[key] === "string" && object[key].startsWith("synthetic:"),
    ) ||
    Object.values(object).some(synthetic)
  );
}
function stateIntegrity(state: SocialState): boolean {
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  return (
    unique(state.parties.map((party) => party.id)) &&
    unique(state.friends.map((profile) => profile.id)) &&
    unique(state.friend_requests.map((profile) => profile.id)) &&
    state.parties.every(
      (party) =>
        party.members.some(
          (member) => member.profile.id === state.profile.id,
        ) &&
        party.members.some((member) => member.profile.id === party.owner_id) &&
        unique(party.messages.map((message) => message.id)) &&
        party.messages.every((message) =>
          party.members.some(
            (member) => member.profile.id === message.author.id,
          ),
        ) &&
        new Set(party.members.map((member) => member.profile.id)).size ===
          party.members.length &&
        party.locations.every((location) =>
          party.members.some(
            (member) => member.profile.id === location.profile.id,
          ),
        ) &&
        (!party.recommendations ||
          recommendationIntegrity(
            party.recommendations,
            party.recommendations.request,
          )) &&
        (!party.itinerary ||
          itineraryIntegrity(party.itinerary, party.itinerary.request)),
    )
  );
}

/** The same-origin proxy owns the HttpOnly session. No bearer token enters JS. */
export function createSocialApi(allowFixtures: boolean) {
  async function request(
    path: "state" | "session" | "action",
    signal: AbortSignal,
    body?: unknown,
  ): Promise<SocialState | null> {
    let response: Response;
    try {
      response = await fetch(`/api/v1/social/${path}`, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers:
          body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(35000)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SocialApiError("unavailable");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SocialApiError("invalid");
    }
    if (!response.ok) {
      const code =
        payload && typeof payload === "object" && "error" in payload
          ? (payload as { error?: { code?: unknown } }).error?.code
          : undefined;
      throw new SocialApiError(
        response.status === 401
          ? "session_required"
          : response.status === 409
            ? code === "constraint_conflict"
              ? "constraint_conflict"
              : "conflict"
            : response.status === 429
              ? "rate_limited"
              : response.status === 422
                ? "invalid"
                : "unavailable",
      );
    }
    if (
      path === "action" &&
      (body as SocialActionRequest).action === "logout"
    ) {
      if (
        !payload ||
        typeof payload !== "object" ||
        !("signed_out" in payload) ||
        payload.signed_out !== true
      )
        throw new SocialApiError("invalid");
      return null;
    }
    if (
      !valid("SocialState", payload) ||
      !stateIntegrity(payload as SocialState)
    )
      throw new SocialApiError("invalid");
    if (
      synthetic(payload) &&
      (!allowFixtures || response.headers.get("X-Astana-Data-Mode") === "live")
    )
      throw new SocialApiError("fixture_disabled");
    return payload as SocialState;
  }
  return {
    state: (signal: AbortSignal) => request("state", signal),
    session: (name: string, signal: AbortSignal) => {
      const body = { name: name.trim() };
      if (!valid("SocialSessionRequest", body))
        throw new SocialApiError("invalid");
      return request("session", signal, body);
    },
    action: (body: SocialActionRequest, signal: AbortSignal) => {
      if (!valid("SocialActionRequest", body))
        throw new SocialApiError("invalid");
      return request("action", signal, body);
    },
  };
}

/** Decode into a fresh canvas: original metadata and source bytes are never sent. */
export async function encodeSharedPhoto(file: File): Promise<string> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    throw new SocialApiError("photo_type");
  if (!file.size || file.size > 8 * 1024 * 1024)
    throw new SocialApiError("photo_size");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new SocialApiError("photo_type");
  }
  try {
    if (
      !bitmap.width ||
      !bitmap.height ||
      bitmap.width * bitmap.height > 40_000_000
    )
      throw new SocialApiError("photo_size");
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new SocialApiError("photo_type");
    for (const edge of [480, 360, 240, 160]) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.7, 0.5, 0.3]) {
        const photo = canvas.toDataURL("image/jpeg", quality);
        if (
          photo.startsWith("data:image/jpeg;base64,") &&
          photo.length <= 24000
        )
          return photo;
      }
    }
    throw new SocialApiError("photo_size");
  } finally {
    bitmap.close();
  }
}
