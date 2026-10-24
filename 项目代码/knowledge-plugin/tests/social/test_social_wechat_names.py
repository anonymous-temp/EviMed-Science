"""WeChat accounts resolved by their name (ct-src 2026-10-24): 44 of the 68 accounts listed on 2026-10-22 were never read
because their verified link was an expired Sogou temporary link. An account whose link cannot name it is asked for by
its nickname; the answer is kept only when the nickname is expected and the posts carry the registry's biz, and its posts
are the first read. The answer below is a live one (医药魔方, 2026-10-24), key and balance scrubbed."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from knowledge_plugin.registry import parse_registry, sync_registry
from knowledge_plugin.social import wechat as wechat_mod
from knowledge_plugin.social.collector import SocialCollector

from social_fakes import FakeFetcher, png_bytes

NOW = datetime(2026, 10, 24, 17, 0, tzinfo=timezone.utc)
FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "dajiala" / "post-history-by-nickname-pharmcube.json"
BIZ = "Mzg2OTY4MTEzMA=="
SOGOU = ("https://mp.weixin.qq.com/s?src=11&timestamp=1790004662&ver=6980&signature=K065AUVFnI6DWp2LIUczzDsb151d"
         "*VqCxR7Eql8aDGixS&new=1")
HISTORY = "https://www.dajiala.com/fbmain/monitor/v3/post_history"
DETAIL = "https://www.dajiala.com/fbmain/monitor/v3/article_detail"


def live_answer() -> dict:
    return json.loads(FIXTURE.read_text())


def row(source_id="wx-pharmcube", name="医药魔方", *, link=SOGOU, biz=BIZ, expected=None):
    config = {"url": link or "https://weixin.sogou.com/weixin?type=1&query=x", "expected_names": expected or [name],
              "priority": 3, "polls_per_day": 1, "role": "organisation", "allowed_hosts": ["mp.weixin.qq.com"]}
    if link:
        config["verified_url"] = link
    if biz:
        config["biz"] = biz
    return {"id": source_id, "name": name, "homepage": config["url"], "lane": "mixed", "source_type": "media",
            "access": "dajiala", "egress": "api", "authority": 2, "safety_feed": False, "owner_entity": name,
            "launch_tier": "P1", "language": "zh", "region": "CN", "poll_floor_s": 86400, "poll_ceiling_s": 86400,
            "enabled": True, "config": config}


async def sync(pool, rows):
    async with pool.connection() as conn:
        await sync_registry(conn, parse_registry({"sources": rows}), NOW)


async def source(pool, source_id):
    async with pool.connection() as conn:
        return await (await conn.execute("SELECT * FROM evimed_knowledge.sources WHERE id = %s", (source_id,))).fetchone()


async def stored(pool, source_id):
    async with pool.connection() as conn:
        return await (await conn.execute(
            """SELECT e.*, t.body_text FROM evimed_knowledge.entries e LEFT JOIN evimed_knowledge.entry_texts t USING (entry_id)
                WHERE e.source_id = %s ORDER BY e.external_key""", (source_id,))).fetchall()


async def spend(pool):
    async with pool.connection() as conn:
        return await (await conn.execute(
            """SELECT purpose, count(*) AS calls, round(sum(amount), 2) AS cny FROM evimed_knowledge.provider_calls
                WHERE provider = 'dajiala' GROUP BY purpose ORDER BY purpose""")).fetchall()


def fakes(history, *, detail=None):
    asked, details = [], []

    def on_history(spec):
        asked.append(json.loads(spec.body))
        return 200, history(asked[-1]) if callable(history) else history

    def on_detail(spec):
        details.append(parse_qs(urlsplit(spec.url).query)["url"][0])
        if detail is not None:
            return 200, detail(details[-1]) if callable(detail) else detail
        return 200, {"code": 0, "content_multi_text": "<p>正文第一段。</p>", "nick_name": "医药魔方", "cost_money": 0.03}

    fetcher = FakeFetcher({("POST", HISTORY): on_history, ("GET", DETAIL): on_detail,
                           ("GET", "https://mmbiz.qpic.cn/"): lambda spec: (200, png_bytes((40, 30)), {"content-type": "image/png"})})
    return fetcher, asked, details


# ------------------------------------------------------------------------------------ pure


def test_a_sogou_search_link_is_temporary_and_a_biz_or_short_link_can_name_the_account():
    assert wechat_mod.temporary_link(SOGOU)
    assert wechat_mod.temporary_link("https://mp.weixin.qq.com/s?src=3&timestamp=1790005394&ver=1&signature=K-Tj")
    assert not wechat_mod.temporary_link("https://mp.weixin.qq.com/s?__biz=MzA5&mid=1&idx=2&sn=a&chksm=b")
    assert not wechat_mod.temporary_link("https://mp.weixin.qq.com/s/9jkBYr7mpX9NTKEX-VskfA")
    assert wechat_mod.resolvable_link(row(link=SOGOU)) is None
    assert wechat_mod.resolvable_link(row(link=None)) is None
    assert wechat_mod.resolvable_link(row(link="https://mp.weixin.qq.com/s/9jkBYr7mpX9NTKEX-VskfA")) is not None
    assert wechat_mod.resolvable_link(row(link="https://example.org/s?__biz=x")) is None


def test_the_name_asked_is_the_first_expected_name():
    assert wechat_mod.ask_name(row(name="中国疾控中心", expected=["中国疾控动态", "中国疾控中心"])) == "中国疾控动态"
    assert wechat_mod.ask_name({"name": " 医学界 ", "config": {}}) == "医学界"


def test_a_name_resolution_needs_the_expected_nickname_and_the_registrys_biz_on_every_post():
    answer = live_answer()
    posts = answer["data"]
    resolved, reason = wechat_mod.name_resolution(answer["nickname"], answer["ghid"], posts, row(), NOW)
    assert reason is None and resolved == {"nickname": "医药魔方", "at": NOW.isoformat(), "via": "nickname",
                                           "ghid": "gh_64290a74a362", "biz": BIZ}
    assert wechat_mod.name_resolution("医药魔方Pro", "gh_x", posts, row(), NOW) == (None, "wechat_nickname_mismatch")
    foreign = posts + [{**posts[0], "url": posts[0]["url"].replace(BIZ, "MzAwMDA5NTIxNQ==")}]
    assert wechat_mod.name_resolution("医药魔方", "gh_x", foreign, row(), NOW) == (None, "wechat_biz_mismatch")
    assert wechat_mod.name_resolution("医药魔方", "gh_x", [], row(), NOW) == (None, "wechat_unconfirmed")
    unknown, reason = wechat_mod.name_resolution("医药魔方", "gh_x", posts, row(biz=None), NOW)
    assert reason is None and unknown["biz"] == BIZ, "without a registry biz the posts' single biz is learned"
    assert wechat_mod.name_resolution("医药魔方", "gh_x", [], row(biz=None), NOW)[0]["ghid"] == "gh_x"


# ------------------------------------------------------------------------------------ the collector


@pytest.mark.db
async def test_a_temporary_link_resolves_by_name_and_the_answer_is_the_first_read(social_settings, pool):
    await sync(pool, [row()])
    answer = {**live_answer(), "remain_money": 500.0}
    fetcher, asked, details = fakes(answer)
    collector = SocialCollector(social_settings, pool, fetcher, clock=lambda: NOW)
    assert (await collector.tick())["wechat"] == {"ok": 1}
    assert asked == [{"nickname": "医药魔方", "verifycode": ""}], "one call by name: no article_detail on a dead link"
    entries = await stored(pool, "wx-pharmcube")
    assert len(entries) == len({wechat_mod.external_key(p) for p in answer["data"]}), "every post of the answer is stored"
    assert all(e["identity_key"].startswith(f"wx:{BIZ}:") for e in entries)
    recent = [e for e in entries if not e["backfill"]]
    bodied = [e for e in entries if e["body_text"]]
    assert len(bodied) == len(details) == min(wechat_mod.MAX_BODIES_PER_READ, len(recent)), "bodies: at most eight a read"
    assert all(e["body_text"] == "正文第一段。" and not e["backfill"] for e in bodied), "only recent posts are bought"
    state = await source(pool, "wx-pharmcube")
    assert state["cursor"]["resolved"] == {"nickname": "医药魔方", "at": NOW.isoformat(), "via": "nickname",
                                           "ghid": "gh_64290a74a362", "biz": BIZ}
    assert state["health"] == "healthy" and state["next_poll_at"] == NOW + timedelta(days=1)
    assert [(r["purpose"], r["calls"]) for r in await spend(pool)] == [("article_detail", len(details)),
                                                                     ("post_history_by_name", 1)]

    later = NOW + timedelta(days=1, minutes=1)
    collector._clock = lambda: later
    await collector.tick()
    assert asked[1] == {"ghid": "gh_64290a74a362", "verifycode": ""}, "afterwards it is read by the id it named"
    assert len(details) == min(wechat_mod.MAX_BODIES_PER_READ, len(recent)), "no post is bought twice"


@pytest.mark.db
async def test_a_verified_link_answering_a_passing_code_falls_back_to_the_name(social_settings, pool):
    link = f"https://mp.weixin.qq.com/s?__biz={BIZ}&mid=1&idx=1&sn=a&chksm=b"
    await sync(pool, [row(link=link)])
    fetcher, asked, details = fakes(live_answer(), detail=lambda url: {"code": 20002, "msg": "参数错误"} if url == link
                                    else {"code": 0, "content_multi_text": "<p>文。</p>", "cost_money": 0.03})
    collector = SocialCollector(social_settings, pool, fetcher, clock=lambda: NOW)
    assert (await collector.tick())["wechat"] == {"ok": 1}
    assert details[0] == link and asked == [{"nickname": "医药魔方", "verifycode": ""}]
    assert (await source(pool, "wx-pharmcube"))["cursor"]["resolved"]["via"] == "nickname"
    assert collector.counters["wechat_link_unresolved:failed"] == 1


@pytest.mark.db
async def test_a_post_of_another_account_parks_it_for_thirty_days_and_nothing_is_stored(social_settings, pool):
    await sync(pool, [row()])
    answer = live_answer()
    answer["data"][3]["url"] = answer["data"][3]["url"].replace(BIZ, "MjM5MTMyMDg0Ng==")
    fetcher, asked, details = fakes(answer)
    collector = SocialCollector(social_settings, pool, fetcher, clock=lambda: NOW)
    assert (await collector.tick())["wechat"] == {"mismatch": 1}
    assert await stored(pool, "wx-pharmcube") == [] and details == []
    state = await source(pool, "wx-pharmcube")
    assert state["last_error_code"] == "wechat_biz_mismatch" and state["next_poll_at"] == NOW + timedelta(days=30)
    assert state["cursor"]["mismatch"]["bizes"] == sorted([BIZ, "MjM5MTMyMDg0Ng=="]) and "resolved" not in state["cursor"]
    assert state["consecutive_failures"] == 1


@pytest.mark.db
async def test_another_nickname_parks_it_and_no_posts_leave_it_unconfirmed(social_settings, pool):
    await sync(pool, [row(), row("wx-quiet", "安静号", biz="MzQuiet==")])
    fetcher, asked, details = fakes(lambda payload: {**live_answer(), "nickname": "医药魔方研究院"}
                                    if payload["nickname"] == "医药魔方" else
                                    {"code": 0, "nickname": "安静号", "ghid": "gh_q", "data": [], "cost_money": 0.16})
    collector = SocialCollector(social_settings, pool, fetcher, clock=lambda: NOW)
    assert (await collector.tick())["wechat"] == {"mismatch": 1, "unconfirmed": 1}
    parked = await source(pool, "wx-pharmcube")
    assert parked["last_error_code"] == "wechat_nickname_mismatch" and parked["next_poll_at"] == NOW + timedelta(days=30)
    assert parked["cursor"]["mismatch"]["nickname"] == "医药魔方研究院"
    quiet = await source(pool, "wx-quiet")
    assert quiet["last_error_code"] == "wechat_unconfirmed" and quiet["next_poll_at"] == NOW + timedelta(days=3)
    assert details == []


@pytest.mark.db
async def test_the_name_lookup_respects_the_cap_and_the_balance(social_settings, pool):
    from dataclasses import replace

    await sync(pool, [row()])
    fetcher, asked, _ = fakes(live_answer())
    capped = SocialCollector(replace(social_settings, dajiala_daily_cny=0.15), pool, fetcher, clock=lambda: NOW)
    assert (await capped.tick())["wechat"] == {"capped": 1}
    assert asked == [], "¥0.16 would pass a ¥0.15 cap: the call is not made"
    assert (await source(pool, "wx-pharmcube"))["last_error_code"] == "daily_cap"
