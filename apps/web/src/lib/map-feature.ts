import type { Location, MapFeatureResponse } from "@astana/api-client";
import { valid } from "./contracts";
import type { Locale } from "./i18n";

export type MapFeaturesResult = MapFeatureResponse;
export class MapFeatureError extends Error {
  constructor(readonly code: "unavailable" | "invalid" | "busy") {
    super(code);
  }
}
export function safeSourceUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
/** Use the shared schema plus cross-field integrity before rendering source data. */
export function mapFeaturesResult(value: unknown): MapFeaturesResult | null {
  if (!valid("MapFeatureResponse", value)) return null;
  const result = value as MapFeaturesResult;
  if (
    (result.status === "empty") !== (result.features.length === 0) ||
    new Set(result.features.map((feature) => feature.id)).size !==
      result.features.length ||
    result.features.some((feature) => !safeSourceUrl(feature.source_url))
  )
    return null;
  return result;
}
export async function fetchMapFeatures(
  location: Location,
  locale: Locale,
  signal: AbortSignal,
): Promise<MapFeaturesResult> {
  const response = await fetch("/api/v1/map-features", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location, locale }),
    signal,
    cache: "no-store",
  });
  if (!response.ok)
    throw new MapFeatureError(response.status === 429 ? "busy" : "unavailable");
  const result = mapFeaturesResult(await response.json());
  if (!result) throw new MapFeatureError("invalid");
  return result;
}
