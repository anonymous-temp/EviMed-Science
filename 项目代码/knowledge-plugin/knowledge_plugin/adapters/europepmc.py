"""``europepmc``: a Europe PMC search stream windowed on the index date (preprints, mostly).

The registry template carries the query with ``AND FIRST_IDATE:[{since} TO {today}]``,
``format=json&resultType=core&pageSize=100&cursorMark={cursor}``. Facts behind it (2026-09-21/22):

- **About 20 % of identical requests answer 200 with a bare ``{"version":"6.9"}`` and no
  ``hitCount``**, whatever the pacing. That is a failed request, not an empty result: ``parse``
  raises ``FetchError('http-error', 'europepmc_missing_hitcount', retry_after_s=2)`` so the core
  counts a failure and retries, and never records "zero new preprints".
- **Select on ``FIRST_IDATE``, never ``FIRST_PDATE``.** Newly indexed MEDLINE records carry a
  ``firstPublicationDate`` a median 46 days in the future; a publication-date window misses them
  and a publication-date timestamp would sit in the future. ``published_at`` is the first
  publication date unless it is later than the first index date, then the index date.
- ``resultType=core`` carries ``abstractText`` (HTML with ``<h4>`` headings), ``pubTypeList``,
  ``meshHeadingList`` and ``fullTextUrlList``; preprints (``source: PPR``) appear about a day after
  posting, with the server in ``bookOrReportDetails.publisher``. No ETag / Last-Modified is sent,
  so requests are unconditional.
- Deep paging follows ``nextCursorMark`` while a page comes back full; the mark is never stored.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from ..model import FetchError, FetchResult, NormalizedEntry, ParseOutput, RequestSpec, SourceConfig, SourceState
from ..urltemplate import render_template, template_values
from .common import (
    clean_markup,
    load_json,
    make_entry,
    normalize_doi,
    parse_date,
    query_param,
    registry_ids,
    set_query_param,
)
from .eutils import NOTICE_PUBLICATION_TYPES, PUBMED_LANGUAGES


def _pub_types(result: dict) -> list[str]:
    value = (result.get("pubTypeList") or {}).get("pubType") or []
    return [str(v) for v in (value if isinstance(value, list) else [value]) if v]


def _author_count(result: dict) -> int | None:
    authors = (result.get("authorList") or {}).get("author")
    if isinstance(authors, list):
        return len(authors)
    text = result.get("authorString") or ""
    return len([a for a in text.rstrip(".").split(",") if a.strip()]) if text else None


def europepmc_journal(result: dict) -> str | None:
    journal = ((result.get("journalInfo") or {}).get("journal") or {}).get("title")
    if journal:
        return clean_markup(journal)
    publisher = (result.get("bookOrReportDetails") or {}).get("publisher")
    return clean_markup(publisher) if publisher else None


def europepmc_published_at(result: dict) -> datetime | None:
    published, _ = parse_date(result.get("firstPublicationDate"))
    indexed, _ = parse_date(result.get("firstIndexDate"))
    if published and indexed and published > indexed:
        return indexed
    return published or indexed


def europepmc_result_entry(result: dict, *, source: SourceConfig) -> NormalizedEntry | None:
    """One Europe PMC ``core`` result as an entry; ``None`` without an id or a title."""
    record_id, record_source = result.get("id"), result.get("source")
    title = clean_markup(result.get("title"))
    if not record_id or not record_source or not title:
        return None
    doi = normalize_doi(result.get("doi"))
    pmid = str(result["pmid"]) if result.get("pmid") else None
    abstract = clean_markup(result.get("abstractText")) or None
    url = f"https://doi.org/{doi}" if doi else f"https://europepmc.org/article/{record_source}/{record_id}"
    types = set(_pub_types(result))
    language = PUBMED_LANGUAGES.get(str(result.get("language") or "").lower(), source.language or "en")
    facts = {
        "journal": europepmc_journal(result),
        "author_count": _author_count(result),
        "is_correction_notice": True if types & NOTICE_PUBLICATION_TYPES else None,
    }
    return make_entry(
        external_key=f"{record_source}:{record_id}",
        url=url,
        title=title,
        summary=abstract,
        published_at=europepmc_published_at(result),
        precision="day",
        language=language,
        doi=doi,
        pmid=pmid,
        registry=registry_ids(title, abstract),
        facts=facts,
    )


def europepmc_results(result: FetchResult) -> tuple[dict[str, Any], list[dict]]:
    """``(payload, results)`` of a search answer; the missing-``hitCount`` fault raises (see module docstring)."""
    payload = load_json(result, "europepmc")
    if result.status != 200:
        raise FetchError("http-error", f"europepmc_http_{result.status}", status=result.status)
    if not isinstance(payload, dict) or "hitCount" not in payload:
        raise FetchError("http-error", "europepmc_missing_hitcount", status=result.status, retry_after_s=2)
    results = ((payload.get("resultList") or {}).get("result")) or []
    if not isinstance(results, list):
        raise FetchError("parse-error", "europepmc_unexpected_shape", status=result.status)
    return payload, results


class EuropePmcAdapter:
    """A Europe PMC REST search stream (see module docstring)."""

    access = "europepmc"

    def validate_config(self, source: SourceConfig) -> list[str]:
        url = (source.config or {}).get("url") or ""
        problems = []
        if "/europepmc/webservices/rest/search" not in url:
            problems.append("url is not a Europe PMC REST search URL")
        if "FIRST_PDATE" in url or "P_PDATE" in url.split("sort=")[0]:
            problems.append("window on FIRST_IDATE: FIRST_PDATE of new MEDLINE records runs weeks into the future")
        if "format=json" not in url:
            problems.append("format=json is required")
        if "resultType=core" not in url:
            problems.append("resultType=core is required for abstracts")
        return problems

    def plan(self, source: SourceConfig, state: SourceState, now: datetime) -> list[RequestSpec]:
        config = source.config or {}
        values = template_values(source, state, now)
        values["cursor"] = str(config.get("cursor_start") or "*")
        url = render_template(config["url"], values)
        if config.get("page_size") and query_param(url, "pageSize") != str(int(config["page_size"])):
            url = set_query_param(url, "pageSize", str(int(config["page_size"])))
        return [RequestSpec(url=url, conditional=False, api=True)]

    def parse(self, result: FetchResult, source: SourceConfig, now: datetime) -> ParseOutput:
        payload, results = europepmc_results(result)
        entries, skipped = [], 0
        for item in results:
            entry = europepmc_result_entry(item, source=source) if isinstance(item, dict) else None
            if entry is None:
                skipped += 1
            else:
                entries.append(entry)
        notes = [f"europepmc_skipped={skipped}"] if skipped else []
        request_url = result.request.url
        page_size = int(query_param(request_url, "pageSize") or 25)
        mark = payload.get("nextCursorMark")
        next_request = None
        if mark and mark != query_param(request_url, "cursorMark") and len(results) >= page_size:
            next_request = RequestSpec(url=set_query_param(request_url, "cursorMark", str(mark)),
                                       conditional=False, api=True)
        return ParseOutput(entries=entries, next=next_request, notes=notes)
