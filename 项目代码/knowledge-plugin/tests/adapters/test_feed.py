"""rss / atom against recorded feeds (2026-09-22) and the plan's feed traps.

Undated feeds (中国药学杂志 served as text/html; 中国现代应用药学 RSS 1.0 with empty dates), a stale
feed with an oversize item (fharrell.com: newest item 2026-08-18, one item 423,503 characters),
naive China-time stamps (科学网 ``2026-09-22 13:31``), publisher-cut summaries (GOV.UK "…"),
double-escaped HTML, feed-tracking query tags, summaries equal to the title, arXiv versions.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from knowledge_plugin.adapters import REGISTRY
from knowledge_plugin.model import SUMMARY_MAX
from replay import load_case


def parsed(name):
    case = load_case(name)
    return case, REGISTRY[case.source.access].parse(case.results()[0], case.source, case.now)


def test_undated_feed_served_as_html_still_parses():
    case, output = parsed("rss/zgyxzz-undated")
    assert case.results()[0].headers["content-type"].startswith("text/html")
    assert len(output.entries) == 12 and "feed_bozo" in output.notes
    assert all(e.published_at is None for e in output.entries)  # the core stamps the first sighting, 'inferred'
    assert all(e.language == "zh" for e in output.entries)
    first = output.entries[0]
    assert first.title == "基于光动力疗法消融肿瘤的无机纳米材料研究进展"
    assert first.url == "http://journal11.magtechjournal.com/Jwk34_zgyxzz/CN/abstract/abstract33785.shtml"


def test_double_escaped_rss1_with_dois_and_no_dates():
    _, output = parsed("rss/chinjmap-double-escaped")
    assert len(output.entries) == 15
    first = output.entries[0]
    assert first.doi == "10.13748/j.cnki.issn1007-7693.2026-16"
    assert first.facts == {"journal": "中国现代应用药学"}
    assert first.published_at is None
    assert first.summary.startswith("藏医药是中华医药宝库的重要组成部分")
    for entry in output.entries:
        assert "&lt;" not in entry.summary and "<p" not in entry.summary and "</" not in entry.summary


def test_stale_feed_with_oversize_items():
    case, output = parsed("rss/harrell-stale-oversize")
    assert len(output.entries) == 20
    newest = max(e.published_at for e in output.entries)
    assert newest == datetime(2026, 8, 18, 5, 0, tzinfo=timezone.utc)
    assert case.now - newest > timedelta(days=30)  # 200 and items, yet stale: health reads new-entry time, not status
    oversize = [e for e in output.entries if "oversize-truncated" in e.defects]
    assert len(oversize) == 5
    assert all(len(e.summary) <= SUMMARY_MAX for e in output.entries)


def test_naive_china_time_is_not_read_as_utc():
    case, output = parsed("rss/sciencenet-naive-local-time")
    assert "<pubDate>2026-09-22 13:31</pubDate>" in case.results()[0].body.decode("utf-8")
    first = output.entries[0]
    assert first.published_at == datetime(2026, 9, 22, 5, 31, tzinfo=timezone.utc)
    assert all(e.published_at <= case.now for e in output.entries)  # read as UTC they would be 8 h in the future


def test_gov_uk_atom_cut_summaries_are_flagged():
    _, output = parsed("atom/mhra-drug-safety-update")
    assert len(output.entries) == 50
    cut = [e for e in output.entries if "truncated-summary" in e.defects]
    assert len(cut) == 31
    assert all(e.summary.endswith("…") for e in cut)
    first = output.entries[0]
    assert first.published_at == datetime(2026, 9, 2, 10, 0, 2, tzinfo=timezone.utc)  # <updated> +01:00, no <published>
    assert first.external_key.startswith("tag:www.gov.uk,2005:/drug-safety-update/")


def test_medrxiv_feed_links_lose_the_rss_tag_and_carry_the_doi():
    _, output = parsed("rss/medrxiv-epidemiology")
    assert len(output.entries) == 30
    first = output.entries[0]
    assert first.url == "https://www.medrxiv.org/content/10.64898/2026.09.18.26363440v1"
    assert first.external_key.endswith("?rss=1")  # the source's own id, unchanged
    assert first.doi == "10.64898/2026.09.18.26363440"
    assert first.published_at == datetime(2026, 9, 21, tzinfo=timezone.utc) and first.date_precision == "day"


def test_summary_equal_to_title_is_no_summary():
    _, output = parsed("rss/ema-new-human-medicines")
    assert len(output.entries) == 12
    assert all(e.summary is None and e.defects == ["no-summary"] for e in output.entries)


def test_arxiv_versions_share_one_entry_and_get_the_datacite_doi():
    _, output = parsed("atom/arxiv-qbio-qm")
    assert len(output.entries) == 100
    first = output.entries[0]
    assert first.external_key == "arxiv:2609.24666" and first.url == "https://arxiv.org/abs/2609.24666"
    assert first.doi == "10.48550/arxiv.2609.24666"
    assert first.published_at == datetime(2026, 9, 21, 14, 30, 6, tzinfo=timezone.utc)
    assert all("v" not in e.external_key.split(":")[-1] for e in output.entries)


def test_feed_plans_are_conditional_page_requests():
    case = load_case("rss/cdc-eid-ahead-of-print")
    (planned,) = REGISTRY["rss"].plan(case.source, case.state, case.now)
    assert planned.url == "https://wwwnc.cdc.gov/eid/rss/ahead-of-print.xml"
    assert planned.conditional is True and planned.api is False  # robots.txt applies to website feeds
    _, output = parsed("rss/cdc-eid-ahead-of-print")
    assert len(output.entries) == 35
