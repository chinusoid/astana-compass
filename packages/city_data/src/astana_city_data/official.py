"""Bounded, reviewed editorial supplements; offline only, never a general web scraper.

The private import format is not a second Place DTO. Every output and retained
base record is checked against the canonical contract. Sources are exact pages,
identities are exact OSM IDs/names/coordinates, and every assertion cites a page.
"""
from copy import deepcopy
from datetime import timedelta
import re

from astana_contracts import validate_payload

from .common import DataError, canonical, coordinates, digest, instant, utcnow

FORMAT = "astana-official-supplement-v1"
POLICY = "reviewed-exact-osm-identity-v1"
USAGE = "Paraphrased factual editorial notes; source text and images are not redistributed."
MAX_BYTES = 256 * 1024
MAX_PLACES = 20
# Adding a page requires a code/data review; redirects, arbitrary URLs and URLs
# supplied by a request can never become trusted evidence through this importer.
PAGES = {
    "botsad-about": ("Астанинский ботанический сад", "https://www.astanabotsad.kz/ru/o-nas"),
    "botsad-contacts": ("Астанинский ботанический сад", "https://www.astanabotsad.kz/ru/kontakty"),
    "visit-central": ("Visit Astana", "https://visitastana.kz/ru/about-city/what-to-see/tsentralnyy-park/"),
    "visit-parks": ("Visit Astana", "https://www.visitastana.kz/kz/about-city/top/top-5-parkov/"),
    "gov-bridge": ("Акимат Астаны", "https://www.gov.kz/memleket/entities/astana/press/news/details/339556?lang=ru"),
    "gov-river-walk": ("Министерство обороны РК", "https://www.gov.kz/memleket/entities/mod/press/news/details/766669?lang=ru"),
    "visit-museum": ("Visit Astana", "https://www.visitastana.kz/ru/about-city/what-to-see/natsionalnyy-muzey-respubliki-kazakhstan/"),
    "opera-about": ("Астана Опера", "https://astanaopera.kz/ru/about-us"),
    "visit-arch": ("Visit Astana", "https://visitastana.kz/ru/about-city/what-to-see/triumfalnaya-arka-m-gilik-el9679/"),
    "visit-jetisu": ("Visit Astana", "https://visitastana.kz/ru/about-city/what-to-see/park-zhetysu/"),
    "visit-korean": ("Visit Astana", "https://visitastana.kz/ru/about-city/what-to-see/koreyskiy-sad-druzhby-/"),
    "visit-triathlon": ("Visit Astana", "https://visitastana.kz/ru/about-city/what-to-see/triatlon-park-astana/"),
    "visit-zheruyyk": ("Visit Astana", "https://visitastana.kz/ru/about-city/what-to-see/park-zheruyyk/"),
    "museums-atameken": ("Дирекция музеев города Астаны", "https://astanamuseums.kz/news/28-avgusta-6-osobennostej-etno-memorialnogo-kompleksa-karta-kazahstana-atameken"),
    "museum-contacts": ("Национальный музей Республики Казахстан", "https://nmrk.kz/ru/about-museum/contacts/"),
    "opera-contacts": ("Астана Опера", "https://astanaopera.kz/en/contacts"),
}
# A tourist publication is evidence, not automatically the venue's own website.
# Operator links are reviewed separately and must be supported by that operator.
OPERATOR_WEBSITES = {
    "https://www.astanabotsad.kz/": frozenset({"botsad-about", "botsad-contacts"}),
    "https://nmrk.kz/": frozenset({"museum-contacts"}),
    "https://astanaopera.kz/": frozenset({"opera-about", "opera-contacts"}),
}
BOOL_KEYS = frozenset({
    "free_entry", "has_wifi", "toilets", "wheelchair_accessible", "indoor",
    "official:walking_paths", "official:cycle_paths", "official:running_paths",
    "official:playground", "official:fountains", "official:greenhouse",
})
TEXT_KEYS = frozenset({
    "opening_hours", "official:waterfront", "official:greenhouse_hours", "official:greenhouse_entry_hours",
    "official:architecture", "official:visitor_note", "official:published_hours",
    "official:address", "official:ticket_office_hours",
    *(f"official:description:{lang}" for lang in ("ru", "kk", "en")),
})
LIST_KEYS = frozenset({"official:highlights", *(f"official:aliases:{lang}" for lang in ("ru", "kk", "en"))})


def _text(value, maximum=2000):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= maximum and not any(
        ord(char) < 32 and char not in "\n\t" for char in value)


def validate_bundle(bundle, *, clock=utcnow):
    """Validate the reviewed notes, not the truth or current availability of a venue."""
    if (not isinstance(bundle, dict) or set(bundle) != {"format", "identity_policy", "sources", "places"}
            or bundle["format"] != FORMAT or bundle["identity_policy"] != POLICY
            or len(canonical(bundle)) > MAX_BYTES
            or not isinstance(bundle["sources"], dict) or not 1 <= len(bundle["sources"]) <= len(PAGES)
            or not isinstance(bundle["places"], list) or not 1 <= len(bundle["places"]) <= MAX_PLACES):
        raise DataError("Invalid official supplement")
    for key, source in bundle["sources"].items():
        if (key not in PAGES or not isinstance(source, dict)
                or set(source) != {"source_name", "source_url", "retrieved_at", "access_method", "usage", "review_note"}
                or (source["source_name"], source["source_url"]) != PAGES[key]
                or source["access_method"] not in {"reviewed-web-index", "reviewed-public-page"}
                or source["usage"] != USAGE or not _text(source["review_note"])
                or instant(source["retrieved_at"]) > clock() + timedelta(minutes=5)):
            raise DataError("Invalid official source provenance")
    seen, used = set(), set()
    for entry in bundle["places"]:
        if (not isinstance(entry, dict) or set(entry) != {"place_id", "osm_name", "location", "identity_note", "facts"}
                or not isinstance(entry["place_id"], str)
                or not re.fullmatch(r"osm:(node|way|relation)/[1-9][0-9]*", entry["place_id"])
                or entry["place_id"] in seen or not _text(entry["osm_name"], 512)
                or not coordinates(entry["location"]) or not _text(entry["identity_note"])
                or not isinstance(entry["facts"], list) or not 1 <= len(entry["facts"]) <= 40):
            raise DataError("Invalid official place identity")
        seen.add(entry["place_id"])
        claims = set()
        for fact in entry["facts"]:
            if (not isinstance(fact, dict) or set(fact) != {"key", "value", "sources", "note"}
                    or not isinstance(fact["key"], str) or not _text(fact["note"])
                    or not isinstance(fact["sources"], list) or not 1 <= len(fact["sources"]) <= 4
                    or any(not isinstance(s, str) or s not in bundle["sources"] for s in fact["sources"])
                    or len(set(fact["sources"])) != len(fact["sources"])):
                raise DataError("Invalid official fact provenance")
            key, value = fact["key"], fact["value"]
            valid = ((key in BOOL_KEYS and type(value) is bool)
                     or (key in TEXT_KEYS and _text(value))
                     or (key in LIST_KEYS and isinstance(value, list) and 1 <= len(value) <= 12
                         and all(_text(v, 300) for v in value) and len(set(value)) == len(value))
                     or (key == "official:opened_year" and type(value) is int and 1000 <= value <= clock().year))
            if key == "official:website":
                valid = isinstance(value, str) and bool(
                    OPERATOR_WEBSITES.get(value, frozenset()).intersection(fact["sources"]))
            elif key == "official:phone":
                valid = (isinstance(value, str) and bool(re.fullmatch(r"\+[0-9 ()-]+", value))
                         and 7 <= sum(char.isdigit() for char in value) <= 15)
            identity = (key, tuple(sorted(fact["sources"])))
            if not valid or identity in claims:
                raise DataError("Invalid or duplicate official claim")
            claims.add(identity)
            used.update(fact["sources"])
    if used != set(bundle["sources"]):
        raise DataError("Unused official source")
    return bundle


def _merge(place, claim, evidence_ids):
    key, value = claim["key"], claim["value"]
    fact = {"key": key, "status": "known", "value": deepcopy(value), "evidence_ids": evidence_ids,
            "note": claim["note"] + " Source claim; retrieval is not a field verification."}
    # Keep each claim separately as well as the effective fact. Conflicting
    # assertions must stay visible and must never satisfy a required constraint.
    claim_key = "official:claim:" + digest(claim)[:16]
    place["facts"].append({**deepcopy(fact), "key": claim_key})
    existing = next((f for f in place["facts"] if f["key"] == key), None)
    if existing is None:
        place["facts"].append(fact)
    elif existing["status"] == "unknown":
        place["facts"][place["facts"].index(existing)] = fact
    elif existing["status"] == "known" and existing["value"] == value:
        existing["evidence_ids"] = sorted(set(existing["evidence_ids"] + evidence_ids))
    else:
        if existing["status"] == "known":
            place["facts"].append({**deepcopy(existing), "key": "source:prior:" + key})
        existing.update(status="conflicting", value=None,
                        evidence_ids=sorted(set(existing["evidence_ids"] + evidence_ids)),
                        note="Sources disagree. Individual source assertions are retained; do not treat as confirmed.")


def enrich(places, bundle, *, clock=utcnow):
    bundle = validate_bundle(bundle, clock=clock)
    entries = {entry["place_id"]: entry for entry in bundle["places"]}
    available = {place["id"]: place for place in places}
    if not set(entries) <= set(available):
        raise DataError("Official supplement identity is absent from the selected OSM snapshot")
    result, base = deepcopy(places), []
    for place in result:
        entry = entries.get(place["id"])
        if entry is None:
            continue
        validate_payload("Place", place)
        if (place["name"] != entry["osm_name"] or place["location"] != entry["location"]
                or any(e["source_type"] == "official" for e in place["evidence"])
                or any(f["key"].startswith(("official:", "source:prior:")) for f in place["facts"])):
            raise DataError("Official supplement identity changed or was already applied")
        base.append(deepcopy(place))
        source_ids = sorted({s for fact in entry["facts"] for s in fact["sources"]})
        for source_id in source_ids:
            source = bundle["sources"][source_id]
            place["evidence"].append({"id": "official:" + source_id, "source_type": "official",
                "source_name": source["source_name"], "source_url": source["source_url"],
                "source_record_id": source_id, "retrieved_at": source["retrieved_at"], "is_synthetic": False})
        for claim in entry["facts"]:
            _merge(place, claim, ["official:" + s for s in sorted(claim["sources"])])
        description = next((f for f in place["facts"] if f["key"] == "official:description:ru"
                            and f["status"] == "known"), None)
        if description:
            # Old OSM/Wikidata text and base metadata remain intact in the source
            # facts and manifest; the display fallback explicitly identifies this synopsis.
            place["description"] = description["value"]
            place["facts"] = [f for f in place["facts"] if f["key"] not in {"description:source", "description:language"}]
            for key, value in (("description:source", "official"), ("description:language", "ru")):
                place["facts"].append({"key": key, "status": "known", "value": value,
                    "evidence_ids": description["evidence_ids"], "note": "Reviewed factual synopsis of the cited official pages."})
        validate_payload("Place", place)
    report = {"format": FORMAT, "identity_policy": POLICY, "bundle_sha256": digest(bundle),
              "bundle": deepcopy(bundle), "base_places": base, "place_count": len(base)}
    return result, report


def expected_records(report, *, clock=utcnow):
    """Rebuild declared enrichment at load time, rejecting undeclared changed facts."""
    if (not isinstance(report, dict)
            or set(report) != {"format", "identity_policy", "bundle_sha256", "bundle", "base_places", "place_count"}
            or report["format"] != FORMAT or report["identity_policy"] != POLICY
            or not isinstance(report["base_places"], list) or not 1 <= len(report["base_places"]) <= MAX_PLACES
            or type(report["place_count"]) is not int or report["place_count"] != len(report["base_places"])
            or report["bundle_sha256"] != digest(report["bundle"]) or len(canonical(report)) > 1024 * 1024):
        raise DataError("Invalid official supplement manifest")
    places, rebuilt = enrich(report["base_places"], report["bundle"], clock=clock)
    if rebuilt != report or len({p["id"] for p in places}) != len(places):
        raise DataError("Official supplement manifest cannot be replayed")
    return {place["id"]: canonical(place) for place in places}
