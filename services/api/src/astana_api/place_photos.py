"""Attributed Commons photographs linked by existing, evidenced OSM Wikidata IDs.

No image search by name, arbitrary URL fetching, image proxying or 2GIS storage.
The only stored provider data is a bounded, in-memory Commons metadata cache.
API references: https://www.mediawiki.org/wiki/Wikibase/API and
https://www.mediawiki.org/wiki/API:Imageinfo. Each file keeps its own licence.
"""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from copy import deepcopy
from html.parser import HTMLParser
import re
import time
import unicodedata
from urllib.parse import urlsplit, urlunsplit

from astana_city_context.common import JsonHTTP, ProviderError

WIKIDATA_ENDPOINT = "https://www.wikidata.org/w/api.php"
COMMONS_ENDPOINT = "https://commons.wikimedia.org/w/api.php"
# Exact IDs already joined by the reproducible catalogue import. Extending this
# list requires an evidenced catalogue identity, not a guessed name match.
SUPPORTED_PLACES = {
    "osm:way/69232075": "Q104866925",  # Jetisu Park
    "osm:way/1196402246": "Q104866948",  # Botanical Garden
    "osm:way/1460700597": "Q1454511",  # Atameken miniature park
    "osm:node/4894937300": "Q18405670",  # National Museum
    "osm:way/917478479": "Q21371563",  # Astana Opera
    "osm:way/549307755": "Q42422896",  # Mangilik El arch
    "osm:way/1460537088": "Q573362",  # Central Concert Hall
}
_USER_AGENT = "AstanaCompass-Photos/0.1 (https://github.com/chinusoid/astana-compass)"
_ALT = {"ru": "Фотография", "kk": "Фотосурет", "en": "Photograph"}
_MAX_CACHE = 32
_TTL = 86400


class _Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.blocked = [], []

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "svg", "iframe", "object", "template"}:
            self.blocked.append(tag)
        elif not self.blocked:
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in self.blocked:
            del self.blocked[self.blocked.index(tag):]

    def handle_data(self, data):
        if not self.blocked:
            self.parts.append(data)


def _text(value, limit=240):
    if not isinstance(value, str):
        return None
    parser = _Text()
    parser.feed(value[:8000])
    parser.close()
    value = "".join(parser.parts)
    value = "".join(char for char in value if not unicodedata.category(char).startswith("C"))
    return " ".join(value.split())[:limit] or None


def _safe_url(value, kind):
    if not isinstance(value, str) or len(value) > 2048:
        return None
    try:
        url = urlsplit(value)
        if url.scheme != "https" or url.username or url.password or url.port is not None or url.fragment:
            return None
        if kind == "image":
            allowed = (url.hostname in {"upload.wikimedia.org", "thumb.wikimedia.org"}
                       and url.path.startswith("/wikipedia/commons/thumb/")
                       and re.search(r"/([1-9]\d{1,3})px-[^/]+\.(?:jpe?g|png|webp)$", url.path, re.I))
            if not allowed or int(allowed.group(1)) > 1280:
                return None
        elif kind == "source":
            if url.hostname != "commons.wikimedia.org" or not url.path.startswith("/wiki/File:") or url.query:
                return None
        elif kind == "license":
            if (url.hostname != "creativecommons.org" or url.query
                    or not re.fullmatch(r"/(?:licenses/by(?:-sa)?/(?:2\.0|2\.5|3\.0|4\.0)|publicdomain/(?:zero|mark)/1\.0)/?", url.path)):
                return None
        else:
            return None
        # API tracking query parameters are unnecessary for display/attribution.
        return urlunsplit((url.scheme, url.netloc, url.path, "", ""))
    except (ValueError, TypeError):
        return None


def photo_qid(place):
    """A source-backed identity is mandatory, including for allowlisted places."""
    if not isinstance(place, dict) or place.get("is_synthetic") is not False:
        return None
    expected = SUPPORTED_PLACES.get(place.get("id"))
    if not expected:
        return None
    sources = {item.get("id") for item in place.get("evidence", [])
               if isinstance(item, dict) and item.get("source_type") == "osm" and item.get("is_synthetic") is False}
    return expected if any(
        isinstance(fact, dict) and fact.get("key") == "osm:wikidata" and fact.get("status") == "known"
        and fact.get("value") == expected and bool(sources.intersection(fact.get("evidence_ids", [])))
        for fact in place.get("facts", [])
    ) else None


def _filename(payload, qid):
    entities = payload.get("entities", {})
    entity = entities.get(qid) if isinstance(entities, dict) else None
    if not isinstance(entity, dict) or entity.get("id") != qid:
        return None
    claims = entity.get("claims", {}).get("P18", [])
    if not isinstance(claims, list) or len(claims) > 20:
        return None
    claims = sorted((claim for claim in claims if isinstance(claim, dict)),
                    key=lambda claim: claim.get("rank") != "preferred")
    for claim in claims:
        if claim.get("rank") == "deprecated":
            continue
        snak = claim.get("mainsnak", {})
        if not isinstance(snak, dict) or snak.get("snaktype") != "value" or snak.get("datatype") != "commonsMedia":
            continue
        value = snak.get("datavalue", {}).get("value")
        if (isinstance(value, str) and 1 <= len(value) <= 240 and "|" not in value
                and not any(unicodedata.category(char).startswith("C") for char in value)
                and re.search(r"\.(?:jpe?g|png|webp)$", value, re.I)):
            return value
    return None


def _metadata(payload, filename):
    pages = payload.get("query", {}).get("pages", [])
    if not isinstance(pages, list) or len(pages) != 1:
        return None
    page = pages[0]
    if (not isinstance(page, dict) or page.get("missing") is True
            or page.get("title", "").replace("_", " ") != f"File:{filename}".replace("_", " ")):
        return None
    info = page.get("imageinfo", [])
    if not isinstance(info, list) or len(info) != 1 or not isinstance(info[0], dict):
        return None
    info = info[0]
    if info.get("mime") not in {"image/jpeg", "image/png", "image/webp"}:
        return None
    if (type(info.get("thumbwidth")) is not int or not 1 <= info["thumbwidth"] <= 1280
            or type(info.get("thumbheight")) is not int or not 1 <= info["thumbheight"] <= 1600):
        return None
    meta = info.get("extmetadata", {})
    if not isinstance(meta, dict):
        return None
    def value(key):
        field = meta.get(key)
        return field.get("value") if isinstance(field, dict) else None
    result = {
        "url": _safe_url(info.get("thumburl"), "image"),
        "source_url": _safe_url(info.get("descriptionurl"), "source"),
        "author": _text(value("Artist")),
        "license": _text(value("LicenseShortName"), 80),
        "license_url": _safe_url(value("LicenseUrl"), "license"),
    }
    return result if all(result.values()) else None


class WikimediaPlacePhotos:
    def __init__(self, *, http=None, clock=time.monotonic):
        self.http = http or JsonHTTP(timeout_seconds=4, retries=0, max_bytes=256_000)
        self.clock, self.cache, self.gate = clock, OrderedDict(), asyncio.Lock()
        self.cooldown = 0.0

    async def aclose(self):
        await self.http.aclose()

    async def photo(self, place, locale):
        if locale not in _ALT:
            raise ProviderError("invalid_request")
        qid = photo_qid(place)
        if not qid:
            return {"status": "unavailable", "photo": None}
        try:
            async with asyncio.timeout(8):
                async with self.gate:
                    now = self.clock()
                    cached = self.cache.get(qid)
                    if cached and now < cached[0]:
                        metadata = deepcopy(cached[1])
                        self.cache.move_to_end(qid)
                    elif now < self.cooldown:
                        metadata = None
                    else:
                        metadata = await self._lookup(qid)
                        self._store(qid, metadata, _TTL)
        except ProviderError as error:
            if error.code == "rate_limited":
                self.cooldown = self.clock() + max(60, error.retry_after_seconds)
            self._store(qid, None, 300)
            metadata = None
        except (TimeoutError, ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError):
            self._store(qid, None, 300)
            metadata = None
        if not metadata:
            return {"status": "unavailable", "photo": None}
        metadata["alt"] = f"{_ALT[locale]}: {_text(place.get('name'), 180) or qid}"
        return {"status": "available", "photo": metadata}

    def _store(self, qid, metadata, ttl):
        self.cache[qid] = (self.clock() + ttl, deepcopy(metadata))
        self.cache.move_to_end(qid)
        while len(self.cache) > _MAX_CACHE:
            self.cache.popitem(last=False)

    async def _lookup(self, qid):
        # This is a visible, user-facing cover lookup, not a background import.
        # Wikimedia permits interactive requests to omit maxlag:
        # https://www.mediawiki.org/wiki/Manual:Maxlag_parameter
        payload = await self.http.request("GET", WIKIDATA_ENDPOINT,
                                          headers={"User-Agent": _USER_AGENT}, params={
                                              "action": "wbgetentities", "format": "json", "ids": qid,
                                              "props": "claims",
                                          })
        self._check_error(payload)
        filename = _filename(payload, qid)
        if not filename:
            return None
        payload = await self.http.request("GET", COMMONS_ENDPOINT,
                                          headers={"User-Agent": _USER_AGENT}, params={
                                              "action": "query", "format": "json", "formatversion": 2,
                                              "prop": "imageinfo", "titles": f"File:{filename}",
                                              "iiprop": "url|extmetadata|mime|size", "iiurlwidth": 800,
                                              "iiextmetadatafilter": "Artist|LicenseShortName|LicenseUrl",
                                          })
        self._check_error(payload)
        return _metadata(payload, filename)

    @staticmethod
    def _check_error(payload):
        # MediaWiki may return an API error in an HTTP 200 response. Treat it
        # as a short failure, never as a missing image cached for 24 hours.
        if "error" in payload or "errors" in payload:
            error = payload.get("error")
            rate_limited = isinstance(error, dict) and error.get("code") in {"ratelimited", "maxlag"}
            raise ProviderError("rate_limited" if rate_limited else "provider_unavailable",
                                retry_after_seconds=60 if rate_limited else 0)
