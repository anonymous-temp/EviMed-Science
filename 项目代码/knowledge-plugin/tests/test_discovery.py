"""Automatic source discovery: candidates, validation, trials, the lifecycle and their counts (fr-sources, 2026-10-22).

The network is a scripted fetcher answering by URL; everything else — the store, the registry composition, the
scheduler's claim, the API — is the real code against the scratch database.
"""

from __future__ import annotations

import json
from dataclasses import asdict, replace
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from knowledge_plugin.discovery import (Candidate, advertised_feed_links, canonical_site, discovery_health, host_matches,
                                        journal_row, parse_caps, run_discovery, site_row, upsert_candidates)
from knowledge_plugin.discovery_lines import links_in_page, request_candidates
from knowledge_plugin.model import FetchError, FetchResult
from knowledge_plugin.registry import parse_registry
from knowledge_plugin.source_requests import admitted_requests

NOW = datetime(2026, 10, 22, 2, 0, tzinfo=timezone.utc)
DAY = "2026-10-22"


def feed(*days_ago: int, at: datetime = NOW) -> bytes:
    items = "".join(
        f"<item><title>Hospital study {n}</title><link>https://www.hospital.example.org/news/{n}</link>"
        f"<guid>hospital-{n}</guid><pubDate>{(at - timedelta(days=n)).strftime('%a, %d %b %Y %H:%M:%S GMT')}</pubDate>"
        f"<description>A synthetic hospital news item for the discovery test, not clinical evidence.</description></item>"
        for n in days_ago)
    return (f'<?xml version="1.0"?><rss version="2.0"><channel><title>Hospital news</title>'
            f'<link>https://www.hospital.example.org/</link>{items}</channel></rss>').encode()


class Web:
    """Answers by URL; a URL it does not know is a 404, a callable may raise."""

    def __init__(self, routes: dict):
        self.routes = routes
        self.calls: list[str] = []

    def egress_configured(self, egress):
        return egress != "relay"

    async def host_budget_usage(self):
        return getattr(self, "usage", {})

    async def fetch(self, spec, **kwargs):
        self.calls.append(spec.url)
        answer = self.routes.get(spec.url)
        if answer is None:
            raise FetchError("http-error", "http_404", status=404)
        if callable(answer):
            answer = answer()
        body, ctype = answer if isinstance(answer, tuple) else (answer, "text/html")
        return FetchResult(request=spec, final_url=spec.url, status=200, headers={"content-type": ctype}, body=body,
                           fetched_at=NOW)


def registry_row(**changes) -> dict:
    row = {"id": "known-journal", "name": "Known journal", "homepage": "https://www.known.example.org/",
           "lane": "evidence", "source_type": "journal", "access": "rss", "egress": "direct", "authority": 3,
           "safety_feed": False, "owner_entity": "Known publisher", "launch_tier": "P0", "language": "en", "region": "US",
           "poll_floor_s": 3600, "poll_ceiling_s": 86400, "enabled": True, "disabled_reason": None,
           "category": "journal-specialty",
           "config": {"url": "https://www.known.example.org/feed.xml", "allowed_hosts": ["www.known.example.org"],
                      "max_pages": 1, "issn": "1111-1111", "issns": ["1111-1111"]}}
    row.update(changes)
    return row


@pytest.fixture()
def registry_file(tmp_path, settings):
    path = tmp_path / "sources.json"
    path.write_text(json.dumps({"sources": [registry_row()]}))
    return replace(settings, registry_path=str(path))


def data() -> dict:
    return {"exclude_hosts": ["x.com", "doi.org"],
            "directories": [{"name": "Example Hospital", "homepage": "https://www.hospital.example.org/news",
                             "source_type": "evidence-body", "category": "medical-society-news", "lane": "research",
                             "region": "US", "language": "en", "owner_entity": "Example Hospital"}]}


# ------------------------------------------------------------------------------------ pure


def test_url_helpers():
    assert canonical_site("https://News.Example.org/a/b?x=1") == "https://news.example.org/"
    assert canonical_site("http://10.0.0.1/") is None and canonical_site("https://localhost/") is None
    assert canonical_site("ftp://example.org/") is None
    assert host_matches("news.example.org", {"example.org"}) and not host_matches("example.org.evil.net", {"example.org"})
    assert parse_caps("journal=7,unknown=3,outbound=x") ["journal"] == 7


def test_advertised_feeds_stay_in_the_page_family():
    html = b'''<link rel="alternate" type="application/rss+xml" title="News" href="/news/rss.xml">
      <link rel="alternate" type="application/atom+xml" href="https://feeds.hospital.example.org/all">
      <link rel="alternate" type="application/rss+xml" href="https://elsewhere.example.net/feed">'''
    found = advertised_feed_links(html, "https://www.hospital.example.org/news")
    assert [f["url"] for f in found] == ["https://www.hospital.example.org/news/rss.xml", "https://feeds.hospital.example.org/all"]


def test_links_in_page_are_absolute_http_targets():
    html = b'<a href="https://www.society.example.org/press">x</a><a href="/local">y</a><a href="mailto:a@b">z</a>'
    assert links_in_page(html, "https://news.example.com/story") == ["https://www.society.example.org/press"]


def test_built_rows_load_and_their_adapters_accept_them():
    from knowledge_plugin.adapters import validate_config

    site = site_row("https://www.hospital.example.org/news/rss.xml", access="rss", egress="direct", name="Hospital news",
                    homepage="https://www.hospital.example.org/", hint={}, language="en", line="outbound")
    journal = journal_row(["2168-6254", "2168-6262"], title="JAMA Surgery", publisher="AMA", medical_basis="medline")
    for row in (site, journal):
        parsed = parse_registry({"sources": [row]})[0]
        assert validate_config(parsed.source) == []
    assert site["lane"] == "mixed" and site["poll_floor_s"] >= 21600 and site["id"].startswith("discovered-")
    assert journal["access"] == "crossref-issn" and journal["config"]["issn"] == "2168-6254"


def test_requests_in_any_lane_become_candidates_and_the_ai_lane_keeps_its_admission():
    document = {"sources": [
        {"id": "hospital-news", "name": "Hospital news", "lane": "research", "access": "rss", "egress": "direct",
         "config": {"url": "https://www.hospital.example.org/news/rss.xml"}},
        {"id": "ai-discovery-x", "lane": "ai", "config": {"url": "https://export.arxiv.org/api/query"}}]}
    candidates = request_candidates(document)
    assert [(c.line, c.kind, c.key, c.medical_basis) for c in candidates] == [
        ("request", "row", "https://www.hospital.example.org/news/rss.xml", "request")]
    _, dispositions = admitted_requests(document, [])
    assert dispositions[0] == {"id": "hospital-news", "status": "candidate"}


# ------------------------------------------------------------------------------------ the cycle


async def test_a_directory_site_and_a_medline_journal_go_on_trial_then_are_admitted(pool, registry_file):
    web = Web({
        "https://www.hospital.example.org/news": b'<html><head><title>Example Hospital</title>'
                                                 b'<link rel="alternate" type="application/rss+xml" href="/news/rss.xml"></head></html>',
        "https://www.hospital.example.org/news/rss.xml": (feed(1, 3, 40), "application/rss+xml"),
        "https://api.crossref.org/journals/2168-6254/works?filter=from-created-date:2026-09-22,type:journal-article&rows=0":
            (json.dumps({"message": {"total-results": 33}}).encode(), "application/json"),
        "https://api.crossref.org/journals/2168-6254": (json.dumps({"message": {"title": "JAMA Surgery", "publisher": "AMA",
                                                                                "ISSN": ["2168-6254", "2168-6262"]}}).encode(), "application/json"),
    })
    async with pool.connection() as conn:
        async with conn.transaction():
            await upsert_candidates(conn, [Candidate("journal", "journal", "issn:2168-6254", name="JAMA surgery",
                                                     medical_basis="medline", hint={"issns": ["2168-6254", "2168-6262"]}),
                                           Candidate("journal", "journal", "issn:1111-1111", medical_basis="medline",
                                                     hint={"issns": ["1111-1111"]})], NOW, DAY)
    report = await run_discovery(registry_file, pool, web, lambda: NOW, data=data(), gather_lines=["directory"])
    assert report["validated"]["journal"] == {"trial": 1, "failed": 1}         # the second ISSN is already read
    assert report["validated"]["directory"] == {"trial": 1}
    async with pool.connection() as conn:
        rows = {r["key"]: r for r in await (await conn.execute(
            "SELECT key, state, state_reason, source_id, medical_basis, row FROM evimed_knowledge.source_candidates")).fetchall()}
        assert rows["issn:1111-1111"]["state_reason"] == "known"
        hospital = rows["https://www.hospital.example.org/news"]
        assert hospital["state"] == "trial" and hospital["medical_basis"] == "directory"
        assert hospital["row"]["source_type"] == "evidence-body" and hospital["row"]["owner_entity"] == "Example Hospital"
        sources = {r["id"]: r for r in await (await conn.execute(
            "SELECT id, enabled, retired_at, poll_floor_s FROM evimed_knowledge.sources")).fetchall()}
        assert sources["j-2168-6254"]["enabled"] and sources["j-2168-6254"]["retired_at"] is None
        assert sources[hospital["source_id"]]["poll_floor_s"] == 21600     # the trial's low rate
        health = await discovery_health(conn, NOW)
    assert health["today"]["candidates"] == 3 and health["today"]["trial"] == 2 and health["today"]["failed"] == 1
    assert health["in_trial"] == 2 and len(health["history"]) == 14

    # A week later: the journal produced a new entry after its first poll, the hospital feed did not.
    later = NOW + timedelta(days=8)
    async with pool.connection() as conn:
        await conn.execute("UPDATE evimed_knowledge.sources SET first_contact_at = %s, last_ok_at = %s WHERE id = ANY(%s)",
                           (NOW + timedelta(hours=1), later, ["j-2168-6254", hospital["source_id"]]))
        for sid in ("j-2168-6254", hospital["source_id"]):
            await conn.execute("""INSERT INTO evimed_knowledge.fetches (source_id, fetched_at, egress, outcome)
                                  VALUES (%s, %s, 'direct', 'ok')""", (sid, NOW + timedelta(hours=1)))
        await conn.execute("""INSERT INTO evimed_knowledge.entries (entry_id, source_id, external_key, identity_key, url,
                                canonical_url, title, first_seen_at, content_sha256)
                              VALUES ('j-2168-6254:a', 'j-2168-6254', 'k', 'doi:10.1/x', 'https://doi.org/10.1/x',
                                'https://doi.org/10.1/x', 'A new paper', %s, %s)""", (NOW + timedelta(days=3), "a" * 64))
    report = await run_discovery(registry_file, pool, web, lambda: later, data=data(), gather_lines=[])
    verdicts = {d["source_id"]: (d["verdict"], d["reason"]) for d in report["decided"]}
    assert verdicts["j-2168-6254"] == ("admitted", "basis:medline")
    assert verdicts[hospital["source_id"]] == ("failed", "no_new_entry")
    async with pool.connection() as conn:
        sources = {r["id"]: r for r in await (await conn.execute("SELECT id, retired_at FROM evimed_knowledge.sources")).fetchall()}
        health = await discovery_health(conn, later)
    assert sources["j-2168-6254"]["retired_at"] is None
    assert sources[hospital["source_id"]]["retired_at"] is not None          # out of the composition, row kept
    assert health["today"]["admitted"] == 1 and health["today"]["failed"] == 1


async def test_validation_failures_are_named(pool, registry_file):
    web = Web({
        "https://quiet.example.org/": b'<link rel="alternate" type="application/rss+xml" href="/rss.xml">',
        "https://quiet.example.org/rss.xml": (feed(45, 60), "application/rss+xml"),
        "https://nofeed.example.org/": b"<html><head><title>No feed</title></head></html>",
    })
    async with pool.connection() as conn:
        async with conn.transaction():
            await upsert_candidates(conn, [Candidate("outbound", "site", "https://quiet.example.org/"),
                                           Candidate("outbound", "site", "https://nofeed.example.org/"),
                                           Candidate("outbound", "site", "https://gone.example.org/"),
                                           Candidate("outbound", "site", "https://x.com/")], NOW, DAY)
    await run_discovery(registry_file, pool, web, lambda: NOW, data=data(), gather_lines=[])
    async with pool.connection() as conn:
        reasons = {r["key"]: r["state_reason"] for r in await (await conn.execute(
            "SELECT key, state_reason FROM evimed_knowledge.source_candidates")).fetchall()}
    assert reasons["https://quiet.example.org/"] == "no_fresh_items"
    assert reasons["https://nofeed.example.org/"] == "no_feed"
    assert reasons["https://gone.example.org/"].startswith("unreachable:http-error")
    assert reasons["https://x.com/"] == "excluded"


async def test_a_social_candidate_waits_for_its_adapter(pool, registry_file):
    async with pool.connection() as conn:
        async with conn.transaction():
            await upsert_candidates(conn, [Candidate("social", "social", "x:somedoctor", hint={"platform": "x"})], NOW, DAY)
    report = await run_discovery(registry_file, pool, Web({}), lambda: NOW, data=data(), gather_lines=[])
    assert report["validated"]["social"] == {"deferred": 1}
    async with pool.connection() as conn:
        row = await (await conn.execute("SELECT state, state_reason, next_check_at FROM evimed_knowledge.source_candidates")).fetchone()
    assert row["state"] == "candidate" and row["state_reason"] == "adapter_unavailable:x" and row["next_check_at"] > NOW


async def test_a_retired_source_leaves_the_queue_keeps_its_row_and_comes_back_on_its_recheck(pool, registry_file):
    from knowledge_plugin.scheduler import Crawler

    async with pool.connection() as conn:
        from knowledge_plugin.dynamic_registry import sync_dynamic_registry
        from knowledge_plugin.registry import load_registry
        await sync_dynamic_registry(conn, lambda: load_registry(registry_file.registry_path), NOW)
        await conn.execute("""UPDATE evimed_knowledge.sources SET last_error_code = 'robots-denied:robots_disallow',
                                consecutive_failures = 2, failing_since = %s, first_contact_at = %s, next_poll_at = %s
                              WHERE id = 'known-journal'""", (NOW - timedelta(days=1), NOW - timedelta(days=30), NOW))
    report = await run_discovery(registry_file, pool, Web({}), lambda: NOW, data=data(), gather_lines=[])
    assert report["retired"] == [{"source_id": "known-journal", "reason": "robots", "line": "registry"}]
    async with pool.connection() as conn:
        row = await (await conn.execute("SELECT retired_at FROM evimed_knowledge.sources WHERE id = 'known-journal'")).fetchone()
        assert row["retired_at"] is not None
        health = await discovery_health(conn, NOW)
    assert health["today"]["retired"] == 1 and health["by_line"]["registry"]["retired"] == 1
    crawler = Crawler(registry_file, pool, None, clock=lambda: NOW, enricher=lambda *args: None)
    assert await crawler.claim(10) == []                                    # robots-refused: not polled any more

    # Thirty days on, the re-check finds the feed permitted and fresh again: the source is back.
    later = NOW + timedelta(days=31)
    web = Web({"https://www.known.example.org/feed.xml": (feed(0, 1, at=later), "application/rss+xml")})
    async with pool.connection() as conn:
        await conn.execute("""UPDATE evimed_knowledge.sources SET last_error_code = NULL, consecutive_failures = 0,
                                failing_since = NULL WHERE id = 'known-journal'""")
    report = await run_discovery(registry_file, pool, web, lambda: later, data=data(), gather_lines=["readmit"])
    assert report["validated"]["readmit"] == {"admitted": 1}
    async with pool.connection() as conn:
        row = await (await conn.execute("SELECT retired_at FROM evimed_knowledge.sources WHERE id = 'known-journal'")).fetchone()
        assert row["retired_at"] is None
        assert (await (await conn.execute("SELECT count(*) AS n FROM evimed_knowledge.source_lifecycle")).fetchone())["n"] == 0


async def test_health_and_the_screening_report(settings, pool):
    from knowledge_plugin.api import create_app
    from knowledge_plugin.registry import sync_registry

    rows = parse_registry({"sources": [registry_row()]})
    async with pool.connection() as conn:
        await sync_registry(conn, rows, NOW)
    app = create_app(settings, pool=pool, clock=lambda: NOW)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://plugin") as http:
        health = (await http.get("/v1/health")).json()
        assert health["discovery"]["today"] == {"day": DAY, "candidates": 0, "validated": 0, "trial": 0, "admitted": 0,
                                                "retired": 0, "failed": 0}
        http.headers["Authorization"] = "Bearer test-token-0123456789"
        answer = await http.post("/v1/sources/screening", json={"window_days": 14, "sources": [
            {"id": "known-journal", "screened": 10, "off_topic": 7}, {"id": "nobody", "screened": 1, "off_topic": 0}]})
        assert answer.status_code == 200 and answer.json() == {"accepted": 1, "unknown": 1}
        bad = await http.post("/v1/sources/screening", json={"window_days": 14, "sources": [
            {"id": "known-journal", "screened": 1, "off_topic": 2}]})
        assert bad.status_code == 400 and bad.json()["code"] == "invalid_params"
        assert (await http.post("/v1/sources/screening", json={"window_days": 0, "sources": []})).status_code == 400
        del http.headers["Authorization"]
        assert (await http.post("/v1/sources/screening", json={"window_days": 14, "sources": []})).status_code == 401
    async with pool.connection() as conn:
        row = await (await conn.execute("SELECT screened, off_topic FROM evimed_knowledge.source_screening")).fetchone()
    assert (row["screened"], row["off_topic"]) == (10, 7)


async def test_the_journal_line_waits_while_crossref_is_nearly_spent(pool, registry_file):
    web = Web({})
    web.usage = {"api.crossref.org": {"used": 2500, "cap": 3000}}
    async with pool.connection() as conn:
        async with conn.transaction():
            await upsert_candidates(conn, [Candidate("journal", "journal", "issn:2168-6254", medical_basis="medline",
                                                     hint={"issns": ["2168-6254"]})], NOW, DAY)
    report = await run_discovery(registry_file, pool, web, lambda: NOW, data=data(), gather_lines=[])
    assert report["crossrefTight"] is True and "journal" not in report["validated"] and web.calls == []


async def test_a_source_on_trial_is_judged_by_its_trial_not_retired(pool, registry_file):
    from knowledge_plugin.discovery import apply_retirements
    from knowledge_plugin.registry import sync_registry

    row = site_row("https://www.tech.example.org/feed", access="rss", egress="direct", name="Tech feed",
                   homepage="https://www.tech.example.org/", hint={}, language="en", line="outbound")
    async with pool.connection() as conn:
        await sync_registry(conn, parse_registry({"sources": [row]}), NOW)
        await conn.execute("""INSERT INTO evimed_knowledge.source_candidates (id, line, key, first_seen_at, last_seen_at, state,
                                state_at, source_id, row, trial_started_at, trial_until)
                              VALUES ('c1', 'outbound', 'https://www.tech.example.org/', %s, %s, 'trial', %s, %s, %s, %s, %s)""",
                           (NOW, NOW, NOW, row["id"], json.dumps(row), NOW, NOW + timedelta(days=7)))
        await conn.execute("""INSERT INTO evimed_knowledge.source_screening VALUES (%s, 20, 19, 14, %s)""", (row["id"], NOW))
        async with conn.transaction():
            assert await apply_retirements(conn, NOW, DAY, set()) == []
        await conn.execute("UPDATE evimed_knowledge.source_candidates SET state = 'admitted'")
        async with conn.transaction():
            assert [r["reason"] for r in await apply_retirements(conn, NOW, DAY, set())] == ["off-topic"]


def test_discovery_data_is_read_beside_the_registry_the_plugin_runs_on(tmp_path):
    from knowledge_plugin.discovery import DATA_PATH, data_path
    registry = tmp_path / "registry" / "sources.json"
    registry.parent.mkdir()
    registry.write_text("{}", encoding="utf-8")
    assert data_path(str(registry)) == DATA_PATH                                 # nothing beside it: the source tree's
    (registry.parent / "discovery.json").write_text('{"directories": []}', encoding="utf-8")
    assert data_path(str(registry)) == registry.parent / "discovery.json"
    assert data_path(None) == DATA_PATH
