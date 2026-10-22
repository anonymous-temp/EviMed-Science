"""Publisher feeds for ``/text``: the abstract a journal's own RSS carries when no index has it yet.

A journal's registry row may name its publisher's feeds (``config.abstract_feed``: one URL or a list — typically the
"advance articles" feed and the current issue). Measured 2026-10-22 through this plugin's fetcher (the honest
``EviMedBot`` identity, robots.txt honoured): OUP's feeds carry the whole abstract (~1,600 characters, its sections as
``<div class="boxTitle">``), the AGA/Cell Press journal hosts the first paragraph or the summary (~250–500), JAMA Network
a 200–300-character summary, BMJ's the first paragraph; The Lancet's ``/rssfeed`` is disallowed by its robots.txt
(``Disallow: /rss``), NEJM's and the AHA's ``/action/showFeed`` by theirs — those rows name no feed. The publishers'
article pages answer this crawler with a challenge (OUP, JAMA) or a 403 (the Elsevier hosts) while their feeds answer.

- A feed is read at most once every ``FEED_TTL_S`` (two hours) per URL by this process, whatever number of entries ask;
  a feed that failed is not asked again for ``FAILURE_TTL_S``. Reads are page requests (robots.txt applies).
- An entry is matched by DOI (``prism:doi``, ``dc:identifier``, the guid, the link, an ``id``), else by its DOI's suffix
  as the last segment of the item's link (BMJ links ``/content/395/bmj-2026-101102``).
- The item's description (or content) is the text, its markup read with section titles kept (OUP's ``boxTitle``
  becomes ``Heading: text``, ``structured_abstract``). At least ``article_html.ABSTRACT_MIN`` characters and not cut
  (``looks_truncated``) is an ``abstract``; shorter or cut is an ``excerpt``; shorter than ``EXCERPT_MIN`` is nothing.
"""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import urlsplit

import feedparser

from ..adapters.common import looks_truncated, normalize_doi, structured_abstract
from .article_html import ABSTRACT_MAX, ABSTRACT_MIN
from .common import Trace, get

FEED_TTL_S = 2 * 3600
FAILURE_TTL_S = 30 * 60
EXCERPT_MIN = 60
MAX_FEEDS_PER_ROW = 4
_BOX_TITLE = re.compile(r"<div\s+class=\"boxTitle\"\s*>(.*?)</div>", re.I | re.S)
_DOI_FIELDS = ("prism_doi", "dc_identifier", "id", "guid", "link")
_TAIL_SUFFIXES = (".full", ".abstract", ".short", ".full-text", ".pdf")


@dataclass
class FeedItem:
    dois: frozenset[str]
    tail: str | None
    text: str


@dataclass
class _Cached:
    at: float
    items: list[FeedItem] | None          # None: the read failed


@dataclass
class FeedCache:
    """Per-process cache of parsed feeds (module docstring); ``clock`` is monotonic seconds (tests pass their own)."""

    clock: Callable[[], float] = time.monotonic
    entries: dict[str, _Cached] = field(default_factory=dict)
    locks: dict[str, asyncio.Lock] = field(default_factory=dict)
    reads: int = 0

    def fresh(self, url: str) -> _Cached | None:
        cached = self.entries.get(url)
        if cached is None:
            return None
        ttl = FEED_TTL_S if cached.items is not None else FAILURE_TTL_S
        return cached if self.clock() - cached.at < ttl else None


CACHE = FeedCache()


def feed_urls(config: Any) -> list[str]:
    """The ``abstract_feed`` URLs of a row's config (a string or a list), http(s) only, at most ``MAX_FEEDS_PER_ROW``."""
    value = (config or {}).get("abstract_feed") if isinstance(config, dict) else None
    values = [value] if isinstance(value, str) else value if isinstance(value, list) else []
    return [v for v in values if isinstance(v, str) and v.startswith(("https://", "http://"))][:MAX_FEEDS_PER_ROW]


def item_text(value: str) -> str:
    """A feed description as paragraphs: OUP's ``boxTitle`` divs are section titles."""
    return structured_abstract(_BOX_TITLE.sub(lambda m: f"<h4>{m.group(1)}</h4>", value or ""))


def _tail(link: str | None) -> str | None:
    if not link:
        return None
    path = urlsplit(link).path.rstrip("/")
    last = path.rsplit("/", 1)[-1].lower()
    for suffix in _TAIL_SUFFIXES:
        if last.endswith(suffix):
            last = last[: -len(suffix)]
    return last or None


def parse_items(body: bytes) -> list[FeedItem]:
    parsed = feedparser.parse(body)
    items: list[FeedItem] = []
    for entry in parsed.entries:
        dois = set()
        for key in _DOI_FIELDS:
            doi = normalize_doi(entry.get(key))
            if doi:
                dois.add(doi)
        texts = [entry.get("summary") or ""] + [c.get("value") or "" for c in entry.get("content") or [] if isinstance(c, dict)]
        text = max((item_text(t) for t in texts), key=len, default="")
        items.append(FeedItem(dois=frozenset(dois), tail=_tail(entry.get("link")), text=text))
    return items


def match(items: list[FeedItem], doi: str) -> FeedItem | None:
    doi = doi.lower()
    suffix = doi.split("/", 1)[1] if "/" in doi else ""
    for item in items:
        if doi in item.dois:
            return item
    if len(suffix) >= 8:
        for item in items:
            if item.tail and item.tail == suffix:
                return item
    return None


async def read_feed(fetcher: Any, url: str, *, source_id: str | None, egress: str, trace: Trace,
                    cache: FeedCache | None = None) -> list[FeedItem] | None:
    """The feed's items, from the cache when fresh (module docstring)."""
    cache = cache or CACHE
    cached = cache.fresh(url)
    if cached is not None:
        return cached.items
    lock = cache.locks.setdefault(url, asyncio.Lock())
    async with lock:
        cached = cache.fresh(url)
        if cached is not None:
            return cached.items
        cache.reads += 1
        attempt = await get(fetcher, url, api=False, source_id=source_id, egress=egress)
        if attempt.result is None or attempt.result.status != 200:
            trace.record(attempt, "feed")
            cache.entries[url] = _Cached(at=cache.clock(), items=None)
            return None
        items = parse_items(attempt.result.body)
        cache.entries[url] = _Cached(at=cache.clock(), items=items)
        return items


async def feed_text(fetcher: Any, row: dict, doi: str, trace: Trace,
                    cache: FeedCache | None = None) -> tuple[str, str] | None:
    """``(kind, text)`` — ``abstract`` or ``excerpt`` — of the entry in its journal's feeds, or ``None``."""
    for url in feed_urls(row.get("source_config")):
        items = await read_feed(fetcher, url, source_id=row.get("source_id"), egress=row.get("source_egress") or "direct",
                                trace=trace, cache=cache)
        item = match(items or [], doi)
        if item is None:
            continue
        text = item.text
        if ABSTRACT_MIN <= len(text) <= ABSTRACT_MAX and not looks_truncated(text):
            return "abstract", text
        if len(text) >= EXCERPT_MIN:
            return "excerpt", text[:ABSTRACT_MAX]
        trace.notes.append("feed_item_without_text")
        return None
    return None


__all__ = ["CACHE", "FeedCache", "FeedItem", "feed_text", "feed_urls", "item_text", "match", "parse_items", "read_feed"]
