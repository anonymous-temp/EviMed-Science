"""A WeChat account is leased for the read, so a read the process does not come back from is not started again at once.

2026-10-27: one article's text killed the plugin (out of memory) a few seconds after it was bought, every restart read the
same first-due account again — nothing about it had been written — and bought the same posts again, ¥0.26 a time, once a
minute for hours. The scheduler's polls were already leased; the social collector's reads were not.
"""

from __future__ import annotations

import asyncio
import socket
from dataclasses import replace
from datetime import timedelta

import pytest
from psycopg.types.json import Jsonb

from knowledge_plugin import policy
from knowledge_plugin.scheduler import Crawler
from knowledge_plugin.social.collector import SocialCollector

from social_fakes import FakeFetcher, png_bytes
from test_social_collectors import NOW, sync, wx_post, wx_row

pytestmark = pytest.mark.db

HISTORY = "https://www.dajiala.com/fbmain/monitor/v3/post_history"
DETAIL = "https://www.dajiala.com/fbmain/monitor/v3/article_detail"
COVER = "https://mmbiz.qpic.cn/"


async def resolved_account(pool):
    await sync(pool, [wx_row()])
    async with pool.connection() as conn:
        await conn.execute("UPDATE evimed_knowledge.sources SET cursor = %s WHERE id = 'wx-dxy-heart'",
                           (Jsonb({"resolved": {"ghid": "gh_real", "nickname": "丁香园心血管时间", "at": NOW.isoformat()}}),))


def fetcher_that(history, detail=None):
    detail = detail or (lambda spec: (200, {"code": 0, "title": "t", "content": "<p>正文。</p>", "nick_name": "丁香园心血管时间",
                                            "cost_money": 0.03, "remain_money": 29.8}))
    cover = png_bytes((60, 40))
    return FakeFetcher({("POST", HISTORY): history, ("GET", DETAIL): detail,
                        ("GET", COVER): lambda spec: (200, cover, {"content-type": "image/png"})})


def history_ok(spec):
    return 200, {"code": 0, "nickname": "丁香园心血管时间", "ghid": "gh_real", "cost_money": 0.14, "remain_money": 29.8,
                 "data": [wx_post(7, 1)]}


async def row_of(pool):
    async with pool.connection() as conn:
        return await (await conn.execute("SELECT * FROM evimed_knowledge.sources WHERE id = 'wx-dxy-heart'")).fetchone()


async def test_a_finished_read_gives_the_account_back(social_settings, pool):
    await resolved_account(pool)
    collector = SocialCollector(social_settings, pool, fetcher_that(history_ok), clock=lambda: NOW)
    assert (await collector.tick())["wechat"] == {"ok": 1}
    row = await row_of(pool)
    assert row["lease_owner"] is None and row["lease_until"] is None and row["consecutive_failures"] == 0


async def test_a_read_that_never_comes_back_is_not_started_again_until_the_restart_has_parked_it(social_settings, pool):
    mine = replace(social_settings, worker_id=f"{socket.gethostname()}:4242")
    await resolved_account(pool)

    def killed_mid_read(spec):
        raise asyncio.CancelledError("the process died here")       # not an Exception: nothing in the collector catches it

    first = fetcher_that(killed_mid_read)
    with pytest.raises(asyncio.CancelledError):
        await SocialCollector(mine, pool, first, clock=lambda: NOW).tick()
    assert first.count(HISTORY) == 1
    row = await row_of(pool)
    assert row["lease_owner"] == mine.worker_id and row["lease_until"] == NOW + timedelta(seconds=mine.lease_s)

    # The next tick of a process that is still alive (the lease has not run out) leaves the account alone.
    again = fetcher_that(history_ok)
    assert (await SocialCollector(mine, pool, again, clock=lambda: NOW + timedelta(minutes=1)).tick())["wechat"] == {}
    assert again.count(HISTORY) == 0

    # The restart: a lease held at start is a read that did not come back, a failed read with its backoff.
    crawler = Crawler(mine, pool, FakeFetcher(), adapters={}, clock=lambda: NOW, enricher=lambda *args: None)
    await crawler._recover_dead_leases()
    row = await row_of(pool)
    wait = timedelta(seconds=policy.failure_delay_s(row["poll_floor_s"], 1))
    assert row["lease_owner"] is None and row["consecutive_failures"] == 1 and row["last_error_code"] == "worker_died"
    assert row["next_poll_at"] == NOW + wait

    # Not read before the backoff is over, read (and cleared) after it.
    waiting = fetcher_that(history_ok)
    assert (await SocialCollector(mine, pool, waiting, clock=lambda: NOW + wait - timedelta(seconds=1)).tick())["wechat"] == {}
    assert waiting.count(HISTORY) == 0
    later = NOW + wait + timedelta(seconds=1)
    assert (await SocialCollector(mine, pool, waiting, clock=lambda: later).tick())["wechat"] == {"ok": 1}
    row = await row_of(pool)
    assert waiting.count(HISTORY) == 1 and row["consecutive_failures"] == 0 and row["lease_owner"] is None


async def test_an_account_leased_by_another_process_is_not_read_twice(social_settings, pool):
    await resolved_account(pool)
    async with pool.connection() as conn:
        await conn.execute(
            "UPDATE evimed_knowledge.sources SET lease_owner = 'other:1', lease_until = %s WHERE id = 'wx-dxy-heart'",
            (NOW + timedelta(minutes=5),))
    fetcher = fetcher_that(history_ok)
    assert (await SocialCollector(social_settings, pool, fetcher, clock=lambda: NOW).tick())["wechat"] == {}
    assert fetcher.calls == []
    expired = SocialCollector(social_settings, pool, fetcher, clock=lambda: NOW + timedelta(minutes=6))
    assert (await expired.tick())["wechat"] == {"ok": 1}, "a lease that has run out is no lease"
