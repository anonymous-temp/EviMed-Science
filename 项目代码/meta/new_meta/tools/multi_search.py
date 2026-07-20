"""Multi-source academic search — Semantic Scholar, OpenAlex, citation chaining.

Provides additional search sources beyond PubMed to satisfy PRISMA requirements
for searching multiple databases. Uses free APIs (no subscription needed).
"""
from __future__ import annotations

import logging
import os
import re
import time
from typing import Any

import requests

logger = logging.getLogger("metaagent.multi_search")

HEADERS = {"User-Agent": "MetaAgent/1.0 (mailto:metaagent@research.ai)"}
MULTI_SEARCH_TIMEOUT = float(os.getenv("MULTI_SEARCH_TIMEOUT", "12"))
MULTI_SEARCH_RATE_LIMIT_SLEEP = float(os.getenv("MULTI_SEARCH_RATE_LIMIT_SLEEP", "5"))
MULTI_SEARCH_DISABLED = os.getenv("MULTI_SEARCH_DISABLED", "").lower() in {"1", "true", "yes"}


# =============================================================================
# Semantic Scholar API (free, 100 req/5min without API key)
# =============================================================================

def search_semantic_scholar(
    query: str,
    max_results: int = 100,
    year_range: tuple[int, int] | None = None,
    fields_of_study: list[str] | None = None,
) -> list[dict]:
    """Search Semantic Scholar for papers matching a query.

    Returns list of dicts with: title, authors, year, doi, abstract, pmid, source.
    """
    url = "https://api.semanticscholar.org/graph/v1/paper/search"
    params: dict[str, Any] = {
        "query": query[:200],  # API limit
        "limit": min(max_results, 100),
        "fields": "title,authors,year,externalIds,abstract,citationCount",
    }
    if year_range:
        params["year"] = f"{year_range[0]}-{year_range[1]}"
    if fields_of_study:
        params["fieldsOfStudy"] = ",".join(fields_of_study)

    papers = []
    offset = 0
    while len(papers) < max_results:
        params["offset"] = offset
        try:
            resp = requests.get(url, params=params, headers=HEADERS, timeout=MULTI_SEARCH_TIMEOUT)
            if resp.status_code == 429:
                logger.warning("Semantic Scholar rate limit hit; skipping this source for now.")
                if MULTI_SEARCH_RATE_LIMIT_SLEEP > 0:
                    time.sleep(MULTI_SEARCH_RATE_LIMIT_SLEEP)
                break
            resp.raise_for_status()
            data = resp.json()
            batch = data.get("data", [])
            if not batch:
                break
            for p in batch:
                ext_ids = p.get("externalIds", {}) or {}
                authors = [a.get("name", "") for a in (p.get("authors") or [])]
                papers.append({
                    "title": p.get("title", ""),
                    "authors": authors,
                    "year": p.get("year", 0),
                    "doi": ext_ids.get("DOI", ""),
                    "pmid": ext_ids.get("PubMed", ""),
                    "abstract": p.get("abstract", "") or "",
                    "citation_count": p.get("citationCount", 0),
                    "source": "semantic_scholar",
                    "s2_paper_id": p.get("paperId", ""),
                })
            offset += len(batch)
            if data.get("next") is None:
                break
            if MULTI_SEARCH_RATE_LIMIT_SLEEP > 0:
                time.sleep(min(MULTI_SEARCH_RATE_LIMIT_SLEEP, 1))  # Rate limiting
        except Exception as e:
            logger.warning(f"Semantic Scholar search error: {e}")
            break

    logger.info(f"Semantic Scholar returned {len(papers)} papers")
    return papers[:max_results]


# =============================================================================
# OpenAlex API (free, unlimited, acts as Embase/Crossref proxy)
# =============================================================================

def search_openalex(
    query: str,
    max_results: int = 100,
    year_range: tuple[int, int] | None = None,
) -> list[dict]:
    """Search OpenAlex (free alternative covering Crossref, PubMed, etc.).

    Returns list of dicts with: title, authors, year, doi, pmid, abstract, source.
    """
    url = "https://api.openalex.org/works"

    params: dict[str, Any] = {
        "search": query[:300],
        "per_page": min(max_results, 200),
        "mailto": "metaagent@research.ai",
    }
    if year_range:
        params["filter"] = f"from_publication_date:{year_range[0]}-01-01,to_publication_date:{year_range[1]}-12-31"

    papers = []
    try:
        resp = requests.get(url, params=params, headers=HEADERS, timeout=MULTI_SEARCH_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        for work in data.get("results", []):
            # Extract IDs
            doi = (work.get("doi") or "").replace("https://doi.org/", "")
            ids = work.get("ids", {})
            pmid = (ids.get("pmid") or "").replace("https://pubmed.ncbi.nlm.nih.gov/", "").rstrip("/")

            # Extract authors
            authors = []
            for auth in work.get("authorships", []):
                name = auth.get("author", {}).get("display_name", "")
                if name:
                    authors.append(name)

            pdf_urls = _openalex_pdf_urls(work)
            papers.append({
                "title": work.get("display_name", "") or work.get("title", ""),
                "authors": authors,
                "year": work.get("publication_year", 0),
                "doi": doi,
                "pmid": pmid,
                "abstract": _openalex_abstract(work.get("abstract_inverted_index") or {}),
                "url": (pdf_urls[0] if pdf_urls else (work.get("primary_location") or {}).get("landing_page_url") or ""),
                "pdf_url": pdf_urls[0] if pdf_urls else "",
                "pdf_urls": pdf_urls,
                "citation_count": work.get("cited_by_count", 0),
                "source": "openalex",
                "openalex_id": work.get("id", ""),
            })
    except Exception as e:
        logger.warning(f"OpenAlex search error: {e}")

    logger.info(f"OpenAlex returned {len(papers)} papers")
    return papers[:max_results]


# =============================================================================
# Backward/Forward Citation Chaining (Snowball Search)
# =============================================================================

def citation_chain(
    seed_dois: list[str],
    direction: str = "both",
    max_results: int = 50,
) -> list[dict]:
    """Perform backward and/or forward citation chaining via Semantic Scholar.

    Args:
        seed_dois: DOIs of included studies to start from.
        direction: "backward" (references), "forward" (citations), or "both".
        max_results: Max papers to return.

    Returns:
        list of paper dicts from citation chains.
    """
    seen_ids: set[str] = set()
    chain_papers: list[dict] = []

    for doi in seed_dois:
        if len(chain_papers) >= max_results:
            break

        paper_id = f"DOI:{doi}" if doi else None
        if not paper_id:
            continue

        # Backward: get references
        if direction in ("backward", "both"):
            refs = _get_s2_connections(paper_id, "references")
            for r in refs:
                pid = r.get("paperId", "")
                if pid and pid not in seen_ids:
                    seen_ids.add(pid)
                    chain_papers.append(_s2_to_paper_dict(r, "citation_backward"))
                    if len(chain_papers) >= max_results:
                        break

        # Forward: get citations
        if direction in ("forward", "both"):
            cits = _get_s2_connections(paper_id, "citations")
            for c in cits:
                pid = c.get("paperId", "")
                if pid and pid not in seen_ids:
                    seen_ids.add(pid)
                    chain_papers.append(_s2_to_paper_dict(c, "citation_forward"))
                    if len(chain_papers) >= max_results:
                        break

        time.sleep(1)  # Rate limiting

    logger.info(f"Citation chaining found {len(chain_papers)} papers from {len(seed_dois)} seeds")
    return chain_papers[:max_results]


def _get_s2_connections(paper_id: str, connection_type: str) -> list[dict]:
    """Get references or citations for a paper from Semantic Scholar."""
    url = f"https://api.semanticscholar.org/graph/v1/paper/{paper_id}/{connection_type}"
    params = {
        "fields": "title,authors,year,externalIds,abstract",
        "limit": 50,
    }
    try:
        resp = requests.get(url, params=params, headers=HEADERS, timeout=MULTI_SEARCH_TIMEOUT)
        if resp.status_code != 200:
            return []
        data = resp.json().get("data", [])
        # Each entry has a nested "citedPaper" or "citingPaper"
        papers = []
        for entry in data:
            p = entry.get("citedPaper") or entry.get("citingPaper") or entry
            if p and p.get("title"):
                papers.append(p)
        return papers
    except Exception as e:
        logger.debug(f"S2 {connection_type} fetch error for {paper_id}: {e}")
        return []


def _s2_to_paper_dict(p: dict, source: str) -> dict:
    """Convert Semantic Scholar paper object to our standard dict."""
    ext_ids = p.get("externalIds", {}) or {}
    authors = [a.get("name", "") for a in (p.get("authors") or [])]
    return {
        "title": p.get("title", ""),
        "authors": authors,
        "year": p.get("year", 0),
        "doi": ext_ids.get("DOI", ""),
        "pmid": ext_ids.get("PubMed", ""),
        "abstract": p.get("abstract", "") or "",
        "source": source,
        "s2_paper_id": p.get("paperId", ""),
    }


# =============================================================================
# Aggregate Search — combine multiple sources
# =============================================================================

def aggregate_search(
    query: str,
    max_per_source: int = 100,
    year_range: tuple[int, int] | None = None,
    include_semantic_scholar: bool = True,
    include_openalex: bool = True,
) -> tuple[list[dict], dict[str, int]]:
    """Search multiple databases and return deduplicated results.

    Returns:
        (papers, source_counts) where source_counts maps source name to count.
    """
    if MULTI_SEARCH_DISABLED:
        logger.info("Aggregate search disabled by MULTI_SEARCH_DISABLED")
        return [], {"Semantic Scholar": 0, "OpenAlex": 0}

    all_papers: list[dict] = []
    source_counts: dict[str, int] = {}

    if include_semantic_scholar:
        try:
            s2_papers = search_semantic_scholar(query, max_results=max_per_source, year_range=year_range)
            all_papers.extend(s2_papers)
            source_counts["Semantic Scholar"] = len(s2_papers)
        except Exception as e:
            logger.warning(f"Semantic Scholar search failed: {e}")
            source_counts["Semantic Scholar"] = 0

    if include_openalex:
        try:
            oa_papers = search_openalex(query, max_results=max_per_source, year_range=year_range)
            all_papers.extend(oa_papers)
            source_counts["OpenAlex"] = len(oa_papers)
        except Exception as e:
            logger.warning(f"OpenAlex search failed: {e}")
            source_counts["OpenAlex"] = 0

    unique = _deduplicate_by_doi_pmid_title(all_papers)
    logger.info(
        f"Aggregate search: {len(unique)} unique papers from "
        f"{len(all_papers)} raw records across {len(source_counts)} sources"
    )
    return unique, source_counts


def _deduplicate_by_doi_pmid_title(papers: list[dict]) -> list[dict]:
    """Small source-local deduper so aggregate_search matches its contract."""
    seen_ids: set[str] = set()
    seen_titles: set[str] = set()
    unique: list[dict] = []
    for paper in papers:
        doi = str(paper.get("doi") or "").strip().lower()
        pmid = str(paper.get("pmid") or "").strip().lower()
        title = re.sub(r"\s+", " ", str(paper.get("title") or "").strip().lower())
        key = doi or pmid
        if key and key in seen_ids:
            continue
        if title and title in seen_titles:
            continue
        if key:
            seen_ids.add(key)
        if title:
            seen_titles.add(title)
        unique.append(paper)
    return unique


def _openalex_abstract(inverted_index: dict[str, list[int]]) -> str:
    """Reconstruct OpenAlex abstract text from its inverted-index format."""
    if not inverted_index:
        return ""
    positioned: list[tuple[int, str]] = []
    for word, positions in inverted_index.items():
        for pos in positions or []:
            try:
                positioned.append((int(pos), word))
            except (TypeError, ValueError):
                continue
    if not positioned:
        return ""
    return " ".join(word for _, word in sorted(positioned))


def _openalex_pdf_url(work: dict) -> str:
    """Return the best available OpenAlex PDF URL for a work."""
    urls = _openalex_pdf_urls(work)
    return urls[0] if urls else ""


def get_openalex_pdf_urls_for_doi(doi: str) -> list[str]:
    """Fetch OpenAlex OA PDF candidates for a DOI.

    This is used as a resume-safe hydration path for cached search records
    produced before PDF URL candidates were persisted.
    """
    doi = (doi or "").strip()
    if not doi:
        return []
    try:
        resp = requests.get(
            f"https://api.openalex.org/works/doi:{doi}",
            headers=HEADERS,
            timeout=MULTI_SEARCH_TIMEOUT,
        )
        resp.raise_for_status()
        return _openalex_pdf_urls(resp.json())
    except Exception as exc:
        logger.debug(f"OpenAlex DOI PDF URL fetch failed for {doi}: {exc}")
        return []


def _openalex_pdf_urls(work: dict) -> list[str]:
    """Return ordered unique OpenAlex PDF URLs for a work."""
    urls: list[str] = []

    def add(url: str | None) -> None:
        if not url:
            return
        if url in urls:
            return
        urls.append(url)

    primary = work.get("primary_location") or {}
    add(primary.get("pdf_url"))
    open_access = work.get("open_access") or {}
    oa_url = open_access.get("oa_url") or ""
    if oa_url.lower().endswith(".pdf"):
        add(oa_url)
    for location in work.get("locations") or []:
        add(location.get("pdf_url"))
    return urls
