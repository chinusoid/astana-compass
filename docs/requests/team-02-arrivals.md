# Team 02: ordered route legs and arrival-time orchestration

Status: proposal for the coordinator; current v0.1 wire/ports are unchanged.

Current `RouteEstimate` has full-trip totals but no per-leg durations, and root
calls enrichment once at departure. Context computes `open_at_requested_time`
only for that request instant. It cannot honestly assert opening at the second
stop's arrival or throughout a visit from the total alone. A venue open at 12:00
may close before a 12:30 arrival. No private arrival fields were introduced.

Propose a coordinated contracts version `0.2.0`, after reviewing the weather
extension/versioning request. Add optional `legs` to canonical `RouteEstimate`,
an array of `RouteLeg {from: Location, to: Location, distance_meters: number>=0,
duration_seconds: integer>=0}` with `additionalProperties=false`, all four keys
required. For routed itineraries integrated with arrival checks, require exactly
N entries (N stops, plus one on return), exact requested endpoints/order, and
distance/duration totals equal to full-trip totals. Integer rounding must be
specified centrally (ceil each leg and sum, rather than ceil only the aggregate).
Keep approximate geometry null and state each leg's estimation method through
the parent route method/assumptions. No legs are emitted by Team 02 under v0.1.

Root can then compute each arrival as departure + previous route legs + previous
visit estimates, and call the same `enrich_places` port with one selected place
and a canonical request whose `start_at` is that arrival. This uses explicit
existing fields. Preserve all original IDs/order, never discard inconvenient
stops, and recheck required facts and total budget after the complete route.
Approximate legs must not claim verified deadline feasibility. Visit-through-
closing validation needs an explicit separate end-time/interval rule; checking
one arrival instant does not prove the whole visit fits opening hours.

Consumers: ContextProvider, DefaultRecommendationService itinerary and alternatives,
API/client schema generation, frontend timetable. Strict v0.1 readers reject
additional fields: root must negotiate/cut over versions and update generated
copies together. Do not deploy new fields to old validators. Existing start-time
calls continue to use v0.1 behavior until coordinated migration.

Acceptance: three ordered stops with asymmetric legs and return; a venue open at
departure but closed at arrival returns `no_match` without substitutes; arrival
across midnight uses Asia/Almaty; unknown/conflicting schedule fails required;
travel + visits + return fit the shared budget exactly; rounding cannot lose
seconds. Own module already checks exact provider segment count and full totals
internally, but exposing legs is blocked on contract acceptance.
