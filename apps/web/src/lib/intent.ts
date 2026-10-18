import type { Constraint, IntentResponse } from "@astana/api-client";
import { ApiError } from "./api";
import { valid } from "./contracts";
import { constraintKeys, type Locale } from "./i18n";

export type IntentSelection = {
  constraints: Constraint[];
  available_seconds: number | null;
};

/** Intent is a proposal, never an authoritative source of facts or coordinates. */
export function intentIntegrity(
  response: IntentResponse,
  query: string,
  locale: Locale,
): boolean {
  return (
    response.locale === locale &&
    new Set(response.constraints.map((entry) => entry.constraint.key)).size ===
      response.constraints.length &&
    response.constraints.every(
      ({ constraint, source_quote }) =>
        constraintKeys.some((key) => key === constraint.key) &&
        constraint.value === true &&
        query.includes(source_quote),
    ) &&
    (response.available_seconds === null
      ? response.time_evidence === null
      : response.time_evidence !== null &&
        query.includes(response.time_evidence))
  );
}

export async function interpretIntent(
  query: string,
  locale: Locale,
  signal: AbortSignal,
): Promise<IntentResponse> {
  const body = { query: query.trim(), locale };
  if (!valid("IntentRequest", body)) throw new ApiError("invalid_request");
  let response: Response;
  try {
    response = await fetch("/api/v1/intent", {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
  if (!response.ok)
    throw new ApiError(
      response.status === 429 ? "rate_limited" : "provider_unavailable",
    );
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError("invalid_response");
  }
  if (
    !valid("IntentResponse", payload) ||
    !intentIntegrity(payload as IntentResponse, body.query, locale)
  )
    throw new ApiError("invalid_response");
  return payload as IntentResponse;
}

/** Explicit review can strengthen a preference but cannot lower an existing must-have. */
export function applyIntentConstraints(
  current: Record<string, "" | Constraint["strength"]>,
  suggested: Constraint[],
) {
  const result = { ...current };
  for (const constraint of suggested) {
    if (
      constraint.value === true &&
      constraintKeys.some((key) => key === constraint.key)
    )
      result[constraint.key] =
        current[constraint.key] === "required"
          ? "required"
          : constraint.strength;
  }
  return result;
}
