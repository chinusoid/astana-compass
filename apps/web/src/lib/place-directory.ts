import type {
  MapFeatureResponse,
  PlaceDirectoryRequest,
} from "@astana/api-client";
import type { Locale } from "./i18n";
import { mapFeaturesResult } from "./map-feature";
import { valid } from "./contracts";

export class PlaceDirectoryError extends Error {
  constructor(readonly code: "unavailable" | "invalid" | "busy") {
    super(code);
  }
}

/** Directory candidates stay separate from saved catalogue facts. */
export function placeDirectoryResult(
  value: unknown,
): MapFeatureResponse | null {
  const result = mapFeaturesResult(value);
  if (
    !result ||
    result.features.some((feature) => {
      const id = /^twogis:branch:([0-9]+)$/.exec(feature.id)?.[1];
      return !id || feature.source_url !== `https://2gis.kz/astana/firm/${id}`;
    })
  )
    return null;
  return result;
}

export async function fetchPlaceDirectory(
  placeId: string,
  locale: Locale,
  signal: AbortSignal,
): Promise<MapFeatureResponse> {
  const body: PlaceDirectoryRequest = { place_id: placeId, locale };
  if (!valid("PlaceDirectoryRequest", body))
    throw new PlaceDirectoryError("invalid");
  let response: Response;
  try {
    response = await fetch("/api/v1/place-directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      cache: "no-store",
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new PlaceDirectoryError("unavailable");
  }
  if (!response.ok)
    throw new PlaceDirectoryError(
      response.status === 429 ? "busy" : "unavailable",
    );
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new PlaceDirectoryError("invalid");
  }
  const result = placeDirectoryResult(payload);
  if (!result) throw new PlaceDirectoryError("invalid");
  return result;
}
