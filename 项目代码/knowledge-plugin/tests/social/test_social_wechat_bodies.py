"""WeChat bodies survive a provider hiccup (fr-ext 2026-10-22).

On 2026-10-22 production had 88 of 300 Dajiala ``article_detail`` calls answer code 20002 while the balance ran down; the
posts were stored without their text, ``/text`` then read mp.weixin.qq.com (robots.txt refuses it) and the text was never
recovered. Here, with Dajiala faked: 20002 is a failure that passes, a WeChat text is bought when the platform asks for it
(never read as a page), the retries are bounded per entry and across entries, and the entries already lost are bought
again by the ops command, which delivers each recovered entry as its next revision."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

import pytest

from knowledge_plugin.enrich import enrich_batch
from knowledge_plugin.model import EntryTextResult
from knowledge_plugin.scheduler import Crawler
from knowledge_plugin.social import lost_bodies
from knowledge_plugin.social import wechat as wechat_mod
from knowledge_plugin.social.collector import SocialCollector
from knowledge_plugin.social.providers import DajialaClient, ProviderError
from knowledge_plugin.store import save_text_result, schedule_text

from social_fakes import FakeFetcher
from test_social_collectors import NOW, entries, sync, wx_post, wx_row

DETAIL = "https://www.dajiala.com/fbmain/monitor/v3/article_detail"
HISTORY = "https://www.dajiala.com/fbmain/monitor/v3/post_history"
VERIFIED = "https://mp.weixin.qq.com/s?__biz=MzA5&mid=1&idx=2&sn=a"


class Clock:
    def __init__(self, now: datetime = NOW) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **delta) -> None:
        self.now += timedelta(**delta)


def ok_detail(text="<p>第一段。</p><p>第二段。</p>"):
    return {"code": 0, "content": text, "nick_name": "丁香园心血管时间", "user_name": "gh_real", "alias": "dxy", "biz": "MzA5",
            "cost_money": 0.03, "remain_money": 20.57}


class Dajiala:
    """The two Dajiala routes, scripted: ``answers[link]`` is a list of answers given in turn (the last one repeats), any
    other link reads ``default``; the verified link always resolves the account."""

    def __init__(self, posts, *, default=None, answers=None) -> None:
        self.posts = posts
        self.default = default or ok_detail()
        self.answers = answers or {}
        self.asked: list[str] = []

    def history(self, spec):
        return 200, {"code": 0, "nickname": "丁香园心血管时间", "ghid": "gh_real", "cost_money": 0.14, "data": self.posts}

    def detail(self, spec):
        link = parse_qs(urlsplit(spec.url).query)["url"][0]
        self.asked.append(link)
        if link == VERIFIED:
            return 200, ok_detail()
        script = self.answers.get(link)
        if script:
            return 200, script.pop(0) if len(script) > 1 else script[0]
        return 200, self.default

    def fetcher(self) -> FakeFetcher:
        return FakeFetcher({("POST", HISTORY): self.history, ("GET", DETAIL): self.detail})

    def bodies_asked(self) -> list[str]:
        return [link for link in self.asked if link != VERIFIED]


def link(mid, idx=1) -> str:
    return f"https://mp.weixin.qq.com/s?__biz=MzA5&mid={mid}&idx={idx}&sn=s{mid}&chksm=x"


def failing(code=20002):
    return {"code": code, "msg": "", "cost_money": 0, "remain_money": 20.57}


def no_page_reader(calls):
    async def enricher(job, fetcher, settings):   # a WeChat text must never reach the page reader
        calls.append(job["entry_id"])
        return EntryTextResult(status="unavailable", notes=["page_robots-denied:robots_disallow"])
    return enricher


def text_worker(settings, pool, fetcher, clock, page_reads=None) -> Crawler:
    """The scheduler's text worker, eight jobs a tick, with a page reader that records whatever reaches it."""
    from dataclasses import replace

    return Crawler(replace(settings, text_concurrency=8), pool, fetcher, adapters={},
                   enricher=no_page_reader([] if page_reads is None else page_reads), clock=clock)


async def collect(social_settings, pool, dajiala, clock) -> SocialCollector:
    collector = SocialCollector(social_settings, pool, dajiala.fetcher(), clock=clock)
    assert (await collector.tick())["wechat"] == {"ok": 1}
    return collector


async def ask_text(pool, clock, rows):
    """What the platform's ``GET /v1/entries/{id}/text`` does first: queue the text."""
    async with pool.connection() as conn:
        for row in rows:
            await schedule_text(conn, row["entry_id"], row["revision"], clock(), reset=False)


async def texts(pool):
    async with pool.connection() as conn:
        rows = await (await conn.execute(
            """SELECT e.external_key, e.text_status, e.revision, e.seq, t.body_text, t.text_kind, t.fetched_from, t.paid_attempts,
                      t.last_error, t.next_attempt_at
                 FROM evimed_knowledge.entries e LEFT JOIN evimed_knowledge.entry_texts t USING (entry_id)""")).fetchall()
    return {row["external_key"]: row for row in rows}


pytestmark = pytest.mark.db


async def test_code_20002_is_a_failure_that_passes_not_a_wrong_request(social_settings, pool):
    from knowledge_plugin.social.spend import ProviderLedger

    clock = Clock()
    fetcher = FakeFetcher({("GET", DETAIL): lambda spec: (200, failing(20002))})
    client = DajialaClient(fetcher, ProviderLedger(pool, clock), social_settings, clock)
    with pytest.raises(ProviderError) as raised:
        await client.article_detail(link(7))
    assert raised.value.kind == "failed" and raised.value.detail == "code_20002"
    fetcher = FakeFetcher({("GET", DETAIL): lambda spec: (200, failing(20003))})
    client = DajialaClient(fetcher, ProviderLedger(pool, clock), social_settings, clock)
    with pytest.raises(ProviderError) as raised:
        await client.article_detail(link(7))
    assert raised.value.kind == "bad-request", "the other documented wrong-request codes stay final"
    async with pool.connection() as conn:
        rows = await (await conn.execute("SELECT outcome, error FROM evimed_knowledge.provider_calls ORDER BY id")).fetchall()
    assert [(row["outcome"], row["error"]) for row in rows] == [("failed", "code_20002"), ("failed", "code_20003")]


async def test_a_body_lost_at_collection_is_bought_when_the_platform_asks_and_the_page_is_never_read(social_settings, pool):
    clock = Clock()
    await sync(pool, [wx_row()])
    dajiala = Dajiala([wx_post(7, 1), wx_post(7, 2)], answers={link(7, 1): [failing(20002), ok_detail("<p>正文终于来了。</p>")]})
    await collect(social_settings, pool, dajiala, clock)
    stored = await texts(pool)
    assert stored["MzA5:7:1"]["body_text"] is None and stored["MzA5:7:1"]["text_status"] == "none", "stored without it"
    assert stored["MzA5:7:2"]["body_text"] == "第一段。\n\n第二段。", "a failure that passes does not stop the read"

    page_reads: list[str] = []
    crawler = text_worker(social_settings, pool, dajiala.fetcher(), clock, page_reads)
    await ask_text(pool, clock, await entries(pool, "wx-dxy-heart"))
    clock.advance(minutes=1)
    await crawler._text_tick()
    after = await texts(pool)
    assert page_reads == [], "a WeChat text never reaches the page reader"
    assert not [call for call in crawler._fetcher.calls if "mp.weixin.qq.com/s" in call["url"].split("?")[0]]
    lost = after["MzA5:7:1"]
    assert lost["text_status"] == "available" and lost["body_text"] == "正文终于来了。"
    assert lost["text_kind"] == "full" and lost["fetched_from"] == "wechat" and lost["paid_attempts"] == 1
    assert after["MzA5:7:2"]["paid_attempts"] == 1 and after["MzA5:7:2"]["body_text"] == "第一段。\n\n第二段。"


async def test_a_text_that_keeps_failing_is_retried_later_six_calls_at_most(social_settings, pool):
    clock = Clock()
    await sync(pool, [wx_row()])
    dajiala = Dajiala([wx_post(7, 1)], answers={link(7, 1): [failing(20002)]})
    await collect(social_settings, pool, dajiala, clock)
    crawler = text_worker(social_settings, pool, dajiala.fetcher(), clock)
    await ask_text(pool, clock, await entries(pool, "wx-dxy-heart"))
    waits = []
    for _ in range(20):
        before = len(dajiala.bodies_asked())
        await crawler._text_tick()
        row = (await texts(pool))["MzA5:7:1"]
        if len(dajiala.bodies_asked()) > before:
            waits.append(row["next_attempt_at"] - clock() if row["next_attempt_at"] else None)
        if row["text_status"] != "pending":
            break
        clock.now = max(clock.now, row["next_attempt_at"]) + timedelta(seconds=1)
    assert row["text_status"] == "unavailable" and "wechat_body_calls_spent" in row["last_error"]
    assert row["paid_attempts"] == 6 and len(dajiala.bodies_asked()) == 1 + 6, "the collection's own try, then six"
    assert waits[:5] == [timedelta(minutes=30), timedelta(hours=1), timedelta(hours=2), timedelta(hours=4),
                         timedelta(hours=6)], "the wait doubles, at most six hours"
    assert wechat_mod.body_retry_after(9) == timedelta(hours=6)


async def test_five_failures_in_a_row_pause_every_body_purchase_for_an_hour(social_settings, pool):
    clock = Clock()
    await sync(pool, [wx_row()])
    posts = [wx_post(mid, 1) for mid in range(10, 17)]
    dajiala = Dajiala(posts)
    collector = SocialCollector(social_settings, pool, dajiala.fetcher(), clock=clock)
    collector.wechat_bodies_per_read = 0              # stored without bodies, as after the hiccup
    await collector.tick()
    dajiala.default = failing(20002)
    crawler = text_worker(social_settings, pool, dajiala.fetcher(), clock)
    crawler._social = collector
    await ask_text(pool, clock, await entries(pool, "wx-dxy-heart"))
    await crawler._text_tick()
    assert len(dajiala.bodies_asked()) == 5, "the fifth failure in a row stops the sixth and seventh call"
    rows = await texts(pool)
    paused = [row for row in rows.values() if row["last_error"] == "dajiala_paused"]
    assert len(paused) == 2 and all(row["paid_attempts"] == 0 for row in paused)
    assert collector.bodies_wait(clock()) == NOW + timedelta(hours=1)

    clock.advance(hours=12, minutes=1)                # the account's next read, an hour paused again by a new streak
    collector.bodies_paused_until = clock() + timedelta(minutes=30)
    collector.wechat_bodies_per_read = 8
    dajiala.posts = posts + [wx_post(20, 1, hours=1)]
    asked = len(dajiala.bodies_asked())
    await collector.tick()
    assert len(dajiala.bodies_asked()) == asked, "a read while bodies are paused buys none"
    assert (await texts(pool))["MzA5:20:1"]["body_text"] is None


async def test_a_refused_key_or_a_spent_balance_waits_without_spending_an_entrys_calls(social_settings, pool):
    clock = Clock()
    await sync(pool, [wx_row()])
    dajiala = Dajiala([wx_post(7, 1), wx_post(8, 1)])
    collector = SocialCollector(social_settings, pool, dajiala.fetcher(), clock=clock)
    collector.wechat_bodies_per_read = 0
    await collector.tick()
    dajiala.default = failing(10002)
    crawler = text_worker(social_settings, pool, dajiala.fetcher(), clock)
    crawler._social = collector
    await ask_text(pool, clock, await entries(pool, "wx-dxy-heart"))
    await crawler._text_tick()
    rows = await texts(pool)
    assert len(dajiala.bodies_asked()) == 1, "a refused key pauses Dajiala: the other text waits without a call"
    assert sorted(row["last_error"] for row in rows.values()) == ["dajiala_key_refused", "dajiala_paused"]
    assert all(row["text_status"] == "pending" for row in rows.values())
    assert collector.paused["dajiala"] == NOW + timedelta(hours=1)


async def test_without_a_dajiala_key_a_wechat_text_is_unavailable_and_still_never_read_as_a_page(settings, pool):
    clock = Clock()
    await sync(pool, [wx_row()])
    async with pool.connection() as conn:
        await conn.execute(
            """INSERT INTO evimed_knowledge.entries (entry_id, source_id, external_key, identity_key, url, canonical_url,
                 title, lang, first_seen_at, content_sha256, revision, delivered_at, text_status)
               VALUES ('wx-dxy-heart:1', 'wx-dxy-heart', 'MzA5:7:1', 'wx:MzA5:7:1', %s, %s, '文章', 'zh', %s, repeat('a', 64), 1, %s, 'none')""",
            (link(7), link(7), NOW, NOW))
    fetcher = FakeFetcher()
    page_reads: list[str] = []
    crawler = text_worker(settings, pool, fetcher, clock, page_reads)
    await ask_text(pool, clock, [{"entry_id": "wx-dxy-heart:1", "revision": 1}])
    await crawler._text_tick()
    row = (await texts(pool))["MzA5:7:1"]
    assert row["text_status"] == "unavailable" and row["last_error"] == "wechat_body_unconfigured"
    assert page_reads == [] and fetcher.calls == []


async def test_the_page_reader_never_reads_a_wechat_article():
    fetcher = FakeFetcher()
    row = {"entry_id": "e1", "source_id": "some-list", "source_access": "html-list", "source_type": "media", "url": link(7),
           "title": "转载的公众号文章", "summary": "摘要", "first_seen_at": NOW}
    [result] = await enrich_batch([row], fetcher, None, now=NOW)
    assert result.status == "unavailable" and "wechat_page_not_read" in result.notes
    assert fetcher.calls == [], "not even robots.txt is asked"


async def lose_bodies(social_settings, pool, clock, posts):
    """The entries as production left them: stored without a body, asked for, answered unavailable by the page reader."""
    dajiala = Dajiala(posts, default=failing(20002))
    collector = SocialCollector(social_settings, pool, dajiala.fetcher(), clock=clock)
    await collector.tick()
    rows = await entries(pool, "wx-dxy-heart")
    await ask_text(pool, clock, rows)
    async with pool.connection() as conn:
        claimed = await (await conn.execute(
            """SELECT e.entry_id, e.revision, e.first_seen_at, e.text_requested_at, t.attempts FROM evimed_knowledge.entries e
                 JOIN evimed_knowledge.entry_texts t USING (entry_id)""")).fetchall()
        for job in claimed:
            await save_text_result(conn, job, EntryTextResult(status="unavailable", notes=["page_robots-denied:robots_disallow"]),
                                   clock())
    return dajiala


async def test_the_ops_command_reports_first_then_buys_the_lost_bodies_and_delivers_them_again(social_settings, pool):
    clock = Clock()
    await sync(pool, [wx_row()])
    old = wx_post(3, 1, hours=2)
    dajiala = await lose_bodies(social_settings, pool, clock, [wx_post(7, 1), wx_post(8, 1), wx_post(9, 1), old])
    async with pool.connection() as conn:              # one seen ten days ago is outside the window
        await conn.execute("UPDATE evimed_knowledge.entries SET first_seen_at = %s WHERE external_key = 'MzA5:3:1'",
                           (NOW - timedelta(days=10),))
    before = await texts(pool)
    asked = len(dajiala.asked)
    collector = SocialCollector(social_settings, pool, dajiala.fetcher(), clock=clock)

    clock.advance(hours=3)
    report = await lost_bodies.report(collector, pool, clock())
    assert sorted(line["entry_id"].split(":")[0] for line in report["entries"]) == ["wx-dxy-heart"] * 3
    assert report["summary"]["candidates"] == 3 and report["summary"]["estimate_cny"] == 0.09
    assert report["summary"]["daily_cap_cny"] == 30.0 and report["summary"]["dajiala_configured"] is True
    assert len(dajiala.asked) == asked and await texts(pool) == before, "the report calls nobody and writes nothing"

    dajiala.answers = {link(7): [ok_detail("<p>找回的正文。</p>")], link(8): [failing(101)], link(9): [failing(20002)]}
    outcome = await lost_bodies.apply(collector, pool, clock)
    by_key = {line["entry_id"]: line for line in outcome["entries"]}
    assert outcome["summary"] == {"candidates": 3, "recovered": 1, "unavailable": 1, "later": 1, "not_tried": 0}
    after = await texts(pool)
    recovered = after["MzA5:7:1"]
    assert recovered["text_status"] == "available" and recovered["body_text"] == "找回的正文。"
    assert recovered["revision"] == before["MzA5:7:1"]["revision"] + 1, "delivered again: the platform asks /text again"
    assert recovered["seq"] > max(row["seq"] for row in before.values()), "at the end of the stream"
    assert by_key[next(k for k in by_key if by_key[k]["outcome"] == "recovered")]["revision"] == recovered["revision"]
    assert after["MzA5:8:1"]["text_status"] == "unavailable" and after["MzA5:8:1"]["last_error"].startswith("dajiala_gone")
    assert after["MzA5:8:1"]["revision"] == before["MzA5:8:1"]["revision"]
    assert after["MzA5:9:1"]["text_status"] == "unavailable" and after["MzA5:9:1"]["paid_attempts"] == 1, "left as it was"
    assert after["MzA5:3:1"]["paid_attempts"] == 0
    async with pool.connection() as conn:
        seen = await (await conn.execute("SELECT max(revision) AS revision FROM evimed_knowledge.seen_keys")).fetchone()
    assert seen["revision"] == recovered["revision"]

    again = await lost_bodies.report(collector, pool, clock())
    assert [line["calls_so_far"] for line in again["entries"]] == [1], "only the one that may pass is left to try again"


async def test_the_ops_command_stops_at_the_days_cap(social_settings, pool):
    from dataclasses import replace

    clock = Clock()
    await sync(pool, [wx_row()])
    dajiala = await lose_bodies(social_settings, pool, clock, [wx_post(7, 1), wx_post(8, 1)])
    capped = replace(social_settings, dajiala_daily_cny=0.0)
    dajiala.default = ok_detail()
    asked = len(dajiala.asked)
    outcome = await lost_bodies.apply(SocialCollector(capped, pool, dajiala.fetcher(), clock=clock), pool, clock)
    assert outcome["summary"] == {"candidates": 2, "recovered": 0, "unavailable": 0, "later": 0, "not_tried": 2,
                                  "stopped": "daily_cap"}
    assert len(dajiala.asked) == asked
