"""browser-list: the Ruishu-protected regulator lists, rendered by the plugin's browser egress.

Recorded 2026-09-22 through ``knowledge_plugin.fetch.ProtectedFetcher`` with the browser egress
(``tests/fixtures/record.py``: robots.txt read through the browser, the list selector awaited, the
production outcome rules) against a local Chrome for Testing 145 with the honest ``EviMedBot/1.0``
suffix. The body of each fixture is the rendered DOM the browser handed over; the parser is the
html-list reader with the row's selector block from ``P2-selectors.json``.

One exception: 药审中心 refused this box (a 403 WAF page) from about 11:13Z on, so its
breakthrough-therapy fixture is the page P1's render helper (the same ``BrowserFetcher.render``)
saved at 11:11:15Z; its provenance lists every later refused attempt.
"""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timezone
from urllib.parse import urlsplit

import pytest

from knowledge_plugin.adapters import REGISTRY, validate_config
from knowledge_plugin.adapters.html_list import HtmlListAdapter, list_entries
from knowledge_plugin.enrich.evimed import drug_mentions
from knowledge_plugin.fetch import detect_challenge
from knowledge_plugin.model import FetchError, SourceConfig
from replay import FIXTURES, load_case

ADAPTER = REGISTRY["browser-list"]
RENDERED = {  # case -> items on the page as rendered on 2026-09-22
    "nmpa-ggtg": 20,
    "nmpa-label-revision-announcements": 20,
    "nmpa-other-drug-announcements": 20,
    "nmpa-innovative-approvals": 14,
    "cde-breakthrough-therapy": 10,
    "cmde-guidance": 20,
    "nhc-policy-documents": 24,
}


def parsed(name):
    case = load_case(f"browser-list/{name}")
    (result,) = case.results()
    return case, result, ADAPTER.parse(result, case.source, case.now)


def test_browser_list_is_the_html_list_reader_behind_the_browser_egress():
    assert isinstance(ADAPTER, HtmlListAdapter) and ADAPTER.access == "browser-list"
    case = load_case("browser-list/nmpa-ggtg")
    assert (case.source.access, case.source.egress) == ("browser-list", "browser")
    (planned,) = ADAPTER.plan(case.source, case.state, case.now)
    assert (planned.url, planned.method, planned.api, planned.conditional) == (case.source.config["url"], "GET", False, True)


def test_every_rendered_case_was_found():
    recorded = {p.parent.name for p in (FIXTURES / "browser-list").glob("*/provenance.json")}
    assert recorded >= set(RENDERED)  # a broken walk must not pass empty


@pytest.mark.parametrize("name", sorted(RENDERED))
def test_rendered_regulator_lists_parse(name):
    case, result, output = parsed(name)
    meta = case.exchanges[0].meta
    assert meta["egress"] == "browser" and meta["render"] == "dom" and meta["user_agent"].endswith(
        "EviMedBot/1.0 (+https://www.evimed.com; knowledge-source monitor)")
    if name == "cde-breakthrough-therapy":  # the helper's render (module docstring)
        provenance = json.loads((FIXTURES / "browser-list" / name / "provenance.json").read_text(encoding="utf-8"))
        assert "knowledge_plugin.browser render" in provenance["note"] and meta["wait_for"] is None
        assert {a["status"] for a in provenance["later_attempts"]} == {403}
    else:
        assert meta["wait_for"] and "@" not in meta["wait_for"]  # the scheduler's rule: the item selector
    assert result.status == 200 and result.headers["content-type"] == "text/html; charset=utf-8"
    if name != "cde-breakthrough-therapy":  # passed the plugin's own fetcher when recorded
        assert detect_challenge(result.status, result.headers["content-type"], result.body, api=False) is None
    # 药审中心's rendered DOM keeps Ruishu's inline script, which the fetcher's marker rule still
    # reads as a challenge after the page passed: reported to the core (P2.log 2026-09-22T11:38:02Z)
    assert validate_config(case.source) == []
    assert len(output.entries) == RENDERED[name] and output.notes == []
    hosts = set(case.source.config["allowed_hosts"])
    recorded_day = case.now.date()
    for entry in output.entries:
        assert urlsplit(entry.url).hostname in hosts and entry.url.startswith("https://")
        assert entry.title and entry.language == "zh" and entry.date_precision == "day"
        assert entry.published_at is not None and entry.published_at.date() <= recorded_day
    assert len({e.external_key for e in output.entries}) == len(output.entries)


def test_nmpa_relative_links_resolve_against_the_page():
    _, _, output = parsed("nmpa-label-revision-announcements")
    (first, *_) = output.entries
    assert first.url == "https://www.nmpa.gov.cn/xxgk/ggtg/ypggtg/ypshmshxdgg/20260904163246192.html"  # ../../../../xxgk/…
    assert first.title == "国家药监局关于修订肌苷注射剂说明书的公告（2026年第87号）"
    assert first.published_at == datetime(2026, 9, 4, tzinfo=timezone.utc)
    # the column's titles are the closed form the /text drug-label lookup reads
    named = [drug_mentions(e.title, "regulator") for e in output.entries]
    assert named[0] == ["肌苷注射剂"] and sum(1 for n in named if n) >= 15


def test_other_drug_announcements_read_the_drug_column_list():
    case, _, output = parsed("nmpa-other-drug-announcements")
    assert case.source.config["url"] == "https://www.nmpa.gov.cn/yaopin/ypggtg/index.html"  # the registry URL is a 404
    paths = [urlsplit(e.url).path for e in output.entries]
    assert all(p.startswith("/xxgk/ggtg/ypggtg/") for p in paths)
    assert sum(1 for p in paths if p.startswith("/xxgk/ggtg/ypggtg/ypqtggtg/")) >= 10  # 其他公告通告


def test_nhc_documents_include_the_guideline_notices():
    case, _, output = parsed("nhc-policy-documents")
    assert case.source.config["url"] == "https://www.nhc.gov.cn/wjw/gfxwjj/list.shtml"  # not the portal home
    titles = [e.title for e in output.entries]
    assert "国家卫生健康委办公厅关于印发孤独症谱系障碍儿童干预康复指南（2026年版）的通知" in titles
    assert all(e.url.startswith("https://www.nhc.gov.cn/") for e in output.entries)  # root-relative links


def test_cde_table_rows_get_a_derived_link_that_tells_them_apart():
    case, _, output = parsed("cde-breakthrough-therapy")
    entries = output.entries
    assert all(e.defects == ["link-derived"] for e in entries)
    sys6010 = [e for e in entries if "（CXSL2300094）" in e.title]
    assert len(sys6010) == 2 and len({e.external_key for e in sys6010}) == 2  # one inclusion per indication
    first = entries[0]
    assert first.title == "纳入突破性治疗品种名单：注射用BL-B01D1（CXSL2400144）"
    assert first.summary == "注册申请人：成都百利多特生物药业有限责任公司;四川百利药业有限责任公司"
    assert first.url == first.external_key == (
        "https://www.cde.org.cn/main/xxgk/listpage/da6efd086c099b7fc949121166f0130c?acceptid=CXSL2400144&date=2026-09-20")
    assert first.published_at == datetime(2026, 9, 20, tzinfo=timezone.utc)  # 公示截止日期, not 申请日期


def test_the_cde_guidance_list_refused_a_real_browser():
    case = load_case("browser-list/cde-guidance-principles-refused")
    (exchange,) = case.exchanges
    assert exchange.meta["status"] == 403 and exchange.meta["error"] == {"outcome": "blocked", "detail": "http_403"}
    page = (FIXTURES / "browser-list/cde-guidance-principles-refused" / exchange.meta["file"]).read_text(encoding="utf-8")
    assert "请不要使用非法的URL地址访问" in page  # a WAF page, not a Ruishu script page
    provenance = json.loads((FIXTURES / "browser-list/cde-guidance-principles-refused/provenance.json").read_text(encoding="utf-8"))
    assert [r["status"] for r in provenance["robots"]] == [403]  # robots.txt refused too: 4xx = no rules, the page was asked
    assert case.results() == []


def test_a_list_that_is_not_there_is_drift_not_an_error():
    case, result, _ = parsed("nmpa-ggtg")
    wrong = replace(case.source, config={**case.source.config, "selectors": {"item": "ul.zxxx_list li", "title": "a@title",
                                                                          "link": "a@href", "date": "span.ml"}})
    output = ADAPTER.parse(result, wrong, case.now)
    assert output.entries == [] and output.notes == ["html_list_no_items"]
    with pytest.raises(FetchError) as refused:
        ADAPTER.parse(replace(result, status=403), case.source, case.now)
    assert refused.value.outcome == "http-error"


def _row(config):
    return SourceConfig(id="t", name="t", homepage=None, lane="regulatory", source_type="regulator", access="browser-list",
                        egress="browser", authority=4, safety_feed=False, owner_entity=None, launch_tier="P1",
                        language="zh", region="CN", poll_floor_s=7200, poll_ceiling_s=21600,
                        config={"url": "https://www.cde.org.cn/list", "allowed_hosts": ["www.cde.org.cn"], **config})


def test_templates_fall_back_and_encode():
    page = ("<table><tbody><tr><td>CXSL1</td><td>药 A</td><td>甲公司</td><td>2026-09-20</td></tr>"
            "<tr><td></td><td>药 B</td><td></td><td>2026-09-19</td></tr></tbody></table>")
    source = _row({"selectors": {"item": "tr", "id": "td:nth-child(1)", "title": "td:nth-child(2)",
                                 "summary": "td:nth-child(3)", "date": "td:nth-child(4)"},
                   "link_template": "https://www.cde.org.cn/list?acceptid={id}&name={title}",
                   "title_template": "纳入：{title}（{id}）", "summary_template": "注册申请人：{summary}",
                   "min_title_chars": 2})
    entries, notes = list_entries(page, source=source, base="https://www.cde.org.cn/list")
    assert [e.title for e in entries] == ["纳入：药 A（CXSL1）"]
    assert entries[0].url == "https://www.cde.org.cn/list?acceptid=CXSL1&name=%E8%8D%AF%20A"  # percent-encoded
    assert entries[0].summary == "注册申请人：甲公司"
    assert notes == ["html_list_dropped_link=1"]  # no id -> no link -> dropped, never a shared link


def test_link_template_replaces_the_link_selector_in_validation():
    table = _row({"selectors": {"item": "tr", "title": "td"}, "link_template": "https://www.cde.org.cn/list?acceptid={id}"})
    assert validate_config(table) == []
    constant = _row({"selectors": {"item": "tr", "title": "td"}, "link_template": "https://www.cde.org.cn/list"})
    assert any("every row would share one link" in p for p in validate_config(constant))
    assert any("selectors.link" in p for p in validate_config(_row({"selectors": {"item": "tr", "title": "td"}})))
