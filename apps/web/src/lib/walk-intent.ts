import type { IntentResponse, RecommendationRequest } from "@astana/api-client";

/** Text describes the walk. Inferred amenities remain preferences, never must-haves. */
export function applyWalkIntent(
  request: RecommendationRequest,
  intent: IntentResponse | null,
): RecommendationRequest {
  if (!intent || intent.locale !== request.locale) return request;
  const constraints = new Map(
    request.constraints.map((item) => [item.key, item]),
  );
  for (const { constraint } of intent.constraints) {
    if (!constraints.has(constraint.key))
      constraints.set(constraint.key, { ...constraint, strength: "preferred" });
  }
  return {
    ...request,
    available_seconds: intent.available_seconds ?? request.available_seconds,
    constraints: [...constraints.values()],
  };
}

/** Explicit return wording can be used without inventing a start or coordinates. */
export function textRequestsReturn(query: string): boolean {
  const mentions = [
    ...query.matchAll(
      /(?:верну(?:ться|сь|емся)|возвращени[ея]|return|back)\s+(?:обратно\s+)?(?:к\s+(?:началу|старту|исходной)|на\s+старт|to\s+(?:the\s+)?start)|бастапқы\s+нүктеге\s+орал|и\s+обратно/giu,
    ),
  ];
  const negated = mentions.some((match) =>
    /(?:\b(?:no need to|not|without|don't|do not)|(?:не|без)(?:\s+\S+){0,2})\s*$/iu.test(
      query.slice(Math.max(0, match.index! - 40), match.index),
    ),
  );
  return mentions.length > 0 && !negated;
}
