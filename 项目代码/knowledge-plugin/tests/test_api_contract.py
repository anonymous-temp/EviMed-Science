"""Contract test: live responses of the app, validated against ``contract/knowledge-plugin-openapi.yaml``.

The app runs in-process over ``httpx.ASGITransport`` (the async equivalent of Starlette's
TestClient: the psycopg pool belongs to the test's event loop, which a TestClient thread cannot
share). Every body is validated with ``jsonschema`` against the named component schema, with
strict ``date-time`` and ``uri`` checks, so an extra field, a wrong type or a nullable/omitted
mix-up fails here before a consumer sees it.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
import yaml
from jsonschema import Draft202012Validator, FormatChecker
from psycopg.types.json import Jsonb
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

from knowledge_plugin.api import create_app
from knowledge_plugin.model import EntryTextResult, NormalizedEntry
from knowledge_plugin.normalize import prepare
from knowledge_plugin.registry import load_registry, source_from_row, sync_registry
from knowledge_plugin.store import claim_texts, save_text_result, store_entries

pytestmark = pytest.mark.db

ROOT = Path(__file__).resolve().parent.parent
SPEC = yaml.safe_load((ROOT / "contract" / "knowledge-plugin-openapi.yaml").read_text(encoding="utf-8"))
NOW = datetime(2026, 9, 22, 8, 0, tzinfo=timezone.utc)

FORMATS = FormatChecker(formats=())


@FORMATS.checks("date-time", raises=ValueError)
def _date_time(value) -> bool:
    if not isinstance(value, str):
        return True
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("date-time without an offset")
    return True


@FORMATS.checks("uri", raises=ValueError)
def _uri(value) -> bool:
    if isinstance(value, str) and not value.startswith(("http://", "https://")):
        raise ValueError("not an absolute http(s) URI")
    return True


REGISTRY = Registry().with_resource("urn:contract", Resource.from_contents(SPEC, default_specification=DRAFT202012))


def assert_schema(body, name: str) -> None:
    validator = Draft202012Validator({"$ref": f"urn:contract#/components/schemas/{name}"}, registry=REGISTRY,
                                     format_checker=FORMATS)
    errors = sorted(validator.iter_errors(body), key=lambda e: list(e.path))
    assert not errors, "; ".join(f"{list(e.path)}: {e.message}" for e in errors[:5])


def assert_error(response: httpx.Response, status: int, code: str) -> dict:
    assert response.status_code == status, response.text
    body = response.json()
    assert_schema(body, "Error")
    assert body["code"] == code
    return body


@pytest.fixture()
async def seeded(pool):
    rows = load_registry(ROOT / "registry" / "sources.json")
    async with pool.connection() as conn:
        await sync_registry(conn, rows, NOW)
        source_rows = await (await conn.execute(
            "SELECT * FROM evimed_knowledge.sources WHERE id IN ('j-0028-4793', 'fda-press-announcements', 'ctgov-results-first-posted')")).fetchall()
        sources = {r["id"]: source_from_row(r) for r in source_rows}
        journal = sources["j-0028-4793"]
        await store_entries(conn, journal.id, [
            prepare(NormalizedEntry(external_key="10.1056/nejmoa1", url="https://doi.org/10.1056/nejmoa1", title="Trial one",
                                    summary="An abstract " * 20, published_at=NOW - timedelta(days=1), doi="10.1056/NEJMoa1",
                                    facts={"journal": "NEJM", "author_count": 12, "crossref_type": "journal-article"}), journal),
            prepare(NormalizedEntry(external_key="10.1056/nejmoa2", url="https://doi.org/10.1056/nejmoa2", title="Editorial Board",
                                    published_at=NOW - timedelta(days=2), doi="10.1056/nejmoa2"), journal),
            prepare(NormalizedEntry(external_key="10.1056/old", url="https://doi.org/10.1056/old", title="An old paper",
                                    published_at=NOW - timedelta(days=60), doi="10.1056/old"), journal),
        ], now=NOW, first_contact=True)
        feed = sources["fda-press-announcements"]
        await store_entries(conn, feed.id, [
            prepare(NormalizedEntry(external_key="guid-1", url="https://www.fda.gov/news/1?utm_source=rss", title="FDA approves X",
                                    summary="Short", published_at=None), feed),
        ], now=NOW, first_contact=False)
        trials = sources["ctgov-results-first-posted"]
        await store_entries(conn, trials.id, [
            prepare(NormalizedEntry(external_key="NCT01234567:results-posted:2026-09-20", url="https://clinicaltrials.gov/study/NCT01234567",
                                    title="A phase 3 trial", registry_ids=["NCT01234567"], date_precision="day",
                                    published_at=datetime(2026, 9, 20, tzinfo=timezone.utc),
                                    identity_hint="reg:NCT01234567:results-posted:2026-09-20",
                                    facts={"trial_event": "results-posted", "trial_phase": "PHASE3"}), trials),
        ], now=NOW, first_contact=False)
        # a row that somehow holds a non-whitelisted fact must still serialize without it
        await conn.execute("""UPDATE evimed_knowledge.entries SET facts = facts || %s WHERE external_key = 'guid-1'""",
                           (Jsonb({"contact_email": "leak@example.org"}),))
    return pool


@pytest.fixture()
async def client(settings, seeded):
    app = create_app(settings, pool=seeded, clock=lambda: NOW)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://plugin") as http:
        http.headers["Authorization"] = "Bearer test-token-0123456789"
        yield http


async def test_health_needs_no_token(client):
    response = await client.get("/v1/health", headers={"Authorization": ""})
    assert response.status_code == 200
    body = response.json()
    assert_schema(body, "Health")
    assert body["contract"] == SPEC["info"]["version"]
    assert body["model_calls_24h"] == 0 and body["latest_seq"] >= 5
    assert body["sources"]["disabled"] > 0 and body["egress"]["relay"] == "unconfigured"
    assert body["rate_limited_1h"] == {"max": 0, "host": None}             # contract 1.2.0
    assert "last_ok_fetch_at" in body


async def test_every_other_path_needs_the_token(client):
    for method, path in (("GET", "/v1/manifest"), ("GET", "/v1/sources"), ("GET", "/v1/entries?after=0"),
                         ("GET", "/v1/lookups"), ("POST", "/v1/lookups/pubmed-search")):
        for header in ("", "Bearer wrong", "Basic test-token-0123456789"):
            response = await client.request(method, path, headers={"Authorization": header})
            assert_error(response, 401, "unauthorized")
            assert response.headers.get("www-authenticate") == "Bearer"


async def test_manifest(client):
    response = await client.get("/v1/manifest")
    body = response.json()
    assert_schema(body, "Manifest")
    assert body["contract"]["version"] == SPEC["info"]["version"]
    assert body["sources"]["total"] == 720 and body["sources"]["enabled"] >= 256
    assert body["capabilities"] == {"stream": True, "text": True, "refresh": True, "lookups": []}
    assert body["oldest_seq_available"] == 1
    assert "doi" in body["fields"]["entry"] and "journal" in body["fields"]["facts"]
    assert set(body["vocabularies"]["access"]) <= set(SPEC["components"]["schemas"]["Access"]["enum"])


async def test_sources_pages_and_filters(client):
    first = (await client.get("/v1/sources")).json()
    assert_schema(first, "SourcePage")
    assert len(first["sources"]) == 500 and first["next_cursor"]
    second = (await client.get("/v1/sources", params={"cursor": first["next_cursor"]})).json()
    assert_schema(second, "SourcePage")
    assert len(second["sources"]) == 220 and second["next_cursor"] is None
    assert len({s["id"] for s in first["sources"] + second["sources"]}) == 720
    tier = (await client.get("/v1/sources", params={"tier": "P0", "egress": "direct", "limit": 1000})).json()
    assert tier["sources"] and all(s["launch_tier"] == "P0" and s["egress"] == "direct" for s in tier["sources"])
    one = await client.get("/v1/sources/j-0028-4793")
    assert_schema(one.json(), "Source")
    assert one.json()["authority"] == 5 and one.json()["health"] == "new"
    assert_error(await client.get("/v1/sources/nope"), 404, "not_found")
    assert_error(await client.get("/v1/sources", params={"lane": "news"}), 400, "invalid_params")
    assert_error(await client.get("/v1/sources", params={"limit": "1001"}), 400, "invalid_params")


async def test_entries_stream(client):
    page = (await client.get("/v1/entries", params={"after": 0})).json()
    assert_schema(page, "EntryPage")
    titles = [e["title"] for e in page["entries"]]
    assert "An old paper" not in titles                              # backfill is omitted by default
    seqs = [e["seq"] for e in page["entries"]]
    assert seqs == sorted(seqs) and page["has_more"] is False and page["next_after"] == seqs[-1]
    everything = (await client.get("/v1/entries", params={"after": 0, "include_backfill": "true"})).json()
    assert "An old paper" in [e["title"] for e in everything["entries"]]
    assert all(e["backfill"] == (e["title"] == "An old paper") for e in everything["entries"])
    # paging: has_more / next_after walk the same sequence
    walked, after = [], 0
    while True:
        chunk = (await client.get("/v1/entries", params={"after": after, "limit": 1})).json()
        walked += [e["seq"] for e in chunk["entries"]]
        after = chunk["next_after"]
        if not chunk["has_more"]:
            break
    assert walked == seqs
    empty = (await client.get("/v1/entries", params={"after": 10_000})).json()
    assert empty["entries"] == [] and empty["next_after"] == 10_000 and empty["has_more"] is False
    by_entry = {e["title"]: e for e in page["entries"]}
    assert by_entry["Editorial Board"]["facts"]["is_masthead"] is True           # flagged, not dropped
    assert "contact_email" not in by_entry["FDA approves X"]["facts"]            # whitelist at serialization
    assert by_entry["FDA approves X"]["date_precision"] == "inferred" and "no-date" in by_entry["FDA approves X"]["defects"]
    assert by_entry["FDA approves X"]["canonical_url"] == "https://www.fda.gov/news/1"
    assert by_entry["A phase 3 trial"]["identity_key"] == "reg:NCT01234567:results-posted:2026-09-20"
    assert by_entry["Trial one"]["identity_key"] == "doi:10.1056/nejmoa1"
    lane = (await client.get("/v1/entries", params={"after": 0, "lane": "regulatory"})).json()
    assert [e["source_id"] for e in lane["entries"]] == ["fda-press-announcements"]
    source = (await client.get("/v1/entries", params={"after": 0, "source_id": "ctgov-results-first-posted"})).json()
    assert len(source["entries"]) == 1


@pytest.mark.parametrize("params, code", [
    ({}, "invalid_cursor"), ({"after": "-1"}, "invalid_cursor"), ({"after": "abc"}, "invalid_cursor"),
    ({"after": "1.5"}, "invalid_cursor"), ({"after": "0", "limit": "501"}, "invalid_params"),
    ({"after": "0", "limit": "0"}, "invalid_params"), ({"after": "0", "include_backfill": "maybe"}, "invalid_params"),
    ({"after": "0", "lane": "news"}, "invalid_params"),
])
async def test_entries_bad_parameters(client, params, code):
    body = assert_error(await client.get("/v1/entries", params=params), 400, code)
    assert body["details"]["field"]


async def test_entry_and_text_lifecycle(client, seeded, settings):
    page = (await client.get("/v1/entries", params={"after": 0})).json()
    entry = next(e for e in page["entries"] if e["title"] == "Trial one")
    single = await client.get(f"/v1/entries/{entry['entry_id']}")
    assert_schema(single.json(), "Entry")
    assert single.json() == entry
    assert_error(await client.get("/v1/entries/nope:0000"), 404, "not_found")

    pending = await client.get(f"/v1/entries/{entry['entry_id']}/text")
    assert pending.status_code == 200
    assert_schema(pending.json(), "EntryText")
    assert pending.json()["status"] == "pending" and pending.json()["next_attempt_at"]
    assert (await client.get(f"/v1/entries/{entry['entry_id']}")).json()["text_status"] == "pending"

    async with seeded.connection() as conn:
        requested = await (await conn.execute("SELECT text_requested_at FROM evimed_knowledge.entries WHERE entry_id = %s",
                                              (entry["entry_id"],))).fetchone()
        assert requested["text_requested_at"] == NOW                     # retention becomes 90 days
        jobs = await claim_texts(conn, 5, NOW, 600)
        assert [j["entry_id"] for j in jobs] == [entry["entry_id"]]
        await save_text_result(conn, jobs[0], EntryTextResult(
            status="available", text_kind="abstract", abstract="Background. Methods. Results.", fetched_from="pubmed",
            fetched_at=NOW, enrichment={"publication_types": ["Randomized Controlled Trial"], "mesh": ["Heart Failure"],
                                        "affiliation_countries": ["cn", "US"], "open_access": "gold", "made_up": "x"}), NOW)
    available = await client.get(f"/v1/entries/{entry['entry_id']}/text")
    body = available.json()
    assert_schema(body, "EntryText")
    assert body["status"] == "available" and body["abstract"].startswith("Background")
    assert body["enrichment"] == {"publication_types": ["Randomized Controlled Trial"], "mesh": ["Heart Failure"],
                                  "affiliation_countries": ["CN", "US"], "open_access": "gold"}
    assert (await client.get(f"/v1/entries/{entry['entry_id']}")).json()["text_status"] == "available"

    refresh = await client.post(f"/v1/entries/{entry['entry_id']}/refresh")
    assert refresh.status_code == 202 and refresh.json()["scheduled"] is True
    assert_error(await client.post("/v1/entries/nope:0000/refresh"), 404, "not_found")


async def test_lookups_are_not_offered_in_batch_1(client):
    listed = await client.get("/v1/lookups")
    assert listed.json() == {"lookups": []}
    assert_error(await client.post("/v1/lookups/pubmed-search", json={"q": "x"}), 501, "capability_unavailable")
    assert_error(await client.post("/v1/lookups/Bad!", json={}), 400, "invalid_params")


async def test_unknown_paths_use_the_error_shape(client):
    assert_error(await client.get("/v2/anything"), 404, "not_found")


def test_the_schema_check_is_not_vacuous():
    """The validator must reject what the contract forbids, or every assertion above proves nothing."""
    with pytest.raises(AssertionError):
        assert_schema({"entry_id": "x"}, "Entry")                                   # required fields missing
    good_facts = {"journal": "NEJM"}
    bad = {"entry_id": "s:1", "seq": 1, "revision": 1, "source_id": "s", "identity_key": "url:x", "url": "u",
           "canonical_url": "u", "title": "t", "language": "en", "first_seen_at": "2026-09-22T08:00:00Z",
           "content_sha256": "0" * 64, "backfill": False, "facts": {**good_facts, "contact_email": "x@y"}}
    with pytest.raises(AssertionError):
        assert_schema(bad, "Entry")                                                  # facts are additionalProperties: false
    with pytest.raises(AssertionError):
        assert_schema({**bad, "facts": good_facts, "first_seen_at": "2026-09-22 08:00"}, "Entry")   # no offset
    assert_schema({**bad, "facts": good_facts}, "Entry")



def test_egress_health_prefers_live_counts_then_the_log():
    from knowledge_plugin.api import egress_health

    class Fetcher:
        def egress_status(self, now):
            return {"direct": None, "api": "ok", "relay": "down", "browser": "unconfigured", "bridge": "unconfigured"}

        def evimed_status(self):
            return "unconfigured"

    log_rows = [{"egress": "direct", "last_outcome": "http-error", "any_ok": True}]
    assert egress_health(Fetcher(), log_rows, NOW) == {"direct": "degraded", "api": "ok", "relay": "down",
                                                       "browser": "unconfigured", "bridge": "unconfigured", "evimed-api": "unconfigured"}
    assert egress_health(None, [], NOW)["relay"] == "unconfigured"
