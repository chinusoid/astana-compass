"""Photo identity, attribution, URL boundaries and bounded failure behavior."""
import asyncio
from copy import deepcopy
import json
from pathlib import Path

import httpx
import pytest

from astana_api.place_photos import (
    COMMONS_ENDPOINT, SUPPORTED_PLACES, WIKIDATA_ENDPOINT, WikimediaPlacePhotos,
    _metadata, _safe_url, photo_qid,
)
from astana_city_context.common import JsonHTTP, ProviderError

FILENAME = "A view of Nur-Sultan's Botanical Garden.jpg"
IMAGE = "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/1d/Garden.jpg/960px-Garden.jpg"
SOURCE = "https://commons.wikimedia.org/wiki/File:A_view_of_Nur-Sultan%27s_Botanical_Garden.jpg"
LICENSE = "https://creativecommons.org/licenses/by-sa/4.0"


def place():
    return {
        "id": "osm:way/1196402246", "name": "Ботаникалық бақ", "is_synthetic": False,
        "facts": [{"key": "osm:wikidata", "status": "known", "value": "Q104866948", "evidence_ids": ["source"]}],
        "evidence": [{"id": "source", "source_type": "osm", "is_synthetic": False}],
    }


def entity(filename=FILENAME):
    return {"entities": {"Q104866948": {"id": "Q104866948", "claims": {"P18": [{
        "rank": "normal", "mainsnak": {"datatype": "commonsMedia", "snaktype": "value",
                                       "datavalue": {"value": filename}},
    }]}}}}


def commons():
    return {"query": {"pages": [{"title": f"File:{FILENAME}", "imageinfo": [{
        "thumburl": IMAGE + "?utm_source=commons.wikimedia.org", "descriptionurl": SOURCE,
        "thumbwidth": 800, "thumbheight": 600, "mime": "image/jpeg", "extmetadata": {
            "Artist": {"value": '<a href="//commons.wikimedia.org/wiki/User:Rubatooo">Demir Berisha</a>'},
            "LicenseShortName": {"value": "CC BY-SA 4.0"}, "LicenseUrl": {"value": LICENSE},
        },
    }]}]}}


class FakeHTTP:
    def __init__(self, responses=None):
        self.responses = [entity(), commons()] if responses is None else responses
        self.calls = []
        self.closed = False

    async def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return deepcopy(response)

    async def aclose(self):
        self.closed = True


def test_catalogue_identity_allowlist_is_reproducible():
    snapshot = json.loads((Path(__file__).parents[2] / "data/samples/astana-osm.json").read_text(encoding="utf8"))
    actual = {item["id"]: photo_qid(item) for item in snapshot["places"] if item["id"] in SUPPORTED_PLACES}
    assert actual == SUPPORTED_PLACES


@pytest.mark.parametrize("change", ["synthetic", "other_place", "other_qid", "unknown", "unlinked", "synthetic_evidence"])
def test_requires_exact_catalogue_identity_and_evidence(change):
    item = place()
    if change == "synthetic":
        item["is_synthetic"] = True
    elif change == "other_place":
        item["id"] = "osm:way/123"
    elif change == "other_qid":
        item["facts"][0]["value"] = "Q42"
    elif change == "unknown":
        item["facts"][0]["status"] = "unknown"
    elif change == "unlinked":
        item["facts"][0]["evidence_ids"] = []
    else:
        item["evidence"][0]["is_synthetic"] = True
    http = FakeHTTP()
    result = asyncio.run(WikimediaPlacePhotos(http=http).photo(item, "ru"))
    assert result == {"status": "unavailable", "photo": None}
    assert http.calls == []


def test_complete_attribution_plain_text_and_fixed_api_requests():
    http = FakeHTTP()
    result = asyncio.run(WikimediaPlacePhotos(http=http).photo(place(), "ru"))
    assert result == {"status": "available", "photo": {
        "url": IMAGE, "source_url": SOURCE, "author": "Demir Berisha", "license": "CC BY-SA 4.0",
        "license_url": LICENSE, "alt": "Фотография: Ботаникалық бақ",
    }}
    assert [entry[1] for entry in http.calls] == [WIKIDATA_ENDPOINT, COMMONS_ENDPOINT]
    assert http.calls[0][2]["params"]["ids"] == "Q104866948"
    assert http.calls[1][2]["params"]["titles"] == f"File:{FILENAME}"
    assert all("AstanaCompass" in entry[2]["headers"]["User-Agent"] for entry in http.calls)


@pytest.mark.parametrize("part,value", [
    ("thumburl", "https://evil.example/960px-Garden.jpg"),
    ("thumburl", "https://thumb.wikimedia.org.evil.example/wikipedia/commons/thumb/a/b/960px-Garden.jpg"),
    ("thumburl", "https://upload.wikimedia.org/wikipedia/commons/a/b/Garden.jpg"),
    ("thumburl", IMAGE.replace("960px", "1920px")),
    ("thumburl", IMAGE.replace("https://", "https://user:secret@")),
    ("descriptionurl", "https://en.wikipedia.org/wiki/Garden"),
    ("mime", "image/svg+xml"), ("thumbheight", 9000),
])
def test_rejects_non_thumbnail_urls_wrong_hosts_or_unbounded_images(part, value):
    data = commons()
    data["query"]["pages"][0]["imageinfo"][0][part] = value
    assert _metadata(data, FILENAME) is None


@pytest.mark.parametrize("key", ["Artist", "LicenseShortName", "LicenseUrl"])
def test_does_not_display_photograph_without_complete_attribution(key):
    data = commons()
    del data["query"]["pages"][0]["imageinfo"][0]["extmetadata"][key]
    assert _metadata(data, FILENAME) is None


def test_rejects_non_free_or_foreign_license_and_different_file():
    data = commons()
    data["query"]["pages"][0]["imageinfo"][0]["extmetadata"]["LicenseUrl"]["value"] = "https://example.org/rights"
    assert _metadata(data, FILENAME) is None
    assert _metadata(commons(), "Different Garden.jpg") is None
    assert _safe_url("https://creativecommons.org/licenses/by-nc/4.0/", "license") is None


def test_untrusted_author_markup_is_not_executable_and_not_a_prompt():
    data = commons()
    data["query"]["pages"][0]["imageinfo"][0]["extmetadata"]["Artist"]["value"] = '<script>doBad()</script><b>Alice &amp; Bob</b>'
    assert _metadata(data, FILENAME)["author"] == "Alice & Bob"


def test_metadata_cache_is_24_hours_localized_per_response_and_defensive():
    async def run():
        clock = [100.0]
        http = FakeHTTP([entity(), commons(), entity(), commons()])
        provider = WikimediaPlacePhotos(http=http, clock=lambda: clock[0])
        first = await provider.photo(place(), "ru")
        first["photo"]["author"] = "corrupted by caller"
        second = await provider.photo(place(), "en")
        assert second["photo"]["author"] == "Demir Berisha"
        assert second["photo"]["alt"] == "Photograph: Ботаникалық бақ"
        assert len(http.calls) == 2
        clock[0] += 86400
        assert (await provider.photo(place(), "kk"))["status"] == "available"
        assert len(http.calls) == 4
        await provider.aclose()
        assert http.closed
    asyncio.run(run())


def test_no_image_or_deprecated_image_never_uses_name_search():
    async def run():
        data = entity()
        data["entities"]["Q104866948"]["claims"]["P18"][0]["rank"] = "deprecated"
        http = FakeHTTP([data])
        provider = WikimediaPlacePhotos(http=http)
        assert (await provider.photo(place(), "ru"))["photo"] is None
        assert (await provider.photo(place(), "en"))["photo"] is None
        assert len(http.calls) == 1
    asyncio.run(run())


def test_upstream_failure_is_a_quiet_fallback_with_short_backoff():
    async def run():
        clock = [100.0]
        http = FakeHTTP([ProviderError("provider_unavailable"), entity(), commons()])
        provider = WikimediaPlacePhotos(http=http, clock=lambda: clock[0])
        assert (await provider.photo(place(), "ru"))["status"] == "unavailable"
        assert (await provider.photo(place(), "ru"))["status"] == "unavailable"
        assert len(http.calls) == 1
        clock[0] += 301
        assert (await provider.photo(place(), "ru"))["status"] == "available"
    asyncio.run(run())


@pytest.mark.parametrize("code", ["maxlag", "ratelimited", "readonly"])
def test_api_errors_in_http_200_do_not_become_day_long_missing_images(code):
    async def run():
        clock = [100.0]
        http = FakeHTTP([{"error": {"code": code}}, entity(), commons()])
        provider = WikimediaPlacePhotos(http=http, clock=lambda: clock[0])
        assert (await provider.photo(place(), "ru"))["status"] == "unavailable"
        clock[0] += 301
        assert (await provider.photo(place(), "ru"))["status"] == "available"
    asyncio.run(run())


def test_concurrent_readers_share_metadata_lookup():
    async def run():
        http = FakeHTTP()
        provider = WikimediaPlacePhotos(http=http)
        results = await asyncio.gather(*(provider.photo(place(), "ru") for _ in range(5)))
        assert all(result["status"] == "available" for result in results)
        assert len(http.calls) == 2
    asyncio.run(run())


@pytest.mark.parametrize("kind", ["redirect", "oversize", "encoded"])
def test_real_http_boundary_rejects_redirects_size_and_encoding(kind):
    async def run():
        def handle(request):
            if kind == "redirect":
                return httpx.Response(302, headers={"location": "https://evil.example"})
            if kind == "oversize":
                return httpx.Response(200, content=b"x" * 257)
            return httpx.Response(200, headers={"content-encoding": "gzip"}, content=b"not gzip")
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            provider = WikimediaPlacePhotos(http=JsonHTTP(client=client, max_bytes=256, retries=0))
            assert (await provider.photo(place(), "ru"))["status"] == "unavailable"
    asyncio.run(run())
