# astana-ai-providers

Optional async adapters implementing the recommender's `ExplanationGenerator`.
They select known fact references and a generic activity; the recommender renders
the actual explanation in `ru`, `kk`, or `en` and applies its own validation.
`IntentAnalyzer` also extracts reviewable preferences through local rules and
optional hosted extraction. Neither adapter is a trained Astana model.

`JourneyPlanner` separately interprets the complete outing scenario into the
canonical `JourneyPlan`, before the recommender retrieves real places. Its
semantic activities are open ended: normalized search phrases are not vetoed
by the intent review screen's finite amenity/category vocabulary.

```python
from astana_ai_providers import create_journey_planner

async with create_journey_planner(
    provider="openai", model="gpt-6-luna", api_key=server_side_key,
    budget=shared_llm_request_budget,
) as planner:
    journey = await planner.plan(user_query, "ru")
```

The planner sends only `query` and `locale` in one bounded hosted request. It
does not receive coordinates, history, POIs or database facts. OpenAI uses
Responses with `store: false`, the canonical schema specialized for that
provider, strict structured output, a ten-second deadline and at most 4096
output tokens. The exact `gpt-6-luna` journey model uses `reasoning.effort: low`
to allow more interpretation work within that bounded request. The existing
fixed-endpoint HTTP transport enforces response size, identity encoding,
refusal/tool rejection and the shared request quota.
NVIDIA retains its seven-second/3072-token JSON response path and the same local
validation. Intent review and explanation selection keep their existing Luna
`none` reasoning setting. Construction and rules mode make no network request.

Hosted journey failures emit one warning with a fixed failure category, provider,
validated HTTP status integer and elapsed milliseconds. Categories distinguish
timeouts, HTTP rejection, local quota, schema and grounding failures. These
diagnostics contain no query, coordinates, model output, provider body, credential
or exception text. Cancellation propagates without becoming a fallback warning;
no retries or extra provider calls are added.

Each independent concrete goal gets a separate ordered stage, with an exact
`source_quote` and a normalized `search_query`. Names must be literal excerpts
of that stage's quoted user text; cuisine identifiers describe a requested
food, never a confirmed venue menu. A single concrete goal produces one stage.
Semantic `categories` are source category search filters: reading can request
`library`, buying books `bookshop`, and swimming `swimming_pool`. These tokens
are not limited to a finite list of activities and cannot establish that a
matching venue exists. Strict provider schemas require every stage property,
including `categories`, while the public schema keeps that field optional for
older adapters.
Exact multilingual generic labels such as `торговый центр`, `shopping mall`
and `сауда орталығы` become category `mall` with no proper-name filter.
`shopping_mall` is normalized to the source category `mall`; true compound
proper names remain literal source excerpts. This small type ontology does
not veto unknown category tokens or claim that a matching venue exists.
`botanical_garden` expands to the existing source group `park`/`garden`;
strict aliases such as `art_gallery` and `movie_theater` map to `gallery` and
`cinema`. Expansion never silently discards other unknown type filters.
For a true named destination, incidental category hints are cleared only when
the text outside its exact name contains solely visit/order/preposition filler.
Independent wording such as `cafe Mega` or `watch a movie at MEGA` keeps its type
constraint. Generic type-only labels keep their category constraints as well.
A broad discovery walk can keep `stages: []` to allow diverse recommendations.
Explicit sequences take precedence over suggested logical ordering, while
unsupported or ambiguous wishes remain visible as `unresolved` stages with a
clarification question. Venue selection and source-backed name/cuisine checks
belong to retrieval, after planning.

Missing configuration, provider failure or invalid output returns a visibly
limited local fallback. It separates ordinary clauses and conjunctions without
special treatment for a named destination or cuisine; uncertain relative order
and long fragments remain unresolved. A generic meal-first suggestion applies
only to unordered wishes; explicit sequences remain intact. Local validation rejects invented source
quotes/names, cropped negation, omitted independent lexical clauses, duplicate
stages and extra fields. Distinct clauses require distinct source-bound stages;
a shared verb cannot cover another goal, and a whole-query quote cannot hide
merged goals. Grounded plausible or quoted proper names can retain internal
conjunctions. Simple before/after dependencies are checked separately from
first/then sequence groups; ambiguous relative clauses need clarification in
the affected stage. These checks establish text provenance and basic
coverage, not proof that arbitrary semantics were understood correctly. The
fallback and planner warnings are intended to remain visible to users. Neither
mocked tests nor a well-formed plan establish live model quality or POI coverage.

Standalone negative clauses are copied into every stage's retrieval phrase in
both hosted and rules modes, preserving global exclusions after decomposition.
If the 300-character search bound cannot retain all exclusions, that stage
becomes unresolved and asks for clarification. Spelled-out duration budgets,
companions and basic mobility context do not become extra stops.

For an unambiguous pair, `по пути`, `on the way`, `en route` and `жолай`
place the intermediate stop before the final destination even when the final
destination is mentioned first. Hosted output is checked against that source
relation, and local fallback handles ordinary two-clause pairs without a
venue-specific branch. Conflicting first/then instructions and ambiguous
chains retain unresolved stages and ask for clarification. Markers inside a
grounded or quoted proper name do not create a route dependency.

```python
import os
from astana_ai_providers import create_generator

generator = create_generator(
    provider=os.environ["LLM_PROVIDER"],       # openai or nvidia
    model=os.environ["LLM_MODEL"],             # no default model ID
    api_key=os.environ["OPENAI_API_KEY"],      # use NVIDIA_API_KEY for nvidia
    timeout_seconds=6.0,
    max_response_bytes=65_536,
    max_output_tokens=512,
)
try:
    result = await generator.generate(
        locale="ru", query=user_query, place=validated_place,
        constraint_evaluations=validated_evaluations,
    )
finally:
    await generator.aclose()
```

Exact factory:

```python
create_generator(
    provider: Literal["openai", "nvidia"], model: str, api_key: str, *,
    timeout_seconds: float = 6.0,
    max_response_bytes: int = 65_536,
    max_output_tokens: int = 512,
    transport: httpx.AsyncBaseTransport | None = None,
) -> HostedExplanationGenerator
```

The object also supports `async with`. Construction makes no network request.
The server owns lifecycle and supplies secrets from environment; this package
does not read environment, choose a model, or configure the API service.
Its default deadline is below the recommender's current 8-second deadline.
No automatic retries are made, avoiding duplicate paid calls. `transport` permits
offline `httpx.MockTransport` tests. Endpoints are fixed, redirects disabled, and
environment proxies are not used (`trust_env=False`).

## Provider contracts

- OpenAI: `POST https://api.openai.com/v1/responses`, `text.format` with a strict
  JSON schema, configured model, `store: false`, bounded `max_output_tokens`.
  Only completed responses with exactly one output-text item are accepted;
  refusals, tools, failed/incomplete output and malformed envelopes are rejected.
  The selected model must support Responses structured outputs.
  For the exact configured ID `gpt-6-luna`, both explanations and intent
  extraction explicitly use `reasoning: {"effort": "none"}` to retain the
  short deadline and small JSON output limits. This is an application latency
  choice: [GPT-6 Luna supports `none` and otherwise defaults to `medium`](https://developers.openai.com/api/docs/models/gpt-6-luna).
  Other model IDs retain their previous settings; no sampling or Chat
  Completions token parameters are added to OpenAI requests.
- NVIDIA hosted: `POST https://integrate.api.nvidia.com/v1/chat/completions`,
  configured model, system/user messages, `stream: false`, bounded `max_tokens`.
  The default asks for plain JSON in the prompt and **does not send
  `response_format`**, because capability is model-specific. The same strict
  local validation always applies. Only a single assistant choice with
  `finish_reason: stop` is accepted; refusals and tool calls are rejected.

Official references checked before implementation:
[OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)
and [NVIDIA hosted LLM APIs](https://docs.api.nvidia.com/nim/reference/llm-apis).
Configured model availability and account access still need a live check.

## Grounding and privacy boundary

The explanation adapter never sends the raw `query`. It derives only eight closed
interest hints locally (nature, architecture, history, coffee, river, photos,
short_walk, long_walk) and filters source categories to a closed taxonomy.
These hints are preferences and categories, never evidence for a venue amenity.
It also uses normalized constraint evaluations. It does not send the place name, description, location,
source URLs, arbitrary fact strings/numbers, actual fact IDs, or evidence IDs.
This prevents coordinates embedded even in those fields from reaching the model.

The provider receives opaque `fact_N`/evidence tokens, fixed safe semantic labels,
boolean values where available, locale, normalized constraint outcomes, and the
closed category/interest hints. Unknown semantic labels are omitted.
Known input facts must have non-null
values and references to evidence actually present in the place. Unknown and
conflicting facts never enter the selection whitelist.

Output contains at most eight reasons, each selecting one whitelist token with
the exact complete citation set; aliases are mapped back locally to immutable
`GroundedReason` objects. Duplicates, extra fields, unsupported activities,
unrecognized references, missing citations, invalid/duplicate-key JSON and
unrestricted prose are rejected. Activities are only `observe`, `explore` and
`take_break`. If there are no known facts, the adapter returns an empty explanation
without calling the provider. This is not a claim that every source fact is true:
data provenance and freshness remain the upstream responsibility.

HTTP requests require identity encoding; nonidentity encoded responses are
rejected before reading. Network bodies are read as raw bytes with a cap and an
overall deadline, preventing decompression bombs from bypassing the size limit.
Preloaded custom test-transport responses are also size-checked. `ProviderError`
contains only provider, a fixed code, retryability and optional HTTP status, never
the provider body, request, key, query or user location. The recommender can catch
it and use its deterministic explanation fallback. No internal chain of thought
is returned. Do not enable third-party HTTP wire/body logging in production.

## Verification

From the configured workspace environment:

```sh
python -m pytest packages/ai_providers/tests
```

Tests use `httpx.MockTransport`: no keys or paid/live API calls are required.
They check both payloads, privacy, exact citations, malformed/refused/incomplete
outputs, HTTP/network errors, time/size limits, cancellation and lifecycle.
Live provider behavior and model capability are not established by mocked tests.
