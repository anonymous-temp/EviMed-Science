"""``eutils-query``: a PubMed query stream read by entry date (``esearch`` + ``efetch``).

One poll is a chain: ``esearch`` (``usehistory=y``, ``retmax=0``) puts the matching PMIDs on
NCBI's history server and says how many there are; ``efetch`` pages then read the records as
PubMed XML (abstract, publication types, MeSH, journal, DOI) straight from the history set.
Facts behind the design (measured 2026-09-21/22):

- **``datetype`` must be one of ``edat pdat mdat crdt mhda``.** A misspelling is not an error: the
  date range silently becomes two all-field words (``"2026/09/15"[All Fields]``) and the query
  answers ``count 0`` — indistinguishable from "no news today". ``validate_config``/``plan`` refuse
  any other value, and ``parse`` checks that PubMed's own ``querytranslation`` carries the date
  label (``[Date - Entry]`` for ``edat``) before trusting a count.
- **efetch past the end is an HTTP 400** (``Cannot retrieve history data: OUT OF RANGE``). The chain
  therefore never asks past ``count``: it reads the newest ``page_size × (max_pages − 1)`` records
  of the history set **backwards**, page by page — each request's own ``retstart`` says where the
  next one starts, so ``parse`` needs no state and never over-asks.
- PMIDs and DOIs come from ``ArticleIdList``/``ELocationID``; the entry's URL is the PubMed record.
  ``published_at`` is the electronic publication date when PubMed has one, else the Entrez date,
  unless the print date is more than 60 days older than the Entrez date (a back-issue newly
  indexed): then the print date, so an old article does not surface as today's news.
- Credentials (``tool``, ``email``, ``api_key``) are added by the fetcher per host, never here.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

from ..model import FetchError, FetchResult, NormalizedEntry, ParseOutput, RequestSpec, SourceConfig, SourceState
from ..urltemplate import render_template, template_values
from .common import (
    UTC,
    clean_markup,
    load_json,
    make_entry,
    normalize_doi,
    query_param,
    registry_ids,
    set_query_param,
)

EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
DATETYPES = {"edat": "[Date - Entry]", "pdat": "[Date - Publication]", "mdat": "[Date - Modification]",
             "crdt": "[Date - Create]", "mhda": "[Date - MeSH]"}
DEFAULT_PAGE_SIZE = 100
DEFAULT_MAX_PAGES = 5
BACK_ISSUE_DAYS = 60

# Publication types that make a record a notice about another record (plan 10.3.2 / 10.3.9).
NOTICE_PUBLICATION_TYPES = frozenset({"Published Erratum", "Retraction of Publication", "Expression of Concern",
                                      "Retraction Notice", "Correction"})
# ISO 639-2 codes PubMed uses → BCP-47 primary tags (closed; anything else stays as PubMed wrote it).
PUBMED_LANGUAGES = {"eng": "en", "chi": "zh", "jpn": "ja", "ger": "de", "fre": "fr", "spa": "es", "rus": "ru",
                    "kor": "ko", "por": "pt", "ita": "it", "pol": "pl", "dut": "nl", "tur": "tr", "per": "fa"}
_MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov",
                                        "dec"], start=1)}

# Affiliation strings end with the country more often than not. The contract (1.1.0,
# ``EntryText.enrichment.affiliation_countries``) wants ISO 3166-1 alpha-2 codes: this closed table
# maps the spellings PubMed and Europe PMC carry (lower-cased, digits dropped) to a code; a name
# that is not in the table is dropped, never guessed.
COUNTRY_CODES = {
    "united states": "US", "usa": "US", "u.s.a": "US", "us": "US", "united states of america": "US",
    "united kingdom": "GB", "uk": "GB", "u.k": "GB", "england": "GB", "scotland": "GB", "wales": "GB",
    "northern ireland": "GB", "great britain": "GB",
    "china": "CN", "p.r. china": "CN", "pr china": "CN", "p. r. china": "CN", "prc": "CN", "p.r.china": "CN",
    "people's republic of china": "CN", "peoples republic of china": "CN", "the people's republic of china": "CN",
    "hong kong": "HK", "hong kong sar": "HK", "hong kong sar china": "HK", "macau": "MO", "macao": "MO",
    "taiwan": "TW", "japan": "JP", "south korea": "KR", "korea": "KR", "republic of korea": "KR",
    "singapore": "SG", "india": "IN", "australia": "AU", "new zealand": "NZ", "canada": "CA", "germany": "DE",
    "deutschland": "DE", "france": "FR", "italy": "IT", "spain": "ES", "españa": "ES", "portugal": "PT",
    "netherlands": "NL", "the netherlands": "NL", "holland": "NL", "belgium": "BE", "switzerland": "CH",
    "austria": "AT", "sweden": "SE", "norway": "NO", "denmark": "DK", "finland": "FI", "iceland": "IS",
    "ireland": "IE", "poland": "PL", "czech republic": "CZ", "czechia": "CZ", "hungary": "HU", "greece": "GR",
    "turkey": "TR", "türkiye": "TR", "turkiye": "TR", "israel": "IL", "iran": "IR", "saudi arabia": "SA",
    "united arab emirates": "AE", "uae": "AE", "qatar": "QA", "egypt": "EG", "south africa": "ZA", "nigeria": "NG",
    "kenya": "KE", "ethiopia": "ET", "brazil": "BR", "brasil": "BR", "argentina": "AR", "chile": "CL", "mexico": "MX",
    "colombia": "CO", "peru": "PE", "pakistan": "PK", "bangladesh": "BD", "thailand": "TH", "vietnam": "VN",
    "viet nam": "VN", "malaysia": "MY", "indonesia": "ID", "philippines": "PH", "russia": "RU",
    "russian federation": "RU", "ukraine": "UA", "romania": "RO", "serbia": "RS", "croatia": "HR", "slovenia": "SI",
    "slovakia": "SK", "estonia": "EE", "lithuania": "LT", "latvia": "LV", "luxembourg": "LU", "lebanon": "LB",
    "jordan": "JO", "kuwait": "KW", "nepal": "NP", "sri lanka": "LK", "uganda": "UG", "tanzania": "TZ", "ghana": "GH",
    "cameroon": "CM", "tunisia": "TN", "morocco": "MA",
}


def affiliation_country(text: str) -> str | None:
    """The ISO 3166-1 alpha-2 code of the country an affiliation string ends with, if the table knows it."""
    if not text:
        return None
    cleaned = text.strip().rstrip(".;").strip()
    if "@" in cleaned:  # "…, China. Electronic address: x@y" → drop the address part
        cleaned = cleaned.split("Electronic address")[0].rstrip(" .;,")
    last = cleaned.split(",")[-1].strip().rstrip(".").strip()
    last = " ".join(word for word in last.split() if not any(ch.isdigit() for ch in word))
    return COUNTRY_CODES.get(last.lower())


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _text(node: ET.Element | None) -> str:
    return clean_markup("".join(node.itertext())) if node is not None else ""


def _pubmed_date(node: ET.Element | None) -> tuple[datetime | None, bool]:
    """``(date, day_known)`` from a PubMed ``<Year><Month><Day>`` (or ``<MedlineDate>``) node."""
    if node is None:
        return None, False
    year = node.findtext("Year")
    month = (node.findtext("Month") or "").strip()
    day = (node.findtext("Day") or "").strip()
    if not year and node.findtext("MedlineDate"):
        year = node.findtext("MedlineDate")[:4]
    if not year or not year.isdigit():
        return None, False
    month_number = int(month) if month.isdigit() else _MONTHS.get(month[:3].lower(), 1)
    day_number = int(day) if day.isdigit() else 1
    try:
        return datetime(int(year), month_number, day_number, tzinfo=UTC), bool(day.isdigit() and month)
    except ValueError:
        return None, False


def parse_pubmed_xml(body: bytes) -> list[dict[str, Any]]:
    """Every ``PubmedArticle`` of an efetch answer as a plain record (pure; shared with enrichment)."""
    try:
        root = ET.fromstring(body)
    except ET.ParseError as error:
        raise FetchError("parse-error", "pubmed_xml_unreadable") from error
    if _local(root.tag) == "eFetchResult":
        raise FetchError("http-error", "pubmed_efetch_error")
    records = []
    for article in root.iter():
        if _local(article.tag) != "PubmedArticle":
            continue
        citation = article.find("MedlineCitation")
        art = citation.find("Article") if citation is not None else None
        if citation is None or art is None:
            continue
        pmid = (citation.findtext("PMID") or "").strip() or None
        doi = None
        for node in article.iter("ArticleId"):
            if node.get("IdType") == "doi" and (node.text or "").strip():
                doi = normalize_doi(node.text)
                break
        if doi is None:
            for node in art.iter("ELocationID"):
                if node.get("EIdType") == "doi":
                    doi = normalize_doi(node.text)
                    break
        parts = []
        for node in art.iter("AbstractText"):
            label = node.get("Label")
            text = _text(node)
            if text:
                parts.append(f"{label}: {text}" if label and label.upper() not in ("UNLABELLED",) else text)
        journal = art.find("Journal")
        issn = None
        if journal is not None:
            for node in journal.iter("ISSN"):
                if (node.text or "").strip():
                    issn = node.text.strip()
                    break
        authors = []
        countries: list[str] = []
        for author in art.iter("Author"):
            if author.get("ValidYN") == "N":
                continue
            collective = author.findtext("CollectiveName")
            last = author.findtext("LastName")
            initials = author.findtext("Initials") or ""
            name = f"{last} {initials}".strip() if last else (clean_markup(collective) if collective else "")
            if name:
                authors.append(name)
            for affiliation in author.iter("Affiliation"):
                country = affiliation_country("".join(affiliation.itertext()))
                if country and country not in countries:
                    countries.append(country)
        entrez = None
        for node in article.iter("PubMedPubDate"):
            if node.get("PubStatus") == "entrez":
                entrez, _ = _pubmed_date(node)
        article_date, _ = _pubmed_date(art.find("ArticleDate"))
        issue = journal.find("JournalIssue") if journal is not None else None
        pub_date, pub_day_known = _pubmed_date(issue.find("PubDate") if issue is not None else None)
        registry = []
        for bank in citation.iter("DataBank"):
            for accession in bank.iter("AccessionNumber"):
                registry += registry_ids(accession.text)
        records.append({
            "pmid": pmid,
            "doi": doi,
            "title": _text(art.find("ArticleTitle")) or _text(art.find("VernacularTitle")),
            "abstract": " ".join(parts) or None,
            "publication_types": [t for t in (_text(n) for n in art.iter("PublicationType")) if t],
            "mesh": [t for t in (_text(n) for n in citation.iter("DescriptorName")) if t],
            "journal": _text(journal.find("Title")) if journal is not None else None,
            "journal_abbreviation": _text(journal.find("ISOAbbreviation")) if journal is not None else None,
            "issn": issn,
            "authors": authors,
            "affiliation_countries": countries,
            "language": (art.findtext("Language") or "").strip() or None,
            "entrez_date": entrez,
            "article_date": article_date,
            "pub_date": pub_date,
            "pub_date_day_known": pub_day_known,
            "registry_ids": registry,
        })
    return records


def authors_short(authors: list[str]) -> str | None:
    """``"A B, C D, E F, et al."`` — the first three names, then et al."""
    if not authors:
        return None
    if len(authors) <= 3:
        return ", ".join(authors)
    return ", ".join(authors[:3]) + ", et al."


def pubmed_published_at(record: dict[str, Any]) -> datetime | None:
    """When the article became public (see module docstring), at day precision."""
    entrez = record.get("entrez_date")
    electronic = record.get("article_date")
    printed = record.get("pub_date")
    if electronic and (entrez is None or electronic <= entrez + timedelta(days=1)):
        return electronic
    if printed and entrez and printed < entrez - timedelta(days=BACK_ISSUE_DAYS):
        return printed
    return entrez or electronic or printed


def pubmed_record_entry(record: dict[str, Any], *, source: SourceConfig) -> NormalizedEntry | None:
    pmid = record.get("pmid")
    title = record.get("title") or ""
    if not pmid or not title:
        return None
    types = set(record.get("publication_types") or [])
    language = PUBMED_LANGUAGES.get((record.get("language") or "").lower(), record.get("language") or "und")
    facts = {
        "journal": record.get("journal"),
        "issn": record.get("issn"),
        "author_count": len(record.get("authors") or []),
        "is_correction_notice": True if types & NOTICE_PUBLICATION_TYPES else None,
    }
    abstract = record.get("abstract")
    return make_entry(
        external_key=pmid,
        url=f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
        title=title,
        summary=abstract,
        published_at=pubmed_published_at(record),
        precision="day",
        language=language,
        doi=record.get("doi"),
        pmid=pmid,
        registry=registry_ids(*(record.get("registry_ids") or []), title, abstract),
        facts=facts,
    )


def _efetch_url(webenv: str, query_key: str, retstart: int, retmax: int) -> str:
    return (f"{EUTILS_BASE}/efetch.fcgi?db=pubmed&retmode=xml&query_key={query_key}&WebEnv={webenv}"
            f"&retstart={retstart}&retmax={retmax}")


class EutilsQueryAdapter:
    """A PubMed search stream windowed on the Entrez date (see module docstring)."""

    access = "eutils-query"

    def _datetype(self, source: SourceConfig) -> str | None:
        config = source.config or {}
        return config.get("datetype") or query_param(config.get("url") or "", "datetype")

    def validate_config(self, source: SourceConfig) -> list[str]:
        config = source.config or {}
        url = config.get("url") or ""
        problems = []
        if "esearch.fcgi" not in url:
            problems.append("url is not an E-utilities esearch URL")
        datetype = self._datetype(source)
        if datetype not in DATETYPES:
            problems.append(f"datetype {datetype!r} is not one of {sorted(DATETYPES)} (a wrong one silently returns 0)")
        url_datetype = query_param(url, "datetype")
        if url_datetype and config.get("datetype") and url_datetype != config["datetype"]:
            problems.append("config.datetype and the url's datetype differ")
        if "reldate=" in url:
            problems.append("reldate ignores the incremental window; use mindate={since}/maxdate={today}")
        if int(config.get("max_pages", DEFAULT_MAX_PAGES)) < 2:
            problems.append("max_pages must be at least 2 (esearch + one efetch page)")
        return problems

    def plan(self, source: SourceConfig, state: SourceState, now: datetime) -> list[RequestSpec]:
        config = source.config or {}
        datetype = self._datetype(source)
        if datetype not in DATETYPES:
            raise ValueError(f"eutils_datetype_invalid: {datetype!r}")
        url = render_template(config["url"], template_values(source, state, now))
        if query_param(url, "datetype") != datetype:
            url = set_query_param(url, "datetype", datetype)
        url = set_query_param(url, "usehistory", "y")
        url = set_query_param(url, "retmax", "0")
        return [RequestSpec(url=url, conditional=False, api=True)]

    def parse(self, result: FetchResult, source: SourceConfig, now: datetime) -> ParseOutput:
        path = urlsplit(result.request.url).path
        if path.endswith("esearch.fcgi"):
            return self._parse_esearch(result, source)
        if path.endswith("efetch.fcgi"):
            return self._parse_efetch(result, source)
        raise FetchError("parse-error", "eutils_unexpected_endpoint", status=result.status)

    def _page_size(self, source: SourceConfig) -> int:
        return max(1, min(500, int((source.config or {}).get("page_size", DEFAULT_PAGE_SIZE))))

    def _parse_esearch(self, result: FetchResult, source: SourceConfig) -> ParseOutput:
        payload = load_json(result, "eutils")
        if result.status != 200:
            raise FetchError("http-error", f"eutils_http_{result.status}", status=result.status)
        search = payload.get("esearchresult") if isinstance(payload, dict) else None
        if not isinstance(search, dict):
            raise FetchError("parse-error", "eutils_unexpected_shape", status=result.status)
        if search.get("ERROR"):
            raise FetchError("http-error", "eutils_search_error", status=result.status)
        notes = []
        request_url = result.request.url
        # An unknown datetype has no label, so the window cannot have been applied (PubMed read the
        # dates as words); a known one must appear in PubMed's own reading of the query.
        label = DATETYPES.get(query_param(request_url, "datetype") or "edat")
        if query_param(request_url, "mindate") and (label is None or label not in (search.get("querytranslation") or "")):
            raise FetchError("parse-error", "eutils_window_not_applied", status=result.status)
        errors = search.get("errorlist") or {}
        for kind in ("phrasesnotfound", "fieldsnotfound"):
            if errors.get(kind):
                notes.append(f"eutils_{kind}={len(errors[kind])}")
        try:
            count = int(search.get("count") or 0)
        except ValueError as error:
            raise FetchError("parse-error", "eutils_count_unreadable") from error
        if count == 0:
            return ParseOutput(entries=[], notes=notes)
        webenv, query_key = search.get("webenv"), search.get("querykey")
        if not webenv or not query_key:
            raise FetchError("parse-error", "eutils_history_missing", status=result.status)
        config = source.config or {}
        page = self._page_size(source)
        budget = page * max(1, int(config.get("max_pages", DEFAULT_MAX_PAGES)) - 1)
        window = min(count, budget)
        if count > window:
            notes.append(f"eutils_truncated count={count} read={window}")
        start = page * ((window - 1) // page)
        return ParseOutput(entries=[], notes=notes,
                           next=RequestSpec(url=_efetch_url(webenv, str(query_key), start, window - start),
                                            conditional=False, api=True))

    def _parse_efetch(self, result: FetchResult, source: SourceConfig) -> ParseOutput:
        if result.status != 200:
            raise FetchError("http-error", f"eutils_http_{result.status}", status=result.status)
        records = parse_pubmed_xml(result.body)
        entries = [e for e in (pubmed_record_entry(r, source=source) for r in records) if e is not None]
        notes = [f"eutils_skipped_records={len(records) - len(entries)}"] if len(entries) < len(records) else []
        url = result.request.url
        start = int(query_param(url, "retstart") or 0)
        next_request = None
        if start > 0:
            page = self._page_size(source)
            previous = max(0, start - page)
            next_request = RequestSpec(
                url=_efetch_url(query_param(url, "WebEnv") or "", query_param(url, "query_key") or "1",
                                previous, start - previous),
                conditional=False, api=True)
        return ParseOutput(entries=entries, next=next_request, notes=notes)
