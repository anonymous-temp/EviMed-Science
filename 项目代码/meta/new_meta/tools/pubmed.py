"""PubMed E-utilities API for literature search."""
from __future__ import annotations

import time
import logging
import os
import xml.etree.ElementTree as ET

import requests

from new_meta.config import PUBMED_EMAIL, PUBMED_API_KEY

logger = logging.getLogger("metaagent.pubmed")

BASE_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
PUBMED_SEARCH_TIMEOUT = float(os.getenv("PUBMED_SEARCH_TIMEOUT", "10"))
PUBMED_FETCH_TIMEOUT = float(os.getenv("PUBMED_FETCH_TIMEOUT", "90"))
PUBMED_ESEARCH_PAGE_SIZE = min(9999, max(1, int(os.getenv("PUBMED_ESEARCH_PAGE_SIZE", "9999"))))
_WARNED_MISSING_EMAIL = False


def _contact_params() -> dict[str, str]:
    """Return optional NCBI contact parameters without inventing fake contact details."""
    global _WARNED_MISSING_EMAIL
    params: dict[str, str] = {}
    email = str(PUBMED_EMAIL or "").strip()
    if email:
        params["email"] = email
    elif not _WARNED_MISSING_EMAIL:
        logger.warning(
            "PUBMED_EMAIL is not configured; set a real NCBI contact email to improve E-utilities compliance."
        )
        _WARNED_MISSING_EMAIL = True
    api_key = str(PUBMED_API_KEY or "").strip()
    if api_key:
        params["api_key"] = api_key
    return params


def _parse_year(text: str | None) -> int:
    if not text:
        return 0
    text = str(text).strip()
    return int(text[:4]) if text[:4].isdigit() else 0


def _search_params(
    *,
    query: str,
    retmax: int,
    min_date: str | None = None,
    max_date: str | None = None,
) -> dict:
    params = {
        "db": "pubmed",
        "term": query,
        "retmax": retmax,
        "retmode": "xml",
        "sort": "relevance",
    }
    params.update(_contact_params())
    if min_date:
        params["mindate"] = min_date
        params["datetype"] = "pdat"
    if max_date:
        params["maxdate"] = max_date
        params["datetype"] = "pdat"
    return params


def _ids_from_esearch_xml(text: str) -> list[str]:
    root = ET.fromstring(text)
    return [id_elem.text for id_elem in root.findall(".//Id") if id_elem.text]


def _search_with_history(
    query: str,
    *,
    max_results: int,
    min_date: str | None = None,
    max_date: str | None = None,
) -> list[str]:
    """Retrieve large PubMed result sets via WebEnv/query_key paging."""
    history_params = _search_params(
        query=query,
        retmax=0,
        min_date=min_date,
        max_date=max_date,
    )
    history_params["usehistory"] = "y"
    resp = requests.post(f"{BASE_URL}/esearch.fcgi", data=history_params, timeout=PUBMED_SEARCH_TIMEOUT)
    resp.raise_for_status()
    root = ET.fromstring(resp.text)
    webenv = root.findtext(".//WebEnv", "")
    query_key = root.findtext(".//QueryKey", "")
    try:
        count = int(root.findtext(".//Count", "") or "0")
    except ValueError:
        count = 0
    if not webenv or not query_key:
        logger.warning("PubMed history paging unavailable; falling back to first %s records.", PUBMED_ESEARCH_PAGE_SIZE)
        fallback_resp = requests.post(
            f"{BASE_URL}/esearch.fcgi",
            data=_search_params(
                query=query,
                retmax=min(max_results, PUBMED_ESEARCH_PAGE_SIZE),
                min_date=min_date,
                max_date=max_date,
            ),
            timeout=PUBMED_SEARCH_TIMEOUT,
        )
        fallback_resp.raise_for_status()
        return _ids_from_esearch_xml(fallback_resp.text)

    target = min(max_results, count) if count > 0 else max_results
    pmids: list[str] = []
    retstart = 0
    while retstart < target:
        retmax = min(PUBMED_ESEARCH_PAGE_SIZE, target - retstart)
        page_params = {
            "db": "pubmed",
            "query_key": query_key,
            "WebEnv": webenv,
            "retstart": retstart,
            "retmax": retmax,
            "retmode": "xml",
            "sort": "relevance",
        }
        page_params.update(_contact_params())
        page_resp = requests.post(f"{BASE_URL}/esearch.fcgi", data=page_params, timeout=PUBMED_SEARCH_TIMEOUT)
        page_resp.raise_for_status()
        page_pmids = _ids_from_esearch_xml(page_resp.text)
        if not page_pmids:
            logger.warning("PubMed history page returned no IDs at retstart=%s; stopping early.", retstart)
            break
        pmids.extend(page_pmids)
        retstart += len(page_pmids)
        if len(page_pmids) < retmax:
            break
    return pmids[:max_results]


def search(query: str, max_results: int = 200, min_date: str = None, max_date: str = None) -> list[str]:
    """Search PubMed and return a list of PMIDs.

    Args:
        query: PubMed search string (can include MeSH terms, Boolean operators)
        max_results: Maximum number of results to retrieve
        min_date/max_date: Date range filter (YYYY/MM/DD format)

    Returns:
        List of PMID strings
    """
    max_results = max(0, int(max_results or 0))
    if max_results <= 0:
        return []
    if max_results > PUBMED_ESEARCH_PAGE_SIZE:
        pmids = _search_with_history(
            query,
            max_results=max_results,
            min_date=min_date,
            max_date=max_date,
        )
        logger.info(f"PubMed search returned {len(pmids)} results for: {query[:80]}...")
        return pmids

    params = _search_params(query=query, retmax=max_results, min_date=min_date, max_date=max_date)

    resp = requests.post(f"{BASE_URL}/esearch.fcgi", data=params, timeout=PUBMED_SEARCH_TIMEOUT)
    resp.raise_for_status()

    pmids = _ids_from_esearch_xml(resp.text)
    logger.info(f"PubMed search returned {len(pmids)} results for: {query[:80]}...")
    return pmids


def fetch_details(pmids: list[str], batch_size: int = 50) -> list[dict]:
    """Fetch detailed metadata for a list of PMIDs.

    Returns list of dicts with: pmid, title, abstract, authors, year, journal, doi
    """
    if not pmids:
        return []

    all_papers = []
    for i in range(0, len(pmids), batch_size):
        batch = pmids[i:i + batch_size]
        params = {
            "db": "pubmed",
            "id": ",".join(batch),
            "retmode": "xml",
            "rettype": "abstract",
        }
        params.update(_contact_params())

        # Retry on transient network errors
        resp = None
        fetch_ok = False
        for attempt in range(3):
            try:
                resp = requests.get(f"{BASE_URL}/efetch.fcgi", params=params, timeout=PUBMED_FETCH_TIMEOUT)
                resp.raise_for_status()
                fetch_ok = True
                break
            except (requests.exceptions.ChunkedEncodingError,
                    requests.exceptions.ConnectionError,
                    requests.exceptions.Timeout) as e:
                logger.warning(f"PubMed fetch batch {i//batch_size + 1} attempt {attempt + 1} failed: {e}")
                if attempt < 2:
                    time.sleep(2 ** attempt)

        if not fetch_ok:
            logger.error(f"PubMed fetch batch {i//batch_size + 1} failed after 3 attempts, skipping {len(batch)} PMIDs")
            continue

        try:
            root = ET.fromstring(resp.text)
            for article in root.findall(".//PubmedArticle"):
                paper = _parse_article(article)
                if paper:
                    all_papers.append(paper)
        except ET.ParseError as e:
            logger.warning(f"XML parse error for batch {i//batch_size + 1}: {e}")

        # Rate limiting: 3 req/s without key, 10 req/s with key
        time.sleep(0.35 if PUBMED_API_KEY else 1.1)

    logger.info(f"Fetched details for {len(all_papers)} papers")
    return all_papers


def _parse_article(article_elem) -> dict | None:
    """Parse a PubmedArticle XML element into a dict."""
    try:
        medline = article_elem.find(".//MedlineCitation")
        art = medline.find(".//Article")

        pmid = medline.findtext("PMID", "")
        title = art.findtext(".//ArticleTitle", "")

        # Abstract
        abstract_parts = []
        for ab in art.findall(".//Abstract/AbstractText"):
            label = ab.get("Label", "")
            text = ab.text or ""
            if label:
                abstract_parts.append(f"{label}: {text}")
            else:
                abstract_parts.append(text)
        abstract = " ".join(abstract_parts)

        # Authors
        authors = []
        for author in art.findall(".//AuthorList/Author"):
            last = author.findtext("LastName", "")
            fore = author.findtext("ForeName", "")
            if last:
                authors.append(f"{last} {fore}".strip())

        # Journal
        journal = art.findtext(".//Journal/Title", "")
        volume = art.findtext(".//Journal/JournalIssue/Volume", "")
        issue = art.findtext(".//Journal/JournalIssue/Issue", "")
        pages = art.findtext(".//Pagination/MedlinePgn", "")

        # Year
        year_text = art.findtext(".//Journal/JournalIssue/PubDate/Year", "")
        if not year_text:
            year_text = art.findtext(".//Journal/JournalIssue/PubDate/MedlineDate", "")[:4] if art.findtext(".//Journal/JournalIssue/PubDate/MedlineDate") else "0"
        year = _parse_year(year_text)

        epub_year = 0
        for article_date in art.findall(".//ArticleDate"):
            date_type = (article_date.get("DateType") or "").lower()
            if date_type in {"", "electronic", "epublish"}:
                epub_year = _parse_year(article_date.findtext("Year", ""))
                if epub_year:
                    break
        if not epub_year:
            for pub_date in article_elem.findall(".//PubmedData/History/PubMedPubDate"):
                pub_status = (pub_date.get("PubStatus") or "").lower()
                if pub_status in {"aheadofprint", "epublish"}:
                    epub_year = _parse_year(pub_date.findtext("Year", ""))
                    if epub_year:
                        break

        # DOI
        doi = ""
        for eid in article_elem.findall(".//PubmedData/ArticleIdList/ArticleId"):
            if eid.get("IdType") == "doi":
                doi = eid.text or ""
                break

        # Publication type
        pub_types = [pt.text for pt in art.findall(".//PublicationTypeList/PublicationType") if pt.text]

        paper = {
            "pmid": pmid,
            "title": title,
            "abstract": abstract,
            "authors": authors,
            "year": year,
            "journal": journal,
            "volume": volume,
            "issue": issue,
            "pages": pages,
            "doi": doi,
            "pub_types": pub_types,
        }
        if epub_year:
            paper["epub_year"] = epub_year
        return paper
    except Exception as e:
        logger.warning(f"Failed to parse article: {e}")
        return None
