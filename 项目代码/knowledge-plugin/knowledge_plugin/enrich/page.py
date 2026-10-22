"""The page excerpt for ``/text``: the main text of a news, regulator or society page, ≤ 12,000 chars.

Asked only for entries the platform kept after screening (about 30 %), so the plugin does not read
pages nobody will see (plan 10.3.4). The request is a page request (``api=False``): robots.txt
applies and the core's fetcher classifies challenge and empty-shell pages (Ruishu, Cloudflare,
WAF markers, < 300 visible characters) as ``challenge`` before this code sees a body.

Extraction (2026-10-22) is trafilatura's (Apache-2.0; the best single tool of Bevendorff et al. 2023, "An Empirical
Comparison of Web Content Extraction Algorithms", and of the ScrapingHub article benchmark), with its recall setting, the
text as paragraphs, tables kept, comments, links and images left out. Measured on 307 pages of the feed's 172 page
sources, our container reading below took the page's furniture with the article — bylines, author biographies, "Editors'
notes / The GIST / Add as preferred source", 「选择字号：小 中 大」, comment-widget templates, a whole navigation menu on
cnpharm.com — 272 such paragraphs to trafilatura's 82, for 90 % of the characters. Trafilatura misses the article on
some pages: on gov.cn it returns the page's language switch (78 characters), on leiphone.com 609 of an article's 3,974.
So the container reading stays the fallback: its text is used when trafilatura's is under ``MIN_EXCERPT``, or when it is
at least ``FALLBACK_RATIO`` times longer — the furniture it carries is what the platform's paragraph check removes,
while an article trafilatura dropped is lost for good.

The container reading is deterministic and small: drop scripts, styles, navigation, headers, footers, asides
and forms; then take the longest *body* container a CMS marks as such (the Chinese government TRS
``#UCAP-CONTENT``/``.pages_content``/``.trs_editor_view``, Sitefinity's ``.sf-detail-body-wrapper``
on who.int, GOV.UK's ``.govspeak``, ``[itemprop=articleBody]`` …); only when none holds 200
characters, the longest generic wrapper (``article``, ``main``, ``#content`` …); else the body.
"Longest wrapper" alone picks the outer page frame: on 2026-09-22 it pulled gov.cn's font-size
toolbar and who.int's related-news list into the excerpt. A PDF is not read (the
plugin has no PDF parser; the document parser is a platform service) and reports
``unavailable``. Feed entries whose own summary is already the full, uncut text skip the request.

Contract 1.5.0: the whole main text, up to 40,000 characters, is also kept as ``body_text`` (what the reader shows and
translates); the excerpt stays its first 12,000 characters, as before.
"""

from __future__ import annotations

from typing import Any

import trafilatura
from selectolax.parser import HTMLParser

from ..adapters.base import decode_body
from ..adapters.common import clean_markup, looks_truncated
from ..model import BODY_TEXT_MAX
from .common import Attempt, Trace, get

EXCERPT_MAX = 12_000
FULL_SUMMARY_MIN = 1_500          # a feed summary this long and uncut is the text; no page request
MIN_EXCERPT = 200                 # less than this is navigation, not an article
FALLBACK_RATIO = 3                # the container reading this many times longer: trafilatura missed the article

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
    return clip_excerpt(main_text(html_text))


def main_text(html_text: str, url: str | None = None) -> str:
    """The main text of a page as paragraphs, ≤ ``BODY_TEXT_MAX`` characters (cut at a paragraph end): trafilatura's,
    or the container reading's when trafilatura's is short or a fraction of it (module docstring)."""
    extracted = extracted_text(html_text, url)
    fallback = container_text(html_text)
    if len(extracted) >= MIN_EXCERPT and len(fallback) < FALLBACK_RATIO * len(extracted):
        return clip_excerpt(extracted, BODY_TEXT_MAX)
    return clip_excerpt(fallback if len(fallback) >= len(extracted) else extracted, BODY_TEXT_MAX)


def extracted_text(html_text: str, url: str | None = None) -> str:
    """Trafilatura's main text, one paragraph a line; empty when it finds none (or cannot parse the page)."""
    try:
        text = trafilatura.extract(html_text, url=url, output_format="txt", favor_recall=True, include_comments=False,
                                   include_tables=True, include_images=False, include_links=False, deduplicate=False)
    except Exception:  # noqa: BLE001 - a page the library cannot parse is a page without its text, never a failed job
        return ""
    # Already plain text with its entities decoded: read as markup again, "a<b … c>d" would lose its middle as a "tag".
    return "\n".join(line.strip() for line in (text or "").splitlines() if line.strip())


def container_text(html_text: str) -> str:
    """The longest CMS body container's text, else the longest generic wrapper's, else the body's, one paragraph a
    line."""
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
    return best


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
    """``(main text or None, attempt)`` for the entry's own page: the whole main text (≤ ``BODY_TEXT_MAX``); its excerpt
    is ``clip_excerpt`` of it."""
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
    text = main_text(decode_body(result), url)
    if len(text) < MIN_EXCERPT:
        trace.notes.append("page_no_main_text")
        return None, attempt
    return text, attempt
