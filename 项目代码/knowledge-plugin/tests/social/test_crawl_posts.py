"""A post of the six Chinese platforms, whole (2026-10-31): its own text as the entry's text, its pictures read out of the
crawler's raw answer, the retained jobs' shapes. Pure: no database, no network. The raw fixtures are the shapes of the crawler's
retained answers with every value invented (no real text, no author)."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from knowledge_plugin.social import crawl as crawl_mod
from knowledge_plugin.social.providers import job_ids, snapshot_posts

NOW = datetime(2026, 10, 31, 6, 0, tzinfo=timezone.utc)
URL = "https://www.xiaohongshu.com/explore/n1"


def post(**fields):
    return {"post_id": "n1", "url": URL, "title": "标题", "content": "正文第一段。\n\n正文第二段。", **fields}


# ------------------------------------------------------------------------------------ the text

def test_the_entry_holds_the_post_whole_and_its_excerpt_stays_300_characters():
    long = "第一句。" * 400                                   # 1,600 characters, as an XHS post runs
    entry = crawl_mod.build_entry(post(title="睡眠", content=long), "xhs", now=NOW)
    assert entry.body_text == long and entry.body_from == "social" and entry.body_kind == "full"
    assert len(entry.summary) == crawl_mod.EXCERPT_MAX and entry.summary.endswith("…") and entry.summary.startswith("睡眠 第一句")
    assert not entry.body_text.startswith("睡眠"), "the title is not put in front of the post's own text"
    assert entry.title == "睡眠" and entry.platform == "xiaohongshu" and entry.author is None


def test_the_text_is_normalised_for_whitespace_only():
    messy = "第一段\r\n\r\n\t\t\r\n第二段   有  空格\n\n\n第三段​结尾"
    entry = crawl_mod.build_entry(post(content=messy), "weibo", now=NOW)
    assert entry.body_text == "第一段\n\n第二段 有 空格\n\n第三段结尾", "tab-only lines and runs of blanks go, nothing else"


def test_the_platforms_own_markers_stay_in_the_text_for_the_platform_to_read():
    content = "#抑郁症[话题]# #睡眠[话题]#\n今天好些了[哭惹R]‌￼"
    entry = crawl_mod.build_entry(post(content=content), "xhs", now=NOW)
    assert "#抑郁症[话题]#" in entry.body_text and "[哭惹R]" in entry.body_text, "format cleaning is the platform's"


def test_a_content_that_only_repeats_the_title_is_no_text_but_the_post_is_still_an_entry():
    for content in ("标题", "  标题 ", "标题\n", ""):
        entry = crawl_mod.build_entry(post(content=content), "xhs", now=NOW)
        assert entry is not None and entry.body_text is None and entry.body_from is None and entry.title == "标题", content
    only_content = crawl_mod.build_entry(post(title="", content="没有标题的一段话"), "bilibili", now=NOW)
    assert only_content.title == "没有标题的一段话" and only_content.body_text == "没有标题的一段话"
    assert crawl_mod.build_entry(post(title="", content=""), "xhs", now=NOW) is None, "nothing to say at all"
    assert crawl_mod.build_entry(post(url=""), "xhs", now=NOW) is None


def test_the_text_is_bounded_with_a_reason_and_cut_at_a_paragraph():
    paragraphs = "\n\n".join("段" * 900 for _ in range(40))      # 36,000 characters
    body = crawl_mod.build_entry(post(content=paragraphs), "zhihu", now=NOW).body_text
    assert len(body) <= crawl_mod.BODY_MAX and body.endswith("…") and body.count("\n\n") < 39


# ------------------------------------------------------------------------------------ the pictures

def image(n, **extra):
    return {"fileid": f"1040g2sg-file-{n}", "url": "[REDACTED_URL]", "url_size_large": "[REDACTED_URL]", "width": 1080, "height": 1440, "index": n, **extra}


def xhs_raw(images, *, kind="normal", where="detail"):
    note = {"type": kind, "images_list": images, "title": "invented", "desc": "invented"}
    if where == "detail":
        return {"detail": {"code": 0, "data": {"data": [{"note_list": [note]}]}}}
    return {"search": {"note": note}}


def test_an_xhs_picture_note_gives_all_its_pictures_in_order():
    raw = xhs_raw([image(2), image(0), image(1)])
    assert [item["url"] for item in crawl_mod.pictures_of(post(raw_response=raw), "xhs")] == [
        "https://ci.xiaohongshu.com/1040g2sg-file-0", "https://ci.xiaohongshu.com/1040g2sg-file-1", "https://ci.xiaohongshu.com/1040g2sg-file-2"]


def test_an_xhs_video_note_gives_one_poster_and_the_search_answer_is_read_when_there_is_no_detail():
    video = xhs_raw([image(0), image(1)], kind="video")
    assert crawl_mod.pictures_of(post(raw_response=video), "xhs") == [{"url": "https://ci.xiaohongshu.com/1040g2sg-file-0", "kind": "video-poster"}]
    searched = {"search": {"note": {"type": "normal", "images_list": [image(0)]}}}
    assert crawl_mod.pictures_of(post(raw_response=searched), "xhs") == [{"url": "https://ci.xiaohongshu.com/1040g2sg-file-0", "kind": "image"}]


def test_pictures_are_capped_at_the_contracts_media_bound_and_deduplicated():
    raw = xhs_raw([image(n) for n in range(12)])
    assert len(crawl_mod.pictures_of(post(raw_response=raw), "xhs")) == crawl_mod.PICTURES_MAX == 8
    same = xhs_raw([image(0), image(0, index=1)])
    assert [item["url"] for item in crawl_mod.pictures_of(post(raw_response=same), "xhs")] == ["https://ci.xiaohongshu.com/1040g2sg-file-0"]


def test_weibo_pictures_are_named_from_pic_ids_on_its_image_host():
    raw = {"detail": {"data": {"pic_ids": ["006abcDEFgy1", "006abcDEFgy2"]}}}
    assert crawl_mod.pictures_of(post(raw_response=raw), "weibo") == [
        {"url": "https://wx1.sinaimg.cn/large/006abcDEFgy1.jpg", "kind": "image"}, {"url": "https://wx1.sinaimg.cn/large/006abcDEFgy2.jpg", "kind": "image"}]
    assert [item["url"] for item in crawl_mod.pictures_of(post(raw_response={"search": {"pic_ids": ["006abcDEFgy3"]}}), "weibo")] == [
        "https://wx1.sinaimg.cn/large/006abcDEFgy3.jpg"]
    assert crawl_mod.pictures_of(post(raw_response={"search": {"pic_ids": []}}), "weibo") == []


@pytest.mark.parametrize("platform", ["xhs", "weibo", "douyin", "bilibili", "wechat_channels", "zhihu", "unknown"])
@pytest.mark.parametrize("raw", [None, "text", 7, [], {}, {"detail": None}, {"detail": {"data": "x"}}, {"detail": {"data": {"data": "x"}}},
                                 {"search": {"note": {"images_list": "x"}}}, {"search": {"note": {"images_list": [None, 3, "u"]}}},
                                 {"detail": {"data": {"data": [{"note_list": [None]}]}}}, {"search": {"video": {"cover": {"url_list": "x"}}}},
                                 {"detail": {"data": {"pic_ids": "a", "pic_infos": [1]}}}, {"search": {"av": {"cover": 5}}}])
def test_a_raw_answer_of_any_shape_costs_the_pictures_never_the_post(platform, raw):
    assert crawl_mod.pictures_of(post(raw_response=raw), platform) == []
    assert crawl_mod.pictures_of({"url": URL}, platform) == []
    entry = crawl_mod.build_entry(post(raw_response=raw), platform, now=NOW)
    assert entry is not None and entry.media == [], "the entry never carries the raw answer or an address from it"


def test_a_platform_with_no_file_id_and_a_redacted_or_unsafe_value_give_no_pictures():
    for platform in ("douyin", "bilibili", "wechat_channels", "zhihu"):
        assert crawl_mod.pictures_of(post(raw_response={"search": {"image": "[REDACTED_URL]", "video": {"cover": "[REDACTED_URL]"}}}), platform) == []
    for bad in ("[REDACTED_URL]", "../../etc/passwd", "short", "a b c d e f g h", 7, None):
        assert crawl_mod.pictures_of(post(raw_response=xhs_raw([{"fileid": bad, "url": "[REDACTED_URL]"}])), "xhs") == [], bad


def test_job_ids_reads_a_list_or_an_object_holding_one():
    a, b, c = "a" * 32, "b" * 32, "c" * 32
    assert job_ids([{"job_id": a, "job_status": "done"}, b, {"job_id": "short"}, 7, None]) == [a, b]
    assert job_ids({"total": 3, "jobs": [{"job_id": c}]}) == [c]
    assert job_ids({"items": [{"job_id": a}]}) == [a] and job_ids({"data": [b]}) == [b]
    assert job_ids({"jobs": "x"}) == [] and job_ids("x") == [] and job_ids(None) == []


def test_snapshot_posts_reads_one_platforms_answer_or_the_envelope_and_nothing_from_a_job_without_a_result():
    p1, p2 = {"post_id": "1"}, {"post_id": "2"}
    single = {"platforms": ["xhs"], "result": {"platform": "xhs", "posts": [p1, "x", p2]}}
    assert snapshot_posts(single) == [("xhs", p1), ("xhs", p2)]
    nameless = {"platforms": ["weibo"], "result": {"posts": [p1]}}
    assert snapshot_posts(nameless) == [("weibo", p1)]
    envelope = {"platforms": ["xhs", "douyin"], "result": {"results": {"xhs": {"posts": [p1]}, "douyin": {"posts": [p2]}}}}
    assert snapshot_posts(envelope) == [("xhs", p1), ("douyin", p2)]
    for snapshot in ({"job_status": "failed"}, {"result": None}, {"result": {"posts": "x"}}, None, [], {"result": {"results": {"xhs": None}}}):
        assert snapshot_posts(snapshot) == []
