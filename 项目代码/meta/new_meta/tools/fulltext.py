"""Full-text fallback retrieval for non-PDF open access articles."""
from __future__ import annotations

import logging
import re
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

import requests

logger = logging.getLogger("metaagent.fulltext")

EUROPE_PMC_SEARCH_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
EUROPE_PMC_FULLTEXT_XML_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/{pmcid}/fullTextXML"
PMC_HTML_URL = "https://pmc.ncbi.nlm.nih.gov/articles/{pmcid}/"
HEADERS = {
    "User-Agent": "MetaAgent/1.0 (mailto:metaagent@research.ai)",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


def fetch_europe_pmc_fulltext(
    *,
    pmid: str = "",
    doi: str = "",
    save_path: str,
    timeout: float = 15,
) -> bool:
    """Fetch free Europe PMC/PubMedCentral full text as normalized text.

    This is intentionally separate from PDF downloading. It gives the pipeline
    citable full-text content when publisher PDFs are blocked but Europe PMC
    exposes machine-readable XML or an HTML full text page.
    """
    record = fetch_europe_pmc_record(pmid=pmid, doi=doi, timeout=timeout)
    links = europe_pmc_fulltext_links(record) if record else {}
    pmcid = links.get("pmcid", "")
    if pmcid and fetch_europe_pmc_fulltext_xml(
        pmcid=pmcid,
        save_path=save_path,
        timeout=timeout,
    ):
        return True

    url = find_europe_pmc_html_url(record=record, pmid=pmid, doi=doi, timeout=timeout)
    if url and fetch_html_fulltext_url(
        url,
        save_path=save_path,
        timeout=timeout,
        source_label="Europe PMC HTML",
    ):
        return True

    if pmcid:
        pmc_url = PMC_HTML_URL.format(pmcid=pmcid)
        if fetch_html_fulltext_url(
            pmc_url,
            save_path=save_path,
            timeout=timeout,
            source_label="PMC article HTML",
        ):
            return True
    return False


def fetch_html_fulltext_url(
    url: str,
    *,
    save_path: str,
    timeout: float = 15,
    source_label: str = "HTML full text",
    min_chars: int = 1000,
) -> bool:
    """Fetch readable article/page text from a URL and save it as plain text."""
    if not url:
        return False
    try:
        resp = requests.get(url, headers=HEADERS, timeout=timeout)
        resp.raise_for_status()
    except Exception as exc:
        logger.debug(f"HTML full-text fetch failed for {url}: {exc}")
        return False

    text = html_to_text(resp.text)
    if len(text) < min_chars:
        logger.debug(f"HTML full-text too short for {url}: {len(text)} chars")
        return False

    output = "\n".join(
        [
            f"SOURCE: {source_label}",
            f"URL: {url}",
            "",
            text,
        ]
    ).strip()
    Path(save_path).parent.mkdir(parents=True, exist_ok=True)
    Path(save_path).write_text(output, encoding="utf-8")
    logger.info(f"Full text saved: {save_path}")
    return True


def fetch_europe_pmc_fulltext_xml(
    *,
    pmcid: str,
    save_path: str,
    timeout: float = 15,
) -> bool:
    """Fetch Europe PMC's fullTextXML endpoint and save readable article text."""
    if not pmcid:
        return False
    try:
        resp = requests.get(
            EUROPE_PMC_FULLTEXT_XML_URL.format(pmcid=pmcid),
            headers=HEADERS,
            timeout=timeout,
        )
        if resp.status_code == 404:
            return False
        resp.raise_for_status()
    except Exception as exc:
        logger.debug(f"Europe PMC fullTextXML fetch failed for {pmcid}: {exc}")
        return False

    text = jats_xml_to_text(resp.text)
    if len(text) < 1000:
        logger.debug(f"Europe PMC fullTextXML too short for {pmcid}: {len(text)} chars")
        return False

    output = "\n".join(
        [
            "SOURCE: Europe PMC fullTextXML",
            f"IDENTIFIERS: PMCID {pmcid}",
            "",
            text,
        ]
    ).strip()
    Path(save_path).parent.mkdir(parents=True, exist_ok=True)
    Path(save_path).write_text(output, encoding="utf-8")
    logger.info(f"Full text XML saved: {save_path}")
    return True


def fetch_europe_pmc_abstract_text(
    *,
    pmid: str = "",
    doi: str = "",
    save_path: str,
    timeout: float = 15,
) -> bool:
    """Save Europe PMC's structured abstract as an explicit low-confidence source.

    This is not a full-text substitute. It exists so the pipeline can still
    screen and extract visibly marked abstract-only evidence when publisher PDFs
    are blocked and no open full text is available.
    """
    record = fetch_europe_pmc_record(pmid=pmid, doi=doi, timeout=timeout)
    if not record:
        return False

    text = europe_pmc_record_to_text(record)
    if len(text) < 500:
        logger.debug(
            "Europe PMC abstract fallback too short for %s: %s chars",
            pmid or doi,
            len(text),
        )
        return False

    Path(save_path).parent.mkdir(parents=True, exist_ok=True)
    Path(save_path).write_text(text, encoding="utf-8")
    logger.info(f"Abstract-only evidence saved: {save_path}")
    return True


def fetch_europe_pmc_record(
    *,
    pmid: str = "",
    doi: str = "",
    timeout: float = 15,
) -> dict[str, Any]:
    """Fetch Europe PMC core metadata for a PMID or DOI."""
    query = f"EXT_ID:{pmid}" if pmid else f"DOI:{doi}" if doi else ""
    if not query:
        return {}

    try:
        resp = requests.get(
            EUROPE_PMC_SEARCH_URL,
            params={
                "query": query,
                "format": "json",
                "pageSize": 1,
                "resultType": "core",
            },
            headers=HEADERS,
            timeout=timeout,
        )
        resp.raise_for_status()
        results = resp.json().get("resultList", {}).get("result", [])
    except Exception as exc:
        logger.debug(f"Europe PMC record fetch failed for {query}: {exc}")
        return {}

    return results[0] if results else {}


def europe_pmc_fulltext_links(record: dict[str, Any]) -> dict[str, Any]:
    """Extract useful free/full-text links from a Europe PMC record."""
    pmcid = record.get("pmcid") or ""
    links = {
        "pmcid": pmcid,
        "pdf_urls": [],
        "html_url": "",
    }
    urls = (record.get("fullTextUrlList") or {}).get("fullTextUrl") or []
    for item in urls:
        availability = (item.get("availabilityCode") or "").upper()
        style = (item.get("documentStyle") or "").lower()
        url = item.get("url") or ""
        if availability not in {"F", "OA"} or not url:
            continue
        if style == "pdf":
            links["pdf_urls"].append(url)
        elif style == "html" and not links["html_url"]:
            links["html_url"] = url

    if pmcid:
        render_url = f"https://europepmc.org/articles/{pmcid}?pdf=render"
        if render_url not in links["pdf_urls"]:
            links["pdf_urls"].append(render_url)
        if not links["html_url"]:
            links["html_url"] = f"https://europepmc.org/articles/{pmcid}"
    return links


def get_europe_pmc_pdf_urls(
    *,
    pmid: str = "",
    doi: str = "",
    timeout: float = 15,
) -> tuple[list[str], str, str]:
    """Return Europe PMC PDF URL candidates, HTML URL, and PMCID."""
    record = fetch_europe_pmc_record(pmid=pmid, doi=doi, timeout=timeout)
    if not record:
        return [], "", ""
    links = europe_pmc_fulltext_links(record)
    return links["pdf_urls"], links["html_url"], links["pmcid"]


def europe_pmc_record_to_text(record: dict[str, Any]) -> str:
    """Render Europe PMC metadata and structured abstract as readable text."""
    title = record.get("title") or ""
    journal = record.get("journalTitle") or record.get("journalInfo", {}).get("journal", {}).get("title") or ""
    year = record.get("pubYear") or ""
    pmid = record.get("pmid") or record.get("id") or ""
    doi = record.get("doi") or ""
    pmcid = record.get("pmcid") or ""
    abstract = html_to_text(record.get("abstractText") or "")

    lines = [
        "SOURCE: Europe PMC structured abstract only",
        "SOURCE_LIMITATION: Publisher PDF/full text was not retrievable automatically; verify extracted data manually.",
    ]
    if title:
        lines.append(f"TITLE: {title}")
    citation_bits = [bit for bit in [journal, str(year)] if bit]
    if citation_bits:
        lines.append(f"CITATION: {', '.join(citation_bits)}")
    id_bits = []
    if pmid:
        id_bits.append(f"PMID {pmid}")
    if doi:
        id_bits.append(f"DOI {doi}")
    if pmcid:
        id_bits.append(f"PMCID {pmcid}")
    if id_bits:
        lines.append(f"IDENTIFIERS: {'; '.join(id_bits)}")
    if abstract:
        lines.extend(["", "ABSTRACT", abstract])

    return "\n".join(lines).strip()


def find_europe_pmc_html_url(
    *,
    record: dict[str, Any] | None = None,
    pmid: str = "",
    doi: str = "",
    timeout: float = 15,
) -> str:
    """Find a free Europe PMC/PubMedCentral HTML full-text URL."""
    if record:
        links = europe_pmc_fulltext_links(record)
        return links["html_url"]

    query = f"EXT_ID:{pmid}" if pmid else f"DOI:{doi}" if doi else ""
    if not query:
        return ""

    try:
        resp = requests.get(
            EUROPE_PMC_SEARCH_URL,
            params={
                "query": query,
                "format": "json",
                "pageSize": 1,
                "resultType": "core",
            },
            headers=HEADERS,
            timeout=timeout,
        )
        resp.raise_for_status()
        results = resp.json().get("resultList", {}).get("result", [])
    except Exception as exc:
        logger.debug(f"Europe PMC search failed for {query}: {exc}")
        return ""

    if not results:
        return ""

    links = europe_pmc_fulltext_links(results[0])
    return links["html_url"]


def html_to_text(html: str) -> str:
    """Convert article HTML to readable plain text with coarse section spacing."""
    parser = _ArticleHTMLTextParser()
    parser.feed(html)
    text = parser.get_text()
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def jats_xml_to_text(xml: str) -> str:
    """Convert Europe PMC/JATS XML to readable text, including tables."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return html_to_text(xml)

    parts: list[str] = []
    _append_xml_text(root, parts)
    text = "".join(parts)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _append_xml_text(node: ET.Element, parts: list[str]) -> None:
    tag = node.tag.rsplit("}", 1)[-1].lower()
    block_tags = {
        "abstract", "article-title", "body", "caption", "fig", "p", "sec",
        "table", "tbody", "thead", "title", "tr",
    }
    inline_break_tags = {"br", "td", "th"}

    if tag in block_tags:
        parts.append("\n")
    if node.text and node.text.strip():
        parts.append(node.text.strip())
        parts.append(" ")
    for child in list(node):
        _append_xml_text(child, parts)
        if child.tail and child.tail.strip():
            parts.append(child.tail.strip())
            parts.append(" ")
    if tag in block_tags:
        parts.append("\n")
    elif tag in inline_break_tags:
        parts.append(" | ")


class _ArticleHTMLTextParser(HTMLParser):
    """Small dependency-free HTML text extractor."""

    _BLOCK_TAGS = {
        "article",
        "section",
        "div",
        "p",
        "br",
        "table",
        "tr",
        "li",
        "h1",
        "h2",
        "h3",
        "h4",
    }

    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in {"script", "style", "noscript", "svg"}:
            self._skip_depth += 1
            return
        if tag in self._BLOCK_TAGS:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg"} and self._skip_depth:
            self._skip_depth -= 1
            return
        if tag in self._BLOCK_TAGS:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        cleaned = data.strip()
        if cleaned:
            self._parts.append(cleaned)
            self._parts.append(" ")

    def get_text(self) -> str:
        return "".join(self._parts)
