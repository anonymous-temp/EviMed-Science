"""The shared reader helpers: dates, markup, identifiers, notices and mastheads, URLs.

Inputs here are small literal strings in the shapes the upstreams were seen to use (each named);
the recorded answers themselves are exercised by the per-adapter tests.
"""

from __future__ import annotations

from datetime import datetime, timezone

from knowledge_plugin.adapters.common import (
    clean_markup,
    dig,
    host_allowed,
    is_masthead_title,
    is_notice_title,
    looks_truncated,
    make_entry,
    normalize_doi,
    parse_date,
    registry_ids,
    set_query_param,
    source_zone,
    strip_params,
    zone,
)
from knowledge_plugin.model import SUMMARY_MAX

UTC = timezone.utc
CHINA = zone("Asia/Shanghai")


def test_date_forms_the_upstreams_use():
    assert parse_date("Tue, 18 Aug 2026 05:00:00 GMT") == (datetime(2026, 8, 18, 5, tzinfo=UTC), "instant")  # RSS
    assert parse_date("2026-09-02T11:00:02+01:00") == (datetime(2026, 9, 2, 10, 0, 2, tzinfo=UTC), "instant")  # Atom
    assert parse_date("2026-09-21T16:00:00Z") == (datetime(2026, 9, 21, 16, tzinfo=UTC), "instant")  # WHO OData
    assert parse_date("20260909") == (datetime(2026, 9, 9, tzinfo=UTC), "day")  # openFDA
    assert parse_date("09/18/2026") == (datetime(2026, 9, 18, tzinfo=UTC), "day")  # openFDA shortages
    assert parse_date("09/18/2026", date_format="%m/%d/%Y") == (datetime(2026, 9, 18, tzinfo=UTC), "day")
    assert parse_date("2026/09/16") == (datetime(2026, 9, 16, tzinfo=UTC), "day")  # PubMed
    assert parse_date("2026年9月20日") == (datetime(2026, 9, 20, tzinfo=UTC), "day")
    assert parse_date("[2026-09-20]") == (datetime(2026, 9, 20, tzinfo=UTC), "day")
    assert parse_date("") == (None, "day") and parse_date(None) == (None, "day") and parse_date("n/a") == (None, "day")


def test_naive_times_take_the_source_zone():
    assert parse_date("2026-09-22 13:31", naive_zone=CHINA) == (datetime(2026, 9, 22, 5, 31, tzinfo=UTC), "instant")
    assert parse_date("2026/9/22 8:45:39", naive_zone=CHINA) == (datetime(2026, 9, 22, 0, 45, 39, tzinfo=UTC), "instant")
    assert parse_date("2026-09-22T13:31:00+08:00", naive_zone=UTC)[0] == datetime(2026, 9, 22, 5, 31, tzinfo=UTC)
    assert source_zone({}, "CN") == CHINA
    assert source_zone({"timezone": "Asia/Tokyo"}, "CN") == zone("Asia/Tokyo")
    assert source_zone({}, "US") is UTC  # a zone is only assumed where the registry's region says so


def test_markup_cleaning():
    assert clean_markup("<p>A &amp; B</p><p>C</p>") == "A & B C"
    assert clean_markup("<jats:p>Background</jats:p><jats:p>Methods</jats:p>", keep_paragraphs=True) == "Background\nMethods"
    assert clean_markup("&lt;b&gt;bold&lt;/b&gt; text") == "bold text"
    assert clean_markup("P<0.05 and IL-6<IL-8") == "P<0.05 and IL-6<IL-8"  # prose '<' is not markup
    assert clean_markup(None) == ""


def test_notice_and_masthead_titles_are_closed_forms():
    for title in ("Correction to: Something", "Author Correction: X", "Erratum", "Retraction Note: Y",
                  "Expression of Concern: Z", "Corrigendum to “Kidney injury …”", "RETRACTION: Long Noncoding RNA",
                  "Notice of Retraction"):
        assert is_notice_title(title), title
    for title in ("Correction of Hyponatremia in Adults", "Retractions and research integrity in oncology",
                  "Erratic sleep and dementia"):
        assert not is_notice_title(title), title
    for title in ("Editorial Board", "Table of Contents", "Issue Information", "In this issue", "Cover Image"):
        assert is_masthead_title(title), title
    assert not is_masthead_title("Editorial Board diversity in cardiology journals")  # whole titles only


def test_identifiers():
    assert normalize_doi("https://doi.org/10.1056/NEJMoa2605659") == "10.1056/nejmoa2605659"
    assert normalize_doi("doi:10.13748/j.cnki.issn1007-7693.2026-16") == "10.13748/j.cnki.issn1007-7693.2026-16"
    assert normalize_doi("Science. 2026 Sep 17;393(6817):eaec6129. doi: 10.1126/science.aec6129. Epub") == \
        "10.1126/science.aec6129"
    assert normalize_doi("10.1016/S0140-6736(26)01234-5") == "10.1016/s0140-6736(26)01234-5"
    assert normalize_doi("no doi here") is None
    assert registry_ids("ClinicalTrials.gov number, NCT03643276; ChiCTR2400081234 and PREPARE-2024CN159") == \
        ["NCT03643276", "ChiCTR2400081234", "PREPARE-2024CN159"]


def test_url_helpers():
    url = "https://api.crossref.org/works?filter=a:b&rows=20&cursor=*"
    assert set_query_param(url, "cursor", "AoJ+/x=") == "https://api.crossref.org/works?filter=a:b&rows=20&cursor=AoJ%2B%2Fx%3D"
    assert set_query_param(url, "rows", None) == "https://api.crossref.org/works?filter=a:b&cursor=*"
    assert strip_params("https://www.medrxiv.org/content/10.64898/x.y.zv1?rss=1", ["rss"]) == \
        "https://www.medrxiv.org/content/10.64898/x.y.zv1"
    assert host_allowed("https://news.sciencenet.cn/a", ["sciencenet.cn"])
    assert not host_allowed("https://evil.example/a", ["sciencenet.cn"])
    assert dig({"aU": '{"common": "/jbkzzx/x.html"}'}, "aU.common") == "/jbkzzx/x.html"


def test_entry_defects_from_the_summary():
    long = "x" * (SUMMARY_MAX + 50)
    entry = make_entry(external_key="k", url="https://e.org", title="T", summary=long)
    assert len(entry.summary) <= SUMMARY_MAX and entry.defects == ["oversize-truncated"]
    cut = make_entry(external_key="k", url="https://e.org", title="T", summary="A sentence that stops…", feed_summary=True)
    assert cut.defects == ["truncated-summary"]
    none = make_entry(external_key="k", url="https://e.org", title="T")
    assert none.defects == ["no-summary"] and none.date_precision == "instant"
    assert looks_truncated("… continue reading") and not looks_truncated("A complete sentence.")
