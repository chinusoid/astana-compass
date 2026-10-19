import type {
  Place,
  PlacePhotoRequest,
  PlacePhotoResponse,
} from "@astana/api-client";
import { valid } from "./contracts";
import type { Locale } from "./i18n";

/** Only explicit source-backed identities are eligible; no name/image guessing. */
export function hasPhotoIdentity(place: Place): boolean {
  if (place.is_synthetic) return false;
  const evidence = new Set(
    place.evidence
      .filter((source) => source.source_type === "osm" && !source.is_synthetic)
      .map((source) => source.id),
  );
  return place.facts.some(
    (fact) =>
      fact.key === "osm:wikidata" &&
      fact.status === "known" &&
      typeof fact.value === "string" &&
      /^Q[1-9]\d*$/.test(fact.value) &&
      fact.evidence_ids.some((id) => evidence.has(id)),
  );
}

function allowedUrl(value: string, kind: "image" | "source" | "license") {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      url.search
    )
      return false;
    if (kind === "source")
      return (
        url.hostname === "commons.wikimedia.org" &&
        url.pathname.startsWith("/wiki/File:")
      );
    if (kind === "license")
      return (
        url.hostname === "creativecommons.org" &&
        /^\/(?:licenses\/by(?:-sa)?\/(?:2\.0|2\.5|3\.0|4\.0)|publicdomain\/(?:zero|mark)\/1\.0)\/?$/.test(
          url.pathname,
        )
      );
    const width = /\/([1-9]\d{1,3})px-[^/]+\.(?:jpe?g|png|webp)$/i.exec(
      url.pathname,
    );
    return (
      ["upload.wikimedia.org", "thumb.wikimedia.org"].includes(url.hostname) &&
      url.pathname.startsWith("/wikipedia/commons/thumb/") &&
      Boolean(width && Number(width[1]) <= 1280)
    );
  } catch {
    return false;
  }
}

export function placePhotoResult(value: unknown): PlacePhotoResponse | null {
  if (!valid("PlacePhotoResponse", value)) return null;
  const result = value as PlacePhotoResponse;
  if (result.status === "unavailable")
    return result.photo === null ? result : null;
  const photo = result.photo;
  if (
    !photo ||
    !allowedUrl(photo.url, "image") ||
    !allowedUrl(photo.source_url, "source") ||
    !allowedUrl(photo.license_url, "license")
  )
    return null;
  return result;
}

export async function fetchPlacePhoto(
  placeId: string,
  locale: Locale,
  signal: AbortSignal,
): Promise<PlacePhotoResponse> {
  const body: PlacePhotoRequest = { place_id: placeId, locale };
  if (!valid("PlacePhotoRequest", body))
    throw new Error("invalid_photo_request");
  const response = await fetch("/api/v1/place-photo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "omit",
    cache: "no-store",
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
  });
  if (!response.ok) throw new Error("photo_unavailable");
  const result = placePhotoResult(await response.json());
  if (!result) throw new Error("invalid_photo_response");
  return result;
}
