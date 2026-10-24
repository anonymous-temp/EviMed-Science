"""Leads (contract 1.6.0, ct-mix 2026-10-24): the addresses the platform's lead triggers hand over, received once within a
day's cap, read under the plugin's own rules, emitted as ordinary entries and proposed to discovery (line ``lead``).

The network is a scripted fetcher answering by URL and a fake Dajiala client; everything else — the store, the registry
composition, the API, the candidate store — is the real code against the scratch database.
"""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import httpx
import pytest
import yaml

from knowledge_plugin.discovery import DEFAULT_CAPS, LINES
from knowledge_plugin.leads import (LeadReader, LeadsInvalid, identity_keys, lead_kind, lead_source_row, parse_leads,
                                    _wechat_time)
from knowledge_plugin.model import ACCESSES, CONTRACT_VERSION, FetchError, FetchResult, IMPLEMENTED_ACCESSES, UNPOLLED_ACCESSES
from knowledge_plugin.registry import parse_registry, sync_registry

NOW = datetime(2026, 10, 24, 2, 0, tzinfo=timezone.utc)
TOKEN = "Bearer test-token-0123456789"


def registry_row(**changes) -> dict:
    row = {"id": "known-site", "name": "Known medical news", "homepage": "https://www.known.example.org/",
           "lane": "mixed", "source_type": "media", "access": "rss", "egress": "direct", "authority": 3,
           "safety_feed": False, "owner_entity": "Known", "launch_tier": "P1", "language": "en", "region": "US",
           "poll_floor_s": 3600, "poll_ceiling_s": 86400, "enabled": True, "disabled_reason": None, "category": "media",
           "config": {"url": "https://www.known.example.org/feed.xml", "allowed_hosts": ["www.known.example.org"], "max_pages": 1}}
    row.update(changes)
    return row


@pytest.fixture()
def registry_file(tmp_path, settings):
    path = tmp_path / "sources.json"
    path.write_text(json.dumps({"sources": [registry_row(), registry_row(
        id="j-1111-1111", name="Journal of Known Things", homepage=None, source_type="journal", access="crossref-issn",
        egress="api", lane="evidence", category="journal",
        config={"url": "https://api.crossref.org/journals/{issn}/works?rows=10&cursor={cursor}", "issn": "1111-1111",
                "issns": ["1111-1111"], "allowed_hosts": ["api.crossref.org"], "cursor_start": "*"})]}))
    return replace(settings, registry_path=str(path), leads_daily=4)


async def synced(pool, settings):
    from knowledge_plugin.dynamic_registry import sync_dynamic_registry
    from knowledge_plugin.registry import load_registry

    async with pool.connection() as conn:
        await sync_dynamic_registry(conn, lambda: load_registry(settings.registry_path), NOW)


def page(title: str, date: str | None, body: str = "正文第一段。" * 80, site: str = "新浪医药") -> bytes:
    meta = f'<meta property="article:published_time" content="{date}">' if date else ""
    return (f'<html><head><title>{title}</title><meta property="og:site_name" content="{site}">{meta}'
            f'<meta name="description" content="{title}的摘要"></head><body><article><h1>{title}</h1><p>{body}</p>'
            f'</article></body></html>').encode()


class Web:
    """Answers by URL; a URL it does not know is a 404."""

    def __init__(self, routes: dict):
        self.routes = routes
        self.calls: list[tuple[str, bool]] = []

    def egress_configured(self, egress):
        return egress != "relay"

    async def fetch(self, spec, **kwargs):
        self.calls.append((spec.url, spec.api))
        answer = self.routes.get(spec.url)
        if answer is None:
            raise FetchError("http-error", "http_404", status=404)
        if isinstance(answer, Exception):
            raise answer
        body, ctype = answer if isinstance(answer, tuple) else (answer, "text/html; charset=utf-8")
        return FetchResult(request=spec, final_url=spec.url, status=200, headers={"content-type": ctype}, body=body, fetched_at=NOW)


class FakeDajiala:
    configured = True

    def __init__(self, detail):
        self.detail = detail
        self.calls = []

    async def article_detail(self, url):
        self.calls.append(url)
        return self.detail


class FakeCollector:
    def __init__(self, detail, blocked=None):
        self.dajiala = FakeDajiala(detail)
        self.blocked = blocked

    async def bodies_blocked(self, now):
        return self.blocked

    def bodies_wait(self, now):
        return None


# ------------------------------------------------------------------------------------ pure


def test_the_contract_and_the_vocabulary_name_the_lead_access_and_line():
    spec = yaml.safe_load(open("contract/knowledge-plugin-openapi.yaml", encoding="utf-8"))
    assert CONTRACT_VERSION == spec["info"]["version"] == "1.6.0"
    assert "lead" in ACCESSES and "lead" in IMPLEMENTED_ACCESSES and "lead" in UNPOLLED_ACCESSES
    assert spec["components"]["schemas"]["Access"]["enum"] == list(ACCESSES)
    assert "/v1/leads" in spec["paths"]
    assert "lead" in LINES and DEFAULT_CAPS["lead"] == 20


def test_a_post_is_checked_against_the_contract():
    leads = parse_leads({"leads": [{"url": "https://news.example.cn/a", "trigger": "zh-report", "title": "标题",
                                    "published_hint": "2026-10-24T01:00:00Z"}]})
    assert leads[0].published_hint == datetime(2026, 10, 24, 1, tzinfo=timezone.utc)
    for bad, field in (({"leads": []}, "leads"), ({"leads": [{"url": "ftp://x.example/a", "trigger": "zh-report"}]}, "leads.url"),
                       ({"leads": [{"url": "https://x.example/a", "trigger": "Bad Trigger"}]}, "leads.trigger"),
                       ({"leads": [{"url": "https://x.example/a", "trigger": "zh-report", "extra": 1}]}, "leads"),
                       ({"leads": [{"url": "https://x.example/a", "trigger": "zh-report", "published_hint": "yesterday"}]}, "leads.published_hint"),
                       ({"leads": [{"url": f"https://x.example/{n}", "trigger": "hot-tag"} for n in range(51)]}, "leads")):
        with pytest.raises(LeadsInvalid) as raised:
            parse_leads(bad)
        assert raised.value.field == field


def test_what_an_address_names():
    assert lead_kind("https://mp.weixin.qq.com/s?__biz=MzA5&mid=1&idx=1&sn=x") == ("wechat", None)
    assert lead_kind("https://doi.org/10.1056/NEJMoa2412345") == ("doi", "10.1056/nejmoa2412345")
    assert lead_kind("https://pubmed.ncbi.nlm.nih.gov/39876543/") == ("pmid", "39876543")
    assert lead_kind("https://clinicaltrials.gov/study/nct01234567") == ("nct", "NCT01234567")
    assert lead_kind("https://news.example.cn/a") == ("page", None)
    assert identity_keys("https://doi.org/10.1056/x")[1] == "doi:10.1056/x"
    assert _wechat_time("1761271200") == datetime(2025, 10, 24, 2, 0, tzinfo=timezone.utc)
    assert _wechat_time("2026-10-24 10:00") == datetime(2026, 10, 24, 2, 0, tzinfo=timezone.utc), "Beijing wall time"
    assert _wechat_time("soon") is None


def test_a_lead_source_is_a_registry_row_that_loads_and_is_never_polled():
    row = lead_source_row("site:news.example.cn", name="示例医药网", homepage="https://news.example.cn/", url="https://news.example.cn/",
                          source_type="media", owner="news.example.cn")
    parsed = parse_registry({"sources": [row]})[0]
    assert parsed.source.access == "lead" and parsed.source.owner_entity == "news.example.cn" and parsed.source.name == "示例医药网"
    assert row["id"].startswith("lead-") and row["id"] == lead_source_row("site:news.example.cn", name="x", homepage=None,
                                                                          url="https://news.example.cn/", source_type="media", owner="x")["id"]


# ------------------------------------------------------------------------------------ the API


async def test_a_post_is_answered_address_by_address_idempotent_and_capped(registry_file, pool):
    from knowledge_plugin.api import create_app

    await synced(pool, registry_file)
    async with pool.connection() as conn:
        await conn.execute("""UPDATE evimed_knowledge.sources SET disabled_reason = 'owner_excluded' WHERE id = 'known-site'""")
    app = create_app(registry_file, pool=pool, clock=lambda: NOW)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://plugin") as http:
        assert (await http.post("/v1/leads", json={"leads": [{"url": "https://a.example.cn/1", "trigger": "zh-report"}]})).status_code == 401
        http.headers["Authorization"] = TOKEN
        first = await http.post("/v1/leads", json={"leads": [
            {"url": "https://a.example.cn/1?utm_source=x", "trigger": "zh-report", "title": "一"},
            {"url": "https://a.example.cn/2", "trigger": "zh-report"},
            {"url": "https://www.known.example.org/news/1", "trigger": "hot-tag"},
            {"url": "https://localhost/x", "trigger": "hot-tag"}]})
        assert first.status_code == 200
        body = first.json()
        assert [r["status"] for r in body["results"]] == ["accepted", "accepted", "refused", "refused"]
        assert [body[k] for k in ("accepted", "duplicate", "refused", "capped")] == [2, 0, 2, 0]
        assert body["results"][2]["reason"] == "excluded"
        again = (await http.post("/v1/leads", json={"leads": [{"url": "https://a.example.cn/1", "trigger": "event-hot"},
                                                              {"url": "https://a.example.cn/3", "trigger": "hot-tag"},
                                                              {"url": "https://a.example.cn/4", "trigger": "hot-tag"},
                                                              {"url": "https://a.example.cn/5", "trigger": "hot-tag"}]})).json()
        assert [r["status"] for r in again["results"]] == ["duplicate", "accepted", "accepted", "capped"], "four a day"
        assert (await http.post("/v1/leads", json={"leads": [{"url": "nope", "trigger": "hot-tag"}]})).json()["code"] == "invalid_params"
        health = (await http.get("/v1/health")).json()
        assert health["leads"] == {"today": {"queued": 4, "fetched": 0, "stale": 0, "failed": 0, "refused": 0}, "queued": 4}
        manifest = (await http.get("/v1/manifest")).json()
        assert manifest["capabilities"]["leads"] is True
    off = create_app(replace(registry_file, leads_enabled=False), pool=pool, clock=lambda: NOW)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=off), base_url="http://plugin") as http:
        http.headers["Authorization"] = TOKEN
        refused = await http.post("/v1/leads", json={"leads": [{"url": "https://a.example.cn/9", "trigger": "hot-tag"}]})
        assert refused.status_code == 501 and refused.json()["code"] == "capability_unavailable"


async def test_a_page_the_stream_already_holds_is_a_duplicate(registry_file, pool):
    from knowledge_plugin.api import create_app
    from knowledge_plugin.model import NormalizedEntry
    from knowledge_plugin.normalize import prepare
    from knowledge_plugin.registry import source_from_row
    from knowledge_plugin.store import store_entries

    await synced(pool, registry_file)
    async with pool.connection() as conn:
        row = await (await conn.execute("SELECT * FROM evimed_knowledge.sources WHERE id = 'known-site'")).fetchone()
        await store_entries(conn, "known-site", [prepare(NormalizedEntry(external_key="g1", url="https://www.known.example.org/news/7",
                                                                         title="Held", published_at=NOW), source_from_row(row))],
                            now=NOW, first_contact=False)
    app = create_app(registry_file, pool=pool, clock=lambda: NOW)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://plugin") as http:
        http.headers["Authorization"] = TOKEN
        answer = (await http.post("/v1/leads", json={"leads": [{"url": "http://www.known.example.org/news/7", "trigger": "zh-report"}]})).json()
    assert answer["results"] == [{"url": "http://www.known.example.org/news/7", "status": "duplicate", "reason": "in_stream"}]


# ------------------------------------------------------------------------------------ reading


async def queue(pool, settings, *urls: str, hint: datetime | None = None) -> None:
    from knowledge_plugin.leads import parse_leads, submit

    async with pool.connection() as conn:
        await submit(conn, parse_leads({"leads": [{"url": url, "trigger": "zh-report", "title": "搜索标题",
                                                   **({"published_hint": hint.isoformat()} if hint else {})} for url in urls]}),
                     NOW, daily_cap=100, excluded=set())


async def entries(pool) -> list[dict]:
    async with pool.connection() as conn:
        return [dict(r) for r in await (await conn.execute(
            "SELECT e.*, t.text_kind, t.body_text FROM evimed_knowledge.entries e LEFT JOIN evimed_knowledge.entry_texts t USING (entry_id) ORDER BY seq")).fetchall()]


async def leads_by_url(pool) -> dict:
    async with pool.connection() as conn:
        return {r["url"]: dict(r) for r in await (await conn.execute("SELECT * FROM evimed_knowledge.leads")).fetchall()}


async def test_a_page_of_an_unknown_site_becomes_an_entry_under_its_own_lead_source_and_a_discovery_candidate(registry_file, pool):
    await synced(pool, registry_file)
    await queue(pool, registry_file, "https://med.example.cn/news/1", "https://med.example.cn/old/2", "https://med.example.cn/undated/3",
                "https://www.known.example.org/news/5")
    web = Web({"https://med.example.cn/news/1": page("司美格鲁肽获批新适应症", "2026-10-23T08:00:00+08:00"),
               "https://med.example.cn/old/2": page("旧闻", "2026-07-01T08:00:00+08:00"),
               "https://med.example.cn/undated/3": page("无日期", None),
               "https://www.known.example.org/news/5": page("A known site's story", "2026-10-23", body="Body text. " * 60, site="Known")})
    reader = LeadReader(registry_file, pool, web, clock=lambda: NOW, data={"exclude_hosts": []})
    report = await reader.tick()
    assert report["read"] == 4 and report["lead_sources"] == 1 and report["candidates"] == 1
    assert all(api is False for _, api in web.calls), "a page is read as a page: robots apply"
    stored = sorted(await entries(pool), key=lambda e: e["title"])
    assert [(e["source_id"].startswith("lead-"), e["title"]) for e in stored] == [(False, "A known site's story"), (True, "司美格鲁肽获批新适应症")]
    known, lead_entry = stored
    assert lead_entry["lang"] == "zh" and lead_entry["channel"] == "news" and lead_entry["backfill"] is False
    assert lead_entry["text_status"] == "available" and lead_entry["text_kind"] == "full" and "正文第一段" in lead_entry["body_text"]
    assert known["source_id"] == "known-site", "the registered source of the site"
    async with pool.connection() as conn:
        source = await (await conn.execute("SELECT * FROM evimed_knowledge.sources WHERE id = %s", (lead_entry["source_id"],))).fetchone()
        candidate = await (await conn.execute("SELECT line, key, evidence FROM evimed_knowledge.source_candidates")).fetchone()
    assert (source["name"], source["owner_entity"], source["access"], source["retired_at"]) == ("新浪医药", "med.example.cn", "lead", None)
    assert (candidate["line"], candidate["key"]) == ("lead", "https://med.example.cn/")
    states = {url: (row["state"], row["state_reason"]) for url, row in (await leads_by_url(pool)).items()}
    assert states["https://med.example.cn/old/2"] == ("stale", "older_than_window")
    assert states["https://med.example.cn/undated/3"] == ("stale", "undated")
    assert states["https://med.example.cn/news/1"][0] == "fetched"
    # A later registry reload keeps the lead source composed (a sync retires what the composition leaves out).
    await synced(pool, registry_file)
    async with pool.connection() as conn:
        assert (await (await conn.execute("SELECT retired_at FROM evimed_knowledge.sources WHERE id = %s",
                                          (lead_entry["source_id"],))).fetchone())["retired_at"] is None
        polled = await (await conn.execute("SELECT count(*) AS n FROM evimed_knowledge.sources WHERE access = 'lead'")).fetchone()
    assert polled["n"] == 1
    assert await reader.tick() == {"read": 0}, "a read lead is not read again"


async def test_an_identifier_is_read_from_its_index_and_a_trial_from_the_registry_api(registry_file, pool):
    await synced(pool, registry_file)
    await queue(pool, registry_file, "https://doi.org/10.5555/known.1", "https://doi.org/10.5555/other.2",
                "https://pubmed.ncbi.nlm.nih.gov/39876543/", "https://clinicaltrials.gov/study/NCT07654321")
    crossref = "https://api.crossref.org/works"
    web = Web({
        f"{crossref}/10.5555/known.1": (json.dumps({"message": {"title": ["A known journal's paper"], "container-title": ["Journal of Known Things"],
                                                                 "ISSN": ["1111-1111"], "published-online": {"date-parts": [[2026, 9, 1]]},
                                                                 "URL": "https://doi.org/10.5555/known.1", "type": "journal-article"}}).encode(), "application/json"),
        f"{crossref}/10.5555/other.2": (json.dumps({"message": {"title": ["Elsewhere"], "container-title": ["Other Journal"], "ISSN": ["2222-2222"],
                                                                 "publisher": "Other Press", "created": {"date-parts": [[2026, 10, 20]]}}}).encode(), "application/json"),
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=39876543": (json.dumps({"result": {"39876543": {
            "title": "A PubMed record.", "fulljournalname": "Journal of Known Things", "issn": "1111-1111", "sortpubdate": "2026/10/01 00:00",
            "articleids": [{"idtype": "doi", "value": "10.5555/pm.3"}]}}}).encode(), "application/json"),
        "https://clinicaltrials.gov/api/v2/studies/NCT07654321": (json.dumps({"protocolSection": {
            "identificationModule": {"briefTitle": "A phase 3 trial"}, "statusModule": {"overallStatus": "COMPLETED",
                                                                                       "resultsFirstPostDateStruct": {"date": "2026-10-20"}},
            "descriptionModule": {"briefSummary": "A summary."}}}).encode(), "application/json"),
    })
    report = await LeadReader(registry_file, pool, web, clock=lambda: NOW, data={"exclude_hosts": []}).tick()
    assert report["read"] == 4
    assert all(api for _, api in web.calls), "identifiers are read through their APIs"
    by_key = {e["identity_key"]: e for e in await entries(pool)}
    assert by_key["doi:10.5555/known.1"]["source_id"] == "j-1111-1111", "the registered journal of its ISSN"
    assert by_key["doi:10.5555/known.1"]["backfill"] is False, "asked for: never a first contact's backlog, though seven weeks old"
    assert by_key["doi:10.5555/other.2"]["source_id"].startswith("lead-")
    assert by_key["doi:10.5555/pm.3"]["pmid"] == "39876543"
    trial = by_key["reg:NCT07654321:results-posted:2026-10-20"]
    assert trial["channel"] == "registry" and trial["registry_ids"] == ["NCT07654321"] and trial["facts"]["trial_event"] == "results-posted"
    async with pool.connection() as conn:
        lines = {r["key"]: r["line"] for r in await (await conn.execute("SELECT key, line FROM evimed_knowledge.source_candidates")).fetchall()}
    assert lines == {"issn:2222-2222": "lead"}, "a journal no source covers is a candidate; ClinicalTrials.gov is not"


async def test_a_wechat_article_is_bought_within_the_shared_cap_never_read_as_a_page(registry_file, pool):
    await synced(pool, registry_file)
    link = "https://mp.weixin.qq.com/s?__biz=MzA5&mid=2247&idx=1&sn=abc"
    await queue(pool, registry_file, link)
    detail = {"code": 0, "title": "NEJM 重磅：新药降低心血管事件", "nick_name": "医学界", "user_name": "gh_x", "alias": "yxj", "biz": "MzA5",
              "desc": "导语", "pubtime": "2026-10-23 20:00", "content_multi_text": "<p>第一段。</p><p>第二段。</p>"}
    collector = FakeCollector(detail)
    web = Web({})
    report = await LeadReader(registry_file, pool, web, collector=collector, clock=lambda: NOW, data={"exclude_hosts": []}).tick()
    assert report["read"] == 1 and web.calls == [], "mp.weixin.qq.com is never fetched as a page"
    assert collector.dajiala.calls == [link]
    [entry] = await entries(pool)
    assert (entry["platform"], entry["channel"], entry["identity_key"]) == ("wechat", "wechat", "wx:MzA5:2247:1")
    assert entry["body_text"] == "第一段。\n\n第二段。"
    async with pool.connection() as conn:
        source = await (await conn.execute("SELECT name, owner_entity, access FROM evimed_knowledge.sources WHERE id = %s", (entry["source_id"],))).fetchone()
        candidate = await (await conn.execute("SELECT line, key, evidence FROM evimed_knowledge.source_candidates")).fetchone()
    assert dict(source) == {"name": "医学界", "owner_entity": "医学界", "access": "lead"}
    assert (candidate["line"], candidate["key"]) == ("lead", "wechat:MzA5")
    assert candidate["evidence"]["hint"]["verified_url"] == link
    # The day's Dajiala cap spent: the lead waits for tomorrow, no attempt spent past the third.
    link2 = "https://mp.weixin.qq.com/s?__biz=MzA5&mid=2248&idx=1&sn=def"
    await queue(pool, registry_file, link2)
    capped = FakeCollector(detail, blocked="daily_cap")
    await LeadReader(registry_file, pool, Web({}), collector=capped, clock=lambda: NOW, data={"exclude_hosts": []}).tick()
    waiting = (await leads_by_url(pool))[link2]
    assert (waiting["state"], waiting["state_reason"]) == ("queued", "dajiala_daily_cap") and waiting["next_attempt_at"] > NOW + timedelta(hours=10)
    assert capped.dajiala.calls == []


async def test_a_site_discovery_excludes_is_read_but_never_proposed(registry_file, pool):
    await synced(pool, registry_file)
    await queue(pool, registry_file, "https://www.163.com/news/1")
    web = Web({"https://www.163.com/news/1": page("网易报道", "2026-10-23T08:00:00+08:00", site="网易")})
    report = await LeadReader(registry_file, pool, web, clock=lambda: NOW, data={"exclude_hosts": ["163.com"]}).tick()
    assert report["read"] == 1 and report["candidates"] == 0
    assert len(await entries(pool)) == 1
