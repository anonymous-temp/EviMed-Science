"""html-list against recorded list pages (2026-09-22) with the selector blocks of P2-selectors.json.

The three page shapes: markup lists (中国政府网, 药品不良反应监测中心, EMA, PubMed trending, 科学网),
the Hanweb CMS list hidden in ``<script type="text/xml">`` CDATA records (国家医保局), and a JS
array literal rendered client-side (国家疾控局). Selectors are data; a page they no longer match
parses to zero entries with a note (the core's drift signal), never an exception.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone

from knowledge_plugin.adapters import REGISTRY
from replay import load_case

ADAPTER = REGISTRY["html-list"]


def parsed(name, source=None):
    case = load_case(f"html-list/{name}")
    return case, ADAPTER.parse(case.results()[0], source or case.source, case.now)


def day(y, m, d):
    return datetime(y, m, d, tzinfo=timezone.utc)


def test_nhsa_list_lives_in_script_cdata_records():
    case, output = parsed("nhsa-notices")
    body = case.results()[0].body.decode("utf-8")
    assert '<script type="text/xml">' in body and "<![CDATA[" in body
    assert case.source.config["mode"] == "script-cdata"
    assert len(output.entries) == 40 and output.notes == []
    first = output.entries[0]
    assert first.title == "2026全球脑机接口×医保创新场景大赛决赛入围项目名单"
    assert first.url == "http://www.nhsa.gov.cn/art/2026/9/20/art_109_22286.html"
    assert first.published_at == day(2026, 9, 20) and first.date_precision == "day"
    assert first.language == "zh"


def test_nhsa_titles_come_from_the_title_attribute_not_the_cut_text():
    _, output = parsed("nhsa-consultations")
    long_title = next(e for e in output.entries if e.url.endswith("art_113_21166.html"))
    assert long_title.title.endswith("（征求意见稿）》意见") and "..." not in long_title.title
    _, interpretation = parsed("nhsa-policy-interpretation")
    assert interpretation.entries[0].published_at == day(2026, 9, 18)


def test_nhsa_index_numbers_are_not_read_as_dates():
    # every row starts with an index such as "2026-04-00088"; the date is the last cell
    _, output = parsed("nhsa-notices")
    assert all(e.published_at.day != 0 for e in output.entries)
    assert output.entries[-1].published_at == day(2026, 5, 31)


def test_gov_cn_latest_policies_block():
    _, output = parsed("gov-cn-policy")
    assert len(output.entries) == 8
    assert output.entries[0].url == "https://www.gov.cn/zhengce/202609/content_7081587.htm"  # "./202609/…" resolved
    assert output.entries[0].published_at == day(2026, 9, 20)


def test_cdr_safety_column_keeps_the_nmpa_announcements():
    case, output = parsed("cdr-adr-safety-warnings")
    hosts = {e.url.split("/")[2] for e in output.entries}
    assert hosts == {"www.cdr-adr.org.cn", "www.nmpa.gov.cn"}
    first = output.entries[0]
    assert first.title == "国家药监局关于修订肌苷注射剂说明书的公告（2026年第87号）"
    assert first.published_at == day(2026, 9, 9)
    own_host_only = replace(case.source, config={**case.source.config, "link_hosts": None})
    _, narrowed = parsed("cdr-adr-safety-warnings", own_host_only)
    assert len(narrowed.entries) == 10 and narrowed.notes == ["html_list_dropped_host=10"]


def test_ema_prac_documents_are_dated_by_first_publication():
    case, output = parsed("ema-prac-safety-signals")
    assert len(case.results()[0].body) > 2_000_000  # the whole signal history on one page
    assert len(output.entries) == 20  # max_items: the latest meetings only
    first = output.entries[0]
    assert first.title == "PRAC recommendations on signals adopted at the 6-9 July 2026 PRAC meeting"
    assert first.url.endswith("/prac-recommendations-signals-adopted-6-9-july-2026-prac-meeting_en.pdf")
    assert first.published_at == datetime(2026, 8, 3, 11, 0, tzinfo=timezone.utc) and first.date_precision == "instant"


def test_pubmed_trending_gives_pmids_and_dois_without_dates():
    _, output = parsed("pubmed-trending")
    assert len(output.entries) == 10
    first = output.entries[0]
    assert first.pmid == "42752131" and first.doi == "10.1126/science.aec6129"
    assert all(e.published_at is None for e in output.entries)  # a ranking, not a dated list: dates are inferred


def test_ndcpa_list_is_a_js_array_with_json_inside_strings():
    case, output = parsed("ndcpa-notices")
    assert "var itemObj = [" in case.results()[0].body.decode("utf-8")
    assert len(output.entries) == 30
    first = output.entries[0]
    assert first.external_key == "2101473343535747072"
    assert first.url == "https://www.ndcpa.gov.cn/jbkzzx/c100014/common/content/content_2101473343535747072.html"
    assert first.published_at == datetime(2026, 9, 22, 2, 0, tzinfo=timezone.utc)  # "2026-09-22 10:00", China time
    _, epidemic = parsed("ndcpa-epidemic-info")
    assert epidemic.entries[0].title == "2025年全国法定传染病疫情概况"


def test_sciencenet_table_rows_with_naive_times():
    _, output = parsed("sciencenet-topnews")
    assert len(output.entries) == 28 and output.notes == ["html_list_dropped_host=2"]
    first = output.entries[0]
    assert first.title == "陈立泉：不怕输，也绝不能服输"
    assert first.published_at == datetime(2026, 9, 22, 0, 45, 39, tzinfo=timezone.utc)  # 2026/9/22 8:45:39 China time


def test_selectors_that_match_nothing_are_a_drift_signal_not_an_error():
    case = load_case("html-list/gov-cn-policy")
    drifted = replace(case.source, config={**case.source.config,
                                           "selectors": {**case.source.config["selectors"], "item": "div.redesigned li"}})
    output = ADAPTER.parse(case.results()[0], drifted, case.now)
    assert output.entries == [] and output.notes == ["html_list_no_items"]


def test_plan_is_a_conditional_page_request_and_config_is_validated():
    case = load_case("html-list/gov-cn-policy")
    (planned,) = ADAPTER.plan(case.source, case.state, case.now)
    assert planned.url == "https://www.gov.cn/zhengce/" and planned.api is False and planned.conditional is True
    assert ADAPTER.validate_config(case.source) == []
    missing = replace(case.source, config={"url": "https://www.gov.cn/zhengce/", "allowed_hosts": ["www.gov.cn"]})
    assert "selectors.item missing" in ADAPTER.validate_config(missing)
