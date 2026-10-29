"""What a journal article's landing page says about it: the abstract, a standfirst, the whole open text, the licence.

Pure (no network): ``read_article_page(html, url)`` is handed a page the protected fetcher already read. Measured on
2026-10-22 on the landing pages of the frontier feed's gap (Nature, Springer, BMC, BMJ, Frontiers, the OUP/JAMA/NEJM
challenges, ScienceDirect's 403):

- **The abstract**, in order of trust: the publisher's own metadata (Highwire ``citation_abstract``, Dublin Core
  ``dc.description`` / ``DCTERMS.abstract``), the JSON-LD ``ScholarlyArticle``'s ``abstract`` (or its ``description``),
  the abstract section of the page (Springer Nature ``#Abs1-content``, Atypon ``.abstractSection``, Wiley
  ``.article-section__abstract``, OUP ``section.abstract``, ``[role=doc-abstract]`` …), and last ``og:description`` when
  it is uncut and long enough. A metadata abstract is plain text; when the page's own section says the same thing with
  its headings ("Purpose", "Methods" …), the section's form is kept, one ``Heading: text`` paragraph a section
  (``structured_abstract``). What is not an abstract: a text under ``ABSTRACT_MIN`` characters (BMJ's standfirst in
  ``citation_abstract``), one that ends cut (BMJ's ``DC.Description`` is the article's opening and ends "…"), and one
  over ``ABSTRACT_MAX`` (Frontiers writes a whole data report into ``citation_abstract``: 25,459 characters).
- **The excerpt**, when there is no abstract: the longest of those, or a news piece's standfirst (Nature's
  ``.c-article-teaser-text``) — what the publisher itself shows of a piece that has no abstract.
- **The whole text**, when the page carries it: the article body (``BODY_CONTAINERS``), a paragraph per block, a
  section title a paragraph of its own written ``## Title``, figure and table captions kept (the first thing given up
  when the text is over the contract's 40,000 characters: ``fit_body``), figure files, tables,
  formulas, references, acknowledgements, funding, contributions, conflicts, rights and the "about this article" block
  left out (``BACK_MATTER``). The abstract leads it as its own ``## Abstract`` section. It counts as the whole text only
  when the main text, the abstract and the back matter set aside, is at least ``FULL_TEXT_MIN`` characters: a Springer
  article published the same day is an abstract and its back matter around a "work in progress" banner.
- **The licence**: a Creative Commons licence the page links to (``rel=license``, a ``creativecommons.org/licenses/``
  link or metadata). Whether the whole text may be taken is the caller's decision (``landing.py``).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Iterable

from selectolax.parser import HTMLParser, Node

from ..adapters.common import clean_markup, looks_truncated, structured_abstract
from ..model import BODY_TEXT_MAX

ABSTRACT_MIN = 200          # shorter is a standfirst or a teaser (BMJ's citation_abstract of a feature: 166)
ABSTRACT_MAX = 6_000        # longer is not an abstract (Frontiers' citation_abstract of a data report: 25,459)
EXCERPT_MIN = 60
FULL_TEXT_MIN = 2_000       # main text (abstract and back matter aside) a page must carry to be the whole text

_META_ABSTRACT = ("citation_abstract", "dc.description", "dcterms.abstract", "dcterms.description", "eprints.abstract",
                  "bepress_citation_abstract")
_META_SHORT = ("og:description", "og-description", "description", "prism.teaser")
_ARTICLE_TYPES = frozenset({"scholarlyarticle", "medicalscholarlyarticle", "article", "newsarticle", "report",
                            "techarticle", "review", "medicalwebpage"})
ABSTRACT_SECTIONS = (
    "#Abs1-content",                                        # Springer Nature, BMC
    "section[data-title=Abstract] .c-article-section__content",
    "[role=doc-abstract]", "[property=abstract]",           # Atypon (its "core" layout: PNAS, AAAS …), JATS4R
    ".abstractSection", ".abstractInFull",                  # Atypon (T&F, SAGE, ACS, NEJM, AHA …)
    ".article-section__abstract",                           # Wiley
    "section.abstract",                                     # OUP, Elsevier, HighWire
    "#abstracts .abstract.author",                          # ScienceDirect
    ".JournalAbstract",                                     # Frontiers
    "div.abstract", "#abstract", "#Abstract", ".html-abstract", ".article-abstract", ".abstract-content",
)
# Not ``[class*=abstract]``: PNAS shows the abstracts of related articles in ``.card__abstract`` cards, and a commentary
# with no abstract of its own would take one of theirs.
STANDFIRST = (".c-article-teaser-text", ".article__teaser", ".c-article-standfirst", ".standfirst", "p.lead")
BODY_CONTAINERS = (
    ".c-article-body",                                      # Springer Nature, BMC
    ".ArticleContent", ".JournalFullText",                  # Frontiers
    "#artText",                                             # PLOS
    ".html-body",                                           # MDPI
    ".hlFld-Fulltext",                                      # Atypon
    ".article-section__full", ".article__body",             # Wiley
    "[data-widgetname=ArticleFulltext]", ".widget-ArticleFulltext",   # OUP
    ".fulltext-view",                                       # HighWire (BMJ)
    "#body",                                                # ScienceDirect
    "[property=articleBody]", "#bodymatter",                # Atypon "core" (PNAS, AAAS, ACP …)
    "[itemprop=articleBody]",
)
# Section titles of back matter, compared lower-case without numbering and punctuation; a section is left out with
# everything under it until the next title of its level or above.
BACK_MATTER = frozenset({
    "references", "reference", "bibliography", "literature cited", "works cited", "notes and references",
    "acknowledgements", "acknowledgments", "acknowledgement", "acknowledgment", "funding", "funding information",
    "funding statement", "financial support", "sources of funding", "grant information",
    "author contributions", "authors contributions", "author contribution", "contributions", "contributorship",
    "author information", "authors and affiliations", "affiliations", "corresponding author", "corresponding authors",
    "competing interests", "conflict of interest", "conflicts of interest", "conflict of interest statement",
    "declaration of competing interest", "declaration of interests", "disclosures", "disclosure", "duality of interest",
    "ethics declarations", "ethics statement", "ethics approval and consent to participate", "consent for publication",
    "ethical approval", "additional information", "publishers note", "rights and permissions", "about this article",
    "cite this article", "share this article", "supplementary information", "supplementary material",
    "supplementary materials", "supplementary data", "electronic supplementary material", "supporting information",
    "source data", "data availability", "data availability statement", "availability of data and materials",
    "data sharing statement", "code availability", "peer review", "peer review information",
    "similar content being viewed by others", "explore related subjects", "keywords", "footnotes", "notes",
    "statements", "generative ai statement", "author disclaimer", "orcid", "figures", "outline", "abbreviations",
    "glossary", "copyright", "license", "permissions", "related articles", "comments", "metrics",
    "ethics statements", "patient consent for publication", "provenance and peer review", "supplemental material",
    "artificial intelligence statement", "data sharing", "trial status", "competing interests statement",
})
_SKIP_SUBTREES = ("script", "style", "noscript", "template", "svg", "iframe", "nav", "aside", "button", "form", "select",
                  "math", "img", "picture", "video", "audio", "object",
                  ".c-article-references", "ol.references", ".references", "#references", ".ref-list", ".ref-list-wrap",
                  "[data-test=reference-list]", ".c-article-recommendations", ".c-reading-companion", ".u-hide-print",
                  "[aria-hidden=true]", ".visually-hidden", ".sr-only", ".c-article-section__figure-link",
                  ".c-article__pill-button", ".MathJax", ".mjx-chtml", ".denial-block", "[role=doc-bibliography]",
                  "[role=doc-acknowledgments]", "[role=doc-endnotes]", "[role=doc-footnote]", "#backmatter",
                  "[class*=download]", "[class*=Download]", ".figure-inline-download", ".caption_object",
                  ".highwire-figure-links", ".fig-links", ".table-links", ".table-expand-inline")
# Titles that open back matter whatever follows ("Acknowledgments and disclosures", "Conflict of interest statement");
# "Conflict resolution and evidence management" (a methods subsection) is not one.
_BACK_MATTER_PREFIXES = ("acknowledg", "conflict of interest", "conflicts of interest", "competing interest",
                         "declaration of competing", "author contribution", "authors contribution",
                         "supplementary material", "supplementary information", "supplementary data")
_TABLE_PARTS = "thead, tbody, tfoot, tr, colgroup"      # a table goes, its caption stays
_BLOCK_TAGS = frozenset({"h2", "h3", "h4", "h5", "p", "li", "figcaption", "caption", "blockquote", "dd", "pre"})
_NUMBERING = re.compile(r"^(?:[0-9]+(?:\.[0-9]+)*\.?|[IVXLC]+\.|[A-Z]\.)\s+")
_NOT_WORD = re.compile(r"[^\w\s]")
_WORD = re.compile(r"\w+")
_CC = re.compile(r"https?://(?:www\.)?creativecommons\.org/(?:licenses|publicdomain)/[A-Za-z0-9._/-]+", re.I)


@dataclass(frozen=True)
class ArticlePage:
    """What ``read_article_page`` found; every field ``None`` when the page does not carry it."""

    abstract: str | None = None
    abstract_from: str | None = None      # which part of the page: ``meta:<name>``, ``jsonld``, ``section``, ``og``
    excerpt: str | None = None
    body_text: str | None = None          # the whole text with ``## `` section titles (module docstring)
    license_url: str | None = None
    is_article: bool = False              # the page names the work (citation_title / citation_doi / dc.identifier …)


def read_article_page(html_text: str, url: str | None = None) -> ArticlePage:
    """The abstract, excerpt, whole text and licence of one landing page (module docstring)."""
    tree = HTMLParser(html_text)
    metas = _metas(tree)
    is_article = any(name in metas for name in ("citation_title", "citation_doi", "dc.identifier", "prism.doi",
                                                 "citation_journal_title"))
    titles = {_words(value) for name in ("citation_title", "dc.title", "og:title", "twitter:title")
              for value in metas.get(name, [])}
    if tree.css_first("title") is not None:
        titles.add(_words(tree.css_first("title").text()))
    candidates: list[tuple[str, str]] = []          # (how, text) in order of trust; a title is not a description
    for name in _META_ABSTRACT:
        for value in metas.get(name, []):
            candidates.append((f"meta:{name}", structured_abstract(value)))
    for value in _jsonld_texts(tree):
        candidates.append(("jsonld", structured_abstract(value)))
    sections = [structured_abstract(_abstract_html(node)) for node in abstract_sections(tree)]
    for name in _META_SHORT:
        for value in metas.get(name, []):
            candidates.append(("og", clean_markup(value, keep_paragraphs=True)))

    candidates = [(h, text) for h, text in candidates if text and not _is_title(text, titles)]
    abstract, how = None, None
    trusted = [(h, text) for h, text in candidates if h != "og" and is_abstract(text)]
    section = next((text for text in sections if is_abstract(text)), None)
    if trusted:
        how, abstract = trusted[0]
        if section and same_text(abstract, section) and _structure(section) > _structure(abstract):
            abstract, how = section, how + "+section"
    elif section:
        abstract, how = section, "section"
    elif is_article:
        # Last, and only on a page that names its article: a site's own description is no article's abstract.
        og = next((text for h, text in candidates if h == "og" and is_abstract(text)), None)
        if og:
            abstract, how = og, "og"

    excerpt = None
    if abstract is None:
        shorter = [text for _, text in candidates if EXCERPT_MIN <= len(text) <= ABSTRACT_MAX]
        shorter += [text for text in (_text_of(node) for node in _first_matches(tree, STANDFIRST)) if len(text) >= EXCERPT_MIN]
        shorter += [text for text in sections if EXCERPT_MIN <= len(text) <= ABSTRACT_MAX]
        excerpt = max(shorter, key=len) if shorter else None

    body = article_body(tree, abstract)
    return ArticlePage(abstract=abstract, abstract_from=how, excerpt=excerpt, body_text=body,
                       license_url=page_license(tree, metas), is_article=is_article)


def is_abstract(text: str | None) -> bool:
    """Long enough, short enough and not cut (module docstring)."""
    return bool(text) and ABSTRACT_MIN <= len(text) <= ABSTRACT_MAX and not looks_truncated(text)


def same_text(a: str, b: str) -> bool:
    """Whether two renderings are the same abstract: most of their words shared (headings and punctuation aside)."""
    words_a, words_b = set(_WORD.findall(a.lower())), set(_WORD.findall(b.lower()))
    if not words_a or not words_b:
        return False
    return len(words_a & words_b) / min(len(words_a), len(words_b)) >= 0.8


def _words(text: str | None) -> str:
    return " ".join(_WORD.findall((text or "").lower()))


def _is_title(text: str, titles: set[str]) -> bool:
    """The page's title written again as its description (PNAS gives a commentary's title as ``dc.Description``)."""
    words = _words(text)
    return bool(words) and any(words == title or (len(words) >= 20 and words in title) for title in titles if title)


def _structure(text: str) -> int:
    return text.count("\n")


def _metas(tree: HTMLParser) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for node in tree.css("meta"):
        name = (node.attributes.get("name") or node.attributes.get("property") or "").strip().lower()
        content = node.attributes.get("content")
        if name and content and content.strip():
            out.setdefault(name, []).append(content)
    return out


def _jsonld_texts(tree: HTMLParser) -> list[str]:
    """``abstract`` (then an uncut ``description``) of every article object in the page's JSON-LD."""
    found: list[str] = []

    def visit(node: Any, inherited: bool) -> None:
        if isinstance(node, list):
            for item in node:
                visit(item, inherited)
            return
        if not isinstance(node, dict):
            return
        kinds = node.get("@type")
        kinds = [kinds] if isinstance(kinds, str) else kinds if isinstance(kinds, list) else []
        is_article = inherited or any(str(kind).lower() in _ARTICLE_TYPES for kind in kinds)
        if is_article:
            for key in ("abstract", "description"):
                value = node.get(key)
                if isinstance(value, str) and value.strip():
                    found.append(value)
                    break
        for key, value in node.items():
            if isinstance(value, (dict, list)):
                visit(value, inherited=key == "mainEntity")

    for script in tree.css('script[type="application/ld+json"]'):
        try:
            visit(json.loads(script.text() or ""), False)
        except ValueError:
            continue
    return found


# Sections marked as abstracts that are not the abstract (PNAS's "Significance" is a ``doc-abstract`` beside the real one).
NOT_THE_ABSTRACT = frozenset({"significance", "significance statement", "graphical abstract", "visual abstract",
                              "highlights", "key points", "plain language summary", "lay summary", "author summary",
                              "editors summary", "editor s summary", "teaser", "summary for patients", "video abstract",
                              "research in context", "what is already known", "what this study adds"})


# What an abstract section embeds that is not its text: NEJM's "Research Summary" and "Quick Take" cards (Atypon digital
# objects), figures, buttons.
_ABSTRACT_NOISE = ("figure", "img", "picture", "aside", "button", "nav", "svg", "script", "style", "[role=button]",
                   "[class*=digital-object]", "[class*=media_item]", "[class*=media-item]")


def _abstract_html(node: Node) -> str:
    for selector in _ABSTRACT_NOISE:
        for noise in node.css(selector):
            noise.decompose()
    return node.html or ""


def abstract_sections(tree: HTMLParser) -> list[Node]:
    """The page's abstract sections in ``ABSTRACT_SECTIONS`` order, one titled "Abstract" (or "Summary") first and none
    titled as something else (``NOT_THE_ABSTRACT``)."""
    ranked: list[tuple[int, int, Node]] = []
    seen: set[int] = set()
    for selector in ABSTRACT_SECTIONS:
        for node in tree.css(selector):
            if node.mem_id in seen:
                continue
            seen.add(node.mem_id)
            heading = node.css_first("h1, h2, h3, h4, h5")
            key = heading_key(heading.text()) if heading is not None else ""
            if key in NOT_THE_ABSTRACT:
                continue
            ranked.append((0 if key in ("abstract", "summary") else 1, len(ranked), node))
    # A page that marks its abstract by its title alone (Frontiers: ``<div id="h1"><h2>Abstract</h2><p>…``): the block
    # the title opens. "Abstract" only: Frontiers' side panel titled "Summary" holds the keywords, citation and dates.
    for heading in tree.css("h2, h3"):
        parent = heading.parent
        if parent is None or parent.mem_id in seen or heading_key(heading.text()) != "abstract":
            continue
        seen.add(parent.mem_id)
        if len(parent.text(strip=True)) <= ABSTRACT_MAX + 200:
            ranked.append((2, len(ranked), parent))
    return [node for _, _, node in sorted(ranked, key=lambda item: item[:2])]


def _first_matches(tree: HTMLParser | Node, selectors: Iterable[str]) -> list[Node]:
    out: list[Node] = []
    for selector in selectors:
        out += tree.css(selector)
    return out


def _text_of(node: Node) -> str:
    return clean_markup(node.html or "", keep_paragraphs=True)


def page_license(tree: HTMLParser, metas: dict[str, list[str]] | None = None) -> str | None:
    """The Creative Commons licence the page states, as its URL (``rel=license`` first, then any licence link or
    metadata value); ``None`` when it states none."""
    for node in tree.css('[rel~="license"]'):
        match = _CC.search(node.attributes.get("href") or "")
        if match:
            return match.group(0)
    for values in (metas or _metas(tree)).values():
        for value in values:
            match = _CC.search(value)
            if match:
                return match.group(0)
    for node in tree.css('a[href*="creativecommons.org/"], link[href*="creativecommons.org/"]'):
        match = _CC.search(node.attributes.get("href") or "")
        if match:
            return match.group(0)
    return None


def heading_key(title: str) -> str:
    """A section title as ``BACK_MATTER`` compares it: lower case, no numbering, no punctuation."""
    title = _NUMBERING.sub("", title.strip())
    return " ".join(_NOT_WORD.sub("", title.lower()).split())


def is_back_matter(title: str) -> bool:
    key = heading_key(title)
    return key in BACK_MATTER or key.startswith(_BACK_MATTER_PREFIXES)


def article_body(tree: HTMLParser, abstract: str | None) -> str | None:
    """The article's whole text (module docstring), or ``None`` when the page does not carry it."""
    container = next(iter(_first_matches(tree, BODY_CONTAINERS)), None)
    if container is None:
        return None
    paragraphs = body_paragraphs(container)
    main = sum(len(p) for p in paragraphs if not p.startswith("## "))
    if main < FULL_TEXT_MIN or (abstract and main < 2 * len(abstract)):
        return None
    lead = ["## Abstract", *abstract.split("\n")] if abstract else []
    return "\n\n".join(lead + paragraphs)


def body_paragraphs(container: Node) -> list[str]:
    """The blocks of an article body in document order as paragraphs, section titles as ``## Title``, the abstract and
    back matter out. A block's own text is the paragraph: nothing inside a block is read again. (Not
    ``Node.traverse``: it goes on past the container into the nodes that follow it.)"""
    for selector in _SKIP_SUBTREES:
        for node in container.css(selector):
            node.decompose()
    for node in container.css(_TABLE_PARTS):
        node.decompose()
    out: list[str] = []
    skip_level: int | None = None
    stack = list(reversed(list(container.iter())))
    while stack:
        node = stack.pop()
        tag = (node.tag or "").lower()
        if tag == "div" and node.attributes.get("role") == "paragraph":    # Atypon "core" writes paragraphs as divs
            tag = "p"
        if tag not in _BLOCK_TAGS:
            stack.extend(reversed(list(node.iter())))
            continue
        text = clean_markup(node.html or "")
        if not text or _is_furniture(node, text):
            continue
        if tag in ("h2", "h3", "h4", "h5"):
            level = int(tag[1])
            if skip_level is not None and level > skip_level:
                continue
            skip_level = None
            if heading_key(text) in ("abstract", "summary") or is_back_matter(text):
                skip_level = level
                continue
            out.append("## " + text)
            continue
        if skip_level is None:
            out.append(text)
    while out and out[-1].startswith("## "):
        out.pop()
    return _drop_empty_sections(out)


_BARE_URL = re.compile(r"^(?:https?://|doi:)\S+$", re.I)


def _is_furniture(node: Node, text: str) -> bool:
    """A list item that is only links ("Download figure", "Open in new tab", a keyword's subject page), or a paragraph
    that is only an address (PLOS's figure DOI): the page's machinery, not the article."""
    if _BARE_URL.match(text):
        return True
    if (node.tag or "").lower() != "li" or len(text) > 80:
        return False
    linked = "".join(clean_markup(a.html or "") for a in node.css("a"))
    return bool(linked) and len(linked.replace(" ", "")) >= len(text.replace(" ", "")) - 2


_CAPTION = re.compile(r"^(?:fig\.?|figure|table|scheme|box|chart)\s*[a-z]?[0-9]+[a-z]?[.:]?\s", re.I)
_FIGURE_LABEL = re.compile(r"^(?:fig\.?|figure|table|scheme|box|chart)\s*[a-z]?[0-9]+[a-z]?[.:]?$", re.I)


def _drop_empty_sections(paragraphs: list[str]) -> list[str]:
    """A section title repeated at once (a heading drawn twice, for print and screen) is one title, and a figure's
    label alone ("Fig. 1", Springer's ``figcaption``) is joined to the caption that follows it."""
    out: list[str] = []
    for paragraph in paragraphs:
        if paragraph.startswith("## ") and out and out[-1] == paragraph:
            continue
        if out and _FIGURE_LABEL.match(out[-1]) and not paragraph.startswith("## "):
            out[-1] = f"{out[-1]} {paragraph}"
            continue
        out.append(paragraph)
    return out


def fit_body(text: str, limit: int = BODY_TEXT_MAX) -> tuple[str, bool]:
    """``(text, whole)``: the whole text within the contract's ``limit``. Given up first, in order: the leading
    ``## Abstract`` section (the abstract is its own field), then the figure and table captions; when it is still
    longer, its paragraphs up to the limit and ``whole`` false (the reader is told it is a part)."""
    if len(text) <= limit:
        return text, True
    paragraphs = text.split("\n\n")
    if paragraphs and paragraphs[0] == "## Abstract":
        end = next((i for i, p in enumerate(paragraphs[1:], 1) if p.startswith("## ")), len(paragraphs))
        paragraphs = paragraphs[end:]
        joined = "\n\n".join(paragraphs)
        if len(joined) <= limit:
            return joined, True
    kept = [p for p in paragraphs if not _CAPTION.match(p)]
    joined = "\n\n".join(kept)
    if len(joined) <= limit:
        return joined, True
    out: list[str] = []
    size = 0
    for paragraph in kept:
        if size + len(paragraph) + 2 > limit:
            break
        out.append(paragraph)
        size += len(paragraph) + 2
    while out and out[-1].startswith("## "):
        out.pop()
    return "\n\n".join(out), False


__all__ = ["ABSTRACT_MAX", "ABSTRACT_MIN", "ArticlePage", "BACK_MATTER", "FULL_TEXT_MIN", "article_body",
           "body_paragraphs", "heading_key", "is_abstract", "is_back_matter", "page_license", "read_article_page",
           "same_text"]
