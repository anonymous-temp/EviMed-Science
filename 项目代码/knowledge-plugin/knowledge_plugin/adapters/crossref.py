"""``crossref-issn``: what a journal registered in Crossref inside the read window.

The registry template (``tools/build_registry.py``) reads ``/journals/{issn}/works`` with
``filter=from-created-date:{since},type:journal-article``, ``sort=created&order=desc`` and
``cursor={cursor}``. Measured facts behind this adapter (2026-09-21/22):

- **``rows`` silently truncates.** Nature Communications had 224 works in a 7-day window and the
  dry run's ``rows=100`` returned 100 of them with no error (``total-results`` said 224). This
  adapter follows Crossref deep paging: while a page comes back full, it asks again with the
  page's ``next-cursor``. Cursors expire after minutes, so they are never stored between polls.
- **``from-index-date`` is not "new".** One day of ``from-index-date`` on NEJM returned 3,553 works
  registered between 1988 and 2024 (Crossref re-indexes on every cited-by change); the window is
  therefore on ``created`` (first registration). An incremental poll re-reads one overlapping day
  (``urltemplate.window_since``) and the store is idempotent by DOI.
- **The journal route refuses ``select=subtype`` and ``select=language``** with a 400
  ``select-not-available`` validation failure; ``plan`` strips them from a template that names them
  (``validate_config`` reports it) and ``parse`` names the failure if one slips through.
- **Notices and mastheads are flagged, not dropped** (plan 10.3.2): ``update-to`` (3.1 % of works;
  correction 31, new_version 10, erratum 9, expression_of_concern 1, retraction 1 in the dry run)
  and notice title forms set ``is_correction_notice``; the exact masthead titles ("Editorial
  Board" in seven journals) set ``is_masthead``. ``new_version`` / ``new_edition`` updates are
  versions of the work itself, not notices, and are only reported in ``update_to``.
- 44 % of works carry a JATS ``abstract``; the rest wait for PubMed / Europe PMC in ``/text``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from ..model import FetchError, FetchResult, NormalizedEntry, ParseOutput, RequestSpec, SourceConfig, SourceState
from ..urltemplate import render_template, template_values
from .common import (
    NOTICE_UPDATE_TYPES,
    clean_markup,
    guess_language,
    is_masthead_title,
    is_notice_title,
    load_json,
    make_entry,
    normalize_doi,
    parse_date,
    query_param,
    registry_ids,
    set_query_param,
)

# Fields the parser reads; the journal route accepts all of them (probed 2026-09-21/22).
SELECT_FIELDS = ("DOI", "title", "created", "published", "type", "update-to", "abstract", "author",
                 "container-title")
REFUSED_SELECT = frozenset({"subtype", "language"})


def _select_problems(url: str) -> list[str]:
    select = query_param(url, "select")
    if select is None:
        return []
    fields = [f.strip() for f in select.split(",") if f.strip()]
    problems = [f"select field {f!r} is refused by the Crossref journal route" for f in fields if f in REFUSED_SELECT]
    missing = [f for f in SELECT_FIELDS if f not in fields]
    if missing:
        problems.append(f"select omits fields the parser reads: {missing}")
    return problems


def _repair_select(url: str) -> str:
    select = query_param(url, "select")
    if select is None:
        return url
    fields = [f.strip() for f in select.split(",") if f.strip() and f.strip() not in REFUSED_SELECT]
    for needed in SELECT_FIELDS:
        if needed not in fields:
            fields.append(needed)
    return set_query_param(url, "select", ",".join(fields))


def _date_parts(value: Any) -> datetime | None:
    """A Crossref ``{date-time}`` or ``{date-parts}`` object as a UTC datetime (day precision for parts)."""
    if not isinstance(value, dict):
        return None
    if value.get("date-time"):
        parsed, _ = parse_date(value["date-time"])
        return parsed
    parts = (value.get("date-parts") or [[]])[0] or []
    if len(parts) >= 3 and all(isinstance(p, int) for p in parts[:3]):
        parsed, _ = parse_date(f"{parts[0]:04d}-{parts[1]:02d}-{parts[2]:02d}")
        return parsed
    return None


def crossref_error_detail(payload: Any, status: int) -> str:
    """A snake_case reason for a Crossref error body (``select-not-available`` → ``crossref_select_not_available``)."""
    if isinstance(payload, dict) and isinstance(payload.get("message"), list):
        for item in payload["message"]:
            if isinstance(item, dict) and item.get("type"):
                return "crossref_" + str(item["type"]).replace("-", "_")[:60]
    return f"crossref_http_{status}"


def crossref_work_entry(work: dict, *, source: SourceConfig) -> NormalizedEntry | None:
    """One Crossref work as a normalised entry; ``None`` when it has no DOI or no title.

    Shared with the ``crossref-works`` json-api family (the retraction and correction streams).
    """
    doi = normalize_doi(work.get("DOI"))
    titles = work.get("title") or []
    title = clean_markup(titles[0]) if titles else ""
    if not doi or not title:
        return None
    abstract = clean_markup(work.get("abstract"))
    if abstract[:9].lower() == "abstract ":
        abstract = abstract[9:].lstrip()
    created = _date_parts(work.get("created"))
    updates = []
    notice = False
    for update in work.get("update-to") or []:
        if not isinstance(update, dict):
            continue
        kind = str(update.get("type") or "").strip()
        target = normalize_doi(update.get("DOI"))
        when = _date_parts(update.get("updated"))
        item = {"type": kind, "doi": target, "date": when.date().isoformat() if when else None}
        updates.append({k: v for k, v in item.items() if v})
        if kind.replace("-", "_") in NOTICE_UPDATE_TYPES:
            notice = True
    notice = notice or is_notice_title(title)
    container = work.get("container-title") or []
    config = source.config or {}
    issn = config.get("issn") or next(iter(work.get("ISSN") or []), None)
    facts = {
        "crossref_type": work.get("type"),
        "update_to": updates or None,
        "author_count": len(work.get("author") or []),
        "journal": clean_markup(container[0]) if container else None,
        "issn": issn,
        "is_correction_notice": True if notice else None,
        "is_masthead": True if is_masthead_title(title) else None,
    }
    return make_entry(
        external_key=doi,
        url=f"https://doi.org/{doi}",
        title=title,
        summary=abstract or None,
        published_at=created,
        precision="instant",
        language=guess_language(title, source.language or "en"),
        doi=doi,
        registry=registry_ids(title, abstract),
        facts=facts,
    )


def parse_crossref_works(result: FetchResult, source: SourceConfig) -> ParseOutput:
    """Read one Crossref works page (journal route or ``/works``) and plan the next cursor page."""
    payload = load_json(result, "crossref")
    if result.status != 200:
        raise FetchError("http-error", crossref_error_detail(payload, result.status), status=result.status)
    if not isinstance(payload, dict) or payload.get("status") != "ok" or not isinstance(payload.get("message"), dict):
        raise FetchError("parse-error", "crossref_unexpected_shape", status=result.status)
    message = payload["message"]
    items = message.get("items")
    if not isinstance(items, list):
        raise FetchError("parse-error", "crossref_items_missing", status=result.status)
    entries: list[NormalizedEntry] = []
    untitled = 0
    for work in items:
        entry = crossref_work_entry(work, source=source) if isinstance(work, dict) else None
        if entry is None:
            untitled += 1
            continue
        entries.append(entry)
    notes = [f"crossref_dropped_untitled={untitled}"] if untitled else []
    request_url = result.request.url
    rows = int(query_param(request_url, "rows") or 20)
    total = message.get("total-results")
    next_cursor = message.get("next-cursor")
    follow = (
        query_param(request_url, "cursor") is not None
        and next_cursor
        and len(items) >= rows
        and not (isinstance(total, int) and total <= rows)
    )
    next_request = None
    if follow:
        next_request = RequestSpec(url=set_query_param(request_url, "cursor", str(next_cursor)),
                                   conditional=False, api=True)
    return ParseOutput(entries=entries, next=next_request, notes=notes)


class CrossrefIssnAdapter:
    """Journal works by ISSN from the Crossref REST API (see module docstring)."""

    access = "crossref-issn"

    def validate_config(self, source: SourceConfig) -> list[str]:
        config = source.config or {}
        url = config.get("url") or ""
        problems = []
        if "{issn}" in url and not config.get("issn"):
            problems.append("url uses {issn} but config.issn is empty")
        if "api.crossref.org" not in url:
            problems.append("url is not a Crossref API URL")
        problems += _select_problems(url)
        if "from-index-date" in url:
            problems.append("from-index-date returns re-indexed old works; window on from-created-date")
        return problems

    def plan(self, source: SourceConfig, state: SourceState, now: datetime) -> list[RequestSpec]:
        config = source.config or {}
        values = template_values(source, state, now)
        values["cursor"] = str(config.get("cursor_start") or "*")  # a stored cursor is never reused
        url = _repair_select(render_template(config["url"], values))
        if config.get("page_size"):
            url = set_query_param(url, "rows", str(int(config["page_size"])))
        return [RequestSpec(url=url, conditional=False, api=True)]

    def parse(self, result: FetchResult, source: SourceConfig, now: datetime) -> ParseOutput:
        return parse_crossref_works(result, source)
