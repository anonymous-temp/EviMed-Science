"""A preprint server's own feed carries the paper's whole abstract as the entry's summary (2026-10-22).

arXiv's Atom API and bioRxiv's and medRxiv's RSS were read with the generic ``atom``/``rss`` adapters, so the paper text chain
did not know their summary was the abstract: it asked PubMed, which does not index preprints, and 287 published papers showed
no text. Every request here is answered 404 — the abstract has to come from the entry itself.
"""

from __future__ import annotations

from datetime import datetime, timezone

from knowledge_plugin.enrich import enrich_batch, preprint_feed_abstract
from knowledge_plugin.model import FetchResult, RequestSpec

NOW = datetime(2026, 10, 22, 18, 0, tzinfo=timezone.utc)
ABSTRACT = ("We develop a quantitative framework for estimating within-host viral dynamics from sparse longitudinal "
            "samples, and show on three cohorts that it recovers clearance rates within 8% of the reference method. ") * 4


class NotFound:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def fetch(self, spec: RequestSpec, *, source_id=None, egress="direct", allowed_hosts=None) -> FetchResult:
        self.calls.append(spec.url)
        return FetchResult(spec, spec.url, 404, {"content-type": "text/plain"}, b"", NOW)


def entry(doi: str, access: str, summary: str = ABSTRACT) -> dict:
    return {"entry_id": f"s:{doi}", "source_id": "s", "external_key": doi, "doi": doi, "pmid": None, "url": f"https://doi.org/{doi}",
            "title": "A paper", "summary": summary, "source_access": access, "source_type": "preprint", "source_egress": "direct", "source_config": {},
            "attempts": 0, "first_seen_at": NOW, "published_at": NOW}


def test_which_summaries_are_an_abstract():
    assert preprint_feed_abstract(entry("10.48550/arxiv.2610.29399", "atom"), "10.48550/arxiv.2610.29399")
    assert preprint_feed_abstract(entry("10.1101/2026.10.20.123456", "rss"), "10.1101/2026.10.20.123456")
    assert preprint_feed_abstract(entry("10.64898/2026.09.18.26363418", "rss"), "10.64898/2026.09.18.26363418")
    # A journal's RSS summary is a teaser, a short or cut summary is not the abstract, and an HTML list carries none.
    assert not preprint_feed_abstract(entry("10.1056/nejmoa2605659", "rss"), "10.1056/nejmoa2605659")
    assert not preprint_feed_abstract(entry("10.48550/arxiv.2610.1", "atom", "Too short."), "10.48550/arxiv.2610.1")
    assert not preprint_feed_abstract(entry("10.48550/arxiv.2610.2", "atom", ABSTRACT[:400] + "…"), "10.48550/arxiv.2610.2")
    assert not preprint_feed_abstract(entry("10.48550/arxiv.2610.3", "html-list"), "10.48550/arxiv.2610.3")


async def test_an_arxiv_or_biorxiv_entry_is_read_from_its_own_summary():
    rows = [entry("10.48550/arxiv.2610.29399", "atom"), entry("10.1101/2026.10.20.123456", "rss")]
    results = await enrich_batch(rows, NotFound(), None, now=NOW)
    for result in results:
        assert (result.status, result.text_kind, result.abstract) == ("available", "abstract", ABSTRACT)
