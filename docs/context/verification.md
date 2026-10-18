# Team 02 verification record

Checked 2026-10-19 on Linux, CPython 3.12.15. Initial upstream SHA:
`9a9747309941e7ea5ff9c338b695e2605ccbef73`. Before publication, the unpushed branch
was advanced to `7258917c3a5a81717639ee3d8abf2588d253f131` (foundation PR #2),
and compatibility was rechecked. No coordinator/shared files were changed.

## Environment and offline checks

From repository root, using an isolated environment outside the checkout:

```sh
UV_PROJECT_ENVIRONMENT=../.foundation-venv uv sync --locked --all-packages --python 3.12
uv pip install --python ../.foundation-venv/bin/python --no-deps -e packages/city_context
../.foundation-venv/bin/python -m pytest packages/city_context/tests \
  packages/contracts/tests packages/recommender/tests packages/ai_providers/tests tests/integration
../.foundation-venv/bin/python verify_contracts.py
../.foundation-venv/bin/python scripts/generate_contracts.py --check
../.foundation-venv/bin/ruff check .
../.foundation-venv/bin/python -m build packages/city_context --outdir ../dist-context
git diff --check
```

Actual outcomes:

| Check | Result |
|---|---|
| Context module (including optional synthetic foundation integration) | 213 passed |
| Context plus all existing Python suites on updated upstream | 385 passed; 54 subtests passed |
| Canonical schemas and positive/negative examples | 25 cases passed |
| Generated copies | 4 artifacts verified; no drift |
| Ruff, entire repository | Passed |
| Whitespace/diff check | Passed |
| Isolated package build | sdist and wheel built successfully |

The foundation's currently locked Starlette emits one deprecation warning about
its `httpx` TestClient integration; tests pass. No shared dependency was changed
to suppress it. No new tests were added to coordinator-owned directories. Root
test discovery does not yet include context until the integration request merges;
the commands above include its tests explicitly.

Offline tests cover multiple schedules/intervals, overnight and date exceptions,
invalid dates/offsets, unavailable and conflicting evidence, immutable inputs,
three locales, whole ordered walking routes and return, malformed/missing geometry
and legs, exact walking profile, provider timeout/quota/age, copy-safe cache/pace,
weather units/model semantics/staleness and cancellation-safe HTTP shutdown.

## Synthetic integration and real local startup

Nine module-owned integration tests exercise real `CityContext`, the foundation
factory signature validation/resource ownership, real recommender final policy
and HTTP itinerary endpoint. Data and route ports are explicitly synthetic:
these tests are not observations of real venues or ORS responses. Unknown dynamic
required facts become known after enrichment; unknown schedules remain excluded.
A model-shortcut prompt cannot reorder/drop selected stops. A full trip over the
budget returns `no_match` without a shortened plan.

Started the actual uvicorn app on an unused loopback port with
`ASTANA_MODE=fixture LLM_PROVIDER=none`, disabled access logs, and ran the current
`scripts/smoke.py --base-url http://127.0.0.1:8767`: **8/8 checks passed**, with
canonical validation enabled. `/sandbox` returned HTTP 200. This is the existing
synthetic foundation mode, not a live city integration. Owned test servers were
stopped after verification.

A separate actual `ASTANA_MODE=live` startup returned liveness 200 and readiness
503 because data/search factories are absent. No synthetic substitution occurred.
The context factory itself loads, passes the updated root port validation and
closes correctly, as verified independently with synthetic injected data ports.

## Live provider status and remaining coordination

`python -m astana_city_context.smoke` exits 1 with:
`Live ORS smoke blocked: configure backend ROUTING_API_KEY (or ORS_API_KEY).`
Neither backend variable is present in this environment. No hosted walking call
was made; no real geometry/provider connectivity or provider credentials were
verified. The owner must configure a permitted ORS backend credential privately
and run the documented smoke. It uses fixed public landmark-area coordinates,
never a user's precise location, and requires a complete routed return trip.

Hosted weather remains disabled; no live weather request was made. The operator
must select a permitted usage mode before enabling free noncommercial Open-Meteo.
Its official docs/terms and current rendered HeiGIT plans/terms were checked;
source links and attribution are in the respective provider policy documents.

Pending coordinator requests: workspace/lock/test-discovery integration,
versioned weather schema, and route-leg/arrival-time orchestration. The module
does not emit unapproved weather/arrival fields. Source schedules are checked at
the provided request instant; this does not establish actual operation at a
later stop arrival or through its visit. Required constraints and final full-trip
budget remain the real recommender's responsibility. Only ORS is a concrete live
routing adapter in this change; alternative ports can be injected, and the local
approximate calculator is explicitly separate from routed results.
