"""Publisher feeds for ``/text`` (``enrich.feeds``), on feeds recorded through the feed step on 2026-10-22.

``enrich/paper-feeds``: Clinical Infectious Diseases (OUP; advance articles and current issue), The BMJ (its
``/rss/recent.xml`` forwards to feeds.bmj.com), JAMA (online first), JAMA Network Open (new online), The Lancet (its
robots.txt disallows ``/rss``: recorded as refused) and Gastroenterology (the AGA's journal host).
"""

from __future__ import annotations

from replay import ReplayFetcher, load_case

from knowledge_plugin.enrich import feeds
from knowledge_plugin.enrich.common import Trace

CASE = "enrich/paper-feeds"
OUP_ADVANCE = "https://academic.oup.com/rss/site_5269/advanceAccess_3135.xml"
OUP_CURRENT = "https://academic.oup.com/rss/site_5269/3135.xml"
BMJ = "https://www.bmj.com/rss/recent.xml"
JAMA = "https://jamanetwork.com/rss/site_3/onlineFirst_67.xml"
JNO = "https://jamanetwork.com/rss/site_214/187.xml"
LANCET = "https://www.thelancet.com/rssfeed/lancet_online.xml"
GASTRO = "https://www.gastrojournal.org/current.rss"


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def row(*urls: str) -> dict:
    return {"source_id": "j-test", "source_egress": "direct",
            "source_config": {"abstract_feed": list(urls) if len(urls) > 1 else urls[0]}}


async def text_of(doi: str, *urls: str, cache=None, fetcher=None):
    fetcher = fetcher or ReplayFetcher(load_case(CASE))
    trace = Trace()
    found = await feeds.feed_text(fetcher, row(*urls), doi, trace, cache=cache or feeds.FeedCache())
    return found, trace, fetcher


async def test_oup_current_issue_carries_the_whole_structured_abstract():
    (kind, text), _, _ = await text_of("10.1093/cid/ciag500", OUP_CURRENT)
    assert kind == "abstract"
    sections = text.split("\n")
    assert sections[0].startswith("Background: Kenya has moved from fragmented, pilot-based antimicrobial resistance")
    assert [s.split(":")[0] for s in sections] == ["Background", "Methods", "Results", "Conclusions"]


async def test_oup_advance_keywords_are_not_a_text():
    found, trace, _ = await text_of("10.1093/cid/ciag502", OUP_ADVANCE)   # "anogenital cancerantiretroviral therapy…"
    assert found is None and trace.notes == ["feed_item_without_text"]
    (kind, text), _, _ = await text_of("10.1093/cid/ciag602", OUP_ADVANCE)
    assert kind == "abstract" and text.startswith("Disseminated nontuberculous mycobacterial disease")


async def test_jama_a_long_summary_is_an_abstract_a_sentence_an_excerpt():
    (kind, text), _, _ = await text_of("10.1001/jama.2026.20670", JAMA)
    assert kind == "abstract" and text.startswith("Reducing the opioid supply has been an important pillar") and len(text) == 586
    (kind, text), _, _ = await text_of("10.1001/jama.2026.18862", JAMA)
    assert kind == "excerpt" and text.startswith("This extended follow-up of a cohort study") and len(text) == 185


async def test_jama_network_open_a_subject_label_is_not_a_text():
    found, trace, _ = await text_of("10.1001/jamanetworkopen.2026.32903", JNO)          # "Global Health"
    assert found is None and trace.notes == ["feed_item_without_text"]


async def test_bmj_items_carry_no_doi_and_are_matched_by_the_link_s_last_segment():
    items = await feeds.read_feed(ReplayFetcher(load_case(CASE)), BMJ, source_id=None, egress="direct", trace=Trace(),
                                  cache=feeds.FeedCache())
    assert items and not any(item.dois for item in items)
    (kind, text), _, _ = await text_of("10.1136/bmj-2026-101219", BMJ)
    # BMJ's descriptions are the piece's opening, cut and ending "...": an excerpt.
    assert kind == "excerpt" and text.startswith("A new clinical trial has been launched in the UK")
    assert text.endswith("aims to...")


async def test_the_lancet_s_robots_txt_refuses_its_feeds_and_the_refusal_is_remembered():
    clock = Clock()
    cache = feeds.FeedCache(clock=clock)
    fetcher = ReplayFetcher(load_case(CASE))
    found, trace, _ = await text_of("10.1016/s0140-6736(26)01234-5", LANCET, cache=cache, fetcher=fetcher)
    assert found is None and trace.notes == ["feed_robots-denied:robots_disallow"]
    calls = len(fetcher.calls)
    found, _, _ = await text_of("10.1016/s0140-6736(26)01234-6", LANCET, cache=cache, fetcher=fetcher)
    assert found is None and len(fetcher.calls) == calls                    # not asked again within the failure TTL
    clock.now += feeds.FAILURE_TTL_S + 1
    await text_of("10.1016/s0140-6736(26)01234-6", LANCET, cache=cache, fetcher=fetcher)
    assert len(fetcher.calls) == calls + 1


async def test_a_feed_is_read_once_per_two_hours_whatever_number_of_entries_ask():
    clock = Clock()
    cache = feeds.FeedCache(clock=clock)
    fetcher = ReplayFetcher(load_case(CASE))
    for doi in ("10.1093/cid/ciag500", "10.1093/cid/ciag498", "10.1093/cid/ciag499"):
        found, _, _ = await text_of(doi, OUP_CURRENT, cache=cache, fetcher=fetcher)
        assert found is not None
    assert [url for _, url, _ in fetcher.calls] == [OUP_CURRENT] and cache.reads == 1
    clock.now += feeds.FEED_TTL_S - 1
    await text_of("10.1093/cid/ciag500", OUP_CURRENT, cache=cache, fetcher=fetcher)
    assert cache.reads == 1
    clock.now += 2
    await text_of("10.1093/cid/ciag500", OUP_CURRENT, cache=cache, fetcher=fetcher)
    assert cache.reads == 2


async def test_the_feeds_of_a_row_are_tried_in_order():
    (kind, _), _, fetcher = await text_of("10.1093/cid/ciag500", OUP_ADVANCE, OUP_CURRENT)
    assert kind == "abstract" and [url for _, url, _ in fetcher.calls] == [OUP_ADVANCE, OUP_CURRENT]


async def test_an_item_without_a_description_is_nothing():
    found, trace, _ = await text_of("10.1053/j.gastro.2026.10.375", GASTRO)            # a letter, no description
    assert found is None and trace.notes == ["feed_item_without_text"]


def test_a_doi_suffix_in_a_link_s_number_or_e_locator():
    items = [feeds.FeedItem(dois=frozenset(), tail="205800", text="x"), feeds.FeedItem(dois=frozenset(), tail="e101329", text="y"),
             feeds.FeedItem(dois=frozenset(), tail="e111942", text="z")]
    assert feeds.match(items, "10.1172/JCI205800").text == "x"                 # JCI: /articles/view/205800
    assert feeds.match(items, "10.2196/101329").text == "y"                    # JMIR: /2026/1/e101329
    assert feeds.match(items, "10.1136/bmjopen-2025-111942") is None           # BMJ Open's link number is not its suffix


def test_feed_urls_of_a_row():
    assert feeds.feed_urls({"abstract_feed": "https://a.example/rss"}) == ["https://a.example/rss"]
    assert feeds.feed_urls({"abstract_feed": ["https://a.example/1", "ftp://x", 3, "https://a.example/2"]}) == [
        "https://a.example/1", "https://a.example/2"]
    assert feeds.feed_urls({}) == [] and feeds.feed_urls(None) == []


def test_oup_box_titles_are_section_headings():
    text = feeds.item_text('<span class="paragraphSection"><div class="boxTitle">Abstract</div><div class="boxTitle">'
                           'Background</div>One. <div class="boxTitle">Methods</div>Two.</span>')
    assert text == "Background: One.\nMethods: Two."
