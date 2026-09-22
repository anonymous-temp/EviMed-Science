"""The text rule for journal and preprint entries: pending → available, or unavailable after 5 days.

The plugin does not bump an entry's revision when its text arrives, so a journal entry must not
answer ``available`` before there is an abstract or an excerpt: the platform would publish a
title-only item and never re-edit it when PubMed indexes the abstract (controller ruling,
2026-09-22). Rows and answers are the recorded ``enrich/journal-batch`` case (an NEJM Clinical Image
that PubMed indexed without an abstract, and an RCT with one).
"""

from __future__ import annotations

from datetime import datetime, timedelta

from knowledge_plugin.enrich import apply_text_rule, enrich_batch, is_journal_like
from knowledge_plugin.model import EntryTextResult
from replay import ReplayFetcher, load_case

CASE = "enrich/journal-batch"
IMAGE = "10.1056/nejmicm2609443"
RCT = "10.1056/nejmoa2605659"


async def answers(now: datetime):
    case = load_case(CASE)
    results = await enrich_batch(case.rows, ReplayFetcher(case), None, now=now)
    return case, {row["doi"]: result for row, result in zip(case.rows, results, strict=True)}


def first_seen(case, doi):
    return next(row["first_seen_at"] for row in case.rows if row["doi"] == doi)


async def test_pending_with_enrichment_while_no_abstract_exists():
    case = load_case(CASE)
    now = first_seen(case, IMAGE) + timedelta(hours=1)
    _, results = await answers(now)
    image = results[IMAGE]
    assert image.status == "pending" and image.text_kind == "none"
    assert image.abstract is None and image.body_excerpt is None
    assert image.enrichment["publication_types"] == ["Case Reports", "Journal Article"]  # kept while pending
    assert image.enrichment["open_access"] == "closed"
    assert image.retry_after_s == 12 * 3600


async def test_available_as_soon_as_an_abstract_exists():
    case = load_case(CASE)
    _, results = await answers(first_seen(case, RCT) + timedelta(hours=1))
    rct = results[RCT]
    assert (rct.status, rct.text_kind, rct.fetched_from) == ("available", "abstract", "pubmed")
    assert rct.retry_after_s is None


async def test_unavailable_with_enrichment_after_five_days():
    case = load_case(CASE)
    _, results = await answers(first_seen(case, IMAGE) + timedelta(days=5, seconds=1))
    image = results[IMAGE]
    assert image.status == "unavailable" and image.retry_after_s is None
    assert image.enrichment["publication_types"] == ["Case Reports", "Journal Article"]
    assert "text_horizon_passed" in image.notes
    assert results[RCT].status == "available"  # an abstract stays available whatever the age


async def test_the_retry_never_overshoots_the_horizon():
    case = load_case(CASE)
    _, results = await answers(first_seen(case, IMAGE) + timedelta(days=5) - timedelta(minutes=30))
    assert results[IMAGE].status == "pending" and results[IMAGE].retry_after_s == 30 * 60


def test_scope_of_the_rule():
    assert is_journal_like({"source_access": "crossref-issn"})
    assert is_journal_like({"source_access": "rss", "doi": "10.1/x"})
    assert is_journal_like({"source_access": "html-list", "pmid": "42752131"})
    assert not is_journal_like({"source_access": "rss"})
    news = {"source_access": "rss", "first_seen_at": "2026-09-01T00:00:00+00:00"}
    unchanged = EntryTextResult(status="unavailable", notes=["page_challenge:ruishu"])
    assert apply_text_rule(news, unchanged, datetime.fromisoformat("2026-09-22T00:00:00+00:00")) is unchanged
