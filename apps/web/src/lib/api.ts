import type {
  DataStatusResponse,
  ErrorResponse,
  FeedbackRequest,
  FeedbackResponse,
  ItineraryRequest,
  ItineraryResponse,
  Place,
  PlaceListResponse,
  RecommendationRequest,
  RecommendationResponse,
} from "@astana/api-client";
import {
  itineraryIntegrity,
  placeIntegrity,
  recommendationIntegrity,
  valid,
  type Definition,
} from "./contracts";

export type ErrorCode =
  | ErrorResponse["error"]["code"]
  | "invalid_response"
  | "fixture_disabled"
  | "timeout";
export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    public requestId?: string,
  ) {
    super(code);
  }
}
export type DataMode = "fixture" | "live" | "unknown";

function hasSyntheticMarker(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSyntheticMarker);
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.is_synthetic === true ||
    record.source_type === "synthetic" ||
    ["id", "source_record_id"].some(
      (key) =>
        typeof record[key] === "string" && record[key].startsWith("synthetic:"),
    ) ||
    Object.values(record).some(hasSyntheticMarker)
  );
}

// Private frontend transport. All public wire types come from @astana/api-client;
// runtime shapes come directly from the canonical schema, never a second DTO.
export function createApi(
  allowFixtures: boolean,
  onMode: (mode: DataMode) => void,
) {
  async function call<T>(
    path: string,
    definition: Definition,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`/api/v1/${path}`, {
        method: body === undefined ? "GET" : "POST",
        credentials: "omit",
        cache: "no-store",
        headers:
          body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(35000)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ApiError(
        error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "provider_unavailable",
      );
    }
    const mode = response.headers.get("X-Astana-Data-Mode");
    if (mode === "fixture" || mode === "live") onMode(mode);
    if (mode === "fixture" && !allowFixtures)
      throw new ApiError("fixture_disabled");
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ApiError("invalid_response");
    }
    if (!response.ok) {
      if (valid("ErrorResponse", payload)) {
        const error = payload as ErrorResponse;
        throw new ApiError(error.error.code, error.request_id);
      }
      throw new ApiError(
        response.status === 429 ? "rate_limited" : "provider_unavailable",
      );
    }
    if (!valid(definition, payload)) throw new ApiError("invalid_response");
    const places =
      definition === "Place"
        ? [payload as Place]
        : ((payload as { places?: Place[] }).places ?? []);
    if (!places.every(placeIntegrity)) throw new ApiError("invalid_response");
    if (hasSyntheticMarker(payload)) {
      onMode("fixture");
      if (!allowFixtures || mode === "live")
        throw new ApiError("fixture_disabled");
    }
    return payload as T;
  }
  return {
    places: (signal: AbortSignal, query = "", cursor?: string) =>
      call<PlaceListResponse>(
        `places?${new URLSearchParams({ limit: "12", ...(query ? { query } : {}), ...(cursor ? { cursor } : {}) })}`,
        "PlaceListResponse",
        signal,
      ),
    place: (id: string, signal: AbortSignal) =>
      call<Place>(`places/${encodeURIComponent(id)}`, "Place", signal),
    dataStatus: (signal: AbortSignal) =>
      call<DataStatusResponse>("data-status", "DataStatusResponse", signal),
    feedback: (body: FeedbackRequest, signal: AbortSignal) =>
      call<FeedbackResponse>("feedback", "FeedbackResponse", signal, body),
    async recommend(body: RecommendationRequest, signal: AbortSignal) {
      if (!valid("RecommendationRequest", body))
        throw new ApiError("invalid_request");
      const response = await call<RecommendationResponse>(
        "recommendations",
        "RecommendationResponse",
        signal,
        body,
      );
      if (!recommendationIntegrity(response, body))
        throw new ApiError("invalid_response");
      return response;
    },
    async itinerary(body: ItineraryRequest, signal: AbortSignal) {
      if (!valid("ItineraryRequest", body))
        throw new ApiError("invalid_request");
      const response = await call<ItineraryResponse>(
        "itineraries",
        "ItineraryResponse",
        signal,
        body,
      );
      if (!itineraryIntegrity(response, body))
        throw new ApiError("invalid_response");
      return response;
    },
  };
}
export function asApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError("internal_error");
}
