import { afterEach, expect, it, vi } from "vitest";
import examples from "../../../../contracts.examples.json";
import type {
  ItineraryResponse,
  Place,
  RecommendationResponse,
  RouteEstimate,
} from "@astana/api-client";
import { createApi } from "./api";

afterEach(() => vi.unstubAllGlobals());
const place = () =>
  structuredClone(
    examples.cases.find((c) => c.name === "place_valid")!.instance,
  ) as Place;

function recommendationWithRealPlaces() {
  const response = structuredClone(
    examples.cases.find((c) => c.name === "recommendations_valid")!.instance,
  ) as RecommendationResponse;
  makePlacesReal(response);
  return response;
}
function itineraryWithRealPlaces() {
  const response = structuredClone(
    examples.cases.find((c) => c.name === "itinerary_valid")!.instance,
  ) as ItineraryResponse;
  makePlacesReal(response);
  return response;
}
function makePlacesReal(response: RecommendationResponse | ItineraryResponse) {
  const placeIds = new Map<string, string>();
  const evidenceIds = new Map<string, string>();
  response.places.forEach((place, index) => {
    const id = `osm:node:${index + 1}`;
    placeIds.set(place.id, id);
    place.id = id;
    place.is_synthetic = false;
    place.evidence.forEach((evidence, evidenceIndex) => {
      const evidenceId = `osm:evidence:${index + 1}:${evidenceIndex + 1}`;
      evidenceIds.set(evidence.id, evidenceId);
      evidence.id = evidenceId;
      evidence.source_type = "osm";
      evidence.source_record_id = `node:${index + 1}`;
      evidence.is_synthetic = false;
    });
    for (const fact of place.facts)
      fact.evidence_ids = fact.evidence_ids.map((id) => evidenceIds.get(id)!);
  });
  const items =
    "recommendations" in response ? response.recommendations : response.stops;
  for (const item of items) {
    item.place_id = placeIds.get(item.place_id)!;
    for (const evaluation of item.constraint_evaluations)
      evaluation.evidence_ids = evaluation.evidence_ids.map((id) =>
        evidenceIds.get(id)!,
      );
  }
  if ("place_ids" in response.request)
    response.request.place_ids = response.request.place_ids.map((id) =>
      placeIds.get(id)!,
    );
}
function makeRouteReal(route: RouteEstimate) {
  route.provider = "offline-test-provider";
  route.evidence.forEach((evidence, index) => {
    evidence.id = `provider:route:${index}`;
    evidence.source_type = "provider";
    evidence.source_record_id = `route:${index}`;
    evidence.is_synthetic = false;
  });
}

it("blocks synthetic data without explicit opt-in, even if the mode header is absent", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(place())));
  await expect(
    createApi(false, vi.fn()).place(
      "synthetic:place:one",
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "fixture_disabled" });
});
it("rejects synthetic payloads claimed as live", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json(place(), { headers: { "X-Astana-Data-Mode": "live" } }),
      ),
  );
  await expect(
    createApi(true, vi.fn()).place(
      "synthetic:place:one",
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "fixture_disabled" });
});
it.each([
  [false, undefined],
  [false, "fixture"],
  [false, "live"],
  [true, "live"],
] as const)(
  "blocks synthetic recommendation routes with real places (opt-in %s, mode %s)",
  async (allowFixtures, mode) => {
    const response = recommendationWithRealPlaces();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(response, {
          headers: mode ? { "X-Astana-Data-Mode": mode } : {},
        }),
      ),
    );
    await expect(
      createApi(allowFixtures, vi.fn()).recommend(
        response.request,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "fixture_disabled" });
  },
);
it.each([
  [false, undefined],
  [false, "fixture"],
  [false, "live"],
  [true, "live"],
] as const)(
  "blocks synthetic itinerary routes with real places (opt-in %s, mode %s)",
  async (allowFixtures, mode) => {
    const response = itineraryWithRealPlaces();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(response, {
          headers: mode ? { "X-Astana-Data-Mode": mode } : {},
        }),
      ),
    );
    await expect(
      createApi(allowFixtures, vi.fn()).itinerary(
        response.request,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "fixture_disabled" });
  },
);
it.each([undefined, "fixture"] as const)(
  "allows explicitly opted-in synthetic route data and marks its mode (%s)",
  async (mode) => {
    const response = itineraryWithRealPlaces();
    const onMode = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(response, {
          headers: mode ? { "X-Astana-Data-Mode": mode } : {},
        }),
      ),
    );
    await expect(
      createApi(true, onMode).itinerary(
        response.request,
        new AbortController().signal,
      ),
    ).resolves.toEqual(response);
    expect(onMode).toHaveBeenLastCalledWith("fixture");
  },
);
it.each(["id", "source_record_id"] as const)(
  "blocks a synthetic route evidence %s even when its boolean marker is false",
  async (key) => {
    const response = recommendationWithRealPlaces();
    const route = response.recommendations[0].route;
    makeRouteReal(route);
    route.evidence[0][key] = "synthetic:route:reserved";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(response, {
            headers: { "X-Astana-Data-Mode": "live" },
          }),
        ),
    );
    await expect(
      createApi(false, vi.fn()).recommend(
        response.request,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "fixture_disabled" });
  },
);
it("keeps real responses available and does not classify free text as a fixture marker", async () => {
  const response = recommendationWithRealPlaces();
  response.request.query = "What does synthetic: mean in a data source?";
  response.places[0].description = "The display mentions synthetic: examples.";
  for (const recommendation of response.recommendations)
    makeRouteReal(recommendation.route);
  const onMode = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json(response, { headers: { "X-Astana-Data-Mode": "live" } }),
      ),
  );
  await expect(
    createApi(false, onMode).recommend(
      response.request,
      new AbortController().signal,
    ),
  ).resolves.toEqual(response);
  expect(onMode).toHaveBeenCalledExactlyOnceWith("live");
});
it("rejects malformed response shapes instead of showing fabricated results", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ places: ["wrong shape"] })),
  );
  await expect(
    createApi(true, vi.fn()).places(new AbortController().signal),
  ).rejects.toMatchObject({ code: "invalid_response" });
});
it("preserves safe error code and reference without exposing provider text", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json(
        {
          request_id: "safe-reference",
          error: {
            code: "rate_limited",
            message: "private-provider-detail",
            details: [],
            retryable: true,
          },
        },
        { status: 429 },
      ),
    ),
  );
  await expect(
    createApi(true, vi.fn()).places(new AbortController().signal),
  ).rejects.toMatchObject({
    code: "rate_limited",
    requestId: "safe-reference",
    message: "rate_limited",
  });
});
it("does not retry an aborted or failed operation", async () => {
  const fetch = vi
    .fn()
    .mockRejectedValue(new DOMException("Cancelled", "AbortError"));
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  controller.abort();
  await expect(
    createApi(true, vi.fn()).places(controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).toHaveBeenCalledTimes(1);
});
