# [IN] None (external API)
# [OUT] PaperReference list
# [POS] mr_agent/tools/pubmed.py - PubMed literature search
"""PubMed API integration for literature search."""

from __future__ import annotations

import logging
import os
import threading
import time

from mr_agent.models import PaperReference

logger = logging.getLogger(__name__)

_EMAIL = os.getenv("PUBMED_EMAIL", "mr_agent@example.com")
_MIN_REQUEST_INTERVAL = 0.34  # NCBI allows max 3 requests/sec
_last_request_time = 0.0
_rate_lock = threading.Lock()


def _rate_limit() -> None:
    """Enforce NCBI rate limit of 3 requests per second (thread-safe)."""
    global _last_request_time
    with _rate_lock:
        now = time.monotonic()
        elapsed = now - _last_request_time
        if elapsed < _MIN_REQUEST_INTERVAL:
            time.sleep(_MIN_REQUEST_INTERVAL - elapsed)
        _last_request_time = time.monotonic()


def search_papers(
    keyword: str,
    max_results: int = 20,
    sort: str = "relevance",
) -> list[PaperReference]:
    """Search PubMed for papers matching keyword."""
    try:
        from Bio import Entrez
    except ImportError:
        logger.warning(
            "biopython not installed. Install with: pip install biopython"
        )
        return []

    try:
        Entrez.email = _EMAIL
        _rate_limit()
        handle = Entrez.esearch(
            db="pubmed",
            term=keyword,
            retmax=max_results,
            sort=sort,
        )
        record = Entrez.read(handle)
        handle.close()
        id_list = record.get("IdList", [])
        if not id_list:
            return []
        return _fetch_details(id_list)
    except Exception as e:
        logger.warning(f"PubMed search failed for '{keyword}': {e}")
        return []


def _fetch_details(pmid_list: list[str]) -> list[PaperReference]:
    """Fetch paper details for a list of PMIDs."""
    try:
        from Bio import Entrez
    except ImportError:
        return []

    try:
        Entrez.email = _EMAIL
        _rate_limit()
        handle = Entrez.efetch(
            db="pubmed",
            id=",".join(pmid_list),
            rettype="xml",
            retmode="xml",
        )
        records = Entrez.read(handle)
        handle.close()
        papers = []
        for article in records.get("PubmedArticle", []):
            ref = _parse_article(article)
            if ref:
                papers.append(ref)
        return papers
    except Exception as e:
        logger.warning(f"PubMed fetch details failed: {e}")
        return []


def _parse_article(article: dict) -> PaperReference | None:
    """Parse a single PubMed article into PaperReference."""
    try:
        medline = article["MedlineCitation"]
        art = medline["Article"]
        pmid = str(medline["PMID"])
        title = str(art.get("ArticleTitle", ""))
        abstract = _extract_abstract(art)
        authors = _extract_authors(art)
        journal = str(art.get("Journal", {}).get("Title", ""))
        year = _extract_year(art)
        doi = _extract_doi(art)
        return PaperReference(
            pmid=pmid,
            doi=doi,
            title=title,
            authors=authors,
            journal=journal,
            year=year,
            abstract=abstract,
        )
    except Exception:
        logger.warning("Failed to parse PubMed article")
        return None


def _extract_abstract(article: dict) -> str:
    """Extract abstract text from article."""
    abs_data = article.get("Abstract", {}).get("AbstractText", [])
    if isinstance(abs_data, list):
        return " ".join(str(s) for s in abs_data)
    return str(abs_data)


def _extract_authors(article: dict) -> str:
    """Extract author list as string."""
    authors = article.get("AuthorList", [])
    names = []
    for author in authors[:5]:
        last = author.get("LastName", "")
        first = author.get("ForeName", "")
        if last:
            names.append(f"{last} {first}".strip())
    suffix = " et al." if len(authors) > 5 else ""
    return ", ".join(names) + suffix


def _extract_year(article: dict) -> int | None:
    """Extract publication year."""
    try:
        date = article["Journal"]["JournalIssue"]["PubDate"]
        return int(date.get("Year", 0)) or None
    except (KeyError, ValueError):
        return None


def _extract_doi(article: dict) -> str | None:
    """Extract DOI from article IDs."""
    try:
        for eid in article.get("ELocationID", []):
            if str(getattr(eid, "attributes", {}).get("EIdType", "")) == "doi":
                return str(eid)
    except (AttributeError, TypeError):
        pass
    return None


def search_mr_studies(exposure: str, outcome: str, max_results: int = 10) -> list[PaperReference]:
    """Search specifically for MR studies on an exposure-outcome pair."""
    query = (
        f'({exposure}[Title/Abstract]) AND '
        f'({outcome}[Title/Abstract]) AND '
        f'(Mendelian randomization[Title/Abstract])'
    )
    return search_papers(query, max_results=max_results)
