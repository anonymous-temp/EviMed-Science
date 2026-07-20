"""Reference manager — BibTeX generation and citation formatting."""
from __future__ import annotations

import logging
import re
from urllib.parse import quote

import requests

from new_meta.tools.utils import first_author_lastname

logger = logging.getLogger("metaagent.reference_manager")

_CROSSREF_CACHE: dict[str, dict] = {}


class ReferenceManager:
    """Manage references for the manuscript."""

    def __init__(self):
        self.entries: list[dict] = []  # List of paper metadata dicts
        self._id_map: dict[str, int] = {}  # study_id → citation number
        self._fingerprint_map: dict[str, int] = {}  # normalized reference identity → citation number

    def add(self, paper: dict, study_id: str = None):
        """Add a reference. paper should have: title, authors, year, journal, doi, pmid."""
        paper = self._enrich_metadata(dict(paper or {}))
        key = study_id or paper.get("pmid", "") or paper.get("doi", "")
        fingerprint = self._fingerprint(paper)

        if fingerprint and fingerprint in self._fingerprint_map:
            idx = self._fingerprint_map[fingerprint]
            self._merge_entry(idx, paper)
            if key and key not in self._id_map:
                self._id_map[key] = idx
            return

        if key and key in self._id_map:
            return

        self.entries.append(paper)
        idx = len(self.entries)
        if not key:
            key = f"_ref_{idx}"
        self._id_map[key] = idx
        if fingerprint:
            self._fingerprint_map[fingerprint] = idx

    def cite(self, study_id: str) -> str:
        """Get citation number string like '[1]'."""
        num = self._id_map.get(study_id, 0)
        return f"[{num}]" if num else "[?]"

    def get_author_year(self, paper: dict) -> str:
        """Format as 'FirstAuthor et al., Year'."""
        authors = paper.get("authors", [])
        year = paper.get("year", "")
        if not authors:
            return f"Unknown, {year}"
        prefer_display_order = str(paper.get("source") or "").lower() != "pubmed"
        first = first_author_lastname([authors[0]], prefer_display_order=prefer_display_order)
        if len(authors) > 2:
            return f"{first} et al., {year}"
        elif len(authors) == 2:
            second = first_author_lastname([authors[1]], prefer_display_order=prefer_display_order)
            return f"{first} & {second}, {year}"
        return f"{first}, {year}"

    def to_bibtex(self) -> str:
        """Generate BibTeX file content."""
        entries_str = []
        for i, paper in enumerate(self.entries, 1):
            key = self._make_bibtex_key(paper, i)
            authors_bib = self._format_bibtex_authors(paper.get("authors", ["Unknown"]))
            entry = (
                f"@article{{{key},\n"
                f"  title = {{{paper.get('title', '')}}},\n"
                f"  author = {{{authors_bib}}},\n"
                f"  journal = {{{paper.get('journal', '')}}},\n"
                f"  year = {{{paper.get('year', '')}}},\n"
                f"  volume = {{{paper.get('volume', '')}}},\n"
                f"  issue = {{{paper.get('issue', '')}}},\n"
                f"  pages = {{{paper.get('pages', '')}}},\n"
                f"  doi = {{{paper.get('doi', '')}}},\n"
                f"  pmid = {{{paper.get('pmid', '')}}},\n"
                f"  url = {{{paper.get('url', '')}}},\n"
                f"}}"
            )
            entries_str.append(entry)
        return "\n\n".join(entries_str)

    def to_numbered_list(self) -> str:
        """Generate a numbered reference list for the manuscript."""
        lines = []
        for i, paper in enumerate(self.entries, 1):
            authors = paper.get("authors", [])
            if len(authors) > 6:
                author_str = ", ".join(authors[:6]) + ", et al."
            else:
                author_str = ", ".join(authors)
            title = paper.get("title", "")
            journal = paper.get("journal", "")
            year = paper.get("year", "")
            volume = str(paper.get("volume") or "").strip()
            issue = str(paper.get("issue") or "").strip()
            pages = str(paper.get("pages") or paper.get("page") or "").strip()
            doi = paper.get("doi", "")

            journal_part = f"*{journal}*. " if journal else ""
            citation_detail = str(year or "").strip()
            if volume:
                citation_detail += f";{volume}"
                if issue:
                    citation_detail += f"({issue})"
                if pages:
                    citation_detail += f":{pages}"
            elif pages:
                citation_detail += f":{pages}"
            ref = f"[{i}] {author_str}. {title}. {journal_part}{citation_detail}."
            if doi:
                ref += f" doi: {doi}"
            if paper.get("url"):
                ref += f" {paper.get('url')}"
            lines.append(ref)
        return "\n\n".join(lines)

    @staticmethod
    def _make_bibtex_key(paper: dict, idx: int) -> str:
        authors = paper.get("authors", [])
        year = paper.get("year", "0000")
        if authors:
            prefer_display_order = str(paper.get("source") or "").lower() != "pubmed"
            first = first_author_lastname([authors[0]], prefer_display_order=prefer_display_order).lower()
        else:
            first = "unknown"
        first = re.sub(r"[^a-z0-9]+", "", first) or "unknown"
        year = re.sub(r"[^0-9A-Za-z]+", "", str(year)) or "0000"
        return f"{first}{year}_{idx}"

    @staticmethod
    def _fingerprint(paper: dict) -> str:
        pmid = str(paper.get("pmid") or "").strip().lower()
        if pmid:
            return f"pmid:{pmid}"
        doi = str(paper.get("doi") or "").strip().lower()
        if doi:
            return f"doi:{doi}"
        combined = " ".join(
            str(paper.get(field) or "")
            for field in ("title", "url", "registry_id", "registration_id", "trial_id")
        )
        nct_match = re.search(r"\bNCT\d{8}\b", combined, flags=re.IGNORECASE)
        if nct_match:
            return f"nct:{nct_match.group(0).lower()}"
        url = str(paper.get("url") or "").strip().lower().rstrip("/")
        if url:
            return f"url:{url}"
        title = " ".join(str(paper.get("title") or "").lower().split())
        year = str(paper.get("year") or "").strip()
        if title:
            return f"title:{title}|year:{year}"
        return ""

    def _merge_entry(self, idx: int, paper: dict) -> None:
        paper = self._enrich_metadata(dict(paper or {}))
        if idx <= 0 or idx > len(self.entries):
            return
        existing = self.entries[idx - 1]
        for field, value in paper.items():
            if value in (None, "", []):
                continue
            current = existing.get(field)
            if current in (None, "", []):
                existing[field] = value
                continue
            if field == "title" and len(str(value)) > len(str(current)):
                existing[field] = value
            elif field in {"authors", "journal"} and self._looks_placeholder(current) and not self._looks_placeholder(value):
                existing[field] = value
            elif field == "url" and value:
                existing[field] = value

    @staticmethod
    def _enrich_metadata(paper: dict) -> dict:
        doi = str(paper.get("doi") or "").strip()
        if not doi or not _reference_needs_doi_enrichment(paper):
            return paper
        metadata = _fetch_crossref_metadata(doi)
        for field in ("journal", "volume", "issue", "pages", "year"):
            if paper.get(field) in (None, "", []):
                value = metadata.get(field)
                if value not in (None, "", []):
                    paper[field] = value
        return paper

    @staticmethod
    def _looks_placeholder(value) -> bool:
        if isinstance(value, list):
            return len(value) <= 1 and bool(value) and len(str(value[0]).split()) <= 2
        text = str(value or "").strip()
        return bool(text) and len(text.split()) <= 2 and text.isupper()

    @staticmethod
    def _format_bibtex_authors(authors: list[str]) -> str:
        clean_authors = [str(author).strip() for author in (authors or []) if str(author).strip()]
        if not clean_authors:
            clean_authors = ["Unknown"]
        if len(clean_authors) > 50:
            clean_authors = clean_authors[:6] + ["others"]
        return " and ".join(clean_authors)


def _reference_needs_doi_enrichment(paper: dict) -> bool:
    return any(not str(paper.get(field) or "").strip() for field in ("journal", "volume", "pages"))


def _fetch_crossref_metadata(doi: str) -> dict:
    normalized = str(doi or "").strip().lower()
    if not normalized:
        return {}
    if normalized in _CROSSREF_CACHE:
        return dict(_CROSSREF_CACHE[normalized])
    try:
        response = requests.get(
            f"https://api.crossref.org/works/{quote(normalized, safe='')}",
            headers={"User-Agent": "MetaAgent reference metadata enrichment (mailto:metaagent@research.ai)"},
            timeout=6,
        )
        response.raise_for_status()
        message = (response.json() or {}).get("message") or {}
        metadata = _crossref_message_to_reference_metadata(message)
    except Exception as exc:  # Reference enrichment should never break manuscript generation.
        logger.warning("Crossref metadata enrichment failed for DOI %s: %s", doi, exc)
        metadata = {}
    _CROSSREF_CACHE[normalized] = dict(metadata)
    return metadata


def _crossref_message_to_reference_metadata(message: dict) -> dict:
    container = message.get("container-title") or []
    journal = container[0] if container else ""
    year = _crossref_year(message)
    return {
        "journal": journal,
        "volume": message.get("volume") or "",
        "issue": message.get("issue") or "",
        "pages": message.get("page") or message.get("article-number") or "",
        "year": year,
    }


def _crossref_year(message: dict) -> int | str:
    for key in ("published-print", "published-online", "published", "issued"):
        date_parts = (message.get(key) or {}).get("date-parts") or []
        if date_parts and date_parts[0]:
            year = date_parts[0][0]
            return int(year) if str(year).isdigit() else year
    return ""
