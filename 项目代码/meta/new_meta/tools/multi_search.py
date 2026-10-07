"""Multi-source academic search — Semantic Scholar, OpenAlex, citation chaining.

Provides additional search sources beyond PubMed to satisfy PRISMA requirements
for searching multiple databases. Uses free APIs (no subscription needed).
"""
from __future__ import annotations

try:
    from evimed_judge import ask as judge_ask, ask_async as judge_ask_async
except ImportError:
    def judge_ask(*args, **kwargs):
        return None

    async def judge_ask_async(*args, **kwargs):
        return None


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
    _annotate_trial_pairs(unique)
    return unique, source_counts


def _annotate_trial_pairs(papers: list[dict]) -> None:
    """Bounded candidate annotations only; a judge never merges publications."""
    checked = 0
    stop_words = {"a", "an", "the", "of", "in", "and", "or", "for", "with", "to", "from", "by", "on",
                  "trial", "study", "randomized", "randomised", "controlled", "patients", "results", "analysis"}
    def title_words(paper):
        return {word.strip(".,:;()[]") for word in str(paper.get("title") or "").casefold().split()} - stop_words
    for index, left in enumerate(papers):
        words = title_words(left)
        if len(words) < 2:
            continue
        for right in papers[index + 1:]:
            other = title_words(right)
            if len(words & other) < 2:
                continue
            if checked >= 40:
                for paper in papers:
                    paper["trial_linkage_review"] = {
                        "status": "incomplete", "candidate_pairs_reviewed": checked,
                        "notice": "同一试验关联核对已达到40对上限，剩余候选未核对；记录均保留，不应据此认定试验相互独立。",
                    }
                logger.warning("Trial linkage annotation stopped at the 40-pair limit; all publications retained")
                return
            checked += 1
            judgment = judge_ask("J18", {"left": {"title": left.get("title") or "", "abstract": left.get("abstract") or ""},
                                        "right": {"title": right.get("title") or "", "abstract": right.get("abstract") or ""}})
            if isinstance(judgment, dict) and judgment.get("relation") == "same_trial":
                left.setdefault("suspected_same_trial", []).append(right.get("doi") or right.get("pmid") or right.get("title"))
                right.setdefault("suspected_same_trial", []).append(left.get("doi") or left.get("pmid") or left.get("title"))


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
    return get_openalex_locations_for_doi(doi)["pdf_urls"]


def get_openalex_locations_for_doi(doi: str, *, timeout: float | None = None) -> dict[str, Any]:
    """Fetch a DOI's OpenAlex work and return its full-text leads.

    ``pdf_urls``: every declared PDF (best OA, primary, all locations).
    ``landing_urls``: OA landing pages, to be read for citation_pdf_url.
    ``pmcid``: the PubMed Central id OpenAlex knows for the work, if any.
    """
    empty: dict[str, Any] = {"pdf_urls": [], "landing_urls": [], "pmcid": ""}
    doi = (doi or "").strip()
    if not doi:
        return empty
    try:
        resp = requests.get(
            f"https://api.openalex.org/works/doi:{doi}",
            headers=HEADERS,
            timeout=timeout or MULTI_SEARCH_TIMEOUT,
        )
        resp.raise_for_status()
        work = resp.json() or {}
    except Exception as exc:
        logger.debug(f"OpenAlex DOI location fetch failed for {doi}: {exc}")
        return empty
    return {
        "pdf_urls": _openalex_pdf_urls(work),
        "landing_urls": _openalex_landing_urls(work),
        "pmcid": _openalex_pmcid(work),
    }


def _openalex_locations(work: dict) -> list[dict]:
    """best_oa_location, primary_location, then every location, in that order."""
    ordered: list[dict] = []
    for location in [work.get("best_oa_location"), work.get("primary_location"), *(work.get("locations") or [])]:
        if isinstance(location, dict):
            ordered.append(location)
    return ordered


def _openalex_pdf_urls(work: dict) -> list[str]:
    """Return ordered unique OpenAlex PDF URLs for a work.

    Every location's ``pdf_url`` counts, not only an ``oa_url`` that happens
    to end in ``.pdf`` (MDPI, BMC and most OA publishers serve PDFs from
    extension-less paths).
    """
    urls: list[str] = []

    def add(url: str | None) -> None:
        url = str(url or "").strip()
        if url and url not in urls:
            urls.append(url)

    for location in (work.get("best_oa_location"), work.get("primary_location")):
        if isinstance(location, dict):
            add(location.get("pdf_url"))
    oa_url = str((work.get("open_access") or {}).get("oa_url") or "")
    if oa_url.lower().endswith(".pdf"):
        add(oa_url)
    for location in _openalex_locations(work):
        add(location.get("pdf_url"))
    return urls


_NON_ARTICLE_LANDING_HOSTS = ("pubmed.ncbi.nlm.nih.gov", "doaj.org")


def _openalex_landing_urls(work: dict) -> list[str]:
    """Return OA landing pages worth reading for a citation_pdf_url.

    PubMed and DOAJ pages carry no article PDF; PMC pages are reached through
    the PMCID instead (Europe PMC), and doi.org is the DOI route's own.
    """
    urls: list[str] = []
    pdf_urls = set(_openalex_pdf_urls(work))

    def add(url: str | None) -> None:
        url = str(url or "").strip()
        lowered = url.lower()
        if not url or url in urls or url in pdf_urls:
            return
        if not lowered.startswith(("http://", "https://")):
            return
        if "doi.org/" in lowered or "/pmc/articles/" in lowered or "pmc.ncbi.nlm.nih.gov" in lowered:
            return
        if any(host in lowered for host in _NON_ARTICLE_LANDING_HOSTS):
            return
        urls.append(url)

    for location in _openalex_locations(work):
        if location.get("is_oa"):
            add(location.get("landing_page_url"))
    add((work.get("open_access") or {}).get("oa_url"))
    return urls


def _openalex_pmcid(work: dict) -> str:
    """Return a normalized PMCID ("PMC123") from OpenAlex ids or PMC locations."""
    candidates = [str((work.get("ids") or {}).get("pmcid") or "")]
    for location in _openalex_locations(work):
        candidates.append(str(location.get("landing_page_url") or ""))
        candidates.append(str(location.get("pdf_url") or ""))
    for value in candidates:
        match = re.search(r"/pmc/articles/(?:PMC)?(\d+)|\bPMC(\d+)\b", value, flags=re.IGNORECASE)
        if match:
            return f"PMC{match.group(1) or match.group(2)}"
    return ""
