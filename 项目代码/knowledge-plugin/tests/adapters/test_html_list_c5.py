"""html-list readings added with the c5-sources batch (2026-10-26): a list marker inside the link text, a title the page cut
for its layout, and a month written as a Chinese name.

The three real pages they were made for are recorded cases (``tests/fixtures/record.py``): 江苏省药监局's Hanweb list (every
link text starts with ``· ``), 河南省药监局's 公告通告 (the visible text is cut with ``...`` and the full title is the link's
``title`` attribute) and 清华大学医学院's 科研动态 (the date is ``十月 15, 2026``). The small cases below are the rules on their own.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone

import pytest
from selectolax.parser import HTMLParser

from knowledge_plugin.adapters import REGISTRY, validate_config
from knowledge_plugin.adapters.common import parse_date
from knowledge_plugin.adapters.html_list import LIST_MARKERS, list_entries
from knowledge_plugin.model import SourceConfig
from replay import load_case

ADAPTER = REGISTRY["html-list"]


def parsed(name, **selectors):
    case = load_case(f"html-list/{name}")
    source = case.source
    if selectors:
        source = replace(source, config={**source.config, "selectors": {**source.config["selectors"], **selectors}})
    return case, ADAPTER.parse(case.results()[0], source, case.now)


def small_source(selectors, **config):
    return SourceConfig(id="probe", name="probe", homepage=None, lane="regulatory", source_type="regulator", access="html-list",
                        egress="direct", authority=5, safety_feed=False, owner_entity="probe", launch_tier="P2", language="zh",
                        region="CN", poll_floor_s=3600, poll_ceiling_s=21600,
                        config={"url": "https://x.example/list", "max_pages": 1, "allowed_hosts": ["x.example"],
                                "selectors": selectors, **config})


def titles_of(html, selectors, **config):
    entries, _ = list_entries(html, source=small_source(selectors, **config), base="https://x.example/list")
    return [entry.title for entry in entries]


# ---------------------------------------------------------------------------------------------- list markers


def test_a_bullet_in_front_of_the_link_text_is_not_part_of_the_title():
    # 江苏省药监局: ``<a class="bt_link">· 省药品监督检验研究院…</a>`` on every row of both columns
    case, output = parsed("cn-js-mpa-dt")
    assert validate_config(case.source) == []
    assert "· " in case.results()[0].body.decode("utf-8"), "the recorded page carries the bullet: the case proves something"
    assert len(output.entries) == 30 and output.notes == []
    for entry in output.entries:
        assert not entry.title.startswith(tuple(LIST_MARKERS)) and not entry.title[0].isspace()
        assert entry.published_at is not None and entry.url.startswith("https://da.jiangsu.gov.cn/art/")
    assert output.entries[0].title.startswith("省药品监督检验研究院连云港检验室")


@pytest.mark.parametrize("written, read", [
    ("· 省局信息", "省局信息"), ("·省局信息", "省局信息"), ("• Press release", "Press release"), ("・ お知らせ", "お知らせ"),
    ("· · 省局信息", "省局信息"),
])
def test_the_markers_the_pages_use_are_removed_once_and_only_at_the_front(written, read):
    html = f'<ul><li><a href="/a/1">{written}</a><i>2026-10-20</i></li></ul>'
    assert titles_of(html, {"item": "li", "title": "a", "link": "a@href", "date": "i"}) == [read]


def test_a_title_is_otherwise_left_as_written():
    html = ('<ul><li><a href="/a/1">【通告】省局信息 · 第二期</a><i>2026-10-20</i></li>'
            '<li><a href="/a/2">- Notice of 2026</a><i>2026-10-19</i></li></ul>')
    assert titles_of(html, {"item": "li", "title": "a", "link": "a@href", "date": "i"}) == ["【通告】省局信息 · 第二期", "- Notice of 2026"]


def test_a_title_that_is_only_a_marker_is_dropped_like_any_empty_title():
    html = '<ul><li><a href="/a/1">· </a><i>2026-10-20</i></li></ul>'
    entries, notes = list_entries(html, source=small_source({"item": "li", "title": "a", "link": "a@href", "date": "i"}),
                                  base="https://x.example/list")
    assert entries == [] and "html_list_dropped_title=1" in notes


# ---------------------------------------------------------------------------------------------- a cut title


def test_a_title_cut_for_the_layout_is_read_whole_from_the_title_attribute():
    case, by_attribute = parsed("cn-ha-mpa-ggtg")                         # the registry row reads ``a@title``
    _, by_text = parsed("cn-ha-mpa-ggtg", title="a")                      # the visible text, as a row without the attribute selector
    html = case.results()[0].body.decode("utf-8")
    visible = [a.text(strip=True) for a in HTMLParser(html).css("li a") if a.text(strip=True).endswith("...")]
    assert len(visible) >= 5, "the recorded page cuts its long titles"
    assert [e.title for e in by_text.entries] == [e.title for e in by_attribute.entries]
    assert not any(e.title.endswith("...") for e in by_text.entries)
    assert any(len(e.title) > 30 for e in by_text.entries)


def test_the_title_attribute_is_used_only_when_it_continues_the_visible_text():
    cut = lambda attribute: titles_of(  # noqa: E731
        f'<ul><li><a href="/a/1" title="{attribute}">省药监局关于开展药品抽检的通…</a><i>2026-10-20</i></li></ul>',
        {"item": "li", "title": "a", "link": "a@href", "date": "i"})
    assert cut("省药监局关于开展药品抽检的通告（2026年第12号）") == ["省药监局关于开展药品抽检的通告（2026年第12号）"]
    assert cut("省药监局 关于开展药品抽检的通告（2026年第12号）") == ["省药监局 关于开展药品抽检的通告（2026年第12号）"], "spacing is not part of the comparison"
    assert cut("点击查看详情") == ["省药监局关于开展药品抽检的通…"], "a tooltip about something else is not the title"
    assert cut("省药监局关于开展药品抽检的通") == ["省药监局关于开展药品抽检的通…"], "an attribute that adds nothing changes nothing"


def test_a_cut_title_with_a_bullet_in_front_matches_its_title_attribute_without_the_bullet():
    selectors = {"item": "li", "title": "a", "link": "a@href", "date": "i"}
    row = lambda visible, attribute: (  # noqa: E731
        f'<ul><li><a href="/a/1" title="{attribute}">{visible}</a><i>2026-10-20</i></li></ul>')
    full = "省药监局关于开展药品抽检的通告（2026年第12号）"
    assert titles_of(row("· 省药监局关于开展药品抽检的通…", full), selectors) == [full], "the bullet is not part of what the attribute continues"
    assert titles_of(row("·省药监局关于开展药品抽检的通...", full), selectors) == [full]
    assert titles_of(row("· 省药监局关于开展药品抽检的通…", f"· {full}"), selectors) == [full], "an attribute that carries the bullet too"
    assert titles_of(row("· 省药监局关于开展药品抽检的通…", "点击查看详情"), selectors) == ["省药监局关于开展药品抽检的通…"]
    assert titles_of(row("· …", full), selectors) == [], "nothing is left of the visible text to continue: no attribute is taken for it"


def test_the_attribute_is_looked_for_on_the_node_the_title_was_read_from_and_around_it():
    on_link = ('<ul><li><h3><a href="/a/1" title="Full title of the first article">Full title of the fi...</a></h3><i>2026-10-20</i></li></ul>')
    on_wrapper = ('<ul><li><a href="/a/2" title="Full title of the second article"><h3>Full title of the sec...</h3></a><i>2026-10-20</i></li></ul>')
    on_item = ('<ul><li title="Full title of the third article"><a href="/a/3">Full title of the thi...</a><i>2026-10-20</i></li></ul>')
    selectors = {"item": "li", "title": "h3", "link": "a@href", "date": "i"}
    assert titles_of(on_link, {**selectors, "title": "h3 a"}) == ["Full title of the first article"]
    assert titles_of(on_wrapper, selectors) == ["Full title of the second article"]
    assert titles_of(on_item, {**selectors, "title": "a"}) == ["Full title of the third article"]


def test_a_title_selector_that_names_an_attribute_is_read_as_it_says_and_an_uncut_title_is_untouched():
    html = ('<ul><li><a href="/a/1" title="A different tooltip that is long">The headline as shown</a><i>2026-10-20</i></li>'
            '<li><a href="/a/2" title="Cut by the page, in full">Cut by the page, in fu…</a><i>2026-10-19</i></li></ul>')
    assert titles_of(html, {"item": "li", "title": "a", "link": "a@href", "date": "i"}) == ["The headline as shown", "Cut by the page, in full"]
    assert titles_of(html, {"item": "li", "title": "a@title", "link": "a@href", "date": "i"}) == [
        "A different tooltip that is long", "Cut by the page, in full"]


# ---------------------------------------------------------------------------------------------- a Chinese month name


@pytest.mark.parametrize("name, month", [("一", 1), ("二", 2), ("三", 3), ("四", 4), ("五", 5), ("六", 6), ("七", 7), ("八", 8),
                                         ("九", 9), ("十", 10), ("十一", 11), ("十二", 12)])
def test_the_twelve_chinese_month_names_are_read(name, month):
    assert parse_date(f"{name}月 15, 2026") == (datetime(2026, month, 15, tzinfo=timezone.utc), "day")


@pytest.mark.parametrize("written", ["十月  15, 2026", "十月 15，2026", "十月15日, 2026", "十月 15 2026", "  十月 15, 2026  "])
def test_the_forms_around_the_name_are_tolerated(written):
    assert parse_date(written) == (datetime(2026, 10, 15, tzinfo=timezone.utc), "day")


@pytest.mark.parametrize("written", ["十月 15", "十三月 15, 2026", "十月 32, 2026", "十月 15, 20261", "零月 15, 2026"])
def test_a_form_that_is_not_a_date_is_not_guessed(written):
    # no year: the year is never supplied; "十三月" is not read as its last two characters
    assert parse_date(written) == (None, "day")


def test_the_forms_that_were_read_before_are_read_the_same():
    assert parse_date("2026年10月15日")[0] == datetime(2026, 10, 15, tzinfo=timezone.utc)
    assert parse_date("2026-10-15")[0] == datetime(2026, 10, 15, tzinfo=timezone.utc)
    assert parse_date("October 15, 2026", date_format="%B %d, %Y")[0] == datetime(2026, 10, 15, tzinfo=timezone.utc)


def test_清华大学医学院_cards_carry_their_dates():
    case, output = parsed("uni-tsinghua-med-research")
    assert validate_config(case.source) == []
    assert "十月" in case.results()[0].body.decode("utf-8")
    assert len(output.entries) == 10 and output.notes == []
    for entry in output.entries:
        assert entry.published_at == datetime(2026, 10, 15, tzinfo=timezone.utc) and entry.date_precision == "day"
        assert entry.url.startswith("https://www.med.tsinghua.edu.cn/info/") and entry.language == "zh"
        assert entry.summary and not entry.title.endswith("...")
