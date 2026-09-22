"""html-list, batch 2 (SPEC G(4)): P1-tier Chinese societies, regulators and media with clean lists.

Recorded 2026-09-22 with the selector blocks of ``P2-selectors.json`` through ``record.py`` (the
adapter's own plan, the honest User-Agent, robots.txt honoured). Each page is one list; the reader
is the same html-list parser as the P0 lists.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from urllib.parse import urlsplit

import pytest

from knowledge_plugin.adapters import REGISTRY, validate_config
from replay import load_case

ADAPTER = REGISTRY["html-list"]
LISTS = {  # case -> entries on the recorded page
    "natcm-notices": 25,
    "most-tztg": 20,
    "nmpa-gd-mirror": 20,
    "csco-news": 11,
    "gd-pharm-society-notifications": 10,
    "cntcm-news": 40,
    "nhsa-policy-regulations": 40,
    "cdr-adr-notices": 20,
    "zhongguokexuebao": 30,
    "chinacdc-notifiable-disease": 12,
    "china-cdc-news": 12,
}
_TRAILING_DATE = re.compile(r"20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?\s*$")


def parsed(name):
    case = load_case(f"html-list/{name}")
    return case, ADAPTER.parse(case.results()[0], case.source, case.now)


@pytest.mark.parametrize("name", sorted(LISTS))
def test_batch2_lists_parse(name):
    case, output = parsed(name)
    assert validate_config(case.source) == []
    assert len(output.entries) == LISTS[name]
    assert output.notes == (["html_list_dropped_host=4"] if name == "csco-news" else [])
    hosts = set(case.source.config.get("link_hosts") or case.source.config["allowed_hosts"])
    for entry in output.entries:
        assert urlsplit(entry.url).hostname in hosts
        assert entry.title and not _TRAILING_DATE.search(entry.title) and entry.language == "zh"
        assert entry.published_at is not None and entry.published_at <= case.now
    assert len({e.external_key for e in output.entries}) == len(output.entries)


def test_a_date_inside_the_title_link_is_not_part_of_the_title():
    _, output = parsed("chinacdc-notifiable-disease")
    first = output.entries[0]
    assert first.title == "2026年8月全国传染病疫情概况"  # the link text ends with "<span>2026-09-10 </span>"
    assert first.published_at == datetime(2026, 9, 10, tzinfo=timezone.utc)
    assert first.summary.startswith("2026年8月（8月1日0时至31日24时），全国共报告法定传染病")


def test_beijing_times_become_utc_instants():
    _, society = parsed("gd-pharm-society-notifications")
    assert society.entries[0].published_at == datetime(2026, 9, 18, 2, 27, 55, tzinfo=timezone.utc)  # 10:27:55 +08:00
    assert society.entries[0].date_precision == "instant" and society.entries[0].summary
    _, science = parsed("zhongguokexuebao")
    assert science.entries[0].published_at == datetime(2026, 9, 22, 11, 0, 35, tzinfo=timezone.utc)  # 2026/9/22 19:00:35


def test_society_posts_on_wechat_are_left_to_the_wechat_lane():
    case, output = parsed("csco-news")
    body = case.results()[0].body.decode("utf-8")
    assert body.count("https://mp.weixin.qq.com/s/") == 4  # dropped by the host rule, counted in the note
    assert all(urlsplit(e.url).hostname == "www.csco.org.cn" for e in output.entries)


def test_the_adr_centre_notices_list_nmpa_pages_too():
    case, output = parsed("cdr-adr-notices")
    assert case.source.config["link_hosts"] == ["www.cdr-adr.org.cn", "www.nmpa.gov.cn"]
    assert any(urlsplit(e.url).hostname == "www.nmpa.gov.cn" for e in output.entries)
