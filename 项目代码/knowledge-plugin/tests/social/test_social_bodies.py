"""``social-bodies`` (2026-10-31): the posts stored cut, restored whole from the crawler's retained jobs — a dry run that writes
nothing, an apply that stores and delivers again, the second apply that finds nothing. The crawler is faked."""

from __future__ import annotations

import asyncio
import json
from datetime import timedelta

import httpx
import pytest

from knowledge_plugin.social import crawl as crawl_mod
from knowledge_plugin.social import cut_posts
from knowledge_plugin.social.collector import SocialCollector
from knowledge_plugin.social.providers import CrawlClient, ProviderError
from knowledge_plugin.social.spend import ProviderLedger

from social_fakes import FakeFetcher
from test_social_collectors import NOW, crawl_row, entries, sync

pytestmark = pytest.mark.db


def jid(n: int) -> str:
    return f"{n:032x}"


def whole(text_id: str, length: int = 900) -> str:
    return "。".join(f"{text_id}句{n}" for n in range(length // 6))


def job(n: int, platform: str, posts: list[dict], *, envelope=False) -> dict:
    result = {"platform": platform, "meta": {"collection_status": "collected"}, "posts": posts}
    return {"job_id": jid(n), "job_status": "done", "query": "高血压", "platforms": [platform],
            "result": {"results": {platform: result}} if envelope else result}


def post(post_id: str, content: str, *, title: str = "标题", host="www.xiaohongshu.com") -> dict:
    return {"post_id": post_id, "title": title, "content": content, "url": f"https://{host}/explore/{post_id}",
            "publish_time": int((NOW - timedelta(hours=3)).timestamp()), "author": "不应出现", "raw_response": {"user": {"nickname": "不应出现"}}}


def crawler_server(jobs: dict[str, dict | int], *, page_limit=None, seen: list | None = None):
    """The retained-jobs API: the listing by limit/offset, then each job (an int is the status it answers)."""
    order = list(jobs)

    def handle(request: httpx.Request):
        assert request.method == "GET" and request.headers["authorization"] == "Bearer fake-crawler-key"
        if seen is not None:
            seen.append(str(request.url))
        if request.url.path == "/api/jobs":
            query = dict(request.url.params)
            limit = min(int(query["limit"]), page_limit or 10**6)
            offset = int(query["offset"])
            ids = order[offset:offset + limit]
            return httpx.Response(200, json={"total": len(order), "jobs": [{"job_id": i, "job_status": "done", "attempts": 1} for i in ids]})
        answer = jobs.get(request.url.path.rsplit("/", 1)[-1])
        if isinstance(answer, int):
            return httpx.Response(answer, json={"detail": "x"})
        return httpx.Response(200, json=answer)

    return handle


def crawler_for(settings, pool, handler) -> CrawlClient:
    return CrawlClient(ProviderLedger(pool, lambda: NOW), settings, lambda: NOW, transport=httpx.MockTransport(handler),
                       poll_retry_delays_s=(0.0, 0.0))


async def store_cut(settings, pool, posts: list[tuple[str, dict]], *, full=()):
    """Entries in the shape the posts had until 2026-10-31: the excerpt (title + content cut to 300) and no text of their own."""
    await sync(pool, [crawl_row("xhs", "xiaohongshu"), crawl_row("weibo", "weibo")])
    collector = SocialCollector(settings, pool, FakeFetcher(), clock=lambda: NOW)
    for platform, item in posts:
        entry = crawl_mod.build_entry(item, platform, now=NOW)
        if item["post_id"] not in full:
            entry.body_text, entry.body_kind = entry.summary, "excerpt"
        async with pool.connection() as conn:
            row = await (await conn.execute("SELECT * FROM evimed_knowledge.sources WHERE id = %s", (f"social-{entry.platform}",))).fetchone()
        await collector._store(row, [entry], NOW)
    return collector


async def state(pool):
    return {row["external_key"]: row for row in await entries(pool, "social-xiaohongshu") + await entries(pool, "social-weibo")}


async def test_it_restores_the_whole_text_of_the_posts_stored_cut_and_only_those(social_settings, pool):
    p1, p2, p3, p4, w1 = post("p1", whole("甲")), post("p2", whole("乙", 1200)), post("p3", "标题"), post("p4", whole("丁")), post("w1", whole("戊"), host="m.weibo.cn")
    await store_cut(social_settings, pool, [("xhs", p1), ("xhs", p2), ("xhs", p3), ("weibo", w1)], full={"w1"})
    before = await state(pool)
    assert before["xhs:p1"]["text_kind"] == "excerpt" and before["xhs:p1"]["body_text"] is None
    assert before["weibo:w1"]["text_kind"] == "full"

    shorter = post("p2", whole("乙", 600))
    jobs = {jid(1): job(1, "xhs", [p1, shorter]), jid(2): job(2, "xhs", [p2, p3, p4]),            # p2 twice: the longer content wins
            jid(3): job(3, "weibo", [w1], envelope=True), jid(4): 500, jid(5): job(5, "xhs", [])}
    crawler = crawler_for(social_settings, pool, crawler_server(jobs))

    report = await cut_posts.report(crawler, pool, NOW)
    assert report["entries"] == [{"platform": "weibo", "posts": 1, "to_fill": 0, "already_full": 1, "not_stored": 0},
                                 {"platform": "xiaohongshu", "posts": 3, "to_fill": 2, "already_full": 0, "not_stored": 1}]
    assert report["summary"] == {"listed": 5, "read": 4, "unreadable": 1, "posts": 4, "to_fill": 2}
    assert await state(pool) == before, "a dry run writes nothing"

    outcome = await cut_posts.apply(crawler, pool, lambda: NOW + timedelta(minutes=1))
    assert outcome["summary"] == {"listed": 5, "read": 4, "unreadable": 1, "posts": 4, "filled": 2}
    after = await state(pool)
    for key, content in (("xhs:p1", p1["content"]), ("xhs:p2", p2["content"])):
        assert after[key]["body_text"] == content and after[key]["text_kind"] == "full" and after[key]["text_status"] == "available"
        assert after[key]["revision"] == before[key]["revision"] + 1 and after[key]["seq"] > before[key]["seq"]
        assert after[key]["summary"] == before[key]["summary"] and after[key]["title"] == before[key]["title"]
    for key in ("xhs:p3", "weibo:w1"):
        assert after[key]["revision"] == before[key]["revision"], "a title-only post and a post stored whole are left as they were"
    assert "xhs:p4" not in after, "a post that was never stored is not stored by this command"
    assert "不应出现" not in json.dumps([dict(r) for r in after.values()], default=str, ensure_ascii=False)

    again = await cut_posts.apply(crawler, pool, lambda: NOW + timedelta(minutes=2))
    assert again["summary"]["filled"] == 0 and await state(pool) == after, "idempotent"
    assert (await cut_posts.report(crawler, pool, NOW))["summary"]["to_fill"] == 0


async def test_the_listing_is_read_page_by_page_to_its_end_and_a_busy_crawler_is_waited_for(social_settings, pool, monkeypatch):
    jobs = {jid(n): job(n, "xhs", [post(f"q{n}", whole("甲"))]) for n in range(1, 6)}
    seen: list[str] = []
    busy = {jid(3): 2}
    server = crawler_server(jobs, page_limit=2, seen=seen)

    def handle(request):
        job_id = request.url.path.rsplit("/", 1)[-1]
        if busy.get(job_id):
            busy[job_id] -= 1
            return httpx.Response(429, headers={"retry-after": "1"}, json={"detail": "busy"})
        return server(request)

    waits: list[float] = []

    async def no_sleep(seconds):
        waits.append(seconds)

    monkeypatch.setattr(asyncio, "sleep", no_sleep)
    counts = await crawler_for(social_settings, pool, handle).retained(page=2)
    assert counts == {"listed": 5, "read": 5, "unreadable": 0}
    assert [url.split("?")[1] for url in seen if "?" in url] == ["limit=2&offset=0", "limit=2&offset=2", "limit=2&offset=4", "limit=2&offset=5"]
    assert waits == [1.0, 1.0], "the crawler named the wait; it is taken twice, the job then reads"
    ledger_rows = await _calls(pool)
    assert ledger_rows == 0, "reading retained jobs is no crawl request: the day's cap and the ledger are untouched"


async def _calls(pool) -> int:
    async with pool.connection() as conn:
        return (await (await conn.execute("SELECT count(*) AS n FROM evimed_knowledge.provider_calls")).fetchone())["n"]


async def test_a_crawler_that_ignores_the_offset_or_fails_a_later_page_ends_the_listing_and_the_first_page_failing_is_an_error(social_settings, pool):
    jobs = {jid(1): job(1, "xhs", [post("a", whole("甲"))])}

    def ignores_offset(request):
        if request.url.path == "/api/jobs":
            return httpx.Response(200, json=[{"job_id": jid(1)}])
        return httpx.Response(200, json=jobs[jid(1)])

    assert await crawler_for(social_settings, pool, ignores_offset).retained(page=1) == {"listed": 1, "read": 1, "unreadable": 0}

    def second_page_down(request):
        if request.url.path == "/api/jobs" and request.url.params["offset"] != "0":
            return httpx.Response(500)
        return crawler_server({jid(1): jobs[jid(1)], jid(2): jobs[jid(1)]}, page_limit=1)(request)

    counts = await crawler_for(social_settings, pool, second_page_down).retained(page=1)
    assert counts == {"listed": 1, "read": 1, "unreadable": 0, "stopped": "list_failed"}

    with pytest.raises(ProviderError) as error:
        await crawler_for(social_settings, pool, lambda request: httpx.Response(401)).retained()
    assert error.value.detail == "jobs_unlistable"


async def test_the_command_reads_the_jobs_of_the_crawler_it_is_configured_for(social_settings, pool, monkeypatch, capsys):
    from knowledge_plugin import __main__ as main

    p1 = post("p1", whole("甲"))
    await store_cut(social_settings, pool, [("xhs", p1)])
    handler = crawler_server({jid(1): job(1, "xhs", [p1])})
    real = CrawlClient

    def with_transport(ledger, settings, clock):
        return real(ledger, settings, clock, transport=httpx.MockTransport(handler))

    monkeypatch.setattr("knowledge_plugin.social.providers.CrawlClient", with_transport)
    monkeypatch.setattr("knowledge_plugin.db.create_pool", _pool_of(pool))
    assert await main._social_bodies(social_settings, apply=False) == 0
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert lines == [{"platform": "xiaohongshu", "posts": 1, "to_fill": 1, "already_full": 0, "not_stored": 0},
                     {"listed": 1, "read": 1, "unreadable": 0, "posts": 1, "to_fill": 1}]


def _pool_of(pool):
    class Keep:
        def __init__(self, inner):
            self._inner = inner

        def __getattr__(self, name):
            return getattr(self._inner, name)

        async def close(self):         # the test's pool is the fixture's to close
            return None

    async def create(settings):
        return Keep(pool)

    return create
