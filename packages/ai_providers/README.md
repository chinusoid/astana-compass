# astana-ai-providers

Optional async adapters implementing the recommender's `ExplanationGenerator`.
They select known fact references and a generic activity; the recommender renders
the actual explanation in `ru`, `kk`, or `en` and applies its own validation.
These are inference adapters, not a trained Astana model or an intent parser.

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

`query` is deliberately **not sent or directly interpreted**. A future intent
parser is a separate coordinated component; this adapter uses normalized
constraint evaluations. It does not send the place name, description, location,
source URLs, arbitrary fact strings/numbers, actual fact IDs, or evidence IDs.
This prevents coordinates embedded even in those fields from reaching the model.

The provider receives opaque `fact_N`/evidence tokens, fixed safe semantic labels,
boolean values where available, locale, and normalized constraint outcomes.
Unknown semantic labels become `other_confirmed_fact`. This conservative policy
limits semantic richness intentionally. Known input facts must have non-null
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
