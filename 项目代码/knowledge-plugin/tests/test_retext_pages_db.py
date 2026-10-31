"""``retext --kinds unread-page`` (2026-10-31): the page entries answered ``unavailable`` for a reason a fixed reader may now pass
(643 News-Medical pages ``page_no_main_text`` from before the 2026-10-22 extractor, 54 ``page_http-error``) — read again and
delivered when they now give a text, left exactly as they were when they still do not."""

from __future__ import annotations

from datetime import timedelta

import pytest

from knowledge_plugin import retext
from knowledge_plugin.model import EntryTextResult, NormalizedEntry, ParseOutput

from test_scheduler_db import T0, Clock, ScriptedAdapter, ScriptedFetcher, crawler_for, poll_now, seed, source

pytestmark = pytest.mark.db

ARTICLE = "Pregnant patients receiving medication for opioid use disorder should not reduce their dose.\n\nThe study followed 5,000 births."
STORED = ARTICLE


class _NoCollector:
    class dajiala:
        configured = False

    async def wechat_text(self, row, now):
        raise AssertionError("no WeChat entry is read here")


def page(key, url=None, **extra):
    return NormalizedEntry(external_key=key, url=url or f"https://www.news-medical.example/news/{key}.aspx", title=f"Story {key}",
                           summary=None, published_at=T0 - timedelta(hours=6), **extra)


async def rows(pool):
    async with pool.connection() as conn:
        found = await (await conn.execute(
            """SELECT e.entry_id, e.external_key, e.text_status, e.revision, e.seq, t.body_text, t.body_excerpt, t.last_error
                 FROM evimed_knowledge.entries e LEFT JOIN evimed_knowledge.entry_texts t USING (entry_id)""")).fetchall()
    return {row["external_key"]: row for row in found}


async def seeded(settings, pool, clock):
    src = source("news-medical", source_type="media")
    await seed(pool, src)
    entries = [page("no-text"), page("http-error"), page("robots"), page("challenge"), page("journal-like", doi="10.1000/x.1"),
               page("wechat", url="https://mp.weixin.qq.com/s?__biz=A&mid=1&idx=1&sn=a"), page("fine"), page("not-asked")]
    adapter = ScriptedAdapter(pages={src.config["url"]: ParseOutput(entries=entries)})
    fetcher = ScriptedFetcher(clock)
    fetcher.ok(src.config["url"])
    crawler = crawler_for(settings, pool, clock, adapter, fetcher)
    await poll_now(crawler)
    notes = {"no-text": "page_no_main_text", "http-error": "page_http-error:http_503,text_horizon_passed",
             "robots": "page_robots-denied:robots", "challenge": "page_challenge:cloudflare",
             "journal-like": "page_no_main_text", "wechat": "page_no_main_text", "not-asked": "page_no_main_text"}
    async with pool.connection() as conn:
        for key, row in (await rows(pool)).items():
            if key == "fine":
                await conn.execute("UPDATE evimed_knowledge.entries SET text_status = 'available', text_requested_at = %s WHERE entry_id = %s",
                                   (T0, row["entry_id"]))
                await conn.execute("INSERT INTO evimed_knowledge.entry_texts (entry_id, revision, text_kind, body_excerpt) "
                                   "VALUES (%s, %s, 'excerpt', 'a text') ON CONFLICT (entry_id) DO NOTHING", (row["entry_id"], row["revision"]))
                continue
            await conn.execute("UPDATE evimed_knowledge.entries SET text_status = 'unavailable', text_requested_at = %s WHERE entry_id = %s",
                               (None if key == "not-asked" else T0, row["entry_id"]))
            await conn.execute("INSERT INTO evimed_knowledge.entry_texts (entry_id, revision, last_error) VALUES (%s, %s, %s) "
                               "ON CONFLICT (entry_id) DO UPDATE SET last_error = EXCLUDED.last_error",
                               (row["entry_id"], row["revision"], notes[key]))


async def test_the_unread_pages_are_named_only_and_only_the_two_reasons_a_fixed_reader_may_pass_are_read_again(settings, pool):
    clock = Clock()
    await seeded(settings, pool, clock)
    since, cutoff = T0 - timedelta(days=1), T0 + timedelta(days=1)
    assert "unread-page" in retext.KINDS and "unread-page" not in retext.DEFAULT_KINDS, "named only"
    assert retext.window(["--kinds", "unread-page"], clock.now)[0] == ["unread-page"]

    report = await retext.report(_NoCollector(), pool, clock.now, ["unread-page"], since=since, before=cutoff)
    assert report["summary"]["candidates"] == 2 and report["summary"]["unread-page"] == 2
    assert report["entries"] == [{"kind": "unread-page", "source_id": "news-medical", "count": 2}], \
        "no robots refusal, no challenge, no journal entry, no WeChat article, nothing the platform did not ask for"

    both = await retext.report(_NoCollector(), pool, clock.now, ["journal", "unread-page"], since=since, before=cutoff)
    assert both["summary"]["journal"] == 1 and both["summary"]["unread-page"] == 2, "a journal-like entry is a journal one, once"


async def test_a_page_that_now_reads_is_stored_and_delivered_and_one_that_still_fails_stays_as_it_was(settings, pool, monkeypatch):
    clock = Clock()
    await seeded(settings, pool, clock)
    before = await rows(pool)
    since, cutoff = T0 - timedelta(days=1), T0 + timedelta(days=1)
    asked: list[dict] = []

    async def reader(row, fetcher_, settings_, now=None):
        asked.append(row)
        if row["external_key"] == "no-text":
            return EntryTextResult(status="available", text_kind="excerpt", body_excerpt=ARTICLE, body_text=ARTICLE, fetched_from="page")
        return EntryTextResult(status="unavailable", notes=["page_http-error:http_503"])

    monkeypatch.setattr(retext, "enrich", reader)
    outcome = await retext.apply(_NoCollector(), pool, None, settings, lambda: clock.now, ["unread-page"], since=since, before=cutoff)
    assert outcome["summary"] == {"candidates": 2, "redelivered": 1, "same": 0, "kept": 1}
    assert {row["external_key"] for row in asked} == {"no-text", "http-error"}

    after = await rows(pool)
    assert (after["no-text"]["text_status"], after["no-text"]["body_text"]) == ("available", STORED)
    assert after["no-text"]["revision"] == before["no-text"]["revision"] + 1 and after["no-text"]["seq"] > before["no-text"]["seq"]
    assert after["http-error"] == before["http-error"], "a page that still fails is exactly as it was: status, note and revision"
    for key in ("robots", "challenge", "journal-like", "wechat", "fine", "not-asked"):
        assert after[key] == before[key], key

    again = await retext.report(_NoCollector(), pool, clock.now, ["unread-page"], since=since, before=cutoff)
    assert again["summary"]["candidates"] == 1, "what was read is not read again; what was not is a candidate of the next run"
