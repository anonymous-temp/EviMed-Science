"""A JATS article (Europe PMC ``fullTextXML``) as the reader's text: its abstract, and its whole text with ``## `` titles.

Pure (no network). The rules are ``article_html``'s, read off JATS elements instead of a page's markup:

- ``<abstract>`` (the first without an ``abstract-type``: not a graphical abstract, teaser or author summary) is one
  ``Heading: text`` paragraph a section, its own "Abstract" title dropped — the form ``structured_abstract`` gives.
- ``<body>``: a ``<sec>``'s ``<title>`` is a paragraph of its own written ``## Title``, whatever its depth; a ``<p>`` is a
  paragraph; a figure's or a table's label and caption are a paragraph (``Fig. 1 Caption…``); a list item is a paragraph;
  a displayed formula, a table's cells, a graphic and supplementary material are left out, and so is a section whose
  type or title is back matter (``article_html.BACK_MATTER``: funding, contributions, conflicts, data availability …).
- ``<back>`` (references, acknowledgements, footnotes, appendices) is never read.
- Inline formulas keep their MathML text (``α1``) without the TeX annotation that repeats them.

The whole text leads with the abstract as its own ``## Abstract`` section, like a landing page's, and counts only when the
main text is at least ``article_html.FULL_TEXT_MIN`` characters (a scanned article's body is one line pointing at its
PDF). ``ElementTree`` resolves no external entity; a document it cannot parse is a document without text.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET

from .article_html import FULL_TEXT_MIN, heading_key, is_back_matter

_SPACE = re.compile(r"\s+")
# Children of a paragraph that are blocks of their own, not part of its sentence.
_BLOCK_CHILDREN = frozenset({"fig", "fig-group", "table-wrap", "table-wrap-group", "disp-formula", "disp-formula-group",
                             "list", "disp-quote", "boxed-text", "supplementary-material", "media", "graphic",
                             "def-list", "statement", "verse-group", "code", "preformat", "array"})
_NEVER_TEXT = frozenset({"annotation", "annotation-xml", "tex-math", "alt-text", "graphic", "inline-graphic", "media",
                         "object-id", "label"})
_BACK_SEC_TYPES = ("supplementary-material", "coi-statement", "funding", "author-contributions", "data-availability",
                   "ethics-statement", "acknowledgments", "acknowledgements", "conflict", "display-objects",
                   "supplementary", "kwd-group")


def _local(tag: object) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _clean(text: str) -> str:
    return _SPACE.sub(" ", text).strip()


def inline_text(element: ET.Element, *, skip_blocks: bool = True) -> str:
    """The running text of a mixed-content element: its text, its inline children's, their tails."""
    parts: list[str] = [element.text or ""]
    for child in element:
        name = _local(child.tag)
        if not (skip_blocks and name in _BLOCK_CHILDREN) and name not in _NEVER_TEXT:
            if name == "inline-formula":
                parts.append(_formula_text(child))
            elif name in ("break", "hr"):
                parts.append(" ")
            else:
                parts.append(inline_text(child, skip_blocks=skip_blocks))
        parts.append(child.tail or "")
    return _clean("".join(parts))


def _formula_text(element: ET.Element) -> str:
    for child in element.iter():
        if _local(child.tag) == "math":
            return inline_text(child)
    return ""


def _caption_paragraph(element: ET.Element) -> str | None:
    label = next((inline_text(child) for child in element if _local(child.tag) == "label"), "")
    caption = next((child for child in element if _local(child.tag) == "caption"), None)
    text = ""
    if caption is not None:
        pieces = [inline_text(child) for child in caption if _local(child.tag) in ("title", "p")]
        text = " ".join(piece for piece in pieces if piece) or inline_text(caption)
    joined = _clean(f"{label} {text}")
    return joined or None


def _blocks(element: ET.Element, out: list[str]) -> None:
    """The paragraphs of a body-level element, in order (module docstring)."""
    name = _local(element.tag)
    if name == "sec":
        sec_type = (element.get("sec-type") or "").lower()
        title_node = next((child for child in element if _local(child.tag) == "title"), None)
        title = inline_text(title_node) if title_node is not None else ""
        if sec_type.startswith(_BACK_SEC_TYPES) or (title and is_back_matter(title)):
            return
        if title:
            out.append("## " + title)
        for child in element:
            if _local(child.tag) not in ("title", "label"):
                _blocks(child, out)
        return
    if name == "p":
        text = inline_text(element)
        if text:
            out.append(text)
        for child in element:
            if _local(child.tag) in _BLOCK_CHILDREN:
                _blocks(child, out)
        return
    if name in ("fig", "table-wrap"):
        caption = _caption_paragraph(element)
        if caption:
            out.append(caption)
        return
    if name in ("fig-group", "table-wrap-group", "list", "list-item", "disp-quote", "boxed-text", "def-list",
                "def-item", "def", "statement", "verse-group"):
        for child in element:
            if _local(child.tag) == "title":
                title = inline_text(child)
                if title:
                    out.append(title)
            elif _local(child.tag) in ("term",):
                term = inline_text(child)
                if term:
                    out.append(term)
            else:
                _blocks(child, out)
        return
    if name in ("verse-line",):
        text = inline_text(element)
        if text:
            out.append(text)


def abstract_paragraphs(abstract: ET.Element) -> list[str]:
    """``Heading: text`` per section, plain paragraphs otherwise; the abstract's own title dropped."""
    out: list[str] = []

    def visit(node: ET.Element, heading: str) -> None:
        for child in node:
            name = _local(child.tag)
            if name == "sec":
                title_node = next((c for c in child if _local(c.tag) == "title"), None)
                title = inline_text(title_node) if title_node is not None else ""
                sec_type = (child.get("sec-type") or "").lower()
                if (title and is_back_matter(title)) or sec_type.startswith(_BACK_SEC_TYPES):
                    continue                                  # the keywords, written as a section of the abstract
                visit(child, title if heading_key(title) not in ("abstract", "summary") else "")
            elif name == "p":
                text = inline_text(child)
                if text:
                    out.append(f"{heading}{'' if heading.endswith((':', '：')) else ':'} {text}" if heading else text)
                    heading = ""
            elif name in ("list",):
                visit(child, heading)
            elif name == "list-item":
                visit(child, heading)

    visit(abstract, "")
    return out


def _article(root: ET.Element) -> ET.Element | None:
    if _local(root.tag) == "article":
        return root
    return next((node for node in root.iter() if _local(node.tag) == "article"), None)


def jats_text(body: bytes) -> tuple[str | None, str | None]:
    """``(abstract, whole text)`` of a JATS article; either ``None`` when the document does not carry it."""
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return None, None
    article = _article(root)
    if article is None:
        return None, None
    abstract = None
    front = next((node for node in article if _local(node.tag) == "front"), None)
    if front is not None:
        candidates = [node for node in front.iter() if _local(node.tag) == "abstract"]
        chosen = next((node for node in candidates if not node.get("abstract-type")), candidates[0] if candidates else None)
        if chosen is not None:
            abstract = "\n".join(abstract_paragraphs(chosen)) or None
    main = next((node for node in article if _local(node.tag) == "body"), None)
    if main is None:
        return abstract, None
    paragraphs: list[str] = []
    for child in main:
        _blocks(child, paragraphs)
    while paragraphs and paragraphs[-1].startswith("## "):
        paragraphs.pop()
    if sum(len(p) for p in paragraphs if not p.startswith("## ")) < FULL_TEXT_MIN:
        return abstract, None
    lead = ["## Abstract", *abstract.split("\n")] if abstract else []
    return abstract, "\n\n".join(lead + paragraphs)


__all__ = ["abstract_paragraphs", "inline_text", "jats_text"]
