"""A News-Medical article reads today (2026-10-31): 643 of its pages were answered ``page_no_main_text`` in 30 days by the reader
that ``trafilatura`` replaced on 2026-10-22, and ``retext --kinds unread-page`` reads them again. The page's markup, with
invented text: the article body is a ``div`` marked ``itemprop="articleBody"`` inside ``main``, with related-story ``article``
teasers and a navigation beside it. (A live page of the site, fetched once on 2026-10-31 and not saved, gave 4,915 characters
through ``main_text``; this keeps the shape, not the page.)"""

from __future__ import annotations

from knowledge_plugin.enrich.page import MIN_EXCERPT, main_text

PARAGRAPHS = [
    "Patients treated for a long-term condition during pregnancy were followed from the first visit to the birth of their "
    "child in a cohort of five thousand births, and the doses they took were recorded at every appointment by the clinic.",
    "The researchers compared newborns whose mothers lowered the dose with newborns whose mothers kept it unchanged, and "
    "found no difference in the number needing treatment for withdrawal symptoms in the first week of life.",
    "The authors note that the study was observational and that the findings should be confirmed in a trial before they "
    "change the advice given to patients, but they say the result argues against reducing the dose out of fear.",
]


def page() -> str:
    teaser = "".join(f'<article class="article-size-3 interview col-xs-12"><a href="/news/{n}.aspx"><h3>Related story {n}</h3>'
                     f'<p>A short teaser about another story number {n}.</p></a></article>' for n in range(3))
    body = "".join(f"<p>{text}</p>" for text in PARAGRAPHS)
    return ("<html><head><title>A story - News-Medical</title></head><body><form id='aspNetForm'>"
            "<nav><ul><li><a href='/'>Home</a></li><li><a href='/news'>News</a></li></ul></nav>"
            "<div class='container main-content-left'><main class='main-container col-xs-12 col-md-8' id='main'>"
            "<div class='item-body content-item-body'><h1>A story</h1><div class='content'>"
            f"<div class='page-content clearfix' id='body-1' itemprop='articleBody'>{body}</div></div></div>"
            f"<div class='related'>{teaser}</div></main></div><footer>Copyright</footer></form></body></html>")


def test_the_article_body_is_read_and_the_related_teasers_are_not():
    text = main_text(page(), "https://www.news-medical.net/news/20261030/a-story.aspx")
    assert len(text) >= MIN_EXCERPT, "the reader that answered page_no_main_text read nothing"
    assert all(paragraph in text for paragraph in PARAGRAPHS)
    assert "Related story" not in text and "A short teaser" not in text
