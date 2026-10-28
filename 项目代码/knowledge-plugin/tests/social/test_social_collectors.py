"""The social collector with all three providers faked: X shards and watermarks, WeChat re-resolution and pacing, the
six-platform monitor's pacing and minimisation, and the caps that stop each one alone."""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from knowledge_plugin.registry import parse_registry, sync_registry
from knowledge_plugin.social import x as x_mod
from knowledge_plugin.social.collector import SocialCollector

from social_fakes import FakeFetcher, png_bytes

pytestmark = pytest.mark.db
NOW = datetime(2026, 10, 22, 6, 0, tzinfo=timezone.utc)


def x_row(handle, *, mode="editorial", role="organisation"):
    return {"id": f"x-{handle.lower()}", "name": handle, "homepage": f"https://x.com/{handle}", "lane": "mixed",
            "source_type": "regulator" if role == "organisation" else "media", "access": "socialdata", "egress": "api",
            "authority": 4, "safety_feed": False, "owner_entity": handle, "launch_tier": "P1", "language": "en",
            "poll_floor_s": 1800, "poll_ceiling_s": 3600, "enabled": True,
            "config": {"url": f"https://x.com/{handle}", "handle": handle, "mode": mode, "role": role}}


def tweet(tweet_id, handle, text, *, hours=1, media=None, quoted=None, retweet=False):
    body = {"id_str": str(tweet_id), "tweet_created_at": (NOW - timedelta(hours=hours)).isoformat().replace("+00:00", "Z"),
            "full_text": text, "lang": "en", "user": {"id_str": f"9{tweet_id}", "name": f"{handle} name", "screen_name": handle},
            "favorite_count": 10, "retweet_count": 2, "reply_count": 1, "views_count": 500, "entities": {"urls": []}}
    if media:
        body["extended_entities"] = {"media": media}
    if quoted:
        body["quoted_status"] = quoted
    if retweet:
        body["retweeted_status"] = {"id_str": "1"}
    return body


async def sync(pool, rows):
    async with pool.connection() as conn:
        await sync_registry(conn, parse_registry({"sources": rows}), NOW)


async def source(pool, source_id):
    async with pool.connection() as conn:
        return await (await conn.execute("SELECT * FROM evimed_knowledge.sources WHERE id = %s", (source_id,))).fetchone()


async def entries(pool, source_id):
    async with pool.connection() as conn:
        return await (await conn.execute(
            "SELECT e.*, t.body_text, t.text_kind FROM evimed_knowledge.entries e LEFT JOIN evimed_knowledge.entry_texts t USING (entry_id) WHERE e.source_id = %s ORDER BY e.external_key",
            (source_id,))).fetchall()


def test_shards_pack_two_dozen_handles_under_the_query_limit_by_pace():
    rows = [x_row(f"acct{i:02d}") for i in range(30)] + [x_row("Person1", mode="signal", role="person")]
    rows = [{**row, "cursor": {}} for row in rows]
    shards = x_mod.plan_shards(rows)
    assert [len(s.members) for s in shards if s.mode == "editorial"] == [24, 6]
    assert [s.mode for s in shards] == ["editorial", "editorial", "signal"]
    assert all(len(s.query) <= x_mod.SHARD_QUERY_MAX for s in shards)
    assert shards[0].query.startswith("(from:acct00 OR from:acct01") and shards[0].query.endswith(") -filter:replies")
    assert x_mod.plan_shards(list(reversed(rows)))[0].key == shards[0].key, "the same accounts give the same shards"
    long = [{**x_row("h" + "x" * 12 + f"{i:02d}"), "cursor": {}} for i in range(30)]
    assert all(len(s.query) <= 470 for s in x_mod.plan_shards(long)) and len(x_mod.plan_shards(long)[0].members) < 24


def test_coverage_is_the_own_post_or_the_last_read():
    assert x_mod.covered_to({"cursor": {}}, NOW) == x_mod.x_id_at(NOW - timedelta(hours=24)), "a new account: the last day"
    assert x_mod.covered_to({"cursor": {"last_tweet_id": "5"}}, NOW) == 5
    read_at = (NOW - timedelta(hours=1)).isoformat()
    assert x_mod.covered_to({"cursor": {"last_tweet_id": "5", "last_ok_at": read_at}}, NOW) == x_mod.x_id_at(
        NOW - timedelta(hours=1, minutes=10)), "a quiet account is covered up to ten minutes before its last read"


async def test_x_shard_reads_each_accounts_posts_moves_its_own_watermark_and_stores_media(social_settings, pool):
    await sync(pool, [x_row("US_FDA"), x_row("NEJM")])
    photo = png_bytes((100, 80))
    quoted = tweet(500, "FDA_Drug_Info", "Label update today.", hours=3,
                   media=[{"type": "photo", "media_url_https": "https://pbs.twimg.com/media/q.jpg"}])
    pages = {None: ([tweet(1003, "US_FDA", "FDA approves drug A https://t.co/abc",
                           media=[{"type": "photo", "media_url_https": "https://pbs.twimg.com/media/a.jpg",
                                   "ext_alt_text": "Approval letter", "original_info": {"width": 100, "height": 80}}],
                           quoted=quoted),
                     tweet(1002, "NEJM", "New trial of drug B: NCT01234567"),
                     tweet(1001, "US_FDA", "RT of something", retweet=True)], "page-2"),
             "page-2": ([tweet(1000, "NEJM", "Read our X Article https://x.com/i/article/42")], None)}
    searches = []

    def search(spec):
        query = parse_qs(urlsplit(spec.url).query)
        searches.append(query)
        tweets, following = pages[query.get("cursor", [None])[0]]
        return 200, {"tweets": tweets, "next_cursor": following}

    article = {"article": {"title": "Our editors on drug B", "content_state": {"blocks": [
        {"type": "unstyled", "text": "First paragraph."}, {"type": "atomic", "text": " "}, {"type": "header-two", "text": "Second."}]}}}
    fetcher = FakeFetcher({("GET", "https://api.socialdata.tools/twitter/search"): search,
                           ("GET", "https://api.socialdata.tools/twitter/article/1000"): lambda spec: (200, article),
                           ("GET", "https://pbs.twimg.com/"): lambda spec: (200, photo, {"content-type": "image/png"})},
                          relay=True)
    collector = SocialCollector(social_settings, pool, fetcher, clock=lambda: NOW)
    report = await collector.tick()
    assert report["x"] == {"ok": 1}, "two accounts, one shard, one search"
    assert searches[0]["query"][0] == f"(from:NEJM OR from:US_FDA) -filter:replies since_id:{x_mod.x_id_at(NOW - timedelta(hours=24))}"
    assert searches[0]["type"] == ["Latest"] and searches[1]["cursor"] == ["page-2"]
    fda = await entries(pool, "x-us_fda")
    assert [row["external_key"] for row in fda] == ["1003"], "the retweet is someone else's post"
    post = fda[0]
    assert post["channel"] == "x" and post["platform"] == "x" and post["text_status"] == "available"
    assert post["author"] == {"name": "US_FDA name", "handle": "US_FDA", "url": "https://x.com/US_FDA", "role": "organisation"}
    assert post["body_text"] == "FDA approves drug A" and post["text_kind"] == "full", "the trailing media link is gone"
    assert post["media"][0]["alt"] == "Approval letter" and post["media"][0]["kind"] == "image"
    assert post["quoted"]["author"]["handle"] == "FDA_Drug_Info" and len(post["quoted"]["media"]) == 1
    assert post["metrics"]["likes"] == 10 and post["metrics"]["views"] == 500
    assert all(call["egress"] == "relay" for call in fetcher.calls if "twimg" in call["url"])
    nejm = await entries(pool, "x-nejm")
    article_post = next(row for row in nejm if row["external_key"] == "1000")
    assert article_post["body_text"] == "Our editors on drug B\n\nFirst paragraph.\n\nSecond.", "the X Article is the body"
    assert article_post["title"] == "Our editors on drug B", "a post that is only the article's link takes its title"
    assert next(row for row in nejm if row["external_key"] == "1002")["registry_ids"] == ["NCT01234567"]
    fda_source, nejm_source = await source(pool, "x-us_fda"), await source(pool, "x-nejm")
    assert fda_source["cursor"]["last_tweet_id"] == "1003" and nejm_source["cursor"]["last_tweet_id"] == "1002"
    assert fda_source["health"] == "healthy" and fda_source["next_poll_at"] == NOW + timedelta(minutes=30)
    async with pool.connection() as conn:
        spent = await (await conn.execute(
            "SELECT sum(objects) AS objects, sum(amount) AS amount FROM evimed_knowledge.provider_calls WHERE provider = 'socialdata'")).fetchone()
        fetches = await (await conn.execute("SELECT source_id, outcome FROM evimed_knowledge.fetches ORDER BY source_id")).fetchall()
    assert spent["objects"] == 5 and float(spent["amount"]) == pytest.approx(5 * 0.0002), "4 tweets and 1 article"
    assert [(row["source_id"], row["outcome"]) for row in fetches] == [("x-nejm", "ok"), ("x-us_fda", "ok")]

    later = NOW + timedelta(minutes=31)
    pages[None] = ([tweet(1003, "US_FDA", "FDA approves drug A https://t.co/abc")], None)
    collector._clock = lambda: later
    calls = len(fetcher.calls)
    await collector.tick()
    assert fetcher.count("https://pbs.twimg.com/") == 2 and len(fetcher.calls) == calls + 1, "a stored post is not bought again"


async def test_x_cap_reached_waits_for_the_next_day_and_nothing_is_sent(social_settings, pool):
    await sync(pool, [x_row("US_FDA")])
    fetcher = FakeFetcher({("GET", "https://api.socialdata.tools/"): lambda spec: (200, {"tweets": []})})
    collector = SocialCollector(replace(social_settings, socialdata_daily_usd=0.001), pool, fetcher, clock=lambda: NOW)
    assert (await collector.tick())["x"] == {"capped": 1}
    assert fetcher.calls == [], "a call that could pass the cap is not made"
    row = await source(pool, "x-us_fda")
    assert row["next_poll_at"] == datetime(2026, 10, 22, 16, 0, tzinfo=timezone.utc) and row["last_error_code"] == "daily_cap"
    assert row["consecutive_failures"] == 0, "the plugin's own refusal is no failure of the source"


async def test_x_without_a_key_does_nothing(settings, pool):
    await sync(pool, [x_row("US_FDA")])
    fetcher = FakeFetcher()
    assert (await SocialCollector(settings, pool, fetcher, clock=lambda: NOW).tick())["x"] == {"skipped": "unconfigured"}
    assert fetcher.calls == []


# ------------------------------------------------------------------------------------ WeChat

def wx_row(source_id="wx-dxy-heart", name="丁香园心血管时间", *, priority=1, polls=2):
    return {"id": source_id, "name": name, "homepage": "https://mp.weixin.qq.com/s?__biz=MzA5&mid=1&idx=2&sn=a",
            "lane": "mixed", "source_type": "media", "access": "dajiala", "egress": "api", "authority": 3, "safety_feed": False,
            "owner_entity": "丁香园", "launch_tier": "P1", "language": "zh", "region": "CN", "poll_floor_s": 43200,
            "poll_ceiling_s": 86400, "enabled": True,
            "config": {"url": "https://mp.weixin.qq.com/s?__biz=MzA5&mid=1&idx=2&sn=a",
                       "verified_url": "https://mp.weixin.qq.com/s?__biz=MzA5&mid=1&idx=2&sn=a",
                       "expected_names": [name], "priority": priority, "polls_per_day": polls,
                       "allowed_hosts": ["mp.weixin.qq.com"]}}


def wx_post(mid, idx=1, *, hours=2, original=1):
    return {"position": idx, "url": f"http://mp.weixin.qq.com/s?__biz=MzA5&mid={mid}&idx={idx}&sn=s{mid}&chksm=x#rd",
            "title": f"文章 {mid}-{idx}", "digest": "摘要：一项新研究", "post_time": int((NOW - timedelta(hours=hours)).timestamp()),
            "cover_url": f"http://mmbiz.qpic.cn/cover{mid}.jpg", "original": original, "read": 1200, "zan": 30, "sn": f"s{mid}"}


async def test_wechat_resolves_from_the_verified_link_then_reads_by_id_and_buys_each_body_once(social_settings, pool):
    await sync(pool, [wx_row()])
    history_calls, details = [], []

    def history(spec):
        payload = json.loads(spec.body)
        history_calls.append(payload)
        return 200, {"code": 0, "nickname": "丁香园心血管时间", "ghid": "gh_real", "cost_money": 0.14, "remain_money": 29.86,
                     "data": [wx_post(7, 1), wx_post(7, 2), wx_post(3, 1, hours=24 * 30)]}

    def detail(spec):
        details.append(parse_qs(urlsplit(spec.url).query)["url"][0])
        return 200, {"code": 0, "title": "文章", "content": "<p>第一段。</p><p>第二段 NCT01234567。</p>", "author": "张三",
                     "nick_name": "丁香园心血管时间", "user_name": "gh_real", "alias": "dxy_heart_today", "biz": "MzA5",
                     "read": 1500, "zan": 40, "share_count": 12, "comment_count": 3, "cost_money": 0.03, "remain_money": 29.80}

    cover = png_bytes((60, 40))
    fetcher = FakeFetcher({("POST", "https://www.dajiala.com/fbmain/monitor/v3/post_history"): history,
                           ("GET", "https://www.dajiala.com/fbmain/monitor/v3/article_detail"): detail,
                           ("GET", "https://mmbiz.qpic.cn/"): lambda spec: (200, cover, {"content-type": "image/png"})})
    collector = SocialCollector(social_settings, pool, fetcher, clock=lambda: NOW)
    assert (await collector.tick())["wechat"] == {"ok": 1}
    assert details[0] == "https://mp.weixin.qq.com/s?__biz=MzA5&mid=1&idx=2&sn=a", "the verified link names the account"
    assert history_calls == [{"ghid": "gh_real", "verifycode": ""}], "then the account is read by the id it named"
    rows = await entries(pool, "wx-dxy-heart")
    assert [row["external_key"] for row in rows] == ["MzA5:3:1", "MzA5:7:1", "MzA5:7:2"]
    new = next(row for row in rows if row["external_key"] == "MzA5:7:1")
    assert new["identity_key"] == "wx:MzA5:7:1" and new["channel"] == "wechat" and new["url"].startswith("https://")
    assert new["author"] == {"name": "丁香园心血管时间", "handle": "dxy_heart_today", "role": "organisation"}
    assert new["media"][0]["kind"] == "image"
    assert new["body_text"] == "第一段。\n\n第二段 NCT01234567。" and new["facts"] == {"wx_biz": "MzA5", "wx_author": "张三", "wx_original": True}
    assert new["metrics"] == {"views": 1500, "likes": 40, "reposts": 12, "replies": 3, "observed_at": "2026-10-22T06:00:00Z"}
    assert new["registry_ids"] == ["NCT01234567"]
    old = next(row for row in rows if row["external_key"] == "MzA5:3:1")
    assert old["backfill"] and old["body_text"] is None, "an old post on first contact is history: no body bought"
    assert len(details) == 3, "the resolution and two bodies"
    state = await source(pool, "wx-dxy-heart")
    assert state["cursor"]["resolved"]["ghid"] == "gh_real" and state["next_poll_at"] == NOW + timedelta(hours=12)

    later = NOW + timedelta(hours=12, minutes=1)
    collector._clock = lambda: later
    await collector.tick()
    assert history_calls[1] == {"ghid": "gh_real", "verifycode": ""} and len(details) == 3, "no resolution, no body bought again"
    async with pool.connection() as conn:
        spent = await (await conn.execute(
            "SELECT round(sum(amount), 2) AS cny, count(*) AS calls FROM evimed_knowledge.provider_calls WHERE provider = 'dajiala'")).fetchone()
    assert float(spent["cny"]) == 0.37 and spent["calls"] == 5


async def test_wechat_a_link_that_names_another_account_parks_it_at_the_cost_of_the_check(social_settings, pool):
    await sync(pool, [wx_row("wx-dxy", "丁香园")])
    fetcher = FakeFetcher({("GET", "https://www.dajiala.com/fbmain/monitor/v3/article_detail"): lambda spec: (
        200, {"code": 0, "nick_name": "快乐测试123", "user_name": "gh_1e80bb81a1d2", "cost_money": 0.03})})
    collector = SocialCollector(social_settings, pool, fetcher, clock=lambda: NOW)
    assert (await collector.tick())["wechat"] == {"mismatch": 1}
    assert fetcher.count("https://www.dajiala.com/fbmain/monitor/v3/post_history") == 0, "a mismatch is never read"
    assert await entries(pool, "wx-dxy") == []
    row = await source(pool, "wx-dxy")
    assert row["last_error_code"] == "wechat_nickname_mismatch" and row["next_poll_at"] == NOW + timedelta(days=30)
    assert row["cursor"]["mismatch"]["nickname"] == "快乐测试123" and "resolved" not in row["cursor"]


async def test_wechat_balance_stops_wechat_for_the_day_and_priority_goes_first(social_settings, pool):
    await sync(pool, [wx_row("wx-a", "A号", priority=3), wx_row("wx-b", "B号", priority=1)])
    asked = []

    def balance(spec):
        asked.append(spec)
        return 200, {"code": 20001, "msg": "余额不足"}

    fetcher = FakeFetcher({("GET", "https://www.dajiala.com/"): balance, ("POST", "https://www.dajiala.com/"): balance})
    collector = SocialCollector(social_settings, pool, fetcher, clock=lambda: NOW)
    assert (await collector.tick())["wechat"] == {"balance": 1}
    assert len(asked) == 1, "the first answer about the balance stops every other account"
    assert (await source(pool, "wx-b"))["last_error_code"] == "dajiala_balance", "the higher priority went first"
    assert (await source(pool, "wx-a"))["last_attempt_at"] is None
    assert (await collector.tick())["wechat"] == {"skipped": "paused"}


# ------------------------------------------------------------------------------------ the six platforms

def crawl_row(platform="xhs", name="xiaohongshu"):
    return {"id": f"social-{name}", "name": name, "lane": "mixed", "source_type": "media", "access": "social-crawl",
            "egress": "api", "authority": 1, "safety_feed": False, "owner_entity": name, "launch_tier": "P2",
            "language": "zh", "region": "CN", "poll_floor_s": 3600, "poll_ceiling_s": 86400, "enabled": True,
            "config": {"url": "https://www.xiaohongshu.com/", "crawl_platform": platform, "platform": name}}


def job_transport(handler):
    """Wrap existing collector behavior fixtures in the upgraded terminal job envelope."""
    def handle(request):
        assert request.url.path == "/api/jobs" and request.method == "POST"
        assert request.headers["authorization"] == "Bearer fake-crawler-key"
        response = handler(request)
        if response.status_code != 200:
            return response
        body = json.loads(request.content)
        assert "platform" not in body and len(body["platforms"]) == 1, "the job takes a list of platforms, one name for the monitor"
        return httpx.Response(202, json={"job_id": "a" * 32, "job_status": "done", "query": body["query"],
                                       "platforms": body["platforms"], "result": json.loads(response.content)})
    return httpx.MockTransport(handle)


async def test_crawl_monitors_the_watch_list_one_request_at_a_time_and_keeps_no_author(social_settings, pool, tmp_path):
    registry = tmp_path / "social-sources.json"
    registry.write_text(json.dumps({"sources": [], "watch_list": [{"term": "司美格鲁肽", "why": "GLP-1"}, {"term": "流感", "why": "季节"}]}))
    settings = replace(social_settings, social_registry_path=str(registry))
    await sync(pool, [crawl_row("xhs", "xiaohongshu"), crawl_row("zhihu", "zhihu")])
    requests = []

    def answer(request: httpx.Request):
        body = json.loads(request.content)
        requests.append(body)
        if len(requests) == 2:
            return httpx.Response(429, json={"detail": "busy"})
        return httpx.Response(200, json={"platform": body["platforms"][0], "meta": {"collection_status": "collected"}, "posts": [
            {"post_id": "p1", "title": "打了司美格鲁肽三个月", "content": "体重下降了 8 公斤，" * 40, "url": "https://www.xiaohongshu.com/explore/p1",
             "likes": "1.2万" , "shares": 30, "comment_count": 12, "author": "某用户", "author_id": "u1",
             "comments": [{"content": "我也是", "author": "另一人"}], "publish_time": int((NOW - timedelta(hours=5)).timestamp())},
            {"post_id": "p2", "title": "无地址的帖子"}]})

    collector = SocialCollector(settings, pool, FakeFetcher(), clock=lambda: NOW, crawl_transport=job_transport(answer))
    first = (await collector.tick())["crawl"]
    assert first == {"term": "司美格鲁肽", "platform": "xhs", "posts": 1, "new": 1}
    assert requests[0] == {"query": "司美格鲁肽", "platforms": ["xhs"], "sort_type": "latest", "page": 1, "minimum_detail_posts": 5,
                           "minimum_comments_per_post": 0, "collect_comments": False, "include_provider_raw": False}
    (row,) = await entries(pool, "social-xiaohongshu")
    assert row["channel"] == "social" and row["platform"] == "xiaohongshu" and row["author"] is None
    assert len(row["summary"]) <= 300 and "某用户" not in json.dumps(row, default=str) and "我也是" not in json.dumps(row, default=str)
    assert row["metrics"] == {"reposts": 30, "replies": 12, "observed_at": "2026-10-22T06:00:00Z"}, "an unstated count is absent"
    assert row["text_kind"] == "excerpt" and row["body_text"] is None and row["text_status"] == "available"
    assert row["published_at"] == NOW - timedelta(hours=5)
    assert (await collector.tick())["crawl"] == {"skipped": "not_yet"}, "120 a day is one every twelve minutes"

    collector._clock = lambda: NOW + timedelta(minutes=12)
    assert (await collector.tick())["crawl"] == {"busy": "http_429"}
    assert requests[1]["query"] == "司美格鲁肽" and requests[1]["platforms"] == ["zhihu"], "the pair searched longest ago"
    collector._clock = lambda: NOW + timedelta(minutes=21)
    assert (await collector.tick())["crawl"] == {"skipped": "not_yet"}, "after a busy answer GEO gets ten minutes"
    collector._clock = lambda: NOW + timedelta(minutes=23)
    await collector.tick()
    assert len(requests) == 3 and requests[2]["platforms"] == ["zhihu"]


CRAWL_PLATFORMS = (("xhs", "xiaohongshu"), ("douyin", "douyin"), ("zhihu", "zhihu"), ("weibo", "weibo"),
                   ("bilibili", "bilibili"), ("wechat_channels", "channels"))


async def six_platform_monitor(social_settings, pool, tmp_path, handler, *, terms=("司美格鲁肽", "流感")):
    registry = tmp_path / "social-sources.json"
    registry.write_text(json.dumps({"sources": [], "watch_list": [{"term": term, "why": "test"} for term in terms]}))
    settings = replace(social_settings, social_registry_path=str(registry))
    await sync(pool, [crawl_row(platform, name) for platform, name in CRAWL_PLATFORMS])
    return SocialCollector(settings, pool, FakeFetcher(), clock=lambda: NOW, crawl_transport=job_transport(handler))


def collected(request: httpx.Request, *, post_id="p"):
    body = json.loads(request.content)
    platform = body["platforms"][0]
    return httpx.Response(200, json={"platform": platform, "meta": {"collection_status": "collected"}, "posts": [
        {"post_id": f"{post_id}-{platform}", "title": "一条帖子", "content": "内容" * 20,
         "url": f"https://example.test/{platform}/{post_id}", "publish_time": int((NOW - timedelta(hours=2)).timestamp())}]})


async def test_one_failing_platform_never_holds_the_other_five(social_settings, pool, tmp_path):
    """Review G1 (2026-10-25): xhs answered 500 for three days and every attempt went to xhs again, the other five never asked."""
    asked = []
    down = {"xhs"}

    def handler(request: httpx.Request):
        platform = json.loads(request.content)["platforms"][0]
        asked.append(platform)
        return httpx.Response(500, json={"detail": "boom"}) if platform in down else collected(request)

    collector = await six_platform_monitor(social_settings, pool, tmp_path, handler)
    clock = [NOW]
    collector._clock = lambda: clock[0]
    first = (await collector.tick())["crawl"]
    assert first["failed"] == "http_500" and first["parked_until"] == (NOW + timedelta(hours=3)).isoformat()
    assert asked == ["xhs"]
    xhs = await source(pool, "social-xiaohongshu")
    assert xhs["consecutive_failures"] == 1 and xhs["last_error_code"] == "crawl_http_500"
    assert xhs["next_poll_at"] == NOW + timedelta(hours=3) and xhs["health"] == "degraded", "a failing platform reads non-healthy"

    for step in range(1, 6):                      # twelve minutes apart, the five others in turn, none of them xhs
        clock[0] = NOW + timedelta(minutes=12 * step)
        done = (await collector.tick())["crawl"]
        assert done["term"] == "司美格鲁肽" and done["posts"] == 1 and done["new"] == 1
    assert asked == ["xhs", "douyin", "zhihu", "weibo", "bilibili", "wechat_channels"]
    for _, name in CRAWL_PLATFORMS[1:]:
        read = await source(pool, f"social-{name}")
        assert read["health"] == "healthy" and read["last_ok_at"] is not None and read["consecutive_failures"] == 0

    clock[0] = NOW + timedelta(minutes=72)        # the second term goes round the five that are not parked
    for platform in ("douyin", "zhihu", "weibo", "bilibili", "wechat_channels"):
        done = (await collector.tick())["crawl"]
        assert done["term"] == "流感" and done["platform"] == platform
        clock[0] += timedelta(minutes=12)
    assert "xhs" not in asked[6:], "xhs is parked for three hours"


async def test_a_parked_platform_comes_back_when_its_time_is_up_and_a_success_clears_it(social_settings, pool, tmp_path):
    asked, down = [], {"xhs"}

    def handler(request: httpx.Request):
        platform = json.loads(request.content)["platforms"][0]
        asked.append(platform)
        return httpx.Response(500) if platform in down else collected(request)

    collector = await six_platform_monitor(social_settings, pool, tmp_path, handler, terms=("流感",))
    clock = [NOW]
    collector._clock = lambda: clock[0]
    await collector.tick()                                         # xhs fails and is parked until 09:00
    for _ in range(5):
        clock[0] += timedelta(minutes=12)
        await collector.tick()
    assert asked == ["xhs", "douyin", "zhihu", "weibo", "bilibili", "wechat_channels"]
    clock[0] = NOW + timedelta(hours=3, minutes=1)
    assert (await collector.tick())["crawl"]["platform"] == "xhs", "its time is up: it is asked again"
    assert asked[-1] == "xhs"
    again = await source(pool, "social-xiaohongshu")
    assert again["consecutive_failures"] == 2 and again["next_poll_at"] == clock[0] + timedelta(hours=6), "doubled"

    down.clear()                                                   # it recovers; the round robin reaches it in its turn
    clock[0] = NOW + timedelta(hours=9, minutes=2)
    for _ in range(6):
        done = (await collector.tick())["crawl"]
        clock[0] += timedelta(minutes=12)
        if done["platform"] == "xhs":
            break
    assert done["platform"] == "xhs" and done["posts"] == 1
    back = await source(pool, "social-xiaohongshu")
    assert back["health"] == "healthy" and back["consecutive_failures"] == 0 and back["last_ok_at"] == clock[0] - timedelta(minutes=12)
    async with pool.connection() as conn:
        state = (await (await conn.execute("SELECT value FROM evimed_knowledge.meta WHERE key = 'social_crawl_state'")).fetchone())["value"]
    assert "parked" not in state, "the first success clears the park"


async def test_a_busy_answer_parks_nobody_and_all_platforms_down_waits_without_asking(social_settings, pool, tmp_path):
    asked, status = [], [429]

    def handler(request: httpx.Request):
        asked.append(json.loads(request.content)["platforms"][0])
        return httpx.Response(status[0], json={"detail": "x"})

    collector = await six_platform_monitor(social_settings, pool, tmp_path, handler, terms=("流感",))
    clock = [NOW]
    collector._clock = lambda: clock[0]
    assert (await collector.tick())["crawl"] == {"busy": "http_429"}
    clock[0] = NOW + timedelta(minutes=11)
    status[0] = 500
    for _ in range(6):                                              # the crawler itself is down: each platform fails once
        clock[0] += timedelta(minutes=12)
        assert "parked_until" in (await collector.tick())["crawl"]
    assert asked == ["xhs", "xhs", "douyin", "zhihu", "weibo", "bilibili", "wechat_channels"], "xhs was not parked by the busy answer"
    clock[0] += timedelta(minutes=12)
    assert (await collector.tick())["crawl"] == {"skipped": "all_parked"}
    assert len(asked) == 7


async def test_a_partial_read_with_posts_is_a_success_that_says_it_is_partial(social_settings, pool, tmp_path):
    """A platform whose comments stage failed kept its posts and was recorded as an http-error: its failure streak grew and its last
    success never moved, so a platform that worked every time read as failing."""
    def partial(request: httpx.Request):
        body = json.loads(collected(request).content)
        body["meta"] = {"collection_status": "partial_collected", "comments": {"failed": 3, "complete": False}}
        return httpx.Response(200, json=body)

    collector = await six_platform_monitor(social_settings, pool, tmp_path, partial, terms=("流感",))
    assert (await collector.tick())["crawl"] == {"term": "流感", "platform": "xhs", "posts": 1, "new": 1}
    xhs = await source(pool, "social-xiaohongshu")
    assert xhs["consecutive_failures"] == 0 and xhs["last_ok_at"] == NOW and xhs["health"] == "healthy"
    assert xhs["last_error_code"].startswith("partial term=流感") and "status=partial_collected" in xhs["last_error_code"]
    async with pool.connection() as conn:
        fetch = await (await conn.execute("SELECT outcome FROM evimed_knowledge.fetches WHERE source_id = 'social-xiaohongshu'")).fetchone()
        state = (await (await conn.execute("SELECT value FROM evimed_knowledge.meta WHERE key = 'social_crawl_state'")).fetchone())["value"]
    assert fetch["outcome"] == "ok" and "parked" not in state
    assert collector.counters["crawl_partial"] == 1 and len(await entries(pool, "social-xiaohongshu")) == 1


async def test_unmet_requirements_without_errors_are_an_empty_read_and_park_nobody(social_settings, pool, tmp_path):
    """Fewer posts than the five asked for is a quiet term on a quiet platform, not a platform that failed: it was parked for three hours."""
    def quiet(request: httpx.Request):
        platform = json.loads(request.content)["platforms"][0]
        return httpx.Response(200, json={"platform": platform, "requirements_met": False, "posts": [],
                                         "meta": {"collection_status": "collected", "requirements_met": False}})

    collector = await six_platform_monitor(social_settings, pool, tmp_path, quiet, terms=("流感",))
    assert (await collector.tick())["crawl"] == {"term": "流感", "platform": "xhs", "posts": 0, "new": 0}
    xhs = await source(pool, "social-xiaohongshu")
    assert xhs["consecutive_failures"] == 0 and xhs["last_ok_at"] == NOW
    async with pool.connection() as conn:
        fetch = await (await conn.execute("SELECT outcome FROM evimed_knowledge.fetches WHERE source_id = 'social-xiaohongshu'")).fetchone()
        state = (await (await conn.execute("SELECT value FROM evimed_knowledge.meta WHERE key = 'social_crawl_state'")).fetchone())["value"]
    assert fetch["outcome"] == "empty" and "parked" not in state, "the next platform is asked in its turn"
    assert collector.counters["crawl_parked"] == 0


async def test_the_scheduler_never_claims_a_social_source(social_settings, pool):
    from knowledge_plugin.scheduler import Crawler

    feed = {"id": "feed", "name": "A feed", "lane": "evidence", "source_type": "journal", "access": "rss", "egress": "direct",
            "authority": 3, "safety_feed": False, "owner_entity": "X", "launch_tier": "P0", "poll_floor_s": 3600,
            "poll_ceiling_s": 7200, "enabled": True, "config": {"url": "https://example.org/feed"}}
    await sync(pool, [x_row("US_FDA"), wx_row(), crawl_row(), feed])
    crawler = Crawler(social_settings, pool, FakeFetcher(), adapters={}, enricher=lambda *a: None, clock=lambda: NOW)
    claimed = await crawler.claim(50)
    assert [row["id"] for row in claimed] == ["feed"], "the social read methods are the social collector's alone"
