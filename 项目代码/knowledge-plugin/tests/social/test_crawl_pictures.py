"""The six-platform monitor keeps a post whole (2026-10-31): its text, its pictures from the crawler's raw answer, the raw answer
nowhere, and a post stored short of itself filled when a later read answers it whole. The crawler and the picture hosts are
faked."""

from __future__ import annotations

import json
import logging
from dataclasses import replace
from datetime import timedelta

import httpx
import pytest

from knowledge_plugin.api import create_app
from knowledge_plugin.social.collector import SocialCollector

from social_fakes import FakeFetcher, contract_validator, png_bytes
from test_social_collectors import NOW, crawl_row, entries, job_transport, source, sync

pytestmark = pytest.mark.db
SECRET = "秘密作者昵称"
NOTE_TEXT = "第一段说明。\n\n第二段：夜间血压要监测。 #高血压[话题]#"


def xhs_post(post_id="n1", *, content=NOTE_TEXT, images=3):
    note = {"type": "normal", "images_list": [{"url": "[REDACTED_URL]", "url_size_large": "[REDACTED_URL]", "fileid": f"{post_id}-file-{n}",
                                               "index": n, "width": 8, "height": 6} for n in range(images)]}
    return {"post_id": post_id, "title": "血压日记", "content": content, "url": f"https://www.xiaohongshu.com/explore/{post_id}",
            "likes": 3, "author": SECRET, "author_id": "u-secret",
            "raw_response": {"search": {"note": note, "user": {"nickname": SECRET, "user_id": "u-secret"}},
                             "detail": {"data": {"data": [{"note_list": [note], "user": {"nickname": SECRET}}]}}},
            "publish_time": int((NOW - timedelta(hours=3)).timestamp())}


def pictures_fetcher(*, fail=()):
    colours = {"0": (200, 30, 30), "1": (30, 200, 30), "2": (30, 30, 200)}

    def serve(spec):
        n = spec.url[-1]
        return (500, b"") if n in fail else (200, png_bytes((64, 48), colours[n]), {"content-type": "image/png"})

    return FakeFetcher({("GET", "https://ci.xiaohongshu.com/"): serve})


async def monitor(social_settings, pool, tmp_path, posts, *, fetcher, platform=("xhs", "xiaohongshu"), asked=None):
    registry = tmp_path / "social-sources.json"
    registry.write_text(json.dumps({"sources": [], "watch_list": [{"term": "高血压", "why": "test"}]}))
    settings = replace(social_settings, social_registry_path=str(registry))
    await sync(pool, [crawl_row(*platform)])

    def handler(request: httpx.Request):
        body = json.loads(request.content)
        if asked is not None:
            asked.append(body)
        return httpx.Response(200, json={"platform": body["platforms"][0], "meta": {"collection_status": "collected"},
                                         "posts": json.loads(json.dumps(posts()))})

    clock = [NOW]
    collector = SocialCollector(settings, pool, fetcher, clock=lambda: clock[0], crawl_transport=job_transport(handler))
    return collector, clock


async def test_a_post_is_stored_whole_with_its_pictures_and_the_raw_answer_goes_no_further(social_settings, pool, tmp_path, caplog):
    asked: list[dict] = []
    fetcher = pictures_fetcher(fail={"2"})                   # the third picture's host fails: the post goes without that one
    collector, _ = await monitor(social_settings, pool, tmp_path, lambda: [xhs_post()], fetcher=fetcher, asked=asked)
    caplog.set_level(logging.DEBUG)
    assert (await collector.tick())["crawl"] == {"term": "高血压", "platform": "xhs", "posts": 1, "new": 1}
    assert asked[0]["include_provider_raw"] is True, "the pictures' addresses are in the provider's raw answer"
    (row,) = await entries(pool, "social-xiaohongshu")
    assert row["body_text"] == NOTE_TEXT and row["text_kind"] == "full" and row["text_status"] == "available"
    assert len(row["summary"]) <= 300 and row["title"] == "血压日记"
    assert [item["kind"] for item in row["media"]] == ["image", "image"]
    assert [item["original_url"] for item in row["media"]] == ["https://ci.xiaohongshu.com/n1-file-0", "https://ci.xiaohongshu.com/n1-file-1"], "in the post's order"
    assert collector.media.counters["stored"] == 2

    everything = []
    async with pool.connection() as conn:
        for table in ("entries", "entry_texts", "seen_keys", "provider_calls", "media", "media_failures", "meta", "fetches"):
            everything += [json.dumps(r, default=str, ensure_ascii=False)
                           for r in await (await conn.execute(f"SELECT * FROM evimed_knowledge.{table}")).fetchall()]
    blob = "\n".join(everything) + "\n" + caplog.text
    assert SECRET not in blob and "u-secret" not in blob and "raw_response" not in blob, "the raw answer is read and dropped"


async def test_a_weibo_picture_is_asked_with_the_referrer_its_host_wants(social_settings, pool, tmp_path):
    def post():
        return [{"post_id": "w1", "title": "", "content": "微博标题\n微博正文", "url": "https://m.weibo.cn/detail/w1",
                 "publish_time": int((NOW - timedelta(hours=1)).timestamp()),
                 "raw_response": {"detail": {"data": {"pic_ids": ["006abcDEFgy1"], "pic_infos": {"006abcDEFgy1": {"large": {"url": "[REDACTED_URL]"}}}}}}}]

    seen = []

    def serve(spec):
        seen.append(spec)
        return 200, png_bytes((64, 48)), {"content-type": "image/png"}

    fetcher = FakeFetcher({("GET", "https://wx1.sinaimg.cn/"): serve})
    collector, _ = await monitor(social_settings, pool, tmp_path, post, fetcher=fetcher, platform=("weibo", "weibo"))
    assert (await collector.tick())["crawl"]["new"] == 1
    assert fetcher.calls[0]["headers"]["Referer"] == "https://weibo.com/"
    (row,) = await entries(pool, "social-weibo")
    assert len(row["media"]) == 1 and row["body_text"] == "微博正文"


async def test_a_title_only_post_with_pictures_is_an_entry_with_no_text_and_its_pictures(social_settings, pool, tmp_path):
    collector, _ = await monitor(social_settings, pool, tmp_path, lambda: [xhs_post(content="血压日记", images=2)], fetcher=pictures_fetcher())
    assert (await collector.tick())["crawl"]["new"] == 1
    (row,) = await entries(pool, "social-xiaohongshu")
    assert row["body_text"] is None and row["text_status"] == "none" and len(row["media"]) == 2


async def test_a_post_stored_short_of_itself_is_filled_once_a_later_read_answers_it_whole(social_settings, pool, tmp_path):
    collector, clock = await monitor(social_settings, pool, tmp_path, lambda: [xhs_post()], fetcher=pictures_fetcher())
    await collector.tick()
    (stored,) = await entries(pool, "social-xiaohongshu")
    async with pool.connection() as conn:              # the shape the posts had until 2026-10-31: an excerpt, no text, no picture
        await conn.execute("UPDATE evimed_knowledge.entries SET media = '[]'::jsonb WHERE entry_id = %s", (stored["entry_id"],))
        await conn.execute("UPDATE evimed_knowledge.entry_texts SET text_kind = 'excerpt', body_text = NULL, "
                           "body_excerpt = '血压日记 第一段说明。' WHERE entry_id = %s", (stored["entry_id"],))
    clock[0] = NOW + timedelta(minutes=13)
    again = (await collector.tick())["crawl"]
    assert again == {"term": "高血压", "platform": "xhs", "posts": 1, "new": 0, "filled": 1}
    (filled,) = await entries(pool, "social-xiaohongshu")
    assert filled["revision"] == stored["revision"] + 1 and filled["seq"] > stored["seq"], "delivered again as the next revision"
    assert filled["text_kind"] == "full" and filled["body_text"] == stored["body_text"] and len(filled["media"]) == 3
    assert filled["summary"] == stored["summary"] and collector.counters["crawl_filled"] == 1

    clock[0] = NOW + timedelta(minutes=26)
    assert (await collector.tick())["crawl"] == {"term": "高血压", "platform": "xhs", "posts": 1, "new": 0}, "nothing left to add"
    (last,) = await entries(pool, "social-xiaohongshu")
    assert last["revision"] == filled["revision"]


async def test_a_full_text_already_stored_is_never_replaced_by_a_later_read(social_settings, pool, tmp_path):
    texts = iter([NOTE_TEXT, NOTE_TEXT + "\n\n后来补充的一段。"])
    collector, clock = await monitor(social_settings, pool, tmp_path, lambda: [xhs_post(content=next(texts))], fetcher=pictures_fetcher())
    await collector.tick()
    clock[0] = NOW + timedelta(minutes=13)
    assert "filled" not in (await collector.tick())["crawl"]
    (row,) = await entries(pool, "social-xiaohongshu")
    assert row["body_text"] == NOTE_TEXT and row["revision"] == 1


async def test_the_crawl_reads_a_platform_whose_answer_has_no_raw_part_as_before(social_settings, pool, tmp_path):
    def bare():
        post = xhs_post()
        del post["raw_response"]
        return [post]

    collector, _ = await monitor(social_settings, pool, tmp_path, bare, fetcher=pictures_fetcher())
    assert (await collector.tick())["crawl"]["new"] == 1
    (row,) = await entries(pool, "social-xiaohongshu")
    assert row["media"] == [] and row["body_text"] == NOTE_TEXT
    assert (await source(pool, "social-xiaohongshu"))["consecutive_failures"] == 0


async def test_the_stream_and_text_say_it_on_the_wire(social_settings, pool, tmp_path):
    _, assert_schema = contract_validator()
    collector, _ = await monitor(social_settings, pool, tmp_path, lambda: [xhs_post()], fetcher=pictures_fetcher())
    await collector.tick()
    app = create_app(social_settings, pool=pool, clock=lambda: NOW)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://plugin") as client:
        client.headers["Authorization"] = "Bearer test-token-0123456789"
        page = (await client.get("/v1/entries", params={"after": 0})).json()
        assert_schema(page, "EntryPage")
        (entry,) = page["entries"]
        assert entry["platform"] == "xiaohongshu" and entry["channel"] == "social" and "author" not in entry
        assert [item["kind"] for item in entry["media"]] == ["image", "image", "image"] and entry["text_status"] == "available"
        assert len(entry["summary"]) <= 300
        text = (await client.get(f"/v1/entries/{entry['entry_id']}/text")).json()
        assert_schema(text, "EntryText")
        assert text["text_kind"] == "full" and text["body_text"] == NOTE_TEXT and text["fetched_from"] == "social"
        assert text["body_excerpt"] == NOTE_TEXT, "a full text is its own excerpt, so a reader of the excerpt alone sees the post"
        stored = (await client.get(f"/v1/media/{entry['media'][0]['id']}")).headers["content-type"]
        assert stored == "image/jpeg", "re-encoded by the store"


def test_pictures_are_named_from_file_ids_because_the_crawler_redacts_every_address():
    from knowledge_plugin.social.crawl import pictures_of
    note = {"type": "normal", "images_list": [{"fileid": "1040g2sg31abcDEF", "index": 1, "url": "[REDACTED_URL]"},
                                              {"fileid": "1040g2sg31abcDE0", "index": 0, "url": "[REDACTED_URL]"},
                                              {"fileid": "../../etc/passwd", "index": 2}]}
    assert pictures_of({"raw_response": {"detail": {"data": {"data": [{"note_list": [note]}]}}}}, "xhs") == [
        {"url": "https://ci.xiaohongshu.com/1040g2sg31abcDE0", "kind": "image"}, {"url": "https://ci.xiaohongshu.com/1040g2sg31abcDEF", "kind": "image"}], "in order, and a value that is no file id is nothing"
    video = {"type": "video", "images_list": [{"fileid": "1040g2sg31abcDEF"}, {"fileid": "1040g2sg31abcDE0"}]}
    assert pictures_of({"raw_response": {"search": {"note": video}}}, "xhs") == [{"url": "https://ci.xiaohongshu.com/1040g2sg31abcDEF", "kind": "video-poster"}]
    assert pictures_of({"raw_response": {"search": {"pic_ids": ["006abcDEFgy1"]}}}, "weibo") == [{"url": "https://wx1.sinaimg.cn/large/006abcDEFgy1.jpg", "kind": "image"}]
    for platform in ("douyin", "bilibili", "wechat_channels", "zhihu"):
        assert pictures_of({"raw_response": {"search": {"image": "[REDACTED_URL]"}}}, platform) == []
