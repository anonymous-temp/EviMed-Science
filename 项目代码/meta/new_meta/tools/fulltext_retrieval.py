"""Automatic full-text retrieval for one paper: route order, bounds, provenance.

Routes, cheapest and most likely first (2026-09-28, measured from the Beijing
production host, where every nih.gov web page and most large publishers answer
with a Cloudflare 403 while the Europe PMC REST API, OpenAlex, Crossref,
Springer/BMC, Frontiers and Nature answer normally):

1. ``europe_pmc_xml``    — PMC papers: Europe PMC fullTextXML (ebi.ac.uk REST)
2. ``europe_pmc_pdf``    — PMC papers: europepmc.org ``?pdf=render``
3. ``record_pdf_url``    — PDF URLs the search record already carries
4. ``openalex_pdf``      — every OpenAlex location's pdf_url
5. ``unpaywall_pdf``     — Unpaywall url_for_pdf (only with a contact address)
6. ``oa_landing``        — OA landing pages, read for citation_pdf_url
7. ``doi``               — the DOI's registered URL: a PDF, or its landing page
8. ``ncbi_pmc_pdf``      — the NCBI PMC PDF, last (blocked from Beijing)
9. ``ncbi_pmc_html``     — the NCBI PMC article page as text, last
then ``europe_pmc_abstract`` (abstract only — not full text) or ``none``.

A route that reached a PDF through a landing page is recorded with a
``+citation_pdf_url`` suffix. Every attempt (route, host, url, outcome) is kept
on the paper as ``fulltext_attempts`` and the winning route as
``fulltext_route``, so the PRISMA "reports not retrieved" count can be traced.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any
from urllib.parse import quote

import requests

from new_meta.config import SCIHUB_BASE_URL, SCIHUB_ENABLED, UNPAYWALL_EMAIL
from new_meta.tools import multi_search
from new_meta.tools.fulltext import (
    EUROPE_PMC_FULLTEXT_XML_URL,
    PMC_HTML_URL,
    europe_pmc_fulltext_links,
    fetch_europe_pmc_abstract_text,
    fetch_europe_pmc_fulltext_xml,
    fetch_europe_pmc_record,
    fetch_html_fulltext_url,
)
from new_meta.tools.pdf_downloader import (
    HostMemo,
    PaperBudget,
    _try_scihub_download,
    fetch_pdf_url,
    resolve_doi_url,
)

logger = logging.getLogger("metaagent.fulltext_retrieval")

ROUTE_EUROPE_PMC_XML = "europe_pmc_xml"
ROUTE_EUROPE_PMC_PDF = "europe_pmc_pdf"
ROUTE_RECORD_PDF = "record_pdf_url"
ROUTE_OPENALEX_PDF = "openalex_pdf"
ROUTE_UNPAYWALL_PDF = "unpaywall_pdf"
ROUTE_OA_LANDING = "oa_landing"
ROUTE_DOI = "doi"
ROUTE_NCBI_PMC_PDF = "ncbi_pmc_pdf"
ROUTE_NCBI_PMC_HTML = "ncbi_pmc_html"
ROUTE_SCIHUB = "scihub"
ROUTE_EUROPE_PMC_ABSTRACT = "europe_pmc_abstract"
ROUTE_CACHED_PDF = "cached_pdf"
ROUTE_NONE = "none"

UNPAYWALL_API = "https://api.unpaywall.org/v2/{doi}"
NCBI_PMC_PDF_URL = "https://pmc.ncbi.nlm.nih.gov/articles/{pmcid}/pdf/"
EUROPE_PMC_XML_TIMEOUT = 30.0
METADATA_TIMEOUT = 12.0
_NCBI_HOST_MARKERS = ("ncbi.nlm.nih.gov", ".nih.gov/")


def normalize_doi(value: Any) -> str:
    doi = str(value or "").strip()
    doi = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", doi, flags=re.IGNORECASE)
    return doi.strip()


def normalize_pmcid(value: Any) -> str:
    text = str(value or "").strip()
    match = re.search(r"(?:PMC)?(\d+)", text, flags=re.IGNORECASE) if text else None
    if not match:
        return ""
    if not text.upper().startswith("PMC") and not text.isdigit() and "/pmc/" not in text.lower():
        return ""
    return f"PMC{match.group(1)}"


def _pmcid_in(value: str) -> str:
    match = re.search(r"/pmc/articles/(?:PMC)?(\d+)|\bPMC(\d+)\b|pubmedcentral\.nih\.gov:(\d+)",
                      str(value or ""), flags=re.IGNORECASE)
    if not match:
        return ""
    return f"PMC{match.group(1) or match.group(2) or match.group(3)}"


def _is_ncbi(url: str) -> bool:
    lowered = str(url or "").lower()
    return any(marker in lowered for marker in _NCBI_HOST_MARKERS)


def _ncbi_last(urls: list[str]) -> list[str]:
    """NCBI web hosts are the least likely to answer; keep them for the end."""
    return [u for u in urls if not _is_ncbi(u)] + [u for u in urls if _is_ncbi(u)]


def _record_urls(paper: dict) -> list[str]:
    raw = paper.get("pdf_urls") or paper.get("pdf_url") or paper.get("url") or []
    raw = list(raw) if isinstance(raw, (list, tuple)) else [raw]
    urls: list[str] = []
    for item in raw:
        item = str(item or "").strip()
        if item and item not in urls:
            urls.append(item)
    return urls


def get_unpaywall_locations(doi: str, email: str, *, timeout: float = METADATA_TIMEOUT) -> dict[str, Any]:
    """Unpaywall's OA locations for a DOI: PDF URLs (best first), landing pages,
    and a PMCID when a location is PubMed Central. Empty without an email.

    The email travels only as the query parameter Unpaywall requires; it is
    never logged (exceptions are logged by class name, since their messages
    carry the request URL).
    """
    empty: dict[str, Any] = {"pdf_urls": [], "landing_urls": [], "pmcid": ""}
    doi = normalize_doi(doi)
    email = str(email or "").strip()
    if not doi or not email:
        return empty
    try:
        resp = requests.get(
            UNPAYWALL_API.format(doi=quote(doi, safe="/")),
            params={"email": email},
            headers={"User-Agent": "MetaAgent/1.0"},
            timeout=timeout,
        )
        status = int(getattr(resp, "status_code", 0) or 0)
        if status != 200:
            logger.debug("Unpaywall lookup for %s answered HTTP %s", doi, status)
            return empty
        data = resp.json() or {}
    except Exception as exc:
        logger.debug("Unpaywall lookup for %s failed: %s", doi, type(exc).__name__)
        return empty

    best = data.get("best_oa_location") or None
    locations = [best] if isinstance(best, dict) else []
    for location in data.get("oa_locations") or []:
        if isinstance(location, dict) and location not in locations:
            locations.append(location)

    pdf_urls: list[str] = []
    landing_urls: list[str] = []
    pmcid = ""
    for location in locations:
        pdf = str(location.get("url_for_pdf") or "").strip()
        landing = str(location.get("url_for_landing_page") or "").strip()
        pmcid = pmcid or _pmcid_in(landing) or _pmcid_in(pdf) or _pmcid_in(str(location.get("pmh_id") or ""))
        if pdf and pdf not in pdf_urls:
            pdf_urls.append(pdf)
        if landing and landing not in landing_urls and landing not in pdf_urls:
            lowered = landing.lower()
            if "doi.org/" in lowered or _is_ncbi(landing):
                continue
            landing_urls.append(landing)
    return {"pdf_urls": pdf_urls, "landing_urls": landing_urls, "pmcid": pmcid}


def retrieve_paper_text(
    paper: dict,
    papers_dir: Path,
    *,
    memo: HostMemo,
    budget: PaperBudget | None = None,
    unpaywall_email: str | None = None,
) -> dict:
    """Retrieve full text for ``paper`` (mutated in place and returned).

    Sets ``pdf_path`` / ``fulltext_path`` / ``fulltext_source`` /
    ``text_availability`` as before, plus ``fulltext_route`` and
    ``fulltext_attempts``.
    """
    budget = budget if budget is not None else PaperBudget()
    email = UNPAYWALL_EMAIL if unpaywall_email is None else unpaywall_email
    papers_dir = Path(papers_dir)
    pmid = str(paper.get("pmid") or "").strip()
    doi = normalize_doi(paper.get("doi"))
    identifier = pmid or doi.replace("/", "_") or f"paper_{id(paper)}"
    pdf_path = str(papers_dir / f"{identifier}.pdf")
    text_path = str(papers_dir / f"{identifier}.fulltext.txt")
    abstract_path = str(papers_dir / f"{identifier}.abstract.txt")

    def finish(route: str, *, kind: str) -> dict:
        paper["fulltext_route"] = route
        paper["fulltext_attempts"] = budget.attempts
        stop = budget.exhausted()
        if stop and kind in {"abstract", "none"}:
            paper["fulltext_retrieval_stopped"] = stop
        else:
            paper.pop("fulltext_retrieval_stopped", None)
        if kind == "pdf":
            paper["pdf_path"] = pdf_path
            paper.pop("fulltext_path", None)
            paper["text_availability"] = "full_text"
            paper["fulltext_source"] = "pdf"
        elif kind == "text":
            paper["pdf_path"] = None
            paper["fulltext_path"] = text_path
            paper["fulltext_source"] = "europe_pmc_fulltext"
            paper["text_availability"] = "full_text"
        elif kind == "abstract":
            paper["pdf_path"] = None
            paper["fulltext_path"] = abstract_path
            paper["fulltext_source"] = "europe_pmc_abstract"
            paper["text_availability"] = "abstract_only"
        else:
            paper["pdf_path"] = None
            paper["fulltext_path"] = None
            paper.pop("fulltext_source", None)
            paper.pop("text_availability", None)
        return paper

    if Path(pdf_path).exists():
        return finish(ROUTE_CACHED_PDF, kind="pdf")

    def tried(url: str) -> bool:
        return any(attempt.get("url") == url for attempt in budget.attempts)

    def try_pdf(url: str, route: str) -> str:
        if not url or tried(url):
            return ""
        return fetch_pdf_url(url, pdf_path, route=route, memo=memo, budget=budget)

    def try_xml(pmcid: str) -> bool:
        url = EUROPE_PMC_FULLTEXT_XML_URL.format(pmcid=pmcid)
        if tried(url):
            return False
        blocked = memo.blocked_reason(url)
        if blocked:
            budget.record(ROUTE_EUROPE_PMC_XML, url, f"skipped_{blocked}")
            return False
        spent = budget.exhausted()
        if spent:
            budget.record(ROUTE_EUROPE_PMC_XML, url, f"skipped_{spent}")
            return False
        budget.spend()
        ok = fetch_europe_pmc_fulltext_xml(
            pmcid=pmcid,
            save_path=text_path,
            timeout=budget.timeout(EUROPE_PMC_XML_TIMEOUT),
        )
        budget.record(ROUTE_EUROPE_PMC_XML, url, "text" if ok else "no_text")
        return ok

    # --- Europe PMC record: PMCID and Europe PMC's own full-text links -------
    record: dict[str, Any] = {}
    if (pmid or doi) and budget.remaining() > 0:
        record = fetch_europe_pmc_record(pmid=pmid, doi=doi, timeout=budget.timeout(METADATA_TIMEOUT))
    links = europe_pmc_fulltext_links(record) if record else {"pmcid": "", "pdf_urls": [], "html_url": ""}
    pmcid = normalize_pmcid(paper.get("pmcid")) or normalize_pmcid(links.get("pmcid"))
    if pmcid:
        paper["pmcid"] = pmcid
    if links.get("html_url") and not paper.get("fulltext_url"):
        paper["fulltext_url"] = links["html_url"]

    # 1-2. PMC papers: Europe PMC XML, then Europe PMC's PDF rendering.
    if pmcid and try_xml(pmcid):
        return finish(ROUTE_EUROPE_PMC_XML, kind="text")
    epmc_pdfs = list(links.get("pdf_urls") or [])
    if pmcid and not epmc_pdfs:
        epmc_pdfs = [f"https://europepmc.org/articles/{pmcid}?pdf=render"]
    for url in epmc_pdfs:
        route = try_pdf(url, ROUTE_EUROPE_PMC_PDF)
        if route:
            return finish(route, kind="pdf")

    # 3. PDF URLs the search record already carries.
    record_urls = _record_urls(paper)
    for url in _ncbi_last(record_urls):
        route = try_pdf(url, ROUTE_RECORD_PDF)
        if route:
            return finish(route, kind="pdf")

    # 4. OpenAlex: every location's pdf_url; a PMCID it knows goes back to 1.
    openalex: dict[str, Any] = {"pdf_urls": [], "landing_urls": [], "pmcid": ""}
    if doi and not budget.exhausted():
        openalex = multi_search.get_openalex_locations_for_doi(doi, timeout=budget.timeout(METADATA_TIMEOUT))
    if not pmcid and openalex.get("pmcid"):
        pmcid = normalize_pmcid(openalex["pmcid"])
        paper["pmcid"] = pmcid
        if try_xml(pmcid):
            return finish(ROUTE_EUROPE_PMC_XML, kind="text")
    for url in _ncbi_last(list(openalex.get("pdf_urls") or [])):
        route = try_pdf(url, ROUTE_OPENALEX_PDF)
        if route:
            return finish(route, kind="pdf")

    # 5. Unpaywall (only with a configured contact address).
    unpaywall: dict[str, Any] = {"pdf_urls": [], "landing_urls": [], "pmcid": ""}
    if doi and email and not budget.exhausted():
        unpaywall = get_unpaywall_locations(doi, email, timeout=budget.timeout(METADATA_TIMEOUT))
    if not pmcid and unpaywall.get("pmcid"):
        pmcid = normalize_pmcid(unpaywall["pmcid"])
        paper["pmcid"] = pmcid
        if try_xml(pmcid):
            return finish(ROUTE_EUROPE_PMC_XML, kind="text")
    for url in _ncbi_last(list(unpaywall.get("pdf_urls") or [])):
        route = try_pdf(url, ROUTE_UNPAYWALL_PDF)
        if route:
            return finish(route, kind="pdf")

    # 6. OA landing pages -> citation_pdf_url (one hop).
    for url in list(openalex.get("landing_urls") or []) + list(unpaywall.get("landing_urls") or []):
        route = try_pdf(url, ROUTE_OA_LANDING)
        if route:
            return finish(route, kind="pdf")

    # 7. The DOI's registered URL: a PDF, or a landing page declaring one.
    if doi and not budget.exhausted():
        target = resolve_doi_url(doi, timeout=budget.timeout(10))
        route = try_pdf(target, ROUTE_DOI)
        if route:
            return finish(route, kind="pdf")

    # 8. NCBI PMC PDF, last: from Beijing the whole nih.gov family is a
    #    Cloudflare 403, and the host memo stops paying for it after one answer.
    if pmcid:
        route = try_pdf(NCBI_PMC_PDF_URL.format(pmcid=pmcid), ROUTE_NCBI_PMC_PDF)
        if route:
            return finish(route, kind="pdf")

    if SCIHUB_ENABLED and SCIHUB_BASE_URL and (doi or pmid):
        if _try_scihub_download(doi or pmid, pdf_path, 1):
            budget.record(ROUTE_SCIHUB, SCIHUB_BASE_URL, "pdf")
            return finish(ROUTE_SCIHUB, kind="pdf")

    # 9. NCBI PMC article page as text.
    if pmcid:
        url = PMC_HTML_URL.format(pmcid=pmcid)
        blocked = memo.blocked_reason(url)
        spent = budget.exhausted()
        if blocked or spent:
            budget.record(ROUTE_NCBI_PMC_HTML, url, f"skipped_{blocked or spent}")
        else:
            budget.spend()
            ok = fetch_html_fulltext_url(
                url,
                save_path=text_path,
                timeout=budget.timeout(15),
                source_label="PMC article HTML",
            )
            budget.record(ROUTE_NCBI_PMC_HTML, url, "text" if ok else "no_text")
            if ok:
                return finish(ROUTE_NCBI_PMC_HTML, kind="text")

    # Abstract only (not full text): reuse the Europe PMC record already held.
    if record and fetch_europe_pmc_abstract_text(
        pmid=pmid,
        doi=doi,
        save_path=abstract_path,
        record=record,
    ):
        return finish(ROUTE_EUROPE_PMC_ABSTRACT, kind="abstract")
    return finish(ROUTE_NONE, kind="none")


def summarize_routes(papers: list[dict], memo: HostMemo) -> dict[str, Any]:
    """Run-level retrieval provenance: papers per winning route, blocked hosts."""
    by_route: dict[str, int] = {}
    for paper in papers:
        route = str(paper.get("fulltext_route") or "")
        if not route:
            continue
        by_route[route] = by_route.get(route, 0) + 1
    return {
        "papers": len(papers),
        "by_route": dict(sorted(by_route.items())),
        "blocked_hosts": memo.snapshot(),
        "per_paper": [
            {
                "pmid": paper.get("pmid", ""),
                "doi": paper.get("doi", ""),
                "route": paper.get("fulltext_route", ""),
                "fulltext_source": paper.get("fulltext_source", ""),
                "text_availability": paper.get("text_availability", ""),
                "attempts": len(paper.get("fulltext_attempts") or []),
                "stopped": paper.get("fulltext_retrieval_stopped", ""),
            }
            for paper in papers
            if paper.get("fulltext_route")
        ],
    }
