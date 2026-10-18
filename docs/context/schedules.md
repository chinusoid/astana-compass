# Schedule enrichment

`enrich_schedule(place, *, at: datetime, locale)` returns a canonical derived
`PlaceFact` and warnings. The factory's provider copies each input place, replaces
any prior `open_at_requested_time`, and validates the resulting `ContextResult`.
No place, source schedule, evidence record or retrieval timestamp is mutated.
The source is a string fact named `opening_hours`; supporting evidence IDs remain
those of that fact. The helper performs no network requests or LLM calls.

An aware instant is converted with Python `zoneinfo.ZoneInfo("Asia/Almaty")` before
evaluation. Naive/invalid datetimes and unsupported locales are rejected. Locale
is `ru`, `kk` or `en`; notes and warnings are provided in all three languages.
Schedule interval starts are inclusive, ends exclusive; seconds are respected.

## Implemented syntax

The parser implements a conservative subset of the [OSM opening-hours
specification](https://wiki.openstreetmap.org/wiki/Key:opening_hours/specification)
(consulted 2026-10-19). It does not claim full OSM grammar compatibility.

| Form | Synthetic example |
| --- | --- |
| Weekly range/list, including wrapping weekday ranges | `Mo-Fr 09:00-18:00; Sa,Su 10:00-14:00` |
| Multiple intervals within one day | `Mo-Fr 09:00-12:00,13:00-18:00` |
| Overnight end before start | `Fr,Sa 22:00-02:00` |
| End of day | `Mo 00:00-24:00` |
| Continuous operation | `24/7` |
| All-day closure | `Su off` or `Su closed` |
| Timed closure | `24/7; Mo 12:00-14:00 off` |
| Explicit date exception | `24/7; 2026 Oct 19 off` |
| Annual date exception | `24/7; Dec 25 off` |
| Date-specific hours | `Mo-Su 09:00-18:00; 2026 Oct 19 12:00-14:00` |

Date selectors may be followed by a weekday selector. An optional readability
colon is supported after a selector; `open` may follow a time interval. Unselected
weekdays default to closed. `open` alone means all day. A later semicolon-separated
opening rule replaces the earlier hours on its selected day; closure rules cut
out only their selected intervals. An overnight interval remains effective in the
following morning unless a later applicable rule replaces/cuts it. For example,
`Fr 22:00-02:00; Sa 10:00-12:00` closes the early Saturday spillover, following OSM
normal-rule semantics. Use one comma-separated interval list for split hours.

## Explicit uncertainty

Missing/unknown source facts remain unknown with null value and no evidence claim.
Conflicting source facts remain conflicting, retaining at least two source IDs;
neither status becomes false. Known derived values always cite the source schedule.
Dangling/missing supporting evidence cannot produce known values.

Any unsupported or invalid rule makes the entire result unknown, including when
an earlier rule says `24/7`. This deliberately avoids overconfident partial parsing.
`PH` and `SH` always remain unknown because no authoritative Kazakhstan public or
school holiday calendar is integrated. Other unsupported forms include natural
language, comments/appointment restrictions, fallback `||`, additional comma
**rules**, date ranges, month ranges, ISO numeric dates, nth weekdays, solar times,
open-ended times, times beyond 24:00, repeated events, and zero-length intervals.
The accepted source text is bounded to 8192 characters and 128 rules.

“Open according to published hours” does not confirm actual operation today.
Temporary closure, stale source hours and exceptional events may be absent from
the source. The source's `retrieved_at` is preserved and never presented as a check
of the venue's actual schedule. The computed request instant appears in the note,
not in a fabricated evidence record.

This enrichment checks the **requested start instant** only. Arrival times at
successive itinerary stops and remaining open time for a visit require coordinator
orchestration after full routing; there are no hidden arrival fields or implied
opening guarantees for the whole visit.

## Verification

Run `python -m pytest packages/city_context/tests/test_schedules.py` in the isolated
module development environment described in the context README. All fixtures are
explicitly synthetic; passing tests do not validate any real venue schedule.
