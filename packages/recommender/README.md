# Astana recommendation orchestration

Installable Python package, Python 3.12–3.14. The public entry point is
astana_recommender.DefaultRecommendationService(repository, retriever, context,
generator=None). Dependencies implement the async ports from astana_contracts.
Importing the package creates no clients, makes no requests and reads no secrets.

## Implemented behavior

- Validates requests, dependency boundaries and final responses against the
  canonical schema and invariants.
- Bounds retrieval candidates, context enrichment, provider timeouts and route
  concurrency. Preserves query relevance after required-condition checks, with
  broad source-category variety inside comparable lexical scores. Richer park
  descriptions cannot fill all discovery slots as separate waterfront and
  architecture themes while an equally relevant landmark is available.
  Strong literal matches retain priority. Preferences stay visible and do not override
  the user's destination intent. It never treats a retrieval score as a confidence probability.
- Checks every required condition after context enrichment using JSON equality:
  true is not the number 1. Unknown, absent and conflicting required facts exclude
  a place. Unmet preferences remain visible and produce a partial response.
- Requires valid route mode, return flag and complete travel plus visit time.
  The selected time is a preference: longer alternatives and complete selected
  itineraries remain visible with a localized duration/overrun warning and a
  partial status. Selected stops preserve their requested ID order.
- Explicit sequences such as `сначала кофе, потом парк`, `first coffee then
  park` and `алдымен кофе, содан кейін саябақ` retrieve each destination
  separately and return one distinct place per stage in that order (up to the
  requested limit of three). Two stages produce two stops. Ordinary mixed
  wishes retain normal relevance/diversity ranking. The same required-condition
  checks and soft time preference apply; no additional LLM parsing is used.
- A Botanical Garden plus food wish joined by `и`, `and` or `және` also forms
  two core stages: food before the named garden. Explicit order takes priority.
  Generic mixed wishes, negation and food searches near the landmark do not
  trigger this inference. The named garden must match a known source name or
  alias; another park cannot fill that stage. Pizza requires a known, cited
  cuisine value `pizza` or `italian_pizza` at a cafe or restaurant. A venue name
  or description alone cannot establish cuisine. The food shortlist accounts
  for the onward garden location using a geographic heuristic. Recommendation
  cards keep their routes from the original start; `build_itinerary` constructs
  the connected route in returned stage order. Two recommendation routes plus
  that itinerary use three route calls when the providers succeed.
- An empty, unmatched or unroutable sequence stage is disclosed as an
  incomplete plan, with its original stage number. Available stops remain a
  partial result; if none are available, the response needs clarification.
  A failed stage search never substitutes an arbitrary nearby place.
- Uses an explicit nearby-catalog fallback for ordinary requests if retrieval fails. Context failure
  invalidates request-time facts; static facts may still support a partial result.
  Route failure excludes a candidate rather than fabricating a path.
- Marks synthetic data, approximate routing, visit estimates, generator failure
  and an unconfigured language model. Error text never echoes provider exceptions.
- Returns Russian, Kazakh or English template explanations without credentials.
- Museum, art, architecture, historic/memorial and viewpoint categories receive
  distinct activities and grounded category explanations. Source names and
  descriptions cannot assign these categories or imply amenities or access.
- Explicit requests for less walking or a longer walk use an internal geographic
  heuristic within the top nine retrieved candidates, then rank returned options
  by their actual route distance. Only the usual returned alternatives are routed;
  no extra LLM calls are added. The heuristic is never displayed as a route.
  Conflicting or negated pace requests preserve normal relevance behavior.
  Ordered stages retain their requested order; an explicit pace preference
  selects within each stage using the previous chosen stop as its geographic
  anchor. Only chosen stops are routed, with no claim of a globally shortest
  path. Durations remain a soft preference.

The default visit estimate is 1,200 seconds. A positive integer source fact named
visit_duration_seconds can override it. Durations are not shortened simply to fit
a time budget. The value remains explicitly labelled as an estimate.

## Optional generation

An ExplanationGenerator implements:

    async def generate(*, locale, query, place, constraint_evaluations):
        return GroundedExplanation(
            why=(GroundedReason("indoor", ("evidence:id",)),),
            suggested_activity="observe",
        )

The generator receives the public place but no private origin or entire request.
Reasons reference existing known fact keys and exactly their evidence IDs.
Activities are observe, explore or take_break. The service renders actual values
in the selected language. Arbitrary generated factual prose is deliberately not a
supported output: an existing citation cannot make an invented claim trustworthy.
Invalid output or a timeout falls back to the data template. Provider adapters
are separate from this package.

## Configuration and errors

Keyword-only settings: candidate_limit=24, radius_meters=10000,
timeout_seconds=8, default_visit_seconds=1200, route_concurrency=4, clock=None.
The injected clock must return a timezone-aware datetime.

Each external call has its own timeout; route calls run in bounded batches no
larger than the number of remaining result slots and stop once enough valid
recommendations are found. Explanations are generated only for returned places.
The package does not promise
an overall HTTP latency SLA. The API layer should impose its own total deadline.
Cancellation propagates normally.

Invalid input raises astana_contracts.ContractValidationError. An unsupported
transport raises RecommenderError with code unsupported_transport and a safe
localized message. Dependency failures normally become a canonical no_match or
partial response with warnings. The initial service supports walking only.

## Checks

From the repository root after workspace installation:

    python -m unittest discover -s packages/recommender/tests -v

Or:

    pytest packages/recommender/tests

The tests use explicitly synthetic local ports. Named garden and food regressions
also exercise the checked-in 628-place OSM snapshot with local lexical retrieval;
their route provider remains synthetic and makes no network requests.
They exercise required/preferred
semantics, unknown/conflicting facts, dynamic enrichment, bool/number equality,
source references, budgets and return trips, itinerary order, timeouts,
cancellation, invalid provider output, generator grounding and all three locales.
They do not claim to verify real POI, live routes, model providers, opening-hours
truth, route geometry continuity or retrieval quality.

## Current limits

Request-time opening facts are supplied by city_context. This package does not
derive arrival-time schedules or weather facts on its own. The current route DTO
has a total duration rather than per-leg arrival times; a future canonical
extension is needed for arrival-aware itinerary schedule guarantees. The service
does not parse additional hard constraints out of free text: the API/input layer
must make such constraints explicit in the canonical request.
