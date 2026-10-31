"""``/text`` for news, regulator and list entries: the page excerpt and its failure classes.

Recorded pages (2026-09-22): a who.int news item (Sitefinity), a gov.cn policy page (TRS CMS) and an
NMPA announcement that answers a Ruishu script page (HTTP 412) — classified by the plugin's own
``fetch.detect_challenge`` when it was recorded. Fetcher doubles that raise are used only for the
transport failure classes; they stand for no upstream answer.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from knowledge_plugin.enrich import enrich, enrich_batch, kind_of, page_retry_s
from knowledge_plugin.enrich.common import Attempt, Endpoints
from knowledge_plugin.enrich.page import EXCERPT_MAX, extract_main_text, meta_refresh_target, page_excerpt
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


async def test_full_feed_text_is_the_answer_when_the_page_gives_none():
    # The summary is the whole text but folded to one line, so the page (which has the paragraphs) is read first; a page
    # that cannot be read leaves the feed's text as the answer, at once, transient failure or not.
    row = entry_row("rss/harrell-stale-oversize", 2)
    assert len(row["summary"]) > EXCERPT_MAX and kind_of(row) == "page"
    for outcome, detail in (("http-error", "http_404"), ("timeout", "read_timeout")):
        fetcher = FailingFetcher(outcome, detail)
        result = await enrich(row, fetcher, None, now=NOW)
        assert len(fetcher.calls) == 1 and fetcher.calls[0][0].url == row["url"]
        assert result.status == "available" and result.text_kind == "excerpt" and "feed_text" in result.notes
        assert len(result.body_excerpt) <= EXCERPT_MAX and row["summary"].startswith(result.body_excerpt[:200])


async def test_a_crawled_post_with_no_text_is_never_sent_to_the_page_reader():
    """F6: the post's page can carry the uploader's name and the comments (contract rule 4), and the platforms refuse programs; the crawler's
    answer is all there is of a post, so a title-only post is ``unavailable`` with a named reason and the platform decides what it is worth."""
    row = {"entry_id": "social-xiaohongshu:x", "revision": 1, "source_id": "social-xiaohongshu", "external_key": "xhs:n1", "identity_key": None,
           "url": "https://www.xiaohongshu.com/explore/n1", "canonical_url": None, "doi": None, "pmid": None, "registry_ids": [],
           "title": "只有标题的笔记", "summary": "只有标题的笔记", "lang": "zh", "published_at": NOW, "facts": {}, "first_seen_at": NOW,
           "source_access": "social-crawl", "source_egress": "direct", "source_type": "media", "source_config": {}, "attempts": 0}
    assert kind_of(row) == "post"
    result = await enrich(row, RefusingFetcher(), None, now=NOW)
    assert result.status == "unavailable" and result.notes == ["post_is_the_text"] and result.body_text is None and result.body_excerpt is None
    (batched,) = await enrich_batch([row, ], RefusingFetcher(), None, now=NOW)
    assert (batched.status, batched.notes) == ("unavailable", ["post_is_the_text"])
    # The other social accesses and every page source are read as before.
    assert kind_of({**row, "source_access": "rss"}) == "page"


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


# ------------------------------------------------------------------ redirect shells and pages that always answer 4xx (review G6)

CHP_SHELL_URL = "https://www.chp.gov.hk/en/media/116/110525.html"
CHP_TARGET_URL = "https://www.info.gov.hk/gia/general/202610/23/P2026102300702.htm"


class ShellFetcher:
    """The two real pages of the 香港卫生防护中心 press release of 2026-10-23, read with a plain GET on 2026-10-25 (the bytes
    in ``fixtures/enrich/page-hk-chp-refresh/``): the link of the feed answers 200 with 477 bytes — a ``<meta
    http-equiv="refresh">`` to the Government Information Services copy — and the copy is the release. A request for any
    other address fails the test."""

    def __init__(self, pages: dict[str, bytes]) -> None:
        self.pages = pages
        self.calls: list[tuple[str, bool]] = []

    async def fetch(self, spec, **_):
        self.calls.append((spec.url, spec.api))
        assert spec.url in self.pages, f"unexpected request {spec.url}"
        return FetchResult(request=spec, final_url=spec.url, status=200, headers={"content-type": "text/html"},
                           body=self.pages[spec.url], fetched_at=NOW)


def chp_pages() -> dict[str, bytes]:
    from pathlib import Path

    folder = Path(__file__).resolve().parents[1] / "fixtures" / "enrich" / "page-hk-chp-refresh"
    return {CHP_SHELL_URL: (folder / "shell.html").read_bytes(), CHP_TARGET_URL: (folder / "target.html").read_bytes()}


def chp_row(hosts: list[str]) -> dict:
    return {"entry_id": "hk-chp-press:x", "revision": 1, "source_id": "hk-chp-press", "external_key": CHP_SHELL_URL,
            "url": CHP_SHELL_URL, "canonical_url": CHP_SHELL_URL, "doi": None, "pmid": None, "registry_ids": [],
            "title": "CHP records case of severe paediatric influenza infection", "summary": None, "lang": "en",
            "published_at": datetime(2026, 10, 23, tzinfo=timezone.utc), "facts": {}, "first_seen_at": NOW,
            "source_access": "rss", "source_egress": "direct", "source_type": "regulator",
            "source_config": {"url": "https://www.chp.gov.hk/rss/pressreleases_en_RSS.xml", "allowed_hosts": hosts},
            "attempts": 0}


async def test_a_meta_refresh_shell_is_followed_once_to_an_allowed_host():
    fetcher = ShellFetcher(chp_pages())
    result = await enrich(chp_row(["info.gov.hk", "www.chp.gov.hk"]), fetcher, None, now=NOW)
    assert fetcher.calls == [(CHP_SHELL_URL, False), (CHP_TARGET_URL, False)], "both are page requests: robots.txt applies"
    assert (result.status, result.text_kind, result.fetched_from) == ("available", "excerpt", "page")
    assert result.body_text.startswith("CHP records case of severe paediatric influenza infection") and len(result.body_text) > 300
    assert "Issued at HKT 19:25" in result.body_text
    assert result.notes == ["page_meta_refresh"]


async def test_a_meta_refresh_to_a_host_the_source_does_not_name_is_not_followed():
    fetcher = ShellFetcher(chp_pages())
    result = await enrich(chp_row(["www.chp.gov.hk"]), fetcher, None, now=NOW)
    assert fetcher.calls == [(CHP_SHELL_URL, False)], "the target is outside the source's hosts: no request"
    assert (result.status, result.body_text) == ("unavailable", None)
    assert result.notes == ["page_refresh_host_not_allowed", "page_no_main_text"]


async def test_only_one_refresh_is_followed():
    shell = chp_pages()[CHP_SHELL_URL]
    pages = {CHP_SHELL_URL: shell, CHP_TARGET_URL: shell.replace(b"/P2026102300702", b"/P2026102300703")}
    fetcher = ShellFetcher(pages)
    trace = Trace()
    text, _ = await page_excerpt(fetcher, CHP_SHELL_URL, source_id="hk-chp-press", egress="direct", trace=trace,
                                 allowed_hosts=["info.gov.hk"])
    assert text is None and len(fetcher.calls) == 2, "a shell behind a shell is not chased"
    assert trace.notes == ["page_meta_refresh", "page_no_main_text"]


def test_the_refresh_target_is_read_from_the_refresh_meta_only():
    base = "https://www.chp.gov.hk/en/media/116/110525.html"
    shell = chp_pages()[CHP_SHELL_URL].decode("utf-8")
    assert meta_refresh_target(shell, base) == CHP_TARGET_URL, "the other http-equiv metas (Pragma, no-cache …) are not it"
    assert meta_refresh_target('<meta HTTP-EQUIV="Refresh" content="5;url=\'/next.html\'">', base) == \
        "https://www.chp.gov.hk/next.html"
    assert meta_refresh_target('<meta http-equiv="refresh" content="0, https://other.example/a">', base) == "https://other.example/a"
    assert meta_refresh_target('<meta http-equiv="refresh" content="30">', base) is None, "a reload is not a redirect"
    assert meta_refresh_target('<meta http-equiv="refresh" content="0; URL=javascript:alert(1)">', base) is None
    assert meta_refresh_target('<meta http-equiv="refresh" content="0; URL=https://user:fake@example.org/">', base) is None
    assert meta_refresh_target("<html><body>no tag</body></html>", base) is None


def http_error(status=None, detail=None, outcome="http-error"):
    return Attempt(error=FetchError(outcome, detail or f"http_{status}", status=status))


def test_a_page_answering_4xx_is_asked_three_times_and_then_it_is_final():
    gone = http_error(405)
    assert [page_retry_s(gone, n) for n in range(4)] == [3600, 6 * 3600, None, None]
    assert page_retry_s(http_error(detail="http_404"), 2) is None, "the status is also read from the detail"
    for transient in (http_error(503), http_error(429, "rate_limited_429"), http_error(408), Attempt(error=FetchError("timeout", "timeout")),
                      Attempt(error=FetchError("host-budget", "daily_cap"))):
        assert page_retry_s(transient, 40) == 3600, "a timeout, a 5xx and the host's pacing are asked again, hourly"


@pytest.mark.parametrize("attempts_before, status, notes", [
    (0, "pending", ["page_http-error:http_405"]), (1, "pending", ["page_http-error:http_405"]),
    (2, "unavailable", ["page_http-error:http_405", "page_4xx_given_up"])])
async def test_the_entry_of_a_405_page_stops_being_asked(attempts_before, status, notes):
    row = {**load_case("enrich/page-who-news").rows[0], "attempts": attempts_before}
    result = await enrich(row, FailingFetcher("http-error", "http_405"), None, now=NOW)
    assert (result.status, result.notes) == (status, notes)
    assert result.retry_after_s == ([3600, 6 * 3600, None][attempts_before] if status == "pending" else None)
