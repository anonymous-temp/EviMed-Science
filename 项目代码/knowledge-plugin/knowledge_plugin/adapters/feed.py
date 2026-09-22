"""``rss`` / ``atom``: subscription feeds, read with feedparser.

One reader serves both methods (feedparser tells RSS 0.9x/1.0/2.0 and Atom apart by itself). What
the P0 feeds actually do (2026-09-21/22) and how this reader answers it:

- **79 % of feed items are archive** (MMWR returns 2,325 items back to 2019, CDC newsroom 1,842
  back to 2006). The reader returns them all; the core's first-contact guard and its 400-day
  seen-keys memory decide what is new. ``config.max_items`` (default 500, newest first) only
  bounds a pathological feed.
- **Undated feeds**: 中国药学杂志 (``zgyxzz-pharm``, served as ``text/html``) and 中国现代应用药学
  (``chinjmap``, RSS 1.0 with empty ``prism:publicationDate``) carry no date at all; such entries
  go out with ``published_at=None`` and the core stamps the first sighting as ``inferred``.
- **Naive local timestamps**: 科学网 writes ``2026-09-22 13:31`` (China time, no zone). feedparser
  would read it as UTC, eight hours into the future; this reader parses the raw string itself
  and applies the source's zone (``common.source_zone``) to naive values only.
- **Oversize and truncated text**: fharrell.com shipped one item of 423,503 characters; summaries
  are capped at the contract's 20,000 with ``oversize-truncated``. Publisher-cut summaries ("…",
  "Read more", "阅读全文") get ``truncated-summary``. When ``content:encoded``/Atom content is
  longer than the summary it is used instead (full-text feeds such as oneusefulthing.org).
- **Double-escaped HTML** (``chinjmap``) is unescaped by ``common.clean_markup``; a summary equal to
  the title (EMA's EPAR feed) or PubMed's "No abstract" placeholder is no summary.
- Identifiers: ``prism:doi`` / ``dc:identifier doi:…`` / DOI-bearing links give ``doi``;
  PubMed's ``pubmed:<pmid>`` ids give ``pmid``; arXiv ids lose their version (``arxiv:<id>``)
  and get arXiv's DataCite DOI ``10.48550/arxiv.<id>`` so versions revise one entry.
- Feed-tracking query tags named in ``config.strip_params`` (medRxiv's ``rss=1``) are removed
  from links. Website feeds consult robots.txt (``api`` false) unless the registry marks the feed
  an API (``config.api``).
"""

from __future__ import annotations

import calendar
import re
from datetime import datetime, timezone
from typing import Any

import feedparser

from ..model import FetchError, FetchResult, NormalizedEntry, ParseOutput, RequestSpec, SourceConfig, SourceState
from .base import plan_from_template
from .common import (
    PMID_IN_URL,
    absolute_url,
    clean_markup,
    guess_language,
    make_entry,
    normalize_doi,
    parse_date,
    registry_ids,
    source_zone,
    strip_params,
)

DEFAULT_MAX_ITEMS = 500
NO_ABSTRACT = frozenset({"no abstract", "no abstract available", "abstract not available", "暂无摘要", "无摘要"})
_ARXIV_ID = re.compile(r"arxiv\.org/abs/([a-z\-]+(?:\.[A-Z]{2})?/\d{7}|\d{4}\.\d{4,5})(v\d+)?", re.I)
_DATE_KEYS = ("published", "updated", "prism_publicationdate", "dc_date", "created", "issued", "prism_coverdate",
              "date")
_PARSED_KEYS = ("published_parsed", "updated_parsed", "created_parsed")


def _entry_date(item: Any, naive_zone) -> tuple[datetime | None, str]:
    # dict.get, not item.get: FeedParserDict maps a missing ``published`` to ``updated`` with a
    # DeprecationWarning (feedparser issue 310); the raw keys are read as the feed wrote them.
    for key in _DATE_KEYS:
        raw = dict.get(item, key)
        if raw:
            parsed, precision = parse_date(raw, naive_zone=naive_zone)
            if parsed is not None:
                return parsed, precision
    for key in _PARSED_KEYS:  # a form parse_date does not know: trust feedparser's reading (UTC)
        value = dict.get(item, key)
        if value:
            return datetime.fromtimestamp(calendar.timegm(value), tz=timezone.utc), "instant"
    return None, "instant"


def _entry_link(item: Any, base: str) -> str | None:
    candidates = [item.get("link")]
    candidates += [link.get("href") for link in item.get("links") or [] if link.get("rel", "alternate") == "alternate"]
    guid = item.get("id") or ""
    if guid.startswith(("http://", "https://")):
        candidates.append(guid)
    for candidate in candidates:
        resolved = absolute_url(candidate, base)
        if resolved:
            return resolved
    return None


def _entry_text(item: Any) -> str:
    summary = clean_markup(item.get("summary"))
    contents = [clean_markup(c.get("value")) for c in item.get("content") or [] if c.get("value")]
    longest = max(contents, key=len) if contents else ""
    return longest if len(longest) > len(summary) else summary


def feed_entry(item: Any, *, source: SourceConfig, base: str, naive_zone) -> NormalizedEntry | None:
    config = source.config or {}
    title = clean_markup(item.get("title"))
    link = _entry_link(item, base)
    if not title or not link:
        return None
    link = strip_params(link, config.get("strip_params") or [])
    guid = str(item.get("id") or "").strip()
    external_key = guid or link
    doi = (normalize_doi(item.get("prism_doi")) or normalize_doi(item.get("dc_identifier"))
           or normalize_doi(link) or normalize_doi(guid))
    pmid = None
    if guid.startswith("pubmed:") and guid[7:].isdigit():
        pmid = guid[7:]
    else:
        found = PMID_IN_URL.search(link)
        pmid = found.group(1) if found else None
    arxiv = _ARXIV_ID.search(guid) or _ARXIV_ID.search(link)
    if arxiv:
        arxiv_id = arxiv.group(1)
        external_key = f"arxiv:{arxiv_id}"
        link = f"https://arxiv.org/abs/{arxiv_id}"
        doi = doi or f"10.48550/arxiv.{arxiv_id.lower()}"
    text = _entry_text(item)
    if text.strip().lower().rstrip(".") in NO_ABSTRACT or text.strip() == title:
        text = ""
    published_at, precision = _entry_date(item, naive_zone)
    journal = clean_markup(item.get("prism_publicationname") or item.get("dc_source")) or None
    return make_entry(
        external_key=external_key,
        url=link,
        title=title,
        summary=text or None,
        published_at=published_at,
        precision=precision,
        language=guess_language(title, source.language),
        doi=doi,
        pmid=pmid,
        registry=registry_ids(title, text),
        facts={"journal": journal},
        feed_summary=True,
    )


def parse_feed(result: FetchResult, source: SourceConfig, now: datetime) -> ParseOutput:
    """Read one feed document (also used by the json-api ``arxiv`` family)."""
    if result.not_modified:
        return ParseOutput(entries=[], notes=["feed_not_modified"])
    if result.status != 200:
        raise FetchError("http-error", f"feed_http_{result.status}", status=result.status)
    headers = {"content-type": result.headers.get("content-type", ""), "content-location": result.final_url}
    parsed = feedparser.parse(result.body, response_headers=headers)
    items = parsed.get("entries") or []
    if not items and not parsed.get("version"):
        head = result.body[:2048].lower()
        detail = "feed_not_a_feed" if b"<html" in head or b"<!doctype html" in head else "feed_unreadable"
        raise FetchError("parse-error", detail, status=result.status)
    config = source.config or {}
    naive_zone = source_zone(config, source.region)
    base = result.final_url or result.request.url
    entries: list[NormalizedEntry] = []
    seen: set[str] = set()
    skipped = duplicates = 0
    for item in items:
        entry = feed_entry(item, source=source, base=base, naive_zone=naive_zone)
        if entry is None:
            skipped += 1
            continue
        if entry.external_key in seen:
            duplicates += 1
            continue
        seen.add(entry.external_key)
        entries.append(entry)
    limit = int(config.get("max_items") or DEFAULT_MAX_ITEMS)
    notes = []
    if len(entries) > limit:
        floor = datetime.min.replace(tzinfo=timezone.utc)
        entries.sort(key=lambda e: e.published_at or floor, reverse=True)
        notes.append(f"feed_capped={len(entries)}>{limit}")
        entries = entries[:limit]
    if skipped:
        notes.append(f"feed_skipped_untitled_or_unlinked={skipped}")
    if duplicates:
        notes.append(f"feed_duplicate_ids={duplicates}")
    if parsed.get("bozo") and entries:
        notes.append("feed_bozo")
    return ParseOutput(entries=entries, notes=notes)


class FeedAdapter:
    """RSS or Atom (the ``access`` value is the registry's; the reading is the same)."""

    def __init__(self, access: str) -> None:
        self.access = access

    def validate_config(self, source: SourceConfig) -> list[str]:
        config = source.config or {}
        problems = []
        if not config.get("url"):
            problems.append("url missing")
        if config.get("max_items") is not None and int(config["max_items"]) < 1:
            problems.append("max_items must be positive")
        return problems

    def plan(self, source: SourceConfig, state: SourceState, now: datetime) -> list[RequestSpec]:
        return plan_from_template(source, state, now, api=bool((source.config or {}).get("api")), conditional=True)

    def parse(self, result: FetchResult, source: SourceConfig, now: datetime) -> ParseOutput:
        return parse_feed(result, source, now)
