# Context integration verification

The coordinator integrated Team 02 PR #3, based on
`8b44243ac399b3d38a303b0fc51951fa7bc6c252`, into the locked workspace and API
runtime dependencies. The original author commit is retained in history.

## Review fixes

- Replacing a day's normal opening hours also removes its old overnight
  continuation. A venue with `Mo 22:00-02:00; Mo 10:00-12:00` is no longer
  treated as open at Tuesday 01:00. Weekly and date-specific cases are tested
  through the schedule parser and real recommender.
- Routing rejects zero-distance legs between different requested points and
  distances materially below the straight-line minimum between those points.
  Invalid results use the configured explicit approximation or fail in strict
  mode. The existing 2%/10 m numerical tolerance and 100 m snap radius remain;
  this does not prove access from the road graph to each entrance.
- Provider HTTP requests require identity encoding. Compressed responses are
  rejected before body consumption, and raw response chunks are bounded before
  appending. Offline compressed-response tests cover this boundary.
- The foundation retrieval fixture now validates its response and asserts that
  the recommender did not silently fall back to repository candidate selection.

## Local verification

On Python 3.12.15, with no hosted provider requests or credentials:

```sh
uv sync --locked --all-packages
uv run pytest
uv run python verify_contracts.py
uv run python scripts/generate_contracts.py --check
uv run ruff check .
uv lock --check
python -m build packages/city_context
git diff --check
```

Results: 422 tests and 54 subtests passed; 25 contract cases and 4 generated
artifacts verified; Ruff, lock and whitespace checks passed; wheel and sdist
built. The existing Starlette/httpx deprecation warning remains. The context
factory was created and closed successfully without external requests.

Root pytest discovery now includes context tests in both Python 3.12 and 3.14
CI jobs. Container CI additionally constructs and closes the installed context
factory without source checkout imports or provider calls. Docker runtime
validation runs in CI because the local daemon socket is not accessible.

## Remaining boundaries

Fixture mode still uses synthetic data and routes. Live mode needs Team 01's
real repository and retrieval packages. Real ORS service validation requires a
privately configured backend key; none was supplied for this verification.
Weather is internal and disabled by default. Opening is checked at the supplied
instant, not at future arrival times or throughout a visit. The proposed weather
and arrival-time wire contract changes remain separate, unaccepted proposals.
