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
    return {"url": f"http://sns-webpic.test/{n}/std", "original": f"http://sns-webpic.test/{n}/orig",
            "url_size_large": f"https://sns-webpic.test/{n}/large", "width": 1080, "height": 1440, "index": n, **extra}


def xhs_raw(images, *, kind="normal", where="detail"):
    note = {"type": kind, "images_list": images, "title": "invented", "desc": "invented"}
    if where == "detail":
        return {"detail": {"code": 0, "data": {"data": [{"note_list": [note]}]}}}
    return {"search": {"note": note}}


def test_an_xhs_picture_note_gives_all_its_pictures_in_order_the_large_one_first():
    raw = xhs_raw([image(2), image(0), image(1, url_size_large=None)])
    assert crawl_mod.pictures_of(post(raw_response=raw), "xhs") == [
        {"url": "https://sns-webpic.test/0/large", "kind": "image"},
        {"url": "https://sns-webpic.test/1/orig", "kind": "image"},      # no large one: the original (http taken as https)
        {"url": "https://sns-webpic.test/2/large", "kind": "image"}]


def test_an_xhs_video_note_gives_one_poster_and_the_search_answer_is_read_when_there_is_no_detail():
    video = xhs_raw([image(0), image(1)], kind="video")
    assert crawl_mod.pictures_of(post(raw_response=video), "xhs") == [{"url": "https://sns-webpic.test/0/large", "kind": "video-poster"}]
    searched = xhs_raw([image(0)], where="search")
    assert crawl_mod.pictures_of(post(raw_response=searched), "xhs") == [{"url": "https://sns-webpic.test/0/large", "kind": "image"}]


def test_pictures_are_capped_at_the_contracts_media_bound_and_deduplicated():
    raw = xhs_raw([image(n) for n in range(12)])
    assert len(crawl_mod.pictures_of(post(raw_response=raw), "xhs")) == crawl_mod.PICTURES_MAX == 8
    same = xhs_raw([image(0), image(0), image(1)])
    assert [item["url"] for item in crawl_mod.pictures_of(post(raw_response=same), "xhs")] == [
        "https://sns-webpic.test/0/large", "https://sns-webpic.test/1/large"]


def test_weibo_pictures_follow_pic_ids_through_pic_infos_and_fall_back_to_the_parsed_media():
    infos = {"a1": {"large": {"url": "https://wx1.sinaimg.test/large/a1.jpg"}, "thumbnail": {"url": "https://t/x"}},
             "b2": {"original": {"url": "http://wx2.sinaimg.test/orj/b2.jpg"}}}
    raw = {"detail": {"data": {"pic_ids": ["b2", "a1", "missing"], "pic_num": 3, "pic_infos": infos}}}
    assert crawl_mod.pictures_of(post(raw_response=raw), "weibo") == [
        {"url": "https://wx2.sinaimg.test/orj/b2.jpg", "kind": "image"}, {"url": "https://wx1.sinaimg.test/large/a1.jpg", "kind": "image"}]
    parsed = {"search": {"_v2_parsed": {"media": {"has_image": True, "images": ["//wx3.sinaimg.test/large/c3.jpg",
                                                                              {"url": "https://wx4.sinaimg.test/d4.jpg"}]}}}}
    assert [item["url"] for item in crawl_mod.pictures_of(post(raw_response=parsed), "weibo")] == [
        "https://wx3.sinaimg.test/large/c3.jpg", "https://wx4.sinaimg.test/d4.jpg"]
    video = {"detail": {"data": {"pic_ids": [], "page_info": {"type": "video", "page_pic": "https://p.test/poster.jpg"}}}}
    assert crawl_mod.pictures_of(post(raw_response=video), "weibo") == [{"url": "https://p.test/poster.jpg", "kind": "video-poster"}]
    text_only = {"search": {"_v2_parsed": {"media": {"has_image": False, "images": []}}}, "detail": {"data": {"pic_ids": [], "pic_num": 0}}}
    assert crawl_mod.pictures_of(post(raw_response=text_only), "weibo") == []


def test_a_video_has_one_poster_on_douyin_bilibili_and_channels_an_album_has_its_pictures():
    video = {"detail": {"data": {"aweme_detail": {"images": None, "video": {"cover": {"url_list": [
        "https://p3.douyinpic.test/a.heic", "https://p3.douyinpic.test/a.jpeg"]}}}}}}
    assert crawl_mod.pictures_of(post(raw_response=video), "douyin") == [{"url": "https://p3.douyinpic.test/a.jpeg", "kind": "video-poster"}], \
        "an address of a format the store cannot decode is chosen only when it is the only one"
    album = {"search": {"video": {"cover": {"url_list": ["https://x.test/cover.jpeg"]}},
                        "images": [{"url_list": ["https://x.test/1.jpeg"], "width": 1}, {"url_list": ["https://x.test/2.webp"]}]}}
    assert [item["kind"] for item in crawl_mod.pictures_of(post(raw_response=album), "douyin")] == ["image", "image"]
    bilibili = {"search": {"av": {"cover": "//i0.hdslb.test/bfs/archive/c.jpg"}}, "detail": {"data": {"data": {"View": {"pic": ""}}}}}
    assert crawl_mod.pictures_of(post(raw_response=bilibili), "bilibili") == [{"url": "https://i0.hdslb.test/bfs/archive/c.jpg", "kind": "video-poster"}]
    channels = {"search": {"image": "https://wx.test/cover.jpg"}, "detail": {"data": {"cover_img_url": "", "media": {"cover_url": "https://wx.test/other"}}}}
    assert crawl_mod.pictures_of(post(raw_response=channels), "wechat_channels") == [{"url": "https://wx.test/cover.jpg", "kind": "video-poster"}]


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


def test_zhihu_and_unusable_addresses_give_no_pictures():
    raw = {"search": {"object": {"thumbnail_info": {"thumbnails": [{"url": "https://pic.zhimg.test/a.jpg"}]}}}}
    assert crawl_mod.pictures_of(post(raw_response=raw), "zhihu") == []
    for bad in ("ftp://x/a.jpg", "javascript:alert(1)", "data:image/png;base64,AAAA", "https://a b/c.jpg", "https://x.test/" + "a" * 2100):
        assert crawl_mod.pictures_of(post(raw_response=xhs_raw([{"url": bad}])), "xhs") == [], bad


# ------------------------------------------------------------------------------------ the retained jobs

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
