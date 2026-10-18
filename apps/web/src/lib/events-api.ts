import type { CommunityEvents } from "@astana/api-client";
import { valid } from "./contracts";
import { SocialApiError } from "./social-api";

export async function loadCommunityEvents(
  signal: AbortSignal,
): Promise<CommunityEvents> {
  let response: Response;
  try {
    response = await fetch("/api/v1/social/events", {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(35000)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new SocialApiError("unavailable");
  }
  if (!response.ok)
    throw new SocialApiError(
      response.status === 401
        ? "session_required"
        : response.status === 429
          ? "rate_limited"
          : "unavailable",
    );
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SocialApiError("invalid");
  }
  if (!valid("CommunityEvents", payload)) throw new SocialApiError("invalid");
  const data = payload as CommunityEvents;
  if (
    new Set(data.events.map((event) => event.id)).size !== data.events.length ||
    data.events.some(
      (event) =>
        new Date(event.starts_at).getTime() >=
        new Date(event.ends_at).getTime(),
    )
  )
    throw new SocialApiError("invalid");
  return data;
}
