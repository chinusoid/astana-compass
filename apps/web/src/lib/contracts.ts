import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type {
  ConstraintEvaluation,
  ItineraryRequest,
  ItineraryResponse,
  Place,
  RecommendationRequest,
  RecommendationResponse,
  RouteEstimate,
} from "@astana/api-client";
import schema from "../../../../contracts.schema.json";

const ajv = new Ajv2020({
  strict: false,
  allErrors: false,
  validateFormats: true,
});
addFormats(ajv);
ajv.addSchema(schema, "canonical");
export type Definition = keyof typeof schema.$defs;
export function valid(name: Definition, data: unknown): boolean {
  const validate = ajv.getSchema(`canonical#/$defs/${name}`);
  return Boolean(validate?.(data));
}
export function routeGeometry(route: RouteEstimate | null | undefined) {
  return route?.method === "routed" ? route.geometry : null;
}
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== "object" || !a || typeof b !== "object" || !b) return false;
  const ak = Object.keys(a),
    bk = Object.keys(b);
  return (
    ak.length === bk.length &&
    ak.every(
      (k) =>
        Object.hasOwn(b, k) &&
        same(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
    )
  );
};
export function placeIntegrity(place: Place): boolean {
  const ids = new Set(place.evidence.map((e) => e.id));
  return (
    ids.size === place.evidence.length &&
    new Set(place.facts.map((f) => f.key)).size === place.facts.length &&
    place.facts.every((f) => f.evidence_ids.every((id) => ids.has(id))) &&
    place.is_synthetic === place.evidence.some((e) => e.is_synthetic) &&
    place.is_synthetic === place.id.startsWith("synthetic:") &&
    place.evidence.every(
      (e) =>
        e.is_synthetic === e.id.startsWith("synthetic:") &&
        e.is_synthetic === (e.source_type === "synthetic"),
    )
  );
}
function evaluationsSafe(
  place: Place,
  evaluations: ConstraintEvaluation[],
  request: RecommendationRequest,
): boolean {
  if (
    evaluations.length !== request.constraints.length ||
    new Set(evaluations.map((e) => e.key)).size !== evaluations.length
  )
    return false;
  const evidenceIds = new Set(place.evidence.map((e) => e.id));
  return request.constraints.every((constraint) => {
    const evaluation = evaluations.find(
      (e) => e.key === constraint.key && e.strength === constraint.strength,
    );
    if (
      !evaluation ||
      !evaluation.evidence_ids.every((id) => evidenceIds.has(id))
    )
      return false;
    const fact = place.facts.find((f) => f.key === constraint.key);
    const expected =
      fact?.status === "known"
        ? same(fact.value, constraint.value)
          ? "satisfied"
          : "unsatisfied"
        : "unknown";
    return (
      evaluation.outcome === expected &&
      (constraint.strength !== "required" || expected === "satisfied") &&
      (fact?.status !== "known" ||
        fact.evidence_ids.every((id) => evaluation.evidence_ids.includes(id)))
    );
  });
}
function routeSafe(
  route: RouteEstimate,
  request: RecommendationRequest,
): boolean {
  return (
    route.includes_return === request.return_to_origin &&
    route.transport === request.transport &&
    new Set(route.evidence.map((e) => e.id)).size === route.evidence.length &&
    (route.distance_meters === 0 || route.duration_seconds > 0) &&
    (route.method !== "approximate" ||
      (route.geometry === null && route.assumptions.length > 0))
  );
}
export function recommendationIntegrity(
  response: RecommendationResponse,
  request: RecommendationRequest,
): boolean {
  if (
    !same(response.request, request) ||
    !response.places.every(placeIntegrity)
  )
    return false;
  const places = new Map(response.places.map((p) => [p.id, p]));
  const ids = response.recommendations.map((r) => r.place_id);
  if (
    places.size !== response.places.length ||
    new Set(ids).size !== ids.length ||
    ids.length !== places.size ||
    ids.length > request.limit
  )
    return false;
  return response.recommendations.every((r, index) => {
    const place = places.get(r.place_id);
    return (
      place &&
      r.rank === index + 1 &&
      routeSafe(r.route, request) &&
      evaluationsSafe(place, r.constraint_evaluations, request) &&
      r.total_duration_seconds ===
        r.visit_duration_seconds + r.route.duration_seconds &&
      r.total_duration_seconds <= request.available_seconds
    );
  });
}
export function itineraryIntegrity(
  response: ItineraryResponse,
  request: ItineraryRequest,
): boolean {
  if (
    !same(response.request, request) ||
    !response.places.every(placeIntegrity)
  )
    return false;
  if (
    response.status === "no_match" ||
    response.status === "needs_clarification"
  )
    return (
      response.stops.length === 0 &&
      response.route === null &&
      response.places.length === 0 &&
      response.total_duration_seconds === 0
    );
  const places = new Map(response.places.map((p) => [p.id, p]));
  if (
    places.size !== response.places.length ||
    places.size !== request.place_ids.length ||
    !response.route ||
    !routeSafe(response.route, request)
  )
    return false;
  if (
    response.stops.length !== request.place_ids.length ||
    !response.stops.every((stop, index) => {
      const place = places.get(stop.place_id);
      return (
        place &&
        stop.place_id === request.place_ids[index] &&
        stop.order === index + 1 &&
        evaluationsSafe(place, stop.constraint_evaluations, request)
      );
    })
  )
    return false;
  return (
    response.total_duration_seconds ===
      response.route.duration_seconds +
        response.stops.reduce(
          (sum, stop) => sum + stop.visit_duration_seconds,
          0,
        ) && response.total_duration_seconds <= request.available_seconds
  );
}
