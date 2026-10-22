"""``retext`` (2026-10-22): the texts stored before the reader-text fixes, read again through them.

With Dajiala faked: a WeChat body bought from the light HTML (a paragraph split at every styled run) is bought again and
read from the article's own HTML; the entry is delivered again only when its text changed; a read that fails leaves the
stored text as it was; the report reads nothing and writes nothing; a second run with the same ``--before`` has nothing
left to do."""

from __future__ import annotations

from datetime import timedelta

import pytest

from knowledge_plugin import retext
from knowledge_plugin.social.collector import SocialCollector

from test_social_collectors import NOW, entries, sync, wx_post, wx_row
from test_social_wechat_bodies import Clock, Dajiala, failing, link, ok_detail, texts

pytestmark = pytest.mark.db

LIGHT = "<p>第一段的前半，</p><p>（ASO）</p><p>后半。</p><p>第二段。</p>"
ORIGINAL = "<p><span>第一段的前半，</span><span>（ASO）</span><span>后半。</span></p><p><span>第二段。</span></p>"


def detail(light: str, original: str | None = None) -> dict:
    answer = ok_detail(light)
    if original is not None:
        answer["content_multi_text"] = original
    return answer


async def test_retext_reports_then_reads_the_wechat_bodies_again_and_delivers_only_what_changed(social_settings, pool):
    clock = Clock()
    await sync(pool, [wx_row()])
    dajiala = Dajiala([wx_post(7, 1), wx_post(8, 1), wx_post(9, 1)], default=detail(LIGHT))
    collector = SocialCollector(social_settings, pool, dajiala.fetcher(), clock=clock)
    assert (await collector.tick())["wechat"] == {"ok": 1}
    rows = await entries(pool, "wx-dxy-heart")
    async with pool.connection() as conn:      # what GET /v1/entries/{id}/text does for a text that is already there
        for row in rows:
            await conn.execute("UPDATE evimed_knowledge.entries SET text_requested_at = %s WHERE entry_id = %s",
                               (clock(), row["entry_id"]))
    before = await texts(pool)
    assert before["MzA5:7:1"]["body_text"] == "第一段的前半，\n\n（ASO）\n\n后半。\n\n第二段。", "the light HTML's fragments"
    clock.advance(hours=1)
    cutoff = clock()
    asked = len(dajiala.asked)

    report = await retext.report(collector, pool, clock(), ["wechat"], since=NOW - timedelta(days=1), before=cutoff)
    assert report["summary"]["candidates"] == 3 and report["summary"]["wechat"] == 3
    assert report["summary"]["wechat_estimate_cny"] == 0.09
    assert len(dajiala.asked) == asked and await texts(pool) == before, "the report calls nobody and writes nothing"

    dajiala.answers = {link(7): [detail(LIGHT, ORIGINAL)], link(8): [detail(LIGHT)], link(9): [failing(20002)]}
    clock.advance(minutes=5)
    outcome = await retext.apply(collector, pool, None, social_settings, clock, ["wechat"], since=NOW - timedelta(days=1),
                                 before=cutoff)
    assert outcome["summary"] == {"candidates": 3, "redelivered": 1, "same": 1, "kept": 1}
    after = await texts(pool)
    assert after["MzA5:7:1"]["body_text"] == "第一段的前半，（ASO）后半。\n\n第二段。"
    assert after["MzA5:7:1"]["revision"] == before["MzA5:7:1"]["revision"] + 1, "delivered again: the platform reads it"
    assert after["MzA5:8:1"]["body_text"] == before["MzA5:8:1"]["body_text"]
    assert after["MzA5:8:1"]["revision"] == before["MzA5:8:1"]["revision"], "the same text is not delivered again"
    assert after["MzA5:9:1"]["body_text"] == before["MzA5:9:1"]["body_text"], "a failed read keeps the stored text"
    assert after["MzA5:9:1"]["text_status"] == "available" and after["MzA5:9:1"]["revision"] == before["MzA5:9:1"]["revision"]

    again = await retext.report(collector, pool, clock(), ["wechat"], since=NOW - timedelta(days=1), before=cutoff)
    assert again["summary"]["candidates"] == 1, "with the same --before only the failed read is left"


def test_the_window_flags():
    now = NOW
    assert retext.window([], now) == (list(retext.KINDS), now - timedelta(days=retext.DEFAULT_SINCE_DAYS), now,
                                      retext.DEFAULT_LIMIT)
    kinds, since, before, limit = retext.window(["--kinds", "page,crossref", "--since", "2026-09-01", "--before",
                                                 "2026-10-22T14:00:00Z", "--limit", "50"], now)
    assert kinds == ["page", "crossref"] and since.isoformat() == "2026-09-01T00:00:00+00:00"
    assert before.isoformat() == "2026-10-22T14:00:00+00:00" and limit == 50
    assert retext.window(["--kinds", "x"], now).startswith("--kinds")
    assert retext.window(["--limit", "0"], now).startswith("--limit")
    assert "not valid" in retext.window(["--since", "yesterday"], now)
