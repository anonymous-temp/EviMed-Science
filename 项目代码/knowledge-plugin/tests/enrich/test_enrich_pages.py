"""``/text`` for news, regulator and list entries: the page excerpt and its failure classes.

Recorded pages (2026-09-22): a who.int news item (Sitefinity), a gov.cn policy page (TRS CMS) and an
NMPA announcement that answers a Ruishu script page (HTTP 412) — classified by the plugin's own
``fetch.detect_challenge`` when it was recorded. Fetcher doubles that raise are used only for the
transport failure classes; they stand for no upstream answer.
"""

from __future__ import annotations

from datetime import datetime, timezone

from knowledge_plugin.enrich import enrich, enrich_batch, kind_of
from knowledge_plugin.enrich.common import Endpoints
from knowledge_plugin.enrich.page import EXCERPT_MAX, extract_main_text, page_excerpt
from knowledge_plugin.enrich.common import Trace
from knowledge_plugin.model import FetchError, FetchResult, RequestSpec
from knowledge_plugin.settings import Settings
from replay import ReplayFetcher, load_case


NOW = datetime(2026, 9, 22, 9, 35, tzinfo=timezone.utc)  # when these pages were recorded


class RefusingFetcher:
    """Any request is a test failure: the code under test must not fetch."""

    async def fetch(self, spec, **_):
        raise AssertionError(f"unexpected request {spec.url}")


class FailingFetcher:
    def __init__(self, outcome: str, detail: str) -> None:
        self.error = FetchError(outcome, detail)
        self.calls = []

    async def fetch(self, spec, **kwargs):
        self.calls.append((spec, kwargs))
        raise self.error


def entry_row(case_name: str, index: int = 0) -> dict:
    """A store-shaped row for the ``index``-th entry an adapter parsed from a recorded case."""
    from knowledge_plugin.adapters import REGISTRY

    case = load_case(case_name)
    entries = [e for r in case.results() for e in REGISTRY[case.source.access].parse(r, case.source, case.now).entries]
    entry = entries[index]
    source = case.provenance["source"]
    return {"entry_id": f"{source['id']}:x", "revision": 1, "source_id": source["id"], "external_key": entry.external_key,
            "identity_key": entry.identity_hint, "url": entry.url, "canonical_url": entry.url, "doi": entry.doi,
            "pmid": entry.pmid, "registry_ids": entry.registry_ids, "title": entry.title, "summary": entry.summary,
            "lang": entry.language, "published_at": entry.published_at, "facts": entry.facts,
            "first_seen_at": case.now, "source_access": source["access"], "source_egress": source["egress"],
            "source_type": source["source_type"], "source_config": source["config"], "attempts": 0}


async def test_who_news_page_excerpt_is_the_article_body():
    case = load_case("enrich/page-who-news")
    fetcher = ReplayFetcher(case)
    result = await enrich(case.rows[0], fetcher, None, now=NOW)
    assert kind_of(case.rows[0]) == "page"
    ((method, url, source_id),) = fetcher.calls
    assert url == case.rows[0]["url"] and source_id == "who-news-api"
    assert case.exchanges[0].spec.api is False  # a page request: robots.txt applies
    assert (result.status, result.text_kind, result.fetched_from) == ("available", "excerpt", "page")
    assert result.fetched_at == datetime(2026, 9, 22, 9, 34, 59, tzinfo=timezone.utc)
    assert result.body_excerpt.startswith("New Delhi, India, 13 September 2026 – Health featured prominently")
    assert "Related" not in result.body_excerpt and "©" not in result.body_excerpt  # the frame is not the text


async def test_gov_cn_excerpt_skips_the_toolbar_and_editor_line():
    case = load_case("enrich/page-gov-cn")
    result = await enrich(case.rows[0], ReplayFetcher(case), None, now=NOW)
    assert result.status == "available" and result.text_kind == "excerpt"
    assert result.body_excerpt.startswith("新华社北京9月20日电 近日，中共中央办公厅、国务院办公厅印发")
    for chrome in ("字号", "打印", "责任编辑", "我要纠错"):
        assert chrome not in result.body_excerpt


async def test_a_challenge_page_is_final_not_retried():
    case = load_case("enrich/page-nmpa-challenge")
    assert case.exchanges[0].meta["status"] == 412 and case.exchanges[0].error.outcome == "challenge"
    result = await enrich(case.rows[0], ReplayFetcher(case), None, now=NOW)
    assert (result.status, result.text_kind, result.body_excerpt) == ("unavailable", "none", None)
    assert result.notes == ["page_challenge:ruishu"]


async def test_transient_failures_leave_the_entry_pending():
    row = load_case("enrich/page-who-news").rows[0]
    for outcome, detail in (("timeout", "timeout"), ("http-error", "http_503"), ("host-budget", "daily_cap")):
        result = await enrich(row, FailingFetcher(outcome, detail), None, now=NOW)
        assert result.status == "pending" and result.retry_after_s == 3600, outcome
    for outcome, detail in (("robots-denied", "robots_disallow"), ("blocked", "http_403")):
        assert (await enrich(row, FailingFetcher(outcome, detail), None, now=NOW)).status == "unavailable", outcome


async def test_full_feed_text_needs_no_request():
    row = entry_row("rss/harrell-stale-oversize", 2)
    assert len(row["summary"]) > EXCERPT_MAX and kind_of(row) == "page"
    result = await enrich(row, RefusingFetcher(), None, now=NOW)
    assert result.status == "available" and result.text_kind == "excerpt"
    assert len(result.body_excerpt) <= EXCERPT_MAX and row["summary"].startswith(result.body_excerpt[:200])


async def test_record_entries_fetch_nothing():
    row = entry_row("json-api/openfda-enforcement")
    assert kind_of(row) == "record"
    result = await enrich(row, RefusingFetcher(), None, now=NOW)
    assert result.status == "unavailable" and result.notes == ["record_is_the_text"]


async def test_batch_mixes_kinds_in_order():
    rows = [entry_row("json-api/openfda-shortages"), load_case("enrich/page-gov-cn").rows[0]]
    results = await enrich_batch(rows, ReplayFetcher(load_case("enrich/page-gov-cn")), None, now=NOW)
    assert [r.status for r in results] == ["unavailable", "available"]


async def test_a_pdf_is_not_read():
    # Constructed transport answer for the branch (a real PRAC PDF is 283 KB and says nothing more):
    # only the content type and the magic bytes are looked at.
    class PdfFetcher:
        async def fetch(self, spec, **_):
            return FetchResult(request=spec, final_url=spec.url, status=200, headers={"content-type": "application/pdf"},
                               body=b"%PDF-1.7\n", fetched_at=datetime(2026, 9, 22, tzinfo=timezone.utc))

    trace = Trace()
    text, _ = await page_excerpt(PdfFetcher(), "https://www.ema.europa.eu/en/documents/x_en.pdf", source_id="s",
                                 egress="direct", trace=trace)
    assert text is None and trace.notes == ["page_is_pdf"]


def test_extraction_prefers_the_cms_body_over_the_page_frame():
    case = load_case("enrich/page-gov-cn")
    text = extract_main_text(case.exchanges[0].result.body.decode("utf-8"))
    assert text.startswith("新华社北京9月20日电") and text.endswith("营造良好氛围。")


def test_endpoints_come_from_the_core_settings():
    settings = Settings(database_url="postgresql://unused")
    endpoints = Endpoints.from_settings(settings)
    assert endpoints.pubmed_efetch == settings.enrichment.pubmed_efetch
    assert endpoints.unpaywall == "https://api.unpaywall.org/v2"
    assert Endpoints.from_settings(None) == Endpoints()


def test_request_spec_of_a_page_is_unconditional():
    spec = RequestSpec(url="https://example.org/", api=False, conditional=False)
    assert spec.conditional is False  # an excerpt is fetched whole: the stored validators belong to the list page
