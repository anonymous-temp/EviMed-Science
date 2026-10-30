"""Taking nodes out of a parsed page (2026-10-28: one WeChat article sent the plugin out of memory about once a minute).

``css()`` lists a node and the nodes inside it side by side; ``decompose()`` of the outer one frees the inner ones and
``decompose()`` of an inner one after it frees it a second time. lexbor's allocator then hands the same memory to two later
allocations: a text inserted before a block appears four times, and ``Node.text()`` walks a cycle for ever, appending to its
result about 35 MB a second. ``decompose_all`` frees each subtree once, whatever order ``css()`` listed the nodes in.

The failure is a C loop that no timeout inside the process can interrupt, so every case runs in a child process with a
deadline: a regression fails the test instead of hanging the suite.
"""

from __future__ import annotations

import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEADLINE_S = 30

# Real WeChat editor markup, cut down to what makes the loop (found by deleting every tag that did not matter from a
# 丁香园消化时间 article of 2026-10-26): an <svg> holding two <svg>, one of them holding paragraphs.
WEIXIN_SVG_CARD = (
    '<svg width="100%" height="100%" style="box-sizing: border-box;">'
    '<svg width="100%" height="100%" style="box-sizing: border-box;"></svg>'
    '<svg x="0.00%" y="0.00%" width="100.00%" xmlns="http://www.w3.org/2000/svg" style="max-width: 100%;" height="100.00%">'
    '<p style="white-space: normal;margin: 0px;"><p style="white-space: normal;margin: 0px;"><p style="white-space: normal;">'
)
# Listed by css() as [template, svg] although the template is inside the svg: the order of the selectors, not the document's.
LISTED_AGAINST_DOCUMENT_ORDER = "<h2></p><svg></b>x<template>"


def isolated(code: str) -> str:
    """The stdout of ``code`` run in a child process with the plugin importable; a child past the deadline fails the test."""
    program = f"import sys\nsys.path.insert(0, {str(ROOT)!r})\n" + textwrap.dedent(code)
    try:
        done = subprocess.run([sys.executable, "-I", "-c", program], capture_output=True, text=True, timeout=DEADLINE_S)
    except subprocess.TimeoutExpired:
        pytest.fail(f"the child did not finish in {DEADLINE_S} s: a node was freed twice and the parser is looping")
    assert done.returncode == 0, done.stderr[-2000:]
    return done.stdout


@pytest.mark.parametrize("markup", [
    LISTED_AGAINST_DOCUMENT_ORDER,
    "<svg><svg></svg><svg><p><p><p>",
    WEIXIN_SVG_CARD,
    "<p>before</p>" + WEIXIN_SVG_CARD + "</svg></svg><p>after</p>",
    "<template><template><svg><svg><iframe></iframe></svg></svg></template></template><p>x</p>" * 3,
], ids=["list-order", "minimal", "weixin-card", "weixin-card-between-paragraphs", "nested-drop-tags"])
def test_clean_markup_finishes_on_nested_dropped_tags(markup):
    out = isolated(f"""
        from knowledge_plugin.adapters.common import clean_markup
        text = clean_markup({markup!r}, keep_paragraphs=True)
        print(len(text))
        print(clean_markup({markup!r}))
    """)
    assert out.splitlines()[0].isdigit()


def test_text_around_dropped_markup_is_kept_once():
    out = isolated("""
        from knowledge_plugin.adapters.common import clean_markup
        markup = ("<p>keep</p><template><template><p>no</p></template></template>"
                  "<noscript><noscript>no</noscript></noscript><p>tail</p>")
        print(repr(clean_markup(markup, keep_paragraphs=True)))
    """)
    assert out.strip() == repr("keep\ntail")


@pytest.mark.parametrize(("markup", "text"), [
    ("x</h2>x<li><section><noscript></p><noscript></noscript>", "xx"),
    ("x<b><div></b><span></iframe><div><p></iframe><b><template>yy</span></section></iframe><svg></iframe></iframe><svg>", "x"),
], ids=["nested-noscript", "nested-svg-and-iframe"])
def test_the_text_outside_nested_dropped_tags_is_not_lost(markup, text):
    """Found by comparing 4,000 random documents with the code before: the double free did not always loop, it also
    left the parser with an empty tree (the whole article's text gone, with no error)."""
    out = isolated(f"""
        from knowledge_plugin.adapters.common import clean_markup
        print(repr(clean_markup({markup!r}, keep_paragraphs=True)))
    """)
    assert out.strip() == repr(text)


def test_decompose_all_frees_each_subtree_once():
    out = isolated("""
        from selectolax.parser import HTMLParser
        from knowledge_plugin.adapters.common import decompose_all

        tree = HTMLParser("<div><aside>1<aside>2<aside>3</aside></aside></aside><p>keep</p><aside>4</aside></div>")
        listed = tree.css("aside")
        assert len(listed) == 4
        assert decompose_all(listed + listed) == 4, "a node listed twice is one node"
        print(tree.body.html)
        assert tree.css("aside") == []
        assert decompose_all([]) == 0
    """)
    assert out.strip() == "<body><div><p>keep</p></div></body>"


def test_the_page_readers_finish_on_the_same_markup():
    """Every reader that takes nodes out of a page goes through ``decompose_all``: the text-chain page reader, the landing-page
    reader and the html-list adapter."""
    out = isolated(f"""
        from knowledge_plugin.adapters.html_list import _html_items
        from knowledge_plugin.enrich.article_html import ArticlePage, read_article_page
        from knowledge_plugin.enrich.landing import _is_shell
        from knowledge_plugin.enrich.page import container_text

        for body in ({LISTED_AGAINST_DOCUMENT_ORDER!r}, {WEIXIN_SVG_CARD!r}):
            page = "<html><body><article><p>" + "Long enough sentence. " * 30 + "</p>" + body + "</article></body></html>"
            assert container_text(page).startswith("Long enough sentence.")
            read_article_page(page)
            assert _is_shell(ArticlePage(), page) in (True, False)
            _html_items(page, {{"selectors": {{"item": "p"}}}})
        print("done")
    """)
    assert out.strip() == "done"
