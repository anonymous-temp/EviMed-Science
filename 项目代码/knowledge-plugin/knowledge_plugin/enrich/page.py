"""The page excerpt for ``/text``: the main text of a news, regulator or society page, ≤ 12,000 chars.

Asked only for entries the platform kept after screening (about 30 %), so the plugin does not read
pages nobody will see (plan 10.3.4). The request is a page request (``api=False``): robots.txt
applies and the core's fetcher classifies challenge and empty-shell pages (Ruishu, Cloudflare,
WAF markers, < 300 visible characters) as ``challenge`` before this code sees a body.

Extraction is deterministic and small: drop scripts, styles, navigation, headers, footers, asides
and forms; then take the longest *body* container a CMS marks as such (the Chinese government TRS
``#UCAP-CONTENT``/``.pages_content``/``.trs_editor_view``, Sitefinity's ``.sf-detail-body-wrapper``
on who.int, GOV.UK's ``.govspeak``, ``[itemprop=articleBody]`` …); only when none holds 200
characters, the longest generic wrapper (``article``, ``main``, ``#content`` …); else the body.
"Longest wrapper" alone picks the outer page frame: on 2026-09-22 it pulled gov.cn's font-size
toolbar and who.int's related-news list into the excerpt. A PDF is not read (the
plugin has no PDF parser; the document parser is a platform service) and reports
``unavailable``. Feed entries whose own summary is already the full, uncut text skip the request.
"""

from __future__ import annotations

from typing import Any

from selectolax.parser import HTMLParser

from ..adapters.base import decode_body
from ..adapters.common import clean_markup, looks_truncated
from .common import Attempt, Trace, get

EXCERPT_MAX = 12_000
FULL_SUMMARY_MIN = 1_500          # a feed summary this long and uncut is the text; no page request
MIN_EXCERPT = 200                 # less than this is navigation, not an article

_REMOVE = ("script", "style", "noscript", "template", "svg", "iframe", "nav", "header", "footer", "aside", "form",
           "button", "select", "[role=navigation]", "[role=banner]", "[role=contentinfo]", "[aria-hidden=true]")
_BODY_CONTAINERS = ("#UCAP-CONTENT", ".pages_content", ".trs_editor_view", ".TRS_Editor", "#zoom",
                    ".sf-detail-body-wrapper", ".govspeak", "[itemprop=articleBody]", ".c-article-body",
                    ".article-body", ".article__body", ".article-content", ".entry-content", ".post-content",
                    ".news-content", ".field--name-body", ".con_content", ".xl_content", "#article-body")
_GENERIC_CONTAINERS = ("article", "main", "[role=main]", "#content", "#main-content", ".content", ".article",
                       ".detail", ".view", "#Content")


def extract_main_text(html_text: str) -> str:
    """The main text of a page as paragraphs, ≤ ``EXCERPT_MAX`` characters (cut at a paragraph end)."""
    tree = HTMLParser(html_text)
    for selector in _REMOVE:
        for node in tree.css(selector):
            node.decompose()
    best = ""
    for tier in (_BODY_CONTAINERS, _GENERIC_CONTAINERS):
        for selector in tier:
            for node in tree.css(selector):
                text = clean_markup(node.html or "", keep_paragraphs=True)
                if len(text) > len(best):
                    best = text
        if len(best) >= MIN_EXCERPT:
            break
    if len(best) < MIN_EXCERPT and tree.body is not None:
        body = clean_markup(tree.body.html or "", keep_paragraphs=True)
        if len(body) > len(best):
            best = body
    return clip_excerpt(best)


def clip_excerpt(text: str, limit: int = EXCERPT_MAX) -> str:
    if len(text) <= limit:
        return text
    cut = text[:limit]
    end = cut.rfind("\n")
    if end < limit // 2:
        end = max(cut.rfind("。"), cut.rfind(". "))
    return (cut[: end + 1] if end > limit // 2 else cut).rstrip()


def summary_is_full_text(summary: str | None) -> bool:
    """The entry's own text already serves as the excerpt: long, and either uncut or longer than an excerpt.

    A summary longer than ``EXCERPT_MAX`` covers the excerpt whatever its ending — including one the
    adapter cut at the contract's 20,000 characters and marked with "…".
    """
    if not summary or len(summary) < FULL_SUMMARY_MIN:
        return False
    return len(summary) > EXCERPT_MAX or not looks_truncated(summary)


async def page_excerpt(fetcher: Any, url: str, *, source_id: str | None, egress: str,
                       trace: Trace) -> tuple[str | None, Attempt]:
    """``(excerpt or None, attempt)`` for the entry's own page."""
    attempt = await get(fetcher, url, api=False, source_id=source_id, egress=egress)
    if attempt.result is None:
        trace.record(attempt, "page")
        return None, attempt
    result = attempt.result
    content_type = result.headers.get("content-type", "").lower()
    if result.status != 200:
        trace.notes.append(f"page_http_{result.status}")
        return None, attempt
    if "pdf" in content_type or result.body[:5] == b"%PDF-":
        trace.notes.append("page_is_pdf")
        return None, attempt
    if content_type and not any(kind in content_type for kind in ("html", "xml", "text/plain")):
        trace.notes.append("page_not_html")
        return None, attempt
    text = extract_main_text(decode_body(result))
    if len(text) < MIN_EXCERPT:
        trace.notes.append("page_no_main_text")
        return None, attempt
    return text, attempt
